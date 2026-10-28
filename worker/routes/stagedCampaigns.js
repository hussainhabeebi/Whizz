// ── Genuinely time-staged campaign rollout ──
// campaignSend.js's own header comment is honest that its "progressive batches" guard
// setting isn't real time-staged delivery — a single Worker invocation isn't a safe place
// to hold a multi-minute wait. This is what makes it real: a staged run is persisted here
// (status + the remaining contact list, as JSON — D1 has no array column), and a Cron
// Trigger (wrangler.toml's [triggers], processed by processStagedCampaignRuns below) wakes
// up on a real schedule to send the next batch, re-checking opt-outs and the daily send
// cap each time since real time has actually passed between batches.
import { resolveContactsForCampaign } from './automation.js';
import { loadMetaAccessToken, GRAPH_API_VERSION } from './metaTemplates.js';
import { findInbox, sentTodayForInbox, toSendableNumber, buildComponents, classifyMetaErrorCode } from './campaignSend.js';
import { getOptedOutSet } from './optOuts.js';
import { logUserActivity } from './teamActivity.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
function json(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS }); }

async function currentUser(request, env) {
  const email = (request.headers.get('Cf-Access-Authenticated-User-Email') || '').trim().toLowerCase();
  return email ? env.DB.prepare('SELECT email,role,teamId FROM users WHERE email=?').bind(email).first() : null;
}

export async function handleCreateStagedRun(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'User is not provisioned in Whizz.' }, 403);

  const body = await request.json().catch(() => ({}));
  const templateName = String(body.template_name || '').trim();
  const language = String(body.language || '').trim();
  if (!templateName || !language) return json({ error: 'A template is required.' }, 400);

  const inboxLookup = await findInbox(env, String(body.inboxId || '').trim());
  if (inboxLookup.error) return json({ error: inboxLookup.error }, 400);
  const inbox = inboxLookup.inbox;
  if (!inbox) return json({ error: 'Selected number was not found.' }, 400);
  if (!inbox.phoneNumberId) return json({ error: `"${inbox.label}" has no Phone Number ID set — add one under Integrations → Chatwoot.` }, 400);

  let contacts;
  try { contacts = await resolveContactsForCampaign(env, user, body); }
  catch (error) { return json({ error: error.message }, 500); }

  const seenPhones = new Set();
  const cleaned = contacts.filter(c => {
    const phone = toSendableNumber(c.phone);
    if (!phone || seenPhones.has(phone)) return false;
    seenPhones.add(phone);
    return true;
  }).map(c => ({ id: c.id, contactName: c.contactName, phone: c.phone }));
  if (!cleaned.length) return json({ error: 'No eligible contacts (with a usable, non-duplicate phone number) in this audience.' }, 400);

  const batchSize = Math.min(2000, Math.max(1, parseInt(body.batchSize, 10) || 50));
  const intervalMinutes = Math.max(15, parseInt(body.intervalMinutes, 10) || 60);
  const guard = body.delivery_guard || {};
  const template = body.template || {};

  const result = await env.DB.prepare(`INSERT INTO staged_campaign_runs
    (templateName,language,templateHeader,templateBody,templateFooter,inboxId,audienceLabel,batchSize,intervalMinutes,maxPermanentFailureRate,maxTotalFailureRate,remainingContacts,totalContacts,createdByEmail,nextRunAt)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`)
    .bind(
      templateName, language, template.header || '', template.body || '', template.footer || '',
      inbox.inboxId, String(body.audienceLabel || '').slice(0, 200), batchSize, intervalMinutes,
      Number(guard.max_permanent_failure_rate ?? 8), Number(guard.max_total_failure_rate ?? 15),
      JSON.stringify(cleaned), cleaned.length, user.email
    ).run();

  return json({ success: true, id: result.meta.last_row_id, totalContacts: cleaned.length, batches: Math.ceil(cleaned.length / batchSize) });
}

export async function handleListStagedRuns(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'User is not provisioned in Whizz.' }, 403);
  const result = await env.DB.prepare(`SELECT id,status,templateName,language,inboxId,audienceLabel,batchSize,intervalMinutes,
    totalContacts,sentCount,failedCount,permanentFailedCount,nextRunAt,lastNote,createdByEmail,createdAt,updatedAt
    FROM staged_campaign_runs ORDER BY createdAt DESC LIMIT 50`).all();
  return json({ runs: result.results || [] });
}

export async function handlePauseStagedRun(request, env, id) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'User is not provisioned in Whizz.' }, 403);
  await env.DB.prepare("UPDATE staged_campaign_runs SET status='paused', updatedAt=CURRENT_TIMESTAMP WHERE id=? AND status='active'").bind(id).run();
  return json({ success: true });
}

export async function handleResumeStagedRun(request, env, id) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'User is not provisioned in Whizz.' }, 403);
  await env.DB.prepare("UPDATE staged_campaign_runs SET status='active', lastNote='', nextRunAt=CURRENT_TIMESTAMP, updatedAt=CURRENT_TIMESTAMP WHERE id=? AND status='paused'").bind(id).run();
  return json({ success: true });
}

export async function handleCancelStagedRun(request, env, id) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'User is not provisioned in Whizz.' }, 403);
  await env.DB.prepare("UPDATE staged_campaign_runs SET status='cancelled', remainingContacts='[]', updatedAt=CURRENT_TIMESTAMP WHERE id=? AND status IN ('active','paused')").bind(id).run();
  return json({ success: true });
}

