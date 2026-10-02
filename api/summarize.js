const { applyCors, verifyAuthFull, checkGuestYoutubeLimit, checkYoutubeDailyLimit } = require('./_lib/auth');
const { MODEL_LARGE, FRIENDLY_AI_ERROR, isModelUnavailableError } = require('./_lib/models');

function getVideoId(url) {
  const m = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&\n?#]+)/);
  return m ? m[1] : null;
}

async function supadataFetch(youtubeUrl, apiKey, lang, nativeOnly = true) {
  const params = `url=${encodeURIComponent(youtubeUrl)}${lang ? `&lang=${lang}` : ''}${nativeOnly ? '&mode=native' : ''}`;
  const res = await fetch(`https://api.supadata.ai/v1/transcript?${params}`, {
    headers: { 'x-api-key': apiKey },
    signal: AbortSignal.timeout(10000)
  });

  const body = await res.text();
  let parsed;
  try { parsed = JSON.parse(body); } catch { throw new Error(body || 'Invalid response.'); }
  if (!res.ok) throw new Error(parsed.message || `HTTP ${res.status}`);

  if (res.status === 202) {
    const jobId = parsed.id;
    // Poll for up to 24s (6 attempts × 4s)
    for (let i = 0; i < 6; i++) {
      await new Promise(r => setTimeout(r, 4000));
      const poll = await fetch(`https://api.supadata.ai/v1/transcript/${jobId}`, {
        headers: { 'x-api-key': apiKey },
        signal: AbortSignal.timeout(8000)
      });
      if (!poll.ok) continue;
      let result;
      try { result = JSON.parse(await poll.text()); } catch { continue; }
      if (result.status === 'done') return extractText(result.content);
    }
    throw new Error('Transcription timed out. Try a shorter video.');
  }

  return extractText(parsed.content);
}

function _parseCaptionRaw(raw) {
  return raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[.,]\d{3}[^\n]*/gm, '')
    .replace(/^\d+\s*$/gm, '')
    .replace(/WEBVTT[^\n]*/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchTranscriptGetApi(videoId) {
  // Fetch YouTube page to get visitorData token (needed for get_transcript API)
  const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: _YT_HEADERS_DESKTOP,
    signal: AbortSignal.timeout(10000)
  });
  if (!pageRes.ok) throw new Error(`Page HTTP ${pageRes.status}`);
  const html = await pageRes.text();

  const vdM = html.match(/"visitorData"\s*:\s*"([^"]+)"/);
  const visitorData = vdM ? vdM[1] : '';

  // Build minimal protobuf: field 1 (videoId)
  const vidBytes = Buffer.from(videoId, 'utf8');
  const params = Buffer.concat([Buffer.from([0x0a, vidBytes.length]), vidBytes]).toString('base64');

  const body = JSON.stringify({
    context: {
      client: {
        clientName: 'WEB',
        clientVersion: '2.20231121.01.00',
        hl: 'en',
        gl: 'US',
        ...(visitorData ? { visitorData } : {})
      }
    },
    params
  });

  const tRes = await fetch('https://www.youtube.com/youtubei/v1/get_transcript', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': _YT_HEADERS_DESKTOP['User-Agent'],
      'Accept-Language': 'en-US,en;q=0.9',
      ...(visitorData ? { 'X-Goog-Visitor-Id': visitorData } : {})
    },
    body,
    signal: AbortSignal.timeout(10000)
  });

  if (!tRes.ok) throw new Error(`get_transcript HTTP ${tRes.status}`);
  const data = await tRes.json();

  // Walk the response to find transcript segments
  const segList = data?.actions?.[0]
    ?.updateEngagementPanelAction?.content
    ?.transcriptRenderer?.content
    ?.transcriptSearchPanelRenderer?.body
    ?.transcriptSegmentListRenderer?.initialSegments;

  if (!segList?.length) throw new Error('No transcript segments in response');

  const text = segList
    .map(s => s?.transcriptSegmentRenderer?.snippet?.runs?.map(r => r.text || '').join('') || '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text || text.length < 30) throw new Error('Empty transcript from get_transcript');
  return text;
}

