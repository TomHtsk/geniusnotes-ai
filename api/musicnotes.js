export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { lyrics, title, key, style } = req.body || {};
  if (!lyrics || !lyrics.trim()) return res.status(400).json({ error: 'No lyrics provided' });

  const prompt = `You are a music composer. Convert the following song lyrics into ABC notation format.

Rules:
- Output ONLY valid ABC notation — no explanations, no markdown code blocks, no extra text
- Include X:, T:, M:, L:, Q:, K: headers
- Write a simple, singable melody — quarter and eighth notes mostly
- Add chord symbols above the staff using "Chord" format (e.g. "C", "Am", "G7", "F")
- Include ALL lyrics under the notes using w: lines after each staff line
- Split syllables with hyphens in w: lines (e.g. "hap-py birth-day to you")
- Use 4/4 time unless lyrics clearly suggest otherwise
- Default to C major unless the user specified a different key
- Keep it 1–2 lines of music maximum (do not write the full song if long — just the first verse/chorus)

Song title: ${title || 'Song'}
Key: ${key || 'C major'}
Style: ${style || 'folk/pop'}

Lyrics:
${lyrics.slice(0, 1200)}

Output ONLY the ABC notation:`;

  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1500,
      temperature: 0.65
    })
  });

  if (!resp.ok) {
    const err = await resp.text();
    return res.status(502).json({ error: 'Groq API error', details: err });
  }

  const data = await resp.json();
  let abc = (data.choices?.[0]?.message?.content || '').trim();

  // Strip markdown code fences if model wrapped it
  abc = abc.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();

  if (!abc || !abc.includes('K:')) {
    return res.status(500).json({ error: 'Invalid ABC notation generated. Please try again.' });
  }

  return res.status(200).json({ abc });
}
