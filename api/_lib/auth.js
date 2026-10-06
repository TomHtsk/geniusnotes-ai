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
// (the free YouTube converter) â€” see verifyAuthFull's `allowAnonymous` option and
// checkGuestYoutubeLimit below.

// firebase-admin v14+ removed the old namespaced compat API (admin.auth(),
// admin.firestore(), admin.credential.cert(), admin.apps) from the default
// export â€” must use the modular subpath imports instead. Required lazily
// (inside _ensureAdmin, not at module top level) so that any resolution
// problem surfaces as a normal catchable error instead of crashing the whole
// serverless function at cold start with an opaque, bodyless 500.
let _fbApp = null, _fbFirestore = null;

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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Confirm-Cost, X-Idempotency-Key');
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

  // Extract the first balanced {...} object â€” handles extra pasted text before/after
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

function _ensureAdmin() {
  if (_fbApp) return;
  const { initializeApp, cert, getApps } = require('firebase-admin/app');
  if (getApps().length) { _fbApp = getApps()[0]; return; }
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT env var is not set');
  const serviceAccount = _parseServiceAccount(raw);
  _fbApp = initializeApp({ credential: cert(serviceAccount) });
}

// Token verification via Firebase's Identity Toolkit REST API instead of
// firebase-admin/auth's getAuth(). require('firebase-admin/auth') reproducibly
// fails with ERR_REQUIRE_ESM in Vercel's deployed runtime (confirmed via a
// temporary diagnostic â€” works fine locally, fails in production regardless of
// whether the require is eager or lazy, and regardless of vercel.json
// includeFiles â€” points to Vercel's bundler mishandling this package's dual
// CJS/ESM conditional exports for this specific subpath). The REST endpoint
// below needs only the public Firebase Web API key (the same value already
// embedded in every page's own client-side Firebase config â€” not a secret),
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
// access (subscription.js) â€” avoids each of them separately importing
// firebase-admin/firestore.
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
      res.status(401).json({ error: 'Unauthorized â€” missing Authorization header' });
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
    res.status(401).json({ error: 'Unauthorized â€” invalid or expired token' });
    return null;
  }
}

// Returns just the uid (string) on success, or null (401 already sent). Anonymous
// sessions are rejected unless opts.allowAnonymous is true.
async function verifyAuth(req, res, opts) {
  const decoded = await _verifyToken(req, res, opts);
  return decoded ? decoded.uid : null;
}

// Same as verifyAuth but returns { uid, email, isAnonymous } â€” for callers that need
// the verified email or need to branch on anonymous
// status (summarize.js, for the free/guest-limited YouTube converter).
async function verifyAuthFull(req, res, opts) {
  const decoded = await _verifyToken(req, res, opts);
  if (!decoded) return null;
  return { uid: decoded.uid, email: decoded.email || null, isAnonymous: decoded._isAnonymous };
}


const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// Usage checks FAIL CLOSED: if Firestore can't be reached, the request is refused with
// this message (503) and no AI or transcription work runs.
const USAGE_UNAVAILABLE = "We can't check your allowance right now, so nothing was run and nothing was charged. Please try again in a minute.";
function sendUsageUnavailable(res) {
  res.status(503).json({ code: 'usage_unavailable', error: USAGE_UNAVAILABLE });
}

// Simple per-user sliding-window-ish counter stored in Firestore at
// users/{uid}/rateLimit/current. Returns true if the request is allowed; otherwise sends
// the 429 (limit hit) or 503 (Firestore unreachable) itself and returns false.
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
    console.error('Rate limit check failed:', e.message);
    sendUsageUnavailable(res);
    return false;
  }
}

const GUEST_YT_LIMIT = 3;
const YT_PER_DAY = 3;

// One-time reset of every YouTube daily counter: the counters only count a day whose
// stored key matches _ytDayKey(), so changing this tag makes all of today's counts start
// again from zero (for guests and accounts). Bump it (r2, r3, ...) to reset again.
const YT_COUNTER_RESET_TAG = 'r1';
function _ytDayKey() { return _todayKey() + '-' + YT_COUNTER_RESET_TAG; }

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
// uid AND per IP address. Only called for anonymous users. Sends the 429 itself (with the
// guest_limit_reached shape the frontend looks for). Fails closed (503).
async function checkGuestYoutubeLimit(req, uid, res) {
  try {
    _ensureAdmin();
    const db = getDb();
    const today = _ytDayKey();
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
    console.error('Guest YouTube limit check failed:', e.message);
    sendUsageUnavailable(res);
    return false;
  }
}

