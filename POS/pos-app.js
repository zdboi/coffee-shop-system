/* =====================================================================
   POS APP
   Runs on the SAME origin/database as the Inventory app (see logic.js for
   the shared `state`, costing engine, and backup core). This file adds
   POS-only in-memory state (cart, session) and all POS screens.
   ===================================================================== */

const posState = {
  cart: [],              // [{lineId, recipeId, name, unitPrice, quantity, modifiers:[{group,label,priceDelta}], baseModCost}]
  discount: null,        // {type:'percent'|'fixed', value, appliedBy}
  currentUser: null,     // {id, name, role}
  route: 'pos',
  resumingHeldSaleId: null,
  catFilter: 'ALL',
  searchTerm: '',
};

const ROLE_RANK = {CASHIER:1, MANAGER:2, ADMIN:3};
function hasRole(minRole){
  if(!posState.currentUser) return false;
  return ROLE_RANK[posState.currentUser.role] >= ROLE_RANK[minRole];
}

/* ================= PIN hashing (SubtleCrypto — real hashing, not plaintext) ================= */
async function hashPin(pin){
  const enc = new TextEncoder().encode('coffeepos:'+pin);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,'0')).join('');
}

/* ================= Bootstrap ================= */
async function bootstrap(){
  await openDB();
  state.settings = (await DB.get('settings','app')) || null;
  if(!state.settings){
    state.settings = {...DEFAULT_SETTINGS, schemaVersion: SCHEMA_VERSION, device_tag: shortDeviceTag()};
    await DB.put('settings', state.settings);
    await seedInitialData();
  } else {
    let changed = false;
    for(const k of Object.keys(DEFAULT_SETTINGS)){
      if(!(k in state.settings)){ state.settings[k] = DEFAULT_SETTINGS[k]; changed = true; }
    }
    if(!state.settings.device_tag){ state.settings.device_tag = shortDeviceTag(); changed = true; }
    if(changed) await DB.put('settings', state.settings);
  }
  await loadAll();
  await ensureProducedCategory();
  applyCustomTheme();
  updateOnlinePill_POS();
  window.addEventListener('online', ()=>{ updateOnlinePill_POS(); maybeAutoBackup_POS(); });
  window.addEventListener('offline', updateOnlinePill_POS);
  if('serviceWorker' in navigator && location.protocol.startsWith('http')){
    navigator.serviceWorker.register('./pos-sw.js').catch(()=>{});
  }
  initPinGate(); // async; awaits internally before the pad becomes interactive
  maybeAutoBackup_POS();
}

async function maybeAutoBackup_POS(){
  const s = state.settings;
  if(!s.autoBackupLocal && !s.autoBackupGDrive) return;
  if(s.autoBackupLocal && isBackupDue(s.lastLocalBackup, s.backupFrequency)){
    try{ await exportDatabase(true, 'auto'); }
    catch(e){ console.warn('Automatic local backup failed', e); }
  }
  if(s.autoBackupGDrive && isBackupDue(s.lastGDriveBackup, s.backupFrequency)){
    if(navigator.onLine && s.gdriveConnected){
      try{ await gdriveBackup(true); } catch(e){ /* stays local, retried later */ }
    }
  }
}

function updateOnlinePill_POS(){
  const pill = document.getElementById('offline-pill');
  if(!pill) return;
  if(navigator.onLine){ pill.className='online'; pill.innerHTML='<span class="dot"></span> Online'; }
  else { pill.className='offline'; pill.innerHTML='<span class="dot"></span> Offline — sales still work'; }
}

window.addEventListener('DOMContentLoaded', ()=>{ bootstrap().catch(err=>{ console.error(err); alert('Failed to start the POS: '+err.message); }); });

/* =====================================================================
   PIN GATE / SESSION
   Not a security boundary (see ARCHITECTURE.md) — a local-only app can't
   cryptographically stop someone with device access. What this genuinely
   provides: per-person accountability in the audit log, and a real deterrent
   against casual misuse (a cashier can't refund/discount/void without a
   manager physically entering their own PIN).
   ===================================================================== */
let pinBuffer = '';
let pinMode = 'login'; // 'login' | 'firstrun' | 'override'
let pinOverrideResolve = null;
let pinOverrideMinRole = 'MANAGER';

