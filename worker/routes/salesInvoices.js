// ── Sales Invoices module ──
// Two ways to get data in, both ending up in the same table/export:
// 1. Live pull (handleListSalesInvoices) — direct from the company's sales/ERP API for a
//    selected date range. Requires that API to be reachable from Cloudflare's network,
//    which it currently isn't (IP-restricted to the office network, out of this repo's
//    control to fix).
// 2. Import (handleImportSalesInvoices) — the same JSON the live API would have returned,
//    pulled from a machine that CAN reach it (e.g. the office network) and pasted/uploaded
//    here. Upserted into sales_invoices by invoiceRef, so re-importing an overlapping date
//    range never creates duplicates or loses a row that isn't in this particular import.
// Connection settings (base URL, company code, API key) are still the only thing this
// module stores on its own for the live path — imported invoices are the one real stored
// dataset.
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
function json(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS }); }
function emailFromAccess(request) { return (request.headers.get('Cf-Access-Authenticated-User-Email') || '').trim().toLowerCase(); }

async function currentUser(request, env) {
  const email = emailFromAccess(request);
  return email ? env.DB.prepare('SELECT email,role FROM users WHERE email=?').bind(email).first() : null;
}
function requireAdmin(user) { return user && user.role === 'Administrator'; }
function requireAdminOrManager(user) { return user && (user.role === 'Administrator' || user.role === 'Manager'); }

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

// Confirmed against a real response from this exact API (a UAE e-invoicing-style sales
// voucher feed): issueDate/buyerName/payableAmount are the real fields — sellerName is
// Whizz itself, not the customer, and totalIncludingTax/lineExtensionTotal can be 0 on a
// row where payableAmount is the only populated total, so that's the one used. The
// original generic guesses are kept as fallbacks after the confirmed names, in case a
// future response from this API (a different voucher type, a schema update) doesn't carry
// one of these exact keys — never the other way round.
function firstOf(row, keys) {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== null && row[k] !== '') return row[k];
  }
  return '';
}
// Cheap, deterministic, non-cryptographic — only ever used as a last-resort dedupe key
// when a row has no invoiceRef/documentId at all, so the same malformed row re-imported
// twice still collapses to one, rather than piling up duplicates.
function cheapHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (Math.imul(31, h) + s.charCodeAt(i)) | 0; }
  return 'ROW_' + (h >>> 0).toString(36);
}
function normalizeInvoice(raw) {
  const date = firstOf(raw, ['issueDate', 'date', 'Date', 'invoiceDate', 'InvoiceDate', 'salesDate', 'SalesDate', 'docDate', 'DocDate', 'billDate', 'BillDate']);
  const customerName = firstOf(raw, ['buyerName', 'customerName', 'CustomerName', 'custName', 'CustName', 'partyName', 'PartyName', 'customer', 'Customer', 'clientName', 'ClientName']);
  const amount = firstOf(raw, ['payableAmount', 'invoiceAmount', 'InvoiceAmount', 'amount', 'Amount', 'netAmount', 'NetAmount', 'totalAmount', 'TotalAmount', 'grandTotal', 'GrandTotal', 'billAmount', 'BillAmount']);
  const invoiceRef = firstOf(raw, ['invoiceRef', 'documentId', 'InvoiceRef', 'DocumentId', 'invoiceNumber', 'InvoiceNumber']) || cheapHash(JSON.stringify(raw));
  return { invoiceRef: String(invoiceRef), date: String(date || ''), customerName: String(customerName || ''), invoiceAmount: Number(amount) || 0 };
}
// Shared by the live pull and the import handler — the API wraps its array under a few
// different possible keys depending on the endpoint, same multi-fallback spirit as the
// field-name matching above.
function extractRows(data) {
  return Array.isArray(data) ? data
    : Array.isArray(data?.data) ? data.data
      : Array.isArray(data?.result) ? data.result
        : Array.isArray(data?.sales) ? data.sales
          : Array.isArray(data?.invoices) ? data.invoices : [];
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

  // The x-api-key header is rejected with this API's own "error code: 1003" — not a
  // connection problem (that request did reach it and got a structured response), so
  // this is most likely how the key is passed, not where. Tries every common convention
  // in turn and uses whichever one the API actually accepts, rather than committing to
  // one guess and leaving the whole module broken if it's wrong.
  const attempts = [
    { label: 'x-api-key header', headers: { 'x-api-key': apiKey }, extraParams: {} },
    { label: 'Authorization: Bearer header', headers: { authorization: `Bearer ${apiKey}` }, extraParams: {} },
    { label: 'Authorization header (no Bearer)', headers: { authorization: apiKey }, extraParams: {} },
    { label: 'apiKey query param', headers: {}, extraParams: { apiKey } },
    { label: 'api_key query param', headers: {}, extraParams: { api_key: apiKey } },
    { label: '"ApiKey" header (no hyphen)', headers: { ApiKey: apiKey }, extraParams: {} },
  ];
  let text, lastError, succeededAs = null;
  for (const attempt of attempts) {
    const attemptUrl = new URL(target.toString());
    for (const [k, v] of Object.entries(attempt.extraParams)) attemptUrl.searchParams.set(k, v);
    try {
      const response = await fetch(attemptUrl.toString(), { headers: attempt.headers });
      const body = await response.text();
      if (response.ok) { text = body; succeededAs = attempt.label; break; }
      lastError = `HTTP ${response.status} (tried as ${attempt.label}): ${body.slice(0, 200)}`;
    } catch (error) {
      lastError = `Could not reach the sales API (tried as ${attempt.label}): ${error.message}`;
    }
  }
  if (succeededAs === null) {
    return json({ error: `Every way of sending the API key was rejected. Last attempt — ${lastError}` }, 502);
  }

  let data;
  try { data = JSON.parse(text); }
  catch (error) { return json({ error: `Sales API did not return JSON: ${text.slice(0, 200)}` }, 502); }

  const rows = extractRows(data);
  const invoices = rows.map(normalizeInvoice);
  const total = invoices.reduce((sum, i) => sum + i.invoiceAmount, 0);
  // One raw row, not every row — enough to debug the field mapping above without
  // bloating the response on a large date range. authMethod says which of the attempts
  // above actually worked, in case that's ever useful to know later.
  return json({ invoices, total, count: invoices.length, sample: rows[0] || null, authMethod: succeededAs });
}

