// ── Auth ──
// Identity is established by Cloudflare Access at the edge (tiarafzco.com sits behind an
// Access application). We only read who Access already authenticated — the app never
// collects or checks a password.
async function getAccessIdentity() {
  try {
    const r = await fetch('/cdn-cgi/access/get-identity', { credentials: 'include' });
    if (!r.ok) return null;
    const d = await r.json();
    return d && d.email ? d : null;
  } catch (e) { return null; }
}

function showLoginError(message) {
  document.getElementById('login-status-title').textContent = 'Sign-in required';
  document.getElementById('login-status-sub').textContent = '';
  const err = document.getElementById('login-error');
  err.textContent = message;
  err.style.display = 'block';
}

async function bootAuth() {
  const identity = await getAccessIdentity();
  if (!identity) {
    showLoginError('Could not verify your Cloudflare Access session. Reload this page, or sign in again if prompted.');
    return;
  }
  const email = identity.email.trim().toLowerCase();
  const user = USERS[email];
  if (!user) {
    showLoginError(`${email} is authenticated but not provisioned in Whizz. Ask an Administrator to add you under Users.`);
    return;
  }
  const session = { email, name: user.name, role: user.role, loginTime: Date.now() };
  localStorage.setItem('whizz_session', JSON.stringify(session));
  initApp(session);
}

function doLogout() {
  stopAutoSync();
  localStorage.removeItem('whizz_session');
  document.getElementById('app-shell').classList.remove('visible');
  document.getElementById('login-page').style.display = 'flex';
  window.location.href = '/cdn-cgi/access/logout';
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

window.addEventListener('load', bootAuth);
