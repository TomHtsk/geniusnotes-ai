const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const admin = require('firebase-admin');
const { _ensureAdmin } = require('./_lib/auth');

async function setProStatus(uid, pro, proUntil) {
  _ensureAdmin();
  await admin.firestore().doc(`users/${uid}`).set({
    pro: !!pro,
    proUntil: proUntil || 0,
    updatedAt: Math.floor(Date.now() / 1000),
  }, { merge: true });
}

async function setPaymentFailed(uid, failed) {
  _ensureAdmin();
  await admin.firestore().doc(`users/${uid}`).set({
    paymentFailed: !!failed,
    updatedAt: Math.floor(Date.now() / 1000),
  }, { merge: true });
}

async function linkStripeCustomer(uid, customerId) {
  _ensureAdmin();
  await admin.firestore().doc(`users/${uid}`).set({ stripeCustomerId: customerId }, { merge: true });
}

// Fallback for subscription events that lack metadata.uid (e.g. a subscription
// created before this change shipped, or directly in the Stripe Dashboard).
async function resolveUidFromCustomer(customerId) {
  _ensureAdmin();
  const snap = await admin.firestore().collection('users').where('stripeCustomerId', '==', customerId).limit(1).get();
  return snap.empty ? null : snap.docs[0].id;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    // Never accept unverified events — fail closed, not open.
    return res.status(500).json({ error: 'Webhook secret not configured' });
  }

  let event;
  try {
    const rawBody = await getRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const uid = session.metadata && session.metadata.uid;
        if (uid) {
          if (session.customer) await linkStripeCustomer(uid, session.customer);
          if (session.subscription) {
            const sub = await stripe.subscriptions.retrieve(session.subscription);
            const active = sub.status === 'active' || sub.status === 'trialing';
            await setProStatus(uid, active, active ? sub.current_period_end : 0);
            await setPaymentFailed(uid, false);
          }
        }
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const uid = (sub.metadata && sub.metadata.uid) || (await resolveUidFromCustomer(sub.customer));
        if (uid) {
          const active = ['active', 'trialing'].includes(sub.status);
          await setProStatus(uid, active, active ? sub.current_period_end : 0);
          if (!active) await setPaymentFailed(uid, false); // canceled/unpaid supersedes the flag
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const uid = (sub.metadata && sub.metadata.uid) || (await resolveUidFromCustomer(sub.customer));
        if (uid) {
          await setProStatus(uid, false, 0);
          await setPaymentFailed(uid, false);
        }
        break;
      }

      case 'invoice.payment_failed': {
        // Stripe retries failed invoices automatically — do NOT revoke pro here.
        // A real cancellation fires customer.subscription.updated/deleted separately.
        // Just flag it for a possible future dunning banner (not wired into any UI yet).
        const invoice = event.data.object;
        const customerId = invoice.customer;
        if (customerId) {
          const uid = await resolveUidFromCustomer(customerId);
          if (uid) await setPaymentFailed(uid, true);
        }
        break;
      }

      default:
        break; // ignore everything else
    }
  } catch (err) {
    console.error('Webhook handler error:', err.message);
    return res.status(500).json({ error: 'Webhook processing failed' }); // Stripe retries
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
