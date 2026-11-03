export async function handleDeleteContact(request, env) {
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

  const stmt = env.DB.prepare(`DELETE FROM contacts WHERE id=? AND ${ownership}`);
  const result = await (actor.role === 'Administrator'
    ? stmt.bind(id)
    : stmt.bind(id, ownerParam)
  ).run();

  if (!result.meta.changes) return Response.json({ error: 'Contact not found or access denied.' }, { status: 404 });
  return Response.json({ success: true });
}

const BULK_DELETE_CAP = 1000;

export async function handleBulkDeleteContacts(request, env) {
  const email = (request.headers.get('Cf-Access-Authenticated-User-Email') || '').trim().toLowerCase();
  const actor = email ? await env.DB.prepare('SELECT email,role,teamId FROM users WHERE email=?').bind(email).first() : null;
  if (!actor) return Response.json({ error: 'Authenticated user is not provisioned in Whizz.' }, { status: 403 });

  const body = await request.json().catch(() => ({}));
  const ids = Array.isArray(body.ids) ? [...new Set(body.ids.map(id => Number(id)).filter(Boolean))] : [];
  if (!ids.length) return Response.json({ error: 'At least one contact id is required.' }, { status: 400 });
  const capped = ids.slice(0, BULK_DELETE_CAP);

  const ownership = actor.role === 'Administrator' ? '1=1'
    : actor.role === 'Manager' ? '(ownerEmail IS NULL OR teamId = ?)'
    : 'ownerEmail = ?';
  const placeholders = capped.map(() => '?').join(',');
  const bindArgs = actor.role === 'Administrator' ? capped : [...capped, actor.role === 'Sales' ? actor.email : (actor.teamId || '')];

  const result = await env.DB.prepare(`DELETE FROM contacts WHERE id IN (${placeholders}) AND ${ownership}`).bind(...bindArgs).run();

  return Response.json({ success: true, requested: ids.length, deleted: result.meta.changes || 0 });
}
