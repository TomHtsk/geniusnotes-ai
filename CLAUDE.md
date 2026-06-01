# GeniusNotes.ai — Project Context

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
- Test secret: `sk_test_…` (stored in Vercel env var `STRIPE_SECRET_KEY` — do not commit)
- Monthly: `price_1TZMytFzUKNvR71hbVBxf0Lc` ($12.99/mo) | Yearly: `price_1TZMytFzUKNvR71hXvErlp8s` ($99.99/yr)

## Vercel Env Vars
`GROQ_API_KEY`, `SUPADATA_API_KEY` (`sd_c660106aa59694f231f3a315b20e6777`), `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`

## Git
Remote: `https://github.com/TomHtsk/geniusnotes-ai.git` (branch: `main`)

---

## study.html — REMOVED
`study.html` now contains a meta-redirect to `notepad.html`. All internal links updated. Do not restore.

---

## Standardized Sidebar (all pages)
Applied to: `index.html`, `dashboard.html`, `passwords.html`, `meetings.html`

**Structure:** flat list, 3 items only — no section labels, no extra pages
- Home → `index.html`
- My Notes → `my-notes.html`
- Notepad → `notepad.html`

**CSS classes:** `.sidebar` (fixed, 240px, `#12121e`), `.sidebar-item` (hover/active), `.sb-hd`, `.sb-close`, `.sb-footer`
**JS:** `toggleSidebar()` / `closeSidebar()` — overlay id is `sidebarOverlay`
**Active item:** `.sidebar-item.active { background:#6d28d9 }` — set per-page

---

## index.html — Homepage

### Hero
- **Video background:** `images/hero-bg.mp4` (rough seas), loops/muted/autoplay
- **Gradient overlay:** `::before` at z-index:1, text at z-index:2
- **Title:** "Your AI study co-captain." (no badge)
- **Buttons:** Take Notes | Upload | Record Lecture | and more → dashboard.html

### YouTube bar
- Button: **Transcribe** → `goYtTranscribe()` → `/api/summarize` `mode:'transcribe'`
- Opens `#yt-modal` with transcript result + Import/Download/Convert options

### Upload modal (`#upload-modal`)
- Supports: PDF, DOCX, PPTX, TXT, JPG/PNG/GIF/WEBP, MP4/MOV/WEBM
- PDF → PDF.js → `/api/extract` with `ocrImages`
- PPTX → `/api/extract` with `fileType:'pptx'`
- Images → `/api/extract` with `ocrImages`
- Video → `/api/transcribe` with base64

### Record modal (`#record-modal`)
- Web Speech API live transcript

### Recent notes — REMOVED
- `_renderRecentNotes`, `#home-notes-grid`, `hsRender()`, `#hs-notes-list`, `#hs-folders-list` all removed
- Sidebar shows only 3 nav items; no note history anywhere

### Informational section
- Demo video placeholder (`#demo-wrap`)
- "Study smarter in three steps" — 3 feature cards
- Feature pills row (all 12 commands)
- CTA → signup.html

### Nav
- Left: sidebar toggle + logo
- Right: theme toggle | Get Started / Sign In | Dashboard | Sign Out

---

## notepad.html

### Sidebar quick-nav (above Notes list)
Two pill buttons added between search bar and Notes section header:
- **Home** → `index.html` (same tab)
- **My Notes** → `my-notes.html` (same tab)

### Bottom bar
- Study | Theme | Dashboard (unchanged)

### Tab bar — REMOVED
No `_tabs`, `_renderTabs`, `_initTabs`, `_switchToIframe`, `_switchToNotepad`, `#iframe-panel`.

### Sidebar + button
- `+` button (`#add-note-btn`) → dropdown: **Add New Note** | **Add New Folder**
- Folder `+` button (`#folder-add-btn`) → dropdown: **New Note** | **New Folder**
- `newNoteWithName()` — prompts for name via `showCustomPrompt`, creates note

### Demo note (Prompt Guide)
- `_DEMO_NOTE_ID = '__demo_commands__'`
- Injected into `notes[]` when `notes.length === 0`
- Cannot be deleted

### Selection popup
- **1 word** → Spelling + 📌 Sticky Note
- **Multiple words** → Define | Comprehend | Grammar | 📌 Sticky Note
- `sel-multi-row` / `sel-single-row` toggled in `showSelectionPopup()`

