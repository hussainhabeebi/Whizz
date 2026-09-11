# Whizz Lead Intelligence Collector

This service runs the authenticated browser work for Whizz Lead Intelligence. Keep the main Whizz app on Cloudflare Workers/D1 and deploy this folder as a small Docker service (for example in Coolify).

## Required Whizz Worker config

Two are genuinely sensitive and must be set as **Secrets** (Cloudflare dashboard → Workers & Pages → whizz → Settings → Variables and Secrets, type "Secret", or `wrangler secret put`) — never commit these:

- `LEAD_INTELLIGENCE_KEY` — long random secret used to AES-GCM encrypt directory credentials.
- `LEAD_COLLECTOR_TOKEN` — shared bearer token used in both directions.

The other two are just URLs, not credentials, so they're committed as plain `[vars]` in `wrangler.toml` instead of a dashboard-only variable — this repo auto-deploys via Cloudflare Workers Builds on every push, and a deploy re-applies `wrangler.toml` each time, which silently drops any variable that was only ever added through the dashboard UI (not tracked in the repo) rather than as a Secret:

- `LEAD_COLLECTOR_URL` — public HTTPS URL of this collector service.
- `LEAD_INTELLIGENCE_CALLBACK_URL` — `https://YOUR-WHIZZ-DOMAIN/api/lead-intelligence/callback`.

If either of those changes (e.g. the collector moves to a new host), update `wrangler.toml` and redeploy rather than editing it in the dashboard — a dashboard-only edit will be overwritten by the next automated build.

## Collector environment

- `LEAD_COLLECTOR_TOKEN` — same shared token as the Worker.
- `SESSION_DIR=/data/sessions` — mount this directory as persistent storage so login sessions survive restarts.
- `MAX_CONCURRENT_JOBS=1` — how many crawl jobs may run at once. Each job launches its own headless Chromium instance (the main RAM cost), so this is the primary lever for controlling peak memory usage — keep it at 1 on a small instance. Extra jobs queue in-memory and run once a slot frees up instead of piling up.
- `MAX_PROFILES_PER_RUN=40` — safety limit per source/run.
- `REQUEST_DELAY_MS=1800` — delay between directory/marketplace page requests.
- Optional login URL overrides: `PCEXPORTERS_LOGIN_URL`, `HANDELOT_LOGIN_URL`, `KADORF_LOGIN_URL`.
- `KASPI_MAX_PAGES_PER_BRAND=4` — how many search-result pages to paginate through per brand on Kaspi.kz before moving to the next brand.

## Kaspi.kz (Kazakhstan)

Kaspi.kz is a public marketplace — no `directory_accounts` username/password is used. Instead, save a brand watchlist (e.g. `JBL, Dyson, Samsung`) from the "Directory Sources" tab (or search one ad hoc from Contact Discovery); each run works per brand in two possible ways:

1. **Apify discovery (preferred, when `APIFY_TOKEN` is set)** — calls the [`isolovyev/marketplace-seller-leads`](https://apify.com/isolovyev/marketplace-seller-leads) actor (Kaspi platform) to get a reliable list of real seller store pages for the brand, sidestepping the issues below with our own search crawl (most likely: a fresh headless session has no city/zone cookie, so Kaspi may show an interstitial or different results than a real browser). We still visit each returned seller page ourselves with Playwright — the actor's own output doesn't include phone/WhatsApp/Telegram, only store identity/rating/review count, which gets merged into the record's `activity` field.
2. **Direct crawl (fallback, used when Apify isn't configured or a call fails)** — searches Kaspi.kz directly, paginates results, opens each product page, follows the seller link(s) it lists, then opens the seller's own page. This is what's described further below.

### Apify config

- `APIFY_TOKEN` — your Apify API token. Without this, Kaspi runs always use the direct crawl fallback.
- `APIFY_KASPI_ACTOR_ID` — defaults to `isolovyev~marketplace-seller-leads`.
- `APIFY_KASPI_INPUT_JSON` — optional override for the actor's input body (JSON string, `{{brand}}` is substituted with the search brand). The built-in default (`{"searchQueries":["{{brand}}"],"platforms":["kaspi"],"maxPagesPerQuery":3,"maxSellersPerPlatform":40}`) is a **best-effort guess** at the actor's real input schema — `apify.com` is unreachable from this codebase's dev environment, so it was never verified against the actor's actual "Input"/"API" tab. If Kaspi runs error out or Apify discovery silently returns nothing (falling back to the direct crawl), open that tab on the actor's Apify page, copy its real input JSON, and set `APIFY_KASPI_INPUT_JSON` to match.

### Direct crawl details

The `productLinkPattern` and `merchantLinkPattern` in `server.js` have been verified against real Kaspi.kz URLs (`/shop/p/<slug>-<id>/?...&m=<merchantId>&...` for a product, `/shop/m/<merchantId>/...` for its seller). The search URL's pagination (`&page=N`) has **not** been separately confirmed — if a brand search only ever returns page-1 results, that's likely why; the code fails safe in that case (it just stops paginating early rather than erroring) but won't reach deeper pages until confirmed/fixed.

## Verification behavior

The collector does **not** bypass CAPTCHA, Cloudflare challenges, 2FA, device verification, or similar controls. If a challenge is detected, it returns `verification_required` to Whizz and stores the current browser session. The Whizz UI exposes the verification URL/status and the run can be retried after the account has been verified through the platform's normal process.

## Resource limits

For a small deployment, start with one collector instance, one concurrent run, about 512 MB–1 GB RAM, and conservative CPU limits. Browser jobs are intentionally capped and throttled so they do not compete heavily with the rest of the Whizz stack.
