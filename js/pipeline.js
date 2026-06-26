// ── Lead Pipeline ──
const PIPE_KEY='whizz_pipeline_v1';
let _pipeId=0;
function pipelineLoad(){try{return JSON.parse(localStorage.getItem(PIPE_KEY)||'[]');}catch{return[];}}
function pipelineSave(data){localStorage.setItem(PIPE_KEY,JSON.stringify(data));}
const PIPE_STAGES=['new','contacted','interested','closed'];
const PIPE_LABELS={new:'New',contacted:'Contacted',interested:'Interested',closed:'Closed'};

function renderPipelinePage(){
  try{
    const data=pipelineLoad();
    PIPE_STAGES.forEach(stage=>{
      const cards=data.filter(c=>c.stage===stage);
      const cntEl=document.getElementById('pipe-cnt-'+stage);
      const cardsEl=document.getElementById('pipe-cards-'+stage);
      if(!cntEl||!cardsEl)return;
      cntEl.textContent=cards.length;
      cardsEl.innerHTML=cards.length
        ?cards.map(c=>pipeCardHtml(c)).join('')
        :`<div class="pipe-empty">No contacts</div>`;
    });
    const total=data.length;
    const totEl=document.getElementById('pipe-total');
    if(totEl)totEl.textContent=total?`${total} contact${total>1?'s':''} in pipeline`:'';
  }catch(e){console.error('Pipeline render error:',e);}
}

function pipeCardHtml(c){
  const stageIdx=PIPE_STAGES.indexOf(c.stage);
  const canLeft=stageIdx>0,canRight=stageIdx<PIPE_STAGES.length-1;
  const dateStr=c.addedAt?new Date(c.addedAt).toLocaleDateString([],{month:'short',day:'numeric'}):'';
  return`<div class="pipe-card" draggable="true" ondragstart="pipelineDragStart(event,'${c.id}')" id="pcard-${c.id}">
    <div class="pipe-card-name">${c.name}</div>
    ${c.phone?`<div class="pipe-card-meta">${c.phone}</div>`:''}
    ${c.email?`<div class="pipe-card-meta">${c.email}</div>`:''}
    ${c.notes?`<div class="pipe-card-meta" style="margin-top:4px;font-style:italic;">${c.notes}</div>`:''}
    <div class="pipe-card-foot">
      <span class="pipe-card-brand">${c.brand||'—'}</span>
      <div style="display:flex;gap:6px;align-items:center;">
        <span style="font-size:10px;color:var(--text3);">${dateStr}</span>
        <div class="pipe-move-btns">
          ${canLeft?`<button title="Move left" onclick="pipelineMove('${c.id}',-1)">←</button>`:'<button style="opacity:0.2;cursor:default;" disabled>←</button>'}
          ${canRight?`<button title="Move right" onclick="pipelineMove('${c.id}',1)">→</button>`:'<button style="opacity:0.2;cursor:default;" disabled>→</button>'}
          <button title="Delete" onclick="pipelineDelete('${c.id}')" style="color:var(--red);">✕</button>
        </div>
      </div>
    </div>
  </div>`;
}

function pipelineMove(id,dir){
  const data=pipelineLoad();
  const c=data.find(x=>x.id===id);
  if(!c)return;
  const idx=PIPE_STAGES.indexOf(c.stage);
  const next=PIPE_STAGES[idx+dir];
  if(next){c.stage=next;pipelineSave(data);renderPipelinePage();}
}

function pipelineDelete(id){
  if(!confirm('Remove this contact from the pipeline?'))return;
  const data=pipelineLoad().filter(x=>x.id!==id);
  pipelineSave(data);renderPipelinePage();
}

let _dragId=null;
function pipelineDragStart(event,id){
  _dragId=id;
  event.dataTransfer.effectAllowed='move';
  document.getElementById('pcard-'+id)?.classList.add('dragging');
}
function pipelineDrop(event,stage){
  event.preventDefault();
  document.querySelectorAll('.pipe-col').forEach(c=>c.classList.remove('drag-over'));
  if(!_dragId)return;
  const data=pipelineLoad();
  const c=data.find(x=>x.id===_dragId);
  if(c){c.stage=stage;pipelineSave(data);renderPipelinePage();}
  _dragId=null;
}
document.addEventListener('dragover',()=>{});
document.addEventListener('dragend',()=>{
  _dragId=null;
  document.querySelectorAll('.pipe-card').forEach(c=>c.classList.remove('dragging'));
});

function openAddPipelineModal(prefill){
  ['ap-name','ap-phone','ap-email','ap-brand','ap-notes'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('ap-stage').value='new';
  if(prefill){
    document.getElementById('ap-name').value=prefill.name||'';
    document.getElementById('ap-phone').value=prefill.phone||'';
    document.getElementById('ap-email').value=prefill.email||'';
    document.getElementById('ap-brand').value=prefill.brand||'';
  }
  document.getElementById('modal-add-pipeline').classList.add('open');
}
function submitAddPipeline(){
  const name=document.getElementById('ap-name').value.trim();
  if(!name){showToast('Name is required','error');return;}
  const data=pipelineLoad();
  data.push({
    id:'p'+(++_pipeId)+Date.now(),
    name,
    phone:document.getElementById('ap-phone').value.trim(),
    email:document.getElementById('ap-email').value.trim(),
    brand:document.getElementById('ap-brand').value.trim(),
    notes:document.getElementById('ap-notes').value.trim(),
    stage:document.getElementById('ap-stage').value,
    addedAt:Date.now()
  });
  pipelineSave(data);
  closeModal('modal-add-pipeline');
  showToast('Added to pipeline','success');
  if(S.page==='pipeline')renderPipelinePage();
}
