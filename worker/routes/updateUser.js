export async function handleUpdateUser(request, env) {
  const body = await request.json().catch(() => ({}));
  const email = String(body.email || '').trim().toLowerCase();
  const name = String(body.name || '').trim();
  const role = String(body.role || 'Sales').trim();
  const allowedBrands = Array.isArray(body.allowedBrands) ? body.allowedBrands : [];
  const allowedPlatforms = Array.isArray(body.allowedPlatforms) ? body.allowedPlatforms : [];

  if (!email || !name) return Response.json({ error: 'email and name are required' }, { status: 400 });

  const result = await env.DB.prepare(
    'UPDATE users SET name = ?2, role = ?3, allowedBrands = ?4, allowedPlatforms = ?5 WHERE email = ?1'
  ).bind(email, name, role, JSON.stringify(allowedBrands), JSON.stringify(allowedPlatforms)).run();

  if (result.meta.rows_written === 0) return Response.json({ error: 'User not found' }, { status: 404 });

  return Response.json({ success: true });
}
