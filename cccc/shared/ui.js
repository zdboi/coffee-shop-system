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
  AMOUNT_NOT_POSITIVE: 'The amount must be more than ₱0.',
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
  // Stamp card rewards (release 1.2, 008)
  REWARD_NOT_AVAILABLE: 'This reward can\'t be used on this sale. Ask a manager to check the customer\'s stamp card.',
  REWARD_AMOUNT_MISMATCH: 'The reward amount didn\'t match. Remove the reward and add it again.',
  BAD_LOYALTY_REWARDS: 'The stamp card settings are not valid. Each reward needs a stamp number within the card size, and an amount above ₱0 for "amount off" rewards.',
  // Ingredient brands (release 1.2, 008)
  BRAND_IN_USE: 'This brand has purchases or stock, so it can\'t be deleted. Switch it off instead.',
  BRAND_MISMATCH: 'That brand belongs to a different ingredient. Choose one of this ingredient\'s brands.',
  BRAND_NOT_ALLOWED: 'A brand can only be set on starting stock, a purchase or a stock increase.',
  // Sub-category tile colours (release 1.2, 008)
  BAD_SUBCATEGORY_COLORS: 'The tile colours could not be saved. Pick a colour from the list for each sub-category (names up to 40 characters).',
  // CAPTCHA (Cloudflare Turnstile) before an anonymous sign-in
  CAPTCHA_FAILED: 'We couldn\'t confirm you\'re a person. Check your internet and try again.',
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

/* ================= Icons (release 1.2) =================
   icon(name, {size, label, className}) -> inline SVG string.
   Line icons on a 24 x 24 grid, drawn with currentColor, so they take the text colour.
   No label: aria-hidden (decorative; the button/link text names the action).
   With a label: role="img" + <title>, for icon-only controls.
   Unknown names give '' (never throws). ICON_NAMES lists every name. */
