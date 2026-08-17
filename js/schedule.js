// ── Campaign Scheduler ──
function loadScheduled() {
  try { return JSON.parse(localStorage.getItem(SCHEDULE_KEY) || '[]'); } catch { return []; }
}
function saveScheduled(data) {
  localStorage.setItem(SCHEDULE_KEY, JSON.stringify(data));
}

function scheduleCampaign() {
  const dtVal = document.getElementById('sched-datetime')?.value;
  if (!dtVal) { showToast('Pick a date and time first', 'error'); return; }
  if (!S.selectedTemplate) { showToast('Select a template before scheduling', 'error'); return; }
  const fireAt = new Date(dtVal).getTime();
  if (fireAt <= Date.now()) { showToast('Scheduled time must be in the future', 'error'); return; }

  const allGroups = document.getElementById('all-groups').checked || S.selectedGroups.length === 0;
  const job = {
    id: 'sch_' + Date.now(),
    fireAt,
    template: S.selectedTemplate.name,
    language: S.selectedTemplate.language,
    audience: allGroups ? 'All' : S.selectedGroups.map(k => k.replaceAll('||', ' / ')).join(', '),
    platform: allGroups ? 'ALL' : (S.selectedGroups[0]?.split('||')[0] || 'ALL'),
    country:  allGroups ? 'ALL' : (S.selectedGroups[0]?.split('||')[1] || 'ALL'),
    brand:    allGroups ? 'ALL' : (S.selectedGroups[0]?.split('||')[2] || 'ALL'),
    audiences: allGroups ? [] : S.selectedGroups.map(key=>{const [platform,country,brand]=key.split('||');return {platform,country,brand};}),
    audienceRules: getCampaignAudienceRules(),
    deliveryGuard: getDeliveryGuardConfig(),
    createdAt: Date.now()
  };

  const data = loadScheduled();
  data.push(job);
  saveScheduled(data);
  showToast(`Campaign scheduled for ${new Date(fireAt).toLocaleString('en-AE')}`, 'success');
  addNotif(`Campaign "${job.template}" scheduled for ${new Date(fireAt).toLocaleString('en-AE',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}`);
  renderScheduledList();
}

function cancelScheduled(id) {
  if (!confirm('Cancel this scheduled campaign?')) return;
  const data = loadScheduled().filter(j => j.id !== id);
  saveScheduled(data);
  renderScheduledList();
  showToast('Scheduled campaign cancelled', 'info');
}

async function fireScheduledJob(job) {
  try {
    const result = await api('whizz-send-campaign', 'POST', {
      platform: job.platform,
      country: job.country,
      brand: job.brand,
      template_name: job.template,
      language: job.language,
      audiences: job.audiences || [],
      audience_rules: job.audienceRules || getCampaignAudienceRules(),
      delivery_guard: job.deliveryGuard || getDeliveryGuardConfig()
    });
    saveHistory({
      template: job.template,
      audience: job.audience,
      total: result.total,
      sent: result.sent,
      failed: result.failed,
      ts: Date.now(),
      scheduled: true
    });
    addNotif(`Scheduled campaign "${job.template}" fired — ${result.sent} delivered`);
  } catch(e) {
    addNotif(`Scheduled campaign "${job.template}" failed to send`);
    console.error('Scheduled job failed:', e);
  }
}

function checkScheduledCampaigns() {
  const now = Date.now();
  const data = loadScheduled();
  const remaining = [];
  const toFire = [];
  data.forEach(job => {
    if (job.fireAt <= now) toFire.push(job);
    else remaining.push(job);
  });
  if (toFire.length) {
    saveScheduled(remaining);
    toFire.forEach(job => fireScheduledJob(job));
    renderScheduledList();
  }
}

function renderScheduledList() {
  const el = document.getElementById('scheduled-list');
  if (!el) return;
  const data = loadScheduled().sort((a, b) => a.fireAt - b.fireAt);
  if (!data.length) {
    el.innerHTML = '<div style="text-align:center;color:var(--text3);font-size:12px;padding:16px;">No campaigns scheduled.</div>';
    return;
  }
  el.innerHTML = data.map(job => {
    const fireStr = new Date(job.fireAt).toLocaleString('en-AE', {day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'});
    const diff = job.fireAt - Date.now();
    const hrs = Math.floor(diff / 3600000);
    const mins = Math.floor((diff % 3600000) / 60000);
    const countdown = diff > 0 ? (hrs > 0 ? `in ${hrs}h ${mins}m` : `in ${mins}m`) : 'firing soon…';
    return `<div class="hist-item">
      <div class="hist-icon" style="background:var(--accent-dim);color:var(--accent);">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
      </div>
      <div class="hist-info">
        <div class="hist-name">${job.template} — ${job.audience}</div>
        <div class="hist-meta">${fireStr} · <span style="color:var(--accent)">${countdown}</span></div>
      </div>
      <button class="t-btn" style="padding:4px 10px;font-size:11px;background:var(--red-dim);color:var(--red);border:1px solid rgba(220,38,38,0.2);flex-shrink:0;" onclick="cancelScheduled('${job.id}')">Cancel</button>
    </div>`;
  }).join('');
}

let _schedulerInterval = null;
function startScheduler() {
  checkScheduledCampaigns();
  _schedulerInterval = setInterval(checkScheduledCampaigns, 60000);
}
