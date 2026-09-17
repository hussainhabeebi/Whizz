// Identifies (and corrects) a contact's country from their phone number, and derives the
// sales region from that country. Calling-code lookup handles the common case for free;
// Cloudflare Workers AI (`env.AI`) is only invoked when the lookup is ambiguous (shared
// codes like +1/+7), unrecognized, or conflicts with a country already on file.

export const REGION_MAP = {
  'UAE':'Middle East','Saudi Arabia':'Middle East','Qatar':'Middle East','Kuwait':'Middle East',
  'Bahrain':'Middle East','Oman':'Middle East','Jordan':'Middle East','Lebanon':'Middle East',
  'Iraq':'Middle East','Egypt':'Middle East','Morocco':'Middle East','Libya':'Middle East',
  'Tunisia':'Middle East','Algeria':'Middle East','Yemen':'Middle East','Syria':'Middle East',
  'Israel':'Middle East','Palestine':'Middle East','Turkey':'Middle East','Middle East':'Middle East',
  'UK':'Europe','Germany':'Europe','France':'Europe','Spain':'Europe','Italy':'Europe',
  'Netherlands':'Europe','Belgium':'Europe','Poland':'Europe','Portugal':'Europe',
  'Sweden':'Europe','Norway':'Europe','Denmark':'Europe','Finland':'Europe',
  'Austria':'Europe','Switzerland':'Europe','Greece':'Europe','Romania':'Europe',
  'Czech Republic':'Europe','Hungary':'Europe','Slovakia':'Europe','Croatia':'Europe',
  'Ukraine':'Europe','Serbia':'Europe','Bulgaria':'Europe','Europe':'Europe',
  'Russia':'CIS','Kazakhstan':'CIS','Uzbekistan':'CIS','Tajikistan':'CIS',
  'Kyrgyzstan':'CIS','Turkmenistan':'CIS','Azerbaijan':'CIS','Georgia':'CIS',
  'Armenia':'CIS','Belarus':'CIS','Moldova':'CIS','CIS':'CIS',
  'India':'Asia','Pakistan':'Asia','Bangladesh':'Asia','Sri Lanka':'Asia',
  'China':'Asia','Japan':'Asia','South Korea':'Asia','Taiwan':'Asia',
  'Singapore':'Asia','Malaysia':'Asia','Thailand':'Asia','Indonesia':'Asia',
  'Philippines':'Asia','Vietnam':'Asia','Myanmar':'Asia','Cambodia':'Asia',
  'Nepal':'Asia','Afghanistan':'Asia','Southeast Asia':'Asia',
  'USA':'Americas','Canada':'Americas','Mexico':'Americas','Brazil':'Americas',
  'Colombia':'Americas','Argentina':'Americas','Chile':'Americas','Peru':'Americas',
  'North America':'Americas','Latin America':'Americas',
  'Nigeria':'Africa','Kenya':'Africa','South Africa':'Africa','Ghana':'Africa',
  'Tanzania':'Africa','Ethiopia':'Africa','Uganda':'Africa','Cameroon':'Africa',
  'Senegal':'Africa','Zimbabwe':'Africa','Zambia':'Africa','Angola':'Africa',
  'Africa':'Africa',
  'Australia':'Oceania','New Zealand':'Oceania','Oceania':'Oceania',
};

export function regionForCountry(country) { return REGION_MAP[country] || 'Other'; }