const ICON_PATHS = {
  'orders':        '<path d="M6 8h12l-1.2 11.2a2 2 0 0 1-2 1.8H9.2a2 2 0 0 1-2-1.8z"/><path d="M5 5h14v3H5z"/><path d="M9 12h6"/>',
  'qr':            '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3"/>',
  'users':         '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5"/>',
  'user':          '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  'receipt':       '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
  'clock':         '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  'grid':          '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  'lock':          '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  'search':        '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  'inbox':         '<path d="M3 13h5l1.5 3h5L16 13h5"/><path d="M5 5h14l2 8v6H3v-6z"/>',
  'plus':          '<path d="M12 5v14M5 12h14"/>',
  'minus':         '<path d="M5 12h14"/>',
  'trash':         '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/><path d="M9 7V4h6v3"/>',
  'edit':          '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  'check':         '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  'x':             '<path d="M6 6l12 12M18 6 6 18"/>',
  'chevron-left':  '<path d="m15 5-7 7 7 7"/>',
  'chevron-right': '<path d="m9 5 7 7-7 7"/>',
  'chevron-down':  '<path d="m5 9 7 7 7-7"/>',
  'printer':       '<path d="M7 9V3h10v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M7 14h10v7H7z"/>',
  'cash':          '<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.8"/><path d="M6 9.5v.01M18 14.5v.01"/>',
  'card':          '<rect x="2.5" y="5" width="19" height="14" rx="2"/><path d="M2.5 10h19M6.5 15h4"/>',
  'phone':         '<rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M11 18.5h2"/>',
  'wifi-off':      '<path d="M3 3l18 18"/><path d="M8.5 16.5a5 5 0 0 1 7 0"/><path d="M5 12.9a10 10 0 0 1 5.2-2.8M14.5 10.2A10 10 0 0 1 19 12.9"/><path d="M2 9.3a14.8 14.8 0 0 1 4.3-2.6M10.5 5.6A15 15 0 0 1 22 9.3"/><path d="M12 20h.01"/>',
  'alert':         '<path d="M12 3.5 2.5 20h19z"/><path d="M12 10v4.5M12 17.5v.01"/>',
  'star':          '<path d="m12 3 2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 16.8l-5.4 2.9 1.1-6.1-4.5-4.2 6.1-.8z"/>',
  'gift':          '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M5 12v9h14v-9M12 8v13"/><path d="M12 8S10.5 3.5 8 4.5 9 8 12 8zM12 8s1.5-4.5 4-3.5S15 8 12 8z"/>',
  'map':           '<path d="m3 6 6-2.5 6 2.5 6-2.5v14.5L15 20.5 9 18l-6 2.5z"/><path d="M9 3.5V18M15 6v14.5"/>',
  'table-square':  '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 3h6M9 21h6M3 9v6M21 9v6"/>',
  'table-round':   '<circle cx="12" cy="12" r="6"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2"/>',
  'settings':      '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
  'logout':        '<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"/><path d="M10 16l-4-4 4-4M6 12h10"/>',
  'download':      '<path d="M12 4v11M7 10.5l5 5 5-5"/><path d="M4 19.5h16"/>',
  'upload':        '<path d="M12 15.5V4.5M7 9l5-5 5 5"/><path d="M4 19.5h16"/>',
  'filter':        '<path d="M3.5 5h17l-6.5 8v6l-4-2v-4z"/>',
  'refresh':       '<path d="M20 11a8 8 0 0 0-14.3-4.3L4 9"/><path d="M4 4v5h5"/><path d="M4 13a8 8 0 0 0 14.3 4.3L20 15"/><path d="M20 20v-5h-5"/>',
  'home':          '<path d="M3.5 11 12 4l8.5 7"/><path d="M6 9.5V20h12V9.5"/><path d="M10 20v-6h4v6"/>',
  'box':           '<path d="m12 3 8.5 4.5v9L12 21l-8.5-4.5v-9z"/><path d="M3.5 7.5 12 12l8.5-4.5M12 12v9"/>',
  'chart':         '<path d="M4 4v16h16"/><path d="M8 16v-4M12 16V8M16 16v-7"/>',
  'cup':           '<path d="M5 8h11v6a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5z"/><path d="M16 10h1.5a2.5 2.5 0 0 1 0 5H16"/><path d="M8 3.5v2M11 3.5v2"/>',
  'info':          '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.5v.01"/>',
};
const ICON_NAMES = Object.keys(ICON_PATHS);
function icon(name, opts){
  const body = ICON_PATHS[name];
  if(!body) return '';
  opts = opts || {};
  const n = Number(opts.size);
  const size = (isFinite(n) && n > 0 && n <= 256) ? Math.round(n) : 22;
  const cls = 'cc-icon' + (opts.className ? ' ' + escapeHtml(opts.className) : '');
  const label = opts.label != null && String(opts.label).trim() !== '' ? String(opts.label) : '';
  const a11y = label ? `role="img" aria-label="${escapeHtml(label)}"` : 'aria-hidden="true" focusable="false"';
  return `<svg class="${cls}" ${a11y} width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">`
    + (label ? `<title>${escapeHtml(label)}</title>` : '') + body + '</svg>';
}

/* ================= Brand theme + logo (release 1.2) =================
   settings.theme: 'CUSTOM' = the shop's own colours / logo / font from Settings.
   Anything else (missing, 'CCCC', or the old 'light' / 'dark') = the CCCC brand look. */
