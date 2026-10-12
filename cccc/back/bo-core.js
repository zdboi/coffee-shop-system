/* =====================================================================
   BACK OFFICE — core: sign-in, the owner-only check, loading the shop's
   data, saving changes, the page shell (menu, top bar) and the dashboard.

   Data:  bo_bootstrap()   -> everything the stock / menu screens need
          sales_report()   -> sales, refunds, shifts… for a date range
          apply_changes()  -> every change, several rows at once, all-or-nothing
   Shared logic (costing, stock, shift maths, receipts) comes from
   ../shared/logic.js — this file never re-implements those formulas.
   ===================================================================== */

const cloud = Cloud.createClient({storageKey: 'cccc.admin.session'});

const BO = {
  isOwner: false, rank: 0,
  ownerStaff: null,          // the owner's own row in `staff`
  profileName: '',
  counts: {open_qr_orders: 0, customer_count: 0, needs_review: 0},
  lastLoadAt: 0,
  started: false,
  salesCache: new Map(),     // "from|to" -> {at, data}
};

// Extra plain-language messages for codes only the Back Office meets (added, never replacing).
(function addBackOfficeErrorText(){
  const extra = {
    TABLE_NOT_ALLOWED: 'That kind of record cannot be changed from here.',
    BAD_COLUMN: 'Something in this change is not a known field. Reload the page and try again.',
    BAD_OP: 'This change could not be understood by the server. Reload the page and try again.',
    SAME_CUSTOMER: 'Choose two different customers to merge.',
    UNKNOWN_CUSTOMER: 'One of these customers no longer exists (maybe merged already). Refresh and try again.',
    BAD_HASH: 'A staff PIN in the old data could not be read, so that person was brought in without a PIN.',
    NAME_REQUIRED: 'Enter a name.',
  };
  Object.keys(extra).forEach(k => { if(!ERROR_TEXT[k]) ERROR_TEXT[k] = extra[k]; });
})();

/* ================= small helpers ================= */
function esc(s){ return escapeHtml(s); }
function num(v){ const n = Number(v); return isFinite(n) ? n : 0; }
function show(id, on, how){ const n = document.getElementById(id); if(n) n.style.display = on ? (how || 'flex') : 'none'; }
function nowISO(){ return new Date().toISOString(); }
function boActorName(){ return (BO.ownerStaff && BO.ownerStaff.name) || BO.profileName || (cloud.user() && cloud.user().email) || 'Owner'; }
function boActorId(){ return BO.ownerStaff ? BO.ownerStaff.id : null; }
function plural(n, one, many){ return `${n} ${n===1 ? one : (many || one + 's')}`; }
function byName(a, b){ return String(a.name||'').localeCompare(String(b.name||''), undefined, {numeric: true}); }

// Runs fn while the button shows a "working" state; the button comes back afterwards.
async function busy(btn, fn, label){
  if(!btn) return fn();
  if(btn.dataset.busy) return;
  const old = btn.innerHTML;
  btn.dataset.busy = '1'; btn.disabled = true;
  if(label !== false) btn.textContent = label || 'Saving…';
  try{ return await fn(); }
  finally{ delete btn.dataset.busy; btn.disabled = false; if(btn.isConnected) btn.innerHTML = old; }
}

/* ================= shop time zone (Asia/Manila by default) =================
   Days and hours in reports follow the SHOP's clock, not the computer's, so a
   report opened abroad still matches the counter's "today". */