// Per-day YouTube-conversion counter for SIGNED-IN users at users/{uid}/ytLimit/{day}.
// Fails closed (503).
async function checkYoutubeDailyLimit(uid, res) {
  try {
    const limit = YT_PER_DAY;
    _ensureAdmin();
    const db = getDb();
    const today = _ytDayKey();
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
      res.status(429).json({
        code: 'limit_reached', used: result.used, limit: result.limit,
        error: `You've used today's ${result.limit} YouTube conversions. The limit resets tomorrow.`,
      });
      return false;
    }
    return true;
  } catch (e) {
    console.error('YouTube daily limit check failed:', e.message);
    sendUsageUnavailable(res);
    return false;
  }
}

// ── Credits and transcription time (the wallet, api/_lib/wallet.js) ──────────────────
// Plans, credit costs and limits: api/_lib/plans.js.
//
// chargeCredits / chargeSeconds charge BEFORE the expensive work runs and send the reply
// themselves when they return null:
//   409 { code: 'confirm_cost', credits | seconds, confirm, ... }  the person hasn't
//        confirmed this cost yet. The browser (js/cost-confirm.js) shows it and sends the
//        same request again with the header  X-Confirm-Cost: <confirm>.
//   429 { code: 'limit_reached', ... }   not enough left; nothing charged
//   503 { code: 'usage_unavailable' }    wallet unreachable; nothing runs (fail closed)
// Every charge of a request is remembered on `res`; refundCharges(res) gives all of it back
// when the work fails. The browser may send X-Idempotency-Key so a retried request is
// charged once.

const wallet = require('./wallet');
const { PLANS, CREDIT_RULES, LIMITS, creditsForSize } = require('./plans');

function _dateText(ms) {
  return new Date(ms).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}
function _hoursText(sec) {
  if (sec >= 3600) return (Math.round(sec / 360) / 10) + ' hours';
  return Math.max(0, Math.round(sec / 60)) + ' minutes';
}

function _requestKey(req, uid) {
  const h = req && req.headers && (req.headers['x-idempotency-key'] || req.headers['X-Idempotency-Key']);
  if (typeof h === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(h)) return uid + '_' + h;
  return uid + '_' + require('crypto').randomBytes(12).toString('hex');
}
function _confirmed(req, value) {
  const h = req && req.headers && (req.headers['x-confirm-cost'] || req.headers['X-Confirm-Cost']);
  return h !== undefined && String(h) === String(value);
}
function _remember(res, uid, key) {
  res._gnCharges = res._gnCharges || [];
  res._gnCharges.push({ uid, key });
  _armAutoRefund(res);
}

// After a charge, ANY error reply from the request (status 400 or more) first gives the
// charges back, then sends the reply — so a failed AI call, a parse failure or a "not found"
// never costs the person anything, without every error branch remembering to refund.
function _armAutoRefund(res) {
  if (res._gnArmed || typeof res.json !== 'function') return;
  res._gnArmed = true;
  const send = res.json;
  res.json = function (body) {
    const status = res.statusCode || res.code || 200;
    if (status >= 400 && res._gnCharges && res._gnCharges.length) {
      res._gnPending = refundCharges(res, 'error-' + status).then(() => send.call(res, body));
      return res;
    }
    return send.call(res, body);
  };
}

function _resetLine(v) {
  if (!v.resetAt) return '';
  if (v.plan !== 'free' && v.resetAt < Date.now()) return ' Your plan will refill once your next payment goes through.';
  return ` Your allowance refills on ${_dateText(v.resetAt)}.`;
}

function sendCreditLimit(res, v, credits) {
  const upgrade = v.plan === 'free'
    ? ' You can wait until then or upgrade on the Pricing page.'
    : ' You can wait until then, upgrade, or buy a top-up on the Pricing page.';
  res.status(429).json({
    code: 'limit_reached', plan: v.plan, need: credits, creditsLeft: v.creditsLeft, resetAt: v.resetAt,
    error: (v.creditsLeft > 0
      ? `This needs ${credits} AI credits and you have ${v.creditsLeft} left.`
      : `You've used all your AI credits for now.`) + _resetLine(v) + upgrade +
      ' Your notes and saved work are still available, and features that don\'t use AI keep working.',
  });
}

