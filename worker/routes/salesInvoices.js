// ── Sales Invoices module — a live, read-only pull from the company's own sales/ERP API
// for a selected date range. Nothing is stored in D1 except the connection settings
// (base URL, company code, API key) — every invoice list is fetched fresh, same spirit as
// this repo's other "live external pull" integrations rather than a synced local copy.
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
function json(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS }); }
function emailFromAccess(request) { return (request.headers.get('Cf-Access-Authenticated-User-Email') || '').trim().toLowerCase(); }

async function currentUser(request, env) {
  const email = emailFromAccess(request);
  return email ? env.DB.prepare('SELECT email,role FROM users WHERE email=?').bind(email).first() : null;
}
function requireAdmin(user) { return user && user.role === 'Administrator'; }

// Same AES-GCM technique/secret as every other stored credential in this repo (Meta
// access token, Chatwoot token, Telegram bot token, Resend API key) — kept as a local
// copy per this repo's established pattern of small per-route duplication over a shared
// crypto util module.
async function cryptoKey(secret) {
  if (!secret) throw new Error('LEAD_INTELLIGENCE_KEY secret is not configured — set it with `wrangler secret put LEAD_INTELLIGENCE_KEY` before saving a sales API key.');
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

async function getSalesSettingsRow(env) { return env.DB.prepare('SELECT * FROM sales_invoice_settings WHERE id=1').first(); }

export async function handleGetSalesInvoiceSettings(request, env) {
  const user = await currentUser(request, env);
  if (!requireAdmin(user)) return json({ error: 'Administrator access required.' }, 403);
  const row = await getSalesSettingsRow(env);
  return json({ hasApiKey: !!row?.apiKeyEncrypted, baseUrl: row?.baseUrl || '', compCode: row?.compCode || '' });
}

export async function handleSaveSalesInvoiceSettings(request, env) {
  const user = await currentUser(request, env);
  if (!requireAdmin(user)) return json({ error: 'Administrator access required.' }, 403);
  const body = await request.json().catch(() => ({}));
  const newKey = String(body.apiKey || '').trim();
  const existing = await getSalesSettingsRow(env);
  let apiKeyEncrypted = existing?.apiKeyEncrypted || null;
  if (newKey) {
    try { apiKeyEncrypted = await encryptToken(env, newKey); }
    catch (error) { return json({ error: error.message }, 500); }
  }
  if (!apiKeyEncrypted) return json({ error: 'An API key is required.' }, 400);
  const baseUrl = body.baseUrl !== undefined ? String(body.baseUrl).trim() : (existing?.baseUrl || '');
  const compCode = body.compCode !== undefined ? String(body.compCode).trim() : (existing?.compCode || '');
  if (!baseUrl) return json({ error: 'A base URL is required.' }, 400);
  await env.DB.prepare(`INSERT INTO sales_invoice_settings (id,baseUrl,compCode,apiKeyEncrypted,updatedAt) VALUES (1,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET baseUrl=excluded.baseUrl, compCode=excluded.compCode, apiKeyEncrypted=excluded.apiKeyEncrypted, updatedAt=CURRENT_TIMESTAMP`)
    .bind(baseUrl, compCode, apiKeyEncrypted).run();
  return json({ success: true });
}

// The external API's exact field names weren't something this environment could probe
// (the server isn't reachable from here to test against) — every plausible key is tried,
// same multi-fallback convention convPhone()/normalizeConversation() already use
// elsewhere in this app, rather than guessing one shape and silently breaking if it's
// wrong. If every candidate for a field comes up empty, that column renders as "—" (not a
// guess), and the response's `sample` field carries one raw row back so the real shape
// can be inspected and this mapping adjusted.
function firstOf(row, keys) {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== null && row[k] !== '') return row[k];
  }
  return '';
}
function normalizeInvoice(raw) {
  const date = firstOf(raw, ['date', 'Date', 'invoiceDate', 'InvoiceDate', 'salesDate', 'SalesDate', 'docDate', 'DocDate', 'billDate', 'BillDate']);
  const customerName = firstOf(raw, ['customerName', 'CustomerName', 'custName', 'CustName', 'partyName', 'PartyName', 'customer', 'Customer', 'clientName', 'ClientName']);
  const amount = firstOf(raw, ['invoiceAmount', 'InvoiceAmount', 'amount', 'Amount', 'netAmount', 'NetAmount', 'totalAmount', 'TotalAmount', 'grandTotal', 'GrandTotal', 'billAmount', 'BillAmount']);
  return { date: String(date || ''), customerName: String(customerName || ''), invoiceAmount: Number(amount) || 0 };
}

export async function handleListSalesInvoices(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'User is not provisioned in Whizz.' }, 403);
  const settings = await getSalesSettingsRow(env);
  if (!settings?.apiKeyEncrypted || !settings.baseUrl) return json({ error: 'Sales Invoices isn’t connected yet. Add the API details above.' }, 503);
  let apiKey;
  try { apiKey = await decryptToken(env, settings.apiKeyEncrypted); }
  catch (error) { return json({ error: error.message }, 500); }

  const url = new URL(request.url);
  const today = new Date().toISOString().slice(0, 10);
  const startDate = url.searchParams.get('startDate') || today;
  const endDate = url.searchParams.get('endDate') || startDate;

  let target;
  try { target = new URL(settings.baseUrl); }
  catch (error) { return json({ error: `The saved base URL isn't valid: ${error.message}` }, 500); }
  target.searchParams.set('startDate', startDate);
  target.searchParams.set('endDate', endDate);
  if (settings.compCode) target.searchParams.set('compCode', settings.compCode);

  let text;
  try {
    const response = await fetch(target.toString(), { headers: { 'x-api-key': apiKey } });
    text = await response.text();
    if (!response.ok) return json({ error: `Sales API returned HTTP ${response.status}: ${text.slice(0, 200)}` }, 502);
  } catch (error) {
    return json({ error: `Could not reach the sales API: ${error.message}` }, 502);
  }

  let data;
  try { data = JSON.parse(text); }
  catch (error) { return json({ error: `Sales API did not return JSON: ${text.slice(0, 200)}` }, 502); }

  const rows = Array.isArray(data) ? data
    : Array.isArray(data.data) ? data.data
      : Array.isArray(data.result) ? data.result
        : Array.isArray(data.sales) ? data.sales
          : Array.isArray(data.invoices) ? data.invoices : [];
  const invoices = rows.map(normalizeInvoice);
  const total = invoices.reduce((sum, i) => sum + i.invoiceAmount, 0);
  // One raw row, not every row — enough to debug the field mapping above without
  // bloating the response on a large date range.
  return json({ invoices, total, count: invoices.length, sample: rows[0] || null });
}
