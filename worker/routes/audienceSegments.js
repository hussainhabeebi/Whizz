// ── Saved Audience Segments ──
// A named platform/brand/region/country filter combo, saved from the campaign wizard's
// Audience step so a recurring segment (e.g. "UAE Mix buyers") doesn't need rebuilding
// from scratch every campaign. Visibility follows the same ownership pattern used
// elsewhere: Administrator sees every segment, Manager sees their team's, Sales sees
// only their own.
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
function json(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS }); }

async function currentUser(request, env) {
  const email = (request.headers.get('Cf-Access-Authenticated-User-Email') || '').trim().toLowerCase();
  return email ? env.DB.prepare('SELECT email,role,teamId FROM users WHERE email=?').bind(email).first() : null;
}

function normalizeRow(row) {
  let platforms = [], brands = [];
  try { platforms = JSON.parse(row.platforms || '[]'); } catch (_) {}
  try { brands = JSON.parse(row.brands || '[]'); } catch (_) {}
  return { id: row.id, name: row.name, ownerEmail: row.ownerEmail, platforms, brands, region: row.region || 'ALL', country: row.country || 'ALL', createdAt: row.createdAt };
}

export async function handleListAudienceSegments(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'User is not provisioned in Whizz.' }, 403);
  const ownership = user.role === 'Administrator' ? '1=1'
    : user.role === 'Manager' ? 'teamId=?'
    : 'ownerEmail=?';
  const bind = user.role === 'Manager' ? (user.teamId || '') : user.email;
  const stmt = user.role === 'Administrator'
    ? env.DB.prepare(`SELECT * FROM audience_segments ORDER BY name COLLATE NOCASE`)
    : env.DB.prepare(`SELECT * FROM audience_segments WHERE ${ownership} ORDER BY name COLLATE NOCASE`).bind(bind);
  const result = await stmt.all();
  return json({ segments: (result.results || []).map(normalizeRow) });
}

export async function handleCreateAudienceSegment(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'User is not provisioned in Whizz.' }, 403);
  const body = await request.json().catch(() => ({}));
  const name = String(body.name || '').trim();
  if (!name) return json({ error: 'A name is required.' }, 400);
  const platforms = Array.isArray(body.platforms) ? body.platforms : [];
  const brands = Array.isArray(body.brands) ? body.brands : [];
  const region = String(body.region || 'ALL');
  const country = String(body.country || 'ALL');
  const result = await env.DB.prepare('INSERT INTO audience_segments (name,ownerEmail,teamId,platforms,brands,region,country) VALUES (?,?,?,?,?,?,?)')
    .bind(name, user.email, user.teamId || 'sales', JSON.stringify(platforms), JSON.stringify(brands), region, country).run();
  return json({ segment: { id: result.meta.last_row_id, name, ownerEmail: user.email, platforms, brands, region, country } }, 201);
}

export async function handleDeleteAudienceSegment(request, env, id) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'User is not provisioned in Whizz.' }, 403);
  const row = await env.DB.prepare('SELECT ownerEmail FROM audience_segments WHERE id=?').bind(id).first();
  if (!row) return json({ error: 'Segment not found.' }, 404);
  if (user.role !== 'Administrator' && row.ownerEmail !== user.email) return json({ error: 'Only the segment\'s owner or an Administrator can delete it.' }, 403);
  await env.DB.prepare('DELETE FROM audience_segments WHERE id=?').bind(id).run();
  return json({ success: true });
}
