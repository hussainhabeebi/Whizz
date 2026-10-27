// ── Chatwoot integration (app.aiingo.com) ──
// Talks to Chatwoot's REST API directly using an account-scoped API access token.
// Unlike most other integrations here, the token is entered from the Integrations page
// (Administrator only) and stored encrypted in D1 — not a wrangler secret — so it can be
// rotated without a deploy. Multiple inboxes can be registered; each becomes its own tab
// in the Conversations page.
import { logUserActivity } from './teamActivity.js';
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
function json(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS }); }
function emailFromAccess(request) { return (request.headers.get('Cf-Access-Authenticated-User-Email') || '').trim().toLowerCase(); }

async function currentUser(request, env) {
  const email = emailFromAccess(request);
  return email ? env.DB.prepare('SELECT email,name,role,teamId FROM users WHERE email=?').bind(email).first() : null;
}
function requireAdmin(user) { return user && user.role === 'Administrator'; }

// ── Token encryption (AES-GCM, same technique/secret as Lead Intelligence's directory
// credentials) so the API token can live in D1 without sitting around in plain text. ──
async function cryptoKey(secret) {
  if (!secret) throw new Error('LEAD_INTELLIGENCE_KEY secret is not configured — set it with `wrangler secret put LEAD_INTELLIGENCE_KEY` before saving a Chatwoot token.');
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
function toB64(bytes) { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); }
function fromB64(s) { const bin = atob(s); return Uint8Array.from(bin, c => c.charCodeAt(0)); }
async function encryptToken(env, value) {
  const key = await cryptoKey(env.LEAD_INTELLIGENCE_KEY);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(value));
  return `${toB64(iv)}.${toB64(new Uint8Array(cipher))}`;
}
async function decryptToken(env, token) {
  if (!token) return '';
  const [iv64, data64] = token.split('.');
  const key = await cryptoKey(env.LEAD_INTELLIGENCE_KEY);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv64) }, key, fromB64(data64));
  return new TextDecoder().decode(plain);
}

async function getSettingsRow(env) { return env.DB.prepare('SELECT * FROM chatwoot_settings WHERE id=1').first(); }
async function listInboxes(env) {
  const result = await env.DB.prepare('SELECT id,inboxId,label,wabaId,phoneNumber,phoneNumberId FROM chatwoot_inboxes ORDER BY id').all();
  return result.results || [];
}
export async function loadChatwootConfig(env) {
  const row = await getSettingsRow(env);
  if (!row || !row.accountId || !row.apiTokenEncrypted) return null;
  const apiToken = await decryptToken(env, row.apiTokenEncrypted);
  if (!apiToken) return null;
  return { baseUrl: String(row.baseUrl || 'https://app.aiingo.com').replace(/\/$/, ''), accountId: row.accountId, apiToken };
}

export async function chatwootFetch(config, path, options = {}) {
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
    inboxId: String(raw.inbox_id ?? ''),
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
// Field names follow Chatwoot's documented message object shape. status/content_type/
// private/attachments/content_attributes power the WhatsApp-style ticks, internal-note
// styling, attachment rendering and quote-reply already built in the Conversations page.
function normalizeMessage(raw) {
  return {
    id: raw.id,
    content: raw.content || '',
    message_type: raw.message_type,
    sender_type: raw.sender_type || raw.sender?.type || '',
    sender_name: raw.sender?.name || '',
    created_at: raw.created_at,
    status: raw.status || '',
    content_type: raw.content_type || '',
    private: !!raw.private,
    in_reply_to: raw.content_attributes?.in_reply_to || null,
    attachments: (Array.isArray(raw.attachments) ? raw.attachments : []).map(a => ({
      file_type: a.file_type || '', data_url: a.data_url || a.file_url || '', thumb_url: a.thumb_url || '',
    })),
  };
}

// ── Non-secret info any signed-in user needs: deep-link base + the inbox tabs. ──
export async function handleChatwootMeta(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'User is not provisioned in Whizz.' }, 403);
  const row = await getSettingsRow(env);
  const inboxes = await listInboxes(env);
  return json({ baseUrl: row?.baseUrl || 'https://app.aiingo.com', accountId: row?.accountId || '', configured: !!(row?.accountId && row?.apiTokenEncrypted), inboxes });
}

