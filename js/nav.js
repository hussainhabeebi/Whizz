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
