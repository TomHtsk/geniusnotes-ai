// "Coming soon" site lock — the two public actions of the coming-soon page.
// The lock itself (which pages may be opened) is middleware.js in the project root; this file
// only handles the two buttons on coming-soon.html. They are sent to /api/subscription as
// POST { action: 'site-unlock', code } and POST { action: 'waitlist', email }, so no new
// serverless function is needed. They are the only actions that work without signing in.
//
// Env vars (Vercel): SITE_LOCKED = "true" turns the lock on; SITE_ACCESS_PASSWORD = the code.
// The unlock cookie is "<expiry ms>.<HMAC-SHA256(code, 'nc-access:' + expiry)>", so it can't be
// forged without the code, and changing the code in Vercel signs everyone out of the lock.
// middleware.js checks the same cookie with the same formula — keep the two in step.
const crypto = require('crypto');
const { _ensureAdmin, getDb, isAllowedOrigin } = require('./auth');

const COOKIE_NAME = 'nc_access';
const COOKIE_DAYS = 30;
const ATTEMPTS_PER_MINUTE = 5;   // per visitor (IP), for the access code and for the waitlist

// Database unreachable -> refuse (fail closed), never unlock or rate-limit-skip.
function _unavailable(res, where, e) {
  console.error('Site lock (' + where + ') failed:', e && e.message);
  if (!res.headersSent) res.status(503).json({ error: 'Something went wrong on our side. Please try again in a minute.' });
}

function _clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  const ip = fwd ? String(fwd).split(',')[0].trim() : (req.headers['x-real-ip'] || 'unknown');
  return String(ip).replace(/[^a-zA-Z0-9.:]/g, '_').slice(0, 100) || 'unknown';
}

// Fixed one-minute window per IP, stored server-only (top-level collection; the browser
// can't read or write it). Returns true if allowed, false if over; throws if Firestore fails.
async function _underLimit(collection, req) {
  _ensureAdmin();
  const db = getDb();
  const ref = db.doc(`${collection}/${_clientIp(req)}`);
  const now = Date.now();
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const d = snap.exists ? snap.data() : null;
    if (!d || !d.windowStart || now - d.windowStart >= 60 * 1000) {
      tx.set(ref, { count: 1, windowStart: now });
      return true;
    }
    if (d.count >= ATTEMPTS_PER_MINUTE) return false;
    tx.set(ref, { count: d.count + 1, windowStart: d.windowStart });
    return true;
  });
}

function _sameCode(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function accessCookieValue(password, expiresAt) {
  const sig = crypto.createHmac('sha256', password).update(`nc-access:${expiresAt}`).digest('hex');
  return `${expiresAt}.${sig}`;
}

async function _unlock(req, res) {
  const password = process.env.SITE_ACCESS_PASSWORD;
  if (!password) return res.status(503).json({ error: 'Access codes are not set up yet.' });
  try {
    if (!(await _underLimit('siteLockAttempts', req))) {
      return res.status(429).json({ error: 'Too many tries. Please wait a minute and try again.' });
    }
  } catch (e) { _unavailable(res, 'unlock', e); return; }

  const code = String((req.body || {}).code || '').slice(0, 200);
  if (!code || !_sameCode(code, password)) return res.status(401).json({ error: 'Incorrect code' });

  const expiresAt = Date.now() + COOKIE_DAYS * 24 * 60 * 60 * 1000;
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${accessCookieValue(password, expiresAt)}; Max-Age=${COOKIE_DAYS * 24 * 60 * 60}; Path=/; HttpOnly; Secure; SameSite=Lax`);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ ok: true });
}

const EMAIL_RX = /^[^\s@<>()",;]{1,64}@[^\s@<>()",;]+\.[a-zA-Z]{2,}$/;

async function _waitlist(req, res) {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RX.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
  try {
    if (!(await _underLimit('waitlistAttempts', req))) {
      return res.status(429).json({ error: 'Too many tries. Please wait a minute and try again.' });
    }
    const id = crypto.createHash('sha256').update(email).digest('hex');
    try {
      await getDb().doc(`waitlist/${id}`).create({ email, createdAt: new Date(), source: 'coming-soon' });
    } catch (e) {
      if (e && (e.code === 6 || /already exists/i.test(e.message || ''))) return res.status(200).json({ ok: true });
      throw e;
    }
    return res.status(200).json({ ok: true });
  } catch (e) { _unavailable(res, 'waitlist', e); return; }
}

// Returns true if the request was one of the two coming-soon actions (and was answered).
async function handleSiteLockAction(req, res) {
  if (req.method !== 'POST') return false;
  const action = (req.body || {}).action;
  if (action !== 'site-unlock' && action !== 'waitlist') return false;
  // Only our own pages may call these (stops other sites from posting to them).
  if (!isAllowedOrigin(req.headers.origin)) { res.status(403).json({ error: 'Forbidden' }); return true; }
  if (action === 'site-unlock') await _unlock(req, res);
  else await _waitlist(req, res);
  return true;
}

module.exports = { handleSiteLockAction, accessCookieValue, COOKIE_NAME };
