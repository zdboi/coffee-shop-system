/* =====================================================================
   FRONT OFFICE (counter POS)
   Uses the same Supabase database as the Back Office through shared/data.js
   in "queued" mode: every sale is saved on the tablet first and uploaded in
   the background, so the counter keeps selling if the internet drops.
   The cart, checkout, held orders, shifts, cash drawer, receipts, refunds
   and voids are the same as the previous version. New pieces (pairing,
   server-checked PINs, QR order queue, customers, sync status) are in
   fo-extra.js.
   ===================================================================== */

const posState = {
  cart: [],              // [{lineId, recipeId, name, unitPrice, quantity, modifiers:[{group,label,priceDelta}], baseModCost}]
  discount: null,        // {type:'percent'|'fixed', value, appliedBy}
  currentUser: null,     // {id, name, role}
  route: 'pos',
  resumingHeldSaleId: null,
  catFilter: 'ALL',
  searchTerm: '',
  orderId: null,         // QR order being rung up
  customerId: null,      // customer attached to this sale (loyalty)
};

const ROLE_RANK = {CASHIER:1, MANAGER:2, ADMIN:3};
function hasRole(minRole){
  if(!posState.currentUser) return false;
  return ROLE_RANK[posState.currentUser.role] >= ROLE_RANK[minRole];
}

function updateOnlinePill_POS(){ if(typeof renderSyncPill==='function') renderSyncPill(); }

window.addEventListener('DOMContentLoaded', ()=>{ bootstrap().catch(err=>{ console.error(err); showFoBootError(friendlyError(err)); }); });

/* =====================================================================
   PIN GATE / SESSION
   PINs are checked by the server (Supabase), which also locks the tablet for
   a while after 5 wrong PINs. If the internet is down, staff who signed in
   on this tablet recently can still sign in (checked on the tablet).
   A cashier can't refund/discount/void without a manager entering their PIN.
   ===================================================================== */
let pinBuffer = '';
let pinBusy = false;
let pinMode = 'login'; // 'login' | 'override'
let pinOverrideResolve = null;
let pinOverrideMinRole = 'MANAGER';

let pinGateWired = false;
async function initPinGate(){
  await refreshPinGateMode();
  if(pinGateWired) return;
  pinGateWired = true;
  const press = (k)=>{
    unlockAlertSound();
    if(pinBusy) return;
    if(k==='clear') pinBuffer='';
    else if(k==='back') pinBuffer = pinBuffer.slice(0,-1);
    else if(k==='enter'){ if(pinBuffer.length>=4) trySubmitPin(); else showPinError('PINs have 4 to 6 digits'); return; }
    else if(pinBuffer.length<6) pinBuffer += k;
    renderPinDisplay();
    document.getElementById('pin-error').textContent = '';
    if(pinBuffer.length===6) setTimeout(trySubmitPin, 120);
  };
  document.getElementById('pin-pad').addEventListener('click', (e)=>{
    const btn = e.target.closest('button'); if(!btn) return;
    press(btn.dataset.k);
  });
  document.getElementById('pin-enter').addEventListener('click', ()=> press('enter'));
  document.addEventListener('keydown', (e)=>{
    if(document.getElementById('pin-gate').style.display==='none') return;
    if(/^[0-9]$/.test(e.key)) press(e.key);
    else if(e.key==='Backspace') press('back');
    else if(e.key==='Enter') press('enter');
    else if(e.key==='Escape') press('clear');
  });
}

function renderPinDisplay(){
  const disp = document.getElementById('pin-display');
  disp.innerHTML = Array.from({length:6}).map((_,i)=>`<span class="dot ${i<pinBuffer.length?'filled':''}"></span>`).join('');
}

async function refreshPinGateMode(){
  pinBuffer=''; renderPinDisplay();
  document.getElementById('pin-error').textContent='';
  if(pinMode!=='override'){
    pinMode = 'login';
    document.getElementById('pin-title').textContent = 'Enter your PIN';
    document.getElementById('pin-sub').textContent = `${businessName()||appDisplayName()} · ${(FO.device && FO.device.device_name)||'Counter'}`;
  }
}

async function trySubmitPin(){
  if(pinBusy || pinBuffer.length<4) return;
  pinBusy = true;
  const pin = pinBuffer;
  document.getElementById('pin-pad').classList.add('busy');
  try{
    const minRole = pinMode==='override' ? pinOverrideMinRole : null;
    const user = await verifyStaffPin(pin, minRole, pinMode!=='override');
    pinBuffer=''; renderPinDisplay();
    if(!user) return; // the reason is already shown under the pad
    if(pinMode==='override'){
      document.getElementById('pin-gate').style.display='none';
      restoreOverrideCancelLink();
      if(pinOverrideResolve) pinOverrideResolve(user);
      return;
    }
    await signIn(user);
  } finally {
    pinBusy = false;
    document.getElementById('pin-pad').classList.remove('busy');
  }
}
function showPinError(msg){ document.getElementById('pin-error').textContent = msg; }

async function signIn(user){
  posState.currentUser = {id:user.id, name:user.name, role:user.role};
  await logAudit('User login', user.name, `Role: ${user.role} · ${(FO.device&&FO.device.device_name)||''}`);
  document.getElementById('pin-gate').style.display='none';
  document.getElementById('app').style.display='flex';
  renderPOSShell();
  navigatePOS('pos');
}

async function lockSession(){
  if(posState.cart.length){
    const ok = await confirmDialog('There are items in the current order. Lock anyway? (Hold the order first if you want to keep it.)');
    if(!ok) return;
  }
  if(posState.currentUser) logAudit('User logout', posState.currentUser.name, '');
  posState.currentUser = null;
  posState.cart = []; posState.discount = null; posState.orderId = null; posState.customerId = null; posState.resumingHeldSaleId = null;
  document.getElementById('app').style.display='none';
  document.getElementById('pin-gate').style.display='flex';
  pinMode='login';
  if(navigator.onLine) sb.rpc('staff_sign_out').then(()=>{}, ()=>{});
  refreshPinGateMode();
}

// Prompts for a Manager (or higher) PIN inline, without losing the current session/cart.
// Returns the authorizing user, or null if cancelled.
function requireOverride(minRole='MANAGER'){
  if(hasRole(minRole)) return Promise.resolve(posState.currentUser);
  return new Promise((resolve)=>{
    pinOverrideMinRole = minRole;
    pinMode = 'override';
    pinOverrideResolve = (user)=>{ pinMode='login'; resolve(user); };
    document.getElementById('pin-title').textContent = `${minRole.charAt(0)+minRole.slice(1).toLowerCase()} PIN Required`;
    document.getElementById('pin-sub').textContent = 'Enter an authorized PIN to continue, or press Clear then close this to cancel.';
    document.getElementById('pin-error').textContent='';
    pinBuffer=''; renderPinDisplay();
    document.getElementById('pin-gate').style.display='flex';
    const cancelLink = document.querySelector('.pin-inventory-link');
    cancelLink.textContent = '← Cancel';
    cancelLink.href = 'javascript:void(0)';
    cancelLink.onclick = (e)=>{
      e.preventDefault();
      document.getElementById('pin-gate').style.display='none';
      restoreOverrideCancelLink();
      pinMode='login';
      resolve(null);
    };
  });
}
function restoreOverrideCancelLink(){
  const cancelLink = document.querySelector('.pin-inventory-link');
  cancelLink.textContent = 'Back Office (admins) →'; cancelLink.href='../backoffice/'; cancelLink.onclick=null;
}

