const { MODEL_LARGE, MODEL_VISION } = require('./_lib/models');

const TB_COLORS = ['#FFE566','#6EE7B7','#7DD3FC','#F9A8D4','#FCA5A1','#C4B5FD','#FCD34D','#86EFAC'];

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const GROQ = process.env.GROQ_API_KEY;
  if (!GROQ) return res.status(500).json({ error: 'API key not configured' });

  try {
    const { chapter, questionsText, questionsImage, questionsMime } = req.body || {};
    if (!chapter) return res.status(400).json({ error: 'Chapter text is required' });

    let questions = (questionsText || '').trim();

    // Step 1: Extract questions from image via Groq vision
    if (questionsImage && !questions) {
      const vRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ}` },
        body: JSON.stringify({
          model: MODEL_VISION,
          messages: [{ role: 'user', content: [
            { type: 'image_url', image_url: { url: `data:${questionsMime || 'image/jpeg'};base64,${questionsImage}` } },
            { type: 'text', text: 'Extract every question from this image. List each question on a new line, numbered (1. 2. 3. ...). Return ONLY the numbered questions — no other text.' }
          ]}],
          max_tokens: 800, temperature: 0.1
        })
      });
      const vData = await vRes.json();
      questions = vData.choices?.[0]?.message?.content?.trim() || '';
      if (!questions) return res.status(400).json({ error: 'Could not extract questions from image.' });
    }

    if (!questions) return res.status(400).json({ error: 'No questions provided.' });

    // Step 2: Match questions to chapter phrases
    const chapterCapped = chapter.slice(0, 18000);

    const prompt = `You are a study assistant. A student has textbook questions and chapter text. For each question, find 1–3 short exact phrases or sentences from the chapter that directly answer or relate to that question. The phrases MUST be verbatim substrings of the chapter text (exact match, same spelling and punctuation).

QUESTIONS:
${questions}

CHAPTER TEXT:
${chapterCapped}

Return ONLY valid JSON, no markdown fences:
{
  "matches": [
    { "question": "full question text", "phrases": ["exact phrase from chapter"] },
    { "question": "full question text", "phrases": ["exact phrase 1", "exact phrase 2"] }
  ]
}`;

    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ}` },
      body: JSON.stringify({ model: MODEL_LARGE, messages: [{ role: 'user', content: prompt }], max_tokens: 3000, temperature: 0.1, include_reasoning: false, response_format: { type: 'json_object' } })
    });

    const data = await r.json();
    if (!r.ok) return res.status(500).json({ error: data.error?.message || 'AI error' });

    let raw = data.choices?.[0]?.message?.content?.trim() || '';
    raw = raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
    const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
    if (s !== -1 && e > s) raw = raw.slice(s, e + 1);

    let result;
    try { result = JSON.parse(raw); }
    catch { result = JSON.parse(raw.replace(/,\s*([}\]])/g, '$1')); }

    result.matches = (result.matches || []).map((m, i) => ({ ...m, color: TB_COLORS[i % TB_COLORS.length] }));

    return res.status(200).json({ matches: result.matches, questionsExtracted: questions });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
