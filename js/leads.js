// ── Leads Data Overview Module ──
function getCurrentUserRestrictions(){
  const sess=localStorage.getItem('whizz_session');
  let allowedBrands=[],allowedPlatforms=[];
  if(sess){try{const se=JSON.parse(sess);const u=USERS[se.email];if(u){if(u.allowedBrands&&u.allowedBrands.length>0)allowedBrands=u.allowedBrands;if(u.allowedPlatforms&&u.allowedPlatforms.length>0)allowedPlatforms=u.allowedPlatforms;}}catch(e){}}
  return{allowedBrands,allowedPlatforms};
}
function renderLeadsPage(groups,total){
  const{allowedBrands,allowedPlatforms}=getCurrentUserRestrictions();
  let filteredGroups=groups||[];
  let filteredBrands=S.brands;
  let filteredPlatforms=S.platforms;
  if(allowedBrands.length>0){filteredGroups=filteredGroups.filter(g=>allowedBrands.includes(g.brand));filteredBrands=S.brands.filter(b=>allowedBrands.includes(b));}
  if(allowedPlatforms.length>0){filteredGroups=filteredGroups.filter(g=>allowedPlatforms.includes(g.platform));filteredPlatforms=S.platforms.filter(p=>allowedPlatforms.includes(p));}
  document.getElementById('leads-total').textContent=`${total||0} operational records mapped`;
  renderChipsFilter(filteredPlatforms,'leads-platform-chips','filterLeadsByPlatform');
  renderChipsFilter(S.countries,'leads-country-chips','filterLeadsByCountry');
  renderChipsFilter(filteredBrands,'leads-brand-chips','filterLeadsByBrand');
  renderGroupCards(filteredGroups,'leads-groups',true,'selectLeadsGroup');
  renderLeadScores(filteredGroups,'lead-score-list');
}
function renderChipsFilter(list,id,fn){
  const el=document.getElementById(id);
  el.innerHTML=['ALL',...list].map(v=>`<div class="chip ${v==='ALL'?'active':''}" onclick="${fn}('${v.replace(/'/g, "\\'")}',this)">${v}</div>`).join('');
}
function filterLeadsByPlatform(v,el){document.querySelectorAll('#leads-platform-chips .chip').forEach(c=>c.classList.remove('active'));el.classList.add('active');applyLeadsFilter();}
function filterLeadsByCountry(v,el){document.querySelectorAll('#leads-country-chips .chip').forEach(c=>c.classList.remove('active'));el.classList.add('active');applyLeadsFilter();}
function filterLeadsByBrand(v,el){document.querySelectorAll('#leads-brand-chips .chip').forEach(c=>c.classList.remove('active'));el.classList.add('active');applyLeadsFilter();}
function applyLeadsFilter(){
  const p=document.querySelector('#leads-platform-chips .chip.active')?.textContent||'ALL';
  const co=document.querySelector('#leads-country-chips .chip.active')?.textContent||'ALL';
  const b=document.querySelector('#leads-brand-chips .chip.active')?.textContent||'ALL';
  const{allowedBrands,allowedPlatforms}=getCurrentUserRestrictions();
  let f=S.cache.groups||[];
  if(allowedBrands.length>0) f=f.filter(g=>allowedBrands.includes(g.brand));
  if(allowedPlatforms.length>0) f=f.filter(g=>allowedPlatforms.includes(g.platform));
  if(p!=='ALL') f=f.filter(g=>g.platform===p);
  if(co!=='ALL') f=f.filter(g=>g.country===co);
  if(b!=='ALL') f=f.filter(g=>g.brand.toLowerCase().includes(b.toLowerCase()));
  renderGroupCards(f,'leads-groups',true,'selectLeadsGroup');
  closeGroupContacts();
}

// ── Lead Group Contacts ──
let _currentLeadsGroup=null;
let _currentLeadsContacts=[];

function selectLeadsGroup(platform,country,brand,el){
  document.querySelectorAll('#leads-groups .group-card').forEach(c=>c.classList.remove('selected'));
  el.classList.add('selected');
  _currentLeadsGroup={platform,country,brand};
  openGroupContacts(platform,country,brand);
}

function closeGroupContacts(){
  document.getElementById('leads-contacts-panel').style.display='none';
  document.querySelectorAll('#leads-groups .group-card').forEach(c=>c.classList.remove('selected'));
  _currentLeadsGroup=null;
  _currentLeadsContacts=[];
}

