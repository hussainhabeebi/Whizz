const SOURCES = ['pcexporters','handelot','kadorf','kaspi','2gis'];
// Sources in this list are public marketplaces with no login: they're configured with a
// brand watchlist (e.g. JBL, Dyson) instead of a username/password.
const BRAND_SEARCH_SOURCES = ['kaspi'];
// Also runnable without a prior "configure credentials" step — each /run/:source call carries
// what it needs directly (Kaspi: brands to search; 2GIS: a query+location pair) rather than
// requiring a saved directory_accounts row first. Kaspi's run persists into a growing watchlist;
// 2GIS's is a single ad-hoc search that replaces whatever was there before (see runCollector).
const AD_HOC_SEARCH_SOURCES = ['kaspi', '2gis'];
// Not a collector-backed source — no directory_accounts row, no card in Directory Sources, no
// run/brand-watchlist concept. It's just a tag for rows pasted in via the manual CSV importer,
// which reuses the same dedupe/scoring/promote pipeline as every scraped source.
const MANUAL_SOURCE = 'manual';

function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

function sourceName(source) {
  return ({ pcexporters: 'PC Exporters', handelot: 'Handelot', kadorf: 'Kadorf', kaspi: 'Kaspi.kz', '2gis': '2GIS', manual: 'Manual Import' })[source] || source;
}

function requireSource(source) {
  source = String(source || '').toLowerCase();
  if (!SOURCES.includes(source)) throw new Error('Unsupported directory source');
  return source;
}

async function cryptoKey(secret) {
  if (!secret) throw new Error('LEAD_INTELLIGENCE_KEY secret is not configured');
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt','decrypt']);
}

function toB64(bytes) {
  let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s);
}
function fromB64(s) {
  const bin = atob(s); return Uint8Array.from(bin, c => c.charCodeAt(0));
}

async function encryptCredentials(env, value) {
  const key = await cryptoKey(env.LEAD_INTELLIGENCE_KEY);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  return `${toB64(iv)}.${toB64(new Uint8Array(cipher))}`;
}

async function decryptCredentials(env, token) {
  if (!token) return {};
  const [iv64, data64] = token.split('.');
  const key = await cryptoKey(env.LEAD_INTELLIGENCE_KEY);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv64) }, key, fromB64(data64));
  return JSON.parse(new TextDecoder().decode(plain));
}

function leadScore(p) {
  let score = 0;
  const text = `${p.brand || ''} ${p.productInterest || ''} ${p.activity || ''}`.toLowerCase();
  const priorityBrands = ['dyson','jbl','apple','samsung','sony','canon','nikon','fujifilm','om system'];
  if (priorityBrands.some(b => text.includes(b))) score += 25;
  if (/wtb|wanted|buy|request|looking for/.test(text)) score += 25;
  if (p.country) score += 10;
  if (p.email || p.phone) score += 10;
  if (p.whatsapp || p.telegram) score += 20; // deep, direct-contact channels outweigh a bare email/phone
  if (p.website) score += 5;
  if (p.verified) score += 10;
  if (p.lastActivityAt) score += 5;
  return Math.min(score, 100);
}

