# Whizz Lead Intelligence Collector

This service runs the authenticated browser work for Whizz Lead Intelligence. Keep the main Whizz app on Cloudflare Workers/D1 and deploy this folder as a small Docker service (for example in Coolify).

## Required Whizz Worker secrets

- `LEAD_INTELLIGENCE_KEY` — long random secret used to AES-GCM encrypt directory credentials.
- `LEAD_COLLECTOR_URL` — public HTTPS URL of this collector service.
- `LEAD_COLLECTOR_TOKEN` — shared bearer token used in both directions.
- `LEAD_INTELLIGENCE_CALLBACK_URL` — `https://YOUR-WHIZZ-DOMAIN/api/lead-intelligence/callback`.

Set secrets with your normal Cloudflare deployment process. Do not commit passwords or the encryption key.

## Collector environment

- `LEAD_COLLECTOR_TOKEN` — same shared token as the Worker.
- `SESSION_DIR=/data/sessions` — mount this directory as persistent storage so login sessions survive restarts.
- `MAX_CONCURRENT_JOBS=1` — how many crawl jobs may run at once. Each job launches its own headless Chromium instance (the main RAM cost), so this is the primary lever for controlling peak memory usage — keep it at 1 on a small instance. Extra jobs queue in-memory and run once a slot frees up instead of piling up.
- `MAX_PROFILES_PER_RUN=40` — safety limit per source/run.
- `REQUEST_DELAY_MS=1800` — delay between directory/marketplace page requests.
- Optional login URL overrides: `PCEXPORTERS_LOGIN_URL`, `HANDELOT_LOGIN_URL`, `KADORF_LOGIN_URL`.
- `KASPI_MAX_PAGES_PER_BRAND=4` — how many search-result pages to paginate through per brand on Kaspi.kz before moving to the next brand.

## Kaspi.kz (Kazakhstan)

Kaspi.kz is a public marketplace — no `directory_accounts` username/password is used. Instead, save a brand watchlist (e.g. `JBL, Dyson, Samsung`) from the "Directory Sources" tab; each run searches Kaspi.kz for every brand, paginates the results, opens each product page, follows the seller/merchant link(s) it lists, then opens the merchant's own page to pull phone, WhatsApp, Telegram handle, and the registered company name — not just what's visible on the search results page.

The Kaspi `searchUrl`/`productLinkPattern`/`merchantLinkPattern` in `server.js` are based on Kaspi's known public URL structure but have not been verified against the live DOM from this codebase's dev environment (kaspi.kz was unreachable there). Run a test sync and check the collector logs/output items before relying on it — adjust the regex patterns in `CONFIG.kaspi` if Kaspi's markup differs.

## Verification behavior

The collector does **not** bypass CAPTCHA, Cloudflare challenges, 2FA, device verification, or similar controls. If a challenge is detected, it returns `verification_required` to Whizz and stores the current browser session. The Whizz UI exposes the verification URL/status and the run can be retried after the account has been verified through the platform's normal process.

## Resource limits

For a small deployment, start with one collector instance, one concurrent run, about 512 MB–1 GB RAM, and conservative CPU limits. Browser jobs are intentionally capped and throttled so they do not compete heavily with the rest of the Whizz stack.
