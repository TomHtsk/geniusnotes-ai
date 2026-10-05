const crypto = require('crypto');
const { applyCors, verifyAuthFull, checkRateLimit, getDb, isAllowedOrigin, getUserPlan } = require('./_lib/auth');

// Paid plans through Stripe (Oct 2026). Talks to Stripe's REST API with fetch — no
// `stripe` package. Needs two Vercel env vars:
//   STRIPE_SECRET_KEY      sk_test_... while testing, sk_live_... to take real money
//   STRIPE_WEBHOOK_SECRET  whsec_... from the webhook endpoint pointing at
//                          https://www.notecaptain.ai/api/billing
// The products, prices and the "Manage subscription" page settings are created in Stripe
// by this file the first time they are needed (separately for test and live mode), so
// nothing has to be set up by hand in the Stripe dashboard except the webhook.
//
//   POST { action: 'checkout', plan: 'student'|'pro', interval: 'month'|'year' } -> { url }
//        (already subscribed -> { portal: true, url } to the manage page instead)
//   POST { action: 'portal' }   -> { url } of Stripe's page to cancel / switch / change card
//   POST from Stripe (has a Stripe-Signature header) -> webhook; keeps billing/{uid} up to date
//
// billing/{uid} = { plan, status, interval, stripeCustomerId, stripeSubscriptionId,
//                   currentPeriodEnd (ms), cancelAtPeriodEnd, updatedAt }
// Only this file writes it; the browser can't (firestore.rules). Limits are read from it by
// getUserPlan in api/_lib/auth.js.

// ── Prices. Change an amount here and a new Stripe price is created automatically (the
// amount is part of the lookup key); people already subscribed keep their old price.
const PRICES = {
  student_month: { plan: 'student', interval: 'month', amount: 499 },
  student_year:  { plan: 'student', interval: 'year',  amount: 4990 },
  pro_month:     { plan: 'pro',     interval: 'month', amount: 999 },
  pro_year:      { plan: 'pro',     interval: 'year',  amount: 9990 },
};
const PRODUCT_NAMES = { student: 'NoteCaptain Student', pro: 'NoteCaptain Pro' };
const SITE = 'https://www.notecaptain.ai';
// Pinned so Stripe's replies always have the same shape, whatever the account's default.
const STRIPE_VERSION = '2024-06-20';
const PAID_STATUSES = ['active', 'trialing', 'past_due'];

function _lookupKey(key) { return `nc_${key}_${PRICES[key].amount}`; }

// Stripe wants form encoding with nested keys: a[b][0][c]=...
function _encode(obj, prefix, out) {
  out = out || [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') _encode(v, key, out);
    else out.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(v)));
  }
  return out;
}

