// ── Stock Module ──
async function refreshStock() {
  const d = await api('whizz-stock');
  S.cache.stock = d;
  S.stock = d.stock || [];
  S.stockCrossTab = d.crossTabMatrix || [];
  S.stockBrands = d.brands || [];
  S.stockRegions = d.regions || [];
  S.stockParentGroups = d.parentGroups || [];
  renderStockPage();
  fetchStockDemandScores();
}

async function fetchStockDemandScores() {
  const btn = document.getElementById('demand-refresh-btn');
  const icon = document.getElementById('demand-refresh-icon');
  if (btn) { btn.disabled = true; icon && icon.classList.add('spin'); }
  document.getElementById('demand-body').innerHTML = '<div class="ai-thinking" style="justify-content:center;"><div class="ai-dot"></div><div class="ai-dot"></div><div class="ai-dot"></div><span style="margin-left:6px;">Fetching NewsAPI demand scores per product…</span></div>';
  try {
    const items = S.stock.map(i => ({ name: i.productName, alias: i.alias }));
    const d = await api('whizz-demand-index', 'POST', { items });
    S.cache.demandIndex = d;
    S.demandData = d;
    S.demandByItem = {};
    (d.all || [...(d.mostDiscussed||[]), ...(d.leastDiscussed||[])]).forEach(entry => {
      S.demandByItem[entry.name || entry.productName] = entry;
    });
    renderDemandIndex(d);
    if (document.getElementById('demand-updated'))
      document.getElementById('demand-updated').textContent = 'Updated ' + new Date().toLocaleTimeString('en-AE',{hour:'2-digit',minute:'2-digit'});
    const high = (d.mostDiscussed||[]).length;
    if (document.getElementById('stock-trending')) document.getElementById('stock-trending').textContent = high;
    saveCache();
    applyStockFilters();
    renderStockMatrix();
  } catch(e) {
    document.getElementById('demand-body').innerHTML = '<div style="text-align:center;color:var(--red);font-size:12px;padding:24px;">Failed to fetch demand data — ensure <strong>whizz-demand-index</strong> webhook is active in n8n.</div>';
  }
  if (btn) { btn.disabled = false; icon && icon.classList.remove('spin'); }
}

function renderStockPage() {
  const s = S.stock;
  document.getElementById('stock-total').textContent = s.length;
  document.getElementById('stock-urgency').textContent = s.filter(i => i.status === 'Urgency Alert').length;
  document.getElementById('stock-liquidation').textContent = s.filter(i => i.status === 'Liquidation Risk').length;
  document.getElementById('stock-oos').textContent = s.filter(i => i.status === 'Out of Stock').length;
  const bEl = document.getElementById('stock-brand-chips');
  bEl.innerHTML = ['ALL', ...S.stockBrands].map(v => `<div class="chip ${S.activeStockBrand===v?'active':''}" onclick="filterStock('${v.replace(/'/g,"\\'")}',this)">${v}</div>`).join('');
  const rEl = document.getElementById('stock-region-chips');
  rEl.innerHTML = ['ALL', ...S.stockRegions].map(v => `<div class="chip ${S.activeStockRegion===v?'active':''}" onclick="filterStockRegion('${v.replace(/'/g,"\\'")}',this)">${v}</div>`).join('');
  const gEl = document.getElementById('stock-group-chips');
  gEl.innerHTML = ['ALL', ...S.stockParentGroups].map(v => `<div class="chip ${S.activeStockParentGroup===v?'active':''}" onclick="filterStockGroup('${v.replace(/'/g,"\\'")}',this)">${v}</div>`).join('');
  const statuses = ['Optimal Allocation','Urgency Alert','Liquidation Risk','Out of Stock'];
  const stEl = document.getElementById('stock-status-chips');
  stEl.innerHTML = ['ALL', ...statuses].map(v => `<div class="chip ${S.activeStockStatus===v?'active':''}" onclick="filterStockStatus('${v.replace(/'/g,"\\'")}',this)">${v}</div>`).join('');
  renderStockMatrix();
  applyStockFilters();
}

