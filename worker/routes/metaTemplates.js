// ── WhatsApp template management via Meta's Graph API (direct, not n8n) ──
// Template approval is per Meta WhatsApp Business Account (WABA) — each configured
// Chatwoot inbox carries its own wabaId (see chatwoot.js / Integrations page), and every
// template fetched here comes tagged with the inbox it actually belongs to, straight from
// Meta. One System User access token (stored encrypted, Administrator-entered) is expected
// to have access to every WABA under the same Meta Business portfolio.
const GRAPH_API_VERSION = 'v21.0';
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
function json(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS }); }
function emailFromAccess(request) { return (request.headers.get('Cf-Access-Authenticated-User-Email') || '').trim().toLowerCase(); }

async function currentUser(request, env) {
  const email = emailFromAccess(request);
  return email ? env.DB.prepare('SELECT email,name,role,teamId FROM users WHERE email=?').bind(email).first() : null;
}
function requireAdmin(user) { return user && user.role === 'Administrator'; }

// Same AES-GCM technique/secret as the Chatwoot token and Lead Intelligence's directory
// credentials — kept as a local copy rather than a shared import (matches this repo's
// existing pattern of small per-route duplication over a shared crypto util module).
async function cryptoKey(secret) {
  if (!secret) throw new Error('LEAD_INTELLIGENCE_KEY secret is not configured — set it with `wrangler secret put LEAD_INTELLIGENCE_KEY` before saving a Meta access token.');
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
function toB64(bytes) { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); }
function fromB64(s) { const bin = atob(s); return Uint8Array.from(bin, c => c.charCodeAt(0)); }
async function encryptToken(env, value) {
  const key = await cryptoKey(env.LEAD_INTELLIGENCE_KEY);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(value));
  return `${toB64(iv)}.${toB64(new Uint8Array(cipher))}`;
}
async function decryptToken(env, token) {
  if (!token) return '';
  const [iv64, data64] = token.split('.');
  const key = await cryptoKey(env.LEAD_INTELLIGENCE_KEY);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv64) }, key, fromB64(data64));
  return new TextDecoder().decode(plain);
}

async function getMetaSettingsRow(env) { return env.DB.prepare('SELECT * FROM meta_whatsapp_settings WHERE id=1').first(); }
async function loadMetaAccessToken(env) {
  const row = await getMetaSettingsRow(env);
  if (!row?.accessTokenEncrypted) return null;
  const token = await decryptToken(env, row.accessTokenEncrypted);
  return token || null;
}
async function listInboxesWithWaba(env) {
  const result = await env.DB.prepare("SELECT id,inboxId,label,wabaId,phoneNumber FROM chatwoot_inboxes WHERE wabaId<>'' ORDER BY id").all();
  return result.results || [];
}

async function graphFetch(accessToken, path, options = {}) {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}${path}`;
  const response = await fetch(url, {
    ...options,
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `Meta API request failed (${response.status})`);
  return data;
}

export async function handleGetMetaSettings(request, env) {
  const user = await currentUser(request, env);
  if (!requireAdmin(user)) return json({ error: 'Administrator access required.' }, 403);
  const row = await getMetaSettingsRow(env);
  return json({ hasToken: !!row?.accessTokenEncrypted });
}

export async function handleSaveMetaSettings(request, env) {
  const user = await currentUser(request, env);
  if (!requireAdmin(user)) return json({ error: 'Administrator access required.' }, 403);
  const body = await request.json().catch(() => ({}));
  const newToken = String(body.accessToken || '').trim();
  const existing = await getMetaSettingsRow(env);
  let accessTokenEncrypted = existing?.accessTokenEncrypted || null;
  if (newToken) {
    try { accessTokenEncrypted = await encryptToken(env, newToken); }
    catch (error) { return json({ error: error.message }, 500); }
  }
  if (!accessTokenEncrypted) return json({ error: 'An access token is required.' }, 400);
  await env.DB.prepare(`INSERT INTO meta_whatsapp_settings (id,accessTokenEncrypted,updatedAt) VALUES (1,?,CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET accessTokenEncrypted=excluded.accessTokenEncrypted, updatedAt=CURRENT_TIMESTAMP`)
    .bind(accessTokenEncrypted).run();
  return json({ success: true });
}

function normalizeTemplate(raw, inboxId) {
  const components = raw.components || [];
  const header = components.find(c => c.type === 'HEADER' && c.format === 'TEXT');
  const body = components.find(c => c.type === 'BODY');
  const footer = components.find(c => c.type === 'FOOTER');
  return {
    id: raw.id,
    name: raw.name,
    language: raw.language,
    category: raw.category,
    status: raw.status,
    header: header?.text || '',
    body: body?.text || '',
    footer: footer?.text || '',
    inboxId,
  };
}

export async function handleListMetaTemplates(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'User is not provisioned in Whizz.' }, 403);
  const accessToken = await loadMetaAccessToken(env);
  if (!accessToken) return json({ error: 'Meta WhatsApp isn’t connected yet. Add an access token under Integrations.' }, 503);
  const inboxes = await listInboxesWithWaba(env);
  if (!inboxes.length) return json({ error: 'No inbox has a WABA ID set yet — add one under Integrations → Chatwoot.' }, 503);

  const templates = [];
  // Per-inbox counts/errors travel back even when templates is empty, so an empty
  // Templates page can say *why* (wrong WABA ID, no permission, genuinely zero
  // templates on that WABA) instead of just looking identical to "not connected".
  const diagnostics = [];
  for (const inbox of inboxes) {
    let count = 0, error = null;
    try {
      let next = `/${inbox.wabaId}/message_templates?fields=name,status,category,language,components&limit=100`;
      while (next) {
        const data = await graphFetch(accessToken, next);
        for (const raw of data.data || []) { templates.push(normalizeTemplate(raw, inbox.inboxId)); count++; }
        const nextUrl = data.paging?.next || null;
        next = nextUrl ? nextUrl.replace(`https://graph.facebook.com/${GRAPH_API_VERSION}`, '') : null;
      }
    } catch (err) {
      error = err.message;
      templates.push({ name: `(${inbox.label}: failed to load — ${err.message})`, language: '', category: '', status: 'ERROR', body: '', inboxId: inbox.inboxId, loadError: true });
    }
    diagnostics.push({ inboxId: inbox.inboxId, label: inbox.label, wabaId: inbox.wabaId, count, error });
  }
  return json({ templates, diagnostics });
}