/* ================= UI primitives (same pattern as the Inventory app) ================= */
function toast(msg, type='success'){
  const wrap = document.getElementById('toast-wrap');
  const el = document.createElement('div');
  el.className = 'toast '+type;
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(()=>{ el.style.opacity='0'; el.style.transition='opacity .3s'; setTimeout(()=>el.remove(),300); }, 3200);
}
function openModal({title, body, foot, wide, onMount}){
  closeModal();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'active-modal-overlay';
  overlay.innerHTML = `
    <div class="modal ${wide?'wide':''}">
      <div class="modal-head"><h2>${title}</h2><button class="close-x" id="modal-close">✕</button></div>
      <div class="modal-body">${body}</div>
      ${foot? `<div class="modal-foot">${foot}</div>`:''}
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#modal-close').onclick = closeModal;
  overlay.addEventListener('mousedown', (e)=>{ if(e.target===overlay) closeModal(); });
  if(onMount) onMount(overlay);
}
function closeModal(){
  const elx = document.getElementById('active-modal-overlay');
  if(elx) elx.remove();
}
function confirmDialog(message){
  return new Promise(resolve=>{
    openModal({
      title:'Please confirm', wide:false,
      body: `<p>${message}</p>`,
      foot: `<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-danger" data-ok>Confirm</button>`,
      onMount:(root)=>{
        root.querySelector('[data-cancel]').onclick = ()=>{closeModal(); resolve(false);};
        root.querySelector('[data-ok]').onclick = ()=>{closeModal(); resolve(true);};
      }
    });
  });
}
function el(html){
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
function escapeHtml(s){ return String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

/* ================= Shell & Navigation ================= */
const POS_NAV_ITEMS = [
  {id:'pos', label:'POS', ic:'🛒'},
  {id:'orders', label:'QR Orders', ic:'📱'},
  {id:'salesHistory', label:'Sales History', ic:'🧾'},
  {id:'reports', label:'Reports', ic:'📊', minRole:'MANAGER'},
  {id:'calendar', label:'Sales Calendar', ic:'📅', minRole:'MANAGER'},
  {id:'settings', label:'This Device', ic:'⚙'},
];

function renderPOSShell(){
  const logo = state.settings.logo ? `<img src="${state.settings.logo}" alt="logo" style="width:26px;height:26px;object-fit:contain;border-radius:6px;vertical-align:middle;margin-right:2px;">` : '🛒';
  document.getElementById('sidebar').innerHTML = `
    <div class="brand">${logo} <span>${escapeHtml(appDisplayName())}</span><small>${escapeHtml(businessName()) || 'Point of Sale'} · ${escapeHtml((FO.device&&FO.device.device_name)||'Counter')}</small></div>
    <div id="nav">${POS_NAV_ITEMS.filter(n=> !n.minRole || hasRole(n.minRole)).map(n=>`<div class="nav-item" data-route="${n.id}"><span class="ic">${n.ic}</span><span class="label">${n.label}</span>${n.id==='orders'?'<span class="nav-badge" id="orders-badge" style="display:none;"></span>':''}</div>`).join('')}
    </div>
    <div id="sidebar-foot">
      <div style="margin-bottom:8px;"><span class="role-badge">👤 ${escapeHtml(posState.currentUser.name)} · ${posState.currentUser.role}</span></div>
      <span id="offline-pill" class="online"><span class="dot"></span> Online</span>
      <button class="btn btn-ghost btn-sm" id="lock-btn" style="margin-top:8px;width:100%;">🔒 Lock / Switch User</button>
    </div>
  `;
  document.getElementById('nav').addEventListener('click', (e)=>{
    const item = e.target.closest('.nav-item');
    if(item) navigatePOS(item.dataset.route);
  });
  document.getElementById('lock-btn').onclick = lockSession;
  document.title = 'Front Office' + (businessName()? ' — '+businessName() : '');
  updateOnlinePill_POS();
  updateOrdersBadge();
}

const POS_ROUTE_TITLES = {
  pos:'Point of Sale', salesHistory:'Sales History', reports:'Reports', orders:'QR Orders', calendar:'Sales Calendar',
  settings:'This Device', saleDetail:'Transaction Detail',
};

function navigatePOS(route, param=null){
  if((route==='reports' || route==='calendar') && !hasRole('MANAGER')) route = 'pos';
  posState.route = route; posState.routeParam = param;
  document.querySelectorAll('.nav-item').forEach(elx=> elx.classList.toggle('active', elx.dataset.route===route));
  document.getElementById('topbar-title').textContent = POS_ROUTE_TITLES[route] || '';
  const renderers = {
    pos: renderPOSScreen, salesHistory: renderSalesHistory, reports: renderPOSReports,
    orders: renderOrdersBoard, calendar: renderFoCalendar,
    settings: renderDeviceScreen,
    saleDetail: ()=>renderSaleDetail(param),
  };
  document.getElementById('topbar-actions').innerHTML = '';
  const c = document.getElementById('content'); c.className = '';
  (renderers[route]||renderPOSScreen)();
}

/* ================= Main POS Screen ================= */
function sellableRecipes(){
  return state.recipes.filter(r => r.active!==false && r.pos_visible!==false && Number(r.selling_price) > 0);
}
function posCategoryOf(recipe){
  return (recipe.category && recipe.category.trim()) || recipeTypeLabel(recipeTypeOf(recipe));
}
// Can this recipe currently be made at least once, given on-hand stock of its ingredients?
function recipeAvailability(recipe){
  const {lines} = recipeCost(recipe.id);
  let lowest = Infinity;
  for(const l of lines){
    const stock = ingredientStock(l.ingredientId);
    const qtyNeeded = Number(l.quantity)||0;
    if(qtyNeeded<=0) continue;
    lowest = Math.min(lowest, Math.floor(stock/qtyNeeded));
  }
  return lowest===Infinity ? 99 : lowest; // how many more units are makeable right now
}

function renderPOSScreen(){
  const shift = activeShift();
  if(!shift){ renderStartShiftGate(); return; }

  const held = state.sales.filter(s=>s.status==='HELD' && (!s.device_id || s.device_id===Data.deviceId));
  document.getElementById('topbar-actions').innerHTML = `
    <span class="shift-badge" id="shift-badge" title="Opened ${fmtDate(shift.opened_at)} by ${escapeHtml(shift.cashier_name)}">🕐 Shift ${escapeHtml(shift.shift_number||'')} · ${shiftDuration(shift)}</span>
    ${held.length? `<button class="btn btn-outline" id="held-orders-btn">📥 Held Orders (${held.length})</button>` : ''}
    <button class="btn btn-outline" id="cash-mgmt-btn">💵 Cash Management</button>
    <button class="btn btn-danger" id="close-shift-btn">Close Shift</button>
  `;
  if(held.length) document.getElementById('held-orders-btn').onclick = showHeldOrders;
  document.getElementById('cash-mgmt-btn').onclick = openCashManagementModal;
  document.getElementById('close-shift-btn').onclick = openCloseShiftFlow;

  const content = document.getElementById('content');
  const recipes = sellableRecipes();
  const cats = ['ALL', ...new Set(recipes.map(posCategoryOf))].sort((a,b)=> a==='ALL'?-1:b==='ALL'?1:a.localeCompare(b));

  content.className = 'pos-layout';
  content.innerHTML = `
    <div class="pos-left">
      <div class="pos-search"><input type="text" id="pos-search" placeholder="🔍 Search products..." value="${posState.searchTerm}"></div>
      <div class="pos-cats" id="pos-cats">${cats.map(c=>`<button class="pos-cat-btn ${posState.catFilter===c?'active':''}" data-cat="${escapeHtml(c)}">${c}</button>`).join('')}</div>
      <div class="pos-product-grid" id="pos-product-grid"></div>
    </div>
    <div class="pos-cart" id="pos-cart-panel"></div>
  `;
  document.getElementById('pos-search').oninput = (e)=>{ posState.searchTerm = e.target.value; renderProductGrid(); };
  document.getElementById('pos-cats').addEventListener('click', (e)=>{
    const btn = e.target.closest('[data-cat]'); if(!btn) return;
    posState.catFilter = btn.dataset.cat;
    renderProductGrid();
    document.querySelectorAll('.pos-cat-btn').forEach(b=> b.classList.toggle('active', b.dataset.cat===posState.catFilter));
  });
  renderProductGrid();
  renderCartPanel();
}

/* ================= Shift gate / open / cash management / close ================= */
function renderStartShiftGate(){
  document.getElementById('topbar-actions').innerHTML = '';
  const content = document.getElementById('content');
  content.className = '';
  content.innerHTML = `
    <div style="max-width:420px;margin:60px auto;text-align:center;">
      <div style="font-size:44px;margin-bottom:6px;">🕐</div>
      <h2 style="font-family:var(--font-display);font-size:22px;margin-bottom:6px;">No Active Shift</h2>
      <p class="text-light" style="margin-bottom:20px;">Every sale needs to belong to a shift so cash and sales can be reconciled at the end of the day. Start one to begin selling.</p>
      <div class="card" style="text-align:left;">
        <div class="form-row"><label>Cashier</label><input value="${escapeHtml(posState.currentUser.name)}" disabled></div>
        <div class="form-row"><label>Opening Cash</label><input type="number" step="any" id="ss-opening-cash" placeholder="e.g. 2000"></div>
        <div class="form-row"><label>Notes (optional)</label><input id="ss-notes" placeholder="e.g. Regular Tuesday shift"></div>
        <button class="btn btn-primary" id="ss-start-btn" style="width:100%;margin-top:6px;">Start Shift</button>
      </div>
    </div>
  `;
  document.getElementById('ss-start-btn').onclick = async ()=>{
    const openingCash = Number(document.getElementById('ss-opening-cash').value);
    if(!(openingCash >= 0)){ toast('Enter a valid opening cash amount (0 or more)', 'error'); return; }
    const now = new Date().toISOString();
    const shift = {
      id: uid('shift'), shift_number: nextShiftNumber(), cashier_id: posState.currentUser.id,
      cashier_name: posState.currentUser.name, opened_at: now, closed_at: null, status:'ACTIVE',
      device_id: Data.deviceId, store_id: (FO.device && FO.device.store_id) || null,
      opening_cash: openingCash, declared_cash: null, notes: document.getElementById('ss-notes').value,
      created_at: now, updated_at: now,
    };
    await DB.put('shifts', shift);
    await logAudit('Shift opened', posState.currentUser.name, `${shift.shift_number} — opening cash ${fmtMoney(openingCash)}`, shift.id);
    await loadAll();
    toast(`Shift ${shift.shift_number} started`);
    navigatePOS('pos');
  };
}

function openCashManagementModal(){
  const shift = activeShift();
  if(!shift) return;
  let mode = 'PAY_IN';
  openModal({title:'Cash Management', body:`
    <div class="pay-methods" style="grid-template-columns:1fr 1fr;">
      <button class="pay-method-btn selected" data-mode="PAY_IN">💰<br>Pay In</button>
      <button class="pay-method-btn" data-mode="PAY_OUT">📤<br>Pay Out</button>
    </div>
    <div class="form-row" style="margin-top:14px;"><label>Amount</label><input type="number" step="any" id="cm-amount" placeholder="0.00"></div>
    <div class="form-row"><label>Reason</label><input id="cm-reason" placeholder="e.g. Change fund top-up / Petty cash for supplies"></div>
  `, foot:`<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" id="cm-save">Record</button>`,
  onMount:(root)=>{
    root.querySelector('[data-cancel]').onclick = closeModal;
    root.querySelectorAll('[data-mode]').forEach(b=> b.onclick = ()=>{ mode=b.dataset.mode; root.querySelectorAll('[data-mode]').forEach(x=>x.classList.toggle('selected', x===b)); });
    root.querySelector('#cm-save').onclick = async ()=>{
      const amount = Number(root.querySelector('#cm-amount').value);
      const reason = root.querySelector('#cm-reason').value.trim();
      if(!(amount > 0)){ toast('Enter an amount greater than 0', 'error'); return; }
      if(!reason){ toast('Enter a reason — this shows up on the shift report', 'error'); return; }
      const now = new Date().toISOString();
      const rec = {id: uid('cash'), shift_id: shift.id, type: mode, amount, reason, performed_by: posState.currentUser.id, performed_by_name: posState.currentUser.name, at: now, created_at: now};
      await DB.put('cashMovements', rec);
      await logAudit(mode==='PAY_IN'?'Cash pay-in':'Cash pay-out', posState.currentUser.name, `${fmtMoney(amount)} — ${reason}`, shift.id);
      await loadAll();
      closeModal();
      toast(`${mode==='PAY_IN'?'Pay in':'Pay out'} recorded`);
      if(posState.route==='pos') renderPOSScreen();
    };
  }});
}

async function openCloseShiftFlow(){
  const shift = activeShift();
  if(!shift) return;
  if(shift.cashier_id !== posState.currentUser.id){
    const authUser = await requireOverride('MANAGER');
    if(!authUser) return;
  }
  const m = shiftMetrics(shift);
  let declared = 0;
  const body = `
    <div class="grid grid-4">
      ${statCard('Gross Sales', fmtMoney(m.grossSales),'')}${statCard('Net Sales', fmtMoney(m.netSales),'')}
      ${statCard('Transactions', m.transactionCount, `${m.voidedCount} voided`)}${statCard('Refunds', fmtMoney(m.refundsOnly),'')}
    </div>
    <div class="section-title" style="font-size:15px;">Payment Breakdown</div>
    <div class="grid grid-3">${statCard('Cash', fmtMoney(m.cashGross),'')}${statCard('Card', fmtMoney(m.cardGross),'')}${statCard('Other', fmtMoney(m.otherGross),'')}</div>
    <div class="section-title" style="font-size:15px;">Cash Drawer</div>
    <div class="card" style="background:var(--beige);box-shadow:none;">
      <div class="row" style="display:flex;justify-content:space-between;padding:4px 0;"><span>Opening Cash</span><b>${fmtMoney(m.openingCash)}</b></div>
      <div class="row" style="display:flex;justify-content:space-between;padding:4px 0;"><span>Cash Sales (net of cash refunds)</span><b>${fmtMoney(m.netCashFromSales)}</b></div>
      <div class="row" style="display:flex;justify-content:space-between;padding:4px 0;"><span>Pay Ins (${m.payInCount})</span><b>+${fmtMoney(m.payIns)}</b></div>
      <div class="row" style="display:flex;justify-content:space-between;padding:4px 0;"><span>Pay Outs (${m.payOutCount})</span><b>-${fmtMoney(m.payOuts)}</b></div>
      <div class="row" style="display:flex;justify-content:space-between;padding:8px 0 0;border-top:1px dashed var(--beige-dark);margin-top:6px;font-size:16px;"><span><b>Expected Cash</b></span><b>${fmtMoney(m.expectedCash)}</b></div>
    </div>
    <div class="form-row" style="margin-top:14px;"><label>Declared Cash (actual counted amount)</label><input type="number" step="any" id="cs-declared" placeholder="0.00"></div>
    <div class="change-display" id="cs-variance-display" style="display:none;">
      <div class="lbl" id="cs-variance-lbl">Variance</div>
      <div class="val" id="cs-variance-val">₱0.00</div>
    </div>
    <div class="form-row" id="cs-notes-row" style="margin-top:10px;display:none;"><label>Reason for variance (required)</label><input id="cs-notes"></div>
  `;
  const foot = `<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-danger" id="cs-confirm">Confirm Close Shift</button>`;
  openModal({title:`Close Shift ${shift.shift_number||''}`, wide:true, body, foot, onMount:(root)=>{
    root.querySelector('[data-cancel]').onclick = closeModal;
    const varianceDisplay = root.querySelector('#cs-variance-display');
    const notesRow = root.querySelector('#cs-notes-row');
    function updateVariance(){
      declared = Number(root.querySelector('#cs-declared').value);
      if(isNaN(declared)){ varianceDisplay.style.display='none'; notesRow.style.display='none'; return; }
      const variance = declared - m.expectedCash;
      varianceDisplay.style.display='block';
      const label = Math.abs(variance) < 0.005 ? 'Balanced' : (variance>0 ? 'Over' : 'Short');
      root.querySelector('#cs-variance-lbl').textContent = label;
      root.querySelector('#cs-variance-val').textContent = fmtMoney(Math.abs(variance));
      root.querySelector('#cs-variance-val').style.color = Math.abs(variance)<0.005 ? 'var(--green)' : 'var(--red)';
      notesRow.style.display = Math.abs(variance) > 20 ? 'block' : 'none';
    }
    root.querySelector('#cs-declared').oninput = updateVariance;
    root.querySelector('#cs-confirm').onclick = async ()=>{
      if(isNaN(declared)){ toast('Enter the declared cash amount', 'error'); return; }
      const variance = declared - m.expectedCash;
      if(Math.abs(variance) > 20 && !root.querySelector('#cs-notes').value.trim()){
        toast('Please enter a reason for this variance', 'error'); return;
      }
      const now = new Date().toISOString();
      Object.assign(shift, {
        status:'CLOSED', closed_at: now, declared_cash: declared, expected_cash: m.expectedCash, cash_variance: variance,
        gross_sales: m.grossSales, net_sales: m.netSales, cash_sales: m.cashGross, card_sales: m.cardGross, other_sales: m.otherGross,
        refunds_total: m.refundsOnly, voids_total: m.voidsOnly, transaction_count: m.transactionCount,
        notes: (shift.notes||'') + (root.querySelector('#cs-notes').value? ' | Variance note: '+root.querySelector('#cs-notes').value : ''),
        updated_at: now,
      });
      await DB.put('shifts', shift);
      await logAudit('Shift closed', posState.currentUser.name, `${shift.shift_number} — variance ${fmtMoney(variance)}`, shift.id);
      await loadAll();
      closeModal();
      toast('Shift closed');
      showShiftReport(shift.id);
    };
  }});
}

function showShiftReport(shiftId){
  const shift = state.shifts.find(s=>s.id===shiftId);
  const m = shiftMetrics(shift);
  openModal({title:`Shift Report — ${shift.shift_number||''}`, wide:true, body:`
    <div style="font-size:13.5px;line-height:1.8;margin-bottom:14px;">
      <div>Cashier: <b>${escapeHtml(shift.cashier_name)}</b></div>
      <div>Opened: <b>${fmtDate(shift.opened_at)} ${new Date(shift.opened_at).toLocaleTimeString()}</b> — Closed: <b>${fmtDate(shift.closed_at)} ${new Date(shift.closed_at).toLocaleTimeString()}</b> (${shiftDuration(shift)})</div>
    </div>
    <div class="grid grid-4">
      ${statCard('Gross Sales', fmtMoney(shift.gross_sales),'')}${statCard('Net Sales', fmtMoney(shift.net_sales),'')}
      ${statCard('Transactions', shift.transaction_count, `${m.voidedCount} voided`)}${statCard('Refunds', fmtMoney(shift.refunds_total),'')}
    </div>
    <div class="grid grid-3" style="margin-top:14px;">${statCard('Cash', fmtMoney(shift.cash_sales),'')}${statCard('Card', fmtMoney(shift.card_sales),'')}${statCard('Other', fmtMoney(shift.other_sales),'')}</div>
    <div class="card" style="margin-top:14px;background:var(--beige);box-shadow:none;">
      <div style="display:flex;justify-content:space-between;padding:4px 0;"><span>Opening Cash</span><b>${fmtMoney(shift.opening_cash)}</b></div>
      <div style="display:flex;justify-content:space-between;padding:4px 0;"><span>Expected Cash</span><b>${fmtMoney(shift.expected_cash)}</b></div>
      <div style="display:flex;justify-content:space-between;padding:4px 0;"><span>Declared Cash</span><b>${fmtMoney(shift.declared_cash)}</b></div>
      <div style="display:flex;justify-content:space-between;padding:8px 0 0;border-top:1px dashed var(--beige-dark);margin-top:6px;font-size:16px;">
        <span><b>Variance</b></span><b style="color:${Math.abs(shift.cash_variance)<0.005?'var(--green)':'var(--red)'}">${shift.cash_variance>=0?'+':''}${fmtMoney(shift.cash_variance)}</b></div>
    </div>
    ${shift.notes?`<p class="hint" style="margin-top:10px;">${escapeHtml(shift.notes)}</p>`:''}
  `, foot:`<button class="btn btn-outline" id="sr-print">🖨 Print</button><button class="btn btn-primary" data-cancel>Done</button>`,
  onMount:(root)=>{
    root.querySelector('[data-cancel]').onclick = ()=>{ closeModal(); navigatePOS('pos'); };
    root.querySelector('#sr-print').onclick = ()=> printShiftReport(shift, m);
  }});
}

function printShiftReport(shift, m){
  const win = window.open('', '_blank');
  if(!win){ toast('Please allow pop-ups to print', 'error'); return; }
  win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Shift Report ${shift.shift_number}</title>
    <style>body{font-family:Georgia,serif;max-width:420px;margin:24px auto;color:#241209;font-size:13px;}
    .row{display:flex;justify-content:space-between;padding:3px 0;} hr{border:none;border-top:1px dashed #999;margin:10px 0;}
    h1{font-size:17px;}</style></head><body>
    <h1>${escapeHtml(businessName()||appDisplayName())} — Shift Report</h1>
    <div>${shift.shift_number} · ${escapeHtml(shift.cashier_name)}</div>
    <div>${fmtDate(shift.opened_at)} ${new Date(shift.opened_at).toLocaleTimeString()} → ${fmtDate(shift.closed_at)} ${new Date(shift.closed_at).toLocaleTimeString()}</div>
    <hr>
    <div class="row"><span>Gross Sales</span><b>${fmtMoney(shift.gross_sales)}</b></div>
    <div class="row"><span>Net Sales</span><b>${fmtMoney(shift.net_sales)}</b></div>
    <div class="row"><span>Transactions</span><b>${shift.transaction_count}</b></div>
    <div class="row"><span>Refunds</span><b>${fmtMoney(shift.refunds_total)}</b></div>
    <div class="row"><span>Voids</span><b>${fmtMoney(shift.voids_total)}</b></div>
    <hr>
    <div class="row"><span>Cash</span><b>${fmtMoney(shift.cash_sales)}</b></div>
    <div class="row"><span>Card</span><b>${fmtMoney(shift.card_sales)}</b></div>
    <div class="row"><span>Other</span><b>${fmtMoney(shift.other_sales)}</b></div>
    <hr>
    <div class="row"><span>Opening Cash</span><b>${fmtMoney(shift.opening_cash)}</b></div>
    <div class="row"><span>Expected Cash</span><b>${fmtMoney(shift.expected_cash)}</b></div>
    <div class="row"><span>Declared Cash</span><b>${fmtMoney(shift.declared_cash)}</b></div>
    <div class="row" style="font-size:15px;"><span><b>Variance</b></span><b>${shift.cash_variance>=0?'+':''}${fmtMoney(shift.cash_variance)}</b></div>
    ${shift.notes?`<hr><div>${escapeHtml(shift.notes)}</div>`:''}
    </body></html>`);
  win.document.close(); win.focus();
  setTimeout(()=>{ try{ win.print(); }catch(e){} }, 300);
}

function renderProductGrid(){
  const grid = document.getElementById('pos-product-grid');
  if(!grid) return;
  let list = sellableRecipes();
  if(posState.catFilter!=='ALL') list = list.filter(r=> posCategoryOf(r)===posState.catFilter);
  if(posState.searchTerm) list = list.filter(r=> r.name.toLowerCase().includes(posState.searchTerm.toLowerCase()));
  list.sort((a,b)=>a.name.localeCompare(b.name));
  if(list.length===0){ grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;">No products found. Add recipes with a selling price in the Back Office (Recipes & Menu).</div>`; return; }
  grid.innerHTML = list.map(r=>{
    const avail = recipeAvailability(r);
    const low = avail<=2;
    return `<div class="pos-product-card ${avail<=0?'unavailable':''}" data-recipe="${r.id}">
      <div><div class="ptag">${escapeHtml(posCategoryOf(r))}</div><div class="pname">${escapeHtml(r.name)}</div></div>
      <div class="pprice">${fmtMoney(r.selling_price)}${r.sold_out?` <span class="sold-tag">sold out</span>`:(low?` <span style="font-size:10px;color:var(--red);">·${avail<=0?' out':' low'}</span>`:'')}</div>
    </div>`;
  }).join('');
  grid.querySelectorAll('[data-recipe]').forEach(card=> card.onclick = ()=> onProductTap(card.dataset.recipe));
}

function onProductTap(recipeId){
  const recipe = state.recipes.find(r=>r.id===recipeId);
  if(!recipe) return;
  const groups = recipe.modifierGroups || [];
  if(groups.length===0){
    addToCart(recipe, 1, []);
    return;
  }
  openModifierPicker(recipe);
}

/* ================= Modifier picker ================= */
function openModifierPicker(recipe, existingLine){
  const groups = recipe.modifierGroups || [];
  // existing cart lines store option details ({group,label,…}); map them back to option ids for editing
  let selections = [];
  if(existingLine){
    (existingLine.modifiers||[]).forEach(m=>{
      const g = groups.find(x=> x.name===m.group); const o = g && (g.options||[]).find(x=> x.label===m.label);
      if(g && o) selections.push({groupId:g.id, optionId:o.id});
    });
  }
  let qty = existingLine ? existingLine.quantity : 1;

  function currentPrice(){
    let p = Number(recipe.selling_price)||0;
    selections.forEach(sel=>{
      const g = groups.find(x=>x.id===sel.groupId); const o = g && g.options.find(x=>x.id===sel.optionId);
      if(o) p += Number(o.priceDelta)||0;
    });
    return p;
  }

  const body = `
    <div style="text-align:center;margin-bottom:10px;"><b style="font-size:17px;">${escapeHtml(recipe.name)}</b></div>
    ${groups.map(g=>`
      <div class="mod-group" data-group="${g.id}">
        <div class="mod-group-title"><span>${escapeHtml(g.name)}</span>${g.required?'<span class="req">Required</span>':''}</div>
        <div class="mod-options">${g.options.map(o=>`<button class="mod-opt" data-group="${g.id}" data-opt="${o.id}">${escapeHtml(o.label)}${o.priceDelta?` (${o.priceDelta>0?'+':''}${fmtMoney(o.priceDelta)})`:''}</button>`).join('')}</div>
      </div>
    `).join('')}
    <div class="qty-stepper">
      <button class="qbig" id="mod-qty-minus">−</button>
      <span class="qval" id="mod-qty-val">${qty}</span>
      <button class="qbig" id="mod-qty-plus">+</button>
    </div>
    <div style="text-align:center;font-family:var(--font-display);font-size:22px;font-weight:700;color:var(--espresso);" id="mod-total-price">${fmtMoney(currentPrice()*qty)}</div>
  `;
  const foot = `<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" id="mod-add">${existingLine?'Update Item':'Add to Order'}</button>`;

  openModal({title:'Customize', body, foot, onMount:(root)=>{
    root.querySelector('[data-cancel]').onclick = closeModal;

    function refreshUI(){
      root.querySelectorAll('.mod-opt').forEach(btn=>{
        const isSel = selections.some(s=>s.groupId===btn.dataset.group && s.optionId===btn.dataset.opt);
        btn.classList.toggle('selected', isSel);
      });
      root.querySelector('#mod-qty-val').textContent = qty;
      root.querySelector('#mod-total-price').textContent = fmtMoney(currentPrice()*qty);
    }
    root.querySelectorAll('.mod-opt').forEach(btn=>{
      btn.onclick = ()=>{
        const gid = btn.dataset.group, oid = btn.dataset.opt;
        const group = groups.find(g=>g.id===gid);
        const already = selections.some(s=>s.groupId===gid && s.optionId===oid);
        if(group.multiSelect){
          if(already) selections = selections.filter(s=>!(s.groupId===gid && s.optionId===oid));
          else selections.push({groupId:gid, optionId:oid});
        } else {
          selections = selections.filter(s=>s.groupId!==gid);
          if(!already) selections.push({groupId:gid, optionId:oid});
        }
        refreshUI();
      };
    });
    root.querySelector('#mod-qty-minus').onclick = ()=>{ qty = Math.max(1, qty-1); refreshUI(); };
    root.querySelector('#mod-qty-plus').onclick = ()=>{ qty = qty+1; refreshUI(); };
    refreshUI();

    root.querySelector('#mod-add').onclick = ()=>{
      const missingRequired = groups.filter(g=>g.required && !selections.some(s=>s.groupId===g.id));
      if(missingRequired.length){ toast(`Please choose: ${missingRequired.map(g=>g.name).join(', ')}`, 'error'); return; }
      const modifierDetails = selections.map(s=>{
        const g = groups.find(x=>x.id===s.groupId); const o = g.options.find(x=>x.id===s.optionId);
        return {group:g.name, label:o.label, priceDelta:Number(o.priceDelta)||0, ingredientId:o.ingredientId||null, ingredientQtyDelta:Number(o.ingredientQtyDelta)||0};
      });
      if(existingLine){
        existingLine.quantity = qty; existingLine.modifiers = modifierDetails; existingLine.unitPrice = currentPrice();
      } else {
        addToCart(recipe, qty, modifierDetails);
      }
      closeModal();
      renderCartPanel();
    };
  }});
}

/* ================= Cart ================= */
function addToCart(recipe, qty, modifiers){
  const unitPrice = Number(recipe.selling_price||0) + modifiers.reduce((s,m)=>s+(Number(m.priceDelta)||0),0);
  posState.cart.push({
    lineId: uid('line'), recipeId: recipe.id, name: recipe.name, unitPrice, quantity: qty, modifiers,
  });
  renderCartPanel();
  toast(`Added ${recipe.name}`, 'success');
}
function cartLineTotal(line){ return line.unitPrice * line.quantity; }
function currentCartTotals(){
  const lines = posState.cart.map(l=>({unit_price:l.unitPrice, quantity:l.quantity}));
  return computeSaleTotals(lines, posState.discount);
}

function renderCartPanel(){
  const panel = document.getElementById('pos-cart-panel');
  if(!panel) return;
  const totals = currentCartTotals();
  panel.innerHTML = `
    <div class="pos-cart-head"><h3>Current Order</h3>${posState.cart.length?`<button class="btn btn-ghost btn-sm" id="clear-cart">Clear</button>`:''}</div>
    ${cartContextHtml()}
    <div class="pos-cart-items" id="cart-items">
      ${posState.cart.length===0 ? `<div class="cart-empty">🧺<br>No items yet.<br>Tap a product to add it.</div>` :
      posState.cart.map(line=>`
        <div class="cart-line" data-line="${line.lineId}">
          <div class="cart-line-top">
            <div><div class="cart-line-name">${escapeHtml(line.name)}</div>
              ${line.modifiers.length?`<div class="cart-line-mods">${line.modifiers.map(m=>escapeHtml(m.label)).join(', ')}</div>`:''}</div>
            <div class="cart-line-price">${fmtMoney(cartLineTotal(line))}</div>
          </div>
          <div class="cart-line-controls">
            <button class="qty-btn" data-dec="${line.lineId}">−</button>
            <span>${line.quantity}</span>
            <button class="qty-btn" data-inc="${line.lineId}">+</button>
            <button class="btn btn-ghost btn-sm" data-edit-line="${line.lineId}" style="margin-left:auto;">Edit</button>
            <button class="btn btn-ghost btn-sm" data-remove="${line.lineId}">✕</button>
          </div>
        </div>
      `).join('')}
    </div>
    <div class="pos-cart-summary">
      <div class="row"><span>Subtotal</span><span>${fmtMoney(totals.subtotal)}</span></div>
      <div class="row"><span>Discount ${posState.discount?`(${posState.discount.type==='percent'?posState.discount.value+'%':fmtMoney(posState.discount.value)})`:''}</span>
        <span>${totals.discountAmt>0?'-'+fmtMoney(totals.discountAmt):fmtMoney(0)} ${!posState.discount?`<a class="linklike" id="add-discount-link" style="font-size:11.5px;">add</a>`:`<a class="linklike" id="remove-discount-link" style="font-size:11.5px;">remove</a>`}</span></div>
      ${state.settings.tax_pct>0?`<div class="row"><span>Tax (${state.settings.tax_pct}%)</span><span>${fmtMoney(totals.tax)}</span></div>`:''}
      ${state.settings.service_charge_pct>0?`<div class="row"><span>Service Charge (${state.settings.service_charge_pct}%)</span><span>${fmtMoney(totals.serviceCharge)}</span></div>`:''}
      <div class="row total"><span>Total</span><span>${fmtMoney(totals.grandTotal)}</span></div>
    </div>
    <div class="pos-cart-foot">
      <button class="btn-hold" id="hold-order-btn" ${posState.cart.length===0?'disabled':''}>Hold</button>
      <button class="btn-checkout" id="checkout-btn" ${posState.cart.length===0?'disabled':''}>CHECKOUT / PAY</button>
    </div>
  `;
  panel.querySelectorAll('[data-inc]').forEach(b=> b.onclick = ()=>{ const l=posState.cart.find(x=>x.lineId===b.dataset.inc); l.quantity++; renderCartPanel(); });
  panel.querySelectorAll('[data-dec]').forEach(b=> b.onclick = ()=>{ const l=posState.cart.find(x=>x.lineId===b.dataset.dec); l.quantity--; if(l.quantity<=0) posState.cart=posState.cart.filter(x=>x.lineId!==l.lineId); renderCartPanel(); });
  panel.querySelectorAll('[data-remove]').forEach(b=> b.onclick = ()=>{ posState.cart = posState.cart.filter(x=>x.lineId!==b.dataset.remove); renderCartPanel(); });
  panel.querySelectorAll('[data-edit-line]').forEach(b=> b.onclick = ()=>{
    const line = posState.cart.find(x=>x.lineId===b.dataset.editLine);
    const recipe = state.recipes.find(r=>r.id===line.recipeId);
    if(recipe.modifierGroups && recipe.modifierGroups.length) openModifierPicker(recipe, line);
  });
  const clearBtn = document.getElementById('clear-cart');
  if(clearBtn) clearBtn.onclick = async ()=>{ const ok = await confirmDialog('Clear the current order?'); if(ok){ posState.cart=[]; posState.discount=null; posState.resumingHeldSaleId=null; posState.orderId=null; posState.customerId=null; renderCartPanel(); } };
  wireCartContext(panel);
  const addDiscLink = document.getElementById('add-discount-link');
  if(addDiscLink) addDiscLink.onclick = openDiscountPicker;
  const rmDiscLink = document.getElementById('remove-discount-link');
  if(rmDiscLink) rmDiscLink.onclick = ()=>{ posState.discount=null; renderCartPanel(); };
  const holdBtn = document.getElementById('hold-order-btn');
  if(holdBtn) holdBtn.onclick = holdCurrentOrder;
  const checkoutBtn = document.getElementById('checkout-btn');
  if(checkoutBtn) checkoutBtn.onclick = openCheckout;
}

async function openDiscountPicker(){
  const authUser = await requireOverride('MANAGER');
  if(!authUser) return;
  openModal({title:'Apply Discount', body:`
    <div class="form-row"><label>Type</label><select id="disc-type"><option value="percent">Percentage %</option><option value="fixed">Fixed Amount ₱</option></select></div>
    <div class="form-row"><label>Value</label><input type="number" step="any" id="disc-value" placeholder="e.g. 10"></div>
  `, foot:`<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" id="disc-apply">Apply</button>`,
  onMount:(root)=>{
    root.querySelector('[data-cancel]').onclick = closeModal;
    root.querySelector('#disc-apply').onclick = ()=>{
      const value = Number(root.querySelector('#disc-value').value)||0;
      if(value<=0){ toast('Enter a discount value','error'); return; }
      posState.discount = {type: root.querySelector('#disc-type').value, value, appliedBy: authUser.name};
      closeModal(); renderCartPanel();
      logAudit('Discount applied', authUser.name, `${value}${posState.discount.type==='percent'?'%':' fixed'}`);
    };
  }});
}

async function holdCurrentOrder(){
  if(posState.cart.length===0) return;
  const now = new Date().toISOString();
  const saleId = posState.resumingHeldSaleId || uid('sale');
  const totals = currentCartTotals();
  const existing = state.sales.find(s=>s.id===saleId);
  const sale = {
    id: saleId, transaction_number: (existing && existing.transaction_number) || nextTransactionNumber(), transaction_date: now,
    status:'HELD', cashier: posState.currentUser.name, cashier_id: posState.currentUser.id, notes:'', created_at: now,
    device_id: Data.deviceId, store_id: (FO.device && FO.device.store_id) || null, customer_id: posState.customerId || null,
    order_id: posState.orderId || null,
    subtotal: totals.subtotal, discount_type: posState.discount?.type||null, discount_value: posState.discount?.value||0,
    discount_amount: totals.discountAmt, tax_amount: totals.tax, service_charge_amount: totals.serviceCharge, grand_total: totals.grandTotal,
  };
  await DB.put('sales', sale);
  const oldItems = await DB.byIndex('saleItems','saleId', saleId);
  for(const it of oldItems) await DB.delete('saleItems', it.id);
  for(const line of posState.cart){
    await DB.put('saleItems', {id: uid('sit'), saleId, recipeId: line.recipeId, name: line.name, quantity: line.quantity, unit_price: line.unitPrice, modifiers: line.modifiers, line_total: cartLineTotal(line)});
  }
  await loadAll();
  toast('Order held — resume it anytime from Held Orders');
  posState.cart = []; posState.discount = null; posState.resumingHeldSaleId = null; posState.orderId = null; posState.customerId = null;
  navigatePOS('pos');
}

async function showHeldOrders(){
  const held = state.sales.filter(s=>s.status==='HELD' && (!s.device_id || s.device_id===Data.deviceId)).sort((a,b)=> new Date(b.transaction_date)-new Date(a.transaction_date));
  openModal({title:'Held Orders', body: held.length? `<div class="grid grid-2">${held.map(s=>`
      <div class="card"><b>${s.transaction_number}</b><div class="text-light" style="font-size:12px;">${fmtDate(s.transaction_date)} · ${escapeHtml(s.cashier)}</div>
      <div style="display:flex;gap:8px;margin-top:10px;"><button class="btn btn-sm btn-primary" data-resume="${s.id}">Resume</button><button class="btn btn-sm btn-danger" data-cancel-hold="${s.id}">Cancel</button></div></div>
    `).join('')}</div>` : `<p>No held orders.</p>`,
    foot:`<button class="btn btn-outline" data-cancel>Close</button>`,
    onMount:(root)=>{
      root.querySelector('[data-cancel]').onclick = closeModal;
      root.querySelectorAll('[data-resume]').forEach(b=> b.onclick = async ()=>{
        const saleId = b.dataset.resume;
        const items = await DB.byIndex('saleItems','saleId', saleId);
        posState.cart = items.map(it=>({lineId: uid('line'), recipeId: it.recipeId, name: it.name, unitPrice: it.unit_price, quantity: it.quantity, modifiers: it.modifiers||[]}));
        posState.resumingHeldSaleId = saleId;
        const heldSale = state.sales.find(x=>x.id===saleId) || {};
        posState.customerId = heldSale.customer_id || null;
        posState.orderId = heldSale.order_id || null;
        closeModal(); navigatePOS('pos');
      });
      root.querySelectorAll('[data-cancel-hold]').forEach(b=> b.onclick = async ()=>{
        const ok = await confirmDialog('Cancel this held order? It will be removed.');
        if(!ok) return;
        const saleId = b.dataset.cancelHold;
        const items = await DB.byIndex('saleItems','saleId', saleId);
        for(const it of items) await DB.delete('saleItems', it.id);
        await DB.delete('sales', saleId);
        await loadAll();
        closeModal(); showHeldOrders();
      });
    }
  });
}

/* ================= Checkout ================= */
function openCheckout(){
  if(posState.cart.length===0) return;
  const totals = currentCartTotals();
  let method = 'CASH';
  let tendered = 0;

  const body = `
    <div style="text-align:center;margin-bottom:14px;"><div class="text-light" style="font-size:12px;text-transform:uppercase;font-weight:700;">Total Due</div>
      <div style="font-family:var(--font-display);font-size:34px;font-weight:700;">${fmtMoney(totals.grandTotal)}</div></div>
    <div class="pay-methods" id="pay-methods">
      <button class="pay-method-btn selected" data-method="CASH">💵<br>Cash</button>
      <button class="pay-method-btn" data-method="GCASH">📱<br>GCash</button>
      <button class="pay-method-btn" data-method="CARD">💳<br>Card</button>
      <button class="pay-method-btn" data-method="OTHER">⋯<br>Other</button>
    </div>
    <div id="pay-detail"></div>
  `;
  const foot = `<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" id="complete-sale-btn">Complete Sale</button>`;
  openModal({title:'Checkout', body, foot, onMount:(root)=>{
    root.querySelector('[data-cancel]').onclick = closeModal;
    const detailWrap = root.querySelector('#pay-detail');

    function renderDetail(){
      if(method==='CASH'){
        detailWrap.innerHTML = `
          <div class="form-row"><label>Cash Received</label><input type="number" step="any" id="cash-tendered" placeholder="0.00"></div>
          <div class="quick-cash">
            ${[totals.grandTotal, 100, 200, 500, 1000].map(v=>`<button data-quick="${v}">${v===totals.grandTotal?'Exact':fmtMoney(v)}</button>`).join('')}
          </div>
          <div class="change-display"><div class="lbl">Change</div><div class="val" id="change-val">₱0.00</div></div>
        `;
        const input = detailWrap.querySelector('#cash-tendered');
        function updateChange(){
          tendered = Number(input.value)||0;
          const change = tendered - totals.grandTotal;
          detailWrap.querySelector('#change-val').textContent = fmtMoney(Math.max(0,change));
          detailWrap.querySelector('#change-val').style.color = change<0 ? 'var(--red)' : 'var(--green)';
        }
        input.oninput = updateChange;
        detailWrap.querySelectorAll('[data-quick]').forEach(b=> b.onclick = ()=>{ input.value = b.dataset.quick; updateChange(); });
        updateChange();
      } else {
        detailWrap.innerHTML = `
          <div class="form-row"><label>Reference # (optional)</label><input id="pay-ref" placeholder="e.g. GCash ref number"></div>
          <label style="display:flex;gap:8px;align-items:flex-start;font-size:13.5px;margin-top:10px;">
            <input type="checkbox" id="pay-confirmed" style="margin-top:3px;width:16px;height:16px;">
            <span>I have verified this ${method} payment was actually received (checked the ${method==='GCASH'?'GCash app/SMS':'terminal'} myself). This app cannot confirm electronic payments automatically without connecting a real payment processor.</span>
          </label>
        `;
      }
    }
    root.querySelectorAll('[data-method]').forEach(b=> b.onclick = ()=>{
      method = b.dataset.method;
      root.querySelectorAll('[data-method]').forEach(x=>x.classList.toggle('selected', x===b));
      renderDetail();
    });
    renderDetail();

    root.querySelector('#complete-sale-btn').onclick = async ()=>{
      if(method==='CASH'){
        if(tendered < totals.grandTotal){ toast('Cash received is less than the total due','error'); return; }
      } else {
        const confirmedBox = detailWrap.querySelector('#pay-confirmed');
        if(!confirmedBox || !confirmedBox.checked){ toast('Please confirm the payment was actually received before completing the sale','error'); return; }
      }
      const paymentInfo = {
        method, amount: totals.grandTotal,
        tendered: method==='CASH'? tendered : null,
        change: method==='CASH'? Math.max(0,tendered-totals.grandTotal) : null,
        reference: method!=='CASH' ? (detailWrap.querySelector('#pay-ref')?.value||'') : '',
        status: method==='CASH' ? 'CONFIRMED' : 'CONFIRMED', // non-cash only reaches here after manual human confirmation above
      };
      const sale = await completeSale(paymentInfo);
      closeModal();
      showReceipt(sale.id, {autoPrint:false});
    };
  }});
}

// Recomputes totals fresh from source (cart + discount + settings) rather than trusting any
// value carried in from earlier UI state.
async function completeSale(paymentInfo){
  const now = new Date().toISOString();
  const totals = currentCartTotals();
  const saleId = posState.resumingHeldSaleId || uid('sale');
  const shift = activeShift();
  const existing = state.sales.find(s=>s.id===saleId);
  // A resumed held order: remove its old lines FIRST, while it is still "held"
  // (only held orders may have lines removed at the counter).
  if(posState.resumingHeldSaleId){
    const oldItems = await DB.byIndex('saleItems','saleId', saleId);
    for(const it of oldItems) await DB.delete('saleItems', it.id);
  }
  const sale = {
    id: saleId,
    transaction_number: (existing || {}).transaction_number || nextTransactionNumber(),
    transaction_date: now, status: 'COMPLETED', cashier: posState.currentUser.name, cashier_id: posState.currentUser.id,
    shift_id: shift ? shift.id : null, device_id: Data.deviceId, store_id: (FO.device && FO.device.store_id) || null,
    customer_id: posState.customerId || null, order_id: posState.orderId || null,
    subtotal: totals.subtotal, discount_type: posState.discount?.type||null, discount_value: posState.discount?.value||0,
    discount_amount: totals.discountAmt, tax_amount: totals.tax, service_charge_amount: totals.serviceCharge,
    grand_total: totals.grandTotal, notes:'', created_at: (existing||{}).created_at || now,
  };
  await DB.put('sales', sale);

  for(const line of posState.cart){
    await DB.put('saleItems', {
      id: uid('sit'), saleId, recipeId: line.recipeId, name: line.name, quantity: line.quantity,
      unit_price: line.unitPrice, modifiers: line.modifiers, line_total: cartLineTotal(line), created_at: now,
    });
  }

  await DB.put('payments', {id: uid('pay'), saleId, method: paymentInfo.method, amount: paymentInfo.amount,
    tendered: paymentInfo.tendered, change: paymentInfo.change, reference: paymentInfo.reference,
    status: paymentInfo.status, created_at: now});

  // Inventory deduction — uses the EXACT SAME recipe-costing/ingredient-line traversal the
  // Back Office uses (recipeCost(), shared via logic.js), not separate POS-side logic.
  for(const line of posState.cart){
    const {lines} = recipeCost(line.recipeId);
    for(const ingLine of lines){
      const qty = Number(ingLine.quantity||0) * line.quantity;
      if(qty<=0) continue;
      await DB.put('inventoryTransactions', {
        id: uid('txn'), ingredientId: ingLine.ingredientId, transaction_type:'SALE_USAGE', quantity: qty,
        reference_id: saleId, transaction_date: now.slice(0,10), notes:`Sold: ${sale.transaction_number}`, created_at: now,
      });
    }
    for(const mod of line.modifiers){
      if(mod.ingredientId && mod.ingredientQtyDelta){
        const qty = Number(mod.ingredientQtyDelta) * line.quantity;
        await DB.put('inventoryTransactions', {
          id: uid('txn'), ingredientId: mod.ingredientId, transaction_type:'SALE_USAGE', quantity: qty,
          reference_id: saleId, transaction_date: now.slice(0,10), notes:`Modifier "${mod.label}" — ${sale.transaction_number}`, created_at: now,
        });
      }
    }
  }

  // A QR order that was rung up is now finished.
  if(posState.orderId){
    const order = state.orders.find(o=>o.id===posState.orderId);
    if(order){ Object.assign(order, {status:'COMPLETED', sale_id: saleId, handled_by_name: posState.currentUser.name}); await DB.put('orders', order); }
  }

  await logAudit('Sale completed', posState.currentUser.name, `${sale.transaction_number} — ${fmtMoney(sale.grand_total)} (${paymentInfo.method})${sale.order_id?' · QR order':''}`, saleId);
  posState.cart = []; posState.discount = null; posState.resumingHeldSaleId = null; posState.orderId = null; posState.customerId = null;
  navigatePOS('pos');
  toast(`Sale ${sale.transaction_number} completed`, 'success');
  return sale;
}

/* ================= Receipt ================= */
async function showReceipt(saleId, {autoPrint}={}){
  const sale = state.sales.find(s=>s.id===saleId) || await DB.get('sales', saleId);
  const items = await DB.byIndex('saleItems','saleId', saleId);
  const payments = await DB.byIndex('payments','saleId', saleId);
  const s = state.settings;
  if(!sale){ toast('Transaction not found','error'); return; }
  const win = window.open('', '_blank');
  if(!win){ toast('Please allow pop-ups to view/print receipts', 'error'); return; }
  const pay = payments[0] || {};
  win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Receipt ${sale.transaction_number}</title>
    <style>
      body{font-family:'Courier New',monospace;width:300px;margin:20px auto;color:#111;font-size:12.5px;}
      .center{text-align:center;} .row{display:flex;justify-content:space-between;}
      hr{border:none;border-top:1px dashed #888;margin:8px 0;}
      .logo{width:44px;height:44px;object-fit:contain;margin:0 auto 6px;display:block;}
      .biz{font-weight:700;font-size:15px;} .small{font-size:11px;color:#555;}
      .items td{padding:2px 0;} table{width:100%;border-collapse:collapse;}
      .modline{font-size:10.5px;color:#555;padding-left:8px;}
      @media print{ body{width:80mm;margin:0;font-size:11px;} }
    </style></head><body>
    <div class="center">
      ${s.logo?`<img class="logo" src="${s.logo}">`:''}
      <div class="biz">${escapeHtml(businessName()||appDisplayName())}</div>
      ${s.business_address?`<div class="small">${escapeHtml(s.business_address)}</div>`:''}
      ${s.business_contact?`<div class="small">${escapeHtml(s.business_contact)}</div>`:''}
    </div>
    <hr>
    <div class="row"><span>${escapeHtml(sale.transaction_number)}</span><span>${fmtDate(sale.transaction_date)}</span></div>
    <div class="row"><span>Cashier: ${escapeHtml(sale.cashier)}</span><span>${new Date(sale.transaction_date).toLocaleTimeString()}</span></div>
    ${receiptExtraLines(sale)}
    <hr>
    <table class="items">
      ${items.map(it=>`<tr><td colspan="2">${it.quantity} × ${escapeHtml(it.name)}</td><td style="text-align:right;">${fmtMoney(it.line_total)}</td></tr>
        ${(it.modifiers||[]).map(m=>`<tr><td colspan="3" class="modline">— ${escapeHtml(m.label)}${m.priceDelta?` (+${fmtMoney(m.priceDelta)})`:''}</td></tr>`).join('')}`).join('')}
    </table>
    <hr>
    <div class="row"><span>Subtotal</span><span>${fmtMoney(sale.subtotal)}</span></div>
    ${sale.discount_amount>0?`<div class="row"><span>Discount</span><span>-${fmtMoney(sale.discount_amount)}</span></div>`:''}
    ${sale.tax_amount>0?`<div class="row"><span>Tax</span><span>${fmtMoney(sale.tax_amount)}</span></div>`:''}
    ${sale.service_charge_amount>0?`<div class="row"><span>Service Charge</span><span>${fmtMoney(sale.service_charge_amount)}</span></div>`:''}
    <div class="row" style="font-weight:700;font-size:14px;margin-top:4px;"><span>TOTAL</span><span>${fmtMoney(sale.grand_total)}</span></div>
    <hr>
    <div class="row"><span>Payment (${escapeHtml(pay.method||'—')})</span><span>${fmtMoney(pay.amount||sale.grand_total)}</span></div>
    ${pay.method==='CASH'?`<div class="row"><span>Cash Received</span><span>${fmtMoney(pay.tendered)}</span></div><div class="row"><span>Change</span><span>${fmtMoney(pay.change)}</span></div>`:''}
    ${pay.reference?`<div class="row small"><span>Ref#</span><span>${escapeHtml(pay.reference)}</span></div>`:''}
    <hr>
    <div class="center small">${escapeHtml(s.receipt_footer||'Thank you!')}</div>
    ${sale.status!=='COMPLETED'?`<div class="center" style="margin-top:8px;font-weight:700;">*** ${sale.status} ***</div>`:''}
    </body></html>`);
  win.document.close();
  win.focus();
  if(autoPrint!==false) setTimeout(()=>{ try{ win.print(); }catch(e){} }, 350);
}

/* ================= Placeholder stubs (replaced by full implementations below) ================= */
/* ================= Reports ================= */
const POS_REPORT_DEFS = [
  {id:'today', name:"Today's Sales"},
  {id:'product', name:'Product Sales'},
  {id:'category', name:'Category Sales'},
  {id:'payment', name:'Payment Method Sales'},
  {id:'hourly', name:'Hourly Sales'},
  {id:'cashier', name:'Cashier Sales'},
  {id:'refunds', name:'Refunds'},
  {id:'voids', name:'Voids'},
  {id:'consumption', name:'Inventory Consumption'},
];
let posReportState = {active:'today', from: new Date().toISOString().slice(0,10), to: new Date().toISOString().slice(0,10)};

function renderPOSReports(){
  const content = document.getElementById('content');
  content.className = '';
  content.innerHTML = `
    <div class="toolbar">
      <div class="toolbar-left" style="flex-wrap:wrap;">${POS_REPORT_DEFS.map(r=>`<button class="btn btn-sm ${posReportState.active===r.id?'btn-primary':'btn-outline'}" data-report="${r.id}">${r.name}</button>`).join('')}</div>
    </div>
    <div class="toolbar">
      <div class="toolbar-left">
        <div class="form-row mb-0"><label>From</label><input type="date" id="rep-from" value="${posReportState.from}"></div>
        <div class="form-row mb-0"><label>To</label><input type="date" id="rep-to" value="${posReportState.to}"></div>
      </div>
      <button class="btn btn-outline btn-sm" id="rep-export">Export CSV</button>
    </div>
    <div id="rep-body"></div>
  `;
  content.querySelectorAll('[data-report]').forEach(b=> b.onclick = ()=>{ posReportState.active=b.dataset.report; renderPOSReports(); });
  content.querySelector('#rep-from').onchange = async e=>{ posReportState.from=e.target.value; try{ await Data.ensureRange(posReportState.from); }catch(err){ toast(friendlyError(err),'error'); } renderReportBody_POS(); };
  content.querySelector('#rep-to').onchange = e=>{ posReportState.to=e.target.value; renderReportBody_POS(); };
  content.querySelector('#rep-export').onclick = exportPOSReportCSV;
  renderReportBody_POS();
}

function salesInReportRange(){
  const from = new Date(posReportState.from+'T00:00:00').getTime();
  const to = new Date(posReportState.to+'T23:59:59').getTime();
  return state.sales.filter(s=>{ const t=new Date(s.transaction_date).getTime(); return t>=from && t<=to; });
}
let lastReportTable = {headers:[], rows:[]};
function renderReportBody_POS(){
  const wrap = document.getElementById('rep-body');
  const sales = salesInReportRange();
  const completed = sales.filter(s=>s.status==='COMPLETED'||s.status==='PARTIALLY_REFUNDED');
  let headers=[], rows=[];

  if(posReportState.active==='today'){
    const gross = completed.reduce((s,x)=>s+x.subtotal,0);
    const discounts = completed.reduce((s,x)=>s+x.discount_amount,0);
    const net = completed.reduce((s,x)=>s+x.grand_total,0);
    const count = completed.length;
    const avg = count? net/count : 0;
    wrap.innerHTML = `<div class="grid grid-4">
      ${statCard('Gross Sales', fmtMoney(gross),'')}${statCard('Discounts', fmtMoney(discounts),'')}
      ${statCard('Net Sales', fmtMoney(net),'')}${statCard('Transactions', count, `avg ${fmtMoney(avg)}`)}
    </div>`;
    lastReportTable = {headers:['Metric','Value'], rows:[['Gross Sales',fmtMoney(gross)],['Discounts',fmtMoney(discounts)],['Net Sales',fmtMoney(net)],['Transactions',count],['Average Transaction',fmtMoney(avg)]]};
    return;
  }
  if(posReportState.active==='product'){
    headers=['Product','Qty Sold','Revenue'];
    const map = {};
    completed.forEach(s=>{ state.saleItems.filter(it=>it.saleId===s.id).forEach(it=>{ map[it.name]=map[it.name]||{qty:0,rev:0}; map[it.name].qty+=it.quantity; map[it.name].rev+=it.line_total; }); });
    rows = Object.entries(map).sort((a,b)=>b[1].rev-a[1].rev).map(([name,v])=>[name, v.qty, fmtMoney(v.rev)]);
  } else if(posReportState.active==='category'){
    headers=['Category','Revenue'];
    const map = {};
    completed.forEach(s=>{ state.saleItems.filter(it=>it.saleId===s.id).forEach(it=>{ const r=state.recipes.find(x=>x.id===it.recipeId); const cat = r?posCategoryOf(r):'Other'; map[cat]=(map[cat]||0)+it.line_total; }); });
    rows = Object.entries(map).sort((a,b)=>b[1]-a[1]).map(([cat,rev])=>[cat, fmtMoney(rev)]);
  } else if(posReportState.active==='payment'){
    headers=['Payment Method','Transactions','Total'];
    const map = {};
    completed.forEach(s=>{ const pay = state.payments.find(p=>p.saleId===s.id); const m = pay?pay.method:'—'; map[m]=map[m]||{n:0,total:0}; map[m].n++; map[m].total+=s.grand_total; });
    rows = Object.entries(map).map(([m,v])=>[m, v.n, fmtMoney(v.total)]);
  } else if(posReportState.active==='hourly'){
    headers=['Hour','Transactions','Total'];
    const map = {};
    completed.forEach(s=>{ const h = new Date(s.transaction_date).getHours(); const key = `${String(h).padStart(2,'0')}:00`; map[key]=map[key]||{n:0,total:0}; map[key].n++; map[key].total+=s.grand_total; });
    rows = Object.keys(map).sort().map(h=>[h, map[h].n, fmtMoney(map[h].total)]);
  } else if(posReportState.active==='cashier'){
    headers=['Cashier','Transactions','Total'];
    const map = {};
    completed.forEach(s=>{ map[s.cashier]=map[s.cashier]||{n:0,total:0}; map[s.cashier].n++; map[s.cashier].total+=s.grand_total; });
    rows = Object.entries(map).sort((a,b)=>b[1].total-a[1].total).map(([c,v])=>[c, v.n, fmtMoney(v.total)]);
  } else if(posReportState.active==='refunds'){
    headers=['Date','Transaction #','Amount','Reason','Approved By'];
    const refundsInRange = state.refunds.filter(r=> r.type!=='VOID' && sales.some(s=>s.id===r.saleId));
    rows = refundsInRange.map(r=>{ const s=state.sales.find(x=>x.id===r.saleId); return [fmtDate(r.date), s?s.transaction_number:'—', fmtMoney(r.amount), r.reason||'—', r.approved_by]; });
  } else if(posReportState.active==='voids'){
    headers=['Date','Transaction #','Amount','Reason','Approved By'];
    const voidsInRange = state.refunds.filter(r=> r.type==='VOID' && sales.some(s=>s.id===r.saleId));
    rows = voidsInRange.map(r=>{ const s=state.sales.find(x=>x.id===r.saleId); return [fmtDate(r.date), s?s.transaction_number:'—', fmtMoney(r.amount), r.reason||'—', r.approved_by]; });
  } else if(posReportState.active==='consumption'){
    headers=['Ingredient','Quantity Used','Unit'];
    const map = {};
    const saleIdsInRange = new Set(sales.map(s=>s.id));
    state.inventoryTransactions.filter(t=>t.transaction_type==='SALE_USAGE' && saleIdsInRange.has(t.reference_id)).forEach(t=>{
      const ing = ingredientById(t.ingredientId); if(!ing) return;
      map[ing.name]=map[ing.name]||{qty:0,unit:ing.base_unit}; map[ing.name].qty+=Number(t.quantity)||0;
    });
    rows = Object.entries(map).sort((a,b)=>b[1].qty-a[1].qty).map(([name,v])=>[name, fmtNum(v.qty,2), v.unit]);
  }
  lastReportTable = {headers, rows};
  if(rows.length===0){ wrap.innerHTML = emptyBlock('No data for this date range yet.'); return; }
  wrap.innerHTML = `<div class="table-wrap"><table><thead><tr>${headers.map(h=>`<th>${h}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(r=>`<tr>${r.map(c=>`<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
function exportPOSReportCSV(){
  const {headers, rows} = lastReportTable;
  const csv = [headers.join(','), ...rows.map(r=>r.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(','))].join('\n');
  downloadFile(`${fileNameSlug()}-pos-${posReportState.active}-${posReportState.from}-to-${posReportState.to}.csv`, csv, 'text/csv');
  toast('Report exported as CSV');
}
/* ================= Sales History ================= */
let salesHistoryFilter = {search:'', cashier:'', method:'', page:0};
const SALES_PAGE_SIZE = 25;

async function renderSalesHistory(){
  const content = document.getElementById('content');
  content.className = '';
  const cashiers = [...new Set(state.sales.map(s=>s.cashier))];
  content.innerHTML = `
    <div class="toolbar">
      <div class="toolbar-left">
        <div class="search-box"><input type="text" placeholder="Search transaction # or product..." id="sh-search" value="${salesHistoryFilter.search}"></div>
        <select class="filter" id="sh-cashier"><option value="">All Cashiers</option>${cashiers.map(c=>`<option ${salesHistoryFilter.cashier===c?'selected':''}>${escapeHtml(c)}</option>`).join('')}</select>
        <select class="filter" id="sh-method"><option value="">All Payment Methods</option>${['CASH','GCASH','CARD','OTHER'].map(m=>`<option value="${m}" ${salesHistoryFilter.method===m?'selected':''}>${m}</option>`).join('')}</select>
      </div>
      <div class="text-light" style="font-size:13px;">Most recent first. “Load More” fetches older sales from the database.</div>
    </div>
    <div id="sh-table-wrap"></div>
    <div style="text-align:center;margin-top:14px;"><button class="btn btn-outline" id="sh-load-more">Load More</button></div>
  `;
  document.getElementById('sh-search').oninput = e=>{ salesHistoryFilter.search=e.target.value; salesHistoryFilter.page=0; renderSalesHistoryTable(true); };
  document.getElementById('sh-cashier').onchange = e=>{ salesHistoryFilter.cashier=e.target.value; salesHistoryFilter.page=0; renderSalesHistoryTable(true); };
  document.getElementById('sh-method').onchange = e=>{ salesHistoryFilter.method=e.target.value; salesHistoryFilter.page=0; renderSalesHistoryTable(true); };
  document.getElementById('sh-load-more').onclick = ()=>{ salesHistoryFilter.page++; renderSalesHistoryTable(false); };
  await renderSalesHistoryTable(true);
}

let salesHistoryRows = [];
async function renderSalesHistoryTable(reset){
  const wrap = document.getElementById('sh-table-wrap');
  const hasFilter = salesHistoryFilter.search || salesHistoryFilter.cashier || salesHistoryFilter.method;
  let pageItems;
  if(hasFilter){
    // Filtered search scans the full (indexed-by-date) set in memory — fine at small/medium
    // shop scale; for very large histories, narrow by cashier/method first to shrink the scan.
    let all = state.sales.filter(s=>s.status!=='HELD').sort((a,b)=> new Date(b.transaction_date)-new Date(a.transaction_date));
    if(salesHistoryFilter.cashier) all = all.filter(s=>s.cashier===salesHistoryFilter.cashier);
    if(salesHistoryFilter.search){
      const q = salesHistoryFilter.search.toLowerCase();
      const matchingSaleIds = new Set(state.saleItems.filter(it=>it.name.toLowerCase().includes(q)).map(it=>it.saleId));
      all = all.filter(s=> s.transaction_number.toLowerCase().includes(q) || matchingSaleIds.has(s.id));
    }
    if(salesHistoryFilter.method){
      const matchingSaleIds = new Set(state.payments.filter(p=>p.method===salesHistoryFilter.method).map(p=>p.saleId));
      all = all.filter(s=> matchingSaleIds.has(s.id));
    }
    pageItems = all.slice(0, (salesHistoryFilter.page+1)*SALES_PAGE_SIZE);
    salesHistoryRows = pageItems;
  } else {
    // Cursor-paginated straight off the transaction_date index — never loads the whole table.
    if(reset) salesHistoryRows = [];
    const fresh = await DB.pageByIndex('sales','transaction_date',{limit:SALES_PAGE_SIZE, offset:salesHistoryRows.length, direction:'prev'});
    salesHistoryRows = reset ? fresh.filter(s=>s.status!=='HELD') : salesHistoryRows.concat(fresh.filter(s=>s.status!=='HELD'));
    pageItems = salesHistoryRows;
  }
  if(pageItems.length===0){ wrap.innerHTML = emptyBlock('No transactions match this filter yet.'); return; }
  wrap.innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>Transaction #</th><th>Date/Time</th><th>Cashier</th><th>Status</th><th>Total</th><th>Sync</th><th></th></tr></thead>
    <tbody>${pageItems.map(s=>`<tr class="clickable" data-id="${s.id}">
      <td><b>${s.transaction_number}</b></td><td>${fmtDate(s.transaction_date)} ${new Date(s.transaction_date).toLocaleTimeString()}</td>
      <td>${escapeHtml(s.cashier)}</td><td>${saleStatusBadge(s.status)}</td><td>${fmtMoney(s.grand_total)}</td>
      <td>${s._pending?'<span class="sync-pill pending">Waiting to upload</span>':'<span class="sync-pill saved">Saved</span>'}</td>
      <td><button class="btn btn-sm btn-ghost" data-reprint="${s.id}">Reprint</button></td>
    </tr>`).join('')}</tbody></table></div>`;
  wrap.querySelectorAll('[data-id]').forEach(tr=> tr.onclick = (e)=>{ if(e.target.closest('[data-reprint]')) return; navigatePOS('saleDetail', tr.dataset.id); });
  wrap.querySelectorAll('[data-reprint]').forEach(b=> b.onclick = (e)=>{ e.stopPropagation(); showReceipt(b.dataset.reprint); });
}
function saleStatusBadge(status){
  const map = {COMPLETED:'badge-green', VOIDED:'badge-red', REFUNDED:'badge-red', PARTIALLY_REFUNDED:'badge-yellow', HELD:'badge-gray'};
  return `<span class="badge ${map[status]||'badge-gray'}">${status.replace(/_/g,' ')}</span>`;
}
function emptyBlock(text){ return `<div class="card empty-state" style="box-shadow:var(--shadow);"><div style="padding:10px 0;">${text}</div></div>`; }
function statCard(label, value, sub){
  return `<div class="card stat-card"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub||''}</div></div>`;
}

/* ================= Sale Detail / Refund / Void ================= */
async function renderSaleDetail(saleId){
  const content = document.getElementById('content');
  content.className = '';
  const sale = state.sales.find(s=>s.id===saleId) || await DB.get('sales', saleId);
  if(!sale){ content.innerHTML = emptyBlock('Transaction not found.'); return; }
  const items = await DB.byIndex('saleItems','saleId', saleId);
  const payments = await DB.byIndex('payments','saleId', saleId);
  const refunds = await DB.byIndex('refunds','saleId', saleId);
  const pay = payments[0] || {};

  content.innerHTML = `
    <a class="linklike" id="back-sh" style="font-size:13px;">← Back to Sales History</a>
    <div class="ingredient-detail-header" style="margin-top:10px;">
      <div><h2 style="font-family:var(--font-display);font-size:24px;">${sale.transaction_number}</h2>
        <div style="margin-top:6px;display:flex;gap:8px;align-items:center;">${saleStatusBadge(sale.status)}<span class="tag-pill">${fmtDate(sale.transaction_date)}</span><span class="tag-pill">Cashier: ${escapeHtml(sale.cashier)}</span></div>
      </div>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-outline" id="reprint-btn">🖨 Reprint Receipt</button>
        ${sale.status==='COMPLETED'?`<button class="btn btn-danger" id="void-btn">Void</button><button class="btn btn-amber" id="refund-btn">Refund</button>`:''}
      </div>
    </div>
    <div class="grid grid-4" style="margin-top:20px;">
      ${statCard('Total', fmtMoney(sale.grand_total),'')}
      ${statCard('Payment Method', pay.method||'—','')}
      ${statCard('Discount', sale.discount_amount>0?fmtMoney(sale.discount_amount):'—','')}
      ${statCard('Tax + Service', fmtMoney((sale.tax_amount||0)+(sale.service_charge_amount||0)),'')}
    </div>
    <div class="section-title">Items</div>
    <div class="table-wrap"><table><thead><tr><th>Item</th><th>Qty</th><th>Unit Price</th><th>Total</th></tr></thead>
      <tbody>${items.map(it=>`<tr><td><b>${escapeHtml(it.name)}</b>${(it.modifiers||[]).length?`<div class="text-light" style="font-size:12px;">${it.modifiers.map(m=>escapeHtml(m.label)).join(', ')}</div>`:''}</td>
        <td>${it.quantity}</td><td>${fmtMoney(it.unit_price)}</td><td>${fmtMoney(it.line_total)}</td></tr>`).join('')}</tbody></table></div>
    ${refunds.length?`<div class="section-title">Refund / Void History</div><div class="table-wrap"><table><thead><tr><th>Date</th><th>Type</th><th>Amount</th><th>Reason</th><th>Approved By</th></tr></thead>
      <tbody>${refunds.map(r=>`<tr><td>${fmtDate(r.date)}</td><td>${r.type.replace(/_/g,' ')}</td><td>${fmtMoney(r.amount)}</td><td>${escapeHtml(r.reason||'—')}</td><td>${escapeHtml(r.approved_by)}</td></tr>`).join('')}</tbody></table></div>`:''}
  `;
  content.querySelector('#back-sh').onclick = ()=>navigatePOS('salesHistory');
  content.querySelector('#reprint-btn').onclick = ()=>showReceipt(saleId);
  if(sale.status==='COMPLETED'){
    content.querySelector('#void-btn').onclick = ()=>openRefundVoidFlow(sale, items, 'VOID');
    content.querySelector('#refund-btn').onclick = ()=>openRefundVoidFlow(sale, items, 'REFUND');
  }
}

async function openRefundVoidFlow(sale, items, kind){
  const authUser = await requireOverride('MANAGER');
  if(!authUser) return;
  const isVoid = kind==='VOID';
  openModal({
    title: isVoid?'Void Transaction':'Refund Transaction', wide:true,
    body: isVoid ? `<p>This will void <b>${sale.transaction_number}</b> (${fmtMoney(sale.grand_total)}) and return all items to inventory. The original sale record is kept for your records — it will not be deleted.</p>
      <div class="form-row"><label>Reason</label><input id="rv-reason" placeholder="e.g. Order entered by mistake"></div>`
      : `<p>Select items and quantities to refund from <b>${sale.transaction_number}</b>:</p>
      <table class="ri-table"><thead><tr><th>Item</th><th>Sold Qty</th><th>Refund Qty</th></tr></thead>
      <tbody>${items.map(it=>`<tr data-item="${it.id}"><td>${escapeHtml(it.name)}</td><td>${it.quantity}</td><td><input type="number" min="0" max="${it.quantity}" value="0" class="rv-qty" style="width:70px;"></td></tr>`).join('')}</tbody></table>
      <div class="form-row" style="margin-top:12px;"><label>Reason</label><input id="rv-reason" placeholder="e.g. Customer changed order"></div>`,
    foot: `<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-danger" id="rv-confirm">${isVoid?'Confirm Void':'Confirm Refund'}</button>`,
    onMount:(root)=>{
      root.querySelector('[data-cancel]').onclick = closeModal;
      root.querySelector('#rv-confirm').onclick = async ()=>{
        const reason = root.querySelector('#rv-reason').value.trim();
        let refundItems = [], refundAmount = 0;
        if(isVoid){
          refundItems = items.map(it=>({saleItemId:it.id, quantity:it.quantity, recipeId:it.recipeId, modifiers:it.modifiers||[]}));
          refundAmount = sale.grand_total;
        } else {
          root.querySelectorAll('[data-item]').forEach(row=>{
            const qty = Number(row.querySelector('.rv-qty').value)||0;
            if(qty>0){
              const it = items.find(x=>x.id===row.dataset.item);
              refundItems.push({saleItemId:it.id, quantity:qty, recipeId:it.recipeId, modifiers:it.modifiers||[]});
              refundAmount += (it.line_total/it.quantity)*qty;
            }
          });
          if(refundItems.length===0){ toast('Select at least one item/quantity to refund','error'); return; }
        }
        const now = new Date().toISOString();
        const currentShift = activeShift();
        const refundRec = {id: uid('refund'), saleId: sale.id, shift_id: currentShift ? currentShift.id : null,
          type: isVoid?'VOID':(refundAmount>=sale.grand_total-0.01?'FULL_REFUND':'PARTIAL_REFUND'),
          amount: refundAmount, reason, items: refundItems, approved_by: authUser.name, approved_by_id: authUser.id, date: now, notes:'', created_at: now};
        await DB.put('refunds', refundRec);
        // Reverse inventory for each affected item, scaled by refunded qty (not full original
        // qty) — mirrors completeSale() exactly, including modifier-driven extra ingredients,
        // so a refunded "Extra Shot" gives back the extra shot's coffee too, not just the base recipe.
        for(const ri of refundItems){
          const {lines} = recipeCost(ri.recipeId);
          for(const ingLine of lines){
            const qty = Number(ingLine.quantity||0) * ri.quantity;
            if(qty<=0) continue;
            await DB.put('inventoryTransactions', {id: uid('txn'), ingredientId: ingLine.ingredientId, transaction_type:'SALE_REVERSAL', quantity: qty,
              reference_id: refundRec.id, transaction_date: now.slice(0,10), notes:`${isVoid?'Void':'Refund'} of ${sale.transaction_number}`, created_at: now});
          }
          for(const mod of ri.modifiers){
            if(mod.ingredientId && mod.ingredientQtyDelta){
              const qty = Number(mod.ingredientQtyDelta) * ri.quantity;
              await DB.put('inventoryTransactions', {id: uid('txn'), ingredientId: mod.ingredientId, transaction_type:'SALE_REVERSAL', quantity: qty,
                reference_id: refundRec.id, transaction_date: now.slice(0,10), notes:`${isVoid?'Void':'Refund'} modifier "${mod.label}" — ${sale.transaction_number}`, created_at: now});
            }
          }
        }
        sale.status = isVoid ? 'VOIDED' : (refundRec.type==='FULL_REFUND' ? 'REFUNDED' : 'PARTIALLY_REFUNDED');
        await DB.put('sales', sale);
        await logAudit(isVoid?'Sale voided':'Refund', authUser.name, `${sale.transaction_number} — ${fmtMoney(refundAmount)}${reason?' — '+reason:''}`, sale.id);
        closeModal();
        toast(isVoid?'Transaction voided, inventory restored':'Refund processed, inventory restored');
        navigatePOS('saleDetail', sale.id);
      };
    }
  });
}

