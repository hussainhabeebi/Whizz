import express from 'express';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const app = express();
app.use(express.json({ limit: '2mb' }));
const PORT = Number(process.env.PORT || 3000);
const TOKEN = process.env.LEAD_COLLECTOR_TOKEN || '';
const SESSION_DIR = process.env.SESSION_DIR || '/data/sessions';
const MAX_PROFILES = Math.max(5, Math.min(Number(process.env.MAX_PROFILES_PER_RUN || 40), 150));
const DELAY_MS = Math.max(800, Number(process.env.REQUEST_DELAY_MS || 1800));
const KASPI_MAX_PAGES_PER_BRAND = Math.max(1, Math.min(Number(process.env.KASPI_MAX_PAGES_PER_BRAND || 4), 10));
// 2GIS runs one country TLD at a time — kz/ru/uz/kg/etc. Default to Kazakhstan since that's this
// app's primary CIS market (matches Kaspi.kz); override per-deployment if you mostly search a
// different country.
const TWOGIS_DOMAIN = process.env.TWOGIS_DOMAIN || '2gis.kz';
const TWOGIS_MAX_ITEMS = Math.max(1, Math.min(Number(process.env.TWOGIS_MAX_ITEMS || 20), 50));
// A realistic desktop Chrome UA, unlike the other sources' self-identifying "Whizz-Lead-Collector"
// UA — 2GIS's anti-bot check is exactly what blocked the Apify actor over a flagged proxy pool, so
// announcing ourselves as a bot here would likely hit the same wall immediately.
const TWOGIS_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Optional: use the Apify "marketplace-seller-leads" actor (apify.com/isolovyev/marketplace-seller-leads)
// to discover Kaspi.kz sellers for a brand — more reliable than our own search/product crawl, which
// is liable to break on city/zone cookie state or DOM changes. When configured, this replaces just the
// *discovery* step; we still visit each returned seller page ourselves with Playwright for the deep
// contact fields (phone/WhatsApp/Telegram) the actor doesn't provide. Falls back to the direct crawl
// (collectKaspiProductLinks/collectKaspiMerchantLinks below) when unset or when a call fails.
const APIFY_TOKEN = process.env.APIFY_TOKEN || '';
const APIFY_KASPI_ACTOR_ID = process.env.APIFY_KASPI_ACTOR_ID || 'isolovyev~marketplace-seller-leads';
// NOT verified against the actor's real input schema (apify.com is unreachable from this codebase's
// dev environment) — this is a best-effort guess from the actor's public listing description
// (search queries / platforms / max pages / max sellers / cities). If Apify calls return errors or
// consistently zero sellers, open the actor's "API" tab on apify.com for its real input JSON and set
// APIFY_KASPI_INPUT_JSON to override this, using "{{brand}}" as the substitution placeholder.
const DEFAULT_APIFY_KASPI_INPUT = JSON.stringify({
  searchQueries: ['{{brand}}'],
  platforms: ['kaspi'],
  maxPagesPerQuery: 3,
  maxSellersPerPlatform: 40
});

