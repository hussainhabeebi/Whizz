// ── Toast Notifications UI Node ──
const TOAST_ICONS={
  success:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>',
  error:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
  info:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
};
function showToast(msg,type='info'){
  const el=document.createElement('div');
  el.className=`toast ${type}`;
  const icon=document.createElement('span');
  icon.className='toast-icon';
  icon.innerHTML=TOAST_ICONS[type]||TOAST_ICONS.info;
  const text=document.createElement('span');
  text.className='toast-msg';
  text.textContent=msg;
  el.appendChild(icon);el.appendChild(text);
  document.getElementById('toast-wrap').appendChild(el);
  setTimeout(()=>{el.classList.add('out');setTimeout(()=>el.remove(),200);},4000);
}

// ── Phone normalization (for duplicate detection) ──
// Strips everything but digits, drops a leading trunk "0", and compares
// the trailing 9 digits so "+971501234567", "971501234567" and
// "0501234567" are all recognized as the same mobile number.
function normalizePhone(phone){
  if(!phone)return'';
  let digits=String(phone).replace(/\D/g,'');
  digits=digits.replace(/^0+/,'');
  if(digits.length<7)return digits;
  return digits.slice(-9);
}

// ── Dark / Light Mode ──
function toggleTheme(){
  const dark=document.body.classList.toggle('dark');
  localStorage.setItem('whizz_theme',dark?'dark':'light');
  document.getElementById('theme-icon-dark').style.display=dark?'none':'block';
  document.getElementById('theme-icon-light').style.display=dark?'block':'none';
}

// ── Modal Helpers ──
function closeModal(id){ document.getElementById(id).classList.remove('open'); }

// Apply saved theme on load
(function(){
  if(localStorage.getItem('whizz_theme')==='dark'){
    document.body.classList.add('dark');
    const d=document.getElementById('theme-icon-dark'),l=document.getElementById('theme-icon-light');
    if(d)d.style.display='none'; if(l)l.style.display='block';
  }
})();