function brandTheme(settings){
  const s = settings || (typeof state !== 'undefined' && state && state.settings) || {};
  return String(s.theme || '').toUpperCase() === 'CUSTOM' ? 'CUSTOM' : 'CCCC';
}
// Folder of the bundled brand files, worked out from where this script was loaded
// (…/cccc/shared/ui.js -> …/cccc/shared/brand/), so it is right for every app folder.
const BRAND_DIR = (function(){
  try{
    const src = document.currentScript && document.currentScript.src;
    if(src) return new URL('brand/', src).href;
  }catch(e){}
  return '../shared/brand/';   // apps live one folder below cccc/ (front/, back/, order/)
})();
const BRAND_ASSETS = {
  mark:             'tile-icon-192.webp',        // square tile icon (small marks, sign-in cards)
  'mark-large':     'tile-icon-512.webp',
  'wide-cream':     'logo-horizontal-cream.webp',
  'wide-terracotta':'logo-horizontal-terracotta.webp',
  'lockup-cream':   'logo-lockup-cream.webp',
  'wordmark-dark':       'wordmark-dark.webp',       // on the dark ink sidebar
  'wordmark-terracotta': 'wordmark-terracotta.webp', // on terracotta
  'wordmark-cream':      'wordmark-cream.webp',      // on paper / cream
};
const BRAND_NAME = 'Cavite City Coffee Club';
function brandAssetUrl(file){ return BRAND_DIR + file; }
// Safe custom logo URL (https / same-site relative only; never javascript: or data:).
function _customLogoUrl(s){
  const u = s && s.logo_url ? String(s.logo_url).trim() : '';
  if(!u) return '';
  if(/^https:\/\//i.test(u) || /^\.{0,2}\//.test(u)) return u;
  return '';
}
// brandLogo(variant, settings?) -> {src, alt, custom}
//   variant: 'mark' (default) | 'mark-large' | 'wide-cream' | 'wide-terracotta' | 'lockup-cream'
//   CCCC theme (or no logo_url): the bundled image. CUSTOM theme with logo_url: that image.
function brandLogo(variant, settings){
  const s = settings || (typeof state !== 'undefined' && state && state.settings) || {};
  const custom = brandTheme(s) === 'CUSTOM' ? _customLogoUrl(s) : '';
  if(custom) return {src: custom, alt: '', custom: true};
  const file = BRAND_ASSETS[variant] && !/^wordmark-/.test(variant) ? BRAND_ASSETS[variant] : BRAND_ASSETS.mark;
  return {src: brandAssetUrl(file), alt: '', custom: false};
}
// brandWordmark(variant, settings?) -> {src, alt, text}
//   variant: 'dark' (ink sidebar, default) | 'terracotta' | 'cream' (paper / cream background).
//   CCCC theme: the Brunson wordmark image, alt "Cavite City Coffee Club" (src set, text '').
//   CUSTOM theme: no image (src ''); text = the business name to show as plain text.
//   The shop name is never typed in the display font.
function brandWordmark(variant, settings){
  const s = settings || (typeof state !== 'undefined' && state && state.settings) || {};
  if(brandTheme(s) === 'CUSTOM'){
    const name = (s.business_name || (typeof state !== 'undefined' && state && state.business && state.business.name) || s.app_name || '').trim();
    return {src: '', alt: name, text: name};
  }
  const key = 'wordmark-' + (variant === 'terracotta' || variant === 'cream' ? variant : 'dark');
  return {src: brandAssetUrl(BRAND_ASSETS[key]), alt: BRAND_NAME, text: ''};
}
// Ready-made HTML for screens. Every value is escaped.
//   brandLogoHtml('mark', {className:'mark', alt:''})   -> <img …>
//   brandWordmarkHtml('dark', {className:'wm'})        -> <img …> or <span class="…">Business name</span>
function brandLogoHtml(variant, opts){
  opts = opts || {};
  const l = brandLogo(variant, opts.settings);
  const alt = opts.alt != null ? opts.alt : l.alt;
  return `<img class="${escapeHtml(opts.className || 'brand-mark')}" src="${escapeHtml(l.src)}" alt="${escapeHtml(alt)}" decoding="async">`;
}
function brandWordmarkHtml(variant, opts){
  opts = opts || {};
  const w = brandWordmark(variant, opts.settings);
  const cls = escapeHtml(opts.className || 'brand-wordmark');
  if(!w.src) return `<span class="${cls} brand-name-text">${escapeHtml(w.text)}</span>`;
  return `<img class="${cls}" src="${escapeHtml(w.src)}" alt="${escapeHtml(w.alt)}" decoding="async">`;
}
