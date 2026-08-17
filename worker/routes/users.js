const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const ROLES = new Set(['Administrator', 'Manager', 'Sales']);

function json(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS }); }
function emailFromAccess(request) { return (request.headers.get('Cf-Access-Authenticated-User-Email') || '').trim().toLowerCase(); }
function normalizeRow(row) {
  let allowedBrands = [], allowedPlatforms = [];
  try { allowedBrands = JSON.parse(row.allowedBrands || '[]'); } catch (_) {}
  try { allowedPlatforms = JSON.parse(row.allowedPlatforms || '[]'); } catch (_) {}
  return { email: row.email, name: row.name, role: row.role, allowedBrands, allowedPlatforms, resetAt: row.resetAt || 0 };
}
async function actorFor(request, env) {
  const email = emailFromAccess(request);
  return email ? env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first() : null;
}
async function requireAdmin(request, env) {
  const actor = await actorFor(request, env);
  return actor && actor.role === 'Administrator' ? actor : null;
}

export async function handleUsers(request, env) {
  const actor = await actorFor(request, env);
  if (!actor) return json({ error: 'User is not provisioned in Whizz.' }, 403);
  if (actor.role === 'Administrator') {
    const result = await env.DB.prepare('SELECT * FROM users ORDER BY name COLLATE NOCASE').all();
    return json({ users: (result.results || []).map(normalizeRow) });
  }
  return json({ users: [normalizeRow(actor)] });
}

export async function handleCreateUser(request, env) {
  if (!await requireAdmin(request, env)) return json({ error: 'Administrator access required.' }, 403);
  const body = await request.json();
  const email = String(body.email || '').trim().toLowerCase();
  const name = String(body.name || '').trim();
  const role = String(body.role || 'Sales');
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'A valid name and email are required.' }, 400);
  if (!ROLES.has(role)) return json({ error: 'Invalid role.' }, 400);
  try {
    await env.DB.prepare('INSERT INTO users (email,name,role,allowedBrands,allowedPlatforms,updatedAt) VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)')
      .bind(email, name, role, JSON.stringify(body.allowedBrands || []), JSON.stringify(body.allowedPlatforms || [])).run();
  } catch (error) {
    if (String(error.message).toLowerCase().includes('unique')) return json({ error: 'A user with this email already exists.' }, 409);
    throw error;
  }
  return json({ user: { email, name, role, allowedBrands: body.allowedBrands || [], allowedPlatforms: body.allowedPlatforms || [], resetAt: 0 } }, 201);
}

export async function handleUpdateUser(request, env, email) {
  if (!await requireAdmin(request, env)) return json({ error: 'Administrator access required.' }, 403);
  const body = await request.json();
  const name = String(body.name || '').trim(), role = String(body.role || 'Sales');
  if (!name || !ROLES.has(role)) return json({ error: 'Valid name and role are required.' }, 400);
  const result = await env.DB.prepare('UPDATE users SET name=?,role=?,allowedBrands=?,allowedPlatforms=?,updatedAt=CURRENT_TIMESTAMP WHERE email=?')
    .bind(name, role, JSON.stringify(body.allowedBrands || []), JSON.stringify(body.allowedPlatforms || []), email).run();
  return result.meta.changes ? json({ success: true }) : json({ error: 'User not found.' }, 404);
}

export async function handleDeleteUser(request, env, email) {
  const actor = await requireAdmin(request, env);
  if (!actor) return json({ error: 'Administrator access required.' }, 403);
  if (actor.email === email) return json({ error: 'You cannot delete your own account.' }, 400);
  await env.DB.prepare('DELETE FROM users WHERE email=?').bind(email).run();
  return json({ success: true });
}

export async function handleResetUserAccess(request, env, email) {
  const actor = await requireAdmin(request, env);
  if (!actor) return json({ error: 'Administrator access required.' }, 403);
  if (actor.email === email) return json({ error: 'Use Logout to reset your own sign-in.' }, 400);
  const resetAt = Date.now();
  const result = await env.DB.prepare('UPDATE users SET resetAt=?,updatedAt=CURRENT_TIMESTAMP WHERE email=?').bind(resetAt, email).run();
  return result.meta.changes ? json({ success: true, resetAt }) : json({ error: 'User not found.' }, 404);
}
