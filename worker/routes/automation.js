import { regionForCountry, detectCountryFromPhone, applyDetectedCountry } from './detectCountry.js';

const WRITE_ROLES = {
  'whizz-discover-contacts': ['Administrator', 'Manager'],
  'whizz-discover-2gis': ['Administrator', 'Manager'],
  'whizz-save-integration': ['Administrator'],
  'whizz-delete-integration': ['Administrator'],
};

function emailFromAccess(request) {
  return (request.headers.get('Cf-Access-Authenticated-User-Email') || '').trim().toLowerCase();
}

async function conversationContext(env, user) {
  const assignments = await env.DB.prepare(`SELECT a.conversationId,a.assignedUserEmail,a.assignedTeamId,
    u.name assignedUserName FROM conversation_assignments a LEFT JOIN users u ON u.email=a.assignedUserEmail`).all();
  let assigneeQuery = 'SELECT email,name,role,teamId FROM users WHERE role IN (\'Manager\',\'Sales\')';
  const assignees = user.role === 'Administrator'
    ? await env.DB.prepare(assigneeQuery + ' ORDER BY name COLLATE NOCASE').all()
    : user.role === 'Manager'
      ? await env.DB.prepare(assigneeQuery + ' AND teamId=? ORDER BY name COLLATE NOCASE').bind(user.teamId || '').all()
      : { results: [] };
  return { assignments: assignments.results || [], assignees: assignees.results || [] };
}

function filterConversationPayload(payload, user, context) {
  const byId = new Map(context.assignments.map(a => [String(a.conversationId), a]));
  const source = Array.isArray(payload) ? payload : (payload.conversations || []);
  const visible = source.filter(conversation => {
    const assignment = byId.get(String(conversation.id));
    if (user.role === 'Administrator') return true;
    if (user.role === 'Manager') return !assignment || assignment.assignedTeamId === user.teamId;
    return assignment?.assignedUserEmail === user.email;
  }).map(conversation => {
    const a = byId.get(String(conversation.id));
    return { ...conversation, assignment: a ? { userEmail: a.assignedUserEmail, userName: a.assignedUserName || a.assignedUserEmail, teamId: a.assignedTeamId } : null };
  });
  if (Array.isArray(payload)) return { conversations: visible, assignees: context.assignees };
  return { ...payload, conversations: visible, assignees: context.assignees };
}

function scoreLead(contact) {
  return Math.min(100, 35 + (contact.phone ? 15 : 0) + (contact.email ? 15 : 0) +
    (contact.brand ? 10 : 0) + (contact.productInterest || contact.category ? 15 : 0) + (contact.country ? 10 : 0));
}

