// ── Country → template-language mapping ──
// Purely admin-defined (no seeded defaults — guessing a country's marketing language
// would be exactly the kind of silent assumption this app avoids elsewhere). Powers
// campaignSend.js's optional per-contact template-language auto-pick for bulk campaigns:
// when a template has multiple approved language variants, a contact's country can be
// mapped here to pick the right one instead of sending everyone the same language.
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
function json(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS }); }

async function currentUser(request, env) {
  const email = (request.headers.get('Cf-Access-Authenticated-User-Email') || '').trim().toLowerCase();
  return email ? env.DB.prepare('SELECT email,role FROM users WHERE email=?').bind(email).first() : null;
}

export async function handleListCountryLanguageMap(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'User is not provisioned in Whizz.' }, 403);
  const result = await env.DB.prepare('SELECT country,language FROM country_language_map ORDER BY country COLLATE NOCASE').all();
  return json({ map: result.results || [] });
}

export async function handleSetCountryLanguageMap(request, env) {
  const user = await currentUser(request, env);
  if (!user || user.role !== 'Administrator') return json({ error: 'Administrator access required.' }, 403);
  const body = await request.json().catch(() => ({}));
  const country = String(body.country || '').trim();
  const language = String(body.language || '').trim();
  if (!country || !language) return json({ error: 'Both a country and a language code are required.' }, 400);
  await env.DB.prepare('INSERT INTO country_language_map (country,language) VALUES (?,?) ON CONFLICT(country) DO UPDATE SET language=excluded.language')
    .bind(country, language).run();
  return json({ success: true });
}

export async function handleDeleteCountryLanguageMap(request, env, country) {
  const user = await currentUser(request, env);
  if (!user || user.role !== 'Administrator') return json({ error: 'Administrator access required.' }, 403);
  await env.DB.prepare('DELETE FROM country_language_map WHERE country=?').bind(decodeURIComponent(country)).run();
  return json({ success: true });
}
