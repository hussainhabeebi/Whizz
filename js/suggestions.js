// ── Broadcast Suggestions Module ──
function getTodayCampaigns() {
  const today = new Date().toDateString();
  return S.history.filter(h => new Date(h.ts).toDateString() === today);
}
function getWeekCampaigns() {
  const cutoff = Date.now() - 7*24*3600*1000;
  return S.history.filter(h => h.ts > cutoff);
}
function wasSentToday(templateName) {
  return getTodayCampaigns().some(h => h.template === templateName);
}
function wasSentRecently(templateName) {
  const cutoff = Date.now() - 24*3600*1000;
  return S.history.some(h => h.ts > cutoff && h.template === templateName);
}

function refreshSuggestions() {
  renderSuggestions();
  renderTodaySent();
  renderWeekSummary();
}

function renderSuggestions() {
  const el = document.getElementById('suggestions-list');
  if (!S.stock.length) {
    el.innerHTML = '<div style="text-align:center;color:var(--text3);font-size:12px;padding:32px;">Load stock data first — go to Stock page and click Refresh, then return here.</div>';
    return;
  }

  const liquidation = S.stock.filter(i => i.status === 'Liquidation Risk');
  const urgency     = S.stock.filter(i => i.status === 'Urgency Alert');
  const oos         = S.stock.filter(i => i.status === 'Out of Stock');
  const suggestions = [];

  const uniq = arr => [...new Set(arr)];

  uniq(liquidation.map(i=>i.brand)).slice(0,4).forEach(brand => {
    const items = liquidation.filter(i=>i.brand===brand);
    const total = items.reduce((a,i)=>a+i.stock,0);
    suggestions.push({ type:'liquidation', priority:'high', brand,
      regions: uniq(items.map(i=>i.region)),
      title: `Promotional Push — ${brand}`,
      desc: `${items.length} product line${items.length>1?'s':''} carrying ${total.toLocaleString()} units at liquidation risk. Send a targeted broadcast to drive immediate sales volume.`,
      icon:'red', tag:`${total.toLocaleString()} units excess` });
  });

  uniq(urgency.map(i=>i.brand)).slice(0,4).forEach(brand => {
    const items = urgency.filter(i=>i.brand===brand);
    suggestions.push({ type:'urgency', priority:'medium', brand,
      regions: uniq(items.map(i=>i.region)),
      title: `Scarcity Alert — ${brand}`,
      desc: `${items.length} item${items.length>1?'s':''} critically low (≤50 units). Use scarcity messaging to trigger immediate purchase decisions before stock runs out.`,
      icon:'amber', tag:`${items.length} item${items.length>1?'s':''} low` });
  });

  const demandAll = (S.demandData && S.demandData.all) ? S.demandData.all : [];
  const demandHigh = demandAll.filter(i=>i.level==='high').slice(0,2);
  const demandDormant = demandAll.filter(i=>i.level==='dormant'||i.level==='low').slice(0,2);
  demandHigh.forEach(item => {
    suggestions.push({ type:'demand-high', priority:'high', brand: item.brand,
      regions: ['Global'],
      title: `Strike While Hot — ${item.brand}`,
      desc: `${item.brand} is trending with ${item.mentions.toLocaleString()} web mentions this week (Demand Index: ${item.demandIndex}/100). Broadcast now while market interest is peaking.`,
      icon:'green', tag:`Index ${item.demandIndex}/100`, demandIndex: item.demandIndex });
  });
  demandDormant.forEach(item => {
    suggestions.push({ type:'demand-low', priority:'medium', brand: item.brand,
      regions: ['Global'],
      title: `Awareness Push — ${item.brand}`,
      desc: `${item.brand} has low market discussion (Demand Index: ${item.demandIndex}/100, ${item.mentions.toLocaleString()} mentions). A targeted broadcast could capture overlooked demand before competitors do.`,
      icon:'blue', tag:`Index ${item.demandIndex}/100`, demandIndex: item.demandIndex });
  });

  uniq(oos.map(i=>i.brand)).slice(0,3).forEach(brand => {
    const items = oos.filter(i=>i.brand===brand);
    suggestions.push({ type:'oos', priority:'low', brand,
      regions: uniq(items.map(i=>i.region)),
      title: `Restock Alert — ${brand}`,
      desc: `${items.length} item${items.length>1?'s':''} currently out of stock. Notify warm prospects to capture pre-order intent and prioritise your next order.`,
      icon:'blue', tag:`${items.length} OOS` });
  });

  if (!suggestions.length) {
    el.innerHTML = '<div style="text-align:center;color:var(--text3);font-size:12px;padding:32px;">All stock within optimal range — no urgent broadcast campaigns required.</div>';
    document.getElementById('suggest-badge').style.display='none';
    return;
  }

  const pOrd = {high:0,medium:1,low:2};
  suggestions.sort((a,b)=>pOrd[a.priority]-pOrd[b.priority]);

  const iconCfg = {
    red:   {bg:'var(--red-dim)',c:'var(--red)'},
    amber: {bg:'var(--amber-dim)',c:'var(--amber)'},
    blue:  {bg:'var(--blue-dim)',c:'var(--blue)'},
    green: {bg:'var(--green-dim)',c:'var(--green)'},
    purple:{bg:'rgba(139,92,246,0.1)',c:'#8b5cf6'}
  };
  const iconSvg = {
    liquidation:'<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>',
    urgency:'<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    oos:'<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
    'demand-high':'<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>',
    'demand-low':'<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>'
  };
  const pLabel = {high:'High Priority',medium:'Medium',low:'Low Priority'};
  const pColor = {high:'var(--red)',medium:'var(--amber)',low:'var(--blue)'};

  el.innerHTML = suggestions.map(s => {
    const ic = iconCfg[s.icon]||iconCfg.blue;
    const sentToday = wasSentToday(s.brand);
    const sentRecent = !sentToday && wasSentRecently(s.brand);
    const lastSent = S.history.find(h => h.audience && h.audience.toLowerCase().includes(s.brand.toLowerCase()));
    const lastTxt = lastSent && !sentToday && !sentRecent ? `Last: ${new Date(lastSent.ts).toLocaleDateString('en-AE',{day:'2-digit',month:'short'})}` : '';
    return `<div class="suggest-card">
      <div class="suggest-icon" style="background:${ic.bg};color:${ic.c}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${iconSvg[s.type]||iconSvg.oos}</svg>
      </div>
      <div class="suggest-body">
        <div class="suggest-title">${s.title}</div>
        <div class="suggest-desc">${s.desc}</div>
        <div class="suggest-meta">
          <span class="suggest-tag" style="color:${pColor[s.priority]};border-color:${pColor[s.priority]}40">${pLabel[s.priority]}</span>
          <span class="suggest-tag">${s.tag}</span>
          ${s.regions.length ? `<span class="suggest-tag">${s.regions.slice(0,3).join(', ')}</span>` : ''}
          ${sentToday ? '<span class="suggest-warn">⚠ Sent today already</span>' : ''}
          ${sentRecent ? '<span class="suggest-warn">Sent in last 24h</span>' : ''}
          ${lastTxt ? `<span style="font-size:10px;color:var(--text3)">${lastTxt}</span>` : ''}
        </div>
      </div>
      <div class="suggest-actions">
        <button class="t-btn btn-primary" style="padding:5px 10px;font-size:11px;white-space:nowrap;" onclick="launchSuggestedCampaign('${s.brand.replace(/'/g,"\\'")}',${sentToday||sentRecent})">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
          Campaign
        </button>
      </div>
    </div>`;
  }).join('');

  const highCount = suggestions.filter(s=>s.priority==='high').length;
  const badge = document.getElementById('suggest-badge');
  if (highCount > 0) { badge.textContent = highCount; badge.style.display='inline'; }
  else badge.style.display='none';
}

