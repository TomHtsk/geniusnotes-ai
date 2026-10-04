// Shared sign-in gate: modal, full-page guard, and lock-icon handling for nav items
// that require a real (non-anonymous) Firebase account.
//
// Works with either Firebase SDK style used across the site:
//  - modular (index.html): window._fauth (auth instance) + window._fbModular (helper
//    functions, since `import` isn't usable from a classic script)
//  - compat (notepad.html, my-notes.html, flashcards.html, notebook.html,
//    dashboard.html): the global `firebase.auth()`
//
// Neither SDK is guaranteed ready when this file's top-level code runs (classic
// scripts execute before deferred `type="module"` scripts), so every exported
// function re-checks for the SDK at call time rather than caching it up front.
(function () {
  'use strict';

  // Master switch for the sign-in locks on Notepad / My Notes / Flashcards.
  //   false = guests can open and use those pages (their notes stay in this browser only)
  //   true  = those pages and their nav links require a signed-in account (🔒)
  // Items marked data-requires-auth="server" (Upload, Record Lecture) stay locked either
  // way: they call /api endpoints that reject requests without a real account.
  var LOCKS_ENABLED = false;
  window.GN_LOCKS_ENABLED = LOCKS_ENABLED;

  function hasModular() { return !!(window._fauth && window._fbModular); }
  // The compat SDK script can be loaded long before the page calls firebase.initializeApp()
  // (notepad.html initializes near the bottom of a very long page). Calling firebase.auth()
  // before that throws "No Firebase App '[DEFAULT]'", which used to leave the full-page
  // guard stuck on "Checking sign-in…" forever. Only treat compat as ready once an app exists.
  function hasCompat() {
    try {
      return typeof firebase !== 'undefined' && !!firebase.auth && !!firebase.apps && firebase.apps.length > 0;
    } catch (e) { return false; }
  }

  function currentUser() {
    if (hasModular()) return window._fauth.currentUser;
    if (hasCompat()) return firebase.auth().currentUser;
    return null;
  }

  function isRealUser(user) {
    return !!(user && !user.isAnonymous);
  }

  function onAuthChange(cb) {
    if (hasModular()) {
      // index.html's module script calls window._gnOnAuthChange(user) itself.
      var prev = window._gnOnAuthChange;
      window._gnOnAuthChange = function (user) {
        if (typeof prev === 'function') prev(user);
        cb(user);
      };
      // Fire once immediately with whatever we already know, in case auth already resolved.
      if (window._fauth.currentUser !== undefined) cb(window._fauth.currentUser);
    } else if (hasCompat()) {
      try {
        firebase.auth().onAuthStateChanged(cb);
      } catch (e) {
        setTimeout(function () { onAuthChange(cb); }, 150);
      }
    } else {
      // Neither SDK loaded yet — try again shortly (covers the brief window before a
      // deferred module script or a later classic script finishes initializing Firebase).
      setTimeout(function () { onAuthChange(cb); }, 150);
    }
  }

  // ── Sign-in modal ──────────────────────────────────────────────────────────
  var _modalEl = null;
  var _onSuccessCb = null;

  function _injectStyles() {
    if (document.getElementById('gn-auth-gate-styles')) return;
    var style = document.createElement('style');
    style.id = 'gn-auth-gate-styles';
    style.textContent =
      '.gn-ag-overlay { position:fixed; inset:0; z-index:1000000; background:rgba(11,15,20,0.6); backdrop-filter:blur(3px); display:flex; align-items:center; justify-content:center; padding:20px; }' +
      '.gn-ag-box { width:100%; max-width:380px; background:var(--surface,#131A21); border:1px solid var(--border,rgba(255,255,255,0.11)); border-radius:14px; padding:28px 24px; box-shadow:0 20px 60px rgba(11,15,20,0.35); font-family:Inter,system-ui,sans-serif; }' +
      '.gn-ag-title { color:var(--text,#E9EEF2); font-size:1.1rem; font-weight:700; margin-bottom:6px; text-align:center; }' +
      '.gn-ag-sub { color:var(--muted,#9AA7B2); font-size:0.82rem; text-align:center; margin-bottom:20px; }' +
      '.gn-ag-google { width:100%; display:flex; align-items:center; justify-content:center; gap:10px; padding:11px; background:#fff; color:#111; border:1px solid #DCE1E6; border-radius:10px; font-weight:700; font-size:0.86rem; cursor:pointer; font-family:inherit; margin-bottom:14px; }' +
      '.gn-ag-google:hover { opacity:0.9; }' +
      '.gn-ag-divider { display:flex; align-items:center; gap:10px; color:var(--muted,#9AA7B2); font-size:0.72rem; margin:14px 0; }' +
      '.gn-ag-divider::before, .gn-ag-divider::after { content:""; flex:1; height:1px; background:var(--border,rgba(255,255,255,0.11)); }' +
      '.gn-ag-input { width:100%; padding:10px 12px; background:var(--surface2,rgba(127,127,127,0.12)); border:1px solid var(--border,rgba(255,255,255,0.12)); border-radius:10px; color:var(--text,#E9EEF2); font-size:0.84rem; font-family:inherit; margin-bottom:10px; outline:none; }' +
      '.gn-ag-input:focus { border-color:var(--accent,var(--purple,#5CC4D0)); }' +
      '.gn-ag-submit { width:100%; padding:11px; background:var(--primary-bg,var(--purple,#5CC4D0)); color:var(--primary-text,#fff); border:none; border-radius:10px; font-weight:700; font-size:0.86rem; cursor:pointer; font-family:inherit; }' +
      '.gn-ag-submit:hover { opacity:0.9; }' +
      '.gn-ag-toggle { text-align:center; margin-top:12px; font-size:0.78rem; color:var(--muted,#9AA7B2); }' +
      '.gn-ag-toggle a { color:var(--accent,var(--purple2,#7FD4DD)); cursor:pointer; text-decoration:underline; }' +
      '.gn-ag-err { color:#E5484D; font-size:0.78rem; text-align:center; margin-top:10px; min-height:1em; }' +
      '.gn-ag-close { position:absolute; top:10px; right:14px; background:none; border:none; color:var(--muted,#9AA7B2); font-size:1.2rem; cursor:pointer; }' +
      '@media(max-width:420px){ .gn-ag-box{ padding:22px 18px; } }';
    document.head.appendChild(style);
  }

  function _closeModal() {
    if (_modalEl) { _modalEl.remove(); _modalEl = null; }
    _onSuccessCb = null;
  }

  // After a successful sign-in, if the user that was signed in WAS anonymous, Firebase
  // has already replaced it with the new real account (link succeeded) or — if the
  // credential already belonged to an existing account — thrown auth/credential-already-in-use,
  // in which case we fall back to a plain sign-in with that same credential.
  async function _finishWithCredential(priorUser, signInFn, linkFn) {
    if (priorUser && priorUser.isAnonymous && linkFn) {
      try {
        await linkFn(priorUser);
        return;
      } catch (e) {
        if (e && e.code === 'auth/credential-already-in-use') {
          await signInFn();
          return;
        }
        throw e;
      }
    }
    await signInFn();
  }

  async function _doGoogle(errEl) {
    errEl.textContent = '';
    try {
      const prior = currentUser();
      if (hasModular()) {
        const provider = new window._fbModular.GoogleAuthProvider();
        await _finishWithCredential(
          prior,
          () => window._fbModular.signInWithPopup(provider),
          (u) => window._fbModular.linkWithPopup(u, provider)
        );
      } else if (hasCompat()) {
        const provider = new firebase.auth.GoogleAuthProvider();
        await _finishWithCredential(
          prior,
          () => firebase.auth().signInWithPopup(provider),
          (u) => u.linkWithPopup(provider)
        );
      }
      _succeed();
    } catch (e) {
      errEl.textContent = (e && e.message) ? e.message.replace(/^Firebase:\s*/, '') : 'Sign-in failed. Please try again.';
    }
  }

  async function _doEmail(mode, email, pw, errEl) {
    errEl.textContent = '';
    if (!email || !pw) { errEl.textContent = 'Enter your email and password.'; return; }
    try {
      const prior = currentUser();
      if (mode === 'signup') {
        if (hasModular()) {
          await _finishWithCredential(
            prior,
            () => window._fbModular.createUserWithEmailAndPassword(email, pw),
            (u) => window._fbModular.linkWithCredential(u, window._fbModular.EmailAuthProvider.credential(email, pw))
          );
        } else if (hasCompat()) {
          await _finishWithCredential(
            prior,
            () => firebase.auth().createUserWithEmailAndPassword(email, pw),
            (u) => u.linkWithCredential(firebase.auth.EmailAuthProvider.credential(email, pw))
          );
        }
      } else {
        if (hasModular()) {
          await window._fbModular.signInWithEmailAndPassword(email, pw);
        } else if (hasCompat()) {
          await firebase.auth().signInWithEmailAndPassword(email, pw);
        }
      }
      _succeed();
    } catch (e) {
      errEl.textContent = (e && e.message) ? e.message.replace(/^Firebase:\s*/, '') : 'Sign-in failed. Please try again.';
    }
  }

  function _succeed() {
    var cb = _onSuccessCb;
    _closeModal();
    if (typeof cb === 'function') cb();
  }

  // Builds the modal DOM. `reason` is a short friendly line shown at the top.
  // `inline` (optional element) renders the box inside that container instead of as a
  // floating overlay — used by gnGuardPage() to embed it in the full-page lock screen.
  function _buildModalBox(reason, mode) {
    mode = mode || 'signin';
    var box = document.createElement('div');
    box.className = 'gn-ag-box';
    box.style.position = 'relative';
    box.innerHTML =
      '<div class="gn-ag-title">' + (reason || 'Sign in free to continue') + '</div>' +
      '<div class="gn-ag-sub">It only takes a few seconds.</div>' +
      '<button type="button" class="gn-ag-google">' +
        '<svg width="18" height="18" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.1 8 3l5.7-5.7C34.6 6.1 29.6 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.7-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.1 8 3l5.7-5.7C34.6 6.1 29.6 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.5 0 10.4-2.1 14.1-5.5l-6.5-5.5C29.6 34.8 26.9 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.6 5.1C9.6 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.3 4.3-4.2 5.7.001 0 .002 0 .003-.001l6.5 5.5C37.4 39.3 44 34 44 24c0-1.3-.1-2.7-.4-3.5z"/></svg>' +
        'Continue with Google' +
      '</button>' +
      '<div class="gn-ag-divider">or</div>' +
      '<input type="email" class="gn-ag-input gn-ag-email" placeholder="Email" autocomplete="email">' +
      '<input type="password" class="gn-ag-input gn-ag-pw" placeholder="Password" autocomplete="current-password">' +
      '<button type="button" class="gn-ag-submit gn-ag-submit-btn">' + (mode === 'signup' ? 'Create account' : 'Sign in') + '</button>' +
      '<div class="gn-ag-toggle">' +
        (mode === 'signup' ? 'Already have an account? <a class="gn-ag-switch">Sign in</a>' : "New here? <a class=\"gn-ag-switch\">Create a free account</a>") +
      '</div>' +
      '<div class="gn-ag-err"></div>';

    var errEl = box.querySelector('.gn-ag-err');
    box.querySelector('.gn-ag-google').addEventListener('click', function () { _doGoogle(errEl); });
    box.querySelector('.gn-ag-submit-btn').addEventListener('click', function () {
      var email = box.querySelector('.gn-ag-email').value.trim();
      var pw = box.querySelector('.gn-ag-pw').value;
      _doEmail(mode, email, pw, errEl);
    });
    box.querySelector('.gn-ag-switch').addEventListener('click', function () {
      var fresh = _buildModalBox(reason, mode === 'signup' ? 'signin' : 'signup');
      box.replaceWith(fresh);
    });
    return box;
  }

  // Opens a floating sign-in modal. `onSuccess` runs once sign-in completes.
  function gnRequireSignIn(reason, onSuccess) {
    _injectStyles();
    _closeModal();
    _onSuccessCb = onSuccess || null;
    _modalEl = document.createElement('div');
    _modalEl.className = 'gn-ag-overlay';
    var box = _buildModalBox(reason, 'signin');
    var closeBtn = document.createElement('button');
    closeBtn.className = 'gn-ag-close';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', _closeModal);
    box.style.position = 'relative';
    box.appendChild(closeBtn);
    _modalEl.appendChild(box);
    _modalEl.addEventListener('click', function (e) { if (e.target === _modalEl) _closeModal(); });
    document.body.appendChild(_modalEl);
  }
  window.gnRequireSignIn = gnRequireSignIn;

  // ── Full-page guard (direct URL access to a locked page) ────────────────────
  // Call once, as early as possible in <body>, on a page that should be fully
  // inaccessible while signed out. Shows a full-screen overlay immediately (no flash
  // of real content) and removes it once a real signed-in user is confirmed.
  function gnGuardPage() {
    if (!LOCKS_ENABLED) return;
    _injectStyles();
    var overlay = document.createElement('div');
    overlay.className = 'gn-ag-overlay';
    overlay.id = 'gn-page-guard';
    overlay.style.position = 'fixed';
    overlay.style.background = 'var(--bg, #0B0F14)';
    overlay.style.backdropFilter = 'none';
    overlay.innerHTML = '<div style="color:var(--muted,#9AA7B2);font-size:0.85rem;">Checking sign-in…</div>';
    document.documentElement.appendChild(overlay); // before <body> content paints
    var resolved = false;

    onAuthChange(function (user) {
      if (user === undefined) return; // SDK not ready yet, onAuthChange will retry
      if (isRealUser(user)) {
        resolved = true;
        overlay.remove();
      } else if (!resolved) {
        overlay.innerHTML = '';
        var box = _buildModalBox('Sign in free to continue', 'signin');
        overlay.appendChild(box);
        _onSuccessCb = function () { overlay.remove(); resolved = true; };
        // The box's own buttons call _doGoogle/_doEmail which call _succeed(), which
        // uses _onSuccessCb — fine as long as no other floating modal is open at the
        // same time (gnGuardPage and gnRequireSignIn are not used together in practice).
      }
    });
  }
  window.gnGuardPage = gnGuardPage;

  // ── Lock icons + click-intercept on nav items ────────────────────────────────
  // Any element with [data-requires-auth] gets a 🔒 appended to its label and its
  // click intercepted while signed out; both are removed once a real user is signed in.
  function gnApplyLocks() {
    var signedOut = !isRealUser(currentUser());
    var els = document.querySelectorAll('[data-requires-auth]');
    for (var i = 0; i < els.length; i++) {
      (function (el) {
        var locked = signedOut && (LOCKS_ENABLED || el.getAttribute('data-requires-auth') === 'server');
        if (locked) {
          if (!el.querySelector('.gn-lock-icon')) {
            var lock = document.createElement('span');
            lock.className = 'gn-lock-icon';
            lock.textContent = ' 🔒';
            lock.style.cssText = 'margin-left:4px;';
            el.appendChild(lock);
          }
          if (el._gnOrigOnClick === undefined) {
            el._gnOrigOnClick = el.onclick || null;
            el._gnOrigHref = el.getAttribute('href');
          }
          el.onclick = function (e) {
            e.preventDefault();
            e.stopPropagation();
            var reason = el.getAttribute('data-auth-reason') || 'Sign in free to continue';
            var href = el._gnOrigHref;
            var origFn = el._gnOrigOnClick;
            gnRequireSignIn(reason, function () {
              if (href) window.location.href = href;
              else if (origFn) origFn.call(el, e);
            });
            return false;
          };
        } else {
          var existingLock = el.querySelector('.gn-lock-icon');
          if (existingLock) existingLock.remove();
          if (el._gnOrigOnClick !== undefined) {
            el.onclick = el._gnOrigOnClick;
            delete el._gnOrigOnClick;
            delete el._gnOrigHref;
          }
        }
      })(els[i]);
    }
  }
  window.gnApplyLocks = gnApplyLocks;

  // ── "Limit reached" notice ───────────────────────────────────────────────────
  // Shown when an /api call answers { code: 'limit_reached', error: '<friendly text>' }.
  // The text comes from the server and already says when the limit resets.
  function gnShowLimitNotice(message) {
    _injectStyles();
    var overlay = document.createElement('div');
    overlay.className = 'gn-ag-overlay';
    var box = document.createElement('div');
    box.className = 'gn-ag-box';
    var title = document.createElement('div');
    title.className = 'gn-ag-title';
    title.textContent = 'Limit reached';
    var sub = document.createElement('div');
    sub.className = 'gn-ag-sub';
    sub.textContent = message || "You've reached the limit for now. Please try again later.";
    var ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'gn-ag-submit';
    ok.textContent = 'OK';
    ok.addEventListener('click', function () { overlay.remove(); });
    overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.remove(); });
    box.appendChild(title); box.appendChild(sub); box.appendChild(ok);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    ok.focus();
  }
  window.gnShowLimitNotice = gnShowLimitNotice;

  function _init() {
    onAuthChange(function () { gnApplyLocks(); });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    _init();
  }
})();