// ── Import path — for when the live API isn't reachable from Cloudflare but is reachable
// from somewhere else (e.g. the office network). Accepts the exact same JSON shape the
// live API itself returns (or a bare array of rows), reusing extractRows/normalizeInvoice
// so the two paths can never drift apart on field mapping. Upserts by invoiceRef: an
// existing row is refreshed if the same invoice is imported again, but nothing already
// stored is ever deleted just because this particular import doesn't mention it — each
// import is additive, never a full replace.
export async function handleImportSalesInvoices(request, env) {
  const user = await currentUser(request, env);
  if (!requireAdmin(user)) return json({ error: 'Administrator access required.' }, 403);
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'Could not parse the pasted/uploaded data as JSON.' }, 400);
  const rows = extractRows(body);
  if (!rows.length) return json({ error: 'No invoice rows found in that data — expected an array, or an object with a data/result/sales/invoices array.' }, 400);

  const invoices = rows.map(normalizeInvoice);
  let imported = 0;
  for (const inv of invoices) {
    try {
      await env.DB.prepare(`INSERT INTO sales_invoices (invoiceRef,date,customerName,invoiceAmount,importedByEmail,importedAt) VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)
        ON CONFLICT(invoiceRef) DO UPDATE SET date=excluded.date, customerName=excluded.customerName, invoiceAmount=excluded.invoiceAmount, importedByEmail=excluded.importedByEmail, importedAt=CURRENT_TIMESTAMP`)
        .bind(inv.invoiceRef, inv.date, inv.customerName, inv.invoiceAmount, user.email).run();
      imported++;
    } catch (_) { /* one bad row shouldn't abort the whole import */ }
  }
  return json({ success: true, imported, totalInBatch: invoices.length });
}

export async function handleListStoredSalesInvoices(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'User is not provisioned in Whizz.' }, 403);
  const url = new URL(request.url);
  const today = new Date().toISOString().slice(0, 10);
  const startDate = url.searchParams.get('startDate') || today;
  const endDate = url.searchParams.get('endDate') || startDate;
  // date is stored as the API's own ISO "YYYY-MM-DD" string — plain string comparison
  // sorts/filters correctly for that format, same as every other ISO-date-as-TEXT column
  // already in this schema (contacts.createdAt and friends).
  const result = await env.DB.prepare('SELECT invoiceRef,date,customerName,invoiceAmount FROM sales_invoices WHERE date>=? AND date<=? ORDER BY date DESC, invoiceRef DESC')
    .bind(startDate, endDate).all();
  const invoices = result.results || [];
  const total = invoices.reduce((sum, i) => sum + (Number(i.invoiceAmount) || 0), 0);
  return json({ invoices, total, count: invoices.length });
}

