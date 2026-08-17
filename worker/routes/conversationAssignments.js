const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers });
const actorEmail = request => (request.headers.get('Cf-Access-Authenticated-User-Email') || '').trim().toLowerCase();

export async function handleConversationAssignment(request, env, conversationId) {
  const email = actorEmail(request);
  const actor = email ? await env.DB.prepare('SELECT email,role,teamId FROM users WHERE email=?').bind(email).first() : null;
  if (!actor) return json({ error: 'Authenticated user is not provisioned in Whizz.' }, 403);
  if (!['Administrator', 'Manager'].includes(actor.role)) return json({ error: 'Assignment control requires Manager or Administrator access.' }, 403);

  const existing = await env.DB.prepare('SELECT assignedTeamId FROM conversation_assignments WHERE conversationId=?').bind(conversationId).first();
  if (actor.role === 'Manager' && existing?.assignedTeamId && existing.assignedTeamId !== actor.teamId) {
    return json({ error: 'This conversation belongs to another team.' }, 403);
  }

  const body = await request.json().catch(() => ({}));
  const targetEmail = String(body.assignedUserEmail || '').trim().toLowerCase();
  if (!targetEmail) {
    await env.DB.prepare('DELETE FROM conversation_assignments WHERE conversationId=?').bind(conversationId).run();
    return json({ success: true, assignment: null });
  }

  const target = await env.DB.prepare('SELECT email,name,role,teamId FROM users WHERE email=?').bind(targetEmail).first();
  if (!target) return json({ error: 'Selected user was not found.' }, 404);
  if (actor.role === 'Manager' && (!actor.teamId || target.teamId !== actor.teamId)) {
    return json({ error: 'Managers can only assign conversations inside their own team.' }, 403);
  }

  await env.DB.prepare(`INSERT INTO conversation_assignments
    (conversationId,assignedUserEmail,assignedTeamId,assignedByEmail,assignedAt)
    VALUES (?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(conversationId) DO UPDATE SET
      assignedUserEmail=excluded.assignedUserEmail,
      assignedTeamId=excluded.assignedTeamId,
      assignedByEmail=excluded.assignedByEmail,
      assignedAt=CURRENT_TIMESTAMP`)
    .bind(conversationId, target.email, target.teamId || 'sales', actor.email).run();

  return json({ success: true, assignment: { userEmail: target.email, userName: target.name, teamId: target.teamId || 'sales' } });
}
