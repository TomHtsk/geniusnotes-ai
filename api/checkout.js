const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { applyCors, verifyAuthFull, checkRateLimit } = require('./_lib/auth');

const PRICES = {
  monthly: 'price_1TZMytFzUKNvR71hbVBxf0Lc',
  yearly:  'price_1TZMytFzUKNvR71hXvErlp8s',
};

module.exports = async function handler(req, res) {
  applyCors(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const authed = await verifyAuthFull(req, res);
  if (!authed) return;
  if (!(await checkRateLimit(authed.uid, res))) return;

  try {
    // uid/email come from the verified token, not the request body — a client can no
    // longer start a checkout session on someone else's account by sending their uid.
    const { uid, email } = authed;
    const { plan = 'monthly' } = req.body || {};
    if (!uid || !email) return res.status(400).json({ error: 'Missing uid or email on token' });

    const priceId = PRICES[plan] || PRICES.monthly;
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'geniusnotes.ai';
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const base = `${proto}://${host}`;

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: email,
      metadata: { uid },
      success_url: `${base}/dashboard.html?pro=1`,
      cancel_url: `${base}/?canceled=1`,
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
