// Local SQLite mirror + write queue. Deliberately generic rather than one real table per
// server table: mirror_cache stores each syncable GET response verbatim (keyed by its full
// path+querystring) rather than modelling every column of every Worker table locally. This
// is enough to serve instant/offline reads and is far less code than re-deriving the
// server's own schema per resource — the Worker (via the proxy below) stays the only place
// business logic actually lives.
const { app } = require('electron');
const path = require('path');
const Database = require('better-sqlite3');

let db;

function getDb() {
  if (db) return db;
  const dbPath = path.join(app.getPath('userData'), 'whizz-local.sqlite');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS mirror_cache (
      cacheKey TEXT PRIMARY KEY,
      body TEXT NOT NULL,
      status INTEGER NOT NULL,
      updatedAt TEXT NOT NULL,
      dirty INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sync_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      body TEXT,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  return db;
}

function getCache(cacheKey) {
  const row = getDb().prepare('SELECT body,status,updatedAt,dirty FROM mirror_cache WHERE cacheKey=?').get(cacheKey);
  return row || null;
}
function setCache(cacheKey, body, status) {
  getDb().prepare(`INSERT INTO mirror_cache (cacheKey,body,status,updatedAt,dirty) VALUES (?,?,?,?,0)
    ON CONFLICT(cacheKey) DO UPDATE SET body=excluded.body, status=excluded.status, updatedAt=excluded.updatedAt, dirty=0`)
    .run(cacheKey, body, status, new Date().toISOString());
}
// Marks every cached entry for a resource "dirty" (not deleted) after an offline write —
// the UI keeps showing the last-known-good snapshot rather than going blank, but it's
// flagged as not reflecting that edit yet until the outbox actually syncs.
function markResourceDirty(resourceKeyPrefix) {
  getDb().prepare("UPDATE mirror_cache SET dirty=1 WHERE cacheKey LIKE ?").run(`${resourceKeyPrefix}::%`);
}
function invalidateResource(resourceKeyPrefix) {
  getDb().prepare("DELETE FROM mirror_cache WHERE cacheKey LIKE ?").run(`${resourceKeyPrefix}::%`);
}

function enqueueOutbox(method, pathWithQuery, bodyText) {
  getDb().prepare('INSERT INTO sync_outbox (method,path,body,createdAt) VALUES (?,?,?,CURRENT_TIMESTAMP)')
    .run(method, pathWithQuery, bodyText ?? null);
}
function peekOldestOutboxEntry() {
  return getDb().prepare('SELECT * FROM sync_outbox ORDER BY id ASC LIMIT 1').get() || null;
}
function deleteOutboxEntry(id) {
  getDb().prepare('DELETE FROM sync_outbox WHERE id=?').run(id);
}
function outboxCount() {
  return getDb().prepare('SELECT COUNT(*) c FROM sync_outbox').get().c;
}

module.exports = {
  getCache, setCache, markResourceDirty, invalidateResource,
  enqueueOutbox, peekOldestOutboxEntry, deleteOutboxEntry, outboxCount,
};
