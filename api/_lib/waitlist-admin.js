// Owner-only view of the coming-soon waitlist (the /admin/waitlist page).
// GET /api/subscription?admin=waitlist with the owner's Firebase sign-in token
//   -> { count, entries: [{ email, createdAt, source }] }, newest first.
// The list lives in Firestore `waitlist/{sha256(email)}` (written by api/_lib/site-lock.js).
// The browser can never read that collection directly (no rule in firestore.rules allows
// it), so this server route is the only way to see it.
//
// Who may see it: the owner's main account, plus any uids in the Vercel env var
// NC_ADMIN_UIDS (comma-separated). Everyone else gets 403.
const { verifyAuthFull, checkRateLimit, getDb } = require('./auth');

const OWNER_UID = '7mC5UUxdMPVwmtjwypi7qhiUzd12';
const MAX_ROWS = 10000;

function isAdmin(uid) {
  const extra = String(process.env.NC_ADMIN_UIDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return uid === OWNER_UID || extra.includes(uid);
}

// Returns true if the request was the waitlist admin route (and was answered).
async function handleWaitlistAdmin(req, res) {
  if (req.method !== 'GET' || !req.query || req.query.admin !== 'waitlist') return false;
  res.setHeader('Cache-Control', 'no-store');
  const authed = await verifyAuthFull(req, res);
  if (!authed) return true;
  if (!isAdmin(authed.uid)) { res.status(403).json({ error: 'This page is only for the site owner.' }); return true; }
  if (!(await checkRateLimit(authed.uid, res))) return true;
  try {
    const snap = await getDb().collection('waitlist').orderBy('createdAt', 'desc').limit(MAX_ROWS).get();
    const entries = snap.docs.map((d) => {
      const v = d.data();
      const t = v.createdAt && typeof v.createdAt.toDate === 'function' ? v.createdAt.toDate() : null;
      return { email: v.email || '', createdAt: t ? t.toISOString() : '', source: v.source || '' };
    });
    res.status(200).json({ count: entries.length, entries });
  } catch (e) {
    console.error('Waitlist admin read failed:', e && e.message);
    res.status(503).json({ error: 'Could not read the waitlist right now. Please try again in a minute.' });
  }
  return true;
}

module.exports = { handleWaitlistAdmin };
