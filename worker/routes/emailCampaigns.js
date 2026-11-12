// ── Email Marketing module — sends via Resend's API directly (not n8n/Brevo) ──
// Mirrors the Telegram Marketing module's shape (its own settings card, its own audience
// resolution, its own suppression list, its own send history) rather than being wedged
// into the WhatsApp campaign wizard, since email has none of WhatsApp's template-approval
// or per-number concepts. Audience targeting reuses the exact same `contacts` leadbase and
// platform/country/brand filters as WhatsApp campaigns (resolveContactsForCampaign), just
// narrowed to contacts that actually have an email address on file.
import { resolveContactsForCampaign } from './automation.js';
import { logUserActivity } from './teamActivity.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
function json(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS }); }
function emailFromAccess(request) { return (request.headers.get('Cf-Access-Authenticated-User-Email') || '').trim().toLowerCase(); }

async function currentUser(request, env) {
  const email = emailFromAccess(request);
  return email ? env.DB.prepare('SELECT email,name,role,teamId FROM users WHERE email=?').bind(email).first() : null;
}
function requireAdmin(user) { return user && user.role === 'Administrator'; }

// Same AES-GCM technique/secret as every other integration's stored credential in this
// repo (Meta access token, Chatwoot token, Telegram bot token, Lead Intelligence directory
// credentials) — kept as a local copy per this repo's established pattern.
async function cryptoKey(secret) {
  if (!secret) throw new Error('LEAD_INTELLIGENCE_KEY secret is not configured — set it with `wrangler secret put LEAD_INTELLIGENCE_KEY` before saving a Resend API key.');
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
function toB64(bytes) { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); }
function fromB64(s) { const bin = atob(s); return Uint8Array.from(bin, c => c.charCodeAt(0)); }
async function encryptToken(env, value) {
  const key = await cryptoKey(env.LEAD_INTELLIGENCE_KEY);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(value));
  return `${toB64(iv)}.${toB64(new Uint8Array(cipher))}`;
}
async function decryptToken(env, token) {
  if (!token) return '';
  const [iv64, data64] = token.split('.');
  const key = await cryptoKey(env.LEAD_INTELLIGENCE_KEY);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv64) }, key, fromB64(data64));
  return new TextDecoder().decode(plain);
}

async function getEmailSettingsRow(env) { return env.DB.prepare('SELECT * FROM email_settings WHERE id=1').first(); }
export async function loadResendApiKey(env) {
  const row = await getEmailSettingsRow(env);
  if (!row?.apiKeyEncrypted) return null;
  const key = await decryptToken(env, row.apiKeyEncrypted);
  return key || null;
}

export async function handleGetEmailSettings(request, env) {
  const user = await currentUser(request, env);
  if (!requireAdmin(user)) return json({ error: 'Administrator access required.' }, 403);
  const row = await getEmailSettingsRow(env);
  return json({
    hasApiKey: !!row?.apiKeyEncrypted,
    fromEmail: row?.fromEmail || '',
    fromName: row?.fromName || '',
    webhookConfigured: !!row?.webhookSecret,
  });
}

export async function handleSaveEmailSettings(request, env) {
  const user = await currentUser(request, env);
  if (!requireAdmin(user)) return json({ error: 'Administrator access required.' }, 403);
  const body = await request.json().catch(() => ({}));
  const newKey = String(body.apiKey || '').trim();
  const existing = await getEmailSettingsRow(env);
  let apiKeyEncrypted = existing?.apiKeyEncrypted || null;
  if (newKey) {
    try { apiKeyEncrypted = await encryptToken(env, newKey); }
    catch (error) { return json({ error: error.message }, 500); }
  }
  if (!apiKeyEncrypted) return json({ error: 'A Resend API key is required.' }, 400);
  const fromEmail = body.fromEmail !== undefined ? String(body.fromEmail).trim() : (existing?.fromEmail || '');
  const fromName = body.fromName !== undefined ? String(body.fromName).trim() : (existing?.fromName || '');
  if (!fromEmail) return json({ error: 'A "From" email address is required — it must be on a domain verified in Resend.' }, 400);
  // Auto-generated once, like Telegram's webhookSecret — the admin pastes this into
  // Resend's dashboard (Webhooks → Add Endpoint → Signing Secret), not the other way
  // round, so it's only ever regenerated if the row doesn't have one yet.
  const webhookSecret = existing?.webhookSecret || `wh_${crypto.randomUUID().replace(/-/g, '')}`;
  await env.DB.prepare(`INSERT INTO email_settings (id,apiKeyEncrypted,fromEmail,fromName,webhookSecret,updatedAt) VALUES (1,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET apiKeyEncrypted=excluded.apiKeyEncrypted, fromEmail=excluded.fromEmail, fromName=excluded.fromName, webhookSecret=excluded.webhookSecret, updatedAt=CURRENT_TIMESTAMP`)
    .bind(apiKeyEncrypted, fromEmail, fromName, webhookSecret).run();
  return json({ success: true, webhookSecret });
}