const BO_TZ_FORMATTERS = {};
function shopTz(){ return (state.settings && state.settings.timezone) || 'Asia/Manila'; }
function tzFormatter(){
  const tz = shopTz();
  if(!BO_TZ_FORMATTERS[tz]){
    const opts = {year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23', weekday:'short'};
    try{ BO_TZ_FORMATTERS[tz] = new Intl.DateTimeFormat('en-US', Object.assign({timeZone: tz}, opts)); }
    catch(e){ BO_TZ_FORMATTERS[tz] = new Intl.DateTimeFormat('en-US', opts); }
  }
  return BO_TZ_FORMATTERS[tz];
}
const BO_DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
function tzParts(d){
  const p = {};
  tzFormatter().formatToParts(d instanceof Date ? d : new Date(d)).forEach(x => { p[x.type] = x.value; });
  return {y: +p.year, m: +p.month, d: +p.day, h: (+p.hour) % 24, mi: +p.minute, s: +p.second,
    dow: BO_DOW.indexOf(p.weekday), key: `${p.year}-${p.month}-${p.day}`};
}
function tzOffsetMs(date){
  const p = tzParts(date);
  return Date.UTC(p.y, p.m-1, p.d, p.h, p.mi, p.s) - Math.floor(date.getTime()/1000)*1000;
}
// 'YYYY-MM-DD' -> the moment that day starts in the shop's time zone
function shopDayStart(key){
  const [y, m, d] = String(key).split('-').map(Number);
  const utc = Date.UTC(y, m-1, d);
  let t = utc - tzOffsetMs(new Date(utc));
  const off2 = tzOffsetMs(new Date(t));
  if(utc - off2 !== t) t = utc - off2;
  return new Date(t);
}
function shopTodayKey(){ return tzParts(new Date()).key; }
function dayKeyOf(d){ return tzParts(d).key; }
function hourOf(d){ return tzParts(d).h; }
function keyAddDays(key, n){ const [y,m,d] = key.split('-').map(Number); return new Date(Date.UTC(y, m-1, d+n)).toISOString().slice(0,10); }
function keyDow(key){ const [y,m,d] = key.split('-').map(Number); return new Date(Date.UTC(y, m-1, d)).getUTCDay(); }
function keyLabel(key, opts){ const [y,m,d] = key.split('-').map(Number); return new Date(Date.UTC(y, m-1, d, 12)).toLocaleDateString('en-PH', Object.assign({timeZone:'UTC'}, opts || {weekday:'short', month:'short', day:'numeric', year:'numeric'})); }
function keyMonthStart(key){ return key.slice(0,8) + '01'; }
function keyAddMonths(key, n){ const [y,m] = key.split('-').map(Number); return new Date(Date.UTC(y, m-1+n, 1)).toISOString().slice(0,10); }
// Inclusive day keys [fromKey, toKey] -> {from, to} moments ([from, to) in the shop's zone)
function dayRange(fromKey, toKey){ return {from: shopDayStart(fromKey), to: shopDayStart(keyAddDays(toKey, 1))}; }
function fmtShopTime(d){ if(!d) return '—'; try{ return new Date(d).toLocaleTimeString('en-PH', {hour:'numeric', minute:'2-digit', timeZone: shopTz()}); }catch(e){ return fmtTime(d); } }
function fmtShopDate(d){ if(!d) return '—'; try{ return new Date(d).toLocaleDateString('en-PH', {year:'numeric', month:'short', day:'numeric', timeZone: shopTz()}); }catch(e){ return fmtDate(d); } }
function fmtShopDateTime(d){ return d ? fmtShopDate(d) + ' ' + fmtShopTime(d) : '—'; }
// Plain dates stored as 'YYYY-MM-DD' (purchase date, waste date…) are shown as written.
function fmtDay(v){ if(!v) return '—'; const s = String(v); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? keyLabel(s, {year:'numeric', month:'short', day:'numeric'}) : fmtShopDate(s); }
function dayValue(v){ if(!v) return ''; const s = String(v); return /^\d{4}-\d{2}-\d{2}/.test(s) && s.length <= 10 ? s : dayKeyOf(s); }

/* ================= loading ================= */
async function boLoad(){
  const d = await cloud.rpc('bo_bootstrap', {}, {timeout: 30000});
  applyBoBootstrap(d || {});
  return d;
}
function applyBoBootstrap(d){
  state.business = d.business || null;
  setSettingsFromServer(d.settings);
  state.staff = d.staff || [];
  state.categories = d.categories || [];
  state.suppliers = d.suppliers || [];
  state.ingredients = d.ingredients || [];
  state.recipes = (d.recipes || []).map(r => Object.assign(r, {modifier_groups: Array.isArray(r.modifier_groups) ? r.modifier_groups : []}));
  state.recipeIngredients = d.recipe_ingredients || [];
  state.purchases = d.purchases || [];
  state.productionBatches = d.production_batches || [];
  state.waste = d.waste || [];
  setStockFromServer(d.stock);
  state.tables = d.tables || [];
  state.devices = d.devices || [];
  state.stores = d.stores || [];
  state.ingredientTxns = {};
  BO.isOwner = !!d.is_owner;
  BO.rank = Number(d.rank) || 0;
  BO.counts.open_qr_orders = Number(d.open_qr_orders) || 0;
  BO.counts.customer_count = Number(d.customer_count) || 0;
  BO.ownerStaff = state.staff.find(s => s.profile_id && s.profile_id === cloud.userId()) || null;
  BO.lastLoadAt = Date.now();
}

// Inventory history of one ingredient (loaded when needed, cached until the next reload).
async function loadIngredientTxns(ingredientId, force){
  if(!force && state.ingredientTxns[ingredientId]) return state.ingredientTxns[ingredientId];
  const rows = await cloud.selectAll('inventory_transactions', {eq: {ingredient_id: ingredientId}, order: 'transaction_date.asc,created_at.asc'});
  state.ingredientTxns[ingredientId] = rows || [];
  return state.ingredientTxns[ingredientId];
}

async function refreshReviewCount(){
  try{
    const rows = await cloud.select('sales', {select: 'id', eq: {needs_review: true}, limit: 500});
    BO.counts.needs_review = (rows || []).length;
  }catch(e){ /* not important */ }
  updateNavBadges();
}

/* ================= saving =================
   Every change goes through apply_changes() in ONE call, so related rows
   (e.g. a purchase and its stock line) are saved together or not at all. */
const Ops = {
  upsert: (table, row) => ({op: 'upsert', table, row}),
  update: (table, row) => ({op: 'update', table, row}),
  insertIgnore: (table, row) => ({op: 'insert_ignore', table, row}),
  del: (table, id) => ({op: 'delete', table, id}),
  delWhere: (table, where) => ({op: 'delete_where', table, where}),
  audit: (action, details, referenceId) => ({op: 'insert_ignore', table: 'audit_log', row: {
    id: uid(), action, actor_id: boActorId(), actor_name: boActorName(),
    details: details || '', reference_id: referenceId ? String(referenceId) : null, at: nowISO()}}),
};
async function applyChanges(ops){
  if(!ops || !ops.length) return {applied: 0};
  return cloud.rpc('apply_changes', {p_ops: ops}, {timeout: 90000});
}
// Saves, shows a plain error if it fails, then reloads the shop data. Returns true when saved.
async function boSave(ops, opts){
  opts = opts || {};
  try{
    await applyChanges(ops);
  }catch(e){
    console.error('save failed', e);
    toast((opts.errorPrefix || '') + friendlyError(e), 'error');
    return false;
  }
  if(opts.reload !== false){
    try{ await boLoad(); }catch(e){ console.warn('reload after save failed', e); }
  }
  if(opts.dropSales) BO.salesCache.clear();
  if(opts.success) toast(opts.success);
  return true;
}

/* ================= images (menu photos, logo) ================= */
function resizeImage(file, maxDim, type, quality){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('That file is not a picture this browser can open.'));
      img.onload = () => {
        let w = img.width, h = img.height;
        if(w > maxDim || h > maxDim){ const s = maxDim / Math.max(w, h); w = Math.round(w*s); h = Math.round(h*s); }
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const ctx = c.getContext('2d');
        if(type === 'image/jpeg'){ ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h); }
        ctx.drawImage(img, 0, 0, w, h);
        c.toBlob(b => b ? resolve(b) : reject(new Error('Could not shrink the picture.')), type, quality);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
// Puts a picture in the shop's own folder of the public "menu-images" storage.
async function uploadShopImage(blob, name, contentType){
  if(!state.business) throw new Error('The shop is not loaded yet.');
  const path = `${state.business.id}/${name}`;
  return cloud.upload('menu-images', path, blob, contentType || blob.type);
}

/* ================= sign-in screens ================= */
function showBoot(msg){
  show('auth-screen', false); show('app', false);
  const b = document.getElementById('boot-screen');
  b.style.display = 'flex';
  b.querySelector('.boot-msg').textContent = msg;
  b.querySelector('.boot-actions').innerHTML = '';
}
function showBootError(msg, canRetry){
  showBoot(msg);
  const a = document.querySelector('#boot-screen .boot-actions');
  a.innerHTML = `${canRetry !== false ? '<button class="btn btn-primary" id="boot-retry">Try again</button>' : ''}<button class="btn btn-outline" id="boot-signout">Sign out</button>`;
  const r = a.querySelector('#boot-retry'); if(r) r.onclick = () => location.reload();
  a.querySelector('#boot-signout').onclick = async () => { await cloud.signOut(); location.reload(); };
}

const AUTH_VIEWS = {
  login: () => `
    <h2>Back Office</h2>
    <p class="auth-sub">For the shop owner. Sign in with your email and password.</p>
    <form id="f-login" autocomplete="on">
      <div class="form-row"><label for="li-email">Email</label><input id="li-email" type="email" autocomplete="username" required></div>
      <div class="form-row"><label for="li-pass">Password</label><input id="li-pass" type="password" autocomplete="current-password" required></div>
      <button type="submit" class="btn btn-primary btn-block">Sign in</button>
    </form>
    <div class="auth-alt"><a class="linklike" data-view="forgot">Forgot password?</a><br><a class="linklike" data-view="signup">Create a new shop account</a></div>`,
  forgot: () => `
    <h2>Reset your password</h2>
    <p class="auth-sub">We will email you a link. Open it on this device to choose a new password.</p>
    <form id="f-forgot">
      <div class="form-row"><label for="fp-email">Email</label><input id="fp-email" type="email" autocomplete="username" required></div>
      <button type="submit" class="btn btn-primary btn-block">Send the reset link</button>
    </form>
    <div class="auth-alt"><a class="linklike" data-view="login">← Back to sign in</a></div>`,
  newpass: () => `
    <h2>Choose a new password</h2>
    <p class="auth-sub">At least 8 characters. You will use it the next time you sign in.</p>
    <form id="f-newpass">
      <div class="form-row"><label for="np-1">New password</label><input id="np-1" type="password" autocomplete="new-password" minlength="8" required></div>
      <div class="form-row"><label for="np-2">Type it again</label><input id="np-2" type="password" autocomplete="new-password" minlength="8" required></div>
      <button type="submit" class="btn btn-primary btn-block">Save new password</button>
    </form>
    <div class="auth-alt"><a class="linklike" id="np-cancel">Cancel and sign out</a></div>`,
  signup: () => `
    <h2>Create a new shop account</h2>
    <p class="auth-sub">This makes a separate shop with you as its owner. To sign in to your existing shop, go back.</p>
    <form id="f-signup" autocomplete="on">
      <div class="form-row"><label for="su-biz">Shop name</label><input id="su-biz" maxlength="80" required placeholder="e.g. Cavite City Coffee Club"></div>
      <div class="form-row"><label for="su-name">Your name</label><input id="su-name" autocomplete="name" maxlength="60" required></div>
      <div class="form-row"><label for="su-email">Email</label><input id="su-email" type="email" autocomplete="username" required></div>
      <div class="form-row"><label for="su-pass">Password (8 or more characters)</label><input id="su-pass" type="password" autocomplete="new-password" minlength="8" required></div>
      <button type="submit" class="btn btn-primary btn-block">Create shop account</button>
    </form>
    <div class="auth-alt"><a class="linklike" data-view="login">← Back to sign in</a></div>`,
};

function showAuth(view, msg, isError){
  show('boot-screen', false); show('app', false);
  const wrap = document.getElementById('auth-screen');
  wrap.style.display = 'flex';
  wrap.innerHTML = `<div class="auth-card form-card">
      <div class="pin-logo">☕</div>
      ${(AUTH_VIEWS[view] || AUTH_VIEWS.login)()}
      <div id="auth-msg" class="auth-msg${isError ? ' err' : ''}" role="status" aria-live="polite">${esc(msg || '')}</div>
      <a href="../front/" class="auth-link">Staff: go to the counter (Front Office) →</a>
    </div>`;
  const setMsg = (m, err) => { const n = document.getElementById('auth-msg'); n.textContent = m || ''; n.className = 'auth-msg' + (err ? ' err' : ''); };
  wrap.querySelectorAll('[data-view]').forEach(a => a.onclick = () => {
    const email = (wrap.querySelector('input[type=email]') || {}).value || '';
    showAuth(a.dataset.view);
    const e2 = wrap.querySelector('input[type=email]'); if(e2 && email) e2.value = email;
  });
  const first = wrap.querySelector('input'); if(first) setTimeout(() => first.focus(), 30);

  const login = wrap.querySelector('#f-login');
  if(login) login.onsubmit = async (e) => {
    e.preventDefault();
    const email = wrap.querySelector('#li-email').value.trim();
    const pass = wrap.querySelector('#li-pass').value;
    const btn = login.querySelector('button[type=submit]');
    setMsg('Signing in…');
    await busy(btn, async () => {
      try{
        await cloud.signInWithPassword(email, pass);
        await startBackOffice();
      }catch(err){ setMsg(friendlyError(err), true); }
    }, 'Signing in…');
  };
  const forgot = wrap.querySelector('#f-forgot');
  if(forgot) forgot.onsubmit = async (e) => {
    e.preventDefault();
    const email = wrap.querySelector('#fp-email').value.trim();
    const btn = forgot.querySelector('button[type=submit]');
    await busy(btn, async () => {
      try{
        await cloud.resetPassword(email, location.origin + location.pathname);
        setMsg('If that email has a login, a reset link is on its way. Check your inbox (and spam folder).');
      }catch(err){ setMsg(friendlyError(err), true); }
    }, 'Sending…');
  };
  const np = wrap.querySelector('#f-newpass');
  if(np){
    np.onsubmit = async (e) => {
      e.preventDefault();
      const a = wrap.querySelector('#np-1').value, b = wrap.querySelector('#np-2').value;
      if(a.length < 8){ setMsg('Use at least 8 characters.', true); return; }
      if(a !== b){ setMsg('The two passwords are different. Type them again.', true); return; }
      const btn = np.querySelector('button[type=submit]');
      await busy(btn, async () => {
        try{
          await cloud.updatePassword(a);
          toast('Password changed');
          await startBackOffice();
        }catch(err){ setMsg(friendlyError(err), true); }
      });
    };
    wrap.querySelector('#np-cancel').onclick = async () => { await cloud.signOut(); showAuth('login'); };
  }
  const su = wrap.querySelector('#f-signup');
  if(su) su.onsubmit = async (e) => {
    e.preventDefault();
    const biz = wrap.querySelector('#su-biz').value.trim();
    const name = wrap.querySelector('#su-name').value.trim();
    const email = wrap.querySelector('#su-email').value.trim();
    const pass = wrap.querySelector('#su-pass').value;
    if(!biz || !name){ setMsg('Enter the shop name and your name.', true); return; }
    if(pass.length < 8){ setMsg('The password needs at least 8 characters.', true); return; }
    const btn = su.querySelector('button[type=submit]');
    await busy(btn, async () => {
      try{
        const r = await cloud.signUp(email, pass, {business_name: biz, admin_name: name});
        if(r && r.session){ toast('Shop account created'); await startBackOffice(); return; }
        showAuth('login', 'Account created. Check your email and tap the confirmation link, then sign in here.');
        const em = document.getElementById('li-email'); if(em) em.value = email;
      }catch(err){ setMsg(friendlyError(err), true); }
    }, 'Creating…');
  };
}

function showNotOwner(reason){
  show('boot-screen', false); show('app', false);
  const wrap = document.getElementById('auth-screen');
  wrap.style.display = 'flex';
  const who = (cloud.user() && cloud.user().email) || (cloud.isAnonymous() ? 'a counter or customer login' : 'this login');
  wrap.innerHTML = `<div class="auth-card form-card">
      <div class="pin-logo">🔒</div>
      <h2>This page is for the shop owner's login</h2>
      <p class="auth-sub" style="margin-bottom:12px;">${esc(reason || 'You are signed in as ' + who + ', which is not the owner of a shop.')}</p>
      <p class="hint" style="margin-bottom:16px;">Staff use the counter (Front Office) with their PIN. If you are the owner, sign out and sign in with the email you used to create the shop.</p>
      <button class="btn btn-primary btn-block" id="no-signout">Sign out</button>
      <a href="../front/" class="auth-link">Go to the counter (Front Office) →</a>
    </div>`;
  wrap.querySelector('#no-signout').onclick = async () => { await cloud.signOut(); showAuth('login'); };
}

/* ================= start-up ================= */
async function bootBackOffice(){
  window.addEventListener('unhandledrejection', (ev) => {
    const e = ev.reason;
    console.error(e);
    if(BO.started) toast(friendlyError(e), 'error');
  });
  let link = null;
  try{ link = await cloud.sessionFromUrl(); }catch(e){ link = null; }
  if(link && link.error){ showAuth('login', link.error, true); return; }
  const sess = await cloud.ensureSession();
  if(!sess){ showAuth('login'); return; }
  if(link && link.type === 'recovery'){ showAuth('newpass'); return; }
  if(link && link.type === 'signup') toast('Email confirmed');
  await startBackOffice();
}

async function startBackOffice(){
  showBoot('Loading your shop…');
  if(cloud.isAnonymous()){ showNotOwner('This browser is signed in as a counter or a customer, not as the shop owner.'); return; }
  try{
    await boLoad();
  }catch(e){
    console.error(e);
    if(/NOT_A_MEMBER/.test(e.message || '')){ showNotOwner('This login is not linked to a shop.'); return; }
    if(e.code === 'NO_SESSION' || e.status === 401){ showAuth('login', 'Your login has ended. Please sign in again.', true); return; }
    showBootError(friendlyError(e));
    return;
  }
  if(!BO.isOwner){ showNotOwner(); return; }
  try{
    const prof = await cloud.select('profiles', {eq: {id: cloud.userId()}, limit: 1});
    BO.profileName = (prof && prof[0] && prof[0].name) || '';
  }catch(e){ /* only used for the name shown */ }
  await ensureStarterData();
  show('boot-screen', false); show('auth-screen', false);
  show('app', true);
  BO.started = true;
  applyCustomTheme();
  renderShell();
  const start = (location.hash || '').replace(/^#/, '');
  navigate(BO_ROUTES[start] && !BO_ROUTES[start].param ? start : 'dashboard');
  startBackgroundRefresh();
  refreshReviewCount();
  if(typeof maybeAutoBackup === 'function') setTimeout(() => maybeAutoBackup().catch(e => console.warn(e)), 2500);
}

// Same first-run set-up as the original app: starter categories, a default supplier,
// the "House-Made / Produced" category, and the owner's own staff row if missing.
async function ensureStarterData(){
  const ops = [];
  const notes = [];
  if(!state.categories.length){
    CATEGORY_SEED.forEach(name => ops.push(Ops.upsert('categories', {id: uid(), name})));
    notes.push('starter categories');
    if(!state.suppliers.length){
      ops.push(Ops.upsert('suppliers', {id: uid(), name: 'Local Supplier', contact: '', phone: '', email: '', address: '', notes: 'Default supplier — edit or add more in Suppliers.'}));
    }
  }
  if(!state.categories.some(c => c.name === PRODUCED_CATEGORY_NAME)){
    ops.push(Ops.upsert('categories', {id: uid(), name: PRODUCED_CATEGORY_NAME}));
  }
  if(!BO.ownerStaff && cloud.userId()){
    ops.push(Ops.upsert('staff', {id: uid(), profile_id: cloud.userId(), name: BO.profileName || ((cloud.user()||{}).email||'Owner').split('@')[0], role: 'ADMIN', active: true}));
    notes.push('your staff record');
  }
  if(!ops.length) return;
  if(notes.length) ops.push(Ops.audit('Shop set up', 'Added ' + notes.join(' and ')));
  try{ await applyChanges(ops); await boLoad(); }
  catch(e){ console.warn('starter data not added', e); }
}

/* ================= shell & navigation ================= */
const BO_NAV = [
  {group: 'Overview'},
  {id: 'dashboard', label: 'Dashboard', ic: '◈'},
  {id: 'calendar', label: 'Sales calendar', ic: '📅'},
  {id: 'transactions', label: 'Transactions', ic: '🧾', badge: 'needs_review'},
  {id: 'qrOrders', label: 'QR orders', ic: '📱', badge: 'open_qr_orders'},
  {id: 'customers', label: 'Customers', ic: '⭐'},
  {group: 'Kitchen & stock'},
  {id: 'ingredients', label: 'Ingredients', ic: '🌿'},
  {id: 'purchases', label: 'Purchases', ic: '🛒'},
  {id: 'production', label: 'Production', ic: '🏭'},
  {id: 'recipes', label: 'Recipes & menu', ic: '📖'},
  {id: 'inventory', label: 'Inventory', ic: '📦'},
  {id: 'costing', label: 'Costing', ic: '💰'},
  {id: 'suppliers', label: 'Suppliers', ic: '🚚'},
  {id: 'reports', label: 'Reports', ic: '📊'},
  {group: 'Setup'},
  {id: 'tables', label: 'Tables & QR codes', ic: '🔳'},
  {id: 'staff', label: 'Staff & PINs', ic: '👥'},
  {id: 'devices', label: 'Devices', ic: '💻'},
  {id: 'auditLog', label: 'Audit log', ic: '📋'},
  {id: 'settings', label: 'Settings', ic: '⚙'},
  {id: 'backup', label: 'Backup & import', ic: '💾'},
];
// route -> {title, render}. Renderers live in the other bo-*.js files.
const BO_ROUTES = {
  dashboard: {title: 'Dashboard', render: () => renderDashboard()},
  calendar: {title: 'Sales calendar', render: () => renderCalendar()},
  transactions: {title: 'Transactions', render: () => renderTransactions()},
  qrOrders: {title: 'QR orders', render: () => renderQrOrders()},
  customers: {title: 'Customers', render: () => renderCustomers()},
  ingredients: {title: 'Ingredients', render: () => renderIngredients()},
  ingredientDetail: {title: 'Ingredient', param: true, nav: 'ingredients', render: (p) => renderIngredientDetail(p)},
  purchases: {title: 'Purchases', render: () => renderPurchases()},
  production: {title: 'Production', render: () => renderProduction()},
  recipes: {title: 'Recipes & menu', render: () => renderRecipes()},
  recipeDetail: {title: 'Recipe', param: true, nav: 'recipes', render: (p) => renderRecipeDetail(p)},
  inventory: {title: 'Inventory', render: () => renderInventory()},
  costing: {title: 'Recipe costing', render: () => renderCosting()},
  suppliers: {title: 'Suppliers', render: () => renderSuppliers()},
  reports: {title: 'Reports', render: () => renderReports()},
  tables: {title: 'Tables & QR codes', render: () => renderTables()},
  staff: {title: 'Staff & PINs', render: () => renderStaff()},
  devices: {title: 'Devices', render: () => renderDevices()},
  auditLog: {title: 'Audit log', render: () => renderAuditLog()},
  settings: {title: 'Settings', render: () => renderSettings()},
  backup: {title: 'Backup & import', render: () => renderBackup()},
};

function renderShell(){
  const s = state.settings;
  const logo = s.logo_url ? `<img src="${esc(s.logo_url)}" alt="" style="width:26px;height:26px;object-fit:contain;border-radius:6px;vertical-align:middle;margin-right:2px;">` : '☕';
  document.getElementById('sidebar').innerHTML = `
    <div class="brand">${logo} <span>${esc(businessName() || appDisplayName())}</span><small>Back Office</small></div>
    <nav id="nav" aria-label="Back Office menu">${BO_NAV.map(n => n.group
      ? `<div class="nav-group">${esc(n.group)}</div>`
      : `<div class="nav-item" data-route="${n.id}" tabindex="0" role="link" title="${esc(n.label)}"><span class="ic">${n.ic}</span><span class="label">${esc(n.label)}</span>${n.badge ? `<span class="nav-badge" data-badge="${n.badge}" style="display:none;">0</span>` : ''}</div>`).join('')}</nav>
    <div id="sidebar-foot">
      <div class="who" title="${esc(boActorName())}">👤 ${esc(boActorName())}</div>
      <span id="offline-pill" class="online"><span class="dot"></span> Online</span>
      <div class="foot-actions"><a class="foot-link" href="../front/" target="_blank" rel="noopener">Front Office ↗</a><button class="foot-link" id="btn-signout" type="button">Sign out</button></div>
    </div>`;
  const nav = document.getElementById('nav');
  nav.addEventListener('click', (e) => { const it = e.target.closest('.nav-item'); if(it){ closeNavDrawer(); navigate(it.dataset.route); } });
  nav.addEventListener('keydown', (e) => { if(e.key === 'Enter' || e.key === ' '){ const it = e.target.closest('.nav-item'); if(it){ e.preventDefault(); closeNavDrawer(); navigate(it.dataset.route); } } });
  document.getElementById('btn-signout').onclick = signOutBackOffice;
  document.getElementById('nav-toggle').onclick = () => document.body.classList.toggle('nav-open');
  document.getElementById('nav-scrim').onclick = closeNavDrawer;
  document.title = 'Back Office — ' + (businessName() || appDisplayName());
  updateOnlinePill();
  updateNavBadges();
}
function closeNavDrawer(){ document.body.classList.remove('nav-open'); }
function updateNavBadges(){
  document.querySelectorAll('[data-badge]').forEach(b => {
    const n = Number(BO.counts[b.dataset.badge]) || 0;
    b.textContent = n; b.style.display = n ? 'inline-flex' : 'none';
  });
}
function updateOnlinePill(){
  const pill = document.getElementById('offline-pill');
  if(!pill) return;
  if(cloud.isReachable()){
    const mins = BO.lastLoadAt ? Math.round((Date.now() - BO.lastLoadAt) / 60000) : null;
    pill.className = 'online';
    pill.innerHTML = `<span class="dot"></span> Online${mins != null ? ' · updated ' + (mins < 1 ? 'just now' : mins + ' min ago') : ''}`;
  } else {
    pill.className = 'offline';
    pill.innerHTML = '<span class="dot"></span> Offline — changes can\'t be saved';
  }
}
cloud.onNetwork(() => updateOnlinePill());
window.addEventListener('online', updateOnlinePill);
window.addEventListener('offline', updateOnlinePill);

async function signOutBackOffice(){
  const ok = await confirmDialog('Sign out of the Back Office on this device?', 'Sign out');
  if(!ok) return;
  await cloud.signOut();
  location.replace(location.pathname);
}

function navigate(route, param){
  const def = BO_ROUTES[route] || BO_ROUTES.dashboard;
  route = BO_ROUTES[route] ? route : 'dashboard';
  if(state.route === 'settings' && route !== 'settings') applyCustomTheme();   // drop an unsaved colour preview
  BO.salesCache.clear();      // opening a screen always shows fresh sales; the cache only serves filter changes on it
  state.route = route; state.routeParam = param == null ? null : param;
  calTip(null);
  const navId = def.nav || route;
  document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.route === navId));
  document.getElementById('topbar-title').textContent = def.title;
  setTopbarActions('');
  const c = document.getElementById('content');
  c.className = '';
  c.scrollTop = 0;
  if(!def.param && history.replaceState){ try{ history.replaceState(null, '', '#' + route); }catch(e){} }
  try{
    const r = def.render(param);
    if(r && typeof r.catch === 'function') r.catch(err => { console.error(err); c.innerHTML = emptyBlock(esc(friendlyError(err))); });
  }catch(err){
    console.error(err);
    c.innerHTML = emptyBlock('This screen could not be shown: ' + esc(friendlyError(err)));
  }
}
// Buttons on the right of the top bar (+ always a Refresh button).
function setTopbarActions(html){
  const wrap = document.getElementById('topbar-actions');
  wrap.innerHTML = (html || '') + ` <button class="btn btn-ghost btn-sm" id="btn-refresh" title="Load the latest data">↻ Refresh</button>`;
  wrap.querySelector('#btn-refresh').onclick = (e) => boRefresh(true, e.currentTarget);
  return wrap;
}
function rerender(){ navigate(state.route, state.routeParam); }

