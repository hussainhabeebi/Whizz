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
- `MAX_PROFILES_PER_RUN=40` — safety limit per source/run.
- `REQUEST_DELAY_MS=1800` — delay between directory page requests.
- Optional login URL overrides: `PCEXPORTERS_LOGIN_URL`, `HANDELOT_LOGIN_URL`, `KADORF_LOGIN_URL`.

## Verification behavior

The collector does **not** bypass CAPTCHA, Cloudflare challenges, 2FA, device verification, or similar controls. If a challenge is detected, it returns `verification_required` to Whizz and stores the current browser session. The Whizz UI exposes the verification URL/status and the run can be retried after the account has been verified through the platform's normal process.

## Resource limits

For a small deployment, start with one collector instance, one concurrent run, about 512 MB–1 GB RAM, and conservative CPU limits. Browser jobs are intentionally capped and throttled so they do not compete heavily with the rest of the Whizz stack.
