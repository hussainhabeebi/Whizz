import { handleGetContacts } from './routes/getContacts.js';
import { handleMarkConversion } from './routes/markConversion.js';
import { handleGetConversionStats } from './routes/getConversionStats.js';
import { handleGetEnquiries } from './routes/getEnquiries.js';
import { handleAppendMemory } from './routes/appendMemory.js';
import { handleMe, handleUsers, handleCreateUser, handleUpdateUser, handleDeleteUser, handleResetUserAccess, handleSyncUserAccess } from './routes/users.js';
import { handleAutomation } from './routes/automation.js';
import { handleConversationAssignment } from './routes/conversationAssignments.js';
import { handleIFABookingCreate, handleIFABookingList } from './routes/ifaBookings.js';
import { handleLeadIntelligence } from './routes/leadIntelligence.js';
import { ensureDatabaseSchema } from './dbSchema.js';

const routes = [
  { method: 'GET', path: '/whizz-get-contacts', handler: handleGetContacts },
  { method: 'POST', path: '/whizz-mark-conversion', handler: handleMarkConversion },
  { method: 'GET', path: '/api/conversion-stats', handler: handleGetConversionStats },
  { method: 'GET', path: '/whizz-get-enquiries', handler: handleGetEnquiries },
  { method: 'POST', path: '/whizz-append-memory', handler: handleAppendMemory },
  { method: 'GET', path: '/api/me', handler: handleMe },
  { method: 'GET', path: '/api/users', handler: handleUsers },
  { method: 'POST', path: '/api/users', handler: handleCreateUser },
  { method: 'POST', path: '/api/ifa-bookings', handler: handleIFABookingCreate },
  { method: 'GET', path: '/api/ifa-bookings', handler: handleIFABookingList },
];

async function leadActor(request, env) {
  const email = (request.headers.get('Cf-Access-Authenticated-User-Email') || '').trim().toLowerCase();
  if (!email) return null;
  return env.DB.prepare('SELECT email,name,role,teamId FROM users WHERE email=?').bind(email).first();
}
async function requireLeadRole(request, env, adminOnly = false) {
  const actor = await leadActor(request, env);
  if (!actor) return { error: Response.json({ error: 'User is not provisioned in Whizz.' }, { status: 403 }) };
  if (adminOnly && actor.role !== 'Administrator') return { error: Response.json({ error: 'Administrator access required.' }, { status: 403 }) };
  if (!adminOnly && !['Administrator','Manager','Sales'].includes(actor.role)) return { error: Response.json({ error: 'Lead Intelligence access denied.' }, { status: 403 }) };
  return { actor };
}

