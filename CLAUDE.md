# GeniusNotes.ai — Project Context

## notebook.html — Notebooks App (updated June 2026)

### Architecture
- **Data**: `gn-nb-folders` (folders) + `gn-notebooks` (notebooks, each has `pages[]` of internal pages)
- **Hierarchy**: Folders → Notebooks (independent documents) → Pages (within one notebook)
- **Views**: shelf → editor (2-view stack; page shelf removed)
- **openNotebook(id)**: always opens editor directly (`openPage(lastPage||0)`) — no intermediate page shelf
- **closeEditor()**: calls `goHome()` → main shelf. `goHome()` fixes: uses `lp-starred/recent/trash` IDs (no `lp-all`)
- **Theme**: light default (`:root`), dark via `:root.dark`; editor bg is always white/dark per mode
- **Migration**: `migrateNotepad()` imports notepad notes (flag: `gn-nb-v2-imported`)
- **Demo**: `_seedDemoNotebook()` creates "Prompt Guide" notebook for new users (flag: `gn-nb-demo-seeded`)

### Notes vs Pages terminology
- A **Notebook** = an independent document (on the All Notebooks shelf)
- A **Page** = a page within that notebook (navigated via left panel thumbnails, `+ Add Page ▾`)
- Internal page titles default to "Page 1", "Page 2", etc.
- Old `addPageFromShelf('type')` now creates a **new standalone notebook** (not a page within current)
- `extractAndOpenPage(i)`: extracts a page from `_curNb.pages` → new standalone notebook, opens it; deletes `_curNb` if empty

### Color Picker
- `COLORS[]` = 10 solid colors (purple, blue, teal, green, red, pink, amber, orange, dark, slate)
- `GRADIENTS[]` = 6 gradient strings (`linear-gradient(135deg,...)`)
- `colorWithAlpha(c, hexAlpha)`: returns `c+hexAlpha` for solid colors, `c` unchanged for gradients
- `buildColorModalRow(rowId, inputId, hexId, curColor, onPick)`: shared builder showing COLORS + "Gradients" label + GRADIENTS swatches
- Folder cards use `colorWithAlpha(f.color, '22'/'33')` for tinted backgrounds — gradient-safe
- Both notebook and folder right-click menus have "🎨 Change Color" → `modal-nb-color` / `modal-folder-color`

### Split Screen — Cross-Notebook Drag-and-Drop
- **Drag** any notebook card (shelf or left panel tree) → **drop onto another notebook** → opens both side-by-side
- Visual: drag source dims to 60% opacity; drop target shows purple "⊞ Open Split" overlay (`:after` with `pointer-events:none`)
- `dragleave` uses `contains(e.relatedTarget)` to avoid flickering on child elements
- `dragstart` stores ID in both `_dragItem` and `e.dataTransfer.setData('text/plain', id)`; `drop` reads both as fallback
- `openCrossNbSplit(id1, id2)`: sets `_splitNb2`, `_splitNb2PageIdx`, `_crossNbSplit=true` BEFORE calling `openPage()`
- State: `_crossNbSplit` (bool), `_splitNb2` (notebook object), `_splitNb2PageIdx` (int)
- `saveRightPage()`, `saveRightTitle()`, `prevRightPage()`, `nextRightPage()`, `swapSplitEditors()` all branch on `_crossNbSplit`
- `exitSplitMode()` resets all three cross-nb state vars

### In-editor Split Screen (same notebook)
- **⊞ Split** button → `toggleSplitPicker()` → dropdown of other pages in same notebook
- Click page → `enterSplitMode(idx)` → shows right panel + divider
- **⇄ swap** centered on divider → `swapSplitEditors()` swaps content between panels
- Divider drag-to-resize: `startSplitResize` / `onSplitResize` / `stopSplitResize`
- Right panel: ◀ ▶ navigate pages, ✕ close → `exitSplitMode()`