function sendTranscribeLimit(res, v, seconds) {
  if (v.plan === 'free' && v.secondsLeft <= 0) {
    return res.status(429).json({
      code: 'limit_reached', plan: v.plan, secondsLeft: 0,
      error: 'Transcription (Record Lecture and audio/video uploads) is included in the Student and Pro plans. See the Pricing page.',
    });
  }
  res.status(429).json({
    code: 'limit_reached', plan: v.plan, need: seconds, secondsLeft: v.secondsLeft, resetAt: v.resetAt,
    error: (v.secondsLeft > 0
      ? `This needs about ${_hoursText(seconds)} of transcription and you have ${_hoursText(v.secondsLeft)} left.`
      : 'You\'ve used all your transcription time for now.') + _resetLine(v) +
      (v.plan === 'free' ? '' : ' You can wait, upgrade, or buy a top-up on the Pricing page.'),
  });
}

// Charge `credits` for this request. opts.reason (for the ledger), opts.confirm (ask first;
// default: when credits >= CONFIRM_FROM), opts.suffix (a second charge in the same request).
async function chargeCredits(req, res, uid, credits, opts) {
  opts = opts || {};
  credits = Math.max(1, Math.round(credits || 1));
  const needConfirm = opts.confirm !== undefined ? opts.confirm : credits >= CREDIT_RULES.CONFIRM_FROM;
  try {
    _ensureAdmin();
    if (needConfirm && !_confirmed(req, credits)) {
      const v = await wallet.summary(uid);
      if (v.creditsLeft < credits) { sendCreditLimit(res, v, credits); return null; }
      res.status(409).json({
        code: 'confirm_cost', kind: 'credits', credits, upTo: !!opts.upTo, confirm: String(credits),
        creditsLeft: v.creditsLeft, resetAt: v.resetAt, plan: v.plan,
        error: `This uses ${opts.upTo ? 'up to ' : ''}${credits} AI credits. You have ${v.creditsLeft} left. Confirm to continue.`,
      });
      return null;
    }
    const key = (res._gnKey = res._gnKey || _requestKey(req, uid)) + (opts.suffix || '');
    const r = await wallet.spend(uid, { credits, key, reason: opts.reason || '' });
    if (!r.ok) { sendCreditLimit(res, r.view, credits); return null; }
    _remember(res, uid, key);
    return r;
  } catch (e) {
    console.error('Credit charge failed:', e.message);
    sendUsageUnavailable(res);
    return null;
  }
}

// A further charge inside a request that already passed chargeCredits (for example a second
// real AI call). Never sends a reply: returns false if it can't be charged, and the caller
// skips that extra work.
async function chargeMoreCredits(req, res, uid, credits, suffix, reason) {
  try {
    const key = (res._gnKey = res._gnKey || _requestKey(req, uid)) + suffix;
    const r = await wallet.spend(uid, { credits, key, reason: reason || '' });
    if (r.ok) _remember(res, uid, key);
    return !!r.ok;
  } catch (e) {
    console.error('Extra credit charge failed:', e.message);
    return false;
  }
}

// Charge transcription seconds. opts.key (stable key, e.g. an upload chunk), opts.confirm
// (value the browser must echo, or false), opts.partial (charge what's left — for work
// already done), opts.minLeft (seconds that must be left to start), opts.dryRun (only
// check it fits + is confirmed, charge nothing), opts.reason.
async function chargeSeconds(req, res, uid, seconds, opts) {
  opts = opts || {};
  seconds = Math.max(0, Math.round(seconds || 0));
  try {
    _ensureAdmin();
    if (opts.confirm !== undefined && opts.confirm !== false && !_confirmed(req, opts.confirm)) {
      const v = await wallet.summary(uid);
      if (v.secondsLeft < Math.max(seconds, opts.minLeft || 1)) { sendTranscribeLimit(res, v, seconds); return null; }
      res.status(409).json({
        code: 'confirm_cost', kind: 'seconds', seconds, confirm: String(opts.confirm),
        secondsLeft: v.secondsLeft, resetAt: v.resetAt, plan: v.plan,
        error: `This uses about ${_hoursText(seconds)} of transcription. You have ${_hoursText(v.secondsLeft)} left. Confirm to continue.`,
      });
      return null;
    }
    if (opts.minLeft || opts.dryRun) {
      const v = await wallet.summary(uid);
      const need = Math.max(opts.dryRun ? seconds : 0, opts.minLeft || 0);
      if (v.secondsLeft < need) { sendTranscribeLimit(res, v, need); return null; }
      // dryRun: only check that it fits (and that it was confirmed); charge nothing.
      if (opts.dryRun) return { ok: true, view: v, dryRun: true };
    }
    const key = opts.key || ((res._gnKey = res._gnKey || _requestKey(req, uid)) + (opts.suffix || '_sec'));
    const r = await wallet.spend(uid, { seconds, key, reason: opts.reason || 'transcription', partialSeconds: !!opts.partial });
    if (!r.ok) { sendTranscribeLimit(res, r.view, seconds); return null; }
    _remember(res, uid, key);
    return r;
  } catch (e) {
    console.error('Transcription charge failed:', e.message);
    sendUsageUnavailable(res);
    return null;
  }
}