### Sticky Notes
- Button: **📌 Sticky Note** in selection popup (both single and multi-word rows)
- `addStickyNote()` → wraps selection in `<span class="gn-sticky" data-note="" data-color="#FFD600">`
- Visual: dashed gold underline + 📌 superscript icon
- Clicking a sticky span → `openStickyDrop(span)` → `#sticky-drop` dropdown
- **Dropdown modes:**
  - Read-only (default): shows note text + **Edit** + **Remove**
  - Edit mode: shows textarea + **Save** + **Remove**
- **Color picker:** 5 dots (yellow/green/blue/pink/orange) — `setStickyColor(color, btn)` sets `data-color` on span
- `deleteStickyDrop()` → unwraps the span, restores plain text
- Sticky data stored inline in note HTML → auto-saves with note
- **Only Remove button removes the sticky** — closing dropdown never removes it
- CSS: `.gn-sticky`, `#sticky-drop`, `.sticky-color-dot`, `#sticky-drop-edit/save/del`

### Highlights (manual color)
- `applyManualHighlight(color)` — uses Range `extractContents` + `insertNode` (NOT `insertHTML`)
  - Preserves `.gn-sticky` span wrappers when highlighting inside a sticky
  - **Toggle:** clicking same color on already-highlighted text removes the highlight
- `removeManualHighlight()` — finds ALL `<mark>` elements intersecting the selection and unwraps them
  - ✕ button removes highlight from entire selected sentence, not just inner word
- Colors: Yellow | Green | Blue | Pink | Purple | Orange

### Text-to-Speech (TTS)
- Button: **🔊 Read** in the header toolbar (`#tts-btn`)
- `toggleTTS()` → reads active editor's `innerText` via Web Speech API (`SpeechSynthesisUtterance`)
- **Word-by-word highlighting:** `utt.onboundary` fires per word
  - `_ttsBuildMap(root)` — walks DOM (text nodes + block newlines) to build `{node, start, end}` offset map
  - `_ttsHighlightWord(el, charIndex, charLen)` — wraps current word in `<mark class="tts-word">` (blue highlight)
  - `_ttsRemoveHighlight()` — unwraps mark + `normalize()` before next word
- Button toggles to **⏹ Stop** while active
- Auto-stops and clears highlight on note switch (`openNote` calls `_ttsStop`)
- CSS: `mark.tts-word { background:rgba(96,165,250,0.45) }`

### Welcome note seeding (`_seedWelcomeNote`)
- Fires on every login, checks `users/{uid}/meta/welcome` Firestore doc
- New users get folder `Prompt Guide` + note `Prompt Guide`

### Page breaks
- `.pg-sep { display:block; background:transparent }` — spacers take up layout space
- `_applyPageBreaks` pushes elements crossing `gapStart` to next page
- `gapOff = _PG_H - bottomMargin` (920px default)

---

## my-notes.html

### getFolders()
Merges both localStorage keys:
```javascript
const a = JSON.parse(localStorage.getItem('gn-notepad-folders') || '[]'); // cloud sync
const b = JSON.parse(localStorage.getItem('gn-folders-' + _uid) || '[]'); // my-notes
// cloud-synced takes precedence
```

### Demo note for signed-out users
- `_MN_DEMO_NOTE` / `_MN_DEMO_FOLDER` injected when `!_uid && notes.length === 0`

---

## api/extract.js
- **PPTX support:** `fileType:'pptx'` → JSZip parses `ppt/slides/slideN.xml`, extracts `<a:t>` text
- **Image OCR:** `ocrImages` → Groq vision `meta-llama/llama-4-scout-17b-16e-instruct`
- **DOCX:** mammoth → fallback OCR images in `word/media/`

## api/writing.js
- `grammar` mode: **no minimum character length** (minLen = 1)

## api/summarize.js
- `mode:'transcribe'` → returns raw transcript from Supadata without AI summarization

---

## Known Architecture Notes
- **Auth-gated notes:** `saveNotes()` no-op if `_fbUid === null`
- **Cloud sync layers:** `initCloudSync()` in notepad.html (onSnapshot); `GNSync` in `js/cloud-sync.js`
- **localStorage keys:** `gn-notepad-notes`, `gn-notepad-folders`, `gn-notepad-open`, `gn-theme`, `gn-margins`, `gn-zoom`
- **applyManualHighlight uses Range API** (not `insertHTML`) to preserve sticky note spans
- **Sticky note data is inline HTML** — no separate storage, auto-saved with note content
- **TTS offset mapping:** `_ttsBuildMap` accounts for block-element newlines to align with `innerText` offsets
