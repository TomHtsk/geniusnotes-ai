# TASK.md — GeniusNotes Active Work Log

## Status Key: [x] done | [ ] todo | [~] in progress

---

## ✅ COMPLETED THIS SESSION

- [x] Image resize/drag broken (stale handles saved in HTML) — fixed: `_stripImgSelection()` on all save/load paths
- [x] `startDragImg` native browser drag interference — fixed: `e.preventDefault()` added
- [x] Add `_getActiveNoteId()` helper for right-editor-aware note lookup
- [x] `openCodeConvert()` / `openDocFormat()` use left `activeId` even when right is active — fixed
- [x] `insertDocIntoNote()` / `insertCodeIntoNote()` / `insertHwIntoNote()` use `activeId` — fixed
- [x] `sendNoteToFlashcards()` guarded by `activeId` only — fixed
- [x] `runHlSb()` always highlights left editor — fixed
- [x] `_applyNoteHighlights()` hardcoded to left editor — fixed
- [x] `clearHlSb()` hardcoded to left editor — fixed
- [x] Cornell diff mode in `runHlSb` hardcoded to left editor — fixed
- [x] AI inline popup close doesn't check right editor — fixed
- [x] `updateStats()` hardcoded left editor — fixed
- [x] `copyNote()` hardcoded left editor — fixed

---

## [ ] OPEN / IN-PROGRESS

- [ ] study.html hash-to-panel mapping bug (pre-existing; low priority)
- [ ] Stripe secret key rotation (Vercel env — not in scope for code)
- [ ] Right-pane save indicator — right editor input events don't trigger statusbar "Saving…" indicator
- [ ] Right-editor word count stats not reflected in statusbar (partially fixed by updateStats fix)

---

## 🔍 NEWLY DISCOVERED ISSUES (this session)

- `downloadDocResult` references `activeId` for note title — same pattern; low-impact since it's a modal
- `runHlSb` diff mode Cornell block detection operates only on one editor — may need per-editor Cornell detection

---

## ARCHITECTURE NOTES

- `activeId` = left pane note ID always
- `_rightNoteId` = right pane note ID
- `_activeEditor` = 'left' | 'right' — tracks last focused editor
- `_getActiveEditorEl()` = returns correct editor DOM element
- `_getActiveNoteId()` = NEW helper: returns `_rightNoteId` or `activeId`
- All "Insert into Note" flows: create new note → open on left → split with original on right