async function stripe(method, path, params) {
  const key = process.env.STRIPE_SECRET_KEY;
  const qs = params ? _encode(params).join('&') : '';
  const url = 'https://api.stripe.com/v1' + path + (method === 'GET' && qs ? '?' + qs : '');
  const r = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'Stripe-Version': STRIPE_VERSION,
      ...(method === 'GET' ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }),
    },
    body: method === 'GET' ? undefined : qs,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error((data.error && data.error.message) || `Stripe ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return data;
}

// ── Products, prices and the manage page, created once per mode and remembered while
// this server instance is warm.
let _prices = null, _portalConfig = null;

async function ensurePrices() {
  if (_prices) return _prices;
  const keys = Object.keys(PRICES);
  const found = await stripe('GET', '/prices', { active: 'true', limit: 20, lookup_keys: keys.map(_lookupKey) });
  const byLookup = {};
  for (const p of found.data || []) byLookup[p.lookup_key] = p;

  const productFor = {}; // plan -> product id
  for (const k of keys) {
    const p = byLookup[_lookupKey(k)];
    if (p) productFor[PRICES[k].plan] = typeof p.product === 'string' ? p.product : p.product.id;
  }
  const result = {};
  for (const k of keys) {
    const def = PRICES[k];
    let p = byLookup[_lookupKey(k)];
    if (!p) {
      if (!productFor[def.plan]) {
        const prod = await stripe('POST', '/products', { name: PRODUCT_NAMES[def.plan], metadata: { nc_plan: def.plan } });
        productFor[def.plan] = prod.id;
      }
      p = await stripe('POST', '/prices', {
        product: productFor[def.plan],
        currency: 'usd',
        unit_amount: def.amount,
        recurring: { interval: def.interval },
        lookup_key: _lookupKey(k),
        transfer_lookup_key: 'true',
        metadata: { nc_plan: def.plan, nc_interval: def.interval },
      });
    }
    result[k] = { id: p.id, product: productFor[def.plan] };
  }
  _prices = result;
  return result;
}

// Settings for Stripe's "Manage subscription" page: cancel (at the end of the paid period),
// switch between Student/Pro and monthly/yearly, change card, see invoices.
async function ensurePortalConfig() {
  if (_portalConfig) return _portalConfig;
  const prices = await ensurePrices();
  const tag = 'v1:' + Object.keys(PRICES).map(k => prices[k].id).join(',');
  const list = await stripe('GET', '/billing_portal/configurations', { active: 'true', limit: 100 });
  const existing = (list.data || []).find(c => c.metadata && c.metadata.nc === tag);
  if (existing) return (_portalConfig = existing.id);

  const products = {};
  for (const k of Object.keys(PRICES)) {
    const pid = prices[k].product;
    (products[pid] = products[pid] || []).push(prices[k].id);
  }
  const cfg = await stripe('POST', '/billing_portal/configurations', {
    business_profile: { headline: 'NoteCaptain — manage your plan' },
    default_return_url: SITE + '/pricing.html',
    features: {
      invoice_history: { enabled: 'true' },
      payment_method_update: { enabled: 'true' },
      subscription_cancel: { enabled: 'true', mode: 'at_period_end' },
      subscription_update: {
        enabled: 'true',
        default_allowed_updates: ['price'],
        proration_behavior: 'create_prorations',
        products: Object.entries(products).map(([product, ps]) => ({ product, prices: ps })),
      },
    },
    metadata: { nc: tag },
  });
  return (_portalConfig = cfg.id);
}

function _returnBase(req) {
  const origin = req.headers.origin;
  return isAllowedOrigin(origin) ? origin : SITE;
}

// One Stripe customer per account, remembered in billing/{uid}.
async function ensureCustomer(uid, email) {
  const ref = getDb().doc(`billing/${uid}`);
  const snap = await ref.get();
  const b = snap.exists ? snap.data() : {};
  if (b.stripeCustomerId) return b.stripeCustomerId;
  const c = await stripe('POST', '/customers', { email: email || undefined, metadata: { uid } });
  await ref.set({ stripeCustomerId: c.id, plan: b.plan || 'free', updatedAt: Date.now() }, { merge: true });
  return c.id;
}

// ── Webhook ──────────────────────────────────────────────────────────────────
function verifySignature(rawBody, header, secret) {
  if (!header) return false;
  const parts = {};
  for (const kv of String(header).split(',')) {
    const i = kv.indexOf('=');
    if (i > 0) (parts[kv.slice(0, i)] = parts[kv.slice(0, i)] || []).push(kv.slice(i + 1));
  }
  const t = parts.t && parts.t[0];
  if (!t || !parts.v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false; // older than 5 minutes
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody.toString('utf8')}`).digest('hex');
  const exp = Buffer.from(expected, 'utf8');
  return parts.v1.some(sig => {
    const got = Buffer.from(sig, 'utf8');
    return got.length === exp.length && crypto.timingSafeEqual(got, exp);
  });
}

function _planOfPrice(price) {
  const m = (price && price.metadata && price.metadata.nc_plan) || '';
  if (m === 'student' || m === 'pro') return m;
  const lk = (price && price.lookup_key) || '';
  if (lk.startsWith('nc_student_')) return 'student';
  if (lk.startsWith('nc_pro_')) return 'pro';
  return null;
}

