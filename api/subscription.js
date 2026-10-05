const {
  applyCors, verifyAuthFull, checkRateLimit, getDb,
  PLANS, YT_PER_DAY, getUserPlan, getTranscribeAllowance, sendTranscribeLimit,
} = require('./_lib/auth');

function _monthKey() {
  return new Date().toISOString().slice(0, 7); // YYYY-MM, UTC
}

// Usage endpoint (the file keeps its old name so existing calls to /api/subscription keep
// working). Plans and limits are in api/_lib/auth.js (PLANS); buying and managing a plan
// is in api/billing.js.
//   GET                                -> the user's plan, this month's usage and the limits
//   POST { action: 'record-check' }    -> can the user start a recording right now?
//   POST { action: 'record-log', seconds } -> report a Record Lecture that was turned into
//        text by the browser's own speech recognition (costs us nothing, so the browser's
//        number is accepted, capped per call)
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
    let billing = {};
    const plan = await getUserPlan(uid);
    try {
      const [usageSnap, billSnap] = await Promise.all([
        db.doc(`users/${uid}/usage/${_monthKey()}`).get(),
        db.doc(`billing/${uid}`).get(),
      ]);
      if (usageSnap.exists) usage = usageSnap.data();
      if (billSnap.exists) billing = billSnap.data();
    } catch (e) {}
    return res.status(200).json({
      plan,
      planName: PLANS[plan].name,
      interval: plan === 'free' ? null : (billing.interval || null),
      renewsAt: plan === 'free' ? null : (billing.currentPeriodEnd || null),
      cancelAtPeriodEnd: plan === 'free' ? false : !!billing.cancelAtPeriodEnd,
      // Launch-offer free month: when it ends (the first charge, unless they cancel).
      trialEndsAt: billing.status === 'trialing' ? (billing.trialEnd || null) : null,
      paymentProblem: billing.status === 'past_due',
      creditsUsed: usage.aiActions || 0,
      creditsLimit: PLANS[plan].ai,
      transcribeSecondsUsed: usage.recordSeconds || 0,
      transcribeSecondsLimit: PLANS[plan].transcribe,
      ytPerDay: YT_PER_DAY,
      // Old names, still read by older pages.
      aiActionsUsed: usage.aiActions || 0,
      aiActionsLimit: PLANS[plan].ai,
      recordSecondsUsed: usage.recordSeconds || 0,
      recordSecondsLimit: PLANS[plan].transcribe,
    });
  }

  if (req.method === 'POST') {
    const { action } = req.body || {};

    if (action === 'record-check') {
      try {
        const a = await getTranscribeAllowance(uid);
        if (a.used >= a.limit) return sendTranscribeLimit(res, a);
        return res.status(200).json({ ok: true, secondsLeft: a.limit - a.used });
      } catch (e) {
        return res.status(200).json({ ok: true }); // fail open
      }
    }

    if (action === 'record-log') {
      try {
        const seconds = Math.min(4 * 3600, Math.max(0, Math.floor(Number((req.body || {}).seconds) || 0)));
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
