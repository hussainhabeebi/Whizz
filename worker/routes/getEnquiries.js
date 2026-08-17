// Port of the n8n "whizz-get-enquiries" workflow's "Parse & Format" code node, verbatim
// logic — only the source of rows changed (D1 `memory` table instead of the Sheets "Memory"
// tab). See that workflow's comments for why this collapses multiple rows per phone number
// and only surfaces enquiries with a confirmed product match.

const CALLING_CODES = [
  ['971', 'United Arab Emirates'], ['966', 'Saudi Arabia'], ['968', 'Oman'],
  ['973', 'Bahrain'], ['974', 'Qatar'], ['965', 'Kuwait'], ['962', 'Jordan'],
  ['961', 'Lebanon'], ['92', 'Pakistan'], ['91', 'India'], ['880', 'Bangladesh'],
  ['94', 'Sri Lanka'], ['20', 'Egypt'], ['234', 'Nigeria'], ['254', 'Kenya'],
  ['27', 'South Africa'], ['1', 'United States / Canada'], ['44', 'United Kingdom'],
  ['86', 'China'], ['852', 'Hong Kong'], ['65', 'Singapore'], ['55', 'Brazil'],
  ['52', 'Mexico'], ['62', 'Indonesia'], ['60', 'Malaysia'], ['63', 'Philippines'],
  ['84', 'Vietnam'], ['98', 'Iran'], ['90', 'Turkey'], ['61', 'Australia'],
  ['64', 'New Zealand'], ['81', 'Japan'], ['82', 'South Korea'], ['49', 'Germany'],
  ['33', 'France'], ['39', 'Italy'], ['34', 'Spain'], ['31', 'Netherlands'], ['7', 'Russia / Kazakhstan'],
].sort((a, b) => b[0].length - a[0].length);

function countryFromPhone(phone) {
  const digits = (phone || '').replace(/\D/g, '');
  const hit = CALLING_CODES.find(([code]) => digits.startsWith(code));
  return hit ? hit[1] : '';
}

function productInterestsFromHistory(history) {
  if (!history) return [];
  const found = [];
  const seen = new Set();
  const addMatch = (raw) => {
    const val = raw.trim();
    const key = val.toLowerCase();
    if (val && !seen.has(key)) { seen.add(key); found.push(val); }
  };
  const patterns = [
    /we have the ([^\n.!]+?) in stock/gi,
    /we have (?:several|some|many|a few) ([^\n.!]+?) (?:items?|units?) in stock/gi,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(history)) !== null) addMatch(m[1]);
  }
  return found;
}

export async function handleGetEnquiries(request, env) {
  const email = (request.headers.get('Cf-Access-Authenticated-User-Email') || '').trim().toLowerCase();
  const actor = email ? await env.DB.prepare('SELECT role FROM users WHERE email=?').bind(email).first() : null;
  if (!actor) return Response.json({ error: 'Authenticated user is not provisioned in Whizz.' }, { status: 403 });
  if (actor.role === 'Sales') {
    return Response.json({ error: 'Sales users receive enquiries only through their assigned conversations.' }, { status: 403 });
  }
  const { results } = await env.DB.prepare('SELECT id, phone, name, history FROM memory').all();

  const byPhone = {};
  for (const r of results) {
    const phone = String(r.phone || '').trim();
    if (!phone) continue;
    const history = String(r.history || '');
    const rowNumber = Number(r.id || 0);
    const existing = byPhone[phone];
    if (!existing) {
      byPhone[phone] = { phone, name: r.name || '', history, rowNumber };
    } else {
      if (history.length > existing.history.length) existing.history = history;
      if (!existing.name && r.name) existing.name = r.name;
      if (rowNumber > existing.rowNumber) existing.rowNumber = rowNumber;
    }
  }

  const enquiries = Object.values(byPhone)
    .map(e => ({
      name: e.name || 'Unknown',
      products: productInterestsFromHistory(e.history),
      country: countryFromPhone(e.phone) || '—',
      phone: e.phone.startsWith('+') ? e.phone : '+' + e.phone,
      rowNumber: e.rowNumber,
    }))
    .filter(e => e.products.length > 0)
    .sort((a, b) => b.rowNumber - a.rowNumber)
    .map(e => ({ name: e.name, productInterest: e.products.join(', '), country: e.country, phone: e.phone }));

  return Response.json({ enquiries });
}
