const {
  applyCors, verifyAuth, checkRateLimit, checkAndIncrementUsage,
  UPLOAD_MAX_CHUNKS, isValidUploadId, claimUploadChunk, startUploadSession,
  checkAudioAllowance, addTranscribedSeconds, sendUsageUnavailable, INPUT_LIMITS,
} = require('./_lib/auth');
const { MODEL_SMALL, MODEL_WHISPER, MODEL_WHISPER_TURBO, FRIENDLY_AI_ERROR, isModelUnavailableError, groqChat, BUSY_AI_CODE, sendServerError } = require('./_lib/models');
const { refundAiAction } = require('./_lib/auth');

// Record Lecture tidy-up: js/recorder.js sends a long transcript in pieces of about
// 7,000 characters (~8 minutes of speech). One piece = one AI action.
const TIDY_PIECE_MAX = 8000;     // larger text is returned untouched (not charged)
const TIDY_CONTEXT_MAX = 1200;   // end of the previous edited piece, for consistent speaker labels
// Words in a transcript, ignoring "Speaker 1:" / "Name:" labels at the start of a line.
function _tidyWords(s) {
  return (String(s || '').replace(/^[^:\n]{1,40}:[ \t]*/gm, '').match(/[A-Za-z0-9']+/g) || []).length;
}

// Chunks from the homepage Upload window are 16 kHz mono 16-bit WAV, at most ~80 seconds.
const CHUNK_BYTES_PER_SEC = 32000;
const CHUNK_MAX_SECONDS = 90;

// ── CHUNKED UPLOAD (video/audio file split in the browser) ─────────────────
// Body: { audio (base64 WAV), uploadId, chunkIndex, chunkCount, chunkSeconds }.
// One file = one AI action: only chunk 0 goes through the rate limit and usage check;
// later chunks must match the session recorded for that uploadId (api/_lib/auth.js).
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
  if (claim.status === 'new') {
    if (!(await checkRateLimit(uid, res))) return;
    if (!(await checkAudioAllowance(uid, res))) return;
    if (!(await checkAndIncrementUsage(uid, res, 'ai'))) return;
    await startUploadSession(uid, uploadId, chunkCount);
  } else if (claim.status === 'error') {
    // Can't tell whether this part belongs to a paid-for upload: refuse rather than guess.
    return sendUsageUnavailable(res, 'upload session');
  }

  try {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: 'audio/wav' }), 'audio.wav');
    form.append('model', MODEL_WHISPER);
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

    // Count by the real length of the audio we received, never more than the browser said.
    const declared = Number(req.body.chunkSeconds);
    await addTranscribedSeconds(uid, declared > 0 ? Math.min(declared, seconds) : seconds);
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
  // Size limits before charging (long recordings use the Upload button, which sends parts).
  const _tb = req.body || {};
  if (_tb.audio && (typeof _tb.audio !== 'string' || _tb.audio.length * 0.75 > INPUT_LIMITS.AUDIO_BYTES)) {
    return res.status(413).json({ code: 'too_long', error: 'This recording is too large to send in one piece. Use the Upload button for long recordings.' });
  }
  // Tidy-up text bigger than one piece is sent back untouched and not charged (the
  // recorder sends long lectures in pieces; an older cached page may still send it whole).
  if (_tb.text && !_tb.audio && String(_tb.text).length > TIDY_PIECE_MAX) {
    return res.status(200).json({ transcript: String(_tb.text), tidied: false });
  }
  if (!(await checkAndIncrementUsage(uid, res, 'ai'))) return;

  const { audio, mimeType, diarize, text } = _tb;
  const spkNames = _tb.spkNames ? String(_tb.spkNames).slice(0, 500) : '';
  if (!audio && !text) return res.status(400).json({ error: 'Missing audio or text' });

  // ── TEXT-ONLY FAST PATH (skip Whisper) ───────────────────
  // Tidies ONE piece of a Record Lecture transcript (punctuation + speaker labels).
  // Reply: { transcript, tidied }. tidied:false means the piece comes back exactly as sent
  // (AI busy, failed, cut its answer short, or dropped words) and the action is given back;
  // busy:true tells the recorder it may wait and try that piece again.
  if (text && !audio) {
    if (!text.trim()) return res.status(200).json({ transcript: text, tidied: false });
    const context = typeof _tb.context === 'string' ? _tb.context.slice(-TIDY_CONTEXT_MAX) : '';
    const keepRaw = async (busy) => {
      await refundAiAction(uid);
      return res.status(200).json(busy ? { transcript: text, tidied: false, busy: true } : { transcript: text, tidied: false });
    };
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

  const buffer = Buffer.from(audio, 'base64');

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
        return res.status(200).json({ transcript });
      }
    } catch {}
    // Fall through to Groq Whisper if AssemblyAI fails
  }

  // ── GROQ WHISPER ─────────────────────────────────────────
  try {
    const ext = (mimeType || 'audio/webm').split('/')[1]?.split(';')[0] || 'webm';
    const blob = new Blob([buffer], { type: mimeType || 'audio/webm' });
    // Use full large-v3 for final transcriptions (realtime flag uses turbo)
    const model = req.body.realtime ? MODEL_WHISPER_TURBO : MODEL_WHISPER;
    const form = new FormData();
    form.append('file', blob, `audio.${ext}`);
    form.append('model', model);
    form.append('response_format', 'json');
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
