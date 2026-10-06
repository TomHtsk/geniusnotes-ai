// NCSafe — cleans HTML that did NOT come from NoteCaptain's own code before it is put on
// the page: shared-note content edited by guests, remote cursor labels/colours, AI replies,
// Wikipedia/YouTube data, text pulled from uploads.
//
//   NCSafe.clean(html)  -> safe HTML (DOMPurify with an allow-list made for notes)
//   NCSafe.text(str)    -> the string escaped for use inside HTML
//   NCSafe.color(str)   -> str if it is a plain #hex / rgb() / hsl() colour, else a default
//
// Needs DOMPurify (loaded from cdnjs with an integrity hash, before this file). If
// DOMPurify is missing, clean() FAILS SAFE: it returns the input as escaped plain text.
//
// The allow-list is what the Notepad really writes into notes: rich text (execCommand makes
// <font color/size/face>), headings, lists, tables, code blocks (.gh-block tables), Cornell
// notes (.cornell-block with an "Active Recall" <button>), sticky notes (.gn-sticky with
// data-*), images and created diagrams (<span class="img-wrap"><img src="data:image/png…">),
// KaTeX maths (span/div.math-eq[-block] with data-latex; KaTeX's HTML spans + its small
// <svg>/<path>/<line> shapes — its hidden MathML copy is dropped, which changes nothing on
// screen).
(function () {
  'use strict';

  var TAGS = [
    'p', 'div', 'span', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'ins', 'mark', 'small',
    'sub', 'sup', 'blockquote', 'pre', 'code', 'a', 'img', 'font', 'figure', 'figcaption',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'colgroup', 'col', 'caption',
    'button', 'label', 'canvas',
    // KaTeX's drawn symbols (square roots, long arrows, wide accents)
    'svg', 'path', 'line',
  ];
  var ATTRS = [
    'class', 'style', 'href', 'src', 'alt', 'title', 'colspan', 'rowspan', 'width', 'height',
    'target', 'rel', 'draggable', 'contenteditable', 'start', 'type', 'align', 'valign',
    'border', 'cellpadding', 'cellspacing', 'bgcolor', 'span',   // pasted tables
    'color', 'size', 'face',               // <font> from the editor's colour / size buttons
    'aria-hidden',                         // KaTeX
    'viewbox', 'viewBox', 'preserveaspectratio', 'preserveAspectRatio', 'd',
    'x1', 'y1', 'x2', 'y2', 'stroke', 'stroke-width', 'fill',
  ];
  var IMG_DATA = /^data:image\/(png|jpeg|jpg|gif|webp);base64,[a-z0-9+/=\s]+$/i;
  var LINK_OK = /^(https?:|mailto:)/i;
  var IMG_OK = /^https:/i;
  // style="" declarations that could overlay the page or load outside content. Only those
  // declarations are dropped; the rest of the formatting stays.
  var BAD_DECL = /url\s*\(|expression\s*\(|javascript:|behavior\s*:|-moz-binding|^\s*position\s*:\s*(fixed|sticky)|@import/i;
  // Returns the style unchanged when nothing in it is unsafe (so saved notes don't change).
  function cleanStyle(style) {
    var s = String(style);
    var parts = s.split(';');
    if (!parts.some(function (d) { return BAD_DECL.test(d); })) return s;
    return parts.filter(function (d) { return d.trim() && !BAD_DECL.test(d); }).join(';');
  }

  var hooked = false;
  function addHooks(P) {
    if (hooked) return;
    hooked = true;
    P.addHook('afterSanitizeAttributes', function (node) {
      var tag = node.nodeName.toLowerCase();
      if (node.hasAttribute('href')) {
        var href = (node.getAttribute('href') || '').trim();
        if (!LINK_OK.test(href)) node.removeAttribute('href');
      }
      if (tag === 'a') {
        node.setAttribute('rel', 'noopener noreferrer');
        if (node.hasAttribute('target') && node.getAttribute('target') !== '_blank') node.removeAttribute('target');
      } else if (node.hasAttribute('target')) {
        node.removeAttribute('target');
      }
      if (node.hasAttribute('src')) {
        var src = (node.getAttribute('src') || '').trim();
        if (tag !== 'img' || !(IMG_OK.test(src) || IMG_DATA.test(src))) node.removeAttribute('src');
      }
      if (node.hasAttribute('style')) {
        var st = cleanStyle(node.getAttribute('style'));
        if (st) node.setAttribute('style', st); else node.removeAttribute('style');
      }
      // Locked pieces (maths, pictures, Cornell frame) use "false", Cornell cells "true".
      if (node.hasAttribute('contenteditable')) {
        var ce = node.getAttribute('contenteditable');
        if (ce !== 'false' && ce !== 'true') node.removeAttribute('contenteditable');
      }
      if (tag === 'button') node.setAttribute('type', 'button');
      if (node.hasAttribute('type') && tag !== 'button' && tag !== 'ol' && tag !== 'ul') node.removeAttribute('type');
    });
  }

  var CONFIG = {
    ALLOWED_TAGS: TAGS,
    ALLOWED_ATTR: ATTRS,
    ALLOW_DATA_ATTR: true,        // data-latex, data-display, data-text (sticky notes)…
    ALLOW_ARIA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    ADD_DATA_URI_TAGS: ['img'],
    WHOLE_DOCUMENT: false,
    RETURN_DOM: false,
  };

  function text(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function clean(html) {
    var s = String(html == null ? '' : html);
    var P = window.DOMPurify;
    if (!P || typeof P.sanitize !== 'function' || !P.isSupported) return text(s); // fail safe
    addHooks(P);
    return P.sanitize(s, CONFIG);
  }

  var DEFAULT_COLOR = '#5CC4D0';
  var COLOR_OK = /^(#[0-9a-fA-F]{3,8}|rgba?\(\s*\d{1,3}%?\s*,\s*\d{1,3}%?\s*,\s*\d{1,3}%?\s*(,\s*(0|1|0?\.\d+))?\s*\)|hsla?\(\s*\d{1,3}(deg)?\s*,\s*\d{1,3}%\s*,\s*\d{1,3}%\s*(,\s*(0|1|0?\.\d+))?\s*\))$/;
  function color(str, fallback) {
    var c = String(str == null ? '' : str).trim();
    return COLOR_OK.test(c) ? c : (fallback || DEFAULT_COLOR);
  }

  // A note's stored content is either one HTML string (older notes, share.html edits) or a
  // JSON list of page HTML strings (the Notepad's pages). Cleans every page, keeps the shape.
  function cleanNote(content) {
    var s = String(content == null ? '' : content);
    if (s.trim().charAt(0) === '[') {
      try {
        var arr = JSON.parse(s);
        if (Array.isArray(arr)) return JSON.stringify(arr.map(function (p) { return clean(typeof p === 'string' ? p : ''); }));
      } catch (e) { /* not JSON: treat as HTML below */ }
    }
    return clean(s);
  }

  // Plain text of some HTML, read in an inert document: nothing in it loads or runs
  // (a normal off-screen <div> would still fire <img onerror>).
  function textOf(html) {
    var doc = document.implementation.createHTMLDocument('');
    doc.body.innerHTML = String(html == null ? '' : html);
    return (doc.body.textContent || '').trim();
  }

  window.NCSafe = { clean: clean, cleanNote: cleanNote, text: text, textOf: textOf, color: color };

  // Cornell notes keep an "Active Recall" button and click-to-reveal note cells inside the
  // note. Cleaned content loses their inline onclick, so one shared listener does the same
  // job — only for elements WITHOUT an onclick, so notes that still have one don't fire twice.
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var b = t.closest('.cn-recall-btn');
    if (b && !b.hasAttribute('onclick') && typeof window.toggleCornellRecall === 'function') { window.toggleCornellRecall(b); return; }
    var n = t.closest('.cn-note');
    if (n && !n.hasAttribute('onclick') && typeof window.cnReveal === 'function') window.cnReveal(n);
  });
})();
