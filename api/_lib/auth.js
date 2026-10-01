// Shared CORS + Firebase auth + per-user rate limiting for /api/*.
// Lives in api/_lib/ (underscore-prefixed dirs are not treated as routes by Vercel).
//
// Usage at the top of a handler, replacing the old 3-line CORS block:
//   const { applyCors, verifyAuth, checkRateLimit } = require('./_lib/auth');
//   module.exports = async function handler(req, res) {
//     applyCors(res, req);
//     if (req.method === 'OPTIONS') return res.status(200).end();
//     const uid = await verifyAuth(req, res);
//     if (!uid) return; // verifyAuth already sent the 401
//     if (!(await checkRateLimit(uid, res))) return; // checkRateLimit already sent the 429
//     ... existing handler logic unchanged below ...
//   };
//
// api/summarize.js is the one endpoint that also accepts anonymous Firebase users
// (the free YouTube converter) — see verifyAuthFull's `allowAnonymous` option and
// checkGuestYoutubeLimit below.

// firebase-admin v14+ removed the old namespaced compat API (admin.auth(),
// admin.firestore(), admin.credential.cert(), admin.apps) from the default
// export — must use the modular subpath imports instead.
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');

const ALLOWED_ORIGINS = [
  'https://geniusnotes.ai',
  'https://www.geniusnotes.ai',
  'https://geniusnotes-ai.vercel.app',
];

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  // Local development only
  if (/^https?:\/\/localhost(:\d+)?$/.test(origin)) return true;
  if (/^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)) return true;
  return false;
}

function applyCors(res, req) {
  const origin = req.headers.origin;
  if (isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function _ensureAdmin() {
  if (getApps().length) return;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT env var is not set');
  const serviceAccount = JSON.parse(raw);
  initializeApp({ credential: cert(serviceAccount) });
}

// Shared Firestore handle for every file in api/ that needs direct Firestore
// access (checkout.js, webhook.js, subscription.js) — avoids each of them
// separately importing firebase-admin/firestore.
function getDb() {
  _ensureAdmin();
  return getFirestore();
}

// Decodes and verifies the Authorization: Bearer <idToken> header. Returns the decoded
// token (which includes .uid, .email, and .firebase.sign_in_provider) on success, or
// null after sending the 401 response itself. `opts.allowAnonymous` (default false)
// controls whether a token from an anonymous Firebase session is accepted at all.
async function _verifyToken(req, res, opts) {
  opts = opts || {};
  try {
    const header = req.headers.authorization || '';
    const match = header.match(/^Bearer (.+)$/);
    if (!match) {
      res.status(401).json({ error: 'Unauthorized — missing Authorization header' });
      return null;
    }
    _ensureAdmin();
    const decoded = await getAuth().verifyIdToken(match[1]);
    const isAnonymous = decoded.firebase && decoded.firebase.sign_in_provider === 'anonymous';
    if (isAnonymous && !opts.allowAnonymous) {
      res.status(401).json({ error: 'sign_in_required' });
      return null;
    }
    decoded._isAnonymous = !!isAnonymous;
    return decoded;
  } catch (e) {
    res.status(401).json({ error: 'Unauthorized — invalid or expired token' });
    return null;
  }
}

// Returns just the uid (string) on success, or null (401 already sent). Anonymous
// sessions are rejected unless opts.allowAnonymous is true.
async function verifyAuth(req, res, opts) {
  const decoded = await _verifyToken(req, res, opts);
  return decoded ? decoded.uid : null;
}

// Same as verifyAuth but returns { uid, email, isAnonymous } — for callers that need
// the verified email (checkout.js, subscription.js) or need to branch on anonymous
// status (summarize.js, for the free/guest-limited YouTube converter).
async function verifyAuthFull(req, res, opts) {
  const decoded = await _verifyToken(req, res, opts);
  if (!decoded) return null;
  return { uid: decoded.uid, email: decoded.email || null, isAnonymous: decoded._isAnonymous };
}

const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// Simple per-user sliding-window-ish counter stored in Firestore at
// users/{uid}/rateLimit/current. Returns true if the request is allowed; on
// exceeding the limit it sends the 429 response itself and returns false.
async function checkRateLimit(uid, res) {
  try {
    _ensureAdmin();
    const db = getFirestore();
    const ref = db.doc(`users/${uid}/rateLimit/current`);
    const now = Date.now();

    const allowed = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.exists ? snap.data() : null;
      if (!data || !data.windowStart || now - data.windowStart > RATE_LIMIT_WINDOW_MS) {
        tx.set(ref, { count: 1, windowStart: now });
        return true;
      }
      if (data.count >= RATE_LIMIT_MAX) return false;
      tx.set(ref, { count: data.count + 1, windowStart: data.windowStart }, { merge: true });
      return true;
    });

    if (!allowed) {
      res.status(429).json({ error: 'Rate limit exceeded — please wait a bit before trying again.' });
      return false;
    }
    return true;
  } catch (e) {
    // If Firestore itself is unreachable, fail open rather than blocking every request —
    // auth already gates access; rate limiting is a secondary protection.
    return true;
  }
}

const GUEST_YT_LIMIT = 3;

function _todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD, UTC
}

function _sanitizeIp(ip) {
  return String(ip || 'unknown').trim().replace(/[^a-zA-Z0-9.:]/g, '_').slice(0, 100) || 'unknown';
}

function _clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.headers['x-real-ip'] || req.socket && req.socket.remoteAddress || 'unknown';
}

