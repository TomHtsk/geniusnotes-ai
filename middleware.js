// "Coming soon" site lock (Vercel Routing Middleware — runs on Vercel's servers before any
// page is sent, so a locked page's HTML never reaches the browser).
//   SITE_LOCKED = "true"        -> lock on. Anything else (or unset) -> the site works normally.
//   SITE_ACCESS_PASSWORD        -> the access code (only ever read on the server).
// While locked, a visitor without a valid unlock cookie gets coming-soon.html at the address
// they asked for; entering the code (api/_lib/site-lock.js) sets the cookie and reloads that
// address. Always public: /api/* (they keep their own login checks), images, CSS, fonts, the
// favicon, /privacy, /terms. While locked every reply says "noindex" and robots.txt blocks all.

export const config = { matcher: '/((?!api/).*)' };

const NOINDEX = 'noindex, nofollow';
const COOKIE_NAME = 'nc_access';
const PUBLIC_PATHS = new Set(['/privacy', '/privacy.html', '/terms', '/terms.html', '/coming-soon.html', '/favicon.ico']);
const PUBLIC_FILES = /\.(png|jpe?g|gif|svg|webp|avif|ico|bmp|css|woff2?|ttf|otf|eot)$/i;

// Same as Vercel's next() / rewrite() helpers, without adding a dependency.
function pass() {
  return new Response(null, { headers: { 'x-middleware-next': '1', 'X-Robots-Tag': NOINDEX } });
}
function showComingSoon(request) {
  return new Response(null, { headers: {
    'x-middleware-rewrite': new URL('/coming-soon.html', request.url).toString(),
    'X-Robots-Tag': NOINDEX,
    'Cache-Control': 'no-store',
  } });
}

function _readCookie(request, name) {
  const all = request.headers.get('cookie') || '';
  for (const part of all.split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

// Cookie = "<expiry ms>.<hex HMAC-SHA256(password, 'nc-access:' + expiry)>" (made by site-lock.js).
async function _hasAccess(request, password) {
  if (!password) return false;
  const value = _readCookie(request, COOKIE_NAME);
  const m = /^(\d{10,16})\.([0-9a-f]{64})$/.exec(value);
  if (!m || Number(m[1]) < Date.now()) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(password), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`nc-access:${m[1]}`)));
  let hex = '';
  for (const b of sig) hex += b.toString(16).padStart(2, '0');
  let diff = 0;
  for (let i = 0; i < 64; i++) diff |= hex.charCodeAt(i) ^ m[2].charCodeAt(i);
  return diff === 0;
}

export default async function middleware(request) {
  if (process.env.SITE_LOCKED !== 'true') return; // lock off: nothing changes

  const path = new URL(request.url).pathname;
  if (path === '/robots.txt') {
    return new Response('User-agent: *\nDisallow: /\n', { headers: {
      'Content-Type': 'text/plain; charset=utf-8', 'X-Robots-Tag': NOINDEX, 'Cache-Control': 'no-store',
    } });
  }
  if (path.startsWith('/api/') || PUBLIC_PATHS.has(path) || PUBLIC_FILES.test(path)) return pass();

  let ok = false;
  try { ok = await _hasAccess(request, process.env.SITE_ACCESS_PASSWORD); } catch (e) { ok = false; }
  if (ok) return pass();

  // Locked. Pages get the coming-soon page; anything else (scripts, data files) is refused.
  const last = path.split('/').pop();
  if (last.includes('.') && !/\.html?$/i.test(last)) {
    return new Response('This site is not open yet.', { status: 401, headers: {
      'Content-Type': 'text/plain; charset=utf-8', 'X-Robots-Tag': NOINDEX, 'Cache-Control': 'no-store',
    } });
  }
  return showComingSoon(request);
}
