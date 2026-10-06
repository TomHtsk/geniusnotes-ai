// share.html: shared-note viewer / live editor (moved out of the page so share.html can use a
// strict Content-Security-Policy with no inline scripts or onclick handlers).
(function(){
  if(localStorage.getItem('gn-theme') !== 'dark') document.documentElement.classList.add('light');
  window.addEventListener('storage', e => { if (e.key === 'gn-theme') document.documentElement.classList.toggle('light', e.newValue !== 'dark'); });

  firebase.initializeApp({
    apiKey:'AIzaSyAwbZkiZR8NRgrFYCL041FHfGquHyeEJUI',
    authDomain:'geniusnotes-ai.firebaseapp.com',
    projectId:'geniusnotes-ai',
    appId:'1:1041746856723:web:fae9072e0292c3946068e6'
  });
  const db = firebase.firestore();

  const id = new URLSearchParams(location.search).get('id');
  if (!id) { showError('No note ID provided.'); return; }

  let _isCollab = false;
  let _saveTimer = null;
  let _lastRemote = '';
  let _lastTyped = 0;
  let _noteData = null;

  // A note shared from the Notepad is stored as a JSON list of page HTML strings
  // ('["<p>…</p>", …]'); edits made on this page are stored as one HTML string. Show both
  // as one HTML block (it is cleaned with NCSafe.clean before it goes on the page).
  function noteHtml(content) {
    const s = String(content || '');
    if (s.trim().charAt(0) === '[') {
      try { const pages = JSON.parse(s); if (Array.isArray(pages)) return pages.filter(p => typeof p === 'string').join(''); } catch (e) {}
    }
    return s;
  }

  window.importToNotepad = function() {
    // Always read from the live editor — it's kept up-to-date by the real-time listener
    const editor = document.getElementById('note-editor');
    const titleEl = document.getElementById('note-title-el');
    const title = (titleEl ? titleEl.textContent : null) || (_noteData ? _noteData.title : 'Shared Note') || 'Shared Note';
    const content = NCSafe.clean((editor ? editor.innerHTML : null) || (_noteData ? noteHtml(_noteData.content) : '') || '');
    const newId = 'imp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    const note = { id: newId, title: title, content: content, created: Date.now(), updated: Date.now(), shareId: id };
    try {
      const existing = JSON.parse(localStorage.getItem('gn-notepad-notes') || '[]');
      existing.unshift(note);
      localStorage.setItem('gn-notepad-notes', JSON.stringify(existing));
      localStorage.setItem('gn-notepad-open', newId);
    } catch(e) {}
    window.location.href = 'notepad.html';
  };

  // Presence / cursor
  const _uid = Math.random().toString(36).slice(2, 9);
  const _colors = ['#e05252','#e08c52','#b5c916','#34c98b','#4fc3f7','#a78bfa','#f472b6'];
  const _color = _colors[Math.floor(Math.random() * _colors.length)];
  let _label = 'User';

  firebase.auth().onAuthStateChanged(user => {
    // A hidden guest session (YouTube converter) is a guest here too: numbered "User #N".
    if (user && !user.isAnonymous) {
      const raw = user.displayName || user.email || '';
      _label = raw.replace(/@.*/, '') || 'User';
    } else {
      const key = 'gn-guest-num-' + id;
      const stored = sessionStorage.getItem(key);
      if (stored) {
        _label = 'User #' + stored;
      } else {
        db.runTransaction(async t => {
          const docRef = db.collection('shared_notes').doc(id);
          const snap = await t.get(docRef);
          const n = (snap.exists ? (snap.data().guestCount || 0) : 0) + 1;
          t.update(docRef, { guestCount: n });
          return n;
        }).then(n => {
          sessionStorage.setItem(key, String(n));
          _label = 'User #' + n;
        }).catch(() => { _label = 'User #1'; });
      }
    }
  });

  db.collection('shared_notes').doc(id).get().then(doc => {
    if (!doc.exists) { showError('This note has been deleted or the link is invalid.'); return; }
    const data = doc.data();
    _noteData = data;
    _isCollab = !!data.collaborative;
    _lastRemote = data.content || '';
    renderNote(data);
    if (_isCollab) setupRealtime(doc.ref, data);
  }).catch(e => showError('Failed to load: ' + e.message));

  function renderNote(data) {
    const main = document.getElementById('main');
    const date = data.sharedAt ? new Date(data.sharedAt).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : '';
    main.innerHTML = `
      <div class="note-meta">
        <div class="note-title" id="note-title-el">${esc(data.title||'Untitled Note')}</div>
        <div class="note-info">
          <span>📅 ${date}</span>
          ${_isCollab ? '<span id="presence"><span class="presence-dot"></span> Live collaboration</span>' : '<span>🔒 Read-only</span>'}
          <span id="sync-status"></span>
        </div>
      </div>
      ${_isCollab ? `<div class="toolbar visible" id="collab-toolbar">
        <button class="tb" data-cmd="bold"><b>B</b></button>
        <button class="tb" data-cmd="italic"><i>I</i></button>
        <button class="tb" data-cmd="underline"><u>U</u></button>
        <div class="tb-sep"></div>
        <button class="tb" data-cmd="insertUnorderedList">• List</button>
        <button class="tb" data-cmd="insertOrderedList">1. List</button>
        <div class="tb-sep"></div>
        <button class="tb" data-cmd="formatBlock" data-arg="h2">H2</button>
        <button class="tb" data-cmd="formatBlock" data-arg="p">¶</button>
      </div>` : ''}
      <div id="note-editor" contenteditable="${_isCollab ? 'true' : 'false'}"
           spellcheck="true" data-placeholder="Start writing…">${NCSafe.clean(noteHtml(data.content)||'<p><br></p>')}</div>
    `;
    if (_isCollab) {
      const badge = document.getElementById('mode-badge');
      badge.textContent = '✏️ Collaborative';
      badge.className = 'nav-badge collab-badge';
      document.title = (data.title||'Shared Note') + ' · Live — NoteCaptain AI';
    } else {
      document.title = (data.title||'Shared Note') + ' — NoteCaptain AI';
    }
  }

  function setupRealtime(ref, initialData) {
    const editor = document.getElementById('note-editor');
    if (!editor) return;

    // ── Cursor helpers ──
    function getTextOffset(root, node, off) {
      let count = 0;
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (w.nextNode()) {
        if (w.currentNode.parentElement?.closest('.rc')) continue;
        if (w.currentNode === node) return count + off;
        count += w.currentNode.length;
      }
      return count;
    }

    function getRangeFromOffset(root, offset) {
      let count = 0;
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let lastNode = null, lastLen = 0;
      while (w.nextNode()) {
        if (w.currentNode.parentElement?.closest('.rc')) continue;
        const len = w.currentNode.length;
        if (count + len >= offset) {
          const r = document.createRange();
          r.setStart(w.currentNode, Math.min(offset - count, len));
          r.collapse(true);
          return r;
        }
        count += len;
        lastNode = w.currentNode;
        lastLen = len;
      }
      if (lastNode) {
        const r = document.createRange();
        r.setStart(lastNode, lastLen);
        r.collapse(true);
        return r;
      }
      return null;
    }

    function renderRemoteCursor(uid, offset, color, label) {
      document.getElementById('rc-' + uid)?.remove();
      const range = getRangeFromOffset(editor, offset);
      if (!range) return;
      const eRect = editor.getBoundingClientRect();
      const rects = range.getClientRects();
      const rRect = rects.length ? rects[0] : range.getBoundingClientRect();
      if (!rRect) return;
      const el = document.createElement('div');
      el.id = 'rc-' + uid;
      el.className = 'rc';
      el.style.top = (rRect.top - eRect.top) + 'px';
      el.style.left = (rRect.left - eRect.left) + 'px';
      // Guests can write any label/colour into Firestore: the colour must pass the allow-list
      // and is set through the style property; the label is plain text. No HTML/CSS strings.
      const _c = NCSafe.color(color);
      const caret = document.createElement('div');
      caret.className = 'rc-caret';
      caret.style.backgroundColor = _c;
      const lbl = document.createElement('div');
      lbl.className = 'rc-label';
      lbl.style.backgroundColor = _c;
      lbl.textContent = String(label == null ? '' : label).slice(0, 60);
      el.append(caret, lbl);
      editor.appendChild(el);
    }

    // Broadcast own cursor position (debounced)
    let _cursorTimer = null;
    document.addEventListener('selectionchange', () => {
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount || !editor.contains(sel.anchorNode)) return;
      clearTimeout(_cursorTimer);
      _cursorTimer = setTimeout(() => {
        const offset = getTextOffset(editor, sel.anchorNode, sel.anchorOffset);
        const update = {};
        update[`cursors.${_uid}`] = { offset, color: _color, label: _label, t: Date.now() };
        ref.update(update).catch(() => {});
      }, 80);
    });

    // Remove own cursor on leave
    window.addEventListener('beforeunload', () => {
      const update = {};
      update[`cursors.${_uid}`] = firebase.firestore.FieldValue.delete();
      ref.update(update).catch(() => {});
    });

    // Listen for remote changes + cursors
    ref.onSnapshot(snap => {
      if (!snap.exists) return;
      const d = snap.data();

      // Remote content
      const remoteContent = d.content || '';
      if (remoteContent !== _lastRemote) {
        _lastRemote = remoteContent;
        if (Date.now() - _lastTyped > 2000) applyRemoteContent(editor, remoteContent);
      }

      // Remote cursors
      const cursors = d.cursors || {};
      // Remove stale cursors
      editor.querySelectorAll('.rc').forEach(el => {
        const uid = el.id.replace('rc-', '');
        if (!cursors[uid] || uid === _uid) el.remove();
      });
      // Render active remote cursors
      Object.entries(cursors).forEach(([uid, c]) => {
        if (uid === _uid) return;
        if (Date.now() - c.t > 30000) return; // stale
        renderRemoteCursor(uid, c.offset, c.color, c.label);
      });

      const titleEl = document.getElementById('note-title-el');
      if (titleEl && d.title) titleEl.textContent = d.title;
    });

    // Push local changes to Firestore
    editor.addEventListener('input', () => {
      _lastTyped = Date.now();
      setSyncStatus('saving');
      clearTimeout(_saveTimer);
      _saveTimer = setTimeout(() => {
        const content = editor.innerHTML;
        _lastRemote = content;
        ref.update({ content, lastEditedAt: Date.now() })
          .then(() => setSyncStatus('saved'))
          .catch(() => setSyncStatus(''));
      }, 1500);
    });
  }

  function applyRemoteContent(editor, content) {
    // Save cursor position
    const sel = window.getSelection();
    let savedRange = null;
    if (sel && sel.rangeCount && editor.contains(sel.anchorNode)) {
      savedRange = sel.getRangeAt(0).cloneRange();
    }
    // Anyone with an "Edit together" link can change this content: clean it first.
    editor.innerHTML = NCSafe.clean(noteHtml(content));
    // Restore cursor if possible
    if (savedRange) {
      try { sel.removeAllRanges(); sel.addRange(savedRange); } catch(e) {}
    }
    setSyncStatus('saved');
  }

  function setSyncStatus(state) {
    const el = document.getElementById('sync-status');
    if (!el) return;
    if (state === 'saving') { el.textContent = '● Syncing…'; el.className = 'saving'; }
    else if (state === 'saved') { el.textContent = '✓ Synced'; el.className = 'saved'; setTimeout(() => { el.textContent=''; el.className=''; }, 2500); }
    else { el.textContent = ''; el.className = ''; }
  }

  function showError(msg) {
    document.getElementById('main').innerHTML = `<div class="state"><div style="font-size:2.5rem;opacity:0.3;margin-bottom:14px;">🔗</div><div style="font-size:0.88rem;color:#666;">${NCSafe.text(msg)}</div></div>`;
  }

  function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
})();

  // One listener replaces the inline onclick handlers (strict CSP forbids them).
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('[data-action],[data-cmd]') : null;
    if (!t) return;
    if (t.dataset.cmd) { document.execCommand(t.dataset.cmd, false, t.dataset.arg); return; }
    if (t.dataset.action === 'import' && typeof window.importToNotepad === 'function') window.importToNotepad();
    if (t.dataset.action === 'theme' && typeof window.gnToggleTheme === 'function') window.gnToggleTheme();
  });
