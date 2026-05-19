const SYSTEM = `You are an expert AI study tutor for GeniusNotes AI. Help students learn effectively.

Guidelines:
- Explain concepts clearly — start simple, build to complexity
- Use examples, analogies, and real-world connections
- Break down complex topics into digestible steps
- Keep responses concise: 2-4 paragraphs or a short bulleted list
- Use **bold** for key terms
- If a student seems stuck, try a completely different explanation approach
- Be encouraging but academically rigorous`;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { messages } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0)
      return res.status(400).json({ error: 'Missing messages' });

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'system', content: SYSTEM }, ...messages.slice(-20)],
        max_tokens: 700,
        temperature: 0.65
      })
    });

    const data = await groqRes.json();
    if (!groqRes.ok) return res.status(500).json({ error: data.error?.message || 'Groq error' });

    const reply = data.choices?.[0]?.message?.content;
    if (!reply) return res.status(500).json({ error: 'No reply returned' });

    return res.status(200).json({ reply });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
