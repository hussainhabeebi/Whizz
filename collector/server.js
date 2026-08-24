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

app.get('/health', (_req, res) => res.json({ ok: true, service: 'whizz-lead-collector' }));
app.post('/', async (req, res) => {
  if (!authOk(req)) return res.status(401).json({ error: 'Unauthorized' });
  const job = req.body || {};
  try { sourceConfig(job.source); } catch (e) { return res.status(400).json({ error: e.message }); }
  res.status(202).json({ ok: true, status: 'syncing' });
  runJob(job).catch(err => console.error('collector job failed', err));
});

app.listen(PORT, '0.0.0.0', () => console.log(`Whizz lead collector listening on ${PORT}`));
