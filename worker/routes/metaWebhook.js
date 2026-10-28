// ── Meta WhatsApp Cloud API status webhook ──
// Real delivery/read receipts: Meta posts sent → delivered → read (or failed) for every
// message here, keyed by the wamid campaignSend.js already captures at send time. Until
// this is configured in Meta's App Dashboard, Campaign History only ever shows "the Graph
// API accepted it" — this is what turns that into a real delivery state.
//
// Two things an Administrator must do outside this app before receipts start arriving:
//   1. Set a webhook verify token under Integrations → Meta WhatsApp, then in Meta's App
//      Dashboard (WhatsApp → Configuration) point the webhook at
//      https://<this app's domain>/api/webhooks/meta with that same verify token, and
//      subscribe the "messages" field on the WABA.
//   2. Add a Cloudflare Access bypass policy for the /api/webhooks/meta path — Meta's
//      servers can't complete an SSO login, and without a bypass policy, Access will
//      reject every request (both the verification handshake and the status posts)
//      before it reaches this route.
import { loadWebhookVerifyToken } from './metaTemplates.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
function json(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS }); }

async function currentUser(request, env) {
  const email = (request.headers.get('Cf-Access-Authenticated-User-Email') || '').trim().toLowerCase();
  return email ? env.DB.prepare('SELECT email,role FROM users WHERE email=?').bind(email).first() : null;
}

export async function handleMetaWebhookVerify(request, env) {
  const url = new URL(request.url);
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');
  const expected = await loadWebhookVerifyToken(env);
  if (mode === 'subscribe' && expected && token === expected) {
    return new Response(challenge || '', { status: 200, headers: { 'content-type': 'text/plain' } });
  }
  return json({ error: 'Verification token mismatch.' }, 403);
}

export async function handleMetaWebhookEvent(request, env) {
  const body = await request.json().catch(() => null);
  // Always acknowledge — Meta retries (and eventually disables) a webhook that doesn't
  // respond 200 quickly, even for a payload shape we don't recognize or can't use.
  if (!body) return json({ received: true });
  try {
    const entries = Array.isArray(body.entry) ? body.entry : [];
    for (const entry of entries) {
      const changes = Array.isArray(entry.changes) ? entry.changes : [];
      for (const change of changes) {
        const statuses = Array.isArray(change.value?.statuses) ? change.value.statuses : [];
        for (const status of statuses) {
          const wamid = status.id;
          if (!wamid) continue;
          const state = String(status.status || 'unknown');
          const phone = status.recipient_id ? String(status.recipient_id) : '';
          const errorMessage = Array.isArray(status.errors) && status.errors.length
            ? String(status.errors[0].title || status.errors[0].message || '').slice(0, 200)
            : '';
          await env.DB.prepare(`INSERT INTO message_delivery_status (wamid,phone,status,errorMessage,updatedAt) VALUES (?,?,?,?,CURRENT_TIMESTAMP)
            ON CONFLICT(wamid) DO UPDATE SET status=excluded.status, errorMessage=excluded.errorMessage, phone=CASE WHEN excluded.phone<>'' THEN excluded.phone ELSE message_delivery_status.phone END, updatedAt=CURRENT_TIMESTAMP`)
            .bind(wamid, phone, state, errorMessage).run();
        }
      }
    }
  } catch (_) {
    // Never fail the webhook response over a persistence hiccup — Meta would just retry
    // (and eventually disable) the subscription, which loses receipts for every message.
  }
  return json({ received: true });
}

export async function handleGetDeliveryStatuses(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'User is not provisioned in Whizz.' }, 403);
  const body = await request.json().catch(() => ({}));
  const wamids = Array.isArray(body.wamids) ? [...new Set(body.wamids.filter(Boolean))] : [];
  if (!wamids.length) return json({ statuses: {} });
  const statuses = {};
  for (let i = 0; i < wamids.length; i += 100) {
    const batch = wamids.slice(i, i + 100);
    const placeholders = batch.map(() => '?').join(',');
    const result = await env.DB.prepare(`SELECT wamid,status,errorMessage,updatedAt FROM message_delivery_status WHERE wamid IN (${placeholders})`)
      .bind(...batch).all();
    for (const row of result.results || []) statuses[row.wamid] = { status: row.status, errorMessage: row.errorMessage, updatedAt: row.updatedAt };
  }
  return json({ statuses });
}
