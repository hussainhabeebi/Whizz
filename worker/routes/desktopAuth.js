// ── Desktop app authentication ──
// Every other route in this app trusts the Cf-Access-Authenticated-User-Email header that
// Cloudflare Access injects at the edge — fine for a browser visiting the hosted domain,
// but a local desktop app has no way to sit behind Cloudflare Access the same way. This
// module adds a second, narrower identity path (a long-lived Bearer token), handed out by
// either of two flows, and resolveDesktopAuthHeader() below maps a valid token back to the
// exact same header value every existing route handler already reads — so nothing else in
// the app needs to change.
//
// Flow 1, pairing: a short device-code handshake, the same shape used by CLI/TV-app OAuth
// device flows. The browser (already Access-authenticated) asks for a code, shows it on
// screen; the desktop app submits that code directly (it has no Access session) and gets
// back the real token exactly once. The token itself is never stored server-side in
// plaintext — only its SHA-256 hash, in desktop_auth — but the short-lived
// desktop_pairing_codes row does hold the plaintext token for the few minutes between
// "start" and "claim", since that's the one moment it has to be revealed to a device that
// isn't logged in yet.
//
// Flow 2, email OTP: lets someone log the desktop app in directly, without first opening a
// browser — type the email Whizz already provisioned for them, get a 6-digit code by email
// (reusing the same Resend credentials as the Email Marketing module), enter it, done. Only
// the code's SHA-256 hash is stored (desktop_otp_codes); requesting one never reveals
// whether that email is actually provisioned, and verifying has a 5-attempt cap per code so
// a 6-digit space can't be brute-forced before it expires.
import { loadResendApiKey } from './emailCampaigns.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
function json(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS }); }
function emailFromAccess(request) { return (request.headers.get('Cf-Access-Authenticated-User-Email') || '').trim().toLowerCase(); }

// Reuses the Email Marketing module's own Resend API key and From address — no separate
// credential for this. Throws if Email Marketing isn't connected yet, which
// handleDesktopOtpRequest surfaces as a clear error rather than silently doing nothing.
async function sendOtpEmail(env, email, name, code) {
  const apiKey = await loadResendApiKey(env);
  const settings = await env.DB.prepare('SELECT fromEmail,fromName FROM email_settings WHERE id=1').first();
  if (!apiKey || !settings?.fromEmail) throw new Error('Email Marketing isn\'t connected yet (needed to send login codes) — add a Resend API key and From address first.');
  const from = settings.fromName ? `${settings.fromName} <${settings.fromEmail}>` : settings.fromEmail;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from,
      to: [email],
      subject: `Your Whizz desktop login code: ${code}`,
      html: `<p>Hi ${name || ''},</p><p>Your Whizz desktop app login code is:</p><p style="font-size:28px;font-weight:700;letter-spacing:0.1em;">${code}</p><p style="color:#64748b;font-size:12px;">Expires in 10 minutes. If you didn't request this, you can ignore this email.</p>`,
    }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.message || `Resend API error (${response.status})`);
  }
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const b64 = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `wzd_${b64}`;
}
// Excludes 0/O/1/I/L — easy to read aloud and type without ambiguity.
const PAIRING_CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function randomPairingCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map(b => PAIRING_CODE_CHARS[b % PAIRING_CODE_CHARS.length]).join('');
}

async function currentUser(request, env) {
  const email = emailFromAccess(request);
  return email ? env.DB.prepare('SELECT email,name,role FROM users WHERE email=?').bind(email).first() : null;
}
function randomOtpCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  const num = new DataView(bytes.buffer).getUint32(0) % 1000000;
  return String(num).padStart(6, '0');
}