async function initPinGate(){
  await refreshPinGateMode(); // establish firstrun vs login BEFORE the pad can be used
  const pad = document.getElementById('pin-pad');
  pad.addEventListener('click', (e)=>{
    const btn = e.target.closest('button'); if(!btn) return;
    const k = btn.dataset.k;
    if(k==='clear') pinBuffer='';
    else if(k==='back') pinBuffer = pinBuffer.slice(0,-1);
    else if(pinBuffer.length<6) pinBuffer += k;
    renderPinDisplay();
    if(pinBuffer.length>=4) setTimeout(trySubmitPin, 120);
  });
}

function renderPinDisplay(){
  const disp = document.getElementById('pin-display');
  disp.innerHTML = Array.from({length:6}).map((_,i)=>`<span class="dot ${i<pinBuffer.length?'filled':''}"></span>`).join('');
}

async function refreshPinGateMode(){
  await loadAll(); // make sure we see the latest users list (e.g. after Settings changes)
  pinBuffer=''; renderPinDisplay();
  document.getElementById('pin-error').textContent='';
  if(state.users.length===0 && pinMode!=='override'){
    pinMode = 'firstrun';
    document.getElementById('pin-title').textContent = 'Welcome — Set Up Admin';
    document.getElementById('pin-sub').textContent = 'No users yet. Create the first Admin account to get started.';
  } else if(pinMode!=='override'){
    pinMode = 'login';
    document.getElementById('pin-title').textContent = 'Enter PIN';
    document.getElementById('pin-sub').textContent = 'Sign in to start a shift';
  }
}

async function trySubmitPin(){
  if(pinMode==='firstrun'){
    if(pinBuffer.length<4){ showPinError('PIN must be at least 4 digits'); return; }
    openModal({
      title:'Create Admin Account', body:`
        <div class="form-row"><label>Your Name</label><input id="fr-name" placeholder="e.g. Juan Dela Cruz"></div>
        <p class="hint">PIN entered: ${'•'.repeat(pinBuffer.length)} — you'll use this PIN to sign in from now on.</p>
      `, foot:`<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" id="fr-save">Create Admin</button>`,
      onMount:(root)=>{
        root.querySelector('[data-cancel]').onclick = ()=>{ closeModal(); pinBuffer=''; renderPinDisplay(); };
        root.querySelector('#fr-save').onclick = async ()=>{
          const name = root.querySelector('#fr-name').value.trim();
          if(!name){ toast('Enter your name','error'); return; }
          const pinHash = await hashPin(pinBuffer);
          const user = {id: uid('user'), name, role:'ADMIN', pin_hash: pinHash, active:true, created_at:new Date().toISOString()};
          await DB.put('users', user);
          state.users.push(user);
          await logAudit('User login', name, 'First-run Admin account created');
          closeModal();
          await signIn(user);
        };
      }
    });
    return;
  }
  // login or override
  const hash = await hashPin(pinBuffer);
  const user = state.users.find(u=>u.pin_hash===hash && u.active!==false);
  if(!user){ showPinError('Incorrect PIN'); pinBuffer=''; renderPinDisplay(); return; }
  if(pinMode==='override'){
    if(ROLE_RANK[user.role] < ROLE_RANK[pinOverrideMinRole]){ showPinError(`This action needs a ${pinOverrideMinRole.toLowerCase()} PIN`); pinBuffer=''; renderPinDisplay(); return; }
    document.getElementById('pin-gate').style.display='none';
    if(pinOverrideResolve) pinOverrideResolve(user);
    return;
  }
  await signIn(user);
}
function showPinError(msg){ document.getElementById('pin-error').textContent = msg; }

async function signIn(user){
  posState.currentUser = {id:user.id, name:user.name, role:user.role};
  await logAudit('User login', user.name, `Role: ${user.role}`);
  document.getElementById('pin-gate').style.display='none';
  document.getElementById('app').style.display='flex';
  renderPOSShell();
  navigatePOS('pos');
}