function normalize(s) { return String(s || '').trim(); }
// De-dupes a brand list case-insensitively (JBL/jbl are the same search) while keeping the
// first-seen casing, so a saved watchlist never accumulates near-duplicate entries.
function dedupeBrands(list) {
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const b = normalize(raw);
    const key = b.toLowerCase();
    if (!b || seen.has(key)) continue;
    seen.add(key);
    out.push(b);
  }
  return out;
}
function keyFor(p) {
  const domain = normalize(p.website).toLowerCase().replace(/^https?:\/\//,'').replace(/^www\./,'').split('/')[0];
  const email = normalize(p.email).toLowerCase();
  const phone = normalize(p.phone).replace(/\D/g,'');
  const whatsapp = normalize(p.whatsapp).replace(/\D/g,'');
  const telegram = normalize(p.telegram).toLowerCase().replace(/^@/,'');
  const company = normalize(p.company).toLowerCase().replace(/[^a-z0-9]+/g,'');
  return domain || email || phone || whatsapp || telegram || company;
}

async function listSources(env) {
  const rows = await env.DB.prepare(`SELECT source, username, status, lastSyncAt, lastError, verificationUrl, updatedAt FROM directory_accounts ORDER BY source`).all();
  const map = Object.fromEntries((rows.results || []).map(r => [r.source, r]));
  return SOURCES.map(source => ({
    source, name: sourceName(source), configured: !!map[source]?.username,
    username: map[source]?.username || '', status: map[source]?.status || 'not_configured',
    lastSyncAt: map[source]?.lastSyncAt || null, lastError: map[source]?.lastError || null,
    verificationUrl: map[source]?.verificationUrl || null, updatedAt: map[source]?.updatedAt || null
  }));
}

async function saveSource(request, env, source) {
  source = requireSource(source);
  const body = await request.json();
  const existing = await env.DB.prepare('SELECT credentialsEncrypted FROM directory_accounts WHERE source=?').bind(source).first();
  let encrypted = existing?.credentialsEncrypted || null;
  const isBrandSearch = BRAND_SEARCH_SOURCES.includes(source);
  const brands = isBrandSearch ? dedupeBrands(Array.isArray(body.brands) ? body.brands : []).slice(0, 25) : null;
  if (isBrandSearch) {
    if (!brands.length) return json({ error: 'Add at least one brand to search for' }, 400);
    encrypted = await encryptCredentials(env, { password: '', extra: { brands } });
  } else if (body.password || body.extra) {
    encrypted = await encryptCredentials(env, { password: body.password || '', extra: body.extra || {} });
  }
  const username = isBrandSearch ? brands.join(', ') : normalize(body.username);
  await env.DB.prepare(`INSERT INTO directory_accounts(source, username, credentialsEncrypted, status, updatedAt)
    VALUES(?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(source) DO UPDATE SET username=excluded.username, credentialsEncrypted=COALESCE(excluded.credentialsEncrypted,directory_accounts.credentialsEncrypted), status='ready', lastError=NULL, updatedAt=CURRENT_TIMESTAMP`)
    .bind(source, username, encrypted, 'ready').run();
  return json({ ok: true, source, status: 'ready' });
}

async function importProspects(request, env) {
  const body = await request.json();
  const source = String(body.source || '').toLowerCase() === MANUAL_SOURCE ? MANUAL_SOURCE : requireSource(body.source);
  const items = Array.isArray(body.items) ? body.items : [];
  let inserted = 0, updated = 0;
  for (const raw of items.slice(0, 500)) {
    const p = {
      company: normalize(raw.company), contactName: normalize(raw.contactName), country: normalize(raw.country),
      email: normalize(raw.email), phone: normalize(raw.phone), website: normalize(raw.website),
      whatsapp: normalize(raw.whatsapp), telegram: normalize(raw.telegram),
      brand: normalize(raw.brand), productInterest: normalize(raw.productInterest), activity: normalize(raw.activity),
      profileUrl: normalize(raw.profileUrl), verified: raw.verified ? 1 : 0, lastActivityAt: raw.lastActivityAt || null
    };
    const dedupeKey = `${source}:${keyFor(p)}`;
    if (!keyFor(p)) continue;
    const existing = await env.DB.prepare('SELECT id FROM directory_prospects WHERE dedupeKey=?').bind(dedupeKey).first();
    const score = leadScore(p);
    await env.DB.prepare(`INSERT INTO directory_prospects(source,dedupeKey,company,contactName,country,email,phone,website,whatsapp,telegram,brand,productInterest,activity,profileUrl,verified,lastActivityAt,leadScore,status,createdAt,updatedAt)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'new',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
      ON CONFLICT(dedupeKey) DO UPDATE SET company=excluded.company,contactName=excluded.contactName,country=excluded.country,email=excluded.email,phone=excluded.phone,website=excluded.website,whatsapp=excluded.whatsapp,telegram=excluded.telegram,brand=excluded.brand,productInterest=excluded.productInterest,activity=excluded.activity,profileUrl=excluded.profileUrl,verified=excluded.verified,lastActivityAt=excluded.lastActivityAt,leadScore=excluded.leadScore,updatedAt=CURRENT_TIMESTAMP`)
      .bind(source,dedupeKey,p.company,p.contactName,p.country,p.email,p.phone,p.website,p.whatsapp,p.telegram,p.brand,p.productInterest,p.activity,p.profileUrl,p.verified,p.lastActivityAt,score).run();
    existing ? updated++ : inserted++;
  }
  return json({ ok: true, inserted, updated });
}

async function listProspects(request, env) {
  const url = new URL(request.url);
  const source = url.searchParams.get('source');
  const status = url.searchParams.get('status');
  const q = normalize(url.searchParams.get('q')).toLowerCase();
  const params = []; let where = '1=1';
  if (source && (SOURCES.includes(source) || source === MANUAL_SOURCE)) { where += ' AND source=?'; params.push(source); }
  if (status) { where += ' AND status=?'; params.push(status); }
  if (q) { where += ` AND (lower(company) LIKE ? OR lower(brand) LIKE ? OR lower(productInterest) LIKE ? OR lower(country) LIKE ?)`; params.push(...Array(4).fill(`%${q}%`)); }
  const rows = await env.DB.prepare(`SELECT * FROM directory_prospects WHERE ${where} ORDER BY leadScore DESC, updatedAt DESC LIMIT 300`).bind(...params).all();
  return json({ prospects: rows.results || [] });
}

async function promote(env, id, ownerEmail = null) {
  const p = await env.DB.prepare('SELECT * FROM directory_prospects WHERE id=?').bind(id).first();
  if (!p) return json({ error: 'Prospect not found' }, 404);
  const phone = p.phone || '';
  const whatsapp = p.whatsapp || '';
  const matchPhone = phone || whatsapp; // de-dup lookup only — contacts.phone/whatsapp stay separate below
  const existing = await env.DB.prepare(`SELECT id FROM contacts WHERE (email<>'' AND lower(email)=lower(?)) OR (phone<>'' AND phone=?) OR (whatsapp<>'' AND whatsapp=?) OR (company<>'' AND lower(company)=lower(?)) LIMIT 1`).bind(p.email || '', matchPhone, whatsapp, p.company || '').first();
  if (existing) {
    await env.DB.prepare(`UPDATE contacts SET source=?,platform=?,country=COALESCE(NULLIF(?,''),country),brand=COALESCE(NULLIF(?,''),brand),productInterest=COALESCE(NULLIF(?,''),productInterest),phone=COALESCE(NULLIF(phone,''),?),whatsapp=COALESCE(NULLIF(whatsapp,''),?),telegramUsername=COALESCE(NULLIF(telegramUsername,''),?),leadScore=MAX(leadScore,?),updatedAt=CURRENT_TIMESTAMP WHERE id=?`)
      .bind(p.source, sourceName(p.source), p.country, p.brand, p.productInterest, phone, whatsapp, p.telegram || '', p.leadScore, existing.id).run();
    await env.DB.prepare(`UPDATE directory_prospects SET status='promoted',contactId=?,updatedAt=CURRENT_TIMESTAMP WHERE id=?`).bind(existing.id,id).run();
    return json({ ok: true, contactId: existing.id, merged: true });
  }
  const result = await env.DB.prepare(`INSERT INTO contacts(contactName,company,phone,email,category,source,platform,country,brand,productInterest,ownerEmail,leadScore,telegramUsername,whatsapp,createdAt,updatedAt)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`)
    .bind(p.contactName || '',p.company || '',phone,p.email || '','Directory Prospect',p.source,sourceName(p.source),p.country || '',p.brand || '',p.productInterest || '',ownerEmail,p.leadScore || 0,p.telegram || '',whatsapp).run();
  const contactId = result.meta?.last_row_id;
  await env.DB.prepare(`UPDATE directory_prospects SET status='promoted',contactId=?,updatedAt=CURRENT_TIMESTAMP WHERE id=?`).bind(contactId,id).run();
  return json({ ok: true, contactId, merged: false });
}

async function runCollector(request, env, source) {
  source = requireSource(source);
  const isBrandSearch = BRAND_SEARCH_SOURCES.includes(source);
  const isAdHoc = AD_HOC_SEARCH_SOURCES.includes(source);
  let account = await env.DB.prepare('SELECT * FROM directory_accounts WHERE source=?').bind(source).first();

  if (isBrandSearch) {
    // A run can carry brands directly (a quick "search JBL now" from the UI) without a separate
    // configure step first. New brands are folded into the saved watchlist, searched-first, so a
    // brand you just searched isn't starved of the per-run profile budget by older saved brands.
    const body = await request.json().catch(() => ({}));
    const newBrands = dedupeBrands(Array.isArray(body.brands) ? body.brands : []);
    if (newBrands.length) {
      const savedBrands = account?.credentialsEncrypted ? (await decryptCredentials(env, account.credentialsEncrypted)).extra?.brands || [] : [];
      const brands = dedupeBrands([...newBrands, ...savedBrands]).slice(0, 25);
      const encrypted = await encryptCredentials(env, { password: '', extra: { brands } });
      await env.DB.prepare(`INSERT INTO directory_accounts(source, username, credentialsEncrypted, status, updatedAt)
        VALUES(?,?,?,?,CURRENT_TIMESTAMP)
        ON CONFLICT(source) DO UPDATE SET username=excluded.username, credentialsEncrypted=excluded.credentialsEncrypted, status='ready', lastError=NULL, updatedAt=CURRENT_TIMESTAMP`)
        .bind(source, brands.join(', '), encrypted, 'ready').run();
      account = await env.DB.prepare('SELECT * FROM directory_accounts WHERE source=?').bind(source).first();
    }
  } else if (source === '2gis') {
    // Unlike Kaspi's accumulating brand watchlist, 2GIS is location-scoped ("printer in Almaty")
    // and each Discover click is a single independent search — it replaces whatever was there
    // before rather than merging into a growing list.
    const body = await request.json().catch(() => ({}));
    const query = normalize(body.query) || [normalize(body.brand), normalize(body.category)].filter(Boolean).join(' ');
    const location = normalize(body.location);
    if (query && location) {
      const limit = Math.max(1, Math.min(Number(body.limit) || 20, 50));
      const encrypted = await encryptCredentials(env, { password: '', extra: { query, location, limit } });
      await env.DB.prepare(`INSERT INTO directory_accounts(source, username, credentialsEncrypted, status, updatedAt)
        VALUES(?,?,?,?,CURRENT_TIMESTAMP)
        ON CONFLICT(source) DO UPDATE SET username=excluded.username, credentialsEncrypted=excluded.credentialsEncrypted, status='ready', lastError=NULL, updatedAt=CURRENT_TIMESTAMP`)
        .bind(source, `${query} · ${location}`, encrypted, 'ready').run();
      account = await env.DB.prepare('SELECT * FROM directory_accounts WHERE source=?').bind(source).first();
    }
  }

  if (!account?.credentialsEncrypted) {
    return json({ error: isBrandSearch ? 'Add at least one brand to search for first' : isAdHoc ? 'Enter a brand/product and a location to search' : 'Configure credentials first' }, 400);
  }
  // A deep crawl can run for minutes — don't let a re-click (or an impatient poll timeout) queue
  // a duplicate job on top of one still in flight. But a "syncing" status can also be orphaned
  // (e.g. the collector container restarted mid-job and never got to post its callback) — treat
  // it as stale past the collector's own job timeout so it doesn't block runs forever.
  const STALE_SYNCING_MS = 12 * 60 * 1000;
  const syncingAgeMs = account.status === 'syncing' && account.updatedAt ? Date.now() - new Date(account.updatedAt).getTime() : 0;
  if (account.status === 'syncing' && syncingAgeMs < STALE_SYNCING_MS) {
    return json({ ok: true, status: 'syncing', message: 'Already running — hang tight, this can take a few minutes.' });
  }
  if (!env.LEAD_COLLECTOR_URL) {
    await env.DB.prepare(`UPDATE directory_accounts SET status='collector_required',lastError='LEAD_COLLECTOR_URL is not configured',updatedAt=CURRENT_TIMESTAMP WHERE source=?`).bind(source).run();
    return json({ ok: false, status: 'collector_required', message: 'Collector service is not configured yet.' }, 409);
  }
  const credentials = await decryptCredentials(env, account.credentialsEncrypted);
  await env.DB.prepare(`UPDATE directory_accounts SET status='syncing',lastError=NULL,updatedAt=CURRENT_TIMESTAMP WHERE source=?`).bind(source).run();
  const response = await fetch(env.LEAD_COLLECTOR_URL, {
    method: 'POST', headers: { 'content-type':'application/json', 'authorization': `Bearer ${env.LEAD_COLLECTOR_TOKEN || ''}` },
    body: JSON.stringify({ source, username: account.username, credentials, callbackUrl: env.LEAD_INTELLIGENCE_CALLBACK_URL || null })
  });
  const result = await response.json().catch(() => ({}));
  const status = result.status || (response.ok ? 'syncing' : 'error');
  await env.DB.prepare(`UPDATE directory_accounts SET status=?,verificationUrl=?,lastError=?,lastSyncAt=CASE WHEN ?='completed' THEN CURRENT_TIMESTAMP ELSE lastSyncAt END,updatedAt=CURRENT_TIMESTAMP WHERE source=?`)
    .bind(status,result.verificationUrl || null,result.error || null,status,source).run();
  return json({ ok: response.ok, ...result, status }, response.ok ? 200 : response.status);
}

async function collectorCallback(request, env) {
  if (env.LEAD_COLLECTOR_TOKEN) {
    const auth = request.headers.get('authorization') || '';
    if (auth !== `Bearer ${env.LEAD_COLLECTOR_TOKEN}`) return json({ error: 'Unauthorized' }, 401);
  }
  const body = await request.json();
  const source = requireSource(body.source);
  if (Array.isArray(body.items) && body.items.length) {
    const req = new Request('https://local/import',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({source,items:body.items})});
    await importProspects(req, env);
  }
  const status = body.status || 'completed';
  // Reuse lastError as a general "last run note" slot (surfaced the same way in the UI) so a
  // non-error diagnostic — e.g. the Kaspi collector's "Apify used for N brands, crawl fallback
  // for M" summary — is visible without needing to check collector logs.
  await env.DB.prepare(`UPDATE directory_accounts SET status=?,verificationUrl=?,lastError=?,lastSyncAt=CASE WHEN ?='completed' THEN CURRENT_TIMESTAMP ELSE lastSyncAt END,updatedAt=CURRENT_TIMESTAMP WHERE source=?`)
    .bind(status,body.verificationUrl || null,body.error || body.note || null,status,source).run();
  return json({ ok: true });
}

