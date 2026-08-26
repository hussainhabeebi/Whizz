export async function handleMarkConversion(request, env) {
  const email = (request.headers.get('Cf-Access-Authenticated-User-Email') || '').trim().toLowerCase();
  const actor = email ? await env.DB.prepare('SELECT email,role,teamId FROM users WHERE email=?').bind(email).first() : null;
  if (!actor) return Response.json({ error: 'Authenticated user is not provisioned in Whizz.' }, { status: 403 });

  const body = await request.json().catch(() => ({}));
  const id = Number(body.id);
  if (!id) return Response.json({ error: 'Contact id is required.' }, { status: 400 });

  const converted = !!body.converted;
  const convertedAt = converted ? (body.convertedAt || new Date().toISOString()) : null;

  const ownership = actor.role === 'Administrator' ? '1=1'
    : actor.role === 'Manager' ? '(ownerEmail IS NULL OR teamId = ?3)'
    : 'ownerEmail = ?3';

  const stmt = env.DB.prepare(
    `UPDATE contacts SET convertedAt=?1, updatedAt=CURRENT_TIMESTAMP WHERE id=?2 AND ${ownership}`
  );
  const result = await (actor.role === 'Administrator'
    ? stmt.bind(convertedAt, id)
    : stmt.bind(convertedAt, id, actor.role === 'Sales' ? actor.email : (actor.teamId || ''))
  ).run();

  if (!result.meta.changes) return Response.json({ error: 'Contact not found or access denied.' }, { status: 404 });
  return Response.json({ success: true, convertedAt });
}
