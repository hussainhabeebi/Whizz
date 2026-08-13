// Called by the external WhatsApp chatbot workflow on every message, replacing
// the Google Sheets "append row to Memory tab" step it used before. Append-only,
// same as the sheet was — whizz-get-enquiries does the per-phone collapsing at read time.
export async function handleAppendMemory(request, env) {
  const body = await request.json().catch(() => ({}));
  const phone = String(body.phone || body.Phone || '').trim();
  const name = String(body.name || body.Name || '').trim();
  const history = String(body.history || body.History || '');

  if (!phone) return Response.json({ error: 'phone is required' }, { status: 400 });

  await env.DB.prepare('INSERT INTO memory (phone, name, history) VALUES (?1, ?2, ?3)')
    .bind(phone, name, history)
    .run();

  return Response.json({ success: true });
}