// For work that is checked but not charged (live previews while recording): refuse unless
// at least `min` seconds are left. Sends the reply itself when it returns false.
async function requireSeconds(res, uid, min) {
  try {
    _ensureAdmin();
    const v = await wallet.summary(uid);
    if (v.secondsLeft < (min || 1)) { sendTranscribeLimit(res, v, min || 1); return false; }
    return true;
  } catch (e) {
    console.error('Transcription check failed:', e.message);
    sendUsageUnavailable(res);
    return false;
  }
}

// Give back everything this request was charged (the work failed). Never throws.
async function refundCharges(res, reason) {
  const list = (res && res._gnCharges) || [];
  if (res) res._gnCharges = [];
  for (const c of list) {
    try { await wallet.refund(c.uid, c.key, { reason: reason || 'failed' }); }
    catch (e) { console.error('Refund failed (ledger key ' + c.key + '):', e.message); }
  }
}
// Old name kept for existing call sites (uid is ignored: the charges are on `res`).
async function refundAiAction(uid, res) { return refundCharges(res); }

// Give back part of one charge (a reservation bigger than the real work).
async function refundPart(uid, key, amounts, refundId) {
  try { await wallet.refund(uid, key, Object.assign({ refundId: refundId || 'adjust', reason: 'adjust-to-actual' }, amounts)); }
  catch (e) { console.error('Partial refund failed (ledger key ' + key + '):', e.message); }
}

// Text-size guard: 413 when the text is over the hard limit. Returns true when it sent it.
function rejectTooLong(res, chars, max) {
  max = max || LIMITS.MAX_TEXT_CHARS;
  if (chars <= max) return false;
  res.status(413).json({ code: 'too_long', error: `This is too long to process in one go (${chars.toLocaleString('en-US')} characters; the limit is ${max.toLocaleString('en-US')}). Try a shorter part.` });
  return true;
}

// The user's plan for display and Stripe decisions, read from billing/{uid} (written only
// by the Stripe webhook). 'past_due' keeps the plan while Stripe retries the card.
const PAID_STATUSES = ['active', 'trialing', 'past_due'];
async function getUserPlan(uid) {
  const snap = await getDb().doc(`billing/${uid}`).get();
  const b = snap.exists ? snap.data() : null;
  if (b && PLANS[b.plan] && b.plan !== 'free' && PAID_STATUSES.includes(b.status)) return b.plan;
  return 'free';
}

function _monthKey(d) {
  return (d || new Date()).toISOString().slice(0, 7); // YYYY-MM, UTC
}

// ── Chunked uploads (homepage Upload window: video/audio sent as ~80s WAV parts) ──
// Chunk 0 pays the hourly rate limit, checks the whole file fits in the time left and asks
// the person to confirm. Every chunk is charged its own measured seconds before Whisper
// runs (and refunded if Whisper fails). Later chunks must match a live session.
const UPLOAD_MAX_CHUNKS = 50;
const UPLOAD_TTL_MS = 30 * 60 * 1000; // 30 minutes
const UPLOAD_MAX_ATTEMPTS = 2;        // the browser retries a failed chunk once

function isValidUploadId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(id);
}

