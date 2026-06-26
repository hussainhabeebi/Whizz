// ── Reports Tab Optimization ──
function renderReports(){
  const{allowedBrands,allowedPlatforms}=getCurrentUserRestrictions();
  const d=S.cache.stats||{};

  let groups=S.cache.groups||[];
  let matrix=S.crossTabMatrix||[];
  if(allowedBrands.length>0){groups=groups.filter(g=>allowedBrands.includes(g.brand));matrix=matrix.filter(m=>allowedBrands.includes(m.brand));}
  if(allowedPlatforms.length>0){
    groups=groups.filter(g=>allowedPlatforms.includes(g.platform));
    matrix=matrix.map(m=>{
      const filteredPlatforms=Object.fromEntries(Object.entries(m.breakdownByPlatform||{}).filter(([pl])=>allowedPlatforms.includes(pl)));
      const filteredTotal=Object.values(filteredPlatforms).reduce((s,v)=>s+v,0);
      return{...m,breakdownByPlatform:filteredPlatforms,totalGlobalCount:filteredTotal||m.totalGlobalCount};
    });
  }

  document.getElementById('rep-conv').innerHTML=`
    <div class="metric-row"><div class="m-label">Open / Action Required</div><div class="m-value" style="color:var(--accent)">${d.open||0}</div></div>
    <div class="metric-row"><div class="m-label">Resolved Contexts</div><div class="m-value">${d.resolved||0}</div></div>
    <div class="metric-row"><div class="m-label">Awaiting Internal Node State (Pending)</div><div class="m-value" style="color:var(--amber)">${d.pending||0}</div></div>
    <div class="metric-row"><div class="m-label">Campaign Iterations Dispatched</div><div class="m-value" style="color:var(--green)">${S.history.length}</div></div>`;

  const cm={};
  groups.forEach(g=>{if(!g.isAggregatedTail){cm[g.country]=(cm[g.country]||0)+g.count;}});
  document.getElementById('rep-leads').innerHTML=Object.entries(cm).sort((a,b)=>b[1]-a[1])
    .map(([c,n])=>`<div class="metric-row"><div class="m-label">${c}</div><div class="m-value" style="color:var(--accent)">${n}</div></div>`).join('');

  renderStockLeadsOverlap(allowedBrands,allowedPlatforms);
  renderLeadScores(groups,'rep-lead-scores');
  renderRegionalHeatmap(groups);

  const matEl=document.getElementById('rep-matrix');
  if(!matrix.length){matEl.innerHTML='<div style="text-align:center;color:var(--text3);font-size:12px;padding:20px;">No Cross Tab items for your access level.</div>';return;}
  matEl.innerHTML=matrix.map(m=>{
    const countriesBlock=Object.entries(m.breakdownByCountry||{}).map(([co,cnt])=>`<div class="matrix-sub-item">${co}: <span class="matrix-sub-val">${cnt}</span></div>`).join('');
    const platformsBlock=Object.entries(m.breakdownByPlatform||{}).map(([pl,cnt])=>`<div class="matrix-sub-item" style="border-color:rgba(59,130,246,0.2)">${pl}: <span class="matrix-sub-val" style="color:var(--blue)">${cnt}</span></div>`).join('');
    return`<div class="matrix-row-item">
      <div class="matrix-row-header">
        <span class="matrix-brand-name">${m.brand}</span>
        <span class="matrix-total-pill">Global Allocation Weight: ${m.totalGlobalCount}</span>
      </div>
      <div style="font-size:10px;text-transform:uppercase;color:var(--text3);margin-bottom:4px;letter-spacing:0.05em;">Country Distribution Trace</div>
      <div class="matrix-sub-flex" style="margin-bottom:8px;">${countriesBlock||'<span style="color:var(--text3)">None</span>'}</div>
      <div style="font-size:10px;text-transform:uppercase;color:var(--text3);margin-bottom:4px;letter-spacing:0.05em;">Source Channel Breakdown</div>
      <div class="matrix-sub-flex">${platformsBlock||'<span style="color:var(--text3)">None</span>'}</div>
    </div>`;
  }).join('');
}