### A4 Page Breaks (Task 2)
- `_PG_H=1056`, `_GAP_H=32`, `_CYCLE=1088`
- `refreshPageLines()` → `_applyPageBreaks(ed)` inserts `.pg-sep` divs at overflow points
- `schedulePageLines()` debounced 80ms; called from `onTextInput()`, `acceptAI()`, photo insert, etc.
- `saveCurPage()` clones editor and strips `.pg-sep` before saving — stored HTML is always clean
- `loadPage()` saves overlay to OLD page BEFORE changing `_curPageIdx`, then restores new page
- `_setPgCssVars()` sets `--pg-top/right/bottom/left` on `#text-editor`
- `_updateEditorBg(ed)` applies repeating gradient (white page / grey gap) — called on theme toggle too

### Draw Overlay (Task 4)
- `toggleDrawOverlay()` activates/deactivates canvas over text page
- State: `_overlayActive`, `_overlayCanvas`, `_overlayCtx`, `_ovTool`, `_ovColor`, `_ovSize`
- Saved as `pg.overlayDataURL` (stripped from cloud sync to save space)
- Deactivation from `loadPage()` uses UI-only path (saves to old page BEFORE `_curPageIdx` changes)

### Firebase Cloud Sync (Task 8)
- Firestore path: `users/{uid}/nb_store/main` → `{ notebooks, folders, updatedAt }`
- Draw page `dataURL` and `overlayDataURL` stripped before cloud save (localStorage only)
- `scheduleCloudSave()` debounces 3s; skips if `_fbUid` is null
- `initFirebase()` retries on `typeof firebase==='undefined'` (defer script race)
- Presence: `nb_presence/{nbId}` → renders colored dots on page thumbnails for collaborators

### Key Bug Fixes Applied
- `acceptAI()` and `aiAction()` use `_getActiveEditorEl()` (not hardcoded `#text-editor`)
- `applyFont('')` always runs `execCommand('fontName', false, 'inherit')` — fixes Default reset
- `discardAI()` null-guards `#ai-result` elements
- `addPageFromShelf()` / `addPageInEditor()` call `saveCurPage()` + `clearTimeout(_saveTimer)` before creating new note
- `openPage()` used by search results (not manual `switchView+loadPage`) — initializes canvas
- Selection popup works on both left and right editors in split mode
- FileReader has `onerror` handler in `importFile()` — no frozen UI on failure
- `insertImport('current')` guards against being called from shelf view
- `goHome()` uses `lp-starred/recent/trash` IDs + `tree-root` — NOT `lp-all` (does not exist); was crashing before `renderShelf()`
- `closeEditor()` wraps all steps in try/catch so `goHome()` always runs even if canvas/presence errors
- `colorWithAlpha()` guards gradient strings from having hex alpha appended (would produce invalid CSS)

## Live URLs
- https://geniusnotes.ai / https://www.geniusnotes.ai
- https://geniusnotes-ai.vercel.app

## Firebase
- Project: `geniusnotes-ai`
- API key: `AIzaSyAwbZkiZR8NRgrFYCL041FHfGquHyeEJUI`
- App ID: `1:1041746856723:web:fae9072e0292c3946068e6`
- Providers: Email/Password + Google
- Authorized domains: `geniusnotes-ai.vercel.app`, `geniusnotes.ai`, `www.geniusnotes.ai`

## Stripe (test mode)
- Test secret: stored in Vercel env var `STRIPE_SECRET_KEY` — do not commit
- Monthly: `price_1TZMytFzUKNvR71hbVBxf0Lc` | Yearly: `price_1TZMytFzUKNvR71hXvErlp8s`

## Vercel Env Vars
`GROQ_API_KEY`, `SUPADATA_API_KEY` (`sd_c660106aa59694f231f3a315b20e6777`), `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`

## Git
Remote: `https://github.com/TomHtsk/geniusnotes-ai.git` (branch: `main`)

---