const CONFIG = {
  pcexporters: {
    name: 'PC Exporters', home: 'https://www.pcexporters.com/',
    login: process.env.PCEXPORTERS_LOGIN_URL || 'https://www.pcexporters.com/',
    profilePattern: /\/(company|member|profile|buyers?|suppliers?)\//i
  },
  handelot: {
    name: 'Handelot', home: 'https://handelot.com/',
    login: process.env.HANDELOT_LOGIN_URL || 'https://handelot.com/',
    profilePattern: /\/(company|member|profile|requests?|offers?)\//i
  },
  kadorf: {
    name: 'Kadorf', home: 'https://kadorf.com/',
    login: process.env.KADORF_LOGIN_URL || 'https://kadorf.com/',
    profilePattern: /\/company\//i
  },
  // Kaspi.kz is a public Kazakh marketplace — no login. We search per brand, open each
  // product page, follow the seller/merchant link(s) listed on it, then open the merchant's
  // own page for deep contact details (phone / WhatsApp / Telegram / registered company name).
  // NOTE: kaspi.kz is unreachable from this dev sandbox (egress-blocked), so these URL/selector
  // patterns are based on Kaspi's known public URL structure and have NOT been verified against
  // the live DOM. Confirm searchUrl/productLinkPattern/merchantLinkPattern against the real site
  // (or adjust from collector logs) before relying on this in production.
  kaspi: {
    // Verified against the live site: a product page is https://kaspi.kz/shop/p/<slug>-<id>/?c=<cityId>&m=<merchantId>&ms=true
    // and its seller's storefront is https://kaspi.kz/shop/m/<merchantId>/... — confirmed 2026-09.
    name: 'Kaspi.kz', requiresAuth: false, home: 'https://kaspi.kz/shop',
    searchUrl: (query, pageNum) => `https://kaspi.kz/shop/search/?text=${encodeURIComponent(query)}&page=${pageNum}`,
    productLinkPattern: /\/shop\/p\/[^/?#]+/i,
    merchantLinkPattern: /\/shop\/m\/\d+/i,
    maxPagesPerBrand: KASPI_MAX_PAGES_PER_BRAND,
    defaultBrands: ['JBL', 'Dyson', 'Samsung', 'Xiaomi', 'Apple', 'Sony', 'Bosch', 'Philips']
  },
  // 2GIS is a public local-business directory (no login) — replaces both a paid Catalog API key
  // and an Apify actor that hit a residential-proxy wall (`twogis: transport failure: ProxyError`)
  // by using our own headless browser instead, the same way Kaspi does.
  // NOT verified against the live site (2gis.kz is unreachable from this dev sandbox) — the search
  // URL, result-link pattern and TWOGIS_DOMAIN default are a best-effort guess at 2GIS's public
  // URL structure. Confirm against a real search (or adjust from collector logs) before relying on
  // this in production; folding the location into the free-text query avoids having to solve
  // per-city URL slugs, but is worth checking gives the same results a real user search would.
  '2gis': {
    name: '2GIS', requiresAuth: false, home: `https://${TWOGIS_DOMAIN}/`,
    searchUrl: (query, location) => `https://${TWOGIS_DOMAIN}/search/${encodeURIComponent([query, location].filter(Boolean).join(' '))}`,
    listingLinkPattern: /\/firm\/\d+/i,
    maxItemsPerSearch: TWOGIS_MAX_ITEMS
  }
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
function authOk(req) { return !TOKEN || req.headers.authorization === `Bearer ${TOKEN}`; }
function clean(v) { return String(v || '').replace(/\s+/g, ' ').trim(); }
function firstMatch(text, re) { const m = text.match(re); return m ? clean(m[1]) : ''; }
function sourceConfig(source) {
  const cfg = CONFIG[String(source || '').toLowerCase()];
  if (!cfg) throw new Error('Unsupported source');
  return cfg;
}

async function callback(url, payload) {
  if (!url) return;
  await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
    body: JSON.stringify(payload)
  }).catch(() => {});
}

function extractWhatsapp(hrefs, text) {
  const link = hrefs.find(h => /wa\.me\/|whatsapp\.com\/send/i.test(h));
  if (link) {
    const m = link.match(/(?:wa\.me\/|[?&]phone=)(\d{6,15})/i);
    if (m) return `+${m[1]}`;
  }
  return firstMatch(text, /whats\s*app\s*:?\s*([+()\d][+()\d\s.-]{6,}\d)/i);
}

