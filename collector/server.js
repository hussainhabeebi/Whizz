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
    name: 'Kaspi.kz', requiresAuth: false, home: 'https://kaspi.kz/shop',
    searchUrl: (query, pageNum) => `https://kaspi.kz/shop/search/?text=${encodeURIComponent(query)}&page=${pageNum}`,
    productLinkPattern: /\/shop\/p\/[^/?#]+/i,
    merchantLinkPattern: /\/shop\/(?:info|reviews)\/merchant/i,
    maxPagesPerBrand: KASPI_MAX_PAGES_PER_BRAND,
    defaultBrands: ['JBL', 'Dyson', 'Samsung', 'Xiaomi', 'Apple', 'Sony', 'Bosch', 'Philips']
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
  const merchantLinks = [...new Set(hrefs.filter(h => cfg.merchantLinkPattern.test(h)))].slice(0, 3);
  return { links: merchantLinks, challenge: false, productTitle };
}

async function extractKaspiMerchant(page, brand, productTitle) {
  const body = clean(await page.locator('body').innerText().catch(() => ''));
  const hrefs = await pageHrefs(page);
  const title = clean(await page.locator('h1').first().innerText().catch(() => '')) || clean(await page.title().catch(() => ''));
  const company = title.replace(/\s*[-|].*$/, '').trim();
  const telLink = hrefs.find(h => /^tel:/i.test(h));
  const phone = clean((telLink || '').replace(/^tel:/i, '')) || firstMatch(body, /(?:Телефон|Тел\.?|Phone)\s*:?\s*([+()\d][+()\d\s.-]{6,}\d)/i);
  return {
    company, contactName: '', country: 'Kazakhstan',
    email: firstMatch(body, /\b([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\b/i),
    phone, website: '', whatsapp: extractWhatsapp(hrefs, body), telegram: extractTelegram(hrefs, body),
    brand, productInterest: productTitle || brand, activity: 'Marketplace seller (Kaspi.kz)',
    profileUrl: page.url(), verified: /официальн|verified|надежный продавец/i.test(body),
    lastActivityAt: new Date().toISOString(), source: 'kaspi'
  };
}

async function runKaspiJob(job, cfg) {
  const brands = (job.credentials?.extra?.brands?.length ? job.credentials.extra.brands : cfg.defaultBrands).slice(0, 15);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: 'Whizz-Lead-Collector/1.0 (+authorized marketplace research)' });
  const page = await context.newPage();
  const items = [];
  const seenMerchants = new Set();
  const bail = async (verificationUrl) => {
    await callback(job.callbackUrl, { source: 'kaspi', status: 'verification_required', verificationUrl, items });
    return { status: 'verification_required', verificationUrl, itemsCollected: items.length };
  };
  try {
    outer: for (const brand of brands) {
      if (items.length >= MAX_PROFILES) break;
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
    await callback(job.callbackUrl, { source: 'kaspi', status: 'completed', items });
    return { status: 'completed', count: items.length };
  } catch (error) {
    await callback(job.callbackUrl, { source: 'kaspi', status: 'error', error: error.message, items });
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
  if (cfg.requiresAuth === false) return runKaspiJob(job, cfg);
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

function processQueue() {
  if (runningJobs >= MAX_CONCURRENT_JOBS || !jobQueue.length) return;
  const job = jobQueue.shift();
  runningJobs++;
  runJob(job).catch(err => console.error('collector job failed', err)).finally(() => {
    runningJobs--;
    processQueue();
  });
}

app.get('/health', (_req, res) => res.json({ ok: true, service: 'whizz-lead-collector', runningJobs, queued: jobQueue.length }));
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