let boRefreshing = false;
async function boRefresh(manual, btn){
  if(boRefreshing) return;
  boRefreshing = true;
  if(btn) btn.disabled = true;
  try{
    await boLoad();
    BO.salesCache.clear();
    await refreshReviewCount();
    const typing = document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
    if(!document.getElementById('active-modal-overlay') && (manual || !typing)){ renderShell(); rerender(); }
    if(manual) toast('Up to date');
  }catch(e){
    if(manual) toast(friendlyError(e), 'error');
  }finally{
    boRefreshing = false;
    if(btn && btn.isConnected) btn.disabled = false;
    updateOnlinePill();
  }
}
function startBackgroundRefresh(){
  setInterval(() => { if(document.visibilityState === 'visible') boRefresh(false); }, 3 * 60 * 1000);
  setInterval(updateOnlinePill, 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    if(document.visibilityState === 'visible' && Date.now() - BO.lastLoadAt > 60 * 1000) boRefresh(false);
  });
}

/* ================= shared little renderers ================= */
function statusBadge(status){
  if(status === 'IN') return '<span class="badge badge-green">In stock</span>';
  if(status === 'LOW') return '<span class="badge badge-yellow">Low stock</span>';
  return '<span class="badge badge-red">Out of stock</span>';
}
function statusBadgeText(status){ return status === 'IN' ? 'In stock' : status === 'LOW' ? 'Low stock' : 'Out of stock'; }
function saleStatusBadge(status){
  const map = {COMPLETED: 'badge-green', VOIDED: 'badge-red', REFUNDED: 'badge-red', PARTIALLY_REFUNDED: 'badge-yellow', HELD: 'badge-gray'};
  const label = {COMPLETED: 'Completed', VOIDED: 'Voided', REFUNDED: 'Refunded', PARTIALLY_REFUNDED: 'Partly refunded', HELD: 'Held'};
  return `<span class="badge ${map[status] || 'badge-gray'}">${esc(label[status] || String(status || '').replace(/_/g, ' '))}</span>`;
}
function selectOptions(list, selected, labelFn, valueFn){
  return list.map(x => { const v = valueFn ? valueFn(x) : x.id; return `<option value="${esc(v)}" ${String(v) === String(selected) ? 'selected' : ''}>${esc(labelFn ? labelFn(x) : x.name)}</option>`; }).join('');
}

