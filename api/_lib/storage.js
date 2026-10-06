// Cloud storage per account (Free 100 MB, Student 2 GB, Pro 10 GB — PLANS in plans.js).
//
// Notes are written by the browser straight to Firestore, so the server can't refuse an
// individual write. Instead the server measures each account and records the result at
//   storageQuota/{uid} = { usedBytes, limitBytes, blocked, plan, breakdown, checkedAt }
// (server-only; the owner may read it). firestore.rules read `blocked`: a full account
// can still read, edit, shrink and delete, but can't create notes / note pieces / history
// items or make a note's text longer. Nothing is ever deleted for being over the limit.
//
// When it is measured: when the person opens the Notepad or the Pricing page (at most once
// a minute per account), when a cloud save is refused, and for every account once a day
// (Vercel cron -> /api/subscription?cron=storage, see scanAll).
//
// What counts (sizes are the stored JSON, close to Firestore's own byte count):
//   users/{uid}/notepad_notes (+ each note's chunks), notepad_folders, history (also holds
//   flashcard decks), nb_store (notebooks), meta, and shared_notes the account created.

const { PLANS } = require('./plans');

function _db() { return require('./auth').getDb(); }

const RECHECK_MS = 60 * 1000;
const DOC_OVERHEAD = 32; // Firestore adds ~32 bytes per document plus its name

function docBytes(id, data) {
  return DOC_OVERHEAD + Buffer.byteLength(String(id || '')) + Buffer.byteLength(JSON.stringify(data || {}));
}

async function _collectionBytes(path) {
  const snap = await _db().collection(path).get();
  let bytes = 0;
  const docs = [];
  snap.forEach(d => { const data = d.data(); bytes += docBytes(d.id, data); docs.push({ id: d.id, data }); });
  return { bytes, docs };
}

async function measure(uid) {
  const db = _db();
  const notes = await _collectionBytes(`users/${uid}/notepad_notes`);
  let chunkBytes = 0;
  for (const n of notes.docs) {
    if (n.data && n.data.chunked) chunkBytes += (await _collectionBytes(`users/${uid}/notepad_notes/${n.id}/chunks`)).bytes;
  }
  const [folders, history, nb, meta] = await Promise.all([
    _collectionBytes(`users/${uid}/notepad_folders`),
    _collectionBytes(`users/${uid}/history`),
    _collectionBytes(`users/${uid}/nb_store`),
    _collectionBytes(`users/${uid}/meta`),
  ]);
  let shared = 0;
  const sq = await db.collection('shared_notes').where('sharedBy', '==', uid).get();
  sq.forEach(d => { shared += docBytes(d.id, d.data()); });
  const breakdown = { notes: notes.bytes + chunkBytes, folders: folders.bytes, history: history.bytes, notebooks: nb.bytes, shared, other: meta.bytes };
  const usedBytes = Object.values(breakdown).reduce((s, n) => s + n, 0);
  return { usedBytes, breakdown };
}

// Measure (unless measured in the last minute and not forced) and record the result.
// Returns the storageQuota record. Throws if Firestore can't be reached.
async function refresh(uid, opts) {
  opts = opts || {};
  const db = _db();
  const ref = db.doc(`storageQuota/${uid}`);
  const prev = await ref.get();
  const now = Date.now();
  if (!opts.force && prev.exists && now - (prev.data().checkedAt || 0) < RECHECK_MS) return prev.data();
  const plan = await require('./auth').getUserPlan(uid);
  const limitBytes = PLANS[plan].storage;
  const { usedBytes, breakdown } = await measure(uid);
  const rec = { usedBytes, limitBytes, blocked: usedBytes >= limitBytes, plan, breakdown, checkedAt: now };
  await ref.set(rec);
  return rec;
}

async function read(uid) {
  const snap = await _db().doc(`storageQuota/${uid}`).get();
  return snap.exists ? snap.data() : null;
}

// Daily: measure every account, continuing where the last run stopped if it ran out of
// time. The position is kept at billingConfig/storageScan.
async function scanAll(budgetMs) {
  const db = _db();
  const started = Date.now();
  const posRef = db.doc('billingConfig/storageScan');
  const pos = (await posRef.get()).data() || {};
  const refs = await db.collection('users').listDocuments();
  const ids = refs.map(r => r.id).sort();
  let i = pos.lastId ? ids.findIndex(id => id > pos.lastId) : 0;
  if (i < 0) i = 0;
  let done = 0, blocked = 0, failed = 0, lastId = pos.lastId || null;
  for (; i < ids.length; i++) {
    if (Date.now() - started > budgetMs) break;
    try { const rec = await refresh(ids[i], { force: true }); if (rec.blocked) blocked++; done++; }
    catch (e) { failed++; console.error('Storage scan failed for one account:', e.message); }
    lastId = ids[i];
  }
  const finished = i >= ids.length;
  await posRef.set({ lastId: finished ? null : lastId, lastRunAt: Date.now(), lastRunDone: done, finished });
  return { accounts: ids.length, measured: done, blocked, failed, finished };
}

module.exports = { measure, refresh, read, scanAll, docBytes, RECHECK_MS };
