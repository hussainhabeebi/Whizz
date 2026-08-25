const TG_API = 'https://api.telegram.org/bot';

async function tgPost(token, method, body) {
  const res = await fetch(`${TG_API}${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function ensureTgTables(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS telegram_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chatId TEXT NOT NULL,
    contactId INTEGER,
    direction TEXT NOT NULL DEFAULT 'in',
    text TEXT NOT NULL DEFAULT '',
    messageId INTEGER,
    senderName TEXT NOT NULL DEFAULT '',
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_tg_msg_chat ON telegram_messages(chatId, createdAt)').run().catch(() => {});
}

export async function handleTelegramWebhook(request, env) {
  const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
  if (env.TELEGRAM_WEBHOOK_SECRET && secret !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response('Forbidden', { status: 403 });
  }

  await ensureTgTables(env);

  let update;
  try { update = await request.json(); } catch { return Response.json({ ok: true }); }

  const message = update.message || update.edited_message;
  if (!message || !message.text) return Response.json({ ok: true });

  const chatId   = String(message.chat.id);
  const text     = message.text || '';
  const username = message.from?.username || '';
  const fullName = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ');

  // Upsert contact
  let contact = await env.DB.prepare('SELECT id FROM contacts WHERE telegramChatId = ?').bind(chatId).first();
  let contactId = contact?.id ?? null;

  if (!contact) {
    const r = await env.DB.prepare(
      `INSERT INTO contacts (contactName, telegramChatId, telegramUsername, source, createdAt, updatedAt)
       VALUES (?, ?, ?, 'Telegram', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    ).bind(fullName || username || chatId, chatId, username).run();
    contactId = r.meta?.last_row_id ?? null;
  }

  await env.DB.prepare(
    'INSERT INTO telegram_messages (chatId, contactId, direction, text, messageId, senderName, createdAt) VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)'
  ).bind(chatId, contactId, 'in', text, message.message_id, fullName || username).run();

  return Response.json({ ok: true });
}

export async function handleTelegramInbox(request, env) {
  const email = (request.headers.get('Cf-Access-Authenticated-User-Email') || '').trim().toLowerCase();
  const user = email ? await env.DB.prepare('SELECT role FROM users WHERE email=?').bind(email).first() : null;
  if (!user) return Response.json({ error: 'Not authorised.' }, { status: 403 });

  await ensureTgTables(env);

  const { results } = await env.DB.prepare(`
    SELECT m.chatId, m.text AS lastMessage, m.direction AS lastDirection,
           m.createdAt AS lastAt, m.senderName,
           c.id AS contactId, c.contactName, c.telegramUsername, c.company
    FROM telegram_messages m
    LEFT JOIN contacts c ON c.telegramChatId = m.chatId
    WHERE m.id = (SELECT id FROM telegram_messages t2 WHERE t2.chatId = m.chatId ORDER BY id DESC LIMIT 1)
    GROUP BY m.chatId
    ORDER BY m.createdAt DESC
    LIMIT 200
  `).all();

  return Response.json({ conversations: results || [] });
}

export async function handleTelegramMessages(request, env) {
  const email = (request.headers.get('Cf-Access-Authenticated-User-Email') || '').trim().toLowerCase();
  const user = email ? await env.DB.prepare('SELECT role FROM users WHERE email=?').bind(email).first() : null;
  if (!user) return Response.json({ error: 'Not authorised.' }, { status: 403 });

  await ensureTgTables(env);

  const chatId = new URL(request.url).searchParams.get('chatId') || '';
  if (!chatId) return Response.json({ error: 'chatId required' }, { status: 400 });

  const [{ results: messages }, contact] = await Promise.all([
    env.DB.prepare('SELECT * FROM telegram_messages WHERE chatId=? ORDER BY id ASC LIMIT 300').bind(chatId).all(),
    env.DB.prepare('SELECT id, contactName, telegramUsername, company, phone, email FROM contacts WHERE telegramChatId=?').bind(chatId).first(),
  ]);

  return Response.json({ messages: messages || [], contact: contact || null });
}