// ── "A new version is available" notice ─────────────────────────────────────────────
// A tab that was opened before a deploy keeps running the old page until it is reloaded.
// When the tab is looked at again (and at most every 5 minutes) the page asks the server
// for its own headers; if the page's fingerprint (ETag / Last-Modified) has changed since
// it was loaded, a small bar offers a Refresh. It never reloads by itself, so unsaved
// work is never lost.
(function () {
  if (!window.fetch || location.protocol === 'file:') return;
  var url = location.pathname || '/', first = null, lastCheck = 0, shown = false;
  function fingerprint() {
    return fetch(url, { method: 'HEAD', cache: 'no-store' }).then(function (r) {
      if (!r.ok) return null;
      return r.headers.get('etag') || r.headers.get('last-modified') || null;
    }).catch(function () { return null; });
  }
  function showBar() {
    if (shown || !document.body) return;
    shown = true;
    var bar = document.createElement('div');
    bar.setAttribute('role', 'status');
    bar.style.cssText = 'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:99999;display:flex;align-items:center;gap:12px;max-width:92vw;padding:10px 12px 10px 16px;border-radius:10px;background:#0B0F14;color:#E9EEF2;border:1px solid rgba(255,255,255,0.18);box-shadow:0 8px 28px rgba(0,0,0,0.4);font:500 0.84rem Inter,system-ui,sans-serif;';
    var txt = document.createElement('span');
    txt.textContent = 'NoteCaptain was updated.';
    var go = document.createElement('button');
    go.type = 'button'; go.textContent = 'Refresh';
    go.style.cssText = 'background:#5CC4D0;color:#0B0F14;border:none;border-radius:7px;padding:6px 12px;font:700 0.8rem Inter,system-ui,sans-serif;cursor:pointer;';
    go.addEventListener('click', function () { location.reload(); });
    var x = document.createElement('button');
    x.type = 'button'; x.textContent = '✕'; x.setAttribute('aria-label', 'Dismiss');
    x.style.cssText = 'background:none;border:none;color:#9AA7B2;cursor:pointer;font-size:0.9rem;padding:4px;';
    x.addEventListener('click', function () { bar.remove(); });
    bar.appendChild(txt); bar.appendChild(go); bar.appendChild(x);
    document.body.appendChild(bar);
  }
  function check() {
    if (shown || document.visibilityState !== 'visible') return;
    var now = Date.now();
    if (now - lastCheck < 5 * 60 * 1000) return;
    lastCheck = now;
    fingerprint().then(function (fp) {
      if (!fp) return;
      if (first === null) { first = fp; return; }
      if (fp !== first) showBar();
    });
  }
  fingerprint().then(function (fp) { first = fp; lastCheck = Date.now(); });
  document.addEventListener('visibilitychange', check);
  window.addEventListener('focus', check);
  setInterval(check, 5 * 60 * 1000);
})();
