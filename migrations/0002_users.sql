CREATE TABLE IF NOT EXISTS users (
  email TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('Administrator', 'Manager', 'Sales')),
  allowedBrands TEXT NOT NULL DEFAULT '[]',
  allowedPlatforms TEXT NOT NULL DEFAULT '[]',
  resetAt INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO users (email, name, role, allowedBrands, allowedPlatforms) VALUES
  ('hussain@whizzfze.com', 'Hussain', 'Administrator', '[]', '[]'),
  ('admin@whizz.com', 'Whizz Admin', 'Administrator', '[]', '[]'),
  ('sales@whizz.com', 'Sales Team', 'Sales', '[]', '["Viral"]'),
  ('manager@whizz.com', 'Whizz Manager', 'Manager', '[]', '[]'),
  ('mohsin@whizz.com', 'Mohsin', 'Sales', '[]', '["Mohsin"]'),
  ('waqas@whizz.com', 'Waqas', 'Sales', '[]', '["Waqas"]');
