// ── Telegram Bulk Marketing module ──
// A separate module from the WhatsApp campaign system, talking to the Telegram Bot API
// directly (https://api.telegram.org/bot<token>/...) — no Chatwoot, no n8n, no template
// approval process. Two constraints shape everything here, both Telegram's own rules, not
// Whizz's:
//   1. A bot can only message a chat that has already started a conversation with it (pressed
//      Start or sent it any message) — there is no equivalent of WhatsApp's "message any
//      phone number via an approved template".
//   2. This module is direct-to-person only: every send target must be an individual's
//      private chat. A Telegram group/channel/supergroup chat ID is always a negative number
//      and is rejected outright; Whizz never broadcasts into one.
// Leads live in their own table (telegram_leads) rather than the CRM `contacts` table that
// WhatsApp campaigns use — a cold Telegram contact (someone who just messaged the bot, with
// no CRM record at all) is the normal case here, not an edge case, so the lead base needed to
// stand on its own rather than be bolted onto CRM contacts.
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
function json(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS }); }

async function currentUser(request, env) {
  const email = (request.headers.get('Cf-Access-Authenticated-User-Email') || '').trim().toLowerCase();
  return email ? env.DB.prepare('SELECT email,name,role,teamId FROM users WHERE email=?').bind(email).first() : null;
}
function requireAdmin(user) { return user && user.role === 'Administrator'; }

function ownerScope(user) {
  if (user.role === 'Manager') return { filter: 'AND (ownerEmail IS NULL OR teamId = ?)', param: user.teamId || '' };
  if (user.role === 'Sales') return { filter: 'AND ownerEmail = ?', param: user.email };
  return { filter: '', param: undefined };
}

// A Telegram chat ID is only ever a private-user chat (positive integer) in this module —
// a group/supergroup/channel ID is always negative, and those are never valid send targets.
function isPrivateChatId(value) { return /^\d+$/.test(String(value || '').trim()); }

// Same AES-GCM technique/secret as the Meta/Chatwoot tokens — kept as a local copy rather
// than a shared import, matching this repo's existing pattern of small per-route duplication.
async function cryptoKey(secret) {
  if (!secret) throw new Error('LEAD_INTELLIGENCE_KEY secret is not configured — set it with `wrangler secret put LEAD_INTELLIGENCE_KEY` before saving a Telegram bot token.');
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

async function getSettingsRow(env) { return env.DB.prepare('SELECT * FROM telegram_settings WHERE id=1').first(); }
export async function loadTelegramBotToken(env) {
  const row = await getSettingsRow(env);
  if (!row?.botTokenEncrypted) return null;
  return (await decryptToken(env, row.botTokenEncrypted)) || null;
}
async function telegramApi(token, method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok && data.ok, data };
}

export async function handleGetTelegramSettings(request, env) {
  const user = await currentUser(request, env);
  if (!requireAdmin(user)) return json({ error: 'Administrator access required.' }, 403);
  const row = await getSettingsRow(env);
  return json({ hasToken: !!row?.botTokenEncrypted, botUsername: row?.botUsername || '', webhookConfigured: !!row?.webhookSecret });
}

export async function handleSaveTelegramSettings(request, env) {
  const user = await currentUser(request, env);
  if (!requireAdmin(user)) return json({ error: 'Administrator access required.' }, 403);
  const body = await request.json().catch(() => ({}));
  const newToken = String(body.botToken || '').trim();
  const existing = await getSettingsRow(env);
  let botTokenEncrypted = existing?.botTokenEncrypted || null;
  let botUsername = existing?.botUsername || '';
  if (newToken) {
    // Validate against Telegram's own getMe before saving — a typo'd token would otherwise
    // only surface the first time a campaign tries (and fails) to send.
    const { ok, data } = await telegramApi(newToken, 'getMe');
    if (!ok) return json({ error: `Telegram rejected this token: ${data.description || 'invalid token'}` }, 400);
    botUsername = data.result?.username || '';
    try { botTokenEncrypted = await encryptToken(env, newToken); }
    catch (error) { return json({ error: error.message }, 500); }
  }
  if (!botTokenEncrypted) return json({ error: 'A bot token is required.' }, 400);
  const webhookSecret = existing?.webhookSecret || crypto.randomUUID().replace(/-/g, '');
  await env.DB.prepare(`INSERT INTO telegram_settings (id,botTokenEncrypted,botUsername,webhookSecret,updatedAt) VALUES (1,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET botTokenEncrypted=excluded.botTokenEncrypted, botUsername=excluded.botUsername, webhookSecret=excluded.webhookSecret, updatedAt=CURRENT_TIMESTAMP`)
    .bind(botTokenEncrypted, botUsername, webhookSecret).run();
  return json({ success: true, botUsername });
}