function filterStock(v,el){document.querySelectorAll('#stock-brand-chips .chip').forEach(c=>c.classList.remove('active'));el.classList.add('active');S.activeStockBrand=v;applyStockFilters();}
function filterStockRegion(v,el){document.querySelectorAll('#stock-region-chips .chip').forEach(c=>c.classList.remove('active'));el.classList.add('active');S.activeStockRegion=v;applyStockFilters();}
function filterStockGroup(v,el){document.querySelectorAll('#stock-group-chips .chip').forEach(c=>c.classList.remove('active'));el.classList.add('active');S.activeStockParentGroup=v;applyStockFilters();}
function filterStockStatus(v,el){document.querySelectorAll('#stock-status-chips .chip').forEach(c=>c.classList.remove('active'));el.classList.add('active');S.activeStockStatus=v;applyStockFilters();}

function applyStockFilters() {
  let f = S.stock;
  if (S.activeStockBrand !== 'ALL') f = f.filter(i => i.brand === S.activeStockBrand);
  if (S.activeStockRegion !== 'ALL') f = f.filter(i => i.region === S.activeStockRegion);
  if (S.activeStockParentGroup !== 'ALL') f = f.filter(i => i.parentGroup === S.activeStockParentGroup);
  if (S.activeStockStatus !== 'ALL') f = f.filter(i => i.status === S.activeStockStatus);
  renderStockTable(f);
}

function getDemandBadge(productName) {
  const d = S.demandByItem && S.demandByItem[productName];
  if (!d) return '<span style="font-size:10px;color:var(--text3);">—</span>';
  const colors = {high:'var(--green)',medium:'var(--amber)',low:'var(--red)',dormant:'var(--text3)'};
  const labels = {high:'🔥 Hot',medium:'~ Mid',low:'↓ Low',dormant:'· Dormant'};
  const c = colors[d.level]||colors.dormant;
  const l = labels[d.level]||labels.dormant;
  return `<div style="display:flex;flex-direction:column;gap:2px;min-width:70px;">
    <span style="font-size:11px;font-weight:700;color:${c};">${d.demandIndex}</span>
    <span style="font-size:9px;color:${c};opacity:0.85;">${l}</span>
  </div>`;
}