function extractTelegram(hrefs, text) {
  const link = hrefs.find(h => /(?:^|\/)t(?:elegram)?\.me\//i.test(h));
  if (link) {
    const m = link.match(/t(?:elegram)?\.me\/([A-Za-z0-9_]{4,32})/i);
    if (m) return `@${m[1]}`;
  }
  const m = firstMatch(text, /telegram\s*:?\s*@([A-Za-z0-9_]{4,32})/i);
  return m ? `@${m}` : '';
}

async function pageHrefs(page) {
  return page.locator('a[href]').evaluateAll(nodes => nodes.map(a => a.href)).catch(() => []);
}

// Search a brand keyword on Kaspi.kz, paginating until a page returns no new product links
// (or the per-brand page cap is hit) so results aren't limited to the first "surface" page.
async function collectKaspiProductLinks(page, cfg, brand) {
  const found = new Set();
  for (let pageNum = 1; pageNum <= cfg.maxPagesPerBrand; pageNum++) {
    await page.goto(cfg.searchUrl(brand, pageNum), { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
    await sleep(DELAY_MS);
    if (await hasChallenge(page)) return { links: [...found], challenge: true, verificationUrl: page.url() };
    const hrefs = await pageHrefs(page);
    const pageLinks = hrefs.filter(h => cfg.productLinkPattern.test(h));
    const before = found.size;
    for (const href of pageLinks) found.add(href);
    if (found.size === before) break; // no new listings — end of results for this brand
  }
  return { links: [...found], challenge: false };
}

// Open a product page and pull out the seller/merchant sub-page link(s) it lists — the
// deep hop from "what's for sale" to "who is selling it".
async function collectKaspiMerchantLinks(page, cfg, productUrl) {
  await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
  await sleep(DELAY_MS);
  if (await hasChallenge(page)) return { links: [], challenge: true, verificationUrl: page.url() };
  const hrefs = await pageHrefs(page);
  const productTitle = clean(await page.locator('h1').first().innerText().catch(() => ''));
  const merchantIds = new Set();
  for (const href of hrefs) {
    const m = href.match(/\/shop\/m\/(\d+)/i);
    if (m) merchantIds.add(m[1]);
  }
  // Kaspi resolves a default seller straight into the product page's own URL (?m=<merchantId>)
  // once it loads client-side — capture that too, since "other sellers" for a listing aren't
  // always plain <a href> elements on a JS-rendered page.
  const resolved = page.url().match(/[?&]m=(\d+)/i);
  if (resolved) merchantIds.add(resolved[1]);
  const merchantLinks = [...merchantIds].slice(0, 3).map(id => `https://kaspi.kz/shop/m/${id}/`);
  return { links: merchantLinks, challenge: false, productTitle };
}

async function extractKaspiMerchant(page, brand, productTitle, apifyMeta = null) {
  const body = clean(await page.locator('body').innerText().catch(() => ''));
  const hrefs = await pageHrefs(page);
  const title = clean(await page.locator('h1').first().innerText().catch(() => '')) || clean(await page.title().catch(() => ''));
  const company = title.replace(/\s*[-|].*$/, '').trim() || apifyMeta?.name || '';
  const telLink = hrefs.find(h => /^tel:/i.test(h));
  const phone = clean((telLink || '').replace(/^tel:/i, '')) || firstMatch(body, /(?:Телефон|Тел\.?|Phone)\s*:?\s*([+()\d][+()\d\s.-]{6,}\d)/i);
  const activity = apifyMeta?.rating != null
    ? `Marketplace seller (Kaspi.kz) · ★${apifyMeta.rating}${apifyMeta.reviews != null ? ` (${apifyMeta.reviews} reviews)` : ''}`
    : 'Marketplace seller (Kaspi.kz)';
  return {
    company, contactName: '', country: 'Kazakhstan',
    email: firstMatch(body, /\b([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\b/i),
    phone, website: '', whatsapp: extractWhatsapp(hrefs, body), telegram: extractTelegram(hrefs, body),
    brand, productInterest: productTitle || brand, activity,
    profileUrl: page.url(), verified: /официальн|verified|надежный продавец/i.test(body),
    lastActivityAt: new Date().toISOString(), source: 'kaspi'
  };
}

// Runs the Apify actor synchronously and returns its dataset items. Always returns { sellers,
// error } rather than throwing/swallowing — `error` (when set) is surfaced all the way up into
// the Whizz UI notice, so a bad actor ID / token / input schema is visible without needing to
// check the collector's own logs.
async function fetchKaspiSellersFromApify(brand) {
  if (!APIFY_TOKEN) return { sellers: [], error: null };
  let input;
  try {
    const template = process.env.APIFY_KASPI_INPUT_JSON || DEFAULT_APIFY_KASPI_INPUT;
    input = JSON.parse(template.replaceAll('{{brand}}', brand));
  } catch (error) {
    return { sellers: [], error: `Invalid APIFY_KASPI_INPUT_JSON: ${error.message}` };
  }
  const url = `https://api.apify.com/v2/acts/${APIFY_KASPI_ACTOR_ID}/run-sync-get-dataset-items?token=${encodeURIComponent(APIFY_TOKEN)}&timeout=120`;
  try {
    // &timeout=120 above only bounds how long Apify lets the actor run — it does NOT bound how
    // long our own fetch() waits for a response. Without a client-side abort, a hung connection
    // here blocks this job (and everything queued behind it, since only one job runs at a time)
    // indefinitely instead of erroring out.
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(130000) });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('Apify Kaspi actor call failed', res.status, text);
      return { sellers: [], error: `HTTP ${res.status} calling actor "${APIFY_KASPI_ACTOR_ID}": ${text.slice(0, 200)}` };
    }
    const rows = await res.json().catch(() => []);
    const sellers = (Array.isArray(rows) ? rows : [])
      .filter(r => !r.platform || /kaspi/i.test(r.platform))
      .map(r => ({
        url: r.storeUrl || r.store_url || r.storeURL || r.url,
        name: r.store || r.name || r.legalFullName || '',
        rating: r.avgRating ?? r.rating, reviews: r.totalReviews ?? r.reviews
      }))
      .filter(r => r.url);
    return { sellers, error: null };
  } catch (error) {
    return { sellers: [], error: `Apify request failed: ${error.message}` };
  }
}

async function runKaspiJob(job, cfg) {
  const brands = (job.credentials?.extra?.brands?.length ? job.credentials.extra.brands : cfg.defaultBrands).slice(0, 15);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: 'Whizz-Lead-Collector/1.0 (+authorized marketplace research)' });
  const page = await context.newPage();
  const items = [];
  const seenMerchants = new Set();
  // Self-diagnosing summary so "why did this run find nothing" doesn't need a log round-trip —
  // it's folded into the completed callback's `note`.
  const diag = { apifyConfigured: !!APIFY_TOKEN, apifyBrandsUsed: 0, crawlBrandsUsed: 0, apifyLastError: null };
  const bail = async (verificationUrl) => {
    await callback(job.callbackUrl, { source: 'kaspi', status: 'verification_required', verificationUrl, items });
    return { status: 'verification_required', verificationUrl, itemsCollected: items.length };
  };
  try {
    outer: for (const brand of brands) {
      if (items.length >= MAX_PROFILES) break;

      // Prefer Apify for discovery — it doesn't depend on a city/zone cookie the way a fresh
      // headless session does, and returns a list of real seller pages directly.
      const apifyResult = await fetchKaspiSellersFromApify(brand);
      if (apifyResult.error) diag.apifyLastError = apifyResult.error;
      if (apifyResult.sellers.length) {
        diag.apifyBrandsUsed++;
        for (const seller of apifyResult.sellers) {
          if (items.length >= MAX_PROFILES) break outer;
          if (seenMerchants.has(seller.url)) continue;
          seenMerchants.add(seller.url);
          await sleep(DELAY_MS);
          await page.goto(seller.url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
          if (await hasChallenge(page)) return await bail(page.url());
          const item = await extractKaspiMerchant(page, brand, '', seller);
          if (item.company) items.push(item);
        }
        continue; // Apify covered discovery for this brand — skip the direct-crawl fallback below
      }

      // Fallback: Apify not configured (or returned nothing) — crawl search -> product -> merchant.
      diag.crawlBrandsUsed++;
      const search = await collectKaspiProductLinks(page, cfg, brand);
      if (search.challenge) return await bail(search.verificationUrl);
      for (const productUrl of search.links) {
        if (items.length >= MAX_PROFILES) break outer;
        await sleep(DELAY_MS);
        const detail = await collectKaspiMerchantLinks(page, cfg, productUrl);
        if (detail.challenge) return await bail(detail.verificationUrl);
        for (const merchantUrl of detail.links) {
          if (items.length >= MAX_PROFILES) break outer;
          if (seenMerchants.has(merchantUrl)) continue;
          seenMerchants.add(merchantUrl);
          await sleep(DELAY_MS);
          await page.goto(merchantUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
          if (await hasChallenge(page)) return await bail(page.url());
          const item = await extractKaspiMerchant(page, brand, detail.productTitle);
          if (item.company) items.push(item);
        }
      }
    }
    const note = `Discovery: ${diag.apifyConfigured ? `Apify used for ${diag.apifyBrandsUsed} brand(s), direct crawl fallback for ${diag.crawlBrandsUsed}` : `APIFY_TOKEN not set — direct crawl only (${diag.crawlBrandsUsed} brand(s))`}.`
      + (diag.apifyLastError ? ` Apify error: ${diag.apifyLastError}` : '');
    await callback(job.callbackUrl, { source: 'kaspi', status: 'completed', items, note });
    return { status: 'completed', count: items.length, note };
  } catch (error) {
    await callback(job.callbackUrl, { source: 'kaspi', status: 'error', error: error.message, items });
    throw error;
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

// Search once (query + location folded into the free-text query — see the config comment above)
// and collect firm/listing links from the results page. 2GIS is a heavy client-side-rendered
// SPA, so 'domcontentloaded' alone likely fires before results actually paint — this waits for
// 'networkidle' too (falls back gracefully if that times out) and gives the page an extra beat
// before reading links, rather than assuming the DOM is done the instant the HTML arrives.
// Also: 2GIS's search results are commonly infinite-scroll rather than Kaspi's numbered ?page=N —
// this only reads what's present after that initial settle, which is a real limitation (fewer
// results than paging/scrolling through would give) until confirmed against the live site.
async function collect2GisListingLinks(page, cfg, query, location, maxItems) {
  const url = cfg.searchUrl(query, location);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => null);
  await sleep(DELAY_MS);
  if (await hasChallenge(page)) return { links: [], challenge: true, verificationUrl: page.url() };
  const hrefs = await pageHrefs(page);
  const links = [...new Set(hrefs.filter(h => cfg.listingLinkPattern.test(h)))].slice(0, maxItems);
  const pageTitle = clean(await page.title().catch(() => ''));
  return {
    links, challenge: false,
    diag: { requestedUrl: url, finalUrl: page.url(), pageTitle, hrefsSeen: hrefs.length, listingLinksMatched: links.length }
  };
}

// Pulls contact details off a single 2GIS firm page. Phone numbers on directory sites like this
// are often behind a "show phone" button rather than plain text/tel: links — if extraction keeps
// coming back empty on real runs, that's the first thing to check (add a page.click() on a
// "Показать телефон"/"Show phone" button before reading the body text).
async function extract2GisListing(page, query) {
  const body = clean(await page.locator('body').innerText().catch(() => ''));
  const hrefs = await pageHrefs(page);
  const title = clean(await page.locator('h1').first().innerText().catch(() => '')) || clean(await page.title().catch(() => ''));
  const company = title.replace(/\s*[-|].*$/, '').trim();
  const telLink = hrefs.find(h => /^tel:/i.test(h));
  const phone = clean((telLink || '').replace(/^tel:/i, '')) || firstMatch(body, /(?:Телефон|Тел\.?|Phone)\s*:?\s*([+()\d][+()\d\s.-]{6,}\d)/i);
  const website = (hrefs.find(h => /^https?:\/\//i.test(h) && !/2gis\.|google\.|apple\.|vk\.com|instagram\.com|facebook\.com/i.test(h)) || '').trim();
  const email = firstMatch(body, /\b([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\b/i);
  return {
    company, contactName: '', country: '',
    email, phone, website, whatsapp: extractWhatsapp(hrefs, body), telegram: extractTelegram(hrefs, body),
    brand: '', productInterest: query, activity: 'Local business directory (2GIS)',
    profileUrl: page.url(), verified: false, lastActivityAt: new Date().toISOString(), source: '2gis'
  };
}

async function run2GisJob(job, cfg) {
  const extra = job.credentials?.extra || {};
  const query = String(extra.query || '').trim();
  const location = String(extra.location || '').trim();
  const maxItems = Math.max(1, Math.min(Number(extra.limit) || cfg.maxItemsPerSearch, MAX_PROFILES));
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: TWOGIS_USER_AGENT, locale: 'ru-RU' });
  const page = await context.newPage();
  const items = [];
  try {
    if (!query) throw new Error('No search query configured for this 2GIS run');
    const search = await collect2GisListingLinks(page, cfg, query, location, maxItems);
    if (search.challenge) {
      await callback(job.callbackUrl, { source: '2gis', status: 'verification_required', verificationUrl: search.verificationUrl, items });
      return { status: 'verification_required', verificationUrl: search.verificationUrl, itemsCollected: 0 };
    }
    let listingsAttempted = 0, listingsWithCompany = 0;
    for (const listingUrl of search.links) {
      if (items.length >= maxItems) break;
      listingsAttempted++;
      await sleep(DELAY_MS);
      await page.goto(listingUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
      if (await hasChallenge(page)) {
        await callback(job.callbackUrl, { source: '2gis', status: 'verification_required', verificationUrl: page.url(), items });
        return { status: 'verification_required', verificationUrl: page.url(), itemsCollected: items.length };
      }
      const item = await extract2GisListing(page, query);
      if (item.company) { items.push(item); listingsWithCompany++; }
    }
    // Self-diagnosing summary so "why did this find nothing" doesn't need a raw log round-trip —
    // same idea as Kaspi's own run note. Especially useful here since every URL/selector in this
    // job is an unverified guess at 2GIS's real page structure (see collector/README.md).
    const note = `Search URL: ${search.diag.requestedUrl} → landed on ${search.diag.finalUrl} (title: "${search.diag.pageTitle}"). `
      + `Found ${search.diag.hrefsSeen} links on the page, ${search.diag.listingLinksMatched} matched the /firm/\\d+ pattern. `
      + `Opened ${listingsAttempted} listing(s), ${listingsWithCompany} yielded a company name.`
      + (items.length === 0 && search.diag.hrefsSeen > 0 && search.diag.listingLinksMatched === 0
        ? ' Zero matches suggests the listingLinkPattern guess is wrong for this page — check finalUrl/pageTitle above for what 2GIS actually returned (redirect, CAPTCHA-free block page, different URL structure, etc.) and adjust it in collector/server.js.'
        : '');
    await callback(job.callbackUrl, { source: '2gis', status: 'completed', items, note });
    return { status: 'completed', count: items.length, note };
  } catch (error) {
    await callback(job.callbackUrl, { source: '2gis', status: 'error', error: error.message, items });
    throw error;
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function hasChallenge(page) {
  const url = page.url().toLowerCase();
  if (/captcha|challenge|verify|turnstile|recaptcha/.test(url)) return true;
  const text = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
  return /captcha|verify you are human|security check|cloudflare verification|two-factor|2fa|enter.*code|one-time password/.test(text);
}

async function tryLogin(page, username, password) {
  if (!username || !password) return;
  const email = page.locator('input[type="email"],input[name*="email" i],input[name*="user" i],input[type="text"]').first();
  const pass = page.locator('input[type="password"]').first();
  if (!await pass.count()) return;
  if (await email.count()) await email.fill(username).catch(() => {});
  await pass.fill(password).catch(() => {});
  const submit = page.locator('button[type="submit"],input[type="submit"],button:has-text("Login"),button:has-text("Sign in")').first();
  if (await submit.count()) await Promise.allSettled([page.waitForLoadState('domcontentloaded', { timeout: 15000 }), submit.click()]);
  await sleep(1200);
}

async function profileLinks(page, cfg) {
  const base = new URL(cfg.home);
  const links = await page.locator('a[href]').evaluateAll((nodes) => nodes.map(a => ({ href: a.href, text: (a.textContent || '').trim() })));
  const out = [];
  for (const item of links) {
    try {
      const u = new URL(item.href);
      if (u.hostname !== base.hostname && !u.hostname.endsWith('.' + base.hostname.replace(/^www\./, ''))) continue;
      if (!cfg.profilePattern.test(u.pathname)) continue;
      const normalized = `${u.origin}${u.pathname}`;
      if (!out.some(x => x.url === normalized)) out.push({ url: normalized, label: item.text });
    } catch {}
  }
  return out.slice(0, MAX_PROFILES);
}

async function extractProfile(page, source, fallbackLabel = '') {
  const body = clean(await page.locator('body').innerText().catch(() => ''));
  const title = clean(await page.locator('h1').first().innerText().catch(() => '')) || clean(await page.title().catch(() => '')) || fallbackLabel;
  const email = firstMatch(body, /(?:Email|E-mail)\s*:?\s*([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i) || firstMatch(body, /\b([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\b/i);
  const phone = firstMatch(body, /(?:Phone|Mobile|Landline|Tel(?:ephone)?)\s*:?\s*([+()\d][+()\d\s.-]{6,}\d)/i);
  const website = firstMatch(body, /(?:Website|URL)\s*:?\s*(https?:\/\/[^\s]+|www\.[^\s]+)/i);
  const country = firstMatch(body, /(?:Country|Location|Address)\s*:?\s*([^\n|]{2,60})/i);
  const products = firstMatch(body, /(?:Products?|Categories|Product Categories)\s*:?\s*([^\n]{2,220})/i);
  const activity = firstMatch(body, /(?:Requested Products?|WTB|Wanted|Buying Request|Looking for)\s*:?\s*([^\n]{2,220})/i);
  const verified = /verified/i.test(body);
  return {
    company: title.replace(/\s*[-|].*$/, '').trim(), contactName: '', country,
    email, phone, website, brand: '', productInterest: products,
    activity, profileUrl: page.url(), verified, lastActivityAt: new Date().toISOString(), source
  };
}

async function runJob(job) {
  const source = String(job.source || '').toLowerCase();
  const cfg = sourceConfig(source);
  if (source === 'kaspi') return runKaspiJob(job, cfg);
  if (source === '2gis') return run2GisJob(job, cfg);
  const sessionFile = path.join(SESSION_DIR, `${source}.json`);
  await fs.mkdir(SESSION_DIR, { recursive: true });
  let storageState;
  try { await fs.access(sessionFile); storageState = sessionFile; } catch {}

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState, userAgent: 'Whizz-Lead-Collector/1.0 (+authorized business directory automation)' });
  const page = await context.newPage();
  try {
    await page.goto(cfg.login, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(DELAY_MS);
    await tryLogin(page, job.username, job.credentials?.password);

    if (await hasChallenge(page)) {
      await context.storageState({ path: sessionFile });
      await callback(job.callbackUrl, { source, status: 'verification_required', verificationUrl: page.url(), items: [] });
      return { status: 'verification_required', verificationUrl: page.url() };
    }

    await context.storageState({ path: sessionFile });
    await page.goto(cfg.home, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(DELAY_MS);
    if (await hasChallenge(page)) {
      await callback(job.callbackUrl, { source, status: 'verification_required', verificationUrl: page.url(), items: [] });
      return { status: 'verification_required', verificationUrl: page.url() };
    }

    let links = await profileLinks(page, cfg);
    // Kadorf exposes company profiles publicly; other sources may expose them only after login.
    // If no directory links are discoverable, return a useful status instead of hammering the site.
    if (!links.length) {
      const result = { status: 'completed', items: [], note: 'No permitted profile links discovered on the current authenticated page.' };
      await callback(job.callbackUrl, { source, ...result });
      return result;
    }

    const items = [];
    for (const link of links) {
      await sleep(DELAY_MS);
      await page.goto(link.url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
      if (await hasChallenge(page)) {
        await context.storageState({ path: sessionFile });
        await callback(job.callbackUrl, { source, status: 'verification_required', verificationUrl: page.url(), items });
        return { status: 'verification_required', verificationUrl: page.url(), itemsCollected: items.length };
      }
      const item = await extractProfile(page, source, link.label);
      if (item.company) items.push(item);
    }
    await context.storageState({ path: sessionFile });
    await callback(job.callbackUrl, { source, status: 'completed', items });
    return { status: 'completed', count: items.length };
  } catch (error) {
    await callback(job.callbackUrl, { source, status: 'error', error: error.message, items: [] });
    throw error;
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

// Each job launches its own headless Chromium instance (a few hundred MB+), so RAM scales with
// how many jobs run AT ONCE, not with how deep any single crawl goes. Cap concurrency instead of
// letting simultaneous requests (e.g. a Kaspi search landing next to a directory sync) each spawn
// their own browser — extra jobs wait in a small in-memory queue instead of piling up.
const MAX_CONCURRENT_JOBS = Math.max(1, Math.min(Number(process.env.MAX_CONCURRENT_JOBS || 1), 4));
let runningJobs = 0;
const jobQueue = [];

// Safety net: with only MAX_CONCURRENT_JOBS running, a single job that hangs (network call with
// no client-side timeout, an unexpected Playwright wait, etc.) blocks every other source's runs
// forever with no visible error — exactly what an un-timed-out fetch() did before this was added.
// This doesn't cancel the underlying work, but it frees the queue slot and reports a real error
// instead of leaving Whizz stuck on "syncing" indefinitely.
const JOB_TIMEOUT_MS = Math.max(60000, Number(process.env.JOB_TIMEOUT_MS || 8 * 60 * 1000));

function processQueue() {
  if (runningJobs >= MAX_CONCURRENT_JOBS || !jobQueue.length) return;
  const job = jobQueue.shift();
  runningJobs++;
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error(`Job timed out after ${JOB_TIMEOUT_MS}ms`)), JOB_TIMEOUT_MS));
  Promise.race([runJob(job), timeout])
    .catch(async err => {
      console.error('collector job failed', err);
      if (/timed out/i.test(err.message)) {
        await callback(job.callbackUrl, { source: String(job.source || '').toLowerCase(), status: 'error', error: err.message, items: [] }).catch(() => {});
      }
    })
    .finally(() => {
      runningJobs--;
      processQueue();
    });
}

app.get('/health', (_req, res) => res.json({ ok: true, service: 'whizz-lead-collector', runningJobs, queued: jobQueue.length, apifyConfigured: !!APIFY_TOKEN }));
app.post('/', async (req, res) => {
  if (!authOk(req)) return res.status(401).json({ error: 'Unauthorized' });
  const job = req.body || {};
  try { sourceConfig(job.source); } catch (e) { return res.status(400).json({ error: e.message }); }
  const queued = runningJobs >= MAX_CONCURRENT_JOBS;
  res.status(202).json({ ok: true, status: queued ? 'queued' : 'syncing' });
  jobQueue.push(job);
  processQueue();
});

app.listen(PORT, '0.0.0.0', () => console.log(`Whizz lead collector listening on ${PORT}`));
