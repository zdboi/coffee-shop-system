/* =====================================================================
   FRONT OFFICE — the counter POS (staff).
   Built from the original POS app. What changed:
   * Data lives in Supabase. Every counter action becomes an "operation"
     that is applied on screen immediately, saved in a local queue, and
     uploaded by fo_sync(). If the internet drops, selling continues and
     the queue uploads when it comes back.
   * Staff sign in with a PIN checked by the server. Offline, CASHIERS can
     sign in against a copy saved on this counter the last time they signed
     in online (manager/admin PINs are never saved on a counter).
   * A counter joins the shop only with a pairing code (Back Office → Devices).
   * Manager approvals (refund, void, discount, closing someone else's shift)
     carry a token the server checks when the action uploads. A manager typing
     their PIN to approve needs internet. A manager who is signed in (online)
     may approve their OWN actions even offline, with their sign-in token.
   * New: QR Orders board, customer attach, sold-out toggles.
   ===================================================================== */

const cloud = Cloud.createClient({storageKey: 'cccc.staff.session'});
const DEVICE_KEY_STORAGE = 'cccc.device.key';
const STAFF_SESSION_STORAGE = 'cccc.staff.active';     // shared with Back Office (same tab)
const ROLE_RANK = {CASHIER:1, MANAGER:2, ADMIN:3};

const posState = {
  cart: [],              // [{lineId, recipe_id, name, unit_price, quantity, modifiers:[{group,label,price_delta,ingredient_id,ingredient_qty_delta}], notes}]
  discount: null,        // {type:'percent'|'fixed', value, appliedBy, approvedById}
  currentUser: null,     // {id, name, role, offline}
  customer: null,        // {id, nickname}
  qrOrder: null,         // QR order being paid
  route: 'pos', routeParam: null,
  resumingHeldSaleId: null,
  catFilter: 'ALL', searchTerm: '',
  lastBootstrapAt: 0,
  qrSince: null, qrSeen: new Set(),
  todaySales: null,
  shiftCheckOk: null,    // did the last server check of the open shift succeed? (null = not asked yet)
  loginExpiresAt: null,  // when the signed-in person's server login ends (a manager's login also approves their own actions)
  shiftSyncedAt: 0,      // last time the open shift's figures were checked against the server
};

function hasRole(minRole){
  if(!posState.currentUser) return false;
  return ROLE_RANK[posState.currentUser.role] >= ROLE_RANK[minRole];
}
function deviceKey(){
  let k = localStorage.getItem(DEVICE_KEY_STORAGE);
  if(!k){ k = 'dev-' + uid(); localStorage.setItem(DEVICE_KEY_STORAGE, k); }
  return k;
}
// Online = the browser thinks so AND the last request reached the server
// (Wi-Fi can be connected while the internet behind it is down).
function isOnline(){ return cloud.isReachable(); }
cloud.onNetwork((up)=>{
  updateSyncPill();
  if(up){ setTimeout(()=>{ Sync.run(); pollQrOrders(); }, 200); }
  if(posState.route==='qr') renderQrBoard();
});
function show(id, on){ const n = document.getElementById(id); if(n) n.style.display = on ? (id==='app'?'flex':'flex') : 'none'; }

/* =====================================================================
   BOOT
   ===================================================================== */
async function bootstrap(){
  registerSW();
  const params = new URLSearchParams(location.search);
  const pairCode = params.get('pair') || '';
  const sess = await cloud.ensureSession();
  if(!sess){ showSetup(pairCode); return; }
  // Counters join only with a pairing code (a counter login). An owner email login
  // left on this counter by an older version is not used any more.
  if(!cloud.isAnonymous()){
    showSetup(pairCode, 'This counter now connects with a pairing code only. Get a code from the owner (Back Office → Devices → Pair a counter).');
    return;
  }

  let loaded = false;
  try{
    await loadFromServer();
    loaded = true;
  }catch(e){
    if(e.offline){
      loaded = await loadFromSnapshot();
      if(!loaded){ showSetup(pairCode, 'No internet. This counter needs internet the first time it starts.'); return; }
    } else if(/NOT_A_MEMBER/.test(e.message)){
      const wasPaired = !!(await LocalDB.get('fo.snapshot'));
      showSetup(pairCode, wasPaired ? 'This counter is no longer connected to the shop (it may have been removed in Back Office → Devices). Pair it again with a new code. Sales saved on this counter upload after pairing.' : '');
      return;
    } else {
      console.error(e);
      loaded = await loadFromSnapshot();
      if(!loaded){ showSetup(pairCode, friendlyError(e)); return; }
    }
  }

  if(!state.device){ showSetup(pairCode); return; }

  applyCustomTheme();
  show('boot-screen', false); show('setup-screen', false);
  startBackgroundLoops();
  initPinGate();
  const resumed = resumeStaffSession();
  if(!resumed) showPinGate('login');
}

async function loadFromServer(){
  const data = await cloud.rpc('fo_bootstrap', {p_device_key: deviceKey()}, {timeout: 15000});
  await applyBootstrap(data);
  posState.lastBootstrapAt = Date.now();
  await LocalDB.set('fo.snapshot', data);
  // Drawer maths needs the sale behind each of this shift's refunds (a refund of a cash sale from an earlier shift).
  try{ await fillRefundSales(SHIFT_CHECK_MS); }catch(e){ if(!e.offline) console.warn('could not load a refunded sale', e.message); }
}
async function loadFromSnapshot(){
  const data = await LocalDB.get('fo.snapshot');
  if(!data || !data.device) return false;
  await applyBootstrap(data);
  toast('Offline — using the menu saved on this counter', 'warn');
  return true;
}
async function applyBootstrap(d){
  state.business = d.business || null;
  state.device = d.device || null;
  setSettingsFromServer(d.settings);
  state.staff = d.staff || [];
  state.categories = d.categories || [];
  state.ingredients = d.ingredients || [];
  state.recipes = d.recipes || [];
  state.recipeIngredients = d.recipe_ingredients || [];
  setStockFromServer(d.stock);
  state.shifts = d.shifts || [];
  state.sales = d.sales || [];
  state.saleItems = d.sale_items || [];
  state.payments = d.payments || [];
  state.refunds = d.refunds || [];
  state.cashMovements = d.cash_movements || [];
  state.tables = d.tables || [];
  state.qrOrders = d.qr_orders || [];
  state.qrOrders.forEach(o => posState.qrSeen.add(o.id));
  posState.qrSince = state.qrOrders.reduce((m,o)=> (!m || o.updated_at > m) ? o.updated_at : m, null) || d.server_time || null;
  if(d.next_numbers) mergeCounters(d.next_numbers);
  // Operations still waiting to upload are re-applied so they don't vanish from the screen.
  const pending = await LocalDB.outboxAll();
  pending.forEach(op => applyOpLocally(op, true));
  await prunePinVerifiers();
}

/* ---- snapshot of the current state, for offline restarts ---- */
let snapshotTimer = null;
function saveSnapshotSoon(){
  clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(async ()=>{
    if(!state.device) return;
    try{
      await LocalDB.set('fo.snapshot', {
        server_time: new Date().toISOString(), business: state.business, device: state.device, settings: serverSettingsRow(),
        staff: state.staff, categories: state.categories, ingredients: state.ingredients, recipes: state.recipes,
        recipe_ingredients: state.recipeIngredients,
        stock: Object.keys(state.stock).map(k=>({ingredient_id:k, stock: state.stock[k]})),
        shifts: state.shifts.filter(s=>s.status==='ACTIVE'),
        sales: state.sales, sale_items: state.saleItems, payments: state.payments, refunds: state.refunds,
        cash_movements: state.cashMovements, tables: state.tables,
        qr_orders: state.qrOrders.filter(o=>['PENDING','PREPARING','READY'].includes(o.status)),
      });
    }catch(e){ console.warn('snapshot failed', e); }
  }, 3000);
}

/* ---- transaction / shift numbering (per counter, per year) ---- */
function counterKey(){ return 'cccc.counters.' + (state.device ? state.device.device_tag : 'X'); }
function readCounters(){
  const year = new Date().getFullYear();
  let c = null;
  try{ c = JSON.parse(localStorage.getItem(counterKey())||'null'); }catch(e){}
  if(!c || c.year !== year) c = {year, pos:0, shift:0};
  return c;
}
function mergeCounters(server){
  const c = readCounters();
  if(server && server.year === c.year){ c.pos = Math.max(c.pos, Number(server.pos)||0); c.shift = Math.max(c.shift, Number(server.shift)||0); }
  localStorage.setItem(counterKey(), JSON.stringify(c));
}
function nextTransactionNumber(){
  const c = readCounters(); c.pos += 1; localStorage.setItem(counterKey(), JSON.stringify(c));
  return `POS-${state.device.device_tag}-${c.year}-${String(c.pos).padStart(6,'0')}`;
}
function nextShiftNumber(){
  const c = readCounters(); c.shift += 1; localStorage.setItem(counterKey(), JSON.stringify(c));
  return `SHIFT-${state.device.device_tag}-${c.year}-${String(c.shift).padStart(4,'0')}`;
}

/* =====================================================================
   SETUP (pair this counter — the only way a counter joins the shop)
   ===================================================================== */
function showSetup(prefillCode, message){
  // Opened from the Back Office QR code (?pair=CODE): the owner already typed this counter's
  // name there, so the name box starts empty and the server uses the owner's name.
  const fromLink = !!prefillCode;
  show('boot-screen', false); show('app', false); show('pin-gate', false);
  const wrap = document.getElementById('setup-screen');
  wrap.style.display = 'flex';
  wrap.innerHTML = `
    <div class="auth-card setup-card">
      <div class="pin-logo">☕</div>
      <h2>Set up this counter</h2>
      <p class="text-light" style="margin:4px 0 16px;">Connect this tablet or computer to your shop once. After that, staff just enter their PIN.</p>
      ${message?`<div class="notice warn">${escapeHtml(message)}</div>`:''}
      <ol class="setup-steps">
        <li>On the owner's login, open <b>Back Office → Devices → Pair a counter</b>.</li>
        <li>Type the 6-character code below (it works for 15 minutes).</li>
      </ol>
      ${fromLink
        ? `<div class="form-row"><label for="su-devname">Counter name (optional)</label><input id="su-devname" maxlength="30" value="" placeholder="Leave empty to use the name from Back Office"></div>`
        : `<div class="form-row"><label for="su-devname">Counter name</label><input id="su-devname" maxlength="30" value="${escapeHtml(localStorage.getItem('cccc.device.name')||'Front Counter')}"></div>`}
      <div class="form-row"><label for="su-code">Pairing code</label><input id="su-code" value="${escapeHtml(prefillCode)}" autocapitalize="characters" autocomplete="off" maxlength="6" class="code-input" placeholder="ABC123"></div>
      <button class="btn btn-primary btn-big" id="su-pair">Pair this counter</button>
      <div id="su-error" class="pin-error"></div>
    </div>`;
  const err = (m)=>{ document.getElementById('su-error').textContent = m || ''; };
  const pair = async ()=>{
    const btn = document.getElementById('su-pair');
    if(btn.disabled) return;
    const code = document.getElementById('su-code').value.trim().toUpperCase();
    // An empty name is sent as "no name": the server then uses the name the owner typed in Back Office.
    const name = document.getElementById('su-devname').value.trim();
    if(code.length < 6){ err('Enter the 6-character code.'); return; }
    btn.disabled = true; btn.textContent = 'Pairing…'; err('');
    const failed = (m)=>{ err(m); btn.disabled = false; btn.textContent = 'Pair this counter'; };
    try{
      // A counter is always its own anonymous login (never an owner email login).
      if(!cloud.session || !cloud.isAnonymous()){ await cloud.signOut(); await cloud.signInAnonymously(); }
      const r = await cloud.rpc('redeem_device_pairing', {p_code: code, p_device_key: deviceKey(), p_device_name: name || null});
      if(r && r.error){ failed(friendlyError(r)); return; }
      if(name) localStorage.setItem('cccc.device.name', name);
      toast('Counter paired');
      location.replace(location.pathname);
    }catch(e){ failed(e.offline ? 'No internet. Pairing needs internet — check the connection and try again.' : friendlyError(e)); }
  };
  document.getElementById('su-pair').onclick = pair;
  document.getElementById('su-code').addEventListener('keydown', (e)=>{ if(e.key==='Enter') pair(); });
}

/* =====================================================================
   PIN GATE / SESSION
   ===================================================================== */
const APPROVAL_OFFLINE_TEXT = 'Manager approval needs internet. Try again when the counter is back online.';
const APPROVAL_ENDED_TEXT = 'Your sign-in has run out, so you cannot approve while offline. Connect to the internet, then lock and sign in again.';
let pinBuffer = '';
let pinMode = 'login';         // 'login' | 'override'
let pinOverrideResolve = null;
let pinOverrideMinRole = 'MANAGER';
let pinBusy = false;

function initPinGate(){
  const pad = document.getElementById('pin-pad');
  if(pad.dataset.ready) return;
  pad.dataset.ready = '1';
  pad.addEventListener('click', (e)=>{
    const btn = e.target.closest('button'); if(!btn || pinBusy) return;
    const k = btn.dataset.k;
    hidePinChoice();                    // changing the PIN cancels the "upload first?" question
    if(k==='clear') pinBuffer='';
    else if(k==='back') pinBuffer = pinBuffer.slice(0,-1);
    else if(pinBuffer.length<6) pinBuffer += k;
    renderPinDisplay();
    if(pinBuffer.length===6) submitPin();
  });
  document.getElementById('pin-enter').onclick = ()=>{ if(!pinBusy) submitPin(); };
  document.addEventListener('keydown', (e)=>{
    if(document.getElementById('pin-gate').style.display==='none' || pinBusy) return;
    if(/^\d$/.test(e.key) && pinBuffer.length<6){ hidePinChoice(); pinBuffer += e.key; renderPinDisplay(); }
    else if(e.key==='Backspace'){ hidePinChoice(); pinBuffer = pinBuffer.slice(0,-1); renderPinDisplay(); }
    else if(e.key==='Enter') submitPin();
  });
}
function renderPinDisplay(){
  document.getElementById('pin-display').innerHTML = Array.from({length:6}).map((_,i)=>`<span class="dot ${i<pinBuffer.length?'filled':''}"></span>`).join('');
}
function showPinError(msg){ document.getElementById('pin-error').textContent = msg || ''; }

function showPinGate(mode){
  pinMode = mode || 'login';
  pinBuffer = ''; renderPinDisplay(); showPinError(''); hidePinChoice();
  const logo =state.settings.logo_url ? `<img src="${escapeHtml(state.settings.logo_url)}" alt="" style="width:46px;height:46px;object-fit:contain;">` : '☕';
  document.getElementById('pin-logo').innerHTML = logo;
  const foot = document.getElementById('pin-foot');
  if(pinMode === 'login'){
    document.getElementById('pin-title').textContent = businessName() || 'Enter PIN';
    const noPins = !state.staff.some(s=>s.active!==false && s.has_pin);
    document.getElementById('pin-sub').innerHTML = noPins
      ? 'No staff PINs yet. The owner sets them in <b>Back Office → Staff</b>.'
      : `Enter your PIN · ${escapeHtml(state.device ? state.device.device_name : '')}`;
    foot.innerHTML = `<a href="../back/" class="pin-link">Back Office →</a>`;
    // Offline and paused after too many wrong PINs: say so (and until when) straight away.
    const pausedUntil = isOnline() ? 0 : offlinePinLockedUntil();
    if(pausedUntil) showPinError(offlinePinLockText(pausedUntil));
  } else {
    document.getElementById('pin-title').textContent = `${pinOverrideMinRole.charAt(0)+pinOverrideMinRole.slice(1).toLowerCase()} PIN required`;
    document.getElementById('pin-sub').textContent = hasRole(pinOverrideMinRole)
      ? 'Enter your PIN again to approve. This needs internet.'
      : 'Ask a manager to enter their PIN to approve. This needs internet.';
    foot.innerHTML = `<a href="#" class="pin-link" id="pin-cancel">← Cancel</a>`;
    document.getElementById('pin-cancel').onclick = (e)=>{ e.preventDefault(); finishOverride(null); };
  }
  document.getElementById('pin-gate').style.display='flex';
}
// Closes the approval PIN pad and hands the approver (or null = cancelled) to whoever asked.
function finishOverride(approver){
  document.getElementById('pin-gate').style.display='none';
  pinMode = 'login';
  pinBuffer = ''; renderPinDisplay(); showPinError('');
  const r = pinOverrideResolve; pinOverrideResolve = null;
  if(r) r(approver);
}
// Words for a refused PIN. friendlyError() also shows until when the pad is locked
// after too many wrong PINs (staff_pin_login sends locked_until).
function pinErrorText(r, minRole){
  if(r.text) return r.text;
  if(r.error==='ROLE_TOO_LOW') return `This needs a ${String(minRole||'MANAGER').toLowerCase()} PIN`;
  return friendlyError(r);         // the whole server answer, e.g. {error:'TOO_MANY_ATTEMPTS', locked_until}
}

async function submitPin(opts){
  opts = opts || {};
  if(pinBusy) return;
  if(pinBuffer.length < 4){ showPinError('PIN must be at least 4 digits'); return; }
  const pin = pinBuffer;
  const mode = pinMode;
  const minRole = pinOverrideMinRole;
  hidePinChoice();
  pinBusy = true; showPinError('Checking…');
  try{
    if(mode==='override'){
      const r = await approvalPin(pin, minRole);
      if(pinMode!=='override' || !pinOverrideResolve) return;      // cancelled while checking
      if(r.offline){ finishOverride(null); toast(APPROVAL_OFFLINE_TEXT, 'warn'); return; }
      if(r.error){ pinBuffer=''; renderPinDisplay(); showPinError(pinErrorText(r, minRole)); return; }
      finishOverride(r.approver);
      return;
    }
    // F2: an online sign-in ends earlier sign-ins on this counter, so upload first.
    if(isOnline() && !opts.skipUploadCheck){
      if(Sync.pending) showPinError('Checking… uploading waiting items first');
      await uploadBeforeSignIn();
      if(pinMode!=='login' || pinBuffer!==pin) return;
      const n = await queuedLoginApprovals();
      if(n){ showPinError(''); showPinChoice(n); return; }
      showPinError('Checking…');
    }
    const r = await verifyPin(pin);
    if(r.error){ pinBuffer=''; renderPinDisplay(); showPinError(pinErrorText(r)); return; }
    if(r.token && !r.offline) await markEarlierLoginsEnded(r.token);
    await signIn(r.staff, r.token, r.expires_at, !!r.offline,
      opts.signedInAnyway ? ` — signed in before ${opts.signedInAnyway} approved action(s) uploaded` : '');
    if(r.needs_new_pin){
      addAlert({id: 'pin6:' + r.staff.id, kind: 'note', title: 'Your PIN needs updating.', text: 'Ask the owner to give you a new 6-digit PIN.'});
    }
  }finally{
    pinBusy = false;
  }
}

