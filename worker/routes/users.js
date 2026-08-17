const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const ROLES = new Set(['Administrator', 'Manager', 'Sales']);
let supportTablesReady;

function json(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS }); }
function emailFromAccess(request) { return (request.headers.get('Cf-Access-Authenticated-User-Email') || '').trim().toLowerCase(); }
async function ensureSupportTables(env) {
  if (!supportTablesReady) {
    supportTablesReady = env.DB.batch([
      env.DB.prepare('CREATE TABLE IF NOT EXISTS user_access_state (email TEXT PRIMARY KEY, resetAt INTEGER NOT NULL DEFAULT 0)'),
      env.DB.prepare('CREATE TABLE IF NOT EXISTS access_user_policies (email TEXT PRIMARY KEY, policyId TEXT NOT NULL, createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)')
    ]).catch(error => { supportTablesReady = null; throw error; });
  }
  await supportTablesReady;
}
function normalizeRow(row) {
  let allowedBrands = [], allowedPlatforms = [];
  try { allowedBrands = JSON.parse(row.allowedBrands || '[]'); } catch (_) {}
  try { allowedPlatforms = JSON.parse(row.allowedPlatforms || '[]'); } catch (_) {}
  return { email: row.email, name: row.name, role: row.role, teamId: row.teamId || 'sales', allowedBrands, allowedPlatforms, resetAt: row.resetAt || 0, accessPolicySynced: !!row.policyId };
}
async function actorFor(request, env) {
  await ensureSupportTables(env);
  const email = emailFromAccess(request);
  return email ? env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first() : null;
}
async function requireAdmin(request, env) {
  const actor = await actorFor(request, env);
  return actor && actor.role === 'Administrator' ? actor : null;
}
function accessConfig(env) {
  if (!env.CF_ACCESS_API_TOKEN || !env.CF_ACCOUNT_ID || !env.CF_ACCESS_APP_ID) return null;
  return { token: env.CF_ACCESS_API_TOKEN, accountId: env.CF_ACCOUNT_ID, appId: env.CF_ACCESS_APP_ID };
}
async function cloudflareRequest(env, path, options = {}) {
  const config = accessConfig(env);
  if (!config) return { configured: false };
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${config.accountId}/access/apps/${config.appId}${path}`, {
    ...options,
    headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json', ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) {
    const message = data.errors?.map(error => error.message).join(', ') || `Cloudflare Access API failed (${response.status})`;
    throw new Error(message);
  }
  return { configured: true, result: data.result };
}
async function syncAccessPolicy(env, email) {
  const existing = await env.DB.prepare('SELECT policyId FROM access_user_policies WHERE email=?').bind(email).first();
  if (existing?.policyId) return { synced: true, policyId: existing.policyId, existing: true };
  const response = await cloudflareRequest(env, '/policies', {
    method: 'POST',
    body: JSON.stringify({ name: `Whizz user: ${email}`, decision: 'allow', precedence: 1, include: [{ email: { email } }] })
  });
  if (!response.configured) return { synced: false, reason: 'Cloudflare Access automation is not configured.' };
  const policyId = response.result?.id;
  if (!policyId) throw new Error('Cloudflare created the policy without returning its ID.');
  await env.DB.prepare('INSERT OR REPLACE INTO access_user_policies (email,policyId) VALUES (?,?)').bind(email, policyId).run();
  return { synced: true, policyId };
}
async function removeAccessPolicy(env, email) {
  const existing = await env.DB.prepare('SELECT policyId FROM access_user_policies WHERE email=?').bind(email).first();
  if (!existing?.policyId) return { synced: false, reason: 'No managed Access policy was recorded.' };
  const response = await cloudflareRequest(env, `/policies/${encodeURIComponent(existing.policyId)}`, { method: 'DELETE' });
  if (!response.configured) return { synced: false, reason: 'Cloudflare Access automation is not configured.' };
  await env.DB.prepare('DELETE FROM access_user_policies WHERE email=?').bind(email).run();
  return { synced: true };
}

export async function handleUsers(request, env) {
  const actor = await actorFor(request, env);
  if (!actor) return json({ error: 'User is not provisioned in Whizz.' }, 403);
  const baseQuery = `SELECT u.*, COALESCE(s.resetAt,0) resetAt, p.policyId FROM users u
    LEFT JOIN user_access_state s ON s.email=u.email LEFT JOIN access_user_policies p ON p.email=u.email`;
  if (actor.role === 'Administrator') {
    const result = await env.DB.prepare(baseQuery + ' ORDER BY u.name COLLATE NOCASE').all();
    return json({ users: (result.results || []).map(normalizeRow), accessAutomationConfigured: !!accessConfig(env) });
  }
  const row = await env.DB.prepare(baseQuery + ' WHERE u.email=?').bind(actor.email).first();
  return json({ users: row ? [normalizeRow(row)] : [], accessAutomationConfigured: !!accessConfig(env) });
}

export async function handleCreateUser(request, env) {
  if (!await requireAdmin(request, env)) return json({ error: 'Administrator access required.' }, 403);
  const body = await request.json();
  const email = String(body.email || '').trim().toLowerCase(), name = String(body.name || '').trim(), role = String(body.role || 'Sales');
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'A valid name and email are required.' }, 400);
  if (!ROLES.has(role)) return json({ error: 'Invalid role.' }, 400);
  try {
    await env.DB.prepare('INSERT INTO users (email,name,role,teamId,allowedBrands,allowedPlatforms) VALUES (?,?,?,?,?,?)')
      .bind(email, name, role, String(body.teamId || 'sales').trim().toLowerCase(), JSON.stringify(body.allowedBrands || []), JSON.stringify(body.allowedPlatforms || [])).run();
  } catch (error) {
    if (String(error.message).toLowerCase().includes('unique')) return json({ error: 'A user with this email already exists.' }, 409);
    throw error;
  }
  let access;
  try { access = await syncAccessPolicy(env, email); } catch (error) { access = { synced: false, reason: error.message }; }
  return json({ user: { email, name, role, teamId: String(body.teamId || 'sales').trim().toLowerCase(), allowedBrands: body.allowedBrands || [], allowedPlatforms: body.allowedPlatforms || [], resetAt: 0, accessPolicySynced: !!access.synced }, access }, 201);
}

export async function handleUpdateUser(request, env, email) {
  if (!await requireAdmin(request, env)) return json({ error: 'Administrator access required.' }, 403);
  const body = await request.json();
  const name = String(body.name || '').trim(), role = String(body.role || 'Sales');
  if (!name || !ROLES.has(role)) return json({ error: 'Valid name and role are required.' }, 400);
  const result = await env.DB.prepare('UPDATE users SET name=?,role=?,teamId=?,allowedBrands=?,allowedPlatforms=? WHERE email=?')
    .bind(name, role, String(body.teamId || 'sales').trim().toLowerCase(), JSON.stringify(body.allowedBrands || []), JSON.stringify(body.allowedPlatforms || []), email).run();
  return result.meta.changes ? json({ success: true }) : json({ error: 'User not found.' }, 404);
}

export async function handleDeleteUser(request, env, email) {
  const actor = await requireAdmin(request, env);
  if (!actor) return json({ error: 'Administrator access required.' }, 403);
  if (actor.email === email) return json({ error: 'You cannot delete your own account.' }, 400);
  let access;
  try { access = await removeAccessPolicy(env, email); } catch (error) { access = { synced: false, reason: error.message }; }
  await env.DB.batch([
    env.DB.prepare('DELETE FROM access_user_policies WHERE email=?').bind(email),
    env.DB.prepare('DELETE FROM user_access_state WHERE email=?').bind(email),
    env.DB.prepare('DELETE FROM users WHERE email=?').bind(email)
  ]);
  return json({ success: true, access });
}

export async function handleResetUserAccess(request, env, email) {
  const actor = await requireAdmin(request, env);
  if (!actor) return json({ error: 'Administrator access required.' }, 403);
  if (actor.email === email) return json({ error: 'Use Logout to reset your own sign-in.' }, 400);
  const user = await env.DB.prepare('SELECT email FROM users WHERE email=?').bind(email).first();
  if (!user) return json({ error: 'User not found.' }, 404);
  const resetAt = Date.now();
  await env.DB.prepare('INSERT INTO user_access_state (email,resetAt) VALUES (?,?) ON CONFLICT(email) DO UPDATE SET resetAt=excluded.resetAt').bind(email, resetAt).run();
  return json({ success: true, resetAt });
}

export async function handleSyncUserAccess(request, env, email) {
  if (!await requireAdmin(request, env)) return json({ error: 'Administrator access required.' }, 403);
  const user = await env.DB.prepare('SELECT email FROM users WHERE email=?').bind(email).first();
  if (!user) return json({ error: 'User not found.' }, 404);
  try {
    const access = await syncAccessPolicy(env, email);
    return access.synced ? json({ success: true, access }) : json({ error: access.reason }, 503);
  } catch (error) { return json({ error: error.message }, 502); }
}
