import { loadMetaAccessToken, graphFetch } from './metaTemplates.js';

// ── Reports → Team Activity ──
// Per-salesperson view of what's actually happening: leads added, leads converted,
// messages sent, conversations assigned. Honest about what's real:
// - Leads added/converted come straight from contacts.createdByEmail/ownerEmail +
//   createdAt/convertedAt — real, no gaps.
// - Conversations assigned comes from conversation_assignments — a current snapshot
//   (the table doesn't version assignment history), real.
// - Messages sent comes from user_activity_log, which only started being written the
//   moment this feature shipped — there's no way to attribute WhatsApp sends to a Whizz
//   user before that (everything went through one shared Chatwoot/Meta token with no
//   per-user record). Numbers before the table existed are simply absent, not zero.
export async function logUserActivity(env, email, action, count = 1, inboxId = '') {
  if (!email || count <= 0) return;
  try {
    await env.DB.prepare('INSERT INTO user_activity_log (email,action,count,inboxId) VALUES (?,?,?,?)').bind(email, action, count, inboxId || '').run();
  } catch (_) { /* best-effort — never block a send over activity logging */ }
}

function json(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } }); }

export async function handleTeamActivityReport(request, env) {
  const email = (request.headers.get('Cf-Access-Authenticated-User-Email') || '').trim().toLowerCase();
  const actor = email ? await env.DB.prepare('SELECT email,role,teamId FROM users WHERE email=?').bind(email).first() : null;
  if (!actor) return json({ error: 'Authenticated user is not provisioned in Whizz.' }, 403);

  const url = new URL(request.url);
  const period = (url.searchParams.get('period') || 'all').trim();
  const dateFilter = (column) => period === 'all' ? '1=1' : `strftime('%Y-%m', ${column}) = ?2`;

  const userFilter = actor.role === 'Administrator' ? '1=1'
    : actor.role === 'Manager' ? 'u.teamId = ?1'
    : 'u.email = ?1';
  // Always bind both positions, even when ?1 goes unused (Administrator) — keeps ?2
  // (period) at a fixed position regardless of role, instead of the index shifting.
  const scopeBind = actor.role === 'Manager' ? (actor.teamId || '') : actor.email;

  const sql = `
    SELECT u.email, u.name, u.role, u.teamId,
      (SELECT COUNT(*) FROM contacts c WHERE c.createdByEmail = u.email AND ${dateFilter('c.createdAt')}) leadsAdded,
      (SELECT COUNT(*) FROM contacts c WHERE c.ownerEmail = u.email AND c.convertedAt IS NOT NULL AND ${dateFilter('c.convertedAt')}) leadsConverted,
      (SELECT COALESCE(SUM(l.count), 0) FROM user_activity_log l WHERE l.email = u.email AND ${dateFilter('l.createdAt')}) messagesSent,
      (SELECT COUNT(*) FROM conversation_assignments ca WHERE ca.assignedUserEmail = u.email) conversationsAssigned
    FROM users u
    WHERE ${userFilter}
    ORDER BY u.name COLLATE NOCASE
  `;
  const result = await env.DB.prepare(sql).bind(scopeBind, period).all();

  const since = await env.DB.prepare("SELECT MIN(createdAt) earliest FROM user_activity_log").first();
  return json({ rows: result.results || [], messagesSentTrackedSince: since?.earliest || null });
}

// ── Reports → WhatsApp Number Activity ──
// Chatwoot's own /reports endpoint 404s on this account (not available on this
// plan/version), so "Sent" is built from Whizz's own user_activity_log instead — real,
// but only complete from the moment this logging shipped (same caveat as Team Activity).
// "Replies" (customer-initiated conversations) comes from Meta's own Graph API
// Conversation Analytics, queried per WABA and split back out by phone number — this is
// a genuinely different, coarser concept than a message count (it counts 24-hour
// conversation windows the customer opened, not individual replies), and hasn't been
// verified against this account's live data, so it's clearly labeled as such and fails
// per-inbox (not the whole report) if Meta rejects the call.
function mondayOf(date) {
  const d = new Date(date);
  const dayIndex = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - dayIndex);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}
function toMetaPhone(phone) { return String(phone || '').replace(/[^\d]/g, '').replace(/^0+/, ''); }

async function fetchReplyAnalyticsForWaba(accessToken, wabaId, phoneDigitsList, sinceUnix, untilUnix) {
  const fields = `conversation_analytics.start(${sinceUnix}).end(${untilUnix}).granularity(DAILY).phone_numbers(${JSON.stringify(phoneDigitsList)}).dimensions(${JSON.stringify(['phone', 'conversation_direction'])})`;
  const path = `/${wabaId}?fields=${encodeURIComponent(fields)}`;
  const data = await graphFetch(accessToken, path);
  const points = data?.conversation_analytics?.data?.[0]?.data_points || [];
  // byPhone[phoneDigits][weekStart] = replyCount
  const byPhone = {};
  for (const p of points) {
    const direction = String(p.conversation_direction || '').toUpperCase();
    if (direction !== 'USER_INITIATED') continue;
    const phone = String(p.phone_number || p.phone || '').replace(/[^\d]/g, '');
    if (!phone) continue;
    const week = mondayOf((p.start || p.end) * 1000);
    byPhone[phone] = byPhone[phone] || {};
    byPhone[phone][week] = (byPhone[phone][week] || 0) + (Number(p.conversation) || 0);
  }
  return byPhone;
}