// "Some approved actions haven't uploaded yet" — shown on the PIN card before an online sign-in.
function hidePinChoice(){
  const box = document.getElementById('pin-choice');
  if(box){ box.style.display = 'none'; box.innerHTML = ''; }
}
function showPinChoice(n, stillWaiting){
  const box = document.getElementById('pin-choice');
  if(!box) return;
  const what = n === 1 ? '1 approved action' : n + ' approved actions';
  box.innerHTML = `<div class="pin-note">${stillWaiting
      ? (isOnline() ? `${what} still couldn't upload. Check the internet and try again.` : `No internet, so ${what} couldn't upload.`) + ' '
      : ''}Some approved actions haven't uploaded yet. Signing in now will cancel those approvals.</div>
    <div class="pin-choice">
      <button class="btn btn-primary" id="pin-upload-first">Upload first</button>
      <button class="btn btn-outline" id="pin-sign-anyway">Sign in anyway</button>
    </div>`;
  box.style.display = 'block';
  document.getElementById('pin-upload-first').onclick = async (ev)=>{
    if(pinBusy) return;
    const pin = pinBuffer;
    pinBusy = true;
    ev.currentTarget.disabled = true; ev.currentTarget.textContent = 'Uploading…';
    document.getElementById('pin-sign-anyway').disabled = true;
    let left = n;
    try{ await uploadBeforeSignIn(20000); left = await queuedLoginApprovals(); }
    finally{ pinBusy = false; }
    if(pinMode!=='login' || pinBuffer!==pin) return;
    if(left){ showPinChoice(left, true); return; }
    toast('Uploaded. Signing in…');
    submitPin({skipUploadCheck: true});
  };
  document.getElementById('pin-sign-anyway').onclick = ()=>{
    if(pinBusy) return;
    submitPin({skipUploadCheck: true, signedInAnyway: n});
  };
}

// Sign-in. Online: the server checks the PIN. Offline: CASHIERS only, against the
// copy saved on this counter when they last signed in online.
async function verifyPin(pin){
  if(isOnline()){
    try{
      const r = await cloud.rpc('staff_pin_login', {p_pin: pin, p_purpose: 'LOGIN', p_min_role: null}, {timeout: 8000});
      if(r && r.error) return {error: r.error, locked_until: r.locked_until};
      cachePinVerifier(pin, r.staff);
      // Decision 8: managers/admins need a 6-digit PIN. The server may say so in its answer;
      // the counter also knows how many digits were typed.
      const needsNewPin = ROLE_RANK[r.staff.role] >= ROLE_RANK.MANAGER &&
        !!(r.pin_update_needed || r.pin_needs_update || r.pin_update_required || r.needs_new_pin || r.pin_too_short || pin.length < 6);
      return {staff: r.staff, token: r.token, expires_at: r.expires_at, needs_new_pin: needsNewPin};
    }catch(e){
      if(!e.offline) return {error: 'ERROR', text: friendlyError(e)};
    }
  }
  // Offline: a locked pad refuses without checking anything.
  const lockedUntil = offlinePinLockedUntil();
  if(lockedUntil) return {error: 'TOO_MANY_ATTEMPTS', locked_until: new Date(lockedUntil).toISOString(), text: offlinePinLockText(lockedUntil)};
  const found = await offlineVerifyPin(pin);
  // The same PIN fits two cashiers on this counter: sign nobody in (the owner gives one a new PIN).
  if(found.length > 1) return {error: 'PIN_AMBIGUOUS'};
  if(!found.length){
    const wrong = noteOfflinePinFailure();
    if(wrong.until) return {error: 'TOO_MANY_ATTEMPTS', locked_until: new Date(wrong.until).toISOString(), text: offlinePinLockText(wrong.until)};
    const left = wrong.triesLeft === 1 ? '1 try left' : wrong.triesLeft + ' tries left';
    return {error: 'WRONG_PIN', text: `Incorrect PIN, or this PIN needs internet (${left} before this counter pauses PIN sign-in). Offline, only cashiers who signed in on this counter in the last 14 days can sign in.`};
  }
  clearOfflinePinFailures();
  return {staff: found[0], offline: true};
}

/* ---- Wrong PINs while offline: limit the tries on this counter ----
   The server limits wrong PINs when online. Offline, nothing is counting, so this counter does:
   5 wrong tries lock PIN sign-in for 5 minutes; each later lock is longer (15 min, 1 h, then
   4 h). Kept in local storage, so reloading the page does not give new tries. A right PIN
   starts the count again. (Approvals never use offline PINs, so this is for sign-in only.) */
const OFFLINE_PIN_LOCK_KEY = 'cccc.offlinePin.lock';
const OFFLINE_PIN_TRIES = 5;
const OFFLINE_PIN_LOCK_MINUTES = [5, 15, 60, 240];
let offlinePinLockMemory = null;                 // used when the browser blocks local storage
function readOfflinePinLock(){
  let o = null;
  try{ o = JSON.parse(localStorage.getItem(OFFLINE_PIN_LOCK_KEY) || 'null'); }catch(e){ o = offlinePinLockMemory; }
  o = (o && typeof o === 'object') ? o : {};
  return {fails: Number(o.fails) || 0, locks: Number(o.locks) || 0, until: Number(o.until) || 0};
}
function writeOfflinePinLock(o){
  offlinePinLockMemory = o;
  try{ localStorage.setItem(OFFLINE_PIN_LOCK_KEY, JSON.stringify(o)); }catch(e){}
}
function clearOfflinePinFailures(){
  offlinePinLockMemory = null;
  try{ localStorage.removeItem(OFFLINE_PIN_LOCK_KEY); }catch(e){}
}
function offlinePinLockedUntil(){ const l = readOfflinePinLock(); return l.until > Date.now() ? l.until : 0; }
function offlinePinLockText(until){
  const mins = Math.max(1, Math.ceil((until - Date.now()) / 60000));
  const wait = mins === 1 ? 'about 1 minute' : mins < 120 ? 'about ' + mins + ' minutes' : 'about ' + Math.round(mins / 60) + ' hours';
  return `Too many wrong PINs while offline. PIN sign-in on this counter is paused until ${fmtTime(until)} (${wait}). When the internet is back, you can sign in right away.`;
}
// Counts one wrong try. Returns {until (ms, 0 = not locked), triesLeft}.
function noteOfflinePinFailure(){
  const l = readOfflinePinLock();
  const now = Date.now();
  if(l.locks && l.until && now - l.until > 24*3600*1000) l.locks = 0;      // a quiet day forgives earlier locks
  l.fails += 1;
  if(l.fails >= OFFLINE_PIN_TRIES){
    l.locks += 1; l.fails = 0;
    l.until = now + OFFLINE_PIN_LOCK_MINUTES[Math.min(l.locks, OFFLINE_PIN_LOCK_MINUTES.length) - 1] * 60000;
  }
  writeOfflinePinLock(l);
  return {until: l.until > now ? l.until : 0, triesLeft: Math.max(0, OFFLINE_PIN_TRIES - l.fails)};
}

// Manager approval: checked by the server only — never against copies on this counter.
// The answer's one-time token goes with the action to fo_sync, which checks it again.
// Returns {approver:{id,name,role,token}} | {error, locked_until} | {offline:true}.
async function approvalPin(pin, minRole){
  try{
    const r = await cloud.rpc('staff_pin_login', {p_pin: pin, p_purpose: 'OVERRIDE', p_min_role: minRole || 'MANAGER'}, {timeout: 8000});
    if(r && r.error) return {error: r.error, locked_until: r.locked_until};
    if(!r || !r.token || !r.staff) return {error: 'ERROR', text: 'The approval could not be checked. Please try again.'};
    return {approver: {id: r.staff.id, name: r.staff.name, role: r.staff.role, token: r.token}};
  }catch(e){
    if(e.offline) return {offline: true};
    return {error: 'ERROR', text: friendlyError(e)};
  }
}

/* ---- Offline PIN copies: CASHIERS only (security decision 4) ----
   A salted, slow hash of a cashier's PIN, saved when they sign in online, so they
   can sign in while the internet is down. Manager/admin PINs are never saved. */
