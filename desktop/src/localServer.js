// The whole point of this file: index.html's existing fetch('/api/...')/apiW()/apiWMsg()/
// cw()/mt() calls are all relative paths, so pointing the renderer at THIS local server
// instead of the hosted domain means every one of those call sites keeps working with zero
// changes. For a bounded set of "syncable" resources (desktop/src/syncableResources.js),
// this server serves reads from a local SQLite mirror and queues writes when offline;
// everything else is a plain pass-through proxy to the real Worker, attaching the stored
// Bearer token in place of the Cloudflare Access header a browser would normally supply.
const http = require('http');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const { matchRead, matchWrite } = require('./syncableResources');

const DIST_DIR = path.join(__dirname, '..', 'dist');
const STATIC_EXTRA = { '/pairing.html': path.join(__dirname, 'pairing.html') };
const NETWORK_TIMEOUT_MS = 8000;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
// Node's fetch wraps the actually-useful error (ECONNREFUSED, ENOTFOUND, a TLS failure, …)
// in `.cause` and leaves its own `.message` as the uninformative "fetch failed" — unwrap it
// so the diagnostic detail shown to the renderer says *why*, not just *that* it failed.
function describeFetchError(err) {
  if (err && err.cause && err.cause.message) return err.cause.message;
  return (err && err.message) || String(err);
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function serveStatic(req, res, pathname, pathToServe) {
  fs.readFile(pathToServe, (err, data) => {
    if (err) { sendJson(res, 404, { error: 'Not found' }); return; }
    const ext = path.extname(pathToServe);
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  });
}

async function startLocalServer({ getToken, getBaseUrl }) {
  const server = http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res, { getToken, getBaseUrl });
    } catch (err) {
      sendJson(res, 500, { error: err.message || 'Local server error' });
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function handleRequest(req, res, { getToken, getBaseUrl }) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const pathname = url.pathname;

  // ── Local-only control endpoints — never proxied, never cached ──
  if (pathname === '/local/save-token' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    require('./authStore').setToken(body.token);
    sendJson(res, 200, { success: true });
    return;
  }
  if (pathname === '/local/status' && req.method === 'GET') {
    sendJson(res, 200, { paired: !!getToken(), outboxCount: db.outboxCount() });
    return;
  }

  // ── Static files (index.html, pairing.html, js/, css/) ──
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    return serveStatic(req, res, pathname, path.join(DIST_DIR, 'index.html'));
  }
  if (req.method === 'GET' && STATIC_EXTRA[pathname]) {
    return serveStatic(req, res, pathname, STATIC_EXTRA[pathname]);
  }
  if (req.method === 'GET' && pathname === '/lead-intelligence.html') {
    return serveStatic(req, res, pathname, path.join(DIST_DIR, 'lead-intelligence.html'));
  }
  if (req.method === 'GET' && (pathname.startsWith('/js/') || pathname.startsWith('/css/'))) {
    const filePath = path.join(DIST_DIR, pathname);
    if (filePath.startsWith(DIST_DIR)) return serveStatic(req, res, pathname, filePath);
  }

  // Not a desktop-local path — this is an /api/ or /whizz- call the renderer made exactly
  // like it would against the real site.
  const token = getToken();
  const baseUrl = getBaseUrl();
  const bodyBuffer = (req.method === 'GET' || req.method === 'HEAD') ? null : await readBody(req);
  const cacheKeyBase = pathname + (url.search || '');

  const read = matchRead(pathname, req.method);
  if (read) return handleSyncableRead(res, read, cacheKeyBase, baseUrl, token, req);

  const write = matchWrite(pathname, req.method);
  if (write) return handleSyncableWrite(res, write, cacheKeyBase, baseUrl, token, req, bodyBuffer);

  return proxyPassthrough(res, baseUrl, token, req, bodyBuffer);
}

function buildForwardHeaders(req, token) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    // accept-encoding is excluded deliberately, not just host/connection/content-length:
    // forwarding the renderer's own value turns off Node's automatic response
    // decompression on THIS outgoing fetch (most HTTP clients stop auto-decompressing the
    // moment the caller sets Accept-Encoding manually, since that signals "I'll handle
    // decoding myself") — leaving `text` below as raw, still-compressed bytes misread as a
    // string. Omitting it lets Node's fetch set its own and decompress transparently.
    if (['host', 'connection', 'content-length', 'accept-encoding'].includes(k.toLowerCase())) continue;
    headers[k] = v;
  }
  if (token) headers['authorization'] = `Bearer ${token}`;
  return headers;
}

