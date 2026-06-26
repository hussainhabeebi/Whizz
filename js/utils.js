// ── Toast Notifications UI Node ──
function showToast(msg,type='info'){const el=document.createElement('div');el.className=`toast ${type}`;el.textContent=msg;document.getElementById('toast-wrap').appendChild(el);setTimeout(()=>el.remove(),4000);}

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