// One-click equivalent of Meta's manual "paste the webhook URL into the console" step —
// Telegram's setWebhook is a plain API call, so this does it for the admin instead of
// making them run a curl command by hand.
export async function handleSetTelegramWebhook(request, env) {
  const user = await currentUser(request, env);
  if (!requireAdmin(user)) return json({ error: 'Administrator access required.' }, 403);
  const token = await loadTelegramBotToken(env);
  if (!token) return json({ error: 'Save a bot token first.' }, 503);
  const row = await getSettingsRow(env);
  if (!row?.webhookSecret) return json({ error: 'No webhook secret on file — re-save the bot token first.' }, 503);
  const url = new URL(request.url);
  const callbackUrl = `${url.origin}/api/webhooks/telegram`;
  const { ok, data } = await telegramApi(token, 'setWebhook', { url: callbackUrl, secret_token: row.webhookSecret, allowed_updates: ['message'] });
  if (!ok) return json({ error: `Telegram rejected the webhook: ${data.description || 'unknown error'}` }, 502);
  return json({ success: true, url: callbackUrl });
}

// STOP-style opt-out detection — same intent and same best-effort caveat as optOuts.js's
// WhatsApp version: this only runs when a message actually reaches the webhook.
const STOP_PATTERN = /^\s*(stop|unsubscribe|opt[\s-]?out|cancel|remove me|\/stop)\s*[.!]?\s*$/i;

// Resolves (or creates) the telegram_leads row for an inbound private-chat message. Only
// ever called for chat.type === 'private' — see handleTelegramWebhookEvent.
async function findOrCreateTelegramLead(env, chatId, username, firstName, startLeadId) {
  const cleanUsername = String(username || '').trim();
  let lead = await env.DB.prepare('SELECT id,telegramChatId FROM telegram_leads WHERE telegramChatId=?').bind(String(chatId)).first();
  // A personal invite link (t.me/<bot>?start=<leadId>) names the exact lead to link — no
  // name/username guessing needed, so this takes priority over the username fallback.
  if (!lead && startLeadId) {
    lead = await env.DB.prepare('SELECT id,telegramChatId FROM telegram_leads WHERE id=?').bind(startLeadId).first();
  }
  if (!lead && cleanUsername) {
    lead = await env.DB.prepare(`SELECT id,telegramChatId FROM telegram_leads WHERE LOWER(telegramUsername)=LOWER(?) AND (telegramChatId IS NULL OR telegramChatId='')`).bind(cleanUsername).first();
  }
  if (lead) {
    if (!lead.telegramChatId) await env.DB.prepare('UPDATE telegram_leads SET telegramChatId=?,updatedAt=CURRENT_TIMESTAMP WHERE id=?').bind(String(chatId), lead.id).run();
    return lead.id;
  }
  const name = firstName || (cleanUsername ? `@${cleanUsername}` : `Telegram ${chatId}`);
  const result = await env.DB.prepare(`INSERT INTO telegram_leads (contactName,telegramChatId,telegramUsername,source,createdAt,updatedAt)
    VALUES (?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`)
    .bind(name, String(chatId), cleanUsername, 'bot_start').run();
  return result.meta.last_row_id;
}

