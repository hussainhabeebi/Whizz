// ── Real-time Auto Sync ──
let _syncInterval = null;
let _hiddenAt = null;

function updateSyncIndicator(state) {
  const dot = document.getElementById('sync-dot');
  if (!dot) return;
  dot.className = 'sync-dot sync-' + state;
}

async function autoSyncTick() {
  updateSyncIndicator('syncing');
  try {
    await Promise.all([
      api('whizz-get-stats').then(d => {
        S.cache.stats = d;
        if (S.page === 'dashboard' || S.page === 'reports') renderStats(d);
      }).catch(() => {}),
      api('whizz-get-leads').then(d => {
        S.cache.groups = d.groups || [];
        S.cache.crossTabMatrix = d.crossTabMatrix || [];
        S.cache.leadsTotal = d.totalDistributedItems || d.total || 0;
        S.cache.platforms = d.platforms || [];
        S.cache.countries = d.countries || [];
        S.cache.brands = d.brands || [];
        S.groups = S.cache.groups;
        S.crossTabMatrix = S.cache.crossTabMatrix;
        S.platforms = S.cache.platforms;
        S.countries = S.cache.countries;
        S.brands = S.cache.brands;
      }).catch(() => {})
    ]);
    saveCache();
    const timeStr = new Date().toLocaleTimeString('en-AE', {hour:'2-digit', minute:'2-digit'});
    const updEl = document.getElementById('last-upd');
    if (updEl) updEl.textContent = 'Synced ' + timeStr;
    updateSyncIndicator('ok');
    setTimeout(() => updateSyncIndicator('idle'), 3000);
  } catch(e) {
    updateSyncIndicator('error');
    setTimeout(() => updateSyncIndicator('idle'), 5000);
  }
}

function startAutoSync() {
  autoSyncTick();
  _syncInterval = setInterval(autoSyncTick, 5 * 60 * 1000);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      _hiddenAt = Date.now();
    } else {
      if (_hiddenAt && (Date.now() - _hiddenAt) > 2 * 60 * 1000) {
        autoSyncTick();
      }
      _hiddenAt = null;
    }
  });
}

function stopAutoSync() {
  if (_syncInterval) {
    clearInterval(_syncInterval);
    _syncInterval = null;
  }
  updateSyncIndicator('idle');
}
