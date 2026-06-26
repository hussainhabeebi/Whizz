// ── Dashboard Core logic ──
function renderStats(d){
  document.getElementById('stat-open').textContent=d.open??'—';
  document.getElementById('stat-resolved').textContent=d.resolved??'—';
  // Sparkline history
  const SHKEY='whizz_stat_history';
  let hist=[];try{hist=JSON.parse(localStorage.getItem(SHKEY)||'[]');}catch{}
  hist.push({open:d.open||0,resolved:d.resolved||0,leads:S.cache.leadsTotal||0,platforms:(S.cache.platforms||[]).length,ts:Date.now()});
  if(hist.length>10)hist=hist.slice(-10);
  localStorage.setItem(SHKEY,JSON.stringify(hist));
  const sparkColor={open:'var(--amber)',resolved:'var(--green)',leads:'var(--blue)',platforms:'var(--red)'};
  ['open','resolved','leads','platforms'].forEach(k=>{
    const el=document.getElementById('spark-'+k);
    if(!el)return;
    const vals=hist.map(h=>h[k]||0);
    el.innerHTML=makeSpark(vals,sparkColor[k]);
  });
}
function makeSpark(vals,color){
  if(vals.length<2)return'';
  const w=100,h=28,pad=2;
  const min=Math.min(...vals),max=Math.max(...vals);
  const range=max-min||1;
  const pts=vals.map((v,i)=>{
    const x=pad+(i/(vals.length-1))*(w-pad*2);
    const y=h-pad-(v-min)/range*(h-pad*2);
    return`${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const last=vals[vals.length-1],prev=vals[vals.length-2];
  const dot=pts.split(' ').pop().split(',');
  const trend=last>=prev?color:'var(--red)';
  return`<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="${dot[0]}" cy="${dot[1]}" r="2.5" fill="${trend}"/></svg>`;
}
function renderDashConvs(convs){const el=document.getElementById('dash-convs');if(!convs.length){el.innerHTML='<div style="padding:24px;text-align:center;color:var(--text3);font-size:12px;">No open interaction items found</div>';return;}el.innerHTML=convs.slice(0,5).map(c=>convHtml(c)).join('');}
function renderDashCountries(groups){
  const el=document.getElementById('dash-countries');
  const cm={};
  groups.forEach(g=>{if(!g.isAggregatedTail){cm[g.country]=(cm[g.country]||0)+g.count;}});
  const sorted=Object.entries(cm).sort((a,b)=>b[1]-a[1]).slice(0,8);
  el.innerHTML=sorted.map(([c,n])=>`<div class="metric-row"><div class="m-label">${c}</div><div class="m-value" style="color:var(--accent)">${n}</div></div>`).join('');
}