function lockSession(){
  posState.currentUser = null;
  posState.cart = []; posState.discount = null;
  document.getElementById('app').style.display='none';
  document.getElementById('pin-gate').style.display='flex';
  pinMode='login';
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
    // allow cancel via a tap-and-hold-free simple escape: clicking the inventory link area cancels
    const cancelLink = document.querySelector('.pin-inventory-link');
    const origHandler = cancelLink.onclick;
    cancelLink.textContent = '← Cancel';
    cancelLink.href = 'javascript:void(0)';
    cancelLink.onclick = (e)=>{
      e.preventDefault();
      document.getElementById('pin-gate').style.display='none';
      cancelLink.textContent = 'Open Inventory App instead →'; cancelLink.href='../Inventory/index.html'; cancelLink.onclick=null;
      pinMode='login';
      resolve(null);
    };
  });
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
  {id:'salesHistory', label:'Sales History', ic:'🧾'},
  {id:'reports', label:'Reports', ic:'📊'},
  {id:'backup', label:'Backup & Restore', ic:'💾'},
  {id:'settings', label:'Settings', ic:'⚙'},
];

function renderPOSShell(){
  const logo = state.settings.logo ? `<img src="${state.settings.logo}" alt="logo" style="width:26px;height:26px;object-fit:contain;border-radius:6px;vertical-align:middle;margin-right:2px;">` : '🛒';
  document.getElementById('sidebar').innerHTML = `
    <div class="brand">${logo} <span>${escapeHtml(appDisplayName())} POS</span><small>${escapeHtml(businessName()) || 'Point of Sale'}</small></div>
    <div id="nav">${POS_NAV_ITEMS.map(n=>`<div class="nav-item" data-route="${n.id}"><span class="ic">${n.ic}</span><span class="label">${n.label}</span></div>`).join('')}
      ${hasRole('ADMIN')?`<div class="nav-item" data-route="auditLog"><span class="ic">📋</span><span class="label">Audit Log</span></div>`:''}
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
  document.title = appDisplayName() + ' POS' + (businessName()? ' — '+businessName() : '');
  updateOnlinePill_POS();
}

const POS_ROUTE_TITLES = {
  pos:'Point of Sale', salesHistory:'Sales History', reports:'Reports',
  backup:'Backup & Restore', settings:'Settings', auditLog:'Audit Log', saleDetail:'Transaction Detail',
};

function navigatePOS(route, param=null){
  posState.route = route; posState.routeParam = param;
  document.querySelectorAll('.nav-item').forEach(elx=> elx.classList.toggle('active', elx.dataset.route===route));
  document.getElementById('topbar-title').textContent = POS_ROUTE_TITLES[route] || '';
  const renderers = {
    pos: renderPOSScreen, salesHistory: renderSalesHistory, reports: renderPOSReports,
    backup: renderPOSBackup, settings: renderPOSSettings, auditLog: renderAuditLogScreen,
    saleDetail: ()=>renderSaleDetail(param),
  };
  document.getElementById('topbar-actions').innerHTML = '';
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

  const held = state.sales.filter(s=>s.status==='HELD');
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
  if(list.length===0){ grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;">No products found. Add sellable recipes in the Inventory app, or check they have a selling price set.</div>`; return; }
  grid.innerHTML = list.map(r=>{
    const avail = recipeAvailability(r);
    const low = avail<=2;
    return `<div class="pos-product-card ${avail<=0?'unavailable':''}" data-recipe="${r.id}">
      <div><div class="ptag">${escapeHtml(posCategoryOf(r))}</div><div class="pname">${escapeHtml(r.name)}</div></div>
      <div class="pprice">${fmtMoney(r.selling_price)}${low?` <span style="font-size:10px;color:var(--red);">·${avail<=0?' out':' low'}</span>`:''}</div>
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
  let selections = existingLine ? JSON.parse(JSON.stringify(existingLine.modifiers)) : []; // [{groupId, optionId}]
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
  if(clearBtn) clearBtn.onclick = async ()=>{ const ok = await confirmDialog('Clear the current order?'); if(ok){ posState.cart=[]; posState.discount=null; posState.resumingHeldSaleId=null; renderCartPanel(); } };
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
  const sale = {
    id: saleId, transaction_number: nextTransactionNumber(), transaction_date: now,
    status:'HELD', cashier: posState.currentUser.name, notes:'', sync_status:'local', created_at: now,
  };
  await DB.put('sales', sale);
  const oldItems = await DB.byIndex('saleItems','saleId', saleId);
  for(const it of oldItems) await DB.delete('saleItems', it.id);
  for(const line of posState.cart){
    await DB.put('saleItems', {id: uid('sit'), saleId, recipeId: line.recipeId, name: line.name, quantity: line.quantity, unit_price: line.unitPrice, modifiers: line.modifiers, line_total: cartLineTotal(line)});
  }
  await loadAll();
  toast('Order held — resume it anytime from Held Orders');
  posState.cart = []; posState.discount = null; posState.resumingHeldSaleId = null;
  navigatePOS('pos');
}

async function showHeldOrders(){
  const held = state.sales.filter(s=>s.status==='HELD').sort((a,b)=> new Date(b.transaction_date)-new Date(a.transaction_date));
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
// value carried in from earlier UI state — the closest a local-only app can get to "never
// trust the frontend's number" without an actual server to validate against.
async function completeSale(paymentInfo){
  const now = new Date().toISOString();
  const totals = currentCartTotals();
  const saleId = posState.resumingHeldSaleId || uid('sale');
  const shift = activeShift();
  const sale = {
    id: saleId,
    transaction_number: (state.sales.find(s=>s.id===saleId) || {}).transaction_number || nextTransactionNumber(),
    transaction_date: now, status: 'COMPLETED', cashier: posState.currentUser.name,
    shift_id: shift ? shift.id : null,
    subtotal: totals.subtotal, discount_type: posState.discount?.type||null, discount_value: posState.discount?.value||0,
    discount_amount: totals.discountAmt, tax_amount: totals.tax, service_charge_amount: totals.serviceCharge,
    grand_total: totals.grandTotal, notes:'', sync_status:'local', created_at: now,
  };
  await DB.put('sales', sale);

  // Replace any prior saleItems (e.g. resuming a held order) then write fresh ones
  const oldItems = await DB.byIndex('saleItems','saleId', saleId);
  for(const it of oldItems) await DB.delete('saleItems', it.id);
  for(const line of posState.cart){
    await DB.put('saleItems', {
      id: uid('sit'), saleId, recipeId: line.recipeId, name: line.name, quantity: line.quantity,
      unit_price: line.unitPrice, modifiers: line.modifiers, line_total: cartLineTotal(line),
    });
  }

  await DB.put('payments', {id: uid('pay'), saleId, method: paymentInfo.method, amount: paymentInfo.amount,
    tendered: paymentInfo.tendered, change: paymentInfo.change, reference: paymentInfo.reference,
    status: paymentInfo.status, created_at: now});

  // Inventory deduction — uses the EXACT SAME recipe-costing/ingredient-line traversal the
  // Inventory app uses (recipeCost(), shared via logic.js), not separate POS-side logic.
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

  await logAudit('Sale completed', posState.currentUser.name, `${sale.transaction_number} — ${fmtMoney(sale.grand_total)} (${paymentInfo.method})`, saleId);
  await loadAll();
  posState.cart = []; posState.discount = null; posState.resumingHeldSaleId = null;
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
  content.querySelector('#rep-from').onchange = e=>{ posReportState.from=e.target.value; renderReportBody_POS(); };
  content.querySelector('#rep-to').onchange = e=>{ posReportState.to=e.target.value; renderReportBody_POS(); };
  content.querySelector('#rep-export').onclick = exportPOSReportCSV;
  renderReportBody_POS();
}

function salesInRange(){
  const from = new Date(posReportState.from+'T00:00:00').getTime();
  const to = new Date(posReportState.to+'T23:59:59').getTime();
  return state.sales.filter(s=>{ const t=new Date(s.transaction_date).getTime(); return t>=from && t<=to; });
}
let lastReportTable = {headers:[], rows:[]};
function renderReportBody_POS(){
  const wrap = document.getElementById('rep-body');
  const sales = salesInRange();
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
function renderPOSBackup(){
  const content = document.getElementById('content');
  content.className = '';
  const s = state.settings;
  content.innerHTML = `
    <div class="settings-block">
      <div class="card">
        <div style="font-size:13.5px;line-height:1.9;">
          <div>Last Local Backup: <b>${s.lastLocalBackup?fmtDate(s.lastLocalBackup):'Never'}</b></div>
          <div>Last Google Drive Backup: <b>${s.lastGDriveBackup?fmtDate(s.lastGDriveBackup):'Never'}</b></div>
          <div>Total Transactions Stored: <b>${state.sales.filter(x=>x.status!=='HELD').length}</b> (retained indefinitely — five years minimum)</div>
          <div>Saving to: <b id="pos-backup-folder-label">Browser downloads (default)</b></div>
        </div>
        <div style="display:flex;gap:10px;margin-top:16px;flex-wrap:wrap;">
          <button class="btn btn-primary" id="pos-backup-now">BACK UP NOW</button>
          <button class="btn btn-outline" id="pos-restore-btn">Restore Backup</button>
          <input type="file" id="pos-import-input" accept=".json" style="display:none;">
        </div>
        <p class="hint" style="margin-top:10px;">This backs up the WHOLE shared system — every Inventory ingredient/recipe AND every POS sale — since both apps use one local database. Restoring requires Admin authorization because it replaces all current data.</p>
      </div>

      ${FS_ACCESS_SUPPORTED ? `<div class="card" style="margin-top:16px;">
        <div style="margin-bottom:10px;font-weight:700;">Backup Location</div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          <button class="btn btn-outline btn-sm" id="pos-choose-folder">Choose Folder (USB / External Drive)</button>
          <button class="btn btn-ghost btn-sm" id="pos-clear-folder">Use Default Downloads</button>
        </div>
      </div>` : ''}

      <div class="card" style="margin-top:16px;">
        <div style="margin-bottom:10px;font-weight:700;">Automatic Backup Schedule</div>
        <div class="toggle-row"><span>Automatic Local Backup</span><label class="switch"><input type="checkbox" id="pos-tog-local" ${s.autoBackupLocal?'checked':''}><span class="slider-tog"></span></label></div>
        <div class="toggle-row"><span>Google Drive Automatic Backup</span><label class="switch"><input type="checkbox" id="pos-tog-gdrive" ${s.autoBackupGDrive?'checked':''}><span class="slider-tog"></span></label></div>
        <div class="form-row" style="margin-top:12px;"><label>Frequency</label>
          <select id="pos-frequency">
            <option value="daily" ${s.backupFrequency==='daily'?'selected':''}>Every Day</option>
            <option value="monthly" ${s.backupFrequency==='monthly'?'selected':''}>Every Month</option>
            <option value="yearly" ${s.backupFrequency==='yearly'?'selected':''}>Every Year</option>
            <option value="manual" ${s.backupFrequency==='manual'?'selected':''}>Manually Only</option>
          </select>
        </div>
        ${s.backupFrequency!=='manual'?`<p class="hint">Next backup due: <b>${fmtDate(nextBackupDueDate(s.lastLocalBackup, s.backupFrequency).toISOString())}</b> — checked whenever this app is open.</p>`:''}
      </div>

      <div class="card" style="margin-top:16px;">
        <div style="margin-bottom:10px;font-weight:700;">Google Drive: ${s.gdriveConnected?'<span class="badge badge-green">Connected</span>':'<span class="badge badge-gray">Not Connected</span>'}</div>
        <p class="hint">Configure the Google OAuth Client ID from the Inventory app's Settings first. Once connected there, it works from POS too (same shared settings).</p>
        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          <button class="btn btn-primary btn-sm" id="pos-gdrive-connect">${s.gdriveConnected?'Reconnect':'Connect Google Drive'}</button>
          <button class="btn btn-amber btn-sm" id="pos-gdrive-backup" ${!s.gdriveConnected?'disabled':''}>Backup to Google Drive Now</button>
          <button class="btn btn-outline btn-sm" id="pos-gdrive-restore" ${!s.gdriveConnected?'disabled':''}>Restore from Google Drive</button>
        </div>
      </div>
    </div>
  `;
  getSavedBackupFolderHandle().then(handle=>{ const elx=document.getElementById('pos-backup-folder-label'); if(elx && handle) elx.textContent = `📁 ${handle.name}`; });

  document.getElementById('pos-backup-now').onclick = ()=> exportDatabase();
  document.getElementById('pos-restore-btn').onclick = async ()=>{
    const authUser = await requireOverride('ADMIN');
    if(!authUser) return;
    document.getElementById('pos-import-input').click();
  };
  document.getElementById('pos-import-input').onchange = (e)=> handleImportFile(e.target.files[0]);

  if(FS_ACCESS_SUPPORTED){
    document.getElementById('pos-choose-folder').onclick = async ()=>{
      try{ const handle = await chooseBackupFolder(); document.getElementById('pos-backup-folder-label').textContent = `📁 ${handle.name}`; toast('Backup folder set'); }
      catch(e){ if(e.name!=='AbortError') toast('Could not access that folder: '+e.message, 'error'); }
    };
    document.getElementById('pos-clear-folder').onclick = async ()=>{ await clearBackupFolder(); document.getElementById('pos-backup-folder-label').textContent='Browser downloads (default)'; toast('Reverted to downloads'); };
  }
  document.getElementById('pos-tog-local').onchange = async (e)=>{ s.autoBackupLocal=e.target.checked; await DB.put('settings', s); toast('Saved'); };
  document.getElementById('pos-tog-gdrive').onchange = async (e)=>{ s.autoBackupGDrive=e.target.checked; await DB.put('settings', s); toast('Saved'); };
  document.getElementById('pos-frequency').onchange = async (e)=>{ s.backupFrequency=e.target.value; await DB.put('settings', s); renderPOSBackup(); };
  document.getElementById('pos-gdrive-connect').onclick = ()=> gdriveConnect(()=>renderPOSBackup());
  document.getElementById('pos-gdrive-backup').onclick = ()=> gdriveBackup();
  document.getElementById('pos-gdrive-restore').onclick = async ()=>{
    const authUser = await requireOverride('ADMIN');
    if(!authUser) return;
    gdriveRestoreFlow_POS();
  };
}

async function exportDatabase(silent, tag){
  const payload = await buildBackupPayload();
  const stamp = new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
  const filename = `${fileNameSlug()}-backup${tag?'-'+tag:''}-${stamp}.json`;
  const content = JSON.stringify(payload,null,2);
  let wroteToFolder = false;
  try{ wroteToFolder = await writeBackupToFolder(filename, content, state.settings.backup_retain_count); }
  catch(e){ console.warn('Folder backup failed, falling back to download', e); }
  if(!wroteToFolder) downloadFile(filename, content, 'application/json');
  state.settings.lastLocalBackup = new Date().toISOString();
  await DB.put('settings', state.settings);
  if(!silent) toast(wroteToFolder ? `Backup saved to your chosen folder — ${filename}` : 'Database exported — file downloaded');
}
async function handleImportFile(file){
  if(!file) return;
  try{
    const text = await file.text();
    const payload = JSON.parse(text);
    if(!payload.data){ toast('This does not look like a valid backup file for this system','error'); return; }
    const ok = await confirmDialog('Importing will REPLACE all current data (Inventory AND POS, including sales history) with the contents of this backup. A safety backup of your current data will be downloaded first. Continue?');
    if(!ok) return;
    await exportDatabase(true, 'pre-import-safety');
    await restoreFromPayloadCore(payload);
    applyCustomTheme();
    renderPOSShell();
    toast('Database imported successfully');
    navigatePOS('pos');
  }catch(e){
    console.error(e);
    toast('Could not read this backup file — it may be corrupted or invalid','error');
  }
}
async function gdriveRestoreFlow_POS(){
  if(!state.settings.gdriveConnected || !gdriveAccessToken){ toast('Connect Google Drive first', 'error'); return; }
  if(!navigator.onLine){ toast('No internet connection', 'error'); return; }
  try{
    const files = await gdriveListBackups();
    if(files.length===0){ toast('No backups found in your Google Drive folder', 'warn'); return; }
    openModal({title:'Restore from Google Drive', body:`<p style="margin-bottom:10px;">Select a backup to restore.</p>
      <div class="table-wrap"><table><thead><tr><th>File</th><th>Modified</th><th></th></tr></thead><tbody>
      ${files.map(f=>`<tr><td>${f.name}</td><td>${fmtDate(f.modifiedTime)}</td><td><button class="btn btn-sm btn-primary" data-file="${f.id}">Restore</button></td></tr>`).join('')}
      </tbody></table></div>`, foot:`<button class="btn btn-outline" data-cancel>Close</button>`,
      onMount:(root)=>{
        root.querySelector('[data-cancel]').onclick = closeModal;
        root.querySelectorAll('[data-file]').forEach(btn=> btn.onclick = async ()=>{
          const ok = await confirmDialog('This will replace all current local data with this Google Drive backup. Continue?');
          if(!ok) return;
          const payload = await gdriveDownloadBackup(btn.dataset.file);
          await exportDatabase(true, 'pre-gdrive-restore-safety');
          await restoreFromPayloadCore(payload);
          applyCustomTheme(); renderPOSShell();
          closeModal(); toast('Restored from Google Drive'); navigatePOS('pos');
        });
      }
    });
  }catch(e){ console.error(e); toast('Could not list Google Drive backups', 'error'); }
}
async function renderPOSSettings(){
  const content = document.getElementById('content');
  content.className = '';
  const s = state.settings;
  const users = state.users.slice().sort((a,b)=>a.name.localeCompare(b.name));
  const localOnly = state.sales.filter(x=>x.sync_status==='local' && x.status!=='HELD').length;

  content.innerHTML = `
    <div class="settings-block">
      <div class="section-title" style="margin-top:0;">Sync Status</div>
      <div class="card">
        <div style="display:flex;align-items:center;gap:10px;"><span class="sync-pill local" style="font-size:13px;padding:6px 14px;">Local Only</span>
          <span>${localOnly} transaction${localOnly===1?'':'s'} stored on this device</span></div>
        <p class="hint" style="margin-top:10px;">This build is single-device by design — there is no central server for this terminal to sync to, so nothing here is faked as "pending sync." Every transaction is safely stored locally and included in your backups. See <b>Documentation/ARCHITECTURE.md</b> for what real multi-terminal sync would require and how to add it later.</p>
      </div>

      <div class="section-title">Business & Receipt Info</div>
      <div class="card">
        <p class="hint" style="margin-top:0;">Business name, app name, logo, and colors are set once for the whole system from the <a class="linklike" href="../Inventory/index.html">Inventory app's Settings → Customization</a> — they apply here automatically.</p>
        <div class="form-grid">
          <div class="form-row"><label>Business Address</label><input id="set-address" value="${escapeHtml(s.business_address||'')}"></div>
          <div class="form-row"><label>Contact Number</label><input id="set-contact" value="${escapeHtml(s.business_contact||'')}"></div>
        </div>
        <div class="form-grid">
          <div class="form-row"><label>Tax %</label><input type="number" step="any" id="set-tax" value="${s.tax_pct||0}"></div>
          <div class="form-row"><label>Service Charge %</label><input type="number" step="any" id="set-service" value="${s.service_charge_pct||0}"></div>
        </div>
        <div class="form-row"><label>Receipt Footer Message</label><input id="set-footer" value="${escapeHtml(s.receipt_footer||'')}"></div>
        <div class="form-row"><label>Device Label</label><input value="${s.device_tag}" disabled><div class="hint">Used inside transaction numbers (e.g. POS-${s.device_tag}-2026-000001) so this device's numbering never collides with another device's.</div></div>
        <button class="btn btn-primary btn-sm" id="save-pos-settings">Save</button>
      </div>

      <div class="section-title">Users & Roles ${hasRole('ADMIN')?'':'<span class="text-light" style="font-size:12px;font-weight:400;">(Admin only)</span>'}</div>
      <div class="card">
        ${hasRole('ADMIN') ? `
          <div class="table-wrap"><table><thead><tr><th>Name</th><th>Role</th><th>Status</th><th></th></tr></thead>
          <tbody>${users.map(u=>`<tr><td><b>${escapeHtml(u.name)}</b></td><td>${u.role}</td><td>${u.active!==false?'<span class="badge badge-green">Active</span>':'<span class="badge badge-gray">Deactivated</span>'}</td>
            <td><button class="btn btn-sm btn-ghost" data-reset-pin="${u.id}">Reset PIN</button> <button class="btn btn-sm btn-ghost" data-toggle-active="${u.id}">${u.active!==false?'Deactivate':'Reactivate'}</button></td></tr>`).join('')}</tbody></table></div>
          <button class="btn btn-outline btn-sm" id="add-user-btn" style="margin-top:12px;">+ Add User</button>
        ` : `<p class="hint">Sign in as an Admin to manage users and PINs.</p>`}
      </div>
    </div>
  `;
  document.getElementById('save-pos-settings').onclick = async ()=>{
    s.business_address = document.getElementById('set-address').value;
    s.business_contact = document.getElementById('set-contact').value;
    s.tax_pct = Number(document.getElementById('set-tax').value)||0;
    s.service_charge_pct = Number(document.getElementById('set-service').value)||0;
    s.receipt_footer = document.getElementById('set-footer').value;
    await DB.put('settings', s);
    toast('Settings saved');
  };
  if(hasRole('ADMIN')){
    document.getElementById('add-user-btn').onclick = openAddUserModal;
    content.querySelectorAll('[data-reset-pin]').forEach(b=> b.onclick = ()=> openResetPinModal(b.dataset.resetPin));
    content.querySelectorAll('[data-toggle-active]').forEach(b=> b.onclick = async ()=>{
      const u = state.users.find(x=>x.id===b.dataset.toggleActive);
      u.active = u.active===false ? true : false;
      await DB.put('users', u);
      await logAudit(u.active?'User reactivated':'User deactivated', posState.currentUser.name, u.name);
      await loadAll();
      renderPOSSettings();
    });
  }
}

function openAddUserModal(){
  openModal({title:'Add User', body:`
    <div class="form-row"><label>Name</label><input id="au-name" placeholder="e.g. Maria Santos"></div>
    <div class="form-row"><label>Role</label><select id="au-role"><option value="CASHIER">Cashier</option><option value="MANAGER">Manager</option><option value="ADMIN">Admin</option></select></div>
    <div class="form-row"><label>4–6 Digit PIN</label><input id="au-pin" type="password" inputmode="numeric" maxlength="6" placeholder="e.g. 4821"></div>
  `, foot:`<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" id="au-save">Add User</button>`,
  onMount:(root)=>{
    root.querySelector('[data-cancel]').onclick = closeModal;
    root.querySelector('#au-save').onclick = async ()=>{
      const name = root.querySelector('#au-name').value.trim();
      const pin = root.querySelector('#au-pin').value.trim();
      if(!name){ toast('Enter a name','error'); return; }
      if(!/^\d{4,6}$/.test(pin)){ toast('PIN must be 4-6 digits','error'); return; }
      if(state.users.some(u=>u.active!==false)){
        const dupe = await hashPin(pin);
        if(state.users.some(u=>u.pin_hash===dupe)){ toast('That PIN is already in use by another user — choose a different one','error'); return; }
      }
      const user = {id: uid('user'), name, role: root.querySelector('#au-role').value, pin_hash: await hashPin(pin), active:true, created_at:new Date().toISOString()};
      await DB.put('users', user);
      await logAudit('User created', posState.currentUser.name, `${name} (${user.role})`);
      await loadAll();
      closeModal(); toast('User added'); renderPOSSettings();
    };
  }});
}
function openResetPinModal(userId){
  const u = state.users.find(x=>x.id===userId);
  openModal({title:`Reset PIN — ${u.name}`, body:`<div class="form-row"><label>New 4–6 Digit PIN</label><input id="rp-pin" type="password" inputmode="numeric" maxlength="6"></div>`,
    foot:`<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" id="rp-save">Save</button>`,
    onMount:(root)=>{
      root.querySelector('[data-cancel]').onclick = closeModal;
      root.querySelector('#rp-save').onclick = async ()=>{
        const pin = root.querySelector('#rp-pin').value.trim();
        if(!/^\d{4,6}$/.test(pin)){ toast('PIN must be 4-6 digits','error'); return; }
        u.pin_hash = await hashPin(pin);
        await DB.put('users', u);
        await logAudit('PIN reset', posState.currentUser.name, u.name);
        closeModal(); toast('PIN updated');
      };
    }});
}
async function renderAuditLogScreen(){
  const content = document.getElementById('content');
  content.className = '';
  if(!hasRole('ADMIN')){ content.innerHTML = emptyBlock('Admin access required to view the audit log.'); return; }
  const entries = state.auditLog.slice().sort((a,b)=> new Date(b.at)-new Date(a.at)).slice(0,300);
  content.innerHTML = `
    <div class="text-light" style="font-size:13px;margin-bottom:14px;">Showing the ${entries.length} most recent entries. The audit log is append-only — there is no delete/edit function in this UI.</div>
    <div class="table-wrap"><table><thead><tr><th>Date/Time</th><th>Action</th><th>Actor</th><th>Details</th></tr></thead>
    <tbody>${entries.map(e=>`<tr><td>${fmtDate(e.at)} ${new Date(e.at).toLocaleTimeString()}</td><td><b>${escapeHtml(e.action)}</b></td><td>${escapeHtml(e.actor)}</td><td class="text-light">${escapeHtml(e.details)}</td></tr>`).join('')}</tbody></table></div>
  `;
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
      <div class="text-light" style="font-size:13px;">Showing most recent first — five years of history retained</div>
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
      <td><span class="sync-pill local">Local</span></td>
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
          amount: refundAmount, reason, items: refundItems, approved_by: authUser.name, date: now, notes:''};
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
        await loadAll();
        closeModal();
        toast(isVoid?'Transaction voided, inventory restored':'Refund processed, inventory restored');
        navigatePOS('saleDetail', sale.id);
      };
    }
  });
}

