// ── Notifications ──
function loadNotifications() { const raw=localStorage.getItem(NOTIF_KEY);S.notifications=raw?JSON.parse(raw):[];renderNotifs(); }
function addNotif(text) {
  S.notifications.unshift({ text, ts: Date.now() });
  if (S.notifications.length > 20) S.notifications = S.notifications.slice(0, 20);
  localStorage.setItem(NOTIF_KEY, JSON.stringify(S.notifications));
  renderNotifs(); document.getElementById('notif-dot').classList.add('show');
}
function renderNotifs() {
  const el = document.getElementById('notif-list');
  if (!S.notifications.length) { el.innerHTML='<div class="notif-empty">No notifications</div>'; return; }
  el.innerHTML = S.notifications.slice(0,10).map(n=>`<div class="notif-item"><div><div class="notif-text">${n.text}</div><div class="notif-time">${new Date(n.ts).toLocaleString('en-AE',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}</div></div></div>`).join('');
}
function clearNotifs() { S.notifications=[];localStorage.removeItem(NOTIF_KEY);renderNotifs();document.getElementById('notif-dot').classList.remove('show'); }
function toggleNotif() { document.getElementById('notif-panel').classList.toggle('open');document.getElementById('notif-dot').classList.remove('show'); }
document.addEventListener('click',e=>{if(!e.target.closest('#notif-btn')&&!e.target.closest('#notif-panel'))document.getElementById('notif-panel').classList.remove('open');});
