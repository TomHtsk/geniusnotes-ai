// Wikipedia lookup widget — plain JS, no dependencies.
// Flow: opensearch (origin=*, limit=5) powers live suggestions as the user types;
// on Search, opensearch (limit=1) finds the best title, then the REST summary API
// renders title/image/extract/link + "Source: Wikipedia (CC BY-SA)" below the bar.
// "Read full article" pulls the full plain-text extract via the query API and shows it
// in a scrollable panel, inline, without leaving the site.
// Called by js/search.js (the unified smart search bar) via window.GNWiki.
(function () {
  var OPENSEARCH_URL = 'https://en.wikipedia.org/w/api.php?action=opensearch&format=json&origin=*&search=';
  var SUMMARY_URL = 'https://en.wikipedia.org/api/rest_v1/page/summary/';
  var FULLTEXT_URL = 'https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&format=json&origin=*&titles=';
  var RELATED_URL = 'https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&origin=*&srlimit=6&srsearch=';
  var SCROLL_STEP = 240;
  var SUGGEST_LIMIT = 6;
  var SUGGEST_DEBOUNCE = 220;

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
      '.wiki-send-error[hidden] { display:none; }';
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
          '<div class="wiki-full-panel" id="wiki-full-panel" hidden>' +
            '<div class="wiki-full-content" id="wiki-full-content" tabindex="0"><div class="wiki-status">Loading full article…</div></div>' +
          '</div>' +
          '<div class="wiki-send-error" id="wiki-send-error" hidden></div>' +
          '<div class="wiki-attribution">Source: Wikipedia (CC BY-SA)</div>' +
          '<div class="wiki-related" id="wiki-related" hidden></div>' +
        '</div>' +
      '</div>';

    wireFullArticleToggle(data.title, container);
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

  // Fetches the full plain-text article body via the query API. Shared by "Read full
  // article" and "Send to Notepad" so there's one place that knows how to parse the
  // response — resolves with the extract text (possibly empty) or rejects on network error.
  function fetchFullText(title) {
    return fetchJson(FULLTEXT_URL + encodeURIComponent(title)).then(function (data) {
      var pages = (data.query && data.query.pages) || {};
      var page = pages[Object.keys(pages)[0]];
      return (page && page.extract) || '';
    });
  }

  function wireFullArticleToggle(title, container) {
    var toggle = qs('#wiki-full-toggle');
    var panel = qs('#wiki-full-panel');
    var content = qs('#wiki-full-content');
    if (!toggle || !panel || !content) return;

    var loaded = false;

    toggle.addEventListener('click', function () {
      var isHidden = panel.hidden;
      panel.hidden = !isHidden;
      toggle.textContent = isHidden ? 'Hide full article' : 'Read full article';
      if (isHidden && !loaded) {
        loaded = true;
        fetchFullText(title)
          .then(function (text) {
            content.innerHTML = text
              ? '<pre class="wiki-full-text">' + escapeHtml(text) + '</pre>'
              : '<div class="wiki-status">No full-text content available.</div>';
          })
          .catch(function (err) {
            content.innerHTML = '<div class="wiki-status wiki-error">Failed to load full article: ' + escapeHtml(err.message) + '</div>';
          });
      }
    });

    content.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowUp') { e.preventDefault(); content.scrollBy({ top: -SCROLL_STEP, behavior: 'smooth' }); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); content.scrollBy({ top: SCROLL_STEP, behavior: 'smooth' }); }
    });
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
          var body = 'Source: Wikipedia — ' + pageUrl + ' (CC BY-SA)\n\n' + text;
          try {
            localStorage.setItem('gn-notepad-pending', body);
            localStorage.setItem('gn-notepad-pending-title', title + ' — Wikipedia');
            localStorage.setItem('gn-notepad-pending-source', 'wikipedia');
          } catch (e) {}
          window.location.href = 'notepad.html';
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
