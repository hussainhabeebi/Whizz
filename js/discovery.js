// ── Contact Discovery (Apify) Module ──
function setDiscType(type, el) {
  S.discType = type;
  document.querySelectorAll('.disc-type-btn').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
}

async function runDiscovery() {
  const location = document.getElementById('disc-location').value.trim();
  const brand    = document.getElementById('disc-brand').value.trim();
  const category = document.getElementById('disc-category').value.trim();
  const limit    = parseInt(document.getElementById('disc-limit').value) || 20;
  const type     = S.discType;

  if (!location) { showToast('Enter a location to search', 'error'); return; }
  if (!brand && !category) { showToast('Enter a brand or product category', 'error'); return; }

  const btn   = document.getElementById('disc-run-btn');
  const icon  = document.getElementById('disc-run-icon');
  const label = document.getElementById('disc-run-label');
  btn.disabled = true; icon.classList.add('spin'); label.textContent = 'Searching…';

  const parts = [brand, category, type, location].filter(Boolean);
  const query = parts.join(' ');

  document.getElementById('disc-results-body').innerHTML = `
    <div style="padding:40px;text-align:center;">
      <div class="ai-thinking" style="justify-content:center;display:inline-flex;">
        <div class="ai-dot"></div><div class="ai-dot"></div><div class="ai-dot"></div>
        <span style="margin-left:8px;color:var(--text2);font-size:12px;">Scanning Google Maps for "<strong>${query}</strong>"…</span>
      </div>
      <div style="font-size:11px;color:var(--text3);margin-top:10px;">Apify is crawling — this takes 20–60 seconds</div>
    </div>`;
  document.getElementById('disc-results-title').textContent = 'Searching…';

  try {
    const d = await api('whizz-discover-contacts', 'POST', { query, location, brand, category, type, limit });
    const contacts = d.contacts || d.items || (Array.isArray(d) ? d : []);
    S.discoveredContacts = contacts;
    S.selectedDiscContacts = new Set();
    renderDiscoveryResults(S.discoveredContacts);
    if (S.discoveredContacts.length) showToast(`Found ${S.discoveredContacts.length} contacts`, 'success');
    else showToast('No results — try broader filters', 'info');
  } catch(e) {
    document.getElementById('disc-results-body').innerHTML = `<div class="disc-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>Discovery failed — ensure <strong>whizz-discover-contacts</strong> webhook is active in n8n.</div>`;
    document.getElementById('disc-results-title').textContent = 'Results';
  }
  btn.disabled = false; icon.classList.remove('spin'); label.textContent = 'Discover';
}