// Called from the browser (Access-authenticated) — Settings → "Pair a Desktop App".
export async function handleDesktopPairStart(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'User is not provisioned in Whizz.' }, 403);
  const body = await request.json().catch(() => ({}));
  const label = String(body.label || '').trim().slice(0, 80) || 'Desktop App';
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const code = randomPairingCode();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  // Starting a new pairing attempt invalidates any earlier, still-unclaimed code for this
  // same person — codes don't pile up just because one expired or they wanted a fresh one.
  await env.DB.prepare('DELETE FROM desktop_pairing_codes WHERE email=?').bind(user.email).run();
  await env.DB.prepare('INSERT INTO desktop_pairing_codes (code,email,label,tokenHash,token,expiresAt) VALUES (?,?,?,?,?,?)')
    .bind(code, user.email, label, tokenHash, token, expiresAt).run();
  return json({ code, expiresAt });
}

// Called directly by the desktop app — intentionally NOT Access-authenticated, since the
// whole point is that this device doesn't have an Access session yet. The pairing code is
// the one-time proof that whoever's running the desktop app also controls a real,
// Access-authenticated Whizz session (they had to see this code on screen there first).
export async function handleDesktopPairClaim(request, env) {
  const body = await request.json().catch(() => ({}));
  const code = String(body.code || '').trim().toUpperCase();
  if (!code) return json({ error: 'A pairing code is required.' }, 400);
  const row = await env.DB.prepare('SELECT * FROM desktop_pairing_codes WHERE code=?').bind(code).first();
  if (!row) return json({ error: 'Invalid or already-used pairing code.' }, 404);
  if (new Date(row.expiresAt).getTime() < Date.now()) {
    await env.DB.prepare('DELETE FROM desktop_pairing_codes WHERE code=?').bind(code).run();
    return json({ error: 'This pairing code has expired — generate a new one from Whizz.' }, 410);
  }
  await env.DB.prepare('INSERT INTO desktop_auth (tokenHash,email,label,createdAt,lastUsedAt) VALUES (?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)')
    .bind(row.tokenHash, row.email, row.label).run();
  await env.DB.prepare('DELETE FROM desktop_pairing_codes WHERE code=?').bind(code).run();
  return json({ token: row.token, email: row.email });
}

// ── Email OTP login — the direct alternative to pairing, for logging the desktop app in
// without first opening a browser. Not Access-authenticated, same reasoning as pair/claim
// above: this IS the login. ──
export async function handleDesktopOtpRequest(request, env) {
  const body = await request.json().catch(() => ({}));
  const email = String(body.email || '').trim().toLowerCase();
  if (!email) return json({ error: 'Email is required.' }, 400);
  const user = await env.DB.prepare('SELECT email,name FROM users WHERE email=?').bind(email).first();
  // Always return success whether or not this email is actually provisioned — an
  // unauthenticated caller should never be able to tell the two cases apart.
  if (user) {
    const existing = await env.DB.prepare('SELECT createdAt FROM desktop_otp_codes WHERE email=?').bind(email).first();
    // A short cooldown on an already-pending code, not a hard block — re-requesting a
    // moment later (a typo'd resend-click) just reuses the wait rather than erroring.
    if (!existing || Date.now() - new Date(existing.createdAt).getTime() > 30 * 1000) {
      const code = randomOtpCode();
      const codeHash = await sha256Hex(code);
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      await env.DB.prepare(`INSERT INTO desktop_otp_codes (email,codeHash,expiresAt,attempts,createdAt) VALUES (?,?,?,0,CURRENT_TIMESTAMP)
        ON CONFLICT(email) DO UPDATE SET codeHash=excluded.codeHash, expiresAt=excluded.expiresAt, attempts=0, createdAt=CURRENT_TIMESTAMP`)
        .bind(email, codeHash, expiresAt).run();
      try { await sendOtpEmail(env, email, user.name, code); }
      catch (error) { return json({ error: `Couldn't send the login code: ${error.message}` }, 502); }
    }
  }
  return json({ success: true });
}

