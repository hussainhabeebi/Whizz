// ── API Gateway Base Call ──
async function api(path,method='GET',body=null){const opts={method,headers:{'Content-Type':'application/json'},credentials:'include'};if(body)opts.body=JSON.stringify(body);const r=await fetch(`/api/automation/${path}`,opts);const txt=await r.text();let data;try{data=txt?JSON.parse(txt):{success:true};}catch{data={success:true};}if(!r.ok)throw new Error(data.error||'HTTP Status Error '+r.status);return data;}

// ── Global Refresh Orchestrator ──
async function refreshPage() {
  const btn=document.getElementById('refresh-btn'),icon=document.getElementById('refresh-icon');
  btn.disabled=true;icon.classList.add('spin');
  try {
    const p=S.page;
    if(p==='dashboard')await refreshDashboard();
    else if(p==='campaigns')await refreshCampaign();
    else if(p==='templates')await refreshTemplates();
    else if(p==='conversations')await refreshConversations();
    else if(p==='reports')await refreshReportsPage();
    else if(p==='leads')await refreshLeads();
    else if(p==='history')renderHistoryList();
    else if(p==='stock')await refreshStock();
    else if(p==='suggestions'){await refreshStock();refreshSuggestions();}
    else if(p==='discovery')runDiscovery();
    saveCache();
    document.getElementById('last-upd').textContent='Updated '+new Date().toLocaleTimeString('en-AE',{hour:'2-digit',minute:'2-digit'});
    hideBanner(p==='dashboard'?'dash':p==='campaigns'?'camp':p);
  } catch(e){showToast('Network synchronization failed','error');console.error(e);}
  btn.disabled=false;icon.classList.remove('spin');
}

async function refreshDashboard(){await Promise.all([refreshStats(),refreshDashConvData(),refreshLeadData()]);}
async function refreshStats(){const d=await api('whizz-get-stats');S.cache.stats=d;renderStats(d);const cnt=d.open||0;if(cnt>0){document.getElementById('open-count').textContent=cnt;document.getElementById('open-count').style.display='inline';addNotif(`${cnt} operational conversations pending response`);}}
async function refreshDashConvData(){const d=await api('whizz-get-conversations?status=open');S.cache.conversations=d.conversations||[];renderDashConvs(S.cache.conversations);}
async function refreshLeadData(){
  const d=await api('whizz-get-leads');
  S.cache.groups=d.groups||[];
  S.cache.crossTabMatrix=d.crossTabMatrix||[];
  S.cache.leadsTotal=d.totalDistributedItems || d.total || 0;
  S.cache.platforms=d.platforms||[];
  S.cache.countries=d.countries||[];
  S.cache.brands=d.brands||[];
  S.groups=S.cache.groups;
  S.crossTabMatrix=S.cache.crossTabMatrix;
  S.platforms=S.cache.platforms;
  S.countries=S.cache.countries;
  S.brands=S.cache.brands;
  const{allowedBrands:_ab,allowedPlatforms:_ap}=getCurrentUserRestrictions();
  let _filtG=S.cache.groups||[];
  if(_ab.length>0)_filtG=_filtG.filter(g=>_ab.includes(g.brand));
  if(_ap.length>0)_filtG=_filtG.filter(g=>_ap.includes(g.platform));
  const _filtTotal=_filtG.reduce((sum,g)=>sum+g.count,0);
  const _filtPlatforms=[...new Set(_filtG.map(g=>g.platform))];
  document.getElementById('stat-leads').textContent=_filtTotal||S.cache.leadsTotal;
  document.getElementById('stat-platforms').textContent=_filtPlatforms.length||(S.cache.platforms||[]).length;
  renderDashCountries(_filtG);
}
async function refreshConversations(){const d=await api(`whizz-get-conversations?status=${S.convStatus}`);S.cache.conversations=d.conversations||[];renderConvs(S.cache.conversations);}
async function refreshCampaign(){await Promise.all([refreshLeadData(),refreshTemplates()]);}
async function refreshTemplates(){const d=await api('whizz-get-templates');S.cache.templates=d.templates||[];S.templates=S.cache.templates;renderTplPage(S.cache.templates);renderCampTemplates(S.cache.templates);}
async function refreshLeads(){await refreshLeadData();renderLeadsPage(S.cache.groups,S.cache.leadsTotal);}
async function refreshReportsPage(){await Promise.all([refreshStats(),refreshLeadData()]);renderReports();}
