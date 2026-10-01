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
// export — must use the modular subpath imports instead. Required lazily
// (inside _ensureAdmin, not at module top level) so that any resolution
// problem surfaces as a normal catchable error instead of crashing the whole
// serverless function at cold start with an opaque, bodyless 500.
let _fbApp = null, _fbAuth = null, _fbFirestore = null;

const ALLOWED_ORIGINS = [
  'https://notecaptain.ai',
  'https://www.notecaptain.ai',
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

// Tolerant parser for the FIREBASE_SERVICE_ACCOUNT env var. Pasting the key JSON
// into Vercel by hand can leave it double-JSON-encoded, base64-encoded, or with
// extra text before/after it, any of which makes plain JSON.parse throw and
// breaks every signed-in request. Tries the simple, direct parse FIRST (exactly
// what worked before this tolerant logic existed) so well-formed content is
// never put at risk by the fallback logic below; only falls back to base64
// decoding or extracting the first balanced {...} object for genuinely messy
// input.
function _tryParseJson(s) {
  try { return JSON.parse(s); } catch (_) { return null; }
}
function _normalizeServiceAccount(obj) {
  if (obj.private_key && obj.private_key.indexOf('\\n') !== -1) {
    obj.private_key = obj.private_key.replace(/\\n/g, '\n');
  }
  return obj;
}
function _looksLikeServiceAccount(obj) {
  return !!(obj && typeof obj === 'object' && obj.project_id && obj.client_email && obj.private_key);
}
function _parseServiceAccount(raw) {
  let text = String(raw).trim();

  let obj = _tryParseJson(text);
  if (typeof obj === 'string') obj = _tryParseJson(obj.trim()); // double-JSON-encoded value
  if (_looksLikeServiceAccount(obj)) return _normalizeServiceAccount(obj);

  if (text[0] !== '{') {
    try {
      const decoded = Buffer.from(text, 'base64').toString('utf8').trim();
      if (decoded.startsWith('{')) {
        const decodedObj = _tryParseJson(decoded);
        if (_looksLikeServiceAccount(decodedObj)) return _normalizeServiceAccount(decodedObj);
        text = decoded; // fall through to the brace matcher below on the decoded text
      }
    } catch (_) {}
  }

  // Extract the first balanced {...} object — handles extra pasted text before/after
  // the real JSON (e.g. the key pasted twice, or a stray line).
  const start = text.indexOf('{');
  if (start === -1) throw new Error('FIREBASE_SERVICE_ACCOUNT does not contain a JSON object');
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) throw new Error('FIREBASE_SERVICE_ACCOUNT JSON is incomplete (no closing brace)');
  const extracted = JSON.parse(text.slice(start, end + 1));
  if (!_looksLikeServiceAccount(extracted)) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT is missing project_id, client_email or private_key');
  }
  return _normalizeServiceAccount(extracted);
}

let _fbProjectId = null; // TEMPORARY, for the diagnostic below — remove with it.
function _ensureAdmin() {
  if (_fbApp) return;
  const { initializeApp, cert, getApps } = require('firebase-admin/app');
  if (getApps().length) { _fbApp = getApps()[0]; return; }
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT env var is not set');
  const serviceAccount = _parseServiceAccount(raw);
  _fbProjectId = serviceAccount.project_id;
  _fbApp = initializeApp({ credential: cert(serviceAccount) });
}
function _getServiceAccountProjectId() { _ensureAdmin(); return _fbProjectId; }

// Token verification via Firebase's Identity Toolkit REST API instead of
// firebase-admin/auth's getAuth(). require('firebase-admin/auth') reproducibly
// fails with ERR_REQUIRE_ESM in Vercel's deployed runtime (confirmed via a
// temporary diagnostic — works fine locally, fails in production regardless of
// whether the require is eager or lazy, and regardless of vercel.json
// includeFiles — points to Vercel's bundler mishandling this package's dual
// CJS/ESM conditional exports for this specific subpath). The REST endpoint
// below needs only the public Firebase Web API key (the same value already
// embedded in every page's own client-side Firebase config — not a secret),
// so it sidesteps the Admin SDK's auth module entirely.
const FIREBASE_WEB_API_KEY = 'AIzaSyAwbZkiZR8NRgrFYCL041FHfGquHyeEJUI';
async function _verifyIdTokenRest(idToken) {
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_WEB_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken }),
  });
  const data = await res.json().catch(() => ({}));
  const user = data.users && data.users[0];
  if (!res.ok || !user) {
    const err = new Error((data.error && data.error.message) || 'Invalid or expired token');
    err.code = (data.error && data.error.message) || 'auth/invalid-token';
    throw err;
  }
  const isAnonymous = !user.providerUserInfo || user.providerUserInfo.length === 0;
  return {
    uid: user.localId,
    email: user.email || null,
    firebase: { sign_in_provider: isAnonymous ? 'anonymous' : ((user.providerUserInfo[0] || {}).providerId || 'password') },
  };
}

// Shared Firestore handle for every file in api/ that needs direct Firestore
// access (checkout.js, webhook.js, subscription.js) — avoids each of them
// separately importing firebase-admin/firestore.
function getDb() {
  _ensureAdmin();
  if (!_fbFirestore) _fbFirestore = require('firebase-admin/firestore').getFirestore(_fbApp);
  return _fbFirestore;
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
    const decoded = await _verifyIdTokenRest(match[1]);
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
    const db = getDb();
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
    const db = getDb();
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
    const snap = await getDb().doc(`users/${uid}`).get();
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
    const db = getDb();
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
    const db = getDb();
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
  _getServiceAccountProjectId,
  _verifyIdTokenRest,
  getDb,
  getUserPlan,
  checkAndIncrementUsage,
  checkYoutubeDailyLimit,
  PLAN_LIMITS,
};