// ── Stock × Leads Overlap ──
function renderStockLeadsOverlap(allowedBrands,allowedPlatforms) {
  const el = document.getElementById('rep-overlap');
  if (!el) return;
  let groups = S.cache.groups || [];
  const stock = S.stock || [];
  if(!allowedBrands)({allowedBrands,allowedPlatforms}=getCurrentUserRestrictions());
  if(allowedBrands.length>0) groups=groups.filter(g=>allowedBrands.includes(g.brand));
  if(allowedPlatforms.length>0) groups=groups.filter(g=>allowedPlatforms.includes(g.platform));
  if (!groups.length || !stock.length) {
    el.innerHTML = '<div style="text-align:center;color:var(--text3);font-size:12px;">Load both Leads and Stock data first.</div>';
    return;
  }
  const leadBrands = {};
  groups.filter(g => !g.isAggregatedTail).forEach(g => {
    if (!leadBrands[g.brand]) leadBrands[g.brand] = { count: 0, countries: new Set() };
    leadBrands[g.brand].count += g.count;
    leadBrands[g.brand].countries.add(g.country);
  });
  const critStatuses = ['Urgency Alert', 'Liquidation Risk', 'Out of Stock'];
  const overlaps = [];
  Object.entries(leadBrands).forEach(([brand, ld]) => {
    const crit = stock.filter(s => s.brand === brand && critStatuses.includes(s.status));
    if (!crit.length) return;
    const byStatus = {};
    crit.forEach(i => { byStatus[i.status] = (byStatus[i.status] || 0) + 1; });
    overlaps.push({ brand, leadCount: ld.count, countries: [...ld.countries], byStatus });
  });
  overlaps.sort((a, b) => b.leadCount - a.leadCount);
  if (!overlaps.length) {
    el.innerHTML = '<div style="text-align:center;color:var(--green);font-size:12px;padding:12px;">✓ No critical stock issues overlap with active leads.</div>';
    return;
  }
  const sc = { 'Urgency Alert': 'var(--amber)', 'Liquidation Risk': 'var(--red)', 'Out of Stock': 'var(--blue)' };
  el.innerHTML = overlaps.slice(0, 8).map(o => `<div class="overlap-row">
    <div style="flex:1;min-width:0;">
      <div class="overlap-brand">${o.brand}</div>
      <div style="font-size:10px;color:var(--text3);margin-top:2px;">${o.leadCount} leads · ${o.countries.slice(0,3).join(', ')}</div>
    </div>
    <div style="display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end;">
      ${Object.entries(o.byStatus).map(([st,n]) => `<span style="font-size:10px;padding:2px 8px;border-radius:20px;background:${sc[st]}20;color:${sc[st]};font-weight:600;white-space:nowrap;">${n}× ${st}</span>`).join('')}
    </div>
  </div>`).join('');
}