function renderDiscoveryResults(contacts) {
  const body    = document.getElementById('disc-results-body');
  const title   = document.getElementById('disc-results-title');
  const actions = document.getElementById('disc-actions');

  if (!contacts || !contacts.length) {
    title.textContent = 'Results';
    if (actions) actions.style.display = 'none';
    body.innerHTML = `<div class="disc-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/><path d="M11 8v6"/><path d="M8 11h6"/></svg>Set your filters and click <strong>Discover</strong>.</div>`;
    return;
  }

  title.textContent = `${contacts.length} Contacts Found`;
  if (actions) actions.style.display = 'flex';

  const withPhone   = contacts.filter(c=>c.phone||c.phoneNumber).length;
  const withEmail   = contacts.filter(c=>c.email).length;
  const withWebsite = contacts.filter(c=>c.website).length;
  const ratedItems  = contacts.filter(c=>(c.totalScore||c.rating)>0);
  const avgRating   = ratedItems.length ? (ratedItems.reduce((a,c)=>a+(c.totalScore||c.rating),0)/ratedItems.length).toFixed(1) : '—';

  const statsHtml = `<div class="disc-stats-row">
    <div class="disc-stat"><strong>${contacts.length}</strong> contacts</div>
    <div class="disc-stat" style="color:var(--green)">📞 <strong>${withPhone}</strong> phone</div>
    <div class="disc-stat" style="color:var(--blue)">✉ <strong>${withEmail}</strong> email</div>
    <div class="disc-stat">🌐 <strong>${withWebsite}</strong> website</div>
    <div class="disc-stat" style="color:var(--amber)">★ <strong>${avgRating}</strong> avg</div>
    <div class="disc-stat" style="margin-left:auto;color:var(--accent);" id="disc-sel-count">0 selected</div>
  </div>`;

  const cardsHtml = contacts.map((c, i) => {
    const name     = c.name || c.title || 'Unknown Business';
    const initials = name.split(' ').slice(0,2).map(w=>w[0]).join('').toUpperCase();
    const category = c.categoryName || c.category || '';
    const phone    = c.phone || c.phoneNumber || '';
    const email    = c.email || '';
    const website  = c.website || '';
    const address  = [c.address||'', c.city||''].filter(Boolean).join(', ');
    const rating   = c.totalScore || c.rating || 0;
    const stars    = rating ? '★ ' + Number(rating).toFixed(1) : '';
    const mapsUrl  = c.url || '';

    return `<div class="contact-card" id="dcard-${i}" onclick="toggleDiscContact(${i},this)">
      <div class="cc-header">
        <div class="cc-avatar">${initials}</div>
        <div style="flex:1;min-width:0;">
          <div class="cc-name">${name}</div>
          <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;margin-top:3px;">
            ${category?`<span class="cc-cat">${category}</span>`:''}
            ${stars?`<span class="cc-rating">${stars}</span>`:''}
          </div>
        </div>
      </div>
      ${phone?`<div class="cc-detail"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.67 9.8 19.79 19.79 0 0 1 1.61 1.12 2 2 0 0 1 3.58 1h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.56a16 16 0 0 0 6 6z"/></svg><a href="tel:${phone}" onclick="event.stopPropagation()">${phone}</a></div>`:''}
      ${email?`<div class="cc-detail"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg><a href="mailto:${email}" onclick="event.stopPropagation()">${email}</a></div>`:''}
      ${address?`<div class="cc-detail"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>${address}</div>`:''}
      ${website?`<div class="cc-detail"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg><a href="${website}" target="_blank" onclick="event.stopPropagation()">${website.replace(/^https?:\/\/(www\.)?/,'').slice(0,35)}</a></div>`:''}
      <div class="cc-footer">
        ${mapsUrl?`<a class="t-btn btn-ghost" style="padding:4px 9px;font-size:10px;text-decoration:none;" href="${mapsUrl}" target="_blank" onclick="event.stopPropagation()">Maps ↗</a>`:''}
        <button class="t-btn btn-primary" style="padding:4px 9px;font-size:10px;flex:1;justify-content:center;" onclick="event.stopPropagation();saveOneContact(${i})">+ Add to Leads</button>
      </div>
    </div>`;
  }).join('');

  body.innerHTML = statsHtml + `<div class="contact-grid">${cardsHtml}</div>`;
  updateDiscSelCount();
}

function toggleDiscContact(i, el) {
  if (S.selectedDiscContacts.has(i)) S.selectedDiscContacts.delete(i);
  else S.selectedDiscContacts.add(i);
  el.classList.toggle('selected', S.selectedDiscContacts.has(i));
  updateDiscSelCount();
}

function selectAllDisc() {
  const all = S.discoveredContacts.length;
  if (S.selectedDiscContacts.size === all) {
    S.selectedDiscContacts.clear();
    document.querySelectorAll('.contact-card').forEach(c=>c.classList.remove('selected'));
  } else {
    S.selectedDiscContacts = new Set(S.discoveredContacts.map((_,i)=>i));
    document.querySelectorAll('.contact-card').forEach(c=>c.classList.add('selected'));
  }
  updateDiscSelCount();
}

function updateDiscSelCount() {
  const el = document.getElementById('disc-sel-count');
  if (el) el.textContent = `${S.selectedDiscContacts.size} selected`;
  const badge = document.getElementById('disc-badge');
  if (S.discoveredContacts && S.discoveredContacts.length) { badge.textContent = S.discoveredContacts.length; badge.style.display='inline'; }
  else badge.style.display = 'none';
}

async function saveOneContact(i) {
  const c = S.discoveredContacts[i];
  if (!c) return;
  try {
    await api('whizz-save-contact','POST',{contacts:[formatContactForLeads(c)]});
    showToast(`${c.name||c.title||'Contact'} added to Leads`,'success');
  } catch(e){ showToast('Save failed — check whizz-save-contact webhook','error'); }
}

async function saveSelectedContacts() {
  const selected = [...S.selectedDiscContacts].map(i=>S.discoveredContacts[i]).filter(Boolean);
  if (!selected.length) { showToast('Select contacts first (click cards)','error'); return; }
  const btn = document.getElementById('disc-save-btn');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    await api('whizz-save-contact','POST',{contacts:selected.map(formatContactForLeads)});
    showToast(`${selected.length} contact${selected.length>1?'s':''} added to Leads`,'success');
    addNotif(`${selected.length} discovered contacts saved to leads`);
    S.selectedDiscContacts.clear();
    document.querySelectorAll('.contact-card').forEach(c=>c.classList.remove('selected'));
    updateDiscSelCount();
  } catch(e){ showToast('Save failed — check whizz-save-contact webhook','error'); }
  btn.disabled = false;
  btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/><circle cx="16" cy="4" r="3"/></svg> Add Selected to Leads';
}

function formatContactForLeads(c) {
  return {
    contactName: c.name||c.title||'',
    company: c.name||c.title||'',
    phone: c.phone||c.phoneNumber||'',
    email: c.email||'',
    website: c.website||'',
    address: [c.address||'',c.city||'',c.countryCode||''].filter(Boolean).join(', '),
    category: c.categoryName||c.category||'',
    source: 'Apify Discovery',
    rating: c.totalScore||c.rating||'',
    mapsUrl: c.url||''
  };
}

function exportDiscCSV() {
  if (!S.discoveredContacts.length) { showToast('No contacts to export','error'); return; }
  const rows = S.discoveredContacts.map(c => {
    const f = formatContactForLeads(c);
    return `"${f.contactName}","${f.company}","${f.phone}","${f.email}","${f.website}","${f.address}","${f.category}","${f.rating}"`;
  });
  downloadCSV(['Name,Company,Phone,Email,Website,Address,Category,Rating',...rows].join('\n'),'whizz_discovered_contacts.csv');
  showToast('Export complete!','success');
}
