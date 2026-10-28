// ── Bulk WhatsApp campaign sending via Meta's Graph API directly (not n8n) ──
// Scoped per inbox: each configured Chatwoot inbox carries the Meta identifiers sending
// actually needs — phoneNumberId (what the send is addressed to) and wabaId (for
// reference) — set on Integrations → Chatwoot. The same System User access token used
// for template management (Integrations → WhatsApp Templates) is reused here.
//
// What's real vs. simplified, honestly:
// - Frequency cap (skip contacts messaged in the last N days) is real, read from each
//   contact's own lastContactedAt.
// - The auto-pause circuit breaker is real: it checks the failure rate against what's
//   actually happened so far in this run and stops early if it's unsafe to continue.
// - "Progressive batches" (ramp up over minutes with health checks in between) is NOT
//   implemented as true time-staged delivery — a single Worker invocation isn't a safe
//   place to hold a multi-minute wait. Contacts are sent in one pass, respecting the
//   circuit breaker. For audiences that genuinely need staged rollout over time, split
//   the audience into smaller campaigns and send them separately.
// - "Clean & suppress" removes missing/duplicate phone numbers, and — now that a real
//   opt-out/DNC list exists (worker/routes/optOuts.js) — any number that has opted out,
//   unconditionally, not as something a delivery-guard toggle could turn off.
import { resolveContactsForCampaign } from './automation.js';
import { loadMetaAccessToken, GRAPH_API_VERSION } from './metaTemplates.js';
import { loadChatwootConfig, findOrCreateContact, findOrCreateConversation, chatwootFetch } from './chatwoot.js';
import { logUserActivity } from './teamActivity.js';
import { getOptedOutSet, isOptedOut } from './optOuts.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
function json(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS }); }
function emailFromAccess(request) { return (request.headers.get('Cf-Access-Authenticated-User-Email') || '').trim().toLowerCase(); }

async function currentUser(request, env) {
  const email = emailFromAccess(request);
  return email ? env.DB.prepare('SELECT email,role,teamId FROM users WHERE email=?').bind(email).first() : null;
}

async function findInbox(env, inboxId) {
  if (inboxId) return { inbox: await env.DB.prepare('SELECT * FROM chatwoot_inboxes WHERE inboxId=?').bind(inboxId).first() };
  const result = await env.DB.prepare("SELECT * FROM chatwoot_inboxes WHERE phoneNumberId<>'' ORDER BY id LIMIT 2").all();
  const rows = result.results || [];
  if (rows.length === 1) return { inbox: rows[0] };
  if (rows.length === 0) return { error: 'No inbox has a Phone Number ID set yet — add one under Integrations → Chatwoot.' };
  return { error: 'Multiple numbers are configured — pick a Send From number first.' };
}

// Per-number daily quota — stops one rep's bulk send from silently exhausting a shared
// number's whole daily capacity before anyone notices (Meta would otherwise just start
// rejecting sends once its own platform-level limit is hit, with no warning beforehand).
async function sentTodayForInbox(env, inboxId) {
  const row = await env.DB.prepare("SELECT COALESCE(SUM(count),0) total FROM user_activity_log WHERE inboxId=? AND date(createdAt)=date('now')").bind(inboxId).first();
  return Number(row?.total) || 0;
}

function toSendableNumber(phone) {
  const digits = String(phone || '').replace(/[^\d]/g, '');
  return digits.replace(/^0+/, '');
}

// Meta requires an example value for every {{n}} placeholder in the template body/header
// it was approved with; sending requires those same slots be filled with real values, in
// order. {{1}} is filled with the contact's name (a real, useful default); anything beyond
// that isn't data Whizz has per-contact, so those templates are rejected up front rather
// than silently sent with placeholder junk.
function buildComponents(template, contact) {
  const bodyVars = [...new Set([...(template?.body || '').matchAll(/\{\{(\d+)\}\}/g)].map(m => Number(m[1])))].sort((a, b) => a - b);
  const headerVars = [...new Set([...(template?.header || '').matchAll(/\{\{(\d+)\}\}/g)].map(m => Number(m[1])))].sort((a, b) => a - b);
  if (bodyVars.some(n => n > 1) || headerVars.length) {
    throw new Error(`Template "${template?.name}" needs variables beyond {{1}} — bulk sends can only auto-fill {{1}} with the contact's name. Use a simpler template for bulk campaigns.`);
  }
  const components = [];
  if (bodyVars.length) {
    components.push({ type: 'body', parameters: [{ type: 'text', text: contact.contactName || 'there' }] });
  }
  return components;
}