// Decides whether a chunk may be processed. Returns one of:
//   { status: 'new' }       chunk 0 and no live session yet — caller runs the normal checks
//   { status: 'ok', attempt }  matches a live session; this attempt (1 or 2) is recorded
//   { status: 'rejected', error }  not allowed (unknown/expired upload, bad or reused index)
//   { status: 'error' }     Firestore unreachable — caller refuses (fail closed)
async function claimUploadChunk(uid, uploadId, chunkIndex) {
  try {
    _ensureAdmin();
    const db = getDb();
    const ref = db.doc(`users/${uid}/uploads/${uploadId}`);
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.exists ? snap.data() : null;
      const live = data && data.expiresAtMs > Date.now();
      if (!live) {
        if (chunkIndex === 0) return { status: 'new' };
        return { status: 'rejected', error: 'This upload took too long and expired. Please upload the file again.' };
      }
      if (chunkIndex >= data.chunkCount) {
        return { status: 'rejected', error: 'This part does not belong to the upload. Please upload the file again.' };
      }
      const attempts = data.attempts || {};
      const used = attempts[chunkIndex] || 0;
      if (used >= UPLOAD_MAX_ATTEMPTS) {
        return { status: 'rejected', error: 'This part of the file was already sent. Please upload the file again.' };
      }
      attempts[chunkIndex] = used + 1;
      tx.set(ref, { attempts }, { merge: true });
      return { status: 'ok', attempt: used + 1 };
    });
  } catch (e) {
    return { status: 'error' };
  }
}

// Records the session after chunk 0 passed the normal checks. Throws on failure (the
// caller refuses the upload).
async function startUploadSession(uid, uploadId, chunkCount) {
  _ensureAdmin();
  const expiresAtMs = Date.now() + UPLOAD_TTL_MS;
  await getDb().doc(`users/${uid}/uploads/${uploadId}`).set({
    chunkCount, attempts: { 0: 1 }, expiresAtMs, expiresAt: new Date(expiresAtMs),
  });
}

// Site-wide tracking of transcribed audio at siteUsage/{YYYY-MM} (no cap; the per-user
// limit is the wallet). Never throws.
async function trackSiteSeconds(seconds) {
  seconds = Math.max(0, Math.round(Number(seconds) || 0));
  if (!seconds) return;
  try {
    _ensureAdmin();
    const db = getDb();
    const month = _monthKey();
    const siteRef = db.doc(`siteUsage/${month}`);
    await db.runTransaction(async (tx) => {
      const siteSnap = await tx.get(siteRef);
      const site = siteSnap.exists ? siteSnap.data() : { month, transcribeSeconds: 0 };
      tx.set(siteRef, { month, transcribeSeconds: (site.transcribeSeconds || 0) + seconds }, { merge: true });
    });
  } catch (e) { /* tracking must never fail the work */ }
}

// Site-wide monthly cap on Supadata transcript calls (its plan is a fixed number per month
// for the whole site). Takes one call from siteUsage/{YYYY-MM}.supadataCalls; returns false
// when the cap is reached OR the counter can't be reached (then Supadata is skipped).
async function takeSupadataCall() {
  const cap = Number(process.env.SUPADATA_MONTHLY_CAP) || 90;
  try {
    _ensureAdmin();
    const db = getDb();
    const month = _monthKey();
    const ref = db.doc(`siteUsage/${month}`);
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const n = snap.exists ? (snap.data().supadataCalls || 0) : 0;
      if (n >= cap) return false;
      tx.set(ref, { month, supadataCalls: n + 1 }, { merge: true });
      return true;
    });
  } catch (e) {
    return false;
  }
}

module.exports = {
  UPLOAD_MAX_CHUNKS,
  isValidUploadId,
  claimUploadChunk,
  startUploadSession,
  trackSiteSeconds,
  takeSupadataCall,
  applyCors,
  verifyAuth,
  verifyAuthFull,
  checkRateLimit,
  checkGuestYoutubeLimit,
  checkYoutubeDailyLimit,
  isAllowedOrigin,
  _ensureAdmin,
  getDb,
  chargeCredits,
  chargeMoreCredits,
  chargeSeconds,
  requireSeconds,
  refundCharges,
  refundAiAction,
  refundPart,
  rejectTooLong,
  sendUsageUnavailable,
  sendTranscribeLimit,
  getUserPlan,
  PAID_STATUSES,
  PLANS,
  YT_PER_DAY,
  CREDIT_RULES,
  LIMITS,
  creditsForSize,
};
