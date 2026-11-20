// ── Reports → Outreach vs Sales ──
// Crosses WhatsApp (normal + staged) and email outreach against sales invoices for a
// date range. Honest about what's real: WhatsApp per-lead/segment attribution only
// exists for sends made after outreach_log shipped (worker/dbSchema.js) — nothing
// retroactive. Email has always had full per-recipient history via email_sends.
// "Converted" means the contact has ANY recorded sales invoice ever, not necessarily
// within the selected date range — a sale often lands well after the outreach that led
// to it, and requiring both to land in the same window would undercount real
// conversions (this is a deliberate choice, not an oversight).
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
function json(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS }); }
function emailFromAccess(request) { return (request.headers.get('Cf-Access-Authenticated-User-Email') || '').trim().toLowerCase(); }

async function currentUser(request, env) {
  const email = emailFromAccess(request);
  return email ? env.DB.prepare('SELECT email,role FROM users WHERE email=?').bind(email).first() : null;
}
function requireAdminOrManager(user) { return user && (user.role === 'Administrator' || user.role === 'Manager'); }

function isoDate(d) { return d.toISOString().slice(0, 10); }
function defaultRange() {
  const to = new Date();
  const from = new Date(to.getTime() - 29 * 86400000); // last 30 days, inclusive of today
  return { from: isoDate(from), to: isoDate(to) };
}
function matchesFilter(value, filter) { return filter === 'ALL' || String(value || '').toLowerCase() === filter.toLowerCase(); }

// Monday of the week containing `dateStr` — same convention as teamActivity.js's
// mondayOf(), reused so a "weekly" bucket here lines up with every other weekly report.
function mondayOf(dateStr) {
  const d = new Date(dateStr);
  const dayIndex = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayIndex);
  return isoDate(d);
}

