const { applyCors, verifyAuth, checkRateLimit, chargeCredits, creditsForSize, rejectTooLong, LIMITS } = require('./_lib/auth');
const { MODEL_LARGE, MODEL_SMALL, FRIENDLY_AI_ERROR, isModelUnavailableError, groqChat, sendBusyIfNeeded, sendServerError, GENERIC_ERROR } = require('./_lib/models');

async function ddgLookup(query) {
  try {
    const r = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`, { signal: AbortSignal.timeout(5000) });
    const d = await r.json();
    const snippet = d.AbstractText || d.Answer || (d.RelatedTopics?.[0]?.Text) || '';
    const source = d.AbstractSource || d.AnswerType || '';
    return snippet ? `[${source || 'Web'}] ${snippet}` : '';
  } catch { return ''; }
}

// Define and Comprehend are short, simple answers (MODEL_SMALL); the deeper "interpret"
// mode passes MODEL_LARGE.
async function groqCall(prompt, apiKey, model) {
  const r = await groqChat({
    model: model || MODEL_SMALL,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 750,
    temperature: 0.5,
    include_reasoning: false
  }, { apiKey, timeoutMs: 20000 });
  const data = await r.json();
  if (!r.ok) {
    console.error('Groq error (interpret):', data.error?.message);
    const e = new Error(data.error?.message || 'AI error');
    e.code = data.error?.code;
    throw e;
  }
  return data.choices?.[0]?.message?.content?.trim() || '';
}

const _CHAT_SYSTEM = `You are an expert AI study tutor for NoteCaptain AI. Help students learn effectively.\n- Explain concepts clearly — start simple, build up\n- Use examples and real-world connections\n- Keep responses concise: 2-4 paragraphs or a short list\n- Use **bold** for key terms\n- Be encouraging but academically rigorous`;
async function _chatGroq(body,apiKey){const r=await groqChat(body,{apiKey,timeoutMs:20000});if(r.ok)return r;const err=await r.json().catch(()=>({}));const e=new Error(err.error?.message||`Groq ${r.status}`);e.code=err.error?.code;throw e;}

module.exports = async function handler(req, res) {
  applyCors(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();
  const uid = await verifyAuth(req, res);
  if (!uid) return;
  if (!(await checkRateLimit(uid, res))) return;
  // Charged by what is actually sent to the model: a short selection or chat turn is 1 credit.
  const _ib = req.body || {};
  let _credits;
  if (_ib.messages) {
    const chatChars = (Array.isArray(_ib.messages) ? _ib.messages.slice(-20) : []).reduce((s, m) => s + String((m && m.content) || '').length, 0);
    if (rejectTooLong(res, chatChars, LIMITS.MAX_CHAT_CHARS)) return;
    _credits = creditsForSize({ chars: chatChars });
  } else {
    const chars = String(_ib.text || '').length;
    if (rejectTooLong(res, chars)) return;
    _credits = creditsForSize({ chars: chars + Math.min(String(_ib.noteContext || '').length, 400) });
  }
  if (!(await chargeCredits(req, res, uid, _credits, { reason: 'interpret' }))) return;

  const GROQ = process.env.GROQ_API_KEY;
  if (!GROQ) { console.error('GROQ_API_KEY is not set'); return res.status(500).json({ error: GENERIC_ERROR }); }

  // chat route (rewired from /api/chat)
  if (req.body?.messages) {
    try {
      const { messages } = req.body;
      if (!Array.isArray(messages)||!messages.length) return res.status(400).json({ error: 'Missing messages' });
      const r = await _chatGroq({model:MODEL_SMALL,messages:[{role:'system',content:_CHAT_SYSTEM},...messages.slice(-20)],max_tokens:1000,temperature:0.65,include_reasoning:false}, GROQ);
      const data = await r.json();
      const reply = data.choices?.[0]?.message?.content;
      if (!reply) return res.status(500).json({ error: 'No reply returned' });
      return res.status(200).json({ reply });
    } catch(err) {
      console.error('Groq error (chat):', err.message);
      if (await sendBusyIfNeeded(err, res, uid)) return;
      if (isModelUnavailableError(err)) return res.status(502).json({ error: FRIENDLY_AI_ERROR });
      return sendServerError(res, err, 'interpret');
    }
  }

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
      result = await groqCall(prompt, GROQ, MODEL_LARGE);

    } else {
      // comprehend
      webSnippet = await ddgLookup(text);
      const webHint = webSnippet ? `\n\nAdditional context from web: "${webSnippet}"` : '';
      const prompt = `You are a brilliant teacher who can explain anything clearly. ${ctx}\n\nExplain the following passage so anyone can understand it. What does it mean? What are its core ideas? Why does it matter? Give genuine understanding in plain language.${webHint}\n\n3–5 sentences.\n\nPassage: "${text}"`;
      result = await groqCall(prompt, GROQ);
    }

    return res.status(200).json({ result });
  } catch(err) {
    console.error('Groq error (interpret):', err.message);
    if (await sendBusyIfNeeded(err, res, uid)) return;
    if (isModelUnavailableError(err)) return res.status(502).json({ error: FRIENDLY_AI_ERROR });
    return sendServerError(res, err, 'interpret');
  }
};
