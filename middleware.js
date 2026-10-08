// "Coming soon" site lock (Vercel Routing Middleware — runs on Vercel's servers before any
// page is sent, so a locked page's HTML never reaches the browser).
//   SITE_LOCKED = "true"        -> lock on. Anything else (or unset) -> the site works normally.
//   SITE_ACCESS_PASSWORD        -> the access code (only ever read on the server).
// While locked, a visitor without a valid unlock cookie gets coming-soon.html at the address
// they asked for; entering the code (api/_lib/site-lock.js) sets the cookie and reloads that
// address. Always public: /api/* (they keep their own login checks), images, CSS, fonts, the
// favicon, /privacy, /terms. While locked every reply says "noindex" and robots.txt blocks all.
//
// The unlock is a SESSION cookie (gone when the browser closes) holding the time of the last
// request, signed: "<last request ms>.<HMAC-SHA256(code, 'nc-access:' + time)>". It is valid
// for IDLE_MS after that time, and every request while unlocked re-signs it with the current
// time, so 15 minutes without any page load or request locks the site again. A second,
// readable session cookie (nc_unlocked=1, no secret in it) only tells js/site-lock-ui.js to
// show the "Lock site" button. GET /lock-site clears both and goes back to the waitlist page.

export const config = { matcher: '/:path*' };

const NOINDEX = 'noindex, nofollow';
const COOKIE_NAME = 'nc_access';
const UI_COOKIE = 'nc_unlocked';
const IDLE_MS = 15 * 60 * 1000;
const PUBLIC_PATHS = new Set(['/privacy', '/privacy.html', '/terms', '/terms.html', '/coming-soon.html', '/favicon.ico']);
const PUBLIC_FILES = /\.(png|jpe?g|gif|svg|webp|avif|ico|bmp|css|woff2?|ttf|otf|eot)$/i;
const COOKIE_FLAGS = 'Path=/; Secure; SameSite=Strict';   // no Max-Age/Expires: session cookies
const CLEAR = [
  `${COOKIE_NAME}=; Max-Age=0; ${COOKIE_FLAGS}; HttpOnly`,
  `${UI_COOKIE}=; Max-Age=0; ${COOKIE_FLAGS}`,
];

// Same as Vercel's next() / rewrite() helpers, without adding a dependency.
function pass(setCookies) {
  const h = new Headers({ 'x-middleware-next': '1', 'X-Robots-Tag': NOINDEX });
  for (const c of setCookies || []) h.append('Set-Cookie', c);
  return new Response(null, { headers: h });
}
function showComingSoon(request, setCookies) {
  const h = new Headers({
    'x-middleware-rewrite': new URL('/coming-soon.html', request.url).toString(),
    'X-Robots-Tag': NOINDEX,
    'Cache-Control': 'no-store',
  });
  for (const c of setCookies || []) h.append('Set-Cookie', c);
  return new Response(null, { headers: h });
}

function _readCookie(request, name) {
  const all = request.headers.get('cookie') || '';
  for (const part of all.split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

async function _sign(password, time) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(password), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`nc-access:${time}`)));
  let hex = '';
  for (const b of sig) hex += b.toString(16).padStart(2, '0');
  return hex;
}

// 'none' (no cookie), 'bad' (forged / idle too long / from the future), or 'ok'.
async function _checkAccess(request, password, now) {
  const value = _readCookie(request, COOKIE_NAME);
  if (!value) return 'none';
  if (!password) return 'bad';
  const m = /^(\d{10,16})\.([0-9a-f]{64})$/.exec(value);
  if (!m) return 'bad';
  const last = Number(m[1]);
  if (now - last > IDLE_MS || last > now + 60 * 1000) return 'bad';
  const hex = await _sign(password, m[1]);
  let diff = 0;
  for (let i = 0; i < 64; i++) diff |= hex.charCodeAt(i) ^ m[2].charCodeAt(i);
  return diff === 0 ? 'ok' : 'bad';
}

async function _refreshed(password, now) {
  return [
    `${COOKIE_NAME}=${now}.${await _sign(password, String(now))}; ${COOKIE_FLAGS}; HttpOnly`,
    `${UI_COOKIE}=1; ${COOKIE_FLAGS}`,
  ];
}

export default async function middleware(request) {
  const path = new URL(request.url).pathname;
  if (process.env.SITE_LOCKED !== 'true') {
    // Lock off: nothing changes (old unlock cookies are just tidied away).
    if (_readCookie(request, UI_COOKIE) || _readCookie(request, COOKIE_NAME)) return pass(CLEAR);
    return;
  }

  if (path === '/lock-site') {
    const h = new Headers({ Location: '/', 'Cache-Control': 'no-store', 'X-Robots-Tag': NOINDEX });
    for (const c of CLEAR) h.append('Set-Cookie', c);
    return new Response(null, { status: 303, headers: h });
  }
  if (path === '/robots.txt') {
    return new Response('User-agent: *\nDisallow: /\n', { headers: {
      'Content-Type': 'text/plain; charset=utf-8', 'X-Robots-Tag': NOINDEX, 'Cache-Control': 'no-store',
    } });
  }

  const password = process.env.SITE_ACCESS_PASSWORD;
  const now = Date.now();
  let access = 'bad';
  try { access = await _checkAccess(request, password, now); } catch (e) { access = 'bad'; }
  // Any request while unlocked (pages, scripts, images, API calls) restarts the idle timer.
  const cookies = access === 'ok' ? await _refreshed(password, now) : access === 'bad' ? CLEAR : [];

  // API replies never clear the cookie: the access-code request itself arrives with the old,
  // expired cookie and sets the new one — clearing here would undo the unlock.
  if (path.startsWith('/api/')) return pass(access === 'ok' ? cookies : []);
  if (PUBLIC_PATHS.has(path) || PUBLIC_FILES.test(path)) return pass(cookies);
  if (access === 'ok') return pass(cookies);

  // Locked. Pages get the coming-soon page; anything else (scripts, data files) is refused.
  const last = path.split('/').pop();
  if (last.includes('.') && !/\.html?$/i.test(last)) {
    const h = new Headers({ 'Content-Type': 'text/plain; charset=utf-8', 'X-Robots-Tag': NOINDEX, 'Cache-Control': 'no-store' });
    for (const c of cookies) h.append('Set-Cookie', c);
    return new Response('This site is not open yet.', { status: 401, headers: h });
  }
  return showComingSoon(request, cookies);
}