export async function handleTelegramWebhookEvent(request, env) {
  const row = await getSettingsRow(env);
  if (row?.webhookSecret) {
    const header = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
    if (header !== row.webhookSecret) return json({ error: 'Invalid secret token.' }, 403);
  }
  const update = await request.json().catch(() => null);
  if (!update) return json({ received: true });
  try {
    const message = update.message;
    // Direct-to-person only: a message from a group/supergroup/channel chat (chat.type isn't
    // 'private') is never turned into a lead or logged — this module has no group/channel
    // audience at all, so there is nothing useful to do with it here.
    if (message && message.chat && message.chat.type === 'private') {
      const chatId = message.chat.id;
      const username = message.from?.username || '';
      const firstName = message.from?.first_name || '';
      const text = String(message.text || '');
      const startMatch = text.match(/^\/start(?:@\w+)?(?:\s+(\d+))?/);
      const startLeadId = startMatch?.[1] ? Number(startMatch[1]) : null;
      const leadId = await findOrCreateTelegramLead(env, chatId, username, firstName, startLeadId);
      if (STOP_PATTERN.test(text)) {
        await env.DB.prepare('INSERT INTO telegram_opted_out (chatId,source,reason) VALUES (?,?,?) ON CONFLICT(chatId) DO NOTHING')
          .bind(String(chatId), 'keyword_detected', `Replied "${text.trim().slice(0, 50)}"`).run();
      }
      await env.DB.prepare('INSERT INTO telegram_messages (chatId,contactId,direction,text,messageId,senderName) VALUES (?,?,?,?,?,?)')
        .bind(String(chatId), leadId, 'in', text, message.message_id || null, firstName || username || '').run();
    }
  } catch (_) {
    // Never fail the webhook response over a persistence hiccup — Telegram disables a
    // webhook that keeps erroring, which would silently stop capturing every chat going forward.
  }
  return json({ received: true });
}

// ── Opt-outs (mirrors worker/routes/optOuts.js, keyed on chatId instead of phone) ──
export async function handleListTelegramOptOuts(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'User is not provisioned in Whizz.' }, 403);
  const result = await env.DB.prepare('SELECT chatId,source,reason,createdAt FROM telegram_opted_out ORDER BY createdAt DESC').all();
  return json({ chats: result.results || [] });
}
export async function handleAddTelegramOptOut(request, env) {
  const user = await currentUser(request, env);
  if (!user || !['Administrator', 'Manager'].includes(user.role)) return json({ error: 'Administrator or Manager access required.' }, 403);
  const body = await request.json().catch(() => ({}));
  const chatId = String(body.chatId || '').trim();
  if (!chatId) return json({ error: 'A chat ID is required.' }, 400);
  await env.DB.prepare('INSERT INTO telegram_opted_out (chatId,source,reason,addedByEmail) VALUES (?,?,?,?) ON CONFLICT(chatId) DO NOTHING')
    .bind(chatId, 'manual', String(body.reason || '').slice(0, 200), user.email).run();
  return json({ success: true });
}
export async function handleRemoveTelegramOptOut(request, env, chatId) {
  const user = await currentUser(request, env);
  if (!user || !['Administrator', 'Manager'].includes(user.role)) return json({ error: 'Administrator or Manager access required.' }, 403);
  await env.DB.prepare('DELETE FROM telegram_opted_out WHERE chatId=?').bind(decodeURIComponent(chatId)).run();
  return json({ success: true });
}
export async function isTelegramOptedOut(env, chatId) {
  const row = await env.DB.prepare('SELECT 1 FROM telegram_opted_out WHERE chatId=?').bind(String(chatId)).first();
  return !!row;
}
async function getTelegramOptedOutSet(env, chatIds) {
  const unique = [...new Set(chatIds.filter(Boolean).map(String))];
  const out = new Set();
  for (let i = 0; i < unique.length; i += 100) {
    const batch = unique.slice(i, i + 100);
    const placeholders = batch.map(() => '?').join(',');
    const result = await env.DB.prepare(`SELECT chatId FROM telegram_opted_out WHERE chatId IN (${placeholders})`).bind(...batch).all();
    (result.results || []).forEach(r => out.add(r.chatId));
  }
  return out;
}

// ── Telegram Leads (the module's own lead base — see file header) ──

