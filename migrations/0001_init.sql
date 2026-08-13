-- Contacts: leads captured from WordPress, manual entry, discovery, etc.
-- Column names match the JSON the frontend expects, so routes can return rows with no mapping step.
CREATE TABLE contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contactName TEXT NOT NULL DEFAULT '',
  company TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  platform TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT '',
  brand TEXT NOT NULL DEFAULT '',
  productInterest TEXT NOT NULL DEFAULT ''
);

-- Integrations: one row per external service ("brevo", "wordpress:<id>"), config stored as a JSON blob.
-- Mirrors the Sheets "Integrations" tab exactly so save/read/delete-integration port over unchanged.
CREATE TABLE integrations (
  service TEXT PRIMARY KEY,
  data TEXT NOT NULL DEFAULT '{}',
  updatedAt TEXT NOT NULL
);

-- Memory: the WhatsApp chatbot's conversation buffer (one row appended per message).
-- Written by the external chatbot workflow, read by whizz-get-enquiries.
CREATE TABLE memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  history TEXT NOT NULL DEFAULT ''
);