function renderStockTable(items) {
  const el = document.getElementById('stock-rows');
  document.getElementById('stock-filter-count').textContent = `${items.length} items`;
  if (!items.length) { el.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:40px;color:var(--text3);">No items match filters</td></tr>'; return; }
  const cls = {'Optimal Allocation':'status-optimal','Urgency Alert':'status-urgency','Liquidation Risk':'status-liquidation','Out of Stock':'status-oos'};
  el.innerHTML = items.map(i => `<tr>
    <td class="td-bold" title="${i.productName}">${i.productName.length>45?i.productName.slice(0,45)+'…':i.productName}</td>
    <td><span class="stock-sku">${i.alias}</span></td>
    <td>${i.brand}</td>
    <td>${i.region}</td>
    <td>${i.parentGroup}</td>
    <td><span class="stock-num">${i.stock.toLocaleString()}</span></td>
    <td>${getDemandBadge(i.productName)}</td>
    <td><span class="stock-status ${cls[i.status]||''}">${i.status}</span></td>
  </tr>`).join('');
}

function renderStockMatrix() {
  const el = document.getElementById('stock-matrix');
  if (!S.stockCrossTab.length) { el.innerHTML = '<div style="text-align:center;color:var(--text3);font-size:12px;padding:20px;">No matrix data.</div>'; return; }
  el.innerHTML = S.stockCrossTab.map(m => {
    const regBlock = Object.entries(m.breakdownByRegion||{}).map(([r,n])=>`<div class="matrix-sub-item">${r}: <span class="matrix-sub-val">${n.toLocaleString()}</span></div>`).join('');
    const grpBlock = Object.entries(m.breakdownByParentGroup||{}).map(([g,n])=>`<div class="matrix-sub-item" style="border-color:rgba(59,130,246,0.2)">${g}: <span class="matrix-sub-val" style="color:var(--blue)">${n.toLocaleString()}</span></div>`).join('');
    const demColors = {high:'var(--green)',medium:'var(--amber)',low:'var(--red)',dormant:'var(--text3)'};
    const demLabels = {high:'Hot',medium:'Mid',low:'Low',dormant:'Dormant'};
    const brandItems = S.demandByItem
      ? Object.values(S.demandByItem).filter(entry => {
          const match = S.stock.find(s => s.productName === (entry.name||entry.productName));
          return match && match.brand === m.brand;
        }).sort((a,b) => b.demandIndex - a.demandIndex)
      : [];
    const demBlock = brandItems.length
      ? `<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border);">
          <div style="font-size:10px;text-transform:uppercase;color:var(--text3);margin-bottom:5px;letter-spacing:0.05em;">NewsAPI Demand (per item)</div>
          ${brandItems.slice(0,5).map(entry => {
            const c = demColors[entry.level]||demColors.dormant;
            const l = demLabels[entry.level]||'—';
            const nm = (entry.name||entry.productName||'').slice(0,38);
            return `<div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;">
              <div style="flex:1;height:3px;background:var(--bg3);border-radius:2px;overflow:hidden;"><div style="height:3px;width:${entry.demandIndex}%;background:${c};border-radius:2px;"></div></div>
              <span style="font-size:10px;font-weight:700;color:${c};min-width:24px;text-align:right;">${entry.demandIndex}</span>
              <span style="font-size:9px;color:${c};min-width:40px;">${l}</span>
              <span style="font-size:9px;color:var(--text3);flex:2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${nm}</span>
            </div>`;
          }).join('')}
        </div>`
      : '';
    return `<div class="matrix-row-item">
      <div class="matrix-row-header"><span class="matrix-brand-name">${m.brand}</span><span class="matrix-total-pill">Total Volume: ${(m.totalGlobalVolume||0).toLocaleString()}</span></div>
      <div style="font-size:10px;text-transform:uppercase;color:var(--text3);margin-bottom:4px;letter-spacing:0.05em;">By Region</div>
      <div class="matrix-sub-flex" style="margin-bottom:8px;">${regBlock||'<span style="color:var(--text3)">—</span>'}</div>
      <div style="font-size:10px;text-transform:uppercase;color:var(--text3);margin-bottom:4px;letter-spacing:0.05em;">By Category</div>
      <div class="matrix-sub-flex">${grpBlock||'<span style="color:var(--text3)">—</span>'}</div>
      ${demBlock}
    </div>`;
  }).join('');
}

function exportStockCSV() {
  if (!S.stock.length) { showToast('Load stock data first', 'error'); return; }
  const rows = S.stock.map(i => {
    const dem = S.demandByItem && S.demandByItem[i.productName];
    const score = dem ? dem.demandIndex : '';
    const level = dem ? dem.level : '';
    return `"${i.productName}","${i.alias}","${i.brand}","${i.region}","${i.parentGroup}",${i.stock},${score},"${level}","${i.status}"`;
  });
  downloadCSV(['Product,SKU,Brand,Region,Category,Stock,Demand Score,Demand Level,Status', ...rows].join('\n'), 'whizz_stock_evaluation.csv');
  showToast('Export complete!', 'success');
}

async function refreshDemandIndex() {
  const btn = document.getElementById('demand-refresh-btn');
  const icon = document.getElementById('demand-refresh-icon');
  btn.disabled = true; icon.classList.add('spin');
  document.getElementById('demand-body').innerHTML = '<div class="ai-thinking" style="justify-content:center;"><div class="ai-dot"></div><div class="ai-dot"></div><div class="ai-dot"></div><span style="margin-left:6px;">Fetching web mentions for your brands…</span></div>';
  try {
    const items = S.stock.length ? S.stock.map(i => ({ name: i.productName, alias: i.alias })) : [];
    const d = await api('whizz-demand-index', 'POST', { items });
    S.cache.demandIndex = d;
    S.demandData = d;
    S.demandByItem = {};
    (d.all || [...(d.mostDiscussed||[]), ...(d.leastDiscussed||[])]).forEach(entry => {
      S.demandByItem[entry.name || entry.productName] = entry;
    });
    renderDemandIndex(d);
    document.getElementById('demand-updated').textContent = 'Updated ' + new Date().toLocaleTimeString('en-AE',{hour:'2-digit',minute:'2-digit'});
    const high = (d.mostDiscussed||[]).length;
    document.getElementById('stock-trending').textContent = high;
    saveCache();
    applyStockFilters();
    renderStockMatrix();
  } catch(e) {
    document.getElementById('demand-body').innerHTML = '<div style="text-align:center;color:var(--red);font-size:12px;padding:24px;">Failed to fetch — ensure <strong>whizz-demand-index</strong> webhook is active in n8n.</div>';
  }
  btn.disabled = false; icon.classList.remove('spin');
}

function renderDemandIndex(d) {
  const most = d.mostDiscussed || [];
  const least = d.leastDiscussed || [];
  const all = d.all || [];

  if (!most.length && !least.length) {
    document.getElementById('demand-body').innerHTML = '<div style="text-align:center;color:var(--text3);font-size:12px;padding:24px;">No data returned. Check your n8n workflow and brand list.</div>';
    return;
  }

  const levelCfg = {
    high:    { cls:'level-high',    glow:'demand-glow-high', bar:'var(--green)',  label:'High Demand' },
    medium:  { cls:'level-medium',  glow:'',                 bar:'var(--amber)',  label:'Moderate' },
    low:     { cls:'level-low',     glow:'demand-glow-low',  bar:'var(--red)',    label:'Low Demand' },
    dormant: { cls:'level-dormant', glow:'',                 bar:'var(--text3)',  label:'Dormant' }
  };

  const itemHtml = (item, rank) => {
    const cfg = levelCfg[item.level] || levelCfg.dormant;
    const scoreColor = item.level === 'high' ? 'var(--green)' : item.level === 'low' || item.level === 'dormant' ? 'var(--red)' : 'var(--amber)';
    return `<div class="demand-item ${cfg.glow}">
      <div class="demand-item-top">
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="font-size:10px;color:var(--text3);font-weight:700;min-width:16px;">#${rank}</span>
          <span class="demand-brand">${item.name||item.productName||item.brand||''}</span>
        </div>
        <span class="demand-score-pill" style="color:${scoreColor}">${item.demandIndex}</span>
      </div>
      <div class="demand-bar-track">
        <div class="demand-bar-fill" style="width:${item.demandIndex}%;background:${cfg.bar}"></div>
      </div>
      <div class="demand-meta">
        <span class="demand-mentions">${item.mentions.toLocaleString()} mentions</span>
        <div style="display:flex;gap:5px;align-items:center;">
          <span class="demand-level ${cfg.cls}">${cfg.label}</span>
          <button class="t-btn" style="padding:2px 8px;font-size:10px;background:var(--accent-dim);color:var(--accent);border:1px solid rgba(245,158,11,0.2);" onclick="launchDemandCampaign('${(item.name||item.productName||item.brand||'').replace(/'/g,"\\'")}','${item.level}')">Campaign</button>
        </div>
      </div>
    </div>`;
  };

  const getName = i => i.name||i.productName||i.brand||'—';
  const topBrand = getName(most[0]||{});
  const bottomBrand = getName(least[0]||{});
  const highCount = all.filter(i=>i.level==='high').length;
  const dormantCount = all.filter(i=>i.level==='dormant').length;
  const insight = `<strong>${topBrand}</strong> leads discussion this week — ideal for riding momentum with a broadcast. <strong>${bottomBrand}</strong> has the lowest online presence${dormantCount > 1 ? ` (${dormantCount} dormant items total)` : ''} — an awareness campaign could capture overlooked demand. ${highCount > 0 ? `<strong>${highCount}</strong> item${highCount>1?'s are':' is'} trending — prioritise stock readiness.` : ''}`;

  document.getElementById('demand-body').innerHTML = `
    <div class="demand-cols">
      <div>
        <div class="demand-section-title" style="color:var(--green);">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>
          Most Discussed
        </div>
        ${most.map((item,i) => itemHtml(item, i+1)).join('')}
      </div>
      <div>
        <div class="demand-section-title" style="color:var(--red);">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="23 18 13.5 8.5 8.5 13.5 1 6"/><polyline points="17 18 23 18 23 12"/></svg>
          Least Discussed
        </div>
        ${least.map((item,i) => itemHtml(item, (d.all||[]).length - i)).join('')}
      </div>
    </div>
    <div class="demand-insight">💡 <strong>Insight:</strong> ${insight}</div>
  `;
}
