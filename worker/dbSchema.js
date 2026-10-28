let schemaPromise;

async function safeRun(env, sql) {
  try { await env.DB.prepare(sql).run(); }
  catch (error) {
    const message = String(error?.message || '').toLowerCase();
    if (!message.includes('duplicate column') && !message.includes('already exists')) throw error;
  }
}

async function columnNames(env, table) {
  const result = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
  return new Set((result.results || []).map(row => row.name));
}

async function addColumns(env, table, definitions) {
  const existing = await columnNames(env, table);
  for (const [name, definition] of definitions) {
    if (!existing.has(name)) await safeRun(env, `ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

async function repairSchema(env) {
  await safeRun(env, `CREATE TABLE IF NOT EXISTS users (
    email TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL,
    allowedBrands TEXT NOT NULL DEFAULT '[]', allowedPlatforms TEXT NOT NULL DEFAULT '[]'
  )`);
  await addColumns(env, 'users', [
    ['teamId', "TEXT NOT NULL DEFAULT 'sales'"], ['resetAt', 'INTEGER NOT NULL DEFAULT 0'],
    ['createdAt', 'TEXT'], ['updatedAt', 'TEXT'],
    ['allowedInboxes', "TEXT NOT NULL DEFAULT '[]'"],
  ]);
  await env.DB.prepare("UPDATE users SET teamId=COALESCE(NULLIF(teamId,''),'sales'), createdAt=COALESCE(createdAt,CURRENT_TIMESTAMP), updatedAt=COALESCE(updatedAt,CURRENT_TIMESTAMP)").run();

  await safeRun(env, `CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, contactName TEXT NOT NULL DEFAULT '', company TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '', platform TEXT NOT NULL DEFAULT '', country TEXT NOT NULL DEFAULT '',
    brand TEXT NOT NULL DEFAULT '', productInterest TEXT NOT NULL DEFAULT ''
  )`);
  await addColumns(env, 'contacts', [
    ['ownerEmail', 'TEXT'], ['teamId', 'TEXT'], ['createdByEmail', 'TEXT'], ['createdAt', 'TEXT'],
    ['updatedAt', 'TEXT'], ['lastContactedAt', 'TEXT'], ['nextFollowUpAt', 'TEXT'],
    ['dealExpectedAt', 'TEXT'], ['leadScore', 'INTEGER NOT NULL DEFAULT 0'],
    ['telegramChatId', 'TEXT'], ['telegramUsername', 'TEXT'],
    ['convertedAt', 'TEXT'],
    ['website', "TEXT NOT NULL DEFAULT ''"], ['address', "TEXT NOT NULL DEFAULT ''"],
    ['rating', 'REAL NOT NULL DEFAULT 0'], ['mapsUrl', "TEXT NOT NULL DEFAULT ''"],
    ['sourceId', "TEXT NOT NULL DEFAULT ''"], ['linkedin', "TEXT NOT NULL DEFAULT ''"],
    ['whatsapp', "TEXT NOT NULL DEFAULT ''"],
    ['contactPersonName', "TEXT NOT NULL DEFAULT ''"], ['contactPersonTitle', "TEXT NOT NULL DEFAULT ''"],
    ['volzaUrl', "TEXT NOT NULL DEFAULT ''"], ['directoryUrl', "TEXT NOT NULL DEFAULT ''"],
    ['directoryDescription', "TEXT NOT NULL DEFAULT ''"],
  ]);
  await env.DB.prepare('UPDATE contacts SET createdAt=COALESCE(createdAt,CURRENT_TIMESTAMP), updatedAt=COALESCE(updatedAt,CURRENT_TIMESTAMP)').run();
  await safeRun(env, 'CREATE INDEX IF NOT EXISTS idx_contacts_platform_source_id ON contacts(platform, sourceId)');

  await safeRun(env, `CREATE TABLE IF NOT EXISTS conversation_assignments (
    conversationId TEXT PRIMARY KEY, assignedUserEmail TEXT, assignedTeamId TEXT,
    assignedByEmail TEXT NOT NULL, assignedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await safeRun(env, `CREATE TABLE IF NOT EXISTS telegram_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chatId TEXT NOT NULL,
    contactId INTEGER,
    direction TEXT NOT NULL DEFAULT 'in',
    text TEXT NOT NULL DEFAULT '',
    messageId INTEGER,
    senderName TEXT NOT NULL DEFAULT '',
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);

  await safeRun(env, `CREATE TABLE IF NOT EXISTS directory_accounts (
    source TEXT PRIMARY KEY,
    username TEXT NOT NULL DEFAULT '',
    credentialsEncrypted TEXT,
    status TEXT NOT NULL DEFAULT 'not_configured',
    verificationUrl TEXT,
    lastSyncAt TEXT,
    lastError TEXT,
    updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);

  await safeRun(env, `CREATE TABLE IF NOT EXISTS directory_prospects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    dedupeKey TEXT NOT NULL UNIQUE,
    company TEXT NOT NULL DEFAULT '',
    contactName TEXT NOT NULL DEFAULT '',
    country TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    website TEXT NOT NULL DEFAULT '',
    brand TEXT NOT NULL DEFAULT '',
    productInterest TEXT NOT NULL DEFAULT '',
    activity TEXT NOT NULL DEFAULT '',
    profileUrl TEXT NOT NULL DEFAULT '',
    verified INTEGER NOT NULL DEFAULT 0,
    lastActivityAt TEXT,
    leadScore INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'new',
    contactId INTEGER,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await addColumns(env, 'directory_prospects', [
    ['whatsapp', "TEXT NOT NULL DEFAULT ''"],
    ['telegram', "TEXT NOT NULL DEFAULT ''"]
  ]);

  await safeRun(env, `CREATE TABLE IF NOT EXISTS chatwoot_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    baseUrl TEXT NOT NULL DEFAULT 'https://app.aiingo.com',
    accountId TEXT NOT NULL DEFAULT '',
    apiTokenEncrypted TEXT,
    updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await safeRun(env, `CREATE TABLE IF NOT EXISTS chatwoot_inboxes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    inboxId TEXT NOT NULL,
    label TEXT NOT NULL,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  // wabaId: the Meta WhatsApp Business Account this number's templates actually live on
  // (Chatwoot's "inbox" is a different id entirely). Two numbers can share one Meta
  // Business portfolio but still be separate WABAs with separate template libraries —
  // this is what template creation needs to target the right one.
  await addColumns(env, 'chatwoot_inboxes', [
    ['wabaId', "TEXT NOT NULL DEFAULT ''"],
    ['phoneNumber', "TEXT NOT NULL DEFAULT ''"],
    // phoneNumberId: Meta's "Phone number ID" — yet a third identifier, distinct from
    // both wabaId and the human phone number, and what sending a message is actually
    // addressed to (POST /{phone-number-id}/messages). Found in Meta Business Settings →
    // WhatsApp Accounts → the WABA → Phone numbers → the number.
    ['phoneNumberId', "TEXT NOT NULL DEFAULT ''"],
    // 0 = no cap. Enforced in campaignSend.js against today's own user_activity_log sum
    // for this inbox, so one rep's bulk send can't exhaust a shared number's daily
    // capacity without anyone noticing until messages start failing at Meta's end.
    ['dailySendCap', 'INTEGER NOT NULL DEFAULT 0'],
  ]);
  // Template create/list/delete talk to Meta's Graph API directly (per-WABA, using
  // chatwoot_inboxes.wabaId), not n8n. One System User access token covers every WABA
  // under the same Meta Business portfolio.
  await safeRun(env, `CREATE TABLE IF NOT EXISTS meta_whatsapp_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    accessTokenEncrypted TEXT,
    updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);

  // Per-user send activity, logged going forward only (no historical backfill is
  // possible — nothing recorded who sent a message before this table existed). Powers
  // the Reports → Team Activity "Messages Sent" column.
  await safeRun(env, `CREATE TABLE IF NOT EXISTS user_activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    action TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 1,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  // inboxId: which WhatsApp number the send went through — powers Reports → WhatsApp
  // Number Activity's "Sent" column (Chatwoot's own /reports endpoint 404s on this
  // account, so that report is built from this log instead of Chatwoot's analytics).
  await addColumns(env, 'user_activity_log', [['inboxId', "TEXT NOT NULL DEFAULT ''"]]);

  // A named platform/brand/region/country filter combo, saved from the campaign
  // wizard's Audience step so it can be reloaded instead of rebuilt every time.
  await safeRun(env, `CREATE TABLE IF NOT EXISTS audience_segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    ownerEmail TEXT NOT NULL,
    teamId TEXT NOT NULL DEFAULT 'sales',
    platforms TEXT NOT NULL DEFAULT '[]',
    brands TEXT NOT NULL DEFAULT '[]',
    region TEXT NOT NULL DEFAULT 'ALL',
    country TEXT NOT NULL DEFAULT 'ALL',
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);

  // The real opt-out/DNC list — before this, "clean & suppress" only ever removed
  // missing/duplicate phone numbers, never an actual opt-out. phone is normalized
  // (digits only, no leading zeros) so lookups match regardless of how a number was
  // originally formatted. source is 'keyword_detected' (an inbound STOP-style reply,
  // detected best-effort when Conversations messages are fetched/polled — there's no
  // inbound webhook, so this only catches a reply once Whizz has actually loaded that
  // conversation's messages) or 'manual' (added directly from the Suppression List).
  await safeRun(env, `CREATE TABLE IF NOT EXISTS opted_out_numbers (
    phone TEXT PRIMARY KEY,
    source TEXT NOT NULL DEFAULT 'manual',
    reason TEXT NOT NULL DEFAULT '',
    addedByEmail TEXT NOT NULL DEFAULT '',
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);

  // Every failed send, logged from campaignSend.js — powers the campaign review step's
  // list health check (how many selected contacts have a history of hard/permanent
  // failures, i.e. likely-dead numbers) and could later back a per-contact bounce score.
  await safeRun(env, `CREATE TABLE IF NOT EXISTS send_failures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    bucket TEXT NOT NULL DEFAULT 'unknown',
    reason TEXT NOT NULL DEFAULT '',
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);

  for (const sql of [
    'CREATE INDEX IF NOT EXISTS idx_conversation_assignment_user ON conversation_assignments(assignedUserEmail)',
    'CREATE INDEX IF NOT EXISTS idx_conversation_assignment_team ON conversation_assignments(assignedTeamId)',
    'CREATE INDEX IF NOT EXISTS idx_contacts_owner ON contacts(ownerEmail)',
    'CREATE INDEX IF NOT EXISTS idx_contacts_team ON contacts(teamId)',
    'CREATE INDEX IF NOT EXISTS idx_contacts_created_at ON contacts(createdAt)',
    'CREATE INDEX IF NOT EXISTS idx_tg_msg_chat ON telegram_messages(chatId, createdAt)',
    'CREATE INDEX IF NOT EXISTS idx_contacts_tg_chat ON contacts(telegramChatId)',
    'CREATE INDEX IF NOT EXISTS idx_directory_prospects_source ON directory_prospects(source)',
    'CREATE INDEX IF NOT EXISTS idx_directory_prospects_status ON directory_prospects(status)',
    'CREATE INDEX IF NOT EXISTS idx_directory_prospects_score ON directory_prospects(leadScore)',
    'CREATE INDEX IF NOT EXISTS idx_directory_prospects_updated ON directory_prospects(updatedAt)',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_chatwoot_inboxes_inbox_id ON chatwoot_inboxes(inboxId)',
    'CREATE INDEX IF NOT EXISTS idx_user_activity_log_email_created ON user_activity_log(email, createdAt)',
    'CREATE INDEX IF NOT EXISTS idx_audience_segments_owner ON audience_segments(ownerEmail)',
    'CREATE INDEX IF NOT EXISTS idx_send_failures_phone ON send_failures(phone)'
  ]) await safeRun(env, sql);
}

export async function ensureDatabaseSchema(env) {
  if (!schemaPromise) schemaPromise = repairSchema(env).catch(error => { schemaPromise = null; throw error; });
  return schemaPromise;
}