// Free YouTube-converter guest limit: 3 conversions/day, enforced both per anonymous
// uid AND per IP address (so one guest can't just clear storage to get more, and one
// IP can't be hammered through many anonymous sessions). Only called for anonymous
// users — real signed-in users use the normal checkRateLimit instead. Sends the 429
// itself (with the exact guest_limit_reached shape the frontend looks for) and returns
// false if either counter is already at the limit.
async function checkGuestYoutubeLimit(req, uid, res) {
  try {
    _ensureAdmin();
    const db = getFirestore();
    const today = _todayKey();
    const ipKey = _sanitizeIp(_clientIp(req));
    const uidRef = db.doc(`guestLimits/${uid}`);
    const ipRef = db.doc(`guestLimitsByIp/${ipKey}`);

    const allowed = await db.runTransaction(async (tx) => {
      const [uidSnap, ipSnap] = await Promise.all([tx.get(uidRef), tx.get(ipRef)]);
      const uidData = uidSnap.exists ? uidSnap.data() : null;
      const ipData = ipSnap.exists ? ipSnap.data() : null;
      const uidCount = (uidData && uidData.day === today) ? uidData.count : 0;
      const ipCount = (ipData && ipData.day === today) ? ipData.count : 0;

      if (uidCount >= GUEST_YT_LIMIT || ipCount >= GUEST_YT_LIMIT) return false;

      tx.set(uidRef, { day: today, count: uidCount + 1 });
      tx.set(ipRef, { day: today, count: ipCount + 1 });
      return true;
    });

    if (!allowed) {
      res.status(429).json({
        error: 'guest_limit_reached',
        message: "You've used your 3 free conversions today. Sign in free for more.",
      });
      return false;
    }
    return true;
  } catch (e) {
    // Fail open on infra errors, same reasoning as checkRateLimit.
    return true;
  }
}

// Plan tiers and their limits. Record limits are in seconds (1800s = 30min,
// 36000s = 10hr). YouTube limits are per-day; AI/record limits are per-month.
const PLAN_LIMITS = {
  free: { ai: 10, record: 1800, yt: 3 },
  pro: { ai: 500, record: 36000, yt: 50 },
};

function _monthKey(d) {
  return (d || new Date()).toISOString().slice(0, 7); // YYYY-MM, UTC
}

// Reads users/{uid} and returns 'pro' if pro===true and not expired, else 'free'.
// Plain read (not a transaction) — called by every limit-check helper below. Fails
// open to 'free' on any error so a Firestore hiccup never silently grants Pro.
async function getUserPlan(uid) {
  try {
    _ensureAdmin();
    const snap = await getFirestore().doc(`users/${uid}`).get();
    if (!snap.exists) return 'free';
    const d = snap.data();
    const now = Math.floor(Date.now() / 1000);
    const active = d.pro === true && (!d.proUntil || d.proUntil === 0 || d.proUntil > now);
    return active ? 'pro' : 'free';
  } catch (e) {
    return 'free';
  }
}

// Monthly AI-action counter at users/{uid}/usage/{YYYY-MM}. `kind` is currently
// always 'ai' (kept as a param for future extensibility). Sends the 402 itself
// and returns false when the plan's monthly cap is already reached; otherwise
// increments the counter and returns true. Fail-open on Firestore errors, same
// reasoning as checkRateLimit.
async function checkAndIncrementUsage(uid, res, kind) {
  try {
    const plan = await getUserPlan(uid);
    const limit = PLAN_LIMITS[plan].ai;
    _ensureAdmin();
    const db = getFirestore();
    const month = _monthKey();
    const ref = db.doc(`users/${uid}/usage/${month}`);

    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.exists ? snap.data() : { month, aiActions: 0, recordSeconds: 0 };
      const used = data.aiActions || 0;
      if (used >= limit) return { ok: false, used, limit };
      tx.set(ref, Object.assign({}, data, { month, aiActions: used + 1 }), { merge: true });
      return { ok: true, used: used + 1, limit };
    });

    if (!result.ok) {
      res.status(402).json({ error: 'limit_reached', used: result.used, limit: result.limit, plan });
      return false;
    }
    return true;
  } catch (e) {
    return true;
  }
}

// Per-day YouTube-conversion counter for SIGNED-IN users at
// users/{uid}/ytLimit/{YYYY-MM-DD}. Anonymous guests keep using
// checkGuestYoutubeLimit above, unchanged. Same 402 shape/fail-open behavior
// as checkAndIncrementUsage.
async function checkYoutubeDailyLimit(uid, res) {
  try {
    const plan = await getUserPlan(uid);
    const limit = PLAN_LIMITS[plan].yt;
    _ensureAdmin();
    const db = getFirestore();
    const today = _todayKey();
    const ref = db.doc(`users/${uid}/ytLimit/${today}`);

    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.exists ? snap.data() : null;
      const count = (data && data.day === today) ? data.count : 0;
      if (count >= limit) return { ok: false, used: count, limit };
      tx.set(ref, { day: today, count: count + 1 });
      return { ok: true, used: count + 1, limit };
    });

    if (!result.ok) {
      res.status(402).json({ error: 'limit_reached', used: result.used, limit: result.limit, plan });
      return false;
    }
    return true;
  } catch (e) {
    return true;
  }
}

module.exports = {
  applyCors,
  verifyAuth,
  verifyAuthFull,
  checkRateLimit,
  checkGuestYoutubeLimit,
  isAllowedOrigin,
  _ensureAdmin,
  getDb,
  getUserPlan,
  checkAndIncrementUsage,
  checkYoutubeDailyLimit,
  PLAN_LIMITS,
};
