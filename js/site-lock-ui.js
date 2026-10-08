// Coming-soon lock: a small "Lock site" link, shown only while this browser is unlocked
// (middleware.js sets the readable nc_unlocked=1 session cookie next to the real, HttpOnly
// unlock cookie). /lock-site clears both and returns to the waitlist page. In the page footer
// when there is one (homepage), otherwise a faint pill at the bottom centre.
(function () {
  if (!/(?:^|;\s*)nc_unlocked=1(?:;|$)/.test(document.cookie)) return;
  function add() {
    if (document.getElementById('nc-lock-site')) return;
    var a = document.createElement('a');
    a.id = 'nc-lock-site';
    a.href = '/lock-site';
    a.textContent = 'Lock site';
    a.title = 'Lock the site again (shows the waitlist page)';
    var links = document.querySelector('footer .footer-links');
    if (links) { links.appendChild(a); return; }
    a.style.cssText = 'position:fixed;left:50%;bottom:6px;transform:translateX(-50%);z-index:2147483000;' +
      'font:500 11px/1 Inter,system-ui,-apple-system,sans-serif;padding:5px 10px;border-radius:999px;' +
      'background:rgba(19,26,33,0.9);color:#93A1AE;border:1px solid rgba(255,255,255,0.12);' +
      'text-decoration:none;opacity:0.55;transition:opacity .15s';
    a.addEventListener('mouseenter', function () { a.style.opacity = '1'; });
    a.addEventListener('mouseleave', function () { a.style.opacity = '0.55'; });
    document.body.appendChild(a);
  }
  if (document.body) add(); else document.addEventListener('DOMContentLoaded', add);
})();
