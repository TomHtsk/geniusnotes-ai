const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { applyCors, verifyAuthFull, checkRateLimit, getDb, _debugVerify } = require('./_lib/auth');

module.exports = async function handler(req, res) {
  applyCors(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // TEMPORARY DIAGNOSTIC — remove once root-caused.
  if (req.headers['x-gn-debug'] === '1') {
    try {
      const result = await _debugVerify(req);
      return res.status(200).json({ debug: true, result });
    } catch (e) {
      return res.status(200).json({ debug: true, error: e.message, code: e.code, name: e.name, stack: (e.stack || '').split('\n').slice(0, 5) });
    }
  }

  const authed = await verifyAuthFull(req, res);
  if (!authed) return;
  if (!(await checkRateLimit(authed.uid, res))) return;

  const { uid, email } = authed;
  const { action } = req.body || {};
  const userRef = getDb().doc(`users/${uid}`);

  if (action === 'portal') {
    try {
      const userSnap = await userRef.get();
      const customerId = userSnap.exists ? userSnap.data().stripeCustomerId : null;
      if (!customerId) {
        return res.status(400).json({ error: 'no_subscription', message: 'No billing account found yet — subscribe to Pro first.' });
      }
      const host = req.headers['x-forwarded-host'] || req.headers.host || 'notecaptain.ai';
      const proto = req.headers['x-forwarded-proto'] || 'https';
      const session = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: `${proto}://${host}/dashboard.html`,
      });
      return res.status(200).json({ url: session.url });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  try {
    // uid/email come from the verified token, not the request body — a client can no
    // longer start a checkout session on someone else's account by sending their uid.
    const { plan = 'monthly' } = req.body || {};
    if (!uid || !email) return res.status(400).json({ error: 'Missing uid or email on token' });

    const priceId = plan === 'yearly' ? process.env.STRIPE_PRICE_YEARLY : process.env.STRIPE_PRICE_MONTHLY;
    if (!priceId) return res.status(500).json({ error: 'Pricing not configured' });

    // Reuse-or-create a real Stripe Customer tied to uid (instead of a
    // customer_email-only session) so the Customer Portal and webhook.js both
    // have a stable id to key off of.
    const userSnap = await userRef.get();
    let customerId = userSnap.exists ? userSnap.data().stripeCustomerId : null;
    if (!customerId) {
      const customer = await stripe.customers.create({ email, metadata: { uid } });
      customerId = customer.id;
      await userRef.set({ stripeCustomerId: customerId }, { merge: true });
    }

    const host = req.headers['x-forwarded-host'] || req.headers.host || 'notecaptain.ai';
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const base = `${proto}://${host}`;

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      customer: customerId,
      allow_promotion_codes: true,
      subscription_data: { metadata: { uid } },
      metadata: { uid },
      success_url: `${base}/dashboard.html?pro=1`,
      cancel_url: `${base}/#pricing`,
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