async function saveOwnedContacts(request, env, user) {
  const body = await request.json().catch(() => ({}));
  const contacts = Array.isArray(body.contacts) ? body.contacts : [];
  if (!contacts.length) return Response.json({ error: 'At least one contact is required.' }, { status: 400 });
  let inserted = 0, updated = 0, duplicates = 0;
  for (const raw of contacts.slice(0, 1000)) {
    const contact = raw || {};
    const phone = String(contact.phone || '').trim();
    const email = String(contact.email || '').trim().toLowerCase();
    const platform = String(contact.platform || '').trim();
    const sourceId = String(contact.sourceId || '').trim();
    const website = String(contact.website || '').trim();
    const address = String(contact.address || '').trim();
    const mapsUrl = String(contact.mapsUrl || '').trim();
    const rating = Number(contact.rating) || 0;
    const category = String(contact.category || '');
    const telegramUsername = String(contact.telegramUsername || contact.telegram || '').trim().replace(/^@/, '');
    const linkedin = String(contact.linkedin || '').trim();
    const whatsapp = String(contact.whatsapp || '').trim();
    const contactPersonName = String(contact.contactPersonName || '').trim();
    const contactPersonTitle = String(contact.contactPersonTitle || '').trim();
    const volzaUrl = String(contact.volzaUrl || '').trim();
    const directoryUrl = String(contact.directoryUrl || '').trim();
    const directoryDescription = String(contact.directoryDescription || '').trim();
    let country = String(contact.country || '').trim();
    if (phone) country = applyDetectedCountry(country, await detectCountryFromPhone(env, phone, country));

    // Re-discovering the same listing (same platform + external id) refreshes it instead of
    // being silently dropped as a phone/email duplicate — keeps rating/website/category current.
    const existing = sourceId && platform
      ? await env.DB.prepare('SELECT id FROM contacts WHERE platform=? AND sourceId=? LIMIT 1').bind(platform, sourceId).first()
      : null;
    if (existing) {
      await env.DB.prepare(`UPDATE contacts SET website=?,address=?,rating=?,mapsUrl=?,
        category=COALESCE(NULLIF(?,''),category),phone=COALESCE(NULLIF(?,''),phone),email=COALESCE(NULLIF(?,''),email),
        telegramUsername=COALESCE(NULLIF(?,''),telegramUsername),linkedin=COALESCE(NULLIF(?,''),linkedin),
        whatsapp=COALESCE(NULLIF(?,''),whatsapp),
        contactPersonName=COALESCE(NULLIF(?,''),contactPersonName),contactPersonTitle=COALESCE(NULLIF(?,''),contactPersonTitle),
        volzaUrl=COALESCE(NULLIF(?,''),volzaUrl),directoryUrl=COALESCE(NULLIF(?,''),directoryUrl),
        directoryDescription=COALESCE(NULLIF(?,''),directoryDescription),
        updatedAt=CURRENT_TIMESTAMP WHERE id=?`)
        .bind(website, address, rating, mapsUrl, category, phone, email, telegramUsername, linkedin, whatsapp, contactPersonName, contactPersonTitle, volzaUrl, directoryUrl, directoryDescription, existing.id).run();
      updated++; continue;
    }

    const duplicate = phone
      ? await env.DB.prepare("SELECT id FROM contacts WHERE REPLACE(REPLACE(REPLACE(phone,'+',''),' ',''),'-','')=REPLACE(REPLACE(REPLACE(?,'+',''),' ',''),'-','') LIMIT 1").bind(phone).first()
      : email ? await env.DB.prepare('SELECT id FROM contacts WHERE LOWER(email)=LOWER(?) LIMIT 1').bind(email).first() : null;
    if (duplicate) { duplicates++; continue; }
    await env.DB.prepare(`INSERT INTO contacts
      (contactName,company,phone,email,category,source,platform,country,brand,productInterest,
       website,address,rating,mapsUrl,sourceId,telegramUsername,linkedin,whatsapp,contactPersonName,contactPersonTitle,
       volzaUrl,directoryUrl,directoryDescription,
       ownerEmail,teamId,createdByEmail,leadScore,lastContactedAt,nextFollowUpAt,dealExpectedAt,createdAt,updatedAt)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`)
      .bind(String(contact.contactName || contact.name || contact.company || ''), String(contact.company || contact.contactName || contact.name || ''),
        phone, email, category, String(contact.source || ''), platform,
        country, String(contact.brand || ''), String(contact.productInterest || ''),
        website, address, rating, mapsUrl, sourceId, telegramUsername, linkedin, whatsapp, contactPersonName, contactPersonTitle,
        volzaUrl, directoryUrl, directoryDescription,
        user.email, user.teamId || 'sales', user.email, scoreLead(contact), contact.lastContactedAt || null,
        contact.nextFollowUpAt || null, contact.dealExpectedAt || null).run();
    inserted++;
  }
  return Response.json({ success: true, inserted, updated, duplicates, ownerEmail: user.email, teamId: user.teamId || 'sales' });
}

function _normStr(s) { return (s || '').trim().replace(/\s+/g, ' '); }
function _titleCase(s) { return s.replace(/\b\w/g, c => c.toUpperCase()); }

function normalizeCountry(raw) {
  const s = _titleCase(_normStr(raw || 'Unknown'));
  if (/^europe/i.test(s) || /^eu$/i.test(s)) return 'Europe';
  if (/^north.?america/i.test(s) || /^n\.?a\.?$/i.test(s)) return 'North America';
  if (/^middle.?east/i.test(s) || /^mena$/i.test(s)) return 'Middle East';
  if (/^south.?east.?asia/i.test(s) || /^sea$/i.test(s)) return 'Southeast Asia';
  if (/^south.?america/i.test(s) || /^latin.?america/i.test(s) || /^latam$/i.test(s)) return 'Latin America';
  if (/^cis$/i.test(s) || /^central.?asia/i.test(s)) return 'CIS';
  if (/^sub.?saharan/i.test(s) || /^west.?africa/i.test(s) || /^east.?africa/i.test(s)) return 'Africa';
  const isoMap = { 'Ae': 'UAE', 'Gb': 'UK', 'Us': 'USA', 'De': 'Germany', 'Fr': 'France',
    'Sa': 'Saudi Arabia', 'Pk': 'Pakistan', 'In': 'India', 'Ng': 'Nigeria', 'Ke': 'Kenya',
    'Tj': 'Tajikistan', 'Kz': 'Kazakhstan', 'Uz': 'Uzbekistan', 'Ru': 'Russia', 'Cn': 'China',
    'Sg': 'Singapore', 'My': 'Malaysia', 'Tr': 'Turkey', 'Za': 'South Africa', 'Gh': 'Ghana',
    'Eg': 'Egypt', 'Ma': 'Morocco', 'Et': 'Ethiopia', 'Tz': 'Tanzania', 'Ug': 'Uganda' };
  if (isoMap[s]) return isoMap[s];
  return s || 'Unknown';
}

