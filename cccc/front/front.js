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
  customer: null,        // {id, nickname, phone (masked), visits, summary (stamp card), summaryOffline, summaryAt}
  qrOrder: null,         // QR order being paid
  route: 'pos', routeParam: null,
  resumingHeldSaleId: null,
  lastSaleId: null,      // the last sale made here (the "Print receipt" button on an empty order)
  catFilter: 'ALL', searchTerm: '',
  lastBootstrapAt: 0,
  qrSince: null, qrSeen: new Set(),
  reward: null,          // stamp reward on this order: {reward:{card_no, stamp, type, amount, label}, customer_id, recipe_id, offline}
  usedRewardKeys: new Set(),   // "customer:card:stamp" of rewards used in sales still waiting to upload (or refused and not dismissed): not offered meanwhile
  qrView: null,          // 'plan' | 'list' (QR orders board)
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
  if(posState.route==='customers' && !!document.querySelector('.offline-panel') === up) renderCustomersScreen();
  if(posState.route==='pos') renderCartPanel();
  // The open waste log says whether Complimentary can be approved now (needs internet for a PIN).
  if(document.getElementById('waste-approval-note')) openWasteLog();
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
  initPrinter();
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
  state.floorShapes = d.floor_shapes || [];
  floorPlanAt = Date.now();
  state.qrOrders = d.qr_orders || [];
  state.qrOrders.forEach(o => posState.qrSeen.add(o.id));
  posState.qrSince = state.qrOrders.reduce((m,o)=> (!m || o.updated_at > m) ? o.updated_at : m, null) || d.server_time || null;
  if(d.next_numbers) mergeCounters(d.next_numbers);
  autoPrintQrArrivals(state.qrOrders);                         // orders that arrived while this page was closed
  // Operations still waiting to upload are re-applied so they don't vanish from the screen.
  const pending = await LocalDB.outboxAll();
  pending.forEach(op => applyOpLocally(op, true));
  await rebuildUsedRewardKeys();
  await prunePinVerifiers();
}

/* ---- snapshot of the current state, for offline restarts ---- */
// Throttled, not debounced: busy selling must never keep pushing the save back (a reload would
// then lose things that already left the upload queue, e.g. an uploaded "start shift").
// delay 0 = save now (used right after uploads leave the queue).
let snapshotTimer = null, snapshotDue = 0;
function saveSnapshotSoon(delay){
  const d = (delay === undefined || delay === null) ? 3000 : Math.max(0, Number(delay) || 0);
  if(snapshotTimer){
    if(Date.now() + d >= snapshotDue) return;          // a save is already coming soon enough
    clearTimeout(snapshotTimer);
  }
  snapshotDue = Date.now() + d;
  snapshotTimer = setTimeout(async ()=>{
    snapshotTimer = null;
    if(!state.device) return;
    try{
      await LocalDB.set('fo.snapshot', {
        server_time: new Date().toISOString(), business: state.business, device: state.device, settings: serverSettingsRow(),
        staff: state.staff, categories: state.categories, ingredients: state.ingredients, recipes: state.recipes,
        recipe_ingredients: state.recipeIngredients,
        stock: Object.keys(state.stock).map(k=>({ingredient_id:k, stock: state.stock[k]})),
        shifts: state.shifts.filter(s=>s.status==='ACTIVE'),
        sales: state.sales, sale_items: state.saleItems, payments: state.payments, refunds: state.refunds,
        cash_movements: state.cashMovements, tables: state.tables, floor_shapes: state.floorShapes || [],
        qr_orders: state.qrOrders.filter(o=>['PENDING','PREPARING','READY'].includes(o.status)),
      });
    }catch(e){ console.warn('snapshot failed', e); }
  }, d);
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
      <div class="pin-logo">${brandLogoHtml('mark', {className: 'setup-mark'})}</div>
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
      <div id="su-captcha" class="setup-captcha"></div>
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
      if(!cloud.session || !cloud.isAnonymous()){
        await cloud.signOut();
        // Optional CAPTCHA (only when the owner set a site key): the check appears in the small
        // box above the button. Null when CAPTCHA is off, so nothing changes then.
        let captchaToken = null;
        if(window.Captcha && Captcha.enabled()){
          btn.textContent = 'Checking…';
          captchaToken = await Captcha.getToken(document.getElementById('su-captcha'), {timeoutMs: 60000});
          btn.textContent = 'Pairing…';
        }
        await cloud.signInAnonymously(captchaToken ? {captchaToken} : undefined);
      }
      const r = await cloud.rpc('redeem_device_pairing', {p_code: code, p_device_key: deviceKey(), p_device_name: name || null});
      if(r && r.error){ failed(friendlyError(r)); return; }
      if(name) localStorage.setItem('cccc.device.name', name);
      toast('Counter paired');
      location.replace(location.pathname);
    }catch(e){ failed((e && (e.offline || e.code==='offline')) ? 'No internet. Pairing needs internet — check the connection and try again.' : friendlyError(e)); }
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
  document.getElementById('pin-logo').innerHTML = brandLogoHtml('mark', {className: 'pin-mark'});
  const foot = document.getElementById('pin-foot');
  const title = document.getElementById('pin-title');
  title.classList.toggle('is-wordmark', pinMode === 'login');
  if(pinMode === 'login'){
    // The shop name is the Brunson wordmark image (alt text = the name), never typed in the display font.
    title.innerHTML = brandWordmarkHtml('cream', {className: 'pin-wordmark'});
    const noPins = !state.staff.some(s=>s.active!==false && s.has_pin);
    document.getElementById('pin-sub').innerHTML = noPins
      ? 'No staff PINs yet. The owner sets them in <b>Back Office → Staff</b>.'
      : `Enter your PIN · ${escapeHtml(state.device ? state.device.device_name : '')}`;
    foot.innerHTML = `<a href="../back/" class="pin-link">Back Office ${icon('chevron-right', {size: 16})}</a>`;
    // Offline and paused after too many wrong PINs: say so (and until when) straight away.
    const pausedUntil = isOnline() ? 0 : offlinePinLockedUntil();
    if(pausedUntil) showPinError(offlinePinLockText(pausedUntil));
  } else {
    title.textContent = `${pinOverrideMinRole.charAt(0)+pinOverrideMinRole.slice(1).toLowerCase()} PIN required`;
    document.getElementById('pin-sub').textContent = hasRole(pinOverrideMinRole) && !shortPinUser()
      ? 'Enter your PIN again to approve. This needs internet.'
      : 'Ask a manager to enter their PIN to approve. This needs internet.';
    foot.innerHTML = `<a href="#" class="pin-link" id="pin-cancel">${icon('chevron-left', {size: 16})} Cancel</a>`;
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
      opts.signedInAnyway ? ` — signed in before ${opts.signedInAnyway} approved action(s) uploaded` : '', !!r.needs_new_pin);
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

async function signIn(staff, token, expiresAt, offline, auditNote, needsNewPin){
  // needs_new_pin (decision 8): a manager/admin with a PIN shorter than 6 digits can sell, but approves nothing.
  posState.currentUser = {id: staff.id, name: staff.name, role: staff.role, offline: !!offline, needs_new_pin: !!needsNewPin};
  posState.loginExpiresAt = token ? (expiresAt || null) : null;
  cloud.setStaffToken(token || null);
  try{ sessionStorage.setItem(STAFF_SESSION_STORAGE, JSON.stringify({staff, token: token||null, expires_at: expiresAt||null, needs_new_pin: !!needsNewPin})); }catch(e){}
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
    posState.currentUser = {id: st.id, name: st.name, role: st.role, offline: !s.token, needs_new_pin: !!s.needs_new_pin};
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
  posState.cart = []; posState.discount = null; posState.customer = null; posState.qrOrder = null; posState.resumingHeldSaleId = null; posState.reward = null;
  posState.lastSaleId = null;          // the next person doesn't get "Print receipt" for this person's sale
  // Customers screen: forget what was shown (a manager's money view must not stay after locking);
  // answers still on their way are thrown away.
  custView.list = null; custView.detail = null; custView.selected = null; custView.q = '';
  custView.listSeq += 1; custView.detailSeq += 1;
  const content = document.getElementById('content'); if(content){ content.innerHTML = ''; content.className = ''; }
  document.getElementById('topbar-actions').innerHTML = '';
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
// The signed-in manager/admin still has a PIN shorter than 6 digits (decision 8): they can sell,
// but their own sign-in approves nothing (the server would refuse it with PIN_UPDATE_NEEDED).
function shortPinUser(){
  const me = posState.currentUser;
  return !!(me && me.needs_new_pin && ROLE_RANK[me.role] >= ROLE_RANK.MANAGER);
}
function requireOverride(minRole='MANAGER'){
  const me = posState.currentUser;
  const shortPin = shortPinUser();
  const own = me && hasRole(minRole) && !shortPin ? ownLoginToken() : null;
  if(own) return Promise.resolve({id: me.id, name: me.name, role: me.role, token: own, own: true});
  if(shortPin){
    // No approval with their own sign-in. Online, another manager can approve on the PIN pad.
    if(!isOnline()){ toast(friendlyError('PIN_UPDATE_NEEDED'), 'warn'); return Promise.resolve(null); }
    toast(friendlyError('PIN_UPDATE_NEEDED') + ' Another manager can approve with their PIN.', 'warn');
  }
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
        if(sale.loyalty_reward && sale.loyalty_reward.customer_id) posState.usedRewardKeys.add(usedRewardKey(sale.loyalty_reward.customer_id, sale.loyalty_reward));
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
      // A void / full refund gives the sale's stamp reward back (the server sets released_at).
      if(d.refund.type === 'VOID' || d.refund.type === 'FULL_REFUND'){
        const rs = state.sales.find(x=>x.id===d.refund.sale_id);
        if(rs && rs.loyalty_reward && rs.loyalty_reward.customer_id) posState.usedRewardKeys.delete(usedRewardKey(rs.loyalty_reward.customer_id, rs.loyalty_reward));
      }
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
    case 'waste':
      // Release 1.4 (A15): the same stock the server will take off (it works it out itself).
      applyStockDeltas(wasteStockDeltas(d));
      break;
    case 'stock_count':
      // Release 1.5 (B9): this counter's stock goes to the counted amounts (missing -> WASTE,
      // extra -> ADJUSTMENT), like the server does on arrival.
      applyStockDeltas(stockCountDeltas(d));
      break;
  }
  if(!replay) saveSnapshotSoon();
}

const Sync = {
  busy: false, pending: 0, failed: 0, lastError: null, timer: null,
  async queue(type, data){
    const op = {op_id: uid(), type, data};
    applyOpLocally(op, false);
    await LocalDB.outboxAdd(op);
    if(type === 'sale' || type === 'refund') rebuildUsedRewardKeys();
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
    let uploaded = 0;
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
            else toast(`Could not upload (${opTypeLabel(o.type)}): ${failedReasonText({type: o.type, data: o.data, error: r.message})}`, 'error');
          }
          done.push(o.seq);
        }
        await LocalDB.outboxRemove(done);
        uploaded += done.length;
        if(done.length < batch.length) break;
      }
    }finally{
      this.busy = false;
      await this.refreshCounts();
      saveSnapshotSoon(uploaded ? 0 : undefined);
      if(uploaded) rebuildUsedRewardKeys();     // uploaded ops left the queue: keep them in the saved copy now
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
    if(!online){ banner.style.display='block'; banner.className='offline-banner'; banner.innerHTML = `<span class="banner-line">${icon('wifi-off', {size: 18})}<span>${escapeHtml(`Offline — keep selling. ${Sync.pending ? Sync.pending+' item(s) will upload when the internet is back.' : ''} QR orders and the Customers screen pause until you're back online.`)}</span></span>`; }
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
    const soon = soonest > Date.now();
    const text = soon
      ? `${waiting} waiting to upload. ${who}'s sign-in ends at ${fmtTime(soonest)}. Reconnect to the internet before then, or the server will refuse ${them}.`
      : `${waiting} waiting to upload, but ${who}'s sign-in ended at ${fmtTime(soonest)}. Reconnect to the internet now. If the server refuses ${them}, tell the owner (they can be redone in Back Office).`;
    box.innerHTML = `<span class="banner-line">${icon(soon ? 'clock' : 'alert', {size: 18})}<span>${escapeHtml(text)}</span></span>`;
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
  box.innerHTML = `<span class="banner-line">${icon(a.kind === 'note' ? 'info' : 'alert', {size: 18})}<span><b>${escapeHtml(a.title)}</b> ${escapeHtml(a.text)}</span>
    <button class="btn btn-outline btn-sm" id="alert-ok">Got it${list.length>1?` (${list.length-1} more)`:''}</button></span>`;
  box.style.display = 'block';
  document.getElementById('alert-ok').onclick = async ()=>{ try{ await LocalDB.set(ALERTS_KEY, list.slice(1)); }catch(e){} renderAlerts(); };
}

// Plain words for the upload types shown to staff (unknown types show as they are).
const OP_TYPE_LABELS = { shift_open:'Start shift', shift_close:'Close shift', cash_movement:'Pay in / pay out', sale:'Sale',
  held_delete:'Remove held order', refund:'Refund / void', audit:'Activity note', sold_out:'Sold-out change', waste:'Waste log',
  stock_count:'Stock count' };
function opTypeLabel(type){ return Object.prototype.hasOwnProperty.call(OP_TYPE_LABELS, type) ? OP_TYPE_LABELS[type] : String(type == null ? '' : type); }

async function showFailedOps(){
  const list = await LocalDB.failedAll();
  openModal({title:'Uploads that need attention', wide:true, body: list.length ? `
    <p class="hint" style="margin-top:0;">The server refused these. They are still saved on this counter. Usually this means a setting changed (e.g. a staff member was removed). Retry, or download the details for the owner.</p>
    <div class="table-wrap"><table><thead><tr><th>When</th><th>Type</th><th>Reason</th><th></th></tr></thead><tbody>
    ${list.map(f=>`<tr><td>${fmtDateTime(f.queued_at)}</td><td>${escapeHtml(opTypeLabel(f.type))}</td><td class="text-light">${escapeHtml(failedReasonText(f))}</td>
      <td class="failed-acts"><button class="btn btn-sm btn-outline" data-retry="${f.seq}">Retry</button> <button class="btn btn-sm btn-ghost" data-drop="${f.seq}">Dismiss</button>
        ${rewardRefused(f) ? (hasRole('MANAGER') ? `<button class="btn btn-sm btn-amber" data-noreward="${f.seq}">Retry without the reward</button>` : '<div class="hint failed-hint">A manager can retry this sale without the stamp reward.</div>') : ''}</td></tr>`).join('')}
    </tbody></table></div>` : '<p>Nothing failed. Everything uploaded.</p>',
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
      root.querySelectorAll('[data-noreward]').forEach(b=> b.onclick = ()=>{
        const f = list.find(x=>String(x.seq)===b.dataset.noreward);
        if(f) retryWithoutReward(f);
      });
      root.querySelectorAll('[data-drop]').forEach(b=> b.onclick = async ()=>{
        const ok = await confirmDialog('Dismiss this item? It will not be uploaded. (Download the details first if you need them.)', 'Dismiss');
        if(!ok){ showFailedOps(); return; }
        await LocalDB.failedRemove(Number(b.dataset.drop));
        await rebuildUsedRewardKeys();
        await Sync.refreshCounts(); showFailedOps();
      });
    }});
}

/* ---- Retry a refused sale without its stamp reward (release 1.3, P2) ----
   The server refuses the WHOLE sale when its stamp reward no longer fits (used elsewhere, or
   the amount changed). The customer already paid, so a manager can save it at full price:
   the same sale id, a new upload id, no reward, totals worked out again by the shared maths,
   the payment exactly as taken (the server flags a short payment for the owner to review). */
