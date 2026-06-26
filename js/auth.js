// ── Auth ──
function doLogin() {
  const email = document.getElementById('login-email').value.trim().toLowerCase();
  const pass = document.getElementById('login-password').value;
  const err = document.getElementById('login-error');
  const btn = document.getElementById('login-btn');
  err.style.display = 'none';
  const user = USERS[email];
  if (!user || user.hash !== safeEncode(pass)) { err.style.display = 'block'; document.getElementById('login-password').value = ''; return; }
  btn.disabled = true; btn.textContent = 'Signing in...';
  const session = { email, name: user.name, role: user.role, loginTime: Date.now() };
  localStorage.setItem('whizz_session', JSON.stringify(session));
  setTimeout(() => { initApp(session); btn.disabled = false; btn.textContent = 'Sign in'; }, 500);
}

function doLogout() {
  stopAutoSync();
  localStorage.removeItem('whizz_session');
  document.getElementById('app-shell').classList.remove('visible');
  document.getElementById('login-page').style.display = 'flex';
  document.getElementById('login-email').value = '';
  document.getElementById('login-password').value = '';
}

function initApp(session) {
  document.getElementById('login-page').style.display = 'none';
  document.getElementById('app-shell').classList.add('visible');
  const initials = session.name.split(' ').map(w=>w[0]).join('').toUpperCase();
  document.getElementById('u-avatar').textContent = initials;
  document.getElementById('u-name').textContent = session.name;
  document.getElementById('u-role').textContent = session.role;
  const navUsers = document.getElementById('nav-users');
  if (navUsers) navUsers.style.display = session.role === 'Administrator' ? 'flex' : 'none';
  loadCache(); loadOnboarding(); loadNotifications();
  startAutoSync();
  startScheduler();
  renderScheduledList();
}

window.addEventListener('load', () => {
  const s = localStorage.getItem('whizz_session');
  if (s) {
    const session = JSON.parse(s);
    if (Date.now() - session.loginTime < 8 * 3600 * 1000) initApp(session);
    else localStorage.removeItem('whizz_session');
  }
});
