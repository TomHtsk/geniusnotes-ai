// Cost confirmation for paid AI work and transcription.
//
// The server never runs work costing CONFIRM_FROM (2) or more AI credits, or an upload's
// transcription time, until the person has seen the cost. It answers the first request with
//   409 { code: 'confirm_cost', error: '<This uses N AI credits. You have M left…>', confirm }
// Every page's _authFetch passes its reply through gnAfterFetch(): on that answer this shows
// the cost and, if the person continues, sends the SAME request again with the header
// X-Confirm-Cost: <confirm>. If they cancel, the caller gets a 499 reply saying nothing was
// charged. Any other reply passes through untouched. The server decides the cost; this
// file only shows it.
(function () {
  'use strict';
  if (window.gnAfterFetch) return;

  function injectStyles() {
    if (document.getElementById('gn-cost-styles')) return;
    var s = document.createElement('style');
    s.id = 'gn-cost-styles';
    s.textContent =
      '.gn-cost-ov{position:fixed;inset:0;z-index:1000001;background:rgba(11,15,20,0.6);display:flex;align-items:center;justify-content:center;padding:20px;font-family:Inter,system-ui,sans-serif}' +
      '.gn-cost-box{width:100%;max-width:380px;background:var(--surface,#131A21);color:var(--text,#E9EEF2);border:1px solid var(--border,rgba(255,255,255,0.11));border-radius:14px;padding:24px 22px;box-shadow:0 20px 60px rgba(11,15,20,0.35)}' +
      '.gn-cost-title{font-size:1.05rem;font-weight:700;margin-bottom:8px}' +
      '.gn-cost-msg{font-size:0.88rem;line-height:1.5;color:var(--muted,#9AA7B2);margin-bottom:18px}' +
      '.gn-cost-row{display:flex;gap:8px;justify-content:flex-end}' +
      '.gn-cost-row button{height:38px;padding:0 16px;border-radius:10px;font:600 0.86rem Inter,system-ui,sans-serif;cursor:pointer;border:1px solid var(--border,rgba(255,255,255,0.11));background:none;color:var(--text,#E9EEF2)}' +
      '.gn-cost-row .gn-cost-go{background:var(--accent,#5CC4D0);border-color:var(--accent,#5CC4D0);color:var(--on-accent,#0B0F14)}' +
      '.gn-cost-row button:focus-visible{outline:2px solid var(--accent,#5CC4D0);outline-offset:2px}';
    document.head.appendChild(s);
  }

  function ask(info) {
    return new Promise(function (resolve) {
      injectStyles();
      var ov = document.createElement('div');
      ov.className = 'gn-cost-ov';
      ov.setAttribute('role', 'dialog');
      ov.setAttribute('aria-modal', 'true');
      var box = document.createElement('div'); box.className = 'gn-cost-box';
      var t = document.createElement('div'); t.className = 'gn-cost-title';
      t.textContent = info.kind === 'seconds' ? 'Use transcription time?' : 'Use AI credits?';
      var m = document.createElement('div'); m.className = 'gn-cost-msg';
      m.textContent = info.error || 'This uses part of your allowance.';
      var row = document.createElement('div'); row.className = 'gn-cost-row';
      var no = document.createElement('button'); no.type = 'button'; no.textContent = 'Cancel';
      var go = document.createElement('button'); go.type = 'button'; go.className = 'gn-cost-go'; go.textContent = 'Continue';
      function done(v) { document.removeEventListener('keydown', onKey); ov.remove(); resolve(v); }
      function onKey(e) { if (e.key === 'Escape') done(false); }
      no.addEventListener('click', function () { done(false); });
      go.addEventListener('click', function () { done(true); });
      ov.addEventListener('click', function (e) { if (e.target === ov) done(false); });
      document.addEventListener('keydown', onKey);
      row.appendChild(no); row.appendChild(go);
      box.appendChild(t); box.appendChild(m); box.appendChild(row);
      ov.appendChild(box);
      document.body.appendChild(ov);
      go.focus();
    });
  }

  function cancelled() {
    var body = JSON.stringify({ code: 'cancelled', error: 'Cancelled. Nothing was charged.' });
    try { return new Response(body, { status: 499, headers: { 'Content-Type': 'application/json' } }); }
    catch (e) { return { ok: false, status: 499, json: function () { return Promise.resolve(JSON.parse(body)); }, text: function () { return Promise.resolve(body); }, clone: function () { return this; } }; }
  }

  // resp: the fetch reply; refetch(url, opts): the page's own _authFetch.
  window.gnAfterFetch = async function (resp, url, opts, refetch) {
    if (!resp || resp.status !== 409) return resp;
    var info = null;
    try { info = await resp.clone().json(); } catch (e) { return resp; }
    if (!info || info.code !== 'confirm_cost') return resp;
    if (opts && opts.headers && (opts.headers['X-Confirm-Cost'] !== undefined)) return resp; // already confirmed once
    if (!(await ask(info))) return cancelled();
    var next = Object.assign({}, opts || {});
    next.headers = Object.assign({}, (opts && opts.headers) || {}, { 'X-Confirm-Cost': String(info.confirm) });
    return refetch(url, next);
  };
})();
