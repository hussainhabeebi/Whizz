// ── Chatwoot integration (app.aiingo.com) ──
// Talks to Chatwoot's REST API directly using an account-scoped API access token and
// inbox id, instead of proxying through n8n. Config lives in env:
//   CHATWOOT_BASE_URL    (vars)   — defaults to https://app.aiingo.com
//   CHATWOOT_ACCOUNT_ID  (vars)
//   CHATWOOT_INBOX_ID    (vars)
//   CHATWOOT_API_TOKEN   (secret) — set with `wrangler secret put CHATWOOT_API_TOKEN`
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
function json(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS }); }
function emailFromAccess(request) { return (request.headers.get('Cf-Access-Authenticated-User-Email') || '').trim().toLowerCase(); }

async function currentUser(request, env) {
  const email = emailFromAccess(request);
  return email ? env.DB.prepare('SELECT email,name,role,teamId FROM users WHERE email=?').bind(email).first() : null;
}

function chatwootConfig(env) {
  const baseUrl = String(env.CHATWOOT_BASE_URL || 'https://app.aiingo.com').replace(/\/$/, '');
  const accountId = env.CHATWOOT_ACCOUNT_ID;
  const inboxId = env.CHATWOOT_INBOX_ID;
  const apiToken = env.CHATWOOT_API_TOKEN;
  if (!accountId || !apiToken) return null;
  return { baseUrl, accountId, inboxId, apiToken };
}

async function chatwootFetch(config, path, options = {}) {
  const response = await fetch(`${config.baseUrl}/api/v1/accounts/${config.accountId}${path}`, {
    ...options,
    headers: { api_access_token: config.apiToken, 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || data.error || `Chatwoot API request failed (${response.status})`);
  return data;
}

async function assignmentsByConversation(env) {
  const result = await env.DB.prepare(`SELECT a.conversationId,a.assignedUserEmail,a.assignedTeamId,
    u.name assignedUserName FROM conversation_assignments a LEFT JOIN users u ON u.email=a.assignedUserEmail`).all();
  return new Map((result.results || []).map(a => [String(a.conversationId), a]));
}

function visibleToUser(user, assignment) {
  if (user.role === 'Administrator') return true;
  if (user.role === 'Manager') return !assignment || assignment.assignedTeamId === user.teamId;
  return assignment?.assignedUserEmail === user.email;
}

function channelLabel(raw) {
  const s = String(raw || '').toLowerCase();
  if (s.includes('whatsapp')) return 'whatsapp';
  if (s.includes('email')) return 'email';
  return 'chat';
}

function normalizeConversation(raw, assignment) {
  const meta = raw.meta || {};
  const sender = meta.sender || {};
  const last = raw.last_non_activity_message || null;
  return {
    id: raw.id,
    contact_name: sender.name || 'Unknown',
    phone: sender.phone_number || sender.phone || '',
    channel: channelLabel(meta.channel || raw.channel),
    status: raw.status,
    last_activity: raw.timestamp || raw.last_activity_at || 0,
    last_message: last?.content || '',
    unread: raw.unread_count || 0,
    assignment: assignment ? { userEmail: assignment.assignedUserEmail, userName: assignment.assignedUserName || assignment.assignedUserEmail, teamId: assignment.assignedTeamId } : null,
  };
}

function normalizeMessage(raw) {
  return {
    id: raw.id,
    content: raw.content || '',
    message_type: raw.message_type,
    created_at: raw.created_at,
    sender_name: raw.sender?.name || '',
  };
}

export async function handleChatwootConfig(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'User is not provisioned in Whizz.' }, 403);
  const config = chatwootConfig(env);
  if (!config) return json({ error: 'Chatwoot is not configured yet. Set CHATWOOT_ACCOUNT_ID and CHATWOOT_API_TOKEN.' }, 503);
  return json({ baseUrl: config.baseUrl, accountId: config.accountId });
}

export async function handleChatwootConversations(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'User is not provisioned in Whizz.' }, 403);
  const config = chatwootConfig(env);
  if (!config) return json({ error: 'Chatwoot is not configured yet.' }, 503);

  const url = new URL(request.url);
  const status = url.searchParams.get('status') || 'open';
  const params = new URLSearchParams({ status });
  if (config.inboxId) params.set('inbox_id', config.inboxId);

  let data;
  try { data = await chatwootFetch(config, `/conversations?${params.toString()}`); }
  catch (error) { return json({ error: error.message }, 502); }

  const payload = data.data?.payload || data.payload || [];
  const assignments = await assignmentsByConversation(env);
  const conversations = payload
    .map(raw => normalizeConversation(raw, assignments.get(String(raw.id))))
    .filter(conversation => visibleToUser(user, assignments.get(String(conversation.id))));

  const assigneeQuery = 'SELECT email,name,role,teamId FROM users WHERE role IN (\'Manager\',\'Sales\')';
  const assignees = user.role === 'Administrator'
    ? await env.DB.prepare(assigneeQuery + ' ORDER BY name COLLATE NOCASE').all()
    : user.role === 'Manager'
      ? await env.DB.prepare(assigneeQuery + ' AND teamId=? ORDER BY name COLLATE NOCASE').bind(user.teamId || '').all()
      : { results: [] };

  return json({ conversations, assignees: assignees.results || [] });
}

async function requireConversationAccess(request, env, conversationId) {
  const user = await currentUser(request, env);
  if (!user) return { error: json({ error: 'User is not provisioned in Whizz.' }, 403) };
  const config = chatwootConfig(env);
  if (!config) return { error: json({ error: 'Chatwoot is not configured yet.' }, 503) };
  if (user.role !== 'Administrator') {
    const assignment = await env.DB.prepare('SELECT assignedUserEmail,assignedTeamId FROM conversation_assignments WHERE conversationId=?').bind(conversationId).first();
    if (!visibleToUser(user, assignment)) return { error: json({ error: 'This conversation is not assigned to you.' }, 403) };
  }
  return { user, config };
}

// Chatwoot paginates messages (most recent ~20 per page via a `before` message-id cursor).
// Walk back a few pages so the thread reads as a full history, not just the last handful.
const MESSAGE_PAGE_LIMIT = 4;
export async function handleChatwootMessages(request, env, conversationId) {
  const access = await requireConversationAccess(request, env, conversationId);
  if (access.error) return access.error;
  const { config } = access;

  let all = [];
  let before;
  try {
    for (let page = 0; page < MESSAGE_PAGE_LIMIT; page++) {
      const params = before ? `?before=${encodeURIComponent(before)}` : '';
      const data = await chatwootFetch(config, `/conversations/${encodeURIComponent(conversationId)}/messages${params}`);
      const batch = data.payload || [];
      if (!batch.length) break;
      all = batch.concat(all);
      before = batch[0].id;
      if (batch.length < 20) break;
    }
  } catch (error) { return json({ error: error.message }, 502); }

  return json({ messages: all.map(normalizeMessage) });
}

export async function handleChatwootSendMessage(request, env, conversationId) {
  const access = await requireConversationAccess(request, env, conversationId);
  if (access.error) return access.error;
  const { config } = access;

  const body = await request.json().catch(() => ({}));
  const content = String(body.content || '').trim();
  if (!content) return json({ error: 'Message content is required.' }, 400);

  let created;
  try {
    created = await chatwootFetch(config, `/conversations/${encodeURIComponent(conversationId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content, message_type: 'outgoing' }),
    });
  } catch (error) { return json({ error: error.message }, 502); }

  return json({ message: normalizeMessage(created) });
}
