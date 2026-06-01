# DEBUG.md — Active Investigation Log

## RESOLVED THIS SESSION

### [RESOLVED] Image resize/move broken
- **Symptom**: Handles visible but clicking did nothing; image couldn't be dragged
- **Root cause**: Stale `.img-handle` spans + `.selected` class saved in note HTML; on reload, handles have no event listeners and `_selImg` is null
- **Fix**: `_stripImgSelection()` on all 8 save paths + 3 load paths; `e.preventDefault()` in `startDragImg`

### [RESOLVED] Right-editor tools use wrong note context
- **Root cause**: `activeId` hardcoded throughout — always left note ID. `_rightNoteId` not checked when right editor active.
- **Fix**: Added `_getActiveNoteId()` helper; updated all affected tool functions

---

## OPEN INVESTIGATIONS

### [OPEN] Right-pane saving doesn't trigger status indicator
- **What**: When user types in `#editor-right`, `note.content` is saved via the input listener, but the statusbar "Saving…" / "Saved" indicator (setSaving/setSaved) doesn't fire
- **Impact**: User doesn't get visual feedback that right-pane content is being saved
- **Next step**: Add `setSaving()` call to right-editor input listener and `setSaved()` call to right-editor scheduleSave flow

### [OPEN] study.html hash-to-panel mapping
- **Pre-existing bug**: `#lyrics` → `goToPanel(1)` should be 8; `#highlighter` → 2 should be 1; `#homework` → 3 should be 2
- **Impact**: Direct URL hash navigation to panels goes to wrong panel
- **Next step**: Reorder entries in IIFE hash→panel map

---

## KNOWN PATTERNS / WATCH FOR

- Any function using `document.getElementById('editor')` without `_getActiveEditorEl()` is probably broken for right-pane
- `activeId` alone (without `|| _rightNoteId` logic) is a right-pane bug
- `insertXxxIntoNote()` functions should use `_getActiveNoteId()` for `origNote` reference