// ── Matching sales customers to CRM leads/contacts ──
// A sales voucher's customerName is free text from the ERP side — it has no relationship
// to the contacts table at all until explicitly matched. Matching happens once per
// distinct customerName (not per invoice), stored in sales_customer_matches, and applies
// automatically to every past and future invoice with that same name. A row with
// contactId=NULL means "reviewed, confirmed no matching lead" — distinct from no row at
// all, which means "not reviewed yet". The actual fuzzy/approximate-name suggestion logic
// lives client-side (reuses this app's existing levenshteinDistance(), the same approach
// already used to de-duplicate near-identical platform names) — this backend only stores
// and serves confirmed matches, never guesses one on its own.
export async function handleListSalesCustomers(request, env) {
  const user = await currentUser(request, env);
  if (!requireAdminOrManager(user)) return json({ error: 'Manager or Administrator access required.' }, 403);
  const result = await env.DB.prepare(`
    SELECT i.customerName, COUNT(*) invoiceCount, SUM(i.invoiceAmount) totalAmount, MAX(i.date) lastDate,
      m.contactId, m.contactName matchedContactName, m.method matchMethod
    FROM sales_invoices i LEFT JOIN sales_customer_matches m ON m.customerName = i.customerName
    GROUP BY i.customerName
    ORDER BY totalAmount DESC
  `).all();
  // reviewed=false (no row in sales_customer_matches at all) vs reviewed=true with
  // contactId=null (explicitly confirmed as "no matching lead") must stay distinguishable
  // on the frontend — SQL NULL alone can't tell those apart, so this flags it explicitly.
  const customers = (result.results || []).map(r => ({
    customerName: r.customerName, invoiceCount: r.invoiceCount, totalAmount: r.totalAmount, lastDate: r.lastDate,
    contactId: r.contactId ?? null, matchedContactName: r.matchedContactName || '', matchMethod: r.matchMethod || '',
    reviewed: r.matchMethod !== null && r.matchMethod !== undefined,
  }));
  return json({ customers });
}

export async function handleSaveSalesCustomerMatch(request, env) {
  const user = await currentUser(request, env);
  if (!requireAdminOrManager(user)) return json({ error: 'Manager or Administrator access required.' }, 403);
  const body = await request.json().catch(() => ({}));
  const customerName = String(body.customerName || '').trim();
  if (!customerName) return json({ error: 'customerName is required.' }, 400);
  const contactId = body.contactId === null || body.contactId === undefined || body.contactId === '' ? null : Number(body.contactId);
  const contactName = String(body.contactName || '').trim();
  const method = body.method === 'auto' ? 'auto' : 'manual';
  await env.DB.prepare(`INSERT INTO sales_customer_matches (customerName,contactId,contactName,method,matchedByEmail,matchedAt) VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(customerName) DO UPDATE SET contactId=excluded.contactId, contactName=excluded.contactName, method=excluded.method, matchedByEmail=excluded.matchedByEmail, matchedAt=CURRENT_TIMESTAMP`)
    .bind(customerName, contactId, contactName, method, user.email).run();
  return json({ success: true });
}

// ── Sales by Lead report — every matched invoice rolled up per contact, with that
// contact's own CRM brand/platform/country for cross-cutting. Unmatched sales are
// reported separately rather than silently dropped from the totals. ──
export async function handleSalesByLeadReport(request, env) {
  const user = await currentUser(request, env);
  if (!requireAdminOrManager(user)) return json({ error: 'Manager or Administrator access required.' }, 403);
  const matched = await env.DB.prepare(`
    SELECT c.id contactId, c.contactName, c.company, c.brand, c.platform, c.country,
      COUNT(i.invoiceRef) invoiceCount, SUM(i.invoiceAmount) totalSales, MAX(i.date) lastSaleDate
    FROM sales_invoices i
    JOIN sales_customer_matches m ON m.customerName = i.customerName
    JOIN contacts c ON c.id = m.contactId
    GROUP BY c.id
    ORDER BY totalSales DESC
  `).all();
  const unmatched = await env.DB.prepare(`
    SELECT COUNT(DISTINCT i.customerName) customerCount, COUNT(*) invoiceCount, COALESCE(SUM(i.invoiceAmount),0) totalAmount
    FROM sales_invoices i
    LEFT JOIN sales_customer_matches m ON m.customerName = i.customerName
    WHERE m.contactId IS NULL
  `).first();
  return json({ rows: matched.results || [], unmatched: unmatched || { customerCount: 0, invoiceCount: 0, totalAmount: 0 } });
}
