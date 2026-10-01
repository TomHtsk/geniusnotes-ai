// Shared Stripe checkout/portal triggers + the generic "upgrade to Pro" modal shown
// when any /api/* call returns 402 limit_reached. Loaded by index.html (modular
// Firebase SDK) and pricing.html/dashboard.html (compat SDK) — see getFirebaseUser()
// for how this file works with either.
(function () {
  function getFirebaseUser() {
    if (window._fauth) return window._fauth.currentUser; // modular SDK (index.html)
    if (typeof firebase !== 'undefined' && firebase.auth) return firebase.auth().currentUser; // compat SDK
    return null;
  }

  // Attaches a FRESH (force-refreshed) ID token to same-origin /api/* calls. Checkout
  // and portal calls are rare, high-stakes actions, so it's worth an extra round-trip
  // to guarantee a current token rather than reuse window._authFetch's cached one
  // (getIdToken() without force-refresh can hand back a token the SDK still considers
  // valid but the server's clock-skew tolerance rejects — this is what "Unauthorized —
  // invalid or expired token" on an otherwise-working signed-in session usually means).
  async function _fetch(url, opts) {
    opts = opts || {};
    const user = getFirebaseUser();
    if (user) {
      const token = await user.getIdToken(true);
      opts.headers = Object.assign({}, opts.headers, { Authorization: 'Bearer ' + token });
    }
    return fetch(url, opts);
  }

  function _setBtnLoading(btnEl, label) {
    if (!btnEl) return null;
    const orig = { text: btnEl.textContent, disabled: btnEl.disabled };
    btnEl.textContent = label;
    btnEl.disabled = true;
    return orig;
  }
  function _restoreBtn(btnEl, orig) {
    if (!btnEl || !orig) return;
    btnEl.textContent = orig.text;
    btnEl.disabled = orig.disabled;
  }

  async function startProCheckout(plan, btnEl) {
    const user = getFirebaseUser();
    const realUser = user && !user.isAnonymous;
    if (!realUser) {
      if (window.gnRequireSignIn) {
        window.gnRequireSignIn('Sign in to upgrade to Pro', () => startProCheckout(plan, btnEl));
      }
      return;
    }
    const orig = _setBtnLoading(btnEl, 'Opening secure checkout…');
    try {
      const r = await _fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan }),
      });
      const d = await r.json();
      if (d.url) { window.location.href = d.url; return; }
      _restoreBtn(btnEl, orig);
      // TEMPORARY DIAGNOSTIC — remove once root-caused.
      try {
        const token = await getFirebaseUser().getIdToken(true);
        const dbgR = await fetch('/api/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token, 'x-gn-debug': '1' }, body: '{}' });
        const dbg = await dbgR.json();
        alert((d.error || 'Unable to start checkout.') + '\n\nDebug: ' + JSON.stringify(dbg));
      } catch (dbgErr) {
        alert((d.error || 'Unable to start checkout.') + '\n\n(debug call also failed: ' + dbgErr.message + ')');
      }
    } catch (e) {
      _restoreBtn(btnEl, orig);
      alert('Unable to start checkout. Please try again.');
    }
  }

  async function gnOpenManageSubscription(btnEl) {
    const orig = _setBtnLoading(btnEl, 'Opening…');
    try {
      const r = await _fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'portal' }),
      });
      const d = await r.json();
      if (d.url) { window.location.href = d.url; return; }
      _restoreBtn(btnEl, orig);
      alert(d.message || d.error || 'Unable to open billing portal.');
    } catch (e) {
      _restoreBtn(btnEl, orig);
      alert('Unable to open billing portal.');
    }
  }

  // ── Generic upgrade modal, shown on any 402 limit_reached response ──
  let _modalEl = null;
  function _buildModal() {
    if (_modalEl) return _modalEl;
    const overlay = document.createElement('div');
    overlay.id = 'gn-upgrade-modal';
    overlay.style.cssText = 'display:none;position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,0.75);align-items:center;justify-content:center;backdrop-filter:blur(6px);';
    overlay.innerHTML =
      '<div style="background:var(--surface,#15172a);border:1px solid rgba(139,92,246,0.4);border-radius:18px;padding:32px 28px;max-width:380px;width:90%;text-align:center;box-shadow:0 24px 64px rgba(0,0,0,0.5);">' +
        '<h2 id="gn-um-title" style="font-size:1.2rem;font-weight:800;color:var(--text,#f0f0ff);margin:0 0 8px;">Upgrade to Pro</h2>' +
        '<p id="gn-um-msg" style="color:var(--muted,#9999b3);font-size:0.86rem;margin:0 0 22px;line-height:1.5;"></p>' +
        '<div style="display:flex;gap:10px;">' +
          '<button id="gn-um-later" style="flex:1;padding:11px;background:none;border:1px solid rgba(255,255,255,0.15);border-radius:10px;color:var(--muted,#9999b3);font-weight:700;cursor:pointer;font-family:inherit;">Maybe later</button>' +
          '<button id="gn-um-go" style="flex:1;padding:11px;background:#7c3aed;border:none;border-radius:10px;color:#fff;font-weight:700;cursor:pointer;font-family:inherit;">Go Pro — $6.99/mo</button>' +
        '</div>' +
      '</div>';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.style.display = 'none'; });
    document.body.appendChild(overlay);
    overlay.querySelector('#gn-um-later').addEventListener('click', () => { overlay.style.display = 'none'; });
    overlay.querySelector('#gn-um-go').addEventListener('click', () => {
      overlay.style.display = 'none';
      const pricingSection = document.getElementById('pricing');
      if (pricingSection) {
        pricingSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else {
        window.location.href = 'pricing.html';
      }
    });
    _modalEl = overlay;
    return overlay;
  }

  function gnShowUpgradeModal(info) {
    info = info || {};
    const overlay = _buildModal();
    const msgEl = overlay.querySelector('#gn-um-msg');
    const plan = info.plan === 'pro' ? 'pro' : 'free';
    let kind = 'AI actions';
    if (info.kind === 'youtube' || (info.limit === 3 || info.limit === 50)) kind = 'YouTube conversions';
    else if (info.kind === 'record') kind = 'recording minutes';

    if (plan === 'pro') {
      msgEl.textContent = "You've hit the Pro fair-use limit for " + kind + " this month. It resets next month, or contact us if you need more.";
      overlay.querySelector('#gn-um-go').style.display = 'none';
    } else {
      const limit = info.limit != null ? info.limit : '';
      msgEl.textContent = "You've used your " + limit + " free " + kind + (kind === 'YouTube conversions' ? ' today' : ' this month') + ". Upgrade to Pro for unlimited.";
      overlay.querySelector('#gn-um-go').style.display = '';
    }
    overlay.style.display = 'flex';
  }

  window.startProCheckout = startProCheckout;
  window.gnOpenManageSubscription = gnOpenManageSubscription;
  window.gnShowUpgradeModal = gnShowUpgradeModal;
})();
