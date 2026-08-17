import { handleGetContacts } from './routes/getContacts.js';
import { handleGetEnquiries } from './routes/getEnquiries.js';
import { handleAppendMemory } from './routes/appendMemory.js';
import { handleUsers, handleCreateUser, handleUpdateUser, handleDeleteUser, handleResetUserAccess, handleSyncUserAccess } from './routes/users.js';
import { handleAutomation } from './routes/automation.js';

// Routes migrated off n8n live here, one at a time. Anything not matched
// falls through to the static site assets (index.html, css/, js/) exactly
// as before this file existed.
const routes = [
  { method: 'GET', path: '/whizz-get-contacts', handler: handleGetContacts },
  { method: 'GET', path: '/whizz-get-enquiries', handler: handleGetEnquiries },
  { method: 'POST', path: '/whizz-append-memory', handler: handleAppendMemory },
  { method: 'GET', path: '/api/users', handler: handleUsers },
  { method: 'POST', path: '/api/users', handler: handleCreateUser },
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const automationMatch = url.pathname.match(/^\/api\/automation\/([a-z0-9-]+)$/i);
    if (automationMatch) {
      try { return await handleAutomation(request, env, automationMatch[1]); }
      catch (err) { return Response.json({ error: err.message }, { status: 502 }); }
    }
    const userMatch = url.pathname.match(/^\/api\/users\/([^/]+)(?:\/(reset-access|sync-access))?$/);
    if (userMatch) {
      const email = decodeURIComponent(userMatch[1]).trim().toLowerCase();
      try {
        if (request.method === 'PUT' && !userMatch[2]) return await handleUpdateUser(request, env, email);
        if (request.method === 'DELETE' && !userMatch[2]) return await handleDeleteUser(request, env, email);
        if (request.method === 'POST' && userMatch[2] === 'reset-access') return await handleResetUserAccess(request, env, email);
        if (request.method === 'POST' && userMatch[2] === 'sync-access') return await handleSyncUserAccess(request, env, email);
      } catch (err) { return Response.json({ error: err.message }, { status: 500 }); }
    }
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
