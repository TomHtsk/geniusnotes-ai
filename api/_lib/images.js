// AI picture generation for the Notepad ("Create picture"), via Cloudflare Workers AI's
// REST API. Shared code — called from api/subscription.js (action: 'generateImage').
//
// Env vars (Vercel): CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN. Model: CF_MODEL_IMAGE in
// models.js. The free Cloudflare allowance is 10,000 "neurons" per day for the WHOLE site
// (resets 00:00 UTC); one 1024x1024, 4-step flux-1-schnell picture costs about 58.
const { CF_MODEL_IMAGE } = require('./models');

const IMAGE_QUOTA_ERROR = "Today's free pictures are used up. Please try again tomorrow.";
const IMAGE_REFUSED_ERROR = "That description can't be turned into a picture. Please try describing it differently.";
const IMAGE_FAILED_ERROR = "We couldn't create a picture just now. Please try again.";
const IMAGE_STEPS = 4;
const MAX_DESCRIPTION = 600;

// The model is bad at writing text inside pictures, so every request is wrapped in the
// same fixed instruction.
function buildImagePrompt(description) {
  return 'A clear educational illustration of: ' + description + '. ' +
    'Clean flat illustration style, simple shapes, white background. ' +
    'NO text, letters, labels or numbers anywhere in the image. ' +
    'No photorealistic people. No logos or brand characters.';
}

// Returns { ok: true, image: '<base64 JPEG>' } or { ok: false, status, error }.
// Never throws; the real error is logged server-side only.
async function generateImage(description) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !token) {
    console.error('Image error: CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN not set');
    return { ok: false, status: 503, error: IMAGE_FAILED_ERROR };
  }

  let r, data;
  try {
    // flux-1-schnell takes `prompt` and `steps` (max 8) and returns one ~1024x1024 JPEG
    // as base64 in result.image.
    r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${CF_MODEL_IMAGE}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: buildImagePrompt(description), steps: IMAGE_STEPS }),
      signal: AbortSignal.timeout(25000),
    });
    data = await r.json().catch(() => ({}));
  } catch (e) {
    console.error('Image error (network):', e.message);
    return { ok: false, status: 502, error: IMAGE_FAILED_ERROR };
  }

  const image = data && data.result && data.result.image;
  if (r.ok && data.success !== false && typeof image === 'string' && image.length > 100) {
    return { ok: true, image };
  }

  const errs = (data && data.errors) || [];
  const text = errs.map(e => `${e.code || ''} ${e.message || ''}`).join(' | ');
  console.error('Image error (Cloudflare):', r.status, text || '(no error body)');
  if (r.status === 429 || /allocation|quota|neurons|rate.?limit|capacity|too many requests/i.test(text)) {
    return { ok: false, status: 429, error: IMAGE_QUOTA_ERROR };
  }
  if (/nsfw|flagged|safety|not allowed|prohibited|inappropriate/i.test(text)) {
    return { ok: false, status: 400, error: IMAGE_REFUSED_ERROR };
  }
  return { ok: false, status: 502, error: IMAGE_FAILED_ERROR };
}

module.exports = { generateImage, buildImagePrompt, MAX_DESCRIPTION, IMAGE_QUOTA_ERROR, IMAGE_REFUSED_ERROR, IMAGE_FAILED_ERROR };
