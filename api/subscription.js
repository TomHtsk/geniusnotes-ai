const { applyCors, verifyAuthFull, checkRateLimit, getUserPlan, PLAN_LIMITS, getDb } = require('./_lib/auth');

function _monthKey() {
  return new Date().toISOString().slice(0, 7); // YYYY-MM, UTC
}

// Multi-action billing/usage endpoint (folded into one file to stay within Vercel
// Hobby's 12-function limit — see api/_lib/auth.js's PLAN_LIMITS for the numbers).
// The Customer Portal action lives in api/checkout.js instead (POST {action:'portal'}).
//   GET                                -> pro status + this month's usage
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
    try {
      const [userSnap, usageSnap] = await Promise.all([
        db.doc(`users/${uid}`).get(),
        db.doc(`users/${uid}/usage/${_monthKey()}`).get(),
      ]);
      const u = userSnap.exists ? userSnap.data() : {};
      const now = Math.floor(Date.now() / 1000);
      const pro = u.pro === true && (!u.proUntil || u.proUntil === 0 || u.proUntil > now);
      const plan = pro ? 'pro' : 'free';
      const usage = usageSnap.exists ? usageSnap.data() : { aiActions: 0, recordSeconds: 0 };

      return res.status(200).json({
        pro,
        proUntil: u.proUntil || 0,
        aiActionsUsed: usage.aiActions || 0,
        aiActionsLimit: PLAN_LIMITS[plan].ai,
        recordSecondsUsed: usage.recordSeconds || 0,
        recordSecondsLimit: PLAN_LIMITS[plan].record,
        ytPerDay: PLAN_LIMITS[plan].yt,
      });
    } catch (e) {
      return res.status(200).json({
        pro: false, proUntil: 0,
        aiActionsUsed: 0, aiActionsLimit: PLAN_LIMITS.free.ai,
        recordSecondsUsed: 0, recordSecondsLimit: PLAN_LIMITS.free.record,
        ytPerDay: PLAN_LIMITS.free.yt,
      });
    }
  }

  if (req.method === 'POST') {
    const { action } = req.body || {};

    if (action === 'record-check') {
      try {
        const plan = await getUserPlan(uid);
        const limit = PLAN_LIMITS[plan].record;
        const ref = db.doc(`users/${uid}/usage/${_monthKey()}`);
        const snap = await ref.get();
        const used = snap.exists ? (snap.data().recordSeconds || 0) : 0;
        if (used >= limit) {
          return res.status(402).json({ error: 'limit_reached', used, limit, plan });
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
