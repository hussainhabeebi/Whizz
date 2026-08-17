// ── History CSV Engine ──
function saveHistory(entry) {
  S.history.unshift(entry);
  if (S.history.length > 50) S.history = S.history.slice(0, 50);
  S.cache.history = S.history;
  saveCache(); renderHistoryList();
  addNotif(`Campaign "${entry.template}" sent to ${entry.sent} contacts`);
}
function renderHistoryList() {
  const el = document.getElementById('history-list');
  if (!S.history.length) { el.innerHTML = '<div style="text-align:center;color:var(--text3);font-size:12px;padding:32px;">No campaigns sent yet.</div>'; return; }
  el.innerHTML = S.history.map(h => {const f=h.failures||{};const detail=[h.suppressed?`${h.suppressed} protected`:null,f.permanent?`${f.permanent} permanent`:null,f.transient?`${f.transient} temporary`:null,f.policy?`${f.policy} policy`:null].filter(Boolean).join(' · ');return `<div class="hist-item"><div class="hist-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></div><div class="hist-info"><div class="hist-name">${h.template} — ${h.audience}${h.paused?' · AUTO-PAUSED':''}</div><div class="hist-meta">${new Date(h.ts).toLocaleString('en-AE')} · ${h.total} contacts${detail?' · '+detail:''}</div></div><div class="hist-stats"><div class="hist-sent">${h.sent} sent</div><div class="hist-fail">${h.failed} failed</div></div></div>`;}).join('');
  renderCampaignTiming();
}
function exportHistoryCSV() {
  if (!S.history.length) { showToast('No history data available', 'error'); return; }
  const rows = S.history.map(h => `"${new Date(h.ts).toLocaleString()}","${h.template}","${h.audience}",${h.total},${h.sent},${h.failed}`);
  downloadCSV(['Date,Template,Audience,Total,Sent,Failed', ...rows].join('\n'), 'whizz_campaign_history.csv');
  showToast('Export complete!', 'success');
}
function downloadCSV(content, filename) { const a=document.createElement('a');a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(content);a.download=filename;a.click(); }
