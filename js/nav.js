// ── Routing Navigation ──
function navigate(page, el) {
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-item,.nav-ext').forEach(n=>n.classList.remove('active'));
  document.getElementById('page-'+page).classList.add('active');
  if(el)el.classList.add('active');
  if(page!=='conversations' && S.liveSync) stopLiveSync();
  const titles={dashboard:'Dashboard',onboarding:'Setup Checklist',campaigns:'Campaigns',history:'Campaign History',templates:'Templates',conversations:'Conversations',reports:'Reports',leads:'Leads',stock:'Stock Evaluation',suggestions:'Broadcast Suggestions',discovery:'Contact Discovery',users:'User Management',pipeline:'Lead Pipeline'};
  document.getElementById('page-title').textContent=titles[page]||page;
  S.page=page; closeSidebar();
  if(page==='campaigns'&&S.cache.groups){S.groups=S.cache.groups;renderCampGroups(S.cache.groups);hideBanner('camp');}
  if(page==='campaigns'&&S.cache.templates){S.templates=S.cache.templates;renderCampTemplates(S.cache.templates);}
  if(page==='leads'&&S.cache.groups){renderLeadsPage(S.cache.groups,S.cache.leadsTotal);hideBanner('leads');}
  if(page==='conversations'&&S.cache.conversations){renderConvs(S.cache.conversations);hideBanner('conv');}
  if(page==='templates'&&S.cache.templates){renderTplPage(S.cache.templates);hideBanner('tpl');}
  if(page==='reports' && (S.cache.stats || S.cache.crossTabMatrix)){renderReports();hideBanner('rep');}
  if(page==='stock'&&S.cache.stock){renderStockPage();hideBanner('stock');}
  if(page==='suggestions'){refreshSuggestions();}
  if(page==='discovery'){renderDiscoveryResults(S.discoveredContacts||[]);}
  if(page==='users'){renderUsersPage();}
  if(page==='pipeline'){renderPipelinePage();}
  if(page==='history'){renderScheduledList();}
}
function toggleSidebar(){document.getElementById('sidebar').classList.toggle('open');document.getElementById('sidebar-overlay').classList.toggle('show');}
function closeSidebar(){document.getElementById('sidebar').classList.remove('open');document.getElementById('sidebar-overlay').classList.remove('show');}

// Lead Intelligence is intentionally a standalone page so directory sessions and
// credential management remain isolated from the main CRM state.
window.addEventListener('DOMContentLoaded',()=>{
  const nav=document.querySelector('.sidebar-nav');
  if(!nav || nav.querySelector('[data-lead-intelligence]')) return;
  const link=document.createElement('a');
  link.className='nav-ext';
  link.dataset.leadIntelligence='1';
  link.href='/lead-intelligence.html';
  link.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/><circle cx="12" cy="12" r="4"/></svg><span>Lead Intelligence</span>';
  const firstSection=nav.querySelector('.nav-section');
  if(firstSection) nav.insertBefore(link,firstSection); else nav.appendChild(link);
});
