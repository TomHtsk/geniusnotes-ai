module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  // musicnotes route (rewired from /api/musicnotes)
  if (req.body?.lyrics) {
    const { lyrics, title, key, style } = req.body;
    if (!lyrics.trim()) return res.status(400).json({ error: 'No lyrics provided' });
    const prompt = `You are a music composer. Convert the following song lyrics into ABC notation format.\n\nRules:\n- Output ONLY valid ABC notation — no explanations, no markdown code blocks, no extra text\n- Include X:, T:, M:, L:, Q:, K: headers\n- Write a simple, singable melody — quarter and eighth notes mostly\n- Add chord symbols above the staff using "Chord" format (e.g. "C", "Am", "G7", "F")\n- Include ALL lyrics under the notes using w: lines after each staff line\n- Split syllables with hyphens in w: lines (e.g. "hap-py birth-day to you")\n- Use 4/4 time unless lyrics clearly suggest otherwise\n- Default to C major unless the user specified a different key\n- Keep it 1–2 lines of music maximum\n\nSong title: ${title||'Song'}\nKey: ${key||'C major'}\nStyle: ${style||'folk/pop'}\n\nLyrics:\n${lyrics.slice(0,1200)}\n\nOutput ONLY the ABC notation:`;
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${process.env.GROQ_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:'llama-3.3-70b-versatile',messages:[{role:'user',content:prompt}],max_tokens:1500,temperature:0.65})});
    if (!resp.ok) return res.status(502).json({ error: 'Groq API error' });
    const data = await resp.json();
    let abc = (data.choices?.[0]?.message?.content||'').trim().replace(/^```[a-z]*\n?/i,'').replace(/\n?```$/i,'').trim();
    if (!abc||!abc.includes('K:')) return res.status(500).json({ error: 'Invalid ABC notation generated. Please try again.' });
    return res.status(200).json({ abc });
  }

  try {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ error: 'No input provided' });
    const input = url.trim();

    const isYouTube = /youtu\.be\/|youtube\.com\/watch|youtube\.com\/shorts/.test(input);
    const isURL     = /^https?:\/\//.test(input);

    let songTitle = '';
    let artist    = '';

    // ── YouTube ──────────────────────────────────────────────────────────────
    if (isYouTube) {
      const vidMatch = input.match(/(?:v=|youtu\.be\/|shorts\/)([A-Za-z0-9_-]{11})/);
      const videoId  = vidMatch ? vidMatch[1] : null;

      if (videoId) {
        try {
          const oe = await fetch(
            `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
            { signal: AbortSignal.timeout(5000) }
          );
          if (oe.ok) { const d = await oe.json(); songTitle = d.title || ''; }
        } catch (_) {}
      }

      // Try Supadata transcript first (actual audio content)
      const SUPADATA_KEY = process.env.SUPADATA_API_KEY;
      if (videoId && SUPADATA_KEY) {
        for (const endpoint of [
          `https://api.supadata.ai/v1/youtube/transcript?videoId=${videoId}&lang=en`,
          `https://api.supadata.ai/v1/youtube/transcript?videoId=${videoId}`,
        ]) {
          try {
            const r = await fetch(endpoint, {
              headers: { 'x-api-key': SUPADATA_KEY },
              signal: AbortSignal.timeout(15000),
            });
            if (!r.ok) continue;
            const data = await r.json();
            const text = Array.isArray(data?.content)
              ? data.content.map(s => s.text).join('\n')
              : (data?.content || data?.transcript || '');
            if (text.trim()) return res.status(200).json({ lyrics: text.trim(), source: 'transcript', songTitle });
          } catch (_) { continue; }
        }
      }

      // Fallback: lrclib search by title
      if (songTitle) {
        const hit = await tryLrclib(songTitle, '');
        if (hit) return res.status(200).json({ ...hit, songTitle: hit.songTitle || songTitle });
      }

      return res.status(404).json({
        error: songTitle
          ? `Couldn't extract lyrics for "${songTitle}". This video may not have captions enabled.`
          : 'Could not read video info. Please check the URL.',
      });
    }

    // ── Unsupported URL ───────────────────────────────────────────────────────
    if (isURL) {
      return res.status(400).json({ error: 'Only YouTube links are supported. Try typing the song name — Artist instead.' });
    }

    // ── Plain text: "Artist - Song" or "Song" ─────────────────────────────────
    const parts = input.split(/\s*[-–—]\s*/);
    if (parts.length >= 2) {
      artist    = parts[0].trim();
      songTitle = parts.slice(1).join(' - ').trim();
    } else {
      songTitle = input;
    }
    return findLyrics(res, songTitle, artist);

  } catch (err) {
    return res.status(500).json({ error: 'Server error: ' + (err.message || 'Unknown') });
  }
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function coreTitle(title) {
  return title
    .replace(/\s*\([^)]*(?:remix|remaster|edit|version|live|cover|ft\.|feat\.|official|instrumental)[^)]*\)/gi, '')
    .replace(/\s*\[[^\]]*(?:remix|remaster|edit|version|live|cover|ft\.|feat\.|official)[^\]]*\]/gi, '')
    .replace(/(?:\s+\S+){0,3}\s+(?:remix|remaster|edit|cover|instrumental|acoustic)\s*$/gi, '')
    .trim();
}