const REWARD_REFUSAL_CODES = ['REWARD_NOT_AVAILABLE', 'REWARD_AMOUNT_MISMATCH', 'CARD_NOT_ISSUED'];
// Plain words for a refused upload (a discounted sale whose approval ran out gets its own sentence).
function failedReasonText(f){
  if(f && f.type === 'sale' && errorCode(f.error) === 'APPROVAL_INVALID' && f.data && f.data.sale && Number(f.data.sale.discount_amount) > 0){
    return 'The manager approval for this discount has expired or was already used. To record it, ring the sale up again and ask a manager to approve the discount.';
  }
  if(f && f.type === 'sale' && errorCode(f.error) === 'CARD_NOT_ISSUED'){
    return 'The stamp reward on this sale is on the customer\'s next card, which opens only after they use the last reward on their full card (for example the free drink). The sale was not saved. A manager can retry it without the reward.';
  }
  if(f && f.type === 'stock_count'){
    const c = errorCode(f.error);
    const n = f.data && Array.isArray(f.data.lines) ? f.data.lines.length : 0;
    const what = ` (${n} item${n === 1 ? '' : 's'} counted${f.data && f.data.counted_at ? ' at ' + fmtTime(f.data.counted_at) : ''})`;
    if(c === 'BAD_COUNT') return `The owner changed which items are counted at closing, so this count${what} no longer matches the list. Close the shift again: the count list shows the items to count now. Then dismiss this one.`;
    if(c === 'COUNT_REQUIRED') return `This count${what} left out an item that must be counted at closing. Close the shift again and count every item on the list.`;
    if(c === 'FORBIDDEN_ROW') return `This count${what} clashes with a record already on the server, so it was not saved. Download the details for the owner, then count again when you close the shift.`;
    if(c === 'UNKNOWN_INGREDIENT' || c === 'BAD_UNIT') return `An item in this count${what} was changed in the Back Office. Count again when you close the shift.`;
    return friendlyError({message: f.error}) + what;
  }
  if(f && f.type === 'shift_close' && errorCode(f.error) === 'COUNT_REQUIRED'){
    return 'The shift was not closed on the server because its stock count is missing or was refused. Check the stock count in this list first (retry it, or count again), then retry closing the shift.';
  }
  if(f && f.type === 'waste'){
    const c = errorCode(f.error);
    const what = f.data ? ` (${wasteReasonLabel(f.data.reason)}, ${(f.data.items||[]).length} line${(f.data.items||[]).length===1?'':'s'})` : '';
    if(/^APPROVAL_|^PIN_UPDATE_NEEDED$/.test(c)) return `The manager approval for this complimentary waste${what} has expired or was already used. Log it again and ask a manager to approve.`;
    if(c === 'BAD_WASTE' || c === 'UNKNOWN_RECIPE' || c === 'UNKNOWN_INGREDIENT') return `This waste entry${what} names an item or option that is no longer on the menu (the menu changed). Log it again with the current menu, then dismiss this one.`;
    return friendlyError({message: f.error}) + what;
  }
  return friendlyError({message: f && f.error});
}
function rewardRefused(f){
  return !!(f && f.type === 'sale' && f.data && f.data.sale && f.data.sale.status === 'COMPLETED' && REWARD_REFUSAL_CODES.includes(errorCode(f.error)));
}
// The sale as it would be saved at full price (nothing else changes).
function saleWithoutReward(data){
  const sale = data.sale;
  const lines = (data.items || []).map(it=>({recipe_id: it.recipe_id, unit_price: Number(it.unit_price) || 0, quantity: Number(it.quantity) || 0}));
  const discount = sale.discount_type ? {type: sale.discount_type, value: Number(sale.discount_value) || 0} : null;
  const t = computeSaleTotals(lines, discount, undefined, 0);
  const fixed = Object.assign({}, sale, {
    subtotal: t.subtotal, discount_amount: t.discountAmt, tax_amount: t.tax, service_charge_amount: t.serviceCharge, grand_total: t.grandTotal,
    loyalty_reward: null, loyalty_discount: 0, updated_at: new Date().toISOString(),
  });
  const out = Object.assign({}, data, {sale: fixed});        // items, payment, inventory and the discount approval token stay as they were
  return {data: out, totals: t};
}
async function retryWithoutReward(f){
  if(!hasRole('MANAGER')){ toast('Only a manager can do this.', 'warn'); return; }
  const {data, totals} = saleWithoutReward(f.data);
  const paid = f.data.payment ? Number(f.data.payment.amount) || 0 : 0;
  const short = paid + 0.005 < totals.grandTotal;
  const no = f.data.sale.transaction_number || 'this sale';
  const ok = await new Promise(resolve=>{
    let done = false;
    openModal({title: 'Retry without the reward?', body: `
      <p>The stamp reward on <b>${escapeHtml(no)}</b> could not be used, so the server did not save the sale.</p>
      <div class="notice warn">The sale will be saved at full price <b>${fmtMoney(totals.grandTotal)}</b>.${short ? ` The customer paid <b>${fmtMoney(paid)}</b>, so it will be marked for the owner to review.` : ` The customer paid ${fmtMoney(paid)}.`}</div>
      <p class="hint">Nothing is charged again. The owner sees the sale in Back Office.</p>`,
      foot: `<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" data-ok>Save at full price</button>`,
      onClose: ()=>{ if(!done) resolve(false); },
      onMount: (root)=>{
        root.querySelector('[data-cancel]').onclick = ()=>{ done = true; closeModal(); resolve(false); };
        root.querySelector('[data-ok]').onclick = ()=>{ done = true; closeModal(); resolve(true); };
      }});
  });
  if(!ok){ showFailedOps(); return; }
  await LocalDB.failedRemove(f.seq);
  // This counter's own copy of the sale shows the full price too.
  const mine = state.sales.find(x=>x.id===data.sale.id);
  if(mine) Object.assign(mine, data.sale);
  await Sync.queue('sale', data);                              // new upload id, same sale id
  queueAudit('Sale retried without the stamp reward', `${no} — full price ${fmtMoney(totals.grandTotal)}, paid ${fmtMoney(paid)} (by ${posState.currentUser.name}; reason: ${errorCode(f.error)})`, data.sale.id);
  toast(`Retrying ${no} at full price…`);
  await Sync.refreshCounts();
  showFailedOps();
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
    if(rows && rows.length) autoPrintQrArrivals(rows);      // a new order's ticket prints once (Printer screen switch)
    if(rows && rows.length){
      updateQrBadge();
      if(posState.route==='qr') renderQrBoard();
      if(newOnes){ chime(); toast(`${newOnes} new QR order${newOnes>1?'s':''}`, 'warn'); }
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
  if(!isOnline() || !cloud.session) return false;
  try{
    const rows = await cloud.selectAll('v_ingredient_stock', {select:'ingredient_id,stock'});
    setStockFromServer(rows);
    const pending = await LocalDB.outboxAll();
    pending.forEach(op=>{
      if(op.type==='sale' && op.data.sale.status==='COMPLETED') applyStockDeltas(op.data.inventory.map(t=>Object.assign({transaction_type:'SALE_USAGE'}, t)));
      if(op.type==='refund') applyStockDeltas(op.data.inventory.map(t=>Object.assign({transaction_type:'SALE_REVERSAL'}, t)));
      if(op.type==='waste') applyStockDeltas(wasteStockDeltas(op.data));
    });
    if(posState.route==='pos') renderProductGrid();
    return true;
  }catch(e){ return false; }
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
// The route id 'pos' stays (tests and saved state use it); the screen is called "Orders" (1.2).
const POS_NAV_ITEMS = [
  {id:'pos', label:'Orders', ic:'orders'},
  {id:'qr', label:'QR orders', ic:'qr', badge:true},
  {id:'customers', label:'Customers', ic:'users'},
  {id:'sales', label:'Sales', ic:'receipt'},
  {id:'shift', label:'Shift & cash', ic:'clock'},
];
const POS_ROUTE_TITLES = { pos:'Orders', qr:'QR orders', customers:'Customers', sales:'Sales', shift:'Shift & cash', saleDetail:'Transaction', printer:'Receipt printer' };
const ROLE_WORDS = {CASHIER:'Cashier', MANAGER:'Manager', ADMIN:'Admin'};

function renderShell(){
  const u = posState.currentUser;
  const role = u ? (ROLE_WORDS[u.role] || u.role) : '';
  document.getElementById('sidebar').innerHTML = `
    <div class="brand">${brandLogoHtml('mark', {className: 'mark'})}
      <div class="brand-text">${brandWordmarkHtml('dark', {className: 'wm'})}<small>${escapeHtml(state.device?state.device.device_name:'')}</small></div></div>
    <div id="nav">${POS_NAV_ITEMS.map(n=>`<div class="nav-item" data-route="${n.id}" role="button" tabindex="0" title="${escapeHtml(n.label)}"><span class="ic">${icon(n.ic)}</span><span class="label">${escapeHtml(n.label)}</span>${n.badge?'<span class="nav-badge" data-qr-badge style="display:none;">0</span>':''}</div>`).join('')}
      ${u && u.role==='ADMIN' ? `<div class="nav-spacer" aria-hidden="true"></div><a class="nav-item nav-back-office" href="../back/" title="Back Office" aria-label="Back Office"><span class="ic">${icon('settings')}</span><span class="label">Back Office</span></a>` : ''}
    </div>
    <div id="sidebar-foot">
      <div class="who-row"><span class="role-badge" title="${escapeHtml(u?`${u.name} · ${u.role}`:'')}"><b>${escapeHtml(u?u.name:'')}</b><small>${escapeHtml(role)}${u&&u.offline?' · offline':''}</small></span></div>
      <button class="sync-status online" id="sync-pill" title="Upload status — tap for details"><span class="dot"></span> Online</button>
      <button class="printer-pill" id="printer-pill" title="Receipt printer — tap to set up"><span class="ptxt">Printer</span></button>
      <button class="btn btn-ghost btn-sm" id="lock-btn" aria-label="Lock / Switch User">${icon('lock', {size: 18})}<span>Lock / switch user</span></button>
    </div>`;
  const nav = document.getElementById('nav');
  nav.addEventListener('click', (e)=>{
    const item = e.target.closest('.nav-item[data-route]');
    if(item) navigatePOS(item.dataset.route);
  });
  nav.addEventListener('keydown', (e)=>{
    const item = e.target.closest('.nav-item[data-route]');
    if(item && (e.key === 'Enter' || e.key === ' ')){ e.preventDefault(); navigatePOS(item.dataset.route); }
  });
  document.getElementById('lock-btn').onclick = lockSession;
  document.getElementById('sync-pill').onclick = ()=>{ Sync.run(); showFailedOps(); };
  document.getElementById('printer-pill').onclick = ()=> navigatePOS('printer');
  document.title = 'Front Office — ' + (businessName()||appDisplayName());
  updateSyncPill(); updateQrBadge(); updateApprovalBanner(); renderAlerts(); updatePrinterPill();
}

function navigatePOS(route, param=null){
  posState.route = route; posState.routeParam = param;
  document.querySelectorAll('.nav-item').forEach(n=> n.classList.toggle('active', n.dataset.route===route || (route==='saleDetail' && n.dataset.route==='sales')));
  const pp = document.getElementById('printer-pill'); if(pp) pp.classList.toggle('active', route==='printer');
  document.getElementById('topbar-title').textContent = POS_ROUTE_TITLES[route] || '';
  document.getElementById('topbar-actions').innerHTML = '';
  const content = document.getElementById('content');
  content.className = '';
  content.scrollTop = 0;
  const renderers = { pos: renderPOSScreen, qr: renderQrBoard, customers: renderCustomersScreen, sales: renderSalesScreen, shift: renderShiftScreen, saleDetail: ()=>renderSaleDetail(param), printer: renderPrinterScreen };
  (renderers[route]||renderPOSScreen)();
  if(route==='pos') maybeRefreshMenu();
}

/* =====================================================================
   MAIN POS SCREEN
   ===================================================================== */
function sellableRecipes(){
  return state.recipes.filter(r => r.active!==false && r.pos_visible!==false && Number(r.selling_price) > 0);
}
// How many more can be made right now from on-hand stock (99 = not tracked). Release 1.4: the
// shared recipeMakeableCount (same stock lines as a sale; merged ingredients counted on their
// general ingredient, operating supplies left out). Without options here; the option sheet
// checks the item again with the options chosen (cups, lids, swaps).
function recipeAvailability(recipe, modifiers){
  return recipeMakeableCount(recipe.id, modifiers || []);
}
// A swap option could still make an item whose own recipe ran out (e.g. no dairy milk, oat milk in stock).
function hasSwapOption(recipe){
  return recipeOptionGroups(recipe).some(g => (g.options||[]).some(o => o && optionKind(o) === 'SWAP'));
}

function renderPOSScreen(){
  const shift = activeShift();
  if(!shift){ renderStartShiftGate(); return; }

  const held = state.sales.filter(s=>s.status==='HELD');
  document.getElementById('topbar-actions').innerHTML = `
    <span class="shift-badge" title="Opened ${fmtDateTime(shift.opened_at)} by ${escapeHtml(shift.cashier_name)}">${escapeHtml(shift.shift_number||'')} · ${shiftDuration(shift)}</span>
    ${held.length? `<button class="btn btn-outline" id="held-orders-btn">${icon('inbox')} Held (${held.length})</button>` : ''}
    <button class="btn btn-outline" id="barista-btn" title="Log today's barista drink (calibration kit)">${icon('cup')} Barista drink</button>
    <button class="btn btn-outline" id="waste-btn" title="Log waste: spilled, given free, calibration…">${icon('trash')} Log waste</button>`;
  if(held.length) document.getElementById('held-orders-btn').onclick = showHeldOrders;
  document.getElementById('barista-btn').onclick = ()=> openBaristaDrink();
  document.getElementById('waste-btn').onclick = ()=> openWasteLog();

  const content = document.getElementById('content');
  const recipes = sellableRecipes();
  // Sub-categories in the shop's menu order (drinks first, then pastry, then food; release 1.3, A16).
  const cats = ['ALL', ...sortSubcategories([...new Set(recipes.map(posCategoryOf))])];
  if(!cats.includes(posState.catFilter)) posState.catFilter = 'ALL';
  content.className = 'pos-layout';
  content.innerHTML = `
    <div class="pos-left">
      <label class="pos-search">${icon('search')}<input type="search" id="pos-search" placeholder="Search the menu" aria-label="Search the menu" autocomplete="off" value="${escapeHtml(posState.searchTerm)}"></label>
      <div class="pos-cats" id="pos-cats" role="tablist" aria-label="Sub-categories">${cats.map(c=>`<button class="pos-cat-btn ${posState.catFilter===c?'active':''}" data-cat="${escapeHtml(c)}" aria-pressed="${posState.catFilter===c}">${c==='ALL'?'All':escapeHtml(c)}</button>`).join('')}</div>
      <div class="pos-product-grid" id="pos-product-grid"></div>
    </div>
    <div class="pos-cart" id="pos-cart-panel"></div>
    <button class="cart-jump" id="cart-jump" hidden></button>`;
  document.getElementById('cart-jump').onclick = ()=>{ const c = document.getElementById('pos-cart-panel'); if(c) c.scrollIntoView({behavior: 'smooth', block: 'start'}); };
  document.getElementById('pos-search').oninput = (e)=>{ posState.searchTerm = e.target.value; renderProductGrid(); };
  document.getElementById('pos-cats').addEventListener('click', (e)=>{
    const btn = e.target.closest('[data-cat]'); if(!btn) return;
    posState.catFilter = btn.dataset.cat;
    renderProductGrid();
    document.querySelectorAll('.pos-cat-btn').forEach(b=>{ const on = b.dataset.cat===posState.catFilter; b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); });
  });
  renderProductGrid();
  renderCartPanel();
}

// Tiles grouped under their sub-category (posCategoryOf), groups in the shop's menu order
// (sortSubcategories: drinks, then pastry, then food; the owner's order inside), items in their
// menu order (sort_order, then name) inside each group. A chip shows one group; a search
// shows the matching items, still grouped. Returns [{name, items}].
function groupedMenu(){
  let list = sellableRecipes();
  if(posState.catFilter!=='ALL') list = list.filter(r=> posCategoryOf(r)===posState.catFilter);
  const term = String(posState.searchTerm || '').trim().toLowerCase();
  if(term) list = list.filter(r=> String(r.name||'').toLowerCase().includes(term));
  const groups = new Map();
  list.forEach(r=>{ const g = posCategoryOf(r); if(!groups.has(g)) groups.set(g, []); groups.get(g).push(r); });
  return sortSubcategories([...groups.keys()]).map(name=>({
    name, items: groups.get(name).sort((a,b)=> (Number(a.sort_order)||0)-(Number(b.sort_order)||0) || String(a.name).localeCompare(String(b.name))),
  }));
}
function productTileHtml(r, colorKey){
  const avail = recipeAvailability(r);
  const sold = !!r.sold_out;
  const low = !sold && avail<=2;
  const style = colorKey ? tileStyleVars(colorKey) : '';
  const cls = ['pos-product-card', colorKey ? 'tile-colored' : 'tile-plain', colorKey && TILE_COLORS[colorKey].light ? 'tile-light' : '', (sold||avail<=0) ? 'unavailable' : ''].filter(Boolean).join(' ');
  const tag = sold ? '<span class="tile-tag">Sold out</span>' : (low ? `<span class="tile-tag">${avail<=0?'Out of stock':'Low stock'}</span>` : '');
  return `<button type="button" class="${cls}" data-recipe="${escapeHtml(r.id)}" ${style?`style="${style}"`:''}>
      ${tag}<span class="pname">${escapeHtml(r.name)}</span>
      <span class="pprice">${fmtMoney(r.selling_price)}</span>
    </button>`;
}
function renderProductGrid(){
  const grid = document.getElementById('pos-product-grid');
  if(!grid) return;
  const groups = groupedMenu();
  if(groups.length===0){
    grid.innerHTML = posState.searchTerm
      ? `<div class="empty-state">${icon('search', {size: 32})}<p>Nothing on the menu matches “${escapeHtml(posState.searchTerm)}”.</p></div>`
      : `<div class="empty-state">${icon('cup', {size: 32})}<p>No products yet. Add sellable recipes (with a selling price) in Back Office → Recipes.</p></div>`;
    return;
  }
  grid.innerHTML = groups.map(g=>{
    const key = tileColorKeyFor(g.name);
    const n = g.items.length;
    return `<section class="pos-group" data-group="${escapeHtml(g.name)}">
      <div class="pos-group-head"><h2 class="pos-group-title">${escapeHtml(g.name)}</h2><span class="pos-group-count">${n} item${n===1?'':'s'}</span></div>
      <div class="pos-group-grid">${g.items.map(r=>productTileHtml(r, key)).join('')}</div>
    </section>`;
  }).join('');
  grid.querySelectorAll('[data-recipe]').forEach(card=> card.onclick = ()=> onProductTap(card.dataset.recipe));
}

async function onProductTap(recipeId){
  const recipe = state.recipes.find(r=>r.id===recipeId);
  if(!recipe) return;
  // Sold out / out of stock: can't be added (Q6, no "Add anyway?").
  if(recipe.sold_out){
    toast(`${recipe.name} is sold out, so it can't be added. When it's back, turn it on again in QR orders → Sold-out items.`, 'warn');
    return;
  }
  const groups = recipeOptionGroups(recipe);
  if(recipeAvailability(recipe) <= 0 && !(groups.length && hasSwapOption(recipe))){
    const p = cartStockProblems([{recipe_id: recipe.id, name: recipe.name, quantity: 1, modifiers: []}])[0];
    toast(`${recipe.name} is out of stock, so it can't be added${p ? ' (' + stockNeedText(p) + ')' : ''}.${isOnline() ? '' : ' This counter is offline: stock may be out of date.'}`, 'warn');
    return;
  }
  if(groups.length===0){ addToCart(recipe, 1, []); return; }
  openModifierPicker(recipe);
}

// One line on its own, with these options: null when the stock can make it, else the words why not.
function lineStockProblem(recipe, quantity, modifiers){
  const p = cartStockProblems([{recipe_id: recipe.id, name: recipe.name, quantity, modifiers}])[0];
  return p ? stockNeedText(p) : null;
}
// An option that can't be made now (its cup, lid or swap milk ran out on this counter): the
// shared count with only that option chosen. When the item itself can't be made without a
// swap (baseCount 0), only swap options are marked, so the sheet points at what still works.
function optionOutOfStock(recipe, group, option, baseCount){
  if(baseCount <= 0 && optionKind(option) !== 'SWAP') return false;
  return recipeMakeableCount(recipe.id, [modifierFromOption(group, option)]) <= 0;
}
function optionPriceText(o){
  const p = Number(o.price_delta) || 0;
  return p ? ` (${p > 0 ? '+' : ''}${fmtMoney(p)})` : '';
}

/* ================= Modifier picker (the option sheet) =================
   Release 1.4: library groups (lib_…) show like the item's own groups. Required groups (e.g.
   Hot / Iced) must be chosen first (missingRequiredGroups). The cart keeps modifierFromOption's
   snapshot (extras / removes), so cups, lids and swaps deduct the right stock, also offline.
   opts (the waste log uses the same sheet):
     {onDone({quantity, selections, modifiers, notes}), onCancel(), title, addLabel, maxQty, noNotes, noStockCheck} */
function openModifierPicker(recipe, existingLine, opts){
  opts = opts || {};
  const groups = recipeOptionGroups(recipe);
  let selections = existingLine ? (existingLine.selections ? JSON.parse(JSON.stringify(existingLine.selections)) : []) : []; // [{group_id, option_id}]
  let qty = existingLine ? existingLine.quantity : 1;
  const maxQty = opts.maxQty || Infinity;
  const baseCount = opts.noStockCheck ? 99 : recipeAvailability(recipe);
  let finished = false;
  function chosenModifiers(){ return modifiersFromSelections(recipe, selections); }
  function currentPrice(){ return menuUnitPrice(recipe, chosenModifiers()); }
  const body = `
    <div class="mod-head"><b>${escapeHtml(recipe.name)}</b>${!opts.noStockCheck && baseCount <= 0 ? `<div class="hint">Out of stock as it is. A swap below may still work.</div>` : ''}</div>
    ${groups.map(g=>`
      <div class="mod-group" data-group="${escapeHtml(g.id)}">
        <div class="mod-group-title"><span>${escapeHtml(g.name)}${g.multi_select?' <span class="text-light" style="font-weight:500;">(pick any)</span>':''}</span>${g.required?'<span class="req">Required</span>':''}</div>
        <div class="mod-options">${(g.options||[]).map(o=>{
          const swap = optionKind(o) === 'SWAP';
          const out = !opts.noStockCheck && optionOutOfStock(recipe, g, o, baseCount);
          return `<button class="mod-opt${out?' mod-opt-out':''}" data-group="${escapeHtml(g.id)}" data-opt="${escapeHtml(o.id)}">${swap?`<span class="mod-swap">Swap</span> `:''}${escapeHtml(o.label)}${optionPriceText(o)}${out?' <small class="mod-out">Out of stock</small>':''}</button>`;
        }).join('')}</div>
      </div>`).join('')}
    ${opts.noNotes ? '' : `<div class="form-row" style="margin-top:6px;"><label>Note (optional)</label><input id="mod-notes" maxlength="140" value="${escapeHtml(existingLine?existingLine.notes||'':'')}" placeholder="e.g. less ice"></div>`}
    <div class="mod-missing" id="mod-missing" role="alert" hidden></div>
    <div class="qty-stepper">
      <button class="qbig" id="mod-qty-minus" aria-label="One less">−</button><span class="qval" id="mod-qty-val">${qty}</span><button class="qbig" id="mod-qty-plus" aria-label="One more">+</button>
    </div>
    <div class="mod-total" id="mod-total-price">${fmtMoney(currentPrice()*qty)}</div>`;
  const foot = `<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" id="mod-add">${escapeHtml(opts.addLabel || (existingLine?'Update item':'Add to order'))}</button>`;
  openModal({title: escapeHtml(opts.title || 'Customize'), body, foot,
    onClose: ()=>{ if(!finished && opts.onCancel) opts.onCancel(); },
    onMount:(root)=>{
    root.querySelector('[data-cancel]').onclick = closeModal;
    const missingBox = root.querySelector('#mod-missing');
    function showMissing(list){
      root.querySelectorAll('.mod-group').forEach(n=> n.classList.toggle('mod-group-missing', list.some(m=>m.group_id===n.dataset.group)));
      missingBox.hidden = !list.length;
      missingBox.textContent = list.length ? `Choose ${list.map(m=>m.name).join(' and ')} first.` : '';
    }
    function refreshUI(){
      root.querySelectorAll('.mod-opt').forEach(btn=>{
        const on = selections.some(s=>s.group_id===btn.dataset.group && s.option_id===btn.dataset.opt);
        btn.classList.toggle('selected', on); btn.setAttribute('aria-pressed', String(on));
      });
      root.querySelector('#mod-qty-val').textContent = qty;
      root.querySelector('#mod-total-price').textContent = fmtMoney(currentPrice()*qty);
      if(!missingBox.hidden) showMissing(missingRequiredGroups(recipe, selections));
    }
    root.querySelectorAll('.mod-opt').forEach(btn=>{
      btn.onclick = ()=>{
        const gid = btn.dataset.group, oid = btn.dataset.opt;
        const group = groups.find(g=>g.id===gid);
        if(!group) return;
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
    root.querySelector('#mod-qty-plus').onclick = ()=>{ qty = Math.min(maxQty, qty+1); refreshUI(); };
    refreshUI();
    root.querySelector('#mod-add').onclick = ()=>{
      const missing = missingRequiredGroups(recipe, selections);
      if(missing.length){ showMissing(missing); toast(`Choose ${missing.map(m=>m.name).join(' and ')} first.`, 'error'); return; }
      const modifiers = chosenModifiers();
      if(!opts.noStockCheck){
        // Out of stock with these options (e.g. no iced cups left): can't be added (Q6).
        const why = lineStockProblem(recipe, qty, modifiers);
        if(why){ toast(`${recipe.name}${modifiers.length ? ' (' + modifiers.map(m=>m.label).join(', ') + ')' : ''} can't be added: ${why}.${isOnline() ? '' : ' This counter is offline: stock may be out of date.'}`, 'warn'); return; }
      }
      const notesEl = root.querySelector('#mod-notes');
      const notes = notesEl ? notesEl.value.trim() : '';
      finished = true;
      if(opts.onDone){ closeModal(); opts.onDone({quantity: qty, selections, modifiers, notes}); return; }
      if(existingLine){
        Object.assign(existingLine, {quantity: qty, modifiers, selections, notes, unit_price: menuUnitPrice(recipe, modifiers)});
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
  const unit_price = menuUnitPrice(recipe, modifiers);
  posState.cart.push({lineId: uid(), recipe_id: recipe.id, name: recipe.name, unit_price, quantity: qty, modifiers, selections: selections||[], notes: notes||''});
  renderCartPanel();
  toast(`Added ${recipe.name}`, 'success');
}
function cartLineTotal(line){ return line.unit_price * line.quantity; }
function cartLogicLines(){ return posState.cart.map(l=>({recipe_id: l.recipe_id, unit_price: l.unit_price, quantity: l.quantity})); }
// Totals always come from the shared maths, with the stamp reward (if one is applied) worked
// out again from the cart as it is now.
function currentCartTotals(){
  return computeSaleTotals(cartLogicLines(), posState.discount, undefined, rewardAmountNow());
}
function clearCart(){
  posState.cart = []; posState.discount = null; posState.resumingHeldSaleId = null; posState.customer = null; posState.qrOrder = null; posState.reward = null;
}

/* ================= Stamp card rewards at checkout (release 1.2) =================
   The server decides which rewards are ready (fo_customer_detail / fo_customer_list) and checks
   the one used when the sale uploads (REWARD_NOT_AVAILABLE / REWARD_AMOUNT_MISMATCH refuse the
   whole sale; it then waits under "Uploads that need attention"). One reward per sale.
   Offline: only rewards the last online answer showed as ready, and the screen says they are
   checked when the internet is back. A reward used in a sale that is still waiting to upload
   is not offered again on this counter (posState.usedRewardKeys). */
function loyaltyOn(){ return !!(state.settings && state.settings.loyalty_enabled); }
function usedRewardKey(customerId, r){ return customerId + ':' + rewardKey(r); }
// Rebuilds the blocked rewards from what is still on this counter: finished sales with a reward that are
// waiting to upload, or were refused and not dismissed yet, unless a void / full refund of that sale is
// queued too. Everything else follows the server's answer (a released reward is offered again).
async function rebuildUsedRewardKeys(){
  try{
    const ops = (await LocalDB.outboxAll()).concat(await LocalDB.failedAll());
    const released = new Set(ops.filter(o => o.type === 'refund' && o.data && o.data.refund && (o.data.refund.type === 'VOID' || o.data.refund.type === 'FULL_REFUND')).map(o => o.data.refund.sale_id));
    const keys = new Set();
    ops.forEach(o => {
      const sale = o.type === 'sale' && o.data && o.data.sale;
      const lr = sale && sale.status === 'COMPLETED' && sale.loyalty_reward;
      if(lr && lr.customer_id && !released.has(sale.id)) keys.add(usedRewardKey(lr.customer_id, lr));
    });
    posState.usedRewardKeys = keys;
    if(posState.route === 'pos') renderCartPanel();
  }catch(e){}
}
function usableRewards(){
  const c = posState.customer;
  if(!c || !c.summary || !loyaltyOn() || savedCardTooOldForRewards(c)) return [];
  return readyRewards(c.summary).filter(r => !posState.usedRewardKeys.has(usedRewardKey(c.id, r)));
}
// Cart lines a free-item reward can go on: a drink / pastry / food line with a whole quantity of 1 or more.
function freeItemLines(){
  return rewardEligibleLines(posState.cart).filter(l => Number.isInteger(Number(l.quantity)) && Number(l.quantity) >= 1);
}
function rewardAmountNow(){
  const a = posState.reward;
  if(!a) return 0;
  if(a.reward.type === 'FREE_ITEM' && !freeItemLines().some(l => l.recipe_id === a.recipe_id)) return 0;
  return loyaltyRewardAmount(a.reward, cartLogicLines(), posState.discount, a.recipe_id);
}
function rewardLineName(a){
  if(!a) return '';
  if(a.reward.type === 'FREE_ITEM'){
    const line = posState.cart.find(l => l.recipe_id === a.recipe_id);
    return 'Free ' + (line ? line.name : 'item');
  }
  return rewardLabel(a.reward);
}
// Drops a reward that no longer fits the cart (customer removed or changed, free item taken out).
function checkAppliedReward(){
  const a = posState.reward;
  if(!a) return;
  const c = posState.customer;
  let why = '';
  if(!c || c.id !== a.customer_id) why = 'The customer was removed, so the stamp reward was taken off.';
  else if(!loyaltyOn()) why = 'The stamp card is switched off, so the reward was taken off.';
  else if(!usableRewards().some(r => rewardKey(r) === rewardKey(a.reward))) why = 'That stamp reward is no longer available, so it was taken off.';
  else if(a.reward.type === 'FREE_ITEM' && !freeItemLines().some(l => l.recipe_id === a.recipe_id)) why = 'The free item is no longer in the order, so the stamp reward was taken off.';
  if(why){ posState.reward = null; toast(why, 'warn'); }
}
// Release 1.5 (B16): before a reward goes on the order, the customer's card is asked from the
// server again when online, and only that answer's ready_rewards are offered. (With 012, a reward
// of a card that isn't issued yet makes the whole sale fail with CARD_NOT_ISSUED.) Offline, the
// card saved on this counter is used as before (rewards only from a copy at most 48 hours old).
// -> true when the reward may be applied now.
let rewardCheckRunning = false;
async function recheckRewardOnline(c, key){
  if(!isOnline() || !c) return true;
  try{
    const r = await cloud.rpc('fo_customer_detail', {p_customer_id: c.id, p_staff_token: null}, {timeout: 8000});
    if(!posState.customer || posState.customer.id !== c.id) return false;      // customer changed meanwhile
    if(r && r.customer){
      await saveCustomerCard(r.customer);
      setCustomerSummary(r.customer, false);
    } else if(r && r.error === 'NOT_FOUND'){
      await forgetCustomerCard(c.id);
      posState.customer.summary = null;
      renderCartPanel();
      toast('This customer is no longer on the list (merged or removed), so no reward can be used.', 'warn');
      return false;
    } else {
      toast(friendlyError(r || {}) + ' The reward was not applied.', 'warn');
      return false;
    }
  }catch(e){
    if(!e.offline){ toast('Could not check the stamp card just now. Try the reward again in a moment.', 'warn'); return false; }
    return true;                                         // the internet dropped: the saved card rules apply
  }
  if(!usableRewards().some(x => rewardKey(x) === key)){
    renderCartPanel();
    toast('That reward is not ready on the customer\'s card any more (the stamp card was updated). Choose from the rewards shown.', 'warn');
    return false;
  }
  return true;
}
async function applyReward(key){
  const c0 = posState.customer;
  if(!c0 || !usableRewards().some(x => rewardKey(x) === key)) return;
  if(!posState.cart.length){ toast('Add items to the order first, then apply the reward.', 'warn'); return; }
  if(rewardCheckRunning) return;
  rewardCheckRunning = true;
  const chip = document.querySelector(`[data-reward="${CSS.escape(key)}"]`);
  if(chip){ chip.disabled = true; chip.textContent = 'Checking the card…'; }
  let okNow = false;
  try{ okNow = await recheckRewardOnline(c0, key); }
  finally{ rewardCheckRunning = false; }
  if(!okNow){ renderCartPanel(); return; }
  const c = posState.customer;
  const r = usableRewards().find(x => rewardKey(x) === key);
  if(!c || !r){ renderCartPanel(); return; }
  if(!posState.cart.length){ renderCartPanel(); toast('Add items to the order first, then apply the reward.', 'warn'); return; }
  const set = (recipeId)=>{
    posState.reward = {reward: r, customer_id: c.id, recipe_id: recipeId || null, offline: !!c.summaryOffline};
    renderCartPanel();
    toast(`Stamp reward applied: ${r.type === 'FREE_ITEM' ? rewardLineName(posState.reward) : rewardLabel(r)}`);
  };
  if(r.type !== 'FREE_ITEM'){ set(null); return; }
  const lines = freeItemLines();
  // One choice per item (the dearest line of an item counts, as on the server).
  const byRecipe = new Map();
  lines.forEach(l => { const was = byRecipe.get(l.recipe_id); if(!was || Number(l.unit_price) > Number(was.unit_price)) byRecipe.set(l.recipe_id, l); });
  const choices = [...byRecipe.values()];
  if(!choices.length){ toast('Add a drink or food item to the order first. The free item reward takes one of them off.', 'warn'); return; }
  if(choices.length === 1){ set(choices[0].recipe_id); return; }
  openModal({title: 'Which item is free?', body: `
    <p class="hint" style="margin-top:0;">One of the chosen item is free (its price with the options picked).</p>
    <div class="free-pick">${choices.map(l => `<button class="free-pick-btn" data-free="${escapeHtml(l.recipe_id)}"><b>${escapeHtml(l.name)}</b>${l.modifiers && l.modifiers.length ? `<small>${l.modifiers.map(m=>escapeHtml(m.label)).join(', ')}</small>` : ''}<span>${fmtMoney(l.unit_price)}</span></button>`).join('')}</div>`,
    foot: `<button class="btn btn-outline" data-cancel>Cancel</button>`,
    onMount: (root)=>{
      root.querySelector('[data-cancel]').onclick = closeModal;
      root.querySelectorAll('[data-free]').forEach(b => b.onclick = ()=>{ closeModal(); set(b.dataset.free); });
    }});
}

/* ---- The customer on this order (and their stamp card) ---- */
const CUSTOMER_CARDS_KEY = 'fo.customerCards';
const CUSTOMER_CARDS_MAX = 300;
const CUSTOMER_CARD_KEEP_MS = 30*24*3600*1000;      // saved copies older than 30 days are deleted
const CUSTOMER_CARD_REWARD_MS = 48*3600*1000;       // offline, rewards only from copies saved in the last 48 hours
// Saved stamp cards (for offline use). Copies older than 30 days are removed whenever the list is read.
async function loadCustomerCards(){
  let m;
  try{ m = await LocalDB.get(CUSTOMER_CARDS_KEY); }catch(e){ return {}; }
  if(!m || typeof m !== 'object' || Array.isArray(m)) return {};
  const cutoff = Date.now() - CUSTOMER_CARD_KEEP_MS;
  let changed = false;
  Object.keys(m).forEach(id => { const t = m[id] && m[id].at ? new Date(m[id].at).getTime() : NaN; if(!(t >= cutoff)){ delete m[id]; changed = true; } });
  if(changed){ try{ await LocalDB.set(CUSTOMER_CARDS_KEY, m); }catch(e){} }
  return m;
}
// The customer was erased or merged on the server (NOT_FOUND): nothing of them stays on this counter.
async function forgetCustomerCard(id){
  try{
    const m = await loadCustomerCards();
    if(m[id]){ delete m[id]; await LocalDB.set(CUSTOMER_CARDS_KEY, m); }
  }catch(e){}
}
function savedCardTooOldForRewards(c){
  if(!c || !c.summaryOffline) return false;
  const t = c.summaryAt ? new Date(c.summaryAt).getTime() : NaN;
  return !(Date.now() - t <= CUSTOMER_CARD_REWARD_MS);
}
// Only what the counter needs offline: name, masked phone, visits and the stamp card. Never money.
function customerCardCopy(c){
  return {id: c.id, nickname: c.nickname, phone: c.phone || null, visits: c.visits, last_visit_at: c.last_visit_at || null,
    total_stamps: c.total_stamps, drink_stamps_earned: c.drink_stamps_earned, food_stamps_earned: c.food_stamps_earned,
    card: c.card || null, ready_rewards: Array.isArray(c.ready_rewards) ? c.ready_rewards : []};
}
async function saveCustomerCard(c){
  if(!c || !c.id) return;
  try{
    const m = await loadCustomerCards();
    m[c.id] = {c: customerCardCopy(c), at: new Date().toISOString()};
    const ids = Object.keys(m);
    if(ids.length > CUSTOMER_CARDS_MAX) ids.sort((a,b)=> String(m[a].at).localeCompare(String(m[b].at))).slice(0, ids.length - CUSTOMER_CARDS_MAX).forEach(id => delete m[id]);
    await LocalDB.set(CUSTOMER_CARDS_KEY, m);
  }catch(e){ console.warn('could not save the stamp card on this counter', e); }
}
// A reward used in a sale on this counter: take it off the saved card too (so offline it is not offered again).
async function forgetUsedReward(customerId, reward){
  try{
    const m = await loadCustomerCards();
    const e = m[customerId];
    if(!e || !e.c) return;
    e.c.ready_rewards = (e.c.ready_rewards || []).filter(r => rewardKey(r) !== rewardKey(reward));
    await LocalDB.set(CUSTOMER_CARDS_KEY, m);
  }catch(e){}
}
function hasLoyaltyData(c){ return !!(c && (c.card || Array.isArray(c.ready_rewards))); }
function setCustomerSummary(c, offline, at){
  const cur = posState.customer;
  if(!cur || cur.id !== c.id) return;
  if(c.nickname) cur.nickname = c.nickname;
  if(c.phone !== undefined) cur.phone = c.phone;
  if(c.visits !== undefined && c.visits !== null) cur.visits = Number(c.visits) || 0;
  if(hasLoyaltyData(c)){ cur.summary = customerCardCopy(c); cur.summaryOffline = !!offline; cur.summaryAt = at || new Date().toISOString(); }
}
// Put a customer on this order. c: {id, nickname, phone?, visits? | visit_count?, card?, ready_rewards?}.
function attachCustomer(c){
  if(!c || !c.id) return;
  const same = posState.customer && posState.customer.id === c.id;
  if(!same){
    posState.reward = null;
    posState.customer = {id: c.id, nickname: c.nickname || 'Customer', phone: c.phone || null,
      visits: c.visits != null ? Number(c.visits) || 0 : (c.visit_count != null ? Number(c.visit_count) || 0 : null),
      summary: null, summaryOffline: false, summaryAt: null};
  }
  if(hasLoyaltyData(c)) setCustomerSummary(c, false);
  renderCartPanel();
  if(!hasLoyaltyData(c)) refreshCustomerCard(c.id);
  else saveCustomerCard(c);
}
let customerCardRuns = {};
async function refreshCustomerCard(id){
  if(!id || customerCardRuns[id]) return;
  customerCardRuns[id] = true;
  try{
    // The saved copy is used ONLY when the server can't be reached. Any server answer wins:
    // NOT_FOUND (erased / merged) deletes the saved copy; other refusals just show no stamp card.
    if(isOnline()){
      try{
        const r = await cloud.rpc('fo_customer_detail', {p_customer_id: id, p_staff_token: null}, {timeout: 8000});
        if(r && r.customer){
          await saveCustomerCard(r.customer);
          setCustomerSummary(r.customer, false);
          renderCartPanel();
          return;
        }
        if(r && r.error === 'NOT_FOUND') await forgetCustomerCard(id);
        return;
      }catch(e){
        if(!e.offline){ console.warn('could not load the stamp card', e.message); return; }
      }
    }
    const saved = (await loadCustomerCards())[id];
    if(saved && saved.c && posState.customer && posState.customer.id === id && !posState.customer.summary){
      setCustomerSummary(saved.c, true, saved.at);
      renderCartPanel();
    }
  }finally{ delete customerCardRuns[id]; }
}
function initialOf(name){ const t = String(name || '').trim(); return t ? t.charAt(0).toUpperCase() : '?'; }
function visitsText(n){ n = Number(n) || 0; return `${n} visit${n===1?'':'s'}`; }
function cartCustomerHtml(){
  const c = posState.customer;
  if(!c) return `<button class="btn btn-outline cart-add-cust" id="cust-add">${icon('user')} Add customer (stamp card)</button>`;
  const view = c.summary && loyaltyOn() ? loyaltyCardView(c.summary) : null;
  const sub = [c.phone ? escapeHtml(c.phone) : '', c.visits != null ? visitsText(c.visits) : ''].filter(Boolean).join(' · ');
  const applied = posState.reward;
  const rewards = view ? usableRewards() : [];
  let rewardRow = '';
  if(view && rewards.length){
    rewardRow = `<div class="cart-rewards">${rewards.map(r=>{
      const on = applied && rewardKey(applied.reward) === rewardKey(r);
      return `<button class="reward-chip ${on?'on':''}" data-reward="${escapeHtml(rewardKey(r))}" aria-pressed="${on}">${icon(on?'check':'gift', {size: 16})}${escapeHtml(rewardLabel(r))} ${on?'applied':'ready'}</button>`;
    }).join('')}</div>`;
  }
  let note = '';
  if(view && c.summaryOffline && savedCardTooOldForRewards(c)) note = `<div class="cart-cust-note">${icon('wifi-off', {size: 16})}<span>The stamp card saved on this counter is more than 2 days old, so rewards can be used only when the counter is online. Stamps still count when the sale uploads.</span></div>`;
  else if(view && c.summaryOffline) note = `<div class="cart-cust-note">${icon('wifi-off', {size: 16})}<span>Stamp card saved ${escapeHtml(timeAgo(c.summaryAt))}. Rewards will be checked when online.</span></div>`;
  else if(!c.summary && loyaltyOn() && !isOnline()) note = `<div class="cart-cust-note">${icon('wifi-off', {size: 16})}<span>No saved stamp card for this customer on this counter. Stamps still count when the sale uploads.</span></div>`;
  return `<div class="customer-chip cart-cust">
      <span class="cust-av" aria-hidden="true">${escapeHtml(initialOf(c.nickname))}</span>
      <span class="cust-info"><b>${escapeHtml(c.nickname)}</b>${sub?`<small>${sub}</small>`:''}</span>
      ${view ? `<span class="stamp-chip" title="Stamps on this card">${view.stamps_on_card} / ${view.card_size}</span>` : ''}
      <button class="icon-btn" id="cust-remove" aria-label="Remove customer" title="Remove customer">${icon('x', {size: 18})}</button>
    </div>${rewardRow}${note}`;
}

function renderCartPanel(){
  const panel = document.getElementById('pos-cart-panel');
  if(!panel) return;
  checkAppliedReward();
  const totals = currentCartTotals();
  const q = posState.qrOrder;
  const a = posState.reward;
  const free = totals.grandTotal <= 0 && posState.cart.length > 0;
  panel.innerHTML = `
    <div class="pos-cart-head"><h3>${q?`QR ${escapeHtml(q.order_number)}`:'Current order'}</h3>${posState.cart.length?`<button class="btn btn-ghost btn-sm" id="clear-cart">${icon('trash', {size: 18})} Clear</button>`:''}</div>
    ${q?`<div class="cart-qr-banner">${icon('qr', {size: 18})}<span>${escapeHtml(q.table_label||'')} · ${escapeHtml(q.order_type==='TAKEAWAY'?'Takeaway':'Dine-in')}${q.customer_note?`<span class="text-light"> · “${escapeHtml(q.customer_note)}”</span>`:''}</span></div>`:''}
    <div class="cart-customer">${cartCustomerHtml()}</div>
    <div class="pos-cart-items" id="cart-items">
      ${posState.cart.length===0 ? `<div class="cart-empty">${icon('cup', {size: 36})}<p>No items yet.<br>Tap a product to add it.</p>${lastReceiptButtonHtml()}</div>` :
      posState.cart.map(line=>`
        <div class="cart-line" data-line="${line.lineId}">
          <div class="cart-line-top">
            <div class="cart-line-main"><div class="cart-line-name">${escapeHtml(line.name)}</div>
              ${line.modifiers.length?`<div class="cart-line-mods">${line.modifiers.map(m=>escapeHtml(m.label)).join(' · ')}</div>`:''}
              ${line.notes?`<div class="cart-line-mods">“${escapeHtml(line.notes)}”</div>`:''}
              ${a && a.reward.type==='FREE_ITEM' && a.recipe_id===line.recipe_id && posState.cart.find(l=>l.recipe_id===a.recipe_id)===line ? `<div class="cart-line-free">${icon('gift', {size: 14})} One free (stamp reward)</div>` : ''}</div>
            <div class="cart-line-price">${fmtMoney(cartLineTotal(line))}</div>
          </div>
          <div class="cart-line-controls">
            <button class="qty-btn" data-dec="${line.lineId}" aria-label="One less ${escapeHtml(line.name)}">${icon('minus', {size: 18})}</button><span class="qty-val">${line.quantity}</span><button class="qty-btn" data-inc="${line.lineId}" aria-label="One more ${escapeHtml(line.name)}">${icon('plus', {size: 18})}</button>
            <button class="btn btn-ghost btn-sm" data-edit-line="${line.lineId}" style="margin-left:auto;">${icon('edit', {size: 18})} Edit</button>
            <button class="btn btn-ghost btn-sm icon-only" data-remove="${line.lineId}" aria-label="Remove ${escapeHtml(line.name)}">${icon('trash', {size: 18})}</button>
          </div>
        </div>`).join('')}
    </div>
    <div class="pos-cart-summary">
      <div class="row"><span>Subtotal</span><span>${fmtMoney(totals.subtotal)}</span></div>
      <div class="row"><span>Discount ${posState.discount?`(${posState.discount.type==='percent'?posState.discount.value+'%':fmtMoney(posState.discount.value)})`:''}</span>
        <span>${totals.discountAmt>0?'-'+fmtMoney(totals.discountAmt):fmtMoney(0)} ${!posState.discount?`<a class="linklike" id="add-discount-link" role="button" tabindex="0">add</a>`:`<a class="linklike" id="remove-discount-link" role="button" tabindex="0">remove</a>`}</span></div>
      ${a?`<div class="row reward" id="reward-row"><span class="rw-label">${icon('gift', {size: 16})}<span>Stamp reward · ${escapeHtml(rewardLineName(a))}${a.offline?' <small>(checked when online)</small>':''}</span></span>
        <span class="rw-amt">-${fmtMoney(totals.loyaltyDiscount)} <a class="linklike" id="reward-remove" role="button" tabindex="0">remove</a></span></div>`:''}
      ${state.settings.tax_pct>0?`<div class="row"><span>Tax (${state.settings.tax_pct}%${state.settings.tax_inclusive?' incl.':''})</span><span>${fmtMoney(totals.tax)}</span></div>`:''}
      ${state.settings.service_charge_pct>0?`<div class="row"><span>Service charge (${state.settings.service_charge_pct}%)</span><span>${fmtMoney(totals.serviceCharge)}</span></div>`:''}
      <div class="row total"><span class="total-label">Total</span><span class="total-amount">${fmtMoney(totals.grandTotal)}</span></div>
    </div>
    <div class="pos-cart-foot">
      <button class="btn-hold" id="hold-order-btn" ${posState.cart.length===0||q?'disabled':''}>${icon('inbox', {size: 20})} Hold</button>
      <button class="btn-disc" id="cart-discount-btn" ${posState.cart.length===0?'disabled':''}>${posState.discount?'Remove discount':'Discount'}</button>
      <button class="btn-checkout" id="checkout-btn" ${posState.cart.length===0?'disabled':''}>${posState.cart.length===0 ? 'Charge' : free ? 'Complete sale (nothing to pay)' : 'Charge ' + fmtMoney(totals.grandTotal)}</button>
    </div>`;
  panel.querySelectorAll('[data-inc]').forEach(b=> b.onclick = ()=>{ const l=posState.cart.find(x=>x.lineId===b.dataset.inc); l.quantity++; renderCartPanel(); });
  panel.querySelectorAll('[data-dec]').forEach(b=> b.onclick = ()=>{ const l=posState.cart.find(x=>x.lineId===b.dataset.dec); l.quantity--; if(l.quantity<=0) posState.cart=posState.cart.filter(x=>x.lineId!==l.lineId); renderCartPanel(); });
  panel.querySelectorAll('[data-remove]').forEach(b=> b.onclick = ()=>{ posState.cart = posState.cart.filter(x=>x.lineId!==b.dataset.remove); renderCartPanel(); });
  panel.querySelectorAll('[data-edit-line]').forEach(b=> b.onclick = ()=>{
    const line = posState.cart.find(x=>x.lineId===b.dataset.editLine);
    const recipe = state.recipes.find(r=>r.id===line.recipe_id);
    if(recipe && recipeOptionGroups(recipe).length && line.selections) openModifierPicker(recipe, line);
    else editLineNote(line);
  });
  panel.querySelectorAll('[data-reward]').forEach(b=> b.onclick = ()=>{
    const on = posState.reward && rewardKey(posState.reward.reward) === b.dataset.reward;
    if(on){ posState.reward = null; renderCartPanel(); toast('Stamp reward removed'); }
    else applyReward(b.dataset.reward);
  });
  const clickish = (el, fn)=>{ if(!el) return; el.onclick = fn; el.onkeydown = (e)=>{ if(e.key==='Enter' || e.key===' '){ e.preventDefault(); fn(); } }; };
  const clearBtn = document.getElementById('clear-cart');
  if(clearBtn) clearBtn.onclick = async ()=>{ const ok = await confirmDialog(q?'Close this QR order without taking payment? (It stays on the QR board.)':'Clear the current order?'); if(ok){ clearCart(); renderCartPanel(); } };
  clickish(document.getElementById('add-discount-link'), openDiscountPicker);
  clickish(document.getElementById('remove-discount-link'), ()=>{ posState.discount=null; renderCartPanel(); });
  clickish(document.getElementById('reward-remove'), ()=>{ posState.reward = null; renderCartPanel(); toast('Stamp reward removed'); });
  const discBtn = document.getElementById('cart-discount-btn');
  if(discBtn) discBtn.onclick = ()=>{ if(posState.discount){ posState.discount = null; renderCartPanel(); } else openDiscountPicker(); };
  const custAdd = document.getElementById('cust-add'); if(custAdd) custAdd.onclick = ()=>openCustomerPicker();
  const custRm = document.getElementById('cust-remove'); if(custRm) custRm.onclick = ()=>{ posState.customer = null; renderCartPanel(); };
  const holdBtn = document.getElementById('hold-order-btn'); if(holdBtn) holdBtn.onclick = holdCurrentOrder;
  const checkoutBtn = document.getElementById('checkout-btn'); if(checkoutBtn) checkoutBtn.onclick = openCheckout;
  const lastBtn = document.getElementById('print-last'); if(lastBtn) lastBtn.onclick = ()=> showReceipt(lastBtn.dataset.sale, {first: true});
  // Phone-size screens: the order sits below the menu, so a bar at the bottom jumps to it.
  const jump = document.getElementById('cart-jump');
  if(jump){
    const n = posState.cart.reduce((s,l)=> s + (Number(l.quantity)||0), 0);
    jump.hidden = !n;
    jump.innerHTML = `<span>View order · ${n} item${n===1?'':'s'}</span><span>${fmtMoney(totals.grandTotal)}</span>`;
  }
}
// After a sale (cart empty): one tap prints that sale's receipt.
function lastReceiptButtonHtml(){
  const s = posState.lastSaleId && state.sales.find(x=>x.id===posState.lastSaleId && x.status!=='HELD');
  if(!s) return '';
  return `<button class="btn btn-outline print-last" id="print-last" data-sale="${escapeHtml(s.id)}">${icon('printer', {size: 18})} Print receipt</button>
    <small class="print-last-no">Last sale ${escapeHtml(s.transaction_number||'')}</small>`;
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
// opts.onPick(customer): what happens with the chosen / new customer (default: put them on this order).
// opts.newOnly: open straight on the "New customer" form (Customers screen → Add customer).
function openCustomerPicker(opts){
  opts = opts || {};
  if(!isOnline()){ toast(opts.newOnly ? 'Adding a customer needs the internet.' : 'Finding customers needs the internet. You can still finish the sale without one.', 'warn'); return; }
  const SEARCH_HINT = 'Name, last 4 digits or full number';
  openModal({title: opts.newOnly ? 'New customer' : 'Add customer', body:`
    <div class="form-row" ${opts.newOnly?'hidden':''}><label for="cp-q">Find a customer</label><input id="cp-q" placeholder="${SEARCH_HINT}" autocomplete="off"></div>
    <div id="cp-results" class="cp-results" ${opts.newOnly?'hidden':''}><p class="hint">${SEARCH_HINT}.</p></div>
    <details class="cp-new" ${opts.newOnly?'open':''}><summary>${icon('plus', {size: 18})} New customer</summary>
      <div class="form-grid" style="margin-top:10px;">
        <div class="form-row"><label>Nickname</label><input id="cp-name" maxlength="30"></div>
        <div class="form-row"><label>Mobile (optional)</label><input id="cp-phone" inputmode="tel" placeholder="0917 123 4567"></div>
      </div>
      <p class="hint">Ask the customer first: “Can we save your name and number for your rewards?”</p>
      <label class="cp-consent" for="cp-consent"><input type="checkbox" id="cp-consent"> <span>The customer agreed to be added to our loyalty list</span></label>
      <button class="btn btn-primary" id="cp-create">Save customer</button>
    </details>`,
  foot:`<button class="btn btn-outline" data-cancel>Close</button>`,
  onMount:(root)=>{
    root.querySelector('[data-cancel]').onclick = closeModal;
    const results = root.querySelector('#cp-results');
    const pick = (c)=>{
      closeModal();
      if(opts.onPick){ opts.onPick(c); return; }
      attachCustomer(c); toast(`${c.nickname} added to this sale`);
    };
    // Too many look-ups by phone number from this counter (the server limits them so
    // hidden digits can't be guessed): searching by name still works.
    const isLimited = (code)=> /TOO_MANY_ATTEMPTS/.test(String(code||''));
    let lastQ = '', lastList = [], showArchived = false;
    // Release 1.5 (B6): customers without a phone number are archived. They are left out of the
    // matches unless staff tap "Show archived" (the data is kept; they can still be used).
    const isArchived = (c)=> c.archived === true || !c.phone;
    const showResults = ()=>{
      const list = lastList;
      if(!list.length){ results.innerHTML = '<p class="hint">No match. Add them as a new customer below.</p>'; return; }
      const shown = showArchived ? list : list.filter(c => !isArchived(c));
      const hidden = list.length - shown.length;
      // Phone numbers come from the server already masked (e.g. 0917 ••• 4567); shown as received.
      results.innerHTML = (shown.length ? shown.map(c=>`<button class="cp-row" data-id="${escapeHtml(c.id)}"><b>${escapeHtml(c.nickname)}</b><span class="text-light">${c.phone?escapeHtml(c.phone):'no phone · archived'} · ${visitsText(c.visit_count)}</span></button>`).join('')
          : '<p class="hint">No match with a phone number.</p>')
        + (hidden ? `<button class="btn btn-outline btn-sm cp-arch" id="cp-show-arch">Show ${hidden} archived (no phone)</button>` : '');
      results.querySelectorAll('[data-id]').forEach(b=> b.onclick = ()=> pick(list.find(c=>c.id===b.dataset.id)));
      const sa = results.querySelector('#cp-show-arch');
      if(sa) sa.onclick = ()=>{ showArchived = true; showResults(); };
    };
    const search = debounce(async (q)=>{
      lastQ = q;
      if(q.length<2){ results.innerHTML = `<p class="hint">${SEARCH_HINT}.</p>`; return; }
      results.innerHTML = '<p class="hint">Searching…</p>';
      try{
        const list = await cloud.rpc('search_customers', {p_q: q, p_limit: 15});
        if(q !== lastQ) return;                                 // a newer search is on its way
        lastList = list || [];
        showResults();
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
    setTimeout(()=>root.querySelector(opts.newOnly ? '#cp-name' : '#cp-q').focus(), 50);
  }});
}

/* ================= Held orders ================= */
async function holdCurrentOrder(){
  if(posState.cart.length===0 || posState.qrOrder) return;
  // A held order never keeps a stamp reward (the server ignores it on a held sale): say so, and drop it.
  if(posState.reward){
    posState.reward = null;
    toast('Held orders don\'t keep a stamp reward. Apply it again when you finish this order.', 'warn');
  }
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
// A held line's options as picker choices (1.4 modifiers keep group_id + option_id), so "Edit"
// can open the option sheet again. Older lines without ids: none (Edit changes the note only).
function heldSelections(mods){
  const list = Array.isArray(mods) ? mods : [];
  if(!list.length || !list.every(m => m && m.group_id && m.option_id)) return undefined;
  return list.map(m => ({group_id: m.group_id, option_id: m.option_id}));
}
function showHeldOrders(){
  const held = state.sales.filter(s=>s.status==='HELD').sort((a,b)=> new Date(b.transaction_date)-new Date(a.transaction_date));
  openModal({title:'Held orders', body: held.length? `<div class="grid grid-2">${held.map(s=>{
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
          unit_price: Number(it.unit_price), quantity: Number(it.quantity), modifiers: it.modifiers||[], notes: it.notes||'',
          selections: heldSelections(it.modifiers)}));
        posState.resumingHeldSaleId = saleId;
        posState.customer = null; posState.reward = null;
        closeModal(); navigatePOS('pos');
        if(s && s.customer_id) attachCustomer({id: s.customer_id, nickname: 'Customer'});
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

/* ================= Stock check before payment (release 1.3, Q6) =================
   Owner decision 2026-11-02: items that ran out must be REMOVED before payment (counter
   sales and QR orders alike; no "Add anyway?"). The shared cartStockProblems() checks the
   whole cart against this counter's stock (recipe + option extras, summed over the cart).
   Offline it uses the last stock this counter knows, and says so. */
function stockNeedText(p){
  if(p.sold_out) return 'Marked sold out';
  return p.short_ingredients.map(si=>{
    const ing = ingredientById(si.ingredient_id);
    const u = ing ? ing.base_unit : '';
    return `needs ${formatQuantity(si.needed, u)} ${si.name}, ${Number(si.available) > 0 ? formatQuantity(si.available, u) + ' left' : 'none left'}`;
  }).join('; ');
}
// The largest quantity (below the line's own) that fits the stock with the rest of the cart, or 0.
function stockFitQuantity(p){
  if(p.sold_out || Number(p.line.quantity) <= 1) return 0;
  const line = p.line;
  for(let q = Number(line.quantity) - 1; q >= 1; q--){
    const test = posState.cart.map(l => l === line ? Object.assign({}, l, {quantity: q}) : l);
    if(!cartStockProblems(test).some(x => x.index === p.index)) return q;
  }
  return 0;
}
// true = the cart can be paid. false = the stock dialog is open (onReady runs when it is fixed).
function cartStockOk(onReady){
  if(!posState.cart.length || !cartStockProblems(posState.cart).length) return true;
  openStockProblems(onReady);
  return false;
}
function openStockProblems(onReady, opts){
  opts = opts || {};
  const q = posState.qrOrder;
  const problems = cartStockProblems(posState.cart);
  const offline = !isOnline();
  const left = posState.cart.length;
  const note = offline
    ? `<div class="notice warn">${icon('wifi-off', {size: 18})} This counter is offline, so these stock numbers are from its last update and may be out of date.</div>`
    : '';
  let body, foot;
  if(problems.length){
    body = `${note}<p class="stock-intro">${q ? `Some items on QR order <b>${escapeHtml(q.order_number)}</b> ran out after it was placed.` : 'Some items on this order are out of stock.'}
        Remove them${problems.some(p => stockFitQuantity(p)) ? ' or make fewer' : ''} before taking payment.${q ? ' Tell the customer which items are not available.' : ''}</p>
      <div class="stock-list">${problems.map(p=>{
        const fit = stockFitQuantity(p);
        const line = p.line;
        return `<div class="stock-row" data-stock-line="${escapeHtml(line.lineId)}">
          <div class="stock-main"><b>${Number(line.quantity)} × ${escapeHtml(line.name)}</b>
            ${(line.modifiers||[]).length ? `<small>${line.modifiers.map(m=>escapeHtml(m.label)).join(' · ')}</small>` : ''}
            <span class="stock-why">${escapeHtml(stockNeedText(p))}</span></div>
          <div class="stock-acts">
            ${fit ? `<button class="btn btn-outline" data-stock-fit="${escapeHtml(line.lineId)}" data-qty="${fit}">Make it ${fit}</button>` : ''}
            <button class="btn btn-danger" data-stock-rm="${escapeHtml(line.lineId)}">${icon('trash', {size: 18})} Remove</button>
          </div></div>`;
      }).join('')}</div>
      ${problems.filter(p => p.short_ingredients.length).length > 1 ? '<p class="hint">Amounts needed are for the whole order.</p>' : ''}`;
    foot = `<button class="btn btn-outline" data-cancel>Back to order</button>${offline ? '' : `<button class="btn btn-outline" id="stock-recheck">${icon('refresh', {size: 18})} Check stock again</button>`}`;
  } else if(left){
    body = `<p>${icon('check', {size: 18})} Everything left on the order is in stock. Total now: <b>${fmtMoney(currentCartTotals().grandTotal)}</b>.</p>`;
    foot = `<button class="btn btn-outline" data-cancel>Back to order</button>${onReady ? '<button class="btn btn-primary btn-big" id="stock-pay">Take payment</button>' : ''}`;
  } else {
    body = `<p>Nothing is left on this order.${q ? ' You can reject the QR order on the QR orders screen and tell the customer why.' : ''}</p>`;
    foot = `<button class="btn btn-primary" data-cancel>OK</button>`;
  }
  openModal({title: problems.length ? 'Out of stock: remove before payment' : 'Ready to pay', body, foot, onMount: (root)=>{
    root.querySelector('[data-cancel]').onclick = closeModal;
    const again = ()=>{ renderCartPanel(); openStockProblems(onReady); };
    root.querySelectorAll('[data-stock-rm]').forEach(b=> b.onclick = ()=>{
      const line = posState.cart.find(l => l.lineId === b.dataset.stockRm);
      posState.cart = posState.cart.filter(l => l.lineId !== b.dataset.stockRm);
      if(line) toast(`Removed ${line.name}`);
      again();
    });
    root.querySelectorAll('[data-stock-fit]').forEach(b=> b.onclick = ()=>{
      const line = posState.cart.find(l => l.lineId === b.dataset.stockFit);
      if(line) line.quantity = Number(b.dataset.qty) || line.quantity;
      again();
    });
    const re = root.querySelector('#stock-recheck');
    if(re) re.onclick = async ()=>{
      re.disabled = true;
      const ok = await refreshStockQuietly();
      if(!ok) toast('Could not reach the server just now. Using the stock on this counter.', 'warn');
      again();
    };
    const pay = root.querySelector('#stock-pay');
    if(pay) pay.onclick = ()=>{ closeModal(); if(onReady) onReady(); };
  }});
}

/* ================= Checkout ================= */
const PAY_METHOD_ICONS = {CASH:'cash', GCASH:'phone', MAYA:'phone', CARD:'card', OTHER:'receipt'};
function openCheckout(){
  if(posState.cart.length===0) return;
  if(!cartStockOk(openCheckout)) return;                 // out-of-stock items must be removed first (Q6)
  checkAppliedReward();
  const totals = currentCartTotals();
  // The stamp reward covers everything: nothing to pay, one tap finishes the sale.
  if(totals.grandTotal <= 0){ openFreeCheckout(totals); return; }
  let method = 'CASH';
  let tendered = 0;
  const a = posState.reward;
  const body = `
    <div class="checkout-due"><div class="lbl">Total due</div>
      <div class="val">${fmtMoney(totals.grandTotal)}</div>
      ${a?`<div class="checkout-reward">${icon('gift', {size: 16})} Stamp reward: -${fmtMoney(totals.loyaltyDiscount)} (${escapeHtml(rewardLineName(a))})</div>`:''}</div>
    <div class="pay-methods five" id="pay-methods">
      ${PAYMENT_METHODS.map((m,i)=>`<button class="pay-method-btn ${i===0?'selected':''}" data-method="${m.id}">${icon(PAY_METHOD_ICONS[m.id] || 'receipt', {size: 26})}<span>${escapeHtml(m.label)}</span></button>`).join('')}
    </div>
    <div id="pay-detail"></div>`;
  const foot = `<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" id="complete-sale-btn">Complete sale</button>`;
  openModal({title:'Checkout', body, foot, onMount:(root)=>{
    root.querySelector('[data-cancel]').onclick = closeModal;
    const detailWrap = root.querySelector('#pay-detail');
    function renderDetail(){
      if(method==='CASH'){
        const quick = [...new Set([totals.grandTotal, 100, 200, 500, 1000].filter(v=>v>=totals.grandTotal || v===totals.grandTotal))].slice(0,5);
        detailWrap.innerHTML = `
          <div class="form-row"><label>Cash received</label><input type="number" step="any" inputmode="decimal" id="cash-tendered" placeholder="0.00"></div>
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
      if(cartStockProblems(posState.cart).length){ closeModal(); openStockProblems(openCheckout); return; }
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
      if(done) printAfterSale(done.sale.id, {customerName: done.customerName});
    };
  }});
}

// Nothing to pay (the stamp reward covers the whole order): confirm and finish, no payment step.
function openFreeCheckout(totals){
  // Only a reward that actually takes something off "covers" the order; any other ₱0 total
  // (e.g. a 100% approved discount) gets neutral words.
  const a = posState.reward && totals.loyaltyDiscount > 0 ? posState.reward : null;
  openModal({title: 'Nothing to pay', body: `
    <div class="checkout-due"><div class="lbl">Total due</div><div class="val">${fmtMoney(0)}</div>
      ${a?`<div class="checkout-reward">${icon('gift', {size: 16})} Stamp reward: -${fmtMoney(totals.loyaltyDiscount)} (${escapeHtml(rewardLineName(a))})</div>`:''}</div>
    <p>${a ? `The stamp reward covers this whole order, so the customer pays nothing.${a.offline ? ' The reward will be checked when the counter is online.' : ''}` : 'The total is ₱0.00, so the customer pays nothing.'}</p>`,
    foot: `<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary btn-big" id="complete-sale-btn">Complete sale</button>`,
    onMount: (root)=>{
      root.querySelector('[data-cancel]').onclick = closeModal;
      root.querySelector('#complete-sale-btn').onclick = async (ev)=>{
        if(cartStockProblems(posState.cart).length){ closeModal(); openStockProblems(openCheckout); return; }
        ev.currentTarget.disabled = true;
        if(posState.qrOrder && await qrOrderPaidOnServer(posState.qrOrder)){
          const paidOrder = posState.qrOrder;
          closeModal(); clearCart(); navigatePOS('qr');
          await showQrAlreadyPaid(paidOrder);
          return;
        }
        const done = await completeSale({method: 'OTHER', amount: 0, tendered: null, change: null, reference: a ? 'Stamp reward (nothing to pay)' : 'Nothing to pay'});
        closeModal();
        if(done) printAfterSale(done.sale.id, {customerName: done.customerName});
      };
    }});
}
// The words for the stamp reward a sale used (for its receipt), from the shop's stamp card.
function saleRewardLabel(sale){
  const lr = sale && sale.loyalty_reward;
  if(!lr || !(Number(sale.loyalty_discount) > 0)) return '';
  const r = loyaltyConfig().rewards.find(x => Number(x.stamp) === Number(lr.milestone));
  return r ? rewardLabel(r) : '';
}

// Recomputes totals fresh from the cart + discount + reward + settings (never trusts earlier UI numbers).
async function completeSale(paymentInfo){
  const now = new Date().toISOString();
  checkAppliedReward();
  let totals = currentCartTotals();
  // A reward that takes nothing off (e.g. a 100% discount) is not used up.
  if(posState.reward && !(totals.loyaltyDiscount > 0)){ posState.reward = null; totals = currentCartTotals(); }
  const applied = posState.reward;
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
  // Stamp reward (contract D): {loyalty_reward:{customer_id, card_no, milestone, recipe_id}, loyalty_discount}.
  // Without one: loyalty_discount 0. The server checks it and refuses the whole sale if it doesn't fit.
  Object.assign(sale, saleLoyaltyFields(applied ? applied.reward : null, applied ? sale.customer_id : null, totals.loyaltyDiscount, applied ? applied.recipe_id : null));
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
  if(applied && sale.loyalty_reward){
    forgetUsedReward(sale.customer_id, applied.reward);
    if(posState.customer && posState.customer.summary) posState.customer.summary.ready_rewards = (posState.customer.summary.ready_rewards || []).filter(r => rewardKey(r) !== rewardKey(applied.reward));
  }
  posState.lastSaleId = sale.id;          // "Print receipt" on the empty order
  clearCart();
  navigatePOS(q ? 'qr' : 'pos');
  toast(`Sale ${sale.transaction_number} completed`, 'success');
  return {sale, customerName, qrOrder: q, rewardLabel: applied ? rewardLabel(applied.reward) : ''};
}

/* ================= Printing: receipts, barista tickets, shift reports (1.3 P1, 1.4) =================
   Everything prints through the shared Printer (shared/printer.js) to the receipt printer
   chosen on this counter (USB cable, Bluetooth or a printer port), one job at a time.
   Release 1.4 (owner: "print automatically, don't prompt me to save it as PDF"):
   - NOTHING opens the browser's print screen by itself. When a print fails or no printer is
     connected, the cashier sees a plain message with "Reconnect", "Printer screen" and
     "Use print screen"; only that last tap opens the print screen.
   - Printing never blocks or undoes anything: the sale / shift close is saved first.
   Automatic prints (switches on the Printer screen, saved on this counter only):
     auto_print         receipt after each sale (off unless turned on)
     auto_print_ticket  barista ticket after each sale (not again for a QR order whose
                        ticket already printed when it arrived)
     auto_print_qr      ticket when a QR order arrives (each order once: see qrTicketLog)
     auto_print_shift   Z report right after the shift is closed
   Tickets / QR / Z only print by themselves once a printer has been chosen on this counter;
   the receipt switch (turned on on purpose) says so when there is no printer. */
function receiptParts(saleId, dataset, opts){
  dataset = dataset || state;
  const sale = dataset.sales.find(s=>s.id===saleId);
  if(!sale) return null;
  const items = dataset.saleItems.filter(i=>i.sale_id===saleId);
  const payments = dataset.payments.filter(p=>p.sale_id===saleId);
  const qr = sale.qr_order_id ? state.qrOrders.find(o=>o.id===sale.qr_order_id) : null;
  const customerName = (opts && opts.customerName) || (qr ? qr.customer_nickname : null);
  return {sale, items, payments, ropts: {qrOrder: qr, customerName, rewardLabel: saleRewardLabel(sale)}};
}
// The browser's print screen with this receipt (only from a "Use print screen" tap).
function openReceiptScreen(parts, autoPrint){
  return openPrintWindow(receiptHtml(parts.sale, parts.items, parts.payments, parts.ropts), autoPrint);
}
// Is a USB / Bluetooth / port printer set up that this browser can use?
function printerDirect(){
  if(typeof Printer === 'undefined') return false;
  if(typeof Printer.isDirect === 'function') return !!Printer.isDirect();
  const s = Printer.status();
  return (s.connection === 'usb' && s.support.usb) || (s.connection === 'bluetooth' && s.support.bluetooth) || (s.connection === 'serial' && s.support.serial);
}
// Has a printer been chosen on this counter (even if it isn't reachable right now)?
function printerChosen(){ return typeof Printer !== 'undefined' && Printer.settings().connection !== 'dialog'; }
// Can this browser print straight to a receipt printer at all (USB, Bluetooth or a port)?
// No on iPad / iPhone and Safari: there, automatic prints skip quietly (one gentle note per session).
function canPrintDirectHere(){
  if(typeof Printer === 'undefined') return false;
  const s = Printer.support();
  return !s.apple_mobile && !!(s.usb || s.bluetooth || s.serial);
}
const AUTO_PRINT_NOTE_KEY = 'cccc.print.autoNote';
function autoPrintNoteOnce(){
  try{ if(sessionStorage.getItem(AUTO_PRINT_NOTE_KEY)) return; sessionStorage.setItem(AUTO_PRINT_NOTE_KEY, '1'); }catch(e){}
  toast('Automatic printing needs a computer with Google Chrome and a USB receipt printer. Here, tap Print receipt (or Print ticket) to use the print screen.', 'warn');
}

/* ---- print jobs ----
   job: {label: 'The receipt', title: 'The receipt did not print', name: 'Receipt T-0001',
         run(again) -> Printer answer {ok, partial, error, message, ...},
         screen() -> opens the print screen (runs straight from the "Use print screen" tap)} */
function receiptJob(parts, extra){
  let drawerDone = !!(extra && extra.openDrawer === false);
  return {label: 'The receipt', title: 'The receipt did not print', name: 'Receipt ' + (parts.sale.transaction_number || ''),
    run: async ()=>{
      // The drawer opens at most once per sale, however often the receipt is retried.
      const o = Object.assign({}, parts.ropts, extra || {});
      if(drawerDone) o.openDrawer = false;
      const r = await Printer.printReceipt(parts.sale, parts.items, parts.payments, o);
      if(r && r.drawer_kick_sent) drawerDone = true;
      return r;
    },
    screen: ()=> openReceiptScreen(parts, true)};
}
// The barista ticket of a counter sale (no prices).
function saleTicketOrder(parts){
  const s = parts.sale;
  return {transaction_number: s.transaction_number, transaction_date: s.transaction_date, created_at: s.transaction_date, source: 'COUNTER',
    customer_nickname: parts.ropts.customerName || '', paid_at: s.transaction_date,
    items: parts.items.map(i=>({name: i.name, quantity: i.quantity, modifiers: i.modifiers || [], notes: i.notes || ''}))};
}
function ticketJob(order, topts, onPrinted){
  const no = order.order_number || order.transaction_number || '';
  return {label: 'The order ticket', title: 'The order ticket did not print', name: 'Order ticket ' + no,
    run: async ()=>{
      const r = await Printer.printTicket(order, topts);
      if(r && r.ok && onPrinted) onPrinted(r);
      return r;
    },
    screen: ()=> openPrintWindow(ticketHtml(order, topts), true)};
}
function shiftReportJob(shiftId, isX){
  const get = ()=> state.shifts.find(s=>s.id===shiftId);
  const report = ()=>{ const sh = get(); return {shift: sh, metrics: shiftMetrics(sh), isX: !!isX, device_name: state.device ? state.device.device_name : ''}; };
  return {label: isX ? 'The X-report' : 'The shift report', title: isX ? 'The X-report did not print' : 'The shift report did not print',
    name: (isX ? 'X-report ' : 'Shift report ') + ((get() || {}).shift_number || ''),
    run: async ()=>{ if(!get()) return {ok: false, error: 'Shift not found on this counter.'}; return Printer.printShiftReport(report(), {isX: !!isX}); },
    screen: ()=>{ const sh = get(); if(sh) openPrintWindow(shiftReportHtml(sh, shiftMetrics(sh), !!isX), true); }};
}
// Plain words for a failed print.
function printProblemText(res){
  if(!res) return 'Printing failed.';
  if(res.message) return String(res.message);
  if(res.error && res.error !== 'NOT_CONNECTED') return String(res.error);
  return 'No receipt printer is connected. Open the Printer screen and tap Connect USB printer.';
}
// Runs jobs in order. The first one that fails stops the rest (the printer is probably down)
// and the cashier gets ONE message for all of them. ctx: {okToast, saved, onProblem(problem)}.
async function runPrintJobs(jobs, ctx){
  ctx = ctx || {};
  if(typeof Printer === 'undefined' || !jobs.length) return true;
  // A print the cashier TAPPED, on a counter without a usable receipt printer (iPad, Safari, or
  // none chosen): that is the person asking, so the print screen opens straight away (still
  // inside the tap, before anything is awaited, so the browser allows the window).
  if(ctx.manual && !printerDirect()){ jobs[0].screen(); return true; }
  for(let i = 0; i < jobs.length; i++){
    let res;
    try{ res = await jobs[i].run(); }
    catch(e){ res = {ok: false, partial: false, error: friendlyError(e), message: friendlyError(e)}; }
    if(res && res.ok) continue;
    const problem = {jobs: jobs.slice(i), res: res || {ok: false}, saved: ctx.saved || ''};
    if(ctx.onProblem) ctx.onProblem(problem); else showPrintProblem(problem);
    return false;
  }
  if(ctx.okToast) toast(ctx.okToast);
  return true;
}
// Try the printer again from a tap: a USB printer the browser forgot (or none chosen yet, on a
// browser with USB) opens the USB chooser; otherwise a quiet reconnect. -> true when connected.
async function reconnectPrinterFromTap(){
  const s = Printer.status();
  try{
    if(s.support && s.support.usb && (s.usb_needs_tap || s.connection === 'dialog')){
      const st = await Printer.chooseUsb();
      queueAudit('Receipt printer connected', (st && st.name) || '');
      return true;
    }
    if(s.connection === 'dialog') return false;
    return !!(await Printer.reconnect());
  }catch(e){ return false; }
}
// The message box for a failed print. Only one at a time: problems that come in while it (or
// another box) is open wait, so a print problem never closes what the cashier is doing.
let printProblems = [], printProblemTimer = null;
function modalOpenNow(){
  return !!document.getElementById('active-modal-overlay') || document.getElementById('pin-gate').style.display !== 'none';
}
function showPrintProblem(problem){
  if(problem) printProblems.push(problem);
  if(!printProblems.length) return;
  const own = document.getElementById('print-problem');
  if(modalOpenNow() && !own){
    if(problem) toast(problem.jobs[0].label + ' did not print. ' + printProblemText(problem.res), 'warn');
    if(!printProblemTimer) printProblemTimer = setInterval(()=>{
      if(!printProblems.length){ clearInterval(printProblemTimer); printProblemTimer = null; return; }
      if(!modalOpenNow()){ clearInterval(printProblemTimer); printProblemTimer = null; showPrintProblem(null); }
    }, 1500);
    return;
  }
  const first = printProblems[0];
  const jobs = [].concat(...printProblems.map(p=>p.jobs));
  const res = first.res;
  const partial = !!res.partial;
  const msg = printProblemText(res).replace(/^Printing stopped part-way\.\s*/, '');
  const title = partial ? 'Printing stopped part-way' : first.jobs[0].title;
  const saved = [...new Set(printProblems.map(p=>p.saved).filter(Boolean))].join(' ');
  const what = first.jobs[0].label.replace(/^The /, 'the ');
  openModal({title: escapeHtml(title), body: `<div id="print-problem">
      <div class="notice warn">${escapeHtml(msg)}</div>
      <p>${partial ? `Part of ${escapeHtml(what)} came out. Check the printer has paper and is switched on, then print again, or use the print screen.` : 'Fix the printer and tap Reconnect, or use the print screen.'}${saved ? ' ' + escapeHtml(saved) : ''}</p>
      ${jobs.length > 1 ? `<p class="hint">Not printed:</p><ul class="pr-todo">${jobs.map(j=>`<li>${escapeHtml(j.name)}</li>`).join('')}</ul><p class="hint">Use print screen opens the first one (${escapeHtml(jobs[0].name)}).</p>` : ''}</div>`,
    foot: `<button class="btn btn-outline" data-cancel>Close</button><button class="btn btn-outline" id="pr-setup">${icon('settings')} Printer screen</button><button class="btn btn-outline" id="pr-dialog">${icon('receipt')} Use print screen</button>${partial ? `<button class="btn btn-primary" id="pr-again">${icon('printer')} Print again</button>` : `<button class="btn btn-primary" id="pr-reconnect">${icon('refresh')} Reconnect</button>`}`,
    onClose: ()=>{ printProblems = []; },
    onMount: (root)=>{
      root.querySelector('[data-cancel]').onclick = closeModal;
      root.querySelector('#pr-setup').onclick = ()=>{ closeModal(); navigatePOS('printer'); };
      // The print screen for the first one only (one window per tap; the others are not asked
      // about again: they can be printed later, e.g. "Reprint ticket" on a QR order).
      root.querySelector('#pr-dialog').onclick = ()=>{ closeModal(); jobs[0].screen(); };
      const retry = async (btn, reconnect)=>{
        btn.disabled = true;
        if(reconnect){
          btn.textContent = 'Connecting…';
          const ok = await reconnectPrinterFromTap();
          if(!ok){
            btn.disabled = false; btn.innerHTML = `${icon('refresh')} Reconnect`;
            toast(Printer.status().last_error || 'Couldn\'t reach the printer. Check it is switched on (and plugged in, or close by), then try again.', 'warn');
            return;
          }
        }
        closeModal();
        await runPrintJobs(jobs, {saved, okToast: jobs.length > 1 ? 'Printed' : first.jobs[0].label.replace(/^The /, '').replace(/^./, c=>c.toUpperCase()) + ' printed'});
      };
      const again = root.querySelector('#pr-again'); if(again) again.onclick = (ev)=> retry(ev.currentTarget, false);
      const rc = root.querySelector('#pr-reconnect'); if(rc) rc.onclick = (ev)=> retry(ev.currentTarget, true);
    }});
}
// The same choices inside another box (the shift report): never replaces that box.
function inlinePrintProblem(box, problem, retryLabel){
  if(!box || !document.body.contains(box)){ showPrintProblem(problem); return; }
  const res = problem.res;
  box.innerHTML = `<div class="notice warn pr-inline"><span>${icon('alert', {size: 18})} ${escapeHtml(problem.jobs[0].label)} did not print. ${escapeHtml(printProblemText(res))}</span>
    <span class="pr-inline-btns"><button class="btn btn-sm btn-primary" data-pi="again">${icon('refresh', {size: 18})} ${escapeHtml(retryLabel || 'Reconnect')}</button>
    <button class="btn btn-sm btn-outline" data-pi="setup">${icon('settings', {size: 18})} Printer screen</button>
    <button class="btn btn-sm btn-outline" data-pi="screen">${icon('receipt', {size: 18})} Use print screen</button></span></div>`;
  box.querySelector('[data-pi="setup"]').onclick = ()=>{ closeModal(); navigatePOS('printer'); };
  box.querySelector('[data-pi="screen"]').onclick = ()=> problem.jobs[0].screen();
  box.querySelector('[data-pi="again"]').onclick = async (ev)=>{
    ev.currentTarget.disabled = true;
    if(!Printer.status().connected) await reconnectPrinterFromTap();
    printInto(box, problem.jobs);
  };
}
async function printInto(box, jobs, manual){
  if(manual && !printerDirect()){ jobs[0].screen(); return true; }      // a tap with no usable printer: the print screen
  if(box) box.innerHTML = `<div class="hint pr-inline-ok">${icon('printer', {size: 18})} Printing…</div>`;
  const ok = await runPrintJobs(jobs, {onProblem: (p)=> inlinePrintProblem(box, p)});
  if(ok && box && document.body.contains(box)) box.innerHTML = `<div class="hint pr-inline-ok">${icon('check', {size: 18})} Printed on the receipt printer.</div>`;
  return ok;
}

// Reprint (Sales list, transaction screen, "Print receipt" on the empty order).
async function showReceipt(saleId, opts, dataset){
  const parts = receiptParts(saleId, dataset, opts);
  if(!parts){ toast('Sale not found on this counter', 'error'); return; }
  const first = !!(opts && opts.first);
  // "Print receipt" right after the sale: not marked (Reprint); the drawer already opened.
  await runPrintJobs([receiptJob(parts, first ? {openDrawer: false} : {reprint: true})], {okToast: 'Receipt printed', manual: true});
}
// Right after a sale: the receipt (if on), then the barista ticket (if on). A cash sale with the
// receipt switched off still opens the drawer (when that setting is on).
async function printAfterSale(saleId, opts){
  if(typeof Printer === 'undefined') return;
  const parts = receiptParts(saleId, state, opts);
  if(!parts) return;
  const st = Printer.settings();
  const cash = parts.payments.some(p => p && p.method === 'CASH');
  const q = parts.ropts.qrOrder;
  if(!canPrintDirectHere()){ if(st.auto_print || (st.auto_print_ticket && printerChosen())) autoPrintNoteOnce(); return; }
  const jobs = [];
  if(st.auto_print) jobs.push(receiptJob(parts));
  // QR order: its ticket printed when it arrived -> receipt only (no second ticket).
  if(st.auto_print_ticket && printerChosen() && !(q && qrTicketPrinted(q.id))){
    jobs.push(q ? ticketJob(Object.assign({}, q, {paid_at: q.paid_at || parts.sale.transaction_date}), {source: 'QR', paid: true}, ()=> markQrTicketPrinted(q.id))
                : ticketJob(saleTicketOrder(parts), {source: 'COUNTER', paid: true, customerName: parts.ropts.customerName || ''}));
  }
  try{
    if(!st.auto_print && printerDirect() && st.open_drawer_on_cash && cash) await openDrawerOnly();
    if(jobs.length) await runPrintJobs(jobs, {saved: 'The sale is saved.'});
  }catch(e){ console.warn('printing after the sale', e); }
}
// Drawer kick only (ESC @ + ESC p), for a cash sale when the receipt isn't printed by itself.
async function openDrawerOnly(){
  try{ await Printer.sendBytes(Printer.EscPos({}).init().drawer().toUint8()); return true; }
  catch(e){ toast('The cash drawer did not open: the printer isn\'t connected. Open it by hand, and check the printer screen.', 'warn'); return false; }
}

/* ---- QR order tickets: each order prints by itself ONCE on this counter ----
   The ids are kept in this browser (localStorage), so polling, a reload or a restart never
   prints an order again. `since`: only orders that arrived after automatic printing was
   switched on (or first used) print by themselves; older ones have the reprint button. */
const QR_TICKETS_KEY = 'cccc.qr.ticketsPrinted';
const QR_TICKET_KEEP_MS = 3*24*3600*1000;
const QR_TICKET_MAX_AGE_MS = 3*3600*1000;       // never auto-print an order older than this
function qrTicketLog(){
  let v = null;
  try{ v = JSON.parse(localStorage.getItem(QR_TICKETS_KEY) || 'null'); }catch(e){ v = null; }
  if(!v || typeof v !== 'object' || !v.ids || typeof v.ids !== 'object'){
    v = {since: new Date(Date.now() - 5*60*1000).toISOString(), ids: {}};
    saveQrTicketLog(v);
  }
  return v;
}
function saveQrTicketLog(v){
  const cut = Date.now() - QR_TICKET_KEEP_MS;
  Object.keys(v.ids).forEach(k=>{ if(!(Number(v.ids[k] && v.ids[k].at) > cut)) delete v.ids[k]; });
  try{ localStorage.setItem(QR_TICKETS_KEY, JSON.stringify(v)); }catch(e){}
}
function qrTicketPrinted(id){ const e = qrTicketLog().ids[id]; return !!(e && e.p); }
function markQrTicketPrinted(id){
  const v = qrTicketLog();
  v.ids[id] = {at: Date.now(), p: 1};
  saveQrTicketLog(v);
  if(posState.route === 'qr') renderQrBoard();
}
// Automatic printing was just switched on: orders already on the board don't all print now.
function startQrTicketLog(){
  const v = qrTicketLog();
  v.since = new Date(Date.now() - 5*60*1000).toISOString();
  (state.qrOrders || []).forEach(o=>{ if(o && o.id && !v.ids[o.id]) v.ids[o.id] = {at: Date.now(), p: 0}; });
  saveQrTicketLog(v);
}
const QR_OPEN = ['PENDING', 'PREPARING', 'READY'];
function autoPrintQrArrivals(list){
  if(typeof Printer === 'undefined' || !printerReady) return;
  const st = Printer.settings();
  if(!st.auto_print_qr || !printerChosen() || !canPrintDirectHere()) return;
  const v = qrTicketLog();
  const from = Math.max(Date.parse(v.since) || 0, Date.now() - QR_TICKET_MAX_AGE_MS);
  const fresh = (list || []).filter(o => o && o.id && QR_OPEN.includes(o.status) && !v.ids[o.id] && (Date.parse(o.created_at) || 0) >= from)
    .sort((a, b)=> new Date(a.created_at) - new Date(b.created_at));
  if(!fresh.length) return;
  // Written down BEFORE printing: the next poll or a reload never prints it again.
  fresh.forEach(o=>{ v.ids[o.id] = {at: Date.now(), p: 0}; });
  saveQrTicketLog(v);
  const jobs = fresh.map(o=>{ const cur = state.qrOrders.find(x=>x.id===o.id) || o; return ticketJob(cur, {source: 'QR'}, ()=> markQrTicketPrinted(o.id)); });
  runPrintJobs(jobs, {saved: 'The orders are on the QR board: print their tickets from there when the printer is back.'});
}
// The "Print ticket" / "Reprint ticket" button on a QR order card.
async function printQrTicket(o){
  const again = qrTicketPrinted(o.id);
  await runPrintJobs([ticketJob(o, {source: 'QR', reprint: again}, ()=> markQrTicketPrinted(o.id))], {okToast: 'Ticket printed', manual: true});
}

/* ---- Printer status (sidebar) and screen ---- */
let printerReady = false;
function initPrinter(){
  if(typeof Printer === 'undefined') return;
  Printer.on('status', ()=>{ updatePrinterPill(); if(posState.route === 'printer') renderPrinterStatus(); });
  Printer.init().then(()=>{
    printerReady = true; updatePrinterPill();
    if(posState.route === 'printer') renderPrinterScreen();
    autoPrintQrArrivals(state.qrOrders);          // orders that came in while this page was closed
  }).catch(()=>{});
}
// {key: 'none'|'on'|'off'|'busy', text}
function printerState(){
  const s = Printer.status();
  if(s.connection === 'dialog' || !printerDirect()) return {key: 'none', text: 'Printer not set up', long: 'Nothing prints by itself until a receipt printer is connected. On a computer, plug in the USB cable and tap Connect USB printer.'};
  if(s.busy) return {key: 'busy', text: 'Printing…', long: 'Printing…'};
  if(s.connecting) return {key: 'busy', text: 'Connecting…', long: 'Connecting to ' + (s.name || 'the printer') + '…'};
  if(s.connected) return {key: 'on', text: 'Printer connected', long: 'Connected to ' + (s.name || 'the printer') + '.'};
  if(s.usb_needs_tap) return {key: 'off', text: 'Printer not connected', long: 'The browser needs you to choose the USB printer again (once). Tap Connect USB printer.'};
  const how = s.connection === 'usb' ? 'plugged in and switched on' : s.connection === 'bluetooth' ? 'switched on and close by' : 'switched on';
  return {key: 'off', text: 'Printer not connected', long: (s.name || 'The printer') + ' is not connected. It reconnects by itself when it is ' + how + ', or tap Reconnect.'};
}
function updatePrinterPill(){
  const pill = document.getElementById('printer-pill');
  if(!pill || typeof Printer === 'undefined') return;
  const p = printerState();
  pill.className = 'printer-pill p-' + p.key + (posState.route === 'printer' ? ' active' : '');
  pill.title = p.long + ' Tap to set up the printer.';
  pill.setAttribute('aria-label', p.text + '. Printer settings');
  pill.innerHTML = `<span class="pic" aria-hidden="true">${icon('printer', {size: 18})}<span class="pdot"></span></span><span class="ptxt">${escapeHtml(p.text)}</span>`;
}
function segHtml(name, options, value){
  return `<div class="seg" role="group" data-seg="${name}">${options.map(o=>`<button type="button" class="seg-btn ${String(o.v)===String(value)?'active':''}" data-v="${escapeHtml(String(o.v))}" aria-pressed="${String(o.v)===String(value)}">${escapeHtml(o.l)}</button>`).join('')}</div>`;
}
function printerHelpHtml(){
  const h = typeof Printer.helpSteps === 'function' ? Printer.helpSteps() : null;
  if(!h) return '';
  return `<details class="pr-help" ${h.platform === 'mac' || h.platform === 'windows' || h.platform === 'other' ? 'open' : ''}>
      <summary>${escapeHtml('Step by step: ' + (h.title || 'this browser'))}</summary>
      <ol class="pr-steps">${(h.steps || []).map(s=>`<li>${escapeHtml(s)}</li>`).join('')}</ol>
      ${(h.notes || []).length ? `<ul class="pr-notes">${h.notes.map(s=>`<li>${escapeHtml(s)}</li>`).join('')}</ul>` : ''}
    </details>`;
}
function renderPrinterScreen(){
  const content = document.getElementById('content');
  content.className = 'printer-content';
  document.getElementById('topbar-actions').innerHTML = '';
  if(typeof Printer === 'undefined'){ content.innerHTML = emptyBlock('Printing is not available in this version.'); return; }
  const st = Printer.settings();
  const sup = Printer.support();
  const mgr = hasRole('MANAGER');
  const toggle = (id, on, title, sub, locked) => `<label class="pr-toggle ${locked?'locked':''}" for="${id}"><span><b>${escapeHtml(title)}</b><small>${escapeHtml(sub)}</small></span>
    <span class="switch"><input type="checkbox" id="${id}" ${on?'checked':''} ${locked?'disabled':''}><span class="slider-tog"></span></span></label>`;
  // USB first: the recommended way on a computer (Mac / Windows with Chrome, Edge or Brave).
  const usbMain = sup.usb && !sup.apple_mobile;
  content.innerHTML = `
    <div class="printer-page">
      <div class="card pr-card pr-wide" id="pr-status"></div>
      <div class="pr-col"><div class="card pr-card">
        <h3 class="card-title">Connect a printer</h3>
        <p class="hint" id="pr-support">${escapeHtml(Printer.supportText())}</p>
        <div class="pr-connect">
          <button class="btn ${usbMain?'btn-primary':'btn-outline'} btn-big" id="pr-usb" ${sup.usb?'':'disabled'}>${icon('printer')} Connect USB printer${usbMain?' <span class="pr-rec">Recommended on computers</span>':''}</button>
          <button class="btn ${usbMain?'btn-outline':'btn-primary'} btn-big" id="pr-ble" ${sup.bluetooth?'':'disabled'}>${icon('printer')} Connect Bluetooth printer</button>
          ${sup.serial ? `<button class="btn btn-outline btn-big" id="pr-serial">${icon('printer')} Connect printer port</button>` : ''}
        </div>
        <div class="pr-more">
          ${sup.usb ? `<button class="btn btn-ghost btn-sm pr-all" id="pr-usb-all">${icon('search', {size: 18})} Show all USB devices</button>` : ''}
          ${sup.bluetooth ? `<button class="btn btn-ghost btn-sm pr-all" id="pr-ble-all">${icon('search', {size: 18})} Show all Bluetooth devices</button>` : ''}
        </div>
        ${sup.usb || sup.bluetooth ? `<p class="hint">Your printer isn't in the list? Tap ${[sup.usb ? '"Show all USB devices"' : '', sup.bluetooth ? '"Show all Bluetooth devices"' : ''].filter(Boolean).join(' or ')} and pick it there.</p>` : ''}
        ${printerHelpHtml()}
      </div></div>
      <div class="pr-col"><div class="card pr-card">
        <h3 class="card-title">Print by itself</h3>
        <p class="hint">Saved on this counter only. Nothing opens the print screen by itself.</p>
        ${toggle('pr-auto', st.auto_print, 'Print the receipt after each sale', 'Off: after a sale, tap "Print receipt" on the order screen when the customer wants one.')}
        ${toggle('pr-ticket', st.auto_print_ticket, 'Print a barista ticket after each sale', 'The order for the bar, without prices. A QR order whose ticket already printed when it arrived doesn\'t print a second one.')}
        ${toggle('pr-qr', st.auto_print_qr, 'Print QR orders when they arrive', 'Turn this on for ONE counter only, or every counter prints each order. Each order prints once; use "Reprint ticket" on the order for another copy.')}
        ${toggle('pr-shift', st.auto_print_shift, 'Print the shift report when the shift is closed', 'The Z report prints right after Confirm close shift. The X-report prints when you tap Print X-report.')}
        ${toggle('pr-drawer', st.open_drawer_on_cash, 'Open the cash drawer on cash sales', mgr ? 'Needs a cash drawer plugged into the printer.' : (st.open_drawer_on_cash ? 'On.' : 'Off.') + ' Only a manager can change this.', !mgr)}
      </div>
      <div class="card pr-card">
        <h3 class="card-title">Paper</h3>
        <div class="pr-row"><span class="pr-label">Paper width</span>${segHtml('paper_width', [{v:58,l:'58 mm'},{v:80,l:'80 mm'}], st.paper_width)}</div>
        <div class="pr-row"><span class="pr-label">Peso sign on paper</span>${segHtml('peso_style', [{v:'P',l:'P150.00'},{v:'PHP',l:'PHP 150.00'},{v:'none',l:'150.00'}], st.peso_style)}</div>
        <div class="pr-row"><span class="pr-label">Copies of each receipt</span>${segHtml('copies', [{v:1,l:'1'},{v:2,l:'2'},{v:3,l:'3'}], st.copies)}</div>
      </div>
      <div class="card pr-card">
        <h3 class="card-title">Check the printer</h3>
        <div class="pr-connect">
          <button class="btn btn-outline btn-big" id="pr-test">${icon('receipt')} Print test slip</button>
          ${mgr ? `<button class="btn btn-outline btn-big" id="pr-test-drawer">${icon('cash')} Print test slip + open drawer</button>` : ''}
        </div>
        ${mgr ? '<p class="hint">Opening the drawer is written in the activity log with your name.</p>' : '<p class="hint">A manager can also test the cash drawer.</p>'}
        <button class="btn btn-ghost btn-sm pr-forget" id="pr-forget">${icon('trash', {size: 18})} Forget printer</button>
      </div></div>
    </div>`;
  renderPrinterStatus();
  const busyRun = async (btn, fn)=>{ if(btn.disabled) return; btn.disabled = true; try{ await fn(); } finally { if(document.body.contains(btn)) btn.disabled = false; } };
  const connect = (fn)=> async (ev)=> busyRun(ev.currentTarget, async ()=>{
    try{
      const s = await fn();
      toast('Connected to ' + ((s && s.name) || 'the printer') + '. Tap "Print test slip" to check it.', 'success');
      queueAudit('Receipt printer connected', (s && s.name) || '');
    }catch(e){ toast(e.friendly || friendlyError(e), /No printer was chosen|No printer port was chosen/.test(e.friendly || '') ? 'warn' : 'error'); }
    renderPrinterScreen();
  });
  const usb = document.getElementById('pr-usb'); if(usb) usb.onclick = connect(()=> Printer.chooseUsb());
  const usbAll = document.getElementById('pr-usb-all'); if(usbAll) usbAll.onclick = connect(()=> Printer.chooseUsb({showAll: true}));
  const ble = document.getElementById('pr-ble'); if(ble) ble.onclick = connect(()=> Printer.choose());
  const all = document.getElementById('pr-ble-all'); if(all) all.onclick = connect(()=> Printer.choose({showAll: true}));
  const ser = document.getElementById('pr-serial'); if(ser) ser.onclick = connect(()=> Printer.chooseSerial());
  content.querySelectorAll('[data-seg]').forEach(seg=> seg.addEventListener('click', async (e)=>{
    const b = e.target.closest('[data-v]'); if(!b) return;
    const key = seg.dataset.seg;
    const v = key === 'peso_style' ? b.dataset.v : Number(b.dataset.v);
    const before = Printer.settings()[key];
    await Printer.saveSettings({[key]: v});
    if(key === 'copies' && Number(before) !== v) queueAudit('Receipt copies changed', `${before} → ${v} (by ${posState.currentUser ? posState.currentUser.name : ''})`);
    seg.querySelectorAll('[data-v]').forEach(x=>{ const on = x === b; x.classList.toggle('active', on); x.setAttribute('aria-pressed', String(on)); });
    toast('Saved');
  }));
  const who = ()=> posState.currentUser ? posState.currentUser.name : '';
  // A print switch: saved on this counter, written in the activity log.
  const sw = (id, key, auditName, onText, offText, after)=>{
    document.getElementById(id).onchange = async (e)=>{
      const on = e.target.checked;
      await Printer.saveSettings({[key]: on});
      if(after) after(on);
      queueAudit(auditName + ': ' + (on ? 'on' : 'off'), 'by ' + who());
      toast(on ? onText : offText);
    };
  };
  sw('pr-auto', 'auto_print', 'Print receipt after each sale', 'Receipts print after each sale', 'Receipts print only when you tap Print receipt');
  sw('pr-ticket', 'auto_print_ticket', 'Print barista ticket after each sale', 'A barista ticket prints after each sale', 'No barista ticket after a sale');
  sw('pr-qr', 'auto_print_qr', 'Print QR orders when they arrive', 'New QR orders print on this counter', 'QR orders no longer print by themselves here', (on)=>{ if(on) startQrTicketLog(); });
  sw('pr-shift', 'auto_print_shift', 'Print shift report when the shift is closed', 'The shift report prints when the shift is closed', 'The shift report prints only when you tap Print');
  document.getElementById('pr-drawer').onchange = async (e)=>{
    if(!hasRole('MANAGER')){ e.target.checked = !e.target.checked; toast('Only a manager can change this.', 'warn'); return; }
    await Printer.saveSettings({open_drawer_on_cash: e.target.checked}); queueAudit('Cash drawer on cash sales: ' + (e.target.checked ? 'on' : 'off'), 'by ' + who()); toast(e.target.checked ? 'The drawer opens on cash sales' : 'The drawer no longer opens by itself'); };
  const test = async (btn, drawer)=> busyRun(btn, async ()=>{
    if(drawer && !hasRole('MANAGER')){ toast('Only a manager can open the cash drawer.', 'warn'); return; }
    if(!printerDirect()){ toast('No printer yet. Tap Connect USB printer (or Connect a Bluetooth printer / printer port) first.', 'warn'); return; }
    const res = await Printer.printTest({openDrawer: !!drawer});
    if(drawer && res.drawer_kick_sent){
      queueAudit('Cash drawer opened (test slip)', `Printer: ${res.printer_name || 'receipt printer'} · by ${posState.currentUser ? posState.currentUser.name : ''}`);
    }
    if(res.ok) toast(drawer ? 'Test slip sent and the drawer was told to open.' : 'Test slip sent. Check that it came out clearly.', 'success');
    else toast(res.error || 'The test slip did not print.', 'error');
    renderPrinterStatus();
  });
  document.getElementById('pr-test').onclick = (ev)=> test(ev.currentTarget, false);
  const td = document.getElementById('pr-test-drawer'); if(td) td.onclick = (ev)=> test(ev.currentTarget, true);
  document.getElementById('pr-forget').onclick = async ()=>{
    const ok = await confirmDialog('Forget the printer on this counter? Nothing prints until you connect a printer again.', 'Forget printer');
    if(!ok) return;
    const name = Printer.status().name;
    await Printer.forget();
    queueAudit('Receipt printer forgotten', name || '');
    toast('Printer forgotten. Connect a printer to print again.');
    renderPrinterScreen();
  };
}
function renderPrinterStatus(){
  const box = document.getElementById('pr-status');
  if(!box) return;
  const s = Printer.status();
  const p = printerState();
  const remembered = printerDirect() && !s.connected && !s.connecting;
  box.innerHTML = `<div class="pr-status p-${p.key}"><span class="pr-big-dot" aria-hidden="true"></span>
      <div class="pr-status-main"><b>${escapeHtml(p.text)}</b><span>${escapeHtml(p.long)}</span>
      ${s.paper_width ? `<small>${escapeHtml(s.paper_width + ' mm paper · ' + s.chars + ' letters per line')}${s.last_printed_at ? ' · last printed ' + escapeHtml(fmtTime(s.last_printed_at)) : ''}</small>` : ''}</div>
      ${remembered ? `<button class="btn btn-primary" id="pr-reconnect">${icon('refresh')} ${s.usb_needs_tap ? 'Connect USB printer' : 'Reconnect'}</button>` : ''}</div>
    ${s.last_error ? `<div class="notice warn pr-err">${icon('alert', {size: 18})} <span>${escapeHtml(s.last_error)}</span></div>` : ''}`;
  const rc = document.getElementById('pr-reconnect');
  if(rc) rc.onclick = async ()=>{
    rc.disabled = true;
    const ok = await reconnectPrinterFromTap();
    toast(ok ? 'Printer connected' : 'Couldn\'t reach the printer. Check it is switched on (and plugged in, or close by), then tap Reconnect again.', ok ? 'success' : 'warn');
    renderPrinterStatus();
  };
}

/* =====================================================================
   QR ORDERS BOARD (list or floor plan)
   Floor plan (release 1.2): the owner draws it in Back Office → Tables (a 1000 x 1000 grid;
   pos_x / pos_y = top-left corner, rotation turns an item around its centre). The counter reads
   it with fo_bootstrap / fo_floor_plan() (never the dining_tables table: no QR codes on counters).
   Each table is coloured by its open QR orders:
     wait  (terracotta) = an order not paid yet ("Waiting for payment")
     serve (butter)     = paid, being made or ready, not served yet
     free  (paper)      = no open order
   ===================================================================== */
const QR_VIEW_KEY = 'cccc.qr.view';
const FLOOR_REFRESH_MS = 60*1000;
let floorPlanAt = 0, floorPlanRun = null;
function activeTables(){ return (state.tables || []).filter(t => t && t.active !== false); }
function isPlaced(t){ return t && t.pos_x !== null && t.pos_x !== undefined && t.pos_x !== '' && t.pos_y !== null && t.pos_y !== undefined && t.pos_y !== ''; }
function placedTables(){ return activeTables().filter(isPlaced); }
function qrViewMode(){
  if(posState.qrView === 'plan' || posState.qrView === 'list') return posState.qrView;
  let saved = null; try{ saved = localStorage.getItem(QR_VIEW_KEY); }catch(e){}
  if(saved === 'plan' || saved === 'list') return saved;
  return placedTables().length ? 'plan' : 'list';
}
function setQrView(mode){
  posState.qrView = mode;
  try{ localStorage.setItem(QR_VIEW_KEY, mode); }catch(e){}
  renderQrBoard();
}
// A fresh floor plan from the server (the owner may have moved tables). Quietly keeps the last one offline.
function refreshFloorPlan(force){
  if(!isOnline() || !cloud.session) return Promise.resolve(false);
  if(!force && Date.now() - floorPlanAt < FLOOR_REFRESH_MS) return Promise.resolve(false);
  if(floorPlanRun) return floorPlanRun;
  floorPlanRun = (async ()=>{
    try{
      const r = await cloud.rpc('fo_floor_plan', {}, {timeout: 8000});
      if(r && Array.isArray(r.tables)){
        state.tables = r.tables;
        state.floorShapes = Array.isArray(r.shapes) ? r.shapes : [];
        floorPlanAt = Date.now();
        saveSnapshotSoon();
        if(posState.route === 'qr') renderQrBoard();
        return true;
      }
    }catch(e){ if(!e.offline) console.warn('could not load the floor plan', e.message); }
    return false;
  })().finally(()=>{ floorPlanRun = null; });
  return floorPlanRun;
}
function tableOrders(t){ return openQrOrders().filter(o => o.table_id === t.id).sort((a,b)=> new Date(a.created_at)-new Date(b.created_at)); }
function tableState(orders){
  if(!orders.length) return 'free';
  return orders.some(o => !o.paid_at) ? 'wait' : 'serve';
}
const TABLE_STATE_WORDS = {wait: 'Waiting for payment', serve: 'Being made', free: 'Free'};
// [main line, second line] shown on a table: free -> seats; busy -> "Waiting · ₱475.00" + order number(s).
function tableStatusLines(t, orders){
  const st = tableState(orders);
  if(st === 'free') return [t.seats ? `${Number(t.seats)} seat${Number(t.seats)===1?'':'s'}` : 'Free', ''];
  const total = orders.reduce((s,o)=> s + (Number(o.total)||0), 0);
  const what = orders.length === 1 ? orders[0].order_number : `${orders.length} orders`;
  const word = st === 'wait' ? 'Waiting' : (orders.every(o=>o.status==='READY') ? 'Ready' : 'Being made');
  return [`${word} · ${fmtMoney(total)}`, what];
}
function floorBox(tables, shapes){
  const items = tables.map(t=>({x: Number(t.pos_x)||0, y: Number(t.pos_y)||0, w: Number(t.width)||80, h: Number(t.height)||80}))
    .concat(shapes.map(f=>({x: Number(f.pos_x)||0, y: Number(f.pos_y)||0, w: Number(f.width)||100, h: Number(f.height)||100})));
  if(!items.length) return {x: 0, y: 0, w: 1000, h: 1000};
  const PAD = 30, MIN = 240;
  let x0 = Math.min(...items.map(i=>i.x)) - PAD, y0 = Math.min(...items.map(i=>i.y)) - PAD;
  let x1 = Math.max(...items.map(i=>i.x + i.w)) + PAD, y1 = Math.max(...items.map(i=>i.y + i.h)) + PAD;
  x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(1000, x1); y1 = Math.min(1000, y1);
  if(x1 - x0 < MIN){ const c = (x0 + x1) / 2; x0 = Math.max(0, c - MIN/2); x1 = Math.min(1000, x0 + MIN); }
  if(y1 - y0 < MIN){ const c = (y0 + y1) / 2; y0 = Math.max(0, c - MIN/2); y1 = Math.min(1000, y0 + MIN); }
  return {x: x0, y: y0, w: x1 - x0, h: y1 - y0};
}
function boxStyle(box, d, defW, defH){
  const pct = (v)=> (Math.round(v * 1000) / 1000) + '%';
  const w = Number(d.width) || defW, h = Number(d.height) || defH;
  const rot = Math.round(Number(d.rotation) || 0) % 360;
  return `left:${pct((Number(d.pos_x) - box.x) / box.w * 100)};top:${pct((Number(d.pos_y) - box.y) / box.h * 100)};`
    + `width:${pct(w / box.w * 100)};height:${pct(h / box.h * 100)};` + (rot ? `transform:rotate(${rot}deg);--unrot:rotate(${-rot}deg);` : '');
}
function floorTableHtml(t, box){
  const orders = tableOrders(t);
  const st = tableState(orders);
  const shape = t.shape === 'ROUND' ? 'round' : 'square';
  const label = t.label || 'Table';
  const [line1, line2] = tableStatusLines(t, orders);
  return `<button type="button" class="fp-table ${shape} st-${st}" data-table="${escapeHtml(t.id)}" style="${box ? boxStyle(box, t, 80, 80) : ''}"
      aria-label="${escapeHtml(label + ': ' + TABLE_STATE_WORDS[st] + (orders.length ? ', ' + line1 + ', ' + line2 : ''))}">
      <span class="fp-in"><span class="fp-lb">${escapeHtml(label)}</span><small>${escapeHtml(line1)}</small>${line2?`<small class="fp-no">${escapeHtml(line2)}</small>`:''}</span></button>`;
}
function floorShapeHtml(f, box){
  const kind = String(f.kind || 'OTHER').toLowerCase().replace(/[^a-z]/g, '');
  return `<div class="fp-shape k-${kind}${f.shape==='ROUND'?' round':''}" style="${boxStyle(box, f, 100, 100)}" aria-hidden="true"><span class="fp-in">${escapeHtml(f.label || '')}</span></div>`;
}
function floorPlanHtml(){
  const placed = placedTables();
  const unplaced = activeTables().filter(t => !isPlaced(t));
  const shapes = state.floorShapes || [];
  if(!placed.length && !shapes.length){
    return `<div class="floor-empty">${icon('map', {size: 36})}<p><b>No floor plan yet.</b> The owner can draw the tables in Back Office → Tables, then they show here coloured by their QR orders.</p>
      ${unplaced.length?`<div class="fp-unplaced"><span class="fp-unplaced-lbl">Tables</span>${unplaced.map(t=>floorTableHtml(t, null)).join('')}</div>`:''}</div>`;
  }
  const box = floorBox(placed, shapes);
  return `<div class="floor-wrap">
      <div class="floor-plan" style="--ar:${(box.w / box.h).toFixed(4)};">
        ${shapes.slice().sort((a,b)=>(Number(a.sort_order)||0)-(Number(b.sort_order)||0)).map(f=>floorShapeHtml(f, box)).join('')}
        ${placed.map(t=>floorTableHtml(t, box)).join('')}
      </div>
      <div class="fp-foot">
        <div class="fp-legend"><span><i class="lg-wait"></i>Waiting for payment</span><span><i class="lg-serve"></i>Being made</span><span><i class="lg-free"></i>Free</span></div>
        ${unplaced.length?`<div class="fp-unplaced"><span class="fp-unplaced-lbl">Not placed</span>${unplaced.map(t=>floorTableHtml(t, null)).join('')}</div>`:''}
      </div>
    </div>`;
}
function openTableOrders(tableId){
  const t = (state.tables || []).find(x => x.id === tableId);
  if(!t) return;
  const orders = tableOrders(t);
  if(!orders.length){ toast(`${t.label || 'This table'} is free: no open QR orders.`); return; }
  openModal({title: escapeHtml(t.label || 'Table'), wide: orders.length > 1,
    body: `<div class="table-orders">${orders.map(qrCard).join('')}</div>`,
    foot: `<button class="btn btn-outline" data-close>Close</button>`,
    onMount: (root)=>{
      root.querySelector('[data-close]').onclick = closeModal;
      root.querySelectorAll('[data-qr-act]').forEach(b=> b.onclick = ()=>{ closeModal(); qrAction(b.dataset.id, b.dataset.qrAct); });
    }});
}

function renderQrBoard(){
  const content = document.getElementById('content');
  if(posState.route!=='qr') return;
  const scrollTop = content.scrollTop;
  const view = qrViewMode();
  const open = openQrOrders();
  const waiting = open.filter(o=>!o.paid_at).length, making = open.length - waiting;
  document.getElementById('topbar-actions').innerHTML = `
    <div class="seg" role="group" aria-label="Show as"><button class="seg-btn ${view==='plan'?'active':''}" id="qr-view-plan" aria-pressed="${view==='plan'}">${icon('map', {size: 18})} Floor plan</button><button class="seg-btn ${view==='list'?'active':''}" id="qr-view-list" aria-pressed="${view==='list'}">${icon('grid', {size: 18})} List</button></div>
    <span class="shift-badge qr-count">${waiting} waiting · ${making} being made</span>`;
  const tools = `<div class="qr-tools">
    ${qrAutoTicketChip()}
    <button class="btn btn-outline btn-sm" id="qr-refresh">${icon('refresh', {size: 18})} Refresh</button>
    <button class="btn btn-outline btn-sm" id="qr-soldout">${icon('x', {size: 18})} Sold-out items</button></div>`;
  const wireTools = ()=>{
  document.getElementById('qr-view-plan').onclick = ()=> setQrView('plan');
  document.getElementById('qr-view-list').onclick = ()=> setQrView('list');
  document.getElementById('qr-auto-chip').onclick = ()=> navigatePOS('printer');
  document.getElementById('qr-refresh').onclick = ()=>{ pollQrOrders(); refreshFloorPlan(true); toast('Checking for new orders…'); };
  document.getElementById('qr-soldout').onclick = openSoldOutManager;
  };
  const offline = !isOnline();
  const notices = `
    ${offline?`<div class="notice warn notice-icon">${icon('wifi-off', {size: 18})}<span>Offline: new QR orders can't arrive and statuses can't change until the internet is back.</span></div>`:''}
    ${!state.settings.qr_ordering_enabled?`<div class="notice warn notice-icon">${icon('info', {size: 18})}<span>QR ordering is switched OFF in Back Office → Settings → QR Ordering.</span></div>`:''}`;
  if(view === 'plan'){
    const side = open.slice().sort((a,b)=> (a.status==='PENDING'?0:1)-(b.status==='PENDING'?0:1) || new Date(a.created_at)-new Date(b.created_at));
    content.className = 'qr-plan-content';
    content.innerHTML = `${notices}${tools}
      <div class="qr-plan-layout">
        <div class="qr-plan-main">${floorPlanHtml()}</div>
        <div class="qr-side" aria-label="Open QR orders">${side.length ? side.map(qrCard).join('') : `<div class="qr-empty">${icon('qr', {size: 28})}<p>No open QR orders.</p></div>`}</div>
      </div>`;
    content.querySelectorAll('[data-table]').forEach(b=> b.onclick = ()=> openTableOrders(b.dataset.table));
  } else {
    content.className = '';
    const cols = [
      {status:'PENDING', title:'New', hint:'Accept or reject'},
      {status:'PREPARING', title:'Preparing', hint:'Mark ready when done'},
      {status:'READY', title:'Ready', hint:'Hand over / serve'},
    ];
    const doneToday = state.qrOrders.filter(o=>['COMPLETED','REJECTED','CANCELLED'].includes(o.status))
      .sort((a,b)=> new Date(b.updated_at)-new Date(a.updated_at)).slice(0,20);
    content.innerHTML = `${notices}${tools}
      <div class="qr-board">
        ${cols.map(c=>{
          const list = state.qrOrders.filter(o=>o.status===c.status).sort((a,b)=> new Date(a.created_at)-new Date(b.created_at));
          return `<div class="qr-col"><div class="qr-col-head"><h2>${c.title}</h2> <span class="badge badge-gray">${list.length}</span><span class="qr-col-hint">${c.hint}</span></div>
            <div class="qr-col-body">${list.length ? list.map(qrCard).join('') : `<div class="qr-empty">Nothing here</div>`}</div></div>`;
        }).join('')}
      </div>
      <div class="section-title">Finished in the last few hours</div>
      ${doneToday.length?`<div class="table-wrap"><table><thead><tr><th>Order</th><th>Table</th><th>Customer</th><th>Status</th><th>Total</th><th>Updated</th></tr></thead><tbody>
        ${doneToday.map(o=>`<tr><td><b>${escapeHtml(o.order_number)}</b></td><td>${escapeHtml(o.table_label||'')}</td><td>${escapeHtml(qrCustomerWords(o))}</td>
          <td>${qrStatusBadge(o)}</td><td>${fmtMoney(o.total)}</td><td>${fmtTime(o.updated_at)}</td></tr>`).join('')}</tbody></table></div>` : emptyBlock('No finished QR orders yet.')}`;
  }
  wireTools();
  content.scrollTop = scrollTop;
  content.querySelectorAll('[data-qr-act]').forEach(b=> b.onclick = ()=> qrAction(b.dataset.id, b.dataset.qrAct));
  updateQrBadge();
  refreshFloorPlan(false);
}
function qrStatusBadge(o){
  const map = {PENDING:'badge-yellow', PREPARING:'badge-gray', READY:'badge-green', COMPLETED:'badge-green', REJECTED:'badge-red', CANCELLED:'badge-red'};
  return `<span class="badge ${map[o.status]||'badge-gray'}">${escapeHtml(o.status.charAt(0)+o.status.slice(1).toLowerCase())}</span>`;
}
// Who placed a QR order: "Guest" for a phone with no account (release 1.5, is_guest), else the nickname.
function qrCustomerWords(o){
  if(!o) return '';
  if(o.is_guest) return 'Guest';
  return o.customer_nickname || 'Guest';
}
function qrCard(o){
  const paid = !!o.paid_at;
  const offline = !isOnline();
  const dis = offline ? 'disabled' : '';
  const id = escapeHtml(o.id);
  const btns = [];
  if(o.status==='PENDING'){
    btns.push(`<button class="btn btn-sm btn-primary" data-qr-act="ACCEPT" data-id="${id}" ${dis}>Accept</button>`);
    if(!paid) btns.push(`<button class="btn btn-sm btn-amber" data-qr-act="PAY" data-id="${id}">Take payment</button>`);
    btns.push(`<button class="btn btn-sm btn-danger" data-qr-act="REJECT" data-id="${id}" ${dis}>Reject</button>`);
  } else if(o.status==='PREPARING'){
    btns.push(`<button class="btn btn-sm btn-primary" data-qr-act="READY" data-id="${id}" ${dis}>Ready</button>`);
    if(!paid) btns.push(`<button class="btn btn-sm btn-amber" data-qr-act="PAY" data-id="${id}">Take payment</button>`);
  } else if(o.status==='READY'){
    if(!paid) btns.push(`<button class="btn btn-sm btn-amber" data-qr-act="PAY" data-id="${id}">Take payment</button>`);
    btns.push(`<button class="btn btn-sm btn-primary" data-qr-act="COMPLETE" data-id="${id}" ${dis||(!paid?'disabled':'')}>Served / picked up</button>`);
  }
  const printed = qrTicketPrinted(o.id);
  btns.push(`<button class="btn btn-sm btn-ghost" data-qr-act="TICKET" data-id="${id}" title="${printed?'The ticket printed on this counter. Tap for another copy.':'Print the order ticket for the bar'}">${icon('printer', {size: 18})} ${printed?'Reprint ticket':'Print ticket'}</button>`);
  const stateTag = o.status==='PENDING' ? '<span class="tag">New</span>' : (o.status==='READY' ? '<span class="tag ok">Ready</span>' : '<span class="tag soft">Being made</span>');
  return `<div class="qr-card ${o.status==='PENDING'?'is-new':''} ${paid?'':'unpaid'}">
    <div class="qr-card-top"><span class="qr-no">${escapeHtml(o.order_number)}</span>${stateTag}
      ${paid?'<span class="badge badge-green">PAID</span>':'<span class="badge badge-yellow">Unpaid</span>'}
      <span class="qr-total">${fmtMoney(o.total)}</span></div>
    <div class="qr-meta">${escapeHtml(o.table_label||'')}${o.order_type==='TAKEAWAY'?' · Takeaway':' · Dine in'} · ${icon('user', {size: 14})} ${o.is_guest ? '<span class="tag soft guest-tag">Guest</span>' : escapeHtml(qrCustomerWords(o))} · ${escapeHtml(timeAgo(o.created_at))}</div>
    <ul class="qr-items">${(o.items||[]).map(it=>`<li><b>${Number(it.quantity)} ×</b> ${escapeHtml(it.name)}
      ${(it.modifiers||[]).length?`<span class="text-light">(${it.modifiers.map(m=>escapeHtml(m.label)).join(', ')})</span>`:''}
      ${it.notes?`<div class="qr-note">“${escapeHtml(it.notes)}”</div>`:''}</li>`).join('')}</ul>
    ${o.customer_note?`<div class="qr-note">Note: “${escapeHtml(o.customer_note)}”</div>`:''}
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
  if(action==='TICKET'){ printQrTicket(o); return; }
  if(action==='PAY'){
    if(!activeShift()){ toast('Start a shift first (Orders screen).', 'error'); navigatePOS('pos'); return; }
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
    navigatePOS('pos');
    if(o.customer_id) attachCustomer({id: o.customer_id, nickname: o.customer_nickname});
    if(cartStockProblems(posState.cart).length) openStockProblems(openCheckout);   // items that ran out since the order was placed (Q6)
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
    }
  }catch(e){ toast(friendlyError(e), 'error'); }
  renderQrBoard();
}
// "Tickets print on arrival" / "off" on the QR board (the switch is on the Printer screen).
function qrAutoTicketChip(){
  const on = typeof Printer !== 'undefined' && Printer.settings().auto_print_qr && printerChosen();
  const why = typeof Printer === 'undefined' ? '' : !Printer.settings().auto_print_qr ? 'Tickets: tap Print ticket' : !printerChosen() ? 'No printer: tickets don\'t print' : 'Tickets print when orders arrive';
  return `<button class="btn btn-ghost btn-sm qr-auto ${on?'on':''}" id="qr-auto-chip" title="Change this on the Printer screen">${icon('printer', {size: 18})} ${escapeHtml(why)}</button>`;
}
// The order ticket on the print screen (only from a "Use print screen" tap). QR order or counter
// sale. Same lines as the paper ticket (Printer.ticketBytes): the payment status is its own fixed
// line, from paid_at / topts.paid ONLY (security L1: a nickname like "Ana PAID" can't look like it),
// and the customer's name is labelled "Name:".
function ticketHtml(o, topts){
  topts = topts || {};
  const qr = String(topts.source || o.source || (o.order_number ? 'QR' : 'COUNTER')).toUpperCase() === 'QR';
  const no = o.order_number || o.transaction_number || '';
  const type = o.order_type==='TAKEAWAY' ? 'TAKEAWAY' : o.order_type==='DINE_IN' ? 'DINE-IN' : '';
  const where = [o.table_label||'', type].filter(Boolean).join(' - ');
  const paid = !!(o.paid_at || topts.paid);
  const status = paid ? 'PAID' : (qr ? 'NOT PAID - PAY AT COUNTER' : '');
  const nick = o.is_guest ? 'Guest' : (o.customer_nickname || o.customer_name || topts.customerName || '');
  const when = o.created_at || o.transaction_date;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(no)}</title>
    <style>body{font-family:'Courier New',monospace;width:280px;margin:16px auto;font-size:14px;} h1{font-size:26px;margin:0;text-align:center;} .c{text-align:center;} .big{font-size:16px;font-weight:700;} .status{font-size:20px;font-weight:700;text-align:center;padding:4px 0;border-top:1px dashed #888;border-bottom:1px dashed #888;margin:6px 0;} hr{border:none;border-top:1px dashed #888;} .mod{padding-left:14px;font-size:12.5px;} @media print{body{width:${(typeof Printer!=='undefined' && Printer.settings().paper_width===80)?'72':'48'}mm;margin:0;}}</style></head><body>
    <h1>${escapeHtml(no || 'ORDER')}</h1>
    <div class="c big">${qr ? 'QR ORDER' : 'COUNTER ORDER'}</div>
    ${where ? `<div class="c big">${escapeHtml(where)}</div>` : ''}
    ${status ? `<div class="status">${status}</div>` : ''}
    ${nick ? `<div>Name: ${escapeHtml(nick)}</div>` : ''}
    ${when ? `<div>${escapeHtml(fmtDateTime(when))}</div>` : ''}<hr>
    ${(o.items||[]).map(it=>`<div class="big">${Number(it.quantity)} x ${escapeHtml(it.name)}</div>${(it.modifiers||[]).map(m=>`<div class="mod">- ${escapeHtml(m.label||m.name||'')}</div>`).join('')}${it.notes?`<div class="mod">"${escapeHtml(it.notes)}"</div>`:''}`).join('')}
    <hr>${(o.customer_note||o.notes)?`<div class="big">Note: ${escapeHtml(o.customer_note||o.notes)}</div><hr>`:''}
    <div>${(o.items||[]).reduce((n,it)=>n+(Number(it.quantity)||1),0)} item(s)</div>
    ${topts.reprint?'<div class="c">(Reprint)</div>':''}
    </body></html>`;
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
   CUSTOMERS (release 1.2) — needs internet
   fo_customer_list / fo_customer_detail (paired counters only, rate-limited by the server).
   Phones always come masked. Money (total spent, order totals) is sent by the server ONLY
   with the sign-in (LOGIN) token of the manager / admin who is signed in on this counter;
   everyone else sees "Managers only" (never zeros). The token is never an approval: viewing
   doesn't use anything up.
   ===================================================================== */
const custView = {q: '', selected: null, listSeq: 0, detailSeq: 0, list: null, detail: null, archived: false};
// Release 1.5 (B6): customers without a phone number are "archived": the main list hides them,
// the "Archived" filter shows only them (fo_customer_list p_archived). Not remembered: the
// screen always opens on the main list.
// List order (release 1.3, A17): sorted by the server, remembered on this counter. No polling
// (the server allows about 120 list calls an hour): the list loads when the screen opens, the
// search changes or the sort changes.
const CUST_SORT_KEY = 'cccc.customers.sort';
const CUST_SORTS = [{id: 'name', label: 'Name (A–Z)'}, {id: 'recent', label: 'Most recent'}, {id: 'frequent', label: 'Most frequent'}];
function customerSort(){
  let v = null; try{ v = localStorage.getItem(CUST_SORT_KEY); }catch(e){}
  return CUST_SORTS.some(x => x.id === v) ? v : 'recent';
}
function setCustomerSort(v){ try{ localStorage.setItem(CUST_SORT_KEY, v); }catch(e){} }
// The signed-in manager's own sign-in token, for showing money. Cashiers (and managers whose
// PIN is too short) send none.
function customerMoneyToken(){
  const me = posState.currentUser;
  if(!me || !hasRole('MANAGER') || shortPinUser() || me.offline) return null;
  return ownLoginToken();
}
// Whole shop days (Manila) between moment d and now (the shared shop-day helper, release 1.5).
function daysAgo(d){
  if(!d || isNaN(new Date(d))) return null;
  const a = new Date(shopDayKey(d) + 'T00:00:00Z'), b = new Date(shopDayKey() + 'T00:00:00Z');
  return Math.round((b - a) / 86400000);
}
function lastVisitText(d){
  const n = daysAgo(d);
  if(n === null || isNaN(n)) return 'no visits yet';
  if(n <= 0) return 'last visit today';
  if(n === 1) return 'last visit yesterday';
  if(n < 14) return `last visit ${n} days ago`;
  return 'last visit ' + fmtDate(d);
}
function orderWhenText(d){
  const n = daysAgo(d);
  if(n === null || isNaN(n)) return '—';
  if(n <= 0) return 'Today ' + fmtTime(d);
  if(n === 1) return 'Yesterday ' + fmtTime(d);
  if(n < 7){ let wd = ''; try{ wd = new Date(d).toLocaleDateString('en-PH', {weekday: 'short', timeZone: shopTimeZone()}); }catch(e){} return wd + ' ' + fmtTime(d); }
  return fmtDate(d);
}
function ordinal(n){ const s = ['th','st','nd','rd'], v = n % 100; return n + (s[(v-20)%10] || s[v] || s[0]); }
function managersOnlyHtml(reason){
  return `<span class="lock-note">${icon('lock', {size: 14})} Managers only</span>${reason ? `<span class="lock-why">${escapeHtml(reason)}</span>` : ''}`;
}
function moneyRefusedText(r){
  if(!r || !r.money_refused || !hasRole('MANAGER')) return '';
  if(r.money_refused === 'PIN_UPDATE_NEEDED') return friendlyError('PIN_UPDATE_NEEDED');
  return 'Lock and sign in again (online) to see amounts.';
}

function renderCustomersScreen(){
  const content = document.getElementById('content');
  document.getElementById('topbar-actions').innerHTML = `<button class="btn btn-primary" id="cust-new-btn">${icon('plus')} Add customer</button>`;
  document.getElementById('cust-new-btn').onclick = ()=> openCustomerPicker({newOnly: true, onPick: (c)=>{
    toast(`${c.nickname} saved`);
    custView.selected = c.id; custView.q = ''; renderCustomersScreen();
  }});
  if(!isOnline()){
    content.className = '';
    content.innerHTML = `<div class="offline-panel">${icon('wifi-off', {size: 40})}
      <h2>Customers needs the internet</h2>
      <p>The customer list and stamp cards come from the server, so this screen works only online. You can keep selling: sales without a customer upload as usual.</p></div>`;
    return;
  }
  content.className = 'cust-content';
  content.innerHTML = `
    <div class="cust-layout">
      <div class="cust-list-col">
        <label class="cust-search">${icon('search')}<input type="search" id="cust-search" placeholder="Search by nickname or username" aria-label="Search customers by nickname or username" autocomplete="off" maxlength="30" value="${escapeHtml(custView.q)}"></label>
        <div class="cust-sort"><span class="cust-sort-lbl" id="cust-which-lbl">Show</span><div class="seg" role="group" aria-labelledby="cust-which-lbl" id="cust-which">
          <button type="button" class="seg-btn ${custView.archived?'':'active'}" data-arch="0" aria-pressed="${!custView.archived}">With a phone</button>
          <button type="button" class="seg-btn ${custView.archived?'active':''}" data-arch="1" aria-pressed="${custView.archived}">Archived</button></div></div>
        <div class="cust-sort"><span class="cust-sort-lbl" id="cust-sort-lbl">Sort</span><div class="seg" role="group" aria-labelledby="cust-sort-lbl" id="cust-sort">${CUST_SORTS.map(o=>`<button type="button" class="seg-btn ${customerSort()===o.id?'active':''}" data-sort="${o.id}" aria-pressed="${customerSort()===o.id}">${escapeHtml(o.label).replace('–', '&#8288;–&#8288;')}</button>`).join('')}</div></div>
        <div id="cust-list" class="cust-list" aria-live="polite"><p class="hint cust-pad">Loading customers…</p></div>
      </div>
      <div id="cust-detail" class="cust-detail">${custView.selected ? '<div class="card"><p class="hint">Loading…</p></div>' : customerPickHint()}</div>
    </div>`;
  const search = debounce(()=> loadCustomerList(), 300);
  document.getElementById('cust-search').oninput = (e)=>{ custView.q = e.target.value.trim(); search(); };
  document.getElementById('cust-which').addEventListener('click', (e)=>{
    const b = e.target.closest('[data-arch]'); if(!b) return;
    const arch = b.dataset.arch === '1';
    if(arch === custView.archived) return;
    custView.archived = arch;
    document.querySelectorAll('#cust-which [data-arch]').forEach(x=>{ const on = x === b; x.classList.toggle('active', on); x.setAttribute('aria-pressed', String(on)); });
    loadCustomerList();
  });
  document.getElementById('cust-sort').addEventListener('click', (e)=>{
    const b = e.target.closest('[data-sort]'); if(!b || b.dataset.sort === customerSort()) return;
    setCustomerSort(b.dataset.sort);
    document.querySelectorAll('#cust-sort [data-sort]').forEach(x=>{ const on = x === b; x.classList.toggle('active', on); x.setAttribute('aria-pressed', String(on)); });
    loadCustomerList();
  });
  loadCustomerList();
  if(custView.selected) loadCustomerDetail(custView.selected);
}
function customerPickHint(){
  return `<div class="card cust-hint">${icon('users', {size: 32})}<p>Choose a customer to see their visits, stamp card and favourites.</p></div>`;
}
async function loadCustomerList(){
  const box = document.getElementById('cust-list');
  if(!box) return;
  const seq = ++custView.listSeq;
  try{
    const r = await cloud.rpc('fo_customer_list', {p_search: custView.q || '', p_limit: 30, p_staff_token: customerMoneyToken(), p_sort: customerSort(), p_archived: !!custView.archived}, {timeout: 10000});
    if(seq !== custView.listSeq || posState.route !== 'customers') return;
    if(r && r.error){ box.innerHTML = `<p class="hint cust-pad">${escapeHtml(friendlyError(r))}</p>`; return; }
    const list = (r && r.customers) || [];
    custView.list = r;
    if(!list.length){
      box.innerHTML = `<p class="hint cust-pad">${custView.archived
        ? (custView.q ? `No archived customer called “${escapeHtml(custView.q)}”.` : 'No archived customers. Customers saved without a phone number show here.')
        : (custView.q ? `No customer called “${escapeHtml(custView.q)}” with a phone number. Search uses nicknames and usernames. Customers without a number are under “Archived”.` : 'No customers yet. Tap “Add customer” to save one (with their permission).')}</p>`;
      return;
    }
    box.innerHTML = list.map(c=>`<button class="cust-row ${c.id===custView.selected?'on':''}" data-cust="${escapeHtml(c.id)}" aria-pressed="${c.id===custView.selected}">
        <span class="cust-av" aria-hidden="true">${escapeHtml(initialOf(c.nickname))}</span>
        <span class="cust-row-main"><b>${escapeHtml(c.nickname)}</b><small>${c.phone ? escapeHtml(c.phone) : 'No phone'} · ${customerSort()==='frequent' && c.visits != null ? escapeHtml(visitsText(c.visits)) + ' · ' : ''}${escapeHtml(lastVisitText(c.last_visit_at))}</small></span>
        ${r.loyalty_enabled && c.ready_rewards && c.ready_rewards.length ? `<span class="reward-dot" title="Reward ready">${icon('gift', {size: 16, label: 'Reward ready'})}</span>` : ''}
      </button>`).join('');
    box.querySelectorAll('[data-cust]').forEach(b=> b.onclick = ()=>{
      custView.selected = b.dataset.cust;
      box.querySelectorAll('[data-cust]').forEach(x=>{ const on = x.dataset.cust === custView.selected; x.classList.toggle('on', on); x.setAttribute('aria-pressed', String(on)); });
      loadCustomerDetail(custView.selected, true);
    });
  }catch(e){
    if(seq !== custView.listSeq) return;
    box.innerHTML = `<p class="hint cust-pad">${escapeHtml(e.offline ? 'No internet. The customer list needs the internet.' : friendlyError(e))}</p>`;
  }
}
async function loadCustomerDetail(id, scroll){
  const box = document.getElementById('cust-detail');
  if(!box) return;
  const seq = ++custView.detailSeq;
  box.innerHTML = '<div class="card"><p class="hint">Loading…</p></div>';
  try{
    const r = await cloud.rpc('fo_customer_detail', {p_customer_id: id, p_staff_token: customerMoneyToken()}, {timeout: 10000});
    if(seq !== custView.detailSeq || posState.route !== 'customers') return;
    if(r && r.error){
      if(r.error === 'NOT_FOUND') forgetCustomerCard(id);
      box.innerHTML = `<div class="card"><p>${escapeHtml(r.error === 'NOT_FOUND' ? 'This customer is no longer on the list (they may have been merged or removed).' : friendlyError(r))}</p></div>`;
      return;
    }
    custView.detail = r;
    if(r.customer) saveCustomerCard(r.customer);
    box.innerHTML = customerDetailHtml(r);
    const use = document.getElementById('cust-use');
    if(use) use.onclick = ()=> useCustomerForOrder(r.customer);
    if(scroll && window.matchMedia('(max-width: 820px)').matches) box.scrollIntoView({behavior: 'smooth', block: 'start'});
  }catch(e){
    if(seq !== custView.detailSeq) return;
    box.innerHTML = `<div class="card"><p>${escapeHtml(e.offline ? 'No internet. Customer details need the internet.' : friendlyError(e))}</p></div>`;
  }
}
function stampCardHtml(view){
  const ms = new Map(view.milestones.map(m => [m.stamp, m]));
  const cells = [];
  for(let i = 1; i <= view.card_size; i++){
    const m = ms.get(i);
    const filled = i <= view.stamps_on_card;
    if(m){
      const short = m.type === 'FREE_ITEM' ? 'FREE' : (m.amount != null ? '₱' + (Number(m.amount) % 1 ? Number(m.amount).toFixed(2) : Number(m.amount)) : '');
      cells.push(`<span class="s15 m st-${m.status} ${filled?'d':''}" title="${escapeHtml(ordinal(i) + ' stamp: ' + m.label)}">${m.status==='redeemed' ? icon('check', {size: 16}) : escapeHtml(short)}</span>`);
    } else cells.push(`<span class="s15 ${filled?'d':''}" aria-hidden="true"></span>`);
  }
  return `<div class="card15" role="img" aria-label="${escapeHtml(view.stamps_on_card + ' of ' + view.card_size + ' stamps')}">${cells.join('')}</div>`;
}
/* ---- Release 1.5 (B16): the next card opens only after the full card's last reward is used ----
   Stamps earned meanwhile are "saved" and land on the next card. Both come from the server
   (card.saved_stamps, history); the counter only shows them. */
function savedStampsHtml(view){
  const n = Number(view.saved_stamps) || 0;
  if(n <= 0) return '';
  const last = view.milestones.find(m => m.stamp === view.last_reward_stamp) || view.milestones[view.milestones.length - 1];
  const lastWords = last ? (last.type === 'FREE_ITEM' ? 'the free item' : 'the ' + last.label) : 'the last reward';
  return `<div class="notice saved-stamps">${icon('gift', {size: 18})} <span><b>${n} stamp${n === 1 ? '' : 's'} saved for the next card.</b>
    Card ${view.card_no + 1} starts after ${escapeHtml(lastWords)} on this card is used.</span></div>`;
}
function rewardUsedWords(r){
  const what = r.type === 'FREE_ITEM' ? (r.label || 'Free item') : (r.label || rewardLabel(r));
  return `${what}${r.used_at ? ' · ' + fmtDate(r.used_at) : ''}`;
}
function pastCardsHtml(view){
  const list = Array.isArray(view.history) ? view.history.slice().sort((a, b) => (Number(b.card_no) || 0) - (Number(a.card_no) || 0)) : [];
  if(!list.length) return '';
  return `<details class="past-cards"><summary>Past cards (${list.length})</summary>
    <div class="past-card-list">${list.map(h => {
      const rewards = Array.isArray(h.rewards) ? h.rewards : [];
      return `<div class="past-card">
        <div class="past-card-head"><b>Card ${Number(h.card_no) || ''}</b>
          <span class="text-light">${h.filled_at ? 'filled ' + escapeHtml(fmtDate(h.filled_at)) : 'not filled'} · ${h.completed_at ? 'completed ' + escapeHtml(fmtDate(h.completed_at)) : 'not completed'}</span></div>
        ${rewards.length ? `<ul class="past-card-rw">${rewards.map(r => `<li>${icon('check', {size: 14})} ${escapeHtml(rewardUsedWords(r))}</li>`).join('')}</ul>` : '<div class="text-light">No rewards used on this card.</div>'}
      </div>`;
    }).join('')}</div></details>`;
}
function customerDetailHtml(r){
  const c = r.customer || {};
  const money = !!r.show_money;
  const why = moneyRefusedText(r);
  const view = loyaltyCardView(c, r.loyalty_rewards);
  const ready = view.ready;
  const loyalty = !!r.loyalty_enabled;
  const favs = r.favourites || [];
  const maxFav = Math.max(1, ...favs.map(f => Number(f.count) || 0));
  const orders = r.recent_orders || [];
  const statusWords = {COMPLETED: '', VOIDED: 'Voided', REFUNDED: 'Refunded', PARTIALLY_REFUNDED: 'Part refunded'};
  return `
    <div class="cust-head card">
      <span class="cust-av big" aria-hidden="true">${escapeHtml(initialOf(c.nickname))}</span>
      <div class="cust-head-main"><h2>${escapeHtml(c.nickname)}${c.archived || !c.phone ? ' <span class="badge badge-gray">Archived</span>' : ''}</h2>
        ${c.username ? `<div class="cust-username">${escapeHtml(c.username)}</div>` : ''}
        <div class="text-light">${c.phone ? escapeHtml(c.phone) : 'No phone'} · ${escapeHtml(lastVisitText(c.last_visit_at))}${c.first_seen_at ? ' · customer since ' + escapeHtml(fmtDate(c.first_seen_at)) : ''}</div></div>
      <button class="btn btn-primary" id="cust-use">${icon('orders')} Use for this order</button>
    </div>
    <div class="cust-kpis">
      <div class="card kpi"><small>Visits</small><b>${Number(c.visits) || 0}</b><span class="kpi-sub">Days with a paid order</span></div>
      <div class="card kpi"><small>Stamps</small><b>${loyalty ? `${view.stamps_on_card} / ${view.card_size}` : '—'}</b><span class="kpi-sub">${loyalty ? `Card ${view.card_no}${view.saved_stamps > 0 ? ` · ${view.saved_stamps} saved` : ''}` : 'Stamp card off'}</span></div>
      <div class="card kpi"><small>Reward ready</small><b class="${ready.length && loyalty ? 'ok' : ''}">${loyalty && ready.length ? escapeHtml(ready[0].label) : 'None yet'}</b><span class="kpi-sub">${loyalty && ready.length > 1 ? `+${ready.length - 1} more` : ''}</span></div>
      <div class="card kpi" id="cust-spent"><small>Total spent</small>${money ? `<b>${fmtMoney(c.total_spent)}</b><span class="kpi-sub">After refunds</span>` : `<b class="locked">${icon('lock', {label: 'Hidden'})}</b><span class="lock-note">Managers only</span>${why ? `<span class="lock-why">${escapeHtml(why)}</span>` : ''}`}</div>
    </div>
    <div class="cust-cards">
      <div class="card">
        <h3 class="card-title">Stamp card</h3>
        ${loyalty ? `
          <p class="hint">Card ${view.card_no} · ${view.stamps_on_card} of ${view.card_size}. One stamp for a drink and one for food, each day.</p>
          ${stampCardHtml(view)}
          <div class="rw">${view.milestones.map(m=>`<div><span class="rtag ${m.status==='ready'?'ready':m.status==='redeemed'?'used':'lock'}">${m.status==='ready'?'Ready':m.status==='redeemed'?'Used':`${m.to_go} to go`}</span><span>${escapeHtml(ordinal(m.stamp))} stamp: ${escapeHtml(m.label)}</span></div>`).join('')}</div>
          ${ready.some(x => x.card_no < view.card_no) ? `<p class="hint">Also ready from earlier cards: ${ready.filter(x => x.card_no < view.card_no).map(x => escapeHtml(x.label)).join(', ')}.</p>` : ''}
          ${savedStampsHtml(view)}
          ${pastCardsHtml(view)}`
        : `<p class="hint">The stamp card is switched off. The owner can switch it on in Back Office → Settings.</p>`}
      </div>
      <div class="card">
        <h3 class="card-title">Favourites</h3>
        ${favs.length ? `<div class="fav">${favs.map(f=>`<div class="fav-row"><b>${escapeHtml(f.name)}</b><span class="bar-track"><span class="bar" style="width:${Math.max(6, Math.round((Number(f.count)||0) / maxFav * 100))}%"></span></span><span class="fav-n">${Number(f.count) || 0}×</span></div>`).join('')}</div>`
          : '<p class="hint">No orders yet.</p>'}
      </div>
    </div>
    <div class="card">
      <h3 class="card-title">Recent orders</h3>
      ${orders.length ? `<div class="table-scroll"><table class="cust-orders"><thead><tr><th>When</th><th>Order</th><th>Items</th><th class="num">Total</th></tr></thead><tbody>
        ${orders.map(o=>`<tr>
          <td>${escapeHtml(orderWhenText(o.transaction_date))}</td>
          <td><b>${escapeHtml(o.qr_order_number ? 'QR ' + o.qr_order_number : (o.order_number || ''))}</b>${statusWords[o.status] ? ` <span class="badge badge-red">${statusWords[o.status]}</span>` : ''}${o.reward && !o.reward.released ? ` <span class="badge badge-green">Reward used</span>` : ''}</td>
          <td>${(o.items || []).map(it=>`${Number(it.quantity)} × ${escapeHtml(it.name)}${Number(it.refunded_quantity) > 0 ? ` <span class="text-light">(${Number(it.refunded_quantity)} given back)</span>` : ''}`).join(', ')}</td>
          <td class="num">${money ? fmtMoney(o.grand_total) : `<span class="lock-cell" title="Managers only">${icon('lock', {size: 16, label: 'Managers only'})}</span>`}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="hint">No orders yet.</p>'}
    </div>`;
}
function useCustomerForOrder(c){
  if(!c) return;
  if(posState.qrOrder && posState.qrOrder.customer_id && posState.qrOrder.customer_id !== c.id){
    toast('This QR order already belongs to another customer. Finish or close it first.', 'warn'); return;
  }
  attachCustomer(c);
  toast(`${c.nickname} is on this order`);
  navigatePOS('pos');
}

/* =====================================================================
   SHIFT & CASH
   ===================================================================== */
/* =====================================================================
   WASTE LOG (release 1.4, A15)
   Menu items (with their options, on the same option sheet) or single stock ingredients,
   a quantity and a reason. Queued as fo_sync op 'waste' (works offline); the server works out
   the stock and cost itself. This counter takes the same stock off its own numbers right away
   (wasteStockDeltas) until the next refresh. Only Complimentary needs a manager's approval,
   exactly like a discount (OVERRIDE PIN online, or the signed-in manager's own sign-in).
   The draft is kept on this counter (per staff member) so a reload loses nothing.
   ===================================================================== */
const WASTE_DRAFT_KEY = 'cccc.fo.wasteDraft';
const WASTE_LOG_KEY = 'fo.wasteLog';          // what this counter logged (for the shift summary)
function wasteDraft(){
  const me = posState.currentUser;
  let d = null;
  try{ d = JSON.parse(localStorage.getItem(WASTE_DRAFT_KEY) || 'null'); }catch(e){ d = null; }
  if(!d || !me || d.staff_id !== me.id || !Array.isArray(d.items)) d = {staff_id: me ? me.id : null, items: [], reason: '', note: ''};
  return d;
}
function saveWasteDraft(d){ try{ localStorage.setItem(WASTE_DRAFT_KEY, JSON.stringify(d)); }catch(e){} }
function clearWasteDraft(){ try{ localStorage.removeItem(WASTE_DRAFT_KEY); }catch(e){} }

// Draft lines -> the items buildWasteData / wasteStockLines read. onlyFilled: leave out lines without an amount yet.
function wasteItemsFromDraft(d, onlyFilled){
  return d.items.filter(it => !onlyFilled || Number(it.quantity) > 0).map(it => {
    if(it.type === 'recipe'){
      const rec = state.recipes.find(r => r.id === it.recipe_id);
      return {recipe_id: it.recipe_id, quantity: Number(it.quantity), modifiers: rec ? modifiersFromSelections(rec, it.selections || []) : []};
    }
    return {ingredient_id: it.ingredient_id, quantity: it.quantity === '' || it.quantity == null ? NaN : Number(it.quantity), unit: it.unit || null};
  });
}
// Cost at today's costs, only when this counter knows the cost of every ingredient involved
// (counters don't receive purchase prices, so usually it doesn't: the owner sees the cost in
// Back Office → Waste report). -> {cost, known}
function wasteCostInfo(items){
  let lines = [];
  try{ lines = wasteStockLines(items); }catch(e){ return {cost: 0, known: false}; }
  if(!lines.length) return {cost: 0, known: true};
  const known = lines.every(l => (ingredientCosting(l.ingredient_id).current || 0) > 0);
  return {cost: known ? wasteCostPreview(items) : 0, known};
}
function wasteLineText(it){
  if(it.type === 'recipe'){
    const opts = (it.labels || []).length ? ` (${it.labels.join(', ')})` : '';
    return `${Number(it.quantity) || 0} × ${it.name}${opts}`;
  }
  return `${it.quantity === '' || it.quantity == null ? '?' : Number(it.quantity)} ${unitLabel(it.unit || '')} ${it.name}`;
}
// Plain words for a waste entry that can't be saved (codes from buildWasteData).
function wasteErrorText(e, d){
  const code = (e && (e.code || e.message)) || '';
  const nameOf = (rid) => { const r = state.recipes.find(x => x.id === rid); return r ? r.name : 'an item'; };
  if(code === 'OPTION_REQUIRED') return `Choose ${(e.missing || []).map(m => m.name).join(' and ')} for ${nameOf(e.recipe_id)}: tap Options on that line.`;
  if(code === 'BAD_WASTE' && e.problems) return `An option on ${nameOf(e.recipe_id)} is no longer on the menu. Remove that line and add it again.`;
  if(code === 'BAD_WASTE' && !(d && d.items.length)) return 'Add at least one item first.';
  if(code === 'BAD_WASTE') return 'A waste entry can have at most 30 lines. Log the rest as a second entry.';
  if(code === 'UNKNOWN_RECIPE' || code === 'UNKNOWN_INGREDIENT') return 'One of the items is no longer on this counter\'s menu. Remove it and add it again.';
  if(code === 'BAD_QUANTITY') return 'Check the amounts: each line needs an amount above 0 (at most 100 of a menu item).';
  return friendlyError(e);
}

async function openWasteLog(focusIndex){
  if(!posState.currentUser) return;
  const d = wasteDraft();
  const manager = hasRole('MANAGER');
  const body = `
    <p class="hint waste-intro">Drinks or food thrown away, given free, or made for calibration. The stock is taken off like a sale.</p>
    <div class="waste-section-title">What was wasted</div>
    <div class="waste-lines" id="waste-lines">${d.items.length ? d.items.map((it, i) => `
      <div class="waste-line" data-i="${i}">
        <div class="waste-line-main"><b>${escapeHtml(it.name)}</b>
          ${it.type === 'recipe' ? ((it.labels || []).length ? `<small>${it.labels.map(escapeHtml).join(' · ')}</small>` : '') : '<small>Ingredient</small>'}</div>
        <div class="waste-line-qty">${it.type === 'recipe'
          ? `<button class="qty-btn" data-wdec="${i}" aria-label="One less ${escapeHtml(it.name)}">${icon('minus', {size: 18})}</button><span class="qty-val">${Number(it.quantity)}</span><button class="qty-btn" data-winc="${i}" aria-label="One more ${escapeHtml(it.name)}">${icon('plus', {size: 18})}</button>`
          : `<input type="number" step="any" min="0" inputmode="decimal" class="waste-amount" data-wqty="${i}" value="${escapeHtml(it.quantity == null ? '' : String(it.quantity))}" placeholder="Amount" aria-label="Amount of ${escapeHtml(it.name)}">
             <select data-wunit="${i}" aria-label="Unit">${unitsForIngredient(ingredientById(it.ingredient_id)).map(u => `<option value="${escapeHtml(u)}" ${u === it.unit ? 'selected' : ''}>${escapeHtml(unitLabel(u))}</option>`).join('')}</select>`}</div>
        <div class="waste-line-acts">
          ${it.type === 'recipe' && recipeOptionGroups(state.recipes.find(r => r.id === it.recipe_id)).length ? `<button class="btn btn-ghost btn-sm" data-wopts="${i}">${icon('edit', {size: 18})} Options</button>` : ''}
          <button class="btn btn-ghost btn-sm icon-only" data-wrm="${i}" aria-label="Remove ${escapeHtml(it.name)}">${icon('trash', {size: 18})}</button>
        </div>
      </div>`).join('') : '<div class="waste-empty">Nothing added yet.</div>'}</div>
    <div class="waste-add">
      <button class="btn btn-outline btn-big" id="waste-add-menu">${icon('cup', {size: 20})} Add a menu item</button>
      <button class="btn btn-outline btn-big" id="waste-add-ing">${icon('box', {size: 20})} Add an ingredient</button>
    </div>
    <div class="waste-section-title">Reason</div>
    <div class="waste-reasons" role="radiogroup" aria-label="Reason">${WASTE_REASONS.map(r => `
      <button class="waste-reason ${d.reason === r.id ? 'selected' : ''}" data-reason="${r.id}" role="radio" aria-checked="${d.reason === r.id}">${escapeHtml(r.label)}${r.needs_approval ? '<small>Manager approval</small>' : ''}${r.needs_note ? '<small>Add a note</small>' : ''}</button>`).join('')}</div>
    <div id="waste-approval-note"></div>
    <div class="form-row" style="margin-top:12px;"><label for="waste-note">Note <span class="text-light" id="waste-note-need">${d.reason === 'OTHER' ? '(needed)' : '(optional)'}</span></label>
      <input id="waste-note" maxlength="${WASTE_NOTE_MAX}" value="${escapeHtml(d.note || '')}" placeholder="e.g. Dropped on the floor"></div>
    ${manager ? '<div class="waste-cost" id="waste-cost"></div>' : ''}`;
  openModal({title: 'Log waste', wide: true, body,
    foot: `${d.items.length ? '<button class="btn btn-ghost" id="waste-clear">Clear</button>' : ''}<button class="btn btn-outline" data-close>Close</button><button class="btn btn-primary" id="waste-save">Log waste</button>`,
    onMount: (root) => {
      const save = () => saveWasteDraft(d);
      const again = (fi) => { save(); openWasteLog(fi); };
      root.querySelector('[data-close]').onclick = closeModal;
      function approvalNote(){
        const box = root.querySelector('#waste-approval-note');
        if(d.reason !== 'COMPLIMENTARY'){ box.innerHTML = ''; return; }
        const own = hasRole('MANAGER') && !shortPinUser() && ownLoginToken();
        box.innerHTML = own
          ? `<div class="notice">You approve this yourself (you are signed in as a ${escapeHtml(String(ROLE_WORDS[posState.currentUser.role] || '').toLowerCase())}).</div>`
          : (!isOnline()
            ? `<div class="notice warn">${icon('wifi-off', {size: 18})} Complimentary needs a manager's PIN, and checking it needs internet. Log it when the counter is back online, or ask a signed-in manager.</div>`
            : `<div class="notice">A manager enters their PIN to approve when you tap Log waste.</div>`);
      }
      function costNote(){
        const box = root.querySelector('#waste-cost');
        if(!box) return;
        const items = wasteItemsFromDraft(d, true).filter(it => !(it.ingredient_id && !(it.quantity > 0)));
        if(!items.length){ box.innerHTML = ''; return; }
        const c = wasteCostInfo(items);
        box.innerHTML = c.known
          ? `Cost at today's prices: <b>${fmtMoney(c.cost)}</b> <span class="text-light">(managers only)</span>`
          : `<span class="text-light">The cost isn't available on this counter. The owner sees it in Back Office → Waste report.</span>`;
      }
      approvalNote(); costNote();
      root.querySelectorAll('[data-winc]').forEach(b => b.onclick = () => { const it = d.items[+b.dataset.winc]; it.quantity = Math.min(WASTE_MAX_RECIPE_QTY, Number(it.quantity) + 1); again(); });
      root.querySelectorAll('[data-wdec]').forEach(b => b.onclick = () => { const it = d.items[+b.dataset.wdec]; if(Number(it.quantity) > 1){ it.quantity = Number(it.quantity) - 1; again(); } });
      root.querySelectorAll('[data-wrm]').forEach(b => b.onclick = () => { d.items.splice(+b.dataset.wrm, 1); again(); });
      root.querySelectorAll('[data-wqty]').forEach(inp => inp.oninput = () => { d.items[+inp.dataset.wqty].quantity = inp.value; save(); costNote(); });
      root.querySelectorAll('[data-wunit]').forEach(sel => sel.onchange = () => { d.items[+sel.dataset.wunit].unit = sel.value; save(); costNote(); });
      root.querySelectorAll('[data-wopts]').forEach(b => b.onclick = () => {
        const i = +b.dataset.wopts, it = d.items[i];
        const rec = state.recipes.find(r => r.id === it.recipe_id);
        if(!rec) return;
        save();
        openModifierPicker(rec, {quantity: Number(it.quantity) || 1, selections: it.selections || []}, wasteSheetOpts(rec, (r) => {
          const dd = wasteDraft();
          if(dd.items[i]) Object.assign(dd.items[i], {quantity: r.quantity, selections: r.selections, labels: r.modifiers.map(m => m.label)});
          saveWasteDraft(dd); openWasteLog();
        }, 'Update'));
      });
      root.querySelector('#waste-add-menu').onclick = () => { save(); openWasteMenuPicker(); };
      root.querySelector('#waste-add-ing').onclick = () => { save(); openWasteIngredientPicker(); };
      root.querySelectorAll('[data-reason]').forEach(b => b.onclick = () => {
        d.reason = b.dataset.reason; save();
        root.querySelectorAll('[data-reason]').forEach(x => { const on = x === b; x.classList.toggle('selected', on); x.setAttribute('aria-checked', String(on)); });
        root.querySelector('#waste-note-need').textContent = d.reason === 'OTHER' ? '(needed)' : '(optional)';
        approvalNote();
      });
      root.querySelector('#waste-note').oninput = (e) => { d.note = e.target.value; save(); };
      const clr = root.querySelector('#waste-clear');
      if(clr) clr.onclick = async () => {
        const ok = await confirmDialog('Clear this waste entry? Nothing has been logged yet.', 'Clear');
        if(ok){ clearWasteDraft(); toast('Waste entry cleared'); } else openWasteLog();
      };
      root.querySelector('#waste-save').onclick = (ev) => submitWaste(d, root, ev.currentTarget);
      if(focusIndex != null){ const f = root.querySelector(`[data-wqty="${focusIndex}"]`); if(f) f.focus(); }
    }});
}
// The option sheet in "waste" mode: no note, at most 100, no stock check (it already happened).
function wasteSheetOpts(recipe, onDone, label){
  return {title: 'Waste: ' + recipe.name, addLabel: label || 'Add to waste', maxQty: WASTE_MAX_RECIPE_QTY, noNotes: true, noStockCheck: true,
    onDone, onCancel: () => openWasteLog()};
}
function addWasteRecipe(recipe, r){
  const d = wasteDraft();
  if(d.items.length >= WASTE_MAX_ITEMS){ toast('A waste entry can have at most 30 lines. Log this one first.', 'warn'); openWasteLog(); return; }
  d.items.push({type: 'recipe', recipe_id: recipe.id, name: recipe.name, quantity: r.quantity, selections: r.selections, labels: r.modifiers.map(m => m.label)});
  saveWasteDraft(d);
  openWasteLog();
}
function openWasteMenuPicker(){
  const list = state.recipes.filter(r => r.active !== false && !isProductionRecipe(r))
    .sort((a, b) => subcategoryRank(posCategoryOf(a), state.recipes) - subcategoryRank(posCategoryOf(b), state.recipes) || String(a.name).localeCompare(String(b.name)));
  openModal({title: 'Waste: pick a menu item', wide: true, body: `
    <label class="pos-search waste-search">${icon('search')}<input type="search" id="waste-msearch" placeholder="Search the menu" aria-label="Search the menu" autocomplete="off"></label>
    <div class="waste-pick-grid" id="waste-mlist">${list.map(r => `<button class="waste-pick" data-wrec="${escapeHtml(r.id)}" data-name="${escapeHtml(String(r.name).toLowerCase())}"><b>${escapeHtml(r.name)}</b><small>${escapeHtml(posCategoryOf(r))}</small></button>`).join('') || '<p>No menu items.</p>'}</div>`,
    foot: `<button class="btn btn-outline" data-back>Back</button>`,
    onMount: (root) => {
      root.querySelector('[data-back]').onclick = () => openWasteLog();
      root.querySelector('#waste-msearch').oninput = (e) => {
        const t = e.target.value.trim().toLowerCase();
        root.querySelectorAll('[data-wrec]').forEach(b => { b.hidden = !!t && !b.dataset.name.includes(t); });
      };
      root.querySelectorAll('[data-wrec]').forEach(b => b.onclick = () => {
        const rec = state.recipes.find(r => r.id === b.dataset.wrec);
        if(!rec) return;
        if(recipeOptionGroups(rec).length) openModifierPicker(rec, null, wasteSheetOpts(rec, (r) => addWasteRecipe(rec, r)));
        else addWasteRecipe(rec, {quantity: 1, selections: [], modifiers: []});
      });
    }});
}
function openWasteIngredientPicker(){
  // Stock items only: no merged ones, no operating supplies (ingredientPickerList's default).
  const list = ingredientPickerList().slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
  openModal({title: 'Waste: pick an ingredient', wide: true, body: `
    <label class="pos-search waste-search">${icon('search')}<input type="search" id="waste-isearch" placeholder="Search ingredients" aria-label="Search ingredients" autocomplete="off"></label>
    <div class="waste-pick-grid" id="waste-ilist">${list.map(i => `<button class="waste-pick" data-wing="${escapeHtml(i.id)}" data-name="${escapeHtml(String(i.name).toLowerCase())}"><b>${escapeHtml(i.name)}</b><small>Counted in ${escapeHtml(unitLabel(i.base_unit))}${isProducedItem(i) ? ' · house-made' : ''}</small></button>`).join('') || '<p>No ingredients.</p>'}</div>`,
    foot: `<button class="btn btn-outline" data-back>Back</button>`,
    onMount: (root) => {
      root.querySelector('[data-back]').onclick = () => openWasteLog();
      root.querySelector('#waste-isearch').oninput = (e) => {
        const t = e.target.value.trim().toLowerCase();
        root.querySelectorAll('[data-wing]').forEach(b => { b.hidden = !!t && !b.dataset.name.includes(t); });
      };
      root.querySelectorAll('[data-wing]').forEach(b => b.onclick = () => {
        const ing = ingredientById(b.dataset.wing);
        if(!ing) return;
        const d = wasteDraft();
        if(d.items.length >= WASTE_MAX_ITEMS){ toast('A waste entry can have at most 30 lines. Log this one first.', 'warn'); openWasteLog(); return; }
        d.items.push({type: 'ingredient', ingredient_id: ing.id, name: ing.name, quantity: '', unit: ing.base_unit});
        saveWasteDraft(d);
        openWasteLog(d.items.length - 1);
      });
    }});
}

async function submitWaste(d, root, btn){
  const me = posState.currentUser;
  if(!me || btn.disabled) return;
  d.note = (root.querySelector('#waste-note').value || '').trim();
  saveWasteDraft(d);
  if(!d.items.length){ toast('Add at least one item first.', 'error'); return; }
  const empty = d.items.findIndex(it => it.type === 'ingredient' && !(Number(it.quantity) > 0));
  if(empty >= 0){ toast(`Enter how much ${d.items[empty].name} was wasted.`, 'error'); const f = root.querySelector(`[data-wqty="${empty}"]`); if(f) f.focus(); return; }
  if(!d.reason){ toast('Choose a reason.', 'error'); return; }
  const shift = activeShift();
  const input = {reason: d.reason, note: d.note, staff_id: me.id, shift_id: shift ? shift.id : null, items: wasteItemsFromDraft(d)};
  let data, approverName = null;
  try{
    data = buildWasteData(input);
  }catch(e){
    if((e.code || e.message) !== 'APPROVAL_REQUIRED'){ toast(wasteErrorText(e, d), 'error'); return; }
    // Complimentary: a manager approves, exactly like a discount (checked by the server on upload).
    closeModal();
    const approver = await requireOverride('MANAGER');
    if(!approver){ openWasteLog(); return; }
    try{ data = buildWasteData(Object.assign({}, input, {approved_by: approver.id, approval_token: approver.token})); }
    catch(e2){ toast(wasteErrorText(e2, d), 'error'); openWasteLog(); return; }
    approverName = approver.name;
  }
  btn.disabled = true;
  const cost = wasteCostInfo(data.items);
  await Sync.queue('waste', data);
  await rememberWaste({id: data.id, shift_id: data.shift_id, reason: data.reason, logged_at: data.logged_at,
    staff_name: me.name, lines: d.items.length, text: d.items.map(wasteLineText).join('; '), cost: cost.known ? cost.cost : null});
  queueAudit('Waste logged', `${wasteReasonLabel(data.reason)}: ${d.items.map(wasteLineText).join('; ')}${data.note ? ' (note: ' + data.note + ')' : ''}${approverName ? ' (approved by ' + approverName + ')' : ''}`, data.id);
  clearWasteDraft();
  closeModal();
  toast(`Waste logged: ${d.items.length} line${d.items.length === 1 ? '' : 's'} (${wasteReasonLabel(data.reason)})${isOnline() ? '' : '. It uploads when the internet is back.'}`, 'success');
  if(posState.route === 'pos') renderProductGrid();
  if(posState.route === 'shift') renderShiftScreen({local: true});
}
async function loadWasteLog(){ try{ const l = await LocalDB.get(WASTE_LOG_KEY); return Array.isArray(l) ? l : []; }catch(e){ return []; } }
async function rememberWaste(entry){
  const list = (await loadWasteLog()).filter(x => x.id !== entry.id);
  list.push(entry);
  try{ await LocalDB.set(WASTE_LOG_KEY, list.slice(-300)); }catch(e){}
}
// Shift & cash: what this counter logged as waste during the open shift.
async function shiftWasteHtml(shift){
  const list = (await loadWasteLog()).filter(x => x.shift_id === shift.id);
  const manager = hasRole('MANAGER');
  const lines = list.reduce((s, x) => s + (Number(x.lines) || 0), 0);
  const allCosted = list.length && list.every(x => x.cost != null);
  const cost = list.reduce((s, x) => s + (Number(x.cost) || 0), 0);
  const byReason = WASTE_REASONS.map(r => ({label: r.label, n: list.filter(x => x.reason === r.id).length})).filter(r => r.n);
  return `<div class="section-title">Waste this shift</div>
    <div class="card drawer-card waste-summary">
      ${list.length ? `<div class="drow"><span>Entries logged on this counter</span><b>${list.length} (${lines} line${lines === 1 ? '' : 's'})</b></div>
        ${byReason.map(r => `<div class="drow"><span>${escapeHtml(r.label)}</span><b>${r.n}</b></div>`).join('')}
        ${manager ? `<div class="drow"><span>Cost</span><b>${allCosted ? fmtMoney(cost) : '<span class="text-light" style="font-weight:500;">See Back Office → Waste report</span>'}</b></div>` : ''}
        <details class="waste-list"><summary>Show entries</summary>${list.slice().reverse().map(x => `<div class="waste-entry"><span class="text-light">${fmtTime(x.logged_at)}</span> ${escapeHtml(wasteReasonLabel(x.reason))} · ${escapeHtml(x.text || '')} <span class="text-light">· ${escapeHtml(x.staff_name || '')}</span></div>`).join('')}</details>`
        : '<div class="text-light">No waste logged on this counter this shift.</div>'}
    </div>`;
}

/* =====================================================================
   BARISTA DRINK (release 1.5, B7)
   One tap opens today's calibration kit (Back Office → settings.barista_kit, read offline from
   fo_bootstrap). Staff adjust the amounts and save. It is the existing 'waste' op with reason
   CALIBRATION: works offline, no manager PIN. The adjusted amounts are kept on this counter
   (per staff member, per shop day) so a reload loses nothing.
   ===================================================================== */
const BARISTA_DRAFT_KEY = 'cccc.fo.baristaDraft';
function baristaDraft(){
  const me = posState.currentUser;
  const kit = baristaKitItems(state.settings);
  const kitIds = kit.map(l => l.ingredient_id).join(',');
  let d = null;
  try{ d = JSON.parse(localStorage.getItem(BARISTA_DRAFT_KEY) || 'null'); }catch(e){ d = null; }
  if(!d || !me || d.staff_id !== me.id || d.day !== shopDayKey() || d.kit !== kitIds || !Array.isArray(d.items)){
    d = {staff_id: me ? me.id : null, day: shopDayKey(), kit: kitIds, note: '',
      items: kit.map(l => { const ing = ingredientById(l.ingredient_id); return {ingredient_id: l.ingredient_id, quantity: String(l.quantity), unit: l.unit || (ing ? ing.base_unit : null)}; })};
  }
  return d;
}
function saveBaristaDraft(d){ try{ localStorage.setItem(BARISTA_DRAFT_KEY, JSON.stringify(d)); }catch(e){} }
function clearBaristaDraft(){ try{ localStorage.removeItem(BARISTA_DRAFT_KEY); }catch(e){} }
function baristaUnits(ing, unit){
  const list = unitsForIngredient(ing).slice();
  if(unit && !list.includes(unit)) list.unshift(unit);
  return list;
}
async function openBaristaDrink(){
  if(!posState.currentUser) return;
  const d = baristaDraft();
  if(!d.items.length){
    openModal({title: 'Barista drink', body: `
      <div class="notice warn">${icon('info', {size: 18})} <span>Ask the owner to set the barista drink kit in the Back Office.</span></div>
      <p class="hint">Until then, you can log the calibration drink with <b>Log waste</b> (reason “Calibration / barista drink”).</p>`,
      foot: `<button class="btn btn-outline" data-close>Close</button><button class="btn btn-primary" id="bd-to-waste">Log waste instead</button>`,
      onMount: (root) => {
        root.querySelector('[data-close]').onclick = closeModal;
        root.querySelector('#bd-to-waste').onclick = () => openWasteLog();
      }});
    return;
  }
  const today = (await loadWasteLog()).filter(x => x.kit && x.reason === 'CALIBRATION' && shopDayKey(x.logged_at) === shopDayKey());
  const last = today[today.length - 1];
  const body = `
    <p class="hint waste-intro">Today's calibration kit: the coffee, milk, sauces and syrups used to check the drinks. Change any amount that was different, then save. It is logged as waste (Calibration / barista drink).</p>
    ${last ? `<div class="notice">${icon('check', {size: 18})} <span>Already logged today at ${escapeHtml(fmtTime(last.logged_at))} by ${escapeHtml(last.staff_name || 'staff')}. Save again only for another barista drink.</span></div>` : ''}
    <div class="waste-lines" id="bd-lines">${d.items.map((it, i) => {
      const ing = ingredientById(it.ingredient_id);
      return `<div class="waste-line" data-i="${i}">
        <div class="waste-line-main"><b>${escapeHtml(ing ? ing.name : 'Item')}</b><small>Set to 0 to leave it out</small></div>
        <div class="waste-line-qty">
          <input type="number" step="any" min="0" inputmode="decimal" class="waste-amount" data-bqty="${i}" value="${escapeHtml(it.quantity == null ? '' : String(it.quantity))}" placeholder="Amount" aria-label="Amount of ${escapeHtml(ing ? ing.name : 'item')}">
          <select data-bunit="${i}" aria-label="Unit for ${escapeHtml(ing ? ing.name : 'item')}">${baristaUnits(ing, it.unit).map(u => `<option value="${escapeHtml(u)}" ${u === it.unit ? 'selected' : ''}>${escapeHtml(unitLabel(u))}</option>`).join('')}</select>
        </div>
      </div>`;
    }).join('')}</div>
    <div class="form-row" style="margin-top:12px;"><label for="bd-note">Note <span class="text-light">(optional)</span></label>
      <input id="bd-note" maxlength="${WASTE_NOTE_MAX}" value="${escapeHtml(d.note || '')}" placeholder="e.g. New beans, pulled 3 shots"></div>`;
  openModal({title: 'Barista drink', wide: true, body,
    foot: `<button class="btn btn-ghost" id="bd-reset">Use the usual amounts</button><button class="btn btn-outline" data-close>Close</button><button class="btn btn-primary" id="bd-save">Save barista drink</button>`,
    onMount: (root) => {
      root.querySelector('[data-close]').onclick = closeModal;
      root.querySelectorAll('[data-bqty]').forEach(inp => inp.oninput = () => { d.items[+inp.dataset.bqty].quantity = inp.value; saveBaristaDraft(d); });
      root.querySelectorAll('[data-bunit]').forEach(sel => sel.onchange = () => { d.items[+sel.dataset.bunit].unit = sel.value; saveBaristaDraft(d); });
      root.querySelector('#bd-note').oninput = (e) => { d.note = e.target.value; saveBaristaDraft(d); };
      root.querySelector('#bd-reset').onclick = () => { clearBaristaDraft(); openBaristaDrink(); };
      root.querySelector('#bd-save').onclick = (ev) => submitBaristaDrink(d, root, ev.currentTarget);
    }});
}
async function submitBaristaDrink(d, root, btn){
  const me = posState.currentUser;
  if(!me || btn.disabled) return;
  d.note = (root.querySelector('#bd-note').value || '').trim();
  saveBaristaDraft(d);
  const bad = d.items.findIndex(it => String(it.quantity).trim() !== '' && !(Number(it.quantity) >= 0));
  if(bad >= 0){ toast('Check the amounts: use a number, or 0 to leave an item out.', 'error'); const f = root.querySelector(`[data-bqty="${bad}"]`); if(f) f.focus(); return; }
  const used = d.items.filter(it => Number(it.quantity) > 0);
  if(!used.length){ toast('Enter at least one amount above 0.', 'error'); return; }
  const shift = activeShift();
  let data;
  try{
    data = buildWasteData({reason: 'CALIBRATION', note: d.note, staff_id: me.id, shift_id: shift ? shift.id : null,
      items: used.map(it => ({ingredient_id: it.ingredient_id, quantity: Number(it.quantity), unit: it.unit || null}))});
  }catch(e){
    const code = (e && (e.code || e.message)) || '';
    toast(code === 'BAD_UNIT' ? 'One of the units doesn\'t fit that item. Pick another unit.'
      : code === 'UNKNOWN_INGREDIENT' ? 'An item in the kit is no longer on this counter. Ask the owner to update the barista drink kit.'
      : code === 'BAD_QUANTITY' ? 'One of the amounts is too large. Check the amounts.'
      : wasteErrorText(e), 'error');
    return;
  }
  btn.disabled = true;
  const text = data.items.map(it => { const ing = ingredientById(it.ingredient_id); return `${Number(it.quantity)} ${unitLabel(it.unit || (ing ? ing.base_unit : ''))} ${ing ? ing.name : ''}`.trim(); }).join('; ');
  const cost = wasteCostInfo(data.items);
  await Sync.queue('waste', data);
  await rememberWaste({id: data.id, shift_id: data.shift_id, reason: data.reason, logged_at: data.logged_at, kit: true,
    staff_name: me.name, lines: data.items.length, text: 'Barista drink: ' + text, cost: cost.known ? cost.cost : null});
  queueAudit('Barista drink logged', `${text}${data.note ? ' (note: ' + data.note + ')' : ''}`, data.id);
  clearBaristaDraft();
  closeModal();
  toast(`Barista drink saved (${data.items.length} item${data.items.length === 1 ? '' : 's'})${isOnline() ? '' : '. It uploads when the internet is back.'}`, 'success');
  if(posState.route === 'pos') renderProductGrid();
  if(posState.route === 'shift') renderShiftScreen({local: true});
}

function renderStartShiftGate(){
  const content = document.getElementById('content');
  content.className = '';
  content.innerHTML = `
    <div class="start-shift">
      <div class="start-shift-ic">${icon('clock', {size: 44})}</div>
      <h2>Start a shift</h2>
      <p class="text-light" style="margin-bottom:20px;">Every sale belongs to a shift so the cash drawer can be balanced at the end. Count the drawer and start one.</p>
      <div class="card" style="text-align:left;">
        <div class="form-row"><label>Cashier</label><input value="${escapeHtml(posState.currentUser.name)}" disabled></div>
        <div class="form-row"><label>Opening cash (in the drawer now)</label><input type="number" step="any" inputmode="decimal" id="ss-opening-cash" placeholder="e.g. 2000"></div>
        <div class="form-row"><label>Notes (optional)</label><input id="ss-notes" placeholder="e.g. Morning shift"></div>
        <button class="btn btn-primary btn-big" id="ss-start-btn" style="margin-top:6px;">Start shift</button>
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
  const wasteHtml = await shiftWasteHtml(shift);
  if(posState.route !== 'shift') return;
  document.getElementById('topbar-actions').innerHTML = `
    <button class="btn btn-outline" id="cash-mgmt-btn">${icon('cash')} Pay in / pay out</button>
    <button class="btn btn-outline" id="shift-barista-btn">${icon('cup')} Barista drink</button>
    <button class="btn btn-outline" id="shift-waste-btn">${icon('trash')} Log waste</button>
    <button class="btn btn-outline" id="xreport-btn">${icon('printer')} Print X-report</button>
    <button class="btn btn-danger" id="close-shift-btn">Close shift</button>`;
  document.getElementById('cash-mgmt-btn').onclick = openCashManagementModal;
  document.getElementById('shift-barista-btn').onclick = ()=> openBaristaDrink();
  document.getElementById('shift-waste-btn').onclick = ()=> openWasteLog();
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
      ${m.cashMovements.map(c=>`<tr><td>${fmtTime(c.at)}</td><td>${c.type==='PAY_IN'?'Pay In':'Pay Out'}</td><td>${fmtMoney(c.amount)}</td><td>${escapeHtml(c.reason)}</td><td>${escapeHtml(c.performed_by_name||'')}</td></tr>`).join('')}</tbody></table></div>`:''}
    ${wasteHtml}`;
}

function openCashManagementModal(){
  const shift = activeShift();
  if(!shift) return;
  let mode = 'PAY_IN';
  openModal({title:'Pay in / pay out', body:`
    <div class="pay-methods" style="grid-template-columns:1fr 1fr;">
      <button class="pay-method-btn selected" data-mode="PAY_IN">${icon('plus', {size: 26})}<span>Pay in</span></button>
      <button class="pay-method-btn" data-mode="PAY_OUT">${icon('minus', {size: 26})}<span>Pay out</span></button>
    </div>
    <div class="form-row" style="margin-top:14px;"><label>Amount</label><input type="number" step="any" inputmode="decimal" id="cm-amount" placeholder="0.00"></div>
    <div class="form-row"><label>Reason</label><input id="cm-reason" placeholder="e.g. Change fund top-up / Bought ice"></div>`,
  foot:`<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" id="cm-save">Record</button>`,
  onMount:(root)=>{
    root.querySelector('[data-cancel]').onclick = closeModal;
    root.querySelectorAll('[data-mode]').forEach(b=> b.onclick = ()=>{ mode=b.dataset.mode; root.querySelectorAll('[data-mode]').forEach(x=>x.classList.toggle('selected', x===b)); });
    root.querySelector('#cm-save').onclick = async ()=>{
      // Rounded to the centavo, so ₱0.004 counts as ₱0 (the server refuses ₱0 or less: AMOUNT_NOT_POSITIVE).
      const typed = Number(root.querySelector('#cm-amount').value);
      const amount = Number.isFinite(typed) ? Math.round(typed * 100) / 100 : NaN;
      const reason = root.querySelector('#cm-reason').value.trim();
      if(!(amount > 0)){ toast('Enter an amount more than ₱0', 'error'); root.querySelector('#cm-amount').focus(); return; }
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
  if(btn){ btn.disabled = false; btn.textContent = 'Close shift'; }
  const shift = activeShift();
  if(!shift) return;
  // Release 1.5 (B9): with items ticked "Count at closing", staff count them first (blind).
  if(countAtCloseIngredients().length){
    openStockCount(shift, (count)=> showCloseShiftDialog(shift, closer, closeApprovalToken, checked, {count}));
    return;
  }
  showCloseShiftDialog(shift, closer, closeApprovalToken, checked, {});
}

/* ---- Count at closing (release 1.5, B9) ----
   Before Close shift, staff type what they counted for each ticked item. The screen never shows
   what the stock should be (blind count). Confirming shows ONLY the items that differ (from the
   shared countDifferences) for a recount, without saying by how much. The count is queued as
   'stock_count' right before 'shift_close' (the outbox uploads in order), so it works offline.
   What staff type is kept on this counter until the shift closes (a reload loses nothing). */
const COUNT_DRAFT_KEY = 'cccc.fo.countDraft';
function countDraft(shift){
  let d = null;
  try{ d = JSON.parse(localStorage.getItem(COUNT_DRAFT_KEY) || 'null'); }catch(e){ d = null; }
  if(!d || d.shift_id !== shift.id || !d.lines || typeof d.lines !== 'object') d = {shift_id: shift.id, lines: {}, note: '', recounted: []};
  return d;
}
function saveCountDraft(d){ try{ localStorage.setItem(COUNT_DRAFT_KEY, JSON.stringify(d)); }catch(e){} }
function clearCountDraft(){ try{ localStorage.removeItem(COUNT_DRAFT_KEY); }catch(e){} }
// Typed lines for the ticked items (blank ones left out: buildStockCountData names them).
function countLinesFromDraft(d){
  return countAtCloseIngredients().map(ing => {
    const e = d.lines[ing.id];
    if(!e || String(e.quantity == null ? '' : e.quantity).trim() === '') return null;
    return {ingredient_id: ing.id, quantity: Number(e.quantity), unit: e.unit || ing.base_unit};
  }).filter(Boolean);
}
function countErrorText(e){
  const code = (e && (e.code || e.message)) || '';
  if(code === 'COUNT_REQUIRED'){
    const names = (e.missing || []).map(m => m.name);
    return names.length ? `Enter a count for ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` and ${names.length - 3} more` : ''}. Type 0 if there is none left.` : friendlyError('COUNT_REQUIRED');
  }
  if(code === 'BAD_QUANTITY') return 'Check the amounts: each count must be 0 or more.';
  if(code === 'BAD_UNIT') return 'One of the units doesn\'t fit that item. Pick another unit.';
  if(code === 'UNKNOWN_INGREDIENT' || code === 'BAD_COUNT') return 'The list of items to count changed. Close this and tap Close shift again.';
  return friendlyError(e);
}
function countRowHtml(ing, e, attr){
  const units = unitsForIngredient(ing);
  const unit = (e && e.unit) || ing.base_unit;
  if(unit && !units.includes(unit)) units.unshift(unit);
  return `<div class="waste-line count-line" data-ing="${escapeHtml(ing.id)}">
      <div class="waste-line-main"><b>${escapeHtml(ing.name)}</b><small>Counted in ${escapeHtml(unitLabel(ing.base_unit))}</small></div>
      <div class="waste-line-qty">
        <input type="number" step="any" min="0" inputmode="decimal" class="waste-amount" ${attr}="${escapeHtml(ing.id)}" value="${escapeHtml(e && e.quantity != null ? String(e.quantity) : '')}" placeholder="Count" aria-label="Counted amount of ${escapeHtml(ing.name)}">
        <select data-cunit="${escapeHtml(ing.id)}" aria-label="Unit for ${escapeHtml(ing.name)}">${units.map(u => `<option value="${escapeHtml(u)}" ${u === unit ? 'selected' : ''}>${escapeHtml(unitLabel(u))}</option>`).join('')}</select>
      </div>
    </div>`;
}
function wireCountRows(root, d, attr){
  root.querySelectorAll(`[${attr}]`).forEach(inp => inp.oninput = () => {
    const id = inp.getAttribute(attr);
    d.lines[id] = Object.assign({}, d.lines[id] || {}, {quantity: inp.value});
    saveCountDraft(d);
  });
  root.querySelectorAll('[data-cunit]').forEach(sel => sel.onchange = () => {
    const id = sel.dataset.cunit;
    d.lines[id] = Object.assign({}, d.lines[id] || {}, {unit: sel.value});
    saveCountDraft(d);
  });
}
// Step 1: the count list (ticked items only, no expected amounts).
function openStockCount(shift, onDone){
  const d = countDraft(shift);
  const items = countAtCloseIngredients();
  openModal({title: 'Count before closing', wide: true, body: `
    <p class="hint waste-intro">Count or weigh each item and type what is there now. Type 0 if there is none. The expected amounts are hidden on purpose.</p>
    <div class="waste-lines" id="count-lines">${items.map(ing => countRowHtml(ing, d.lines[ing.id], 'data-cqty')).join('')}</div>
    <div class="form-row" style="margin-top:12px;"><label for="count-note">Note <span class="text-light">(optional)</span></label>
      <input id="count-note" maxlength="${STOCK_COUNT_NOTE_MAX}" value="${escapeHtml(d.note || '')}" placeholder="e.g. One milk carton opened today"></div>
    ${!isOnline() ? `<p class="hint">${icon('wifi-off', {size: 16})} Offline: the count is saved on this counter and uploads with the shift close.</p>` : ''}`,
    foot: `<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" id="count-next">Confirm count</button>`,
    onMount: (root) => {
      root.querySelector('[data-cancel]').onclick = closeModal;
      wireCountRows(root, d, 'data-cqty');
      root.querySelector('#count-note').oninput = (e) => { d.note = e.target.value; saveCountDraft(d); };
      root.querySelector('#count-next').onclick = () => {
        d.note = (root.querySelector('#count-note').value || '').trim();
        saveCountDraft(d);
        try{ buildStockCountData({shift_id: shift.id, staff_id: posState.currentUser.id, note: d.note, lines: countLinesFromDraft(d)}); }
        catch(e){
          toast(countErrorText(e), 'error');
          const first = e && e.missing && e.missing[0] && root.querySelector(`[data-cqty="${CSS.escape(e.missing[0].ingredient_id)}"]`);
          if(first) first.focus();
          return;
        }
        const diffs = countDifferences(countLinesFromDraft(d));
        if(!diffs.length){ finishStockCount(shift, d, onDone); return; }
        openCountDoubleCheck(shift, d, diffs.map(x => x.ingredient_id), onDone);
      };
      const firstEmpty = items.find(ing => !(d.lines[ing.id] && String(d.lines[ing.id].quantity || '').trim() !== ''));
      setTimeout(() => { const f = firstEmpty && root.querySelector(`[data-cqty="${CSS.escape(firstEmpty.id)}"]`); if(f) f.focus(); }, 50);
    }});
}
// Step 2: the double-check. Only the items that differ, without saying by how much or which way.
function openCountDoubleCheck(shift, d, ids, onDone){
  const items = countAtCloseIngredients().filter(ing => ids.includes(ing.id) || ids.includes(mergeTarget(ing.id).id));
  openModal({title: 'Please recount these', wide: true, body: `
    <div class="notice warn">${icon('alert', {size: 18})} <span>${items.length === 1 ? 'This item doesn\'t' : `These ${items.length} items don't`} match what the shop expects. Count ${items.length === 1 ? 'it' : 'them'} again and fix the number if needed, then confirm.</span></div>
    <div class="waste-lines" id="recount-lines">${items.map(ing => countRowHtml(ing, d.lines[ing.id], 'data-rqty')).join('')}</div>
    <p class="hint">If your number is right, just confirm. The owner reviews differences in the Back Office.</p>`,
    foot: `<button class="btn btn-outline" id="recount-back">Back to the full list</button><button class="btn btn-primary" id="recount-ok">Confirm count</button>`,
    onMount: (root) => {
      wireCountRows(root, d, 'data-rqty');
      root.querySelector('#recount-back').onclick = () => openStockCount(shift, onDone);
      root.querySelector('#recount-ok').onclick = () => {
        try{ buildStockCountData({shift_id: shift.id, staff_id: posState.currentUser.id, note: d.note, lines: countLinesFromDraft(d)}); }
        catch(e){ toast(countErrorText(e), 'error'); return; }
        d.recounted = items.map(i => i.id);
        finishStockCount(shift, d, onDone);
      };
      setTimeout(() => { const f = root.querySelector('[data-rqty]'); if(f) f.focus(); }, 50);
    }});
}
function finishStockCount(shift, d, onDone){
  d.counted_at = new Date().toISOString();
  d.done = true;
  saveCountDraft(d);
  closeModal();
  onDone({draft: d});
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
    ${preset && preset.count ? `<div class="notice count-done" style="margin-top:12px;">${icon('check', {size: 18})} <span>Stock count done: ${countLinesFromDraft(preset.count.draft).length} item(s)${(preset.count.draft.recounted || []).length ? `, ${preset.count.draft.recounted.length} recounted` : ''}. It is saved with the shift close. <a class="linklike" id="cs-recount" role="button" tabindex="0">Count again</a></span></div>` : ''}
    ${Sync.pending?`<div class="notice warn" style="margin-top:12px;">${Sync.pending} item(s) are still uploading. Closing is fine — they upload in order.</div>`:''}
    <div class="form-row" style="margin-top:14px;"><label>Declared Cash (counted)</label><input type="number" step="any" inputmode="decimal" id="cs-declared" placeholder="0.00"></div>
    <div class="change-display" id="cs-variance-display" style="display:none;"><div class="lbl" id="cs-variance-lbl">Variance</div><div class="val" id="cs-variance-val">₱0.00</div></div>
    <div class="form-row" id="cs-notes-row" style="margin-top:10px;display:none;"><label>Reason for variance (required)</label><input id="cs-notes"></div>`;
  openModal({title:`Close Shift ${escapeHtml(shift.shift_number||'')}`, wide:true, body,
    foot:`<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-danger" id="cs-confirm">Confirm Close Shift</button>`,
    onMount:(root)=>{
      root.querySelector('[data-cancel]').onclick = closeModal;
      const recount = root.querySelector('#cs-recount');
      if(recount){
        const go = ()=> openStockCount(shift, (count)=> showCloseShiftDialog(shift, closer, closeApprovalToken, checked, Object.assign({}, preset, {count})));
        recount.onclick = go; recount.onkeydown = (e)=>{ if(e.key==='Enter' || e.key===' '){ e.preventDefault(); go(); } };
      }
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
          showCloseShiftDialog(current, closer, closeApprovalToken, stillChecked, {declared, note, count: preset && preset.count});
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
        // Release 1.5 (B9): the count goes first (the server closes the shift only after a full count).
        let countData = null;
        if(countAtCloseIngredients().length){
          const cd = preset && preset.count ? preset.count.draft : null;
          try{
            if(!cd) throw Object.assign(new Error('COUNT_REQUIRED'), {code: 'COUNT_REQUIRED'});
            countData = buildStockCountData({shift_id: shift.id, staff_id: posState.currentUser.id, counted_at: cd.counted_at, note: cd.note, lines: countLinesFromDraft(cd)});
          }catch(e){
            // The list of items to count changed meanwhile (e.g. the owner ticked another one): count again.
            closeModal();
            toast('The list of items to count changed. Please count again before closing.', 'warn');
            openStockCount(shift, (count)=> showCloseShiftDialog(shift, closer, closeApprovalToken, stillChecked, {declared, note, count}));
            return;
          }
        }
        if(countData){
          await Sync.queue('stock_count', countData);
          queueAudit('Stock count at closing', `${shift.shift_number} — ${countData.lines.length} item(s) counted${countData.note ? ' (note: ' + countData.note + ')' : ''}`, countData.id);
          clearCountDraft();
        }
        await Sync.queue('shift_close', closeOp);
        queueAudit('Shift closed', `${shift.shift_number} — variance ${fmtMoney(variance)}`, shift.id);
        closeModal();
        toast('Shift closed');
        showShiftReport(shift.id, {justClosed: true});
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
// The shift report box. justClosed: the shift was closed a moment ago -> the Z report prints by
// itself (Printer screen switch). Printing problems show inside this box, never replacing it.
function showShiftReport(shiftId, opts){
  const shift = state.shifts.find(s=>s.id===shiftId);
  const m = shiftMetrics(shift);
  openModal({title:`Shift Report — ${escapeHtml(shift.shift_number||'')}`, wide:true, body:`
    <div id="sr-print-status" class="sr-print-status" aria-live="polite"></div>
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
  foot:`<button class="btn btn-outline" id="sr-print">${icon('printer')} Print</button><button class="btn btn-primary" data-done>Done</button>`,
  onMount:(root)=>{
    const box = root.querySelector('#sr-print-status');
    root.querySelector('[data-done]').onclick = ()=>{ closeModal(); navigatePOS('pos'); };
    root.querySelector('#sr-print').onclick = async (ev)=>{
      const b = ev.currentTarget; b.disabled = true;
      await printInto(box, [shiftReportJob(shift.id, false)], true);
      if(document.body.contains(b)) b.disabled = false;
    };
    if(opts && opts.justClosed && typeof Printer !== 'undefined' && Printer.settings().auto_print_shift){
      if(canPrintDirectHere()) printInto(box, [shiftReportJob(shift.id, false)]);
      else autoPrintNoteOnce();
    }
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
// X-report: the latest figures (the server is asked first unless they were checked a moment
// ago), straight to the receipt printer. Problems: the usual message ("Use print screen" there).
async function printXReport(ev){
  const shift = activeShift();
  if(!shift) return;
  const btn = ev && ev.currentTarget;
  if(btn && btn.disabled) return;
  if(!printerDirect()){
    // No usable receipt printer: the tap opens the print screen. The window opens right away
    // (allowed only straight after a tap) and is filled once the latest figures are in.
    if(!isOnline() || Date.now() - posState.shiftSyncedAt < 20000){ shiftReportJob(shift.id, true).screen(); return; }
    const win = window.open('', '_blank');
    if(!win){ toast('Please allow pop-ups to view/print', 'error'); return; }
    try{ win.document.write('<p style="font-family:sans-serif;margin:24px;">Getting the latest figures…</p>'); }catch(e){}
    posState.shiftCheckOk = await refreshOpenShift({timeout: SHIFT_CHECK_MS});
    const cur = activeShift() || shift;
    try{
      win.document.open(); win.document.write(shiftReportHtml(cur, shiftMetrics(cur), true)); win.document.close();
      win.focus(); setTimeout(()=>{ try{ win.print(); }catch(e){} }, 350);
    }catch(e){ console.warn('could not fill the X-report', e); }
    if(posState.route === 'shift' && !document.getElementById('active-modal-overlay')) renderShiftScreen({local: true});
    return;
  }
  if(btn) btn.disabled = true;
  let refreshed = false;
  try{
    if(isOnline() && Date.now() - posState.shiftSyncedAt >= 20000){
      posState.shiftCheckOk = await refreshOpenShift({timeout: SHIFT_CHECK_MS});
      refreshed = true;
    }
    const current = activeShift() || shift;
    await runPrintJobs([shiftReportJob(current.id, true)], {okToast: 'X-report printed', saved: 'Nothing changed: the shift is still open.'});
  } finally {
    if(btn && document.body.contains(btn)) btn.disabled = false;
  }
  if(refreshed && posState.route === 'shift' && !document.getElementById('active-modal-overlay')) renderShiftScreen({local: true});
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
      // The shop's day (Manila), never the tablet's own clock zone (release 1.5 time-zone fix).
      const from = shopMidnight();
      const to = shopDayRange().to;
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
          <td>${fmtTime(s.transaction_date)}</td><td>${escapeHtml(s.cashier_name||'')}</td><td>${paymentWords(s, pay)}</td>
          <td>${saleStatusBadge(s.status)}</td><td>${fmtMoney(s.grand_total)}</td>
          <td><button class="btn btn-sm btn-ghost" data-reprint="${s.id}">Reprint</button></td></tr>`;
      }).join('')}</tbody></table></div>` : emptyBlock(salesView==='shift' ? 'No sales in this shift yet.' : 'No sales today yet.')}`;
  content.querySelectorAll('tr[data-id]').forEach(tr=> tr.onclick = (e)=>{ if(e.target.closest('[data-reprint]')) return; navigatePOS('saleDetail', tr.dataset.id); });
  content.querySelectorAll('[data-reprint]').forEach(b=> b.onclick = (e)=>{ e.stopPropagation(); showReceipt(b.dataset.reprint, {autoPrint:true}, salesDataset()); });
}

// "Cash", "GCash"… ; a sale the stamp reward paid in full says so.
function paymentWords(sale, pay){
  if(!pay) return '—';
  if(Number(sale.grand_total) === 0 && Number(sale.loyalty_discount) > 0) return 'Stamp reward';
  const m = PAYMENT_METHODS.find(x => x.id === pay.method);
  return escapeHtml(m ? m.label : pay.method);
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
    <button class="btn btn-ghost btn-sm" id="back-sh">${icon('chevron-left', {size: 18})} Back to sales</button>
    <div class="ingredient-detail-header" style="margin-top:10px;">
      <div><h2 class="detail-title">${escapeHtml(sale.transaction_number)}</h2>
        <div style="margin-top:6px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">${saleStatusBadge(sale.status)}<span class="tag-pill">${fmtDateTime(sale.transaction_date)}</span><span class="tag-pill">Cashier: ${escapeHtml(sale.cashier_name||'')}</span>${sale.source==='QR'?'<span class="tag-pill">QR order</span>':''}</div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button class="btn btn-outline" id="reprint-btn">${icon('printer')} Reprint</button>
        ${sale.status==='COMPLETED'?`<button class="btn btn-danger" id="void-btn">Void</button>`:''}
        ${sale.status==='COMPLETED' || sale.status==='PARTIALLY_REFUNDED'?`<button class="btn btn-amber" id="refund-btn">Refund</button>`:''}
      </div>
    </div>
    <div class="grid grid-4" style="margin-top:20px;">
      ${statCard('Total', fmtMoney(sale.grand_total),'')}${statCard('Payment', escapeHtml(pay.method||'—'), pay.reference?('Ref '+escapeHtml(pay.reference)):'')}
      ${statCard('Discount', Number(sale.discount_amount)>0?fmtMoney(sale.discount_amount):'—', [sale.discount_approved_by_name?('by '+escapeHtml(sale.discount_approved_by_name)):'', Number(sale.loyalty_discount)>0?('Stamp reward -'+fmtMoney(sale.loyalty_discount)):''].filter(Boolean).join(' · '))}
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