const ENRICH_MAX_SITES = 20;
const ENRICH_MAX_INSTAGRAM_FOLLOWS = 10;
const ENRICH_FETCH_TIMEOUT_MS = 8000;
// Instagram serves its own login-walled HTML to a plain server-side fetch far more often than
// a normal browser sees it, so a realistic UA meaningfully improves the odds the bio (and any
// wa.me/t.me link in it) actually shows up in the response instead of a login prompt.
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const EMPTY_SOCIAL_LINKS = { telegram: '', linkedin: '', whatsapp: '', instagram: '' };

// A real WhatsApp number is an E.164 phone number: 8-15 digits, optionally with a leading '+'.
// The wa.me/api.whatsapp.com regexes' character classes don't actually bound digit count (spaces
// and dashes inside them don't stop a run of plain digits from going arbitrarily long), so without
// this a match can grab far more than a phone number — a query string, an ID, or a mismatched
// number sitting nearby — and save it as if it were real. Reject anything outside the real range
// rather than store garbage.
function normalizeWhatsAppMatch(raw) {
  const digits = String(raw || '').replace(/[^0-9]/g, '');
  if (digits.length < 8 || digits.length > 15) return '';
  return (String(raw).trim().startsWith('+') ? '+' : '') + digits;
}

function extractSocialLinks(html) {
  const telegramMatch = html.match(/https?:\/\/(?:t|telegram)\.me\/([A-Za-z0-9_]{4,32})/i);
  const linkedinMatch = html.match(/https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(?:company|in|school)\/[A-Za-z0-9\-_%.]+/i);
  const waMeMatch = html.match(/https?:\/\/(?:api\.)?wa\.me\/(\+?[0-9][0-9\s\-()]{5,17}[0-9])/i);
  const waApiMatch = html.match(/https?:\/\/api\.whatsapp\.com\/send\/?\?phone=(\+?[0-9][0-9\s\-()]{5,17}[0-9])/i);
  const whatsapp = normalizeWhatsAppMatch((waMeMatch && waMeMatch[1]) || (waApiMatch && waApiMatch[1]) || '');
  // Instagram is never surfaced as a lead field — it's only followed as a secondary source to
  // find a WhatsApp/Telegram link a business put in its bio instead of on its own website.
  const instagramMatch = html.match(/https?:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9_.]{2,30})/i);
  const instagramHandle = instagramMatch && !/^(p|reel|reels|explore|accounts|direct|stories|tv)$/i.test(instagramMatch[1])
    ? instagramMatch[1] : '';
  return {
    telegram: telegramMatch ? telegramMatch[1] : '',
    linkedin: linkedinMatch ? linkedinMatch[0].replace(/^http:/i, 'https:') : '',
    whatsapp,
    instagram: instagramHandle
  };
}

