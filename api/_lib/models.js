// Single source of truth for every Groq model ID used across /api. A future model
// swap (Groq deprecates/replaces a model again) should only need a Vercel env var
// change — GROQ_MODEL_LARGE / GROQ_MODEL_SMALL / GROQ_MODEL_VISION — not a code edit.
//
// History: llama-3.3-70b-versatile and llama-3.1-8b-instant were shut down by Groq
// (replaced by the openai/gpt-oss-* models below). meta-llama/llama-4-scout-17b-16e-instruct
// (the old vision/OCR model) was also deprecated; Groq's docs (Oct 2026) list
// qwen/qwen3.8-27b as the model that accepts images, so MODEL_VISION defaults to it.

const MODEL_LARGE = process.env.GROQ_MODEL_LARGE || 'openai/gpt-oss-120b';
const MODEL_SMALL = process.env.GROQ_MODEL_SMALL || 'openai/gpt-oss-20b';
const MODEL_VISION = process.env.GROQ_MODEL_VISION || 'qwen/qwen3.8-27b';
const MODEL_WHISPER = 'whisper-large-v3';
const MODEL_WHISPER_TURBO = 'whisper-large-v3-turbo';

// Shared "friendly error" handling for every Groq-calling endpoint: never show a raw
// Groq/model error to the user, but still log the real one server-side. `err.code`
// is Groq's error code (e.g. 'model_not_found') when the calling file's fetch
// wrapper preserves it; falls back to matching the message text if not.
const FRIENDLY_AI_ERROR = 'This AI feature is temporarily unavailable. Please try again soon.';
function isModelUnavailableError(err) {
  if (!err) return false;
  if (err.code === 'model_not_found' || err.code === 'model_decommissioned') return true;
  return /does not exist|decommissioned|model_not_found/i.test(err.message || '');
}

// ── Shared Groq chat call with automatic fallback ────────────────────────────
// Groq's free plan gives EACH model its own separate allowance. Simple tasks ask for
// MODEL_SMALL and quality-sensitive ones for MODEL_LARGE (see CLAUDE.md for the list);
// if Groq answers 429 (rate limit) for the model asked for, groqChat retries ONCE with
// the other one (large -> small, small -> large). Any other model (e.g. the vision
// model) has no fallback.
//
// Returns the fetch Response of the last attempt, so callers keep using r.ok / r.json()
// exactly as they did with their own fetch. If every model is rate-limited it returns a
// 429 Response whose JSON error carries BUSY_AI_ERROR / BUSY_AI_CODE — pass the error
// the caller builds from it to sendBusyIfNeeded().
//   opts.apiKey     defaults to process.env.GROQ_API_KEY
//   opts.timeoutMs  per-attempt timeout (none by default)
const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
const BUSY_AI_ERROR = "NoteCaptain is busy right now because today's free AI allowance is used up. Please try again later.";
const BUSY_AI_CODE = 'ai_busy';

function _fallbackModel(model) {
  const other = model === MODEL_LARGE ? MODEL_SMALL : model === MODEL_SMALL ? MODEL_LARGE : null;
  return other && other !== model ? other : null;
}

async function groqChat(body, opts) {
  opts = opts || {};
  const apiKey = opts.apiKey || process.env.GROQ_API_KEY;
  const send = (model) => fetch(GROQ_CHAT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(Object.assign({}, body, { model })),
    signal: opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined,
  });

  let r = await send(body.model);
  if (r.status !== 429) return r;

  const other = _fallbackModel(body.model);
  if (other) {
    console.warn(`Groq rate limit on ${body.model} — retrying with ${other}`);
    r = await send(other);
    if (r.status !== 429) return r;
  }
  console.error(`Groq rate limit on every model (asked for ${body.model})`);
  return new Response(JSON.stringify({ error: { message: BUSY_AI_ERROR, code: BUSY_AI_CODE } }), {
    status: 429, headers: { 'Content-Type': 'application/json' },
  });
}

function isBusyError(err) {
  return !!err && (err.code === BUSY_AI_CODE || err.message === BUSY_AI_ERROR);
}

// If `err` is the "every model is rate-limited" error: gives the user's monthly AI action
// back (pass uid = null for endpoints that don't charge one), sends the 429 with the
// message the page shows, and returns true. Otherwise returns false and sends nothing.
async function sendBusyIfNeeded(err, res, uid) {
  if (!isBusyError(err)) return false;
  if (uid) { try { await require('./auth').refundAiAction(uid); } catch (_) {} }
  res.status(429).json({ error: BUSY_AI_ERROR, code: BUSY_AI_CODE });
  return true;
}

// ── Errors shown to the browser ──────────────────────────────────────────────
// Internal error text (Groq/Firestore messages, stack details, which service failed, env
// var names) must never reach the browser. userError(msg) marks a message we wrote for the
// user; sendServerError logs the real error server-side and sends only such a message,
// or `fallback`, or GENERIC_ERROR.
const GENERIC_ERROR = 'Something went wrong on our side. Please try again in a moment.';
function userError(message) { const e = new Error(message); e.expose = true; return e; }
function sendServerError(res, err, where, fallback) {
  console.error(`Server error (${where}):`, err && (err.stack || err.message || err));
  return res.status(500).json({ error: (err && err.expose) ? err.message : (fallback || GENERIC_ERROR) });
}

module.exports = {
  MODEL_LARGE, MODEL_SMALL, MODEL_VISION, MODEL_WHISPER, MODEL_WHISPER_TURBO,
  FRIENDLY_AI_ERROR, isModelUnavailableError,
  GENERIC_ERROR, userError, sendServerError,
  BUSY_AI_ERROR, BUSY_AI_CODE, groqChat, isBusyError, sendBusyIfNeeded,
};