// None of this app's syncable endpoints ever legitimately return an empty object on
// success — a real /api/me has email/name/role, a real list endpoint has its array key,
// etc. Rejecting {} (and anything unparseable/empty) catches both a bad live response
// (checked before caching it) and a bad row written before this check existed (checked
// again before ever serving a cached row), so a corrupt cache entry — however it got
// there — can never be handed to the renderer as if it were real data.
function isUsableJsonBody(text) {
  if (!text) return false;
  let parsed;
  try { parsed = JSON.parse(text); } catch (_) { return false; }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length === 0) return false;
  return true;
}

// `reason` is a short, non-sensitive diagnostic string (a caught error's message, or a
// snippet of an unusable upstream body) surfaced as `detail` on the 503 — otherwise
// "the real site timed out", "DNS failed", and "Cloudflare Access served its own HTML
// login page instead of JSON" (a routing gap, not a connectivity one) are all
// indistinguishable from the renderer's point of view.
function serveFromCache(res, cacheKey, reason) {
  const cached = db.getCache(cacheKey);
  if (cached && isUsableJsonBody(cached.body)) {
    res.writeHead(cached.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-whizz-offline-cache': cached.dirty ? 'dirty' : 'fresh' });
    res.end(cached.body);
  } else {
    if (cached) db.invalidateResource(cacheKey.split('::')[0]); // a bad row — drop it rather than leave it to keep failing this same check forever
    sendJson(res, 503, { error: 'Offline, and nothing cached yet for this view.', detail: reason || undefined });
  }
}

async function handleSyncableRead(res, resource, cacheKeyBase, baseUrl, token, req) {
  const cacheKey = `${resource.key}::${cacheKeyBase}`;
  try {
    const upstream = await fetchWithTimeout(`${baseUrl}${cacheKeyBase}`, { headers: buildForwardHeaders(req, token) });
    const text = await upstream.text();
    if (!upstream.ok) {
      // A real error response (403, 500, …) — forward it as-is so the renderer sees the
      // actual message, never silently swapped for stale cache.
      res.writeHead(upstream.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(text);
      return;
    }
    // A 200 with an empty, unparseable, or empty-object body is a real (if rare) failure
    // mode — e.g. a cold Worker isolate or transient hiccup — and must never be cached or
    // served as if it were good data: that would corrupt this resource's cache for every
    // offline read after it (this is exactly what, uncaught, once produced a session with
    // no email/name/role and left the app half-initialized). Treat it the same as a
    // network error.
    if (!isUsableJsonBody(text)) {
      serveFromCache(res, cacheKey, `Got a 200 that wasn't usable JSON: ${text.slice(0, 160)}`);
      return;
    }
    db.setCache(cacheKey, text, upstream.status);
    res.writeHead(upstream.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(text);
  } catch (err) {
    serveFromCache(res, cacheKey, describeFetchError(err));
  }
}

async function handleSyncableWrite(res, write, cacheKeyBase, baseUrl, token, req, bodyBuffer) {
  try {
    const upstream = await fetchWithTimeout(`${baseUrl}${cacheKeyBase}`, { method: req.method, headers: buildForwardHeaders(req, token), body: bodyBuffer });
    const text = await upstream.text();
    res.writeHead(upstream.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(text);
    if (upstream.ok) write.affects.forEach((key) => db.invalidateResource(key));
  } catch (_) {
    // Offline — queue it for the background sync loop, mark whatever it affects as not
    // reflecting this edit yet, and tell the renderer it was accepted (queued) rather than
    // failing outright, so index.html's existing write-then-refresh flow doesn't error.
    db.enqueueOutbox(req.method, cacheKeyBase, bodyBuffer ? bodyBuffer.toString('utf8') : null);
    write.affects.forEach((key) => db.markResourceDirty(key));
    sendJson(res, 200, { success: true, queuedOffline: true });
  }
}

async function proxyPassthrough(res, baseUrl, token, req, bodyBuffer) {
  try {
    const upstream = await fetchWithTimeout(`${baseUrl}${req.url}`, { method: req.method, headers: buildForwardHeaders(req, token), body: bodyBuffer });
    const text = await upstream.text();
    const headers = {};
    upstream.headers.forEach((v, k) => { if (!['content-encoding', 'content-length', 'transfer-encoding'].includes(k)) headers[k] = v; });
    res.writeHead(upstream.status, headers);
    res.end(text);
  } catch (err) {
    sendJson(res, 503, { error: 'This needs an internet connection.', detail: describeFetchError(err) });
  }
}

module.exports = { startLocalServer };
