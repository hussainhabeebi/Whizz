// Global active-page auto refresh for Whizz.
// Keeps the current workspace fresh without reloading the browser or changing page state.
(() => {
  const AUTO_REFRESH_MS = 60 * 1000;
  let timer = null;
  let refreshing = false;
  let hiddenAt = null;

  async function refreshActivePage() {
    if (refreshing || document.hidden) return;
    if (typeof S === 'undefined' || !S || !S.page) return;
    const app = document.getElementById('app-shell');
    if (app && !app.classList.contains('visible')) return;

    refreshing = true;
    try {
      const page = S.page;

      // Use the app's existing refresh orchestration wherever it is safe and available.
      // Discovery is intentionally not re-run automatically because it can start a new
      // external discovery job; its existing results are simply re-rendered instead.
      if (page !== 'discovery' && typeof refreshPage === 'function') {
        await refreshPage();
      }

      // Pages whose data/state is not covered by refreshPage get a lightweight refresh.
      if (page === 'pipeline') {
        if (typeof refreshLeadData === 'function') await refreshLeadData();
        if (typeof renderPipelinePage === 'function') renderPipelinePage();
      } else if (page === 'users') {
        if (typeof renderUsersPage === 'function') await Promise.resolve(renderUsersPage());
      } else if (page === 'onboarding') {
        if (typeof renderOnboarding === 'function') renderOnboarding();
      } else if (page === 'discovery') {
        if (typeof renderDiscoveryResults === 'function') renderDiscoveryResults(S.discoveredContacts || []);
      } else if (page === 'tasks') {
        if (typeof renderTasks === 'function') renderTasks();
        else if (typeof renderTasksPage === 'function') renderTasksPage();
      }

      const updated = document.getElementById('last-upd');
      if (updated) {
        updated.textContent = 'Auto-refreshed ' + new Date().toLocaleTimeString('en-AE', {
          hour: '2-digit', minute: '2-digit'
        });
      }
    } catch (error) {
      console.warn('[Whizz] Auto refresh failed:', error);
    } finally {
      refreshing = false;
    }
  }

  function startGlobalAutoRefresh() {
    if (timer) clearInterval(timer);
    timer = setInterval(refreshActivePage, AUTO_REFRESH_MS);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      hiddenAt = Date.now();
      return;
    }
    // Refresh immediately when returning after being away for at least one cycle.
    if (hiddenAt && Date.now() - hiddenAt >= AUTO_REFRESH_MS) refreshActivePage();
    hiddenAt = null;
  });

  window.addEventListener('focus', () => {
    if (!document.hidden) refreshActivePage();
  });

  window.addEventListener('DOMContentLoaded', startGlobalAutoRefresh);
  window.whizzRefreshNow = refreshActivePage;
})();