// Reads the subscription fresh from Stripe (so the order events arrive in never matters)
// and writes the result to billing/{uid}.
async function syncSubscription(subId, hintUid) {
  const db = getDb();
  const sub = await stripe('GET', `/subscriptions/${subId}`);
  let uid = (sub.metadata && sub.metadata.uid) || hintUid || null;
  if (!uid && sub.customer) {
    const q = await db.collection('billing').where('stripeCustomerId', '==', sub.customer).limit(1).get();
    if (!q.empty) uid = q.docs[0].id;
  }
  if (!uid) { console.error('Stripe webhook: no account found for subscription', sub.id); return; }

  const item = sub.items && sub.items.data && sub.items.data[0];
  const price = item && item.price;
  const plan = _planOfPrice(price);
  if (!plan) { console.error('Stripe webhook: unknown price on subscription', sub.id); return; }

  const ref = db.doc(`billing/${uid}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const cur = snap.exists ? snap.data() : {};
    // An old, ended subscription must not overwrite a newer one that is still running.
    if (cur.stripeSubscriptionId && cur.stripeSubscriptionId !== sub.id &&
        PAID_STATUSES.includes(cur.status) && !PAID_STATUSES.includes(sub.status)) return;
    const periodEnd = sub.current_period_end || (item && item.current_period_end) || 0;
    tx.set(ref, {
      plan: PAID_STATUSES.includes(sub.status) ? plan : 'free',
      status: sub.status,
      interval: (price.recurring && price.recurring.interval) || null,
      stripeCustomerId: sub.customer,
      stripeSubscriptionId: sub.id,
      currentPeriodEnd: periodEnd * 1000,
      cancelAtPeriodEnd: !!sub.cancel_at_period_end,
      updatedAt: Date.now(),
    }, { merge: true });
  });
}

async function handleWebhook(req, res, rawBody) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !process.env.STRIPE_SECRET_KEY) return res.status(500).json({ error: 'Payments are not configured' });
  if (!verifySignature(rawBody, req.headers['stripe-signature'], secret)) {
    return res.status(400).json({ error: 'Bad signature' });
  }
  let event;
  try { event = JSON.parse(rawBody.toString('utf8')); } catch (e) { return res.status(400).json({ error: 'Bad JSON' }); }

  try {
    const obj = (event.data && event.data.object) || {};
    if (event.type === 'checkout.session.completed' && obj.mode === 'subscription' && obj.subscription) {
      await syncSubscription(obj.subscription, obj.client_reference_id || (obj.metadata && obj.metadata.uid));
    } else if (/^customer\.subscription\.(created|updated|deleted|paused|resumed)$/.test(event.type)) {
      await syncSubscription(obj.id, obj.metadata && obj.metadata.uid);
    }
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('Stripe webhook error:', err.message);
    return res.status(500).json({ error: 'Webhook handling failed' }); // Stripe retries later
  }
}

// Body parsing is turned off (config below) because the webhook signature must be checked
// against the exact bytes Stripe sent.
function readRawBody(req) {
  if (Buffer.isBuffer(req.body)) return Promise.resolve(req.body);
  if (typeof req.body === 'string') return Promise.resolve(Buffer.from(req.body));
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const NOT_SET_UP = 'Payments are not set up yet. Please try again later.';
const STRIPE_FAILED = "We couldn't reach the payment service. Please try again in a moment.";

async function handler(req, res) {
  applyCors(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const rawBody = await readRawBody(req);
  if (req.headers['stripe-signature']) return handleWebhook(req, res, rawBody);

  // The body was not parsed for us (see config), so the JSON is read here.
  let body = {};
  try { body = rawBody.length ? JSON.parse(rawBody.toString('utf8')) : {}; } catch (e) {}
  req.body = body;

  const authed = await verifyAuthFull(req, res);
  if (!authed) return;
  if (!(await checkRateLimit(authed.uid, res))) return;
  if (!process.env.STRIPE_SECRET_KEY) return res.status(503).json({ error: NOT_SET_UP });
  const { uid, email } = authed;

  try {
    if (body.action === 'portal') {
      const snap = await getDb().doc(`billing/${uid}`).get();
      const customer = snap.exists ? snap.data().stripeCustomerId : null;
      if (!customer) return res.status(400).json({ error: "You don't have a paid plan yet." });
      const session = await stripe('POST', '/billing_portal/sessions', {
        customer, configuration: await ensurePortalConfig(), return_url: _returnBase(req) + '/pricing.html',
      });
      return res.status(200).json({ url: session.url });
    }

    if (body.action === 'checkout') {
      const key = `${body.plan}_${body.interval}`;
      if (!PRICES[key]) return res.status(400).json({ error: 'Please choose a plan.' });

      const customer = await ensureCustomer(uid, email);
      // Already paying: plan changes happen on Stripe's manage page, so nobody ends up
      // with two subscriptions.
      if ((await getUserPlan(uid)) !== 'free') {
        const session = await stripe('POST', '/billing_portal/sessions', {
          customer, configuration: await ensurePortalConfig(), return_url: _returnBase(req) + '/pricing.html',
        });
        return res.status(200).json({ portal: true, url: session.url });
      }

      const prices = await ensurePrices();
      const base = _returnBase(req);
      const session = await stripe('POST', '/checkout/sessions', {
        mode: 'subscription',
        customer,
        client_reference_id: uid,
        line_items: [{ price: prices[key].id, quantity: 1 }],
        subscription_data: { metadata: { uid } },
        metadata: { uid },
        success_url: base + '/pricing.html?checkout=success',
        cancel_url: base + '/pricing.html?checkout=cancel',
      });
      return res.status(200).json({ url: session.url });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('Stripe error (billing):', err.message);
    return res.status(502).json({ error: STRIPE_FAILED });
  }
}

module.exports = handler;
module.exports.config = { api: { bodyParser: false } };
// For local tests only.
module.exports._test = { verifySignature, _encode, PRICES, resetCache: () => { _prices = null; _portalConfig = null; } };
