const SYSTEM = `You are an expert AI study tutor for GeniusNotes AI. Help students learn effectively.
- Explain concepts clearly — start simple, build up
- Use examples and real-world connections
- Keep responses concise: 2-4 paragraphs or a short list
- Use **bold** for key terms
- Be encouraging but academically rigorous`;

async function groqFetch(body, apiKey) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    if (r.ok) return r;
    if (r.status === 429 && attempt < 2) {
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }
    const err = await r.json().catch(() => ({}));
    throw new Error(err.error?.message || `Groq ${r.status}`);
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { messages } = req.body || {};
    if (!Array.isArray(messages) || !messages.length)
      return res.status(400).json({ error: 'Missing messages' });

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

    const r = await groqFetch({
      model: 'llama-3.1-8b-instant',
      messages: [{ role: 'system', content: SYSTEM }, ...messages.slice(-20)],
      max_tokens: 700,
      temperature: 0.65,
    }, apiKey);

    const data = await r.json();
    const reply = data.choices?.[0]?.message?.content;
    if (!reply) return res.status(500).json({ error: 'No reply returned' });
    return res.status(200).json({ reply });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