// Calling codes, longest-first so e.g. '971' is tried before a bare '9'. Names match the
// short/canonical forms used as REGION_MAP keys so region lookup works directly off them.
const CALLING_CODES = [
  ['971','UAE'], ['966','Saudi Arabia'], ['974','Qatar'], ['965','Kuwait'], ['973','Bahrain'],
  ['968','Oman'], ['962','Jordan'], ['961','Lebanon'], ['964','Iraq'], ['212','Morocco'],
  ['218','Libya'], ['216','Tunisia'], ['213','Algeria'], ['967','Yemen'], ['963','Syria'],
  ['972','Israel'], ['970','Palestine'], ['20','Egypt'], ['90','Turkey'],
  ['44','UK'], ['49','Germany'], ['33','France'], ['34','Spain'], ['39','Italy'],
  ['31','Netherlands'], ['32','Belgium'], ['48','Poland'], ['351','Portugal'], ['46','Sweden'],
  ['47','Norway'], ['45','Denmark'], ['358','Finland'], ['43','Austria'], ['41','Switzerland'],
  ['30','Greece'], ['40','Romania'], ['420','Czech Republic'], ['36','Hungary'], ['421','Slovakia'],
  ['385','Croatia'], ['380','Ukraine'], ['381','Serbia'], ['359','Bulgaria'],
  ['998','Uzbekistan'], ['992','Tajikistan'], ['996','Kyrgyzstan'], ['993','Turkmenistan'],
  ['994','Azerbaijan'], ['995','Georgia'], ['374','Armenia'], ['375','Belarus'], ['373','Moldova'],
  ['91','India'], ['92','Pakistan'], ['880','Bangladesh'], ['94','Sri Lanka'], ['86','China'],
  ['81','Japan'], ['82','South Korea'], ['886','Taiwan'], ['65','Singapore'], ['60','Malaysia'],
  ['66','Thailand'], ['62','Indonesia'], ['63','Philippines'], ['84','Vietnam'], ['95','Myanmar'],
  ['855','Cambodia'], ['977','Nepal'], ['93','Afghanistan'],
  ['52','Mexico'], ['55','Brazil'], ['57','Colombia'], ['54','Argentina'], ['56','Chile'], ['51','Peru'],
  ['234','Nigeria'], ['254','Kenya'], ['27','South Africa'], ['233','Ghana'], ['255','Tanzania'],
  ['251','Ethiopia'], ['256','Uganda'], ['237','Cameroon'], ['221','Senegal'], ['263','Zimbabwe'],
  ['260','Zambia'], ['244','Angola'],
  ['61','Australia'], ['64','New Zealand'],
  // Single-digit codes shared by several countries (NANP, ex-USSR) — resolved to the most
  // common member and flagged ambiguous so genuinely unclear numbers go to AI below.
  ['7','Russia'], ['1','USA'],
].sort((a, b) => b[0].length - a[0].length);

const AMBIGUOUS_CODES = new Set(['7', '1']);

function callingCodeGuess(phone) {
  const digits = String(phone || '').replace(/\D/g, '').replace(/^0+/, '');
  if (!digits) return null;
  const hit = CALLING_CODES.find(([code]) => digits.startsWith(code));
  return hit ? { country: hit[1], ambiguous: AMBIGUOUS_CODES.has(hit[0]) } : null;
}

async function askAI(env, phone, hint) {
  if (!env.AI) return null;
  const prompt = `Identify the most likely country for this CRM contact's phone number. ` +
    `Phone number: "${phone}". ` +
    (hint.callingCodeGuess ? `Its calling code is most commonly used by ${hint.callingCodeGuess}, but could be another country sharing that code. ` : '') +
    (hint.currentCountry ? `The CRM currently records the country as "${hint.currentCountry}" — confirm it or give the correct one. ` : '') +
    `Reply with ONLY a JSON object like {"country":"<name>"} using a common English country name. No other text.`;
  try {
    const result = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
      messages: [
        { role: 'system', content: 'You output strict JSON only, no markdown, no commentary.' },
        { role: 'user', content: prompt },
      ],
      max_tokens: 60,
    });
    const text = String(result?.response || '');
    const match = text.match(/\{[\s\S]*?\}/);
    if (!match) return null;
    const country = String(JSON.parse(match[0]).country || '').trim();
    return country || null;
  } catch { return null; }
}

// Returns the best-known {country, region, confidence, method} for a phone number.
// confidence is 'high' only for an unambiguous calling-code match — that's the only case
// callers should trust enough to overwrite a country a human already entered.
export async function detectCountryFromPhone(env, phone, currentCountry) {
  const current = String(currentCountry || '').trim();
  const guess = callingCodeGuess(phone);
  const conflicts = !!(guess && current && guess.country !== current);
  const needsAI = !guess || guess.ambiguous || conflicts;

  let country = guess?.country || current;
  let confidence = guess && !guess.ambiguous ? 'high' : 'low';
  let method = guess ? 'calling-code' : 'none';

  if (needsAI) {
    const aiCountry = await askAI(env, phone, { callingCodeGuess: guess?.country, currentCountry: current });
    if (aiCountry) { country = aiCountry; confidence = 'low'; method = 'ai'; }
  }

  return { country, region: regionForCountry(country), confidence, method };
}