async function openGroupContacts(platform,country,brand){
  const panel=document.getElementById('leads-contacts-panel');
  panel.style.display='block';
  setTimeout(()=>panel.scrollIntoView({behavior:'smooth',block:'nearest'}),50);
  document.getElementById('leads-contacts-title').textContent=`${platform} · ${country} · ${brand}`;
  document.getElementById('leads-contacts-subtitle').textContent='Loading contacts...';
  document.getElementById('leads-contacts-count').textContent='';
  document.getElementById('leads-contacts-body').innerHTML='<div style="text-align:center;padding:32px;color:var(--text3);font-size:13px;">Fetching contacts...</div>';
  try{
    const d=await api(`whizz-get-contacts?platform=${encodeURIComponent(platform)}&country=${encodeURIComponent(country)}&brand=${encodeURIComponent(brand)}`);
    const contacts=d.contacts||d||[];
    _currentLeadsContacts=Array.isArray(contacts)?contacts:[];
    document.getElementById('leads-contacts-subtitle').textContent=`${platform} / ${country} / ${brand}`;
    document.getElementById('leads-contacts-count').textContent=`${_currentLeadsContacts.length} contact${_currentLeadsContacts.length!==1?'s':''}`;
    renderLeadContacts(_currentLeadsContacts);
  }catch(e){
    document.getElementById('leads-contacts-subtitle').textContent='';
    document.getElementById('leads-contacts-body').innerHTML='<div style="text-align:center;padding:32px;color:var(--red);font-size:12px;">Failed to load contacts — ensure <strong>whizz-get-contacts</strong> webhook is active in n8n.</div>';
  }
}

function renderLeadContacts(contacts){
  const body=document.getElementById('leads-contacts-body');
  if(!contacts.length){body.innerHTML='<div style="text-align:center;padding:32px;color:var(--text3);font-size:12px;">No contacts in this group yet. Use <strong>Add Contact</strong> above to add some.</div>';return;}
  body.innerHTML=`<div class="lead-contacts-grid">${contacts.map((c,i)=>{
    const name=c.contactName||c.company||c.name||'Unknown';
    const initials=name.split(' ').slice(0,2).map(w=>w[0]||'').join('').toUpperCase()||'?';
    return `<div class="lc-card">
      <div class="lc-header">
        <div class="lc-avatar">${initials}</div>
        <div style="flex:1;min-width:0;">
          <div class="lc-name">${name}</div>
          ${c.category?`<span class="cc-cat">${c.category}</span>`:''}
        </div>
        <div style="display:flex;gap:5px;flex-shrink:0;">
          <button class="t-btn btn-ghost" style="padding:4px 8px;font-size:10px;" onclick="openEditLeadContact(${i})" title="Edit contact">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="11" height="11"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            Edit
          </button>
          <button class="t-btn" style="padding:4px 8px;font-size:10px;background:var(--red-dim);color:var(--red);border:1px solid rgba(220,38,38,0.2);" onclick="deleteLeadContact(${i})" title="Delete contact">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="11" height="11"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
          </button>
        </div>
      </div>
      ${c.phone?`<div class="cc-detail"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.67 9.8 19.79 19.79 0 0 1 1.61 1.12 2 2 0 0 1 3.58 1h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.56a16 16 0 0 0 6 6z"/></svg><a href="tel:${c.phone}" onclick="event.stopPropagation()">${c.phone}</a></div>`:''}
      ${c.email?`<div class="cc-detail"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg><a href="mailto:${c.email}" onclick="event.stopPropagation()">${c.email}</a></div>`:''}
      ${c.source?`<div class="cc-detail" style="font-size:10px;color:var(--text3);"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>${c.source}</div>`:''}
    </div>`;
  }).join('')}</div>`;
}

function openEditLeadContact(i){
  const c=_currentLeadsContacts[i];
  if(!c)return;
  document.getElementById('ec-id').value=c.id||'';
  document.getElementById('ec-name').value=c.contactName||c.company||c.name||'';
  document.getElementById('ec-phone').value=c.phone||c.phoneNumber||'';
  document.getElementById('ec-email').value=c.email||'';
  document.getElementById('ec-category').value=c.category||'';
  document.getElementById('ec-source').value=c.source||'';
  document.getElementById('ec-platform').value=c.platform||'';
  document.getElementById('ec-country').value=c.country||'';
  document.getElementById('ec-brand').value=c.brand||'';
  document.getElementById('modal-edit-contact').classList.add('open');
}