export async function handleGetChatwootSettings(request, env) {
  const user = await currentUser(request, env);
  if (!requireAdmin(user)) return json({ error: 'Administrator access required.' }, 403);
  const row = await getSettingsRow(env);
  const inboxes = await listInboxes(env);
  return json({ baseUrl: row?.baseUrl || 'https://app.aiingo.com', accountId: row?.accountId || '', hasToken: !!row?.apiTokenEncrypted, inboxes });
}

export async function handleSaveChatwootSettings(request, env) {
  const user = await currentUser(request, env);
  if (!requireAdmin(user)) return json({ error: 'Administrator access required.' }, 403);
  const body = await request.json().catch(() => ({}));
  const baseUrl = String(body.baseUrl || 'https://app.aiingo.com').trim().replace(/\/$/, '');
  const accountId = String(body.accountId || '').trim();
  if (!accountId) return json({ error: 'Account ID is required.' }, 400);

  const existing = await getSettingsRow(env);
  let apiTokenEncrypted = existing?.apiTokenEncrypted || null;
  const newToken = String(body.apiToken || '').trim();
  if (newToken) {
    try { apiTokenEncrypted = await encryptToken(env, newToken); }
    catch (error) { return json({ error: error.message }, 500); }
  }
  await env.DB.prepare(`INSERT INTO chatwoot_settings (id,baseUrl,accountId,apiTokenEncrypted,updatedAt) VALUES (1,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET baseUrl=excluded.baseUrl, accountId=excluded.accountId, apiTokenEncrypted=excluded.apiTokenEncrypted, updatedAt=CURRENT_TIMESTAMP`)
    .bind(baseUrl, accountId, apiTokenEncrypted).run();
  return json({ success: true });
}

export async function handleAddChatwootInbox(request, env) {
  const user = await currentUser(request, env);
  if (!requireAdmin(user)) return json({ error: 'Administrator access required.' }, 403);
  const body = await request.json().catch(() => ({}));
  const inboxId = String(body.inboxId || '').trim();
  const label = String(body.label || '').trim();
  const wabaId = String(body.wabaId || '').trim();
  const phoneNumber = String(body.phoneNumber || '').trim();
  const phoneNumberId = String(body.phoneNumberId || '').trim();
  if (!inboxId || !label) return json({ error: 'Inbox ID and a label are required.' }, 400);
  try {
    const result = await env.DB.prepare('INSERT INTO chatwoot_inboxes (inboxId,label,wabaId,phoneNumber,phoneNumberId) VALUES (?,?,?,?,?)').bind(inboxId, label, wabaId, phoneNumber, phoneNumberId).run();
    return json({ success: true, inbox: { id: result.meta.last_row_id, inboxId, label, wabaId, phoneNumber, phoneNumberId } }, 201);
  } catch (error) {
    if (String(error.message).toLowerCase().includes('unique')) return json({ error: 'This inbox ID is already added.' }, 409);
    throw error;
  }
}

export async function handleUpdateChatwootInbox(request, env, id) {
  const user = await currentUser(request, env);
  if (!requireAdmin(user)) return json({ error: 'Administrator access required.' }, 403);
  const body = await request.json().catch(() => ({}));
  const label = String(body.label || '').trim();
  const wabaId = String(body.wabaId || '').trim();
  const phoneNumber = String(body.phoneNumber || '').trim();
  const phoneNumberId = String(body.phoneNumberId || '').trim();
  if (!label) return json({ error: 'A label is required.' }, 400);
  const result = await env.DB.prepare('UPDATE chatwoot_inboxes SET label=?,wabaId=?,phoneNumber=?,phoneNumberId=? WHERE id=?').bind(label, wabaId, phoneNumber, phoneNumberId, id).run();
  return result.meta.changes ? json({ success: true }) : json({ error: 'Inbox not found.' }, 404);
}

export async function handleDeleteChatwootInbox(request, env, id) {
  const user = await currentUser(request, env);
  if (!requireAdmin(user)) return json({ error: 'Administrator access required.' }, 403);
  await env.DB.prepare('DELETE FROM chatwoot_inboxes WHERE id=?').bind(id).run();
  return json({ success: true });
}