// ── Regional Heatmap ──
function renderRegionalHeatmap(filteredGroups) {
  const el = document.getElementById('rep-heatmap');
  if (!el) return;
  let matrix;
  if(filteredGroups){
    const bm={};
    filteredGroups.filter(g=>!g.isAggregatedTail).forEach(g=>{
      if(!bm[g.brand])bm[g.brand]={brand:g.brand,breakdownByCountry:{},totalGlobalCount:0};
      bm[g.brand].breakdownByCountry[g.country]=(bm[g.brand].breakdownByCountry[g.country]||0)+g.count;
      bm[g.brand].totalGlobalCount+=g.count;
    });
    matrix=Object.values(bm);
  } else {
    const{allowedBrands,allowedPlatforms}=getCurrentUserRestrictions();
    let groups=S.cache.groups||[];
    if(allowedBrands.length>0) groups=groups.filter(g=>allowedBrands.includes(g.brand));
    if(allowedPlatforms.length>0) groups=groups.filter(g=>allowedPlatforms.includes(g.platform));
    const bm={};
    groups.filter(g=>!g.isAggregatedTail).forEach(g=>{
      if(!bm[g.brand])bm[g.brand]={brand:g.brand,breakdownByCountry:{},totalGlobalCount:0};
      bm[g.brand].breakdownByCountry[g.country]=(bm[g.brand].breakdownByCountry[g.country]||0)+g.count;
      bm[g.brand].totalGlobalCount+=g.count;
    });
    matrix=Object.values(bm);
  }
  if (!matrix.length) {
    el.innerHTML = '<div style="text-align:center;color:var(--text3);font-size:12px;">Load leads data to view heatmap.</div>';
    return;
  }
  const allCountries = new Set();
  matrix.forEach(m => Object.keys(m.breakdownByCountry || {}).forEach(c => allCountries.add(c)));
  const countries = [...allCountries].sort((a, b) => {
    const tA = matrix.reduce((s, m) => s + (m.breakdownByCountry?.[a] || 0), 0);
    const tB = matrix.reduce((s, m) => s + (m.breakdownByCountry?.[b] || 0), 0);
    return tB - tA;
  }).slice(0, 12);
  let gMax = 0;
  matrix.forEach(m => Object.values(m.breakdownByCountry || {}).forEach(v => { if (v > gMax) gMax = v; }));
  const heatBg = v => {
    if (!v || !gMax) return 'transparent';
    const r = v / gMax;
    if (r > 0.7) return 'rgba(245,158,11,0.82)';
    if (r > 0.4) return 'rgba(245,158,11,0.5)';
    if (r > 0.15) return 'rgba(245,158,11,0.22)';
    return 'rgba(245,158,11,0.07)';
  };
  const heatFg = v => {
    if (!v || !gMax) return 'var(--text3)';
    return (v / gMax) > 0.4 ? '#000' : 'var(--text)';
  };
  el.innerHTML = `<div class="heatmap-wrap"><table class="heatmap-tbl">
    <thead><tr><th class="row-h">Brand</th>${countries.map(c => `<th>${c}</th>`).join('')}</tr></thead>
    <tbody>${matrix.map(m => `<tr><td class="row-label">${m.brand}</td>${countries.map(c => {
      const v = m.breakdownByCountry?.[c] || 0;
      return `<td style="background:${heatBg(v)};color:${heatFg(v)};">${v || ''}</td>`;
    }).join('')}</tr>`).join('')}</tbody>
  </table></div>`;
}

// ── Smart Campaign Timing ──
function renderCampaignTiming() {
  const el = document.getElementById('timing-list');
  if (!el) return;
  if (!S.history.length) {
    el.innerHTML = '<div style="text-align:center;color:var(--text3);font-size:12px;">Send campaigns to build timing insights.</div>';
    return;
  }
  const slots = {};
  S.history.forEach(h => {
    const d = new Date(h.ts);
    const day = d.toLocaleDateString('en-AE', { weekday: 'long' });
    const hr = d.getHours();
    const period = hr < 6 ? 'Night' : hr < 12 ? 'Morning' : hr < 17 ? 'Afternoon' : hr < 21 ? 'Evening' : 'Night';
    const key = `${day} ${period}`;
    if (!slots[key]) slots[key] = { sent: 0, total: 0, count: 0 };
    slots[key].sent += h.sent || 0;
    slots[key].total += (h.sent || 0) + (h.failed || 0);
    slots[key].count++;
  });
  const ranked = Object.entries(slots)
    .filter(([, v]) => v.total > 0)
    .map(([label, v]) => ({ label, rate: Math.round(v.sent / v.total * 100), sent: v.sent, count: v.count }))
    .sort((a, b) => b.rate - a.rate)
    .slice(0, 5);
  if (!ranked.length) { el.innerHTML = '<div style="text-align:center;color:var(--text3);font-size:12px;">Not enough data yet.</div>'; return; }
  el.innerHTML = ranked.map((r, i) => `<div class="timing-slot">
    <div class="timing-rank">#${i+1}</div>
    <div class="timing-label">${r.label}
      <div style="font-size:10px;color:var(--text3);margin-top:1px;">${r.count} campaign${r.count>1?'s':''} · ${r.sent.toLocaleString()} delivered</div>
    </div>
    <div class="timing-rate">${r.rate}%</div>
  </div>`).join('');
}
