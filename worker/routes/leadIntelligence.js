const SOURCES = ['pcexporters','handelot','kadorf','kaspi'];
// Sources in this list are public marketplaces with no login: they're configured with a
// brand watchlist (e.g. JBL, Dyson) instead of a username/password.
const BRAND_SEARCH_SOURCES = ['kaspi'];

function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

function sourceName(source) {
  return ({ pcexporters: 'PC Exporters', handelot: 'Handelot', kadorf: 'Kadorf', kaspi: 'Kaspi.kz' })[source] || source;
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
  const brands = isBrandSearch ? [...new Set((Array.isArray(body.brands) ? body.brands : []).map(normalize).filter(Boolean))].slice(0, 25) : null;
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
  const source = requireSource(body.source);
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
  if (source && SOURCES.includes(source)) { where += ' AND source=?'; params.push(source); }
  if (status) { where += ' AND status=?'; params.push(status); }
  if (q) { where += ` AND (lower(company) LIKE ? OR lower(brand) LIKE ? OR lower(productInterest) LIKE ? OR lower(country) LIKE ?)`; params.push(...Array(4).fill(`%${q}%`)); }
  const rows = await env.DB.prepare(`SELECT * FROM directory_prospects WHERE ${where} ORDER BY leadScore DESC, updatedAt DESC LIMIT 300`).bind(...params).all();
  return json({ prospects: rows.results || [] });
}

async function promote(env, id, ownerEmail = null) {
  const p = await env.DB.prepare('SELECT * FROM directory_prospects WHERE id=?').bind(id).first();
  if (!p) return json({ error: 'Prospect not found' }, 404);
  const phone = p.phone || p.whatsapp || ''; // contacts.phone drives the WhatsApp chat button (wa.me/<phone>)
  const existing = await env.DB.prepare(`SELECT id FROM contacts WHERE (email<>'' AND lower(email)=lower(?)) OR (phone<>'' AND phone=?) OR (company<>'' AND lower(company)=lower(?)) LIMIT 1`).bind(p.email || '', phone, p.company || '').first();
  if (existing) {
    await env.DB.prepare(`UPDATE contacts SET source=?,platform=?,country=COALESCE(NULLIF(?,''),country),brand=COALESCE(NULLIF(?,''),brand),productInterest=COALESCE(NULLIF(?,''),productInterest),phone=COALESCE(NULLIF(phone,''),?),telegramUsername=COALESCE(NULLIF(telegramUsername,''),?),leadScore=MAX(leadScore,?),updatedAt=CURRENT_TIMESTAMP WHERE id=?`)
      .bind(p.source, sourceName(p.source), p.country, p.brand, p.productInterest, phone, p.telegram || '', p.leadScore, existing.id).run();
    await env.DB.prepare(`UPDATE directory_prospects SET status='promoted',contactId=?,updatedAt=CURRENT_TIMESTAMP WHERE id=?`).bind(existing.id,id).run();
    return json({ ok: true, contactId: existing.id, merged: true });
  }
  const result = await env.DB.prepare(`INSERT INTO contacts(contactName,company,phone,email,category,source,platform,country,brand,productInterest,ownerEmail,leadScore,telegramUsername,createdAt,updatedAt)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`)
    .bind(p.contactName || '',p.company || '',phone,p.email || '','Directory Prospect',p.source,sourceName(p.source),p.country || '',p.brand || '',p.productInterest || '',ownerEmail,p.leadScore || 0,p.telegram || '').run();
  const contactId = result.meta?.last_row_id;
  await env.DB.prepare(`UPDATE directory_prospects SET status='promoted',contactId=?,updatedAt=CURRENT_TIMESTAMP WHERE id=?`).bind(contactId,id).run();
  return json({ ok: true, contactId, merged: false });
}

async function runCollector(request, env, source) {
  source = requireSource(source);
  const isBrandSearch = BRAND_SEARCH_SOURCES.includes(source);
  let account = await env.DB.prepare('SELECT * FROM directory_accounts WHERE source=?').bind(source).first();

  if (isBrandSearch) {
    // A run can carry brands directly (a quick "search JBL now" from the UI) without a separate
    // configure step first. New brands are folded into the saved watchlist, searched-first, so a
    // brand you just searched isn't starved of the per-run profile budget by older saved brands.
    const body = await request.json().catch(() => ({}));
    const newBrands = [...new Set((Array.isArray(body.brands) ? body.brands : []).map(normalize).filter(Boolean))];
    if (newBrands.length) {
      const savedBrands = account?.credentialsEncrypted ? (await decryptCredentials(env, account.credentialsEncrypted)).extra?.brands || [] : [];
      const brands = [...new Set([...newBrands, ...savedBrands])].slice(0, 25);
      const encrypted = await encryptCredentials(env, { password: '', extra: { brands } });
      await env.DB.prepare(`INSERT INTO directory_accounts(source, username, credentialsEncrypted, status, updatedAt)
        VALUES(?,?,?,?,CURRENT_TIMESTAMP)
        ON CONFLICT(source) DO UPDATE SET username=excluded.username, credentialsEncrypted=excluded.credentialsEncrypted, status='ready', lastError=NULL, updatedAt=CURRENT_TIMESTAMP`)
        .bind(source, brands.join(', '), encrypted, 'ready').run();
      account = await env.DB.prepare('SELECT * FROM directory_accounts WHERE source=?').bind(source).first();
    }
  }

  if (!account?.credentialsEncrypted) {
    return json({ error: isBrandSearch ? 'Add at least one brand to search for first' : 'Configure credentials first' }, 400);
  }
  if (account.status === 'syncing') {
    // A deep crawl can run for minutes — don't let a re-click (or an impatient poll timeout)
    // queue a duplicate job on top of one still in flight.
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
  await env.DB.prepare(`UPDATE directory_accounts SET status=?,verificationUrl=?,lastError=?,lastSyncAt=CASE WHEN ?='completed' THEN CURRENT_TIMESTAMP ELSE lastSyncAt END,updatedAt=CURRENT_TIMESTAMP WHERE source=?`)
    .bind(status,body.verificationUrl || null,body.error || null,status,source).run();
  return json({ ok: true });
}

export async function handleLeadIntelligence(request, env, action, arg) {
  if (request.method === 'GET' && action === 'sources') return json({ sources: await listSources(env) });
  if (request.method === 'PUT' && action === 'source') return saveSource(request, env, arg);
  if (request.method === 'GET' && action === 'prospects') return listProspects(request, env);
  if (request.method === 'POST' && action === 'import') return importProspects(request, env);
  if (request.method === 'POST' && action === 'promote') { const body = await request.json().catch(()=>({})); return promote(env, Number(arg), body.ownerEmail || null); }
  if (request.method === 'POST' && action === 'run') return runCollector(request, env, arg);
  if (request.method === 'POST' && action === 'callback') return collectorCallback(request, env);
  return json({ error: 'Not found' }, 404);
}
