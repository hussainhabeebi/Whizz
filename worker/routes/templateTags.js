// ── Template → inbox tagging ──
// WhatsApp template approval happens per Meta WABA/number, so a template approved for one
// Chatwoot inbox's number may not be approved for another's. The templates themselves
// (name/body/language/approval) still live in n8n/Meta — this just tags which inbox a
// template name is scoped to, purely local to Whizz, so pickers can filter by number.
// An untagged template is treated as valid for every number (keeps existing templates
// working unchanged until someone tags them).
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
function json(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS }); }
function emailFromAccess(request) { return (request.headers.get('Cf-Access-Authenticated-User-Email') || '').trim().toLowerCase(); }

async function currentUser(request, env) {
  const email = emailFromAccess(request);
  return email ? env.DB.prepare('SELECT email,name,role,teamId FROM users WHERE email=?').bind(email).first() : null;
}

export async function handleGetTemplateTags(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'User is not provisioned in Whizz.' }, 403);
  const result = await env.DB.prepare('SELECT templateName,inboxId FROM template_inbox_tags').all();
  const tags = {};
  for (const row of result.results || []) tags[row.templateName] = row.inboxId;
  return json({ tags });
}

export async function handleSetTemplateTag(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'User is not provisioned in Whizz.' }, 403);
  const body = await request.json().catch(() => ({}));
  const templateName = String(body.templateName || '').trim();
  const inboxId = String(body.inboxId || '').trim();
  if (!templateName) return json({ error: 'Template name is required.' }, 400);
  if (!inboxId) {
    await env.DB.prepare('DELETE FROM template_inbox_tags WHERE templateName=?').bind(templateName).run();
    return json({ success: true });
  }
  await env.DB.prepare(`INSERT INTO template_inbox_tags (templateName,inboxId,updatedAt) VALUES (?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(templateName) DO UPDATE SET inboxId=excluded.inboxId, updatedAt=CURRENT_TIMESTAMP`)
    .bind(templateName, inboxId).run();
  return json({ success: true });
}