## dashboard.html — REMOVED (temporary)
- Backed up at `C:\Users\nmntx\AppData\Local\Temp\dashboard.html.bak`
- All `dashboard.html` links across pages replaced with `index.html` (Home) or `notepad.html`
- Pages updated: `index.html`, `notepad.html`, `signin.html`, `passwords.html`, `history.html`, `create-deck.html`, `my-notes.html`

## study.html — REMOVED
`study.html` redirects to `notepad.html`. Do not restore.

---

## Navigation — Standardized Sidebar
Sidebar added to: `my-notes.html`, `flashcards.html` (newly added this session)
Already had sidebar: `index.html`, `passwords.html`, `meetings.html`

**Sidebar items (all pages):**
- 🏠 Home → `index.html`
- 📝 Notepad → `notepad.html`
- 🗂 My Notes → `my-notes.html`
- 🃏 Flashcards → `flashcards.html`

**CSS classes:** `.sidebar-overlay`, `.sidebar`, `.sb-hd`, `.sb-items`, `.sb-item`, `.sb-item.active`, `.sb-footer`, `.nav-hamburger`
**JS:** `toggleSidebar()` / `closeSidebar()` — overlay id: `sidebarOverlay`
**Active item:** `.sb-item.active { background:#6d28d9 }` — set per-page

---

## index.html — Homepage

### Hero
- Video background: `images/hero-bg.mp4`, autoplay/loop/muted
- Title: "Your AI study co-captain." (no badge)
- Buttons: Take Notes | Upload | Record Lecture (no "More Study Tools" — removed)

### Nav (signed-in state)
- Right: theme toggle | **My Notepad** (→ notepad.html) | Sign Out
- No Dashboard link anywhere on the site

### Footer links
- Notepad | My Notes | Sign In | Sign Up (no Dashboard)

### YouTube bar
- **Transcribe** → `goYtTranscribe()` → `/api/summarize` `mode:'transcribe'` → `#yt-modal`

### Upload / Record modals — unchanged

---

## notepad.html

### Status bar — REMOVED
- Zoom controls (−, 100%, +, ↺) removed
- Page counter ("Page 1 of 2") hidden (`display:none`) — element kept for JS refs

### Header buttons
- **My Notes** button (📂): `.np-close-btn` → `my-notes.html`
  - Fixed width (was 32×32px fixed, caused text wrap) → now `height:32px; padding:0 10px; white-space:nowrap`
  - Hover: purple highlight (not red)
- Rename (✏️) and Delete (✕) buttons visually separated by `border-left` on the delete button

### Slash commands — all working
| Command | Action |
|---|---|
| `/format code` | `openCodeConvert()` |
| `/flashcards` | `sendNoteToFlashcards()` |
| `/academic` | `openDocFormat('academic')` |
| `/cornellnotes` | `openDocFormat('cornell')` |
| `/bullets` | `openDocFormat('bullets')` |
| `/outline` | `openDocFormat('outline')` |
| `/studyguide` | `openDocFormat('studyguide')` |
| `/solve` | `openHomeworkSolver()` |
| `/format APA` or `/formatAPA` | APA essay (style pre-selected) |
| `/format MLA` or `/formatMLA` | MLA essay (style pre-selected) |
| `/format Chicago` or `/formatChicago` | Chicago essay (style pre-selected) |

**`_cmdFamily` order matters** — `formatapa`/`formatmla`/`formatchicago` checked BEFORE the `format` catch-all.

### api/writing.js — academic mode
- **Changed:** no longer rewrites content; preserves original text
- Prompt: "DO NOT add, invent, or fabricate any information… PRESERVE all original ideas"
- No fake citations added; References section only if sources mentioned in original
- `bullets`, `outline`, `studyguide` now use `llama-3.3-70b-versatile` (was 8b) with 3000 max tokens