// ── Templates ──
export async function handleListEmailTemplates(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'User is not provisioned in Whizz.' }, 403);
  const result = await env.DB.prepare('SELECT id,name,subject,bodyHtml,createdByEmail,createdAt,updatedAt FROM email_templates ORDER BY updatedAt DESC').all();
  return json({ templates: result.results || [] });
}

export async function handleCreateEmailTemplate(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'User is not provisioned in Whizz.' }, 403);
  const body = await request.json().catch(() => ({}));
  const id = Number(body.id) || null;
  const name = String(body.name || '').trim();
  const subject = String(body.subject || '').trim();
  const bodyHtml = String(body.bodyHtml || '');
  if (!name || !subject || !bodyHtml.trim()) return json({ error: 'Name, subject and body are all required.' }, 400);
  if (id) {
    await env.DB.prepare('UPDATE email_templates SET name=?,subject=?,bodyHtml=?,updatedAt=CURRENT_TIMESTAMP WHERE id=?').bind(name, subject, bodyHtml, id).run();
    return json({ success: true, id });
  }
  const result = await env.DB.prepare('INSERT INTO email_templates (name,subject,bodyHtml,createdByEmail) VALUES (?,?,?,?)').bind(name, subject, bodyHtml, user.email).run();
  return json({ success: true, id: result.meta.last_row_id }, 201);
}

export async function handleDeleteEmailTemplate(request, env, id) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'User is not provisioned in Whizz.' }, 403);
  await env.DB.prepare('DELETE FROM email_templates WHERE id=?').bind(id).run();
  return json({ success: true });
}

// ── Suppression list (email) ──
export function normalizeEmailAddress(email) { return String(email || '').trim().toLowerCase(); }

export async function getEmailOptedOutSet(env, emails) {
  const normalized = [...new Set((emails || []).map(normalizeEmailAddress).filter(Boolean))];
  if (!normalized.length) return new Set();
  const out = new Set();
  // Chunked at 100 — same D1 bound-parameter-limit precaution as every other IN(...)
  // audience lookup in this app (optOuts.js's getOptedOutSet, leadIntelligence.js, etc).
  for (let i = 0; i < normalized.length; i += 100) {
    const batch = normalized.slice(i, i + 100);
    const placeholders = batch.map(() => '?').join(',');
    const result = await env.DB.prepare(`SELECT email FROM email_opted_out WHERE email IN (${placeholders})`).bind(...batch).all();
    for (const r of result.results || []) out.add(r.email);
  }
  return out;
}

export async function handleListEmailOptOuts(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'User is not provisioned in Whizz.' }, 403);
  if (user.role === 'Sales') return json({ error: 'Manager or Administrator access required.' }, 403);
  const result = await env.DB.prepare('SELECT email,source,reason,addedByEmail,createdAt FROM email_opted_out ORDER BY createdAt DESC').all();
  return json({ emails: result.results || [] });
}

export async function handleAddEmailOptOut(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'User is not provisioned in Whizz.' }, 403);
  if (user.role === 'Sales') return json({ error: 'Manager or Administrator access required.' }, 403);
  const body = await request.json().catch(() => ({}));
  const email = normalizeEmailAddress(body.email);
  if (!email) return json({ error: 'An email address is required.' }, 400);
  await env.DB.prepare('INSERT INTO email_opted_out (email,source,reason,addedByEmail) VALUES (?,?,?,?) ON CONFLICT(email) DO NOTHING')
    .bind(email, 'manual', String(body.reason || 'Added manually').slice(0, 200), user.email).run();
  return json({ success: true }, 201);
}

