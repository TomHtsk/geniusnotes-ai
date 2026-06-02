# Current Project State — GeniusNotes.ai

## Live URL
https://geniusnotes-ai.vercel.app (also geniusnotes.ai)

## Working Directory
`C:\Users\nmntx\AppData\Local\Temp\geniusnotes-deploy\`
(Always edit here — original path has apostrophe causing EPERM errors)

## Architecture
- **index.html** — Marketing landing page (no live tools)
- **study.html** — Main app: 9-panel carousel (PANEL_COUNT=9)
- **notepad.html** — Paper editor with sidebar, folders, export, AI tools
- **dashboard.html** — Persistent sidebar layout, stats, Pomodoro
- **history.html** — Per-user history with Firestore sync (GNSync)
- **flashcards.html / create-deck.html / play-deck.html** — Flashcard system
- **meetings.html** — Meeting capture workflow
- **my-notes.html** — Notes grid
- **passwords.html** — Vault with PIN lock
- **signin.html / signup.html / reset.html** — Firebase Auth
- **api/** — Vercel serverless functions (Groq + Stripe + Firebase)
- **js/cloud-sync.js** — GNSync shared Firestore sync module

## Key Systems
- **Auth:** Firebase (email/password + Google), `geniusnotes-ai` project
- **AI:** Groq API (llama-3.3-70b-versatile, llama-4-scout vision, whisper)
- **Payments:** Stripe (test mode active), monthly $12.99 / yearly $99.99
- **Sync:** Firestore real-time via GNSync + notepad's own initCloudSync()
- **Deployment:** Vercel REST API (no CLI), team_wzre1x9ppjkxflBBYcJOdJgG

## Unresolved Issues
- Hash-to-panel mapping bug in study.html (pre-existing, not yet fixed)
- Stripe secret key was exposed in chat — needs rotation in Vercel env
- `play-deck.html` exists in deploy but not documented in CLAUDE.md

## Last Session
Memory system initialized (first session using this workflow).
