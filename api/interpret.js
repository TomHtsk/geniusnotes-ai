async function ddgLookup(query) {
  try {
    const r = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`, { signal: AbortSignal.timeout(5000) });
    const d = await r.json();
    const snippet = d.AbstractText || d.Answer || (d.RelatedTopics?.[0]?.Text) || '';
    const source = d.AbstractSource || d.AnswerType || '';
    return snippet ? `[${source || 'Web'}] ${snippet}` : '';
  } catch { return ''; }
}

async function groqCall(prompt, apiKey) {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 500,
      temperature: 0.5
    }),
    signal: AbortSignal.timeout(20000)
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || 'AI error');
  return data.choices?.[0]?.message?.content?.trim() || '';
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const GROQ = process.env.GROQ_API_KEY;
  if (!GROQ) return res.status(500).json({ error: 'API key not configured' });

  const { text, mode, noteTitle, noteContext } = req.body || {};
  if (!text?.trim()) return res.status(400).json({ error: 'No text provided' });

  const ctx = noteTitle
    ? `The note is titled "${noteTitle}"${noteContext ? `. Surrounding context: "${noteContext.slice(0, 400)}"` : ''}.`
    : '';

  try {
    let result = '';
    let webSnippet = '';

    if (mode === 'define') {
      // Parallel: web lookup + LLM definition
      [webSnippet] = await Promise.all([ddgLookup(text)]);
      const webHint = webSnippet ? `\n\nWeb reference found: "${webSnippet}"` : '';
      const prompt = `You are a precise lexicographer and scholar. ${ctx}\n\nProvide a clear, thorough definition of: "${text}"\n\nCover: (1) literal/dictionary meaning, (2) origin or etymology if notable, (3) usage in relevant fields (philosophy, religion, science, etc.), (4) any specialized meaning in the note's context.${webHint}\n\nBe informative but concise. 3–5 sentences.`;
      result = await groqCall(prompt, GROQ);
      if (webSnippet) result += `\n\n🌐 ${webSnippet}`;

    } else if (mode === 'interpret') {
      webSnippet = await ddgLookup(text + ' meaning origin');
      const webHint = webSnippet ? `\n\nRelevant web context: "${webSnippet}"` : '';
      const prompt = `You are a scholar with broad knowledge across all fields — philosophy, science, religion, literature, history, law, medicine, and more. ${ctx}\n\nFirst, identify what field, tradition, or context this passage most likely comes from based solely on the text and note context. Then interpret it accurately within that context.\n\nUncover the layers:\n1. What it says on the surface\n2. What it actually means in its proper context\n3. Any deeper or non-obvious meaning hidden in the phrasing\n\nDo not name or label traditions unless directly quoting them. Just interpret clearly and accurately.${webHint}\n\nPassage: "${text}"`;
      result = await groqCall(prompt, GROQ);

    } else {
      // comprehend
      webSnippet = await ddgLookup(text);
      const webHint = webSnippet ? `\n\nAdditional context from web: "${webSnippet}"` : '';
      const prompt = `You are a brilliant teacher who can explain anything clearly. ${ctx}\n\nExplain the following passage so anyone can understand it. What does it mean? What are its core ideas? Why does it matter? Give genuine understanding in plain language.${webHint}\n\n3–5 sentences.\n\nPassage: "${text}"`;
      result = await groqCall(prompt, GROQ);
    }

    return res.status(200).json({ result });
  } catch(err) {
    return res.status(500).json({ error: err.message });
  }
};
