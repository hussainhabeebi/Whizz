-- Compatibility tables for installations that already had an older `users` table.
CREATE TABLE IF NOT EXISTS user_access_state (
  email TEXT PRIMARY KEY,
  resetAt INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS access_user_policies (
  email TEXT PRIMARY KEY,
  policyId TEXT NOT NULL,
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
