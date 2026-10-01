const { applyCors, verifyAuth, checkRateLimit, checkAndIncrementUsage } = require('./_lib/auth');

module.exports = async function handler(req, res) {
  applyCors(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const uid = await verifyAuth(req, res);
  if (!uid) return;
  if (!(await checkRateLimit(uid, res))) return;
  if (!(await checkAndIncrementUsage(uid, res, 'ai'))) return;

  const { audio, mimeType, diarize, spkNames, text } = req.body || {};
  if (!audio && !text) return res.status(400).json({ error: 'Missing audio or text' });

  // ── TEXT-ONLY FAST PATH (skip Whisper) ───────────────────
  if (text && !audio) {
    if (!text.trim()) return res.status(200).json({ transcript: text });
    const nameList = spkNames ? spkNames.split(',').map(n => n.trim()).filter(Boolean) : [];
    const namesNote = nameList.length > 0
      ? `Label the speakers as: ${nameList.join(', ')} (in order of first appearance).`
      : 'Label each speaker as Speaker 1, Speaker 2, Speaker 3, etc. in order of first appearance.';
    try {
      const dr = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          temperature: 0.15,
          max_tokens: 2000,
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
            { role: 'user', content: `Edit and label this transcript:\n\n${text}` }
          ]
        })
      });
      const dd = await dr.json();
      const labeled = dd.choices?.[0]?.message?.content?.trim();
      return res.status(200).json({ transcript: labeled || text });
    } catch {
      return res.status(200).json({ transcript: text });
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
    const model = req.body.realtime ? 'whisper-large-v3-turbo' : 'whisper-large-v3';
    const form = new FormData();
    form.append('file', blob, `audio.${ext}`);
    form.append('model', model);
    form.append('response_format', 'json');
    form.append('language', 'en');
    // Seed prompt helps Whisper with classroom/lecture vocabulary
    if (req.body.prompt) form.append('prompt', req.body.prompt);

    const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: form
    });
    const data = await r.json();
    if (!r.ok) return res.status(500).json({ error: data.error?.message || 'Transcription failed' });

    let transcript = data.text || '';

    if (diarize && transcript.trim()) {
      const nameList = spkNames ? spkNames.split(',').map(n => n.trim()).filter(Boolean) : [];
      const namesNote = nameList.length > 0
        ? `The speakers are: ${nameList.join(', ')}. Use their exact names as labels.`
        : 'Label speakers as Speaker 1, Speaker 2, Speaker 3, etc.';
      try {
        const dr = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'llama-3.3-70b-versatile',
            temperature: 0.2,
            max_tokens: 2000,
            messages: [
              {
                role: 'system',
                content: `You are a speaker diarization expert. Label each speaker turn.\n${namesNote}\nOutput only labeled lines, no commentary.`
              },
              { role: 'user', content: `Label all speakers:\n\n${transcript}` }
            ]
          })
        });
        const dd = await dr.json();
        const labeled = dd.choices?.[0]?.message?.content?.trim();
        if (labeled) transcript = labeled;
      } catch {}
    }

    return res.status(200).json({ transcript });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
