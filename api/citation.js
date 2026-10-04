import { MODEL_SMALL, groqChat, BUSY_AI_ERROR } from './_lib/models.js';

const STYLE_NAMES = {
  apa7:      'APA 7th Edition',
  mla9:      'MLA 9th Edition',
  chicago18: 'Chicago 18th Edition (Notes-Bibliography)',
  turabian9: 'Turabian 9th Edition',
  ieee:      'IEEE Style',
};

// groqChat (api/_lib/models.js) retries a rate-limited request on the other model.
async function groqFetch(body, apiKey) {
  const r = await groqChat(body, { apiKey, timeoutMs: 25000 });
  if (r.ok) return r;
  const err = await r.json().catch(() => ({}));
  throw new Error(err.error?.message || `Groq ${r.status}`);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { style, sourceType, autoUrl, ...fields } = req.body || {};
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  let meta = { ...fields };

  if (autoUrl) {
    try {
      const jinaResp = await fetch(`https://r.jina.ai/${autoUrl}`, {
        headers: { 'X-Return-Format': 'markdown' },
        signal: AbortSignal.timeout(8000),
      });
      const text = await jinaResp.text();
      const titleMatch = text.match(/^#\s+(.+)/m);
      if (titleMatch && !meta.title) meta.title = titleMatch[1].trim();
      if (!meta.url) meta.url = autoUrl;
      if (!meta.siteName) {
        try { meta.siteName = new URL(autoUrl).hostname.replace('www.', ''); } catch {}
      }
    } catch { /* proceed without auto-fill */ }
  }

  const fieldLines = Object.entries(meta)
    .filter(([, v]) => v && String(v).trim())
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');

  if (!fieldLines.trim()) return res.status(400).json({ error: 'No source information provided.' });

  const styleName = STYLE_NAMES[style] || 'APA 7th Edition';
  const prompt = `Generate a precisely formatted ${styleName} citation for this ${sourceType || 'source'}.

${fieldLines}

Return ONLY valid JSON:
{"citation":"Full reference entry per ${styleName}","inText":"In-text or footnote format"}

- Match ${styleName} punctuation, capitalization, italics (*Title*), and field order exactly
- IEEE: use [1] format. Chicago/Turabian: footnote in inText. No text outside JSON.`;

  try {
    const r = await groqFetch({
      model: MODEL_SMALL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 600,
      temperature: 0.05,
      include_reasoning: false,
      response_format: { type: 'json_object' },
    }, apiKey);

    const data = await r.json();
    const raw = data.choices?.[0]?.message?.content || '';
    const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('No JSON in response');
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return res.json(parsed);
  } catch (err) {
    if (err.message === BUSY_AI_ERROR) return res.status(429).json({ error: BUSY_AI_ERROR });
    return res.status(500).json({ error: err.message || 'Could not generate citation.' });
  }
}
