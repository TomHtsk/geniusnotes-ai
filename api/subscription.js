const { applyCors, verifyAuthFull, checkRateLimit, USAGE_LIMITS, getDb } = require('./_lib/auth');

function _monthKey() {
  return new Date().toISOString().slice(0, 7); // YYYY-MM, UTC
}

// Multi-action usage endpoint (one file, to stay well within Vercel Hobby's function
// limit — see api/_lib/auth.js's USAGE_LIMITS for the numbers). Payments were removed in
// Oct 2026: there is one set of limits for every signed-in account. The file keeps its old
// name so existing calls to /api/subscription keep working.
//   GET                                -> this month's usage and the limits
//   POST { action: 'record-check' }    -> can the user start a recording right now?
//   POST { action: 'record-log', seconds } -> report actual Record Lecture duration
module.exports = async function handler(req, res) {
  applyCors(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const authed = await verifyAuthFull(req, res);
  if (!authed) return;
  if (!(await checkRateLimit(authed.uid, res))) return;

  const { uid } = authed;
  const db = getDb();

  if (req.method === 'GET') {
    let usage = { aiActions: 0, recordSeconds: 0 };
    try {
      const usageSnap = await db.doc(`users/${uid}/usage/${_monthKey()}`).get();
      if (usageSnap.exists) usage = usageSnap.data();
    } catch (e) {}
    return res.status(200).json({
      aiActionsUsed: usage.aiActions || 0,
      aiActionsLimit: USAGE_LIMITS.ai,
      recordSecondsUsed: usage.recordSeconds || 0,
      recordSecondsLimit: USAGE_LIMITS.record,
      ytPerDay: USAGE_LIMITS.yt,
    });
  }

  if (req.method === 'POST') {
    const { action } = req.body || {};

    if (action === 'record-check') {
      try {
        const limit = USAGE_LIMITS.record;
        const ref = db.doc(`users/${uid}/usage/${_monthKey()}`);
        const snap = await ref.get();
        const used = snap.exists ? (snap.data().recordSeconds || 0) : 0;
        if (used >= limit) {
          return res.status(429).json({
            code: 'limit_reached', used, limit,
            error: `You've used this month's ${Math.round(limit / 60)} minutes of lecture recording. The limit resets at the start of next month.`,
          });
        }
        return res.status(200).json({ ok: true });
      } catch (e) {
        return res.status(200).json({ ok: true }); // fail open
      }
    }

    if (action === 'record-log') {
      try {
        const seconds = Math.max(0, Math.floor(Number((req.body || {}).seconds) || 0));
        if (seconds > 0) {
          const ref = db.doc(`users/${uid}/usage/${_monthKey()}`);
          await db.runTransaction(async (tx) => {
            const snap = await tx.get(ref);
            const month = _monthKey();
            const data = snap.exists ? snap.data() : { month, aiActions: 0, recordSeconds: 0 };
            tx.set(ref, Object.assign({}, data, { month, recordSeconds: (data.recordSeconds || 0) + seconds }), { merge: true });
          });
        }
        return res.status(200).json({ ok: true });
      } catch (e) {
        return res.status(200).json({ ok: true }); // fire-and-forget, never fail the client
      }
    }

    return res.status(400).json({ error: 'Unknown action' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
