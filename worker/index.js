import { handleGetContacts } from './routes/getContacts.js';

// Routes migrated off n8n live here, one at a time. Anything not matched
// falls through to the static site assets (index.html, css/, js/) exactly
// as before this file existed.
const routes = [
  { method: 'GET', path: '/whizz-get-contacts', handler: handleGetContacts },
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const route = routes.find(r => r.method === request.method && r.path === url.pathname);
    if (route) {
      try {
        return await route.handler(request, env);
      } catch (err) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }
    return env.ASSETS.fetch(request);
  },
};