// Merges a detection result into an existing country value: fills a blank country outright,
// but only overrides one already on file when the match was unambiguous (high confidence) —
// a low-confidence/AI guess never silently overwrites a human-entered country.
export function applyDetectedCountry(currentCountry, detected) {
  const current = String(currentCountry || '').trim();
  if (!current) return detected.country || current;
  if (detected.confidence === 'high' && detected.country && detected.country !== current) return detected.country;
  return current;
}

export async function handleDetectCountry(request, env) {
  const email = (request.headers.get('Cf-Access-Authenticated-User-Email') || '').trim().toLowerCase();
  const actor = email ? await env.DB.prepare('SELECT email FROM users WHERE email=?').bind(email).first() : null;
  if (!actor) return Response.json({ error: 'Authenticated user is not provisioned in Whizz.' }, { status: 403 });

  const body = await request.json().catch(() => ({}));
  const phone = String(body.phone || '').trim();
  if (!phone) return Response.json({ error: 'Phone number is required.' }, { status: 400 });

  const detected = await detectCountryFromPhone(env, phone, body.country);
  return Response.json({ success: true, ...detected });
}

// Runs detection across many contacts at once (e.g. a "Detect Country/Region" bulk action on
// selected leads) and persists any correction. Capped per call — the client chunks larger
// selections into several calls — since each contact may need a Workers AI round-trip.
const BULK_DETECT_CAP = 300;

export async function handleBulkDetectCountry(request, env) {
  const email = (request.headers.get('Cf-Access-Authenticated-User-Email') || '').trim().toLowerCase();
  const actor = email ? await env.DB.prepare('SELECT email,role,teamId FROM users WHERE email=?').bind(email).first() : null;
  if (!actor) return Response.json({ error: 'Authenticated user is not provisioned in Whizz.' }, { status: 403 });

  const body = await request.json().catch(() => ({}));
  const ids = Array.isArray(body.ids) ? [...new Set(body.ids.map(id => Number(id)).filter(Boolean))] : [];
  if (!ids.length) return Response.json({ error: 'At least one contact id is required.' }, { status: 400 });
  const capped = ids.slice(0, BULK_DETECT_CAP);

  const ownership = actor.role === 'Administrator' ? '1=1'
    : actor.role === 'Manager' ? '(ownerEmail IS NULL OR teamId = ?)'
    : 'ownerEmail = ?';
  const placeholders = capped.map(() => '?').join(',');
  const bindArgs = actor.role === 'Administrator' ? capped : [...capped, actor.role === 'Sales' ? actor.email : (actor.teamId || '')];
  const { results } = await env.DB.prepare(
    `SELECT id, phone, country FROM contacts WHERE id IN (${placeholders}) AND ${ownership}`
  ).bind(...bindArgs).all();

  let updated = 0, unchanged = 0, noPhone = 0;
  const items = [];
  for (const row of results || []) {
    const phone = String(row.phone || '').trim();
    const currentCountry = String(row.country || '').trim();
    if (!phone) { noPhone++; continue; }
    const detected = await detectCountryFromPhone(env, phone, currentCountry);
    const nextCountry = applyDetectedCountry(currentCountry, detected);
    const changed = nextCountry !== currentCountry;
    if (changed) {
      await env.DB.prepare('UPDATE contacts SET country=?, updatedAt=CURRENT_TIMESTAMP WHERE id=?').bind(nextCountry, row.id).run();
      updated++;
    } else unchanged++;
    items.push({ id: String(row.id), country: nextCountry, region: detected.region, changed });
  }

  return Response.json({ success: true, requested: ids.length, checked: results?.length || 0, updated, unchanged, noPhone, items });
}
