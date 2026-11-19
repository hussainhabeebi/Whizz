// The real Whizz Worker's hosted domain (see wrangler.toml's LEAD_INTELLIGENCE_CALLBACK_URL,
// which points at this same domain) — everything the local server doesn't serve from its
// own SQLite mirror gets proxied here. Overridable via a small config.json in the app's
// userData folder, in case the domain ever changes, without needing a new build.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULT_BASE_URL = 'https://tiarafzco.com';

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function getBaseUrl() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed.baseUrl) return String(parsed.baseUrl).replace(/\/$/, '');
  } catch (_) { /* no override saved yet — use the default */ }
  return DEFAULT_BASE_URL;
}

function setBaseUrl(url) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify({ baseUrl: String(url).replace(/\/$/, '') }));
}

module.exports = { getBaseUrl, setBaseUrl, DEFAULT_BASE_URL };
