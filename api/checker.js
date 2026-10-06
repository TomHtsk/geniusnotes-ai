const { applyCors, verifyAuth, checkRateLimit, chargeCredits, creditsForSize, rejectTooLong } = require('./_lib/auth');
const { MODEL_LARGE, FRIENDLY_AI_ERROR, isModelUnavailableError, groqChat, sendBusyIfNeeded } = require('./_lib/models');

module.exports = async function handler(req, res) {
  applyCors(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const uid = await verifyAuth(req, res);
  if (!uid) return;
  if (!(await checkRateLimit(uid, res))) return;
  // Reads at most the first 12,000 characters, so it is charged for at most that.
  if (!(await chargeCredits(req, res, uid, creditsForSize({ chars: Math.min(String((req.body || {}).text || '').length, 12000) }), { reason: 'checker' }))) return;

  const { text, mode } = req.body || {};
  if (!text || !mode) return res.status(400).json({ error: 'Missing text or mode' });

  const t = text.slice(0, 12000);

  const prompts = {
    aidetect: `You are an AI content detection expert. Analyze the following text and determine the probability it was written by AI vs a human.

Return ONLY valid JSON in this exact format:
{
  "score": <integer 0-100, where 100 = definitely AI>,
  "label": "<one of: 'Very likely human', 'Possibly human', 'Mixed', 'Possibly AI', 'Very likely AI'>",
  "confidence": "<one of: 'Low', 'Medium', 'High'>",
  "signals": [
    { "type": "<AI signal or Human signal>", "detail": "<short explanation, max 15 words>" }
  ],
  "summary": "<2-3 sentence explanation of your assessment>"
}

Signals to look for (AI indicators): repetitive sentence structure, overly formal tone, generic phrasing, lack of personal anecdotes, perfect grammar, excessive transitional phrases, hedging language.
Human indicators: typos/informal language, personal voice, emotional expression, varied sentence length, unique examples.

Provide 4-6 signals. Be calibrated — most text has mixed signals.

Text to analyze:
${t}`,

    grammar: `You are an expert grammar and writing coach. Analyze the following text for grammar errors, style issues, clarity problems, and writing improvements.

Return ONLY valid JSON in this exact format:
{
  "score": <integer 0-100, where 100 = perfect writing>,
  "grade": "<A, B, C, D, or F>",
  "issues": [
    {
      "type": "<one of: Grammar, Spelling, Style, Clarity, Punctuation, Word Choice, Structure>",
      "severity": "<one of: Error, Warning, Suggestion>",
      "original": "<exact problematic text from the passage, max 60 chars>",
      "suggestion": "<corrected or improved version>",
      "explanation": "<why this is an issue, max 15 words>"
    }
  ],
  "strengths": ["<strength 1>", "<strength 2>"],
  "summary": "<2-3 sentence overall writing assessment>"
}

Find up to 10 issues. Focus on real problems, not nitpicking. If writing is excellent, return fewer issues and a high score.

Text to analyze:
${t}`,

    plagiarism: `You are a plagiarism detection analyst. Analyze the following text for signs of potential plagiarism, paraphrasing of well-known sources, or content that appears copied or recycled.

Note: You cannot access the internet, so flag text that uses suspiciously generic, formulaic, or overly familiar phrasing that may be lifted from textbooks, Wikipedia, or common sources.

Return ONLY valid JSON in this exact format:
{
  "risk": "<one of: Very Low, Low, Medium, High, Very High>",
  "score": <integer 0-100, where 100 = very high plagiarism risk>,
  "flags": [
    {
      "text": "<exact flagged phrase from the passage, max 80 chars>",
      "reason": "<why this is flagged, max 20 words>",
      "risk": "<Low, Medium, or High>"
    }
  ],
  "originalityScore": <integer 0-100, where 100 = fully original>,
  "summary": "<2-3 sentence assessment of originality and any concerns>"
}

Flag up to 8 suspicious passages. Be specific about WHY each is flagged. If text appears original, return low risk and few or no flags.

Text to analyze:
${t}`,

    factcheck: `You are a rigorous fact-checker. Identify specific factual claims in the text and assess their accuracy.

Return ONLY valid JSON in this exact format:
{
  "claimsFound": <integer>,
  "overallReliability": "<one of: High, Medium, Low, Very Low>",
  "claims": [
    {
      "claim": "<exact claim from the text, max 100 chars>",
      "verdict": "<one of: Accurate, Likely Accurate, Uncertain, Needs Verification, Questionable, Inaccurate>",
      "confidence": "<Low, Medium, or High>",
      "explanation": "<brief explanation or context, max 25 words>"
    }
  ],
  "summary": "<2-3 sentence overall assessment of the text's factual reliability>"
}

Assess up to 10 claims. Focus on verifiable facts (statistics, dates, names, scientific claims) not opinions. If the text has no clear factual claims, return claimsFound: 0 and say so in summary.

Text to analyze:
${t}`
  };

  const prompt = prompts[mode];
  if (!prompt) return res.status(400).json({ error: 'Invalid mode' });

  try {
    const groqRes = await groqChat({
      model: MODEL_LARGE,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 3000,
      temperature: 0.2,
      include_reasoning: false,
      response_format: { type: 'json_object' }
    });

    const groqData = await groqRes.json();
    if (!groqRes.ok) {
      console.error('Groq error (checker):', groqData.error?.message);
      const e = new Error(groqData.error?.message || 'Groq error');
      e.code = groqData.error?.code;
      if (await sendBusyIfNeeded(e, res, uid)) return;
      if (isModelUnavailableError(e)) return res.status(502).json({ error: FRIENDLY_AI_ERROR });
      return res.status(500).json({ error: e.message });
    }

    let raw = groqData.choices?.[0]?.message?.content?.trim() || '';

    // Extract JSON object robustly — find outermost { ... }
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      raw = raw.slice(start, end + 1);
    }

    let result;
    try {
      result = JSON.parse(raw);
    } catch (parseErr) {
      // Try removing trailing commas (common model mistake)
      const cleaned = raw.replace(/,\s*([}\]])/g, '$1');
      try {
        result = JSON.parse(cleaned);
      } catch {
        return res.status(500).json({ error: 'Failed to parse AI response', raw: raw.slice(0, 500) });
      }
    }

    return res.status(200).json(result);
  } catch (err) {
    console.error('Groq error (checker):', err.message);
    if (isModelUnavailableError(err)) return res.status(502).json({ error: FRIENDLY_AI_ERROR });
    return res.status(500).json({ error: err.message });
  }
};
