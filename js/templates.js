// ── Meta Template Module ──
function renderTplPage(templates){const el=document.getElementById('tpl-list');if(!templates.length){el.innerHTML='<div style="padding:32px;text-align:center;color:var(--text3);font-size:12px;">No approved template records identified inside WABA.</div>';return;}el.innerHTML=`<div class="tpl-grid">${templates.map(t=>`<div class="tpl-card" style="cursor:default;"><div class="tpl-name">${t.name}<span class="tpl-lang">${t.language}</span><span class="tpl-approved">APPROVED</span></div><div class="tpl-body">${t.body||'Empty body context'}</div></div>`).join('')}</div>`;}
function openTplModal(){document.getElementById('tpl-modal').classList.add('open');}
function closeTplModal(){document.getElementById('tpl-modal').classList.remove('open');}
async function createTemplate(){const name=document.getElementById('tpl-name').value.trim(),body=document.getElementById('tpl-body').value.trim();if(!name||!body){showToast('Structural template parameters missing','error');return;}try{const r=await api('whizz-create-template','POST',{name,body,language:document.getElementById('tpl-lang').value,category:document.getElementById('tpl-cat').value,header:document.getElementById('tpl-header').value.trim(),footer:document.getElementById('tpl-footer').value.trim()});if(r.success){showToast('Dispatched to Meta registration node successfully!','success');closeTplModal();refreshTemplates();}else showToast('Meta edge rejected packaging format','error');}catch(e){showToast('API communication drop','error');}}

// ── AI Template Generation ──
async function generateAiTemplate() {
  const brand  = document.getElementById('tpl-ai-brand').value.trim();
  const type   = document.getElementById('tpl-ai-type').value;
  const region = document.getElementById('tpl-ai-region').value.trim();
  const lang   = document.getElementById('tpl-lang').value;

  if (!brand) { showToast('Enter a Brand / Product name for AI context', 'error'); return; }

  const btn   = document.getElementById('ai-gen-btn');
  const label = document.getElementById('ai-gen-label');
  btn.disabled = true;
  label.textContent = 'Generating…';

  const bodyField = document.getElementById('tpl-body');
  const hint = bodyField.parentElement.querySelector('.fi-hint');
  let thinkEl = document.getElementById('ai-thinking-block');
  if (!thinkEl) {
    thinkEl = document.createElement('div');
    thinkEl.id = 'ai-thinking-block';
    thinkEl.className = 'ai-thinking';
    thinkEl.innerHTML = '<div class="ai-dot"></div><div class="ai-dot"></div><div class="ai-dot"></div><span>AI is crafting your WhatsApp template…</span>';
    bodyField.parentElement.insertBefore(thinkEl, bodyField);
  }
  thinkEl.style.display = 'flex';

  try {
    const r = await api('whizz-ai-template', 'POST', { brand, type, region, language: lang, company: 'Whizz Exim FZE' });
    if (r.body) {
      bodyField.value = r.body;
      if (r.header) document.getElementById('tpl-header').value = r.header;
      if (r.footer) document.getElementById('tpl-footer').value = r.footer;
      if (r.name)   document.getElementById('tpl-name').value = r.name;
      showToast('Template generated successfully!', 'success');
    } else {
      showToast('AI returned empty response — check n8n workflow', 'error');
    }
  } catch(e) {
    showToast('AI generation failed — ensure whizz-ai-template webhook is active', 'error');
  }

  thinkEl.style.display = 'none';
  btn.disabled = false;
  label.textContent = 'Regenerate with AI';
}
