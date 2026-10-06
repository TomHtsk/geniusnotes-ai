// Server-only wallet: every account's AI credits and transcription seconds, plus an
// auditable ledger of every grant, spend, refund and top-up.
//
//   wallets/{uid}               balances (see _fresh below)
//   wallets/{uid}/ledger/{id}   one entry per grant / spend / refund / top-up
//
// Both are outside users/{uid}, so the browser can never write them (firestore.rules only
// lets people write their own notes/folders/history under users/{uid}). Every change is
// one Firestore transaction that reads the wallet and the ledger entry it is about to
// write; a ledger id that already exists means "already done", so retries and duplicate
// webhooks never charge or grant twice, and concurrent requests can't spend the same
// credit twice (Firestore retries a transaction whose reads changed). Balances never go
// below zero. Any Firestore failure throws — callers refuse the request (fail closed).
//
// Allowance months:
//   Free         refilled on the 1st of each month (UTC), lazily on first use.
//   Paid monthly refilled when Stripe reports the invoice paid (grantPeriod, from the
//                webhook). A failed renewal means no refill: what's left stays usable.
//   Paid yearly  the yearly invoice grants month 1; months 2-12 refill lazily on the same
//                day of each month until the paid year ends.
//   Upgrade      tops up to the new plan's allowance at once (minus what was already used
//                this period). Downgrades take effect when the next invoice is paid.
//   Top-ups      separate lots that last TOPUP_DAYS, used after the monthly allowance, and
//                only while on a paid plan.

const { PLANS, TOPUPS, TOPUP_DAYS, ownerPlan } = require('./plans');

function _db() { return require('./auth').getDb(); }

function monthKey(ms) { return new Date(ms).toISOString().slice(0, 7); }
function monthStart(ms) { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); }
function nextMonthStart(ms) { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); }
// Same day next month (31 Jan -> 28/29 Feb), same time of day.
function addMonth(ms) {
  const d = new Date(ms);
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Date.UTC(y, m, Math.min(d.getUTCDate(), last), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
}

function safeId(s) { return String(s).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 300); }

function _fresh() {
  return {
    plan: 'free', periodKey: null, periodStart: 0, periodEnd: 0, nextRefillAt: null, paidThrough: 0, subId: null,
    monthlyCredits: 0, monthlySeconds: 0, periodUsedCredits: 0, periodUsedSeconds: 0,
    topups: [], createdAt: Date.now(),
  };
}

function _isPaid(w) { return w.plan === 'student' || w.plan === 'pro'; }

function _usableLots(w, kind, now) {
  if (!_isPaid(w)) return [];
  return (w.topups || []).filter(l => l.kind === kind && l.left > 0 && l.expiresAt > now)
    .sort((a, b) => a.expiresAt - b.expiresAt);
}

// Lazy refills (Free month, or the next month inside a paid year). Mutates w and returns
// the grant ledger entries to write.
function _refill(w, now, forcedPlan) {
  const grants = [];
  // Owner accounts (plans.js OWNER_PLANS): their plan's allowance, refilled on the 1st.
  if (forcedPlan && PLANS[forcedPlan]) {
    const key = 'owner:' + forcedPlan + ':' + monthKey(now);
    if (w.periodKey !== key) {
      const P = PLANS[forcedPlan];
      w.plan = forcedPlan; w.periodKey = key;
      w.periodStart = monthStart(now); w.periodEnd = nextMonthStart(now);
      w.nextRefillAt = null; w.paidThrough = 0;
      w.monthlyCredits = P.ai; w.monthlySeconds = P.transcribe;
      w.periodUsedCredits = 0; w.periodUsedSeconds = 0;
      grants.push({ id: safeId('grant_' + key), type: 'grant', reason: 'owner-month', plan: forcedPlan, credits: P.ai, seconds: P.transcribe, at: now });
    }
    return grants;
  }
  if (!_isPaid(w)) {
    const key = 'free:' + monthKey(now);
    if (w.periodKey !== key) {
      w.plan = 'free';
      w.periodKey = key;
      w.periodStart = monthStart(now);
      w.periodEnd = nextMonthStart(now);
      w.nextRefillAt = null;
      w.monthlyCredits = PLANS.free.ai;
      w.monthlySeconds = PLANS.free.transcribe;
      w.periodUsedCredits = 0; w.periodUsedSeconds = 0;
      grants.push({ id: safeId('grant_' + key), type: 'grant', reason: 'free-month', plan: 'free', credits: PLANS.free.ai, seconds: PLANS.free.transcribe, at: now });
    }
  } else {
    let guard = 0;
    // Only while the paid year is still running (after it, the renewal invoice grants).
    while (w.nextRefillAt && w.nextRefillAt <= now && now < (w.paidThrough || 0) && w.nextRefillAt < w.paidThrough && guard++ < 13) {
      const at = w.nextRefillAt, P = PLANS[w.plan];
      w.periodKey = 'm:' + (w.subId || '') + ':' + at;
      w.periodStart = at;
      w.nextRefillAt = addMonth(at);
      w.periodEnd = Math.min(w.nextRefillAt, w.paidThrough);
      w.monthlyCredits = P.ai; w.monthlySeconds = P.transcribe;
      w.periodUsedCredits = 0; w.periodUsedSeconds = 0;
      grants.push({ id: safeId('grant_' + w.periodKey), type: 'grant', reason: 'yearly-plan-month', plan: w.plan, credits: P.ai, seconds: P.transcribe, at: now });
    }
  }
  return grants;
}

