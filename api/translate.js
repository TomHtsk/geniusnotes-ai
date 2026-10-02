const { applyCors, verifyAuth, checkRateLimit, checkAndIncrementUsage } = require('./_lib/auth');
const { MODEL_SMALL, FRIENDLY_AI_ERROR, isModelUnavailableError } = require('./_lib/models');

async function groqFetch(body, apiKey) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    if (r.ok) return r;
    if (r.status === 429 && attempt < 2) {
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }
    const err = await r.json().catch(() => ({}));
    const e = new Error(err.error?.message || `Groq ${r.status}`);
    e.code = err.error?.code;
    throw e;
  }
}

module.exports = async function handler(req, res) {
  applyCors(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const uid = await verifyAuth(req, res);
  if (!uid) return;
  if (!(await checkRateLimit(uid, res))) return;
  if (!(await checkAndIncrementUsage(uid, res, 'ai'))) return;

  const { text, targetLang, sourceLang } = req.body || {};
  if (!text?.trim()) return res.status(400).json({ error: 'No text provided' });
  if (!targetLang) return res.status(400).json({ error: 'No target language specified' });

  const from = sourceLang && sourceLang !== 'Auto-detect' ? `from ${sourceLang} ` : '';
  const prompt = `Translate the following text ${from}into ${targetLang}. Return ONLY the translated text — no explanations.\n\n${text.slice(0, 8000)}`;

  try {
    const r = await groqFetch({
      model: MODEL_SMALL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 3000,
      temperature: 0.1,
      include_reasoning: false,
    }, process.env.GROQ_API_KEY);

    const data = await r.json();
    const translation = data.choices?.[0]?.message?.content?.trim();
    if (!translation) return res.status(500).json({ error: 'No translation returned' });
    return res.status(200).json({ translation });
  } catch (err) {
    console.error('Groq error (translate):', err.message);
    if (isModelUnavailableError(err)) return res.status(502).json({ error: FRIENDLY_AI_ERROR });
    return res.status(500).json({ error: err.message });
  }
};
