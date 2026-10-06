// Plans, prices of top-ups, credit costs and hard request limits — the ONE place to change
// these numbers. Used by api/_lib/wallet.js (balances), api/_lib/auth.js (charging),
// api/billing.js (Stripe) and api/subscription.js (what the Pricing page shows).
//
// Allowances are product targets, not verified-profitable limits: check real Groq /
// AssemblyAI / Supadata invoices and tune CREDIT_RULES or the allowances.

// `ai` = AI credits per allowance month, `transcribe` = seconds of transcription per month,
// `storage` = bytes of cloud storage for notes, folders, history/flashcard decks, notebooks
// and shared copies (see api/_lib/storage.js). Over the limit, nothing is deleted: the
// account just can't grow in the cloud until it is back under (firestore.rules).
const MB = 1024 * 1024;
const PLANS = {
  free:    { name: 'Free',    rank: 0, ai: 10,   transcribe: 0,         storage: 100 * MB },
  student: { name: 'Student', rank: 1, ai: 300,  transcribe: 8 * 3600,  storage: 2 * 1024 * MB },
  pro:     { name: 'Pro',     rank: 2, ai: 1000, transcribe: 20 * 3600, storage: 10 * 1024 * MB },
};

// One-time top-ups for Student/Pro only. Never bought without the person confirming the
// price; never bought automatically. Used after the monthly allowance runs out; they
// last TOPUP_DAYS and are only usable while on a paid plan.
const TOPUPS = {
  credits100: { kind: 'credits', amount: 100,      cents: 499, name: '100 AI credits' },
  hours2:     { kind: 'seconds', amount: 2 * 3600, cents: 299, name: '2 hours of transcription' },
};
const TOPUP_DAYS = 365;

// Credit cost of one AI request: 1 per started CHARS_PER_CREDIT characters sent, plus 1 per
// started PAGES_PER_CREDIT images/pages read by the vision model; at least 1. Requests
// costing CONFIRM_FROM credits or more need the person to confirm first (the browser shows
// the cost and asks). Transcription never costs credits — it uses seconds.
const CREDIT_RULES = { CHARS_PER_CREDIT: 5000, PAGES_PER_CREDIT: 2, CONFIRM_FROM: 2 };

// Hard server-side limits per request.
const LIMITS = {
  MAX_TEXT_CHARS: 50000,          // text sent to one AI request (=> at most 10 credits)
  MAX_CHAT_CHARS: 20000,          // tutor chat history sent at once
  MAX_OCR_PAGES: 20,              // scanned pages / images in one request
  MAX_IMAGE_CHARS: 3 * 1024 * 1024, // one base64 image
  MAX_AUDIO_BYTES: 4 * 1024 * 1024, // one non-chunked audio request (Vercel's body limit is 4.5 MB)
  MAX_PREVIEW_BYTES: 1536 * 1024, // live-preview audio during Record Lecture
  AUDIO_EST_BYTES_PER_SEC: 2000,  // to reserve seconds before Whisper: 16 kbit/s (over-estimates)
  MAX_AUDIO_SECONDS: 1800,        // longest single (non-chunked) recording accepted
  MIN_SECONDS_TO_START: 30,       // need at least this much transcription left to start
  YT_AI_MAX_CREDITS: 3,           // a YouTube transcript is capped at 12,000 characters
};

// Speaker labels go through AssemblyAI (about 4-6x Whisper's price per hour). 1 = an hour
// of speaker-labelled audio uses one hour of the allowance. OPEN DECISION for the owner.
const DIARIZE_SECONDS_MULTIPLIER = 1;

// Owner accounts: always on a plan, without a Stripe subscription. Their allowance refills
// on the 1st of each month (UTC). More ids can be added in Vercel as NC_OWNER_PRO_UIDS
// (comma-separated Firebase user ids) without a code change.
const OWNER_PLANS = {
  '7mC5UUxdMPVwmtjwypi7qhiUzd12': 'pro', // the site owner's main account
};
function ownerPlan(uid) {
  if (!uid) return null;
  if (OWNER_PLANS[uid]) return OWNER_PLANS[uid];
  const extra = String(process.env.NC_OWNER_PRO_UIDS || '').split(',').map(s => s.trim()).filter(Boolean);
  return extra.indexOf(uid) !== -1 ? 'pro' : null;
}

function creditsForSize(size) {
  size = size || {};
  const chars = Math.max(0, Number(size.chars) || 0);
  const pages = Math.max(0, Number(size.pages) || 0);
  return Math.max(1, Math.ceil(chars / CREDIT_RULES.CHARS_PER_CREDIT) + Math.ceil(pages / CREDIT_RULES.PAGES_PER_CREDIT));
}

module.exports = { PLANS, TOPUPS, TOPUP_DAYS, CREDIT_RULES, LIMITS, DIARIZE_SECONDS_MULTIPLIER, creditsForSize, ownerPlan, OWNER_PLANS };