export async function handleListTelegramLeads(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'User is not provisioned in Whizz.' }, 403);
  const url = new URL(request.url);
  const search = (url.searchParams.get('search') || '').trim().toLowerCase();
  const tag = (url.searchParams.get('tag') || '').trim().toLowerCase();
  const reachableOnly = url.searchParams.get('reachableOnly') === '1';

  const scope = ownerScope(user);
  const binds = [`%${search}%`, `%${search}%`, `%${tag}%`];
  if (scope.param !== undefined) binds.push(scope.param);

  const result = await env.DB.prepare(`
    SELECT id,contactName,telegramUsername,telegramChatId,tags,source,crmContactId,telegramLastContactedAt,createdAt
    FROM telegram_leads
    WHERE (LOWER(contactName) LIKE ? OR LOWER(telegramUsername) LIKE ?)
      AND LOWER(tags) LIKE ?
      ${reachableOnly ? "AND telegramChatId IS NOT NULL AND telegramChatId <> ''" : ''}
      ${scope.filter}
    ORDER BY (telegramChatId IS NULL OR telegramChatId = ''), contactName COLLATE NOCASE
    LIMIT 1000
  `).bind(...binds).all();

  return json({ leads: result.results || [] });
}

export async function handleCreateTelegramLead(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'User is not provisioned in Whizz.' }, 403);
  const body = await request.json().catch(() => ({}));
  const contactName = String(body.contactName || '').trim();
  const telegramUsername = String(body.telegramUsername || '').trim().replace(/^@/, '');
  const rawChatId = String(body.telegramChatId || '').trim();
  const tags = String(body.tags || '').trim();
  if (!contactName) return json({ error: 'A name is required.' }, 400);
  if (rawChatId && !isPrivateChatId(rawChatId)) {
    return json({ error: 'That chat ID looks like a group, channel or supergroup (its number is negative) — this module only messages an individual person directly, so a group/channel chat ID can’t be added here.' }, 400);
  }
  if (!rawChatId && !telegramUsername) return json({ error: 'Add a known chat ID, or at least a Telegram username so you can invite them.' }, 400);
  if (rawChatId) {
    const existing = await env.DB.prepare('SELECT id FROM telegram_leads WHERE telegramChatId=?').bind(rawChatId).first();
    if (existing) return json({ error: 'That chat ID is already in your Telegram leads list.' }, 409);
  }
  const result = await env.DB.prepare(`INSERT INTO telegram_leads (contactName,telegramUsername,telegramChatId,tags,source,ownerEmail,teamId,createdAt,updatedAt)
    VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`)
    .bind(contactName, telegramUsername, rawChatId || null, tags, 'manual', user.email, user.teamId || null).run();
  return json({ success: true, id: result.meta.last_row_id });
}

export async function handleUpdateTelegramLead(request, env, id) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'User is not provisioned in Whizz.' }, 403);
  const body = await request.json().catch(() => ({}));
  const contactName = String(body.contactName || '').trim();
  const telegramUsername = String(body.telegramUsername || '').trim().replace(/^@/, '');
  const tags = String(body.tags || '').trim();
  const rawChatId = body.telegramChatId === undefined ? undefined : String(body.telegramChatId || '').trim();
  if (!contactName) return json({ error: 'A name is required.' }, 400);
  if (rawChatId && !isPrivateChatId(rawChatId)) {
    return json({ error: 'That chat ID looks like a group, channel or supergroup (its number is negative) — this module only messages an individual person directly.' }, 400);
  }
  const scope = ownerScope(user);
  const binds = [contactName, telegramUsername, tags];
  let setChatId = '';
  if (rawChatId !== undefined) { setChatId = ', telegramChatId=?'; binds.push(rawChatId || null); }
  binds.push(id);
  if (scope.param !== undefined) binds.push(scope.param);
  const result = await env.DB.prepare(`UPDATE telegram_leads SET contactName=?,telegramUsername=?,tags=?${setChatId},updatedAt=CURRENT_TIMESTAMP WHERE id=? ${scope.filter}`).bind(...binds).run();
  if (!result.meta.changes) return json({ error: 'Lead not found or access denied.' }, 404);
  return json({ success: true });
}

