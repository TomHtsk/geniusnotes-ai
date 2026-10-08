// Export the coming-soon waitlist (Firestore collection "waitlist") to a CSV file.
// Runs on your own computer. It only READS the database; nothing is changed or deleted.
//
// Usage (from the project folder):
//   node tools/export-waitlist.js "C:\path\to\firebase-admin-key.json" ["C:\path\to\output.csv"]
//
// The admin key: Firebase console -> Project settings (gear icon) -> Service accounts ->
// "Generate new private key". Keep that file OUTSIDE the project folder (e.g. in Documents)
// and never share it or put it in git: it gives full access to the database.
// Instead of the first argument you can set the GOOGLE_APPLICATION_CREDENTIALS env var.
//
// Output: email, signed_up (UTC, ISO 8601), source — oldest sign-up first. The file is saved
// as UTF-8 with Windows line endings so Excel opens it cleanly. Default location:
// your Downloads folder, named waitlist-YYYY-MM-DD.csv.
const fs = require('fs');
const os = require('os');
const path = require('path');

// A cell that starts with = + - @ (or a tab / carriage return) could run as a formula in
// Excel or Google Sheets, so it gets a leading apostrophe. Quotes are doubled.
function csvCell(value) {
  let s = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toDate(v) {
  if (!v) return null;
  if (typeof v.toDate === 'function') return v.toDate();      // Firestore Timestamp
  const d = new Date(v);
  return isNaN(d) ? null : d;
}

// rows: [{ email, createdAt, source }] -> CSV text (with BOM, CRLF)
function toCsv(rows) {
  const sorted = rows
    .map(r => ({ email: r.email || '', when: toDate(r.createdAt), source: r.source || '' }))
    .sort((a, b) => (a.when ? a.when.getTime() : 0) - (b.when ? b.when.getTime() : 0));
  const lines = [['email', 'signed_up', 'source'].join(',')];
  for (const r of sorted) {
    lines.push([csvCell(r.email), csvCell(r.when ? r.when.toISOString() : ''), csvCell(r.source)].join(','));
  }
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

function fail(msg) {
  console.error('\n' + msg + '\n');
  process.exit(1);
}

async function main() {
  const keyPath = process.argv[2] || process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!keyPath) {
    fail('Please give the path to your Firebase admin key file, for example:\n' +
      '  node tools/export-waitlist.js "C:\\Users\\you\\Documents\\firebase-admin-key.json"\n' +
      'Get one from Firebase console -> Project settings -> Service accounts -> Generate new private key.');
  }
  let key;
  try { key = JSON.parse(fs.readFileSync(keyPath, 'utf8')); }
  catch (e) { fail('Could not read the key file "' + keyPath + '". Check the path (put it in quotes if it has spaces).'); }
  if (!key || key.type !== 'service_account' || !key.private_key || !key.client_email) {
    fail('That file does not look like a Firebase admin key (service account JSON).');
  }

  const out = process.argv[3] ||
    path.join(os.homedir(), 'Downloads', 'waitlist-' + new Date().toISOString().slice(0, 10) + '.csv');

  const { initializeApp, cert } = require('firebase-admin/app');
  const { getFirestore } = require('firebase-admin/firestore');
  const app = initializeApp({ credential: cert(key), projectId: key.project_id }, 'waitlist-export');
  let snap;
  try {
    snap = await getFirestore(app).collection('waitlist').get();
  } catch (e) {
    fail('Could not read the waitlist from Firebase: ' + (e.message || e) +
      '\n(Check that the key belongs to the "geniusnotes-ai" project and that you are online.)');
  }
  const rows = snap.docs.map(d => d.data());
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, toCsv(rows), 'utf8');
  console.log(`Saved ${rows.length} email${rows.length === 1 ? '' : 's'} to:\n  ${out}`);
}

module.exports = { toCsv, csvCell };
if (require.main === module) main().catch(e => fail('Export failed: ' + (e && e.message || e)));