export async function handleRemoveEmailOptOut(request, env, email) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'User is not provisioned in Whizz.' }, 403);
  if (user.role === 'Sales') return json({ error: 'Manager or Administrator access required.' }, 403);
  await env.DB.prepare('DELETE FROM email_opted_out WHERE email=?').bind(normalizeEmailAddress(email)).run();
  return json({ success: true });
}

// One-click unsubscribe link (RFC 8058 style) — signed with the same shared secret rather
// than requiring a login, since the person clicking it is, by definition, not necessarily
// a Whizz user. HMAC rather than the AES-GCM encryption used elsewhere: this only ever
// needs to be verified, never decrypted back to anything.
async function hmacKey(env) {
  if (!env.LEAD_INTELLIGENCE_KEY) throw new Error('LEAD_INTELLIGENCE_KEY secret is not configured.');
  return crypto.subtle.importKey('raw', new TextEncoder().encode(env.LEAD_INTELLIGENCE_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}
export async function signUnsubscribeToken(env, email) {
  const key = await hmacKey(env);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(normalizeEmailAddress(email)));
  return toB64(new Uint8Array(sig)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function verifyUnsubscribeToken(env, email, token) {
  const expected = await signUnsubscribeToken(env, email);
  return !!token && token === expected;
}

export async function handleEmailUnsubscribe(request, env) {
  const url = new URL(request.url);
  const email = normalizeEmailAddress(url.searchParams.get('email'));
  const token = url.searchParams.get('sig') || '';
  if (!email || !(await verifyUnsubscribeToken(env, email, token))) {
    return new Response('Invalid or expired unsubscribe link.', { status: 400, headers: { 'content-type': 'text/plain' } });
  }
  await env.DB.prepare('INSERT INTO email_opted_out (email,source,reason) VALUES (?,?,?) ON CONFLICT(email) DO NOTHING')
    .bind(email, 'unsubscribe_link', 'Clicked the unsubscribe link in a campaign email').run();
  return new Response('You have been unsubscribed from marketing emails.', { status: 200, headers: { 'content-type': 'text/plain' } });
}

// ── Audience resolution — same leadbase/filters as WhatsApp, narrowed to has-email ──
async function resolveEmailAudience(env, user, body) {
  const contacts = await resolveContactsForCampaign(env, user, body);
  const seen = new Set();
  return contacts.filter(c => {
    const email = normalizeEmailAddress(c.email);
    if (!email || seen.has(email)) return false;
    seen.add(email);
    return true;
  });
}

export async function handlePreviewEmailAudience(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'User is not provisioned in Whizz.' }, 403);
  const body = await request.json().catch(() => ({}));
  let contacts;
  try { contacts = await resolveEmailAudience(env, user, body); }
  catch (error) { return json({ error: error.message }, 500); }
  const optedOut = await getEmailOptedOutSet(env, contacts.map(c => c.email));
  const eligible = contacts.filter(c => !optedOut.has(normalizeEmailAddress(c.email)));
  return json({ total: contacts.length, eligible: eligible.length, suppressed: contacts.length - eligible.length });
}

function renderTemplate(text, contact) {
  return String(text || '').replace(/\{\{\s*name\s*\}\}/gi, contact.contactName || 'there');
}

// ── Send ──
export async function handleSendEmailCampaign(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'User is not provisioned in Whizz.' }, 403);
  const apiKey = await loadResendApiKey(env);
  const settings = await getEmailSettingsRow(env);
  if (!apiKey || !settings?.fromEmail) return json({ error: 'Email Marketing isn’t connected yet. Add a Resend API key and From address first.' }, 503);

  const body = await request.json().catch(() => ({}));
  const subject = String(body.subject || '').trim();
  const bodyHtml = String(body.bodyHtml || '');
  const name = String(body.name || subject || 'Untitled campaign').trim();
  if (!subject || !bodyHtml.trim()) return json({ error: 'A subject and body are required.' }, 400);

  let contacts;
  try { contacts = await resolveEmailAudience(env, user, body); }
  catch (error) { return json({ error: error.message }, 500); }
  if (!contacts.length) return json({ error: 'No contacts with an email address match this audience.' }, 400);

  const optedOut = await getEmailOptedOutSet(env, contacts.map(c => c.email));
  const eligible = contacts.filter(c => !optedOut.has(normalizeEmailAddress(c.email)));
  if (!eligible.length) return json({ error: 'Every matching contact has opted out of marketing emails.' }, 400);

  const audienceLabel = body.audienceLabel ? String(body.audienceLabel).slice(0, 200) : `${eligible.length} contacts`;
  const campaignResult = await env.DB.prepare(
    'INSERT INTO email_campaigns (templateId,name,subject,bodyHtml,audienceLabel,totalContacts,createdByEmail) VALUES (?,?,?,?,?,?,?)'
  ).bind(body.templateId ? Number(body.templateId) : null, name, subject, bodyHtml, audienceLabel, eligible.length, user.email).run();
  const campaignId = campaignResult.meta.last_row_id;

  const from = settings.fromName ? `${settings.fromName} <${settings.fromEmail}>` : settings.fromEmail;
  let sent = 0, failed = 0;
  const CHUNK = 100; // Resend's own batch-send limit per request
  for (let i = 0; i < eligible.length; i += CHUNK) {
    const slice = eligible.slice(i, i + CHUNK);
    const payloads = await Promise.all(slice.map(async c => {
      const unsubToken = await signUnsubscribeToken(env, c.email);
      const unsubUrl = `${env.PUBLIC_BASE_URL || 'https://app.whizzexim.com'}/api/email/unsubscribe?email=${encodeURIComponent(c.email)}&sig=${unsubToken}`;
      return {
        from,
        to: [c.email],
        subject: renderTemplate(subject, c),
        html: `${renderTemplate(bodyHtml, c)}<p style="font-size:11px;color:#94a3b8;margin-top:24px;">Don't want these emails? <a href="${unsubUrl}">Unsubscribe</a></p>`,
        headers: { 'List-Unsubscribe': `<${unsubUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
      };
    }));

    let data;
    try {
      const response = await fetch('https://api.resend.com/emails/batch', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(payloads),
      });
      data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || `Resend API error (${response.status})`);
    } catch (error) {
      failed += slice.length;
      for (const c of slice) {
        await env.DB.prepare('INSERT INTO email_sends (campaignId,contactId,email,name,status,errorMessage) VALUES (?,?,?,?,?,?)')
          .bind(campaignId, c.id || null, c.email, c.contactName || '', 'failed', String(error.message || '').slice(0, 200)).run();
      }
      continue;
    }

    const results = data.data || [];
    for (let j = 0; j < slice.length; j++) {
      const c = slice[j];
      const resendId = results[j]?.id || '';
      if (resendId) {
        sent++;
        await env.DB.prepare('INSERT INTO email_sends (campaignId,contactId,email,name,resendId,status) VALUES (?,?,?,?,?,?)')
          .bind(campaignId, c.id || null, c.email, c.contactName || '', resendId, 'sent').run();
        if (c.id) await env.DB.prepare('UPDATE contacts SET lastContactedAt=CURRENT_TIMESTAMP WHERE id=?').bind(c.id).run();
      } else {
        failed++;
        await env.DB.prepare('INSERT INTO email_sends (campaignId,contactId,email,name,status,errorMessage) VALUES (?,?,?,?,?,?)')
          .bind(campaignId, c.id || null, c.email, c.contactName || '', 'failed', 'Resend did not return a message id').run();
      }
    }
  }

  await env.DB.prepare('UPDATE email_campaigns SET sentCount=?,failedCount=? WHERE id=?').bind(sent, failed, campaignId).run();
  await logUserActivity(env, user.email, 'email_campaign_sent', sent);
  return json({ success: true, campaignId, total: eligible.length, sent, failed, suppressed: contacts.length - eligible.length });
}

// ── Campaign history ──
export async function handleListEmailCampaigns(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'User is not provisioned in Whizz.' }, 403);
  const result = await env.DB.prepare(`
    SELECT c.id,c.name,c.subject,c.audienceLabel,c.totalContacts,c.sentCount,c.failedCount,c.createdByEmail,c.createdAt,
      SUM(CASE WHEN s.status IN ('delivered','opened','clicked') THEN 1 ELSE 0 END) delivered,
      SUM(CASE WHEN s.openCount > 0 THEN 1 ELSE 0 END) opened,
      SUM(CASE WHEN s.clickCount > 0 THEN 1 ELSE 0 END) clicked,
      SUM(CASE WHEN s.status = 'bounced' THEN 1 ELSE 0 END) bounced
    FROM email_campaigns c LEFT JOIN email_sends s ON s.campaignId = c.id
    GROUP BY c.id ORDER BY c.createdAt DESC LIMIT 100
  `).all();
  return json({ campaigns: result.results || [] });
}

export async function handleGetEmailCampaignDetail(request, env, id) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'User is not provisioned in Whizz.' }, 403);
  const campaign = await env.DB.prepare('SELECT * FROM email_campaigns WHERE id=?').bind(id).first();
  if (!campaign) return json({ error: 'Campaign not found.' }, 404);
  const recipients = await env.DB.prepare('SELECT email,name,status,openCount,clickCount,errorMessage,createdAt,updatedAt FROM email_sends WHERE campaignId=? ORDER BY id').bind(id).all();
  return json({ campaign, recipients: recipients.results || [] });
}

// ── Resend webhook (delivery/open/click/bounce tracking) ──
// Resend signs webhook deliveries the same way Svix does: signed_content is
// "{svix-id}.{svix-timestamp}.{body}", HMAC-SHA256'd with the base64 bytes after the
// webhookSecret's "whsec_"-style prefix, base64-encoded, compared against each
// "v1,<sig>" entry in the svix-signature header. No Cf-Access header reaches this route
// (Resend calls it directly) — same bypass requirement as the Meta/Telegram webhooks.
async function verifyResendSignature(env, request, rawBody) {
  const settings = await getEmailSettingsRow(env);
  if (!settings?.webhookSecret) return false;
  const id = request.headers.get('svix-id') || '';
  const timestamp = request.headers.get('svix-timestamp') || '';
  const signatureHeader = request.headers.get('svix-signature') || '';
  if (!id || !timestamp || !signatureHeader) return false;

  const secretPart = settings.webhookSecret.includes('_') ? settings.webhookSecret.split('_').slice(1).join('_') : settings.webhookSecret;
  let secretBytes;
  try { secretBytes = fromB64(secretPart); } catch (_) { secretBytes = new TextEncoder().encode(secretPart); }
  const key = await crypto.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signed = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${rawBody}`));
  const expected = toB64(new Uint8Array(signed));

  return signatureHeader.split(' ').some(entry => {
    const [, sig] = entry.split(',');
    return sig === expected;
  });
}

export async function handleResendWebhookEvent(request, env) {
  const rawBody = await request.text();
  if (!(await verifyResendSignature(env, request, rawBody))) return json({ error: 'Invalid signature.' }, 401);

  let event;
  try { event = JSON.parse(rawBody); } catch (_) { return json({ received: true }); }
  const resendId = event.data?.email_id || '';
  if (!resendId) return json({ received: true });

  const statusByType = {
    'email.sent': 'sent',
    'email.delivered': 'delivered',
    'email.delivery_delayed': 'delayed',
    'email.bounced': 'bounced',
    'email.complained': 'complained',
  };
  try {
    if (event.type === 'email.opened') {
      await env.DB.prepare('UPDATE email_sends SET openCount=openCount+1,updatedAt=CURRENT_TIMESTAMP WHERE resendId=?').bind(resendId).run();
    } else if (event.type === 'email.clicked') {
      await env.DB.prepare('UPDATE email_sends SET clickCount=clickCount+1,updatedAt=CURRENT_TIMESTAMP WHERE resendId=?').bind(resendId).run();
    } else if (statusByType[event.type]) {
      await env.DB.prepare('UPDATE email_sends SET status=?,updatedAt=CURRENT_TIMESTAMP WHERE resendId=?').bind(statusByType[event.type], resendId).run();
    }
  } catch (_) { /* best-effort */ }
  return json({ received: true });
}