export async function handleDeleteTelegramLead(request, env, id) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'User is not provisioned in Whizz.' }, 403);
  const scope = ownerScope(user);
  const binds = [id];
  if (scope.param !== undefined) binds.push(scope.param);
  const result = await env.DB.prepare(`DELETE FROM telegram_leads WHERE id=? ${scope.filter}`).bind(...binds).run();
  if (!result.meta.changes) return json({ error: 'Lead not found or access denied.' }, 404);
  return json({ success: true });
}

// One-off bridge from the CRM: pulls in contacts that have a Telegram handle on file (e.g.
// from lead-enrichment website scanning) and aren't already in the Telegram leads list, as
// not-yet-started leads ready to be invited. Does not touch the CRM contacts table — this
// only ever copies into telegram_leads, the lead base this module actually sends from.
export async function handleImportTelegramLeadsFromCrm(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'User is not provisioned in Whizz.' }, 403);

  let ownerFilter = '';
  let ownerParam;
  if (user.role === 'Manager') { ownerFilter = 'AND (ownerEmail IS NULL OR teamId = ?)'; ownerParam = user.teamId || ''; }
  else if (user.role === 'Sales') { ownerFilter = 'AND ownerEmail = ?'; ownerParam = user.email; }
  const binds = [];
  if (ownerParam !== undefined) binds.push(ownerParam);

  const candidates = await env.DB.prepare(`
    SELECT id,contactName,telegramUsername,ownerEmail,teamId FROM contacts
    WHERE telegramUsername IS NOT NULL AND telegramUsername <> '' ${ownerFilter}
  `).bind(...binds).all();

  let imported = 0;
  for (const c of candidates.results || []) {
    const existing = await env.DB.prepare('SELECT id FROM telegram_leads WHERE LOWER(telegramUsername)=LOWER(?)').bind(c.telegramUsername).first();
    if (existing) continue;
    await env.DB.prepare(`INSERT INTO telegram_leads (contactName,telegramUsername,source,crmContactId,ownerEmail,teamId,createdAt,updatedAt)
      VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`)
      .bind(c.contactName || `@${c.telegramUsername}`, c.telegramUsername, 'imported_from_crm', c.id, c.ownerEmail || null, c.teamId || null).run();
    imported++;
  }
  return json({ imported, skipped: (candidates.results || []).length - imported });
}

// Any provisioned user needs this to build an invite link — not just the Administrator who
// configured the bot token — so it's deliberately a separate, narrower endpoint from
// handleGetTelegramSettings rather than widening that one's access.
export async function handleGetTelegramBotUsername(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'User is not provisioned in Whizz.' }, 403);
  const row = await getSettingsRow(env);
  return json({ botUsername: row?.botUsername || '' });
}

// Personal deep link (t.me/<bot>?start=<leadId>) for a lead who has a username on file but
// hasn't started the bot yet. The moment they tap it and hit Start, the webhook links this
// exact lead automatically — no name/username guessing needed on the way back.
export async function handleGenerateTelegramInviteLink(request, env, id) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'User is not provisioned in Whizz.' }, 403);
  const scope = ownerScope(user);
  const binds = [id];
  if (scope.param !== undefined) binds.push(scope.param);
  const lead = await env.DB.prepare(`SELECT id,contactName,telegramChatId FROM telegram_leads WHERE id=? ${scope.filter}`).bind(...binds).first();
  if (!lead) return json({ error: 'Lead not found or access denied.' }, 404);
  const row = await getSettingsRow(env);
  if (!row?.botUsername) return json({ error: 'Bot username unavailable — save a bot token under Bot Setup first.' }, 503);
  return json({ link: `https://t.me/${row.botUsername}?start=${lead.id}`, alreadyStarted: !!lead.telegramChatId });
}

function classifyTelegramError(description) {
  const d = String(description || '').toLowerCase();
  if (d.includes('blocked') || d.includes('chat not found') || d.includes('deactivated') || d.includes('kicked')) return 'permanent';
  if (d.includes('too many requests')) return 'transient';
  return 'unknown';
}

