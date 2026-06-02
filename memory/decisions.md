# Architecture Decisions

## Deployment
- **Vercel REST API only** (no CLI — northstar account type incompatible with CLI)
- All API calls require `?teamId=team_wzre1x9ppjkxflBBYcJOdJgG`
- Always edit from temp deploy folder; original path has apostrophe causing EPERM errors

## Frontend
- **No build step** — pure HTML/CSS/JS; CSS and JS inline in HTML or in css/js/ files
- **index.html** is marketing-only (no live tools); live tools live in study.html
- **Single index.html per page** — no framework, no bundler
- **CSS custom properties** for dark/light theming via `data-theme` on `<html>`

## Auth & Data
- **Firebase Auth** for sign-in (email + Google); persistence LOCAL on auth pages
- **Firestore** for cross-device sync (notepad_notes, notepad_folders, history collections)
- **localStorage** as primary cache; Firestore as sync layer
- **GNSync (js/cloud-sync.js)** — shared module loaded by history/my-notes/dashboard pages
- **UID fallback** — `findUid()` scans localStorage; `ensureUid()` creates local_{ts}_{rand} for signed-out saves

## AI / APIs
- **Groq** as primary LLM provider (llama-3.3-70b-versatile for text, llama-4-scout for vision, whisper for audio)
- **Supadata** for YouTube transcript fetching
- **No Gemini** (API key in env but unused)
- **api/writing.js** handles: improve/grammar/tone/paraphrase/shorten/expand/highlight/format/code/docformat/academic/email/cornell/math/inline
- **api/summarize.js** handles: transcribe/summarize/notes/quizzes/flashcards/highlight

## Monetization
- **Stripe** in test mode; monthly $12.99 (`price_1TZMytFzUKNvR71hbVBxf0Lc`), yearly $99.99 (`price_1TZMytFzUKNvR71hXvErlp8s`)
- **Ad gate** — showHwAdGated() → guests capped at 3/day, signed-in free unlimited, Pro no ads
- **No sign-in walls** — every feature free with ads

## Notepad
- **Sidebar drag-and-drop**: top/mid/bot zones; mid = split-screen merge; uses _dropType var (not class-based)
- **Text selection popup**: AI modes (Define/Interpret/Comprehend/Grammar) + 6-color manual highlights
- **Statusbar**: ⚡ Convert ▾ (code format modal) + ✦ Highlight ▾ (AI full-note highlight)
- **➕ Add Note ▾**: position:fixed dropdown outside sidebar overflow clip

## Flashcards
- UID fallback ensures saves work even signed out
- summarize.js flashcards mode returns {flashcards:[]} (parsed server-side)
- Two-step note selection in flashcards.html and history.html before creating deck