async function fetchTranscriptViaJina(videoId) {
  // Jina AI reader routes through their own infra — bypasses YouTube datacenter IP blocks
  const res = await fetch(`https://r.jina.ai/https://www.youtube.com/watch?v=${videoId}`, {
    headers: {
      'Accept': 'application/json',
      'X-No-Cache': 'true',
      'X-Return-Format': 'text'
    },
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) throw new Error(`Jina HTTP ${res.status}`);
  let content;
  try {
    const data = await res.json();
    content = data?.data?.content || data?.data?.text || '';
  } catch {
    content = await res.text().catch(() => '');
  }
  if (!content || content.length < 200) throw new Error('No content from Jina');
  // Reject bot-detection responses
  if (content.includes("confirm you're not a bot") || content.includes('Sign in to confirm')) {
    throw new Error('YouTube bot-detection triggered on Jina reader');
  }
  return content;
}

async function fetchYtTimedtextLegacy(videoId) {
  // Legacy timedtext URL — no signature needed for some auto-generated captions
  const attempts = [
    `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en&fmt=vtt&kind=asr`,
    `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en&fmt=vtt`,
    `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en-US&fmt=vtt&kind=asr`,
  ];
  for (const url of attempts) {
    try {
      const res = await fetch(url, { headers: _YT_HEADERS_DESKTOP, signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const raw = await res.text();
      if (!raw || raw.trim().length < 50) continue;
      const parsed = _parseCaptionRaw(raw);
      if (parsed.length > 50) return parsed;
    } catch (_) { continue; }
  }
  throw new Error('No legacy timedtext available');
}

async function fetchCaptionsFromPiped(videoId) {
  const instances = ['https://pipedapi.kavin.rocks', 'https://pipedapi.leptons.xyz', 'https://piped-api.garudalinux.org'];
  for (const base of instances) {
    try {
      const r = await fetch(`${base}/streams/${videoId}`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const data = await r.json();
      const subs = data.subtitles || [];
      if (!subs.length) continue;
      const sub = subs.find(s => (s.code || '').startsWith('en')) || subs[0];
      if (!sub?.url) continue;
      const captRes = await fetch(sub.url, { signal: AbortSignal.timeout(8000) });
      if (!captRes.ok) continue;
      const text = _parseCaptionRaw(await captRes.text());
      if (text.length > 30) return text;
    } catch (_) { continue; }
  }
  throw new Error('No captions from Piped');
}

async function fetchCaptionsFromInvidious(videoId) {
  const instances = ['https://inv.nadeko.net', 'https://iv.datura.network', 'https://invidious.lunar.icu'];
  for (const base of instances) {
    try {
      const r = await fetch(`${base}/api/v1/captions/${videoId}`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const data = await r.json();
      const tracks = data.captions || [];
      if (!tracks.length) continue;
      const track = tracks.find(t => (t.language_code || t.languageCode || '').startsWith('en')) || tracks[0];
      const captUrl = track?.url;
      if (!captUrl) continue;
      const full = captUrl.startsWith('http') ? captUrl : `${base}${captUrl}`;
      const captRes = await fetch(full, { signal: AbortSignal.timeout(8000) });
      if (!captRes.ok) continue;
      const text = _parseCaptionRaw(await captRes.text());
      if (text.length > 30) return text;
    } catch (_) { continue; }
  }
  throw new Error('No captions from Invidious');
}

const _YT_HEADERS_DESKTOP = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Cookie': 'CONSENT=YES+cb.20210629-17-p0.en+FX+119; SOCS=CAESHAgCEhJnd3NfMjAyMzA4MjktMF9SQzIaAmVuIAEaBgiAo_CmBg'
};

const _YT_HEADERS_MOBILE = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  'Cookie': 'CONSENT=YES+cb.20210629-17-p0.en+FX+119; SOCS=CAESHAgCEhJnd3NfMjAyMzA4MjktMF9SQzIaAmVuIAEaBgiAo_CmBg'
};

function _extractTracksFromHtml(html) {
  // Try multiple markers for different page formats
  const markers = [
    'var ytInitialPlayerResponse = ',
    'ytInitialPlayerResponse=',
    '"ytInitialPlayerResponse":',
    'ytInitialPlayerResponse ='
  ];
  for (const marker of markers) {
    let searchFrom = 0;
    while (true) {
      const si = html.indexOf(marker, searchFrom);
      if (si === -1) break;
      const bi = html.indexOf('{', si + marker.length - 1);
      if (bi === -1) break;
      let depth = 0, start = -1, end = -1;
      for (let i = bi; i < Math.min(bi + 800000, html.length); i++) {
        if (html[i] === '{') { if (depth === 0) start = i; depth++; }
        else if (html[i] === '}') { if (--depth === 0) { end = i; break; } }
      }
      if (start !== -1 && end !== -1) {
        try {
          const pr = JSON.parse(html.slice(start, end + 1));
          const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
          if (tracks?.length) return tracks;
        } catch (_) {}
      }
      searchFrom = si + marker.length;
    }
  }
  return null;
}

async function _fetchTracksFromUrl(url, headers) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const html = await r.text();
  const tracks = _extractTracksFromHtml(html);
  if (!tracks?.length) throw new Error('No tracks in page');
  return tracks;
}

async function fetchYtDirectCaptions(videoId) {
  // Try mobile first (simpler page, fewer bot checks), then desktop
  const attempts = [
    () => _fetchTracksFromUrl(`https://m.youtube.com/watch?v=${videoId}`, _YT_HEADERS_MOBILE),
    () => _fetchTracksFromUrl(`https://www.youtube.com/watch?v=${videoId}`, _YT_HEADERS_DESKTOP),
  ];

  let tracks = null;
  for (const attempt of attempts) {
    try { tracks = await attempt(); if (tracks) break; } catch (_) {}
  }
  if (!tracks) throw new Error('No caption tracks found in YouTube page');

  const track = tracks.find(t => (t.languageCode || '').startsWith('en')) || tracks[0];
  let baseUrl = track?.baseUrl;
  if (!baseUrl) throw new Error('No caption baseUrl');
  if (baseUrl.startsWith('/')) baseUrl = 'https://www.youtube.com' + baseUrl;

  const captRes = await fetch(baseUrl + '&fmt=json3', {
    headers: _YT_HEADERS_DESKTOP,
    signal: AbortSignal.timeout(8000)
  });
  if (!captRes.ok) throw new Error('Caption content fetch failed');

  const captData = await captRes.json();
  const text = (captData.events || [])
    .filter(e => e.segs)
    .map(e => e.segs.map(s => s.utf8 || '').join(''))
    .join(' ')
    .replace(/[\n\r]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text || text.length < 30) throw new Error('Empty caption data');
  return text;
}

async function fetchTranscriptViaInnertube(videoId) {
  const { Innertube } = await import('youtubei.js');
  const opts = process.env.YT_COOKIE ? { cookie: process.env.YT_COOKIE } : {};
  const yt = await Innertube.create(opts);

  let info;
  try {
    info = await yt.getInfo(videoId);
  } catch (e) {
    throw new Error(`getInfo: ${e.message}`);
  }

  // Try structured getTranscript() first
  try {
    const transcriptData = await info.getTranscript();
    const segments = transcriptData?.transcript?.content?.body?.initial_segments ?? [];
    const text = segments
      .map(seg => (seg?.snippet?.runs ?? []).map(r => r.text || '').join(''))
      .filter(t => t.trim())
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text && text.length > 50) return text;
  } catch (_) {}

  // Fall back to caption track URLs
  const tracks = info.captions?.caption_tracks;
  if (!tracks || !tracks.length) throw new Error('No caption tracks — video may have no captions');

  const track = tracks.find(t => (t.language_code || '').startsWith('en')) || tracks[0];
  let baseUrl = track?.base_url;
  if (!baseUrl) throw new Error('No caption base URL');

  // Include cookies in the caption fetch — YouTube requires auth for signed caption URLs
  const captHeaders = {
    ..._YT_HEADERS_DESKTOP,
    ...(process.env.YT_COOKIE ? { Cookie: process.env.YT_COOKIE } : {})
  };

  const sep = baseUrl.includes('?') ? '&' : '?';

  // Try multiple formats: json3 first, then raw (VTT/XML)
  const formatUrls = [
    baseUrl + sep + 'fmt=json3',
    baseUrl + sep + 'fmt=vtt',
    baseUrl,
  ];

  for (const captUrl of formatUrls) {
    const captRes = await fetch(captUrl, { headers: captHeaders, signal: AbortSignal.timeout(10000) });
    if (!captRes.ok) continue;
    const captRaw = await captRes.text();
    if (!captRaw || !captRaw.trim()) continue;

    // Try JSON (fmt=json3)
    try {
      const captData = JSON.parse(captRaw);
      const text = (captData.events || [])
        .filter(e => e.segs)
        .map(e => e.segs.map(s => s.utf8 || '').join(''))
        .join(' ')
        .replace(/[\n\r]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (text.length > 30) return text;
    } catch (_) {}

    // Try VTT/XML/raw
    const parsed = _parseCaptionRaw(captRaw);
    if (parsed.length > 30) return parsed;
  }

  // Content empty server-side (datacenter IP block) — return URL for browser to fetch
  const fallbackSep = baseUrl.includes('?') ? '&' : '?';
  return { _captionUrl: baseUrl + fallbackSep + 'fmt=json3' };
}

// Audio download + Whisper transcription was removed on purpose: NoteCaptain only reads
// existing captions/transcripts and never downloads video or audio from YouTube.

async function fetchFullTranscript(videoId) {
  const supadataKey = process.env.SUPADATA_API_KEY;
  const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;

  const tryAll = await Promise.all([
    supadataKey ? supadataFetch(youtubeUrl, supadataKey, 'en', true).catch(() => null) : Promise.resolve(null),
    supadataKey ? supadataFetch(youtubeUrl, supadataKey, null, true).catch(() => null) : Promise.resolve(null),
    fetchCaptionsFromPiped(videoId).catch(() => null),
    fetchCaptionsFromInvidious(videoId).catch(() => null),
    fetchYtDirectCaptions(videoId).catch(() => null),
    fetchTranscriptGetApi(videoId).catch(() => null),
    // fetchTranscriptViaGroqWhisper(videoId).catch(() => null), // disabled - ytdl decipher broken
  ]);

  const fast = tryAll.find(r => r && r.length > 50);
  if (fast) return fast;

  // Last resort: Supadata AI (async job, up to 30s)
  if (supadataKey) return supadataFetch(youtubeUrl, supadataKey, null, false);
  throw new Error('Could not retrieve transcript. Try uploading the audio/video file directly.');
}

function extractText(content) {
  if (!content) throw new Error('Empty transcript returned.');
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) return content.map(s => s.text || '').join(' ').trim();
  throw new Error('Unexpected transcript format.');
}

async function fetchVideoContent(videoId, url) {
  try {
    const jinaRes = await fetch(`https://r.jina.ai/https://www.youtube.com/watch?v=${videoId}`, {
      headers: { 'Accept': 'application/json', 'X-No-Cache': 'true' }
    });
    if (jinaRes.ok) {
      const jinaData = await jinaRes.json();
      const content = jinaData?.data?.content || jinaData?.data?.description || '';
      if (content.length > 100) return content.slice(0, 12000);
    }
  } catch (_) {}

  try {
    const oembedRes = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
    if (oembedRes.ok) {
      const data = await oembedRes.json();
      if (data.title) return `Video title: "${data.title}" by ${data.author_name}. Note: full transcript unavailable, summarizing from title only.`;
    }
  } catch (_) {}

  throw new Error('Could not extract content from this video. Please try a different video.');
}

function getNotePrompt(style, t) {
  const q = '"quote":{"text":"Famous relevant quote about the subject or learning","author":"Person Name"},';
  if (!style || style === 'auto') {
    // Detect best style from content and generate notes
    return `You are a study note expert. First, read the content and choose the single best note-taking style from this list: detailed, outline, cornell, mindmap, summary, problem, exam, comparison, boxing, charting, mapping, qec.

Rules for choosing:
- outline → structured topics with clear hierarchy
- cornell → lecture notes, Q&A, keyword-heavy content
- mindmap → broad concept overviews
- detailed → comprehensive content needing full explanation
- summary → short articles or simple content
- problem → science/math/engineering problems
- exam → content explicitly for test prep
- comparison → content comparing multiple things
- boxing → distinct named sections/categories
- charting → data, timelines, or tabular info
- mapping → geography, systems, or spatial concepts
- qec → arguments, evidence-based topics

Then generate the notes in that chosen style using the exact JSON schema for that style (see below). Return ONLY valid JSON, nothing else.

DETAILED schema: {"title":"...","subject":"biology|chemistry|physics|math|history|economics|literature|cs|other","emoji":"...","style":"detailed",${q}"sections":[{"heading":"...","content":"...","bullets":["..."],"keyTerms":[{"term":"...","def":"..."}]}],"images":[{"query":"...","caption":"..."}]}
OUTLINE schema: {"title":"...","subject":"...","emoji":"...","style":"outline",${q}"items":[{"level":1,"text":"..."},{"level":2,"text":"..."}]}
CORNELL schema: {"title":"...","subject":"...","emoji":"...","style":"cornell",${q}"rows":[{"cue":"...","notes":"..."}],"summary":"..."}
MINDMAP schema: {"title":"...","subject":"...","emoji":"...","style":"mindmap",${q}"center":"...","branches":[{"label":"...","connection":"...","children":["..."]}]}
SUMMARY schema: {"title":"...","subject":"...","emoji":"...","style":"summary",${q}"overview":"...","bullets":["..."],"keyTerms":[{"term":"...","def":"..."}]}
PROBLEM schema: {"title":"...","subject":"...","emoji":"...","style":"problem",${q}"problems":[{"question":"...","approach":"...","steps":["..."],"answer":"..."}]}
EXAM schema: {"title":"...","subject":"...","emoji":"...","style":"exam",${q}"mustKnow":["..."],"qa":[{"q":"...","a":"..."}],"tips":["..."]}
COMPARISON schema: {"title":"...","subject":"...","emoji":"...","style":"comparison",${q}"items":["..."],"criteria":[{"label":"...","values":["..."]}],"verdict":"..."}
BOXING schema: {"title":"...","subject":"...","emoji":"...","style":"boxing",${q}"boxes":[{"title":"...","content":"...","tag":"..."}]}
CHARTING schema: {"title":"...","subject":"...","emoji":"...","style":"charting",${q}"overview":"...","headers":["..."],"rows":[["..."]]}
MAPPING schema: {"title":"...","subject":"...","emoji":"...","style":"mapping",${q}"center":"...","branches":[{"label":"...","connection":"...","children":[{"label":"...","children":["..."]}]}]}
QEC schema: {"title":"...","subject":"...","emoji":"...","style":"qec",${q}"items":[{"question":"...","evidence":["..."],"conclusion":"..."}]}

Content:\n${t}`;
  }
  switch (style) {
    case 'outline':
      return `You are a study note expert. Return ONLY valid JSON — no markdown fences, nothing before { or after }.
{"title":"...","subject":"biology|chemistry|physics|math|history|economics|literature|cs|other","emoji":"...","style":"outline",${q}"items":[{"level":1,"text":"..."},{"level":2,"text":"..."},{"level":3,"text":"..."}]}
Rules: 3-5 level-1 headings, each with 3-5 level-2 sub-points, key ones with level-3 details. Cover all topics. Start with { end with }.
Content:\n${t}`;

    case 'cornell':
      return `You are a study note expert. Return ONLY valid JSON — no markdown fences, nothing before { or after }.
{"title":"...","subject":"biology|chemistry|physics|math|history|economics|literature|cs|other","emoji":"...","style":"cornell",${q}"rows":[{"cue":"Short keyword or question (max 6 words)","notes":"Detailed explanation 2-4 sentences"}],"summary":"2-3 sentence overall summary"}
Rules: 8-12 rows. Cues = keywords/questions. Notes = full explanations. Start with { end with }.
Content:\n${t}`;

    case 'mindmap':
      return `You are a study note expert. Return ONLY valid JSON — no markdown fences, nothing before { or after }.
{"title":"...","subject":"biology|chemistry|physics|math|history|economics|literature|cs|other","emoji":"...","style":"mindmap",${q}"mermaid":"mindmap\\n  root((Central Topic))\\n    Branch1\\n      Leaf1\\n      Leaf2\\n    Branch2\\n      Leaf3"}
Rules: 4-6 main branches, 2-4 sub-items each. Keep node text SHORT (1-5 words). Proper Mermaid mindmap indentation. Start with { end with }.
Content:\n${t}`;

    case 'summary':
      return `You are a study note expert. Return ONLY valid JSON — no markdown fences, nothing before { or after }.
{"title":"...","subject":"biology|chemistry|physics|math|history|economics|literature|cs|other","emoji":"...","style":"summary",${q}"overview":"2-3 sentence introduction","keyPoints":["Key point (1-2 sentences)"],"keyTakeaways":["Main lesson 1","Main lesson 2","Main lesson 3"]}
Rules: 5-8 key points. Be concise. No filler. Start with { end with }.
Content:\n${t}`;

    case 'problem':
      return `You are a study note expert. Return ONLY valid JSON — no markdown fences, nothing before { or after }.
{"title":"...","subject":"biology|chemistry|physics|math|history|economics|literature|cs|other","emoji":"...","style":"problem",${q}"intro":"Brief context","problems":[{"question":"Problem statement","steps":["Step 1 with $math$ if needed","Step 2"],"answer":"Final answer","formula":"LaTeX or null"}]}
Rules: Extract or create 3-5 representative worked problems. Full step-by-step solutions with math where relevant. Start with { end with }.
Content:\n${t}`;

    case 'exam':
      return `You are a study note expert. Return ONLY valid JSON — no markdown fences, nothing before { or after }.
{"title":"...","subject":"biology|chemistry|physics|math|history|economics|literature|cs|other","emoji":"...","style":"exam",${q}"mustKnow":["Critical fact 1"],"keyTerms":[{"term":"...","definition":"..."}],"practiceQA":[{"q":"...","a":"..."}],"formulas":[{"label":"...","latex":"..."}],"tips":["Exam tip"]}
Rules: 5-8 must-know facts, 6-10 key terms, 4-6 Q&A pairs, relevant formulas, 2-3 exam tips. Start with { end with }.
Content:\n${t}`;

    case 'comparison':
      return `You are a study note expert. Return ONLY valid JSON — no markdown fences, nothing before { or after }.
{"title":"...","subject":"biology|chemistry|physics|math|history|economics|literature|cs|other","emoji":"...","style":"comparison",${q}"overview":"Brief intro","tables":[{"title":"...","headers":["Feature","Option A","Option B"],"rows":[["feature","val A","val B"]]}]}
Rules: 2-3 comparison tables covering main contrasts. Start with { end with }.
Content:\n${t}`;

    case 'boxing':
      return `You are a study note expert. Return ONLY valid JSON — no markdown fences, nothing before { or after }.
{"title":"...","subject":"biology|chemistry|physics|math|history|economics|literature|cs|other","emoji":"...","style":"boxing",${q}"boxes":[{"title":"Concept name","content":"2-3 sentence explanation","tag":"optional label e.g. Definition|Process|Example|Formula|Warning"}]}
Rules: 5-8 concept boxes. Each box is a self-contained idea. Start with { end with }.
Content:\n${t}`;

    case 'charting':
      return `You are a study note expert. Return ONLY valid JSON — no markdown fences, nothing before { or after }.
{"title":"...","subject":"biology|chemistry|physics|math|history|economics|literature|cs|other","emoji":"...","style":"charting",${q}"overview":"1-2 sentence intro","headers":["Topic","Description","Key Detail","Significance"],"rows":[["Topic name","What it is","Specific detail or example","Why it matters"]]}
Rules: 6-10 rows covering all main topics. Each cell concise (1 sentence). Start with { end with }.
Content:\n${t}`;

    case 'mapping':
      return `You are a study note expert. Return ONLY valid JSON — no markdown fences, nothing before { or after }.
{"title":"...","subject":"biology|chemistry|physics|math|history|economics|literature|cs|other","emoji":"...","style":"mapping",${q}"center":"Central concept (3-5 words)","branches":[{"label":"Branch topic","connection":"relates via","children":["sub-point 1","sub-point 2","sub-point 3"]}]}
Rules: 4-6 branches, 2-4 children each. Keep all labels SHORT (1-5 words). Start with { end with }.
Content:\n${t}`;

    case 'qec':
      return `You are a study note expert. Return ONLY valid JSON — no markdown fences, nothing before { or after }.
{"title":"...","subject":"biology|chemistry|physics|math|history|economics|literature|cs|other","emoji":"...","style":"qec",${q}"items":[{"question":"A key question from the material","evidence":["Supporting fact or point 1","Supporting fact or point 2","Supporting fact or point 3"],"conclusion":"Direct answer supported by the evidence (1-2 sentences)"}]}
Rules: 4-6 Q/E/C items covering the main ideas. Questions should be analytical, not trivial. Start with { end with }.
Content:\n${t}`;

    default: // detailed
      return `You are an expert study note generator. Convert the content below into visually rich, structured study notes. Respond with ONLY a valid JSON object — no markdown fences, no text before { or after }.

{
  "title": "Concise topic title",
  "subject": "biology|chemistry|physics|math|history|economics|literature|cs|other",
  "emoji": "single relevant emoji",
  "quote": {"text": "Famous relevant quote about the subject or learning", "author": "Person Name"},
  "overview": "2-3 sentences introducing the topic",
  "sections": [
    {"heading": "Section title", "content": "Detailed explanation using **bold** for key terms. Use - for bullet points. 3-5 sentences or bullets.", "type": "concept"}
  ],
  "keyTerms": [
    {"term": "Term", "definition": "Clear definition", "example": "Optional real example or null"}
  ],
  "formulas": [
    {"label": "Formula name", "latex": "valid LaTeX e.g. F=ma", "note": "What the variables mean"}
  ],
  "visuals": [
    {"query": "specific Wikipedia article title for a helpful diagram", "caption": "What this diagram shows"}
  ],
  "processFlow": null,
  "comparisonTable": null,
  "graphs": [],
  "keyTakeaways": ["Takeaway 1", "Takeaway 2", "Takeaway 3"]
}

Subject rules:
- math/physics/chemistry: populate formulas[] with LaTeX notation
- math: if content contains functions, populate graphs[] with Desmos expressions like "y=x^2+3x-2"
- biology/chemistry/physics/anatomy: populate visuals[] with 1-3 specific Wikipedia queries
- any process: set processFlow to {"title":"Name","steps":["Step 1","Step 2","Step 3"]}
- any comparison: set comparisonTable to {"headers":["Feature","A","B"],"rows":[["feature","val A","val B"]]}
- Include 3-5 sections, 4-8 keyTerms, 3 keyTakeaways minimum
- Return ONLY the JSON. Start with { end with }

Content:
${t}`;
  }
}

function getPrompt(mode, transcript, highlightPrompt, noteStyle, count = 8) {
  const t = transcript.slice(0, mode === 'flashcards' ? 50000 : 12000);
  switch (mode) {
    case 'keypoints':
    case 'summarize':
    default:
      return `You are an expert content summarizer. Produce a rich, well-structured summary of the content below that a student could use to fully understand it without reading the original.

Format your response exactly like this:

**Overview**
2-3 sentences capturing the core subject, purpose, and scope.

**Key Points**
• [Specific point with enough detail to stand alone — not vague]
• [Another key point]
• [Continue for all major ideas — aim for 5-8 bullets]

**Notable Details & Examples**
• [Specific example, statistic, analogy, or insight from the content]
• [Another if present — skip this section only if truly none exist]

**Takeaway**
One strong sentence summarizing the main lesson or conclusion.

Rules: Be specific and direct. Never write "the video/text discusses..." — just state the content. Avoid padding. If a point has a number, date, or name attached, include it.

Content:
${t}`;

    case 'notes':
      return getNotePrompt(noteStyle || 'detailed', t);

    case '_notes_unused':
      return `You are an expert study note generator. Convert the content below into visually rich, structured study notes. Respond with ONLY a valid JSON object — no markdown fences, no text before { or after }.

{
  "title": "Concise topic title",
  "subject": "biology|chemistry|physics|math|history|economics|literature|cs|other",
  "emoji": "single relevant emoji",
  "overview": "2-3 sentences introducing the topic and why it matters",
  "sections": [
    {"heading": "Section title", "content": "Detailed explanation using **bold** for key terms. Use - for bullet points. 3-5 sentences or bullets.", "type": "concept"}
  ],
  "keyTerms": [
    {"term": "Term", "definition": "Clear 1-2 sentence definition", "example": "Optional real example or null"}
  ],
  "formulas": [
    {"label": "Formula name", "latex": "valid LaTeX e.g. F=ma", "note": "What the variables mean"}
  ],
  "visuals": [
    {"query": "specific Wikipedia article title for a helpful diagram", "caption": "What this diagram shows"}
  ],
  "processFlow": null,
  "comparisonTable": null,
  "graphs": [],
  "keyTakeaways": ["Takeaway 1", "Takeaway 2", "Takeaway 3"]
}

Subject rules:
- math/physics/chemistry: populate formulas[] with LaTeX notation
- math: if content contains functions (e.g. f(x)=x^2, y=sin(x), parabola, linear, quadratic), populate graphs[] with Desmos-compatible expressions like "y=x^2+3x-2" or "y=\\sin(x)"; include every plottable function mentioned
- biology/chemistry/physics/anatomy: populate visuals[] with 1-3 specific Wikipedia queries
- any process (cell division, reaction, historical sequence): set processFlow to {"title":"Process Name","steps":["Step 1","Step 2","Step 3"]}
- any comparison (A vs B, types of X): set comparisonTable to {"headers":["Feature","A","B"],"rows":[["feature","val A","val B"]]}
- Include 3-5 sections, 4-8 keyTerms, 3 keyTakeaways minimum
- Return ONLY the JSON. Start with { end with }

Content:
${t}`;

    case 'quizzes':
      return `You are an expert educator. Generate 6 quiz questions from the content below. Include a mix of: factual recall (2), conceptual understanding (2), and application or analysis (2).

Format exactly like this:

Q1: [Question]
A: [Answer — 1 to 3 sentences, precise and complete]

Q2: [Question]
A: [Answer]

[continue through Q6]

Rules: Make every question specific to the content — no generic questions that could apply to any topic. Avoid yes/no questions. Each answer must be self-contained and correct. Vary difficulty across the 6 questions.

Content:
${t}`;

    case 'flashcards':
      return `Generate exactly ${count} high-quality flashcard pairs. Respond with ONLY a valid JSON array, no markdown, no explanation, nothing before or after the array:
[{"front":"term or question (max 10 words)","back":"clear complete answer (1-2 sentences)"},...]

Rules:
- Generate exactly ${count} pairs
- Front: specific term, concept, date, person, or short question
- Back: accurate and complete explanation
- Cover different aspects — no repeated ideas
- Be factually accurate

Content/Topic:
${t}`;

    case 'highlight':
      if (highlightPrompt) {
        return `You are a text highlighting assistant. The user wants to highlight: "${highlightPrompt}"

Your job: search the TEXT BELOW and return a list of short phrases that, when searched for in the document, will highlight exactly what the user asked for.

HOW TO HANDLE EACH TYPE OF REQUEST:

• "questions" / "textbook questions" / "review questions" / "discussion questions"
  → FIND THE OPENING 8–10 WORDS OF EVERY SINGLE QUESTION IN THE TEXT — do not skip any
  → Questions include BOTH interrogative style (What, How, Why, When, Where, Which, Do, Should, Is, Are) AND directive style (Discuss, Describe, Compare, Explain, Identify, List, Give, In reviewing, Because, Table)
  → For EACH numbered or unnumbered question found, return its first 8–10 words as one entry
  → If the text has 11 questions, return 11 entries — count them and ensure every question has an entry
  → Example output for 3 questions: ["Give an example of a drug-using friend and", "Discuss and debate whether the often considered benign", "What is the future of prescription drug abuse"]

• "definitions" / "key terms" / "vocabulary"
  → Find the term names being defined (the word/phrase before "is defined as", "refers to", "means", etc.)
  → Example output: ["psychoactive drug", "physical dependence", "tolerance"]

• "headings" / "subheadings" / "chapter titles"
  → Extract the exact heading text from the text
  → Example output: ["Introduction to Drug Use", "Effects of Stimulants"]

• "main concepts" / "key ideas" / "central themes"
  → Find topic sentences and concept names from the text

• "examples" / "case studies"
  → Find "for example", "such as", phrases that introduce examples

• "names" / "people" / "organizations"
  → Find proper nouns in the text

• "drug types" / "drug names" / "substances"
  → Find drug names from the text; supplement with your knowledge (cocaine, heroin, etc.)
  → Use singular form: "inhalant" not "inhalants"

• "dates" / "statistics" / "facts"
  → Find numbers, years, percentages from the text

CRITICAL RULES:
- NEVER return the user's prompt text as a term (e.g. never output "highlight textbook questions")
- Only return things that EXIST IN THE TEXT or are known category terms to search for
- For questions: entries can be 8–12 words; for terms/names: keep entries short (1–5 words)
- No duplicates, no explanations, no markdown

Return ONLY a JSON array:
["term or phrase","another one",...]

Text:
${t}`;
      }
      return `You are a study assistant. Given the text below, do the following internally:
1. Generate 8–12 test questions covering the key facts, concepts, and ideas.
2. For each question, find the exact verbatim phrase(s) from the text that contain the answer.

Return ONLY a valid JSON array of those answer phrases — exact copies from the text, 3–10 words each. No duplicates. No questions in output. No explanations. No markdown:
["exact phrase from text","another exact phrase",...]

Text:
${t}`;
  }
}

// ── ytsearch merged from api/ytsearch.js ──────────────────────────────────────
const _PIPED=['https://pipedapi.kavin.rocks','https://pipedapi.leptons.xyz','https://piped-api.garudalinux.org'];
const _INVIDIOUS=['https://inv.nadeko.net','https://iv.datura.network','https://invidious.lunar.icu','https://y.com.sb','https://yt.cdaut.de'];
function _fmtDur(s){if(!s||s<0)return '';const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sec=s%60;if(h)return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;return `${m}:${String(sec).padStart(2,'0')}`;}
function _fmtViews(v){if(!v)return '';if(v>=1e9)return (v/1e9).toFixed(1)+'B views';if(v>=1e6)return (v/1e6).toFixed(1)+'M views';if(v>=1e3)return Math.floor(v/1e3)+'K views';return v+' views';}
async function _searchPiped(q){for(const base of _PIPED){try{const r=await fetch(`${base}/search?q=${encodeURIComponent(q)}&filter=videos`,{signal:AbortSignal.timeout(5000)});if(!r.ok)continue;const d=await r.json();const items=(d.items||[]).filter(v=>v.type==='stream'&&v.url);if(!items.length)continue;return items.slice(0,6).map(v=>{const id=(v.url||'').replace('/watch?v=','');return{id,title:v.title||'',channel:v.uploaderName||'',duration:_fmtDur(v.duration),views:_fmtViews(v.views),ago:v.uploadedDate||'',thumb:v.thumbnail||`https://i.ytimg.com/vi/${id}/mqdefault.jpg`};});}catch(_){continue;}}return null;}
async function _searchInv(q){for(const base of _INVIDIOUS){try{const r=await fetch(`${base}/api/v1/search?q=${encodeURIComponent(q)}&type=video&fields=videoId,title,author,lengthSeconds,viewCount,publishedText`,{signal:AbortSignal.timeout(5000)});if(!r.ok)continue;const d=await r.json();if(!Array.isArray(d)||!d.length)continue;return d.filter(v=>v.videoId).slice(0,6).map(v=>({id:v.videoId,title:v.title||'',channel:v.author||'',duration:_fmtDur(v.lengthSeconds),views:_fmtViews(v.viewCount),ago:v.publishedText||'',thumb:`https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`}));}catch(_){continue;}}return null;}

module.exports = async function handler(req, res) {
  applyCors(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  // This is the one endpoint anonymous Firebase users (the free YouTube converter) may
  // call — everything else requires a real account. YouTube has its own per-tier daily
  // cap (guest 3/day, free 3/day, pro 50/day) — separate from the monthly AI-action
  // count, and separate from the generic 30/hour rate limit used elsewhere.
  const authed = await verifyAuthFull(req, res, { allowAnonymous: true });
  if (!authed) return;
  const { uid, isAnonymous } = authed;
  if (isAnonymous) {
    if (!(await checkGuestYoutubeLimit(req, uid, res))) return;
  } else {
    if (!(await checkYoutubeDailyLimit(uid, res))) return;
  }

  // ytsearch route (rewired from /api/ytsearch)
  if (req.body?.q) {
    const q = req.body.q.trim();
    if (!q) return res.status(400).json({ error: 'No query provided' });
    const videos = await Promise.race([_searchPiped(q),_searchInv(q)]).catch(()=>null)||await _searchPiped(q).catch(()=>null)||await _searchInv(q).catch(()=>null);
    if (videos) return res.status(200).json({ videos });
    return res.status(502).json({ error: 'Search temporarily unavailable. Please try again.' });
  }

  try {
    const { url, text, mode = 'summarize', highlightPrompt, noteStyle, count = 8 } = req.body || {};
    if (!url && !text) return res.status(400).json({ error: 'Missing YouTube URL or text content' });

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

    // Direct text input path (upload panel / Magic Assist)
    if (text) {
      if (mode === 'transcribe') return res.status(400).json({ error: 'Transcribe mode requires a YouTube URL.' });
      const prompt = getPrompt(mode, text, highlightPrompt, noteStyle, count);
      const maxTok = mode === 'flashcards' ? 6000 : mode === 'highlight' ? 3000 : mode === 'notes' ? 3000 : 2200;
      let groqRes, data;
      for (let attempt = 0; attempt < 2; attempt++) {
        groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: MODEL_LARGE, messages: [{ role: 'user', content: prompt }], max_tokens: maxTok, temperature: 0.3, include_reasoning: false })
        });
        data = await groqRes.json();
        if (groqRes.status === 429 && attempt === 0) {
          const msg = data.error?.message || '';
          const wait = parseFloat(msg.match(/try again in ([\d.]+)s/i)?.[1] || '6');
          await new Promise(r => setTimeout(r, Math.ceil(wait * 1000) + 500));
          continue;
        }
        break;
      }
      if (!groqRes.ok) {
        console.error('Groq error (summarize/text):', data.error?.message);
        const e = new Error(data.error?.message || 'Groq error');
        e.code = data.error?.code;
        if (isModelUnavailableError(e)) return res.status(502).json({ error: FRIENDLY_AI_ERROR });
        return res.status(500).json({ error: e.message });
      }
      const summary = data.choices?.[0]?.message?.content;
      if (!summary) return res.status(500).json({ error: 'No result returned' });

      // For flashcards mode, parse the JSON array and return it directly
      if (mode === 'flashcards') {
        let cards = null;
        const start = summary.indexOf('[');
        const end = summary.lastIndexOf(']');
        if (start !== -1 && end > start) {
          try { cards = JSON.parse(summary.slice(start, end + 1)); } catch {}
        }
        if (!cards) { try { cards = JSON.parse(summary); } catch {} }
        if (cards) return res.status(200).json({ flashcards: cards });
        // fallback: return raw so client can try parsing
        return res.status(200).json({ summary });
      }

      return res.status(200).json({ summary });
    }

    const videoId = getVideoId(url);
    if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL' });

    if (mode === 'transcribe') {
      if (req.body._test) return res.status(200).json({ ok: true });
      const errors = {};

      // 1. Jina AI reader — routes through Jina's infra, bypasses datacenter IP blocks
      try {
        const r = await fetchTranscriptViaJina(videoId);
        if (r && r.length > 100) return res.status(200).json({ summary: r });
        errors.jina = 'Result too short';
      } catch (e) { errors.jina = e.message; }

      // 2. Legacy timedtext API (works for some public videos without signed URL)
      try {
        const r = await fetchYtTimedtextLegacy(videoId);
        if (r && r.length > 50) return res.status(200).json({ summary: r });
        errors.timedtext = 'Result too short';
      } catch (e) { errors.timedtext = e.message; }

      // 3. InnerTube via youtubei.js
      // If content fetch fails but caption URLs are available, return them for browser-side fetch
      // (browser has user's real IP + session — server is blocked by YouTube datacenter IP filter)
      let _innertubeCapUrl = null;
      try {
        const r = await fetchTranscriptViaInnertube(videoId);
        if (r && typeof r === 'object' && r._captionUrl) {
          _innertubeCapUrl = r._captionUrl;
          errors.innertube = 'Content empty server-side, returning URL for client fetch';
        } else if (r && r.length > 50) {
          return res.status(200).json({ summary: r });
        } else {
          errors.innertube = 'Result too short';
        }
      } catch (e) { errors.innertube = e.message; }
      if (_innertubeCapUrl) return res.status(200).json({ captionUrl: _innertubeCapUrl });

      // 4. Piped + Invidious in parallel (20s window)
      const captResults = await Promise.race([
        Promise.all([
          fetchCaptionsFromPiped(videoId).catch(e => { errors.piped = e.message; return null; }),
          fetchCaptionsFromInvidious(videoId).catch(e => { errors.inv = e.message; return null; }),
        ]),
        new Promise(r => setTimeout(() => r([null, null]), 20000))
      ]);
      const captResult = captResults.find(r => r && r.length > 50);
      if (captResult) return res.status(200).json({ summary: captResult });

      // 5. Supadata fallback (if quota available)
      const supadataKey2 = process.env.SUPADATA_API_KEY;
      if (supadataKey2) {
        const youtubeUrl2 = `https://www.youtube.com/watch?v=${videoId}`;
        try {
          const r = await supadataFetch(youtubeUrl2, supadataKey2, null, true);
          if (r && r.length > 50) return res.status(200).json({ summary: r });
        } catch (e) { errors.supadata = e.message; }
      }


      const isQuotaErr = Object.values(errors).some(m => /limit|quota/i.test(m));
      return res.status(500).json({
        error: isQuotaErr
          ? 'Transcript service quota exceeded. This will reset next month, or add a new SUPADATA_API_KEY in Vercel environment variables.'
          : 'Could not retrieve transcript for this video. YouTube is blocking server-side access. Try uploading the audio/video file directly using the Upload button.',
        _debug: errors
      });
    }

    const transcript = await fetchVideoContent(videoId, url);
    if (!transcript || transcript.length < 50) throw new Error('Could not extract enough content from this video.');

    const prompt = getPrompt(mode, transcript, highlightPrompt, noteStyle);

    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL_LARGE,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1500,
        temperature: 0.3,
        include_reasoning: false
      })
    });

    const data = await groqRes.json();
    if (!groqRes.ok) {
      console.error('Groq error (summarize):', data.error?.message);
      const e = new Error(data.error?.message || 'Groq error');
      e.code = data.error?.code;
      if (isModelUnavailableError(e)) return res.status(502).json({ error: FRIENDLY_AI_ERROR });
      return res.status(500).json({ error: e.message });
    }

    const summary = data.choices?.[0]?.message?.content;
    if (!summary) return res.status(500).json({ error: 'No result returned' });

    return res.status(200).json({ summary });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
