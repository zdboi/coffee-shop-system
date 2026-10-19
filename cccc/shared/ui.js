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

// Turns server / network errors into sentences a cashier (or the owner) can act on.
// The server sends a CODE as the error message, sometimes followed by extra text
// ("TABLE_NOT_ALLOWED: sales"); friendlyError() looks up the code at the start.
const ERROR_TEXT = {
  // PIN login / counter
  WRONG_PIN: 'Incorrect PIN.',
  TOO_MANY_ATTEMPTS: 'Too many tries. Please wait a few minutes and try again.',
  ROLE_TOO_LOW: 'That PIN does not have permission for this.',
  ADMIN_ONLY: 'Only an admin can do this.',
  ADMIN_ONLY_PIN: 'An admin PIN is required.',
  OWNER_ONLY: 'Only the owner\'s email login can do this.',
  NOT_A_MEMBER: 'This login is not linked to a shop.',
  NOT_ALLOWED: 'This login is not allowed to do this. If this is a counter, pair it again in Back Office → Devices.',
  BAD_PURPOSE: 'The PIN check could not be done. Reload the page and try again.',
  UNKNOWN_STAFF: 'That staff member is not in this shop any more. Ask the owner to check Back Office → Staff.',
  BAD_CODE: 'That pairing code is wrong or has expired. Make a new one in Back Office → Devices.',
  PIN_IN_USE: 'Another staff member already uses that PIN. Choose a different one.',
  PIN_FORMAT: 'PIN must be 4 to 6 digits (managers and the owner: 6 digits).',
  DEVICE_NOT_REGISTERED: 'This counter is not registered (it may have been removed in Back Office → Devices).',
  DEVICE_MISMATCH: 'This counter\'s login does not match its pairing. Pair it again in Back Office → Devices.',
  UNKNOWN_DEVICE: 'That counter was not found (it may have been removed already). Refresh the page and try again.',
  PIN_AMBIGUOUS: 'Two staff members share this PIN. Ask the owner to give one of them a new PIN in Back Office → Staff.',
  // Pairing a counter
  NOT_SIGNED_IN: 'This tablet\'s counter login was not ready. Reload the page and enter the pairing code again.',
  DEVICE_KEY_TAKEN: 'This tablet is already paired with a different shop. Ask that shop\'s owner to remove it in Back Office → Devices, then pair it again.',
  // Manager approval (refunds, voids, discounts, closing someone else's shift)
  APPROVAL_REQUIRED: 'This needs a manager\'s approval. Ask a manager to enter their PIN.',
  APPROVAL_INVALID: 'The manager approval expired or was already used. Ask the manager to enter their PIN again.',
  // Refunds and voids
  REFUND_TOO_LARGE: 'The refund is more than what is left to refund on this sale. Check the amount and try again.',
  RETURN_TOO_LARGE: 'More items are being returned than were sold (some may already be refunded). Check the quantities.',
  SALE_NOT_REFUNDABLE: 'This sale cannot be refunded: it is not finished yet, or it was already fully refunded.',
  SALE_NOT_FOUND: 'The sale for this refund is not on the server (it may not have uploaded). Please tell the owner.',
  BAD_AMOUNT: 'That amount is not valid. Enter an amount of ₱0 or more.',
  BAD_REFUND_TYPE: 'This refund has an unknown type, so it was not saved. Please tell the owner.',
  BAD_REFUND: 'This refund is missing information, so it was not saved. Please tell the owner.',
  // Sales and stock
  BAD_SALE: 'This sale is missing information, so it was not saved. Please tell the owner.',
  BAD_SALE_STATUS: 'This sale has an unknown status, so it was not saved. Please tell the owner.',
  SALE_LOCKED: 'A finished sale\'s amounts can\'t be changed.',
  SALE_TOTALS_MISMATCH: 'The sale total does not match its items, so the server did not save it. Please tell the owner.',
  UNKNOWN_INGREDIENT: 'An ingredient in this item no longer exists. Ask the owner to check the item\'s recipe in Back Office.',
  UNKNOWN_RECIPE: 'An item in this sale is no longer on the menu. Ask the owner to check the menu in Back Office.',
  SHIFT_NOT_FOUND: 'This shift is not on the server (it may not have uploaded). Please tell the owner.',
  FORBIDDEN_ROW: 'This could not be saved because it clashes with a record that already exists. Please tell the owner.',
  // QR orders / customers
  NOT_PAID: 'Take payment for this order first.',
  BAD_STATE: 'This order was already updated on another screen. Refreshing.',
  NOT_FOUND: 'This QR order was not found (it may have been removed). Refresh the list and try again.',
  QR_ORDER_ALREADY_PAID: 'This QR order was already paid on another counter.',
  BAD_PHONE: 'Enter a Philippine mobile number, e.g. 0917 123 4567.',
  NAME_REQUIRED: 'Enter the customer\'s name.',
  CONSENT_REQUIRED: 'Tick the box to confirm the customer agreed to join the loyalty list.',
  TOO_MANY_ORDERS: 'Too many orders are coming in right now. Please wait a few minutes.',
  TOO_MANY_SIGNUPS: 'Lots of new customers are joining right now. Please wait a few minutes, or save them without joining the loyalty list for now.',
  // Staff PINs
  PIN_TOO_SHORT: 'Managers and the owner need a 6-digit PIN.',
  PIN_UPDATE_NEEDED: 'This manager PIN is too short to approve. Ask the owner to set a new 6-digit PIN in Back Office → Staff.',
  // Anything unexpected on the server
  SERVER_ERROR: 'Something went wrong on the server, so this wasn\'t saved. Please try again; if it keeps happening, tell the owner.',
};

