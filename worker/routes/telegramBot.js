// ── Telegram Bulk Marketing module ──
// A separate module from the WhatsApp campaign system, talking to the Telegram Bot API
// directly (https://api.telegram.org/bot<token>/...) — no Chatwoot, no n8n, no template
// approval process. The fundamental constraint that shapes everything here: a Telegram bot
// can only message a chat that has already started a conversation with it (pressed Start or
// sent it any message). There is no equivalent of WhatsApp's "message any phone number via
// an approved template" — bulk sending can only ever reach contacts who already have a
// telegramChatId on file, captured by the webhook below when they first message the bot.
import { resolveContactsForCampaign } from './automation.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
function json(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS }); }

async function currentUser(request, env) {
  const email = (request.headers.get('Cf-Access-Authenticated-User-Email') || '').trim().toLowerCase();
  return email ? env.DB.prepare('SELECT email,name,role,teamId FROM users WHERE email=?').bind(email).first() : null;
}
function requireAdmin(user) { return user && user.role === 'Administrator'; }

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

async function findOrCreateTelegramContact(env, chatId, username, firstName) {
  const cleanUsername = String(username || '').trim();
  let contact = await env.DB.prepare('SELECT id,telegramChatId FROM contacts WHERE telegramChatId=?').bind(String(chatId)).first();
  if (!contact && cleanUsername) {
    contact = await env.DB.prepare('SELECT id,telegramChatId FROM contacts WHERE LOWER(telegramUsername)=LOWER(?)').bind(cleanUsername).first();
  }
  if (contact) {
    if (!contact.telegramChatId) await env.DB.prepare('UPDATE contacts SET telegramChatId=?,updatedAt=CURRENT_TIMESTAMP WHERE id=?').bind(String(chatId), contact.id).run();
    return contact.id;
  }
  const name = firstName || (cleanUsername ? `@${cleanUsername}` : `Telegram ${chatId}`);
  const result = await env.DB.prepare(`INSERT INTO contacts (contactName,source,platform,telegramChatId,telegramUsername,createdAt,updatedAt)
    VALUES (?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`)
    .bind(name, 'telegram', 'Telegram', String(chatId), cleanUsername).run();
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
    if (message && message.chat) {
      const chatId = message.chat.id;
      const username = message.from?.username || '';
      const firstName = message.from?.first_name || '';
      const text = String(message.text || '');
      const contactId = await findOrCreateTelegramContact(env, chatId, username, firstName);
      if (STOP_PATTERN.test(text)) {
        await env.DB.prepare('INSERT INTO telegram_opted_out (chatId,source,reason) VALUES (?,?,?) ON CONFLICT(chatId) DO NOTHING')
          .bind(String(chatId), 'keyword_detected', `Replied "${text.trim().slice(0, 50)}"`).run();
      }
      await env.DB.prepare('INSERT INTO telegram_messages (chatId,contactId,direction,text,messageId,senderName) VALUES (?,?,?,?,?,?)')
        .bind(String(chatId), contactId, 'in', text, message.message_id || null, firstName || username || '').run();
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

// Preview how many of a resolved audience can actually be reached — the headline caveat of
// this whole module, surfaced before anyone clicks Send rather than discovered after.
export async function handleTelegramAudiencePreview(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'User is not provisioned in Whizz.' }, 403);
  const body = await request.json().catch(() => ({}));
  let contacts;
  try { contacts = await resolveContactsForCampaign(env, user, body); }
  catch (error) { return json({ error: error.message }, 500); }
  const withTelegram = contacts.filter(c => c.telegramChatId).length;
  return json({ total: contacts.length, withTelegram, withoutTelegram: contacts.length - withTelegram });
}

// Backs the "Select Specific Leads" picker — only ever lists contacts who already have a
// telegramChatId, since anyone else can't be messaged at all. Same role-based ownership
// scoping as resolveContactsForCampaign (automation.js), reimplemented here rather than
// shared since this is a flat, searchable browse rather than a platform/country/brand
// group resolution.
export async function handleListTelegramReachableLeads(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'User is not provisioned in Whizz.' }, 403);
  const url = new URL(request.url);
  const search = (url.searchParams.get('search') || '').trim().toLowerCase();
  const platform = url.searchParams.get('platform') || 'ALL';
  const country = url.searchParams.get('country') || 'ALL';

  let ownerFilter = '';
  let ownerParam;
  if (user.role === 'Manager') { ownerFilter = 'AND (ownerEmail IS NULL OR teamId = ?)'; ownerParam = user.teamId || ''; }
  else if (user.role === 'Sales') { ownerFilter = 'AND ownerEmail = ?'; ownerParam = user.email; }

  const binds = [platform, platform, country, country, `%${search}%`, `%${search}%`];
  if (ownerParam !== undefined) binds.push(ownerParam);

  const result = await env.DB.prepare(`
    SELECT id,contactName,phone,platform,country,brand,telegramUsername,telegramChatId,telegramLastContactedAt,leadScore
    FROM contacts
    WHERE telegramChatId IS NOT NULL AND telegramChatId <> ''
      AND (? = 'ALL' OR LOWER(platform) = LOWER(?))
      AND (? = 'ALL' OR LOWER(country) = LOWER(?))
      AND (LOWER(contactName) LIKE ? OR LOWER(telegramUsername) LIKE ?)
      ${ownerFilter}
    ORDER BY leadScore DESC, contactName COLLATE NOCASE
    LIMIT 500
  `).bind(...binds).all();

  return json({ leads: result.results || [] });
}