export async function handleDesktopOtpVerify(request, env) {
  const body = await request.json().catch(() => ({}));
  const email = String(body.email || '').trim().toLowerCase();
  const code = String(body.code || '').trim();
  if (!email || !code) return json({ error: 'Email and code are required.' }, 400);
  const row = await env.DB.prepare('SELECT * FROM desktop_otp_codes WHERE email=?').bind(email).first();
  if (!row) return json({ error: 'Invalid or expired code.' }, 400);
  if (new Date(row.expiresAt).getTime() < Date.now()) {
    await env.DB.prepare('DELETE FROM desktop_otp_codes WHERE email=?').bind(email).run();
    return json({ error: 'This code has expired — request a new one.' }, 410);
  }
  if (row.attempts >= 5) {
    await env.DB.prepare('DELETE FROM desktop_otp_codes WHERE email=?').bind(email).run();
    return json({ error: 'Too many incorrect attempts — request a new code.' }, 429);
  }
  const codeHash = await sha256Hex(code);
  if (codeHash !== row.codeHash) {
    await env.DB.prepare('UPDATE desktop_otp_codes SET attempts=attempts+1 WHERE email=?').bind(email).run();
    return json({ error: 'Incorrect code.' }, 400);
  }
  await env.DB.prepare('DELETE FROM desktop_otp_codes WHERE email=?').bind(email).run();
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  await env.DB.prepare('INSERT INTO desktop_auth (tokenHash,email,label,createdAt,lastUsedAt) VALUES (?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)')
    .bind(tokenHash, email, 'Desktop App (email login)').run();
  return json({ token, email });
}

// Access-authenticated — Settings → "Desktop App" list. tokenHash is returned as the
// device's id: it's already one-way, so exposing it is harmless (it can't be used to
// authenticate) and it's exactly what revoke needs to target the right row.
export async function handleDesktopListDevices(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'User is not provisioned in Whizz.' }, 403);
  const result = await env.DB.prepare('SELECT tokenHash,label,createdAt,lastUsedAt FROM desktop_auth WHERE email=? AND revokedAt IS NULL ORDER BY createdAt DESC')
    .bind(user.email).all();
  const devices = (result.results || []).map(r => ({ id: r.tokenHash, label: r.label, createdAt: r.createdAt, lastUsedAt: r.lastUsedAt }));
  return json({ devices });
}

export async function handleDesktopRevokeDevice(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'User is not provisioned in Whizz.' }, 403);
  const body = await request.json().catch(() => ({}));
  const id = String(body.id || '');
  if (!id) return json({ error: 'id is required.' }, 400);
  const result = await env.DB.prepare('UPDATE desktop_auth SET revokedAt=CURRENT_TIMESTAMP WHERE tokenHash=? AND email=? AND revokedAt IS NULL')
    .bind(id, user.email).run();
  if (!result.meta.changes) return json({ error: 'Device not found.' }, 404);
  return json({ success: true });
}

// Widens identity at the very top of the request pipeline: if a request already carries a
// real Cloudflare Access header (every browser request), it's left untouched. Otherwise, a
// valid `Authorization: Bearer <token>` is resolved to the same header every other route
// already reads — so every existing handler keeps working completely unchanged, whether the
// caller is a browser behind Access or a paired desktop app presenting its token. Fails
// open (returns the original, unmodified request) on any lookup error so a transient D1
// hiccup degrades to "not authenticated" rather than crashing the whole request.
export async function resolveDesktopAuthHeader(request, env) {
  if (emailFromAccess(request)) return request;
  const authHeader = request.headers.get('authorization') || request.headers.get('Authorization');
  if (!authHeader || !/^bearer\s+/i.test(authHeader)) return request;
  const token = authHeader.replace(/^bearer\s+/i, '').trim();
  if (!token) return request;
  try {
    const tokenHash = await sha256Hex(token);
    const row = await env.DB.prepare('SELECT email FROM desktop_auth WHERE tokenHash=? AND revokedAt IS NULL').bind(tokenHash).first();
    if (!row) return request;
    await env.DB.prepare('UPDATE desktop_auth SET lastUsedAt=CURRENT_TIMESTAMP WHERE tokenHash=?').bind(tokenHash).run();
    const headers = new Headers(request.headers);
    headers.set('Cf-Access-Authenticated-User-Email', row.email);
    return new Request(request, { headers });
  } catch (_) {
    return request;
  }
}
