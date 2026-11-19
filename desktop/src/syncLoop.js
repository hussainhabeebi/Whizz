// Drains the offline write queue once connectivity returns. Processes one outbox entry at
// a time, oldest first, and stops at the first failure (retried next tick) rather than
// reordering or parallelizing — simple and safe, since these are exactly the same writes
// the Worker already validates/applies, just replayed a little later than they happened.
const db = require('./db');
const { matchWrite } = require('./syncableResources');

const TICK_MS = 20000;
const NETWORK_TIMEOUT_MS = 8000;

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function drainOnce({ getToken, getBaseUrl, onStatusChange }) {
  const token = getToken();
  if (!token) return;
  const baseUrl = getBaseUrl();

  // A lightweight reachability probe doubles as "are we online" — /api/me is cheap and
  // already required to be fast since the browser's own boot flow depends on it.
  let online = false;
  try {
    const probe = await fetchWithTimeout(`${baseUrl}/api/me`, { headers: { authorization: `Bearer ${token}` } });
    online = probe.ok;
  } catch (_) { online = false; }
  if (onStatusChange) onStatusChange({ online, outboxCount: db.outboxCount() });
  if (!online) return;

  for (;;) {
    const entry = db.peekOldestOutboxEntry();
    if (!entry) break;
    const [pathname] = entry.path.split('?');
    try {
      const upstream = await fetchWithTimeout(`${baseUrl}${entry.path}`, {
        method: entry.method,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: entry.body || undefined,
      });
      if (!upstream.ok) break; // a real rejection (not just offline) — leave it queued, don't loop forever on it
      db.deleteOutboxEntry(entry.id);
      const write = matchWrite(pathname, entry.method);
      if (write) write.affects.forEach((key) => db.invalidateResource(key));
    } catch (_) {
      break; // network dropped again mid-drain — stop, retry next tick
    }
  }
  if (onStatusChange) onStatusChange({ online, outboxCount: db.outboxCount() });
}

function startSyncLoop(deps) {
  drainOnce(deps);
  const timer = setInterval(() => drainOnce(deps), TICK_MS);
  return () => clearInterval(timer);
}

module.exports = { startSyncLoop };
