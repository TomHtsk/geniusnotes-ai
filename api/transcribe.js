const {
  applyCors, verifyAuth, checkRateLimit, sendUsageUnavailable,
  UPLOAD_MAX_CHUNKS, isValidUploadId, claimUploadChunk, startUploadSession,
  chargeSeconds, requireSeconds, refundPart, trackSiteSeconds, LIMITS, refundCharges,
} = require('./_lib/auth');
const { DIARIZE_SECONDS_MULTIPLIER } = require('./_lib/plans');
const { MODEL_SMALL, MODEL_WHISPER_TURBO, FRIENDLY_AI_ERROR, isModelUnavailableError, groqChat, sendServerError, BUSY_AI_CODE } = require('./_lib/models');

// Record Lecture tidy-up: js/recorder.js sends a long transcript in pieces of about
// 7,000 characters (~8 minutes of speech). Each piece is charged its own spoken time.
const TIDY_PIECE_MAX = 8000;     // larger text is returned untouched (not charged)
const TIDY_CONTEXT_MAX = 1200;   // end of the previous edited piece, for consistent speaker labels
// Words in a transcript, ignoring "Speaker 1:" / "Name:" labels at the start of a line.
function _tidyWords(s) {
  return (String(s || '').replace(/^[^:\n]{1,40}:[ \t]*/gm, '').match(/[A-Za-z0-9']+/g) || []).length;
}

// Chunks from the homepage Upload window are 16 kHz mono 16-bit WAV, at most ~80 seconds.
const CHUNK_BYTES_PER_SEC = 32000;
const CHUNK_MAX_SECONDS = 90;

// Transcription uses the plan's monthly transcription time (the wallet), never AI credits.
// Free has none. Time is always charged BEFORE Whisper / AssemblyAI runs, and an error reply
// gives it back automatically (see chargeSeconds in api/_lib/auth.js).

// ── CHUNKED UPLOAD (video/audio file split in the browser) ─────────────────
// Body: { audio (base64 WAV), uploadId, chunkIndex, chunkCount, chunkSeconds, totalSeconds }.
// Chunk 0: hourly rate limit, the whole file must fit in the time left, and the person
// confirms the time it will use (409 confirm_cost, then the same chunk again with
// X-Confirm-Cost). Every chunk is then charged its real length (measured from the WAV size)
// under a key per chunk and attempt, so a retried chunk is charged once per real Whisper call.
async function handleUploadChunk(req, res, uid) {
  const { audio, uploadId } = req.body;
  const chunkIndex = Number(req.body.chunkIndex);
  const chunkCount = Number(req.body.chunkCount);

  if (!isValidUploadId(uploadId) || !Number.isInteger(chunkIndex) || chunkIndex < 0 ||
      !Number.isInteger(chunkCount) || chunkCount < 1 || chunkIndex >= chunkCount ||
      typeof audio !== 'string' || !audio) {
    return res.status(400).json({ error: 'Something went wrong preparing this file. Please try again.' });
  }
  if (chunkCount > UPLOAD_MAX_CHUNKS) {
    return res.status(400).json({ error: 'This file is too long. The limit is 60 minutes of audio.' });
  }

  const buffer = Buffer.from(audio, 'base64');
  const isWav = buffer.length > 44 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WAVE';
  const seconds = (buffer.length - 44) / CHUNK_BYTES_PER_SEC;
  if (!isWav || seconds > CHUNK_MAX_SECONDS) {
    return res.status(400).json({ error: 'Something went wrong preparing this file. Please try again.' });
  }

  const claim = await claimUploadChunk(uid, uploadId, chunkIndex);
  if (claim.status === 'rejected') return res.status(409).json({ error: claim.error });
  if (claim.status === 'error') return sendUsageUnavailable(res); // fail closed
  let attempt = claim.attempt || 1;
  if (claim.status === 'new') {
    if (!(await checkRateLimit(uid, res))) return;
    // The whole file must fit in the time left; the person confirms it first.
    const declaredTotal = Number(req.body.totalSeconds);
    const total = Math.ceil(declaredTotal > 0 ? Math.min(declaredTotal, chunkCount * CHUNK_MAX_SECONDS) : chunkCount * 80);
    if (!(await chargeSeconds(req, res, uid, total, { confirm: total, key: `up_${uploadId}_check`, reason: 'upload-check', dryRun: true }))) return;
    try { await startUploadSession(uid, uploadId, chunkCount); }
    catch (e) { return sendUsageUnavailable(res); }
    attempt = 1;
  }
  // Charge this chunk's real length before Whisper runs.
  const chunkSecs = Math.ceil(seconds);
  if (!(await chargeSeconds(req, res, uid, chunkSecs, { key: `up_${uploadId}_${chunkIndex}_${attempt}`, reason: 'upload-chunk' }))) return;

  try {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: 'audio/wav' }), 'audio.wav');
    form.append('model', MODEL_WHISPER_TURBO);
    form.append('response_format', 'json');
    form.append('language', 'en');

    const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: form
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error('Groq error (transcribe/chunk):', data.error?.message || r.status);
      const e = new Error(data.error?.message || ''); e.code = data.error?.code;
      if (isModelUnavailableError(e)) return res.status(502).json({ error: FRIENDLY_AI_ERROR });
      return res.status(502).json({ error: 'We couldn\'t transcribe part of this file. Please try again.' });
    }

    await trackSiteSeconds(chunkSecs);
    return res.status(200).json({ transcript: (data.text || '').trim(), chunkIndex });
  } catch (err) {
    console.error('Groq error (transcribe/chunk):', err.message);
    return res.status(502).json({ error: 'We couldn\'t transcribe part of this file. Please try again.' });
  }
}