// Manual chat ID linking — for a lead whose numeric Telegram chat ID is already known from
// somewhere else. There is no API-side fallback for this: Telegram's Bot API can't resolve
// a username to a chat ID, and won't surface one at all until that person messages the bot
// themselves, so a lead who hasn't done that can only become reachable this way.
export async function handleSearchContactsForTelegramLink(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'User is not provisioned in Whizz.' }, 403);
  const url = new URL(request.url);
  const search = (url.searchParams.get('search') || '').trim().toLowerCase();
  if (!search) return json({ contacts: [] });

  let ownerFilter = '';
  let ownerParam;
  if (user.role === 'Manager') { ownerFilter = 'AND (ownerEmail IS NULL OR teamId = ?)'; ownerParam = user.teamId || ''; }
  else if (user.role === 'Sales') { ownerFilter = 'AND ownerEmail = ?'; ownerParam = user.email; }

  const binds = [`%${search}%`, `%${search}%`, `%${search}%`];
  if (ownerParam !== undefined) binds.push(ownerParam);

  const result = await env.DB.prepare(`
    SELECT id,contactName,company,platform,country,telegramUsername,telegramChatId
    FROM contacts
    WHERE (LOWER(contactName) LIKE ? OR LOWER(company) LIKE ? OR LOWER(telegramUsername) LIKE ?)
      ${ownerFilter}
    ORDER BY contactName COLLATE NOCASE
    LIMIT 30
  `).bind(...binds).all();

  return json({ contacts: result.results || [] });
}

export async function handleLinkTelegramChatId(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'User is not provisioned in Whizz.' }, 403);
  const body = await request.json().catch(() => ({}));
  const contactId = Number(body.contactId);
  const chatId = String(body.chatId || '').trim();
  if (!contactId) return json({ error: 'A lead is required.' }, 400);
  if (!/^-?\d+$/.test(chatId)) return json({ error: 'A Telegram chat ID is a plain number (positive for a person, negative for a group/supergroup) — not a username or phone number.' }, 400);

  let ownerFilter = '';
  let ownerParam;
  if (user.role === 'Manager') { ownerFilter = 'AND (ownerEmail IS NULL OR teamId = ?)'; ownerParam = user.teamId || ''; }
  else if (user.role === 'Sales') { ownerFilter = 'AND ownerEmail = ?'; ownerParam = user.email; }

  const binds = [chatId, contactId];
  if (ownerParam !== undefined) binds.push(ownerParam);
  const result = await env.DB.prepare(`UPDATE contacts SET telegramChatId=?, updatedAt=CURRENT_TIMESTAMP WHERE id=? ${ownerFilter}`).bind(...binds).run();
  if (!result.meta.changes) return json({ error: 'Lead not found or access denied.' }, 404);
  return json({ success: true });
}

function classifyTelegramError(description) {
  const d = String(description || '').toLowerCase();
  if (d.includes('blocked') || d.includes('chat not found') || d.includes('deactivated') || d.includes('kicked')) return 'permanent';
  if (d.includes('too many requests')) return 'transient';
  return 'unknown';
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
  if (targetContacts) {
    contacts = targetContacts.map(c => ({ id: c.id || null, contactName: c.name || '', telegramChatId: c.chatId }));
  } else {
    try { contacts = await resolveContactsForCampaign(env, user, body); }
    catch (error) { return json({ error: error.message }, 500); }
  }

  const guard = body.delivery_guard || {};
  const seenChats = new Set();
  const skipped = [];
  let eligible = contacts.filter(c => {
    const chatId = c.telegramChatId ? String(c.telegramChatId) : '';
    if (!chatId) { skipped.push({ contactId: c.id, name: c.contactName, reason: 'No linked Telegram chat — this contact hasn’t started the bot yet' }); return false; }
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
    if (contact.id) await env.DB.prepare('UPDATE contacts SET telegramLastContactedAt=CURRENT_TIMESTAMP WHERE id=?').bind(contact.id).run();
  }

  return json({ total: eligible.length, sent: eligible.length - totalFails, failed: totalFails, skipped: skipped.length, skippedDetail: skipped, results });
}