// A rough, documented classification of Meta's WhatsApp Cloud API error codes — not
// exhaustive, but covers the common cases so the three buckets mean something instead of
// everything landing in "unknown" (same intent as the old n8n-based bucket classifier,
// now backed by Meta's own error codes instead of a guess).
function classifyMetaErrorCode(code) {
  if ([131026, 131053, 100].includes(code)) return 'permanent';
  if ([130429, 131048, 4, 80007, 1].includes(code)) return 'transient';
  if (code >= 132000 && code < 133000) return 'policy';
  if (code === 131047) return 'policy';
  return 'unknown';
}

export async function handleSendCampaignMeta(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'User is not provisioned in Whizz.' }, 403);
  const accessToken = await loadMetaAccessToken(env);
  if (!accessToken) return json({ error: 'Meta WhatsApp isn’t connected yet. Add an access token under Integrations.' }, 503);

  const body = await request.json().catch(() => ({}));
  const templateName = String(body.template_name || '').trim();
  const language = String(body.language || '').trim();
  if (!templateName || !language) return json({ error: 'A template is required.' }, 400);

  const inboxLookup = await findInbox(env, String(body.inboxId || '').trim());
  if (inboxLookup.error) return json({ error: inboxLookup.error }, 400);
  const inbox = inboxLookup.inbox;
  if (!inbox) return json({ error: 'Selected number was not found.' }, 400);
  if (!inbox.phoneNumberId) return json({ error: `"${inbox.label}" has no Phone Number ID set — add one under Integrations → Chatwoot.` }, 400);

  // Resend-to-failed (and any other direct-targeting caller) passes exact contacts to
  // message instead of a CRM audience to resolve — e.g. the failedContacts list from a
  // previous campaign run, which has name/phone but no contacts-table id.
  const targetContacts = Array.isArray(body.targetContacts) ? body.targetContacts : null;
  let contacts;
  if (targetContacts) {
    contacts = targetContacts.map(c => ({ id: null, contactName: String(c.name || '').trim(), phone: c.phone, lastContactedAt: null }));
  } else {
    try { contacts = await resolveContactsForCampaign(env, user, body); }
    catch (error) { return json({ error: error.message }, 500); }
  }

  const guard = body.delivery_guard || {};
  const seenPhones = new Set();
  const skipped = [];
  let eligible = contacts.filter(c => {
    const phone = toSendableNumber(c.phone);
    if (!phone) { skipped.push({ contactId: c.id, name: c.contactName, phone: c.phone, reason: 'No usable phone number on file' }); return false; }
    if (seenPhones.has(phone)) { skipped.push({ contactId: c.id, name: c.contactName, phone: c.phone, reason: 'Duplicate phone number in this audience' }); return false; }
    seenPhones.add(phone);
    return true;
  });
  if (guard.frequency_cap_days) {
    const cutoff = Date.now() - guard.frequency_cap_days * 86400000;
    eligible = eligible.filter(c => {
      if (!c.lastContactedAt) return true;
      const last = new Date(c.lastContactedAt).getTime();
      if (!Number.isNaN(last) && last > cutoff) { skipped.push({ contactId: c.id, name: c.contactName, phone: c.phone, reason: `Contacted within the last ${guard.frequency_cap_days} days` }); return false; }
      return true;
    });
  }

  // Opted-out numbers are suppressed unconditionally — this is not something
  // "clean & suppress" being off should be able to bypass.
  const optedOutSet = await getOptedOutSet(env, eligible.map(c => c.phone));
  if (optedOutSet.size) {
    eligible = eligible.filter(c => {
      if (optedOutSet.has(toSendableNumber(c.phone))) { skipped.push({ contactId: c.id, name: c.contactName, phone: c.phone, reason: 'Opted out of marketing messages' }); return false; }
      return true;
    });
  }

  let quotaCapped = false, quotaRemaining = null;
  if (inbox.dailySendCap > 0) {
    const sentToday = await sentTodayForInbox(env, inbox.inboxId);
    quotaRemaining = Math.max(0, inbox.dailySendCap - sentToday);
    if (quotaRemaining <= 0) return json({ error: `"${inbox.label}" has already reached its daily send cap (${inbox.dailySendCap}). Try again tomorrow or pick a different number.` }, 429);
    if (eligible.length > quotaRemaining) {
      quotaCapped = true;
      eligible.slice(quotaRemaining).forEach(c => skipped.push({ contactId: c.id, name: c.contactName, phone: c.phone, reason: `"${inbox.label}"'s daily send cap (${inbox.dailySendCap}) would be exceeded — held back for tomorrow` }));
      eligible = eligible.slice(0, quotaRemaining);
    }
  }

  let template = body.template || {};
  if (!template.body) {
    // Caller didn't pass the template text — fall back to just the name/language;
    // buildComponents only needs body/header text to detect variables, so with none
    // known we assume a static (no-variable) template rather than guessing wrong.
    template = { name: templateName, body: '', header: '' };
  }

  const results = [];
  let permanentFails = 0, totalFails = 0, paused = false;
  const maxPermanentRate = (guard.max_permanent_failure_rate ?? 8) / 100;
  const maxTotalRate = (guard.max_total_failure_rate ?? 15) / 100;
  const minSampleBeforePause = 20;

  for (const contact of eligible) {
    if (guard.auto_pause !== false && results.length >= minSampleBeforePause) {
      if (permanentFails / results.length > maxPermanentRate || totalFails / results.length > maxTotalRate) {
        paused = true;
        break;
      }
    }
    let components;
    try { components = buildComponents(template, contact); }
    catch (error) { results.push({ contactId: contact.id, name: contact.contactName, phone: contact.phone, status: 'failed', reason: error.message, bucket: 'policy' }); totalFails++; continue; }

    const payload = {
      messaging_product: 'whatsapp',
      to: toSendableNumber(contact.phone),
      type: 'template',
      template: { name: templateName, language: { code: language }, ...(components.length ? { components } : {}) },
    };
    try {
      const response = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${inbox.phoneNumberId}/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const code = data.error?.code;
        const bucket = classifyMetaErrorCode(code);
        if (bucket === 'permanent') permanentFails++;
        totalFails++;
        results.push({ contactId: contact.id, name: contact.contactName, phone: contact.phone, status: 'failed', reason: data.error?.message || `Meta API error (${response.status})`, code, bucket });
        try { await env.DB.prepare('INSERT INTO send_failures (phone,bucket,reason) VALUES (?,?,?)').bind(toSendableNumber(contact.phone), bucket, String(data.error?.message || '').slice(0, 200)).run(); } catch (_) {}
        continue;
      }
      results.push({ contactId: contact.id, name: contact.contactName, phone: contact.phone, status: 'sent', messageId: data.messages?.[0]?.id });
      if (contact.id) await env.DB.prepare('UPDATE contacts SET lastContactedAt=CURRENT_TIMESTAMP WHERE id=?').bind(contact.id).run();
    } catch (error) {
      totalFails++;
      results.push({ contactId: contact.id, name: contact.contactName, phone: contact.phone, status: 'failed', reason: error.message, bucket: 'transient' });
    }
  }

  const sent = results.filter(r => r.status === 'sent').length;
  const failed = results.filter(r => r.status === 'failed').length;
  const failure_reasons = { permanent: 0, transient: 0, policy: 0, unknown: 0 };
  for (const r of results) if (r.status === 'failed') failure_reasons[r.bucket || 'unknown'] = (failure_reasons[r.bucket || 'unknown'] || 0) + 1;

  await logUserActivity(env, user.email, 'campaign_sent', sent, inbox.inboxId);
  return json({
    total: contacts.length,
    attempted: results.length,
    sent, failed,
    suppressed: skipped.length,
    paused,
    quotaCapped,
    quotaRemaining,
    failure_reasons,
    results: [...results, ...skipped.map(s => ({ ...s, status: 'skipped' }))],
  });
}

