const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { applyCors, verifyAuthFull, checkRateLimit } = require('./_lib/auth');

module.exports = async function handler(req, res) {
  applyCors(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const authed = await verifyAuthFull(req, res);
  if (!authed) return;
  if (!(await checkRateLimit(authed.uid, res))) return;

  // Email comes from the verified token, not an arbitrary query param — a signed-in user
  // can no longer look up another account's subscription status by guessing their email.
  const email = authed.email;
  if (!email) return res.status(200).json({ pro: false });

  try {
    const customers = await stripe.customers.list({ email, limit: 1 });
    if (!customers.data.length) return res.status(200).json({ pro: false });
    const subs = await stripe.subscriptions.list({
      customer: customers.data[0].id,
      status: 'active',
      limit: 1
    });
    return res.status(200).json({ pro: subs.data.length > 0 });
  } catch {
    return res.status(200).json({ pro: false });
  }
};
