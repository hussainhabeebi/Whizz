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

export async function handleAutomation(request, env, endpoint) {
  const email = emailFromAccess(request);
  const user = email ? await env.DB.prepare('SELECT email,role,teamId FROM users WHERE email=?').bind(email).first() : null;
  if (!user) return Response.json({ error: 'Authenticated user is not provisioned in Whizz.' }, { status: 403 });

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
