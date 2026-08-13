// Syncs the "who can reach the app" gate (Cloudflare Access policy Include list)
// with the "who's provisioned in Whizz" list (D1 users table) — so adding/removing
// a user in the app also grants/revokes their ability to sign in at all.
function policyUrl(env) {
  return `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/access/apps/${env.CF_ACCESS_APP_ID}/policies/${env.CF_ACCESS_POLICY_ID}`;
}

async function getPolicy(env) {
  const resp = await fetch(policyUrl(env), {
    headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` },
  });
  const data = await resp.json();
  if (!resp.ok || !data.success) throw new Error(`Cloudflare API error (${resp.status}): ${JSON.stringify(data.errors || data)}`);
  return data.result;
}

async function putPolicy(env, policy) {
  const resp = await fetch(policyUrl(env), {
    method: 'PUT',
    headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(policy),
  });
  const data = await resp.json();
  if (!resp.ok || !data.success) throw new Error(`Cloudflare API error (${resp.status}): ${JSON.stringify(data.errors || data)}`);
  return data.result;
}

function emailInclude(email) {
  return { email: { email } };
}

export async function addEmailToAccessPolicy(env, email) {
  const policy = await getPolicy(env);
  const already = (policy.include || []).some(r => r.email && r.email.email === email);
  if (already) return;
  policy.include = [...(policy.include || []), emailInclude(email)];
  await putPolicy(env, policy);
}

export async function removeEmailFromAccessPolicy(env, email) {
  const policy = await getPolicy(env);
  policy.include = (policy.include || []).filter(r => !(r.email && r.email.email === email));
  await putPolicy(env, policy);
}
