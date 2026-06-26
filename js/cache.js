// ── Cache Layer ──
function saveCache() { localStorage.setItem(CACHE_KEY, JSON.stringify({ data: S.cache, ts: Date.now() })); }
function loadCache() {
  const raw = localStorage.getItem(CACHE_KEY);
  if (!raw) return;
  const { data, ts } = JSON.parse(raw);
  S.cache = data || {};
  S.history = S.cache.history || [];
  renderHistoryList();
  if (S.cache.groups) {
    S.groups = S.cache.groups;
    S.crossTabMatrix = S.cache.crossTabMatrix || [];
    S.platforms = S.cache.platforms || [];
    S.countries = S.cache.countries || [];
    S.brands = S.cache.brands || [];
  }
  if (S.cache.templates) S.templates = S.cache.templates;
  const time = new Date(ts).toLocaleString('en-AE', {day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'});
  document.getElementById('dash-cache-time').textContent = time;
  if (S.cache.stats) { renderStats(S.cache.stats); showBanner('dash'); }
  if (S.cache.groups) { renderDashCountries(S.cache.groups); renderCampGroups(S.cache.groups); renderLeadsPage(S.cache.groups, S.cache.leadsTotal); showBanner('camp'); showBanner('leads'); }
  if (S.cache.templates) { renderTplPage(S.cache.templates); renderCampTemplates(S.cache.templates); showBanner('tpl'); }
  if (S.cache.conversations) { renderConvs(S.cache.conversations); renderDashConvs(S.cache.conversations); showBanner('conv'); }
  if (S.cache.stats || S.cache.crossTabMatrix) { renderReports(); showBanner('rep'); }
  if (S.cache.stock) {
    const sd = S.cache.stock;
    S.stock = sd.stock || []; S.stockCrossTab = sd.crossTabMatrix || [];
    S.stockBrands = sd.brands || []; S.stockRegions = sd.regions || []; S.stockParentGroups = sd.parentGroups || [];
    renderStockPage(); showBanner('stock');
  }
  if (S.cache.demandIndex) {
    S.demandData = S.cache.demandIndex;
    renderDemandIndex(S.cache.demandIndex);
    const high = (S.cache.demandIndex.mostDiscussed||[]).length;
    const trendEl = document.getElementById('stock-trending');
    if (trendEl) trendEl.textContent = high;
  }
}
function showBanner(p) { const el=document.getElementById(p+'-banner'); if(el)el.classList.add('show'); }
function hideBanner(p) { const el=document.getElementById(p+'-banner'); if(el)el.classList.remove('show'); }
