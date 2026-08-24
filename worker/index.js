import { handleGetContacts } from './routes/getContacts.js';
import { handleGetEnquiries } from './routes/getEnquiries.js';
import { handleAppendMemory } from './routes/appendMemory.js';
import { handleUsers, handleCreateUser, handleUpdateUser, handleDeleteUser, handleResetUserAccess, handleSyncUserAccess } from './routes/users.js';
import { handleAutomation } from './routes/automation.js';
import { handleConversationAssignment } from './routes/conversationAssignments.js';
import { handleIFABookingCreate, handleIFABookingList } from './routes/ifaBookings.js';
import { handleLeadIntelligence } from './routes/leadIntelligence.js';
import { ensureDatabaseSchema } from './dbSchema.js';

const routes = [
  { method: 'GET', path: '/whizz-get-contacts', handler: handleGetContacts },
  { method: 'GET', path: '/whizz-get-enquiries', handler: handleGetEnquiries },
  { method: 'POST', path: '/whizz-append-memory', handler: handleAppendMemory },
  { method: 'GET', path: '/api/users', handler: handleUsers },
  { method: 'POST', path: '/api/users', handler: handleCreateUser },
  { method: 'POST', path: '/api/ifa-bookings', handler: handleIFABookingCreate },
  { method: 'GET', path: '/api/ifa-bookings', handler: handleIFABookingList },
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/whizz-')) {
      try { await ensureDatabaseSchema(env); }
      catch (err) { return Response.json({ error: `D1 schema repair failed: ${err.message}` }, { status: 503 }); }
    }

    const leadSourceMatch = url.pathname.match(/^\/api\/lead-intelligence\/sources\/([a-z0-9-]+)$/i);
    if (leadSourceMatch && request.method === 'PUT') {
      try { return await handleLeadIntelligence(request, env, 'source', leadSourceMatch[1]); }
      catch (err) { return Response.json({ error: err.message }, { status: 500 }); }
    }
    const leadRunMatch = url.pathname.match(/^\/api\/lead-intelligence\/run\/([a-z0-9-]+)$/i);
    if (leadRunMatch && request.method === 'POST') {
      try { return await handleLeadIntelligence(request, env, 'run', leadRunMatch[1]); }
      catch (err) { return Response.json({ error: err.message }, { status: 500 }); }
    }
    const leadPromoteMatch = url.pathname.match(/^\/api\/lead-intelligence\/prospects\/(\d+)\/promote$/);
    if (leadPromoteMatch && request.method === 'POST') {
      try { return await handleLeadIntelligence(request, env, 'promote', leadPromoteMatch[1]); }
      catch (err) { return Response.json({ error: err.message }, { status: 500 }); }
    }
    if (url.pathname === '/api/lead-intelligence/sources' && request.method === 'GET') {
      try { return await handleLeadIntelligence(request, env, 'sources'); }
      catch (err) { return Response.json({ error: err.message }, { status: 500 }); }
    }
    if (url.pathname === '/api/lead-intelligence/prospects' && request.method === 'GET') {
      try { return await handleLeadIntelligence(request, env, 'prospects'); }
      catch (err) { return Response.json({ error: err.message }, { status: 500 }); }
    }
    if (url.pathname === '/api/lead-intelligence/import' && request.method === 'POST') {
      try { return await handleLeadIntelligence(request, env, 'import'); }
      catch (err) { return Response.json({ error: err.message }, { status: 500 }); }
    }
    if (url.pathname === '/api/lead-intelligence/callback' && request.method === 'POST') {
      try { return await handleLeadIntelligence(request, env, 'callback'); }
      catch (err) { return Response.json({ error: err.message }, { status: 500 }); }
    }

    const automationMatch = url.pathname.match(/^\/api\/automation\/([a-z0-9-]+)$/i);
    if (automationMatch) {
      try { return await handleAutomation(request, env, automationMatch[1]); }
      catch (err) { return Response.json({ error: err.message }, { status: 502 }); }
    }
    const assignmentMatch = url.pathname.match(/^\/api\/conversation-assignments\/([^/]+)$/);
    if (assignmentMatch && request.method === 'PUT') {
      try { return await handleConversationAssignment(request, env, decodeURIComponent(assignmentMatch[1])); }
      catch (err) { return Response.json({ error: err.message }, { status: 500 }); }
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
