/* =====================================================================
   FRONT OFFICE — new pieces for CCCC:
   start-up & device pairing · server-checked PINs (with an offline
   fallback) · sync status · QR order queue · customers on a sale ·
   "This Device" screen.
   ===================================================================== */
const FO_STORES = ['categories','ingredients','recipes','recipeIngredients','inventoryTransactions','sales','saleItems',
  'payments','refunds','users','shifts','cashMovements','diningTables','customers','orders','orderItems'];
let sb = null;
const FO = { device: null, timers: [], lastOrderIds: null, channel: null };
function currentActorId(){ return posState.currentUser ? posState.currentUser.id : null; }

/* ---------- device record on this tablet ---------- */
const DEVICE_KEY = 'cccc-fo-device';
function loadDevice(){ try{ return JSON.parse(localStorage.getItem(DEVICE_KEY)||'null'); }catch(e){ return null; } }
function saveDevice(d){ try{ localStorage.setItem(DEVICE_KEY, JSON.stringify(d)); }catch(e){} }
function clearDevice(){ try{ localStorage.removeItem(DEVICE_KEY); }catch(e){} }

/* ---------- start-up ---------- */
async function bootstrap(){
  setupGlobalErrorToasts();
  wirePairScreen();
  if('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('./sw.js').catch(()=>{});
  try { sb = createSupabase('cccc-frontoffice'); }
  catch(e){ showFoBootError(friendlyError(e)); return; }
  FO.device = loadDevice();
  if(!FO.device){ showPairScreen(); return; }
  let session = null;
  try{ ({data:{session}} = await sb.auth.getSession()); }catch(e){ session = null; }
  // Offline, the saved login may not be readable yet; carry on with the saved device
  // and let the login recover by itself when the internet is back.
  if(!session && navigator.onLine){
    clearDevice();
    showPairScreen('This tablet’s sign-in was lost. Pair it again with a new code from the Back Office.');
    return;
  }
  await startFrontOffice();
}

async function startFrontOffice(){
  showFoBoot('Getting the counter ready…');
  if(navigator.onLine){
    try{
      const {data, error} = await sb.rpc('device_info');
      if(!error && data && data.paired === false){
        clearDevice(); await sb.auth.signOut();
        showPairScreen('This device was removed from the shop. Pair it again with a new code from the Back Office.');
        return;
      }
      if(!error && data && data.device){ FO.device = Object.assign({}, FO.device, data.device); saveDevice(FO.device); }
    }catch(e){ /* offline or slow: carry on with the saved device */ }
  }
  await Data.init({sb, businessId: FO.device.business_id, appName:'fo', mode:'queued', stores: FO_STORES, windowDays: 35,
    deviceSettings: {device_tag: FO.device.device_tag}, deviceId: FO.device.id});
  let loaded = false;
  if(navigator.onLine){
    try{ await Data.loadAll(); loaded = true; }
    catch(e){ console.warn('Could not load from Supabase, trying the saved copy', e); }
  }
  if(!loaded){
    loaded = await Data.loadSnapshot();
    if(loaded) setTimeout(()=> toast('Offline — using the menu saved on this tablet. Sales upload when the internet is back.', 'warn'), 400);
  }
  if(!loaded){ showFoBootError('This tablet needs the internet the first time it starts. Connect to Wi-Fi and try again.', true); return; }
  await seedNumbersFromServer();
  applyCustomTheme();
  document.getElementById('fo-boot').style.display='none';
  document.getElementById('pair-screen').style.display='none';
  document.getElementById('pin-gate').style.display='flex';
  restoreOverrideCancelLink();
  await initPinGate();
  Data.onStatus(()=> renderSyncPill());
  startFoTimers();
  FO.lastOrderIds = new Set(state.orders.filter(o=>o.status==='NEW').map(o=>o.id));
}

// Continue receipt/shift numbering from the highest number this device already used.
async function seedNumbersFromServer(){
  if(!navigator.onLine) return;
  const year = new Date().getFullYear(), tag = FO.device.device_tag;
  try{
    const a = await sb.from('sales').select('transaction_number').eq('business_id', Data.businessId).like('transaction_number', `POS-${tag}-${year}-%`).order('transaction_number', {ascending:false}).limit(1);
    if(!a.error && a.data && a.data[0]) seedDeviceSequence('sale', parseInt(String(a.data[0].transaction_number).split('-').pop(),10)||0);
    const b = await sb.from('shifts').select('shift_number').eq('business_id', Data.businessId).like('shift_number', `SHIFT-${tag}-${year}-%`).order('shift_number', {ascending:false}).limit(1);
    if(!b.error && b.data && b.data[0]) seedDeviceSequence('shift', parseInt(String(b.data[0].shift_number).split('-').pop(),10)||0);
  }catch(e){ /* numbering still continues from what this tablet knows */ }
}

function startFoTimers(){
  FO.timers.forEach(clearInterval); FO.timers = [];
  // fresh menu, prices, stock and settings
  FO.timers.push(setInterval(async ()=>{
    if(!navigator.onLine || document.getElementById('active-modal-overlay')) return;
    try{
      await Data.refresh();
      applyCustomTheme();
      if(posState.currentUser && posState.route==='pos' && !document.querySelector('.modal-overlay')) { renderProductGrid(); }
    }catch(e){ console.warn('refresh failed', e); }
  }, 60*1000));
  // QR order queue
  FO.timers.push(setInterval(()=> refreshOrders(), 12*1000));
  setTimeout(()=> refreshOrders(), 1500);
  try{
    FO.channel = sb.channel('orders-'+Data.businessId)
      .on('postgres_changes', {event:'*', schema:'public', table:'orders', filter:'business_id=eq.'+Data.businessId}, ()=> refreshOrders())
      .subscribe();
  }catch(e){ /* polling still works */ }
  window.addEventListener('online', ()=>{ Data.flush(); refreshOrders(); renderSyncPill(); });
  window.addEventListener('offline', renderSyncPill);
}

/* ---------- boot / pairing screens ---------- */
function showFoBoot(msg){
  ['pair-screen','pin-gate','app'].forEach(id=>{ const e = document.getElementById(id); if(e) e.style.display='none'; });
  const b = document.getElementById('fo-boot');
  b.style.display='flex';
  b.querySelector('.boot-msg').textContent = msg;
  b.querySelector('.boot-actions').innerHTML = '';
}
function showFoBootError(msg, retry){
  showFoBoot(msg);
  const a = document.getElementById('fo-boot').querySelector('.boot-actions');
  a.innerHTML = retry ? '<button class="btn btn-primary" id="fo-retry">Try again</button>' : '';
  if(retry) a.querySelector('#fo-retry').onclick = ()=> location.reload();
}
function showPairScreen(msg){
  ['fo-boot','pin-gate','app'].forEach(id=>{ const e = document.getElementById(id); if(e) e.style.display='none'; });
  document.getElementById('pair-screen').style.display='flex';
  const m = document.getElementById('pair-msg');
  m.textContent = msg||''; m.className = 'auth-msg' + (msg?' err':'');
}
function wirePairScreen(){
  const form = document.getElementById('pair-form');
  if(!form) return;
  form.onsubmit = async (e)=>{
    e.preventDefault();
    const code = form.querySelector('#pair-code').value.trim();
    const name = form.querySelector('#pair-name').value.trim();
    const msg = document.getElementById('pair-msg');
    if(code.replace(/[^A-Za-z0-9]/g,'').length !== 8){ msg.textContent = 'The pairing code has 8 letters and numbers.'; msg.className='auth-msg err'; return; }
    const btn = form.querySelector('button[type=submit]'); btn.disabled = true;
    msg.textContent = 'Pairing…'; msg.className = 'auth-msg';
    try{
      let {data:{session}} = await sb.auth.getSession();
      if(!session){
        const r = await sb.auth.signInAnonymously();
        if(r.error) throw r.error;
      }
      const {data, error} = await sb.rpc('pair_device', {p_code: code, p_device_name: name || null});
      if(error) throw error;
      if(rpcFailed(data)){ msg.textContent = rpcMessage(data); msg.className='auth-msg err'; return; }
      FO.device = data.device; saveDevice(FO.device);
      await startFrontOffice();
    }catch(err){
      const m = String(err && err.message || '');
      msg.textContent = /anonymous/i.test(m) ? 'Anonymous sign-ins are turned off in Supabase. Turn them on (see the setup guide), then try again.' : friendlyError(err);
      msg.className='auth-msg err';
    }finally{ btn.disabled = false; }
  };
}

/* ---------- PIN check: server first, tablet fallback when offline ---------- */
function pinSalt(){
  let s = null; try{ s = localStorage.getItem('cccc-fo-salt'); }catch(e){}
  if(!s){ s = uid(); try{ localStorage.setItem('cccc-fo-salt', s); }catch(e){} }
  return s;
}
async function pinVerifier(staffId, pin){
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pinSalt()+':'+staffId+':'+pin));
  return [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
function offlinePinCache(){ try{ return JSON.parse(localStorage.getItem('cccc-fo-pins')||'{}'); }catch(e){ return {}; } }
function saveOfflinePinCache(c){ try{ localStorage.setItem('cccc-fo-pins', JSON.stringify(c)); }catch(e){} }
const ROLE_ORDER = {CASHIER:1, MANAGER:2, ADMIN:3};

async function verifyStaffPin(pin, minRole, switchUser){
  if(navigator.onLine){
    try{
      const {data, error} = await sb.rpc('staff_pin_login', {p_pin: pin, p_min_role: minRole, p_switch: !!switchUser});
      if(error) throw error;
      if(data && data.ok){
        const cache = offlinePinCache();
        cache[data.staff.id] = {name: data.staff.name, role: data.staff.role, v: await pinVerifier(data.staff.id, pin), at: new Date().toISOString()};
        saveOfflinePinCache(cache);
        return data.staff;
      }
      if(data && data.error==='device_not_paired'){ clearDevice(); showPairScreen('This device was removed from the shop. Pair it again.'); return null; }
      if(data && data.error==='locked') showPinError(`Too many wrong PINs. Try again in ${data.retry_in} seconds.`);
      else showPinError(rpcMessage(data, 'Incorrect PIN'));
      return null;
    }catch(e){
      if(!Data.isNetworkError(e)){ showPinError(friendlyError(e)); return null; }
      // fall through to the offline check
    }
  }
  const cache = offlinePinCache();
  const cutoff = Date.now() - 14*86400000;
  for(const [staffId, rec] of Object.entries(cache)){
    if(new Date(rec.at).getTime() < cutoff) continue;
    if(rec.v === await pinVerifier(staffId, pin)){
      const live = state.users.find(u=>u.id===staffId);
      if(live && live.active===false){ showPinError('This staff member is inactive.'); return null; }
      const role = (live && live.role) || rec.role;
      if(minRole && ROLE_ORDER[role] < ROLE_ORDER[minRole]){ showPinError(`This needs a ${minRole.toLowerCase()} PIN.`); return null; }
      return {id: staffId, name: (live && live.name) || rec.name, role};
    }
  }
  showPinError('Offline: only staff who signed in on this tablet in the last 14 days can sign in until the internet is back.');
  return null;
}

/* ---------- sync status ---------- */
function renderSyncPill(){
  const pill = document.getElementById('offline-pill');
  if(!pill) return;
  const st = Data.status();
  const online = navigator.onLine;
  let cls = 'online', text = 'Online · all saved';
  if(st.failed){ cls = 'offline'; text = `${st.failed} couldn't upload — see This Device`; }
  else if(!online && st.pending){ cls = 'offline'; text = `Offline · ${st.pending} waiting to upload`; }
  else if(!online){ cls = 'offline'; text = 'Offline · sales still work'; }
  else if(st.pending){ text = `Uploading ${st.pending}…`; }
  pill.className = cls; pill.innerHTML = `<span class="dot"></span> ${text}`;
  if(posState.route==='settings' && document.getElementById('dev-sync')) renderDeviceSync();
}

/* ---------- QR order queue ---------- */
const OPEN_ORDER = ['NEW','ACCEPTED','READY'];
let ordersRefreshing = false;
async function refreshOrders(){
  if(ordersRefreshing || !navigator.onLine || !Data.businessId) return;
  ordersRefreshing = true;
  try{
    const open = await Data._select('orders', (q)=> q.eq('business_id', Data.businessId).in('status', OPEN_ORDER));
    const openIds = new Set(open.map(o=>o.id));
    const vanished = state.orders.filter(o=> OPEN_ORDER.includes(o.status) && !openIds.has(o.id) && !o._pending).map(o=>o.id);
    const changed = vanished.length ? await Data._selectByIds('orders', 'id', vanished) : [];
    Data._merge('orders', open.concat(changed));
    const needItems = open.filter(o=> !state.orderItems.some(i=>i.orderId===o.id)).map(o=>o.id);
    if(needItems.length) Data._merge('orderItems', await Data._selectByIds('order_items', 'order_id', needItems));
    Data._reapplyOutbox(); // keep status changes made here that haven't uploaded yet
    const newIds = state.orders.filter(o=>o.status==='NEW').map(o=>o.id);
    const fresh = FO.lastOrderIds ? newIds.filter(id=> !FO.lastOrderIds.has(id)) : [];
    FO.lastOrderIds = new Set(newIds);
    if(fresh.length && posState.currentUser){
      playAlertSound();
      const o = state.orders.find(x=>x.id===fresh[0]);
      toast(`New QR order ${o.order_number} · ${o.table_label||''}${fresh.length>1?` (+${fresh.length-1} more)`:''}`, 'warn');
    }
    updateOrdersBadge();
    if(posState.route==='orders' && !document.getElementById('active-modal-overlay')) renderOrdersBoard();
  }catch(e){ if(!Data.isNetworkError(e)) console.warn('order refresh failed', e); }
  finally{ ordersRefreshing = false; }
}
function updateOrdersBadge(){
  const b = document.getElementById('orders-badge');
  if(!b) return;
  const n = state.orders.filter(o=>o.status==='NEW').length;
  b.textContent = n; b.style.display = n ? 'inline-block' : 'none';
}
function minutesAgo(iso){
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime())/60000));
  return m<1 ? 'just now' : m<60 ? `${m} min ago` : `${Math.floor(m/60)} h ${m%60} min ago`;
}
function orderCardHtml(o){
  const items = state.orderItems.filter(i=>i.orderId===o.id);
  const actions = {
    NEW: `<button class="btn btn-primary btn-sm" data-act="accept" data-id="${o.id}">Accept</button><button class="btn btn-outline btn-sm" data-act="reject" data-id="${o.id}">Reject</button>`,
    ACCEPTED: `<button class="btn btn-amber btn-sm" data-act="ready" data-id="${o.id}">Mark ready</button><button class="btn btn-primary btn-sm" data-act="ringup" data-id="${o.id}">Ring up</button>`,
    READY: `<button class="btn btn-primary btn-sm" data-act="ringup" data-id="${o.id}">Ring up & pay</button>`,
  }[o.status] || '';
  const late = (Date.now() - new Date(o.created_at).getTime()) > 15*60000;
  return `<div class="order-card ${late?'late':''}">
    <div class="oc-head"><span class="oc-num">${escapeHtml(o.order_number)}</span><span class="oc-table">${escapeHtml(o.table_label||'')}${o.order_type==='TAKEAWAY'?' · Take-away':''}</span></div>
    <div class="oc-meta">⭐ ${escapeHtml(o.customer_name||'Guest')} · ${minutesAgo(o.created_at)}</div>
    <div class="oc-items">${items.length ? items.map(i=>`<div class="oc-line"><b>${i.quantity} ×</b> ${escapeHtml(i.name)}${(i.modifiers||[]).length?`<div class="oc-mods">${i.modifiers.map(m=>escapeHtml(m.label)).join(', ')}</div>`:''}${i.note?`<div class="oc-note">“${escapeHtml(i.note)}”</div>`:''}</div>`).join('') : '<div class="text-light">Loading items…</div>'}</div>
    ${o.note?`<div class="oc-note">Note: ${escapeHtml(o.note)}</div>`:''}
    <div class="oc-foot"><b>${fmtMoney(o.subtotal)}</b><span class="oc-actions">${actions}<button class="btn btn-ghost btn-sm" data-act="cancel" data-id="${o.id}" title="Cancel order">✕</button></span></div>
  </div>`;
}
function renderOrdersBoard(){
  const content = document.getElementById('content');
  const cols = [['NEW','New'], ['ACCEPTED','Preparing'], ['READY','Ready for pickup']];
  const qrOn = state.settings.qr_ordering_enabled;
  document.getElementById('topbar-actions').innerHTML = `<span class="text-light" style="font-size:12.5px;">${qrOn?'QR ordering is on':'QR ordering is OFF (turn it on in the Back Office)'}</span>
    <button class="btn btn-ghost btn-sm" id="ord-refresh">↻ Refresh</button>`;
  document.getElementById('ord-refresh').onclick = ()=> refreshOrders();
  content.className = '';
  content.innerHTML = `<div class="orders-board">${cols.map(([st, label])=>{
    const list = state.orders.filter(o=>o.status===st).sort((a,b)=> String(a.created_at).localeCompare(String(b.created_at)));
    return `<div class="orders-col"><div class="orders-col-head">${label} <span class="badge badge-gray">${list.length}</span></div>
      ${list.length ? list.map(orderCardHtml).join('') : `<div class="orders-empty">${st==='NEW'?'No new orders.':'—'}</div>`}</div>`;
  }).join('')}</div>`;
  content.querySelectorAll('[data-act]').forEach(b=> b.onclick = ()=> handleOrderAction(b.dataset.act, b.dataset.id));
}
async function handleOrderAction(act, id){
  const o = state.orders.find(x=>x.id===id);
  if(!o) return;
  const who = posState.currentUser.name;
  if(act==='accept'){ Object.assign(o, {status:'ACCEPTED', handled_by_name: who}); await DB.put('orders', o); await logAudit('QR order accepted', who, o.order_number, o.id); }
  else if(act==='ready'){ Object.assign(o, {status:'READY', handled_by_name: who}); await DB.put('orders', o); await logAudit('QR order ready', who, o.order_number, o.id); }
  else if(act==='reject' || act==='cancel'){
    if(act==='cancel' && o.status!=='NEW'){ const auth = await requireOverride('MANAGER'); if(!auth) return; }
    openModal({title: `${act==='reject'?'Reject':'Cancel'} ${escapeHtml(o.order_number)}?`, body:`
      <p>The customer will see this on their phone.</p>
      <div class="form-row"><label>Reason</label><select id="rj-reason"><option>Sorry, this item is sold out</option><option>We're about to close</option><option>Please order at the counter</option><option>Duplicate order</option><option>Other</option></select></div>`,
      foot:`<button class="btn btn-outline" data-cancel>Back</button><button class="btn btn-danger" id="rj-ok">${act==='reject'?'Reject order':'Cancel order'}</button>`,
      onMount:(root)=>{
        root.querySelector('[data-cancel]').onclick = closeModal;
        root.querySelector('#rj-ok').onclick = async ()=>{
          Object.assign(o, {status: act==='reject'?'REJECTED':'CANCELLED', status_reason: root.querySelector('#rj-reason').value, handled_by_name: who});
          await DB.put('orders', o);
          await logAudit(act==='reject'?'QR order rejected':'QR order cancelled', who, `${o.order_number} — ${o.status_reason}`, o.id);
          closeModal(); renderOrdersBoard(); updateOrdersBadge();
        };
      }});
    return;
  }
  else if(act==='ringup'){ await ringUpOrder(o); return; }
  updateOrdersBadge();
  renderOrdersBoard();
}
async function ringUpOrder(o){
  if(posState.cart.length){
    const ok = await confirmDialog('There are already items in the current order. Replace them with this QR order?');
    if(!ok) return;
  }
  if(!activeShift()){ toast('Start a shift first (POS screen), then ring up the order.', 'warn'); navigatePOS('pos'); return; }
  let items = state.orderItems.filter(i=>i.orderId===o.id);
  if(!items.length){ items = await DB.byIndex('orderItems', 'orderId', o.id); }
  if(!items.length){ toast('Could not load this order\'s items. Check the connection and try again.', 'error'); return; }
  posState.cart = items.map(i=>({lineId: uid('line'), recipeId: i.recipeId, name: i.name, unitPrice: Number(i.unit_price), quantity: i.quantity, modifiers: i.modifiers||[]}));
  posState.discount = null; posState.resumingHeldSaleId = null;
  posState.orderId = o.id; posState.customerId = o.customer_id || null;
  navigatePOS('pos');
  toast(`QR order ${o.order_number} is in the cart — take payment to finish it`);
}