async function processOneStagedRun(env, run, accessToken) {
  const inbox = await env.DB.prepare('SELECT * FROM chatwoot_inboxes WHERE inboxId=?').bind(run.inboxId).first();
  if (!inbox || !inbox.phoneNumberId) {
    await env.DB.prepare("UPDATE staged_campaign_runs SET status='paused', lastNote=?, updatedAt=CURRENT_TIMESTAMP WHERE id=?")
      .bind('Paused — the number this was sending from is no longer configured.', run.id).run();
    return;
  }

  let remaining = JSON.parse(run.remainingContacts || '[]');
  if (!remaining.length) {
    await env.DB.prepare("UPDATE staged_campaign_runs SET status='completed', updatedAt=CURRENT_TIMESTAMP WHERE id=?").bind(run.id).run();
    return;
  }

  let batch = remaining.splice(0, run.batchSize);

  // Re-check opt-outs at send time, not just at creation — real time has passed since
  // this run was staged, and an opt-out is enforced unconditionally everywhere else.
  const optedOutSet = await getOptedOutSet(env, batch.map(c => c.phone));
  let skippedForOptOut = 0;
  if (optedOutSet.size) {
    const before = batch.length;
    batch = batch.filter(c => !optedOutSet.has(toSendableNumber(c.phone)));
    skippedForOptOut = before - batch.length;
  }

  if (inbox.dailySendCap > 0) {
    const sentToday = await sentTodayForInbox(env, inbox.inboxId);
    const quotaRemaining = Math.max(0, inbox.dailySendCap - sentToday);
    if (batch.length > quotaRemaining) {
      remaining = batch.slice(quotaRemaining).concat(remaining);
      batch = batch.slice(0, quotaRemaining);
    }
  }

  const template = { name: run.templateName, header: run.templateHeader, body: run.templateBody, footer: run.templateFooter };
  let sentCount = 0, failedCount = 0, permanentFailedCount = 0;

  for (const contact of batch) {
    let components;
    try { components = buildComponents(template, contact); }
    catch (_error) { failedCount++; continue; }
    const payload = {
      messaging_product: 'whatsapp',
      to: toSendableNumber(contact.phone),
      type: 'template',
      template: { name: run.templateName, language: { code: run.language }, ...(components.length ? { components } : {}) },
    };
    try {
      const response = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${inbox.phoneNumberId}/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const bucket = classifyMetaErrorCode(data.error?.code);
        if (bucket === 'permanent') permanentFailedCount++;
        failedCount++;
        try { await env.DB.prepare('INSERT INTO send_failures (phone,bucket,reason) VALUES (?,?,?)').bind(toSendableNumber(contact.phone), bucket, String(data.error?.message || '').slice(0, 200)).run(); } catch (_) {}
        continue;
      }
      sentCount++;
      const wamid = data.messages?.[0]?.id;
      if (contact.id) await env.DB.prepare('UPDATE contacts SET lastContactedAt=CURRENT_TIMESTAMP WHERE id=?').bind(contact.id).run();
      if (wamid) {
        try { await env.DB.prepare('INSERT INTO message_delivery_status (wamid,phone,status) VALUES (?,?,?) ON CONFLICT(wamid) DO NOTHING').bind(wamid, toSendableNumber(contact.phone), 'sent').run(); }
        catch (_) {}
      }
    } catch (_error) { failedCount++; }
  }

  const newSentTotal = run.sentCount + sentCount;
  const newFailedTotal = run.failedCount + failedCount;
  const newPermFailedTotal = run.permanentFailedCount + permanentFailedCount;
  const processedTotal = newSentTotal + newFailedTotal;
  const maxPermRate = (run.maxPermanentFailureRate ?? 8) / 100;
  const maxTotalRate = (run.maxTotalFailureRate ?? 15) / 100;
  const minSample = 20;

  let status = remaining.length ? 'active' : 'completed';
  let lastNote = skippedForOptOut ? `${skippedForOptOut} skipped this batch (opted out since staged)` : '';
  if (status === 'active' && processedTotal >= minSample
    && (newPermFailedTotal / processedTotal > maxPermRate || newFailedTotal / processedTotal > maxTotalRate)) {
    status = 'paused';
    lastNote = 'Auto-paused — delivery-risk failure rate exceeded the configured threshold.';
  }

  if (sentCount || failedCount) await logUserActivity(env, run.createdByEmail, 'staged_campaign_batch', sentCount, inbox.inboxId);

  await env.DB.prepare(`UPDATE staged_campaign_runs SET remainingContacts=?, sentCount=?, failedCount=?, permanentFailedCount=?,
    status=?, lastNote=?, nextRunAt=datetime('now','+' || ? || ' minutes'), updatedAt=CURRENT_TIMESTAMP WHERE id=?`)
    .bind(JSON.stringify(remaining), newSentTotal, newFailedTotal, newPermFailedTotal, status, lastNote, run.intervalMinutes, run.id)
    .run();
}

// Called from worker/index.js's scheduled() handler on the Cron Trigger set in
// wrangler.toml. Nothing happens until that's deployed — see the note there.
export async function processStagedCampaignRuns(env) {
  const accessToken = await loadMetaAccessToken(env);
  if (!accessToken) return; // Stays queued — retried on the next tick once Meta is connected.
  const due = await env.DB.prepare("SELECT * FROM staged_campaign_runs WHERE status='active' AND nextRunAt<=CURRENT_TIMESTAMP ORDER BY id").all();
  for (const run of due.results || []) {
    try { await processOneStagedRun(env, run, accessToken); }
    catch (error) {
      try { await env.DB.prepare('UPDATE staged_campaign_runs SET lastNote=?, updatedAt=CURRENT_TIMESTAMP WHERE id=?').bind(String(error.message || '').slice(0, 200), run.id).run(); }
      catch (_) {}
    }
  }
}