module.exports = async function handler(req, res) {
  applyCors(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const uid = await verifyAuth(req, res);
  if (!uid) return;
  if (req.body && req.body.uploadId !== undefined) return handleUploadChunk(req, res, uid);
  if (!(await checkRateLimit(uid, res))) return;

  const { audio, mimeType, diarize, text } = req.body || {};
  const spkNames = req.body?.spkNames ? String(req.body.spkNames).slice(0, 500) : '';
  if (!audio && !text) return res.status(400).json({ error: 'Missing audio or text' });

  // ── TEXT-ONLY FAST PATH (skip Whisper) ───────────────────
  // The browser already turned the speech into text (free for us); this only tidies it and
  // labels speakers. The recording's length is counted from the words (about 150 spoken
  // words a minute) — never from a number the browser sends — up to the time left.
  // ONE piece of a lecture per request (see TIDY_PIECE_MAX). Reply: { transcript, tidied }.
  // tidied:false means the piece comes back exactly as sent (AI busy, failed, cut its answer
  // short, or dropped words) and its time is given back; busy:true lets the recorder retry.
  if (text && !audio) {
    if (!String(text).trim()) return res.status(200).json({ transcript: text, tidied: false });
    // Bigger than one piece (an older cached page may still send it whole): untouched, not charged.
    if (String(text).length > TIDY_PIECE_MAX) return res.status(200).json({ transcript: String(text), tidied: false });
    const context = typeof req.body.context === 'string' ? req.body.context.slice(-TIDY_CONTEXT_MAX) : '';
    const keepRaw = async (busy) => {
      await refundCharges(res, 'tidy-failed');
      return res.status(200).json(busy ? { transcript: text, tidied: false, busy: true } : { transcript: text, tidied: false });
    };
    const spoken = Math.ceil(String(text).trim().split(/\s+/).length / 2.5);
    if (!(await chargeSeconds(req, res, uid, spoken, { partial: true, minLeft: 1, reason: 'recording-text' }))) return;
    await trackSiteSeconds(spoken);
    const nameList = spkNames ? spkNames.split(',').map(n => n.trim()).filter(Boolean) : [];
    const namesNote = nameList.length > 0
      ? `Label the speakers as: ${nameList.join(', ')} (in order of first appearance).`
      : 'Label each speaker as Speaker 1, Speaker 2, Speaker 3, etc. in order of first appearance.';
    try {
      const dr = await groqChat({
          model: MODEL_SMALL,
          temperature: 0.15,
          // Room for the whole edited piece plus the model's hidden reasoning, while
          // prompt + piece + max_tokens stays under Groq's free 8,000 tokens a minute.
          max_tokens: Math.min(4500, Math.ceil(text.length / 3) + 1500),
          include_reasoning: false,
          messages: [
            {
              role: 'system',
              content: `You are an expert transcript editor. Given raw speech-to-text output, do ALL of the following:

1. FIX GRAMMAR & PUNCTUATION
   - Add correct commas, periods, question marks, and exclamation points
   - Capitalize the start of every sentence and all proper nouns
   - Fix "i" → "I" throughout, including contractions (I'm, I've, I'll, I'd)
   - Remove duplicated words from SR artifacts ("the the" → "the", "and and" → "and")
   - Break run-on sentences at natural pause points
   - Fix "gonna" → "going to", "wanna" → "want to", "kinda" → "kind of"
   - Correct obvious speech-to-text mishearings where you are confident

2. IDENTIFY & LABEL SPEAKERS — split into turns, label every one. Use ALL these signals:
   - Question followed by an answer (almost always a different person)
   - Shifts between "I" and "you" perspectives
   - Acknowledgments: "yeah", "okay", "right", "sure", "I see", "got it"
   - Direct address: "John, …", "So what do you think?"
   - Topic handoffs, interruptions, contrasting views
   - Style or register changes between turns
   When uncertain, SPLIT — over-detecting turns is better than merging two speakers.
   ${namesNote}

FORMAT:
- Each speaker turn on its own line: "Speaker 1: [their words]"
- Same speaker continuing → keep on one line
- Only one speaker detected → still label as "Speaker 1:"
- Output ONLY the labeled lines — zero commentary, no headers, no blank intro`
            },
            { role: 'user', content: context
              ? `The transcript so far ended like this (already edited - do NOT repeat it; use it only to keep the same speaker labels):\n"""${context}"""\n\nEdit and label this next part of the transcript:\n\n${text}`
              : `Edit and label this transcript:\n\n${text}` }
          ]
      });
      const dd = await dr.json();
      if (!dr.ok) {
        console.error('Groq error (transcribe/label):', dd.error?.message);
        return keepRaw(dd.error?.code === BUSY_AI_CODE);
      }
      const choice = dd.choices?.[0] || {};
      const labeled = (choice.message?.content || '').trim();
      // Never return a shortened transcript: an answer cut off at max_tokens, or one that
      // lost more than 15% of the words, is thrown away and the piece is kept as spoken.
      if (!labeled || choice.finish_reason === 'length' || _tidyWords(labeled) < 0.85 * _tidyWords(text)) {
        console.error('transcribe/label: unusable answer', choice.finish_reason, _tidyWords(labeled), '/', _tidyWords(text));
        return keepRaw(false);
      }
      return res.status(200).json({ transcript: labeled, tidied: true });
    } catch (err) {
      console.error('Groq error (transcribe/label):', err.message);
      return keepRaw(false);
    }
  }

  const buffer = Buffer.from(String(audio), 'base64');
  const isPreview = !!req.body.realtime;

  // Hard limits, then the time check / reservation BEFORE any transcription service runs.
  //  - Live previews while recording re-send the same growing recording every 15 s: they
  //    are small (MAX_PREVIEW_BYTES), not charged, and need some time left.
  //  - A finished recording reserves an over-estimate of its length from its size (at most
  //    the time left), then gives back the difference once the real length is known.
  if (buffer.length > (isPreview ? LIMITS.MAX_PREVIEW_BYTES : LIMITS.MAX_AUDIO_BYTES)) {
    return res.status(413).json({ code: 'too_long', error: 'This recording is too large to send in one piece. Use the Upload button for long recordings.' });
  }
  let reservedKey = null, reserved = 0;
  if (isPreview) {
    if (!(await requireSeconds(res, uid, 1))) return;
  } else {
    const est = Math.min(LIMITS.MAX_AUDIO_SECONDS, Math.ceil(buffer.length / LIMITS.AUDIO_EST_BYTES_PER_SEC));
    const r0 = await chargeSeconds(req, res, uid, est, { partial: true, minLeft: Math.min(est, LIMITS.MIN_SECONDS_TO_START), reason: diarize ? 'recording-speakers' : 'recording' });
    if (!r0) return;
    reservedKey = res._gnCharges[res._gnCharges.length - 1].key;
    reserved = r0.charged ? r0.charged.seconds : est;
  }
  // Charge the real length (never more than was reserved) and give back the rest.
  const settle = async (realSeconds) => {
    if (!reservedKey) return;
    const real = Math.ceil(Math.max(0, Number(realSeconds) || 0));
    if (real > 0 && real < reserved) await refundPart(uid, reservedKey, { seconds: reserved - real }, 'actual-length');
    await trackSiteSeconds(Math.min(real || reserved, reserved));
  };

  // ── DIARIZATION: AssemblyAI ───────────────────────────────
  if (diarize && process.env.ASSEMBLYAI_API_KEY) {
    try {
      const AAI = process.env.ASSEMBLYAI_API_KEY;
      const headers = { 'authorization': AAI, 'content-type': 'application/json' };

      const uploadRes = await fetch('https://api.assemblyai.com/v2/upload', {
        method: 'POST',
        headers: { 'authorization': AAI, 'content-type': 'application/octet-stream' },
        body: buffer
      });
      const { upload_url } = await uploadRes.json();

      const submitRes = await fetch('https://api.assemblyai.com/v2/transcript', {
        method: 'POST',
        headers,
        body: JSON.stringify({ audio_url: upload_url, speaker_labels: true })
      });
      const { id } = await submitRes.json();

      let result = null;
      const deadline = Date.now() + 55000;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 3000));
        const pollRes = await fetch(`https://api.assemblyai.com/v2/transcript/${id}`, { headers });
        result = await pollRes.json();
        if (result.status === 'completed' || result.status === 'error') break;
      }

      if (result && result.status === 'completed' && result.utterances && result.utterances.length) {
        const nameList = spkNames ? spkNames.split(',').map(n => n.trim()).filter(Boolean) : [];
        const speakerMap = {};
        let counter = 0;
        const transcript = result.utterances.map(u => {
          if (!speakerMap[u.speaker]) {
            speakerMap[u.speaker] = nameList[counter] || `Speaker ${counter + 1}`;
            counter++;
          }
          return `${speakerMap[u.speaker]}: ${u.text}`;
        }).join('\n');
        await settle((result.audio_duration || 0) * DIARIZE_SECONDS_MULTIPLIER);
        return res.status(200).json({ transcript });
      }
    } catch {}
    // Fall through to Groq Whisper if AssemblyAI fails
  }

  // ── GROQ WHISPER ─────────────────────────────────────────
  try {
    const ext = (mimeType || 'audio/webm').split('/')[1]?.split(';')[0] || 'webm';
    const blob = new Blob([buffer], { type: mimeType || 'audio/webm' });
    // Turbo for everything (about a third of the price of full large-v3). Final
    // transcriptions ask for verbose_json so Groq tells us the real audio length to charge.
    const form = new FormData();
    form.append('file', blob, `audio.${ext}`);
    form.append('model', MODEL_WHISPER_TURBO);
    form.append('response_format', isPreview ? 'json' : 'verbose_json');
    form.append('language', 'en');
    // Seed prompt helps Whisper with classroom/lecture vocabulary
    if (req.body.prompt) form.append('prompt', String(req.body.prompt).slice(0, 500));

    const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: form
    });
    const data = await r.json();
    if (!r.ok) {
      console.error('Groq error (transcribe/whisper):', data.error?.message);
      const e = new Error(data.error?.message || 'Transcription failed');
      e.code = data.error?.code;
      if (isModelUnavailableError(e)) return res.status(502).json({ error: FRIENDLY_AI_ERROR });
      return sendServerError(res, e, 'transcribe', "We couldn't transcribe this recording. Please try again.");
    }

    let transcript = data.text || '';
    if (!isPreview) await settle(data.duration);

    if (diarize && transcript.trim()) {
      const nameList = spkNames ? spkNames.split(',').map(n => n.trim()).filter(Boolean) : [];
      const namesNote = nameList.length > 0
        ? `The speakers are: ${nameList.join(', ')}. Use their exact names as labels.`
        : 'Label speakers as Speaker 1, Speaker 2, Speaker 3, etc.';
      try {
        const dr = await groqChat({
            model: MODEL_SMALL,
            temperature: 0.2,
            max_tokens: 3000,
            include_reasoning: false,
            messages: [
              {
                role: 'system',
                content: `You are a speaker diarization expert. Label each speaker turn.\n${namesNote}\nOutput only labeled lines, no commentary.`
              },
              { role: 'user', content: `Label all speakers:\n\n${transcript}` }
            ]
        });
        const dd = await dr.json();
        if (!dr.ok) console.error('Groq error (transcribe/diarize-label):', dd.error?.message);
        const labeled = dd.choices?.[0]?.message?.content?.trim();
        if (labeled) transcript = labeled;
      } catch (err) { console.error('Groq error (transcribe/diarize-label):', err.message); }
    }

    return res.status(200).json({ transcript });
  } catch (err) {
    console.error('Groq error (transcribe):', err.message);
    if (isModelUnavailableError(err)) return res.status(502).json({ error: FRIENDLY_AI_ERROR });
    return sendServerError(res, err, 'transcribe', "We couldn't transcribe this recording. Please try again.");
  }
};
