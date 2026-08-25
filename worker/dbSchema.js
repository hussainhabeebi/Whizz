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
    ['createdAt', 'TEXT'], ['updatedAt', 'TEXT']
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
  ]);
  await env.DB.prepare('UPDATE contacts SET createdAt=COALESCE(createdAt,CURRENT_TIMESTAMP), updatedAt=COALESCE(updatedAt,CURRENT_TIMESTAMP)').run();

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

  for (const sql of [
    'CREATE INDEX IF NOT EXISTS idx_conversation_assignment_user ON conversation_assignments(assignedUserEmail)',
    'CREATE INDEX IF NOT EXISTS idx_conversation_assignment_team ON conversation_assignments(assignedTeamId)',
    'CREATE INDEX IF NOT EXISTS idx_contacts_owner ON contacts(ownerEmail)',
    'CREATE INDEX IF NOT EXISTS idx_contacts_team ON contacts(teamId)',
    'CREATE INDEX IF NOT EXISTS idx_contacts_created_at ON contacts(createdAt)',
    'CREATE INDEX IF NOT EXISTS idx_tg_msg_chat ON telegram_messages(chatId, createdAt)',
    'CREATE INDEX IF NOT EXISTS idx_contacts_tg_chat ON contacts(telegramChatId)',
  ]) await safeRun(env, sql);
}

export async function ensureDatabaseSchema(env) {
  if (!schemaPromise) schemaPromise = repairSchema(env).catch(error => { schemaPromise = null; throw error; });
  return schemaPromise;
}