### Folder tree (redesigned this session)
- **Unlimited nesting** — folders can contain sub-folders to any depth
- **`parentId`** field on folder objects (null = root level); backward compatible
- **Tree renderer:** `_renderFolderTree(parentId, depth)` — recursive
- **Unfiled section** at bottom of folder tree — collapsible, shows notes with no `folderId`
- **`+` button** on each folder row → `_ftreeShowAdd(event, folderId)` → dropdown: "New Note here" / "New Subfolder"
- **Drag & drop:**
  - Drag 📁 folder onto another folder → becomes subfolder (`folder.parentId` updated)
  - Drag 📄 note in tree → drop on folder → `note.folderId` updated
  - Drop on "All Notes" → removes from folder (unfiled)
  - Circular nesting prevented via `_ftreeIsDescendant()`
- **Delete cascade:** `_deleteFolderTree(folderId)` — deletes all children recursively
- **Folder filter:** clicking a folder name sets `_folderFilter` → filters flat Notes list above
- **`__unfiled__`** is a special filter ID for notes with no valid folder
- CSS classes: `.ftree-row`, `.ftree-chev`, `.ftree-name`, `.ftree-count`, `.ftree-btn`, `.ftree-note`, `.ftree-note-title`, `.drop-over`

### Note items (flat Notes list)
- **Folder label** shown below date: `📁 FolderName` or `📄 Unfiled` (only when folders exist)
- CSS: `.ni-folder { font-size:0.62rem; color:var(--muted); }`

### Collab sync (notepad ↔ share.html)
- **`_cloudSaveNote(note)`** — if `note.shareId` exists, also writes `content`+`title` to `shared_notes/{shareId}` in Firestore
- **`openNote(id)`** — if note has `shareId`, starts `_startCollabSync(shareId)` (checks Firestore for `collaborative:true`)
- **`initCloudSync()`** — immediately after `_fbDb` is set, checks if the currently active note has a `shareId` and starts the listener (fixes timing: `openNote` runs before `_fbDb` is ready)
- **`_startCollabSync(shareId)`** — `onSnapshot` on `shared_notes/{shareId}` → applies remote content to editor if `_collabLastTyped > 2000ms`
- Full two-way sync: notepad.html ↔ shared_notes ↔ share.html and notepad.html ↔ shared_notes ↔ other notepad.html

### Bottom bar
- Study | Theme (no Dashboard)

### Demo note
- `_DEMO_NOTE_ID = '__demo_commands__'`
- Injected when `notes.length === 0`
- Cannot be deleted

### Other features (unchanged)
- Selection popup: 1 word → Spelling; multiple words → Define/Comprehend/Grammar
- Sticky Notes: `.gn-sticky` spans, inline HTML storage
- Highlights: Range API (not insertHTML), toggleable per color
- TTS: word-by-word highlighting via `_ttsBuildMap`
- Page breaks: `.pg-sep { display:block }`, `_applyPageBreaks`
- Math: KaTeX, `/math` command
- Split screen, detach panel, drag-to-reorder notes

---

## my-notes.html

### Guest (logged-out) users
- `getNotes()` always returns `[_MN_DEMO_NOTE]` — ignores localStorage
- Only one note shown: Prompt Guide with full command list
- "New Folder" button hidden (`display:none`) for guests
- `_MN_DEMO_NOTE` content: full `/command` list with descriptions

### Logged-in users
- Notes loaded from `gn-notepad-notes` localStorage (synced from cloud via `GNSync`)
- `getFolders()` merges `gn-notepad-folders` + `gn-folders-{uid}`

### Nav
- "← Home" (was "← Dashboard") → `index.html`

---

## flashcards.html
- Sidebar added (hamburger + overlay + tree: Home/Notepad/My Notes/Flashcards active)
- Sidebar JS: `toggleSidebar()` / `closeSidebar()` inline at bottom of file

---

## share.html