async function submitEditLeadContact(){
  const name=document.getElementById('ec-name').value.trim();
  if(!name){showToast('Contact name is required','error');return;}
  const contact={
    id:document.getElementById('ec-id').value,
    contactName:name,
    company:name,
    phone:document.getElementById('ec-phone').value.trim(),
    email:document.getElementById('ec-email').value.trim(),
    category:document.getElementById('ec-category').value.trim(),
    source:document.getElementById('ec-source').value.trim(),
    platform:document.getElementById('ec-platform').value.trim(),
    country:document.getElementById('ec-country').value.trim(),
    brand:document.getElementById('ec-brand').value.trim()
  };
  try{
    await api('whizz-update-contact','POST',contact);
    showToast('Contact updated!','success');
    closeModal('modal-edit-contact');
    if(_currentLeadsGroup)openGroupContacts(_currentLeadsGroup.platform,_currentLeadsGroup.country,_currentLeadsGroup.brand);
  }catch(e){showToast('Failed to update — ensure whizz-update-contact webhook is active','error');}
}

async function deleteLeadContact(i){
  const c=_currentLeadsContacts[i];
  if(!c)return;
  const name=c.contactName||c.company||c.name||'this contact';
  if(!confirm(`Delete "${name}"? This cannot be undone.`))return;
  try{
    await api('whizz-delete-contact','POST',{id:c.id});
    showToast(`${name} deleted`,'success');
    if(_currentLeadsGroup){
      openGroupContacts(_currentLeadsGroup.platform,_currentLeadsGroup.country,_currentLeadsGroup.brand);
      refreshLeads();
    }
  }catch(e){showToast('Failed to delete — ensure whizz-delete-contact webhook is active','error');}
}

// ── Add Contact (multi-row) ──
let _acRowId=0;
function acAddRow(){
  const id=++_acRowId;
  const row=document.createElement('div');
  row.id=`ac-row-${id}`;
  row.style.cssText='display:grid;grid-template-columns:1fr 130px 150px 130px 28px;gap:6px;align-items:center;';
  row.innerHTML=`
    <input class="fi" style="padding:7px 9px;font-size:12px;" placeholder="Company or Contact Name *" data-field="name"/>
    <input class="fi" style="padding:7px 9px;font-size:12px;" placeholder="+971..." data-field="phone"/>
    <input class="fi" style="padding:7px 9px;font-size:12px;" placeholder="email@example.com" data-field="email"/>
    <input class="fi" style="padding:7px 9px;font-size:12px;" placeholder="Manual Entry" data-field="source"/>
    <button onclick="acRemoveRow(${id})" style="width:26px;height:26px;border-radius:6px;background:var(--red-dim);border:1px solid rgba(220,38,38,0.2);color:var(--red);cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center;flex-shrink:0;" title="Remove">✕</button>
  `;
  document.getElementById('ac-rows').appendChild(row);
  acUpdateCount();
  row.querySelector('[data-field="name"]').focus();
}
function acRemoveRow(id){
  document.getElementById(`ac-row-${id}`)?.remove();
  acUpdateCount();
}
function acUpdateCount(){
  const n=document.getElementById('ac-rows').children.length;
  document.getElementById('ac-row-count').textContent=n?`${n} contact${n>1?'s':''}  to save`:'';
}
function openAddContactModal(){
  const{allowedBrands,allowedPlatforms}=getCurrentUserRestrictions();
  const pfEl=document.getElementById('ac-shared-platform');
  const brEl=document.getElementById('ac-shared-brand');
  if(allowedPlatforms.length===1){pfEl.value=allowedPlatforms[0];pfEl.readOnly=true;}
  else{pfEl.value='';pfEl.readOnly=false;}
  if(allowedBrands.length===1){brEl.value=allowedBrands[0];brEl.readOnly=true;}
  else{brEl.value='';brEl.readOnly=false;}
  document.getElementById('ac-rows').innerHTML='';
  _acRowId=0;
  acAddRow();
  document.getElementById('modal-add-contact').classList.add('open');
}
async function submitAddContact(){
  const sharedPlatform=document.getElementById('ac-shared-platform').value.trim();
  const sharedCountry=document.getElementById('ac-shared-country').value.trim();
  const sharedBrand=document.getElementById('ac-shared-brand').value.trim();
  const sharedCategory=document.getElementById('ac-shared-category').value.trim();
  const rows=document.getElementById('ac-rows').querySelectorAll('[id^="ac-row-"]');
  const contacts=[];
  let hasError=false;
  rows.forEach(row=>{
    const name=row.querySelector('[data-field="name"]').value.trim();
    if(!name){row.querySelector('[data-field="name"]').style.borderColor='var(--red)';hasError=true;return;}
    row.querySelector('[data-field="name"]').style.borderColor='';
    contacts.push({
      contactName:name,
      company:name,
      phone:row.querySelector('[data-field="phone"]').value.trim(),
      email:row.querySelector('[data-field="email"]').value.trim(),
      source:row.querySelector('[data-field="source"]').value.trim()||'Manual Entry',
      platform:sharedPlatform,
      country:sharedCountry,
      brand:sharedBrand,
      category:sharedCategory
    });
  });
  if(hasError){showToast('Contact name is required for all rows','error');return;}
  if(!contacts.length){showToast('Add at least one contact row','error');return;}
  try{
    await api('whizz-save-contact','POST',{contacts});
    showToast(`${contacts.length} contact${contacts.length>1?'s':''} saved!`,'success');
    closeModal('modal-add-contact');
    refreshLeads();
  }catch(e){showToast('Failed to save contacts — check webhook','error');}
}

