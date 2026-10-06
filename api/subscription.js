const {
  applyCors, verifyAuthFull, checkRateLimit, getDb, getUserPlan, sendUsageUnavailable,
  chargeSeconds, PLANS, YT_PER_DAY, LIMITS,
} = require('./_lib/auth');
const wallet = require('./_lib/wallet');
const storage = require('./_lib/storage');
const { TOPUPS, TOPUP_DAYS } = require('./_lib/plans');

// Usage endpoint (the file keeps its old name so existing calls to /api/subscription keep
// working). Balances live in the wallet (api/_lib/wallet.js); plans, top-ups and limits in
// api/_lib/plans.js; buying and managing a plan in api/billing.js. Everything here is read
// or charged on the server — the browser never sends a plan, balance or price.
//   GET                                -> plan, credits and transcription time left, reset date
//   POST { action: 'record-check' }    -> can the user start a recording? (time left)
//   POST { action: 'record-log', seconds } -> charge a homepage Record Lecture that the
//        browser's own speech recognition turned into text (no AI service ran, so the
//        browser's length is accepted, capped at MAX_AUDIO_SECONDS and at the time left)
//   POST { action: 'storage-check' }   -> measure cloud storage now (at most once a minute)
//   GET ?cron=storage (Vercel cron, Authorization: Bearer $CRON_SECRET) -> measure every
//        account's storage (api/_lib/storage.js), continuing tomorrow if it runs out of time
module.exports = async function handler(req, res) {
  applyCors(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET' && req.query && req.query.cron === 'storage') {
    const secret = process.env.CRON_SECRET;
    if (!secret || req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const result = await storage.scanAll(45 * 1000);
      return res.status(200).json(result);
    } catch (e) {
      console.error('Storage scan failed:', e.message);
      return res.status(500).json({ error: 'Storage scan failed' });
    }
  }

  const authed = await verifyAuthFull(req, res);
  if (!authed) return;
  if (!(await checkRateLimit(authed.uid, res))) return;

  const { uid } = authed;

  if (req.method === 'GET') {
    let v, billing = {}, plan, store = null;
    try {
      const db = getDb();
      [v, plan] = await Promise.all([wallet.summary(uid), getUserPlan(uid)]);
      const billSnap = await db.doc(`billing/${uid}`).get();
      if (billSnap.exists) billing = billSnap.data();
      // Storage: measured at most once a minute; a failure here doesn't hide the rest.
      try { store = await storage.refresh(uid); } catch (e) { console.error('Storage measure failed:', e.message); }
    } catch (e) {
      console.error('Usage read failed:', e.message);
      return sendUsageUnavailable(res);
    }
    return res.status(200).json(Object.assign({}, v, {
      plan,
      planName: PLANS[plan].name,
      allowancePlan: v.plan,           // the plan whose allowance the wallet holds
      interval: plan === 'free' ? null : (billing.interval || null),
      renewsAt: plan === 'free' ? null : (billing.currentPeriodEnd || null),
      cancelAtPeriodEnd: plan === 'free' ? false : !!billing.cancelAtPeriodEnd,
      paymentProblem: billing.status === 'past_due' || !!billing.lastPaymentFailedAt && (billing.lastPaymentFailedAt > (billing.lastPaidAt || 0)),
      trialEndsAt: billing.status === 'trialing' ? (billing.trialEnd || null) : null,
      canBuyTopups: plan !== 'free' && v.plan !== 'free',
      topupOffers: Object.entries(TOPUPS).map(([id, t]) => ({ id, name: t.name, kind: t.kind, amount: t.amount, price: (t.cents / 100).toFixed(2), days: TOPUP_DAYS })),
      ytPerDay: YT_PER_DAY,
      storage: store ? { usedBytes: store.usedBytes, limitBytes: store.limitBytes, blocked: store.blocked, checkedAt: store.checkedAt } : null,
    }));
  }

  if (req.method === 'POST') {
    const { action } = req.body || {};

    if (action === 'record-check') {
      try {
        const v = await wallet.summary(uid);
        if (v.secondsLeft < 1) {
          return res.status(429).json({
            code: 'limit_reached', plan: v.plan, secondsLeft: 0, resetAt: v.resetAt,
            error: v.plan === 'free'
              ? 'Transcription (Record Lecture and audio/video uploads) is included in the Student and Pro plans. See the Pricing page.'
              : 'You\'ve used all your transcription time for now. You can wait for your allowance to refill, upgrade, or buy a top-up on the Pricing page.',
          });
        }
        return res.status(200).json({ ok: true, secondsLeft: v.secondsLeft, resetAt: v.resetAt });
      } catch (e) {
        console.error('Record check failed:', e.message);
        return sendUsageUnavailable(res);
      }
    }

    if (action === 'storage-check') {
      try {
        const s = await storage.refresh(uid);
        return res.status(200).json({ usedBytes: s.usedBytes, limitBytes: s.limitBytes, blocked: s.blocked, plan: s.plan, checkedAt: s.checkedAt });
      } catch (e) {
        console.error('Storage check failed:', e.message);
        return sendUsageUnavailable(res);
      }
    }

    if (action === 'record-log') {
      const seconds = Math.min(LIMITS.MAX_AUDIO_SECONDS * 8, Math.max(0, Math.floor(Number((req.body || {}).seconds) || 0)));
      if (!seconds) return res.status(200).json({ ok: true });
      const r = await chargeSeconds(req, res, uid, seconds, { partial: true, reason: 'recording-browser' });
      if (!r) return;
      return res.status(200).json({ ok: true, secondsLeft: r.view.secondsLeft });
    }

    return res.status(400).json({ error: 'Unknown action' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
