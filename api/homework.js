const { applyCors, verifyAuth, checkRateLimit, chargeCredits, creditsForSize, rejectTooLong, LIMITS } = require('./_lib/auth');
const { MODEL_LARGE, MODEL_VISION, FRIENDLY_AI_ERROR, isModelUnavailableError, groqChat, sendBusyIfNeeded, sendServerError } = require('./_lib/models');

module.exports = async function handler(req, res) {
  applyCors(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const uid = await verifyAuth(req, res);
  if (!uid) return;
  if (!(await checkRateLimit(uid, res))) return;
  const _hb = req.body || {};
  if (rejectTooLong(res, String(_hb.text || '').length)) return;
  if (_hb.image && (typeof _hb.image !== 'string' || _hb.image.length > LIMITS.MAX_IMAGE_CHARS)) return res.status(413).json({ code: 'too_long', error: 'This photo is too large. Please use a smaller photo.' });
  if (!(await chargeCredits(req, res, uid, creditsForSize({ chars: String(_hb.text || '').length, pages: _hb.image ? 1 : 0 }), { reason: 'homework' }))) return;

  const { image, mimeType, subject, text } = req.body || {};
  if (!image && !text) return res.status(400).json({ error: 'Missing image or text' });

  const subjectHint = subject ? `The subject appears to be ${subject}.` : '';

  const prompt = `You are an expert homework tutor. ${subjectHint} Analyze this homework problem from the image and provide a clear, detailed step-by-step solution.

MATH FORMATTING — CRITICAL RULES (follow exactly):
- Wrap EVERY math expression in dollar signs: $...$
- This includes: variables like $x$, numbers like $3$, fractions like $\\frac{a}{b}$, functions like $\\ln(x)$, $\\sqrt{x}$, $\\sin(\\theta)$
- Display equations on their own line use: $$x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}$$
- NEVER write bare LaTeX outside $...$. Example: write "$\\ln(x^3) = 3\\ln(x)$" NOT "\\ln(x^3) = 3\\ln(x)"
- Do NOT use markdown headers (no ###, ##, #)
- Write each step as clear prose with math embedded inline using $...$

MULTI-PART PROBLEMS (a, b, c, d, ...):
- If the problem has parts labeled (a), (b), (c) etc., solve EVERY part
- Group each part's steps together and clearly label them: start with "(a)" or "(b)" etc.
- In the "answer" field, list each part's answer explicitly: "(a) $x = 3$ (b) $y = 5$ (c) ..."
- Do NOT skip any part

Return ONLY valid JSON (no markdown fences, no extra text):
{
  "subject": "<Math, Physics, Chemistry, Biology, History, English, etc.>",
  "problem": "<1-sentence plain-English description — no LaTeX here>",
  "steps": [
    "Step 1 explanation with $math$ inline where needed.",
    "Step 2 explanation...",
    "Step 3 explanation..."
  ],
  "answer": "<final answer — if multi-part: (a) answer (b) answer (c) answer — use $math$ notation>",
  "formula": "<key formula used, e.g. $\\ln(ab) = \\ln(a) + \\ln(b)$, or empty string>",
  "graph": "<Desmos-compatible expression to plot if the problem involves a function, e.g. y=x^2+3x-2 or y=\\sin(x). Use null if not applicable — only include for problems that ask to graph, analyze, or sketch a function>",
  "tip": "<one helpful plain-English study tip — no LaTeX>"
}`;

  const messages = text
    ? [{ role: 'user', content: `${prompt}\n\nThe homework problem is:\n${text}` }]
    : [{ role: 'user', content: [
        { type: 'image_url', image_url: { url: `data:${mimeType || 'image/jpeg'};base64,${image}` } },
        { type: 'text', text: prompt }
      ]}];
  const model = text ? MODEL_LARGE : MODEL_VISION;
  const reqBody = { model, messages, max_tokens: text ? 2700 : 1800, temperature: 0.1 };
  if (text) reqBody.include_reasoning = false; // only the gpt-oss text model supports this param

  try {
    // Typed problems fall back to the small model when rate-limited; the image path
    // (MODEL_VISION) has no fallback.
    const r = await groqChat(reqBody);

    const data = await r.json();
    if (!r.ok) {
      console.error('Groq error (homework):', data.error?.message);
      const e = new Error(data.error?.message || 'Vision model error');
      e.code = data.error?.code;
      if (await sendBusyIfNeeded(e, res, uid)) return;
      if (isModelUnavailableError(e)) return res.status(502).json({ error: FRIENDLY_AI_ERROR });
      return sendServerError(res, e, 'homework', "We couldn't solve this just now. Please try again.");
    }

    let raw = data.choices?.[0]?.message?.content?.trim() || '';

    // Strip markdown code fences if model wrapped output
    raw = raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();

    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start !== -1 && end > start) raw = raw.slice(start, end + 1);

    // Fix LaTeX backslash sequences before JSON.parse.
    // \letter sequences (e.g. \frac, \right, \ln, \theta) are not valid JSON escapes
    // and get mangled: \f→form-feed, \r→carriage-return, etc.
    // Safe: /\\([a-zA-Z])/g leaves \" \\ \/ \uXXXX untouched (non-letter chars).
    const fixBackslashes = (s) => s.replace(/\\([a-zA-Z])/g, '\\\\$1');

    const tryParse = (s) => { try { return JSON.parse(s); } catch { return null; } };

    let result =
      tryParse(raw) ||
      tryParse(fixBackslashes(raw)) ||
      tryParse(raw.replace(/,\s*([}\]])/g, '$1')) ||
      tryParse(fixBackslashes(raw.replace(/,\s*([}\]])/g, '$1')));

    if (!result) {
      console.error('homework: unreadable AI reply:', raw.slice(0, 500)); return res.status(500).json({ error: "We couldn't solve this just now. Please try again." });
    }

    return res.status(200).json(result);
  } catch (err) {
    console.error('Groq error (homework):', err.message);
    if (isModelUnavailableError(err)) return res.status(502).json({ error: FRIENDLY_AI_ERROR });
    return sendServerError(res, err, 'homework', "We couldn't solve this just now. Please try again.");
  }
};
