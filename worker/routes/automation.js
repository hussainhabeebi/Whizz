const WRITE_ROLES = {
  'whizz-discover-contacts': ['Administrator', 'Manager'],
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
  let inserted = 0, duplicates = 0;
  for (const raw of contacts.slice(0, 1000)) {
    const contact = raw || {};
    const phone = String(contact.phone || '').trim();
    const email = String(contact.email || '').trim().toLowerCase();
    const duplicate = phone
      ? await env.DB.prepare("SELECT id FROM contacts WHERE REPLACE(REPLACE(REPLACE(phone,'+',''),' ',''),'-','')=REPLACE(REPLACE(REPLACE(?,'+',''),' ',''),'-','') LIMIT 1").bind(phone).first()
      : email ? await env.DB.prepare('SELECT id FROM contacts WHERE LOWER(email)=LOWER(?) LIMIT 1').bind(email).first() : null;
    if (duplicate) { duplicates++; continue; }
    await env.DB.prepare(`INSERT INTO contacts
      (contactName,company,phone,email,category,source,platform,country,brand,productInterest,
       ownerEmail,teamId,createdByEmail,leadScore,lastContactedAt,nextFollowUpAt,dealExpectedAt,createdAt,updatedAt)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`)
      .bind(String(contact.contactName || contact.name || contact.company || ''), String(contact.company || contact.contactName || contact.name || ''),
        phone, email, String(contact.category || ''), String(contact.source || ''), String(contact.platform || ''),
        String(contact.country || ''), String(contact.brand || ''), String(contact.productInterest || ''),
        user.email, user.teamId || 'sales', user.email, scoreLead(contact), contact.lastContactedAt || null,
        contact.nextFollowUpAt || null, contact.dealExpectedAt || null).run();
    inserted++;
  }
  return Response.json({ success: true, inserted, duplicates, ownerEmail: user.email, teamId: user.teamId || 'sales' });
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

function normalizeBrand(raw) {
  const first = (raw || 'Unspecified').split(/[,;\/]/)[0];
  return _titleCase(_normStr(first)) || 'Unspecified';
}

const REGION_MAP = {
  'UAE':'Middle East','Saudi Arabia':'Middle East','Qatar':'Middle East','Kuwait':'Middle East',
  'Bahrain':'Middle East','Oman':'Middle East','Jordan':'Middle East','Lebanon':'Middle East',
  'Iraq':'Middle East','Egypt':'Middle East','Morocco':'Middle East','Libya':'Middle East',
  'Tunisia':'Middle East','Algeria':'Middle East','Yemen':'Middle East','Syria':'Middle East',
  'Israel':'Middle East','Palestine':'Middle East','Turkey':'Middle East','Middle East':'Middle East',
  'UK':'Europe','Germany':'Europe','France':'Europe','Spain':'Europe','Italy':'Europe',
  'Netherlands':'Europe','Belgium':'Europe','Poland':'Europe','Portugal':'Europe',
  'Sweden':'Europe','Norway':'Europe','Denmark':'Europe','Finland':'Europe',
  'Austria':'Europe','Switzerland':'Europe','Greece':'Europe','Romania':'Europe',
  'Czech Republic':'Europe','Hungary':'Europe','Slovakia':'Europe','Croatia':'Europe',
  'Ukraine':'Europe','Serbia':'Europe','Bulgaria':'Europe','Europe':'Europe',
  'Russia':'CIS','Kazakhstan':'CIS','Uzbekistan':'CIS','Tajikistan':'CIS',
  'Kyrgyzstan':'CIS','Turkmenistan':'CIS','Azerbaijan':'CIS','Georgia':'CIS',
  'Armenia':'CIS','Belarus':'CIS','Moldova':'CIS','CIS':'CIS',
  'India':'Asia','Pakistan':'Asia','Bangladesh':'Asia','Sri Lanka':'Asia',
  'China':'Asia','Japan':'Asia','South Korea':'Asia','Taiwan':'Asia',
  'Singapore':'Asia','Malaysia':'Asia','Thailand':'Asia','Indonesia':'Asia',
  'Philippines':'Asia','Vietnam':'Asia','Myanmar':'Asia','Cambodia':'Asia',
  'Nepal':'Asia','Afghanistan':'Asia','Southeast Asia':'Asia',
  'USA':'Americas','Canada':'Americas','Mexico':'Americas','Brazil':'Americas',
  'Colombia':'Americas','Argentina':'Americas','Chile':'Americas','Peru':'Americas',
  'North America':'Americas','Latin America':'Americas',
  'Nigeria':'Africa','Kenya':'Africa','South Africa':'Africa','Ghana':'Africa',
  'Tanzania':'Africa','Ethiopia':'Africa','Uganda':'Africa','Cameroon':'Africa',
  'Senegal':'Africa','Zimbabwe':'Africa','Zambia':'Africa','Angola':'Africa',
  'Africa':'Africa',
  'Australia':'Oceania','New Zealand':'Oceania','Oceania':'Oceania',
};

function regionForCountry(country) { return REGION_MAP[country] || 'Other'; }

async function ownedLeadSummary(env, user) {
  const clause = user.role === 'Administrator' ? '(? IS NOT NULL)'
    : user.role === 'Manager' ? '(ownerEmail IS NULL OR teamId=?)' : 'ownerEmail=?';
  const scope = user.role === 'Sales' ? user.email : (user.teamId || '');
  const result = await env.DB.prepare(`SELECT platform,country,brand,COUNT(*) count FROM contacts WHERE ${clause}
    GROUP BY platform,country,brand ORDER BY count DESC`).bind(scope).all();

  // Normalize and re-aggregate (merge synonyms, title-case, split comma-brands)
  const aggMap = new Map();
  for (const row of (result.results || [])) {
    const platform = _titleCase(_normStr(row.platform || 'Unknown'));
    const country = normalizeCountry(row.country);
    const brand = normalizeBrand(row.brand);
    const count = Number(row.count || 0);
    const key = `${platform}||${country}||${brand}`;
    if (aggMap.has(key)) {
      aggMap.get(key).count += count;
    } else {
      aggMap.set(key, { platform, country, brand, count, region: regionForCountry(country), trend: 'Stable', velocity30DayPct: 0 });
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