export async function handleTelegramSend(request, env) {
  const email = (request.headers.get('Cf-Access-Authenticated-User-Email') || '').trim().toLowerCase();
  const user = email ? await env.DB.prepare('SELECT role FROM users WHERE email=?').bind(email).first() : null;
  if (!user) return Response.json({ error: 'Not authorised.' }, { status: 403 });
  if (!env.TELEGRAM_BOT_TOKEN) return Response.json({ error: 'TELEGRAM_BOT_TOKEN not configured.' }, { status: 503 });

  await ensureTgTables(env);

  const body = await request.json().catch(() => ({}));
  const chatId = String(body.chatId || '').trim();
  const text   = String(body.text   || '').trim();
  if (!chatId || !text) return Response.json({ error: 'chatId and text required.' }, { status: 400 });

  const tgRes = await tgPost(env.TELEGRAM_BOT_TOKEN, 'sendMessage', { chat_id: chatId, text });
  if (!tgRes.ok) return Response.json({ error: tgRes.description || 'Telegram API error.' }, { status: 502 });

  const contact = await env.DB.prepare('SELECT id FROM contacts WHERE telegramChatId=?').bind(chatId).first();
  await env.DB.prepare(
    'INSERT INTO telegram_messages (chatId, contactId, direction, text, messageId, senderName, createdAt) VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)'
  ).bind(chatId, contact?.id ?? null, 'out', text, tgRes.result?.message_id ?? null, email).run();

  return Response.json({ ok: true });
}

export async function handleTelegramBroadcast(request, env) {
  const email = (request.headers.get('Cf-Access-Authenticated-User-Email') || '').trim().toLowerCase();
  const user = email ? await env.DB.prepare('SELECT role FROM users WHERE email=?').bind(email).first() : null;
  if (!user || !['Administrator', 'Manager'].includes(user.role)) {
    return Response.json({ error: 'Administrator or Manager access required.' }, { status: 403 });
  }
  if (!env.TELEGRAM_BOT_TOKEN) return Response.json({ error: 'TELEGRAM_BOT_TOKEN not configured.' }, { status: 503 });

  await ensureTgTables(env);

  const body = await request.json().catch(() => ({}));
  const text = String(body.text || '').trim();
  if (!text) return Response.json({ error: 'text required.' }, { status: 400 });

  const { results } = await env.DB.prepare(
    "SELECT id, telegramChatId FROM contacts WHERE telegramChatId IS NOT NULL AND telegramChatId != ''"
  ).all();

  let sent = 0, failed = 0;
  const errors = [];

  for (const c of results) {
    try {
      const res = await tgPost(env.TELEGRAM_BOT_TOKEN, 'sendMessage', { chat_id: c.telegramChatId, text });
      if (res.ok) {
        await env.DB.prepare(
          'INSERT INTO telegram_messages (chatId, contactId, direction, text, messageId, senderName, createdAt) VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)'
        ).bind(c.telegramChatId, c.id, 'out', text, res.result?.message_id ?? null, email).run();
        sent++;
      } else {
        failed++;
        errors.push(`${c.telegramChatId}: ${res.description}`);
      }
    } catch (err) {
      failed++;
      errors.push(`${c.telegramChatId}: ${err.message}`);
    }
  }

  return Response.json({ ok: true, sent, failed, errors: errors.slice(0, 10) });
}

export async function handleTelegramSetup(request, env) {
  const email = (request.headers.get('Cf-Access-Authenticated-User-Email') || '').trim().toLowerCase();
  const user = email ? await env.DB.prepare('SELECT role FROM users WHERE email=?').bind(email).first() : null;
  if (!user || user.role !== 'Administrator') return Response.json({ error: 'Administrator access required.' }, { status: 403 });
  if (!env.TELEGRAM_BOT_TOKEN) return Response.json({ error: 'TELEGRAM_BOT_TOKEN not configured.' }, { status: 503 });

  const body = await request.json().catch(() => ({}));
  const webhookUrl   = String(body.webhookUrl   || '').trim();
  const secretToken  = String(body.secretToken  || '').trim();
  if (!webhookUrl) return Response.json({ error: 'webhookUrl required.' }, { status: 400 });

  const params = { url: webhookUrl, allowed_updates: ['message'] };
  if (secretToken) params.secret_token = secretToken;

  const res = await tgPost(env.TELEGRAM_BOT_TOKEN, 'setWebhook', params);
  return Response.json(res);
}

export async function handleTelegramStats(request, env) {
  const email = (request.headers.get('Cf-Access-Authenticated-User-Email') || '').trim().toLowerCase();
  const user = email ? await env.DB.prepare('SELECT role FROM users WHERE email=?').bind(email).first() : null;
  if (!user) return Response.json({ error: 'Not authorised.' }, { status: 403 });

  await ensureTgTables(env);

  const [countRow, msgRow] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) as n FROM contacts WHERE telegramChatId IS NOT NULL AND telegramChatId != ''").first(),
    env.DB.prepare('SELECT COUNT(*) as n FROM telegram_messages').first(),
  ]);

  return Response.json({ contactsWithTelegram: countRow?.n ?? 0, totalMessages: msgRow?.n ?? 0 });
}
