// ── Real opt-out / Do Not Contact list ──
// Before this, "clean & suppress" in the Delivery Guard only ever removed missing or
// duplicate phone numbers — an actual customer opt-out was never tracked or enforced
// anywhere. This is enforced unconditionally on every send (not a toggle a rep could
// turn off), since an opt-out is a compliance requirement, not a preference.
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
function json(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS }); }

async function currentUser(request, env) {
  const email = (request.headers.get('Cf-Access-Authenticated-User-Email') || '').trim().toLowerCase();
  return email ? env.DB.prepare('SELECT email,role,teamId FROM users WHERE email=?').bind(email).first() : null;
}

export function normalizeOptOutPhone(phone) {
  return String(phone || '').replace(/[^\d]/g, '').replace(/^0+/, '');
}

export async function recordOptOut(env, phone, source, reason, addedByEmail = '') {
  const normalized = normalizeOptOutPhone(phone);
  if (!normalized) return;
  try {
    await env.DB.prepare('INSERT INTO opted_out_numbers (phone,source,reason,addedByEmail) VALUES (?,?,?,?) ON CONFLICT(phone) DO NOTHING')
      .bind(normalized, source, String(reason || '').slice(0, 200), addedByEmail).run();
  } catch (_) { /* best-effort — never block a conversation fetch over this */ }
}

// One query for a whole campaign's audience instead of one query per contact.
export async function getOptedOutSet(env, phones) {
  const normalized = [...new Set((phones || []).map(normalizeOptOutPhone).filter(Boolean))];
  if (!normalized.length) return new Set();
  const placeholders = normalized.map(() => '?').join(',');
  const result = await env.DB.prepare(`SELECT phone FROM opted_out_numbers WHERE phone IN (${placeholders})`).bind(...normalized).all();
  return new Set((result.results || []).map(r => r.phone));
}

export async function isOptedOut(env, phone) {
  const normalized = normalizeOptOutPhone(phone);
  if (!normalized) return false;
  const row = await env.DB.prepare('SELECT 1 FROM opted_out_numbers WHERE phone=?').bind(normalized).first();
  return !!row;
}

// STOP-style replies are detected best-effort, lazily, whenever Whizz happens to fetch a
// conversation's messages (there's no inbound webhook receiver here) — so this only
// catches a reply once that conversation has actually been opened/polled, not the
// instant it arrives. Deliberately narrow (whole-message match only) to avoid treating a
// message that merely mentions "stop" in passing as an opt-out.
const STOP_PATTERN = /^\s*(stop|unsubscribe|opt[\s-]?out|cancel|remove me)\s*[.!]?\s*$/i;
export async function detectOptOutsInMessages(env, rawMessages) {
  for (const m of rawMessages) {
    if (m.message_type !== 0) continue; // incoming only — never triggered by our own sends
    const text = String(m.content || '').trim();
    if (!text || !STOP_PATTERN.test(text)) continue;
    const phone = m.sender?.phone_number || m.conversation?.meta?.sender?.phone_number || '';
    if (!phone) continue;
    await recordOptOut(env, phone, 'keyword_detected', `Replied "${text}"`);
  }
}

export async function handleListOptOuts(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'User is not provisioned in Whizz.' }, 403);
  if (user.role === 'Sales') return json({ error: 'Manager or Administrator access required.' }, 403);
  const result = await env.DB.prepare('SELECT phone,source,reason,addedByEmail,createdAt FROM opted_out_numbers ORDER BY createdAt DESC').all();
  return json({ numbers: result.results || [] });
}

export async function handleAddOptOut(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'User is not provisioned in Whizz.' }, 403);
  if (user.role === 'Sales') return json({ error: 'Manager or Administrator access required.' }, 403);
  const body = await request.json().catch(() => ({}));
  const phone = normalizeOptOutPhone(body.phone);
  if (!phone) return json({ error: 'A phone number is required.' }, 400);
  await recordOptOut(env, phone, 'manual', body.reason || 'Added manually', user.email);
  return json({ success: true }, 201);
}

export async function handleRemoveOptOut(request, env, phone) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'User is not provisioned in Whizz.' }, 403);
  if (user.role === 'Sales') return json({ error: 'Manager or Administrator access required.' }, 403);
  await env.DB.prepare('DELETE FROM opted_out_numbers WHERE phone=?').bind(normalizeOptOutPhone(phone)).run();
  return json({ success: true });
}

export async function handleCheckOptOut(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'User is not provisioned in Whizz.' }, 403);
  const url = new URL(request.url);
  const phone = url.searchParams.get('phone') || '';
  const row = await env.DB.prepare('SELECT source,reason,createdAt FROM opted_out_numbers WHERE phone=?').bind(normalizeOptOutPhone(phone)).first();
  return json({ optedOut: !!row, ...(row || {}) });
}