/* ---------- customer & QR order shown on the current sale ---------- */
function cartContextHtml(){
  const parts = [];
  if(posState.orderId){
    const o = state.orders.find(x=>x.id===posState.orderId);
    parts.push(`<div class="cart-ctx qr">📱 QR order <b>${escapeHtml(o?o.order_number:'')}</b> · ${escapeHtml(o?(o.table_label||''):'')} <a class="linklike" id="ctx-detach-order">detach</a></div>`);
  }
  const c = posState.customerId ? state.customers.find(x=>x.id===posState.customerId) : null;
  parts.push(c ? `<div class="cart-ctx">⭐ <b>${escapeHtml(c.nickname)}</b> · ${c.visit_count||0} visit${(c.visit_count||0)===1?'':'s'} <a class="linklike" id="ctx-remove-cust">remove</a></div>`
               : `<div class="cart-ctx muted"><a class="linklike" id="ctx-add-cust">+ Add customer (for loyalty)</a></div>`);
  return parts.join('');
}
function wireCartContext(panel){
  const add = panel.querySelector('#ctx-add-cust'); if(add) add.onclick = openCustomerPicker;
  const rm = panel.querySelector('#ctx-remove-cust'); if(rm) rm.onclick = ()=>{ posState.customerId = null; renderCartPanel(); };
  const det = panel.querySelector('#ctx-detach-order'); if(det) det.onclick = async ()=>{
    const ok = await confirmDialog('Detach the QR order? The order stays open in QR Orders; the items stay in the cart.');
    if(ok){ posState.orderId = null; renderCartPanel(); }
  };
}
function openCustomerPicker(){
  openModal({title:'Add a customer to this sale', body:`
    <div class="form-row"><label>Search nickname or mobile</label><input id="cp-q" placeholder="e.g. Zed or 4567" autocomplete="off"></div>
    <div id="cp-results" class="cp-results"></div>
    <details style="margin-top:12px;"><summary class="linklike">New customer</summary>
      <div class="form-grid" style="margin-top:8px;">
        <div class="form-row"><label>Nickname</label><input id="cp-nick" maxlength="30"></div>
        <div class="form-row"><label>Mobile (optional)</label><input id="cp-phone" inputmode="tel" placeholder="0917 123 4567"></div>
      </div>
      <p class="hint">Ask the customer first before saving their number.</p>
      <button class="btn btn-primary btn-sm" id="cp-create">Save & add</button>
    </details>`,
    foot:`<button class="btn btn-outline" data-cancel>Close</button>`,
    onMount:(root)=>{
      root.querySelector('[data-cancel]').onclick = closeModal;
      const draw = ()=>{
        const q = root.querySelector('#cp-q').value.trim().toLowerCase(), digits = q.replace(/\D/g,'');
        let list = state.customers.filter(c=>!c.merged_into);
        if(q) list = list.filter(c=> c.nickname.toLowerCase().includes(q) || (digits.length>=3 && String(c.phone||'').includes(digits)));
        list = list.sort((a,b)=> String(b.last_visit_at||b.created_at).localeCompare(String(a.last_visit_at||a.created_at))).slice(0,8);
        root.querySelector('#cp-results').innerHTML = list.length ? list.map(c=>`<button class="cp-row" data-cust="${c.id}"><b>${escapeHtml(c.nickname)}</b><span>${c.phone?'•••• '+escapeHtml(String(c.phone).slice(-4)):''} · ${c.visit_count||0} visits</span></button>`).join('') : '<div class="hint">No match.</div>';
        root.querySelectorAll('[data-cust]').forEach(b=> b.onclick = ()=>{ posState.customerId = b.dataset.cust; closeModal(); renderCartPanel(); });
      };
      root.querySelector('#cp-q').oninput = draw; draw();
      setTimeout(()=> root.querySelector('#cp-q').focus(), 50);
      root.querySelector('#cp-create').onclick = async ()=>{
        const nickname = root.querySelector('#cp-nick').value.trim();
        const raw = root.querySelector('#cp-phone').value.trim();
        const phone = raw ? normalizePhone(raw) : null;
        if(!nickname){ toast('Enter a nickname','error'); return; }
        if(raw && !phone){ toast('Check the mobile number','error'); return; }
        const dupe = phone && state.customers.find(c=> c.phone===phone && !c.merged_into);
        if(dupe){ posState.customerId = dupe.id; closeModal(); renderCartPanel(); toast(`That number belongs to ${dupe.nickname} — added them instead`); return; }
        const c = {id: uid(), nickname, phone, consent_at: new Date().toISOString(), visit_count:0, order_count:0, total_spent:0, created_at: new Date().toISOString()};
        await DB.put('customers', c);
        await logAudit('Customer added at counter', posState.currentUser.name, nickname, c.id);
        posState.customerId = c.id; closeModal(); renderCartPanel();
      };
    }});
}
function receiptExtraLines(sale){
  const lines = [];
  const c = sale.customer_id ? state.customers.find(x=>x.id===sale.customer_id) : null;
  if(c) lines.push(`<div class="row"><span>Customer: ${escapeHtml(c.nickname)}</span><span></span></div>`);
  const o = sale.order_id ? state.orders.find(x=>x.id===sale.order_id) : null;
  if(o) lines.push(`<div class="row"><span>QR order ${escapeHtml(o.order_number)}</span><span>${escapeHtml(o.table_label||'')}</span></div>`);
  return lines.join('');
}