/* ================= dashboard ================= */
function renderDashboard(){
  const content = document.getElementById('content');
  const activeIngredients = state.ingredients.filter(i => i.active !== false);
  const rawActive = activeIngredients.filter(i => !isProducedItem(i));
  const producedActive = activeIngredients.filter(i => isProducedItem(i));
  const invValue = activeIngredients.reduce((sum, i) => sum + ingredientStock(i.id) * (ingredientCosting(i.id).current || 0), 0);
  const st = (i) => stockStatus(ingredientStock(i.id), i.reorder_level);
  const lowStockRaw = rawActive.filter(i => st(i) === 'LOW');
  const outStockRaw = rawActive.filter(i => st(i) === 'OUT');
  const lowStockProduced = producedActive.filter(i => st(i) === 'LOW');
  const outStockProduced = producedActive.filter(i => st(i) === 'OUT');

  const today = shopTodayKey();
  const monthStartKey = keyMonthStart(today);
  const inMonth = (v) => dayValue(v) >= monthStartKey;
  const purchasesThisMonth = state.purchases.filter(p => inMonth(p.purchase_date));
  const purchaseTotal = purchasesThisMonth.reduce((s, p) => s + num(p.total_price), 0);
  const wasteThisMonth = state.waste.filter(w => inMonth(w.date));
  const wasteCost = wasteThisMonth.reduce((s, w) => s + num(w.quantity) * (ingredientCosting(w.ingredient_id).current || 0), 0);
  const productionToday = state.productionBatches.filter(b => dayValue(b.production_date) === today);
  const productionThisMonth = state.productionBatches.filter(b => inMonth(b.production_date));
  const productionCostThisMonth = productionThisMonth.reduce((s, b) => s + num(b.raw_cost_total), 0);
  const productionWasteThisMonth = productionThisMonth.reduce((s, b) => s + Math.max(0, num(b.expected_yield) - num(b.actual_yield)) * num(b.actual_cost_per_unit), 0);

  const activeRecipes = state.recipes.filter(r => r.active !== false);
  const recipeStats = activeRecipes.map(r => Object.assign({recipe: r}, recipeMetrics(r)));
  const avgFoodCost = recipeStats.length ? recipeStats.reduce((s, r) => s + r.foodCostPct, 0) / recipeStats.length : 0;
  const highestCost = recipeStats.slice().sort((a, b) => b.cost - a.cost)[0];
  const highestProfit = recipeStats.slice().sort((a, b) => b.profit - a.profit)[0];
  const recentPurchases = state.purchases.slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 5);
  const recentRecipes = state.recipes.slice().sort((a, b) => String(b.updated_at || b.created_at).localeCompare(String(a.updated_at || a.created_at))).slice(0, 5);
  const recentProduction = state.productionBatches.slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 5);
  const noPins = !state.staff.some(s => s.active !== false && s.has_pin);

  content.innerHTML = `
    ${noPins ? `<div class="notice warn">No staff PIN is set yet, so nobody can sign in at the counter. <a class="linklike" data-go="staff">Set PINs in Staff &amp; PINs</a>.</div>` : ''}
    <div id="dash-review"></div>
    <div class="section-title" style="margin-top:0;">Today</div>
    <div class="grid grid-4 kpi-sans" id="dash-today">
      ${statCard('Sales today', '…', 'loading')}${statCard('Transactions', '…', '')}${statCard('QR orders open', BO.counts.open_qr_orders, '<a class="linklike" data-go="qrOrders">see QR orders</a>')}${statCard('Customers', BO.counts.customer_count, '<a class="linklike" data-go="customers">see customers</a>')}
    </div>
    <div class="section-title">Stock &amp; menu</div>
    <div class="grid grid-4">
      ${statCard('Total ingredients', activeIngredients.length, `${rawActive.length} raw · ${producedActive.length} produced`)}
      ${statCard('Total recipes', activeRecipes.length, `${state.recipes.length} total`)}
      ${statCard('Inventory value', fmtMoney(invValue), 'at current cost')}
      ${statCard('Low stock ingredients', `${lowStockRaw.length} / ${outStockRaw.length}`, 'low / out of stock (raw)')}
    </div>
    <div class="grid grid-4" style="margin-top:16px;">
      ${statCard('Low stock produced items', `${lowStockProduced.length} / ${outStockProduced.length}`, 'low / out of stock (house-made)')}
      ${statCard('Production today', productionToday.length, `${productionThisMonth.length} this month`)}
      ${statCard('Purchases this month', fmtMoney(purchaseTotal), plural(purchasesThisMonth.length, 'purchase'))}
      ${statCard('Avg. food cost %', fmtNum(avgFoodCost, 1) + '%', 'across active recipes')}
    </div>
    <div class="grid grid-4" style="margin-top:16px;">
      ${statCard('Production cost this month', fmtMoney(productionCostThisMonth), plural(productionThisMonth.length, 'batch', 'batches'))}
      ${statCard('Production waste this month', fmtMoney(productionWasteThisMonth), 'yield loss, at cost')}
      ${statCard('Waste this month', fmtMoney(wasteCost), plural(wasteThisMonth.length, 'ingredient entry', 'ingredient entries'))}
      ${statCard('Highest cost recipe', highestCost ? esc(highestCost.recipe.name) : '—', highestCost ? fmtMoney(highestCost.cost) : '')}
    </div>
    ${(lowStockProduced.length || outStockProduced.length) ? `
      <div class="section-title">⚠ Produced items running low</div>
      <div class="grid grid-3">${[...outStockProduced, ...lowStockProduced].map(i => `
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;"><b>${esc(i.name)}</b> ${statusBadge(st(i))}</div>
          <div class="text-light" style="font-size:13px;margin-top:6px;">Current: ${fmtNum(ingredientStock(i.id), 2)} ${esc(i.base_unit)} · Reorder at ${fmtNum(i.reorder_level, 1)} ${esc(i.base_unit)}</div>
          <button class="btn btn-sm btn-amber" style="margin-top:10px;" data-produce="${esc(i.id)}">+ Produce another batch</button>
        </div>`).join('')}</div>` : ''}
    ${(lowStockRaw.length || outStockRaw.length) ? `
      <div class="section-title">Ingredients to reorder</div>
      <div class="table-wrap"><table><thead><tr><th>Ingredient</th><th class="num">Stock</th><th class="num">Reorder level</th><th>Status</th></tr></thead><tbody>
        ${[...outStockRaw, ...lowStockRaw].slice(0, 12).map(i => `<tr class="clickable" data-ing="${esc(i.id)}"><td><b>${esc(i.name)}</b></td><td class="num">${fmtNum(ingredientStock(i.id), 2)} ${esc(i.base_unit)}</td><td class="num">${fmtNum(i.reorder_level, 1)}</td><td>${statusBadge(st(i))}</td></tr>`).join('')}
      </tbody></table></div>` : ''}
    <div class="section-title">Recent activity</div>
    <div class="grid grid-3">
      <div class="card"><b>Recent purchases</b>
        ${recentPurchases.length ? recentPurchases.map(p => `<div style="padding:8px 0;border-top:1px solid var(--beige);font-size:13.5px;"><b>${esc(ingName(p.ingredient_id))}</b> — ${fmtMoney(p.total_price)} <span class="text-light">(${fmtDay(p.purchase_date)})</span></div>`).join('') : emptyLine('No purchases yet')}
      </div>
      <div class="card"><b>Recently produced</b>
        ${recentProduction.length ? recentProduction.map(b => `<div style="padding:8px 0;border-top:1px solid var(--beige);font-size:13.5px;"><b>${esc(ingName(b.produced_ingredient_id))}</b> — ${fmtNum(b.actual_yield, 1)} ${esc(b.yield_unit || '')} <span class="text-light">(${fmtDay(b.production_date)})</span></div>`).join('') : emptyLine('No production yet')}
      </div>
      <div class="card"><b>Recently edited recipes</b>
        ${recentRecipes.length ? recentRecipes.map(r => `<div style="padding:8px 0;border-top:1px solid var(--beige);font-size:13.5px;"><a class="linklike" data-recipe="${esc(r.id)}">${esc(r.name)}</a> <span class="text-light">(${fmtShopDate(r.updated_at || r.created_at)})</span></div>`).join('') : emptyLine('No recipes yet')}
      </div>
    </div>
    ${highestProfit ? `<div class="section-title">Highest profit recipe</div><div class="card"><b>${esc(highestProfit.recipe.name)}</b> — gross profit ${fmtMoney(highestProfit.profit)} on a selling price of ${fmtMoney(highestProfit.recipe.selling_price)}</div>` : ''}`;
  wireDashboardLinks(content);
  content.querySelectorAll('[data-produce]').forEach(b => b.onclick = () => openProductionForm((sourceRecipeForIngredient(ingredientById(b.dataset.produce)) || {}).id));
  loadDashboardSales();
}
function wireDashboardLinks(root){
  root.querySelectorAll('[data-go]').forEach(a => a.onclick = () => navigate(a.dataset.go));
  root.querySelectorAll('[data-recipe]').forEach(a => a.onclick = () => navigate('recipeDetail', a.dataset.recipe));
  root.querySelectorAll('tr[data-ing]').forEach(tr => tr.onclick = () => navigate('ingredientDetail', tr.dataset.ing));
}
async function loadDashboardSales(){
  const key = shopTodayKey();
  try{
    const ds = await salesForRange(dayRange(key, key));
    if(state.route !== 'dashboard') return;
    const sum = salesSummary(ds, salesIn(ds));          // same rule as the calendar: voided sales don't count
    const box = document.getElementById('dash-today');
    if(box){
      box.innerHTML = statCard('Sales today', fmtMoney(sum.net), sum.refunds > 0 ? `${fmtMoney(sum.gross)} before ${fmtMoney(sum.refunds)} refunds` : '<a class="linklike" data-go="calendar">see the calendar</a>')
        + statCard('Transactions', sum.count.toLocaleString('en-PH'), sum.count ? `average ${fmtMoney(sum.avg)}` : 'none yet')
        + statCard('QR orders open', BO.counts.open_qr_orders, '<a class="linklike" data-go="qrOrders">see QR orders</a>')
        + statCard('Customers', BO.counts.customer_count, '<a class="linklike" data-go="customers">see customers</a>');
      wireDashboardLinks(box);
    }
  }catch(e){
    const box = document.getElementById('dash-today');
    if(box && state.route === 'dashboard'){ const v = box.querySelector('.stat-card .sub'); if(v) v.textContent = friendlyError(e); }
  }
  const rv = document.getElementById('dash-review');
  if(rv && BO.counts.needs_review){
    rv.innerHTML = `<div class="notice warn"><b>${plural(BO.counts.needs_review, 'sale needs', 'sales need')} your review</b> (for example sold below the menu price). <a class="linklike" id="dash-go-review">Check them</a>.</div>`;
    rv.querySelector('#dash-go-review').onclick = () => { if(typeof txFilter !== 'undefined') txFilter.review = true; navigate('transactions'); };
  }
}

window.addEventListener('DOMContentLoaded', () => {
  bootBackOffice().catch(err => { console.error(err); showBootError('Could not start: ' + friendlyError(err)); });
});