// Meta requires an example value for every {{n}} placeholder before a template with
// variables can be submitted for review. Real per-recipient values aren't known yet at
// creation time, so this fills in plain placeholders — Meta only needs *a* plausible
// example to approve the template shape, not real data.
function exampleTextFor(text) {
  const nums = [...new Set([...(text || '').matchAll(/\{\{(\d+)\}\}/g)].map(m => Number(m[1])))].sort((a, b) => a - b);
  return nums.length ? nums.map(n => `Example ${n}`) : null;
}

export async function handleCreateMetaTemplate(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'User is not provisioned in Whizz.' }, 403);
  const accessToken = await loadMetaAccessToken(env);
  if (!accessToken) return json({ error: 'Meta WhatsApp isn’t connected yet. Add an access token under Integrations.' }, 503);

  const body = await request.json().catch(() => ({}));
  const inboxId = String(body.inboxId || '').trim();
  const name = String(body.name || '').trim();
  const language = String(body.language || '').trim();
  const category = String(body.category || 'MARKETING').trim();
  const headerText = String(body.header || '').trim();
  const bodyText = String(body.body || '').trim();
  const footerText = String(body.footer || '').trim();
  if (!name || !language || !bodyText) return json({ error: 'Name, language and body are required.' }, 400);

  const inboxes = await listInboxesWithWaba(env);
  const inbox = inboxId ? inboxes.find(ib => ib.inboxId === inboxId) : inboxes[0];
  if (!inbox) return json({ error: 'No matching inbox with a WABA ID was found. Set one under Integrations → Chatwoot.' }, 400);

  const components = [];
  if (headerText) {
    const example = exampleTextFor(headerText);
    components.push({ type: 'HEADER', format: 'TEXT', text: headerText, ...(example ? { example: { header_text: example } } : {}) });
  }
  const bodyExample = exampleTextFor(bodyText);
  components.push({ type: 'BODY', text: bodyText, ...(bodyExample ? { example: { body_text: [bodyExample] } } : {}) });
  if (footerText) components.push({ type: 'FOOTER', text: footerText });

  try {
    const created = await graphFetch(accessToken, `/${inbox.wabaId}/message_templates`, {
      method: 'POST',
      body: JSON.stringify({ name, language, category, components }),
    });
    return json({ success: true, id: created.id, status: created.status, category: created.category, inboxId: inbox.inboxId }, 201);
  } catch (error) { return json({ error: error.message }, 502); }
}

export async function handleDeleteMetaTemplate(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'User is not provisioned in Whizz.' }, 403);
  const accessToken = await loadMetaAccessToken(env);
  if (!accessToken) return json({ error: 'Meta WhatsApp isn’t connected yet.' }, 503);

  const body = await request.json().catch(() => ({}));
  const inboxId = String(body.inboxId || '').trim();
  const name = String(body.name || '').trim();
  if (!inboxId || !name) return json({ error: 'Inbox and template name are required.' }, 400);

  const inboxes = await listInboxesWithWaba(env);
  const inbox = inboxes.find(ib => ib.inboxId === inboxId);
  if (!inbox) return json({ error: 'No matching inbox with a WABA ID was found.' }, 400);

  try {
    await graphFetch(accessToken, `/${inbox.wabaId}/message_templates?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
  } catch (error) { return json({ error: error.message }, 502); }
  return json({ success: true });
}
