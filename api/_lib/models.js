// Single source of truth for every Groq model ID used across /api. A future model
// swap (Groq deprecates/replaces a model again) should only need a Vercel env var
// change — GROQ_MODEL_LARGE / GROQ_MODEL_SMALL / GROQ_MODEL_VISION — not a code edit.
//
// History: llama-3.3-70b-versatile and llama-3.1-8b-instant were shut down by Groq
// (replaced by the openai/gpt-oss-* models below). meta-llama/llama-4-scout-17b-16e-instruct
// (the old vision/OCR model) was also deprecated; no confirmed vision-capable
// replacement exists on Groq as of this fix — MODEL_VISION intentionally still
// defaults to the deprecated name until a replacement is confirmed (see CLAUDE.md).
// Image upload/OCR is a known, deferred gap — not a regression introduced here.

const MODEL_LARGE = process.env.GROQ_MODEL_LARGE || 'openai/gpt-oss-120b';
const MODEL_SMALL = process.env.GROQ_MODEL_SMALL || 'openai/gpt-oss-20b';
const MODEL_VISION = process.env.GROQ_MODEL_VISION || 'meta-llama/llama-4-scout-17b-16e-instruct';
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

module.exports = {
  MODEL_LARGE, MODEL_SMALL, MODEL_VISION, MODEL_WHISPER, MODEL_WHISPER_TURBO,
  FRIENDLY_AI_ERROR, isModelUnavailableError,
};