// Preview how many of a resolved audience can actually be reached — the headline caveat of
// this whole module, surfaced before anyone clicks Send rather than discovered after.
export async function handleTelegramAudiencePreview(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'User is not provisioned in Whizz.' }, 403);
  const body = await request.json().catch(() => ({}));
  const search = String(body.search || '').trim().toLowerCase();
  const tag = String(body.tag || '').trim().toLowerCase();
  const scope = ownerScope(user);
  const binds = [`%${search}%`, `%${search}%`, `%${tag}%`];
  if (scope.param !== undefined) binds.push(scope.param);
  const result = await env.DB.prepare(`
    SELECT telegramChatId FROM telegram_leads
    WHERE (LOWER(contactName) LIKE ? OR LOWER(telegramUsername) LIKE ?)
      AND LOWER(tags) LIKE ?
      ${scope.filter}
  `).bind(...binds).all();
  const rows = result.results || [];
  const withTelegram = rows.filter(r => r.telegramChatId).length;
  return json({ total: rows.length, withTelegram, withoutTelegram: rows.length - withTelegram });
}

// Upserts a chat ID pasted straight into the "Chat ID List" audience mode into the lead
// base, so every send target ends up tracked there regardless of how it was entered — the
// lead base stays the single source of truth for who Whizz has ever reached on Telegram.
async function upsertTelegramLeadForChatId(env, user, chatId, name) {
  const existing = await env.DB.prepare('SELECT id FROM telegram_leads WHERE telegramChatId=?').bind(chatId).first();
  if (existing) return existing.id;
  const result = await env.DB.prepare(`INSERT INTO telegram_leads (contactName,telegramChatId,source,ownerEmail,teamId,createdAt,updatedAt)
    VALUES (?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`)
    .bind(name || chatId, chatId, 'chatid_paste', user.email, user.teamId || null).run();
  return result.meta.last_row_id;
}

