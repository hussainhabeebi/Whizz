import { readSheet } from '../lib/googleSheets.js';

// Port of the n8n "whizz-get-contacts" workflow: read the Contacts sheet,
// filter by platform/country/brand, return the same shape the frontend expects.
export async function handleGetContacts(request, env) {
  const url = new URL(request.url);
  const platform = url.searchParams.get('platform') || '';
  const country = url.searchParams.get('country') || '';
  const brand = url.searchParams.get('brand') || '';

  const rows = await readSheet(env, 'Contacts');

  const filtered = rows.filter(r => {
    const matchPlatform = !platform || (r.platform || '').toLowerCase() === platform.toLowerCase();
    const matchCountry = !country || (r.country || '').toLowerCase() === country.toLowerCase();
    const matchBrand = !brand || (r.brand || '').toLowerCase() === brand.toLowerCase();
    return matchPlatform && matchCountry && matchBrand;
  });

  const contacts = filtered.map(r => ({
    id: String(r.row_number || r.id || ''),
    contactName: r.contactName || r.name || '',
    company: r.company || '',
    phone: r.phone || r.whatsapp || r['WhatsApp'] || r.mobile || '',
    email: r.email || '',
    category: r.category || '',
    source: r.source || '',
    platform: r.platform || '',
    country: r.country || '',
    brand: r.brand || '',
    productInterest: r.productInterest || r['Product Interest'] || '',
  }));

  return Response.json({ contacts });
}
