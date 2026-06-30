// ── Support Conversations Engine ──
function renderConvs(convs){
  const el=document.getElementById('conv-list');
  document.getElementById('conv-count').textContent=`${convs.length} operational records`;
  if(!convs.length){el.innerHTML='<div class="thread-empty">No interactions logged under this state filter</div>';return;}
  el.innerHTML=convs.map(c=>convHtml(c)).join('');
  if(S.selectedConvId && !convs.some(c=>String(c.id)===String(S.selectedConvId))){
    S.selectedConvId=null; renderThreadEmpty();
  }
}
function convHtml(c){
  const init=(c.contact_name||'U')[0].toUpperCase();
  const cls=c.channel?.includes('whatsapp')?'ch-wa':c.channel?.includes('email')?'ch-em':'ch-wc';
  const lbl=c.channel?.includes('whatsapp')?'WhatsApp':c.channel?.includes('email')?'Email':'Chat';
  const time=c.last_activity?new Date(c.last_activity*1000).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):'';
  const sel=String(c.id)===String(S.selectedConvId)?' selected':'';
  return`<div class="conv-item${sel}" onclick="selectConv('${c.id}')"><div class="c-avatar">${init}</div><div class="c-info"><div class="c-top"><div class="c-name">${c.contact_name||'Unknown'}</div><div class="c-time">${time}</div></div><div class="c-msg">${c.last_message||'No messages logged'}</div><div class="c-meta"><div class="sdot ${c.status==='open'?'dot-open':c.status==='resolved'?'dot-res':'dot-pend'}"></div><span class="ch-badge ${cls}">${lbl}</span>${c.unread>0?`<span class="unread">${c.unread}</span>`:''}<span class="open-cw" onclick="event.stopPropagation();window.open('${CW_URL}/${c.id}','_blank')">View Full Stack <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></span></div></div></div>`;
}
function filterConv(status,btn){document.querySelectorAll('[id^=f-]').forEach(b=>{b.className='t-btn btn-ghost';b.style.cssText='padding:5px 12px;font-size:11px;';});btn.className='t-btn btn-primary';btn.style.cssText='padding:5px 12px;font-size:11px;';S.convStatus=status;if(S.cache.conversations)renderConvs(S.cache.conversations);refreshConversations();}

// ── Conversation Thread Panel ──
function findConv(id){return (S.cache.conversations||[]).find(c=>String(c.id)===String(id));}

function renderThreadEmpty(){
  document.getElementById('thread-contact-name').textContent='Select a conversation';
  document.getElementById('thread-sub').textContent='';
  document.getElementById('thread-body').innerHTML='<div class="thread-empty">Select a conversation to view the message thread.</div>';
  document.getElementById('replay-btn').disabled=true;
  document.getElementById('open-cw-link').removeAttribute('href');
  document.getElementById('open-cw-link').style.opacity=0.4;
  document.getElementById('open-cw-link').style.pointerEvents='none';
}

async function selectConv(id){
  S.selectedConvId=id;
  if(S.cache.conversations)renderConvs(S.cache.conversations);
  const c=findConv(id);
  if(!c)return;
  document.getElementById('thread-contact-name').textContent=c.contact_name||'Unknown';
  document.getElementById('thread-sub').textContent=`${c.channel||'chat'} · ${c.status||''}`;
  const link=document.getElementById('open-cw-link');
  link.href=`${CW_URL}/${id}`;
  link.style.opacity=1;
  link.style.pointerEvents='auto';
  document.getElementById('replay-btn').disabled=false;
  await loadThread(c,{silent:false});
}

async function loadThread(c,{silent}={}){
  const body=document.getElementById('thread-body');
  if(!silent)body.innerHTML='<div class="thread-empty">Loading thread…</div>';
  let messages=null;
  try{
    const d=await api(`whizz-get-conversation-messages?id=${c.id}`);
    messages=d.messages||d.payload||null;
  }catch(e){messages=null;}
  if(Array.isArray(messages)&&messages.length){
    S.convMessages[c.id]=messages;
    renderThread(messages);
  }else{
    S.convMessages[c.id]=[{content:c.last_message||'No messages logged',sender:'them',created_at:c.last_activity}];
    body.innerHTML=`<div class="thread-empty">Full message thread unavailable from this view — showing latest message only.<br>Use "Open in Chatwoot" for complete history.</div>${threadBubbleHtml(S.convMessages[c.id][0])}`;
  }
}

function normalizeMsg(m){
  const outgoing=m.message_type===1||m.sender_type==='agent'||m.sender==='me'||m.outgoing===true;
  return{
    text:m.content||m.body||m.text||'',
    outgoing,
    time:m.created_at?new Date((m.created_at>1e12?m.created_at:m.created_at*1000)).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):''
  };
}
function threadBubbleHtml(raw){
  const m=normalizeMsg(raw);
  return `<div class="t-bubble-row ${m.outgoing?'t-out':'t-in'}"><div class="t-bubble">${m.text}</div><div class="t-bubble-time">${m.time}</div></div>`;
}
function renderThread(messages){
  document.getElementById('thread-body').innerHTML=messages.map(threadBubbleHtml).join('');
  const body=document.getElementById('thread-body');
  body.scrollTop=body.scrollHeight;
}

// ── Replay ──
async function replayThread(){
  const id=S.selectedConvId;
  if(!id)return;
  const messages=S.convMessages[id];
  if(!messages||!messages.length)return;
  const btn=document.getElementById('replay-btn');
  btn.disabled=true;btn.textContent='Replaying…';
  const body=document.getElementById('thread-body');
  body.innerHTML='';
  for(let i=0;i<messages.length;i++){
    body.insertAdjacentHTML('beforeend',threadBubbleHtml(messages[i]));
    body.scrollTop=body.scrollHeight;
    await new Promise(r=>setTimeout(r,messages.length>12?180:550));
  }
  btn.disabled=false;btn.textContent='Replay';
}

// ── Live Sync ──
function toggleLiveSync(){
  S.liveSync=!S.liveSync;
  const dot=document.getElementById('live-dot'),label=document.getElementById('live-label');
  if(S.liveSync){
    dot.className='sync-dot sync-ok';
    label.textContent='Live Sync On';
    S.liveSyncTimer=setInterval(liveSyncTick,12000);
    showToast('Live sync enabled — conversations refresh every 12s','success');
  }else{
    stopLiveSync(true);
  }
}
function stopLiveSync(skipToast){
  S.liveSync=false;
  if(S.liveSyncTimer){clearInterval(S.liveSyncTimer);S.liveSyncTimer=null;}
  const dot=document.getElementById('live-dot'),label=document.getElementById('live-label');
  if(dot){dot.className='sync-dot sync-idle';label.textContent='Live Sync Off';}
  if(!skipToast===false){}
}
async function liveSyncTick(){
  const dot=document.getElementById('live-dot');
  if(dot)dot.className='sync-dot sync-syncing';
  try{
    await refreshConversations();
    if(S.selectedConvId){
      const c=findConv(S.selectedConvId);
      if(c)await loadThread(c,{silent:true});
    }
  }catch(e){}
  if(dot)dot.className=S.liveSync?'sync-dot sync-ok':'sync-dot sync-idle';
}
