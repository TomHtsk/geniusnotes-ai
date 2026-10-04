// GNSync — real-time cross-device Firestore sync
// Syncs: notepad notes, notepad folders, history items
// Usage:
//   GNSync.init(uid, db, { onReady, onNotes, onFolders, onHistory })
//   GNSync.stop()
//   GNSync.writeHistItem(uid, db, item)
//   GNSync.deleteHistItem(uid, db, id)
//   GNSync.writeFolder(uid, db, folder)
//   GNSync.deleteFolder(uid, db, id)

window.GNSync = (function () {
  let _unsubs = [];

  function _mergeNotepadNotes(docs) {
    try {
      const raw = JSON.parse(localStorage.getItem('gn-notepad-notes') || '[]');
      const map = {};
      raw.forEach(n => { if (n && n.id) map[n.id] = n; });
      docs.forEach(d => {
        if (!d || !d.id) return;
        if (!map[d.id] || (d.updated || 0) > (map[d.id].updated || 0)) map[d.id] = d;
      });
      localStorage.setItem('gn-notepad-notes', JSON.stringify(Object.values(map)));
    } catch {}
  }

  function _mergeNotepadFolders(docs) {
    try {
      const raw = JSON.parse(localStorage.getItem('gn-notepad-folders') || '[]');
      const map = {};
      raw.forEach(f => { if (f && f.id) map[f.id] = f; });
      // A folder marked deleted in the cloud is removed here too (see deleteFolder below)
      docs.forEach(d => { if (d && d.id) { if (d.deleted) delete map[d.id]; else map[d.id] = d; } });
      localStorage.setItem('gn-notepad-folders', JSON.stringify(Object.values(map)));
    } catch {}
  }

  function _mergeHistory(uid, docs) {
    try {
      const key = 'gn-history-' + uid;
      const raw = JSON.parse(localStorage.getItem(key) || '[]');
      const map = {};
      raw.forEach(h => { if (h && h.id) map[h.id] = h; });
      // Firestore takes precedence for shared/updated fields
      docs.forEach(d => { if (d && d.id) map[d.id] = d; });
      const arr = Object.values(map).sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
      localStorage.setItem(key, JSON.stringify(arr));
    } catch {}
  }

  function init(uid, db, callbacks) {
    _unsubs.forEach(u => { try { u(); } catch {} });
    _unsubs = [];
    callbacks = callbacks || {};

    // Track first snapshot for each collection so we know when initial load is done
    let ready = { notes: false, folders: false, history: false };
    let onReadyFired = false;
    function checkReady() {
      if (!onReadyFired && ready.notes && ready.folders && ready.history) {
        onReadyFired = true;
        if (callbacks.onReady) callbacks.onReady();
      }
    }

    _unsubs.push(
      db.collection('users/' + uid + '/notepad_notes').onSnapshot(function (snap) {
        _mergeNotepadNotes(snap.docs.map(function (d) { return d.data(); }));
        if (!ready.notes) { ready.notes = true; checkReady(); }
        if (ready.notes && callbacks.onNotes) callbacks.onNotes();
      }, function () { ready.notes = true; checkReady(); })
    );

    _unsubs.push(
      db.collection('users/' + uid + '/notepad_folders').onSnapshot(function (snap) {
        _mergeNotepadFolders(snap.docs.map(function (d) { return d.data(); }));
        if (!ready.folders) { ready.folders = true; checkReady(); }
        if (ready.folders && callbacks.onFolders) callbacks.onFolders();
      }, function () { ready.folders = true; checkReady(); })
    );

    _unsubs.push(
      db.collection('users/' + uid + '/history').onSnapshot(function (snap) {
        _mergeHistory(uid, snap.docs.map(function (d) { return d.data(); }));
        if (!ready.history) { ready.history = true; checkReady(); }
        if (ready.history && callbacks.onHistory) callbacks.onHistory();
      }, function () { ready.history = true; checkReady(); })
    );

    // Also upload all current local data to Firestore so existing items
    // become available on other devices
    _uploadLocalToCloud(uid, db);
  }

  function _uploadLocalToCloud(uid, db) {
    try {
      const notes = JSON.parse(localStorage.getItem('gn-notepad-notes') || '[]');
      const folders = JSON.parse(localStorage.getItem('gn-notepad-folders') || '[]');
      const history = JSON.parse(localStorage.getItem('gn-history-' + uid) || '[]');
      const all = [
        ...notes.map(n => ({ col: 'notepad_notes', id: n.id, data: n })),
        ...folders.map(f => ({ col: 'notepad_folders', id: f.id, data: f })),
        ...history.map(h => ({ col: 'history', id: h.id, data: h }))
      ].filter(x => x.id);

      // Firestore batch limit is 500
      for (let i = 0; i < all.length; i += 400) {
        const chunk = all.slice(i, i + 400);
        const batch = db.batch();
        chunk.forEach(function (x) {
          batch.set(db.doc('users/' + uid + '/' + x.col + '/' + x.id), x.data, { merge: true });
        });
        batch.commit().catch(function () {});
      }
    } catch {}
  }

  function stop() {
    _unsubs.forEach(u => { try { u(); } catch {} });
    _unsubs = [];
  }

  function writeHistItem(uid, db, item) {
    if (!db || !uid || !item || !item.id) return;
    db.doc('users/' + uid + '/history/' + item.id).set(item, { merge: true }).catch(function () {});
  }

  function deleteHistItem(uid, db, id) {
    if (!db || !uid || !id) return;
    db.doc('users/' + uid + '/history/' + id).delete().catch(function () {});
  }

  function writeFolder(uid, db, folder) {
    if (!db || !uid || !folder || !folder.id) return;
    db.doc('users/' + uid + '/notepad_folders/' + folder.id).set(folder, { merge: true }).catch(function () {});
  }

  function deleteFolder(uid, db, id) {
    if (!db || !uid || !id) return;
    // Marked deleted, not erased, so a browser with an old copy can't bring it back by re-uploading
    db.doc('users/' + uid + '/notepad_folders/' + id).set({ id: id, deleted: true, deletedAt: Date.now() }, { merge: true }).catch(function () {});
  }

  return { init: init, stop: stop, writeHistItem: writeHistItem, deleteHistItem: deleteHistItem, writeFolder: writeFolder, deleteFolder: deleteFolder };
})();