// A contact's brand field can hold a comma-separated list (e.g. an exhibitor carrying
// "JBL, Dyson, Canon"). Split on comma/semicolon only (not slash — values like
// "Dyson (EU 2-pin / 3-pin)" use "/" inside a single brand) so every brand becomes its
// own searchable/filterable entry instead of only the first one.
function normalizeBrands(raw) {
  const parts = String(raw || '').split(/[,;]/).map(s => _titleCase(_normStr(s))).filter(Boolean);
  return parts.length ? parts : ['Unspecified'];
}

async function ownedLeadSummary(env, user) {
  const clause = user.role === 'Administrator' ? '(? IS NOT NULL)'
    : user.role === 'Manager' ? '(ownerEmail IS NULL OR teamId=?)' : 'ownerEmail=?';
  const scope = user.role === 'Sales' ? user.email : (user.teamId || '');
  const result = await env.DB.prepare(`SELECT platform,country,brand,COUNT(*) count FROM contacts WHERE ${clause}
    GROUP BY platform,country,brand ORDER BY count DESC`).bind(scope).all();

  // Normalize and re-aggregate (merge synonyms, title-case, split comma-brands). A row whose
  // brand field lists several brands contributes its count to each brand's own group, so a
  // multi-brand contact is findable under every brand it carries, not just the first.
  const aggMap = new Map();
  for (const row of (result.results || [])) {
    const platform = _titleCase(_normStr(row.platform || 'Unknown'));
    const country = normalizeCountry(row.country);
    const count = Number(row.count || 0);
    for (const brand of normalizeBrands(row.brand)) {
      const key = `${platform}||${country}||${brand}`;
      if (aggMap.has(key)) {
        aggMap.get(key).count += count;
      } else {
        aggMap.set(key, { platform, country, brand, count, region: regionForCountry(country), trend: 'Stable', velocity30DayPct: 0 });
      }
    }
  }
  const groups = [...aggMap.values()].sort((a, b) => b.count - a.count);

  const matrix = new Map();
  for (const group of groups) {
    if (!matrix.has(group.brand)) matrix.set(group.brand, { brand: group.brand, total: 0, breakdownByPlatform: {}, breakdownByCountry: {} });
    const item = matrix.get(group.brand); item.total += group.count;
    item.breakdownByPlatform[group.platform] = (item.breakdownByPlatform[group.platform] || 0) + group.count;
    item.breakdownByCountry[group.country] = (item.breakdownByCountry[group.country] || 0) + group.count;
  }
  const regions = [...new Set(groups.map(g => g.region))].sort();
  return Response.json({ groups, crossTabMatrix: [...matrix.values()], totalDistributedItems: groups.reduce((n,g)=>n+g.count,0),
    platforms: [...new Set(groups.map(g=>g.platform))], countries: [...new Set(groups.map(g=>g.country))].sort(),
    brands: [...new Set(groups.map(g=>g.brand))], regions });
}

