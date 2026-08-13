-- Users: who can use Whizz and what they're allowed to see. Previously lived in
-- each admin's own browser localStorage — moved here so it's one shared source of
-- truth, since whizz-add-user/whizz-delete-user now also sync this list to the
-- Cloudflare Access policy that gates who can reach the app at all.
CREATE TABLE users (
  email TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'Sales',
  allowedBrands TEXT NOT NULL DEFAULT '[]',
  allowedPlatforms TEXT NOT NULL DEFAULT '[]'
);

INSERT INTO users (email, name, role, allowedBrands, allowedPlatforms) VALUES
('hussain@whizzfze.com', 'Hussain', 'Administrator', '[]', '[]'),
('admin@whizz.com', 'Whizz Admin', 'Administrator', '[]', '[]'),
('sales@whizz.com', 'Sales Team', 'Sales', '[]', '["Viral"]'),
('manager@whizz.com', 'Whizz Manager', 'Manager', '[]', '[]'),
('mohsin@whizz.com', 'Mohsin', 'Sales', '[]', '["Mohsin"]'),
('waqas@whizz.com', 'Waqas', 'Sales', '[]', '["Waqas"]');