/* ---------- alert sound for new orders ---------- */
let alertCtx = null;
function unlockAlertSound(){
  try{ if(!alertCtx) alertCtx = new (window.AudioContext||window.webkitAudioContext)(); if(alertCtx.state==='suspended') alertCtx.resume(); }catch(e){}
}
function playAlertSound(){
  try{
    if(!alertCtx) return;
    [0, 0.22].forEach(t=>{
      const o = alertCtx.createOscillator(), g = alertCtx.createGain();
      o.type = 'sine'; o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, alertCtx.currentTime+t);
      g.gain.exponentialRampToValueAtTime(0.3, alertCtx.currentTime+t+0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, alertCtx.currentTime+t+0.18);
      o.connect(g); g.connect(alertCtx.destination); o.start(alertCtx.currentTime+t); o.stop(alertCtx.currentTime+t+0.2);
    });
  }catch(e){}
}

/* ---------- Sales calendar (managers) ---------- */
function renderFoCalendar(){ renderSalesCalendar(document.getElementById('content')); }

/* ---------- This Device ---------- */
function renderDeviceScreen(){
  const content = document.getElementById('content');
  const d = FO.device || {};
  content.innerHTML = `
    <div class="settings-block" style="max-width:820px;">
      <div class="section-title" style="margin-top:0;">This device</div>
      <div class="card" style="font-size:14px;line-height:1.9;">
        <div>Name: <b>${escapeHtml(d.device_name||'')}</b> · Letter <b>${escapeHtml(d.device_tag||'')}</b> (receipts look like POS-${escapeHtml(d.device_tag||'A')}-${new Date().getFullYear()}-000123)</div>
        <div>Shop: <b>${escapeHtml(businessName()||d.business_name||'')}</b></div>
        <div>Signed in: <b>${escapeHtml(posState.currentUser.name)}</b> (${posState.currentUser.role})</div>
        <div>Sales history on this tablet from <b>${fmtDate(Data.loadedFrom)}</b></div>
      </div>
      <div class="section-title">Connection & uploads</div>
      <div class="card" id="dev-sync"></div>
      <div class="section-title">Shop settings</div>
      <div class="card"><p class="hint" style="margin:0;">Menu, prices, tax, receipt text, staff and PINs are managed in the <a class="linklike" href="../backoffice/" target="_blank" rel="noopener">Back Office</a> by an admin. This tablet picks up changes within a minute.</p></div>
      <div class="section-title">Remove this device</div>
      <div class="card"><p class="hint" style="margin-top:0;">Unpairs this tablet from the shop and clears its saved data. Needs an admin PIN. Make sure nothing is waiting to upload first.</p>
        <button class="btn btn-danger btn-sm" id="dev-unpair">Unpair this device</button></div>
    </div>`;
  renderDeviceSync();
  content.querySelector('#dev-unpair').onclick = async ()=>{
    const st = Data.status();
    if(st.pending){ const ok = await confirmDialog(`${st.pending} sale record(s) are still waiting to upload. If you unpair now they will be lost. Continue anyway?`); if(!ok) return; }
    openModal({title:'Unpair this device', body:`<div class="form-row"><label>Admin PIN</label><input id="up-pin" type="password" inputmode="numeric" maxlength="6" autocomplete="off"></div>`,
      foot:`<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-danger" id="up-ok">Unpair</button>`,
      onMount:(root)=>{
        root.querySelector('[data-cancel]').onclick = closeModal;
        root.querySelector('#up-ok').onclick = async ()=>{
          if(!navigator.onLine){ toast('Unpairing needs the internet.', 'error'); return; }
          const {data, error} = await sb.rpc('unpair_this_device', {p_admin_pin: root.querySelector('#up-pin').value.trim()});
          if(error){ toast(friendlyError(error),'error'); return; }
          if(rpcFailed(data)){ toast(rpcMessage(data),'error'); return; }
          await Data.clearLocal(); clearDevice();
          try{ localStorage.removeItem('cccc-fo-pins'); }catch(e){}
          await sb.auth.signOut();
          location.reload();
        };
      }});
  };
}
function renderDeviceSync(){
  const box = document.getElementById('dev-sync');
  if(!box) return;
  const st = Data.status();
  box.innerHTML = `
    <div style="font-size:14px;line-height:1.9;">
      <div>Internet: <b>${navigator.onLine?'Connected':'Offline'}</b></div>
      <div>Last update from the database: <b>${st.lastSync? new Date(st.lastSync).toLocaleTimeString('en-PH',{hour:'numeric',minute:'2-digit'}) : '—'}</b></div>
      <div>Waiting to upload: <b>${st.pending}</b>${st.pending?' (they upload by themselves when the internet is back)':''}</div>
      <div>Could not upload: <b class="${st.failed?'text-red':''}">${st.failed}</b></div>
    </div>
    ${st.failed ? `<div class="hint" style="margin:8px 0;">${Data.failed.slice(0,5).map(f=>`• ${escapeHtml(f.store)}: ${escapeHtml(friendlyError(f.error))}`).join('<br>')}</div>` : ''}
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;">
      <button class="btn btn-outline btn-sm" id="dev-refresh">↻ Refresh now</button>
      ${st.pending?'<button class="btn btn-outline btn-sm" id="dev-flush">Upload now</button>':''}
      ${st.failed?'<button class="btn btn-primary btn-sm" id="dev-retry">Retry failed</button><button class="btn btn-ghost btn-sm" id="dev-discard">Discard failed…</button>':''}
    </div>`;
  box.querySelector('#dev-refresh').onclick = async ()=>{ try{ await Data.refresh({fullMasters:true}); await refreshOrders(); toast('Up to date'); }catch(e){ toast(friendlyError(e),'error'); } renderDeviceSync(); };
  const fl = box.querySelector('#dev-flush'); if(fl) fl.onclick = ()=> Data.flush();
  const rt = box.querySelector('#dev-retry'); if(rt) rt.onclick = async ()=>{ await Data.retryFailed(); renderDeviceSync(); };
  const dc = box.querySelector('#dev-discard'); if(dc) dc.onclick = async ()=>{
    const auth = await requireOverride('ADMIN'); if(!auth) return;
    const ok = await confirmDialog('Throw away the records that could not upload? Write down what they were first — this cannot be undone.');
    if(!ok) return;
    await logAudit('Failed uploads discarded', auth.name, `${Data.failed.length} records`);
    await Data.discardFailed(); renderDeviceSync();
  };
}