async function fetchAndExtract(url, extraHeaders) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(ENRICH_FETCH_TIMEOUT_MS),
      redirect: 'follow',
      headers: extraHeaders
    });
    if (!res.ok) return { ...EMPTY_SOCIAL_LINKS };
    return extractSocialLinks(await res.text());
  } catch (error) {
    return { ...EMPTY_SOCIAL_LINKS };
  }
}

// Google Maps/2GIS listings don't carry a Telegram or WhatsApp field themselves — the only
// signal available is the business's own website, so this fetches each one's homepage and
// regex-scans the raw HTML for a t.me/telegram.me link, a wa.me/api.whatsapp.com link, and a
// linkedin.com/company|in|school link (usually in the footer or a "follow us" block). When a
// site links out to Instagram but its homepage itself has no Telegram/WhatsApp link, that
// Instagram profile is followed as a second source and scanned the same way — many small
// businesses put their WhatsApp/Telegram link in their Instagram bio instead of on a website.
// Best-effort throughout: a site with no such link on its homepage, behind a cookie wall, or
// too slow to respond within the timeout just comes back empty for that field rather than
// failing the whole batch. Instagram itself is never returned as a contact field/lead source —
// only whatever Telegram/WhatsApp link it leads to.
async function enrichSocialLinks(request, env) {
  const body = await request.json().catch(() => ({}));
  const requested = Array.isArray(body.websites) ? body.websites : [];
  const unique = [...new Set(requested.map(w => String(w || '').trim()).filter(Boolean))];
  const batch = unique.slice(0, ENRICH_MAX_SITES);
  if (!batch.length) return json({ results: {} });

  const firstPass = await Promise.all(batch.map(async site => {
    const target = /^https?:\/\//i.test(site) ? site : `https://${site}`;
    const hit = await fetchAndExtract(target, {});
    return [site, hit];
  }));

  // Second pass, capped separately since it's an extra network hop per site: only chase the
  // Instagram link when the homepage itself didn't already surface a Telegram or WhatsApp link.
  const needsInstagramFollow = firstPass.filter(([, hit]) => hit.instagram && !hit.telegram && !hit.whatsapp);
  const toFollow = needsInstagramFollow.slice(0, ENRICH_MAX_INSTAGRAM_FOLLOWS);
  const instagramResults = await Promise.all(toFollow.map(async ([site, hit]) => {
    const igHit = await fetchAndExtract(`https://www.instagram.com/${hit.instagram}/`, { 'User-Agent': BROWSER_UA });
    return [site, igHit];
  }));
  const igBySite = Object.fromEntries(instagramResults);

  const entries = firstPass.map(([site, hit]) => {
    const igHit = igBySite[site];
    if (igHit) {
      hit.telegram = hit.telegram || igHit.telegram;
      hit.whatsapp = hit.whatsapp || igHit.whatsapp;
    }
    const { instagram, ...rest } = hit; // never expose the Instagram handle itself as a result field
    return [site, rest];
  });

  return json({ results: Object.fromEntries(entries), truncated: unique.length > ENRICH_MAX_SITES });
}

