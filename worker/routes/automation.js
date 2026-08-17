const WRITE_ROLES = {
  'whizz-send-campaign': ['Administrator', 'Manager'],
  'whizz-create-template': ['Administrator', 'Manager'],
  'whizz-ai-template': ['Administrator', 'Manager'],
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

async function ownedLeadSummary(env, user) {
  const clause = user.role === 'Administrator' ? '(? IS NOT NULL)'
    : user.role === 'Manager' ? '(ownerEmail IS NULL OR teamId=?)' : 'ownerEmail=?';
  const scope = user.role === 'Sales' ? user.email : (user.teamId || '');
  const result = await env.DB.prepare(`SELECT platform,country,brand,COUNT(*) count FROM contacts WHERE ${clause}
    GROUP BY platform,country,brand ORDER BY count DESC`).bind(scope).all();
  const groups = (result.results || []).map(row => ({ platform: row.platform || 'Unknown', country: row.country || 'Unknown', brand: row.brand || 'Unspecified', count: Number(row.count || 0), trend: 'Stable', velocity30DayPct: 0 }));
  const matrix = new Map();
  for (const group of groups) {
    if (!matrix.has(group.brand)) matrix.set(group.brand, { brand: group.brand, total: 0, breakdownByPlatform: {}, breakdownByCountry: {} });
    const item = matrix.get(group.brand);item.total += group.count;
    item.breakdownByPlatform[group.platform] = (item.breakdownByPlatform[group.platform] || 0) + group.count;
    item.breakdownByCountry[group.country] = (item.breakdownByCountry[group.country] || 0) + group.count;
  }
  return Response.json({ groups, crossTabMatrix: [...matrix.values()], totalDistributedItems: groups.reduce((n,g)=>n+g.count,0),
    platforms: [...new Set(groups.map(g=>g.platform))], countries: [...new Set(groups.map(g=>g.country))], brands: [...new Set(groups.map(g=>g.brand))] });
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
