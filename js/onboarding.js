// ── Onboarding ──
function loadOnboarding() {
  const raw=localStorage.getItem(OB_KEY);const done=raw?JSON.parse(raw):[];
  done.forEach(i=>{const el=document.getElementById('ob-'+i);if(el)el.classList.add('done');});updateObScore();
}
function toggleOb(i) {
  const el=document.getElementById('ob-'+i);el.classList.toggle('done');
  const raw=localStorage.getItem(OB_KEY);let done=raw?JSON.parse(raw):[];
  if(el.classList.contains('done')){if(!done.includes(i))done.push(i);}else done=done.filter(x=>x!==i);
  localStorage.setItem(OB_KEY,JSON.stringify(done));updateObScore();
}
function updateObScore() {
  const done=document.querySelectorAll('.ob-step.done').length;
  document.getElementById('ob-score').textContent=`${done}/5 complete`;
  document.getElementById('ob-prog').style.width=(done/5*100)+'%';
  if(done===5)document.getElementById('ob-badge').style.display='none';
}