const ENRICH_SEARCH_MAX_LEADS = 15;
const ENRICH_SEARCH_TIMEOUT_MS = 10000;

const WA_ME_RE = /https?:\/\/(?:api\.)?wa\.me\/(\+?[0-9][0-9\s\-()]{5,17}[0-9])/i;
const WA_API_RE = /https?:\/\/api\.whatsapp\.com\/send\/?\?phone=(\+?[0-9][0-9\s\-()]{5,17}[0-9])/i;
// Catches a number spelled out next to the word "WhatsApp" in a search snippet/title even when
// there's no wa.me link — common on directory and marketplace listing pages. The gap after
// "whatsapp" excludes quotes so it can't wander across a JSON field boundary when scanning a
// stringified SerpApi response — without that, this regex was matching into an unrelated numeric
// field sitting near the word "whatsapp" in the JSON and producing 16+ digit garbage that isn't a
// phone number at all. normalizeWhatsAppMatch() below is the real safety net either way.
const WA_LABELLED_NUMBER_RE = /whatsapp[^0-9+"]{0,8}(\+?[0-9][0-9\s\-()]{5,13}[0-9])/i;

function extractWhatsAppNumber(text) {
  const waMe = text.match(WA_ME_RE) || text.match(WA_API_RE);
  if (waMe) {
    const num = normalizeWhatsAppMatch(waMe[1]);
    if (num) return num;
  }
  const labelled = text.match(WA_LABELLED_NUMBER_RE);
  return labelled ? normalizeWhatsAppMatch(labelled[1]) : '';
}

// Shared SerpApi-via-Yandex call used by every deeper-search enrichment tier below. Yandex
// rather than Google: Whizz's discovery searches skew toward Russia/CIS (Moscow, Minsk, Baku,
// ...), where Yandex indexes local businesses (and their public web mentions) far more
// thoroughly than Google does. Yandex's SerpApi params differ from Google's: the query goes in
// `text` (not `q`), and `yandex_domain` picks the regional index — yandex.com is the
// international domain, used here rather than guessing a per-lead country-specific domain
// (yandex.ru/.by/.kz/...). Returns the parsed response, or null on any failure — best-effort,
// callers treat null the same as "found nothing".
async function fetchYandexSearch(query, env) {
  const url = new URL('https://serpapi.com/search.json');
  url.searchParams.set('engine', 'yandex');
  url.searchParams.set('text', query);
  url.searchParams.set('yandex_domain', 'yandex.com');
  url.searchParams.set('api_key', env.SERPAPI_API_KEY);
  const res = await fetch(url, { signal: AbortSignal.timeout(ENRICH_SEARCH_TIMEOUT_MS) });
  const data = await res.json().catch(() => ({}));
  return (!res.ok || data.error) ? null : data;
}

// Deeper, WhatsApp-only enrichment tier beyond a business's own website/Instagram: runs each
// lead's name+location through fetchYandexSearch() (an official search API called directly, not
// a scraper chained through Apify/n8n) and scans whatever comes back — directory listings,
// marketplace pages, social mentions — for a WhatsApp number, not just what's on the business's
// own site. WhatsApp-only on purpose: Telegram is already well covered by the free
// website/Instagram tiers, so this paid last-resort tier stays narrow instead of widening the
// query (and the noise) to also chase Telegram. Costs one SerpApi call per lead, so it's meant to
// run only for leads the free tiers already came up empty for, not as a first resort.
async function enrichSocialSearch(request, env) {
  const body = await request.json().catch(() => ({}));
  const requested = Array.isArray(body.leads) ? body.leads : [];
  const batch = requested
    .map(l => ({ key: String(l?.key || '').trim(), query: String(l?.query || '').trim() }))
    .filter(l => l.key && l.query)
    .slice(0, ENRICH_SEARCH_MAX_LEADS);
  if (!batch.length) return json({ results: {} });

  if (!env.SERPAPI_API_KEY) {
    return json({ results: {}, error: 'SERPAPI_API_KEY is not configured on the Worker — set it with `wrangler secret put SERPAPI_API_KEY` (get a key at serpapi.com/manage-api-key).' }, 503);
  }

  const entries = await Promise.all(batch.map(async ({ key, query }) => {
    try {
      const data = await fetchYandexSearch(query, env);
      if (!data) return [key, ''];
      // Scan only the fields that actually describe search hits for this query — organic
      // results plus any knowledge-panel/local-listing block — not the whole response. Fields
      // like pagination, related searches, and request metadata carry unrelated numeric noise
      // (tracking params, result counts, ...) that isn't tied to the business at all, and
      // scanning them was producing WhatsApp "numbers" for the wrong business or no business.
      const relevant = [data.organic_results, data.answer_box, data.knowledge_graph, data.local_results].filter(Boolean);
      return [key, extractWhatsAppNumber(JSON.stringify(relevant))];
    } catch (error) {
      return [key, ''];
    }
  }));

  const results = {};
  for (const [key, whatsapp] of entries) if (whatsapp) results[key] = { whatsapp };
  return json({ results, truncated: requested.length > ENRICH_SEARCH_MAX_LEADS });
}

const CONTACT_PERSON_MAX_LEADS = 15;

const LINKEDIN_PROFILE_RE = /^https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[A-Za-z0-9\-_%]+\/?/i;
// Titles that suggest someone can actually make or influence a purchasing decision — used to
// skip a random employee's profile when several people at the same company show up in results.
const DECISION_MAKER_TITLE_RE = /(owner|founder|\bceo\b|managing director|general manager|\bdirector\b|purchasing|procurement|export manager|import manager|sales manager|business development)/i;

// LinkedIn blocks direct scraping, but its own page <title> ("Name - Job Title - Company |
// LinkedIn") is what search engines index and return as an organic result's title — so a plain
// search for a public LinkedIn profile page gets the name/title/company without ever requesting
// a page from linkedin.com itself. Only returns a match with an explicit decision-maker signal in
// its title or snippet, rather than just the first LinkedIn profile found for the company at any
// level (an intern's profile matching the company name isn't useful here).
function extractContactPerson(organicResults) {
  for (const r of organicResults || []) {
    const link = String(r?.link || r?.url || '').trim();
    if (!LINKEDIN_PROFILE_RE.test(link)) continue;
    const title = String(r?.title || '');
    const parts = title.split(/\s[-|–]\s/).map(s => s.trim()).filter(Boolean);
    const name = parts[0] || '';
    if (!name || /linkedin/i.test(name)) continue;
    const roleGuess = parts.slice(1).find(p => DECISION_MAKER_TITLE_RE.test(p)) || '';
    if (!roleGuess && !DECISION_MAKER_TITLE_RE.test(String(r?.snippet || ''))) continue;
    return { name, title: roleGuess || (parts[1] || ''), linkedin: link.replace(/^http:/i, 'https:') };
  }
  return null;
}

// Finds the actual decision-maker at a business, not just its front-desk number: searches
// site:linkedin.com/in for the company name alongside likely decision-maker titles (owner,
// director, purchasing, ...) via the same SerpApi/Yandex flow as the WhatsApp deep-search tier,
// and pulls a name + title + profile URL out of whichever public LinkedIn profile page turns up.
// Costs one SerpApi call per lead, same cadence as the WhatsApp tier — meant as an opt-in,
// deliberate "find the right person" step, not something run on every search.
async function enrichContactPerson(request, env) {
  const body = await request.json().catch(() => ({}));
  const requested = Array.isArray(body.leads) ? body.leads : [];
  const batch = requested
    .map(l => ({ key: String(l?.key || '').trim(), company: String(l?.company || '').trim() }))
    .filter(l => l.key && l.company)
    .slice(0, CONTACT_PERSON_MAX_LEADS);
  if (!batch.length) return json({ results: {} });

  if (!env.SERPAPI_API_KEY) {
    return json({ results: {}, error: 'SERPAPI_API_KEY is not configured on the Worker — set it with `wrangler secret put SERPAPI_API_KEY` (get a key at serpapi.com/manage-api-key).' }, 503);
  }

  const entries = await Promise.all(batch.map(async ({ key, company }) => {
    try {
      const query = `site:linkedin.com/in "${company}" (owner OR founder OR director OR purchasing OR manager)`;
      const data = await fetchYandexSearch(query, env);
      if (!data) return [key, null];
      return [key, extractContactPerson(data.organic_results)];
    } catch (error) {
      return [key, null];
    }
  }));

  const results = {};
  for (const [key, person] of entries) if (person) results[key] = person;
  return json({ results, truncated: requested.length > CONTACT_PERSON_MAX_LEADS });
}

// Domains that are almost never a business's own official site — skipped when guessing which
// organic result is the company's homepage, so the guess doesn't land on a directory/social/
// marketplace listing about the company instead of the company's own site.
const NON_OFFICIAL_SITE_RE = /(facebook\.com|instagram\.com|linkedin\.com|twitter\.com|x\.com|youtube\.com|wikipedia\.org|yellowpages\.|yelp\.com|crunchbase\.com|bloomberg\.com|t\.me|telegram\.me|wa\.me|api\.whatsapp\.com|google\.[a-z.]+\/maps|maps\.google|2gis\.|kaspi\.kz)/i;

// Same "labelled number next to a keyword" approach as WA_LABELLED_NUMBER_RE, but for a general
// phone number rather than specifically WhatsApp — catches a phone number spelled out next to
// "phone"/"tel"/"телефон" in a search snippet/title/knowledge-panel field.
const PHONE_LABELLED_RE = /(?:phone|tel|телефон)[^0-9+"]{0,8}(\+?[0-9][0-9\s\-()]{6,16}[0-9])/i;
function extractPhoneNumber(text) {
  const labelled = text.match(PHONE_LABELLED_RE);
  return labelled ? normalizeWhatsAppMatch(labelled[1]) : '';
}

// Best-effort guess at the company's own homepage: prefers a knowledge-panel/answer-box website
// field (Yandex sometimes surfaces one directly for a well-known business) and otherwise falls
// back to the first organic result whose link isn't a directory/social/marketplace domain.
function guessOfficialWebsite(data) {
  const kgSite = data.knowledge_graph?.website || data.answer_box?.website;
  if (kgSite) return kgSite;
  const hit = (data.organic_results || []).find(r => r?.link && !NON_OFFICIAL_SITE_RE.test(r.link));
  return hit ? hit.link : '';
}

// Search-by-company-name enrichment: the one-shot counterpart to the per-lead enrichment tiers
// above. Takes just a company name (+ optional location to disambiguate) and builds a single
// enriched lead profile from it — official website, phone, WhatsApp, address and description from
// the SerpApi/Yandex search itself, then Telegram/WhatsApp/LinkedIn scraped off that website (free,
// same as enrichSocialLinks), and optionally the decision-maker's LinkedIn profile (paid, same
// query enrichContactPerson uses) when the caller opts in. Meant for Discovery's "Company Search"
// window: a deliberate, one-company-at-a-time search rather than a bulk per-lead pass, so doing the
// website fetch unconditionally (it's free) and gating only the paid LinkedIn lookup behind a flag
// matches the cost model of the tiers above.
async function searchCompany(request, env) {
  const body = await request.json().catch(() => ({}));
  const company = normalize(body.company);
  const location = normalize(body.location);
  if (!company) return json({ error: 'Enter a company name to search' }, 400);

  if (!env.SERPAPI_API_KEY) {
    return json({ error: 'SERPAPI_API_KEY is not configured on the Worker — set it with `wrangler secret put SERPAPI_API_KEY` (get a key at serpapi.com/manage-api-key).' }, 503);
  }

  const query = [`"${company}"`, location].filter(Boolean).join(' ');
  const data = await fetchYandexSearch(query, env);
  if (!data) return json({ profile: null });

  const relevant = [data.organic_results, data.answer_box, data.knowledge_graph, data.local_results].filter(Boolean);
  const relevantText = JSON.stringify(relevant);
  const website = normalize(guessOfficialWebsite(data));

  const profile = {
    company,
    website,
    phone: normalize(data.knowledge_graph?.phone) || extractPhoneNumber(relevantText),
    whatsapp: extractWhatsAppNumber(relevantText),
    telegram: '',
    linkedin: '',
    address: normalize(data.knowledge_graph?.address || data.local_results?.[0]?.address),
    description: normalize(data.knowledge_graph?.description || data.answer_box?.snippet),
  };

  if (website) {
    const target = /^https?:\/\//i.test(website) ? website : `https://${website}`;
    const siteHit = await fetchAndExtract(target, {});
    profile.telegram = siteHit.telegram;
    profile.linkedin = siteHit.linkedin;
    if (!profile.whatsapp) profile.whatsapp = siteHit.whatsapp;
  }

  if (body.findContactPerson) {
    const cpQuery = `site:linkedin.com/in "${company}" (owner OR founder OR director OR purchasing OR manager)`;
    const cpData = await fetchYandexSearch(cpQuery, env);
    const person = cpData ? extractContactPerson(cpData.organic_results) : null;
    if (person) {
      profile.contactPersonName = person.name;
      profile.contactPersonTitle = person.title;
      if (person.linkedin && !profile.linkedin) profile.linkedin = person.linkedin;
    }
  }

  return json({ profile });
}

const CHECK_EXISTING_MAX_ITEMS = 200;

// Lets Discovery drop results that are already saved leads before showing them, instead of
// re-surfacing the same businesses on every re-search. Matches the same two signals
// saveOwnedContacts() already uses to detect "already imported, refresh it" (worker/routes/
// automation.js): the platform's own stable id (Google's placeId/cid) and a normalized phone
// number. All candidates in one request share a single platform, since Discovery only ever
// checks one source's results at a time.
async function checkExistingContacts(request, env) {
  const body = await request.json().catch(() => ({}));
  const platform = String(body.platform || '').trim();
  const sourceIds = [...new Set((Array.isArray(body.sourceIds) ? body.sourceIds : []).map(s => String(s || '').trim()).filter(Boolean))].slice(0, CHECK_EXISTING_MAX_ITEMS);
  const phones = [...new Set((Array.isArray(body.phones) ? body.phones : []).map(p => String(p || '').replace(/\D/g, '')).filter(Boolean))].slice(0, CHECK_EXISTING_MAX_ITEMS);

  const existingSourceIds = [];
  const existingPhones = [];

  if (platform && sourceIds.length) {
    const placeholders = sourceIds.map(() => '?').join(',');
    const rows = await env.DB.prepare(`SELECT sourceId FROM contacts WHERE platform=? AND sourceId IN (${placeholders})`).bind(platform, ...sourceIds).all();
    for (const r of rows.results || []) existingSourceIds.push(r.sourceId);
  }
  if (phones.length) {
    const placeholders = phones.map(() => '?').join(',');
    const rows = await env.DB.prepare(`SELECT DISTINCT REPLACE(REPLACE(REPLACE(phone,'+',''),' ',''),'-','') AS normPhone FROM contacts WHERE REPLACE(REPLACE(REPLACE(phone,'+',''),' ',''),'-','') IN (${placeholders})`).bind(...phones).all();
    for (const r of rows.results || []) if (r.normPhone) existingPhones.push(r.normPhone);
  }

  return json({ existingSourceIds, existingPhones });
}

export async function handleLeadIntelligence(request, env, action, arg) {
  if (request.method === 'GET' && action === 'sources') return json({ sources: await listSources(env) });
  if (request.method === 'PUT' && action === 'source') return saveSource(request, env, arg);
  if (request.method === 'GET' && action === 'prospects') return listProspects(request, env);
  if (request.method === 'POST' && action === 'import') return importProspects(request, env);
  if (request.method === 'POST' && action === 'enrichSocial') return enrichSocialLinks(request, env);
  if (request.method === 'POST' && action === 'enrichSocialSearch') return enrichSocialSearch(request, env);
  if (request.method === 'POST' && action === 'enrichContactPerson') return enrichContactPerson(request, env);
  if (request.method === 'POST' && action === 'searchCompany') return searchCompany(request, env);
  if (request.method === 'POST' && action === 'checkExisting') return checkExistingContacts(request, env);
  if (request.method === 'POST' && action === 'promote') { const body = await request.json().catch(()=>({})); return promote(env, Number(arg), body.ownerEmail || null); }
  if (request.method === 'POST' && action === 'run') return runCollector(request, env, arg);
  if (request.method === 'POST' && action === 'callback') return collectorCallback(request, env);
  return json({ error: 'Not found' }, 404);
}