function exportLeadsCSV() {
  if (!S.cache.groups) { showToast('Load leads portfolio first', 'error'); return; }
  const rows = S.cache.groups.map(g => `"${g.platform}","${g.country}","${g.brand}",${g.count},"${g.trend||'Stable'}"`);
  downloadCSV(['Platform,Country,Brand,Count,TrendVelocity', ...rows].join('\n'), 'whizz_leads_distribution.csv');
  showToast('Export complete!', 'success');
}

// ── Lead Scoring ──
function computeLeadScore(g) {
  const trend = g.trend === 'Trending Up' ? 1.2 : g.trend === 'Trending Down' ? 0.8 : 1.0;
  const vel = Math.max(0, g.velocity30DayPct || 0);
  return Math.round(g.count * trend * (1 + vel / 200));
}

function renderLeadScores(groups, containerId) {
  const el = document.getElementById(containerId);
  if (!el || !groups || !groups.length) return;
  const scored = groups
    .filter(g => !g.isAggregatedTail)
    .map(g => ({ ...g, score: computeLeadScore(g) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
  if (!scored.length) { el.innerHTML = '<div style="text-align:center;color:var(--text3);font-size:12px;">No data.</div>'; return; }
  const maxScore = scored[0].score || 1;
  el.innerHTML = scored.map((g, i) => {
    const pct = Math.round(g.score / maxScore * 100);
    const arrow = g.trend === 'Trending Up' ? '▲' : g.trend === 'Trending Down' ? '▼' : '→';
    const tc = g.trend === 'Trending Up' ? 'var(--green)' : g.trend === 'Trending Down' ? 'var(--red)' : 'var(--text3)';
    const bLabel = g.brand.length > 18 ? g.brand.slice(0, 18) + '…' : g.brand;
    return `<div class="score-row">
      <span class="score-rank">#${i+1}</span>
      <div style="flex:1;min-width:0;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:3px;gap:6px;">
          <span style="font-size:12px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${g.platform} · ${g.country} · <span style="color:var(--accent)">${bLabel}</span></span>
          <span style="font-size:11px;font-weight:700;color:${tc};flex-shrink:0;">${arrow} ${g.velocity30DayPct||0}%</span>
        </div>
        <div class="score-bar"><div class="score-fill" style="width:${pct}%"></div></div>
      </div>
      <div style="text-align:right;min-width:44px;flex-shrink:0;">
        <div style="font-family:var(--font-display);font-size:16px;font-weight:700;color:var(--text);line-height:1">${g.count}</div>
        <div style="font-size:9px;color:var(--text3)">score ${g.score}</div>
      </div>
    </div>`;
  }).join('');
}