export async function handleChatwootConversations(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'User is not provisioned in Whizz.' }, 403);
  const config = await loadChatwootConfig(env);
  if (!config) return json({ error: 'Chatwoot is not configured yet. Add your API token under Integrations.' }, 503);

  const url = new URL(request.url);
  const status = url.searchParams.get('status') || 'open';
  let inboxId = url.searchParams.get('inboxId') || '';
  if (!inboxId) {
    const inboxes = await listInboxes(env);
    if (inboxes.length === 1) inboxId = inboxes[0].inboxId;
  }
  const params = new URLSearchParams({ status });
  if (inboxId) params.set('inbox_id', inboxId);

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
  const config = await loadChatwootConfig(env);
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

  // message_type 2 = activity (Chatwoot system events like "conversation resolved") —
  // not a real message, so it's dropped rather than shown as a chat bubble.
  return json({ messages: all.filter(m => m.message_type !== 2).map(normalizeMessage) });
}

// Returns the normalized message flat (not wrapped) — the frontend spreads this
// directly onto its optimistic in-flight message object.
export async function handleChatwootSendMessage(request, env, conversationId) {
  const access = await requireConversationAccess(request, env, conversationId);
  if (access.error) return access.error;
  const { config } = access;

  const body = await request.json().catch(() => ({}));
  const content = String(body.content || '').trim();
  if (!content) return json({ error: 'Message content is required.' }, 400);
  const replyToId = body.replyToId || null;
  const inboxId = String(body.inboxId || '').trim();

  let created;
  try {
    created = await chatwootFetch(config, `/conversations/${encodeURIComponent(conversationId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content, message_type: 'outgoing', private: false, ...(replyToId ? { content_attributes: { in_reply_to: replyToId } } : {}) }),
    });
  } catch (error) { return json({ error: error.message }, 502); }

  await logUserActivity(env, access.user.email, 'message_sent', 1, inboxId);
  return json(normalizeMessage(created));
}

// Chatwoot-side only — this does NOT unsend the message from WhatsApp; the customer's
// phone still has it. WhatsApp's Business Platform has no "delete for everyone" API.
export async function handleChatwootDeleteMessage(request, env, conversationId, messageId) {
  const access = await requireConversationAccess(request, env, conversationId);
  if (access.error) return access.error;
  const { config } = access;
  try {
    await chatwootFetch(config, `/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`, { method: 'DELETE' });
  } catch (error) { return json({ error: error.message }, 502); }
  return json({ success: true });
}

export async function findOrCreateContact(config, phone, name) {
  const search = await chatwootFetch(config, `/contacts/search?q=${encodeURIComponent(phone)}`);
  const existing = (search.payload || [])[0];
  if (existing) return existing;
  const created = await chatwootFetch(config, '/contacts', {
    method: 'POST',
    body: JSON.stringify({ name: name || phone, phone_number: phone.startsWith('+') ? phone : `+${phone}` }),
  });
  return created.payload?.contact || created;
}

export async function findOrCreateConversation(config, inboxId, contact, phone) {
  const list = await chatwootFetch(config, `/contacts/${contact.id}/conversations`);
  const existing = (list.payload || []).find(c => String(c.inbox_id) === String(inboxId));
  if (existing) return existing;
  return chatwootFetch(config, '/conversations', {
    method: 'POST',
    body: JSON.stringify({ source_id: phone, inbox_id: inboxId, contact_id: contact.id }),
  });
}

// Single-contact template sending moved to worker/routes/campaignSend.js
// (handleSendTemplateMessageMeta) — it now goes direct to Meta's Graph API, the same
// engine bulk campaigns use, instead of guessing at Chatwoot's template_params shape.

// Reports → WhatsApp Number Activity moved to worker/routes/teamActivity.js
// (handleInboxActivityReport) — Chatwoot's own /reports endpoint 404s on this account,
// so it's built from Whizz's own user_activity_log (sent) and Meta's Graph API
// Conversation Analytics (replies) instead.