async function resolveContactsForCampaign(env, user, body) {
  const audiences = Array.isArray(body.audiences) && body.audiences.length > 0 ? body.audiences : null;
  const targets = audiences || [{ platform: body.platform || 'ALL', country: body.country || 'ALL', brand: body.brand || 'ALL' }];

  // Build ownership filter appended at end of bind list
  let ownerFilter = '';
  let ownerParam = undefined;
  if (user.role === 'Manager') {
    ownerFilter = 'AND (ownerEmail IS NULL OR teamId = ?)';
    ownerParam = user.teamId || '';
  } else if (user.role === 'Sales') {
    ownerFilter = 'AND ownerEmail = ?';
    ownerParam = user.email;
  }

  let contacts = [];
  for (const t of targets) {
    const binds = [
      t.platform || 'ALL', t.platform || 'ALL',
      t.country  || 'ALL', t.country  || 'ALL',
      t.brand    || 'ALL', t.brand    || 'ALL',
    ];
    if (ownerParam !== undefined) binds.push(ownerParam);
    const { results } = await env.DB.prepare(
      `SELECT id,contactName,phone,email,platform,country,brand,leadScore,lastContactedAt FROM contacts
       WHERE (? = 'ALL' OR LOWER(platform) = LOWER(?))
         AND (? = 'ALL' OR LOWER(country) = LOWER(?))
         AND (? = 'ALL' OR (',' || REPLACE(LOWER(brand), ', ', ',') || ',') LIKE ('%,' || LOWER(?) || ',%'))
         ${ownerFilter}
       ORDER BY leadScore DESC`
    ).bind(...binds).all();
    contacts.push(...(results || []));
  }

  // Deduplicate by id
  const seen = new Set();
  contacts = contacts.filter(c => { if (seen.has(c.id)) return false; seen.add(c.id); return true; });

  return contacts;
}

async function sendCampaignWithContacts(request, env, user) {
  const body = await request.json().catch(() => ({}));
  const contacts = await resolveContactsForCampaign(env, user, body);

  const base = (env.N8N_WEBHOOK_BASE || 'https://n8n.aiingo.com/webhook').replace(/\/$/, '');
  const target = new URL(`${base}/whizz-send-campaign`);
  const headers = new Headers({ 'content-type': 'application/json' });
  headers.set('x-whizz-user-email', user.email);
  headers.set('x-whizz-user-role', user.role);

  const payload = { ...body, contacts, contact_count: contacts.length };
  const response = await fetch(target, { method: 'POST', headers, body: JSON.stringify(payload), redirect: 'follow' });
  const responseHeaders = new Headers(response.headers);
  responseHeaders.set('cache-control', 'no-store');
  return new Response(response.body, { status: response.status, headers: responseHeaders });
}

export async function handleAutomation(request, env, endpoint) {
  const email = emailFromAccess(request);
  const user = email ? await env.DB.prepare('SELECT email,role,teamId FROM users WHERE email=?').bind(email).first() : null;
  if (!user) return Response.json({ error: 'Authenticated user is not provisioned in Whizz.' }, { status: 403 });

  if (endpoint === 'whizz-save-contact' && request.method === 'POST') {
    return saveOwnedContacts(request, env, user);
  }
  if (endpoint === 'whizz-get-leads' && request.method === 'GET') {
    return ownedLeadSummary(env, user);
  }
  if (endpoint === 'whizz-send-campaign' && request.method === 'POST') {
    return sendCampaignWithContacts(request, env, user);
  }

  const allowedRoles = WRITE_ROLES[endpoint];
  if (allowedRoles && !allowedRoles.includes(user.role)) {
    return Response.json({ error: `${user.role} users cannot perform this operation.` }, { status: 403 });
  }

  if (endpoint === 'whizz-get-conversation-messages' && user.role !== 'Administrator') {
    const conversationId = new URL(request.url).searchParams.get('id') || '';
    const assignment = await env.DB.prepare('SELECT assignedUserEmail,assignedTeamId FROM conversation_assignments WHERE conversationId=?').bind(conversationId).first();
    const allowed = user.role === 'Manager'
      ? !assignment || assignment.assignedTeamId === user.teamId
      : assignment?.assignedUserEmail === user.email;
    if (!allowed) return Response.json({ error: 'This conversation is not assigned to you.' }, { status: 403 });
  }

  const base = (env.N8N_WEBHOOK_BASE || 'https://n8n.aiingo.com/webhook').replace(/\/$/, '');
  const sourceUrl = new URL(request.url);
  const target = new URL(`${base}/${encodeURIComponent(endpoint)}`);
  target.search = sourceUrl.search;
  const headers = new Headers();
  headers.set('content-type', request.headers.get('content-type') || 'application/json');
  headers.set('x-whizz-user-email', user.email);
  headers.set('x-whizz-user-role', user.role);
  const response = await fetch(target, {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    redirect: 'follow',
  });
  if (endpoint === 'whizz-get-conversations' && response.ok) {
    const payload = await response.json();
    const scoped = filterConversationPayload(payload, user, await conversationContext(env, user));
    return Response.json(scoped, { headers: { 'cache-control': 'no-store' } });
  }
  const responseHeaders = new Headers(response.headers);
  responseHeaders.set('cache-control', 'no-store');
  return new Response(response.body, { status: response.status, headers: responseHeaders });
}
