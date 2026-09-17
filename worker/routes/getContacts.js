// Port of the n8n "whizz-get-contacts" workflow: read the Contacts table,
// filter by platform/country/brand, return the same shape the frontend expects.
export async function handleGetContacts(request, env) {
  const email = (request.headers.get('Cf-Access-Authenticated-User-Email') || '').trim().toLowerCase();
  const actor = email ? await env.DB.prepare('SELECT email,role,teamId FROM users WHERE email=?').bind(email).first() : null;
  if (!actor) return Response.json({ error: 'Authenticated user is not provisioned in Whizz.' }, { status: 403 });
  const url = new URL(request.url);
  const platform = url.searchParams.get('platform') || '';
  const country = url.searchParams.get('country') || '';
  const brand = url.searchParams.get('brand') || '';

  const ownership = actor.role === 'Administrator' ? '(?4 IS NOT NULL)'
    : actor.role === 'Manager' ? '(ownerEmail IS NULL OR teamId = ?4)'
    : 'ownerEmail = ?4';
  // brand can be a comma-separated list on a single contact (e.g. an exhibitor carrying
  // several brands), so match ?3 as one item in that list rather than requiring an exact
  // equal string — otherwise picking any brand but the first from a multi-brand contact
  // would never match.
  const { results } = await env.DB.prepare(
    `SELECT * FROM contacts
     WHERE (?1 = '' OR LOWER(platform) = LOWER(?1))
       AND (?2 = '' OR LOWER(country) = LOWER(?2))
       AND (?3 = '' OR (',' || REPLACE(LOWER(brand), ', ', ',') || ',') LIKE ('%,' || LOWER(?3) || ',%'))
       AND ${ownership}
     ORDER BY createdAt DESC, id DESC`
  ).bind(platform, country, brand, actor.role === 'Sales' ? actor.email : (actor.teamId || '')).all();

  const contacts = results.map(r => ({
    id: String(r.id),
    contactName: r.contactName || '',
    company: r.company || '',
    phone: r.phone || '',
    email: r.email || '',
    category: r.category || '',
    source: r.source || '',
    platform: r.platform || '',
    country: r.country || '',
    brand: r.brand || '',
    productInterest: r.productInterest || '',
    ownerEmail: r.ownerEmail || '', teamId: r.teamId || '', createdByEmail: r.createdByEmail || '',
    createdAt: r.createdAt || '', updatedAt: r.updatedAt || '', lastContactedAt: r.lastContactedAt || '',
    nextFollowUpAt: r.nextFollowUpAt || '', dealExpectedAt: r.dealExpectedAt || '', leadScore: Number(r.leadScore || 0),
    telegramChatId: r.telegramChatId || '', telegramUsername: r.telegramUsername || '',
    convertedAt: r.convertedAt || '',
    website: r.website || '', address: r.address || '', rating: Number(r.rating || 0),
    mapsUrl: r.mapsUrl || '', sourceId: r.sourceId || '', linkedin: r.linkedin || '',
    whatsapp: r.whatsapp || '',
  }));

  return Response.json({ contacts }, { headers: { 'cache-control': 'no-store' } });
}
