const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Firebase Admin via REST (no SDK needed)
async function setProStatus(uid, active, periodEnd) {
  const projectId = 'geniusnotes-ai';
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${uid}`;
  const body = {
    fields: {
      pro: { booleanValue: active },
      proUntil: { integerValue: periodEnd || 0 },
      updatedAt: { integerValue: Math.floor(Date.now() / 1000) }
    }
  };
  await fetch(url + '?updateMask.fieldPaths=pro&updateMask.fieldPaths=proUntil&updateMask.fieldPaths=updatedAt', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    const rawBody = await getRawBody(req);
    event = webhookSecret
      ? stripe.webhooks.constructEvent(rawBody, sig, webhookSecret)
      : JSON.parse(rawBody.toString());
  } catch (err) {
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const uid = session.metadata?.uid;
      if (uid) {
        const sub = await stripe.subscriptions.retrieve(session.subscription);
        await setProStatus(uid, true, sub.current_period_end);
      }
    }

    if (event.type === 'customer.subscription.deleted' || event.type === 'customer.subscription.updated') {
      const sub = event.data.object;
      const uid = sub.metadata?.uid;
      if (!uid) {
        const sessions = await stripe.checkout.sessions.list({ subscription: sub.id, limit: 1 });
        const s = sessions.data[0];
        if (s?.metadata?.uid) {
          const active = sub.status === 'active';
          await setProStatus(s.metadata.uid, active, active ? sub.current_period_end : 0);
        }
      } else {
        const active = sub.status === 'active';
        await setProStatus(uid, active, active ? sub.current_period_end : 0);
      }
    }
  } catch (err) {
    console.error('Webhook handler error:', err.message);
    // Return 500 so Stripe retries the event
    return res.status(500).json({ error: 'Webhook processing failed' });
  }

  return res.status(200).json({ received: true });
};

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
