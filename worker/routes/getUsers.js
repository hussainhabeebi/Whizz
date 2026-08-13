export async function handleGetUsers(request, env) {
  const { results } = await env.DB.prepare('SELECT email, name, role, allowedBrands, allowedPlatforms FROM users').all();
  const users = results.map(r => ({
    email: r.email,
    name: r.name,
    role: r.role,
    allowedBrands: JSON.parse(r.allowedBrands || '[]'),
    allowedPlatforms: JSON.parse(r.allowedPlatforms || '[]'),
  }));
  return Response.json({ users });
}
