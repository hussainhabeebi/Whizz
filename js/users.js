// ── Users Management ──
function renderUsersPage(){
  const sess=localStorage.getItem('whizz_session');
  const currentEmail=sess?JSON.parse(sess).email:'';
  const search=(document.getElementById('users-search')?.value||'').toLowerCase();
  const entries=Object.entries(USERS).filter(([email,u])=>!search||(u.name.toLowerCase().includes(search)||email.toLowerCase().includes(search)));

  const all=Object.values(USERS);
  document.getElementById('stat-users-total').textContent=all.length;
  document.getElementById('stat-users-admin').textContent=all.filter(u=>u.role==='Administrator').length;
  document.getElementById('stat-users-manager').textContent=all.filter(u=>u.role==='Manager').length;
  document.getElementById('stat-users-restricted').textContent=all.filter(u=>u.allowedBrands&&u.allowedBrands.length>0).length;

  const tbody=document.getElementById('users-tbody');
  if(!tbody)return;
  if(!entries.length){
    tbody.innerHTML=`<tr><td colspan="5" style="text-align:center;padding:32px;color:var(--text3);font-size:13px;">${search?'No users match your search.':'No users found.'}</td></tr>`;
    return;
  }
  const roleStyle={Administrator:'background:var(--green-dim);color:var(--green);',Manager:'background:var(--amber-dim);color:var(--amber);',Sales:'background:var(--blue-dim);color:var(--blue);'};
  const chipHtml=(arr,color)=>arr&&arr.length>0?arr.map(v=>`<span style="display:inline-block;background:${color}1a;color:${color};border:1px solid ${color}33;border-radius:4px;padding:1px 7px;font-size:10px;font-weight:500;">${v}</span>`).join(' '):`<span style="font-size:11px;color:var(--green);font-weight:500;">All</span>`;
  tbody.innerHTML=entries.map(([email,u])=>{
    const initials=u.name.split(' ').slice(0,2).map(w=>w[0]||'').join('').toUpperCase()||'?';
    const isMe=email===currentEmail;
    const esc=s=>(s||'').replace(/'/g,"\\'");
    return `<tr>
      <td>
        <div style="display:flex;align-items:center;gap:9px;">
          <div style="width:32px;height:32px;border-radius:50%;flex-shrink:0;background:linear-gradient(135deg,var(--accent),#ef4444);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:11px;color:#fff;">${initials}</div>
          <div>
            <div style="font-weight:500;font-size:13px;">${u.name}${isMe?'<span style="font-size:10px;color:var(--text3);margin-left:5px;">(you)</span>':''}</div>
          </div>
        </div>
      </td>
      <td style="color:var(--text2);font-size:12px;">${email}</td>
      <td><span style="display:inline-block;padding:2px 9px;border-radius:20px;font-size:11px;font-weight:600;${roleStyle[u.role]||''}">${u.role}</span></td>
      <td><div style="display:flex;flex-wrap:wrap;gap:3px;">${chipHtml(u.allowedPlatforms,'#8b5cf6')}</div></td>
      <td><div style="display:flex;flex-wrap:wrap;gap:3px;">${chipHtml(u.allowedBrands,'#f59e0b')}</div></td>
      <td>
        <div style="display:flex;gap:5px;justify-content:center;">
          <button class="t-btn btn-ghost" style="padding:5px 10px;font-size:11px;" onclick="openEditUserModal('${esc(email)}')" title="Edit user">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            Edit
          </button>
          ${!isMe?`<button class="t-btn" style="padding:5px 10px;font-size:11px;background:var(--red-dim);color:var(--red);border:1px solid rgba(220,38,38,0.2);" onclick="deleteUser('${esc(email)}')" title="Delete user">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
            Delete
          </button>`:''}
        </div>
      </td>
    </tr>`;
  }).join('');
}

function populateChips(containerId, options, selectedValues){
  const el=document.getElementById(containerId);
  if(!el)return;
  if(!options||!options.length){el.innerHTML='<span style="font-size:11px;color:var(--text3);">No options loaded yet — refresh Leads data first.</span>';return;}
  el.innerHTML=options.map(v=>{
    const sel=(selectedValues||[]).includes(v);
    return `<div class="chip ${sel?'active':''}" style="cursor:pointer;font-size:11px;padding:4px 10px;" onclick="this.classList.toggle('active')">${v}</div>`;
  }).join('');
}

function populateBrandChips(containerId, selectedBrands){
  const brands=S.brands&&S.brands.length?[...S.brands]:[];
  populateChips(containerId, brands, selectedBrands);
}

function populatePlatformChips(containerId, selectedPlatforms){
  const platforms=S.platforms&&S.platforms.length?[...S.platforms]:['Viral'];
  populateChips(containerId, platforms, selectedPlatforms);
}

function getSelectedChips(containerId){
  return [...document.querySelectorAll(`#${containerId} .chip.active`)].map(el=>el.textContent.trim());
}

function openAddUserModal(){
  populatePlatformChips('au-platform-chips',[]);
  populateBrandChips('au-brand-chips',[]);
  ['au-name','au-email'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('au-role').value='Sales';
  document.getElementById('modal-add-user').classList.add('open');
}

function submitAddUser(){
  const name=document.getElementById('au-name').value.trim();
  const email=document.getElementById('au-email').value.trim().toLowerCase();
  const role=document.getElementById('au-role').value;
  const allowedPlatforms=getSelectedChips('au-platform-chips');
  const allowedBrands=getSelectedChips('au-brand-chips');
  if(!name||!email){showToast('Name and email are required','error');return;}
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){showToast('Please enter a valid email address','error');return;}
  if(USERS[email]){showToast('A user with this email already exists','error');return;}
  USERS[email]={name,role,allowedBrands,allowedPlatforms};
  saveUsers();
  showToast(`User "${name}" added. Remember to also add ${email} to the Cloudflare Access policy.`,'success');
  closeModal('modal-add-user');
  renderUsersPage();
}

function openEditUserModal(email){
  const u=USERS[email];
  if(!u)return;
  document.getElementById('eu-email-key').value=email;
  document.getElementById('eu-email-display').textContent=email;
  document.getElementById('eu-name').value=u.name;
  document.getElementById('eu-role').value=u.role;
  populatePlatformChips('eu-platform-chips',u.allowedPlatforms||[]);
  populateBrandChips('eu-brand-chips',u.allowedBrands||[]);
  document.getElementById('modal-edit-user').classList.add('open');
}

function submitEditUser(){
  const email=document.getElementById('eu-email-key').value;
  const u=USERS[email];
  if(!u){showToast('User not found','error');return;}
  const name=document.getElementById('eu-name').value.trim();
  const role=document.getElementById('eu-role').value;
  const allowedPlatforms=getSelectedChips('eu-platform-chips');
  const allowedBrands=getSelectedChips('eu-brand-chips');
  if(!name){showToast('Name is required','error');return;}
  u.name=name;
  u.role=role;
  u.allowedPlatforms=allowedPlatforms;
  u.allowedBrands=allowedBrands;
  saveUsers();
  showToast(`User "${name}" updated successfully!`,'success');
  closeModal('modal-edit-user');
  renderUsersPage();
  const sess=localStorage.getItem('whizz_session');
  if(sess){const se=JSON.parse(sess);if(se.email===email){se.name=name;se.role=role;localStorage.setItem('whizz_session',JSON.stringify(se));document.getElementById('u-name').textContent=name;document.getElementById('u-role').textContent=role;const initials=name.split(' ').map(w=>w[0]).join('').toUpperCase();document.getElementById('u-avatar').textContent=initials;}}
}

function deleteUser(email){
  const u=USERS[email];
  if(!u)return;
  if(!confirm(`Delete "${u.name}" (${email})?\n\nThis cannot be undone.`))return;
  delete USERS[email];
  saveUsers();
  showToast(`User "${u.name}" deleted. Remember to also remove ${email} from the Cloudflare Access policy.`,'success');
  renderUsersPage();
}
