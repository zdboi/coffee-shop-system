/* =====================================================================
   CUSTOMER QR ORDERING
   Opened by scanning a table's QR code: .../order/?t=<table code>
   - First visit: the customer types a nickname (phone optional) and it is
     saved to the shop's customer list. Their phone keeps a login token, so
     next time the page greets them by name — no sign-in step.
   - Prices are calculated by the server; the page only shows them.
   - Payment happens at the counter.
   ===================================================================== */
(function(){
  const cloud = Cloud.createClient({storageKey: 'cccc.customer.session'});
  const params = new URLSearchParams(location.search);
  let token = params.get('t') || '';
  try{
    if(token) localStorage.setItem('cccc.order.lastToken', token);
    else token = localStorage.getItem('cccc.order.lastToken') || '';
  }catch(e){}
  const CART_KEY = 'cccc.order.cart.' + token;

  const S = {
    menu: null, customer: null, canOrder: true, blockedReason: '',
    cart: [], orders: [], view: 'menu', orderId: null,
    orderType: 'DINE_IN', note: '', justRegistered: false, pollTimer: null,
    ticketAlert: null,   // {id, text}: a problem with cancelling, shown under the ticket's buttons
  };

  /* ---------------- helpers ---------------- */
  const $ = (sel, root) => (root || document).querySelector(sel);
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function money(n){ return '₱' + (Number(n) || 0).toLocaleString('en-PH', {minimumFractionDigits: 2, maximumFractionDigits: 2}); }
  function shop(){ return S.menu ? S.menu.business.name : 'the shop'; }
  // Toasts sit over the top bar (which has nothing to tap), so they never cover a button.
  // Keep them short (2 lines at most); longer messages go next to the thing they're about.
  let toastTimer = null, toastWipe = null;
  function toast(msg, bad){
    const t = $('#toast');
    const text = document.createElement('span');
    text.className = 'toast-text'; text.textContent = msg;
    t.textContent = ''; t.appendChild(text);
    t.className = 'toast show' + (bad ? ' bad' : '');
    clearTimeout(toastTimer); clearTimeout(toastWipe);
    toastTimer = setTimeout(hideToast, 3200);
  }
  function hideToast(){
    const t = $('#toast');
    clearTimeout(toastTimer); clearTimeout(toastWipe);
    if(!t.classList.contains('show')) return;
    t.classList.remove('show');
    toastWipe = setTimeout(() => { t.textContent = ''; }, 250);
  }
  const MSG = {
    TABLE_NOT_FOUND: 'This QR code isn\'t active anymore. Please ask our staff for help.',
    ORDERING_OFF: 'Ordering by phone is paused right now. Please order at the counter.',
    REGISTER_FIRST: 'Tell us your name first.',
    CONSENT_REQUIRED: 'Please tick the box so we can save your name.',
    NAME_REQUIRED: 'Enter a name or nickname.',
    BAD_PHONE: 'Enter a mobile number like 0917 123 4567.',
    PHONE_TAKEN: 'That number is already registered here.',
    NO_MATCH: 'No match for that number and name. Use the same name you gave us before.',
    TOO_MANY_ATTEMPTS: 'Too many tries. Please wait about 15 minutes, then try again.',
    // qr_register: shop-wide limit on new customers. There's no guest ordering on this page
    // (a name is needed to order), so point to the counter instead.
    TOO_MANY_SIGNUPS: 'Lots of people are joining right now. Please wait a few minutes, or order at the counter.',
    BAD_OPTION: 'Something on the menu changed. Please remove that item and add it again.',
    BAD_QUANTITY: 'Please order 1 to 20 of each item.',
    TOO_MANY_OPEN_ORDERS: 'You already have 3 orders waiting. Please pay for those at the counter first.',
    // Also the shop-wide / per-table limit (F5): many orders in a short time.
    TOO_MANY_ORDERS: 'We\'re getting a lot of orders right now. Please wait a few minutes or order at the counter.',
    EMPTY_ORDER: 'Your order is empty.',
    ORDER_TOO_BIG: 'That order is too big for the app. Please order at the counter.',
    CANNOT_CANCEL: 'The shop already started this order, so it can\'t be cancelled here. Please talk to our staff.',
    NOT_SIGNED_IN: 'Your phone isn\'t connected. Reload the page and try again.',
  };
  // This page does not load cccc/shared/ui.js (that file's wording is written for staff at the
  // counter, e.g. its NOT_SIGNED_IN talks about "this tablet's counter login"). Every message a
  // customer can see comes from MSG below. A code we don't know, or a raw server/network message,
  // is never shown as-is: the customer gets the plain fallback.
  const FALLBACK = 'Something went wrong. Please try again.';
  // The error code at the start of a server answer: "BAD_PHONE" or "BAD_PHONE: more text".
  function codeOf(r){
    const raw = String((r && (r.error || r.message)) || '');
    const m = /^\s*([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)(?![A-Za-z0-9_])/.exec(raw);
    return m ? m[1] : raw;
  }
  function errText(r){
    if(!r) return FALLBACK;
    if(r.offline) return 'No connection. Check your internet and try again.';
    const code = codeOf(r);
    if(code === 'ITEM_UNAVAILABLE') return `${r.name || 'An item'} just sold out. Remove it to continue.`;
    if(code === 'OPTION_REQUIRED') return `Choose a ${r.group || 'option'} for ${r.name}.`;
    return MSG[code] || FALLBACK;
  }
  // The server limits number checks (register, save number, "ordered here before") per phone.
  const TOO_MANY = {
    register: 'Too many tries with a mobile number. Please wait about 15 minutes, or leave the number blank for now and add it later.',
    phone: 'Too many tries. Please wait about 15 minutes, then try again.',
    relink: 'Too many tries. Please wait about 15 minutes, or ask our staff to help.',
  };
  function errFor(r, where){
    return (codeOf(r) === 'TOO_MANY_ATTEMPTS' && TOO_MANY[where]) || errText(r);
  }
  // PHONE_TAKEN: the number already belongs to a customer here. Offer "I've ordered here
  // before" with the number filled in (only qr_relink links a phone to an existing customer).
  function showPhoneTaken(slot, prefill, blankOk){
    slot.innerHTML = `<div class="taken">
      <p>Is it yours? Connect this phone to your visits and rewards.${blankOk ? ' If not, check the number or leave it blank.' : ' If not, check the number.'}</p>
      <button class="btn btn-quiet" type="button">Yes, connect this phone</button></div>`;
    slot.querySelector('button').onclick = () => openRelinkSheet(prefill());
  }

  /* ---------------- theme from the shop's settings ---------------- */
  function applyTheme(menu){
    const t = menu.theme || {};
    const map = {primary_color:'--ink', secondary_color:'--leaf', accent_color:'--crema', background_color:'--paper', card_color:'--sheet', text_color:'--text'};
    Object.keys(map).forEach(k => { if(t[k] && /^#[0-9a-fA-F]{3,8}$/.test(t[k])) document.documentElement.style.setProperty(map[k], t[k]); });
    const meta = document.querySelector('meta[name="theme-color"]'); if(meta && t.primary_color) meta.setAttribute('content', t.primary_color);
    $('#brand-name').textContent = menu.business.name;
    if(menu.business.logo_url) $('#brand-logo').innerHTML = `<img src="${esc(menu.business.logo_url)}" alt="">`;
    $('#table-tag').textContent = menu.table.label;
    document.title = 'Order — ' + menu.business.name;
  }

  /* ---------------- cart (kept on this phone between reloads) ---------------- */
  function loadCart(){
    try{ return JSON.parse(localStorage.getItem(CART_KEY) || '[]'); }catch(e){ return []; }
  }
  function saveCart(){ try{ localStorage.setItem(CART_KEY, JSON.stringify(S.cart)); }catch(e){} }
  function itemById(id){ return S.menu.items.find(i => i.id === id); }
  function unitPrice(item, selections){
    let p = Number(item.price) || 0;
    (selections || []).forEach(sel => {
      const g = item.modifier_groups.find(x => x.id === sel.group_id);
      const o = g && g.options.find(x => x.id === sel.option_id);
      if(o) p += Number(o.price_delta) || 0;
    });
    return p;
  }
  function selectionLabels(item, selections){
    return (selections || []).map(sel => {
      const g = item.modifier_groups.find(x => x.id === sel.group_id);
      const o = g && g.options.find(x => x.id === sel.option_id);
      return o ? o.label : null;
    }).filter(Boolean);
  }
  function cartTotals(){
    const subtotal = S.cart.reduce((s, l) => { const it = itemById(l.recipe_id); return s + (it ? unitPrice(it, l.modifiers) * l.quantity : 0); }, 0);
    const m = S.menu;
    const tax = m.tax_inclusive ? 0 : subtotal * (Number(m.tax_pct) || 0) / 100;
    const service = subtotal * (Number(m.service_charge_pct) || 0) / 100;
    return {subtotal, tax, service, total: Math.round((subtotal + tax + service) * 100) / 100,
            count: S.cart.reduce((s, l) => s + l.quantity, 0)};
  }

  /* ---------------- start ---------------- */
  async function start(){
    if(!token){
      renderEmpty('Scan the QR code on your table', 'Each table has its own code. Point your phone camera at it to open the menu.');
      return;
    }
    let menu;
    try{ menu = await cloud.rpc('get_qr_menu', {p_token: token}); }
    catch(e){ renderEmpty('Can\'t reach the shop right now', 'Check your internet connection, then try again.', true); return; }
    if(!menu || menu.error){ renderEmpty('This QR code isn\'t active', 'Please ask our staff for help.'); return; }
    S.menu = menu;
    if(menu.table.kind === 'TAKEAWAY') S.orderType = 'TAKEAWAY';
    applyTheme(menu);
    S.cart = loadCart().filter(l => itemById(l.recipe_id));
    if(!menu.ordering_enabled){ S.canOrder = false; S.blockedReason = MSG.ORDERING_OFF; }
    else{
      try{
        const sess = await cloud.ensureSession();
        if(!sess) await cloud.signInAnonymously();
      }catch(e){
        S.canOrder = false;
        S.blockedReason = 'Ordering from your phone isn\'t available right now. You can still look at the menu and order at the counter.';
      }
    }
    if(S.canOrder){
      try{
        const r = await cloud.rpc('qr_session', {p_token: token});
        S.customer = r.customer || null;
        await loadOrders();
      }catch(e){ S.canOrder = false; S.blockedReason = errText(e); }
    }
    const openOne = S.orders.find(o => ['PENDING','PREPARING','READY'].includes(o.status));
    if(openOne && params.get('view') !== 'menu'){ S.view = 'order'; S.orderId = openOne.id; }
    render();
    schedulePoll();
  }

  async function loadOrders(){
    try{
      const r = await cloud.rpc('qr_my_orders', {p_token: token});
      const before = new Map(S.orders.map(o => [o.id, o.status]));
      S.orders = (r && r.orders) || [];
      S.orders.forEach(o => {
        const was = before.get(o.id);
        if(was && was !== o.status) onStatusChange(o);
      });
    }catch(e){ /* keep what we have */ }
  }
  function onStatusChange(o){
    if(o.status === 'READY'){
      toast(`${o.order_number} is ready!`);
      try{ navigator.vibrate && navigator.vibrate([200, 100, 200]); }catch(e){}
      document.title = `Ready: ${o.order_number} — ${shop()}`;
    } else if(o.status === 'PREPARING') toast(`${o.order_number} is being prepared`);
    else if(o.status === 'REJECTED') toast(`Sorry, we couldn't take ${o.order_number}`, true);
  }
  function schedulePoll(){
    clearTimeout(S.pollTimer);
    const open = S.orders.some(o => ['PENDING','PREPARING','READY'].includes(o.status));
    if(!open || !S.canOrder) return;
    S.pollTimer = setTimeout(async () => {
      if(!document.hidden){ await loadOrders(); render(true); }
      schedulePoll();
    }, 5000);
  }
  document.addEventListener('visibilitychange', async () => {
    if(!document.hidden && S.canOrder && S.menu){ await loadOrders(); render(true); schedulePoll(); }
  });

  /* ---------------- rendering ---------------- */
  function renderEmpty(title, text, retry){
    $('#main').innerHTML = `<div class="empty"><h1>${esc(title)}</h1><p>${esc(text)}</p>
      ${retry ? '<p style="margin-top:18px;"><button class="btn btn-main" id="retry" style="max-width:240px;">Try again</button></p>' : ''}</div>`;
    if(retry) $('#retry').onclick = () => location.reload();
    $('#bottom').hidden = true;
  }

  // quiet = a refresh (new order status, back from another app), not something the customer tapped.
  let lastScreen = '';
  function render(quiet){
    if(!S.menu) return;
    const screen = S.view === 'order' ? 'order:' + S.orderId : (S.canOrder && !S.customer ? 'welcome' : 'menu');
    const changed = screen !== lastScreen;
    if(changed){ hideToast(); S.ticketAlert = null; lastScreen = screen; }
    if(S.view === 'order') renderTicket();
    // The welcome form doesn't depend on orders: never wipe what the customer is typing.
    else if(screen === 'welcome'){ if(changed || !quiet) renderWelcome(); }
    else renderMenu(quiet);
    renderBottom();
  }

  function memberCardHtml(){
    const c = S.customer;
    const since = new Date(c.first_seen_at).toLocaleDateString('en-PH', {month: 'short', year: 'numeric'});
    const stamps = S.menu.loyalty_enabled ? `<div><b>${c.stamps} / ${S.menu.stamps_per_reward}</b>stamps</div>` : '';
    return `<section class="member" aria-label="Your member card">
      <div class="member-shop">${esc(shop())}</div>
      <div class="member-hello">${S.justRegistered ? 'Welcome to the club,' : 'Welcome back,'}</div>
      <div class="member-name">${esc(c.nickname)}!</div>
      <div class="member-stats">
        <div><b>${c.visit_count}</b>${c.visit_count === 1 ? 'visit' : 'visits'}</div>
        <div><b>${esc(since)}</b>member since</div>
        ${stamps}
      </div>
    </section>
    <div class="member-foot"><span class="textlink" style="text-decoration:none;cursor:default;">${S.menu.table.kind === 'TAKEAWAY' ? 'Takeaway / counter' : esc(S.menu.table.label)}</span>
      <button class="textlink" id="not-me">Not ${esc(c.nickname)}?</button></div>`;
  }

  function renderWelcome(){
    $('#main').innerHTML = `
      <section class="member" aria-hidden="true">
        <div class="member-shop">${esc(shop())}</div>
        <div class="member-hello">Welcome to the club,</div>
        <div class="member-name placeholder" id="w-preview">Your name</div>
        <div class="member-stats"><div><b>New</b>member</div></div>
      </section>
      <div class="welcome-copy">
        <h1>What should we call you?</h1>
        <p>We'll use this name when your order is ready, and greet you by name next time.</p>
      </div>
      <div class="field"><label for="w-name">Name or nickname</label>
        <input class="input" id="w-name" maxlength="30" autocomplete="nickname" autocapitalize="words" enterkeyhint="next"></div>
      <div class="field"><label for="w-phone">Mobile number (optional)</label>
        <input class="input" id="w-phone" inputmode="tel" autocomplete="tel" placeholder="0917 123 4567" enterkeyhint="done">
        <div class="help">Add your number so you keep your visits and rewards if you change phones.</div></div>
      <label class="consent"><input type="checkbox" id="w-consent">
        <span>Save my name and number with ${esc(shop())} to keep track of my orders, visits and rewards. I can ask the staff to delete them anytime.</span></label>
      <div class="form-error" id="w-err" role="alert"></div>
      <div id="w-help"></div>
      <button class="btn btn-main" id="w-go">Start ordering</button>
      <p style="text-align:center;margin-top:12px;"><button class="textlink" id="w-relink">I've ordered here before on another phone</button></p>
      ${menuHtml(true)}`;
    const name = $('#w-name'), preview = $('#w-preview');
    name.oninput = () => {
      const v = name.value.trim();
      preview.textContent = v || 'Your name';
      preview.classList.toggle('placeholder', !v);
    };
    $('#w-phone').oninput = () => { $('#w-help').innerHTML = ''; };
    $('#w-go').onclick = register;
    $('#w-relink').onclick = () => openRelinkSheet();
    wireMenu();
  }

  // First visit. qr_register only ever creates a new customer; an existing number answers
  // PHONE_TAKEN and the customer is offered "I've ordered here before" instead.
  async function register(){
    const btn = $('#w-go'), err = $('#w-err'), help = $('#w-help');
    const nickname = $('#w-name').value.trim();
    const phone = $('#w-phone').value.trim();
    help.innerHTML = '';
    if(!nickname){ err.textContent = MSG.NAME_REQUIRED; $('#w-name').focus(); return; }
    if(!$('#w-consent').checked){ err.textContent = MSG.CONSENT_REQUIRED; return; }
    btn.disabled = true; err.textContent = '';
    try{
      const r = (await cloud.rpc('qr_register', {p_token: token, p_nickname: nickname, p_phone: phone || null, p_consent: true})) || {};
      if(r.error || !r.customer){
        err.textContent = errFor(r.error ? r : null, 'register'); btn.disabled = false;
        if(r.error === 'PHONE_TAKEN') showPhoneTaken(help, () => ({phone, nickname: $('#w-name').value.trim()}), true);
        if(r.error === 'BAD_PHONE') $('#w-phone').focus();
        return;
      }
      S.customer = r.customer;
      S.justRegistered = true;
      window.scrollTo({top: 0});
      render();
      toast(`Welcome, ${r.customer.nickname}!`);
    }catch(e){ err.textContent = errFor(e, 'register'); btn.disabled = false; }
  }

  function menuHtml(preview){
    const items = S.menu.items;
    if(!items.length) return `<div class="notice">The menu is being updated. Please order at the counter for now.</div>`;
    const cats = [];
    items.forEach(i => { if(!cats.includes(i.category)) cats.push(i.category); });
    const counts = {};
    S.cart.forEach(l => { counts[l.recipe_id] = (counts[l.recipe_id] || 0) + l.quantity; });
    return `
      ${preview ? '<h2 class="welcome-copy" style="margin-top:28px;font-family:var(--display);font-size:20px;color:var(--ink);">On the menu</h2>' : ''}
      <nav class="cats" aria-label="Menu sections">${cats.map((c, i) => `<button class="cat ${i === 0 ? 'on' : ''}" data-cat="${i}">${esc(c)}</button>`).join('')}</nav>
      ${cats.map((c, i) => `<section class="menu-section" id="cat-${i}"><h2>${esc(c)}</h2>
        ${items.filter(it => it.category === c).map(it => `
          <button class="item ${it.available ? '' : 'off'}" data-item="${it.id}" ${(!it.available || preview || !S.canOrder) ? 'aria-disabled="true"' : ''}>
            <div class="item-body">
              <div class="item-name">${esc(it.name)}${counts[it.id] ? `<span class="item-count">${counts[it.id]} in order</span>` : ''}</div>
              ${it.description ? `<div class="item-desc">${esc(it.description)}</div>` : ''}
              <div class="item-price">${money(it.price)}</div>
            </div>
            ${it.image_url ? `<img class="item-photo" src="${esc(it.image_url)}" alt="" loading="lazy">` : ''}
          </button>`).join('')}
      </section>`).join('')}`;
  }
  function wireMenu(){
    document.querySelectorAll('.cat').forEach(b => b.onclick = () => {
      document.querySelectorAll('.cat').forEach(x => x.classList.toggle('on', x === b));
      const sec = document.getElementById('cat-' + b.dataset.cat);
      if(sec) sec.scrollIntoView({behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start'});
    });
    document.querySelectorAll('.item[data-item]').forEach(b => b.onclick = () => {
      if(b.getAttribute('aria-disabled') === 'true'){
        const it = itemById(b.dataset.item);
        if(S.canOrder && !S.customer) toast('Enter your name above first');
        else if(it && !it.available) toast(`${it.name} is sold out right now`);
        return;
      }
      openItemSheet(b.dataset.item);
    });
  }

  function renderMenu(quiet){
    const y = window.scrollY;
    const open = S.orders.filter(o => ['PENDING','PREPARING','READY'].includes(o.status) || (Date.now() - new Date(o.created_at).getTime() < 3600e3 && o.status !== 'CANCELLED'));
    $('#main').innerHTML = `
      ${S.customer ? memberCardHtml() : ''}
      ${!S.canOrder ? `<div class="notice warn" role="status">${esc(S.blockedReason)}</div>` : (S.menu.welcome_message ? `<div class="notice">${esc(S.menu.welcome_message)}</div>` : '')}
      ${open.length ? `<div class="my-orders">${open.map(o => `<button class="my-order" data-order="${o.id}"><span><b>${esc(o.order_number)}</b> &nbsp;${money(o.total)}</span>${statusPill(o)}</button>`).join('')}</div>` : ''}
      ${menuHtml(false)}`;
    wireMenu();
    document.querySelectorAll('[data-order]').forEach(b => b.onclick = () => { S.view = 'order'; S.orderId = b.dataset.order; render(); window.scrollTo({top: 0}); });
    const nm = $('#not-me'); if(nm) nm.onclick = notMe;
    if(quiet) window.scrollTo({top: y});
  }
  function statusPill(o){
    const t = {PENDING: 'Waiting', PREPARING: 'Preparing', READY: 'Ready!', COMPLETED: 'Done', REJECTED: 'Not accepted', CANCELLED: 'Cancelled'}[o.status];
    const cls = o.status === 'READY' ? 'ready' : (['REJECTED','CANCELLED'].includes(o.status) ? 'bad' : '');
    return `<span class="status-pill ${cls}">${t}</span>`;
  }

  function renderBottom(){
    const b = $('#bottom');
    const t = cartTotals();
    if(S.view !== 'menu' || !S.canOrder || !S.customer || !t.count){ b.hidden = true; return; }
    b.hidden = false;
    b.innerHTML = `<button class="btn" id="view-cart"><span>View order · ${t.count} item${t.count === 1 ? '' : 's'}</span><span>${money(t.total)}</span></button>`;
    $('#view-cart').onclick = openCartSheet;
  }

  /* ---------------- sheets ---------------- */
  function openSheet(title, bodyHtml, footHtml, onMount){
    const root = $('#sheet-root');
    root.innerHTML = `<div class="scrim" id="scrim"><div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="sheet-head"><h3>${esc(title)}</h3><button class="sheet-close" id="sheet-x" aria-label="Close">✕</button></div>
      <div class="sheet-body">${bodyHtml}</div>${footHtml ? `<div class="sheet-foot">${footHtml}</div>` : ''}</div></div>`;
    $('#sheet-x').onclick = closeSheet;
    $('#scrim').addEventListener('click', e => { if(e.target.id === 'scrim') closeSheet(); });
    document.body.style.overflow = 'hidden';
    if(onMount) onMount($('#sheet-root .sheet'));
  }
  function closeSheet(){ $('#sheet-root').innerHTML = ''; document.body.style.overflow = ''; }
  document.addEventListener('keydown', e => { if(e.key === 'Escape') closeSheet(); });

  function openItemSheet(itemId){
    const it = itemById(itemId);
    if(!it) return;
    let selections = [];
    let qty = 1;
    const groups = it.modifier_groups || [];
    const body = `
      ${it.image_url ? `<img class="sheet-photo" src="${esc(it.image_url)}" alt="">` : ''}
      ${it.description ? `<p style="color:var(--muted);">${esc(it.description)}</p>` : ''}
      ${groups.map(g => `<div class="group" data-group="${esc(g.id)}">
        <div class="group-title"><span>${esc(g.name)}</span><small class="${g.required ? 'req' : ''}">${g.required ? 'Choose 1' : (g.multi_select ? 'Optional · any' : 'Optional')}</small></div>
        <div class="opts">${g.options.map(o => `<button class="opt ${g.multi_select ? 'multi' : ''}" aria-pressed="false" data-g="${esc(g.id)}" data-o="${esc(o.id)}">
          <span class="tick"></span><span>${esc(o.label)}</span>${Number(o.price_delta) ? `<span class="delta">+${money(o.price_delta)}</span>` : ''}</button>`).join('')}</div></div>`).join('')}
      <div class="field" style="margin-top:18px;"><label for="it-note">Special request (optional)</label>
        <input class="input" id="it-note" maxlength="140" placeholder="e.g. less ice"></div>
      <div class="qty"><button id="q-minus" aria-label="One less">−</button><span id="q-val" aria-live="polite">1</span><button id="q-plus" aria-label="One more">+</button></div>`;
    openSheet(it.name, body, `<button class="btn btn-main" id="it-add"></button>`, (sheet) => {
      function refresh(){
        sheet.querySelectorAll('.opt').forEach(b => b.setAttribute('aria-pressed', String(selections.some(s => s.group_id === b.dataset.g && s.option_id === b.dataset.o))));
        $('#q-val').textContent = qty;
        $('#it-add').textContent = `Add ${qty > 1 ? qty + ' ' : ''}to order · ${money(unitPrice(it, selections) * qty)}`;
      }
      sheet.querySelectorAll('.opt').forEach(b => b.onclick = () => {
        const g = groups.find(x => x.id === b.dataset.g);
        const has = selections.some(s => s.group_id === g.id && s.option_id === b.dataset.o);
        if(g.multi_select){
          selections = has ? selections.filter(s => !(s.group_id === g.id && s.option_id === b.dataset.o)) : selections.concat([{group_id: g.id, option_id: b.dataset.o}]);
        } else {
          selections = selections.filter(s => s.group_id !== g.id);
          if(!has || g.required) selections.push({group_id: g.id, option_id: b.dataset.o});
        }
        const small = sheet.querySelector(`.group[data-group="${CSS.escape(g.id)}"] small`);
        if(small) small.classList.remove('need');
        refresh();
      });
      $('#q-minus').onclick = () => { qty = Math.max(1, qty - 1); refresh(); };
      $('#q-plus').onclick = () => { qty = Math.min(20, qty + 1); refresh(); };
      $('#it-add').onclick = () => {
        const missing = groups.filter(g => g.required && !selections.some(s => s.group_id === g.id));
        if(missing.length){
          missing.forEach(g => { const sm = sheet.querySelector(`.group[data-group="${CSS.escape(g.id)}"] small`); if(sm){ sm.classList.add('need'); sm.textContent = 'Please choose 1'; } });
          sheet.querySelector(`.group[data-group="${CSS.escape(missing[0].id)}"]`).scrollIntoView({block: 'center'});
          return;
        }
        const notes = $('#it-note').value.trim();
        const same = S.cart.find(l => l.recipe_id === it.id && !l.notes && !notes && JSON.stringify(l.modifiers) === JSON.stringify(selections));
        if(same) same.quantity = Math.min(20, same.quantity + qty);
        else S.cart.push({key: Math.random().toString(36).slice(2), recipe_id: it.id, quantity: qty, modifiers: selections, notes});
        saveCart();
        closeSheet();
        toast(`Added ${it.name}`);
        render(true);
      };
      refresh();
    });
  }

  function openCartSheet(){
    const t = cartTotals();
    const dineInTable = S.menu.table.kind === 'DINE_IN';
    const body = `
      ${S.cart.map(l => {
        const it = itemById(l.recipe_id);
        if(!it) return '';
        const labels = selectionLabels(it, l.modifiers);
        return `<div class="cart-line"><div class="grow"><b>${esc(it.name)}</b>
          ${labels.length ? `<div class="mods">${esc(labels.join(', '))}</div>` : ''}
          ${l.notes ? `<div class="mods">“${esc(l.notes)}”</div>` : ''}
          <div class="mini-qty"><button data-dec="${l.key}" aria-label="One less">−</button><span>${l.quantity}</span><button data-inc="${l.key}" aria-label="One more">+</button></div></div>
          <div style="font-weight:700;font-variant-numeric:tabular-nums;">${money(unitPrice(it, l.modifiers) * l.quantity)}</div></div>`;
      }).join('')}
      ${dineInTable ? `<div class="seg" role="group" aria-label="Dine in or take away">
          <button data-type="DINE_IN" aria-pressed="${S.orderType === 'DINE_IN'}">Dine in</button>
          <button data-type="TAKEAWAY" aria-pressed="${S.orderType === 'TAKEAWAY'}">Take away</button></div>` : ''}
      <div class="field" style="margin-top:14px;"><label for="c-note">Note for the barista (optional)</label>
        <input class="input" id="c-note" maxlength="200" value="${esc(S.note)}" placeholder="e.g. Please bring water"></div>
      <div class="totals">
        <div><span>Subtotal</span><span>${money(t.subtotal)}</span></div>
        ${t.service ? `<div><span>Service charge (${S.menu.service_charge_pct}%)</span><span>${money(t.service)}</span></div>` : ''}
        ${t.tax ? `<div><span>Tax (${S.menu.tax_pct}%)</span><span>${money(t.tax)}</span></div>` : ''}
        <div class="grand"><span>Total</span><span>${money(t.total)}</span></div>
      </div>
      <p style="color:var(--muted);font-size:14px;margin-top:10px;">${esc(S.menu.payment_note || 'Pay at the counter.')}</p>
      <div class="form-error" id="c-err" role="alert" style="margin-top:8px;"></div>`;
    openSheet('Your order', body, `<button class="btn btn-main" id="c-place">Place order · ${money(t.total)}</button>`, (sheet) => {
      sheet.querySelectorAll('[data-inc],[data-dec]').forEach(b => b.onclick = () => {
        const key = b.dataset.inc || b.dataset.dec;
        const l = S.cart.find(x => x.key === key);
        if(!l) return;
        l.quantity += b.dataset.inc ? 1 : -1;
        if(l.quantity > 20) l.quantity = 20;
        if(l.quantity <= 0) S.cart = S.cart.filter(x => x !== l);
        S.note = $('#c-note').value;
        saveCart(); render(true);
        if(S.cart.length) openCartSheet(); else closeSheet();
      });
      sheet.querySelectorAll('[data-type]').forEach(b => b.onclick = () => {
        S.orderType = b.dataset.type;
        sheet.querySelectorAll('[data-type]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
      });
      $('#c-place').onclick = placeOrder;
    });
  }

  async function placeOrder(){
    const btn = $('#c-place'), err = $('#c-err');
    S.note = $('#c-note').value.trim();
    btn.disabled = true; err.textContent = '';
    btn.textContent = 'Sending…';
    try{
      const r = await cloud.rpc('qr_place_order', {
        p_token: token,
        p_items: S.cart.map(l => ({recipe_id: l.recipe_id, quantity: l.quantity, notes: l.notes || null, modifiers: l.modifiers})),
        p_note: S.note || null, p_order_type: S.orderType,
      });
      if(r.error){
        err.textContent = errText(r);
        btn.disabled = false; btn.textContent = `Place order · ${money(cartTotals().total)}`;
        if(r.error === 'ITEM_UNAVAILABLE' || r.error === 'BAD_OPTION'){ refreshMenuQuietly(); }
        if(r.error === 'REGISTER_FIRST'){ S.customer = null; closeSheet(); render(); }
        return;
      }
      S.cart = []; S.note = ''; saveCart();
      S.orders.unshift(r.order);
      S.view = 'order'; S.orderId = r.order.id;
      closeSheet();
      window.scrollTo({top: 0});
      render();
      schedulePoll();
    }catch(e){
      err.textContent = errText(e);
      btn.disabled = false; btn.textContent = `Place order · ${money(cartTotals().total)}`;
    }
  }
  async function refreshMenuQuietly(){
    try{ const m = await cloud.rpc('get_qr_menu', {p_token: token}); if(m && !m.error){ S.menu = m; render(true); } }catch(e){}
  }

  // "I've ordered here before". prefill = {phone, nickname} when we come from a PHONE_TAKEN answer.
  function openRelinkSheet(prefill){
    prefill = prefill || {};
    const filled = !!prefill.phone;
    openSheet('Welcome back', `
      <p style="color:var(--muted);margin-bottom:14px;">${filled
        ? 'Check the name: use the same one you gave us before. We\'ll connect this phone to your visits.'
        : 'Enter the mobile number and the name you used before. We\'ll connect this phone to your visits.'}</p>
      <div class="field"><label for="r-phone">Mobile number</label><input class="input" id="r-phone" inputmode="tel" autocomplete="tel" placeholder="0917 123 4567"></div>
      <div class="field"><label for="r-name">Name or nickname you used</label><input class="input" id="r-name" maxlength="30" autocomplete="nickname"></div>
      <div class="form-error" id="r-err" role="alert"></div>
      ${filled ? '' : '<p style="color:var(--muted);font-size:13.5px;">Didn\'t give us a number before? Just start fresh, and ask our staff to join your old visits to the new name.</p>'}`,
      `<button class="btn btn-main" id="r-go">Connect this phone</button>`, () => {
        if(prefill.phone) $('#r-phone').value = prefill.phone;
        if(prefill.nickname) $('#r-name').value = prefill.nickname;
        if(filled) (prefill.nickname ? $('#r-go') : $('#r-name')).focus();
        $('#r-go').onclick = async () => {
          const btn = $('#r-go'), err = $('#r-err');
          btn.disabled = true; err.textContent = '';
          try{
            const r = await cloud.rpc('qr_relink', {p_token: token, p_phone: $('#r-phone').value.trim(), p_nickname: $('#r-name').value.trim()});
            if(r.error){ err.textContent = errFor(r, 'relink'); btn.disabled = false; return; }
            S.customer = r.customer; S.justRegistered = false;
            closeSheet();
            await loadOrders();
            render();
            toast(`Welcome back, ${r.customer.nickname}!`);
          }catch(e){ err.textContent = errFor(e, 'relink'); btn.disabled = false; }
        };
      });
  }

  function notMe(){
    const name = S.customer ? S.customer.nickname : '';
    openSheet(`Not ${name}?`, `<p style="color:var(--muted);">This phone will forget ${esc(name)}. You can then enter your own name. ${esc(name)}'s visits are kept safe.</p>`,
      `<div class="btn-row"><button class="btn btn-quiet" id="nm-cancel" style="flex:1;">Keep ${esc(name)}</button><button class="btn btn-main" id="nm-go" style="flex:1;">Use my name</button></div>`, () => {
        $('#nm-cancel').onclick = closeSheet;
        $('#nm-go').onclick = async () => {
          $('#nm-go').disabled = true;
          try{ await cloud.rpc('qr_forget_device', {p_token: token}); }catch(e){}
          await cloud.signOut();
          try{ await cloud.signInAnonymously(); }catch(e){ S.canOrder = false; S.blockedReason = errText(e); }
          S.customer = null; S.orders = []; S.cart = []; saveCart(); S.view = 'menu';
          closeSheet(); render();
        };
      });
  }

  /* ---------------- order ticket ---------------- */
  // The ticket refreshes every few seconds while the order is open. Each part is only
  // replaced when it actually changed, so the number field (and its messages) keep what
  // the customer typed and keep the keyboard open.
  function patch(el, html){
    if(el._html === html) return false;
    el.innerHTML = html; el._html = html;
    return true;
  }
  function renderTicket(){
    const o = S.orders.find(x => x.id === S.orderId);
    if(!o){ S.view = 'menu'; renderMenu(); return; }
    const screen = $('#ticket-screen');
    if(!screen || screen.dataset.order !== o.id){
      $('#main').innerHTML = `<div id="ticket-screen" data-order="${esc(o.id)}">
        <section class="ticket" id="t-ticket" aria-label="Your order"></section>
        <div class="after-order"><div class="slot" id="t-phone"></div><div class="slot" id="t-hint"></div><div class="slot" id="t-actions"></div></div></div>`;
    }
    patch($('#t-ticket'), ticketHtml(o));
    if(patch($('#t-phone'), phoneCardHtml(o))) wirePhoneCard();
    if(patch($('#t-hint'), hintHtml())) wireHint();
    if(patch($('#t-actions'), ticketActionsHtml(o))) wireTicketActions();
  }
  function ticketHtml(o){
    const takeaway = o.order_type === 'TAKEAWAY';
    const st = o.status;
    const stepState = (n) => {
      const reached = {PENDING: 1, PREPARING: 2, READY: 3, COMPLETED: 4}[st] || 0;
      return n < reached ? 'done' : (n === reached ? 'now' : '');
    };
    const steps = [
      {b: 'Order received', s: st === 'PENDING' ? 'Waiting for the barista to confirm' : 'The barista has your order'},
      {b: 'Being prepared', s: 'Freshly made for you'},
      {b: 'Ready', s: takeaway ? 'Pick it up at the counter' : 'We\'ll bring it to your table'},
    ];
    const bad = st === 'REJECTED' || st === 'CANCELLED';
    const c = S.customer || {};
    // What the money line says depends on the order's state. "Pay at the counter" is only
    // for an order that is still open and unpaid; it never shows next to a cancelled or
    // rejected order (nothing is charged) or a finished one.
    let payClass = '', payText;
    if(bad){ payClass = ' off'; payText = 'Not charged'; }
    else if(o.paid_at){ payClass = ' paid'; payText = 'Paid — thank you!'; }
    else if(st === 'COMPLETED'){ payText = 'Thank you!'; }
    else payText = esc(S.menu.payment_note || 'Please pay at the counter.');
    const badNote = st === 'CANCELLED'
      ? '<b>You cancelled this order.</b><p>Nothing to pay.</p>'
      : `<b>Sorry, we couldn't take this order.</b>${o.reject_reason ? `<p>${esc(o.reject_reason)}</p>` : ''}`;
    return `
        <div class="ticket-top${bad ? ' is-bad' : ''}">
          <div class="ticket-label">${st === 'COMPLETED' ? 'Enjoy!' : 'Your order number'}</div>
          <div class="ticket-no">${esc(o.order_number)}</div>
          <div class="ticket-where">${esc(o.table_label || '')} · ${takeaway ? 'Take away' : 'Dine in'}${c.nickname ? ` · for ${esc(c.nickname)}` : ''}</div>
        </div>
        <div class="perf" aria-hidden="true"></div>
        ${bad ? `<div class="ticket-note">${badNote}</div>`
          : `<ol class="steps">${steps.map((s, i) => `<li class="step ${stepState(i + 1)}"><span class="dot">${stepState(i + 1) === 'done' ? '✓' : i + 1}</span><div><b>${s.b}</b><span>${s.s}</span></div></li>`).join('')}</ol>`}
        <div class="ticket-pay${payClass}"><span>${payText}</span><b>${money(o.total)}</b></div>
        <ul class="ticket-items">${(o.items || []).map(it => `<li><span>${it.quantity}× ${esc(it.name)}${(it.modifiers || []).length ? `<br><span class="mods">${esc(it.modifiers.map(m => m.label).join(', '))}</span>` : ''}</span><span>${money(it.line_total)}</span></li>`).join('')}</ul>`;
  }

  function phoneCardHtml(o){
    const bad = o.status === 'REJECTED' || o.status === 'CANCELLED';
    if(bad || !S.customer || S.customer.phone_hint) return '';
    return `<div class="card-quiet" id="phone-card"><h4>Keep your visits</h4>
      <p>Add your number so you keep your stamps if you change phones.</p>
      <div class="inline-form"><input class="input" id="pc-phone" inputmode="tel" autocomplete="tel" placeholder="0917 123 4567" aria-label="Mobile number"><button class="btn btn-main" id="pc-save" style="width:auto;">Save</button></div>
      <div class="form-error" id="pc-err" role="alert" style="margin:8px 0 0;"></div>
      <div id="pc-help"></div></div>`;
  }
  function wirePhoneCard(){
    const save = $('#pc-save');
    if(!save) return;
    const input = $('#pc-phone'), err = $('#pc-err'), help = $('#pc-help');
    input.oninput = () => { help.innerHTML = ''; };
    save.onclick = async () => {
      const phone = input.value.trim();
      err.textContent = ''; help.innerHTML = '';
      if(!phone){ err.textContent = MSG.BAD_PHONE; input.focus(); return; }
      save.disabled = true;
      try{
        const r = await cloud.rpc('qr_set_phone', {p_token: token, p_phone: phone});
        if(r.error){
          err.textContent = errFor(r, 'phone'); save.disabled = false;
          if(r.error === 'PHONE_TAKEN') showPhoneTaken(help, () => ({phone, nickname: S.customer ? S.customer.nickname : ''}), false);
          return;
        }
        S.customer = r.customer; render(); toast('Number saved');
      }catch(e){ err.textContent = errFor(e, 'phone'); save.disabled = false; }
    };
  }

  function hintHtml(){
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.navigator.standalone;
    let hideHint = false; try{ hideHint = localStorage.getItem('cccc.order.hintDone') === '1'; }catch(e){}
    return (isIOS && !hideHint) ? `<div class="card-quiet"><h4>Save this page</h4><p>On iPhone, tap Share, then “Add to Home Screen”, so this phone keeps remembering you.</p><button class="textlink" id="hint-ok">Got it</button></div>` : '';
  }
  function wireHint(){
    const hint = $('#hint-ok');
    if(hint) hint.onclick = () => { try{ localStorage.setItem('cccc.order.hintDone', '1'); }catch(e){} render(); };
  }

  function ticketActionsHtml(o){
    const bad = o.status === 'REJECTED' || o.status === 'CANCELLED';
    const alert = S.ticketAlert && S.ticketAlert.id === o.id ? S.ticketAlert.text : '';
    return `<button class="btn btn-main" id="order-more">${bad ? 'Back to the menu' : 'Order something else'}</button>
      ${o.status === 'PENDING' ? '<button class="btn btn-quiet" id="cancel-order">Cancel this order</button>' : ''}
      ${alert ? `<div class="inline-alert" role="alert">${esc(alert)}</div>` : ''}`;
  }
  function wireTicketActions(){
    $('#order-more').onclick = () => { S.view = 'menu'; document.title = 'Order — ' + shop(); render(); window.scrollTo({top: 0}); };
    const cancel = $('#cancel-order');
    if(cancel) cancel.onclick = async () => {
      const id = S.orderId;
      cancel.disabled = true; S.ticketAlert = null;
      const failed = (text) => { S.ticketAlert = {id, text}; if(cancel.isConnected) cancel.disabled = false; };
      try{
        const r = await cloud.rpc('qr_cancel_order', {p_token: token, p_order_id: id});
        if(r.error){ failed(errText(r)); await loadOrders(); render(); return; }
        const cur = S.orders.find(x => x.id === id);
        if(cur) Object.assign(cur, r.order);
        render(); toast('Order cancelled');
      }catch(e){ failed(errText(e)); render(); }
    };
  }

  start().catch(e => { console.error(e); renderEmpty('Something went wrong', 'Please reload the page.', true); });
})();