function renderTodaySent() {
  const el = document.getElementById('today-sent-list');
  const today = getTodayCampaigns();
  if (!today.length) { el.innerHTML = '<div style="text-align:center;color:var(--text3);font-size:12px;">No campaigns sent today.</div>'; return; }
  el.innerHTML = today.map(h => `<div class="today-sent-card">
    <div class="today-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg></div>
    <div style="flex:1;min-width:0;">
      <div style="font-size:12px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${h.template}</div>
      <div style="font-size:10px;color:var(--text3);">${h.audience} · ${h.sent} sent · ${new Date(h.ts).toLocaleTimeString('en-AE',{hour:'2-digit',minute:'2-digit'})}</div>
    </div>
    <div style="font-size:12px;font-weight:700;color:var(--green);flex-shrink:0;">${h.sent}</div>
  </div>`).join('');
}

function renderWeekSummary() {
  const el = document.getElementById('week-summary');
  const week = getWeekCampaigns();
  if (!week.length) { el.innerHTML = '<div style="text-align:center;color:var(--text3);font-size:12px;">No campaigns this week.</div>'; return; }
  const totalSent = week.reduce((a,h)=>a+(h.sent||0),0);
  const totalFailed = week.reduce((a,h)=>a+(h.failed||0),0);
  const tplCount = new Set(week.map(h=>h.template)).size;
  el.innerHTML = `
    <div class="metric-row"><div class="m-label">Campaigns Sent</div><div class="m-value" style="color:var(--accent)">${week.length}</div></div>
    <div class="metric-row"><div class="m-label">Templates Used</div><div class="m-value">${tplCount}</div></div>
    <div class="metric-row"><div class="m-label">Messages Delivered</div><div class="m-value" style="color:var(--green)">${totalSent.toLocaleString()}</div></div>
    <div class="metric-row"><div class="m-label">Failed</div><div class="m-value" style="color:var(--text3)">${totalFailed.toLocaleString()}</div></div>
    <div style="margin-top:12px;font-size:10px;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px;">Recent</div>
    ${week.slice(0,6).map(h=>`<div style="font-size:11px;color:var(--text2);padding:5px 0;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;"><span>${new Date(h.ts).toLocaleDateString('en-AE',{weekday:'short',day:'2-digit',month:'short'})} — ${h.template}</span><span style="color:var(--green);font-weight:600">${h.sent}</span></div>`).join('')}
  `;
}
