// Wikipedia lookup widget — plain JS, no dependencies.
// Flow: opensearch (origin=*, limit=5) powers live suggestions as the user types;
// on Search, opensearch (limit=1) finds the best title, then the REST summary API
// renders title/image/extract/link + "Source: Wikipedia (CC BY-SA)" below the bar.
// "Read full article" opens a full-screen reader (see openReader) with a table of
// contents, reading progress, font-size control, and Send to Notepad.
// Called by js/search.js (the unified smart search bar) via window.GNWiki.
(function () {
  var OPENSEARCH_URL = 'https://en.wikipedia.org/w/api.php?action=opensearch&format=json&origin=*&search=';
  var SUMMARY_URL = 'https://en.wikipedia.org/api/rest_v1/page/summary/';
  var FULLTEXT_URL = 'https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&format=json&origin=*&titles=';
  var RELATED_URL = 'https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&origin=*&srlimit=6&srsearch=';
  var IMAGEINFO_URL = 'https://en.wikipedia.org/w/api.php?action=query&prop=imageinfo&iiprop=extmetadata&format=json&origin=*&titles=';
  var SUGGEST_LIMIT = 6;
  var SUGGEST_DEBOUNCE = 220;
  var WIKI_SKIP_SECTIONS = ['see also', 'references', 'external links', 'further reading', 'notes'];
  var FONT_SIZES = [16, 18, 20, 22, 24];
  var FONT_SIZE_KEY = 'gn-wiki-reader-fontsize';

  function qs(sel, root) { return (root || document).querySelector(sel); }

  function injectStyles() {
    if (qs('#wiki-widget-styles')) return;
    var style = document.createElement('style');
    style.id = 'wiki-widget-styles';
    style.textContent =
      '.wiki-suggest-list { position:absolute; top:calc(100% + 8px); left:0; right:0; z-index:9999; background:#15172a; border:1px solid rgba(255,255,255,0.14); border-radius:12px; overflow:hidden; box-shadow:0 14px 40px rgba(0,0,0,0.55); }' +
      '.wiki-suggest-list[hidden] { display:none; }' +
      '.wiki-suggest-item { padding:10px 14px; font-size:0.84rem; color:rgba(230,230,245,0.9); cursor:pointer; transition:background 0.12s; }' +
      '.wiki-suggest-item mark { background:none; color:#c4b5fd; font-weight:700; }' +
      '.wiki-suggest-item:hover, .wiki-suggest-item.active { background:rgba(139,92,246,0.3); color:#fff; }' +
      '.wiki-suggest-item + .wiki-suggest-item { border-top:1px solid rgba(255,255,255,0.08); }' +
      '@media(max-width:520px) { .wiki-suggest-item { padding:12px 14px; font-size:0.82rem; } }' +
      '.wiki-related { margin-top:8px; }' +
      '.wiki-related-label { font-size:0.7rem; font-weight:800; color:rgba(220,224,245,0.5); letter-spacing:0.05em; text-transform:uppercase; margin-bottom:8px; }' +
      '.wiki-related-chips { display:flex; flex-wrap:wrap; gap:8px; }' +
      '.wiki-related-chip { background:rgba(139,92,246,0.12); border:1px solid rgba(139,92,246,0.3); color:#c4b5fd; font-size:0.78rem; font-weight:600; padding:6px 13px; border-radius:20px; cursor:pointer; font-family:inherit; transition:background 0.15s; }' +
      '.wiki-related-chip:hover, .wiki-related-chip:focus-visible { background:rgba(139,92,246,0.22); }' +
      '.wiki-btn-purple { background:#7c3aed; border:none; color:#fff; font-size:0.78rem; font-weight:700; padding:5px 12px; border-radius:7px; cursor:pointer; font-family:inherit; transition:background 0.15s,opacity 0.15s; }' +
      '.wiki-btn-purple:hover:not(:disabled) { background:#6d28d9; }' +
      '.wiki-btn-purple:disabled { opacity:0.6; cursor:not-allowed; }' +
      '.wiki-send-error { font-size:0.76rem; color:#f87171; margin:-2px 0 10px; }' +
      '.wiki-send-error[hidden] { display:none; }' +
      /* ── Full-screen reader ───────────────────────────────────────── */
      ':root { --wr-bg:#0a0a14; --wr-surface:#15172a; --wr-border:rgba(255,255,255,0.1); --wr-text:#f0f0ff; --wr-muted:#9999b3; --wr-accent:#a78bfa; --wr-mark:rgba(167,139,250,0.18); }' +
      ':root.light { --wr-bg:#faf9f6; --wr-surface:#ffffff; --wr-border:rgba(0,0,0,0.1); --wr-text:#17172a; --wr-muted:#6a6a80; --wr-accent:#7c3aed; --wr-mark:rgba(124,58,237,0.12); }' +
      '.wiki-reader-overlay { position:fixed; inset:0; z-index:100000; background:var(--wr-bg); display:flex; flex-direction:column; opacity:0; transform:translateY(16px); transition:opacity 0.22s ease, transform 0.22s ease; }' +
      '.wiki-reader-overlay.wiki-reader-open { opacity:1; transform:translateY(0); }' +
      '.wiki-reader-top { flex-shrink:0; display:flex; align-items:center; gap:10px; padding:10px 16px; background:var(--wr-surface); border-bottom:1px solid var(--wr-border); position:relative; z-index:2; }' +
      '.wiki-reader-title { flex:1; min-width:0; font-size:0.92rem; font-weight:700; color:var(--wr-text); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }' +
      '.wiki-reader-progress { position:absolute; left:0; bottom:-1px; height:2px; background:var(--wr-accent); width:0%; transition:width 0.1s linear; }' +
      '.wiki-reader-fontbtn { background:none; border:1px solid var(--wr-border); color:var(--wr-text); width:28px; height:28px; border-radius:7px; font-size:0.78rem; font-weight:700; cursor:pointer; font-family:inherit; flex-shrink:0; }' +
      '.wiki-reader-fontbtn:hover { background:rgba(139,92,246,0.15); }' +
      '.wiki-reader-link { font-size:0.78rem; font-weight:700; color:var(--wr-accent); text-decoration:none; white-space:nowrap; flex-shrink:0; }' +
      '.wiki-reader-close { background:none; border:none; color:var(--wr-muted); font-size:1.3rem; cursor:pointer; line-height:1; padding:4px 6px; flex-shrink:0; }' +
      '.wiki-reader-close:hover { color:var(--wr-text); }' +
      '.wiki-reader-toc-toggle { display:none; background:none; border:1px solid var(--wr-border); color:var(--wr-text); font-size:0.78rem; font-weight:700; padding:5px 10px; border-radius:7px; cursor:pointer; font-family:inherit; flex-shrink:0; }' +
      '.wiki-reader-body { flex:1; display:flex; min-height:0; }' +
      '.wiki-reader-toc { width:220px; flex-shrink:0; overflow-y:auto; padding:20px 14px; border-right:1px solid var(--wr-border); }' +
      '.wiki-reader-toc-item { display:block; padding:6px 10px; border-radius:7px; font-size:0.8rem; color:var(--wr-muted); text-decoration:none; cursor:pointer; transition:background 0.12s,color 0.12s; }' +
      '.wiki-reader-toc-item:hover { background:rgba(139,92,246,0.1); color:var(--wr-text); }' +
      '.wiki-reader-toc-item.active { background:var(--wr-mark); color:var(--wr-accent); font-weight:700; }' +
      '.wiki-reader-toc-item.lvl-3 { padding-left:22px; font-size:0.76rem; }' +
      '.wiki-reader-toc-item.lvl-4 { padding-left:32px; font-size:0.74rem; }' +
      '.wiki-reader-toc-dropdown { display:none; position:absolute; top:calc(100% + 4px); left:16px; right:16px; max-height:60vh; overflow-y:auto; background:var(--wr-surface); border:1px solid var(--wr-border); border-radius:10px; box-shadow:0 14px 40px rgba(0,0,0,0.4); z-index:5; padding:6px; }' +
      '.wiki-reader-toc-dropdown.open { display:block; }' +
      '.wiki-reader-scroll { flex:1; overflow-y:auto; -webkit-overflow-scrolling:touch; }' +
      '.wiki-reader-article { max-width:720px; margin:0 auto; padding:36px 24px 100px; font-size:var(--wr-font, 18px); line-height:1.75; color:var(--wr-text); }' +
      '.wiki-reader-article img.wiki-reader-hero-img { width:100%; max-height:360px; object-fit:cover; border-radius:12px; margin-bottom:8px; }' +
      '.wiki-reader-img-credit { font-size:0.72rem; color:var(--wr-muted); margin-bottom:24px; }' +
      '.wiki-reader-article h2 { font-size:1.4em; font-weight:800; margin:1.1em 0 0.4em; color:var(--wr-text); }' +
      '.wiki-reader-article h3 { font-size:1.15em; font-weight:700; margin:0.9em 0 0.35em; color:var(--wr-text); }' +
      '.wiki-reader-article h4 { font-size:1.02em; font-weight:700; margin:0.8em 0 0.3em; color:var(--wr-muted); }' +
      '.wiki-reader-article p { margin:0 0 1em; }' +
      '.wiki-reader-article h2:first-child, .wiki-reader-article h3:first-child { margin-top:0; }' +
      '.wiki-reader-footer { margin-top:48px; padding-top:20px; border-top:1px solid var(--wr-border); font-size:0.78rem; color:var(--wr-muted); }' +
      '.wiki-reader-footer a { color:var(--wr-accent); }' +
      '.wiki-reader-skeleton { max-width:720px; margin:40px auto; padding:0 24px; }' +
      '.wiki-reader-skel-line { height:14px; border-radius:6px; background:linear-gradient(90deg, var(--wr-surface) 25%, rgba(139,92,246,0.15) 50%, var(--wr-surface) 75%); background-size:200% 100%; animation:wikiReaderShimmer 1.4s infinite; margin-bottom:12px; }' +
      '@keyframes wikiReaderShimmer { 0%{background-position:200% 0} 100%{background-position:-200% 0} }' +
      '.wiki-reader-error { max-width:480px; margin:60px auto; text-align:center; color:var(--wr-text); }' +
      '.wiki-reader-retry { margin-top:14px; background:var(--wr-accent); color:#fff; border:none; padding:9px 20px; border-radius:9px; font-weight:700; cursor:pointer; font-family:inherit; }' +
      '@media(max-width:760px) {' +
        '.wiki-reader-toc { display:none; }' +
        '.wiki-reader-toc-toggle { display:inline-block; }' +
        '.wiki-reader-title { display:none; }' +
      '}';
    document.head.appendChild(style);
  }

  function renderLoading(container) {
    container.innerHTML = '<div class="wiki-status">Searching Wikipedia…</div>';
  }

  function renderError(container, message) {
    container.innerHTML = '<div class="wiki-status wiki-error">' + escapeHtml(message) + '</div>';
  }

  function renderResult(container, data) {
    var imageHtml = data.thumbnail
      ? '<img class="wiki-thumb" src="' + escapeAttr(data.thumbnail.source) + '" alt="' + escapeAttr(data.title) + '">'
      : '';
    var pageUrl = (data.content_urls && data.content_urls.desktop && data.content_urls.desktop.page) || ('https://en.wikipedia.org/wiki/' + encodeURIComponent(data.title));
    container.innerHTML =
      '<div class="wiki-card">' +
        '<button type="button" class="wiki-close" id="wiki-close" aria-label="Close">✕</button>' +
        imageHtml +
        '<div class="wiki-body">' +
          '<h3 class="wiki-title">' + escapeHtml(data.title) + '</h3>' +
          '<p class="wiki-summary">' + escapeHtml(data.extract || '') + '</p>' +
          '<div class="wiki-actions-row">' +
            '<a class="wiki-link" href="' + escapeAttr(pageUrl) + '" target="_blank" rel="noopener noreferrer">Read more on Wikipedia →</a>' +
            '<button type="button" class="wiki-full-toggle" id="wiki-full-toggle">Read full article</button>' +
            '<button type="button" class="wiki-btn-purple" id="wiki-send-notepad">📝 Send to Notepad</button>' +
          '</div>' +
          '<div class="wiki-send-error" id="wiki-send-error" hidden></div>' +
          '<div class="wiki-attribution">Source: Wikipedia (CC BY-SA)</div>' +
          '<div class="wiki-related" id="wiki-related" hidden></div>' +
        '</div>' +
      '</div>';

    var readBtn = qs('#wiki-full-toggle');
    if (readBtn) {
      readBtn.addEventListener('click', function () {
        openReader(data.title, pageUrl, data.thumbnail ? data.thumbnail.source : null, readBtn);
      });
    }
    wireSendToNotepad(data.title, pageUrl);

    var closeBtn = qs('#wiki-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', function () {
        container.innerHTML = '';
        var input = qs('#smart-search-input') || qs('#wiki-search-input');
        if (input) input.value = '';
      });
    }

    fetchRelated(data.title)
      .then(function (titles) { renderRelated(container, titles); })
      .catch(function () {
        var box = container.querySelector('#wiki-related');
        if (box) box.hidden = true;
      });
  }

  function fetchRelated(title) {
    return fetchJson(RELATED_URL + encodeURIComponent('morelike:' + title))
      .then(function (data) {
        var hits = (data.query && data.query.search) || [];
        return hits.map(function (h) { return h.title; });
      });
  }

  function renderRelated(container, titles) {
    var box = container.querySelector('#wiki-related');
    if (!box) return;
    if (!titles.length) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    box.innerHTML = '<div class="wiki-related-label">Related topics</div>' +
      '<div class="wiki-related-chips">' +
      titles.map(function (t) {
        return '<button type="button" class="wiki-related-chip" data-title="' + escapeAttr(t) + '">' + escapeHtml(t) + '</button>';
      }).join('') +
      '</div>';

    Array.prototype.forEach.call(box.querySelectorAll('.wiki-related-chip'), function (btn) {
      btn.addEventListener('click', function () {
        var t = btn.getAttribute('data-title');
        searchWikipedia(t, container);
        if (window.GNSearch && window.GNSearch.addRecent) {
          window.GNSearch.addRecent({ type: 'wiki', query: t, title: t, ts: Date.now() });
        }
        setTimeout(function () {
          var card = container.querySelector('.wiki-card');
          if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 50);
      });
    });
  }

  // Fetches the full plain-text article body via the query API. Shared by the reader
  // and "Send to Notepad" so there's one place that knows how to parse the response —
  // resolves with the extract text (possibly empty) or rejects on network error.
  function fetchFullText(title) {
    return fetchJson(FULLTEXT_URL + encodeURIComponent(title)).then(function (data) {
      var pages = (data.query && data.query.pages) || {};
      var page = pages[Object.keys(pages)[0]];
      return (page && page.extract) || '';
    });
  }

  // Best-effort image credit lookup for the reader. Resolves to null (not a rejection)
  // on any failure or missing metadata — the image still shows, just without a credit line.
  function fetchImageCredit(thumbnailUrl) {
    if (!thumbnailUrl) return Promise.resolve(null);
    try {
      var path = decodeURIComponent(new URL(thumbnailUrl).pathname);
      var m = path.match(/\/([^\/]+\.(?:jpg|jpeg|png|gif|svg|webp))$/i);
      if (!m) return Promise.resolve(null);
      // Thumbnail filenames look like "/thumb/.../<width>px-<original>" and, for SVGs
      // rasterized to PNG, "<name>.svg.png" — strip both to get the real File: title
      // (confirmed against the live API: "330px-Foo.svg.png" must become "Foo.svg").
      var filename = m[1].replace(/^\d+px-/, '').replace(/\.svg\.png$/i, '.svg');
      var fileTitle = 'File:' + filename;
      return fetchJson(IMAGEINFO_URL + encodeURIComponent(fileTitle)).then(function (data) {
        var pages = (data.query && data.query.pages) || {};
        var page = pages[Object.keys(pages)[0]];
        var meta = page && page.imageinfo && page.imageinfo[0] && page.imageinfo[0].extmetadata;
        if (!meta) return null;
        var artist = meta.Artist ? _stripHtml(meta.Artist.value) : '';
        var license = meta.LicenseShortName ? meta.LicenseShortName.value : '';
        if (!artist && !license) return null;
        return { artist: artist, license: license, fileTitle: fileTitle };
      }).catch(function () { return null; });
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  function _stripHtml(html) {
    var el = document.createElement('div');
    el.innerHTML = html;
    return (el.textContent || '').trim();
  }

  // Shared by the card's "Send to Notepad" and the reader's — builds the note body,
  // saves the pending-import keys, and redirects. `text` must already be loaded.
  function _sendTextToNotepad(title, pageUrl, text, btn, errEl, onError) {
    var body = 'Source: Wikipedia — ' + pageUrl + ' (CC BY-SA)\n\n' + text;
    try {
      localStorage.setItem('gn-notepad-pending', body);
      localStorage.setItem('gn-notepad-pending-title', title + ' — Wikipedia');
      localStorage.setItem('gn-notepad-pending-source', 'wikipedia');
    } catch (e) {}
    window.location.href = 'notepad.html';
  }

  function wireSendToNotepad(title, pageUrl) {
    var btn = qs('#wiki-send-notepad');
    var errBox = qs('#wiki-send-error');
    if (!btn) return;

    btn.addEventListener('click', function () {
      errBox.hidden = true;
      errBox.textContent = '';
      btn.disabled = true;
      var originalLabel = btn.textContent;
      btn.textContent = 'Sending…';

      fetchFullText(title)
        .then(function (text) {
          _sendTextToNotepad(title, pageUrl, text);
        })
        .catch(function (err) {
          btn.disabled = false;
          btn.textContent = originalLabel;
          errBox.hidden = false;
          errBox.textContent = 'Could not send this article to Notepad: ' + err.message;
        });
    });
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function escapeAttr(str) {
    return escapeHtml(str);
  }

  function fetchJson(url) {
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error('Request failed (' + res.status + ')');
      return res.json();
    });
  }

  function searchWikipedia(query, container) {
    query = (query || '').trim();
    if (!query) return;
    renderLoading(container);

    var opensearchUrl = OPENSEARCH_URL + encodeURIComponent(query) + '&limit=1';

    fetchJson(opensearchUrl)
      .then(function (data) {
        // opensearch response shape: [query, [titles], [descriptions], [urls]]
        var titles = data[1] || [];
        if (!titles.length) {
          renderError(container, 'No Wikipedia article found for "' + query + '".');
          return null;
        }
        var bestTitle = titles[0];
        return fetchJson(SUMMARY_URL + encodeURIComponent(bestTitle));
      })
      .then(function (summary) {
        if (!summary) return;
        if (summary.type === 'disambiguation') {
          renderError(container, '"' + query + '" is ambiguous on Wikipedia — try a more specific term.');
          return;
        }
        renderResult(container, summary);
      })
      .catch(function (err) {
        renderError(container, 'Wikipedia lookup failed: ' + err.message);
      });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // FULL-SCREEN READER
  // ═══════════════════════════════════════════════════════════════════════

  var _articleCache = {}; // title -> { text, toc, html, imageCredit, related }
  var _readerState = null; // { overlay, triggerEl, text, title, pageUrl, pushedHistory }

  function _slugify(text, used) {
    var base = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'section';
    var slug = base, i = 2;
    while (used[slug]) { slug = base + '-' + (i++); }
    used[slug] = true;
    return slug;
  }

  // Parses a Wikipedia plain-text extract into a table of contents + article HTML.
  // Mirrors the same heading regex / skip-list / level-mapping notepad.html's
  // _formatWikipediaNoteContent uses, so behavior matches the Notepad import exactly.
  function _parseReaderArticle(text) {
    var headingRe = /^(={2,6})\s*(.+?)\s*\1\s*$/;
    var sections = [{ level: 0, title: null, bodyLines: [] }];
    text.split('\n').forEach(function (line) {
      var m = line.match(headingRe);
      if (m) {
        var eq = m[1].length;
        var level = eq <= 2 ? 2 : (eq === 3 ? 3 : 4);
        sections.push({ level: level, title: m[2].trim(), bodyLines: [] });
      } else {
        sections[sections.length - 1].bodyLines.push(line);
      }
    });

    var used = {};
    var toc = [];
    var html = '';
    sections.forEach(function (sec) {
      var paras = sec.bodyLines.map(function (l) { return l.trim(); }).filter(Boolean);
      if (!paras.length) return; // skip empty sections (and an empty lead section)
      if (sec.title && WIKI_SKIP_SECTIONS.indexOf(sec.title.toLowerCase()) !== -1) return;
      if (sec.title) {
        var id = _slugify(sec.title, used);
        toc.push({ level: sec.level, title: sec.title, id: id });
        html += '<h' + sec.level + ' id="' + id + '" class="wiki-reader-h">' + escapeHtml(sec.title) + '</h' + sec.level + '>';
      }
      html += paras.map(function (p) { return '<p>' + escapeHtml(p) + '</p>'; }).join('');
    });
    return { toc: toc, html: html };
  }

  function _buildReaderDom(title, pageUrl) {
    var overlay = document.createElement('div');
    overlay.className = 'wiki-reader-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', title);
    overlay.innerHTML =
      '<div class="wiki-reader-top">' +
        '<button type="button" class="wiki-reader-toc-toggle" id="wr-toc-toggle">Contents ▾</button>' +
        '<div class="wiki-reader-title">' + escapeHtml(title) + '</div>' +
        '<button type="button" class="wiki-reader-fontbtn" id="wr-font-minus" aria-label="Decrease font size">A−</button>' +
        '<button type="button" class="wiki-reader-fontbtn" id="wr-font-plus" aria-label="Increase font size">A+</button>' +
        '<button type="button" class="wiki-btn-purple" id="wr-send-notepad">📝 Send to Notepad</button>' +
        '<a class="wiki-reader-link" href="' + escapeAttr(pageUrl) + '" target="_blank" rel="noopener noreferrer">Open on Wikipedia ↗</a>' +
        '<button type="button" class="wiki-reader-close" id="wr-close" aria-label="Close reader">✕</button>' +
        '<div class="wiki-reader-progress" id="wr-progress"></div>' +
        '<div class="wiki-reader-toc-dropdown" id="wr-toc-dropdown"></div>' +
      '</div>' +
      '<div class="wiki-reader-body">' +
        '<nav class="wiki-reader-toc" id="wr-toc" aria-label="Table of contents"></nav>' +
        '<div class="wiki-reader-scroll" id="wr-scroll" tabindex="-1">' +
          '<div class="wiki-reader-skeleton" id="wr-skeleton">' +
            '<div class="wiki-reader-skel-line" style="width:70%;height:24px;"></div>' +
            '<div class="wiki-reader-skel-line" style="width:100%;"></div>' +
            '<div class="wiki-reader-skel-line" style="width:95%;"></div>' +
            '<div class="wiki-reader-skel-line" style="width:88%;"></div>' +
            '<div class="wiki-reader-skel-line" style="width:92%;"></div>' +
          '</div>' +
        '</div>' +
      '</div>';
    return overlay;
  }

  function _applyFontSize(overlay, size) {
    var article = overlay.querySelector('.wiki-reader-article');
    (article || overlay).style.setProperty('--wr-font', size + 'px');
  }

  function _wireFontButtons(overlay) {
    var saved = 18;
    try {
      var stored = parseInt(localStorage.getItem(FONT_SIZE_KEY), 10);
      if (FONT_SIZES.indexOf(stored) !== -1) saved = stored;
    } catch (e) {}
    var idx = FONT_SIZES.indexOf(saved);
    if (idx === -1) idx = 1;
    overlay.style.setProperty('--wr-font', FONT_SIZES[idx] + 'px');

    function setIdx(newIdx) {
      idx = Math.max(0, Math.min(FONT_SIZES.length - 1, newIdx));
      overlay.style.setProperty('--wr-font', FONT_SIZES[idx] + 'px');
      try { localStorage.setItem(FONT_SIZE_KEY, String(FONT_SIZES[idx])); } catch (e) {}
    }
    var minus = qs('#wr-font-minus', overlay);
    var plus = qs('#wr-font-plus', overlay);
    if (minus) minus.addEventListener('click', function () { setIdx(idx - 1); });
    if (plus) plus.addEventListener('click', function () { setIdx(idx + 1); });
  }

  function _renderReaderArticle(overlay, parsed, title, pageUrl, imageUrl, imageCredit, relatedTitles) {
    var skeleton = qs('#wr-skeleton', overlay);
    var scrollEl = qs('#wr-scroll', overlay);
    if (!scrollEl) return;

    var imgHtml = '';
    if (imageUrl) {
      imgHtml = '<img class="wiki-reader-hero-img" src="' + escapeAttr(imageUrl) + '" alt="' + escapeAttr(title) + '">';
      if (imageCredit && (imageCredit.artist || imageCredit.license)) {
        imgHtml += '<div class="wiki-reader-img-credit">Image: ' +
          escapeHtml(imageCredit.artist || 'Wikimedia Commons') +
          (imageCredit.license ? ' / ' + escapeHtml(imageCredit.license) : '') +
          '</div>';
      }
    }

    var relatedHtml = '';
    if (relatedTitles && relatedTitles.length) {
      relatedHtml = '<div class="wiki-related-label">Related topics</div><div class="wiki-related-chips">' +
        relatedTitles.map(function (t) {
          return '<button type="button" class="wiki-related-chip" data-title="' + escapeAttr(t) + '">' + escapeHtml(t) + '</button>';
        }).join('') + '</div>';
    }

    var article = document.createElement('div');
    article.className = 'wiki-reader-article';
    article.innerHTML =
      imgHtml +
      parsed.html +
      '<div class="wiki-reader-footer">' +
        '<div>Text from Wikipedia article &#39;' + escapeHtml(title) + '&#39; (<a href="' + escapeAttr(pageUrl) + '" target="_blank" rel="noopener noreferrer">link</a>), licensed under ' +
        '<a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noopener noreferrer">CC BY-SA 4.0</a>.</div>' +
        '<div style="margin-top:16px;">' + relatedHtml + '</div>' +
      '</div>';

    if (skeleton) skeleton.remove();
    scrollEl.innerHTML = '';
    scrollEl.appendChild(article);

    // Related-topic chips: close the reader, then re-search in the main card.
    Array.prototype.forEach.call(article.querySelectorAll('.wiki-related-chip'), function (btn) {
      btn.addEventListener('click', function () {
        var t = btn.getAttribute('data-title');
        var cardContainer = qs('#wiki-result');
        closeReader();
        if (cardContainer) searchWikipedia(t, cardContainer);
        if (window.GNSearch && window.GNSearch.addRecent) {
          window.GNSearch.addRecent({ type: 'wiki', query: t, title: t, ts: Date.now() });
        }
      });
    });

    _buildToc(overlay, parsed.toc, scrollEl);
    _wireReaderScroll(overlay, scrollEl, parsed.toc);
  }

  function _buildToc(overlay, toc, scrollEl) {
    var tocNav = qs('#wr-toc', overlay);
    var dropdown = qs('#wr-toc-dropdown', overlay);
    var toggle = qs('#wr-toc-toggle', overlay);
    if (!toc.length) {
      if (tocNav) tocNav.style.display = 'none';
      if (toggle) toggle.style.display = 'none';
      return;
    }
    var itemsHtml = toc.map(function (t) {
      return '<a class="wiki-reader-toc-item lvl-' + t.level + '" data-target="' + t.id + '">' + escapeHtml(t.title) + '</a>';
    }).join('');
    if (tocNav) tocNav.innerHTML = itemsHtml;
    if (dropdown) dropdown.innerHTML = itemsHtml;

    function goTo(id) {
      var target = scrollEl.querySelector('#' + CSS.escape(id));
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (dropdown) dropdown.classList.remove('open');
    }
    [tocNav, dropdown].forEach(function (root) {
      if (!root) return;
      Array.prototype.forEach.call(root.querySelectorAll('.wiki-reader-toc-item'), function (a) {
        a.addEventListener('click', function () { goTo(a.getAttribute('data-target')); });
      });
    });
    if (toggle) {
      toggle.addEventListener('click', function () {
        dropdown.classList.toggle('open');
      });
    }
  }

  function _wireReaderScroll(overlay, scrollEl, toc) {
    var progress = qs('#wr-progress', overlay);
    var ticking = false;
    function updateProgress() {
      ticking = false;
      var max = scrollEl.scrollHeight - scrollEl.clientHeight;
      var pct = max > 0 ? Math.min(100, (scrollEl.scrollTop / max) * 100) : 0;
      if (progress) progress.style.width = pct + '%';
    }
    scrollEl.addEventListener('scroll', function () {
      if (!ticking) { ticking = true; requestAnimationFrame(updateProgress); }
    });
    updateProgress();

    if (toc.length && 'IntersectionObserver' in window) {
      var headingEls = toc.map(function (t) { return scrollEl.querySelector('#' + CSS.escape(t.id)); }).filter(Boolean);
      var observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          var id = entry.target.id;
          [qs('#wr-toc', overlay), qs('#wr-toc-dropdown', overlay)].forEach(function (root) {
            if (!root) return;
            Array.prototype.forEach.call(root.querySelectorAll('.wiki-reader-toc-item'), function (a) {
              a.classList.toggle('active', a.getAttribute('data-target') === id);
            });
          });
        });
      }, { root: scrollEl, rootMargin: '0px 0px -70% 0px', threshold: 0 });
      headingEls.forEach(function (el) { observer.observe(el); });
      _readerState && (_readerState.observer = observer);
    }
  }

  function _showReaderError(overlay, message, retryFn) {
    var skeleton = qs('#wr-skeleton', overlay);
    var scrollEl = qs('#wr-scroll', overlay);
    if (skeleton) skeleton.remove();
    if (!scrollEl) return;
    scrollEl.innerHTML = '<div class="wiki-reader-error">' +
      '<div>' + escapeHtml(message) + '</div>' +
      '<button type="button" class="wiki-reader-retry" id="wr-retry">Retry</button>' +
      '</div>';
    var retry = qs('#wr-retry', scrollEl);
    if (retry) retry.addEventListener('click', retryFn);
  }

  var _focusTrapHandler = null;

  function _wireFocusTrap(overlay) {
    _focusTrapHandler = function (e) {
      if (e.key === 'Escape') { e.preventDefault(); closeReader(); return; }
      if (e.key !== 'Tab') return;
      var focusable = overlay.querySelectorAll('button, a[href], [tabindex]:not([tabindex="-1"])');
      if (!focusable.length) return;
      var first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    overlay.addEventListener('keydown', _focusTrapHandler);
  }

  function _onPopState() {
    if (_readerState) closeReader(true);
  }

  function openReader(title, pageUrl, imageUrl, triggerEl) {
    injectStyles();
    if (_readerState) closeReader(true);

    var overlay = _buildReaderDom(title, pageUrl);
    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(function () { overlay.classList.add('wiki-reader-open'); });

    _readerState = { overlay: overlay, triggerEl: triggerEl || null, title: title, pushedHistory: true };
    history.pushState({ gnWikiReader: true }, '');
    window.addEventListener('popstate', _onPopState);

    _wireFontButtons(overlay);
    var closeBtn = qs('#wr-close', overlay);
    if (closeBtn) closeBtn.addEventListener('click', function () { closeReader(); });
    _wireFocusTrap(overlay);
    (closeBtn || overlay).focus();

    var sendBtn = qs('#wr-send-notepad', overlay);

    function load() {
      var cached = _articleCache[title];
      var textPromise = cached ? Promise.resolve(cached.text) : fetchFullText(title);
      var creditPromise = cached ? Promise.resolve(cached.imageCredit) : fetchImageCredit(imageUrl);
      var relatedPromise = cached ? Promise.resolve(cached.related) : fetchRelated(title).catch(function () { return []; });

      textPromise.then(function (text) {
        return Promise.all([Promise.resolve(text), creditPromise, relatedPromise]);
      }).then(function (results) {
        var text = results[0], credit = results[1], related = results[2];
        if (!_readerState || _readerState.overlay !== overlay) return; // closed/reopened meanwhile
        var parsed = _parseReaderArticle(text || '');
        _articleCache[title] = { text: text, toc: parsed.toc, html: parsed.html, imageCredit: credit, related: related };
        _readerState.text = text;
        _renderReaderArticle(overlay, parsed, title, pageUrl, imageUrl, credit, related);
        if (sendBtn) {
          sendBtn.addEventListener('click', function () {
            sendBtn.disabled = true;
            var orig = sendBtn.textContent;
            sendBtn.textContent = 'Sending…';
            _sendTextToNotepad(title, pageUrl, text);
            setTimeout(function () { sendBtn.disabled = false; sendBtn.textContent = orig; }, 1500);
          });
        }
      }).catch(function (err) {
        if (!_readerState || _readerState.overlay !== overlay) return;
        _showReaderError(overlay, 'Could not load this article: ' + err.message, load);
      });
    }
    load();
  }

  function closeReader(fromPopState) {
    if (!_readerState) return;
    var state = _readerState;
    _readerState = null;
    window.removeEventListener('popstate', _onPopState);
    if (state.observer) state.observer.disconnect();

    state.overlay.classList.remove('wiki-reader-open');
    setTimeout(function () {
      if (state.overlay.parentNode) state.overlay.parentNode.removeChild(state.overlay);
    }, 240);
    document.body.style.overflow = '';

    if (!fromPopState && state.pushedHistory) {
      history.back();
    }
    if (state.triggerEl && typeof state.triggerEl.focus === 'function') {
      state.triggerEl.focus();
    }
  }

  // ── Live suggestions ──────────────────────────────────────────────
  // shouldSuppress: optional fn() => bool — when true, suggestions are skipped
  // (used by js/search.js to hide the Wikipedia dropdown while a YouTube link is detected).
  // Returns a controller { close } so callers (search.js, related-topic chips) can
  // force the dropdown shut — e.g. right before running a search — so a late/in-flight
  // response can't pop it back open over the result card.
  function initSuggestions(input, form, container, shouldSuppress) {
    if (getComputedStyle(form).position === 'static') form.style.position = 'relative';

    var list = document.createElement('div');
    list.className = 'wiki-suggest-list';
    list.id = 'wiki-suggest-list';
    list.hidden = true;
    form.appendChild(list);

    var debounceTimer = null;
    var activeIndex = -1;
    var currentTitles = [];
    var reqGen = 0; // bumped on every close/submit so stale fetch responses are ignored
    var suppressedUntilInput = false; // true right after a search runs, until the user types again

    function cancelPending() {
      reqGen++; // any in-flight fetchSuggestions()/debounce from here on is stale
      clearTimeout(debounceTimer);
    }

    function closeList() {
      cancelPending();
      list.hidden = true;
      list.innerHTML = '';
      activeIndex = -1;
      currentTitles = [];
    }

    function highlight(text, query) {
      var idx = text.toLowerCase().indexOf(query.toLowerCase());
      if (idx === -1) return escapeHtml(text);
      return escapeHtml(text.slice(0, idx)) +
        '<mark>' + escapeHtml(text.slice(idx, idx + query.length)) + '</mark>' +
        escapeHtml(text.slice(idx + query.length));
    }

    function renderSuggestions(titles, query) {
      currentTitles = titles;
      activeIndex = -1;
      if (!titles.length) { closeList(); return; }
      list.innerHTML = titles.map(function (t, i) {
        return '<div class="wiki-suggest-item" data-index="' + i + '">' + highlight(t, query) + '</div>';
      }).join('');
      list.hidden = false;

      Array.prototype.forEach.call(list.children, function (el, i) {
        el.addEventListener('mousedown', function (e) {
          // mousedown (not click) so it fires before input's blur hides the list
          e.preventDefault();
          selectSuggestion(i);
        });
      });
    }

    function selectSuggestion(i) {
      var title = currentTitles[i];
      if (!title) return;
      input.value = title;
      closeList();
      suppressedUntilInput = true;
      searchWikipedia(title, container);
    }

    function fetchSuggestions(query) {
      var myGen = reqGen;
      var url = OPENSEARCH_URL + encodeURIComponent(query) + '&limit=' + SUGGEST_LIMIT;
      fetchJson(url)
        .then(function (data) {
          if (myGen !== reqGen) return; // superseded by a close/submit/newer keystroke
          if (suppressedUntilInput) return;
          if (input.value.trim() !== query) return;
          renderSuggestions(data[1] || [], query);
        })
        .catch(function () { if (myGen === reqGen) closeList(); });
    }

    input.addEventListener('input', function () {
      suppressedUntilInput = false;
      if (typeof shouldSuppress === 'function' && shouldSuppress()) {
        closeList();
        return;
      }
      var val = input.value.trim();
      if (!val) {
        container.innerHTML = '';
        closeList();
        return;
      }
      cancelPending(); // drop any in-flight/debounced request from the previous keystroke
      var myGen = reqGen;
      debounceTimer = setTimeout(function () {
        if (myGen !== reqGen) return;
        fetchSuggestions(val);
      }, SUGGEST_DEBOUNCE);
    });

    input.addEventListener('keydown', function (e) {
      if (list.hidden) return;
      var items = list.children;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        activeIndex = Math.min(activeIndex + 1, items.length - 1);
        updateActive(items);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        activeIndex = Math.max(activeIndex - 1, 0);
        updateActive(items);
      } else if (e.key === 'Enter') {
        if (activeIndex >= 0) {
          e.preventDefault();
          selectSuggestion(activeIndex);
        } else {
          closeList();
        }
      } else if (e.key === 'Escape') {
        closeList();
      }
    });

    function updateActive(items) {
      Array.prototype.forEach.call(items, function (el, i) {
        el.classList.toggle('active', i === activeIndex);
      });
      if (items[activeIndex]) items[activeIndex].scrollIntoView({ block: 'nearest' });
    }

    document.addEventListener('click', function (e) {
      if (list.hidden) return;
      if (!form.contains(e.target)) closeList();
    });

    form.addEventListener('submit', function () {
      suppressedUntilInput = true;
      closeList();
    });

    return { close: closeList };
  }

  function init() {
    injectStyles();

    var form = qs('#wiki-search-form');
    var input = qs('#wiki-search-input');
    var container = qs('#wiki-result');
    if (!form || !input || !container) return;

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      searchWikipedia(input.value, container);
    });

    initSuggestions(input, form, container);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Expose for manual/programmatic use elsewhere on the site (js/search.js)
  window.GNWiki = { search: searchWikipedia, initSuggestions: initSuggestions };
})();