function _prune(w, now) {
  w.topups = (w.topups || []).filter(l => l.left > 0 && l.expiresAt > now);
}

function view(w, now) {
  now = now || Date.now();
  const lots = k => _usableLots(w, k, now).reduce((s, l) => s + l.left, 0);
  const owned = k => (w.topups || []).filter(l => l.kind === k && l.left > 0 && l.expiresAt > now).reduce((s, l) => s + l.left, 0);
  const P = PLANS[w.plan] || PLANS.free;
  return {
    plan: w.plan,
    creditsLeft: w.monthlyCredits + lots('credits'),
    monthlyCreditsLeft: w.monthlyCredits,
    topupCreditsLeft: lots('credits'),
    secondsLeft: w.monthlySeconds + lots('seconds'),
    monthlySecondsLeft: w.monthlySeconds,
    topupSecondsLeft: lots('seconds'),
    // Top-ups bought earlier but not usable now (account is on Free).
    unusableTopupCredits: _isPaid(w) ? 0 : owned('credits'),
    unusableTopupSeconds: _isPaid(w) ? 0 : owned('seconds'),
    monthlyCreditsAllowance: P.ai,
    monthlySecondsAllowance: P.transcribe,
    // When the monthly allowance refills next (for a paid monthly plan this is the renewal
    // date, and only happens if that payment succeeds).
    resetAt: w.nextRefillAt && w.nextRefillAt < (w.paidThrough || 0) ? w.nextRefillAt : w.periodEnd,
    topups: (w.topups || []).filter(l => l.left > 0 && l.expiresAt > now).map(l => ({ kind: l.kind, left: l.left, expiresAt: l.expiresAt })),
  };
}

function _take(w, kind, amount, now) {
  const field = kind === 'credits' ? 'monthlyCredits' : 'monthlySeconds';
  const fromMonthly = Math.min(w[field], amount);
  w[field] -= fromMonthly;
  if (kind === 'credits') w.periodUsedCredits += fromMonthly; else w.periodUsedSeconds += fromMonthly;
  let rest = amount - fromMonthly;
  const lots = [];
  for (const lot of _usableLots(w, kind, now)) {
    if (rest <= 0) break;
    const n = Math.min(lot.left, rest);
    lot.left -= n; rest -= n;
    lots.push({ id: lot.id, n });
  }
  return { monthly: fromMonthly, lots };
}

// Give `amount` back along the breakdown it was taken from. Monthly credits only go back
// if the allowance month hasn't changed since (a refill already replaced them).
function _give(w, kind, amount, part, samePeriod) {
  let rest = amount;
  const field = kind === 'credits' ? 'monthlyCredits' : 'monthlySeconds';
  const usedField = kind === 'credits' ? 'periodUsedCredits' : 'periodUsedSeconds';
  const m = Math.min(part.monthly, rest);
  if (m > 0) {
    if (samePeriod) { w[field] += m; w[usedField] = Math.max(0, w[usedField] - m); }
    part.monthly -= m; rest -= m;
  }
  for (const pl of part.lots) {
    if (rest <= 0) break;
    const n = Math.min(pl.n, rest);
    const lot = (w.topups || []).find(l => l.id === pl.id);
    if (lot) lot.left += n;
    pl.n -= n; rest -= n;
  }
}