export async function handleOutreachVsSalesReport(request, env) {
  const user = await currentUser(request, env);
  if (!requireAdminOrManager(user)) return json({ error: 'Manager or Administrator access required.' }, 403);

  const url = new URL(request.url);
  const defaults = defaultRange();
  const from = (url.searchParams.get('from') || defaults.from).slice(0, 10);
  const to = (url.searchParams.get('to') || defaults.to).slice(0, 10);
  const brand = (url.searchParams.get('brand') || 'ALL').trim() || 'ALL';
  const platform = (url.searchParams.get('platform') || 'ALL').trim() || 'ALL';
  const rangeDays = Math.max(1, Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000) + 1);
  const granularity = rangeDays > 31 ? 'weekly' : 'daily';
  const bucketOf = (dateStr) => (granularity === 'weekly' ? mondayOf(dateStr) : String(dateStr).slice(0, 10));

  const [waResult, emailResult, salesResult] = await Promise.all([
    env.DB.prepare(`
      SELECT o.contactId contactId, o.platform platform, o.campaignType campaignType, o.sentAt sentAt,
        c.brand brand, c.contactName contactName
      FROM outreach_log o JOIN contacts c ON c.id = o.contactId
      WHERE date(o.sentAt) BETWEEN ?1 AND ?2
    `).bind(from, to).all(),
    env.DB.prepare(`
      SELECT es.contactId contactId, es.createdAt sentAt, c.brand brand, c.contactName contactName
      FROM email_sends es JOIN contacts c ON c.id = es.contactId
      WHERE es.contactId IS NOT NULL AND date(es.createdAt) BETWEEN ?1 AND ?2
    `).bind(from, to).all(),
    // Unconditional — every sale, ever — same pattern handleSalesByLeadReport already
    // uses; the date range is applied in JS below (needed both ways: once bounded to the
    // report window, and once unbounded for the "any sale ever" conversion check).
    env.DB.prepare(`
      SELECT i.invoiceRef invoiceRef, i.date date, i.invoiceAmount invoiceAmount, i.customerName customerName,
        m.contactId contactId, c.brand brand
      FROM sales_invoices i
      LEFT JOIN sales_customer_matches m ON m.customerName = i.customerName
      LEFT JOIN contacts c ON c.id = m.contactId
    `).all(),
  ]);

  const outreachRaw = [
    ...(waResult.results || []).map(r => ({ ...r, platform: r.platform || 'WhatsApp' })),
    ...(emailResult.results || []).map(r => ({ ...r, platform: 'Email', campaignType: 'email' })),
  ].filter(r => matchesFilter(r.brand, brand) && matchesFilter(r.platform, platform));

  const allSales = salesResult.results || [];
  const salesInRange = allSales.filter(r => r.date && r.date.slice(0, 10) >= from && r.date.slice(0, 10) <= to && matchesFilter(r.brand, brand));

  // ── Summary ──
  const contactsReached = new Set(outreachRaw.map(r => r.contactId));
  const salesByContact = new Map(); // contactId -> { invoiceCount, totalAmount, firstDate }
  for (const r of allSales) {
    if (r.contactId == null) continue;
    if (!salesByContact.has(r.contactId)) salesByContact.set(r.contactId, { invoiceCount: 0, totalAmount: 0, firstDate: null });
    const e = salesByContact.get(r.contactId);
    e.invoiceCount++;
    e.totalAmount += Number(r.invoiceAmount) || 0;
    if (!e.firstDate || r.date < e.firstDate) e.firstDate = r.date;
  }
  let convertedCount = 0, convertedValue = 0;
  for (const id of contactsReached) {
    const s = salesByContact.get(id);
    if (s) { convertedCount++; convertedValue += s.totalAmount; }
  }
  const summary = {
    from, to, granularity,
    outreachCount: outreachRaw.length,
    contactsReached: contactsReached.size,
    salesCount: salesInRange.length,
    salesValue: salesInRange.reduce((s, r) => s + (Number(r.invoiceAmount) || 0), 0),
    convertedContacts: convertedCount,
    convertedValue,
    conversionRate: contactsReached.size ? convertedCount / contactsReached.size : 0,
  };

  // ── By brand/platform ──
  const segKey = new Map();
  for (const r of outreachRaw) {
    const key = `${r.brand || '(none)'}||${r.platform}`;
    if (!segKey.has(key)) segKey.set(key, { brand: r.brand || '(none)', platform: r.platform, outreachCount: 0, contactsReached: new Set() });
    const e = segKey.get(key);
    e.outreachCount++;
    e.contactsReached.add(r.contactId);
  }
  const bySegment = [...segKey.values()]
    .map(e => ({ brand: e.brand, platform: e.platform, outreachCount: e.outreachCount, contactsReached: e.contactsReached.size }))
    .sort((a, b) => b.outreachCount - a.outreachCount);

  // ── Trend ──
  const trendMap = new Map();
  for (const r of outreachRaw) {
    const b = bucketOf(r.sentAt);
    if (!trendMap.has(b)) trendMap.set(b, { bucket: b, outreachCount: 0, salesCount: 0, salesValue: 0 });
    trendMap.get(b).outreachCount++;
  }
  for (const r of salesInRange) {
    const b = bucketOf(r.date);
    if (!trendMap.has(b)) trendMap.set(b, { bucket: b, outreachCount: 0, salesCount: 0, salesValue: 0 });
    const e = trendMap.get(b);
    e.salesCount++;
    e.salesValue += Number(r.invoiceAmount) || 0;
  }
  const trend = [...trendMap.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));

  // ── Per-lead detail ──
  const perContact = new Map();
  for (const r of outreachRaw) {
    if (!perContact.has(r.contactId)) {
      perContact.set(r.contactId, { contactId: r.contactId, contactName: r.contactName, brand: r.brand, platforms: new Set(), outreachCount: 0, lastOutreachAt: null });
    }
    const e = perContact.get(r.contactId);
    e.outreachCount++;
    e.platforms.add(r.platform);
    if (!e.lastOutreachAt || r.sentAt > e.lastOutreachAt) e.lastOutreachAt = r.sentAt;
  }
  const byLead = [...perContact.values()]
    .map(e => {
      const s = salesByContact.get(e.contactId);
      return {
        contactId: e.contactId, contactName: e.contactName, brand: e.brand,
        platforms: [...e.platforms].sort(), outreachCount: e.outreachCount, lastOutreachAt: e.lastOutreachAt,
        salesInvoiceCount: s ? s.invoiceCount : 0, salesValue: s ? s.totalAmount : 0,
        converted: !!s,
      };
    })
    .sort((a, b) => b.outreachCount - a.outreachCount);

  return json({ summary, bySegment, trend, byLead });
}