export async function handleSendTelegramCampaign(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'User is not provisioned in Whizz.' }, 403);
  const token = await loadTelegramBotToken(env);
  if (!token) return json({ error: 'Telegram isn’t connected yet. Add a bot token under the Telegram module’s Bot Setup.' }, 503);

  const body = await request.json().catch(() => ({}));
  const message = String(body.message || '').trim();
  if (!message) return json({ error: 'A message is required.' }, 400);

  const targetContacts = Array.isArray(body.targetContacts) ? body.targetContacts : null;
  let contacts;
  const resolveFails = [];
  if (targetContacts) {
    contacts = targetContacts.map(c => ({ id: c.id || null, contactName: c.name || '', telegramChatId: c.chatId }));
    // Reject anything that isn't an individual's private chat ID up front (negative numbers
    // are always a group/supergroup/channel) — direct-to-person only, no exceptions.
    for (const c of contacts) {
      if (c.telegramChatId && !isPrivateChatId(c.telegramChatId)) {
        resolveFails.push({ contactId: c.id, chatId: null, name: c.contactName, status: 'failed', bucket: 'permanent',
          reason: `"${c.telegramChatId}" looks like a group, channel or supergroup chat ID (it's negative) — this module only messages an individual person directly, so it can't be sent to.` });
        c._invalid = true;
      }
    }
    contacts = contacts.filter(c => !c._invalid);
    // A pasted Chat ID List bypasses the Telegram Leads table on entry — fold every valid
    // target into it now, so the lead base stays the record of everyone ever reached here.
    if (body.source === 'chatid_list') {
      for (const c of contacts) {
        if (c.telegramChatId) c.id = c.id || await upsertTelegramLeadForChatId(env, user, String(c.telegramChatId), c.contactName);
      }
    }
  } else {
    const search = String(body.search || '').trim().toLowerCase();
    const tag = String(body.tag || '').trim().toLowerCase();
    const scope = ownerScope(user);
    const binds = [`%${search}%`, `%${search}%`, `%${tag}%`];
    if (scope.param !== undefined) binds.push(scope.param);
    const result = await env.DB.prepare(`
      SELECT id,contactName,telegramChatId,telegramLastContactedAt FROM telegram_leads
      WHERE (LOWER(contactName) LIKE ? OR LOWER(telegramUsername) LIKE ?)
        AND LOWER(tags) LIKE ?
        ${scope.filter}
    `).bind(...binds).all();
    contacts = result.results || [];
  }

  const guard = body.delivery_guard || {};
  const seenChats = new Set();
  const skipped = [];
  let eligible = contacts.filter(c => {
    const chatId = c.telegramChatId ? String(c.telegramChatId) : '';
    if (!chatId) { skipped.push({ contactId: c.id, name: c.contactName, reason: 'No linked Telegram chat — this lead hasn’t started the bot yet' }); return false; }
    if (seenChats.has(chatId)) { skipped.push({ contactId: c.id, name: c.contactName, reason: 'Duplicate Telegram chat in this audience' }); return false; }
    seenChats.add(chatId);
    return true;
  });

  if (guard.frequency_cap_days) {
    const cutoff = Date.now() - guard.frequency_cap_days * 86400000;
    eligible = eligible.filter(c => {
      if (!c.telegramLastContactedAt) return true;
      const last = new Date(c.telegramLastContactedAt).getTime();
      if (!Number.isNaN(last) && last > cutoff) { skipped.push({ contactId: c.id, name: c.contactName, reason: `Contacted on Telegram within the last ${guard.frequency_cap_days} days` }); return false; }
      return true;
    });
  }

  const optedOutSet = await getTelegramOptedOutSet(env, eligible.map(c => c.telegramChatId));
  if (optedOutSet.size) {
    eligible = eligible.filter(c => {
      if (optedOutSet.has(String(c.telegramChatId))) { skipped.push({ contactId: c.id, name: c.contactName, reason: 'Opted out of Telegram marketing messages' }); return false; }
      return true;
    });
  }

  const results = [];
  let totalFails = 0;
  for (const contact of eligible) {
    const chatId = String(contact.telegramChatId);
    const text = message.replace(/\{\{\s*name\s*\}\}/gi, contact.contactName || 'there');
    let sendResult = await telegramApi(token, 'sendMessage', { chat_id: chatId, text });
    // Telegram's own rate limit — respect the server-told backoff and retry exactly once,
    // rather than either ignoring it (risking a longer ban) or giving up immediately.
    if (!sendResult.ok && sendResult.data.error_code === 429 && sendResult.data.parameters?.retry_after) {
      await new Promise(r => setTimeout(r, Math.min(10000, sendResult.data.parameters.retry_after * 1000)));
      sendResult = await telegramApi(token, 'sendMessage', { chat_id: chatId, text });
    }
    if (!sendResult.ok) {
      const description = sendResult.data.description || `Telegram API error (${sendResult.data.error_code || 'unknown'})`;
      const bucket = classifyTelegramError(description);
      totalFails++;
      results.push({ contactId: contact.id, chatId, name: contact.contactName, status: 'failed', reason: description, bucket });
      // Being blocked is an explicit withdrawal of consent, same as a WhatsApp opt-out —
      // suppress the chat going forward instead of letting every future campaign retry it.
      if (bucket === 'permanent' && description.toLowerCase().includes('blocked')) {
        try { await env.DB.prepare('INSERT INTO telegram_opted_out (chatId,source,reason) VALUES (?,?,?) ON CONFLICT(chatId) DO NOTHING').bind(chatId, 'keyword_detected', 'Blocked the bot').run(); } catch (_) {}
      }
      continue;
    }
    results.push({ contactId: contact.id, chatId, name: contact.contactName, status: 'sent', messageId: sendResult.data.result?.message_id });
    if (contact.id) await env.DB.prepare('UPDATE telegram_leads SET telegramLastContactedAt=CURRENT_TIMESTAMP WHERE id=?').bind(contact.id).run();
  }

  return json({
    total: eligible.length + resolveFails.length,
    sent: eligible.length - totalFails,
    failed: totalFails + resolveFails.length,
    skipped: skipped.length,
    skippedDetail: skipped,
    results: [...resolveFails, ...results],
  });
}
