// ── Campaign Builder Logic ──
function renderChips(list,containerId,activeProp,filterFn) {
  const el = document.getElementById(containerId);
  el.innerHTML = ['ALL', ...list].map(v => `<div class="chip ${S[activeProp] === v ? 'active' : ''}" onclick="${filterFn}('${v.replace(/'/g, "\\'")}', this)">${v}</div>`).join('');
}
function filterByPlatform(v,el){document.querySelectorAll('#platform-chips .chip').forEach(c=>c.classList.remove('active'));el.classList.add('active');S.activePlatform=v;applyGroupFilters();}
function filterByCountry(v,el){document.querySelectorAll('#country-chips .chip').forEach(c=>c.classList.remove('active'));el.classList.add('active');S.activeCountry=v;applyGroupFilters();}
function filterByBrand(v,el){document.querySelectorAll('#brand-chips .chip').forEach(c=>c.classList.remove('active'));el.classList.add('active');S.activeBrand=v;applyGroupFilters();}
function applyGroupFilters(){
  let f=S.groups;
  if(S.activePlatform!=='ALL') f=f.filter(g=>g.platform===S.activePlatform);
  if(S.activeCountry!=='ALL') f=f.filter(g=>g.country===S.activeCountry);
  if(S.activeBrand!=='ALL') f=f.filter(g=>g.brand.toLowerCase().includes(S.activeBrand.toLowerCase()));
  renderGroupCards(f,'camp-groups',true);
}
function renderCampGroups(groups){renderChips(S.platforms,'platform-chips','activePlatform','filterByPlatform');renderChips(S.countries,'country-chips','activeCountry','filterByCountry');renderChips(S.brands,'brand-chips','activeBrand','filterByBrand');renderGroupCards(groups,'camp-groups',true);}

// Render Group Cards supporting Pareto Tail UI flags and Velocity Arrows
function renderGroupCards(groups,id,selectable,clickFn){
  const el=document.getElementById(id);
  if(!groups.length){el.innerHTML='<div style="grid-column:1/-1;text-align:center;color:var(--text3);font-size:12px;">Zero pipeline entities intersect selected matrix nodes</div>';return;}

  el.innerHTML=groups.map(g=>{
    const isTail = g.isAggregatedTail ? 'g-tail-flag' : '';
    let arrow = '➔';
    let trendClass = 'stable';
    if(g.trend === 'Trending Up') { arrow = '▲'; trendClass = 'up'; }
    if(g.trend === 'Trending Down') { arrow = '▼'; trendClass = 'down'; }

    const groupKey = `${g.platform}||${g.country}||${g.brand}`;
    const isSel = S.selectedGroups.includes(groupKey) ? 'selected' : '';
    const fn = clickFn || 'toggleGroup';

    return `<div class="group-card ${isTail} ${isSel}" ${selectable?`onclick="${fn}('${g.platform.replace(/'/g, "\\'")}', '${g.country.replace(/'/g, "\\'")}', '${g.brand.replace(/'/g, "\\'")}', this)"`:'style="cursor:default;"'}>
      <div class="g-platform">${g.platform}</div>
      <div class="g-country">${g.country}</div>
      <div class="g-brand" title="${g.brand}">${g.brand}</div>
      <div class="g-footer-row">
        <div class="g-count">${g.count}</div>
        <span class="g-trend ${trendClass}">${arrow} ${g.velocity30DayPct??0}%</span>
      </div>
    </div>`;
  }).join('');
}

function renderCampTemplates(templates){const el=document.getElementById('camp-templates');if(!templates.length){el.innerHTML='<div style="text-align:center;color:var(--text3);font-size:12px;padding:16px;">WABA contains zero template components inside state approved</div>';return;}el.innerHTML=templates.map(t=>`<div class="tpl-card" onclick="selectTpl('${t.name}',this)"><div class="tpl-name">${t.name}<span class="tpl-lang">${t.language}</span></div><div class="tpl-body">${t.body||''}</div></div>`).join('');}
function toggleGroup(platform,country,brand,el){el.classList.toggle('selected');const key=platform+'||'+country+'||'+brand;const idx=S.selectedGroups.indexOf(key);if(idx===-1)S.selectedGroups.push(key);else S.selectedGroups.splice(idx,1);}
function toggleAllGroups(cb){S.selectedGroups=[];document.querySelectorAll('#camp-groups .group-card').forEach(c=>{c.classList.toggle('selected',cb.checked);if(cb.checked){const p=c.querySelector('.g-platform').textContent,co=c.querySelector('.g-country').textContent,b=c.querySelector('.g-brand').getAttribute('title');S.selectedGroups.push(p+'||'+co+'||'+b);}});}
function selectTpl(name,el){document.querySelectorAll('.tpl-card').forEach(c=>c.classList.remove('selected'));el.classList.add('selected');S.selectedTemplate=S.templates.find(t=>t.name===name);}
function campStep(n){if(n===2&&!S.groups.length){showToast('Synchronize CRM cache boundaries first','error');return;}if(n===3&&!S.selectedTemplate){showToast('Select target template structure context','error');return;}[1,2,3].forEach(i=>{document.getElementById('cs'+i).style.display=i===n?'block':'none';const wz=document.getElementById('wz'+i);wz.className='wz-step'+(i<n?' done':i===n?' active':'');});if(n===3)buildReview();}

