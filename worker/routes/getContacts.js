// Port of the n8n "whizz-get-contacts" workflow: read the Contacts table,
// filter by platform/country/brand, return the same shape the frontend expects.
export async function handleGetContacts(request, env) {
  const url = new URL(request.url);
  const platform = url.searchParams.get('platform') || '';
  const country = url.searchParams.get('country') || '';
  const brand = url.searchParams.get('brand') || '';

  const { results } = await env.DB.prepare(
    `SELECT * FROM contacts
     WHERE (?1 = '' OR LOWER(platform) = LOWER(?1))
       AND (?2 = '' OR LOWER(country) = LOWER(?2))
       AND (?3 = '' OR LOWER(brand) = LOWER(?3))`
  ).bind(platform, country, brand).all();

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
  }));

  return Response.json({ contacts });
}
