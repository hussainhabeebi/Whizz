import { addEmailToAccessPolicy } from '../lib/cloudflareAccess.js';

export async function handleAddUser(request, env) {
  const body = await request.json().catch(() => ({}));
  const email = String(body.email || '').trim().toLowerCase();
  const name = String(body.name || '').trim();
  const role = String(body.role || 'Sales').trim();
  const allowedBrands = Array.isArray(body.allowedBrands) ? body.allowedBrands : [];
  const allowedPlatforms = Array.isArray(body.allowedPlatforms) ? body.allowedPlatforms : [];

  if (!email || !name) return Response.json({ error: 'email and name are required' }, { status: 400 });

  const existing = await env.DB.prepare('SELECT email FROM users WHERE email = ?1').bind(email).first();
  if (existing) return Response.json({ error: 'A user with this email already exists' }, { status: 409 });

  await env.DB.prepare(
    'INSERT INTO users (email, name, role, allowedBrands, allowedPlatforms) VALUES (?1, ?2, ?3, ?4, ?5)'
  ).bind(email, name, role, JSON.stringify(allowedBrands), JSON.stringify(allowedPlatforms)).run();

  let cloudflareSynced = true;
  let warning;
  try {
    await addEmailToAccessPolicy(env, email);
  } catch (err) {
    cloudflareSynced = false;
    warning = `User added, but couldn't add them to the Cloudflare Access policy automatically (${err.message}). Add ${email} manually in the Zero Trust dashboard, or they won't be able to sign in.`;
  }

  return Response.json({ success: true, cloudflareSynced, warning });
}
