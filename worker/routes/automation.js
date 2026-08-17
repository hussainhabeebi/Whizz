const WRITE_ROLES = {
  'whizz-send-campaign': ['Administrator', 'Manager'],
  'whizz-create-template': ['Administrator', 'Manager'],
  'whizz-ai-template': ['Administrator', 'Manager'],
  'whizz-discover-contacts': ['Administrator', 'Manager'],
  'whizz-save-integration': ['Administrator'],
  'whizz-delete-integration': ['Administrator'],
};

function emailFromAccess(request) {
  return (request.headers.get('Cf-Access-Authenticated-User-Email') || '').trim().toLowerCase();
}

export async function handleAutomation(request, env, endpoint) {
  const email = emailFromAccess(request);
  const user = email ? await env.DB.prepare('SELECT email,role FROM users WHERE email=?').bind(email).first() : null;
  if (!user) return Response.json({ error: 'Authenticated user is not provisioned in Whizz.' }, { status: 403 });

  const allowedRoles = WRITE_ROLES[endpoint];
  if (allowedRoles && !allowedRoles.includes(user.role)) {
    return Response.json({ error: `${user.role} users cannot perform this operation.` }, { status: 403 });
  }

  const base = (env.N8N_WEBHOOK_BASE || 'https://n8n.aiingo.com/webhook').replace(/\/$/, '');
  const sourceUrl = new URL(request.url);
  const target = new URL(`${base}/${encodeURIComponent(endpoint)}`);
  target.search = sourceUrl.search;
  const headers = new Headers();
  headers.set('content-type', request.headers.get('content-type') || 'application/json');
  headers.set('x-whizz-user-email', user.email);
  headers.set('x-whizz-user-role', user.role);
  const response = await fetch(target, {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    redirect: 'follow',
  });
  const responseHeaders = new Headers(response.headers);
  responseHeaders.set('cache-control', 'no-store');
  return new Response(response.body, { status: response.status, headers: responseHeaders });
}