export async function handleInboxActivityReport(request, env) {
  const email = (request.headers.get('Cf-Access-Authenticated-User-Email') || '').trim().toLowerCase();
  const actor = email ? await env.DB.prepare('SELECT email,role FROM users WHERE email=?').bind(email).first() : null;
  if (!actor) return json({ error: 'Authenticated user is not provisioned in Whizz.' }, 403);
  if (actor.role === 'Sales') return json({ error: 'Manager or Administrator access required.' }, 403);

  const url = new URL(request.url);
  const period = (url.searchParams.get('period') || 'all').trim();
  const isMonth = /^\d{4}-\d{2}$/.test(period);

  const sentSql = `
    SELECT inboxId,
      date(createdAt, '-' || ((CAST(strftime('%w', createdAt) AS INTEGER) + 6) % 7) || ' days') weekStart,
      SUM(count) sent
    FROM user_activity_log
    WHERE inboxId <> '' AND ${isMonth ? "strftime('%Y-%m', createdAt) = ?1" : "createdAt >= datetime('now', '-84 days')"}
    GROUP BY inboxId, weekStart
    ORDER BY inboxId, weekStart
  `;
  const sentStmt = env.DB.prepare(sentSql);
  const sentResult = isMonth ? await sentStmt.bind(period).all() : await sentStmt.all();

  const inboxesResult = await env.DB.prepare("SELECT inboxId,label,phoneNumber,wabaId FROM chatwoot_inboxes WHERE inboxId<>''").all();
  const inboxRows = inboxesResult.results || [];
  const inboxMeta = new Map(inboxRows.map(ib => [ib.inboxId, ib]));

  const sentByInbox = new Map();
  for (const row of (sentResult.results || [])) {
    if (!sentByInbox.has(row.inboxId)) sentByInbox.set(row.inboxId, new Map());
    sentByInbox.get(row.inboxId).set(row.weekStart, row.sent);
  }

  let sinceUnix, untilUnix;
  if (isMonth) {
    const [y, m] = period.split('-').map(Number);
    sinceUnix = Math.floor(Date.UTC(y, m - 1, 1) / 1000);
    untilUnix = Math.floor(Date.UTC(y, m, 1) / 1000);
  } else {
    untilUnix = Math.floor(Date.now() / 1000);
    sinceUnix = untilUnix - 84 * 86400;
  }

  const accessToken = await loadMetaAccessToken(env);
  const replyErrorsByWaba = new Map();
  const repliesByPhone = {};
  if (accessToken) {
    const byWaba = new Map();
    for (const ib of inboxRows) {
      if (!ib.wabaId || !ib.phoneNumber) continue;
      if (!byWaba.has(ib.wabaId)) byWaba.set(ib.wabaId, []);
      byWaba.get(ib.wabaId).push(toMetaPhone(ib.phoneNumber));
    }
    await Promise.all([...byWaba.entries()].map(async ([wabaId, phones]) => {
      try {
        const byPhone = await fetchReplyAnalyticsForWaba(accessToken, wabaId, phones, sinceUnix, untilUnix);
        Object.assign(repliesByPhone, byPhone);
      } catch (error) { replyErrorsByWaba.set(wabaId, error.message); }
    }));
  }

  const allWeeks = new Set();
  for (const weekMap of sentByInbox.values()) for (const w of weekMap.keys()) allWeeks.add(w);
  for (const phoneWeeks of Object.values(repliesByPhone)) for (const w of Object.keys(phoneWeeks)) allWeeks.add(w);
  const weekList = [...allWeeks].sort();

  const inboxes = inboxRows.map(ib => {
    const sentWeeks = sentByInbox.get(ib.inboxId) || new Map();
    const phoneDigits = toMetaPhone(ib.phoneNumber);
    const replyWeeks = repliesByPhone[phoneDigits] || null;
    const repliesError = !accessToken ? 'Meta WhatsApp isn’t connected — add an access token under Integrations to see replies.'
      : ib.wabaId ? (replyErrorsByWaba.get(ib.wabaId) || null)
      : 'No WABA ID set for this inbox — add one under Integrations → Chatwoot.';
    const weeks = weekList
      .filter(w => sentWeeks.has(w) || (replyWeeks && replyWeeks[w] !== undefined))
      .map(w => ({ weekStart: w, sent: sentWeeks.get(w) || 0, replies: replyWeeks ? (replyWeeks[w] || 0) : null }));
    return { inboxId: ib.inboxId, label: ib.label, phoneNumber: ib.phoneNumber, weeks, repliesError };
  });

  const since = await env.DB.prepare("SELECT MIN(createdAt) earliest FROM user_activity_log WHERE inboxId <> ''").first();
  return json({ inboxes, sentTrackedSince: since?.earliest || null });
}