async function findLyrics(res, songTitle, artist) {
  const clean   = coreTitle(songTitle);
  const isRemix = clean !== songTitle;

  let hit = await tryLrclib(songTitle, artist);
  if (hit) return res.status(200).json(hit);

  if (isRemix) {
    hit = await tryLrclib(clean, artist);
    if (hit) return res.status(200).json(hit);
  }

  hit = await tryLrclib(clean || songTitle, '');
  if (hit) return res.status(200).json(hit);

  if (artist) {
    const lyricsOvh = await tryLyricsOvh(artist, clean || songTitle);
    if (lyricsOvh) return res.status(200).json({ lyrics: lyricsOvh, source: 'lyrics', songTitle: clean || songTitle, artist });
  }

  return aiLyrics(res, clean || songTitle, isRemix ? '' : artist);
}

async function tryLrclib(trackName, artistName) {
  try {
    const params = artistName
      ? `track_name=${encodeURIComponent(trackName)}&artist_name=${encodeURIComponent(artistName)}`
      : `q=${encodeURIComponent(trackName)}`;
    const r = await fetch(`https://lrclib.net/api/search?${params}`, { signal: AbortSignal.timeout(7000) });
    if (!r.ok) return null;
    const results = await r.json();
    const match = results.find(r => r.plainLyrics) || results[0];
    if (match?.plainLyrics) {
      return { lyrics: match.plainLyrics, source: 'lyrics', songTitle: match.trackName || trackName, artist: match.artistName || artistName };
    }
    if (artistName) {
      const r2 = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(trackName)}`, { signal: AbortSignal.timeout(5000) });
      if (r2.ok) {
        const results2 = await r2.json();
        const m2 = results2.find(r => r.plainLyrics);
        if (m2?.plainLyrics) {
          return { lyrics: m2.plainLyrics, source: 'lyrics', songTitle: m2.trackName || trackName, artist: m2.artistName || artistName };
        }
      }
    }
  } catch (_) {}
  return null;
}

async function tryLyricsOvh(artist, title) {
  try {
    const r = await fetch(
      `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!r.ok) return null;
    const d = await r.json();
    return d.lyrics || null;
  } catch (_) { return null; }
}

async function aiLyrics(res, songTitle, artist) {
  const GROQ_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_KEY) return res.status(404).json({ error: `Lyrics not found for "${songTitle}". Try: Song name — Artist` });

  const who    = artist ? `"${songTitle}" by ${artist}` : `"${songTitle}"`;
  const prompt = `Write out the complete, accurate lyrics to the song ${who}. Output ONLY the lyrics — no intro, no explanation, no headers. If you do not know the lyrics, respond with exactly: [NOT FOUND]`;

  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_KEY}` },
      body: JSON.stringify({ model: 'llama-3.1-8b-instant', messages: [{ role: 'user', content: prompt }], max_tokens: 1500, temperature: 0.05 }),
      signal: AbortSignal.timeout(20000),
    });
    const data = await r.json();
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text || text.includes('[NOT FOUND]')) {
      return res.status(404).json({ error: `Lyrics not found for "${songTitle}". Try: Song name — Artist` });
    }
    return res.status(200).json({ lyrics: text, source: 'ai', songTitle, artist });
  } catch (_) {
    return res.status(404).json({ error: `Lyrics not found for "${songTitle}". Try: Song name — Artist` });
  }
}