const LEADS_TABLE_INLINE = `<script>
(()=>{
const style=document.createElement('style');
style.textContent=\`
#page-leads #leads-groups.leads-list-mode{display:block!important}
#page-leads .leads-list-wrap{overflow:auto;border:1px solid var(--border);border-radius:12px;background:var(--bg2)}
#page-leads .leads-list-table{width:100%;min-width:720px;border-collapse:collapse;font-size:12px}
#page-leads .leads-list-table th{padding:10px 14px;background:var(--bg3);border-bottom:1px solid var(--border2);color:var(--text3);font-size:10px;text-transform:uppercase;letter-spacing:.06em;text-align:left}
#page-leads .leads-list-table td{padding:11px 14px;border-bottom:1px solid var(--border);vertical-align:middle}
#page-leads .leads-list-table tbody tr{cursor:pointer}
#page-leads .leads-list-table tbody tr:hover{background:var(--accent-dim)}
#page-leads .leads-list-table tbody tr:last-child td{border-bottom:0}
#page-leads .leads-list-table th:nth-child(4),#page-leads .leads-list-table td:nth-child(4){text-align:right}
#page-leads .lead-list-platform{color:var(--accent);font-weight:700}
#page-leads .lead-list-count{font:700 17px var(--font-display);color:var(--text)}
#page-leads .lead-list-trend{display:inline-flex;padding:3px 8px;border-radius:999px;font-size:10px;font-weight:700}
#page-leads .lead-list-trend.up{background:var(--green-dim);color:var(--green)}
#page-leads .lead-list-trend.down{background:var(--red-dim);color:var(--red)}
#page-leads .lead-list-trend.stable{background:var(--bg4);color:var(--text2)}
#page-leads .lead-list-view{border:1px solid var(--border2);background:var(--bg2);color:var(--text2);border-radius:7px;padding:5px 11px;font:600 11px var(--font);cursor:pointer}
#page-leads .lead-list-view:hover{border-color:var(--accent);color:var(--accent);background:var(--accent-dim)}
\`;
document.head.appendChild(style);
const esc=s=>String(s??'').replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]));
function convert(){
 const box=document.getElementById('leads-groups');
 if(!box||box.querySelector('.leads-list-table'))return;
 const cards=[...box.querySelectorAll(':scope > .group-card')];
 if(!cards.length)return;
 const data=cards.map(card=>({
   platform:card.querySelector('.g-platform')?.textContent?.trim()||'',
   country:card.querySelector('.g-country')?.textContent?.trim()||'',
   brand:card.querySelector('.g-brand')?.getAttribute('title')||card.querySelector('.g-brand')?.textContent?.trim()||'',
   count:card.querySelector('.g-count')?.textContent?.trim()||'0',
   trend:card.querySelector('.g-trend')?.textContent?.trim()||'→ 0%',
   cls:card.querySelector('.g-trend')?.classList.contains('up')?'up':card.querySelector('.g-trend')?.classList.contains('down')?'down':'stable'
 }));
 box.classList.add('leads-list-mode');
 box.innerHTML='<div class="leads-list-wrap"><table class="leads-list-table"><thead><tr><th>Platform</th><th>Region</th><th>Brand</th><th>Leads</th><th>Trend</th><th style="text-align:right">Action</th></tr></thead><tbody>'+data.map((r,i)=>'<tr data-i="'+i+'"><td><span class="lead-list-platform">'+esc(r.platform)+'</span></td><td>'+esc(r.country)+'</td><td>'+esc(r.brand)+'</td><td><span class="lead-list-count">'+esc(r.count)+'</span></td><td><span class="lead-list-trend '+r.cls+'">'+esc(r.trend)+'</span></td><td style="text-align:right"><button type="button" class="lead-list-view">View</button></td></tr>').join('')+'</tbody></table></div>';
 box.querySelectorAll('tbody tr').forEach(tr=>{
   const i=Number(tr.dataset.i),original=cards[i];
   const run=()=>{ if(original&&typeof original.onclick==='function') original.onclick.call(original,new MouseEvent('click',{bubbles:true})); else original?.click(); };
   tr.addEventListener('click',e=>{if(e.target.closest('button'))return;run();});
   tr.querySelector('button')?.addEventListener('click',e=>{e.stopPropagation();run();});
 });
}
const observer=new MutationObserver(()=>convert());
observer.observe(document.body,{childList:true,subtree:true});
setTimeout(convert,50);
})();
</script>`;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/whizz-')) {
      try { await ensureDatabaseSchema(env); }
      catch (err) { return Response.json({ error: `D1 schema repair failed: ${err.message}` }, { status: 503 }); }
    }

    if (url.pathname === '/api/lead-intelligence/callback' && request.method === 'POST') {
      try { return await handleLeadIntelligence(request, env, 'callback'); }
      catch (err) { return Response.json({ error: err.message }, { status: 500 }); }
    }

    if (url.pathname.startsWith('/api/lead-intelligence/')) {
      const adminOnly = request.method === 'PUT' || url.pathname.includes('/run/') || url.pathname === '/api/lead-intelligence/import' || url.pathname === '/api/lead-intelligence/sources';
      const access = await requireLeadRole(request, env, adminOnly);
      if (access.error) return access.error;
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
        try {
          const body = JSON.stringify({ ownerEmail: access.actor.email });
          const forwarded = new Request(request.url, { method:'POST', headers:request.headers, body });
          return await handleLeadIntelligence(forwarded, env, 'promote', leadPromoteMatch[1]);
        } catch (err) { return Response.json({ error: err.message }, { status: 500 }); }
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
      try { return await route.handler(request, env); }
      catch (err) { return Response.json({ error: err.message }, { status: 500 }); }
    }

    const assetResponse = await env.ASSETS.fetch(request);
    const contentType = assetResponse.headers.get('content-type') || '';
    if (request.method === 'GET' && contentType.includes('text/html') && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = await assetResponse.text();
      const injected = html.replace('</body>', `${LEADS_TABLE_INLINE}\n<script src="/js/auto-refresh.js?v=20260826-3"></script>\n</body>`);
      const headers = new Headers(assetResponse.headers);
      headers.delete('content-length');
      headers.set('cache-control', 'no-store, no-cache, must-revalidate');
      return new Response(injected, { status: assetResponse.status, statusText: assetResponse.statusText, headers });
    }
    return assetResponse;
  },
};