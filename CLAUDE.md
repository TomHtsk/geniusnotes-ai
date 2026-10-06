# NoteCaptain (notecaptain.ai) — Project Context

> Formerly "GeniusNotes.ai". The site was renamed to **NoteCaptain** in Oct 2026 and now lives at **www.notecaptain.ai**. Internal IDs keep the old name on purpose (Firebase project `geniusnotes-ai`, GitHub repo `geniusnotes-ai`, `gn-` storage keys). Do not rename those — users would lose accounts and saved notes.

## READ FIRST — current state (Oct 2026)

### What the product is
A study tool. Core flow: **search a topic → learn (Wikipedia + AI) → save to Notepad → flashcards/quiz**. Plain HTML/CSS/JS pages + Vercel serverless functions in `/api`. No framework, no build step.

### Working with the owner
- The owner (Thomas) is a beginner. Explain in plain English, show a plan before big edits, change only what was asked, and finish by listing changed files + how to test.
- Keep it simple: this is an MVP. Hide rather than delete features. Don't add new dependencies or API files without asking.

### Rules that must not be broken
1. **Max 12 serverless functions** (Vercel Hobby). **10 are in use** since payments were removed (Oct 2026), so there are 2 spare. Still prefer adding an `action` to an existing endpoint over a new file in `/api`.
2. **Every `/api` endpoint requires a Firebase ID token** via `api/_lib/auth.js` (`verifyAuth` / `verifyAuthFull`). Frontend calls go through `_authFetch`. Anonymous tokens are accepted only for the YouTube converter (`summarize.js`).
3. **CORS allow-list** in `api/_lib/auth.js` (`ALLOWED_ORIGINS`): notecaptain.ai, www.notecaptain.ai, the vercel.app address, localhost. No `*`.
4. **Never trust the browser for limits.** Usage is checked server-side (`checkAndIncrementUsage`, `checkYoutubeDailyLimit`, `checkGuestYoutubeLimit`).
5. **Secrets only in Vercel env vars.** `FIREBASE_SERVICE_ACCOUNT` is parsed by `_parseServiceAccount` (tolerates extra text / base64).
6. **AI provider is Groq** (OpenAI-compatible endpoint), not OpenAI. Transcription: Supadata (YouTube), Groq Whisper / AssemblyAI (audio).
   - **All model names live in `api/_lib/models.js`** (`MODEL_LARGE`, `MODEL_SMALL`, `MODEL_VISION`, `MODEL_WHISPER`, `MODEL_WHISPER_TURBO`) — never hardcode a Groq model string in any `/api` file. Each has an optional env var override (`GROQ_MODEL_LARGE`, `GROQ_MODEL_SMALL`, `GROQ_MODEL_VISION`) so a future Groq deprecation is fixed in Vercel, not code.
   - **Current models (as of Oct 2026 fix)**: `MODEL_LARGE = openai/gpt-oss-120b` (was `llama-3.3-70b-versatile`, shut down), `MODEL_SMALL = openai/gpt-oss-20b` (was `llama-3.1-8b-instant`, shut down). Both are **reasoning models** — every call site sets `include_reasoning: false` so `message.content` stays the final answer only, and `max_tokens` was raised ~50% across the board to leave room for internal reasoning. JSON-expecting calls (Cornell notes, citation, checker, textbook question-matching) add `response_format: { type: 'json_object' }` on top of the existing tolerant string-parsing fallback — only where the model is expected to return a single top-level JSON *object* (not an array, not plain text).
   - **`MODEL_VISION`** defaults to `qwen/qwen3.8-27b` (the image-capable model in Groq's docs, Oct 2026; used by image upload/OCR, the homework solver's image path, textbook question images). Not yet confirmed working on the live site. If Groq retires it, set `GROQ_MODEL_VISION` in Vercel — no code change needed. Images are shrunk in the browser (`umImageForOcr` in index.html, max 2000px, JPEG) before upload to stay under Vercel's 4.5 MB limit.
   - **Which task uses which model (Oct 2026 — stretches Groq's free plan, since each model has its own separate allowance):**
     - `MODEL_SMALL` (simple tasks): citation formatting (`writing.js` citation route), Define and Comprehend in the selection popup (`interpret.js`), tutor chat (`interpret.js`), transcript clean-up / speaker labelling (`transcribe.js`, both places), translate, the last-resort AI lyrics lookup (`lyrics.js`), and the short `writing.js` modes (grammar, improve, math…).
     - `MODEL_LARGE` (quality-sensitive): notes/summaries/flashcards (`summarize.js`), textbook question matching and the Cornell "diff" gap finder (`writing.js`), the long `writing.js` modes (cornell, studyguide, outline, bullets, academic, docformat, highlight, code, format, email, inline), `checker.js`, `homework.js` (typed problems), sheet-music/ABC notation (`lyrics.js` musicnotes route), and the deep "interpret" mode in `interpret.js`.
   - **Fallback rule — always call Groq chat through `groqChat(body, opts)` in `api/_lib/models.js`, never a raw `fetch`.** If Groq answers 429 (rate limit) for the model asked for, `groqChat` retries ONCE on the other model (large → small, small → large). It returns the normal fetch `Response`, so callers keep using `r.ok` / `r.json()`. Vision calls (`MODEL_VISION`) and Whisper (audio) do not use it and have no fallback.
   - **Both models rate-limited** → the endpoint returns 429 `{ error: "NoteCaptain is busy right now because today's free AI allowance is used up. Please try again later.", code: 'ai_busy' }` via `sendBusyIfNeeded(err, res, uid)`, which also gives the user's monthly AI action back (`refundAiAction` in `auth.js`). Put `if (await sendBusyIfNeeded(err, res, uid)) return;` before the `isModelUnavailableError` check in any new Groq error path. Exception: the transcript clean-up paths still return the unedited text with 200 (and refund the action) rather than failing the recording.
   - Local check: `node _test_groq.js` (gitignored; fakes Groq and Firestore) prints which model each endpoint asks for and tests the fallback.
   - **Friendly errors**: every Groq-calling endpoint logs the real error server-side (`console.error`) and returns `"This AI feature is temporarily unavailable. Please try again soon."` (502) to the client when the error looks like a model-not-found/deprecation error (`isModelUnavailableError` in `models.js`, checks Groq's `error.code` first, falls back to message-text matching). Other errors (bad input, rate limits, timeouts) keep their existing specific messages.
7. **Wikipedia content is CC BY-SA 4.0** — keep the attribution + license link on the result card, the full-screen reader, and notes sent to the Notepad.

### Payments — REMOVED on purpose (Oct 2026)
Stripe, the Pro plan, `pricing.html`, `js/pricing.js`, `api/checkout.js` and `api/webhook.js` were deleted at the owner's request; everything is free. To bring payments back, restore from the git tag **`before-stripe-removal`**. Do not re-add payment code unless asked.

### Usage limits (`USAGE_LIMITS` in `api/_lib/auth.js`) — one set for everyone
| Who | AI actions / month | Lecture recording / month | YouTube conversions / day |
|---|---|---|---|
| Guest (not signed in) | — | — | 3 (`GUEST_YT_LIMIT`) |
| Signed in | 300 | 30 min | 3 |

`/api/summarize` limits by request type: a YouTube **link** uses the daily YouTube allowance; **text** (uploads, flashcards, notebook summaries) is a normal monthly AI action, needs a real account, and never touches the YouTube allowance; a video **search** only hits the hourly rate limit. To reset every YouTube daily counter, bump `YT_COUNTER_RESET_TAG` in `api/_lib/auth.js`.

Limit hit → API returns 429 `{ code: 'limit_reached', error: '<sentence saying when it resets>' }`. Pages can show `error` as-is, or pass it to `gnShowLimitNotice()` in `js/auth-gate.js`. There is no upgrade prompt.

### Create picture — diagrams drawn by OUR templates, not by the AI (Oct 2026)
- **Rule: the AI never draws and never writes SVG.** It only returns structured data; `js/diagram-templates.js` (`GNDiagram`) draws the picture from one fixed template per kind, so every diagram has the same design. Style reference: `Claude outputs/diagram-style-reference.svg` (the photosynthesis equation). Do not let any AI-written markup reach the page.
- **Flow:** "Create picture" (Notepad toolbar and the Convert panel → `openPictureModal()`).
  - **Text is selected:** ONE picture from the selection (`multi:false`), inserted at the selection — unchanged behaviour.
  - **Nothing is selected:** the whole note's plain text (`multi:true`) → every separate topic worth drawing, **up to 5 pictures**, covering the most important parts of the note. One picture → the single preview window ("Try again" / "Insert into note"). Several → a list with title, kind, a small preview (click it to see it larger) and a checkbox ticked by default, with "Try again" / "Insert selected".
  - `POST /api/writing { action: 'diagram', text, multi }` → `{ items: [{ title, kind, data, anchor }], truncated, usedChars }` → each item: `GNDiagram.render(data)` → `GNDiagram.toPng()` (canvas, 2x, white background, redrawn smaller if over about 220 KB) → inserted as a PNG data URL with the caption "Diagram made from your note - check it against your notes". Signed-out users get `gnRequireSignIn`.
- **Placement (`_picInsertItems` in notepad.html):** `anchor` is a short exact quote (5–12 words) from the note. Each picture goes directly after the paragraph, heading, list or loose line containing its anchor (`_picUnits` / `_picFindUnit`; matching ignores case and punctuation and falls back to the quote's first 8, 6, then 4 words). No match → after the block the remembered cursor was in → else the end of the note. Inserts run from the bottom of the note upward so earlier inserts never move later targets. `_undoSave()` before and after means ONE Ctrl+Z removes everything one "Insert selected" added. Each multi-insert picture is its own `<p class="ai-pic-block">`.
- **Note size check:** before inserting, pictures are added only while the note stays under `PIC_NOTE_MAX_CHARS` (8,000,000 characters — a cloud save is one write of about 10 MB, and the content is split into 500,000-character pieces so no Firestore document nears 1 MB). Any that don't fit are left out and a toast says how many and why.
- **How much of the note is read:** the browser sends at most 20,000 characters (`PIC_MAX_NOTE_CHARS`; `MAX_NOTE_CHARS` on the server). **Groq's free plan allows only 8,000 tokens per minute per model, and a request is refused if prompt + note + max_tokens is over that**, so `planDiagramRequest` trims the note to what fits while leaving the AI 3,000 tokens to answer (2,000 for a selection). On the free plan that is about **13,600 characters of a whole note**. When anything is cut, `truncated: true` comes back and the window tells the user only the first part was used. If the Groq plan is upgraded, set `GROQ_DIAGRAM_TOKEN_BUDGET` in Vercel (default 7600) and the 20,000-character cap takes over. One whole-note request can use most of that minute's allowance for the large model; other requests in the same minute fall back to the small model (`groqChat`).
- **Server:** no new `/api` file — the `diagram` action lives in `api/writing.js`; the prompt, request sizing and validation are in `api/_lib/diagram.js`. ONE request to the AI (`MODEL_LARGE` through `groqChat`, `response_format: json_object`) and ONE normal AI action (`checkAndIncrementUsage`) however many pictures come back; there is no separate picture counter.
- **Shapes the AI may return** (anything else is dropped): the AI replies `{"items":[...]}`; each item is one of `equation` { title, subtitle, reactants[{count, formula, name}], products[...], condition, location } · `process` { title, steps[{label, detail}] } · `cycle` (same as process) · `comparison` { title, columns[{heading, points[]}] }, plus `anchor`. `{"items":[]}` means nothing drawable. Preference order: equation, process, cycle, comparison. Limits (`LIMITS` in `diagram.js`): up to 4 substances per side, 2–8 steps, 2–4 columns, up to 6 points, short text lengths, at most `MAX_ITEMS` = 5 items.
- **Validation (`validateItems` → `validateDiagram` per item):** types, lengths and counts are checked and only the allowed fields are kept. Every equation formula must literally appear in the note (spaces and Unicode subscripts ignored) — the AI may not introduce a substance. **An invalid item is dropped, not the whole reply.** Two items showing the same thing are reduced to one. An anchor that is not really in the note is blanked (the browser then uses its fallback placement). A reply that isn't recognisable at all is retried once. If no valid item is left, the reply is `{ items: [], message: "Nothing in this note looks drawable yet. Select an equation or a process and try again." }` and the AI action is given back (`refundAiAction`). Groq failing twice → 502 friendly error; Groq saying the request is too large → 413 "This note is too long to read in one go right now…"; neither is counted.
- **What our code decides, not the AI:** subscripts (digits after a letter or closing bracket), the molecule drawings, plain names for library molecules when the note gives none, and the **balance line** — `GNDiagram.balance()` counts the atoms on each side from the formulas and counts and writes "Balanced: both sides have …", "Not balanced as written: left has …, right has …", or "Balance not checked: …" (short names like ATP/NADPH, or charged ions, are never counted).
- **Molecule library (`MOLECULES` in `js/diagram-templates.js`):** CO2, H2O, O2, H2, N2, CH4, NH3, C6H12O6, NaCl, HCl, O3, CO, NO2, SO2, H2O2, C2H5OH are drawn as balls; ATP is a labelled badge. Any formula not in the library gets a neat formula badge — never a guessed structure. Add a molecule by adding its atoms and bonds there.
- **Template rules:** white background, Arial/Helvetica (a picture can't load web fonts, and measuring and drawing must use the same font), no font below 14, no external images/fonts/scripts. Text is measured with a canvas, then wrapped or shrunk to fit its box (`fitLines`); "…" is the last resort. Equation card widths grow for wide formulas/drawings; process uses a second row after 4 steps; the cycle loop grows with the number of steps.
- **Tests (gitignored, need Edge):** `node _test_diagram.js` feeds fixed JSON to the templates, checks every label for overlap/overflow/minimum font, compares the photosynthesis picture pixel-by-pixel with the style reference, and saves pictures to `Claude outputs/diagram-tests/`. `node _test_picture.js` runs the server action with a fake Groq and the whole Notepad flow (three topics, one topic, a selection, anchors that don't match, undo, too-large notes, long notes). Neither can test the real AI's choices — that needs the live site.
- **Removed:** the Cloudflare Workers AI image generator (`api/_lib/images.js`, `generateImage` on `/api/subscription`, `CF_MODEL_IMAGE`, the 10-pictures-a-month counter). `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` in Vercel are no longer read by any code and can be deleted there.
- **Storage:** diagrams are PNG data URLs inside the note (usually 80–220 KB each). Notes over 700,000 characters are split into 500,000-character chunks in Firestore (`_cloudSaveNote`) and long notes are kept in IndexedDB locally, so a note with several diagrams still saves and syncs. A note that large stops live-updating its shared link (existing behaviour).

### Access
- No sign-in needed: Wikipedia search/reader, YouTube converter (guests are signed in anonymously behind the scenes), and — while `LOCKS_ENABLED = false` in `js/auth-gate.js` — opening and using the Notepad and Flashcards (a guest's notes stay in that browser).
- Sign-in required: Upload, Record Lecture, and all AI tools (the server rejects requests without a real account).
- `my-notes.html` was removed (redirects to `notepad.html`); the Notepad sidebar is where notes and folders are browsed.
- **Retired (Oct 2026, security fix 2):** `passwords.html` and `vault.html` are now plain "retired" pages with Export (passwords .txt / vault files .zip) and "Delete from this browser" buttons and no input fields. They kept passwords, a PIN and private files unencrypted in this browser; NoteCaptain no longer holds secrets. The old code is only in git history (before commit "Security fix 2"). No links to them anywhere.

### Key files added recently
- `js/search.js` — single smart search bar (detects YouTube link vs. topic), recent-search chips
- `js/wiki.js` — Wikipedia summary card, autocomplete, related topics, full-screen article reader, "Send to Notepad" (uses `gn-notepad-pending*` keys)
- `js/auth-gate.js` — shared sign-in modal, 🔒 gating (`LOCKS_ENABLED`), and the "limit reached" notice
- `api/_lib/auth.js` — CORS, auth, rate limits, usage limits, shared Firestore handle (`getDb`)

### Notepad (`notepad.html`)
Simplified in Oct 2026: one continuous "pageless" document by default, notes stored safely for long text, trimmed toolbar with a "More" menu. **Sections further down that describe fixed pages, cross-page Enter/Backspace/Delete, rulers and zoom were written before this change — verify against the code before relying on them.**

### Not done yet (ideas, don't build unless asked)
Wikidata fact chips, AI "Explain simpler" levels, "Study This" one-click flashcards + quiz mode, Privacy Policy/Terms pages.

---

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
- https://www.notecaptain.ai (notecaptain.ai redirects to www)
- https://geniusnotes-ai.vercel.app (Vercel's built-in address)
- geniusnotes.ai is RETIRED — do not add it back to CORS, Firebase, or links.

## Firebase
- Project ID: `geniusnotes-ai` (internal ID; cannot be renamed — leave as is)
- Web config (apiKey/appId) is inline in each HTML page; it is public by design.
- Providers: Email/Password, Google, Anonymous (guests using the YouTube converter)
- Authorized domains: `notecaptain.ai`, `www.notecaptain.ai`, plus Firebase defaults
- Server side uses `firebase-admin` v14 MODULAR imports only (`firebase-admin/app`, `/auth`, `/firestore`), required lazily inside `api/_lib/auth.js`. Never use `admin.auth()` / `admin.firestore()`.

## Vercel Env Vars (values live ONLY in Vercel — never write keys in this file or in code)
`GROQ_API_KEY`, `SUPADATA_API_KEY`, `ASSEMBLYAI_API_KEY`, `FIREBASE_SERVICE_ACCOUNT`, `YOUTUBE_API_KEY`, `YT_COOKIE`, `GEMINI_API_KEY`

The code no longer reads any payment-related env vars; any still set in Vercel are unused and can be deleted there.

## Git / Deploy
- Remote: `https://github.com/TomHtsk/geniusnotes-ai.git` (branch: `main`). Pushing `main` deploys to production on Vercel.
- The owner is on Windows; the project path contains an apostrophe (`Thomas henry's folder`) — quote paths.
- Commit before every big change. Never commit secrets.

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

### Upload modal — video/audio is chunked (Oct 2026)
- The video/audio file itself is NEVER uploaded (Vercel rejects bodies over 4.5 MB with a plain-text 413). `umTranscribeMedia()` decodes the audio in the browser, converts to mono 16 kHz, cuts it into 72–80 s 16-bit WAV parts at quiet moments (`umChunkBounds`), and sends them to `/api/transcribe` one at a time with `uploadId`, `chunkIndex`, `chunkCount`, `chunkSeconds`. Limit: 60 minutes. One retry per part; Cancel button; progress bar.
- `umPostJson()` is the only way the Upload window calls the server — it reads the reply as text first so a non-JSON reply becomes a friendly message. Don't call `r.json()` directly in the upload flow.
- Server (`handleUploadChunk` in `api/transcribe.js` + helpers in `api/_lib/auth.js`): chunk 0 pays the hourly rate limit + ONE AI action and records a session at `users/{uid}/uploads/{uploadId}` (30-min expiry, max 50 parts, max 2 attempts per part). Later parts skip those checks only if they match a live session. Audio seconds (measured from the WAV size, not trusted from the browser) are added to the user's `recordSeconds` — the SAME 30 min/month allowance as Record Lecture — and to the site-wide tracking total `siteUsage/{YYYY-MM}.transcribeSeconds` (no site-wide cap).
- Other callers of `/api/transcribe` (Record Lecture, Notepad, create-deck) send no `uploadId` and are unchanged.
- Local test: `node _test_upload.js` (gitignored; needs the files in `Claude outputs/upload-test-files/`). It fakes Groq and Firestore, so real transcripts still have to be checked on the live site.
- PDF/DOCX/PPTX/image paths still send to `/api/extract` as before (only their error handling changed) — big ones still hit the 4.5 MB limit; moving them into the browser is planned but not done.

### Record modal — unchanged

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

### Selection popup — font size badge
- `#sel-fs-badge` span shows computed font size of selected text (px)
- Populated in `showSelectionPopup()` via `window.getComputedStyle(anchorEl).fontSize`
- `_updateFsDisplay()` also uses `getComputedStyle` (not `el.style.fontSize`)

### Split screen — right pane (paginated, June 2026)
- Right pane uses real `.page-box` divs in `#pages-container-right` (same as left), NOT the old gradient-fake `#editor-right`
- `_createRightPageBox(isFirst)` — mirrors `_createPageBox`; wires `_activeEditor='right'` on focus/mousedown
- `_buildPagesContainerRight(pagesArr)` — rebuilds all page boxes from a pages array, then calls `requestAnimationFrame(_reflowPagesRight)`
- `_reflowPagesRight()` — overflow reflow engine for right pane (mirrors `_reflowPages` but simpler — no cursor-follow or undo)
- `_serializePagesRight()` / `_getEditorRightText()` — serialize right pages for save/stats
- `#doc-ruler-right` — ruler added to right pane; `buildRuler()` populates both `doc-ruler-track` and `doc-ruler-track-right`
- **Zoom sync**: `setZoom()` applies `container.style.zoom` to BOTH `#pages-container` and `#pages-container-right`; `enterSplitMode()` also applies current zoom to right pane on open

### `_reflowPages()` — reflow engine changes (June 2026)
- **Overflow pass — empty trailing blocks discarded**: when `lastBlock` is empty AND cursor is NOT in it, `lastBlock` is removed instead of pushed to the next page (Word behavior — trailing empty lines are absorbed by the page boundary, not flowed to the next page)
- **Pre-pass skips cursor's page**: the pre-pass that strips leading empty blocks from non-first pages now SKIPS the page the cursor is on (`if (_rfCursorPc && cpc === _rfCursorPc) continue`). Empty leading blocks on the active page are intentional (user-typed), not overflow artifacts. Cleanup only runs on pages without the cursor.

### Enter key on non-first pages (June 2026)
- Handler fires for **any block at offset 0** on any non-first page (previously only fired for `pc.firstChild`)
- Inserts new empty `<p>` ABOVE cursor's block; cursor stays in `entBlock` (Word behavior: Enter before a paragraph pushes it down, cursor stays with the text)
- No stale-empty-block stripping in the Enter handler — pre-pass handles cleanup when cursor is elsewhere

### Backspace cross-page handler (updated June 2026)
- Three-part guard: (1) block is **empty** → return (browser deletes the empty line); (2) any **non-empty** previous sibling → return (browser handles); (3) only empty siblings above or none → strip them, proceed to TEXT MERGE
- **TEXT MERGE**: moves block's children into `_lastReal` (last real `<p>` on prevPc), removes block. Binary-search from `_bsOrigLen` to find how much of the merged text fits on page N-1; split overflow to page N via Range API. Succeeds where block-move fails: page N-1 full → two paragraphs need 2 line-heights, merged text shares the last line
- Falls back to block-move if `_lastReal` is special (img, table, cornell, math, draw)
- **Cursor placement**: save `_bsOrigLen = _lastReal.textContent.length` BEFORE merge. After all mutations + `_reflowPages()`, place cursor via fresh `TreeWalker(SHOW_TEXT)` in `setTimeout(0)` walking to character `_bsOrigLen` in `_lastReal`. **Never use a live Range saved before the binary search** — `element.textContent = partial` clamps `(elem,N)` to `(elem,1)`, corrupting the range and causing catastrophic paragraph-merging on the next Backspace keypress
- `prevPc.focus({ preventScroll: true })` + TreeWalker cursor in `setTimeout(0)` + `setTimeout(_scrollCursorIntoView, 60)`

### Delete cross-page handler (June 2026)
- Symmetric to Backspace: cursor at end of last block on page N, Delete pulls first block of page N+1
- **TEXT MERGE**: merges `firstBlock`'s children into `delBlock`, removes `firstBlock`. Binary-search from `_delOrigLen`. `_delDidTextMerge` flag set when text-merge path taken
- Falls back to block-move for special elements
- **Cursor placement**: save `_delJoinOff = delBlock.textContent.length` BEFORE merge. After `_reflowPages()` (which may move `delBlock` to page 2 if rich-HTML measurement exceeds plain-text estimate), place cursor via fresh TreeWalker in `setTimeout(0)`. `_tgt.closest('.page-content')` ensures focus goes to whichever page owns `delBlock` after reflow
- `pc.focus({ preventScroll: true })` + TreeWalker cursor in `setTimeout(0)` + `setTimeout(_scrollCursorIntoView, 60)`

### `_scrollCursorIntoView()` helper (June 2026)
- Shared function called after every cross-page focus switch (Backspace, Delete, all four arrow keys)
- Reads cursor `getBoundingClientRect()` vs `#editor-wrap-left` bounds; scrolls by minimum needed with `behavior:'smooth'`
- Arrow key handlers call it directly (cursor is placed synchronously); Backspace/Delete call via `setTimeout(..., 60)` to let reflow settle first

### Spell check / Grammarly suppression (June 2026)
- Each `.page-content` created with: `setAttribute('spellcheck','false')`, `autocorrect/autocomplete/autocapitalize off`, `data-gramm="false"`, `data-gramm_editor="false"`, `data-enable-grammarly="false"`
- CSS: `.page-content::spelling-error { text-decoration:none !important }` + `::grammar-error` + `-webkit-` prefixed variants
- Both JS attribute AND CSS needed — Chrome can override `spellcheck=false`; Grammarly extension ignores it without `data-gramm`

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

### Deployed (10 functions — Hobby plan limit is 12)
`writing.js`, `summarize.js`, `interpret.js`, `lyrics.js`, `extract.js`, `transcribe.js`, `homework.js`, `checker.js`, `translate.js`, `subscription.js`

`subscription.js` is now only the usage endpoint (this month's usage, `record-check`, `record-log`); it kept its old name so existing calls keep working.

### Merged (skip in deploy — handled via Vercel rewrites)
`api/ytsearch.js` → `summarize.js` | `api/musicnotes.js` → `lyrics.js` | `api/chat.js` → `interpret.js` | `api/citation.js` → `writing.js` | `api/textbook.js` → `writing.js`

### api/writing.js key modes
- `grammar`: minLen = 1 (no minimum)
- `academic`: preserves original content, no fabricated citations, ~same length as input
- `bullets`, `outline`, `studyguide`: use `MODEL_LARGE`, 4500 max tokens
- `cornell`: 4000 max tokens, returns JSON `{topic, rows[], summary}`

### api/summarize.js
- `mode:'transcribe'` → raw transcript (no AI summarization)

### api/extract.js
- PPTX: `fileType:'pptx'` → JSZip → `<a:t>` XML extraction
- Image OCR: Groq vision `MODEL_VISION` (`qwen/qwen3.8-27b`), see "AI provider" section above

---

## Theme — Light Mode Background
All pages use `--bg: #FAF9F6` in their `:root.light` block (warm off-white). Previously each page had its own value (`#F5F5FA`, `#F4F4FC`, `#F5EFE0`, `#eeeef6`, etc.). `notebook.html` uses light as default (`:root` not `:root.light`) — same value applied there.

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
