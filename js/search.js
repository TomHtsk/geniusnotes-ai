// Unified smart search bar — plain JS, no dependencies.
// Detects whether the user typed a YouTube link or a search topic, swaps the bar's
// icon/button accordingly, and routes submit to the existing goYtTranscribe() (unchanged,
// reused via the hidden #yt-url-input it already reads) or to window.GNWiki.search().
// Also owns the recent-searches chip row (localStorage, try/catch-guarded).
(function () {
  var YT_URL_RE = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/)|youtu\.be\/|m\.youtube\.com\/watch\?(?:.*&)?v=)([A-Za-z0-9_-]{6,})/i;
  var OEMBED_URL = 'https://www.youtube.com/oembed?format=json&url=';
  var RECENT_KEY = 'gn-recent-searches';
  var RECENT_MAX = 6;

  function qs(sel, root) { return (root || document).querySelector(sel); }

  function injectStyles() {
    if (qs('#search-widget-styles')) return;
    var style = document.createElement('style');
    style.id = 'search-widget-styles';
    style.textContent =
      // Colours come from the page's "logbook" variables (index.html), with light-theme fallbacks.
      '.smart-search-bar { position:relative; display:flex; align-items:center; gap:12px; background:var(--surface,#fff); border:1px solid var(--border,#DCE1E6); border-radius:14px; padding:9px 9px 9px 18px; margin:0 auto; max-width:720px; width:100%; box-shadow:0 1px 2px rgba(11,15,20,0.05), 0 8px 24px rgba(11,15,20,0.07); transition:border-color 0.15s, box-shadow 0.15s; }' +
      '.smart-search-bar:focus-within { border-color:var(--accent,#0F6E7A); box-shadow:0 0 0 2px var(--accent,#0F6E7A); }' +
      '.smart-search-icon { position:relative; width:34px; height:30px; flex-shrink:0; }' +
      '.smart-search-icon .fade-icon { position:absolute; top:0; left:0; transition:opacity 0.18s ease; opacity:0; }' +
      '.smart-search-icon .fade-icon.fade-in { opacity:1; }' +
      '.smart-divider { width:1px; height:26px; background:var(--border,#DCE1E6); flex-shrink:0; margin:0 2px; }' +
      '.smart-search-input { flex:1; background:none; border:none; outline:none; font-size:1.05rem; color:var(--text,#0B0F14); font-family:inherit; min-width:0; height:44px; }' +
      '.smart-search-input::placeholder { color:var(--muted,#55606B); }' +
      '.smart-search-btn { height:44px; background:var(--primary-bg,#0B0F14); border:none; color:var(--primary-text,#fff); font-size:0.92rem; font-weight:600; padding:0 22px; border-radius:10px; cursor:pointer; font-family:inherit; white-space:nowrap; transition:opacity 0.15s; }' +
      '.smart-search-btn:hover { opacity:0.88; }' +
      '.recent-searches-row { display:flex; flex-wrap:wrap; align-items:center; justify-content:center; gap:8px; max-width:720px; margin:18px auto 0; }' +
      '.recent-chip { display:inline-flex; align-items:center; background:var(--surface,#fff); border:1px solid var(--border,#DCE1E6); border-radius:20px; overflow:hidden; transition:border-color 0.15s; }' +
      '.recent-chip:hover { border-color:var(--accent,#0F6E7A); }' +
      '.recent-chip-main { display:inline-flex; align-items:center; gap:6px; background:none; border:none; color:var(--text,#0B0F14); font-size:0.78rem; font-family:inherit; padding:6px 4px 6px 12px; cursor:pointer; max-width:180px; }' +
      '.recent-chip-main .recent-chip-label { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }' +
      '.recent-chip-remove { background:none; border:none; color:var(--muted,#55606B); font-size:0.78rem; padding:6px 10px 6px 4px; cursor:pointer; }' +
      '.recent-chip-remove:hover { color:var(--text,#0B0F14); }' +
      '.recent-clear-link { background:none; border:none; color:var(--accent,#0F6E7A); font-size:0.78rem; font-weight:600; cursor:pointer; padding:6px 4px; font-family:inherit; }' +
      '.recent-clear-link:hover { text-decoration:underline; }' +
      '.recent-chip-icon { width:16px; height:12px; border-radius:3px; display:flex; align-items:center; justify-content:center; font-size:0.5rem; font-weight:900; flex-shrink:0; }' +
      '.recent-chip-icon.yt { background:#ff0000; color:#fff; }' +
      '.recent-chip-icon.wiki { background:#fff; color:#000; font-family:Georgia,serif; border:1px solid #DCE1E6; }' +
      '@media(max-width:520px) { .smart-search-bar { padding:8px 8px 8px 12px; gap:8px; } .smart-icon-static, .smart-divider { display:none; } .smart-search-btn { padding:0 14px; } .smart-search-input { font-size:1rem; } }';
    document.head.appendChild(style);
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function detectType(value) {
    return YT_URL_RE.test((value || '').trim()) ? 'youtube' : 'wiki';
  }

  // ── Recent searches (localStorage, defensive) ──────────────────────
  function loadRecents() {
    try {
      var raw = localStorage.getItem(RECENT_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  }

  function saveRecents(list) {
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch (e) {}
  }

  function sameEntry(a, b) {
    if (a.type !== b.type) return false;
    return a.type === 'youtube' ? a.url === b.url : a.query === b.query;
  }

  function addRecent(entry) {
    var list = loadRecents().filter(function (e) { return !sameEntry(e, entry); });
    list.unshift(entry);
    list = list.slice(0, RECENT_MAX);
    saveRecents(list);
    renderRecents();
  }

  function removeRecent(index) {
    var list = loadRecents();
    list.splice(index, 1);
    saveRecents(list);
    renderRecents();
  }

  function clearRecents() {
    saveRecents([]);
    renderRecents();
  }

  function updateRecentEntryTitle(url, title) {
    var list = loadRecents();
    var found = false;
    list.forEach(function (e) {
      if (e.type === 'youtube' && e.url === url) { e.title = title; found = true; }
    });
    if (found) { saveRecents(list); renderRecents(); }
  }

  function shortYtLabel(url) {
    var m = url.match(YT_URL_RE);
    return m ? ('youtu.be/' + m[1]) : url;
  }

  function renderRecents() {
    var row = qs('#recent-searches-row');
    if (!row) return;
    var list = loadRecents();
    if (!list.length) { row.hidden = true; row.innerHTML = ''; return; }
    row.hidden = false;
    row.innerHTML = list.map(function (entry, i) {
      var isYt = entry.type === 'youtube';
      var label = isYt ? (entry.title || shortYtLabel(entry.url)) : entry.title;
      var iconHtml = isYt
        ? '<span class="recent-chip-icon yt">▶</span>'
        : '<span class="recent-chip-icon wiki">W</span>';
      return (
        '<span class="recent-chip">' +
          '<button type="button" class="recent-chip-main" data-index="' + i + '">' +
            iconHtml +
            '<span class="recent-chip-label">' + escapeHtml(label) + '</span>' +
          '</button>' +
          '<button type="button" class="recent-chip-remove" data-remove-index="' + i + '" aria-label="Remove">✕</button>' +
        '</span>'
      );
    }).join('') + '<button type="button" class="recent-clear-link" id="recent-clear-btn">Clear</button>';

    Array.prototype.forEach.call(row.querySelectorAll('.recent-chip-main'), function (btn) {
      btn.addEventListener('click', function () {
        var i = parseInt(btn.getAttribute('data-index'), 10);
        runRecentEntry(list[i]);
      });
    });
    Array.prototype.forEach.call(row.querySelectorAll('.recent-chip-remove'), function (btn) {
      btn.addEventListener('click', function () {
        removeRecent(parseInt(btn.getAttribute('data-remove-index'), 10));
      });
    });
    var clearBtn = qs('#recent-clear-btn', row);
    if (clearBtn) clearBtn.addEventListener('click', clearRecents);
  }

  function runRecentEntry(entry) {
    var input = qs('#smart-search-input');
    var wikiResult = qs('#wiki-result');
    if (entry.type === 'youtube') {
      if (input) input.value = entry.url;
      setMode('youtube');
      var ytInput = qs('#yt-url-input');
      if (ytInput) ytInput.value = entry.url;
      if (typeof window.goYtTranscribe === 'function') window.goYtTranscribe();
    } else {
      if (input) input.value = entry.query;
      setMode('wiki');
      if (window.GNWiki && wikiResult) {
        window.GNWiki.search(entry.query, wikiResult);
        addRecent(entry);
      }
    }
  }

  // ── Icon / button mode swap ─────────────────────────────────────────
  var currentMode = 'wiki';

  function setMode(mode) {
    if (mode === currentMode) return;
    currentMode = mode;
    var wikiIcon = qs('#smart-icon-wiki');
    var ytIcon = qs('#smart-icon-yt');
    var btn = qs('#smart-search-btn');
    if (mode === 'youtube') {
      if (ytIcon) { ytIcon.style.display = ''; requestAnimationFrame(function () { ytIcon.classList.add('fade-in'); }); }
      if (wikiIcon) wikiIcon.classList.remove('fade-in');
      setTimeout(function () { if (wikiIcon) wikiIcon.style.display = 'none'; }, 180);
      if (btn) btn.textContent = 'Transcribe';
    } else {
      if (wikiIcon) { wikiIcon.style.display = ''; requestAnimationFrame(function () { wikiIcon.classList.add('fade-in'); }); }
      if (ytIcon) ytIcon.classList.remove('fade-in');
      setTimeout(function () { if (ytIcon) ytIcon.style.display = 'none'; }, 180);
      if (btn) btn.textContent = 'Search';
    }
  }

  function fetchYtTitleForChip(url) {
    fetch(OEMBED_URL + encodeURIComponent(url))
      .then(function (res) { if (!res.ok) throw new Error('oembed failed'); return res.json(); })
      .then(function (data) {
        if (data && data.title) updateRecentEntryTitle(url, data.title);
      })
      .catch(function () {});
  }

  function onSubmit(e) {
    e.preventDefault();
    var input = qs('#smart-search-input');
    var wikiResult = qs('#wiki-result');
    var value = (input && input.value || '').trim();
    if (!value) return;

    if (detectType(value) === 'youtube') {
      setMode('youtube');
      var ytInput = qs('#yt-url-input');
      if (ytInput) ytInput.value = value;
      if (typeof window.goYtTranscribe === 'function') window.goYtTranscribe();
      addRecent({ type: 'youtube', url: value, title: null, ts: Date.now() });
      fetchYtTitleForChip(value);
    } else {
      setMode('wiki');
      if (window.GNWiki && wikiResult) window.GNWiki.search(value, wikiResult);
      addRecent({ type: 'wiki', query: value, title: value, ts: Date.now() });
    }
  }

  function onInput() {
    var input = qs('#smart-search-input');
    if (!input) return;
    setMode(detectType(input.value));
  }

  function init() {
    injectStyles();

    var form = qs('#smart-search-form');
    var input = qs('#smart-search-input');
    var wikiResult = qs('#wiki-result');
    if (!form || !input) return;

    form.addEventListener('submit', onSubmit);
    input.addEventListener('input', onInput);

    renderRecents();

    if (window.GNWiki && typeof window.GNWiki.initSuggestions === 'function') {
      window.GNWiki.initSuggestions(input, form, wikiResult, function () {
        return detectType(input.value) === 'youtube';
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Expose for wiki.js's related-topic chips to add entries to the same recent list
  window.GNSearch = { addRecent: addRecent };
})();
