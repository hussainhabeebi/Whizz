// Leads-only presentation override.
// Replaces the lead-group card grid with a compact sortable table while preserving
// the existing filters, data, selection behavior, contact panel and backend calls.
(() => {
  if (typeof window.renderGroupCards !== 'function') return;

  const originalRenderGroupCards = window.renderGroupCards;
  const sortState = { key: 'count', dir: 'desc' };

  function esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function jsArg(value) {
    return String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  }

  function trendMeta(group) {
    if (group.trend === 'Trending Up') return { arrow: '▲', cls: 'up' };
    if (group.trend === 'Trending Down') return { arrow: '▼', cls: 'down' };
    return { arrow: '→', cls: 'stable' };
  }

  function sortedGroups(groups) {
    const list = [...(groups || [])];
    const { key, dir } = sortState;
    const mul = dir === 'asc' ? 1 : -1;
    return list.sort((a, b) => {
      if (key === 'count') return ((Number(a.count) || 0) - (Number(b.count) || 0)) * mul;
      if (key === 'trend') return ((Number(a.velocity30DayPct) || 0) - (Number(b.velocity30DayPct) || 0)) * mul;
      return String(a[key] || '').localeCompare(String(b[key] || ''), undefined, { sensitivity: 'base' }) * mul;
    });
  }

  function sortIcon(key) {
    if (sortState.key !== key) return '<span class="lead-sort-icon">↕</span>';
    return `<span class="lead-sort-icon active">${sortState.dir === 'asc' ? '↑' : '↓'}</span>`;
  }

  function renderLeadGroupTable(groups, id, selectable, clickFn) {
    const el = document.getElementById(id);
    if (!el) return;
    const rows = sortedGroups(groups);
    if (!rows.length) {
      el.innerHTML = '<div class="lead-table-empty">No lead groups match the current filters.</div>';
      return;
    }

    const fn = clickFn || 'selectLeadsGroup';
    el.innerHTML = `
      <div class="lead-groups-table-wrap">
        <table class="lead-groups-table">
          <thead>
            <tr>
              <th><button type="button" data-lead-sort="platform">Platform ${sortIcon('platform')}</button></th>
              <th><button type="button" data-lead-sort="country">Region ${sortIcon('country')}</button></th>
              <th><button type="button" data-lead-sort="brand">Brand ${sortIcon('brand')}</button></th>
              <th class="num"><button type="button" data-lead-sort="count">Leads ${sortIcon('count')}</button></th>
              <th><button type="button" data-lead-sort="trend">Trend ${sortIcon('trend')}</button></th>
              <th class="action">Action</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(g => {
              const trend = trendMeta(g);
              const groupKey = `${g.platform}||${g.country}||${g.brand}`;
              const selected = Array.isArray(window.S?.selectedGroups) && S.selectedGroups.includes(groupKey) ? ' selected' : '';
              const tail = g.isAggregatedTail ? ' g-tail-flag' : '';
              const call = `${fn}('${jsArg(g.platform)}','${jsArg(g.country)}','${jsArg(g.brand)}',this)`;
              return `<tr class="group-card lead-group-row${selected}${tail}" ${selectable ? `onclick="${call}"` : ''}>
                <td data-label="Platform"><span class="g-platform lead-platform">${esc(g.platform)}</span></td>
                <td data-label="Region"><span class="g-country">${esc(g.country)}</span></td>
                <td data-label="Brand"><span class="g-brand" title="${esc(g.brand)}">${esc(g.brand)}</span></td>
                <td data-label="Leads" class="lead-count-cell"><strong class="g-count">${Number(g.count) || 0}</strong></td>
                <td data-label="Trend"><span class="g-trend ${trend.cls}">${trend.arrow} ${Number(g.velocity30DayPct) || 0}%</span></td>
                <td data-label="Action" class="lead-action-cell">
                  ${selectable ? `<button type="button" class="lead-view-btn" onclick="event.stopPropagation();${fn}('${jsArg(g.platform)}','${jsArg(g.country)}','${jsArg(g.brand)}',this.closest('tr'))">View</button>` : ''}
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`;

    el.querySelectorAll('[data-lead-sort]').forEach(btn => {
      btn.addEventListener('click', event => {
        event.stopPropagation();
        const key = btn.dataset.leadSort;
        if (sortState.key === key) sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
        else {
          sortState.key = key;
          sortState.dir = key === 'count' || key === 'trend' ? 'desc' : 'asc';
        }
        renderLeadGroupTable(groups, id, selectable, clickFn);
      });
    });
  }

  window.renderGroupCards = function(groups, id, selectable, clickFn) {
    if (id === 'leads-groups') return renderLeadGroupTable(groups, id, selectable, clickFn);
    return originalRenderGroupCards(groups, id, selectable, clickFn);
  };

  const style = document.createElement('style');
  style.id = 'leads-table-view-styles';
  style.textContent = `
    #page-leads #leads-groups{display:block;}
    #page-leads .lead-groups-table-wrap{width:100%;overflow:auto;border:1px solid var(--border);border-radius:12px;background:var(--bg2);max-height:min(62vh,720px);}
    #page-leads .lead-groups-table{width:100%;border-collapse:separate;border-spacing:0;min-width:760px;font-size:12px;}
    #page-leads .lead-groups-table thead th{position:sticky;top:0;z-index:2;background:var(--bg3);border-bottom:1px solid var(--border2);padding:10px 14px;text-align:left;color:var(--text3);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;white-space:nowrap;}
    #page-leads .lead-groups-table thead th.num{text-align:right;}
    #page-leads .lead-groups-table thead th.action{text-align:right;width:86px;}
    #page-leads .lead-groups-table thead button{appearance:none;border:0;background:none;color:inherit;font:inherit;text-transform:inherit;letter-spacing:inherit;cursor:pointer;padding:0;display:inline-flex;align-items:center;gap:5px;}
    #page-leads .lead-groups-table thead button:hover{color:var(--accent);}
    #page-leads .lead-sort-icon{font-size:10px;opacity:.45;}
    #page-leads .lead-sort-icon.active{color:var(--accent);opacity:1;}
    #page-leads .lead-group-row.group-card{display:table-row;background:var(--bg2);border:0;border-radius:0;padding:0;margin:0;cursor:pointer;transition:background .12s ease;}
    #page-leads .lead-group-row.group-card:hover{background:var(--accent-dim);transform:none;box-shadow:none;border-color:transparent;}
    #page-leads .lead-group-row.group-card.selected{background:var(--accent-light);}
    #page-leads .lead-group-row.group-card.selected::after{display:none;}
    #page-leads .lead-group-row td{padding:11px 14px;border-bottom:1px solid var(--border);vertical-align:middle;color:var(--text2);height:54px;}
    #page-leads .lead-group-row:last-child td{border-bottom:0;}
    #page-leads .lead-platform{color:var(--accent);font-weight:700;font-size:12px;}
    #page-leads .lead-group-row .g-country{font-size:12px;font-weight:600;color:var(--text);margin:0;}
    #page-leads .lead-group-row .g-brand{font-size:11px;color:var(--text2);margin:0;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block;}
    #page-leads .lead-count-cell{text-align:right;}
    #page-leads .lead-count-cell .g-count{font-family:var(--font-display);font-size:17px;color:var(--text);}
    #page-leads .lead-group-row .g-trend{font-size:10px;font-weight:700;padding:3px 8px;border-radius:999px;display:inline-flex;align-items:center;gap:3px;white-space:nowrap;}
    #page-leads .lead-action-cell{text-align:right;}
    #page-leads .lead-view-btn{border:1px solid var(--border2);background:var(--bg2);color:var(--text2);border-radius:7px;padding:5px 11px;font:600 11px var(--font);cursor:pointer;transition:all .12s ease;}
    #page-leads .lead-view-btn:hover{border-color:var(--accent);color:var(--accent);background:var(--accent-dim);}
    #page-leads .lead-table-empty{text-align:center;padding:34px 18px;color:var(--text3);font-size:12px;border:1px dashed var(--border2);border-radius:10px;background:var(--bg3);}
    #page-leads .lead-group-row.g-tail-flag{background:rgba(245,158,11,.025);}

    @media(max-width:700px){
      #page-leads .lead-groups-table-wrap{border:0;background:transparent;overflow:visible;max-height:none;}
      #page-leads .lead-groups-table{min-width:0;display:block;}
      #page-leads .lead-groups-table thead{display:none;}
      #page-leads .lead-groups-table tbody{display:grid;gap:9px;}
      #page-leads .lead-group-row.group-card{display:grid;grid-template-columns:1fr auto;background:var(--bg2);border:1px solid var(--border);border-radius:10px;overflow:hidden;}
      #page-leads .lead-group-row td{display:flex;align-items:center;justify-content:space-between;gap:12px;height:auto;min-height:38px;padding:8px 12px;border-bottom:1px solid var(--border);}
      #page-leads .lead-group-row td::before{content:attr(data-label);font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text3);}
      #page-leads .lead-group-row td:nth-child(1),#page-leads .lead-group-row td:nth-child(2),#page-leads .lead-group-row td:nth-child(3){grid-column:1/3;}
      #page-leads .lead-group-row td:nth-child(4),#page-leads .lead-group-row td:nth-child(5){grid-column:auto;}
      #page-leads .lead-group-row td:nth-child(6){grid-column:1/3;border-bottom:0;}
      #page-leads .lead-action-cell .lead-view-btn{width:100%;padding:7px 10px;}
      #page-leads .lead-count-cell{text-align:left;}
    }
  `;
  document.head.appendChild(style);

  // If the Leads page was already rendered before this script loaded, repaint only
  // its group area using the current cached data; all other page DOM is untouched.
  if (window.S && Array.isArray(S.cache?.groups) && document.getElementById('leads-groups')) {
    try {
      const activePage = document.getElementById('page-leads');
      if (activePage?.classList.contains('active') && typeof window.applyLeadsFilter === 'function') window.applyLeadsFilter();
    } catch (error) {
      console.warn('[Whizz] Leads table view initial render skipped:', error);
    }
  }
})();