// Why the server flagged a sale "needs review" (sales.review_reason holds codes joined by ", ").
const REVIEW_REASON_TEXT = {
  PRICE_BELOW_MENU: 'Sold below the menu price',
  NOT_ON_MENU: 'Item not on the menu',
  TAX_MISMATCH: 'Tax or service charge doesn\'t match your settings',
  PAYMENT_MISMATCH: 'Payments don\'t add up to the total',
  STAFF_MISMATCH: 'Recorded cashier differs from who was signed in',
};
// "PRICE_BELOW_MENU, TAX_MISMATCH" -> "Sold below the menu price; Tax or service charge doesn't match your settings".
// Unknown codes become plain lower-case words; an empty reason gives 'Flagged by the server'.
// Returns plain text: escape it (esc / escapeHtml) before putting it into HTML.
function reviewReasonText(reasonString){
  const parts = String(reasonString == null ? '' : reasonString).split(/\s*,\s*/).map(s => s.trim()).filter(Boolean);
  if(!parts.length) return 'Flagged by the server';
  return parts.map(c => REVIEW_REASON_TEXT[c] || c.replace(/_/g, ' ').toLowerCase()).join('; ');
}
// The error code at the very start of a message: "APPROVAL_INVALID", "TABLE_NOT_ALLOWED: sales" ...
// Matches whole codes only, so "BAD_REFUND_TYPE" is never read as "BAD_REFUND".
function errorCode(text){
  const m = /^\s*(?:ERROR:\s*)?([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)(?![A-Za-z0-9_])/.exec(String(text == null ? '' : text));
  return m ? m[1] : null;
}
// "Too many wrong tries" with the time the lock ends (staff_pin_login sends locked_until).
function lockedUntilText(lockedUntil){
  const t = lockedUntil ? new Date(lockedUntil) : null;
  if(!t || isNaN(t)) return null;
  const mins = Math.ceil((t.getTime() - Date.now()) / 60000);
  if(mins <= 0) return 'Too many wrong PINs. You can try again now.';
  const wait = mins === 1 ? 'about 1 minute' : mins < 120 ? 'about ' + mins + ' minutes' : 'about ' + Math.round(mins / 60) + ' hours';
  return 'Too many wrong PINs. Try again at ' + fmtTime(t) + ' (' + wait + '), or ask the owner to unlock this counter in Back Office → Devices.';
}
// Accepts a CloudError / Error, a plain string, a server result such as
// {error:'TOO_MANY_ATTEMPTS', locked_until:'…'} or an fo_sync result {status:'error', message:'…'}.
function friendlyError(e){
  if(e == null || e === '') return 'Something went wrong.';
  if(e.offline) return e.message || 'No internet connection.';
  let raw = typeof e === 'string' ? e : (e.message || e.error || e.msg || '');
  if(raw && typeof raw === 'object') raw = raw.message || raw.error || '';
  raw = String(raw || '');
  const code = (e.code && ERROR_TEXT[e.code]) ? e.code : errorCode(raw);
  if(code === 'TOO_MANY_ATTEMPTS' && e.locked_until){
    const t = lockedUntilText(e.locked_until);
    if(t) return t;
  }
  if(code && ERROR_TEXT[code]) return ERROR_TEXT[code];
  if(/row-level security/i.test(raw)) return 'You do not have permission to change this.';
  if(/foreign key/i.test(raw)) return 'This record is still used elsewhere (e.g. in sales history), so it cannot be deleted.';
  if(/duplicate key/i.test(raw)) return 'That already exists.';
  return raw || 'Something went wrong.';
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