async function _run(uid, fn) {
  const db = _db();
  const ref = db.doc(`wallets/${uid}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const w = snap.exists ? Object.assign(_fresh(), snap.data()) : _fresh();
    w.topups = (w.topups || []).map(l => Object.assign({}, l));
    const ledgerRef = id => db.doc(`wallets/${uid}/ledger/${safeId(id)}`);
    const forced = ownerPlan(uid);
    return fn({ tx, ref, w, exists: snap.exists, ledgerRef, now: Date.now(), forced });
  });
}

function _writeGrants(tx, ledgerRef, grants) {
  for (const g of grants) tx.set(ledgerRef(g.id), g);
}

// Current balances (refilling first if a new allowance month has started).
async function summary(uid) {
  return _run(uid, async ({ tx, ref, w, exists, ledgerRef, now, forced }) => {
    const grants = _refill(w, now, forced);
    if (grants.length || !exists) {
      _prune(w, now);
      w.updatedAt = now;
      tx.set(ref, w);
      _writeGrants(tx, ledgerRef, grants);
    }
    return view(w, now);
  });
}

// Charge credits and/or seconds for one piece of work. `key` identifies the work: the same
// key twice is charged once. Returns { ok: true, view, duplicate? } or
// { ok: false, view, need: { credits, seconds } } without charging anything.
// partialSeconds: charge as many seconds as are left (for work already done, e.g. a
// recording made with the browser's own speech recognition); still never below zero.
async function spend(uid, opts) {
  const credits = Math.max(0, Math.round(opts.credits || 0));
  let seconds = Math.max(0, Math.round(opts.seconds || 0));
  const id = 'spend_' + opts.key;
  return _run(uid, async ({ tx, ref, w, ledgerRef, now, forced }) => {
    const lref = ledgerRef(id);
    const prior = await tx.get(lref);
    if (prior.exists) return { ok: true, duplicate: true, view: view(w, now) };
    const grants = _refill(w, now, forced);
    const v = view(w, now);
    if (opts.partialSeconds) seconds = Math.min(seconds, v.secondsLeft);
    if (credits > v.creditsLeft || seconds > v.secondsLeft) {
      if (grants.length) { w.updatedAt = now; tx.set(ref, w); _writeGrants(tx, ledgerRef, grants); }
      return { ok: false, view: v, need: { credits, seconds } };
    }
    const bc = _take(w, 'credits', credits, now);
    const bs = _take(w, 'seconds', seconds, now);
    _prune(w, now);
    w.updatedAt = now;
    tx.set(ref, w);
    _writeGrants(tx, ledgerRef, grants);
    tx.set(lref, {
      type: 'spend', key: String(opts.key), reason: opts.reason || '', credits, seconds,
      refundedCredits: 0, refundedSeconds: 0, periodKey: w.periodKey,
      breakdown: { credits: bc, seconds: bs }, at: now,
    });
    return { ok: true, view: view(w, now), charged: { credits, seconds } };
  });
}

// Give back some or all of what `key` charged (a failed request, or a reservation that
// turned out bigger than the real work). refundId makes a partial refund idempotent.
async function refund(uid, key, opts) {
  opts = opts || {};
  const id = 'spend_' + key;
  return _run(uid, async ({ tx, ref, w, ledgerRef, now, forced }) => {
    const lref = ledgerRef(id);
    const rref = ledgerRef('refund_' + key + '_' + (opts.refundId || 'all'));
    const [entrySnap, doneSnap] = await Promise.all([tx.get(lref), tx.get(rref)]);
    if (!entrySnap.exists || doneSnap.exists) return { ok: true, refunded: { credits: 0, seconds: 0 } };
    const e = JSON.parse(JSON.stringify(entrySnap.data()));
    const canC = e.credits - (e.refundedCredits || 0);
    const canS = e.seconds - (e.refundedSeconds || 0);
    const c = Math.max(0, Math.min(canC, opts.credits === undefined ? canC : Math.round(opts.credits)));
    const s = Math.max(0, Math.min(canS, opts.seconds === undefined ? canS : Math.round(opts.seconds)));
    const grants = _refill(w, now, forced);
    const same = w.periodKey === e.periodKey;
    _give(w, 'credits', c, e.breakdown.credits, same);
    _give(w, 'seconds', s, e.breakdown.seconds, same);
    e.refundedCredits = (e.refundedCredits || 0) + c;
    e.refundedSeconds = (e.refundedSeconds || 0) + s;
    _prune(w, now);
    w.updatedAt = now;
    tx.set(ref, w);
    _writeGrants(tx, ledgerRef, grants);
    tx.set(lref, e);
    tx.set(rref, { type: 'refund', key: String(key), credits: c, seconds: s, reason: opts.reason || '', at: now });
    return { ok: true, refunded: { credits: c, seconds: s } };
  });
}

// A paid allowance from Stripe (webhook, invoice paid). kind 'renewal' sets the full
// allowance for a new paid period; 'upgrade' raises it to a higher plan's allowance at once.
async function grantPeriod(uid, g) {
  const P = PLANS[g.plan];
  if (!P || g.plan === 'free') throw new Error('grantPeriod: not a paid plan');
  return _run(uid, async ({ tx, ref, w, ledgerRef, now, forced }) => {
    const lref = ledgerRef('grant_' + g.grantId);
    if ((await tx.get(lref)).exists) return { ok: true, duplicate: true };
    let credits, seconds;
    if (g.kind === 'upgrade') {
      if (_isPaid(w) && PLANS[w.plan].rank >= P.rank) {
        tx.set(lref, { type: 'grant', reason: 'plan-change-no-upgrade', plan: g.plan, credits: 0, seconds: 0, at: now });
        return { ok: true, skipped: true };
      }
      const nc = Math.max(w.monthlyCredits, P.ai - (w.periodUsedCredits || 0));
      const ns = Math.max(w.monthlySeconds, P.transcribe - (w.periodUsedSeconds || 0));
      credits = nc - w.monthlyCredits; seconds = ns - w.monthlySeconds;
      w.monthlyCredits = nc; w.monthlySeconds = ns; w.plan = g.plan;
    } else {
      w.plan = g.plan;
      w.subId = g.subId || null;
      w.periodKey = 'inv:' + g.grantId;
      w.periodStart = g.periodStart;
      w.paidThrough = g.periodEnd;
      w.nextRefillAt = g.interval === 'year' ? addMonth(g.periodStart) : null;
      w.periodEnd = g.interval === 'year' ? Math.min(w.nextRefillAt, g.periodEnd) : g.periodEnd;
      w.monthlyCredits = P.ai; w.monthlySeconds = P.transcribe;
      w.periodUsedCredits = 0; w.periodUsedSeconds = 0;
      credits = P.ai; seconds = P.transcribe;
    }
    _prune(w, now);
    w.updatedAt = now;
    tx.set(ref, w);
    tx.set(lref, { type: 'grant', reason: g.kind, plan: g.plan, credits, seconds, invoice: g.invoiceId || null, at: now });
    return { ok: true, view: view(w, now) };
  });
}

// The subscription ended: back to Free (this month's Free allowance starts now). Top-ups
// are kept but can't be used until the account is on a paid plan again.
async function setFree(uid, id) {
  return _run(uid, async ({ tx, ref, w, ledgerRef, now, forced }) => {
    const lref = ledgerRef('free_' + id);
    if ((await tx.get(lref)).exists) return { ok: true, duplicate: true };
    w.plan = 'free'; w.periodKey = null; w.nextRefillAt = null; w.paidThrough = 0; w.subId = null;
    const grants = _refill(w, now, forced);
    _prune(w, now);
    w.updatedAt = now;
    tx.set(ref, w);
    _writeGrants(tx, ledgerRef, grants);
    tx.set(lref, { type: 'plan-ended', reason: 'subscription-ended', at: now });
    return { ok: true };
  });
}

// A paid top-up (webhook, checkout paid). `id` is the Stripe Checkout Session id.
async function addTopup(uid, t) {
  const def = TOPUPS[t.item];
  if (!def) throw new Error('addTopup: unknown item');
  return _run(uid, async ({ tx, ref, w, ledgerRef, now, forced }) => {
    const lref = ledgerRef('topup_' + t.id);
    if ((await tx.get(lref)).exists) return { ok: true, duplicate: true };
    const expiresAt = now + TOPUP_DAYS * 86400000;
    w.topups.push({ id: safeId(t.id), kind: def.kind, left: def.amount, amount: def.amount, expiresAt, boughtAt: now });
    _prune(w, now);
    w.updatedAt = now;
    tx.set(ref, w);
    tx.set(lref, { type: 'topup', item: t.item, kind: def.kind, amount: def.amount, cents: t.cents || def.cents, expiresAt, at: now });
    return { ok: true };
  });
}

module.exports = { summary, spend, refund, grantPeriod, setFree, addTopup, view, addMonth, safeId, _refill, _fresh };
