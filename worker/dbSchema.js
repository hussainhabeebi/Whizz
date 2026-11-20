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

// Each entry's own statements stay in order (a table's ADD COLUMNs must wait for its own
// CREATE TABLE) but are otherwise fully independent of every other table — D1 handles
// concurrent requests on the same binding fine, so repairSchema() below runs every
// table's chain at once with Promise.all instead of one after another. On a cold Worker
// isolate (first request after a deploy or idle eviction) this is the difference between
// ~25 sequential D1 round-trips and ~25 concurrent ones — the slowest single chain,
// instead of the sum of all of them, which is exactly what made every first page load
// (including the /api/me identity check that gates sign-in) pay the full accumulated
// migration cost in series as this file grew over many features.
function schemaTasks(env) {
  return [
    async () => {
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
    },

    async () => {
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
        ['telegramChatId', 'TEXT'], ['telegramUsername', 'TEXT'], ['telegramLastContactedAt', 'TEXT'],
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
    },

    () => safeRun(env, `CREATE TABLE IF NOT EXISTS conversation_assignments (
      conversationId TEXT PRIMARY KEY, assignedUserEmail TEXT, assignedTeamId TEXT,
      assignedByEmail TEXT NOT NULL, assignedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),

    () => safeRun(env, `CREATE TABLE IF NOT EXISTS telegram_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chatId TEXT NOT NULL,
      contactId INTEGER,
      direction TEXT NOT NULL DEFAULT 'in',
      text TEXT NOT NULL DEFAULT '',
      messageId INTEGER,
      senderName TEXT NOT NULL DEFAULT '',
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),

    // Telegram Bulk Marketing module (worker/routes/telegramBot.js) — talks to the Telegram
    // Bot API directly, not through Chatwoot/n8n. A single bot token covers the whole
    // workspace (unlike WhatsApp's multiple Chatwoot inboxes), so one settings row is enough.
    // webhookSecret is compared against the X-Telegram-Bot-Api-Secret-Token header on every
    // inbound update, since (unlike Meta) Telegram has no built-in verify-token handshake.
    () => safeRun(env, `CREATE TABLE IF NOT EXISTS telegram_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      botTokenEncrypted TEXT,
      botUsername TEXT NOT NULL DEFAULT '',
      webhookSecret TEXT NOT NULL DEFAULT '',
      updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    // Telegram's own suppression list — a parallel table to opted_out_numbers rather than a
    // shared one, since Telegram identity is a numeric chatId, not a phone number.
    () => safeRun(env, `CREATE TABLE IF NOT EXISTS telegram_opted_out (
      chatId TEXT PRIMARY KEY,
      source TEXT NOT NULL DEFAULT 'manual',
      reason TEXT NOT NULL DEFAULT '',
      addedByEmail TEXT NOT NULL DEFAULT '',
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    // The Telegram module's own lead base — deliberately separate from the main CRM `contacts`
    // table (which WhatsApp campaigns use). A Telegram bot only ever reaches an individual
    // person's private chat (never a channel/group/supergroup, whose chat IDs are always
    // negative), so this list exists independently of whether a row is also a CRM contact.
    // crmContactId is an optional, best-effort breadcrumb back to a CRM contact this lead was
    // imported/invited from — never a hard foreign key, since a Telegram lead must be able to
    // exist (e.g. someone who just messaged the bot cold) with no CRM contact behind it at all.
    () => safeRun(env, `CREATE TABLE IF NOT EXISTS telegram_leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contactName TEXT NOT NULL DEFAULT '',
      telegramUsername TEXT NOT NULL DEFAULT '',
      telegramChatId TEXT,
      tags TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'manual',
      crmContactId INTEGER,
      ownerEmail TEXT,
      teamId TEXT,
      telegramLastContactedAt TEXT,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),

    () => safeRun(env, `CREATE TABLE IF NOT EXISTS directory_accounts (
      source TEXT PRIMARY KEY,
      username TEXT NOT NULL DEFAULT '',
      credentialsEncrypted TEXT,
      status TEXT NOT NULL DEFAULT 'not_configured',
      verificationUrl TEXT,
      lastSyncAt TEXT,
      lastError TEXT,
      updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),

    async () => {
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
    },

    async () => {
      await safeRun(env, `CREATE TABLE IF NOT EXISTS chatwoot_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        baseUrl TEXT NOT NULL DEFAULT 'https://app.aiingo.com',
        accountId TEXT NOT NULL DEFAULT '',
        apiTokenEncrypted TEXT,
        updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
    },

    async () => {
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
      await safeRun(env, 'CREATE UNIQUE INDEX IF NOT EXISTS idx_chatwoot_inboxes_inbox_id ON chatwoot_inboxes(inboxId)');
    },

    async () => {
      // Template create/list/delete talk to Meta's Graph API directly (per-WABA, using
      // chatwoot_inboxes.wabaId), not n8n. One System User access token covers every WABA
      // under the same Meta Business portfolio.
      await safeRun(env, `CREATE TABLE IF NOT EXISTS meta_whatsapp_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        accessTokenEncrypted TEXT,
        updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
      // webhookVerifyToken is the arbitrary string an Administrator pastes into Meta's App
      // Dashboard webhook config (Verify Token field) — compared on the GET handshake in
      // metaWebhook.js. Not a secret the worker generates; whatever the admin sets here must
      // match what they typed into Meta's console.
      await addColumns(env, 'meta_whatsapp_settings', [['webhookVerifyToken', "TEXT NOT NULL DEFAULT ''"]]);
      // appId is the Meta App ID from the Developer App Dashboard (distinct from the WABA ID
      // and phone number ID already tracked on chatwoot_inboxes) — only needed for creating an
      // image-header template, which requires Meta's Resumable Upload API
      // (POST /{app-id}/uploads) to get a header_handle before the template can be submitted.
      await addColumns(env, 'meta_whatsapp_settings', [['appId', "TEXT NOT NULL DEFAULT ''"]]);
    },

    async () => {
      // Per-message delivery/read status, updated by Meta's WhatsApp status webhook
      // (metaWebhook.js) as it reports sent → delivered → read (or failed) for each wamid
      // captured at send time in campaignSend.js. Lets Campaign History show a message's real
      // delivery state instead of only "the Graph API accepted it".
      await safeRun(env, `CREATE TABLE IF NOT EXISTS message_delivery_status (
        wamid TEXT PRIMARY KEY,
        phone TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'sent',
        errorMessage TEXT NOT NULL DEFAULT '',
        sentAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
      await safeRun(env, 'CREATE INDEX IF NOT EXISTS idx_message_delivery_status_phone ON message_delivery_status(phone)');
    },

    async () => {
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
      await safeRun(env, 'CREATE INDEX IF NOT EXISTS idx_user_activity_log_email_created ON user_activity_log(email, createdAt)');
    },

    async () => {
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
      await addColumns(env, 'audience_segments', [['categories', "TEXT NOT NULL DEFAULT '[]'"]]);
      await safeRun(env, 'CREATE INDEX IF NOT EXISTS idx_audience_segments_owner ON audience_segments(ownerEmail)');
    },

    // The real opt-out/DNC list — before this, "clean & suppress" only ever removed
    // missing/duplicate phone numbers, never an actual opt-out. phone is normalized
    // (digits only, no leading zeros) so lookups match regardless of how a number was
    // originally formatted. source is 'keyword_detected' (an inbound STOP-style reply,
    // detected best-effort when Conversations messages are fetched/polled — there's no
    // inbound webhook, so this only catches a reply once Whizz has actually loaded that
    // conversation's messages) or 'manual' (added directly from the Suppression List).
    () => safeRun(env, `CREATE TABLE IF NOT EXISTS opted_out_numbers (
      phone TEXT PRIMARY KEY,
      source TEXT NOT NULL DEFAULT 'manual',
      reason TEXT NOT NULL DEFAULT '',
      addedByEmail TEXT NOT NULL DEFAULT '',
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),

    // Every failed send, logged from campaignSend.js — powers the campaign review step's
    // list health check (how many selected contacts have a history of hard/permanent
    // failures, i.e. likely-dead numbers) and could later back a per-contact bounce score.
    async () => {
      await safeRun(env, `CREATE TABLE IF NOT EXISTS send_failures (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone TEXT NOT NULL,
        bucket TEXT NOT NULL DEFAULT 'unknown',
        reason TEXT NOT NULL DEFAULT '',
        createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
      await safeRun(env, 'CREATE INDEX IF NOT EXISTS idx_send_failures_phone ON send_failures(phone)');
    },

    // Admin-defined only — no seeded defaults, since guessing a country's marketing
    // language is exactly the kind of assumption this app tries not to make silently.
    // Used by campaignSend.js's optional per-contact template-language auto-pick.
    () => safeRun(env, `CREATE TABLE IF NOT EXISTS country_language_map (
      country TEXT PRIMARY KEY,
      language TEXT NOT NULL
    )`),

    async () => {
      // Genuinely time-staged campaign rollout — processed by a real Cron Trigger (see
      // wrangler.toml's [triggers] and stagedCampaigns.js's processStagedCampaignRuns), not a
      // single Worker invocation pretending to wait. remainingContacts/results are JSON since
      // D1 has no array column type; everything else is queryable for the Staged Rollouts list.
      await safeRun(env, `CREATE TABLE IF NOT EXISTS staged_campaign_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        status TEXT NOT NULL DEFAULT 'active',
        templateName TEXT NOT NULL,
        language TEXT NOT NULL,
        templateHeader TEXT NOT NULL DEFAULT '',
        templateBody TEXT NOT NULL DEFAULT '',
        templateFooter TEXT NOT NULL DEFAULT '',
        inboxId TEXT NOT NULL DEFAULT '',
        audienceLabel TEXT NOT NULL DEFAULT '',
        batchSize INTEGER NOT NULL DEFAULT 50,
        intervalMinutes INTEGER NOT NULL DEFAULT 60,
        maxPermanentFailureRate REAL NOT NULL DEFAULT 8,
        maxTotalFailureRate REAL NOT NULL DEFAULT 15,
        remainingContacts TEXT NOT NULL DEFAULT '[]',
        totalContacts INTEGER NOT NULL DEFAULT 0,
        sentCount INTEGER NOT NULL DEFAULT 0,
        failedCount INTEGER NOT NULL DEFAULT 0,
        permanentFailedCount INTEGER NOT NULL DEFAULT 0,
        createdByEmail TEXT NOT NULL DEFAULT '',
        nextRunAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        lastNote TEXT NOT NULL DEFAULT '',
        createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
      // Image-header templates: the header media is uploaded once at staging time (not
      // per-batch — same media id is reused across every batch of this run) via Meta's regular
      // /media endpoint, distinct from the Resumable Upload API template creation itself uses.
      // templateHeaderFormat carries 'IMAGE'/'TEXT'/'' through to processOneStagedRun, since the
      // run's own template fields (templateHeader etc.) don't otherwise say which kind of header
      // this is.
      await addColumns(env, 'staged_campaign_runs', [
        ['templateHeaderFormat', "TEXT NOT NULL DEFAULT ''"],
        ['headerImageMediaId', "TEXT NOT NULL DEFAULT ''"],
      ]);
      await safeRun(env, "CREATE INDEX IF NOT EXISTS idx_staged_campaign_runs_due ON staged_campaign_runs(status, nextRunAt)");
    },

    // Email Marketing module (worker/routes/emailCampaigns.js) — sends via Resend's API
    // directly, reusing the same `contacts` leadbase/audience filters as WhatsApp campaigns.
    // One Resend account/API key covers the whole workspace, same singleton-row pattern as
    // meta_whatsapp_settings/telegram_settings. webhookSecret is pasted into Resend's
    // dashboard (Webhooks → Signing Secret) the same direction as Telegram's webhookSecret —
    // generated here, not typed in.
    () => safeRun(env, `CREATE TABLE IF NOT EXISTS email_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      apiKeyEncrypted TEXT,
      fromEmail TEXT NOT NULL DEFAULT '',
      fromName TEXT NOT NULL DEFAULT '',
      webhookSecret TEXT NOT NULL DEFAULT '',
      updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    () => safeRun(env, `CREATE TABLE IF NOT EXISTS email_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      subject TEXT NOT NULL DEFAULT '',
      bodyHtml TEXT NOT NULL DEFAULT '',
      createdByEmail TEXT NOT NULL DEFAULT '',
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    // One row per send — audienceLabel mirrors staged_campaign_runs' same free-text
    // convention rather than re-deriving the filter description later.
    () => safeRun(env, `CREATE TABLE IF NOT EXISTS email_campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      templateId INTEGER,
      name TEXT NOT NULL DEFAULT '',
      subject TEXT NOT NULL DEFAULT '',
      bodyHtml TEXT NOT NULL DEFAULT '',
      audienceLabel TEXT NOT NULL DEFAULT '',
      totalContacts INTEGER NOT NULL DEFAULT 0,
      sentCount INTEGER NOT NULL DEFAULT 0,
      failedCount INTEGER NOT NULL DEFAULT 0,
      createdByEmail TEXT NOT NULL DEFAULT '',
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    // Per-recipient send + delivery/open/click tracking, updated by Resend's webhook
    // (matched back to a row by resendId, the message id Resend returned at send time).
    async () => {
      await safeRun(env, `CREATE TABLE IF NOT EXISTS email_sends (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaignId INTEGER NOT NULL,
        contactId INTEGER,
        email TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        resendId TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'sent',
        errorMessage TEXT NOT NULL DEFAULT '',
        openCount INTEGER NOT NULL DEFAULT 0,
        clickCount INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
      await safeRun(env, 'CREATE INDEX IF NOT EXISTS idx_email_sends_campaign ON email_sends(campaignId)');
      await safeRun(env, 'CREATE INDEX IF NOT EXISTS idx_email_sends_resend_id ON email_sends(resendId)');
    },
    // The email module's own Do Not Contact list — parallel to opted_out_numbers/
    // telegram_opted_out rather than a shared table, since identity here is an email
    // address, not a phone number or chat id.
    () => safeRun(env, `CREATE TABLE IF NOT EXISTS email_opted_out (
      email TEXT PRIMARY KEY,
      source TEXT NOT NULL DEFAULT 'manual',
      reason TEXT NOT NULL DEFAULT '',
      addedByEmail TEXT NOT NULL DEFAULT '',
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),

    // Sales Invoices module (worker/routes/salesInvoices.js) — connection settings only;
    // the invoice list itself is always a live pull from the company's own sales/ERP API for
    // whatever date range is selected, never stored here. Same singleton-row pattern as
    // email_settings/telegram_settings.
    () => safeRun(env, `CREATE TABLE IF NOT EXISTS sales_invoice_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      baseUrl TEXT NOT NULL DEFAULT '',
      compCode TEXT NOT NULL DEFAULT '',
      apiKeyEncrypted TEXT,
      updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    // Imported invoices — for when the sales API itself isn't reachable from Cloudflare
    // (IP-restricted to the office network) but is reachable from somewhere else that can
    // paste/upload the same JSON here instead. invoiceRef as the primary key makes every
    // import an upsert: re-importing an overlapping date range refreshes existing rows and
    // adds new ones, but never deletes a row this particular import didn't mention.
    async () => {
      await safeRun(env, `CREATE TABLE IF NOT EXISTS sales_invoices (
        invoiceRef TEXT PRIMARY KEY,
        date TEXT NOT NULL DEFAULT '',
        customerName TEXT NOT NULL DEFAULT '',
        invoiceAmount REAL NOT NULL DEFAULT 0,
        importedByEmail TEXT NOT NULL DEFAULT '',
        importedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
      await safeRun(env, 'CREATE INDEX IF NOT EXISTS idx_sales_invoices_date ON sales_invoices(date)');
    },
    // Maps a sales voucher's free-text customerName to a CRM contact, once per distinct
    // name rather than per invoice — applies automatically to every past and future invoice
    // with that same name. contactId=NULL means "reviewed, confirmed no matching lead",
    // distinct from no row existing at all ("not reviewed yet") — the app layer tells these
    // apart, not this schema. method is 'auto' (a confident approximate-name match applied
    // without review) or 'manual' (a person picked it, including explicitly confirming "no
    // match").
    async () => {
      await safeRun(env, `CREATE TABLE IF NOT EXISTS sales_customer_matches (
        customerName TEXT PRIMARY KEY,
        contactId INTEGER,
        contactName TEXT NOT NULL DEFAULT '',
        method TEXT NOT NULL DEFAULT 'manual',
        matchedByEmail TEXT NOT NULL DEFAULT '',
        matchedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
      // Free-text, manually typed/picked campaign label (there's no server-side campaign
      // log to link to — campaign history only ever lived in each browser's own
      // localStorage) — a lightweight way to tag which send is believed to have led to
      // this sale, for attribution on the Sales by Lead report.
      await addColumns(env, 'sales_customer_matches', [['campaignLabel', "TEXT NOT NULL DEFAULT ''"]]);
    },
    // One row per import action (not per invoice) — a lightweight audit trail distinct from
    // the full sales_invoices table. Only a small sample of rows is kept per import (not the
    // whole batch) since its only job is letting someone confirm an import actually went
    // through and roughly what it contained; the complete data stays in sales_invoices,
    // nothing here is ever used for reporting or matching.
    () => safeRun(env, `CREATE TABLE IF NOT EXISTS sales_import_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      importedByEmail TEXT NOT NULL DEFAULT '',
      totalRows INTEGER NOT NULL DEFAULT 0,
      importedCount INTEGER NOT NULL DEFAULT 0,
      sampleRowsJson TEXT NOT NULL DEFAULT '[]',
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),

    // Per-recipient WhatsApp outreach log (campaignSend.js's normal bulk/single-template
    // sends + stagedCampaigns.js's staged batches) — the one piece of per-contact send
    // history WhatsApp was missing (email already has it via email_sends). Powers the
    // Outreach vs Sales report's segment/lead-level breakdowns. Only sends made from the
    // moment this shipped are recorded here — nothing retroactive; contacts.lastContactedAt
    // existed before but only ever tracks the single most-recent touch, not a usable history.
    () => safeRun(env, `CREATE TABLE IF NOT EXISTS outreach_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contactId INTEGER NOT NULL,
      platform TEXT NOT NULL DEFAULT 'WhatsApp',
      campaignType TEXT NOT NULL DEFAULT 'normal',
      campaignRef TEXT NOT NULL DEFAULT '',
      sentByEmail TEXT NOT NULL DEFAULT '',
      sentAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),

    // Desktop app auth (worker/routes/desktopAuth.js) — a long-lived Bearer token stands
    // in for the Cloudflare Access header a browser gets for free, since a local desktop
    // app can't sit behind Access the same way. Only the token's hash is ever stored here;
    // revokedAt (not a delete) keeps a record of past devices for the user's own "Desktop
    // App" list in Settings.
    () => safeRun(env, `CREATE TABLE IF NOT EXISTS desktop_auth (
      tokenHash TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT 'Desktop App',
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      lastUsedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      revokedAt TEXT
    )`),
    // Short-lived device-pairing handshake rows (see handleDesktopPairStart/Claim) — each
    // one is deleted the moment it's claimed or found expired, so this table only ever
    // holds currently-in-progress pairing attempts, never a lasting record. Unlike
    // desktop_auth, the token here is plaintext: this is the one brief window it has to be
    // revealed to a device that isn't authenticated yet.
    () => safeRun(env, `CREATE TABLE IF NOT EXISTS desktop_pairing_codes (
      code TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT 'Desktop App',
      tokenHash TEXT NOT NULL,
      token TEXT NOT NULL,
      expiresAt TEXT NOT NULL
    )`),
    // One row per email with a currently-pending login code — a fresh request overwrites
    // it (ON CONFLICT), never stacks. attempts caps brute-forcing a 6-digit code before it
    // expires; only the hash is ever stored, same as desktop_auth's tokens.
    () => safeRun(env, `CREATE TABLE IF NOT EXISTS desktop_otp_codes (
      email TEXT PRIMARY KEY,
      codeHash TEXT NOT NULL,
      expiresAt TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),

    // These three indexes' tables (conversation_assignments, telegram_messages/telegram_leads,
    // directory_prospects) are created by other entries above — safe to run concurrently with
    // everything else here since D1 only needs the table to exist by the time this specific
    // statement runs, and Promise.all below doesn't resolve until every entry (table creates
    // included) has finished.
    () => safeRun(env, 'CREATE INDEX IF NOT EXISTS idx_conversation_assignment_user ON conversation_assignments(assignedUserEmail)'),
    () => safeRun(env, 'CREATE INDEX IF NOT EXISTS idx_conversation_assignment_team ON conversation_assignments(assignedTeamId)'),
    () => safeRun(env, 'CREATE INDEX IF NOT EXISTS idx_tg_msg_chat ON telegram_messages(chatId, createdAt)'),
    () => safeRun(env, 'CREATE INDEX IF NOT EXISTS idx_contacts_tg_chat ON contacts(telegramChatId)'),
    () => safeRun(env, 'CREATE INDEX IF NOT EXISTS idx_tg_leads_chat ON telegram_leads(telegramChatId)'),
    () => safeRun(env, 'CREATE INDEX IF NOT EXISTS idx_tg_leads_username ON telegram_leads(telegramUsername)'),
    () => safeRun(env, 'CREATE INDEX IF NOT EXISTS idx_tg_leads_owner ON telegram_leads(ownerEmail)'),
    () => safeRun(env, 'CREATE INDEX IF NOT EXISTS idx_tg_leads_team ON telegram_leads(teamId)'),
    () => safeRun(env, 'CREATE INDEX IF NOT EXISTS idx_directory_prospects_source ON directory_prospects(source)'),
    () => safeRun(env, 'CREATE INDEX IF NOT EXISTS idx_directory_prospects_status ON directory_prospects(status)'),
    () => safeRun(env, 'CREATE INDEX IF NOT EXISTS idx_directory_prospects_score ON directory_prospects(leadScore)'),
    () => safeRun(env, 'CREATE INDEX IF NOT EXISTS idx_directory_prospects_updated ON directory_prospects(updatedAt)'),
    () => safeRun(env, 'CREATE INDEX IF NOT EXISTS idx_outreach_log_contact ON outreach_log(contactId)'),
    () => safeRun(env, 'CREATE INDEX IF NOT EXISTS idx_outreach_log_sentat ON outreach_log(sentAt)'),
  ];
}

async function repairSchema(env) {
  const results = await Promise.allSettled(schemaTasks(env).map(task => task()));
  const failure = results.find(r => r.status === 'rejected');
  if (failure) throw failure.reason;
}

export async function ensureDatabaseSchema(env) {
  if (!schemaPromise) schemaPromise = repairSchema(env).catch(error => { schemaPromise = null; throw error; });
  return schemaPromise;
}
