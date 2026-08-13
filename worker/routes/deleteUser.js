import { removeEmailFromAccessPolicy } from '../lib/cloudflareAccess.js';

export async function handleDeleteUser(request, env) {
  const body = await request.json().catch(() => ({}));
  const email = String(body.email || '').trim().toLowerCase();
  if (!email) return Response.json({ error: 'email is required' }, { status: 400 });

  const result = await env.DB.prepare('DELETE FROM users WHERE email = ?1').bind(email).run();
  if (result.meta.rows_written === 0) return Response.json({ error: 'User not found' }, { status: 404 });

  let cloudflareSynced = true;
  let warning;
  try {
    await removeEmailFromAccessPolicy(env, email);
  } catch (err) {
    cloudflareSynced = false;
    warning = `User deleted from Whizz, but couldn't remove them from the Cloudflare Access policy automatically (${err.message}). Remove ${email} manually in the Zero Trust dashboard, or they can still sign in.`;
  }

  return Response.json({ success: true, cloudflareSynced, warning });
}
