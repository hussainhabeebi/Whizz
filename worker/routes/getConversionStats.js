export async function handleGetConversionStats(request, env) {
  const email = (request.headers.get('Cf-Access-Authenticated-User-Email') || '').trim().toLowerCase();
  const actor = email ? await env.DB.prepare('SELECT email,role,teamId FROM users WHERE email=?').bind(email).first() : null;
  if (!actor) return Response.json({ error: 'Authenticated user is not provisioned in Whizz.' }, { status: 403 });

  const ownership = actor.role === 'Administrator' ? '1=1'
    : actor.role === 'Manager' ? '(ownerEmail IS NULL OR teamId = ?1)'
    : 'ownerEmail = ?1';
  const bind = actor.role === 'Sales' ? actor.email : (actor.teamId || '');

  const [totals, byPlatform, byBrand, byCountry] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) total, SUM(CASE WHEN convertedAt IS NOT NULL THEN 1 ELSE 0 END) converted FROM contacts WHERE ${ownership}`).bind(bind).first(),
    env.DB.prepare(`SELECT platform, COUNT(*) total, SUM(CASE WHEN convertedAt IS NOT NULL THEN 1 ELSE 0 END) converted FROM contacts WHERE ${ownership} AND platform != '' GROUP BY platform ORDER BY total DESC`).bind(bind).all(),
    env.DB.prepare(`SELECT brand, COUNT(*) total, SUM(CASE WHEN convertedAt IS NOT NULL THEN 1 ELSE 0 END) converted FROM contacts WHERE ${ownership} AND brand != '' GROUP BY brand ORDER BY total DESC`).bind(bind).all(),
    env.DB.prepare(`SELECT country, COUNT(*) total, SUM(CASE WHEN convertedAt IS NOT NULL THEN 1 ELSE 0 END) converted FROM contacts WHERE ${ownership} AND country != '' GROUP BY country ORDER BY total DESC`).bind(bind).all(),
  ]);

  return Response.json({
    total: totals?.total || 0,
    converted: totals?.converted || 0,
    byPlatform: byPlatform.results || [],
    byBrand: byBrand.results || [],
    byCountry: byCountry.results || [],
  });
}
