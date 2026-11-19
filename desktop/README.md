# Whizz Desktop

A native Windows app wrapping the same Whizz web app (`index.html`, copied in at build time — not duplicated by hand), with a bounded set of features kept usable offline:

- **Works offline**: Leads/contacts (view, add, edit, delete), Sales Invoices (stored list, customer matches, by-lead report, import), Audience Segments, Country-Language Map, marking a lead converted. Reads are served from a local SQLite mirror; writes made while offline are queued and replayed automatically once back online.
- **Needs internet, same as the website**: sending WhatsApp/Telegram/email, live Chatwoot conversations, Meta template management, the Sales/ERP live pull, Lead Intelligence. These show a clear "needs internet" error when offline rather than silently failing.

## First run — pairing

The desktop app has no password of its own. In Whizz on the web (already signed in via your normal Cloudflare Access login), click the monitor icon next to your name in the sidebar → **Desktop App** → **Generate Pairing Code**. Enter that code in the desktop app's pairing screen to connect it.

## Developing

```
npm install
npm start        # copies index.html from the repo root, then launches Electron
```

## Building the Windows installer

```
npm run build:win
```

This also runs on `windows-latest` in CI (`.github/workflows/build-desktop.yml`) — that's the guaranteed way to get a signed-or-not `.exe`, since building a Windows installer from a non-Windows machine isn't reliable without a full Windows toolchain.

## How it's structured

- `src/main.js` — Electron entry point: starts the local server, the background sync loop, and the window.
- `src/localServer.js` — a tiny local HTTP server the renderer (`dist/index.html`, same relative `fetch('/api/...')` calls as the website) talks to instead of the internet directly. Per path, it either serves/queues against the local SQLite mirror (`src/db.js`, `src/syncableResources.js`) or transparently proxies to the real Worker, attaching the stored pairing token.
- `src/syncLoop.js` — periodically drains queued offline writes once connectivity returns.
- `src/authStore.js` / `src/config.js` — the pairing token (via Electron's OS-level `safeStorage`) and the real Worker's base URL.

Nothing here duplicates the Worker's own business logic — the desktop app is a client of the exact same REST API the browser already uses, with a local-first read/write layer bolted on for the resources listed above.