// Single-contact template send — used by the "Send Template Message" button on
// Conversations. Same Meta Graph API path as bulk campaigns (works for either
// configured number via inboxId → phoneNumberId), replacing a guess at Chatwoot's own
// template_params shape that was never verified against a live response.
//
// Sending still bypasses Chatwoot entirely (same tradeoff as bulk campaigns), so the
// outbound message won't appear in Chatwoot's own record of the conversation. To keep
// the thread view in Whizz showing what was actually sent, this also best-effort mirrors
// the rendered text into Chatwoot as a plain outgoing message — using the same
// content/outgoing call every reply already sends through successfully, not the
// unverified template_params shape. If that mirror fails, the real send already
// succeeded, so the error is swallowed rather than reported as a failure.
export async function handleSendTemplateMessageMeta(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'User is not provisioned in Whizz.' }, 403);
  const accessToken = await loadMetaAccessToken(env);
  if (!accessToken) return json({ error: 'Meta WhatsApp isn’t connected yet. Add an access token under Integrations.' }, 503);

  const body = await request.json().catch(() => ({}));
  const phone = toSendableNumber(body.phone);
  const name = String(body.name || '').trim();
  const templateName = String(body.template_name || '').trim();
  const language = String(body.language || '').trim();
  const variables = Array.isArray(body.variables) ? body.variables : [];
  const renderedText = String(body.renderedText || '').trim();
  if (!phone) return json({ error: 'A phone number is required.' }, 400);
  if (!templateName || !language) return json({ error: 'A template is required.' }, 400);
  if (await isOptedOut(env, phone)) return json({ error: 'This contact has opted out of marketing messages.' }, 400);

  const inboxLookup = await findInbox(env, String(body.inboxId || '').trim());
  if (inboxLookup.error) return json({ error: inboxLookup.error }, 400);
  const inbox = inboxLookup.inbox;
  if (!inbox) return json({ error: 'Selected number was not found.' }, 400);
  if (!inbox.phoneNumberId) return json({ error: `"${inbox.label}" has no Phone Number ID set — add one under Integrations → Chatwoot.` }, 400);
  if (inbox.dailySendCap > 0) {
    const sentToday = await sentTodayForInbox(env, inbox.inboxId);
    if (sentToday >= inbox.dailySendCap) return json({ error: `"${inbox.label}" has already reached its daily send cap (${inbox.dailySendCap}). Try again tomorrow or pick a different number.` }, 429);
  }

  const components = variables.length ? [{ type: 'body', parameters: variables.map(v => ({ type: 'text', text: String(v) })) }] : [];
  const payload = {
    messaging_product: 'whatsapp',
    to: phone,
    type: 'template',
    template: { name: templateName, language: { code: language }, ...(components.length ? { components } : {}) },
  };

  let data;
  try {
    const response = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${inbox.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    data = await response.json().catch(() => ({}));
    if (!response.ok) return json({ error: data.error?.message || `Meta API error (${response.status})` }, 502);
  } catch (error) { return json({ error: error.message }, 502); }

  let mirrored = false;
  try {
    const config = await loadChatwootConfig(env);
    if (config && inbox.inboxId && renderedText) {
      const contact = await findOrCreateContact(config, phone, name);
      const conversation = await findOrCreateConversation(config, inbox.inboxId, contact, phone);
      await chatwootFetch(config, `/conversations/${conversation.id}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: renderedText, message_type: 'outgoing', private: false }),
      });
      mirrored = true;
    }
  } catch (error) { /* best-effort only — the real send above already succeeded */ }

  await logUserActivity(env, user.email, 'template_sent', 1, inbox.inboxId);
  return json({ messageId: data.messages?.[0]?.id, mirrored });
}

// Campaign review step's "list health" check — resolves the same audience a real send
// would, but only checks it against send_failures for prior permanent (hard-bounce-style)
// failures, never sends anything. Chunked phone lookups since an audience can run into
// the thousands and a single IN(...) with that many placeholders risks hitting D1's own
// per-statement parameter limit.
export async function handleListHealthPreview(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'User is not provisioned in Whizz.' }, 403);
  const body = await request.json().catch(() => ({}));
  let contacts;
  try { contacts = await resolveContactsForCampaign(env, user, body); }
  catch (error) { return json({ error: error.message }, 500); }

  const phones = [...new Set(contacts.map(c => toSendableNumber(c.phone)).filter(Boolean))];
  let atRisk = 0;
  const CHUNK = 100;
  for (let i = 0; i < phones.length; i += CHUNK) {
    const slice = phones.slice(i, i + CHUNK);
    const placeholders = slice.map(() => '?').join(',');
    const result = await env.DB.prepare(`SELECT COUNT(DISTINCT phone) n FROM send_failures WHERE bucket='permanent' AND phone IN (${placeholders})`).bind(...slice).first();
    atRisk += Number(result?.n) || 0;
  }
  return json({ total: contacts.length, atRisk });
}
