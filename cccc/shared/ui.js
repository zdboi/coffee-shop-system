/* ================= Shared UI primitives (Front Office + Back Office) ================= */
function escapeHtml(s){ return String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function toast(msg, type='success'){
  const wrap = document.getElementById('toast-wrap');
  if(!wrap) return;
  const node = document.createElement('div');
  node.className = 'toast '+type;
  node.textContent = msg;
  wrap.appendChild(node);
  setTimeout(()=>{ node.style.opacity='0'; node.style.transition='opacity .3s'; setTimeout(()=>node.remove(),300); }, type==='error' ? 5200 : 3200);
}

function openModal({title, body, foot, wide, onMount, onClose}){
  closeModal();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'active-modal-overlay';
  overlay.innerHTML = `
    <div class="modal ${wide?'wide':''}" role="dialog" aria-modal="true">
      <div class="modal-head"><h2>${title}</h2><button class="close-x" id="modal-close" aria-label="Close">✕</button></div>
      <div class="modal-body">${body}</div>
      ${foot? `<div class="modal-foot">${foot}</div>`:''}
    </div>`;
  overlay._onClose = onClose || null;
  document.body.appendChild(overlay);
  overlay.querySelector('#modal-close').onclick = closeModal;
  overlay.addEventListener('mousedown', (e)=>{ if(e.target===overlay) closeModal(); });
  if(onMount) onMount(overlay);
}
function closeModal(){
  const node = document.getElementById('active-modal-overlay');
  if(node){ const cb = node._onClose; node.remove(); if(cb) cb(); }
}
function confirmDialog(message, okLabel){
  return new Promise(resolve=>{
    let answered = false;
    openModal({
      title:'Please confirm',
      body: `<p>${message}</p>`,
      foot: `<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-danger" data-ok>${okLabel||'Confirm'}</button>`,
      onClose: ()=>{ if(!answered) resolve(false); },
      onMount:(root)=>{
        root.querySelector('[data-cancel]').onclick = ()=>{ answered=true; closeModal(); resolve(false); };
        root.querySelector('[data-ok]').onclick = ()=>{ answered=true; closeModal(); resolve(true); };
      }
    });
  });
}
function el(html){
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
function statCard(label, value, sub){
  return `<div class="card stat-card"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub||''}</div></div>`;
}
function emptyBlock(text){ return `<div class="card empty-state" style="box-shadow:var(--shadow);"><div style="padding:10px 0;">${text}</div></div>`; }
function emptyLine(text){ return `<div class="text-light" style="padding:14px 0;font-size:13.5px;">${text}</div>`; }

// Turns server / network errors into sentences a cashier can act on.
const ERROR_TEXT = {
  WRONG_PIN: 'Incorrect PIN.',
  TOO_MANY_ATTEMPTS: 'Too many wrong attempts. Wait 5 minutes and try again.',
  ROLE_TOO_LOW: 'That PIN does not have permission for this.',
  ADMIN_ONLY: 'Only an admin can do this.',
  OWNER_ONLY: 'Only the owner\'s email login can do this.',
  NOT_A_MEMBER: 'This login is not linked to a shop.',
  BAD_CODE: 'That pairing code is wrong or has expired. Make a new one in Back Office → Devices.',
  PIN_IN_USE: 'Another staff member already uses that PIN. Choose a different one.',
  PIN_FORMAT: 'PIN must be 4 to 6 digits.',
  DEVICE_NOT_REGISTERED: 'This counter is not registered (it may have been removed in Back Office → Devices).',
  NOT_PAID: 'Take payment for this order first.',
  BAD_STATE: 'This order was already updated on another screen. Refreshing.',
  BAD_PHONE: 'Enter a Philippine mobile number, e.g. 0917 123 4567.',
  ADMIN_ONLY_PIN: 'An admin PIN is required.',
};
function friendlyError(e){
  if(!e) return 'Something went wrong.';
  if(e.offline) return e.message;
  const raw = (e.code && ERROR_TEXT[e.code]) ? e.code : (e.message || String(e));
  if(ERROR_TEXT[raw]) return ERROR_TEXT[raw];
  for(const k of Object.keys(ERROR_TEXT)){ if(raw.indexOf(k) === 0) return ERROR_TEXT[k]; }
  if(/row-level security/i.test(raw)) return 'You do not have permission to change this.';
  if(/foreign key/i.test(raw)) return 'This record is still used elsewhere (e.g. in sales history), so it cannot be deleted.';
  if(/duplicate key/i.test(raw)) return 'That already exists.';
  return raw;
}

function debounce(fn, ms){ let t; return function(){ const a=arguments, self=this; clearTimeout(t); t=setTimeout(()=>fn.apply(self,a), ms); }; }
function todayISO(d){ d = d || new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function fmtTime(d){ if(!d) return '—'; const dt = new Date(d); return isNaN(dt) ? '—' : dt.toLocaleTimeString('en-PH', {hour:'numeric', minute:'2-digit'}); }
function fmtDateTime(d){ if(!d) return '—'; return fmtDate(d)+' '+fmtTime(d); }
function timeAgo(d){
  const s = Math.max(0, Math.round((Date.now() - new Date(d).getTime())/1000));
  if(s < 60) return 'just now';
  if(s < 3600) return Math.floor(s/60)+' min ago';
  if(s < 86400) return Math.floor(s/3600)+' h ago';
  return fmtDate(d);
}