### "Open Notepad" button
- Was: `<a href="notepad.html">` — just navigated, no content transfer
- Now: `<button onclick="importToNotepad()">` — imports live note content into notepad
- `importToNotepad()` reads from `#note-editor` (live DOM, updated by Firestore listener) not stale `_noteData`
- Creates new note: `{ id: 'imp_...', title, content, shareId: id }` — **`shareId` preserved** so collab sync works from User B's notepad
- Saves to `gn-notepad-notes` localStorage, sets `gn-notepad-open`, navigates to `notepad.html`

### Collab sync
- `_noteData` set on Firestore load
- `setupRealtime(ref, data)` — `onSnapshot` on `shared_notes/{id}` → updates `#note-editor` live
- Pushes local edits back to `shared_notes/{id}` on editor `input` event (debounced 500ms)

---

## passwords.html
- Sidebar "DASHBOARD" footer link → now "HOME" → `index.html`
- "← Back to Dashboard" → "← Back to Home" → `index.html`

---

## history.html
- "← Dashboard" → "← Home" → `index.html`

## create-deck.html
- "🏠 Dashboard" tab → "🏠 Home" → `index.html`

## signin.html
- "Go to Dashboard →" → "Go to Notepad →" → `notepad.html`

---

## API Files

### Deployed (12 functions — Hobby plan limit)
`writing.js`, `summarize.js`, `interpret.js`, `lyrics.js`, `extract.js`, `transcribe.js`, `homework.js`, `checker.js`, `translate.js`, `checkout.js`, `webhook.js`, `subscription.js`

### Merged (skip in deploy — handled via Vercel rewrites)
`api/ytsearch.js` → `summarize.js` | `api/musicnotes.js` → `lyrics.js` | `api/chat.js` → `interpret.js` | `api/citation.js` → `writing.js` | `api/textbook.js` → `writing.js`

### api/writing.js key modes
- `grammar`: minLen = 1 (no minimum)
- `academic`: preserves original content, no fabricated citations, ~same length as input
- `bullets`, `outline`, `studyguide`: use 70b model, 3000 max tokens (was 8b/2000)
- `cornell`: 4000 max tokens, returns JSON `{topic, rows[], summary}`

### api/summarize.js
- `mode:'transcribe'` → raw transcript (no AI summarization)

### api/extract.js
- PPTX: `fileType:'pptx'` → JSZip → `<a:t>` XML extraction
- Image OCR: Groq vision `meta-llama/llama-4-scout-17b-16e-instruct`

---

## Known Architecture Notes

### Critical invariants
- **Full deploy always required** — partial deploy = 404 everywhere
- **API function limit = 12** — always skip the 5 merged files in deploy
- **`var _noteSort` / `var _folderSort`** — must be `var` not `let` (TDZ crash before `renderSidebar`)
- **`#editor` position:relative** — required for `_applyPageBreaks` offsetTop calculations
- **Toolbar mousedown → preventDefault()** — required for execCommand to work on selections
- **Folder picker** — `<div class="folder-pick">` must be SIBLING of button (not inside)
- **Folder dropdown clipping** — uses `position:fixed` + `getBoundingClientRect()` to escape overflow:hidden

### Cloud sync
- `initCloudSync()` sets `_fbDb` synchronously, then starts auth listener
- `_fbDb` is available for unauthenticated users (needed for collab sync)
- `_cloudSaveNote` writes to both `users/{uid}/notepad_notes/{id}` AND `shared_notes/{shareId}` if applicable
- `openNote` starts collab listener — but called BEFORE `initCloudSync`, so `initCloudSync` re-checks active note on `_fbDb` ready

### localStorage keys
`gn-notepad-notes`, `gn-notepad-folders`, `gn-notepad-open`, `gn-theme`, `gn-margins`, `gn-zoom`

### Firestore collections
- `users/{uid}/notepad_notes/{noteId}` — user's notes
- `users/{uid}/notepad_folders/{folderId}` — user's folders (now with `parentId` for nesting)
- `users/{uid}/meta/welcome` — welcome note seeding flag
- `shared_notes/{shareId}` — collaborative/shared notes (public read, no auth required)