const PIN_COPY_DAYS = 14;
async function pbkdf2Hex(pin, salt){
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({name:'PBKDF2', salt: enc.encode(salt), iterations: 60000, hash:'SHA-256'}, key, 256);
  return [...new Uint8Array(bits)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
function isActiveCashier(staffId){
  const st = state.staff.find(s=>s.id===staffId);
  return !!(st && st.active!==false && st.role==='CASHIER');
}
function pinCopyIsFresh(v){ return Date.now() - new Date(v.cached_at).getTime() < PIN_COPY_DAYS*24*3600*1000; }
async function cachePinVerifier(pin, staff){
  try{
    const list = (await LocalDB.get('fo.pinVerifiers')) || [];
    const next = list.filter(v=>v && v.staff_id!==staff.id);        // also drops a copy left from before a promotion
    if(staff.role==='CASHIER'){
      const hash = await pbkdf2Hex(pin, staff.id + ':' + deviceKey());
      next.push({staff_id: staff.id, role: 'CASHIER', hash, cached_at: new Date().toISOString()});
    }
    if(next.length || list.length) await LocalDB.set('fo.pinVerifiers', next);
  }catch(e){ console.warn('could not save the PIN copy for offline use', e); }
}
// On start-up (and after each menu refresh): keep copies only for active cashiers.
async function prunePinVerifiers(){
  try{
    const list = (await LocalDB.get('fo.pinVerifiers')) || [];
    const keep = list.filter(v => v && isActiveCashier(v.staff_id) && pinCopyIsFresh(v));
    if(keep.length !== list.length) await LocalDB.set('fo.pinVerifiers', keep);
  }catch(e){ console.warn('could not tidy the offline PIN copies', e); }
}
// Every cached cashier whose PIN fits (normally 0 or 1; 2 or more = the PIN is shared).
// All copies are checked, not only until the first match, so a shared PIN is noticed.
async function offlineVerifyPin(pin){
  const list = (await LocalDB.get('fo.pinVerifiers')) || [];
  const found = [];
  for(const v of list){
    if(!v || !isActiveCashier(v.staff_id) || !pinCopyIsFresh(v)) continue;
    if(await pbkdf2Hex(pin, v.staff_id + ':' + deviceKey()) === v.hash){
      const st = state.staff.find(s=>s.id===v.staff_id);
      if(st && !found.some(f=>f.id===st.id)) found.push({id: st.id, name: st.name, role: st.role});
    }
  }
  return found;
}

async function signIn(staff, token, expiresAt, offline, auditNote){
  posState.currentUser = {id: staff.id, name: staff.name, role: staff.role, offline: !!offline};
  posState.loginExpiresAt = token ? (expiresAt || null) : null;
  cloud.setStaffToken(token || null);
  try{ sessionStorage.setItem(STAFF_SESSION_STORAGE, JSON.stringify({staff, token: token||null, expires_at: expiresAt||null})); }catch(e){}
  if(token && ROLE_RANK[staff.role] >= ROLE_RANK.MANAGER) rememberLoginToken(token, expiresAt, staff.name);
  queueAudit('User login', `Role: ${staff.role}${offline?' (offline)':''}${auditNote||''}`);
  document.getElementById('pin-gate').style.display='none';
  show('app', true);
  renderShell();
  navigatePOS(posState.route && posState.route!=='saleDetail' ? posState.route : 'pos');
}
// Coming back from Back Office in the same tab keeps the staff member signed in.
function resumeStaffSession(){
  try{
    const s = JSON.parse(sessionStorage.getItem(STAFF_SESSION_STORAGE)||'null');
    if(!s || !s.staff) return false;
    if(s.expires_at && new Date(s.expires_at).getTime() < Date.now()) return false;
    const st = state.staff.find(x=>x.id===s.staff.id);
    if(!st || st.active===false) return false;
    posState.currentUser = {id: st.id, name: st.name, role: st.role, offline: !s.token};
    posState.loginExpiresAt = s.token ? (s.expires_at || null) : null;
    cloud.setStaffToken(s.token);
    show('app', true);
    renderShell();
    navigatePOS('pos');
    return true;
  }catch(e){ return false; }
}
// Lock / switch user. The screen locks straight away; ending the login on the
// server happens in the background (see endStaffLogin).
function lockSession(){
  const token = cloud.getStaffToken();
  const tokenEnds = posState.loginExpiresAt;
  cloud.setStaffToken(null);
  try{ sessionStorage.removeItem(STAFF_SESSION_STORAGE); }catch(e){}
  posState.currentUser = null; posState.loginExpiresAt = null;
  posState.cart = []; posState.discount = null; posState.customer = null; posState.qrOrder = null; posState.resumingHeldSaleId = null;
  show('app', false);
  showPinGate('login');
  if(token) endStaffLogin(token, tokenEnds).catch(e=>console.warn('could not end the staff login', e));
}

/* ---- Ending a staff login on the server (staff_logout) ----
   A manager's own login can be the approval for a refund / void / discount that is
   still waiting to upload; ending it first would make that upload fail. So: upload
   what's waiting first, then end the login only if nothing still waiting needs it.
   Logins that can't be ended yet (offline, or still needed) are remembered on this
   counter and ended after a later upload. */
// Each entry keeps only what ending it needs: the token (staff_logout takes it) and when it runs
// out anyway (after that there is nothing to end, so the entry is dropped).
const PENDING_LOGOUTS_KEY = 'fo.pendingLogouts';
let pendingLogoutsLoad = null;
let logoutRun = null;
function pendingLogouts(){
  if(!pendingLogoutsLoad) pendingLogoutsLoad = LocalDB.get(PENDING_LOGOUTS_KEY)
    .then(l=>(Array.isArray(l)?l:[]).map(e=>typeof e === 'string' ? {token: e, exp: null} : e).filter(e=>e && e.token))
    .catch(()=>[]);
  return pendingLogoutsLoad;     // one shared list, changed in memory and saved after each change
}
function savePendingLogouts(list){ return LocalDB.set(PENDING_LOGOUTS_KEY, list.slice()).catch(()=>{}); }
function dropExpiredLogouts(list){
  const now = Date.now();
  for(let i = list.length - 1; i >= 0; i--){
    const end = list[i].exp ? new Date(list[i].exp).getTime() : NaN;
    if(isFinite(end) && end < now) list.splice(i, 1);
  }
}
async function endStaffLogin(token, expiresAt){
  const list = await pendingLogouts();
  if(!list.some(e=>e.token===token)){ list.push({token, exp: expiresAt || null}); await savePendingLogouts(list); }
  await Sync.run();                  // upload first
  await finishPendingLogouts();
}
// A new online sign-in ends every earlier sign-in on this counter on the server (F2),
// so the counter has nothing left to end: forget those tokens.
async function forgetPendingLogouts(){
  while(logoutRun) await logoutRun;
  const list = await pendingLogouts();
  if(!list.length) return;
  list.length = 0;
  await savePendingLogouts(list);
}
async function finishPendingLogouts(){
  while(logoutRun) await logoutRun;
  logoutRun = (async ()=>{
    const list = await pendingLogouts();
    const before = list.length;
    dropExpiredLogouts(list);
    if(list.length !== before) await savePendingLogouts(list);
    if(!list.length || !isOnline()) return;
    const waiting = JSON.stringify((await LocalDB.outboxAll()).map(o=>o.data));
    for(const e of list.slice()){
      if(waiting.includes(e.token)) continue;                 // a queued approval still needs this login
      try{ await cloud.rpc('staff_logout', {p_token: e.token}, {timeout: 8000}); }
      catch(err){ if(err.offline) break; }                     // offline: try again after the next upload
      const i = list.indexOf(e); if(i>=0) list.splice(i, 1);
      await savePendingLogouts(list);
    }
  })().catch(()=>{}).finally(()=>{ logoutRun = null; });
  return logoutRun;
}

/* ---- Before an online sign-in (F2) ----
   The server ends every earlier sign-in on this counter when someone signs in online. A manager's
   offline approval (refund / void / discount / shift close) travels with that manager's sign-in
   token, so it must upload BEFORE the next online sign-in, or the server refuses it.
   So: upload what's waiting first (briefly), then warn if such approvals are still waiting. */
const PRE_SIGNIN_UPLOAD_MS = 6000;
async function uploadBeforeSignIn(ms){
  try{ await Promise.race([Sync.run(), new Promise(r=>setTimeout(r, ms || PRE_SIGNIN_UPLOAD_MS))]); }catch(e){}
}
// How many waiting uploads are approved with an earlier manager's sign-in token (not a one-time
// approval PIN). Only fingerprints of manager sign-in tokens are listed (see rememberLoginToken).
async function queuedLoginApprovals(){
  try{
    const map = (await LocalDB.get(LOGIN_TOKENS_KEY)) || {};
    if(!Object.keys(map).length) return 0;
    let n = 0;
    for(const o of await LocalDB.outboxAll()){
      const d = o.data || {};
      const ts = [d.approval_token, d.discount_approval_token].filter(Boolean);
      for(const t of ts){ if(map[await tokenKey(t)]){ n += 1; break; } }
    }
    return n;
  }catch(e){ return 0; }
}
// After a successful online sign-in: earlier manager sign-ins are now ended on the server.
async function markEarlierLoginsEnded(currentToken){
  try{
    const map = (await LocalDB.get(LOGIN_TOKENS_KEY)) || {};
    const keep = currentToken ? await tokenKey(currentToken) : null;
    const nowIso = new Date().toISOString();
    let changed = false;
    for(const k of Object.keys(map)){
      if(k === keep || !map[k]) continue;
      const e = map[k].exp ? new Date(map[k].exp).getTime() : Infinity;
      if(e > Date.now()){ map[k].exp = nowIso; changed = true; }
    }
    if(changed) await LocalDB.set(LOGIN_TOKENS_KEY, map);
  }catch(e){}
  await forgetPendingLogouts();
  updateApprovalBanner();
}

// The signed-in manager's own login token, if it can still approve (not ended, not about to end).
// It was issued by the server when they signed in online; the server checks it again when the
// action uploads, and accepts it only when that same person is the one doing the action.
function ownLoginToken(){
  const t = cloud.getStaffToken();
  if(!t) return null;
  const end = posState.loginExpiresAt ? new Date(posState.loginExpiresAt).getTime() : NaN;
  if(isFinite(end) && end - Date.now() < 60*1000) return null;
  return t;
}

// Manager (or admin) approval for a refund, void, discount or closing someone else's
// shift — without losing the current cart. Resolves to {id, name, role, token} or null.
// The token goes with the action to the server, which checks it (security decision 3):
//  * a manager who is signed in approves their OWN actions with their sign-in token, with or
//    without internet (owner decision 2026-10-12);
//  * anyone else's action (a cashier's) needs a manager to type their PIN, which only the
//    server can check, so that needs internet. Manager PINs are never checked offline.
function requireOverride(minRole='MANAGER'){
  const me = posState.currentUser;
  const own = me && hasRole(minRole) ? ownLoginToken() : null;
  if(own) return Promise.resolve({id: me.id, name: me.name, role: me.role, token: own, own: true});
  if(!isOnline()){
    toast(me && hasRole(minRole) && cloud.getStaffToken() ? APPROVAL_ENDED_TEXT : APPROVAL_OFFLINE_TEXT, 'warn');
    return Promise.resolve(null);
  }
  if(pinOverrideResolve){ const prev = pinOverrideResolve; pinOverrideResolve = null; prev(null); }
  return new Promise((resolve)=>{
    pinOverrideMinRole = minRole;
    pinOverrideResolve = resolve;
    showPinGate('override');
  });
}

/* =====================================================================
   OPERATIONS + SYNC (outbox)
   ===================================================================== */
// Apply an operation to what's on screen. `replay` = re-applying a queued op after a reload.
function applyOpLocally(op, replay){
  const d = op.data || {};
  switch(op.type){
    case 'shift_open':
      if(!state.shifts.some(s=>s.id===d.id)) state.shifts.push(Object.assign({status:'ACTIVE', device_id: state.device && state.device.id}, d));
      break;
    case 'shift_close': {
      const sh = state.shifts.find(s=>s.id===d.id);
      if(sh && sh.status!=='CLOSED') Object.assign(sh, d, {status:'CLOSED', approval_token: undefined});
      if(sh) delete sh.approval_token;
      break;
    }
    case 'cash_movement':
      if(!state.cashMovements.some(m=>m.id===d.id)) state.cashMovements.push(d);
      break;
    case 'sale': {
      const sale = d.sale;
      noteTouchedSale(sale.id);
      const existing = state.sales.find(s=>s.id===sale.id);
      if(existing && existing.status!=='HELD') break;               // already final (server copy)
      if(existing) Object.assign(existing, sale); else state.sales.push(Object.assign({}, sale));
      state.saleItems = state.saleItems.filter(i=>i.sale_id!==sale.id).concat(d.items||[]);
      state.payments = state.payments.filter(p=>p.sale_id!==sale.id).concat(d.payment ? [d.payment] : []);
      if(sale.status==='COMPLETED'){
        applyStockDeltas((d.inventory||[]).map(t=>Object.assign({transaction_type:'SALE_USAGE'}, t)));
        if(sale.qr_order_id){
          const o = state.qrOrders.find(x=>x.id===sale.qr_order_id);
          if(o){ o.sale_id = sale.id; o.paid_at = o.paid_at || sale.transaction_date; if(o.status==='PENDING') o.status = 'PREPARING'; }
        }
      }
      break;
    }
    case 'held_delete':
      noteTouchedSale(d.id);
      state.sales = state.sales.filter(s=>!(s.id===d.id && s.status==='HELD'));
      state.saleItems = state.saleItems.filter(i=>i.sale_id!==d.id || state.sales.some(s=>s.id===d.id));
      break;
    case 'refund': {
      noteTouchedSale(d.refund.sale_id);
      if(state.refunds.some(r=>r.id===d.refund.id)) break;
      state.refunds.push(d.refund);
      applyStockDeltas((d.inventory||[]).map(t=>Object.assign({transaction_type:'SALE_REVERSAL'}, t)));
      const s = state.sales.find(x=>x.id===d.refund.sale_id) || (posState.todaySales && posState.todaySales.sales.find(x=>x.id===d.refund.sale_id));
      if(s) s.status = d.sale_status;
      break;
    }
    case 'sold_out': {
      const r = state.recipes.find(x=>x.id===d.recipe_id);
      if(r) r.sold_out = !!d.sold_out;
      break;
    }
  }
  if(!replay) saveSnapshotSoon();
}

const Sync = {
  busy: false, pending: 0, failed: 0, lastError: null, timer: null,
  async queue(type, data){
    const op = {op_id: uid(), type, data};
    applyOpLocally(op, false);
    await LocalDB.outboxAdd(op);
    this.pending += 1;
    updateSyncPill();
    updateApprovalBanner();
    this.kick();
    return op;
  },
  kick(){ clearTimeout(this.timer); this.timer = setTimeout(()=>this.run(), 250); },
  // Upload what's waiting. While an upload is already running, returns that one
  // (so callers like "Lock" can wait for it to finish).
  run(){
    if(!this.current) this.current = this._run().finally(()=>{ this.current = null; });
    return this.current;
  },
  async _run(){
    if(navigator.onLine === false){ await this.refreshCounts(); return; }
    this.busy = true;
    try{
      for(let guard = 0; guard < 40; guard++){
        const all = await LocalDB.outboxAll();
        this.pending = all.length; updateSyncPill();
        if(!all.length) break;
        const batch = all.slice(0, 25);
        let results;
        try{
          results = await cloud.rpc('fo_sync', {p_device_key: deviceKey(), p_ops: batch.map(o=>({op_id:o.op_id, type:o.type, data:o.data}))}, {timeout: 45000});
          this.lastError = null;
        }catch(e){
          this.lastError = e;
          if(!e.offline){
            console.error('sync failed', e);
            if(/DEVICE_NOT_REGISTERED|NOT_A_MEMBER|DEVICE_MISMATCH/.test(e.message)){
              setBanner('This counter was removed from the shop. Sales stay saved here; pair it again to upload them.', 'error');
            }
          }
          break;
        }
        const done = [];
        for(const r of (results||[])){
          const o = batch.find(b=>b.op_id===r.op_id);
          if(!o) continue;
          if(r.status==='error'){
            await LocalDB.failedAdd(Object.assign({}, o, {error: r.message, failed_at: new Date().toISOString()}));
            if(o.type==='sale' && errorCode(r.message)==='QR_ORDER_ALREADY_PAID') await onQrOrderAlreadyPaid(o);
            else toast(`Could not upload a ${o.type.replace('_',' ')}: ${friendlyError({message:r.message})}`, 'error');
          }
          done.push(o.seq);
        }
        await LocalDB.outboxRemove(done);
        if(done.length < batch.length) break;
      }
    }finally{
      this.busy = false;
      await this.refreshCounts();
      saveSnapshotSoon();
      finishPendingLogouts();          // staff logins that were waiting for these uploads
    }
  },
  async refreshCounts(){
    this.pending = await LocalDB.outboxCount();
    this.failed = (await LocalDB.failedAll()).length;
    updateSyncPill();
    updateApprovalBanner();
  },
};
function queueAudit(action, details, referenceId){
  if(!posState.currentUser && action!=='User login') return;
  const actor = posState.currentUser || {};
  return Sync.queue('audit', {id: uid(), action, actor_id: actor.id || null, actor_name: actor.name || 'Unknown',
    details: details || '', reference_id: referenceId ? String(referenceId) : null, at: new Date().toISOString()});
}

function updateSyncPill(){
  const pill = document.getElementById('sync-pill');
  const online = isOnline();
  const banner = document.getElementById('offline-banner');
  if(banner && !banner.dataset.sticky){
    if(!online){ banner.style.display='block'; banner.className='offline-banner'; banner.textContent = `Offline — keep selling. ${Sync.pending ? Sync.pending+' item(s) will upload when the internet is back.' : ''} QR orders pause until you're back online.`; }
    else banner.style.display='none';
  }
  if(!pill) return;
  let cls = 'online', txt = 'Online · all saved';
  if(!online){ cls='offline'; txt = `Offline · ${Sync.pending} waiting`; }
  else if(Sync.pending){ cls='pending'; txt = `Uploading ${Sync.pending}…`; }
  if(Sync.failed){ cls='failed'; txt += ` · ${Sync.failed} failed`; }
  pill.className = 'sync-status ' + cls;
  pill.innerHTML = `<span class="dot"></span> ${txt}`;
}
function setBanner(text, kind){
  const b = document.getElementById('offline-banner');
  if(!b) return;
  if(!text){ b.style.display='none'; delete b.dataset.sticky; return; }
  b.dataset.sticky = '1'; b.className = 'offline-banner ' + (kind||''); b.textContent = text; b.style.display='block';
}

/* ---- Manager sign-ins that queued approvals depend on ----
   A manager's sign-in token (16 hours) is what approves their own refund / void / discount /
   shift close while the counter is offline. The server checks it when the action uploads, so if
   the sign-in runs out first the action is refused. We remember each manager sign-in's end time
   here and warn on screen when queued approvals are about to be left without one. */
const LOGIN_TOKENS_KEY = 'fo.loginTokens';
const APPROVAL_WARN_MS = 2*3600*1000;
// Only a fingerprint of the token is kept in this list (the token itself stays where it already is: the waiting action).
async function tokenKey(token){
  const bits = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(token)));
  return [...new Uint8Array(bits)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
async function rememberLoginToken(token, expiresAt, name){
  try{
    const map = (await LocalDB.get(LOGIN_TOKENS_KEY)) || {};
    map[await tokenKey(token)] = {exp: expiresAt || null, name: name || ''};
    const cutoff = Date.now() - 2*24*3600*1000;
    Object.keys(map).forEach(k=>{ const e = map[k] && map[k].exp ? new Date(map[k].exp).getTime() : 0; if(e && e < cutoff) delete map[k]; });
    await LocalDB.set(LOGIN_TOKENS_KEY, map);
  }catch(e){ console.warn('could not save the sign-in end time', e); }
}
async function updateApprovalBanner(){
  const box = document.getElementById('approval-banner');
  if(!box) return;
  try{
    const map = (await LocalDB.get(LOGIN_TOKENS_KEY)) || {};
    const ops = await LocalDB.outboxAll();
    let n = 0, soonest = null, who = '';
    for(const o of ops){
      const d = o.data || {};
      const t = d.approval_token || d.discount_approval_token;
      const entry = t ? map[await tokenKey(t)] : null;
      const e = entry && entry.exp ? new Date(entry.exp).getTime() : null;
      if(!e) continue;
      n += 1;
      if(soonest === null || e < soonest){ soonest = e; who = entry.name || 'The manager'; }
    }
    if(!n || soonest - Date.now() > APPROVAL_WARN_MS){ box.style.display = 'none'; return; }
    const them = n === 1 ? 'it' : 'them';
    const waiting = n === 1 ? '1 approved action is' : n + ' approved actions are';
    box.textContent = soonest > Date.now()
      ? `⏰ ${waiting} waiting to upload. ${who}'s sign-in ends at ${fmtTime(soonest)}. Reconnect to the internet before then, or the server will refuse ${them}.`
      : `⚠ ${waiting} waiting to upload, but ${who}'s sign-in ended at ${fmtTime(soonest)}. Reconnect to the internet now. If the server refuses ${them}, tell the owner (they can be redone in Back Office).`;
    box.style.display = 'block';
  }catch(e){ /* the warning is a help, never a blocker */ }
}

/* ---- Important notices that must not be missed (shown until the cashier taps "Got it") ----
   Used when the server refuses a payment that already took the customer's money (e.g. a QR
   order that another counter had already been paid). Saved on this counter so a reload keeps it. */
const ALERTS_KEY = 'fo.alerts';
async function loadAlerts(){ try{ const l = await LocalDB.get(ALERTS_KEY); return Array.isArray(l) ? l : []; }catch(e){ return []; } }
async function addAlert(alert){
  const list = await loadAlerts();
  if(!list.some(a=>a.id===alert.id)){ list.push(Object.assign({at: new Date().toISOString()}, alert)); try{ await LocalDB.set(ALERTS_KEY, list); }catch(e){} }
  renderAlerts();
}
async function renderAlerts(){
  const box = document.getElementById('alert-banner');
  if(!box) return;
  const list = await loadAlerts();
  if(!list.length){ box.style.display = 'none'; box.innerHTML = ''; return; }
  const a = list[0];
  box.className = a.kind === 'note' ? 'offline-banner' : 'offline-banner error';     // 'note' = a gentle reminder
  box.innerHTML = `<b>${escapeHtml(a.title)}</b> ${escapeHtml(a.text)}
    <button class="btn btn-outline" id="alert-ok" style="margin-left:10px;">Got it${list.length>1?` (${list.length-1} more)`:''}</button>`;
  box.style.display = 'block';
  document.getElementById('alert-ok').onclick = async ()=>{ try{ await LocalDB.set(ALERTS_KEY, list.slice(1)); }catch(e){} renderAlerts(); };
}

async function showFailedOps(){
  const list = await LocalDB.failedAll();
  openModal({title:'Uploads that need attention', wide:true, body: list.length ? `
    <p class="hint" style="margin-top:0;">The server refused these. They are still saved on this counter. Usually this means a setting changed (e.g. a staff member was removed). Retry, or download the details for the owner.</p>
    <div class="table-wrap"><table><thead><tr><th>When</th><th>Type</th><th>Reason</th><th></th></tr></thead><tbody>
    ${list.map(f=>`<tr><td>${fmtDateTime(f.queued_at)}</td><td>${escapeHtml(f.type)}</td><td class="text-light">${escapeHtml(friendlyError({message:f.error}))}</td>
      <td style="white-space:nowrap;"><button class="btn btn-sm btn-outline" data-retry="${f.seq}">Retry</button> <button class="btn btn-sm btn-ghost" data-drop="${f.seq}">Dismiss</button></td></tr>`).join('')}
    </tbody></table></div>` : '<p>Nothing failed. 👍</p>',
    foot: `${list.length?'<button class="btn btn-outline" id="fo-dl-failed">Download details</button>':''}<button class="btn btn-primary" data-close>Close</button>`,
    onMount:(root)=>{
      root.querySelector('[data-close]').onclick = closeModal;
      const dl = root.querySelector('#fo-dl-failed');
      // Approval tokens stay on this counter (needed for Retry) but are left out of the download.
      const noTokens = list.map(f=>Object.assign({}, f, {data: Object.assign({}, f.data, {approval_token: undefined, discount_approval_token: undefined})}));
      if(dl) dl.onclick = ()=> downloadFile(`${fileNameSlug()}-failed-uploads-${todayISO()}.json`, JSON.stringify(noTokens, null, 2), 'application/json');
      root.querySelectorAll('[data-retry]').forEach(b=> b.onclick = async ()=>{
        const f = list.find(x=>String(x.seq)===b.dataset.retry);
        await LocalDB.failedRemove(f.seq);
        await LocalDB.outboxAdd({op_id: f.op_id, type: f.type, data: f.data});
        closeModal(); Sync.kick(); toast('Retrying…');
      });
      root.querySelectorAll('[data-drop]').forEach(b=> b.onclick = async ()=>{
        const ok = await confirmDialog('Dismiss this item? It will not be uploaded. (Download the details first if you need them.)', 'Dismiss');
        if(!ok){ showFailedOps(); return; }
        await LocalDB.failedRemove(Number(b.dataset.drop));
        await Sync.refreshCounts(); showFailedOps();
      });
    }});
}

/* =====================================================================
   BACKGROUND: sync, QR polling, freshness
   ===================================================================== */
let loopsStarted = false;
function startBackgroundLoops(){
  if(loopsStarted) return; loopsStarted = true;
  Sync.refreshCounts().then(()=>Sync.run());
  setInterval(()=>Sync.run(), 15000);
  window.addEventListener('online', ()=>{ updateSyncPill(); Sync.run(); pollQrOrders(); });
  window.addEventListener('offline', updateSyncPill);
  setInterval(pollQrOrders, 7000);
  setInterval(refreshStockQuietly, 5*60*1000);
  setInterval(updateApprovalBanner, 60*1000);          // "sign-in ends soon" warning
  document.addEventListener('visibilitychange', ()=>{ if(!document.hidden){ pollQrOrders(); Sync.run(); } });
}

let pollBusy = false;
async function pollQrOrders(){
  if(pollBusy || navigator.onLine === false || !cloud.session || !state.device) return;
  pollBusy = true;
  try{
    const since = posState.qrSince || new Date(Date.now()-6*3600*1000).toISOString();
    const rows = await cloud.select('qr_orders', {gt:{updated_at: since}, order:'updated_at.asc', limit: 200});
    let newOnes = 0;
    (rows||[]).forEach(o=>{
      if(!posState.qrSeen.has(o.id)){ posState.qrSeen.add(o.id); if(o.status==='PENDING') newOnes++; }
      mergeQrOrder(o);
      if(!posState.qrSince || o.updated_at > posState.qrSince) posState.qrSince = o.updated_at;
    });
    if(rows && rows.length){
      updateQrBadge();
      if(posState.route==='qr') renderQrBoard();
      if(newOnes){ chime(); toast(`📱 ${newOnes} new QR order${newOnes>1?'s':''}`, 'warn'); }
    }
  }catch(e){ if(!e.offline) console.warn('QR poll failed', e.message); }
  finally{ pollBusy = false; }
}
function mergeQrOrder(o){
  const i = state.qrOrders.findIndex(x=>x.id===o.id);
  if(i>=0){
    const local = state.qrOrders[i];
    // keep a locally-recorded payment until the server catches up
    if(local.paid_at && !o.paid_at){ o.paid_at = local.paid_at; o.sale_id = local.sale_id; }
    state.qrOrders[i] = o;
  } else state.qrOrders.push(o);
}
function openQrOrders(){ return state.qrOrders.filter(o=>['PENDING','PREPARING','READY'].includes(o.status)); }
function updateQrBadge(){
  const n = state.qrOrders.filter(o=>o.status==='PENDING').length;
  document.querySelectorAll('[data-qr-badge]').forEach(b=>{ b.textContent = n; b.style.display = n ? 'inline-flex' : 'none'; });
}

let audioCtx = null;
function chime(){
  try{
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime;
    [880, 1320].forEach((f, i)=>{
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = f; o.type = 'sine';
      g.gain.setValueAtTime(0.0001, t + i*0.18);
      g.gain.exponentialRampToValueAtTime(0.25, t + i*0.18 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i*0.18 + 0.25);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(t + i*0.18); o.stop(t + i*0.18 + 0.3);
    });
  }catch(e){}
}

async function refreshStockQuietly(){
  if(!isOnline() || !cloud.session) return;
  try{
    const rows = await cloud.selectAll('v_ingredient_stock', {select:'ingredient_id,stock'});
    setStockFromServer(rows);
    const pending = await LocalDB.outboxAll();
    pending.forEach(op=>{
      if(op.type==='sale' && op.data.sale.status==='COMPLETED') applyStockDeltas(op.data.inventory.map(t=>Object.assign({transaction_type:'SALE_USAGE'}, t)));
      if(op.type==='refund') applyStockDeltas(op.data.inventory.map(t=>Object.assign({transaction_type:'SALE_REVERSAL'}, t)));
    });
    if(posState.route==='pos') renderProductGrid();
  }catch(e){}
}
// Pull a fresh menu/settings when idle (cart empty) and the last load is old.
async function maybeRefreshMenu(){
  if(!isOnline() || posState.cart.length || Date.now() - posState.lastBootstrapAt < 10*60*1000) return;
  if(Sync.pending) return;
  try{ await loadFromServer(); applyCustomTheme(); renderShell(); if(posState.route==='pos') renderPOSScreen(); }catch(e){}
}

/* =====================================================================
   FRESH SHIFT FIGURES
   The owner can change the open shift from Back Office (for example a refund taken from this
   shift's drawer). Shop data is only loaded when the counter starts, so the screens that show
   the drawer (Shift & Cash, Close shift, X-report) first ask the server for the open shift's
   sales, refunds and pay-ins / pay-outs. Offline, or if the server is slow, they use what is
   on this counter and say so. Anything still waiting to upload is never overwritten.
   ===================================================================== */
const SHIFT_CHECK_MS = 3500;                 // how long a screen waits for the server
let shiftRefreshRun = null;
// Sales changed on this counter while a server check is running: the server's copy may be older.
let touchWatchers = 0;
const touchedSales = new Set();
function watchTouchedSales(){ if(touchWatchers++ === 0) touchedSales.clear(); }
function unwatchTouchedSales(){ touchWatchers = Math.max(0, touchWatchers - 1); }
function noteTouchedSale(id){ if(touchWatchers && id) touchedSales.add(id); }

function mergeById(list, rows, skip){
  (rows || []).forEach(r=>{
    if(!r || r.id == null || (skip && skip(r))) return;
    const i = list.findIndex(x=>x.id===r.id);
    if(i >= 0) Object.assign(list[i], r); else list.push(r);
  });
}
async function selectPaged(table, query, timeout){
  const out = [];
  for(let offset = 0; ; offset += 1000){
    const page = await cloud.select(table, Object.assign({order: 'id.asc', limit: 1000, offset}, query), {timeout});
    out.push.apply(out, page || []);
    if(!page || page.length < 1000) break;
  }
  return out;
}
async function selectIn(table, col, ids, timeout){
  const out = [];
  for(let i = 0; i < ids.length; i += 40){
    const page = await cloud.select(table, {in: {[col]: ids.slice(i, i + 40)}}, {timeout});
    out.push.apply(out, page || []);
  }
  return out;
}
// Sales that a waiting (not yet uploaded) action changes: the server's copy of them is older.
async function pendingSaleIds(){
  const ids = new Set();
  (await LocalDB.outboxAll()).forEach(op=>{
    const d = op.data || {};
    if(op.type === 'sale' && d.sale) ids.add(d.sale.id);
    else if(op.type === 'refund' && d.refund) ids.add(d.refund.sale_id);
    else if(op.type === 'held_delete') ids.add(d.id);
  });
  return ids;
}

// Asks the server for the open shift's sales, refunds and pay-ins / pay-outs and merges them in.
// Resolves true when the server answered, false when offline / too slow / failed (nothing changed).
//   opt.timeout  ms to wait for the server (default 3.5 s)
// Calls made while a check is already running share it (a double tap does not ask twice).
function refreshOpenShift(opt){
  opt = opt || {};
  const shift = activeShift();
  if(!shift || !isOnline() || !cloud.session) return Promise.resolve(false);
  if(shiftRefreshRun) return shiftRefreshRun;                         // one check at a time; callers share it
  const t = opt.timeout || SHIFT_CHECK_MS;
  shiftRefreshRun = (async ()=>{
    watchTouchedSales();
    try{
      const before = await pendingSaleIds();
      const mine = {eq: {shift_id: shift.id}};
      const [sales, refunds, moves] = await Promise.all([selectPaged('sales', mine, t), selectPaged('refunds', mine, t), selectPaged('cash_movements', mine, t)]);
      // Sales this counter doesn't have yet (and their payments), and sales of OTHER shifts that
      // this shift's refunds point at: a refund of a cash sale takes cash out of this drawer, so the
      // sale and its payment must be known to work out the drawer.
      const known = (id)=> state.sales.some(s=>s.id===id);
      const newIds = sales.filter(s=>s.status !== 'HELD' && !known(s.id)).map(s=>s.id);
      const refundSaleIds = [...new Set(refunds.concat(state.refunds.filter(r=>r.shift_id === shift.id)).map(r=>r.sale_id))]
        .filter(id=> id && !known(id) && !sales.some(s=>s.id===id));
      const [items, pays, extraSales, extraPays] = await Promise.all([
        selectIn('sale_items', 'sale_id', newIds, t), selectIn('payments', 'sale_id', newIds, t),
        selectIn('sales', 'id', refundSaleIds, t), selectIn('payments', 'sale_id', refundSaleIds, t)]);
      // Merge now, in one go (no waiting from here on).
      const skip = new Set([...before, ...(await pendingSaleIds()), ...touchedSales]);
      mergeById(state.sales, sales, r=> skip.has(r.id) || (r.status === 'HELD' && !known(r.id)));
      mergeById(state.sales, extraSales);
      mergeById(state.saleItems, items);
      mergeById(state.payments, pays.concat(extraPays));
      mergeById(state.refunds, refunds);
      mergeById(state.cashMovements, moves);
      posState.shiftSyncedAt = Date.now();
      saveSnapshotSoon();
      return true;
    }catch(e){
      if(!e.offline) console.warn('could not check the shift against the server', e.message);
      return false;
    }finally{
      unwatchTouchedSales();
      shiftRefreshRun = null;
    }
  })();
  return shiftRefreshRun;
}
// After a full load: sales of earlier shifts that this shift's refunds point at (see above).
async function fillRefundSales(timeout){
  const shift = activeShift();
  if(!shift || !isOnline()) return;
  const missing = [...new Set(state.refunds.filter(r=>r.shift_id === shift.id).map(r=>r.sale_id))].filter(id=> id && !state.sales.some(s=>s.id===id));
  if(!missing.length) return;
  const [sales, pays] = await Promise.all([selectIn('sales', 'id', missing, timeout), selectIn('payments', 'sale_id', missing, timeout)]);
  mergeById(state.sales, sales); mergeById(state.payments, pays);
  saveSnapshotSoon();
}
// Plain words for the figures' source, shown on the shift screens when they could not be checked.
function shiftFreshNote(checked){
  if(checked) return '';
  if(checked === null && isOnline()) return '';                    // not asked yet
  return isOnline()
    ? 'Could not check the server just now, so these figures come from this counter. Changes made in Back Office (for example a refund by the owner) may not be included yet.'
    : 'No internet: these figures come from this counter. Changes made in Back Office (for example a refund by the owner) are not included until the internet is back.';
}
// The sale's refunds can come from elsewhere (Back Office, another counter): fetch them before
// working out what is left to refund. Offline, the refunds known here are used.
async function refreshSaleRefunds(sale, dataset){
  if(!isOnline() || !cloud.session) return false;
  watchTouchedSales();
  try{
    const before = await pendingSaleIds();
    const refunds = await selectPaged('refunds', {eq: {sale_id: sale.id}}, SHIFT_CHECK_MS);
    mergeById(dataset.refunds, refunds);
    if(dataset !== state && state.sales.some(s=>s.id===sale.id)) mergeById(state.refunds, refunds);
    // The sale's status follows its refunds (same rule as the server).
    if(!before.has(sale.id) && !(await pendingSaleIds()).has(sale.id) && !touchedSales.has(sale.id) && (sale.status === 'COMPLETED' || sale.status === 'PARTIALLY_REFUNDED')){
      const all = dataset.refunds.filter(r=>r.sale_id === sale.id);
      if(all.length){
        const total = all.reduce((s, r)=> s + (Number(r.amount) || 0), 0);
        const next = all.some(r=>r.type === 'VOID') ? 'VOIDED' : (total >= Number(sale.grand_total) - 0.01 ? 'REFUNDED' : 'PARTIALLY_REFUNDED');
        sale.status = next;
        const copy = state.sales.find(s=>s.id === sale.id); if(copy) copy.status = next;
      }
    }
    return true;
  }catch(e){
    return false;
  }finally{
    unwatchTouchedSales();
  }
}

/* =====================================================================
   SHELL & NAVIGATION
   ===================================================================== */
const POS_NAV_ITEMS = [
  {id:'pos', label:'Sell', ic:'🛒'},
  {id:'qr', label:'QR Orders', ic:'📱', badge:true},
  {id:'sales', label:'Sales', ic:'🧾'},
  {id:'shift', label:'Shift & Cash', ic:'🕐'},
];
const POS_ROUTE_TITLES = { pos:'Point of Sale', qr:'QR Orders', sales:'Sales', shift:'Shift & Cash', saleDetail:'Transaction Detail' };

function renderShell(){
  const logo = state.settings.logo_url ? `<img src="${escapeHtml(state.settings.logo_url)}" alt="logo" style="width:26px;height:26px;object-fit:contain;border-radius:6px;vertical-align:middle;margin-right:2px;">` : '☕';
  const u = posState.currentUser;
  document.getElementById('sidebar').innerHTML = `
    <div class="brand">${logo} <span>${escapeHtml(businessName()||appDisplayName())}</span><small>Front Office · ${escapeHtml(state.device?state.device.device_name:'')}</small></div>
    <div id="nav">${POS_NAV_ITEMS.map(n=>`<div class="nav-item" data-route="${n.id}"><span class="ic">${n.ic}</span><span class="label">${n.label}</span>${n.badge?'<span class="nav-badge" data-qr-badge style="display:none;">0</span>':''}</div>`).join('')}
      ${u && u.role==='ADMIN' ? `<a class="nav-item" href="../back/" style="text-decoration:none;"><span class="ic">🗂</span><span class="label">Back Office</span></a>` : ''}
    </div>
    <div id="sidebar-foot">
      <div style="margin-bottom:8px;"><span class="role-badge">👤 ${escapeHtml(u?u.name:'')} · ${u?u.role:''}${u&&u.offline?' · offline':''}</span></div>
      <button class="sync-status online" id="sync-pill" title="Upload status — tap for details"><span class="dot"></span> Online</button>
      <button class="btn btn-ghost btn-sm" id="lock-btn" style="margin-top:8px;width:100%;">🔒 Lock / Switch User</button>
    </div>`;
  document.getElementById('nav').addEventListener('click', (e)=>{
    const item = e.target.closest('.nav-item[data-route]');
    if(item) navigatePOS(item.dataset.route);
  });
  document.getElementById('lock-btn').onclick = lockSession;
  document.getElementById('sync-pill').onclick = ()=>{ Sync.run(); showFailedOps(); };
  document.title = 'Front Office — ' + (businessName()||appDisplayName());
  updateSyncPill(); updateQrBadge(); updateApprovalBanner(); renderAlerts();
}

function navigatePOS(route, param=null){
  posState.route = route; posState.routeParam = param;
  document.querySelectorAll('.nav-item').forEach(n=> n.classList.toggle('active', n.dataset.route===route));
  document.getElementById('topbar-title').textContent = POS_ROUTE_TITLES[route] || '';
  document.getElementById('topbar-actions').innerHTML = '';
  const content = document.getElementById('content');
  content.className = '';
  const renderers = { pos: renderPOSScreen, qr: renderQrBoard, sales: renderSalesScreen, shift: renderShiftScreen, saleDetail: ()=>renderSaleDetail(param) };
  (renderers[route]||renderPOSScreen)();
  if(route==='pos') maybeRefreshMenu();
}

/* =====================================================================
   MAIN POS SCREEN
   ===================================================================== */
function sellableRecipes(){
  return state.recipes.filter(r => r.active!==false && r.pos_visible!==false && Number(r.selling_price) > 0);
}
// How many more can be made right now from on-hand stock (99 = not tracked).
function recipeAvailability(recipe){
  const {lines} = recipeCost(recipe.id);
  let lowest = Infinity;
  for(const l of lines){
    const qtyNeeded = Number(l.quantity)||0;
    if(qtyNeeded<=0) continue;
    lowest = Math.min(lowest, Math.floor(ingredientStock(l.ingredient_id)/qtyNeeded));
  }
  return lowest===Infinity ? 99 : lowest;
}

function renderPOSScreen(){
  const shift = activeShift();
  if(!shift){ renderStartShiftGate(); return; }

  const held = state.sales.filter(s=>s.status==='HELD');
  const pendingQr = state.qrOrders.filter(o=>o.status==='PENDING').length;
  document.getElementById('topbar-actions').innerHTML = `
    <span class="shift-badge" title="Opened ${fmtDateTime(shift.opened_at)} by ${escapeHtml(shift.cashier_name)}">🕐 ${escapeHtml(shift.shift_number||'')} · ${shiftDuration(shift)}</span>
    <button class="btn btn-outline" id="qr-jump">📱 QR Orders <span class="nav-badge" data-qr-badge style="display:${pendingQr?'inline-flex':'none'};">${pendingQr}</span></button>
    ${held.length? `<button class="btn btn-outline" id="held-orders-btn">📥 Held (${held.length})</button>` : ''}`;
  document.getElementById('qr-jump').onclick = ()=>navigatePOS('qr');
  if(held.length) document.getElementById('held-orders-btn').onclick = showHeldOrders;

  const content = document.getElementById('content');
  const recipes = sellableRecipes();
  const cats = ['ALL', ...new Set(recipes.map(posCategoryOf))].sort((a,b)=> a==='ALL'?-1:b==='ALL'?1:a.localeCompare(b));
  if(!cats.includes(posState.catFilter)) posState.catFilter = 'ALL';
  content.className = 'pos-layout';
  content.innerHTML = `
    <div class="pos-left">
      <div class="pos-search"><input type="text" id="pos-search" placeholder="🔍 Search products..." value="${escapeHtml(posState.searchTerm)}"></div>
      <div class="pos-cats" id="pos-cats">${cats.map(c=>`<button class="pos-cat-btn ${posState.catFilter===c?'active':''}" data-cat="${escapeHtml(c)}">${c==='ALL'?'All':escapeHtml(c)}</button>`).join('')}</div>
      <div class="pos-product-grid" id="pos-product-grid"></div>
    </div>
    <div class="pos-cart" id="pos-cart-panel"></div>`;
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

function renderProductGrid(){
  const grid = document.getElementById('pos-product-grid');
  if(!grid) return;
  let list = sellableRecipes();
  if(posState.catFilter!=='ALL') list = list.filter(r=> posCategoryOf(r)===posState.catFilter);
  if(posState.searchTerm) list = list.filter(r=> r.name.toLowerCase().includes(posState.searchTerm.toLowerCase()));
  list.sort((a,b)=> (Number(a.sort_order)||0)-(Number(b.sort_order)||0) || a.name.localeCompare(b.name));
  if(list.length===0){ grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;">No products found. Add sellable recipes (with a selling price) in Back Office → Recipes.</div>`; return; }
  grid.innerHTML = list.map(r=>{
    const avail = recipeAvailability(r);
    const sold = !!r.sold_out;
    const low = !sold && avail<=2;
    return `<div class="pos-product-card ${(sold||avail<=0)?'unavailable':''}" data-recipe="${r.id}">
      <div><div class="ptag">${escapeHtml(posCategoryOf(r))}</div><div class="pname">${escapeHtml(r.name)}</div></div>
      <div class="pprice">${fmtMoney(r.selling_price)}${sold?` <span class="stock-note">· sold out</span>`:(low?` <span class="stock-note">·${avail<=0?' out':' low'}</span>`:'')}</div>
    </div>`;
  }).join('');
  grid.querySelectorAll('[data-recipe]').forEach(card=> card.onclick = ()=> onProductTap(card.dataset.recipe));
}

async function onProductTap(recipeId){
  const recipe = state.recipes.find(r=>r.id===recipeId);
  if(!recipe) return;
  if(recipe.sold_out){
    const ok = await confirmDialog(`<b>${escapeHtml(recipe.name)}</b> is marked sold out. Add it anyway?`, 'Add anyway');
    if(!ok) return;
  }
  const groups = recipe.modifier_groups || [];
  if(groups.length===0){ addToCart(recipe, 1, []); return; }
  openModifierPicker(recipe);
}

/* ================= Modifier picker ================= */
function openModifierPicker(recipe, existingLine){
  const groups = recipe.modifier_groups || [];
  let selections = existingLine ? (existingLine.selections ? JSON.parse(JSON.stringify(existingLine.selections)) : []) : []; // [{group_id, option_id}]
  let qty = existingLine ? existingLine.quantity : 1;
  function currentPrice(){
    let p = Number(recipe.selling_price)||0;
    selections.forEach(sel=>{
      const g = groups.find(x=>x.id===sel.group_id); const o = g && (g.options||[]).find(x=>x.id===sel.option_id);
      if(o) p += Number(o.price_delta)||0;
    });
    return p;
  }
  const body = `
    <div style="text-align:center;margin-bottom:10px;"><b style="font-size:17px;">${escapeHtml(recipe.name)}</b></div>
    ${groups.map(g=>`
      <div class="mod-group" data-group="${g.id}">
        <div class="mod-group-title"><span>${escapeHtml(g.name)}${g.multi_select?' <span class="text-light" style="font-weight:500;">(pick any)</span>':''}</span>${g.required?'<span class="req">Required</span>':''}</div>
        <div class="mod-options">${(g.options||[]).map(o=>`<button class="mod-opt" data-group="${g.id}" data-opt="${o.id}">${escapeHtml(o.label)}${Number(o.price_delta)?` (${o.price_delta>0?'+':''}${fmtMoney(o.price_delta)})`:''}</button>`).join('')}</div>
      </div>`).join('')}
    <div class="form-row" style="margin-top:6px;"><label>Note (optional)</label><input id="mod-notes" maxlength="140" value="${escapeHtml(existingLine?existingLine.notes||'':'')}" placeholder="e.g. less ice"></div>
    <div class="qty-stepper">
      <button class="qbig" id="mod-qty-minus">−</button><span class="qval" id="mod-qty-val">${qty}</span><button class="qbig" id="mod-qty-plus">+</button>
    </div>
    <div style="text-align:center;font-family:var(--font-display);font-size:22px;font-weight:700;color:var(--espresso);" id="mod-total-price">${fmtMoney(currentPrice()*qty)}</div>`;
  const foot = `<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" id="mod-add">${existingLine?'Update Item':'Add to Order'}</button>`;
  openModal({title:'Customize', body, foot, onMount:(root)=>{
    root.querySelector('[data-cancel]').onclick = closeModal;
    function refreshUI(){
      root.querySelectorAll('.mod-opt').forEach(btn=>{
        btn.classList.toggle('selected', selections.some(s=>s.group_id===btn.dataset.group && s.option_id===btn.dataset.opt));
      });
      root.querySelector('#mod-qty-val').textContent = qty;
      root.querySelector('#mod-total-price').textContent = fmtMoney(currentPrice()*qty);
    }
    root.querySelectorAll('.mod-opt').forEach(btn=>{
      btn.onclick = ()=>{
        const gid = btn.dataset.group, oid = btn.dataset.opt;
        const group = groups.find(g=>g.id===gid);
        const already = selections.some(s=>s.group_id===gid && s.option_id===oid);
        if(group.multi_select){
          if(already) selections = selections.filter(s=>!(s.group_id===gid && s.option_id===oid));
          else selections.push({group_id:gid, option_id:oid});
        } else {
          selections = selections.filter(s=>s.group_id!==gid);
          if(!already) selections.push({group_id:gid, option_id:oid});
        }
        refreshUI();
      };
    });
    root.querySelector('#mod-qty-minus').onclick = ()=>{ qty = Math.max(1, qty-1); refreshUI(); };
    root.querySelector('#mod-qty-plus').onclick = ()=>{ qty = qty+1; refreshUI(); };
    refreshUI();
    root.querySelector('#mod-add').onclick = ()=>{
      const missing = groups.filter(g=>g.required && !selections.some(s=>s.group_id===g.id));
      if(missing.length){ toast(`Please choose: ${missing.map(g=>g.name).join(', ')}`, 'error'); return; }
      const modifiers = selections.map(s=>{
        const g = groups.find(x=>x.id===s.group_id); const o = g.options.find(x=>x.id===s.option_id);
        return {group:g.name, label:o.label, price_delta:Number(o.price_delta)||0, ingredient_id:o.ingredient_id||null, ingredient_qty_delta:Number(o.ingredient_qty_delta)||0};
      });
      const notes = root.querySelector('#mod-notes').value.trim();
      if(existingLine){
        Object.assign(existingLine, {quantity: qty, modifiers, selections, notes, unit_price: currentPrice()});
      } else {
        addToCart(recipe, qty, modifiers, selections, notes);
      }
      closeModal();
      renderCartPanel();
    };
  }});
}

/* ================= Cart ================= */
function addToCart(recipe, qty, modifiers, selections, notes){
  const unit_price = Number(recipe.selling_price||0) + modifiers.reduce((s,m)=>s+(Number(m.price_delta)||0),0);
  posState.cart.push({lineId: uid(), recipe_id: recipe.id, name: recipe.name, unit_price, quantity: qty, modifiers, selections: selections||[], notes: notes||''});
  renderCartPanel();
  toast(`Added ${recipe.name}`, 'success');
}
function cartLineTotal(line){ return line.unit_price * line.quantity; }
function currentCartTotals(){
  return computeSaleTotals(posState.cart.map(l=>({unit_price:l.unit_price, quantity:l.quantity})), posState.discount);
}
function clearCart(){
  posState.cart = []; posState.discount = null; posState.resumingHeldSaleId = null; posState.customer = null; posState.qrOrder = null;
}

function renderCartPanel(){
  const panel = document.getElementById('pos-cart-panel');
  if(!panel) return;
  const totals = currentCartTotals();
  const q = posState.qrOrder;
  panel.innerHTML = `
    <div class="pos-cart-head"><h3>${q?`QR ${escapeHtml(q.order_number)}`:'Current Order'}</h3>${posState.cart.length?`<button class="btn btn-ghost btn-sm" id="clear-cart">Clear</button>`:''}</div>
    ${q?`<div class="cart-qr-banner">📱 ${escapeHtml(q.table_label||'')} · ${escapeHtml(q.order_type==='TAKEAWAY'?'Takeaway':'Dine-in')}${q.customer_note?`<div class="text-light">“${escapeHtml(q.customer_note)}”</div>`:''}</div>`:''}
    <div class="cart-customer">${posState.customer
      ? `<span class="customer-chip">👤 ${escapeHtml(posState.customer.nickname)} <button class="linklike-btn" id="cust-remove" title="Remove customer">✕</button></span>`
      : `<button class="btn btn-ghost btn-sm" id="cust-add">👤 Add customer (loyalty)</button>`}</div>
    <div class="pos-cart-items" id="cart-items">
      ${posState.cart.length===0 ? `<div class="cart-empty">🧺<br>No items yet.<br>Tap a product to add it.</div>` :
      posState.cart.map(line=>`
        <div class="cart-line" data-line="${line.lineId}">
          <div class="cart-line-top">
            <div><div class="cart-line-name">${escapeHtml(line.name)}</div>
              ${line.modifiers.length?`<div class="cart-line-mods">${line.modifiers.map(m=>escapeHtml(m.label)).join(', ')}</div>`:''}
              ${line.notes?`<div class="cart-line-mods">“${escapeHtml(line.notes)}”</div>`:''}</div>
            <div class="cart-line-price">${fmtMoney(cartLineTotal(line))}</div>
          </div>
          <div class="cart-line-controls">
            <button class="qty-btn" data-dec="${line.lineId}">−</button><span>${line.quantity}</span><button class="qty-btn" data-inc="${line.lineId}">+</button>
            <button class="btn btn-ghost btn-sm" data-edit-line="${line.lineId}" style="margin-left:auto;">Edit</button>
            <button class="btn btn-ghost btn-sm" data-remove="${line.lineId}">✕</button>
          </div>
        </div>`).join('')}
    </div>
    <div class="pos-cart-summary">
      <div class="row"><span>Subtotal</span><span>${fmtMoney(totals.subtotal)}</span></div>
      <div class="row"><span>Discount ${posState.discount?`(${posState.discount.type==='percent'?posState.discount.value+'%':fmtMoney(posState.discount.value)})`:''}</span>
        <span>${totals.discountAmt>0?'-'+fmtMoney(totals.discountAmt):fmtMoney(0)} ${!posState.discount?`<a class="linklike" id="add-discount-link" style="font-size:11.5px;">add</a>`:`<a class="linklike" id="remove-discount-link" style="font-size:11.5px;">remove</a>`}</span></div>
      ${state.settings.tax_pct>0?`<div class="row"><span>Tax (${state.settings.tax_pct}%${state.settings.tax_inclusive?' incl.':''})</span><span>${fmtMoney(totals.tax)}</span></div>`:''}
      ${state.settings.service_charge_pct>0?`<div class="row"><span>Service Charge (${state.settings.service_charge_pct}%)</span><span>${fmtMoney(totals.serviceCharge)}</span></div>`:''}
      <div class="row total"><span>Total</span><span>${fmtMoney(totals.grandTotal)}</span></div>
    </div>
    <div class="pos-cart-foot">
      <button class="btn-hold" id="hold-order-btn" ${posState.cart.length===0||q?'disabled':''}>Hold</button>
      <button class="btn-checkout" id="checkout-btn" ${posState.cart.length===0?'disabled':''}>CHECKOUT / PAY</button>
    </div>`;
  panel.querySelectorAll('[data-inc]').forEach(b=> b.onclick = ()=>{ const l=posState.cart.find(x=>x.lineId===b.dataset.inc); l.quantity++; renderCartPanel(); });
  panel.querySelectorAll('[data-dec]').forEach(b=> b.onclick = ()=>{ const l=posState.cart.find(x=>x.lineId===b.dataset.dec); l.quantity--; if(l.quantity<=0) posState.cart=posState.cart.filter(x=>x.lineId!==l.lineId); renderCartPanel(); });
  panel.querySelectorAll('[data-remove]').forEach(b=> b.onclick = ()=>{ posState.cart = posState.cart.filter(x=>x.lineId!==b.dataset.remove); renderCartPanel(); });
  panel.querySelectorAll('[data-edit-line]').forEach(b=> b.onclick = ()=>{
    const line = posState.cart.find(x=>x.lineId===b.dataset.editLine);
    const recipe = state.recipes.find(r=>r.id===line.recipe_id);
    if(recipe && (recipe.modifier_groups||[]).length && line.selections) openModifierPicker(recipe, line);
    else editLineNote(line);
  });
  const clearBtn = document.getElementById('clear-cart');
  if(clearBtn) clearBtn.onclick = async ()=>{ const ok = await confirmDialog(q?'Close this QR order without taking payment? (It stays on the QR board.)':'Clear the current order?'); if(ok){ clearCart(); renderCartPanel(); } };
  const addDisc = document.getElementById('add-discount-link'); if(addDisc) addDisc.onclick = openDiscountPicker;
  const rmDisc = document.getElementById('remove-discount-link'); if(rmDisc) rmDisc.onclick = ()=>{ posState.discount=null; renderCartPanel(); };
  const custAdd = document.getElementById('cust-add'); if(custAdd) custAdd.onclick = openCustomerPicker;
  const custRm = document.getElementById('cust-remove'); if(custRm) custRm.onclick = ()=>{ posState.customer = null; renderCartPanel(); };
  const holdBtn = document.getElementById('hold-order-btn'); if(holdBtn) holdBtn.onclick = holdCurrentOrder;
  const checkoutBtn = document.getElementById('checkout-btn'); if(checkoutBtn) checkoutBtn.onclick = openCheckout;
}
function editLineNote(line){
  openModal({title:`Note — ${escapeHtml(line.name)}`, body:`<div class="form-row"><label>Note</label><input id="ln-note" maxlength="140" value="${escapeHtml(line.notes||'')}"></div>`,
    foot:`<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" id="ln-save">Save</button>`,
    onMount:(root)=>{ root.querySelector('[data-cancel]').onclick = closeModal; root.querySelector('#ln-save').onclick = ()=>{ line.notes = root.querySelector('#ln-note').value.trim(); closeModal(); renderCartPanel(); }; }});
}

async function openDiscountPicker(){
  const approver = await requireOverride('MANAGER');
  if(!approver) return;
  openModal({title:'Apply Discount', body:`
    <div class="form-row"><label>Type</label><select id="disc-type"><option value="percent">Percentage %</option><option value="fixed">Fixed Amount ₱</option></select></div>
    <div class="form-row"><label>Value</label><input type="number" step="any" id="disc-value" placeholder="e.g. 20 (Senior/PWD)"></div>
    <p class="hint">Approved by ${escapeHtml(approver.name)}.</p>`,
  foot:`<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" id="disc-apply">Apply</button>`,
  onMount:(root)=>{
    root.querySelector('[data-cancel]').onclick = closeModal;
    root.querySelector('#disc-apply').onclick = ()=>{
      const value = Number(root.querySelector('#disc-value').value)||0;
      if(value<=0){ toast('Enter a discount value','error'); return; }
      const type = root.querySelector('#disc-type').value;
      if(type==='percent' && value>100){ toast('A percentage discount cannot be over 100%','error'); return; }
      // approvalToken: the server checks it when this sale uploads (one approval = one sale).
      posState.discount = {type, value, appliedBy: approver.name, approvedById: approver.id, approvalToken: approver.token};
      closeModal(); renderCartPanel();
      queueAudit('Discount applied', `${value}${type==='percent'?'%':' fixed'} — approved by ${approver.name}`);
    };
  }});
}

/* ================= Customers (loyalty) ================= */
function openCustomerPicker(){
  if(!isOnline()){ toast('Finding customers needs the internet. You can still finish the sale without one.', 'warn'); return; }
  const SEARCH_HINT = 'Name, last 4 digits or full number';
  openModal({title:'Add customer', body:`
    <div class="form-row"><label for="cp-q">Find a customer</label><input id="cp-q" placeholder="${SEARCH_HINT}" autocomplete="off"></div>
    <div id="cp-results" class="cp-results"><p class="hint">${SEARCH_HINT}.</p></div>
    <details class="cp-new"><summary>+ New customer</summary>
      <div class="form-grid" style="margin-top:10px;">
        <div class="form-row"><label>Nickname</label><input id="cp-name" maxlength="30"></div>
        <div class="form-row"><label>Mobile (optional)</label><input id="cp-phone" inputmode="tel" placeholder="0917 123 4567"></div>
      </div>
      <p class="hint">Ask the customer first: “Can we save your name and number for your rewards?”</p>
      <label class="cp-consent" for="cp-consent"><input type="checkbox" id="cp-consent"> <span>The customer agreed to be added to our loyalty list</span></label>
      <button class="btn btn-primary btn-sm" id="cp-create">Save customer</button>
    </details>`,
  foot:`<button class="btn btn-outline" data-cancel>Close</button>`,
  onMount:(root)=>{
    root.querySelector('[data-cancel]').onclick = closeModal;
    const results = root.querySelector('#cp-results');
    const pick = (c)=>{ posState.customer = {id:c.id, nickname:c.nickname}; closeModal(); renderCartPanel(); toast(`${c.nickname} added to this sale`); };
    // Too many look-ups by phone number from this counter (the server limits them so
    // hidden digits can't be guessed): searching by name still works.
    const isLimited = (code)=> /TOO_MANY_ATTEMPTS/.test(String(code||''));
    let lastQ = '';
    const search = debounce(async (q)=>{
      lastQ = q;
      if(q.length<2){ results.innerHTML = `<p class="hint">${SEARCH_HINT}.</p>`; return; }
      results.innerHTML = '<p class="hint">Searching…</p>';
      try{
        const list = await cloud.rpc('search_customers', {p_q: q, p_limit: 15});
        if(q !== lastQ) return;                                 // a newer search is on its way
        if(!list || !list.length){ results.innerHTML = '<p class="hint">No match. Add them as a new customer below.</p>'; return; }
        // Phone numbers come from the server already masked (e.g. 0917 ••• 4567); shown as received.
        results.innerHTML = list.map(c=>`<button class="cp-row" data-id="${escapeHtml(c.id)}"><b>${escapeHtml(c.nickname)}</b><span class="text-light">${c.phone?escapeHtml(c.phone):'no phone'} · ${Number(c.visit_count)||0} visit${Number(c.visit_count)===1?'':'s'}</span></button>`).join('');
        results.querySelectorAll('[data-id]').forEach(b=> b.onclick = ()=> pick(list.find(c=>c.id===b.dataset.id)));
      }catch(e){
        if(q !== lastQ) return;
        const extra = e.offline ? ' Finding customers needs internet — you can still finish the sale without one.'
          : isLimited(e.message) ? ' You can still search by name.' : '';
        results.innerHTML = `<p class="hint">${escapeHtml(friendlyError(e) + extra)}</p>`;
      }
    }, 300);
    root.querySelector('#cp-q').oninput = (e)=> search(e.target.value.trim());
    root.querySelector('#cp-create').onclick = async (ev)=>{
      const btn = ev.currentTarget;
      const name = root.querySelector('#cp-name').value.trim();
      if(!name){ toast('Enter a nickname','error'); return; }
      // Required: the server also refuses without it (CONSENT_REQUIRED).
      const consent = root.querySelector('#cp-consent').checked;
      if(!consent){ toast('Tick the box once the customer agrees to be added to the loyalty list','error'); return; }
      btn.disabled = true;
      try{
        const r = await cloud.rpc('fo_add_customer', {p_nickname: name, p_phone: root.querySelector('#cp-phone').value.trim() || null, p_consent: true});
        if(r.error){
          toast(friendlyError(r) + (isLimited(r.error) ? ' Save them without a number for now, or try again later.' : ''), 'error');
          return;
        }
        if(r.existing) toast(`That number belongs to ${r.customer.nickname} — added them`, 'warn');
        pick(r.customer);
      }catch(e){
        toast(e.offline ? 'Saving a customer needs internet. You can still finish the sale without one.' : friendlyError(e), 'error');
      }finally{ btn.disabled = false; }
    };
    setTimeout(()=>root.querySelector('#cp-q').focus(), 50);
  }});
}

/* ================= Held orders ================= */
async function holdCurrentOrder(){
  if(posState.cart.length===0 || posState.qrOrder) return;
  const now = new Date().toISOString();
  const saleId = posState.resumingHeldSaleId || uid();
  const existing = state.sales.find(s=>s.id===saleId);
  const shift = activeShift();
  const sale = {
    id: saleId, transaction_number: (existing && existing.transaction_number) || nextTransactionNumber(), transaction_date: now,
    status:'HELD', cashier_id: posState.currentUser.id, cashier_name: posState.currentUser.name, shift_id: shift?shift.id:null,
    customer_id: posState.customer ? posState.customer.id : null, notes:'', source:'COUNTER',
    created_at: (existing && existing.created_at) || now, updated_at: now,
  };
  const items = posState.cart.map(line=>({id: uid(), sale_id: saleId, recipe_id: line.recipe_id, name: line.name, quantity: line.quantity,
    unit_price: line.unit_price, modifiers: line.modifiers, line_total: cartLineTotal(line), notes: line.notes||null, created_at: now}));
  await Sync.queue('sale', {sale, items, payment: null, inventory: []});
  toast('Order held — resume it anytime from Held');
  clearCart();
  navigatePOS('pos');
}
function showHeldOrders(){
  const held = state.sales.filter(s=>s.status==='HELD').sort((a,b)=> new Date(b.transaction_date)-new Date(a.transaction_date));
  openModal({title:'Held Orders', body: held.length? `<div class="grid grid-2">${held.map(s=>{
      const items = state.saleItems.filter(i=>i.sale_id===s.id);
      return `<div class="card"><b>${escapeHtml(s.transaction_number)}</b><div class="text-light" style="font-size:12px;">${fmtDateTime(s.transaction_date)} · ${escapeHtml(s.cashier_name||'')}</div>
      <div style="font-size:12.5px;margin-top:6px;">${items.map(i=>`${Number(i.quantity)}× ${escapeHtml(i.name)}`).join(', ')||'—'}</div>
      <div style="display:flex;gap:8px;margin-top:10px;"><button class="btn btn-sm btn-primary" data-resume="${s.id}">Resume</button><button class="btn btn-sm btn-danger" data-cancel-hold="${s.id}">Cancel</button></div></div>`;
    }).join('')}</div>` : `<p>No held orders.</p>`,
    foot:`<button class="btn btn-outline" data-close>Close</button>`,
    onMount:(root)=>{
      root.querySelector('[data-close]').onclick = closeModal;
      root.querySelectorAll('[data-resume]').forEach(b=> b.onclick = ()=>{
        const saleId = b.dataset.resume;
        const s = state.sales.find(x=>x.id===saleId);
        posState.cart = state.saleItems.filter(i=>i.sale_id===saleId).map(it=>({lineId: uid(), recipe_id: it.recipe_id, name: it.name,
          unit_price: Number(it.unit_price), quantity: Number(it.quantity), modifiers: it.modifiers||[], notes: it.notes||''}));
        posState.resumingHeldSaleId = saleId;
        posState.customer = s && s.customer_id ? {id: s.customer_id, nickname: 'Customer'} : null;
        closeModal(); navigatePOS('pos');
      });
      root.querySelectorAll('[data-cancel-hold]').forEach(b=> b.onclick = async ()=>{
        const ok = await confirmDialog('Cancel this held order? It will be removed.');
        if(!ok){ showHeldOrders(); return; }
        await Sync.queue('held_delete', {id: b.dataset.cancelHold});
        if(posState.resumingHeldSaleId===b.dataset.cancelHold) clearCart();
        showHeldOrders();
        if(posState.route==='pos') renderPOSScreen();
      });
    }});
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
    <div class="pay-methods five" id="pay-methods">
      ${PAYMENT_METHODS.map((m,i)=>`<button class="pay-method-btn ${i===0?'selected':''}" data-method="${m.id}">${m.ic}<br>${m.label}</button>`).join('')}
    </div>
    <div id="pay-detail"></div>`;
  const foot = `<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" id="complete-sale-btn">Complete Sale</button>`;
  openModal({title:'Checkout', body, foot, onMount:(root)=>{
    root.querySelector('[data-cancel]').onclick = closeModal;
    const detailWrap = root.querySelector('#pay-detail');
    function renderDetail(){
      if(method==='CASH'){
        const quick = [...new Set([totals.grandTotal, 100, 200, 500, 1000].filter(v=>v>=totals.grandTotal || v===totals.grandTotal))].slice(0,5);
        detailWrap.innerHTML = `
          <div class="form-row"><label>Cash Received</label><input type="number" step="any" inputmode="decimal" id="cash-tendered" placeholder="0.00"></div>
          <div class="quick-cash">${quick.map(v=>`<button data-quick="${v}">${v===totals.grandTotal?'Exact':fmtMoney(v)}</button>`).join('')}</div>
          <div class="change-display"><div class="lbl">Change</div><div class="val" id="change-val">₱0.00</div></div>`;
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
        setTimeout(()=>input.focus(), 50);
      } else {
        const label = PAYMENT_METHODS.find(m=>m.id===method).label;
        detailWrap.innerHTML = `
          <div class="form-row"><label>Reference # (optional)</label><input id="pay-ref" placeholder="e.g. ${label} reference number"></div>
          <label style="display:flex;gap:8px;align-items:flex-start;font-size:13.5px;margin-top:10px;">
            <input type="checkbox" id="pay-confirmed" style="margin-top:3px;width:16px;height:16px;">
            <span>I checked that this ${escapeHtml(label)} payment was actually received (in the app / SMS / terminal). This app cannot confirm electronic payments by itself.</span>
          </label>`;
      }
    }
    root.querySelectorAll('[data-method]').forEach(b=> b.onclick = ()=>{
      method = b.dataset.method;
      root.querySelectorAll('[data-method]').forEach(x=>x.classList.toggle('selected', x===b));
      renderDetail();
    });
    renderDetail();
    root.querySelector('#complete-sale-btn').onclick = async (ev)=>{
      if(method==='CASH'){
        if(tendered < totals.grandTotal){ toast('Cash received is less than the total due','error'); return; }
      } else {
        const box = detailWrap.querySelector('#pay-confirmed');
        if(!box || !box.checked){ toast('Please confirm the payment was actually received','error'); return; }
      }
      ev.currentTarget.disabled = true;
      // A QR order may have been paid on another counter while this cart was open.
      if(posState.qrOrder && await qrOrderPaidOnServer(posState.qrOrder)){
        const paidOrder = posState.qrOrder;
        closeModal(); clearCart(); navigatePOS('qr');
        await showQrAlreadyPaid(paidOrder);
        return;
      }
      const paymentInfo = {
        method, amount: totals.grandTotal,
        tendered: method==='CASH'? tendered : null,
        change: method==='CASH'? Math.max(0,tendered-totals.grandTotal) : null,
        reference: method!=='CASH' ? (detailWrap.querySelector('#pay-ref')?.value||'') : '',
      };
      const done = await completeSale(paymentInfo);
      closeModal();
      if(done) showReceipt(done.sale.id, {autoPrint:false, customerName: done.customerName});
    };
  }});
}

// Recomputes totals fresh from the cart + discount + settings (never trusts earlier UI numbers).
async function completeSale(paymentInfo){
  const now = new Date().toISOString();
  const totals = currentCartTotals();
  const saleId = posState.resumingHeldSaleId || uid();
  const existing = state.sales.find(s=>s.id===saleId);
  const shift = activeShift();
  const q = posState.qrOrder;
  const sale = {
    id: saleId,
    transaction_number: (existing && existing.transaction_number) || nextTransactionNumber(),
    transaction_date: now, status: 'COMPLETED',
    cashier_id: posState.currentUser.id, cashier_name: posState.currentUser.name,
    shift_id: shift ? shift.id : null,
    subtotal: totals.subtotal, discount_type: posState.discount ? posState.discount.type : null, discount_value: posState.discount ? posState.discount.value : 0,
    discount_amount: totals.discountAmt, tax_amount: totals.tax, service_charge_amount: totals.serviceCharge,
    grand_total: totals.grandTotal, notes: '',
    discount_approved_by: posState.discount ? posState.discount.approvedById : null,
    discount_approved_by_name: posState.discount ? posState.discount.appliedBy : null,
    source: q ? 'QR' : 'COUNTER', qr_order_id: q ? q.id : null,
    customer_id: posState.customer ? posState.customer.id : null,
    offline: !isOnline(),
    created_at: (existing && existing.created_at) || now, updated_at: now,
  };
  const items = posState.cart.map(line=>({
    id: uid(), sale_id: saleId, recipe_id: line.recipe_id, name: line.name, quantity: line.quantity,
    unit_price: line.unit_price, modifiers: line.modifiers, line_total: cartLineTotal(line), notes: line.notes||null, created_at: now,
  }));
  const payment = {id: uid(), sale_id: saleId, method: paymentInfo.method, amount: paymentInfo.amount, tendered: paymentInfo.tendered,
    change: paymentInfo.change, reference: paymentInfo.reference, status: 'CONFIRMED', created_at: now};
  // Inventory deduction — same recipe traversal as the original app (incl. modifier stock).
  const inventory = [];
  posState.cart.forEach(line=>{
    inventoryLinesForSaleLine(line.recipe_id, line.quantity, line.modifiers).forEach(l=>{
      inventory.push({id: uid(), ingredient_id: l.ingredient_id, transaction_type: 'SALE_USAGE', quantity: l.quantity, reference_id: saleId,
        transaction_date: todayISO(), notes: l.kind==='modifier' ? `Modifier "${l.label}" — ${sale.transaction_number}` : `Sold: ${sale.transaction_number}`, created_at: now});
    });
  });
  const saleOp = {sale, items, payment, inventory};
  if(posState.discount) saleOp.discount_approval_token = posState.discount.approvalToken || null;
  await Sync.queue('sale', saleOp);
  queueAudit('Sale completed', `${sale.transaction_number} — ${fmtMoney(sale.grand_total)} (${paymentInfo.method})${q?' · QR '+q.order_number:''}`, saleId);
  const customerName = posState.customer ? posState.customer.nickname : null;
  clearCart();
  navigatePOS(q ? 'qr' : 'pos');
  toast(`Sale ${sale.transaction_number} completed`, 'success');
  return {sale, customerName, qrOrder: q};
}

/* ================= Receipt ================= */
function showReceipt(saleId, opts, dataset){
  dataset = dataset || state;
  const sale = dataset.sales.find(s=>s.id===saleId);
  if(!sale){ toast('Sale not found on this counter', 'error'); return; }
  const items = dataset.saleItems.filter(i=>i.sale_id===saleId);
  const payments = dataset.payments.filter(p=>p.sale_id===saleId);
  const qr = sale.qr_order_id ? state.qrOrders.find(o=>o.id===sale.qr_order_id) : null;
  const customerName = (opts && opts.customerName) || (qr ? qr.customer_nickname : null);
  openPrintWindow(receiptHtml(sale, items, payments, {qrOrder: qr, customerName}), opts && opts.autoPrint);
}

/* =====================================================================
   QR ORDERS BOARD
   ===================================================================== */
function renderQrBoard(){
  const content = document.getElementById('content');
  if(posState.route!=='qr') return;
  const scrollTop = content.scrollTop;
  const cols = [
    {status:'PENDING', title:'New', hint:'Accept or reject'},
    {status:'PREPARING', title:'Preparing', hint:'Mark ready when done'},
    {status:'READY', title:'Ready', hint:'Hand over / serve'},
  ];
  const doneToday = state.qrOrders.filter(o=>['COMPLETED','REJECTED','CANCELLED'].includes(o.status))
    .sort((a,b)=> new Date(b.updated_at)-new Date(a.updated_at)).slice(0,20);
  document.getElementById('topbar-actions').innerHTML = `
    <label class="inline-check"><input type="checkbox" id="qr-auto-ticket" ${localStorage.getItem('cccc.qr.autoTicket')==='1'?'checked':''}> Print ticket on accept</label>
    <button class="btn btn-outline" id="qr-refresh">↻ Refresh</button>
    <button class="btn btn-outline" id="qr-soldout">🚫 Sold-out items</button>`;
  document.getElementById('qr-auto-ticket').onchange = (e)=>{ try{ localStorage.setItem('cccc.qr.autoTicket', e.target.checked?'1':'0'); }catch(err){} };
  document.getElementById('qr-refresh').onclick = ()=>{ pollQrOrders(); toast('Checking for new orders…'); };
  document.getElementById('qr-soldout').onclick = openSoldOutManager;
  const offline = !isOnline();
  content.innerHTML = `
    ${offline?`<div class="notice warn">Offline: new QR orders can't arrive and statuses can't change until the internet is back.</div>`:''}
    ${!state.settings.qr_ordering_enabled?`<div class="notice warn">QR ordering is switched OFF in Back Office → Settings → QR Ordering.</div>`:''}
    <div class="qr-board">
      ${cols.map(c=>{
        const list = state.qrOrders.filter(o=>o.status===c.status).sort((a,b)=> new Date(a.created_at)-new Date(b.created_at));
        return `<div class="qr-col"><div class="qr-col-head"><b>${c.title}</b> <span class="badge badge-gray">${list.length}</span><span class="text-light" style="font-size:11.5px;margin-left:auto;">${c.hint}</span></div>
          <div class="qr-col-body">${list.length ? list.map(qrCard).join('') : `<div class="qr-empty">Nothing here</div>`}</div></div>`;
      }).join('')}
    </div>
    <div class="section-title">Finished in the last few hours</div>
    ${doneToday.length?`<div class="table-wrap"><table><thead><tr><th>Order</th><th>Table</th><th>Customer</th><th>Status</th><th>Total</th><th>Updated</th></tr></thead><tbody>
      ${doneToday.map(o=>`<tr><td><b>${escapeHtml(o.order_number)}</b></td><td>${escapeHtml(o.table_label||'')}</td><td>${escapeHtml(o.customer_nickname||'')}</td>
        <td>${qrStatusBadge(o)}</td><td>${fmtMoney(o.total)}</td><td>${fmtTime(o.updated_at)}</td></tr>`).join('')}</tbody></table></div>` : emptyBlock('No finished QR orders yet.')}`;
  content.scrollTop = scrollTop;
  content.querySelectorAll('[data-qr-act]').forEach(b=> b.onclick = ()=> qrAction(b.dataset.id, b.dataset.qrAct));
  updateQrBadge();
}
function qrStatusBadge(o){
  const map = {PENDING:'badge-yellow', PREPARING:'badge-gray', READY:'badge-green', COMPLETED:'badge-green', REJECTED:'badge-red', CANCELLED:'badge-red'};
  return `<span class="badge ${map[o.status]||'badge-gray'}">${o.status.charAt(0)+o.status.slice(1).toLowerCase()}</span>`;
}
function qrCard(o){
  const paid = !!o.paid_at;
  const offline = !isOnline();
  const dis = offline ? 'disabled' : '';
  const btns = [];
  if(o.status==='PENDING'){
    btns.push(`<button class="btn btn-sm btn-primary" data-qr-act="ACCEPT" data-id="${o.id}" ${dis}>Accept</button>`);
    if(!paid) btns.push(`<button class="btn btn-sm btn-amber" data-qr-act="PAY" data-id="${o.id}">Take payment</button>`);
    btns.push(`<button class="btn btn-sm btn-danger" data-qr-act="REJECT" data-id="${o.id}" ${dis}>Reject</button>`);
  } else if(o.status==='PREPARING'){
    btns.push(`<button class="btn btn-sm btn-primary" data-qr-act="READY" data-id="${o.id}" ${dis}>Ready</button>`);
    if(!paid) btns.push(`<button class="btn btn-sm btn-amber" data-qr-act="PAY" data-id="${o.id}">Take payment</button>`);
  } else if(o.status==='READY'){
    if(!paid) btns.push(`<button class="btn btn-sm btn-amber" data-qr-act="PAY" data-id="${o.id}">Take payment</button>`);
    btns.push(`<button class="btn btn-sm btn-primary" data-qr-act="COMPLETE" data-id="${o.id}" ${dis||(!paid?'disabled':'')}>Served / picked up</button>`);
  }
  btns.push(`<button class="btn btn-sm btn-ghost" data-qr-act="TICKET" data-id="${o.id}">🖨 Ticket</button>`);
  return `<div class="qr-card ${o.status==='PENDING'?'is-new':''}">
    <div class="qr-card-top"><span class="qr-no">${escapeHtml(o.order_number)}</span>
      <span class="qr-table">${escapeHtml(o.table_label||'')}${o.order_type==='TAKEAWAY'?' · Takeaway':''}</span>
      ${paid?'<span class="badge badge-green">PAID</span>':'<span class="badge badge-yellow">Unpaid</span>'}</div>
    <div class="qr-cust">👤 ${escapeHtml(o.customer_nickname||'Guest')} · <span class="text-light">${timeAgo(o.created_at)}</span></div>
    <ul class="qr-items">${(o.items||[]).map(it=>`<li><b>${Number(it.quantity)}×</b> ${escapeHtml(it.name)}
      ${(it.modifiers||[]).length?`<div class="text-light">${it.modifiers.map(m=>escapeHtml(m.label)).join(', ')}</div>`:''}
      ${it.notes?`<div class="qr-note">“${escapeHtml(it.notes)}”</div>`:''}</li>`).join('')}</ul>
    ${o.customer_note?`<div class="qr-note">Note: “${escapeHtml(o.customer_note)}”</div>`:''}
    <div class="qr-total">${fmtMoney(o.total)}</div>
    <div class="qr-actions">${btns.join('')}</div>
  </div>`;
}
/* ---- A QR order is paid ONCE ----
   Online, the order is checked on the server before payment is taken. If the check can't be
   made (offline), the server decides when the sale uploads: it refuses a second payment with
   QR_ORDER_ALREADY_PAID and onQrOrderAlreadyPaid() tells the cashier plainly. */
async function qrOrderPaidOnServer(o){
  if(!isOnline() || !cloud.session) return false;
  try{
    const rows = await cloud.select('qr_orders', {eq: {id: o.id}}, {timeout: 4000});
    const fresh = rows && rows[0];
    if(!fresh) return false;
    mergeQrOrder(fresh);
    return !!(fresh.paid_at || fresh.sale_id);
  }catch(e){ return false; }
}
// A dialog with one button, for things the cashier must read. `title` is plain text.
function noticeDialog(title, bodyHtml, okLabel){
  return new Promise(resolve=>{
    let done = false;
    openModal({title: escapeHtml(title), body: bodyHtml, foot: `<button class="btn btn-primary btn-big" data-ok>${escapeHtml(okLabel || 'OK')}</button>`,
      onClose: ()=>{ if(!done){ done = true; resolve(); } },
      onMount:(root)=>{ root.querySelector('[data-ok]').onclick = ()=>{ done = true; closeModal(); resolve(); }; }});
  });
}
function showQrAlreadyPaid(o){
  return noticeDialog('This order is already paid',
    `<p><b>QR order ${escapeHtml(o.order_number)} was already paid</b> (on another counter, or in Back Office).</p>
     <p><b>Do not charge the customer again.</b> Just prepare and serve the order.</p>`, 'OK, I will not charge again');
}
// The server refused a QR sale that this counter took money for, because the order was already
// paid elsewhere (typically two counters taking payment while one was offline). The sale was NOT
// recorded, so the customer may have paid twice: say so clearly and keep the notice until read.
async function onQrOrderAlreadyPaid(op){
  const d = op.data || {}, sale = d.sale || {};
  const q = state.qrOrders.find(o=>o.id===sale.qr_order_id);
  const no = q ? q.order_number : 'a QR order';
  // Not on the server, so not in this counter's figures either (a restart would not show it).
  const hadIt = state.sales.some(s=>s.id===sale.id);               // (a retry of an earlier refusal no longer has it)
  state.sales = state.sales.filter(s=>s.id!==sale.id);
  state.saleItems = state.saleItems.filter(i=>i.sale_id!==sale.id);
  state.payments = state.payments.filter(p=>p.sale_id!==sale.id);
  if(hadIt) applyStockDeltas((d.inventory || []).map(t=>Object.assign({transaction_type:'SALE_REVERSAL'}, t)));
  if(q && q.sale_id === sale.id){ q.sale_id = null; q.paid_at = null; }
  try{
    const rows = await cloud.select('qr_orders', {eq: {id: sale.qr_order_id}}, {timeout: 4000});
    if(rows && rows[0]) mergeQrOrder(rows[0]);
  }catch(e){}
  const title = `QR order ${no} was already paid.`;
  const text = `This counter's payment of ${fmtMoney(sale.grand_total)} (${sale.transaction_number || 'sale'}) was NOT recorded, because the order had already been paid on another counter. Do not charge the customer again. If you took money from them here, give it back.`;
  await addAlert({id: op.op_id, title, text});
  toast(title + ' Do not charge again.', 'error');
  if(!document.getElementById('active-modal-overlay') && document.getElementById('pin-gate').style.display === 'none'){
    noticeDialog(title, `<p>${escapeHtml(text)}</p>`, 'OK, I understand');
  }
  if(posState.route === 'qr') renderQrBoard(); else if(posState.route === 'shift') renderShiftScreen({local: true}); else if(posState.route === 'sales') renderSalesScreen();
  saveSnapshotSoon();
}
async function qrAction(orderId, action){
  const o = state.qrOrders.find(x=>x.id===orderId);
  if(!o) return;
  if(action==='TICKET'){ printKitchenTicket(o); return; }
  if(action==='PAY'){
    if(!activeShift()){ toast('Start a shift first (Sell screen).', 'error'); navigatePOS('pos'); return; }
    // Online: make sure another counter hasn't taken payment for this order already.
    if(await qrOrderPaidOnServer(o)){ renderQrBoard(); await showQrAlreadyPaid(o); return; }
    if(posState.cart.length && !posState.qrOrder){
      const ok = await confirmDialog('The current cart has items. Hold it first, or replace it with this QR order?', 'Replace cart');
      if(!ok) return;
    }
    clearCart();
    posState.cart = (o.items||[]).map(it=>({lineId: uid(), recipe_id: it.recipe_id, name: it.name, unit_price: Number(it.unit_price),
      quantity: Number(it.quantity), modifiers: it.modifiers||[], notes: it.notes||''}));
    posState.qrOrder = o;
    posState.customer = o.customer_id ? {id: o.customer_id, nickname: o.customer_nickname} : null;
    navigatePOS('pos');
    return;
  }
  let reason = null;
  if(action==='REJECT'){
    reason = await new Promise(resolve=>{
      let done = false;
      openModal({title:`Reject ${escapeHtml(o.order_number)}?`, body:`<div class="form-row"><label>Reason (the customer sees this)</label>
        <select id="rj-reason"><option>Sorry, an item is sold out</option><option>Sorry, we're about to close</option><option>Please order at the counter</option><option>Other</option></select></div>
        <div class="form-row"><input id="rj-other" placeholder="Other reason (optional)"></div>`,
        foot:`<button class="btn btn-outline" data-cancel>Back</button><button class="btn btn-danger" id="rj-ok">Reject order</button>`,
        onClose:()=>{ if(!done) resolve(null); },
        onMount:(root)=>{
          root.querySelector('[data-cancel]').onclick = ()=>{ done=true; closeModal(); resolve(null); };
          root.querySelector('#rj-ok').onclick = ()=>{ done=true; const other = root.querySelector('#rj-other').value.trim(); const sel = root.querySelector('#rj-reason').value; closeModal(); resolve(other || sel); };
        }});
    });
    if(reason===null) return;
  }
  try{
    const r = await cloud.rpc('qr_update_order', {p_order_id: orderId, p_action: action, p_staff_name: posState.currentUser ? posState.currentUser.name : null, p_reason: reason});
    if(r.order) mergeQrOrder(r.order);
    if(r.error) toast(friendlyError({message:r.error}), r.error==='BAD_STATE'?'warn':'error');
    else {
      const verb = {ACCEPT:'accepted', READY:'marked ready', COMPLETE:'completed', REJECT:'rejected'}[action];
      toast(`${o.order_number} ${verb}`);
      queueAudit('QR order '+verb, `${o.order_number} · ${o.table_label||''}${reason?' — '+reason:''}`, orderId);
      if(action==='ACCEPT' && document.getElementById('qr-auto-ticket')?.checked) printKitchenTicket(r.order);
    }
  }catch(e){ toast(friendlyError(e), 'error'); }
  renderQrBoard();
}
function printKitchenTicket(o){
  openPrintWindow(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(o.order_number)}</title>
    <style>body{font-family:'Courier New',monospace;width:280px;margin:16px auto;font-size:14px;} h1{font-size:26px;margin:0;} .big{font-size:16px;font-weight:700;} hr{border:none;border-top:1px dashed #888;} .mod{padding-left:14px;font-size:12.5px;} @media print{body{width:72mm;margin:0;}}</style></head><body>
    <h1>${escapeHtml(o.order_number)}</h1>
    <div class="big">${escapeHtml(o.table_label||'')} · ${o.order_type==='TAKEAWAY'?'TAKEAWAY':'DINE-IN'}</div>
    <div>${escapeHtml(o.customer_nickname||'')} · ${fmtTime(o.created_at)} ${o.paid_at?'· PAID':''}</div><hr>
    ${(o.items||[]).map(it=>`<div class="big">${Number(it.quantity)} × ${escapeHtml(it.name)}</div>${(it.modifiers||[]).map(m=>`<div class="mod">- ${escapeHtml(m.label)}</div>`).join('')}${it.notes?`<div class="mod">“${escapeHtml(it.notes)}”</div>`:''}`).join('')}
    ${o.customer_note?`<hr><div>Note: ${escapeHtml(o.customer_note)}</div>`:''}
    </body></html>`, true);
}
function openSoldOutManager(){
  const list = sellableRecipes().sort((a,b)=>a.name.localeCompare(b.name));
  openModal({title:'Sold-out items', body:`<p class="hint" style="margin-top:0;">Sold-out items show as unavailable on the QR menu and on this counter. Turn them back on when restocked.</p>
    ${list.map(r=>`<div class="toggle-row"><span>${escapeHtml(r.name)} <span class="text-light" style="font-size:12px;">${escapeHtml(posCategoryOf(r))}</span></span>
      <label class="switch"><input type="checkbox" data-sold="${r.id}" ${r.sold_out?'checked':''}><span class="slider-tog"></span></label></div>`).join('')}`,
    foot:`<button class="btn btn-primary" data-close>Done</button>`,
    onMount:(root)=>{
      root.querySelector('[data-close]').onclick = closeModal;
      root.querySelectorAll('[data-sold]').forEach(cb=> cb.onchange = async ()=>{
        await Sync.queue('sold_out', {recipe_id: cb.dataset.sold, sold_out: cb.checked});
        const r = state.recipes.find(x=>x.id===cb.dataset.sold);
        queueAudit(cb.checked?'Marked sold out':'Back in stock', r ? r.name : '');
        toast(`${r?r.name:'Item'} ${cb.checked?'marked sold out':'available again'}`);
      });
    }});
}

/* =====================================================================
   SHIFT & CASH
   ===================================================================== */
function renderStartShiftGate(){
  const content = document.getElementById('content');
  content.className = '';
  content.innerHTML = `
    <div style="max-width:420px;margin:50px auto;text-align:center;">
      <div style="font-size:44px;margin-bottom:6px;">🕐</div>
      <h2 style="font-family:var(--font-display);font-size:22px;margin-bottom:6px;">No Active Shift</h2>
      <p class="text-light" style="margin-bottom:20px;">Every sale belongs to a shift so the cash drawer can be balanced at the end. Count the drawer and start one.</p>
      <div class="card" style="text-align:left;">
        <div class="form-row"><label>Cashier</label><input value="${escapeHtml(posState.currentUser.name)}" disabled></div>
        <div class="form-row"><label>Opening Cash (in the drawer now)</label><input type="number" step="any" inputmode="decimal" id="ss-opening-cash" placeholder="e.g. 2000"></div>
        <div class="form-row"><label>Notes (optional)</label><input id="ss-notes" placeholder="e.g. Morning shift"></div>
        <button class="btn btn-primary" id="ss-start-btn" style="width:100%;margin-top:6px;justify-content:center;">Start Shift</button>
      </div>
    </div>`;
  document.getElementById('ss-start-btn').onclick = async ()=>{
    const raw = document.getElementById('ss-opening-cash').value;
    const openingCash = Number(raw);
    if(raw==='' || !(openingCash >= 0)){ toast('Enter the opening cash (0 or more)', 'error'); return; }
    const now = new Date().toISOString();
    const shift = {
      id: uid(), shift_number: nextShiftNumber(), cashier_id: posState.currentUser.id, cashier_name: posState.currentUser.name,
      opened_at: now, opening_cash: openingCash, notes: document.getElementById('ss-notes').value, status: 'ACTIVE',
      device_id: state.device.id, created_at: now, updated_at: now,
    };
    await Sync.queue('shift_open', shift);
    queueAudit('Shift opened', `${shift.shift_number} — opening cash ${fmtMoney(openingCash)}`, shift.id);
    toast(`Shift ${shift.shift_number} started`);
    navigatePOS('pos');
  };
}

async function renderShiftScreen(opts){
  const content = document.getElementById('content');
  if(!activeShift()){ renderStartShiftGate(); return; }
  if(!(opts && opts.local)){
    // Ask the server for the latest figures first (a refund made in Back Office, ...). Offline or
    // slow: carry on with what is on this counter and say so below.
    if(isOnline()){
      document.getElementById('topbar-actions').innerHTML = '';
      content.innerHTML = emptyBlock('Checking for the latest figures…');
    }
    posState.shiftCheckOk = await refreshOpenShift({timeout: SHIFT_CHECK_MS});
    if(posState.route !== 'shift') return;                          // moved to another screen meanwhile
  }
  const shift = activeShift();
  if(!shift){ renderStartShiftGate(); return; }
  const m = shiftMetrics(shift);
  const note = shiftFreshNote(posState.shiftCheckOk);
  document.getElementById('topbar-actions').innerHTML = `
    <button class="btn btn-outline" id="cash-mgmt-btn">💵 Pay In / Pay Out</button>
    <button class="btn btn-outline" id="xreport-btn">🖨 Print X-Report</button>
    <button class="btn btn-danger" id="close-shift-btn">Close Shift</button>`;
  document.getElementById('cash-mgmt-btn').onclick = openCashManagementModal;
  document.getElementById('xreport-btn').onclick = printXReport;
  document.getElementById('close-shift-btn').onclick = openCloseShiftFlow;
  content.innerHTML = `
    <div class="text-light" style="margin-bottom:14px;">${escapeHtml(shift.shift_number||'')} · ${escapeHtml(shift.cashier_name)} · opened ${fmtDateTime(shift.opened_at)} (${shiftDuration(shift)})</div>
    ${note?`<div class="notice warn">${escapeHtml(note)}</div>`:''}
    <div class="grid grid-4">
      ${statCard(SALES_LABELS.sales, fmtMoney(m.sales), escapeHtml(SALES_HINTS.sales))}${statCard(SALES_LABELS.refunds, fmtMoney(m.refunds), escapeHtml(SALES_HINTS.refunds))}
      ${statCard(SALES_LABELS.netSales, fmtMoney(m.netSales), escapeHtml(SALES_HINTS.netSales))}${statCard('Transactions', m.transactionCount, `${m.voidedCount} voided`)}
    </div>
    <div class="section-title">Payment Breakdown</div>
    <div class="grid grid-3">${statCard('Cash', fmtMoney(m.cashGross),'')}${statCard('Card', fmtMoney(m.cardGross),'')}${statCard('GCash / Maya / Other', fmtMoney(m.otherGross),'')}</div>
    <div class="section-title">Cash Drawer (live)</div>
    <div class="card drawer-card">
      <div class="drow"><span>Opening Cash</span><b>${fmtMoney(m.openingCash)}</b></div>
      <div class="drow"><span>Cash Sales (net of cash refunds)</span><b>${fmtMoney(m.netCashFromSales)}</b></div>
      <div class="drow"><span>Pay Ins (${m.payInCount})</span><b>+${fmtMoney(m.payIns)}</b></div>
      <div class="drow"><span>Pay Outs (${m.payOutCount})</span><b>-${fmtMoney(m.payOuts)}</b></div>
      <div class="drow total"><span><b>Expected Cash in Drawer</b></span><b>${fmtMoney(m.expectedCash)}</b></div>
    </div>
    ${m.cashMovements.length?`<div class="section-title">Pay Ins / Pay Outs</div><div class="table-wrap"><table><thead><tr><th>Time</th><th>Type</th><th>Amount</th><th>Reason</th><th>By</th></tr></thead><tbody>
      ${m.cashMovements.map(c=>`<tr><td>${fmtTime(c.at)}</td><td>${c.type==='PAY_IN'?'Pay In':'Pay Out'}</td><td>${fmtMoney(c.amount)}</td><td>${escapeHtml(c.reason)}</td><td>${escapeHtml(c.performed_by_name||'')}</td></tr>`).join('')}</tbody></table></div>`:''}`;
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
    <div class="form-row" style="margin-top:14px;"><label>Amount</label><input type="number" step="any" inputmode="decimal" id="cm-amount" placeholder="0.00"></div>
    <div class="form-row"><label>Reason</label><input id="cm-reason" placeholder="e.g. Change fund top-up / Bought ice"></div>`,
  foot:`<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" id="cm-save">Record</button>`,
  onMount:(root)=>{
    root.querySelector('[data-cancel]').onclick = closeModal;
    root.querySelectorAll('[data-mode]').forEach(b=> b.onclick = ()=>{ mode=b.dataset.mode; root.querySelectorAll('[data-mode]').forEach(x=>x.classList.toggle('selected', x===b)); });
    root.querySelector('#cm-save').onclick = async ()=>{
      const amount = Number(root.querySelector('#cm-amount').value);
      const reason = root.querySelector('#cm-reason').value.trim();
      if(!(amount > 0)){ toast('Enter an amount greater than 0', 'error'); return; }
      if(!reason){ toast('Enter a reason — it shows on the shift report', 'error'); return; }
      const now = new Date().toISOString();
      await Sync.queue('cash_movement', {id: uid(), shift_id: shift.id, type: mode, amount, reason, performed_by: posState.currentUser.id,
        performed_by_name: posState.currentUser.name, at: now, created_at: now});
      queueAudit(mode==='PAY_IN'?'Cash pay-in':'Cash pay-out', `${fmtMoney(amount)} — ${reason}`, shift.id);
      closeModal();
      toast(`${mode==='PAY_IN'?'Pay in':'Pay out'} recorded`);
      if(posState.route==='shift') renderShiftScreen({local: true});
    };
  }});
}

async function openCloseShiftFlow(){
  const first = activeShift();
  if(!first) return;
  // Closing your own shift needs nothing extra. Closing another cashier's shift needs a
  // manager approval (closer = the approving manager, with the token the server checks).
  // A signed-in manager approves with their own sign-in, also offline.
  let closer = posState.currentUser;
  if(first.cashier_id !== posState.currentUser.id){
    closer = await requireOverride('MANAGER');
    if(!closer) return;
  }
  const closeApprovalToken = closer.id !== first.cashier_id ? (closer.token || null) : null;
  // The drawer is counted against the LATEST figures: ask the server first (a refund the owner
  // made from this drawer in Back Office must not make a correct count look short).
  const btn = document.getElementById('close-shift-btn');
  if(btn){ btn.disabled = true; btn.textContent = 'Checking…'; }
  const checked = await refreshOpenShift({timeout: SHIFT_CHECK_MS});
  if(btn){ btn.disabled = false; btn.textContent = 'Close Shift'; }
  const shift = activeShift();
  if(!shift) return;
  showCloseShiftDialog(shift, closer, closeApprovalToken, checked, {});
}
function showCloseShiftDialog(shift, closer, closeApprovalToken, checked, preset){
  const m = shiftMetrics(shift);
  const note0 = shiftFreshNote(checked);
  let declared = NaN;
  const body = `
    ${note0?`<div class="notice warn">${escapeHtml(note0)}</div>`:''}
    <div class="grid grid-4">
      ${statCard(SALES_LABELS.sales, fmtMoney(m.sales),'')}${statCard(SALES_LABELS.refunds, fmtMoney(m.refunds),'')}
      ${statCard(SALES_LABELS.netSales, fmtMoney(m.netSales),'')}${statCard('Transactions', m.transactionCount, `${m.voidedCount} voided`)}
    </div>
    <div class="section-title" style="font-size:15px;">Cash Drawer</div>
    <div class="card drawer-card">
      <div class="drow"><span>Opening Cash</span><b>${fmtMoney(m.openingCash)}</b></div>
      <div class="drow"><span>Cash Sales (net of cash refunds)</span><b>${fmtMoney(m.netCashFromSales)}</b></div>
      <div class="drow"><span>Pay Ins (${m.payInCount})</span><b>+${fmtMoney(m.payIns)}</b></div>
      <div class="drow"><span>Pay Outs (${m.payOutCount})</span><b>-${fmtMoney(m.payOuts)}</b></div>
      <div class="drow total"><span><b>Expected Cash</b></span><b>${fmtMoney(m.expectedCash)}</b></div>
    </div>
    ${Sync.pending?`<div class="notice warn" style="margin-top:12px;">${Sync.pending} item(s) are still uploading. Closing is fine — they upload in order.</div>`:''}
    <div class="form-row" style="margin-top:14px;"><label>Declared Cash (counted)</label><input type="number" step="any" inputmode="decimal" id="cs-declared" placeholder="0.00"></div>
    <div class="change-display" id="cs-variance-display" style="display:none;"><div class="lbl" id="cs-variance-lbl">Variance</div><div class="val" id="cs-variance-val">₱0.00</div></div>
    <div class="form-row" id="cs-notes-row" style="margin-top:10px;display:none;"><label>Reason for variance (required)</label><input id="cs-notes"></div>`;
  openModal({title:`Close Shift ${escapeHtml(shift.shift_number||'')}`, wide:true, body,
    foot:`<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-danger" id="cs-confirm">Confirm Close Shift</button>`,
    onMount:(root)=>{
      root.querySelector('[data-cancel]').onclick = closeModal;
      const disp = root.querySelector('#cs-variance-display'), notesRow = root.querySelector('#cs-notes-row');
      const declaredInput = root.querySelector('#cs-declared');
      declaredInput.oninput = ()=>{
        declared = declaredInput.value==='' ? NaN : Number(declaredInput.value);
        if(isNaN(declared)){ disp.style.display='none'; notesRow.style.display='none'; return; }
        const variance = declared - m.expectedCash;
        disp.style.display='block';
        root.querySelector('#cs-variance-lbl').textContent = Math.abs(variance) < 0.005 ? 'Balanced' : (variance>0 ? 'Over' : 'Short');
        root.querySelector('#cs-variance-val').textContent = fmtMoney(Math.abs(variance));
        root.querySelector('#cs-variance-val').style.color = Math.abs(variance)<0.005 ? 'var(--green)' : 'var(--red)';
        notesRow.style.display = Math.abs(variance) > 20 ? 'block' : 'none';
      };
      if(preset && preset.declared !== undefined && !isNaN(preset.declared)){      // coming back after the figures changed
        declaredInput.value = String(preset.declared); declaredInput.oninput();
        root.querySelector('#cs-notes').value = preset.note || '';
      }
      root.querySelector('#cs-confirm').onclick = async (ev)=>{
        const confirmBtn = ev.currentTarget;
        if(confirmBtn.disabled) return;
        if(isNaN(declared)){ toast('Enter the counted cash', 'error'); return; }
        const note = root.querySelector('#cs-notes').value.trim();
        if(Math.abs(declared - m.expectedCash) > 20 && !note){ toast('Please enter a reason for this variance', 'error'); return; }
        // One last look at the server: if something changed while the drawer was being counted
        // (e.g. the owner refunded from this drawer), show the new figures instead of saving a wrong variance.
        confirmBtn.disabled = true; confirmBtn.textContent = 'Checking…';
        const stillChecked = await refreshOpenShift({timeout: SHIFT_CHECK_MS});
        const current = activeShift();
        if(!current){ closeModal(); return; }
        const m2 = shiftMetrics(current);
        if(Math.abs(m2.expectedCash - m.expectedCash) >= 0.005 || Math.abs(m2.netSales - m.netSales) >= 0.005){
          closeModal();
          showCloseShiftDialog(current, closer, closeApprovalToken, stillChecked, {declared, note});
          toast('The figures changed (for example a refund made in Back Office). They are updated below — check your count and confirm again.', 'warn');
          return;
        }
        const variance = declared - m.expectedCash;
        const now = new Date().toISOString();
        const closeOp = {
          id: shift.id, closed_at: now, declared_cash: declared, expected_cash: m.expectedCash, cash_variance: variance,
          gross_sales: m.grossSales, net_sales: m.netSales, cash_sales: m.cashGross, card_sales: m.cardGross, other_sales: m.otherGross,
          refunds_total: m.refundsOnly, voids_total: m.voidsOnly, transaction_count: m.transactionCount,
          notes: (shift.notes||'') + (note ? ' | Variance note: '+note : ''), closed_by: closer.id, closed_by_name: closer.name, updated_at: now,
        };
        if(closeApprovalToken) closeOp.approval_token = closeApprovalToken;
        await Sync.queue('shift_close', closeOp);
        queueAudit('Shift closed', `${shift.shift_number} — variance ${fmtMoney(variance)}`, shift.id);
        closeModal();
        toast('Shift closed');
        showShiftReport(shift.id);
      };
    }});
}
// The sales lines of a report, from the shared words: Item sales, Discounts, Tax & service,
// Sales, Refunds, Net sales (salesSummaryRows), then Voids and Transactions.
function shiftSalesLines(shift, m){
  const closed = shift.status === 'CLOSED';
  const rows = salesSummaryRows(m, shift).map(r=>({label: r.label, hint: r.hint, text: r.sign + fmtMoney(r.amount), total: r.total}));
  const voids = closed && shift.voids_total !== null && shift.voids_total !== undefined ? Number(shift.voids_total) : m.voids;
  const count = closed && shift.transaction_count !== null && shift.transaction_count !== undefined ? shift.transaction_count : m.transactionCount;
  rows.push({label: SALES_LABELS.voids, hint: SALES_HINTS.voids, text: fmtMoney(voids), total: false});
  rows.push({label: 'Transactions', hint: '', text: String(count), total: false});
  return rows;
}
function showShiftReport(shiftId){
  const shift = state.shifts.find(s=>s.id===shiftId);
  const m = shiftMetrics(shift);
  openModal({title:`Shift Report — ${escapeHtml(shift.shift_number||'')}`, wide:true, body:`
    <div style="font-size:13.5px;line-height:1.8;margin-bottom:14px;">
      <div>Cashier: <b>${escapeHtml(shift.cashier_name)}</b>${shift.closed_by_name && shift.closed_by_name!==shift.cashier_name?` · closed by <b>${escapeHtml(shift.closed_by_name)}</b>`:''}</div>
      <div>Opened: <b>${fmtDateTime(shift.opened_at)}</b> — Closed: <b>${fmtDateTime(shift.closed_at)}</b> (${shiftDuration(shift)})</div>
    </div>
    <div class="card drawer-card" id="sr-sales">
      ${shiftSalesLines(shift, m).map(r=>`<div class="drow ${r.total?'total':''}" ${r.hint?`title="${escapeHtml(r.hint)}"`:''}><span>${r.total?`<b>${escapeHtml(r.label)}</b>`:escapeHtml(r.label)}</span><b>${r.text}</b></div>`).join('')}
    </div>
    <div class="grid grid-3" style="margin-top:14px;">${statCard('Cash', fmtMoney(shift.cash_sales),'')}${statCard('Card', fmtMoney(shift.card_sales),'')}${statCard('Other', fmtMoney(shift.other_sales),'')}</div>
    <div class="card drawer-card" style="margin-top:14px;">
      <div class="drow"><span>Opening Cash</span><b>${fmtMoney(shift.opening_cash)}</b></div>
      <div class="drow"><span>Expected Cash</span><b>${fmtMoney(shift.expected_cash)}</b></div>
      <div class="drow"><span>Declared Cash</span><b>${fmtMoney(shift.declared_cash)}</b></div>
      <div class="drow total"><span><b>Variance</b></span><b style="color:${Math.abs(shift.cash_variance)<0.005?'var(--green)':'var(--red)'}">${shift.cash_variance>=0?'+':''}${fmtMoney(shift.cash_variance)}</b></div>
    </div>
    ${shift.notes?`<p class="hint" style="margin-top:10px;">${escapeHtml(shift.notes)}</p>`:''}`,
  foot:`<button class="btn btn-outline" id="sr-print">🖨 Print</button><button class="btn btn-primary" data-done>Done</button>`,
  onMount:(root)=>{
    root.querySelector('[data-done]').onclick = ()=>{ closeModal(); navigatePOS('pos'); };
    root.querySelector('#sr-print').onclick = ()=> printShiftReport(shift, m, false);
  }});
}
function shiftReportHtml(shift, m, isX){
  const closed = shift.status==='CLOSED';
  const v = (k, live)=> closed ? shift[k] : live;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${isX?'X':'Z'}-Report ${escapeHtml(shift.shift_number||'')}</title>
    <style>body{font-family:Georgia,serif;max-width:420px;margin:24px auto;color:#241209;font-size:13px;} .row{display:flex;justify-content:space-between;padding:3px 0;} hr{border:none;border-top:1px dashed #999;margin:10px 0;} h1{font-size:17px;}</style></head><body>
    <h1>${escapeHtml(businessName()||appDisplayName())} — ${isX?'X-Report (mid-shift)':'Shift Report'}</h1>
    <div>${escapeHtml(shift.shift_number||'')} · ${escapeHtml(shift.cashier_name)} · ${escapeHtml(state.device?state.device.device_name:'')}</div>
    <div>${fmtDateTime(shift.opened_at)} → ${closed?fmtDateTime(shift.closed_at):'now ('+fmtDateTime(new Date())+')'}</div><hr>
    ${shiftSalesLines(shift, m).map(r=>`<div class="row"><span>${escapeHtml(r.label)}</span><b>${r.text}</b></div>`).join('\n    ')}<hr>
    <div class="row"><span>Cash</span><b>${fmtMoney(v('cash_sales', m.cashGross))}</b></div>
    <div class="row"><span>Card</span><b>${fmtMoney(v('card_sales', m.cardGross))}</b></div>
    <div class="row"><span>GCash / Maya / Other</span><b>${fmtMoney(v('other_sales', m.otherGross))}</b></div><hr>
    <div class="row"><span>Opening Cash</span><b>${fmtMoney(shift.opening_cash)}</b></div>
    <div class="row"><span>Pay Ins / Outs</span><b>+${fmtMoney(m.payIns)} / -${fmtMoney(m.payOuts)}</b></div>
    <div class="row"><span>Expected Cash</span><b>${fmtMoney(v('expected_cash', m.expectedCash))}</b></div>
    ${closed?`<div class="row"><span>Declared Cash</span><b>${fmtMoney(shift.declared_cash)}</b></div>
    <div class="row" style="font-size:15px;"><span><b>Variance</b></span><b>${shift.cash_variance>=0?'+':''}${fmtMoney(shift.cash_variance)}</b></div>`:''}
    ${shift.notes?`<hr><div>${escapeHtml(shift.notes)}</div>`:''}
    </body></html>`;
}
function printShiftReport(shift, m, isX){
  openPrintWindow(shiftReportHtml(shift, m, isX), true);
}
// X-report: print the latest figures. The window is opened right away (a pop-up is only allowed
// straight after a tap) and filled in once the server has been asked, unless the figures were
// checked a moment ago (they are when this screen was just opened).
async function printXReport(){
  const shift = activeShift();
  if(!shift) return;
  if(!isOnline() || Date.now() - posState.shiftSyncedAt < 20000){
    printShiftReport(shift, shiftMetrics(shift), true);
    return;
  }
  const win = window.open('', '_blank');
  if(!win){ toast('Please allow pop-ups to view/print', 'error'); return; }
  try{ win.document.write('<p style="font-family:sans-serif;margin:24px;">Getting the latest figures…</p>'); }catch(e){}
  posState.shiftCheckOk = await refreshOpenShift({timeout: SHIFT_CHECK_MS});
  const current = activeShift() || shift;
  try{
    win.document.open(); win.document.write(shiftReportHtml(current, shiftMetrics(current), true)); win.document.close();
    win.focus(); setTimeout(()=>{ try{ win.print(); }catch(e){} }, 350);
  }catch(e){ console.warn('could not fill the X-report', e); }
  if(posState.route === 'shift') renderShiftScreen({local: true});
}

/* =====================================================================
   SALES (this shift + today across counters) & REFUNDS / VOIDS
   ===================================================================== */
function saleStatusBadge(status){
  const map = {COMPLETED:'badge-green', VOIDED:'badge-red', REFUNDED:'badge-red', PARTIALLY_REFUNDED:'badge-yellow', HELD:'badge-gray'};
  return `<span class="badge ${map[status]||'badge-gray'}">${String(status).replace(/_/g,' ')}</span>`;
}
let salesView = 'shift';
function salesDataset(){
  if(salesView==='today' && posState.todaySales) return posState.todaySales;
  return state;
}
async function renderSalesScreen(){
  const content = document.getElementById('content');
  document.getElementById('topbar-actions').innerHTML = `
    <div class="seg"><button class="seg-btn ${salesView==='shift'?'active':''}" data-view="shift">This shift</button><button class="seg-btn ${salesView==='today'?'active':''}" data-view="today">Today · all counters</button></div>`;
  document.querySelectorAll('[data-view]').forEach(b=> b.onclick = ()=>{ salesView = b.dataset.view; renderSalesScreen(); });
  if(salesView==='today'){
    if(!isOnline()){ content.innerHTML = emptyBlock('Needs internet. Showing this shift instead is available offline.'); return; }
    content.innerHTML = emptyBlock('Loading today\'s sales…');
    try{
      const from = new Date(); from.setHours(0,0,0,0);
      const to = new Date(from.getTime() + 24*3600*1000);
      const r = await cloud.rpc('sales_report', {p_from: from.toISOString(), p_to: to.toISOString()});
      posState.todaySales = {sales: r.sales||[], saleItems: r.sale_items||[], payments: r.payments||[], refunds: r.refunds||[], cashMovements: r.cash_movements||[]};
    }catch(e){ content.innerHTML = emptyBlock(escapeHtml(friendlyError(e))); return; }
  }
  const ds = salesDataset();
  const shift = activeShift();
  let list = ds.sales.filter(s=>s.status!=='HELD');
  if(salesView==='shift') list = list.filter(s=> shift && s.shift_id===shift.id);
  list.sort((a,b)=> new Date(b.transaction_date)-new Date(a.transaction_date));
  const total = list.filter(s=>s.status!=='VOIDED').reduce((s,x)=>s+Number(x.grand_total||0),0);
  content.innerHTML = `
    <div class="grid grid-3" style="margin-bottom:16px;">${statCard('Transactions', list.filter(s=>s.status!=='VOIDED').length, '')}${statCard('Total', fmtMoney(total), 'before refunds')}${statCard('QR orders paid', list.filter(s=>s.source==='QR'&&s.status!=='VOIDED').length, '')}</div>
    ${list.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Transaction #</th><th>Time</th><th>Cashier</th><th>Payment</th><th>Status</th><th>Total</th><th></th></tr></thead>
      <tbody>${list.map(s=>{
        const pay = ds.payments.find(p=>p.sale_id===s.id);
        return `<tr class="clickable" data-id="${s.id}"><td><b>${escapeHtml(s.transaction_number)}</b>${s.source==='QR'?' <span class="badge badge-gray">QR</span>':''}</td>
          <td>${fmtTime(s.transaction_date)}</td><td>${escapeHtml(s.cashier_name||'')}</td><td>${pay?escapeHtml(pay.method):'—'}</td>
          <td>${saleStatusBadge(s.status)}</td><td>${fmtMoney(s.grand_total)}</td>
          <td><button class="btn btn-sm btn-ghost" data-reprint="${s.id}">Reprint</button></td></tr>`;
      }).join('')}</tbody></table></div>` : emptyBlock(salesView==='shift' ? 'No sales in this shift yet.' : 'No sales today yet.')}`;
  content.querySelectorAll('tr[data-id]').forEach(tr=> tr.onclick = (e)=>{ if(e.target.closest('[data-reprint]')) return; navigatePOS('saleDetail', tr.dataset.id); });
  content.querySelectorAll('[data-reprint]').forEach(b=> b.onclick = (e)=>{ e.stopPropagation(); showReceipt(b.dataset.reprint, {autoPrint:true}, salesDataset()); });
}

function renderSaleDetail(saleId){
  const content = document.getElementById('content');
  const ds = (salesView==='today' && posState.todaySales && posState.todaySales.sales.some(s=>s.id===saleId)) ? posState.todaySales : state;
  const sale = ds.sales.find(s=>s.id===saleId);
  if(!sale){ content.innerHTML = emptyBlock('Transaction not found on this counter.'); return; }
  const items = ds.saleItems.filter(i=>i.sale_id===saleId);
  const pay = ds.payments.find(p=>p.sale_id===saleId) || {};
  const refunds = ds.refunds.filter(r=>r.sale_id===saleId);
  content.innerHTML = `
    <a class="linklike" id="back-sh" style="font-size:13px;">← Back to Sales</a>
    <div class="ingredient-detail-header" style="margin-top:10px;">
      <div><h2 style="font-family:var(--font-display);font-size:24px;">${escapeHtml(sale.transaction_number)}</h2>
        <div style="margin-top:6px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">${saleStatusBadge(sale.status)}<span class="tag-pill">${fmtDateTime(sale.transaction_date)}</span><span class="tag-pill">Cashier: ${escapeHtml(sale.cashier_name||'')}</span>${sale.source==='QR'?'<span class="tag-pill">QR order</span>':''}</div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button class="btn btn-outline" id="reprint-btn">🖨 Reprint</button>
        ${sale.status==='COMPLETED'?`<button class="btn btn-danger" id="void-btn">Void</button>`:''}
        ${sale.status==='COMPLETED' || sale.status==='PARTIALLY_REFUNDED'?`<button class="btn btn-amber" id="refund-btn">Refund</button>`:''}
      </div>
    </div>
    <div class="grid grid-4" style="margin-top:20px;">
      ${statCard('Total', fmtMoney(sale.grand_total),'')}${statCard('Payment', escapeHtml(pay.method||'—'), pay.reference?('Ref '+escapeHtml(pay.reference)):'')}
      ${statCard('Discount', Number(sale.discount_amount)>0?fmtMoney(sale.discount_amount):'—', sale.discount_approved_by_name?('by '+escapeHtml(sale.discount_approved_by_name)):'')}
      ${statCard('Tax + Service', fmtMoney((Number(sale.tax_amount)||0)+(Number(sale.service_charge_amount)||0)),'')}
    </div>
    <div class="section-title">Items</div>
    <div class="table-wrap"><table><thead><tr><th>Item</th><th>Qty</th><th>Unit Price</th><th>Total</th></tr></thead>
      <tbody>${items.map(it=>`<tr><td><b>${escapeHtml(it.name)}</b>${(it.modifiers||[]).length?`<div class="text-light" style="font-size:12px;">${it.modifiers.map(m=>escapeHtml(m.label)).join(', ')}</div>`:''}</td>
        <td>${Number(it.quantity)}</td><td>${fmtMoney(it.unit_price)}</td><td>${fmtMoney(it.line_total)}</td></tr>`).join('')}</tbody></table></div>
    ${refunds.length?`<div class="section-title">Refund / Void History</div><div class="table-wrap"><table><thead><tr><th>Date</th><th>Type</th><th>Amount</th><th>Reason</th><th>Approved By</th></tr></thead>
      <tbody>${refunds.map(r=>`<tr><td>${fmtDateTime(r.date)}</td><td>${r.type.replace(/_/g,' ')}</td><td>${fmtMoney(r.amount)}</td><td>${escapeHtml(r.reason||'—')}</td><td>${escapeHtml(r.approved_by_name||'')}</td></tr>`).join('')}</tbody></table></div>`:''}`;
  content.querySelector('#back-sh').onclick = ()=>navigatePOS('sales');
  content.querySelector('#reprint-btn').onclick = ()=>showReceipt(saleId, {autoPrint:true}, ds);
  if(sale.status==='COMPLETED') content.querySelector('#void-btn').onclick = ()=>openRefundVoidFlow(sale, items, 'VOID', ds);
  if(sale.status==='COMPLETED' || sale.status==='PARTIALLY_REFUNDED') content.querySelector('#refund-btn').onclick = ()=>openRefundVoidFlow(sale, items, 'REFUND', ds);
}

let refundCheckBusy = false;
async function openRefundVoidFlow(sale, items, kind, ds){
  if(refundCheckBusy) return;                                       // a second tap while the first is still checking
  const isVoid = kind==='VOID';
  const dataset = ds || state;
  // Refunds can also be made elsewhere (Back Office, another counter): ask the server for this
  // sale's refunds first, so "what is left" is right. Offline, the refunds known here are used.
  refundCheckBusy = true;
  let checked = false;
  try{ checked = await refreshSaleRefunds(sale, dataset); }finally{ refundCheckBusy = false; }
  let prior = refundPriorFor(sale.id, dataset.refunds);
  if(posState.route==='saleDetail' && posState.routeParam===sale.id) renderSaleDetail(sale.id);   // the status may have changed
  if(sale.status==='VOIDED' || sale.status==='REFUNDED' || refundLeft(sale, prior.amount) <= 0){
    toast('Nothing is left to refund on this sale.', 'warn'); return;
  }
  if(isVoid && (prior.amount > 0 || sale.status!=='COMPLETED')){
    toast('Part of this sale was already refunded, so it cannot be voided. Refund the items that are left instead.', 'warn'); return;
  }
  const approver = await requireOverride('MANAGER');
  if(!approver) return;
  const returned = (it)=> Math.max(0, Number(prior.quantities[it.id]) || 0);       // already given back on earlier refunds
  const canReturn = (it)=> Math.max(0, Number(it.quantity) - returned(it));
  const offlineNote = checked ? '' : `<p class="hint">${isOnline() ? 'Could not check the server just now' : 'No internet'}: refunds made somewhere else (for example in Back Office) are not counted here yet. The server checks the amount again when this uploads.</p>`;
  openModal({
    title: isVoid?'Void Transaction':'Refund Transaction', wide:true,
    body: isVoid ? `<p>This voids <b>${escapeHtml(sale.transaction_number)}</b> (${fmtMoney(sale.grand_total)}) and returns all items to inventory. The sale record is kept.</p>
      <div class="notice ok" id="rv-amount-box">Customer gets back: <b id="rv-amount">${fmtMoney(0)}</b></div>
      <div class="form-row"><label>Reason</label><input id="rv-reason" placeholder="e.g. Entered by mistake"></div>${offlineNote}`
      : `<p>Select items and quantities to refund from <b>${escapeHtml(sale.transaction_number)}</b>:</p>
      <table class="ri-table"><thead><tr><th>Item</th><th>Sold Qty</th><th>Already refunded</th><th>Refund Qty</th></tr></thead>
      <tbody>${items.map(it=>`<tr data-item="${escapeHtml(it.id)}"><td>${escapeHtml(it.name)}</td><td>${Number(it.quantity)}</td><td>${returned(it)}</td>
        <td><input type="number" min="0" max="${canReturn(it)}" value="0" class="rv-qty" style="width:70px;" ${canReturn(it)<=0?'disabled':''}></td></tr>`).join('')}</tbody></table>
      <div class="notice ok" id="rv-amount-box" style="margin-top:12px;">Customer gets back: <b id="rv-amount">${fmtMoney(0)}</b>
        <div class="text-light" style="font-size:12px;">What they paid for these items: their share of any discount, plus tax and service charge.</div></div>
      <div class="form-row" style="margin-top:12px;"><label>Reason</label><input id="rv-reason" placeholder="e.g. Customer changed order"></div>${offlineNote}`,
    foot: `<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-danger" id="rv-confirm">${isVoid?'Confirm Void':'Confirm Refund'}</button>`,
    onMount:(root)=>{
      root.querySelector('[data-cancel]').onclick = closeModal;
      // What is entered now, as lines for the shared refund maths: [{sale_item_id, quantity}].
      const entered = ()=>{
        if(isVoid) return items.map(it=>({sale_item_id: it.id, quantity: Number(it.quantity)}));
        const out = [];
        root.querySelectorAll('[data-item]').forEach(row=>{
          const qty = Number(row.querySelector('.rv-qty').value) || 0;
          if(qty > 0) out.push({sale_item_id: row.dataset.item, quantity: qty});
        });
        return out;
      };
      const showAmount = ()=>{ root.querySelector('#rv-amount').textContent = fmtMoney(refundAmountForItems(sale, items, entered(), prior)); };
      root.querySelectorAll('.rv-qty').forEach(i=> i.addEventListener('input', showAmount));
      showAmount();
      root.querySelector('#rv-confirm').onclick = async (ev)=>{
        const btn = ev.currentTarget;
        if(btn.disabled) return;
        const reason = root.querySelector('#rv-reason').value.trim();
        prior = refundPriorFor(sale.id, dataset.refunds);                      // as of now
        const lines = entered();
        if(!isVoid){
          const tooMany = items.some(it=>{
            const row = root.querySelector(`[data-item="${CSS.escape(it.id)}"]`);
            return row && (Number(row.querySelector('.rv-qty').value) || 0) > canReturn(it);
          });
          if(tooMany){ toast('Refund quantity cannot be more than what is left to refund','error'); return; }
          if(lines.length===0){ toast('Select at least one item to refund','error'); return; }
        }
        // The customer's amount: the shared maths (a void or refunding everything = what is left).
        const amount = refundAmountForItems(sale, items, lines, prior);
        const type = isVoid ? 'VOID' : (refundLeft(sale, prior.amount + amount) === 0 ? 'FULL_REFUND' : 'PARTIAL_REFUND');
        btn.disabled = true;
        const now = new Date().toISOString();
        const currentShift = activeShift();
        // Lines sent to the server: sale_item_id + quantity (the stock part also needs recipe + options).
        const refundItems = lines.map(l=>{
          const it = items.find(x=>x.id===l.sale_item_id);
          return {sale_item_id: l.sale_item_id, quantity: l.quantity, recipe_id: it.recipe_id, modifiers: it.modifiers||[]};
        });
        const refund = {id: uid(), sale_id: sale.id, shift_id: currentShift ? currentShift.id : null,
          type, amount, reason, items: refundItems,
          approved_by: approver.id, approved_by_name: approver.name,
          performed_by: posState.currentUser.id,        // who is doing it at the counter (the server needs it to accept a manager's own sign-in as the approval)
          date: now, notes:'', created_at: now};
        // Return stock for refunded quantities, incl. modifier extras (mirrors the sale).
        const inventory = [];
        refundItems.forEach(ri=>{
          inventoryLinesForSaleLine(ri.recipe_id, ri.quantity, ri.modifiers).forEach(l=>{
            inventory.push({id: uid(), ingredient_id: l.ingredient_id, transaction_type:'SALE_REVERSAL', quantity: l.quantity, reference_id: refund.id,
              transaction_date: todayISO(), notes: `${isVoid?'Void':'Refund'}${l.kind==='modifier'?' modifier "'+l.label+'"':''} of ${sale.transaction_number}`, created_at: now});
          });
        });
        // sale_status is only for this screen (the server works out the sale's status itself).
        const saleStatus = isVoid ? 'VOIDED' : (type==='FULL_REFUND' ? 'REFUNDED' : 'PARTIALLY_REFUNDED');
        // A sale from another shift / counter (the "Today" list) isn't in this counter's own data; the
        // drawer maths needs it (a refund of a cash sale takes cash out of this drawer).
        if(!state.sales.some(x=>x.id===sale.id)){
          state.sales.push(Object.assign({}, sale));
          state.payments = state.payments.concat(dataset.payments.filter(p=>p.sale_id===sale.id && !state.payments.some(x=>x.id===p.id)));
        }
        await Sync.queue('refund', {refund, inventory, sale_status: saleStatus, approval_token: approver.token || null});
        if(ds && ds!==state){ ds.refunds.push(refund); const s = ds.sales.find(x=>x.id===sale.id); if(s) s.status = saleStatus; }
        queueAudit(isVoid?'Sale voided':'Refund', `${sale.transaction_number} — ${fmtMoney(refund.amount)}${reason?' — '+reason:''} (approved by ${approver.name})`, sale.id);
        closeModal();
        toast(isVoid ? `Transaction voided, stock restored. Customer gets back ${fmtMoney(refund.amount)}` : `Refund processed, stock restored. Customer gets back ${fmtMoney(refund.amount)}`);
        navigatePOS('saleDetail', sale.id);
      };
    }
  });
}

/* ================= PWA ================= */
function registerSW(){
  if('serviceWorker' in navigator && location.protocol.startsWith('http')){
    navigator.serviceWorker.register('../sw.js', {scope: '../'}).catch(()=>{});
  }
}

window.addEventListener('DOMContentLoaded', ()=>{
  bootstrap().catch(err=>{ console.error(err); showSetup('', 'Could not start: ' + friendlyError(err)); });
});
