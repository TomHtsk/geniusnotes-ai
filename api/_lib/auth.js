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

const admin = require('firebase-admin');

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

let _adminInitialized = false;
function _ensureAdmin() {
  if (_adminInitialized || admin.apps.length) { _adminInitialized = true; return; }
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT env var is not set');
  const serviceAccount = JSON.parse(raw);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  _adminInitialized = true;
}

// Verifies the Authorization: Bearer <idToken> header. On success returns the uid.
// On any failure, sends the 401 response itself and returns null — callers should
// `if (!uid) return;` immediately after calling this.
async function verifyAuth(req, res) {
  try {
    const header = req.headers.authorization || '';
    const match = header.match(/^Bearer (.+)$/);
    if (!match) {
      res.status(401).json({ error: 'Unauthorized — missing Authorization header' });
      return null;
    }
    _ensureAdmin();
    const decoded = await admin.auth().verifyIdToken(match[1]);
    return decoded.uid;
  } catch (e) {
    res.status(401).json({ error: 'Unauthorized — invalid or expired token' });
    return null;
  }
}

// Same as verifyAuth but returns { uid, email } — for the one handler (checkout.js)
// that needs the verified email too, instead of trusting an email from the request body.
async function verifyAuthFull(req, res) {
  try {
    const header = req.headers.authorization || '';
    const match = header.match(/^Bearer (.+)$/);
    if (!match) {
      res.status(401).json({ error: 'Unauthorized — missing Authorization header' });
      return null;
    }
    _ensureAdmin();
    const decoded = await admin.auth().verifyIdToken(match[1]);
    return { uid: decoded.uid, email: decoded.email || null };
  } catch (e) {
    res.status(401).json({ error: 'Unauthorized — invalid or expired token' });
    return null;
  }
}

const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// Simple per-user sliding-window-ish counter stored in Firestore at
// users/{uid}/rateLimit/current. Returns true if the request is allowed; on
// exceeding the limit it sends the 429 response itself and returns false.
async function checkRateLimit(uid, res) {
  try {
    _ensureAdmin();
    const db = admin.firestore();
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

module.exports = { applyCors, verifyAuth, verifyAuthFull, checkRateLimit, isAllowedOrigin };