function buildReview(){
  const allGroups=document.getElementById('all-groups').checked||S.selectedGroups.length===0;
  const totalCount=allGroups?S.groups.reduce((a,g)=>a+g.count,0):S.groups.filter(g=>S.selectedGroups.includes(g.platform+'||'+g.country+'||'+g.brand)).reduce((a,g)=>a+g.count,0);
  document.getElementById('rv-audience').textContent=allGroups?'Global Distribution Stack':S.selectedGroups.map(k=>k.replaceAll('||',' / ')).join(', ');
  document.getElementById('rv-count').textContent=totalCount;
  document.getElementById('rv-template').textContent=S.selectedTemplate?.name||'—';
  document.getElementById('rv-time').textContent=`~${Math.ceil(totalCount*2/60)} minute engine execution window`;
  document.getElementById('rv-msg').textContent=S.selectedTemplate?.body||'';
}
async function sendCampaign(){
  const btn=document.getElementById('send-btn');
  if(S.selectedTemplate){
    const todayDup=getTodayCampaigns().find(h=>h.template===S.selectedTemplate.name);
    if(todayDup){
      const sentTime=new Date(todayDup.ts).toLocaleTimeString('en-AE',{hour:'2-digit',minute:'2-digit'});
      if(!confirm(`"${S.selectedTemplate.name}" was already sent today at ${sentTime} (${todayDup.sent} contacts). Send again?`))return;
    }
  }
  btn.disabled=true;btn.textContent='Executing Dispatch...';
  document.getElementById('send-progress').style.display='block';
  let prog=0;const interval=setInterval(()=>{prog=Math.min(prog+4,92);document.getElementById('prog-fill').style.width=prog+'%';document.getElementById('prog-text').textContent=`Processing queue arrays... ${prog}%`;},1000);
  try{
    const allGroups=document.getElementById('all-groups').checked||S.selectedGroups.length===0;
    const firstGroup=allGroups?null:S.selectedGroups[0]?.split('||');
    const result=await api('whizz-send-campaign','POST',{
      platform:allGroups?'ALL':(firstGroup?.[0]||'ALL'),
      country:allGroups?'ALL':(firstGroup?.[1]||'ALL'),
      brand:allGroups?'ALL':(firstGroup?.[2]||'ALL'),
      template_name:S.selectedTemplate.name,
      language:S.selectedTemplate.language
    });
    clearInterval(interval);
    document.getElementById('prog-fill').style.width='100%';
    document.getElementById('prog-text').textContent=`Execution terminated. Complete. Sent: ${result.sent}, Failures dropped: ${result.failed}`;
    showToast(`Asynchronous broadcast successful! ${result.sent} elements delivered`,'success');
    saveHistory({template:S.selectedTemplate.name,audience:allGroups?'All':S.selectedGroups.map(k=>k.replaceAll('||',' / ')).join(', '),total:result.total,sent:result.sent,failed:result.failed,ts:Date.now()});
    setTimeout(()=>{document.getElementById('send-progress').style.display='none';btn.disabled=false;btn.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> Send Campaign';resetCampaign();},3000);
  }catch(e){clearInterval(interval);showToast('Asynchronous dispatch loop trace break','error');btn.disabled=false;btn.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> Send Campaign';}
}
function resetCampaign(){S.selectedGroups=[];S.selectedTemplate=null;campStep(1);document.getElementById('all-groups').checked=false;document.querySelectorAll('.group-card').forEach(c=>c.classList.remove('selected'));}

function launchSuggestedCampaign(brand, alreadySent) {
  if (alreadySent) {
    if (!confirm(`A campaign targeting "${brand}" was already sent recently. Proceed anyway?`)) return;
  }
  S.activeBrand = brand;
  const campNav = document.querySelector('.nav-item[onclick*="\'campaigns\'"]');
  navigate('campaigns', campNav);
  setTimeout(() => {
    const chips = document.querySelectorAll('#brand-chips .chip');
    chips.forEach(c => { if (c.textContent.trim() === brand) c.click(); });
  }, 150);
}

function launchDemandCampaign(brand, level) {
  const typeMap = { high:'promotional', medium:'promotional', low:'intro', dormant:'intro' };
  document.getElementById('tpl-ai-brand').value = brand;
  document.getElementById('tpl-ai-type').value = typeMap[level] || 'promotional';
  document.getElementById('tpl-ai-region').value = 'Global';
  openTplModal();
  showToast(`Campaign context set for ${brand} — click Generate with AI`, 'info');
}

function getTplAIContent() { /* placeholder */ }
