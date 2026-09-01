export async function handleUpdateContact(request, env) {
  const email = (request.headers.get('Cf-Access-Authenticated-User-Email') || '').trim().toLowerCase();
  const actor = email ? await env.DB.prepare('SELECT email,role,teamId FROM users WHERE email=?').bind(email).first() : null;
  if (!actor) return Response.json({ error: 'Authenticated user is not provisioned in Whizz.' }, { status: 403 });

  const body = await request.json().catch(() => ({}));
  const id = Number(body.id);
  if (!id) return Response.json({ error: 'Contact id is required.' }, { status: 400 });

  const ownership = actor.role === 'Administrator' ? '1=1'
    : actor.role === 'Manager' ? '(ownerEmail IS NULL OR teamId = ?)'
    : 'ownerEmail = ?';
  const ownerParam = actor.role === 'Sales' ? actor.email : (actor.teamId || '');

  const stmt = env.DB.prepare(
    `UPDATE contacts SET
      contactName=?, company=?, phone=?, email=?, category=?, source=?,
      platform=?, country=?, brand=?, productInterest=?, updatedAt=CURRENT_TIMESTAMP
     WHERE id=? AND ${ownership}`
  );

  const binds = [
    String(body.contactName || ''),
    String(body.company || body.contactName || ''),
    String(body.phone || ''),
    String(body.email || '').toLowerCase(),
    String(body.category || ''),
    String(body.source || ''),
    String(body.platform || ''),
    String(body.country || ''),
    String(body.brand || ''),
    String(body.productInterest || ''),
    id,
  ];
  if (actor.role !== 'Administrator') binds.push(ownerParam);

  const result = await stmt.bind(...binds).run();
  if (!result.meta.changes) return Response.json({ error: 'Contact not found or access denied.' }, { status: 404 });
  return Response.json({ success: true });
}
