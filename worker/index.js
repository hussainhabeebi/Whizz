import { handleGetContacts } from './routes/getContacts.js';
import { handleGetEnquiries } from './routes/getEnquiries.js';
import { handleAppendMemory } from './routes/appendMemory.js';
import { handleGetUsers } from './routes/getUsers.js';
import { handleAddUser } from './routes/addUser.js';
import { handleUpdateUser } from './routes/updateUser.js';
import { handleDeleteUser } from './routes/deleteUser.js';

// Routes migrated off n8n live here, one at a time. Anything not matched
// falls through to the static site assets (index.html, css/, js/) exactly
// as before this file existed.
const routes = [
  { method: 'GET', path: '/whizz-get-contacts', handler: handleGetContacts },
  { method: 'GET', path: '/whizz-get-enquiries', handler: handleGetEnquiries },
  { method: 'POST', path: '/whizz-append-memory', handler: handleAppendMemory },
  { method: 'GET', path: '/whizz-get-users', handler: handleGetUsers },
  { method: 'POST', path: '/whizz-add-user', handler: handleAddUser },
  { method: 'POST', path: '/whizz-update-user', handler: handleUpdateUser },
  { method: 'POST', path: '/whizz-delete-user', handler: handleDeleteUser },
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
