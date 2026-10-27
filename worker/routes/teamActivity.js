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
export async function logUserActivity(env, email, action, count = 1) {
  if (!email || count <= 0) return;
  try {
    await env.DB.prepare('INSERT INTO user_activity_log (email,action,count) VALUES (?,?,?)').bind(email, action, count).run();
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
