/* =====================================================================
   CUSTOMER QR ORDERING
   Opened by scanning a table's QR code: .../order/?t=<table code>
   - First visit (1.5, Q1/A6): "Register (collect stamps)" or "Order as guest".
     Registering saves a nickname (phone optional) to the shop's customer list;
     a guest orders with no name and collects no stamps, and can register
     later on the same phone. The phone keeps its login token, so next time
     the page greets them by name — no sign-in step.
   - One phone per account (1.5, Q5): signing out ("Not you?") goes through
     qr_switch_account, which asks first when this phone has unpaid orders.
     The phone keeps its own login (it IS the phone); only the account link goes.
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
  // "Order as guest" was chosen on this phone (a screen choice only; the server decides who
  // may order). Cleared when the phone registers or connects to an account.
  const GUEST_KEY = 'cccc.order.guest';
  function loadGuest(){ try{ return localStorage.getItem(GUEST_KEY) === '1'; }catch(e){ return false; } }
  function saveGuest(on){ try{ if(on) localStorage.setItem(GUEST_KEY, '1'); else localStorage.removeItem(GUEST_KEY); }catch(e){} }

  const S = {
    menu: null, customer: null, canOrder: true, blockedReason: '',
    cart: [], orders: [], view: 'menu', orderId: null,
    orderType: 'DINE_IN', note: '', justRegistered: false, pollTimer: null,
    ticketAlert: null,   // {id, text}: a problem with cancelling, shown under the ticket's buttons
    signIn: null, signInErr: '', signInPromise: null,   // first sign-in with the person check (beginSignIn)
    readyHidden: new Set(),   // READY orders whose "ready for pickup" banner was closed (until reload)
    guest: loadGuest(),       // ordering as a guest (no account on this phone)
    joining: false,           // a guest opened the register form ("Register to collect stamps")
    welcomeNote: '',          // one message on the welcome screen: signed out elsewhere / after a switch
  };
  // A guest is ordering (not on the register form).
  function guestOrdering(){ return !S.customer && S.guest && !S.joining; }
  // Release 1.3 (A7): the shop takes QR orders only while a counter has an open shift.
  // get_qr_menu says so in is_open (missing on an older database = open).
  function isOpen(){ return !(S.menu && S.menu.is_open === false); }
  function reducedMotion(){ try{ return matchMedia('(prefers-reduced-motion: reduce)').matches; }catch(e){ return false; } }

  /* ---------------- helpers ---------------- */
  const $ = (sel, root) => (root || document).querySelector(sel);
  // Line icons from ../shared/ui.js (inline SVG, decorative unless labelled). '' if that file didn't load.
  function ico(name, opts){ try{ return typeof window.icon === 'function' ? window.icon(name, opts) : ''; }catch(e){ return ''; } }
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
    // qr_register: shop-wide limit on new customers. The register form also offers
    // "Order as guest instead" under this message (1.5).
    TOO_MANY_SIGNUPS: 'Lots of people are joining right now. Please wait a few minutes, or order at the counter.',
    // 1.5 (Q3): at most 4 unpaid tickets per table (real tables only).
    TABLE_FULL: 'This table already has 4 orders waiting to be paid. Please pay for one at the counter, then order again.',
    // 1.5 (Q4): one guest per table at a time. The cart also offers "Register to order".
    GUEST_TABLE_BUSY: 'Someone at this table is already ordering as a guest. Register (it\'s free) to order too, or wait until their order is paid.',
    // 1.5 (Q5): qr_relink on a phone that is still signed in to an account.
    SIGN_OUT_FIRST: 'This phone is still signed in to another name. Sign out first, then connect your number.',
    // 1.5 (Q5): qr_switch_account found unpaid orders (the sheet then asks Yes / No).
    UNPAID_ORDERS: 'You still have unpaid orders. Do you still want to proceed?',
    // 1.5 (Q2): qr_set_username.
    USERNAME_TAKEN: 'Someone already has that username. Try adding a word or a number.',
    BAD_USERNAME: 'That username can\'t be used. Use 3 to 50 letters (up to 4 numbers are OK), with no phone numbers, links or words like "staff" or "admin".',
    BAD_OPTION: 'Something on the menu changed. Please remove that item and add it again.',
    // (OPTION_REQUIRED is worded in errText with the group's name, e.g. "Choose Hot or iced for Latte.")
    BAD_QUANTITY: 'Please order 1 to 20 of each item.',
    TOO_MANY_OPEN_ORDERS: 'You already have 3 orders waiting. Please pay for those at the counter first.',
    // Also the shop-wide / per-table limit (F5): many orders in a short time.
    TOO_MANY_ORDERS: 'We\'re getting a lot of orders right now. Please wait a few minutes or order at the counter.',
    EMPTY_ORDER: 'Your order is empty.',
    ORDER_TOO_BIG: 'That order is too big for the app. Please order at the counter.',
    CANNOT_CANCEL: 'The shop already started this order, so it can\'t be cancelled here. Please talk to our staff.',
    NOT_SIGNED_IN: 'Your phone isn\'t connected. Reload the page and try again.',
    // qr_place_order (1.3): the last shift closed while the customer was ordering. The page
    // then shows the closed screen; the cart stays on this phone.
    SHOP_CLOSED: 'Sorry, we just closed. Your order is saved on this phone for when we open again.',
    // The optional "are you a person" check before a new phone's first sign-in (Captcha).
    CAPTCHA_FAILED: 'We couldn\'t confirm you\'re a person. Check your internet and try again.',
  };
  // This page loads cccc/shared/ui.js only for its icons and brand logo helpers. Its error wording
  // (friendlyError / ERROR_TEXT) is written for staff and is NOT used here: every message a
  // customer can see comes from MSG above. A code we don't know, or a raw server/network message,
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
    if(r.offline || r.code === 'offline') return 'No connection. Check your internet and try again.';
    // Supabase answers a refused check with error_code "captcha_failed"; Captcha.getToken
    // rejects with code CAPTCHA_FAILED.
    if(/captcha/i.test(String(r.code || '')) || /captcha/i.test(String(r.error || r.message || ''))) return MSG.CAPTCHA_FAILED;
    const code = codeOf(r);
    if(code === 'ITEM_UNAVAILABLE') return `${r.name || 'An item'} just sold out. Remove it to continue.`;
    if(code === 'OPTION_REQUIRED') return r.group ? `Choose ${r.group} for ${r.name || 'your item'}.` : `Choose an option for ${r.name || 'your item'}.`;
    return MSG[code] || FALLBACK;
  }
  // The server limits number checks (register, save number, "ordered here before") per phone.
  // Relink (1.5, L3): the lock can also be per number for 24 hours, so the words don't promise
  // a time; the same words whatever the number is (never says if a number is registered).
  const RELINK_TOO_MANY = (typeof CUSTOMER_ERROR_TEXT !== 'undefined' && CUSTOMER_ERROR_TEXT.TOO_MANY_ATTEMPTS)
    || 'Too many tries. Please ask our staff at the counter, or try again later.';
  const TOO_MANY = {
    register: 'Too many tries with a mobile number. Please wait about 15 minutes, or leave the number blank for now and add it later.',
    phone: 'Too many tries. Please wait about 15 minutes, then try again.',
    relink: RELINK_TOO_MANY,
    username: 'Too many tries. Please wait about 15 minutes, then try another username.',
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
  // theme.theme === 'CUSTOM': the shop's saved colours, logo and name (as text).
  // Anything else ('CCCC', missing, old values): the CCCC brand tokens, tile icon and wordmark image;
  // the saved colours are ignored. The brand helpers come from ../shared/ui.js.
  const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
  function hexMix(hex, toward, pct){   // toward: 0 = black, 255 = white
    let h = hex.slice(1); if(h.length === 3) h = h.split('').map(c => c + c).join('');
    const n = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
    return '#' + n.map(v => Math.round(v + (toward - v) * pct / 100).toString(16).padStart(2, '0')).join('');
  }
  function isCustomTheme(menu){ return !!(menu && menu.theme && String(menu.theme.theme || '').toUpperCase() === 'CUSTOM'); }
  function applyTheme(menu){
    const t = menu.theme || {};
    const custom = isCustomTheme(menu);
    const root = document.documentElement.style;
    ['--cc-terracotta','--cc-terracotta-deep','--cc-terracotta-tint','--cc-butter','--cc-paper','--cc-cream','--cc-card','--cc-ink','--qr-dark']
      .forEach(v => root.removeProperty(v));
    const ok = (v) => typeof v === 'string' && HEX.test(v);
    if(custom){
      if(ok(t.secondary_color)){   // "Second": header and main buttons
        root.setProperty('--cc-terracotta', t.secondary_color);
        root.setProperty('--cc-terracotta-deep', hexMix(t.secondary_color, 0, 22));
        root.setProperty('--cc-terracotta-tint', hexMix(t.secondary_color, 255, 85));
      }
      if(ok(t.primary_color)) root.setProperty('--qr-dark', t.primary_color);     // "Main": stamp card head, order bar
      if(ok(t.accent_color)) root.setProperty('--cc-butter', t.accent_color);     // "Accent": text on dark, header text
      if(ok(t.background_color)){ root.setProperty('--cc-paper', t.background_color); root.setProperty('--cc-cream', hexMix(t.background_color, 0, 4)); }
      if(ok(t.card_color)) root.setProperty('--cc-card', t.card_color);
      if(ok(t.text_color)) root.setProperty('--cc-ink', t.text_color);
    }
    const meta = document.querySelector('meta[name="theme-color"]');
    if(meta) meta.setAttribute('content', custom && ok(t.secondary_color) ? t.secondary_color : '#B5432B');
    const settings = {theme: custom ? 'CUSTOM' : 'CCCC', business_name: menu.business.name, logo_url: menu.business.logo_url};
    const name = menu.business.name || 'Cavite City Coffee Club';
    const mark = window.brandLogo ? brandLogo('mark', settings) : null;
    const word = window.brandWordmark ? brandWordmark('terracotta', settings) : null;
    // Custom theme: the shop's own logo, or none (never the CCCC tile for another shop).
    $('#brand-logo').innerHTML = (mark && (!custom || mark.custom))
      ? `<img src="${esc(mark.src)}" alt="" width="44" height="44" decoding="async">` : '';
    $('#brand-name').innerHTML = (word && word.src)
      ? `<img class="brand-wordmark" src="${esc(word.src)}" alt="" width="95" height="40" decoding="async"><span class="sr-only">${esc(word.alt)}</span>`
      : `<span class="brand-name-text">${esc(name)}</span>`;
    $('#table-tag').textContent = menu.table.label;
    document.title = 'Order — ' + name;
  }

  /* ---------------- cart (kept on this phone between reloads) ---------------- */
  function loadCart(){
    try{ return JSON.parse(localStorage.getItem(CART_KEY) || '[]'); }catch(e){ return []; }
  }
  function saveCart(){ try{ localStorage.setItem(CART_KEY, JSON.stringify(S.cart)); }catch(e){} }
  function itemById(id){ return S.menu.items.find(i => i.id === id); }
  // An item's option groups as get_qr_menu sends them (shared "library" groups first, then the
  // item's own). A group with no options is left out. The page reads only id, name, required,
  // multi_select and each option's id, label, price_delta and kind.
  function optionGroups(item){
    const gs = item && Array.isArray(item.modifier_groups) ? item.modifier_groups : [];
    return gs.filter(g => g && g.id != null && Array.isArray(g.options) && g.options.some(o => o && o.id != null))
      .map(g => Object.assign({}, g, {options: g.options.filter(o => o && o.id != null)}));
  }
  function findOption(item, sel){
    const g = sel && optionGroups(item).find(x => x.id === sel.group_id);
    const o = g && g.options.find(x => x.id === sel.option_id);
    return o ? {g, o} : null;
  }
  // Display price only (menu price + chosen options); the server prices the order.
  function unitPrice(item, selections){
    let p = Number(item.price) || 0;
    (selections || []).forEach(sel => { const f = findOption(item, sel); if(f) p += Number(f.o.price_delta) || 0; });
    return p;
  }
  function selectionLabels(item, selections){
    return sortSelections(item, selections).map(sel => { const f = findOption(item, sel); return f ? f.o.label : null; }).filter(Boolean);
  }
  // Choices in menu order (group, then option), so "Iced, Non-dairy milk, Half sweet" reads the
  // same on the cart, the ticket and the counter, and equal lines can be merged.
  function sortSelections(item, selections){
    const groups = optionGroups(item);
    const pos = (s) => {
      const gi = groups.findIndex(g => g.id === s.group_id);
      const oi = gi < 0 ? -1 : groups[gi].options.findIndex(o => o.id === s.option_id);
      return gi < 0 || oi < 0 ? 1e9 : gi * 1000 + oi;
    };
    return (selections || []).filter(s => s && s.group_id != null).map(s => ({group_id: s.group_id, option_id: s.option_id}))
      .sort((a, b) => pos(a) - pos(b));
  }
  // The choices that are still on the menu (at most one in a pick-one group, no repeats).
  function cleanSelections(item, selections){
    const out = [];
    sortSelections(item, selections).forEach(s => {
      const f = findOption(item, s);
      if(!f) return;
      if(out.some(x => x.group_id === s.group_id && (x.option_id === s.option_id || !f.g.multi_select))) return;
      out.push(s);
    });
    return out;
  }
  // A saved cart line the menu no longer accepts as it is: an option was taken off or changed,
  // or the shop made a group required (e.g. Hot or iced). The cart asks to "Choose again".
  function lineNeedsChoice(l){
    const it = itemById(l.recipe_id);
    if(!it) return false;
    const sels = l.modifiers || [];
    const clean = cleanSelections(it, sels);
    if(clean.length !== sels.length) return true;
    return optionGroups(it).some(g => g.required && !clean.some(s => s.group_id === g.id));
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
    // Closed: the menu has no items, so keep the saved cart as it is until the shop opens.
    S.cart = isOpen() ? loadCart().filter(l => itemById(l.recipe_id)) : loadCart();
    // A new phone with the person check switched on: show the welcome screen first and sign in
    // while the customer types their name (see beginSignIn). There's no customer or order yet.
    let signInLater = false;
    if(!menu.ordering_enabled){ S.canOrder = false; S.blockedReason = MSG.ORDERING_OFF; }
    else{
      try{
        const sess = await cloud.ensureSession();
        if(!sess){
          if(captchaOn()) signInLater = true;
          else await cloud.signInAnonymously();
        }
      }catch(e){
        S.canOrder = false;
        S.blockedReason = 'Ordering from your phone isn\'t available right now. You can still look at the menu and order at the counter.';
      }
    }
    if(S.canOrder && !signInLater){
      try{
        const r = await cloud.rpc('qr_session', {p_token: token});
        applySession(r);
        await loadOrders();
      }catch(e){ S.canOrder = false; S.blockedReason = errText(e); }
    }
    const openOne = S.orders.find(o => ['PENDING','PREPARING','READY'].includes(o.status));
    if(openOne && params.get('view') !== 'menu'){ S.view = 'order'; S.orderId = openOne.id; }
    render();
    if(signInLater) beginSignIn();
    schedulePoll();
    setInterval(() => { if(!document.hidden) checkMenu(); }, 120000);
  }

  /* ---------------- open / closed (release 1.3, A7) ---------------- */
  // Fetch the menu again (light: one call). Used every 2 minutes, when the page comes back,
  // and after a "sold out / menu changed" answer. Opening or closing redraws the page.
  let lastCheck = 0;
  async function checkMenu(){
    lastCheck = Date.now();
    let m;
    try{ m = await cloud.rpc('get_qr_menu', {p_token: token}); }catch(e){ return; }
    if(!m || m.error || !S.menu) return;
    const was = isOpen();
    S.menu = m;
    const now = isOpen();
    if(was && !now) onClosed();
    else if(!was && now){
      S.cart = loadCart().filter(l => itemById(l.recipe_id));
      render();
      toast('We\'re open! You can order now.');
      return;
    }
    render(true);
  }
  // The shop closed while the page was open: no more ordering. An item or cart sheet closes
  // (the cart itself stays saved on this phone); a ticket stays on screen.
  function onClosed(){
    const root = $('#sheet-root');
    if(root.dataset.kind === 'order') closeSheet();
    if(S.view !== 'order') window.scrollTo({top: 0});
  }
  window.addEventListener('focus', () => { if(S.menu && Date.now() - lastCheck > 15000) checkMenu(); });

  /* ---------------- first sign-in with the optional person check ---------------- */
  // With CCCC_CONFIG.CAPTCHA_SITE_KEY empty, Captcha.enabled() is false and nothing here runs:
  // the page signs in straight away, exactly as before. With a key, a new phone gets a token
  // from a small box above "Start ordering" (usually it passes by itself), then signs in.
  // S.signIn: null = done / not needed · 'pending' · 'failed' (message in S.signInErr).
  function captchaOn(){
    try{ return !!(window.Captcha && Captcha.enabled()); }catch(e){ return false; }
  }
  function beginSignIn(){
    if(S.signIn === 'pending') return S.signInPromise;
    S.signIn = 'pending'; S.signInErr = '';
    paintCaptcha();
    S.signInPromise = (async () => {
      try{
        const box = $('#w-captcha-box');
        if(!box) throw {error: 'CAPTCHA_FAILED'};
        const captchaToken = await Captcha.getToken(box, {timeoutMs: 60000});
        await cloud.signInAnonymously(captchaToken ? {captchaToken} : undefined);
        S.signIn = null;
      }catch(e){
        S.signIn = 'failed'; S.signInErr = errText(e);
      }
      paintCaptcha();
    })();
    return S.signInPromise;
  }
  // Wait for the sign-in to finish. true = signed in; false = the check failed (its message
  // and "Try again" are shown in the welcome screen).
  async function signedIn(){
    if(S.signIn === 'pending') await S.signInPromise;
    return S.signIn !== 'failed';
  }
  function paintCaptcha(){
    const wrap = $('#w-captcha');
    if(!wrap) return;
    const st = S.signIn;
    wrap.hidden = !st;
    // Most people see nothing here (the check runs by itself); a few get one tick box.
    $('#w-captcha-box').hidden = st !== 'pending';
    const fail = $('#w-captcha-fail');
    if(st === 'failed'){
      fail.innerHTML = `<div class="inline-alert" role="alert"><p>${esc(S.signInErr)}</p>
        <button class="btn btn-quiet" type="button" id="w-captcha-retry">Try again</button></div>`;
      $('#w-captcha-retry').onclick = () => { beginSignIn(); const go = $('#w-go'); if(go) go.focus(); };
    } else fail.innerHTML = '';
  }

  // qr_session's answer (1.5): {customer, state: 'GUEST' | 'REGISTERED', signed_out_elsewhere?}.
  // signed_out_elsewhere comes ONCE, when this phone lost its account because the account was
  // opened on another phone: say so on the welcome screen, and ask again how to order.
  const ELSEWHERE_NOTE = 'Your account was opened on another phone, so this phone is signed out. Your visits and stamps are safe. You can order as a guest, or register a new name.';
  function applySession(r){
    r = r || {};
    S.customer = r.customer || null;
    if(S.customer){ S.guest = false; S.joining = false; saveGuest(false); }
    if(r.signed_out_elsewhere){
      S.welcomeNote = ELSEWHERE_NOTE;
      S.guest = false; S.joining = false; saveGuest(false);
    }
  }

  async function loadOrders(){
    try{
      const r = await cloud.rpc('qr_my_orders', {p_token: token});
      const before = new Map(S.orders.map(o => [o.id, o.status + '|' + (o.paid_at ? 1 : 0)]));
      S.orders = (r && r.orders) || [];
      let paidNow = false;
      S.orders.forEach(o => {
        const was = before.get(o.id);
        if(!was) return;
        const [st, paid] = was.split('|');
        if(st !== o.status) onStatusChange(o);
        if((o.paid_at && paid !== '1') || (o.status === 'COMPLETED' && st !== 'COMPLETED')) paidNow = true;
      });
      if(paidNow && S.customer && S.menu && S.menu.loyalty_enabled) refreshCustomer();
    }catch(e){ /* keep what we have */ }
  }
  function onStatusChange(o){
    if(o.status === 'READY'){
      // The banner at the top says it too (renderBanner); buzz once, unless reduced motion.
      toast(`${o.order_number} is ready!`);
      if(!reducedMotion()){ try{ navigator.vibrate && navigator.vibrate(200); }catch(e){} }
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
    if(document.hidden || !S.menu) return;
    if(Date.now() - lastCheck > 15000) checkMenu();
    // Back on the page: was this account opened on another phone meanwhile? (one light call)
    if(S.canOrder && S.customer) await refreshCustomer();
    if(S.canOrder){ await loadOrders(); render(true); schedulePoll(); }
  });

  /* ---------------- rendering ---------------- */
  function renderEmpty(title, text, retry){
    $('#main').innerHTML = `<div class="empty"><h1 class="disp">${esc(title)}</h1><p>${esc(text)}</p>
      ${retry ? '<p><button class="btn btn-main" id="retry">Try again</button></p>' : ''}</div>`;
    if(retry) $('#retry').onclick = () => location.reload();
    $('#bottom').hidden = true;
  }

  // quiet = a refresh (new order status, back from another app), not something the customer tapped.
  let lastScreen = '';
  function render(quiet){
    if(!S.menu) return;
    const closed = !isOpen();
    // The welcome / register form: a phone with no account that hasn't chosen "Order as guest"
    // (or a guest who tapped "Register to collect stamps").
    const join = S.canOrder && !S.customer && !guestOrdering();
    const screen = S.view === 'order' ? 'order:' + S.orderId
      : closed ? (join ? 'closed-join' : 'closed') : (join ? 'welcome' : 'menu');
    const changed = screen !== lastScreen;
    if(changed){
      hideToast(); S.ticketAlert = null;
      // The welcome note is for the screen it was shown on; leaving it (registering, ordering
      // as a guest) clears it.
      if(lastScreen && /welcome|closed-join/.test(lastScreen) && !/welcome|closed-join/.test(screen)) S.welcomeNote = '';
      lastScreen = screen;
    }
    if(S.view === 'order') renderTicket();
    // The welcome form doesn't depend on orders: never wipe what the customer is typing.
    else if(screen === 'welcome' || screen === 'closed-join'){ if(changed || !quiet) renderWelcome(closed); }
    else if(screen === 'closed') renderClosed(quiet);
    else renderMenu(quiet);
    renderBottom();
    renderBanner();
  }

  /* ---------------- closed screen (release 1.3, A7) ----------------
     No counter has an open shift: no menu, no cart, no ordering. The customer can still
     see their stamp card, join, or connect this phone ("I've ordered here before"). */
  function closedHeroHtml(){
    const custom = isCustomTheme(S.menu);
    const settings = {theme: custom ? 'CUSTOM' : 'CCCC', business_name: S.menu.business.name, logo_url: S.menu.business.logo_url};
    const mark = window.brandLogo ? brandLogo('mark', settings) : null;
    const word = window.brandWordmark ? brandWordmark('cream', settings) : null;
    const name = S.menu.business.name || 'Cavite City Coffee Club';
    const logo = (mark && (!custom || mark.custom))
      ? `<img class="closed-mark" src="${esc(mark.src)}" alt="" width="88" height="88" decoding="async">` : '';
    const wordmark = (word && word.src)
      ? `<img class="closed-wordmark" src="${esc(word.src)}" alt="${esc(word.alt)}" width="190" height="80" decoding="async">`
      : `<p class="closed-name">${esc(name)}</p>`;
    const n = S.cart.reduce((t, l) => t + (Number(l.quantity) || 0), 0);
    return `<section class="closed" id="closed" aria-labelledby="closed-title">
      ${logo}${wordmark}
      <div class="closed-sign">
        <h1 class="disp closed-title" id="closed-title">Sarado pa po kami!</h1>
        <p class="closed-line">We're closed right now. Come back when we're open!</p>
      </div>
      ${n ? `<p class="closed-cart">${ico('receipt', {size: 18})}<span>Your order (${n} ${n === 1 ? 'item' : 'items'}) is saved on this phone for when we open.</span></p>` : ''}
    </section>`;
  }
  function openOrdersHtml(){
    const open = S.orders.filter(o => ['PENDING','PREPARING','READY'].includes(o.status) || (Date.now() - new Date(o.created_at).getTime() < 3600e3 && o.status !== 'CANCELLED'));
    return open.length ? `<div class="my-orders">${open.map(o => `<button class="my-order" data-order="${esc(o.id)}"><span><b>${esc(o.order_number)}</b> &nbsp;${money(o.total)}</span>${statusPill(o)}</button>`).join('')}</div>` : '';
  }
  function wireOpenOrders(){
    document.querySelectorAll('[data-order]').forEach(b => b.onclick = () => { S.view = 'order'; S.orderId = b.dataset.order; render(); window.scrollTo({top: 0}); });
  }
  function renderClosed(quiet){
    const y = window.scrollY;
    $('#main').innerHTML = `${closedHeroHtml()}${openOrdersHtml()}${S.customer ? memberCardHtml() : (guestOrdering() ? guestCardHtml() : '')}`;
    wireOpenOrders();
    wireAccount();
    if(quiet) window.scrollTo({top: y});
  }
  // The buttons of the member card / guest card (whichever is on screen).
  function wireAccount(){
    const nm = $('#not-me'); if(nm) nm.onclick = notMe;
    const un = $('#un-change'); if(un) un.onclick = openUsernameSheet;
    const gr = $('#guest-register'); if(gr) gr.onclick = startJoining;
  }
  // A guest wants to register: show the register form (the cart stays). Orders placed before
  // registering stay guest orders; orders after it collect stamps.
  function startJoining(){
    closeSheet();
    S.joining = true; S.view = 'menu';
    window.scrollTo({top: 0});
    render();
    const n = $('#w-name');
    if(n) n.focus({preventScroll: true});
  }

  /* ---------------- "ready for pickup" banner (release 1.3, A5) ----------------
     Every order (dine-in too) is picked up at the counter. While an order is READY a banner
     sits under the top bar on every screen. Closing it hides it until the page reloads. */
  function renderBanner(){
    const el = $('#ready-banner');
    if(!el) return;
    const ready = S.orders.filter(o => o.status === 'READY');
    const show = ready.filter(o => !S.readyHidden.has(o.id));
    document.title = ready.length ? `Ready: ${ready.map(o => o.order_number).join(', ')} — ${shop()}` : 'Order — ' + shop();
    const nums = show.map(o => o.order_number);
    const html = show.length ? `<div class="ready-inner">
        <span class="ready-ico" aria-hidden="true">${ico('check', {size: 22})}</span>
        <p class="ready-text"><b>Ready for pickup at the counter</b><span> — ${nums.length === 1 ? 'Order' : 'Orders'} ${esc(joinAnd(nums))}</span></p>
        <button class="ready-x" id="ready-x" type="button" aria-label="Hide this message">${ico('x', {size: 22})}</button>
      </div>` : '';
    if(el._html !== html){
      el.innerHTML = html; el._html = html;
      el.hidden = !show.length;
      const x = $('#ready-x');
      if(x) x.onclick = () => { show.forEach(o => S.readyHidden.add(o.id)); renderBanner(); };
    }
    document.documentElement.style.setProperty('--banner-h', (el.hidden ? 0 : el.offsetHeight) + 'px');
  }
  window.addEventListener('resize', () => { const el = $('#ready-banner'); if(el) document.documentElement.style.setProperty('--banner-h', (el.hidden ? 0 : el.offsetHeight) + 'px'); });

  function memberCardHtml(){
    const c = S.customer;
    const d = new Date(c.first_seen_at);
    const since = isNaN(d) ? '' : d.toLocaleDateString('en-PH', {month: 'short', year: 'numeric', timeZone: 'Asia/Manila'});
    const visits = Number(c.visit_count) || 0;
    const meta = [visits ? `${visits} ${visits === 1 ? 'visit' : 'visits'}` : 'New member', since ? `member since ${esc(since)}` : ''].filter(Boolean).join(' · ');
    // 1.5 (Q2): the customer's unique username (made by the server, e.g. "Mika the Coffee Devourer").
    const uname = c.username ? `<p class="username-line"><span class="un-label">Username</span>
        <b class="un-name">${esc(c.username)}</b>
        <button class="textlink" id="un-change" aria-label="Change username">Change</button></p>` : '';
    return `<section class="hello" aria-label="Your visits">
      <h1><span class="member-hello">${S.justRegistered ? 'Welcome to the club,' : 'Welcome back,'}</span> <span class="member-name">${esc(c.nickname)}</span>!</h1>
      <p class="hello-meta"><span>${meta}</span><button class="textlink" id="not-me">Not ${esc(c.nickname)}?</button></p>
      ${uname}
    </section>
    ${stampCardHtml(c)}`;
  }

  /* ---------------- guest (release 1.5, Q1/A6) ----------------
     A guest has no customer record: no name, no stamps. The stamp card shows greyed, with
     "Register to collect stamps" (the same phone; the cart stays). */
  function guestCardHtml(){
    const cfg = S.menu.loyalty_rewards || {};
    const size = Math.min(60, Number(cfg.card_size) || 0);
    const loyalty = S.menu.loyalty_enabled && size > 0;
    const hello = `<section class="hello" aria-label="Ordering as a guest">
      <h1><span class="member-hello">You're ordering as a</span> <span class="member-name">guest</span></h1>
      <p class="hello-meta"><span>No name needed. Pay at the counter.</span>${loyalty ? '' : '<button class="textlink" id="guest-register">Register</button>'}</p>
    </section>`;
    if(!loyalty) return hello;
    const rewards = Array.isArray(cfg.rewards) ? cfg.rewards : [];
    const by = {}; rewards.forEach(r => { by[r.stamp] = r; });
    const cells = [];
    for(let i = 1; i <= size; i++) cells.push(by[i] ? `<span class="stamp ms locked">${esc(rewardShort(by[i]))}</span>` : '<span class="stamp"></span>');
    const pitch = rewards.length ? `Members get ${joinAnd(rewards.map(r => `${rewardName(r)} at ${r.stamp}`))}.` : '';
    return `${hello}
    <section class="stampcard is-guest" id="guest-card" aria-labelledby="guest-card-title">
      <div class="stampcard-head"><h2 class="disp sc-title" id="guest-card-title">Stamp card</h2><span class="disp">Guest</span></div>
      <div class="stampcard-body">
        <div class="stamps" aria-hidden="true">${cells.join('')}</div>
        <p class="stamp-line">Guest orders don't collect stamps.</p>
        ${pitch ? `<p class="stamp-rule">${esc(pitch)}</p>` : ''}
        <button class="btn btn-main guest-join" id="guest-register">${ico('star', {size: 20})}<span>Register to collect stamps</span></button>
        <p class="stamp-rule center-text">It's free. Just a name; your number is optional.</p>
      </div>
    </section>`;
  }

  /* ---------------- stamp card (release 1.2) ----------------
     Everything comes from the server (qr_session / qr_register / qr_relink / qr_set_phone):
     c.card = {card_size, card_no, stamps_on_card, milestones:[{stamp, type, amount, label, status}]},
     c.ready_rewards = rewards reached and not used yet (this card and earlier ones).
     The data says how many stamps are on this card, not which were for a drink or for food,
     so every stamp is drawn the same way (filled, ink). */
  function peso0(n){ const v = Number(n) || 0; return '₱' + v.toLocaleString('en-PH', {minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2}); }
  function rewardShort(m){   // inside the circle
    if(m.type === 'AMOUNT_OFF' && Number(m.amount) > 0) return peso0(m.amount);
    if(m.type === 'FREE_ITEM') return 'FREE';
    return String(m.stamp);
  }
  function rewardName(m){    // "₱10 off", "a free drink or food"
    if(m.type === 'AMOUNT_OFF' && Number(m.amount) > 0) return peso0(m.amount) + ' off';
    if(m.type === 'FREE_ITEM') return 'a free drink or food';
    return m.label || 'a reward';
  }
  function readyPhrase(r){   // "your ₱10-off reward is ready"
    if(r.type === 'AMOUNT_OFF' && Number(r.amount) > 0) return `your ${peso0(r.amount)}-off reward is ready`;
    if(r.type === 'FREE_ITEM') return 'your free drink or food is ready';
    return `your reward (${r.label || 'reward'}) is ready`;
  }
  function joinAnd(list){ return list.length < 2 ? list.join('') : list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1]; }
  // Plain-text lines for the card (escaped by the caller). Returns {line, sr}.
  function stampText(card, ready){
    const n = Number(card.stamps_on_card) || 0, size = Number(card.card_size) || 0;
    const of = `${n} of ${size}`;
    if(ready.length === 1){
      const p = readyPhrase(ready[0]);
      return {line: `${of} · ${p}. Ask at the counter.`, sr: `${of} stamps. ${rewardName(ready[0]).replace(/^a /, 'A ')} is ready. Ask at the counter.`};
    }
    if(ready.length > 1){
      const names = joinAnd(ready.map(rewardName));
      return {line: `${of} · ${ready.length} rewards are ready: ${names}. Ask at the counter.`, sr: `${of} stamps. ${ready.length} rewards are ready: ${names}.`};
    }
    const next = (card.milestones || []).find(m => m.status === 'locked' && m.stamp > n);
    if(next){
      const left = next.stamp - n;
      // Closed (1.3): there's no "today's order" to stamp.
      const first = isOpen() ? 'Get your first stamp with today\'s order.' : 'Get your first stamp on your next visit.';
      const txt = n === 0 ? `${first} ${left} to ${rewardName(next)}.`
        : `${left} more ${left === 1 ? 'stamp' : 'stamps'} to ${rewardName(next)}.`;
      return {line: `${of} · ${txt}`, sr: `${of} stamps. ${txt}`};
    }
    return {line: `${of} · card complete! Your next stamp starts a new card.`, sr: `${of} stamps. Card complete. Your next stamp starts a new card.`};
  }
  function stampCardHtml(c){
    if(!S.menu.loyalty_enabled) return '';
    const card = c && c.card;
    if(!card || !(Number(card.card_size) > 0)) return '';
    const size = Math.min(60, Number(card.card_size));
    const n = Math.max(0, Math.min(size, Number(card.stamps_on_card) || 0));
    const ms = {};
    (card.milestones || []).forEach(m => { ms[m.stamp] = m; });
    const ready = Array.isArray(c.ready_rewards) ? c.ready_rewards : [];
    const cells = [];
    for(let i = 1; i <= size; i++){
      const m = ms[i];
      if(m){
        const st = ['ready', 'redeemed'].includes(m.status) ? m.status : 'locked';
        const inner = st === 'redeemed' ? ico('check', {size: 18}) : esc(rewardShort(m));
        cells.push(`<span class="stamp ms ${st}${i <= n ? ' got' : ''}">${inner}</span>`);
      } else cells.push(`<span class="stamp${i <= n ? ' got' : ''}"></span>`);
    }
    const txt = stampText(Object.assign({}, card, {stamps_on_card: n, card_size: size}), ready);
    const tag = (m) => {
      if(m.status === 'ready') return '<span class="rtag ready">Ready</span>';
      if(m.status === 'redeemed') return '<span class="rtag redeemed">Used</span>';
      const left = m.stamp - n;
      return `<span class="rtag">${left > 0 ? left + ' to go' : 'Locked'}</span>`;
    };
    const ord = (k) => k + (k % 10 === 1 && k % 100 !== 11 ? 'st' : k % 10 === 2 && k % 100 !== 12 ? 'nd' : k % 10 === 3 && k % 100 !== 13 ? 'rd' : 'th');
    const cardNo = Number(card.card_no) || 1;
    // 1.5 (B16): the next card opens only after this card's last reward is used; stamps earned
    // meanwhile are saved for it (the server counts them: card.saved_stamps).
    const saved = Math.max(0, Math.floor(Number(card.saved_stamps) || 0));
    const savedTxt = saved ? savedText(card, saved, cardNo) : '';
    return `<section class="stampcard" id="stamp-card" aria-labelledby="stamp-title">
      <div class="stampcard-head"><h2 class="disp sc-title" id="stamp-title">Stamp card</h2><span class="disp">${cardNo > 1 ? 'Card ' + cardNo : 'Bienvenido!'}</span></div>
      <div class="stampcard-body">
        <div class="stamps" role="img" aria-label="${esc(txt.sr + (savedTxt ? ' ' + savedTxt : ''))}">${cells.join('')}</div>
        <p class="stamp-line" aria-hidden="true">${esc(txt.line)}</p>
        ${savedTxt ? `<p class="stamp-saved" aria-hidden="true">${ico('star', {size: 18})}<span>${esc(savedTxt)}</span></p>` : ''}
        <p class="stamp-rule">One stamp for a drink and one for food, each day.</p>
        <ul class="rewards">${(card.milestones || []).map(m => `<li><span>${esc(ord(m.stamp))} stamp: ${esc(m.label || rewardName(m))}</span>${tag(m)}</li>`).join('')}</ul>
        ${pastCardsHtml(c)}
      </div>
    </section>`;
  }
  // "5 stamps saved for your next card. Use your free drink or food to start card 2."
  function savedText(card, saved, cardNo){
    const lastStamp = Number(card.last_reward_stamp) || 0;
    const last = (card.milestones || []).find(m => Number(m.stamp) === lastStamp)
      || (card.milestones || []).slice().sort((a, b) => b.stamp - a.stamp)[0];
    let use = 'your last reward';
    if(last && last.type === 'FREE_ITEM') use = 'your free drink or food';
    else if(last && last.type === 'AMOUNT_OFF' && Number(last.amount) > 0) use = `your ${peso0(last.amount)}-off reward`;
    const head = `${saved} ${saved === 1 ? 'stamp' : 'stamps'} saved for your next card.`;
    return last && last.status === 'redeemed' ? head : `${head} Use ${use} to start card ${cardNo + 1}.`;
  }
  // A day in Manila: "Sep 16, 2026" ('' when missing or not a date).
  function dayText(iso){
    if(!iso) return '';
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleDateString('en-PH', {day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Manila'});
  }
  // 1.5 (B16): completed cards from c.history (oldest first from the server; shown newest first):
  // [{card_no, filled_at, completed_at, rewards: [{stamp, type, label, amount, used_at}]}]
  function pastCardsHtml(c){
    const list = Array.isArray(c && c.history) ? c.history.filter(h => h && Number(h.card_no) > 0) : [];
    if(!list.length) return '';
    const rows = list.slice().sort((a, b) => Number(b.card_no) - Number(a.card_no)).map(h => {
      const filled = dayText(h.filled_at), done = dayText(h.completed_at);
      const when = [filled ? `filled ${filled}` : '', done ? `completed ${done}` : ''].filter(Boolean).join(' · ');
      const rewards = (Array.isArray(h.rewards) ? h.rewards : []).slice().sort((a, b) => Number(a.stamp) - Number(b.stamp)).map(r => {
        const name = r.type === 'AMOUNT_OFF' && Number(r.amount) > 0 ? `${peso0(r.amount)} off`
          : r.type === 'FREE_ITEM' ? `Free drink or food${Number(r.amount) > 0 ? ` (${peso0(r.amount)} value)` : ''}`
          : (r.label || 'Reward');
        const used = dayText(r.used_at);
        return `<li><span>${esc(name)}</span>${used ? `<span class="pc-when">used ${esc(used)}</span>` : ''}</li>`;
      }).join('');
      return `<li class="pc"><p class="pc-head"><b>Card ${esc(Number(h.card_no))}</b>${when ? `<span> · ${esc(when)}</span>` : ''}</p>
        ${rewards ? `<ul class="pc-rewards" aria-label="Rewards used on card ${esc(Number(h.card_no))}">${rewards}</ul>` : ''}</li>`;
    }).join('');
    return `<details class="past-cards" id="past-cards">
      <summary><span>Past cards (${list.length})</span>${ico('chevron-down', {size: 20})}</summary>
      <ol class="pc-list">${rows}</ol>
    </details>`;
  }
  // Stamps change when the shop takes payment: fetch the customer again (quietly).
  // Also notices (1.5) when this phone was signed out because the account was opened on
  // another phone: the page then shows the welcome screen with that message.
  async function refreshCustomer(){
    try{
      const r = await cloud.rpc('qr_session', {p_token: token});
      if(!r || r.error) return;
      if(r.customer){ S.customer = r.customer; render(true); return; }
      if(S.customer && r.state === 'GUEST'){
        applySession(r);
        if(!r.signed_out_elsewhere) S.welcomeNote = 'This phone is no longer signed in. You can order as a guest, or register again.';
        closeSheet(); S.view = 'menu'; window.scrollTo({top: 0}); render();
      }
    }catch(e){}
  }

  // closed (1.3): the shop is closed. Same form under the closed sign, without the menu:
  // the customer can still join the stamp card or connect this phone.
  function renderWelcome(closed){
    // Keep a person check that is still running (its box holds the check's own frame).
    const runningBox = S.signIn === 'pending' ? $('#w-captcha-box') : null;
    // Keep what the customer typed when the page redraws (e.g. the shop opens or closes).
    const kept = {name: ($('#w-name') || {}).value, phone: ($('#w-phone') || {}).value, consent: ($('#w-consent') || {}).checked};
    const goLabel = closed ? 'Join the stamp card' : (S.joining ? 'Register' : 'Start ordering');
    const stamps = !!S.menu.loyalty_enabled;
    const joinCopy = closed
      ? (stamps
        ? `<h2 class="disp">Collect stamps next time</h2><p>Save your name now, and we'll greet you and add your stamps when you order.</p>`
        : `<h2 class="disp">Save your name</h2><p>Save your name now, and we'll greet you by name when you order.</p>`)
      : `<h2 class="disp">What should we call you?</h2>
        <p>We'll use this name when your order is ready, and greet you by name next time.${S.joining && stamps ? ' Orders you place after registering collect stamps.' : ''}</p>`;
    // 1.5 (Q1/A6): register or order as a guest. Register is the form below (shown straight
    // away); "Order as guest" goes to the menu. Closed: there's nothing to order, so no guest choice.
    const choice = closed ? '' : `
      <div class="welcome-copy choose-copy"><h1 class="disp">${S.joining ? 'Register to collect stamps' : 'How would you like to order?'}</h1></div>
      <div class="choice" role="group" aria-label="How to order">
        <button class="choice-btn on" type="button" id="w-choose-reg" aria-pressed="true">
          <span class="choice-ico" aria-hidden="true">${ico('star', {size: 22})}</span>
          <span class="choice-txt"><b>Register</b><span>${stamps ? 'Collect stamps · free' : 'We\'ll remember you · free'}</span></span></button>
        <button class="choice-btn" type="button" id="w-guest" aria-pressed="false">
          <span class="choice-ico" aria-hidden="true">${ico('user', {size: 22})}</span>
          <span class="choice-txt"><b>${S.joining ? 'Back to guest' : 'Order as guest'}</b><span>${stamps ? 'No name · no stamps' : 'No name needed'}</span></span></button>
      </div>`;
    const note = S.welcomeNote ? `<div class="notice note-info" role="status">${ico('info', {size: 20})}<p>${esc(S.welcomeNote)}</p></div>` : '';
    $('#main').innerHTML = `
      ${closed ? closedHeroHtml() + openOrdersHtml() : openOrdersHtml()}
      ${note}
      ${choice}
      ${joinCardHtml()}
      <div class="welcome-copy">
        ${joinCopy}
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
      <div class="captcha" id="w-captcha" hidden>
        <div class="captcha-box" id="w-captcha-box"></div>
        <div id="w-captcha-fail"></div>
      </div>
      <button class="btn btn-main" id="w-go" data-label="${esc(goLabel)}">${esc(goLabel)}</button>
      <p class="center"><button class="textlink" id="w-relink">I've ordered here before on another phone</button></p>
      ${closed ? '' : menuHtml(true)}`;
    const name = $('#w-name'), preview = $('#w-preview');
    if(kept.name) name.value = kept.name;
    if(kept.phone) $('#w-phone').value = kept.phone;
    if(kept.consent) $('#w-consent').checked = true;
    name.oninput = () => {
      const v = name.value.trim();
      preview.textContent = v || 'there';
      preview.classList.toggle('placeholder', !v);
    };
    $('#w-phone').oninput = () => { $('#w-help').innerHTML = ''; };
    $('#w-go').onclick = register;
    $('#w-relink').onclick = () => openRelinkSheet();
    const reg = $('#w-choose-reg');
    if(reg) reg.onclick = () => {
      name.scrollIntoView({block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth'});
      name.focus({preventScroll: true});
    };
    const guest = $('#w-guest');
    if(guest) guest.onclick = orderAsGuest;
    wireOpenOrders();
    if(!closed) wireMenu();
    if(kept.name) name.oninput();
    if(runningBox) $('#w-captcha-box').replaceWith(runningBox);
    paintCaptcha();
  }

  // First visit: a preview of the (empty) stamp card with the name as it's typed.
  // Decorative only (aria-hidden): the form below says the same in words.
  function joinCardHtml(){
    const cfg = S.menu.loyalty_rewards || {};
    const size = Math.min(60, Number(cfg.card_size) || 0);
    const rewards = Array.isArray(cfg.rewards) ? cfg.rewards : [];
    const by = {}; rewards.forEach(r => { by[r.stamp] = r; });
    const loyalty = S.menu.loyalty_enabled && size > 0;
    let grid = '', pitch = '';
    if(loyalty){
      const cells = [];
      for(let i = 1; i <= size; i++) cells.push(by[i] ? `<span class="stamp ms locked">${esc(rewardShort(by[i]))}</span>` : '<span class="stamp"></span>');
      grid = `<div class="stamps">${cells.join('')}</div>`;
      pitch = `<p class="join-pitch">Join free: ${esc(joinAnd(rewards.map(r => `${rewardName(r)} at ${r.stamp}`)))}. One stamp for a drink and one for food, each day.</p>`;
    }
    return `<section class="stampcard" aria-hidden="true">
      <div class="stampcard-head"><span class="disp sc-title">${loyalty ? 'Stamp card' : 'Welcome'}</span><span class="disp">Bienvenido!</span></div>
      <div class="stampcard-body">
        <p class="join-hi">Hi, <span class="member-name placeholder" id="w-preview">there</span>!</p>
        ${grid ? `<div class="join-grid">${grid}</div>` : ''}${pitch}
      </div></section>`;
  }

  // "Order as guest" (1.5): no name, no stamps. With the person check on, the phone's first
  // sign-in has to finish first (its box and "Try again" are on this screen).
  async function orderAsGuest(){
    const btn = $('#w-guest');
    if(btn) btn.disabled = true;
    if(S.signIn){
      const ok = await signedIn();
      if(!ok){
        if(btn) btn.disabled = false;
        const retry = $('#w-captcha-retry');
        if(retry){ retry.scrollIntoView({block: 'center'}); retry.focus({preventScroll: true}); }
        return;
      }
    }
    const wasJoining = S.joining;
    S.guest = true; S.joining = false; saveGuest(true);
    window.scrollTo({top: 0});
    render();
    toast(wasJoining ? 'Back to ordering as a guest' : 'You\'re ordering as a guest');
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
    if(S.signIn){
      btn.textContent = 'Just a moment…';
      const ok = await signedIn();
      btn.textContent = btn.dataset.label || 'Start ordering';
      if(!ok){ btn.disabled = false; const retry = $('#w-captcha-retry'); if(retry) retry.focus(); return; }
    }
    try{
      const r = (await cloud.rpc('qr_register', {p_token: token, p_nickname: nickname, p_phone: phone || null, p_consent: true})) || {};
      if(r.error || !r.customer){
        err.textContent = errFor(r.error ? r : null, 'register'); btn.disabled = false;
        if(r.error === 'PHONE_TAKEN') showPhoneTaken(help, () => ({phone, nickname: $('#w-name').value.trim()}), true);
        if(r.error === 'BAD_PHONE') $('#w-phone').focus();
        // Lots of sign-ups right now: ordering as a guest still works (1.5).
        if(r.error === 'TOO_MANY_SIGNUPS' && isOpen() && $('#w-guest')){
          help.innerHTML = '<div class="taken"><p>You can still order now without a name.</p><button class="btn btn-quiet" type="button" id="w-guest-too">Order as guest instead</button></div>';
          $('#w-guest-too').onclick = orderAsGuest;
        }
        return;
      }
      S.customer = r.customer;
      S.guest = false; S.joining = false; saveGuest(false);
      S.justRegistered = true;
      window.scrollTo({top: 0});
      render();
      toast(`Welcome, ${r.customer.nickname}!`);
    }catch(e){ err.textContent = errFor(e, 'register'); btn.disabled = false; }
  }

  /* ---------------- sub-category order and colours (release 1.3, A16 + A3) ----------------
     Sections follow the shop's order (menu.subcategory_order) with drinks always first, then
     pastry, then food (sortSubcategoryNames in ../shared/ui.js). Each section's items sit on
     tiles in the counter's colour for that sub-category (menu.subcategory_colors). Only the
     known colour KEYS below are used, as var(--tile-<key>-bg/fg) from tokens.css; anything
     else (an unknown word, a colour code) is ignored and the item keeps the plain card. */
  const TILE_KEYS = {terracotta: 0, deep_terracotta: 0, olive: 0, ink: 0, cocoa: 0, gold: 1, butter: 1, sage: 1, clay: 1, sky: 1};   // 1 = light tile (gets a border)
  function tileKeyFor(name){
    const map = S.menu && S.menu.subcategory_colors;
    if(!map || typeof map !== 'object' || Array.isArray(map) || name == null) return null;
    const good = (k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(TILE_KEYS, k) ? k : null;
    if(Object.prototype.hasOwnProperty.call(map, name)) return good(map[name]);
    const norm = (x) => String(x).trim().replace(/\s+/g, ' ').toLowerCase();
    const want = norm(name);
    const hit = Object.keys(map).find(k => norm(k) === want);
    return hit === undefined ? null : good(map[hit]);
  }
  function tileAttrs(key){   // class + style for a coloured item tile / chip dot; '' when no colour
    if(!key) return {cls: '', style: ''};
    return {cls: ' tiled ' + (TILE_KEYS[key] ? 'tile-light' : 'tile-dark'),
            style: ` style="--t-bg:var(--tile-${key}-bg);--t-fg:var(--tile-${key}-fg)"`};
  }
  function orderedCategories(items){
    const cats = [], types = {};
    items.forEach(i => { if(!cats.includes(i.category)){ cats.push(i.category); types[i.category] = i.recipe_type; } });
    if(typeof window.sortSubcategoryNames !== 'function') return cats;
    try{ return sortSubcategoryNames(cats, (n) => types[n], S.menu.subcategory_order); }catch(e){ return cats; }
  }

  function menuHtml(preview){
    const items = S.menu.items;
    if(!items.length) return `<div class="notice">The menu is being updated. Please order at the counter for now.</div>`;
    const cats = orderedCategories(items);
    const counts = {};
    S.cart.forEach(l => { counts[l.recipe_id] = (counts[l.recipe_id] || 0) + l.quantity; });
    const tiles = cats.map(c => tileAttrs(tileKeyFor(c)));
    return `
      ${preview ? '<h2 class="disp menu-title">On the menu</h2>' : ''}
      ${highlightHtml(preview)}
      <nav class="cats" aria-label="Menu sections">${cats.map((c, i) => `<button class="cat ${i === 0 ? 'on' : ''}${tiles[i].cls}" data-cat="${i}"${tiles[i].style}>${tiles[i].cls ? '<span class="cat-dot" aria-hidden="true"></span>' : ''}${esc(c)}</button>`).join('')}</nav>
      ${cats.map((c, i) => `<section class="menu-section${tiles[i].cls}" id="cat-${i}"${tiles[i].style}><h2 class="disp">${esc(c)}</h2><div class="items">
        ${items.filter(it => it.category === c).map(it => `
          <button class="item ${it.available ? '' : 'off'}${tiles[i].cls}" data-item="${esc(it.id)}" ${(!it.available || preview || !S.canOrder) ? 'aria-disabled="true"' : ''}>
            <span class="item-thumb">${it.image_url ? `<img src="${esc(it.image_url)}" alt="" width="64" height="64" loading="lazy" decoding="async">` : ico('cup', {size: 26})}</span>
            <span class="item-body">
              <span class="item-name">${esc(it.name)}${counts[it.id] ? `<span class="item-count">${counts[it.id]} in order</span>` : ''}</span>
              ${it.description ? `<span class="item-desc">${esc(it.description)}</span>` : ''}
              <span class="item-price">${money(it.price)}</span>
            </span>
            <span class="item-add" aria-hidden="true">${ico('plus', {size: 22})}</span>
          </button>`).join('')}
      </div>      </section>`).join('')}`;
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
    $('#main').innerHTML = `
      ${S.customer ? memberCardHtml() : ''}
      ${!S.canOrder ? `<div class="notice warn" role="status">${esc(S.blockedReason)}</div>` : (S.menu.welcome_message ? `<div class="notice">${esc(S.menu.welcome_message)}</div>` : '')}
      ${openOrdersHtml()}
      ${menuHtml(false)}`;
    wireMenu();
    wireOpenOrders();
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
    if(S.view !== 'menu' || !isOpen() || !S.canOrder || !S.customer || !t.count){ b.hidden = true; return; }
    b.hidden = false;
    b.innerHTML = `<button class="btn" id="view-cart"><span>View order · ${t.count} item${t.count === 1 ? '' : 's'}</span><span>${money(t.total)}</span></button>`;
    $('#view-cart').onclick = openCartSheet;
  }

  /* ---------------- sheets ---------------- */
  function openSheet(title, bodyHtml, footHtml, onMount){
    const root = $('#sheet-root');
    root.innerHTML = `<div class="scrim" id="scrim"><div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="sheet-head"><h3>${esc(title)}</h3><button class="sheet-close" id="sheet-x" aria-label="Close">${ico('x', {size: 22})}</button></div>
      <div class="sheet-body">${bodyHtml}</div>${footHtml ? `<div class="sheet-foot">${footHtml}</div>` : ''}</div></div>`;
    root.dataset.kind = '';
    $('#sheet-x').onclick = closeSheet;
    $('#scrim').addEventListener('click', e => { if(e.target.id === 'scrim') closeSheet(); });
    document.body.style.overflow = 'hidden';
    if(onMount) onMount($('#sheet-root .sheet'));
  }
  function closeSheet(){ const r = $('#sheet-root'); r.innerHTML = ''; r.dataset.kind = ''; document.body.style.overflow = ''; }
  document.addEventListener('keydown', e => { if(e.key === 'Escape') closeSheet(); });

  // The item sheet. Option groups come from get_qr_menu as they are: the shop's shared groups
  // ("library", e.g. Hot or iced, Milk) and the item's own groups look and work the same.
  // Each option is {id, label, price_delta, kind}; kind SWAP (e.g. non-dairy milk) only changes
  // what is shown. Prices here are for display: qr_place_order works out the real total.
  // editKey: a cart line to change (its "Choose again" button); the line is replaced on save.
  function openItemSheet(itemId, editKey){
    const it = itemById(itemId);
    if(!it) return;
    const editing = editKey ? S.cart.find(l => l.key === editKey) : null;
    const groups = optionGroups(it);
    // Start from the line's choices that are still on the menu (one per pick-one group).
    let selections = editing ? cleanSelections(it, editing.modifiers) : [];
    let qty = editing ? editing.quantity : 1;
    let tried = false;   // "Add" was tapped with a required group still empty
    const body = `
      ${it.image_url ? `<img class="sheet-photo" src="${esc(it.image_url)}" alt="" loading="lazy" decoding="async">` : ''}
      ${it.description ? `<p class="sheet-desc">${esc(it.description)}</p>` : ''}
      ${groups.map((g, gi) => groupHtml(g, gi)).join('')}
      <div class="field gap-top"><label for="it-note">Special request (optional)</label>
        <input class="input" id="it-note" maxlength="140" placeholder="e.g. less ice"></div>
      <div class="qty" role="group" aria-label="How many"><button id="q-minus" aria-label="One less">${ico('minus', {size: 22})}</button><span id="q-val" aria-live="polite">1</span><button id="q-plus" aria-label="One more">${ico('plus', {size: 22})}</button></div>`;
    openSheet(it.name, body, `<p class="foot-msg" id="it-msg" role="alert"></p><button class="btn btn-main" id="it-add"></button>`, (sheet) => {
      $('#sheet-root').dataset.kind = 'order';
      if(editing && editing.notes) $('#it-note').value = editing.notes;
      const groupEl = (g) => sheet.querySelector(`.group[data-group="${CSS.escape(g.id)}"]`);
      function missingGroups(){ return groups.filter(g => g.required && !selections.some(s => s.group_id === g.id)); }
      function refresh(){
        sheet.querySelectorAll('.opt').forEach(b => b.setAttribute('aria-pressed', String(selections.some(s => s.group_id === b.dataset.g && s.option_id === b.dataset.o))));
        const missing = missingGroups();
        groups.forEach(g => {
          const el = groupEl(g); if(!el) return;
          const need = tried && missing.includes(g);
          el.classList.toggle('need', need);
          const small = el.querySelector('small');
          if(small){
            const done = g.required && !missing.includes(g);
            small.className = 'g-hint' + (need ? ' need' : done ? ' done' : g.required ? ' req' : '');
            small.innerHTML = need ? (g.multi_select ? 'Please choose at least 1' : 'Please choose 1')
              : done ? `${ico('check', {size: 14})}<span>Chosen</span>` : esc(groupHint(g));
          }
        });
        // The message above the button goes away once every required group has a choice.
        const msg = $('#it-msg');
        msg.textContent = tried && missing.length ? `Choose ${joinAnd(missing.map(g => g.name))} first.` : '';
        $('#q-val').textContent = qty;
        $('#it-add').textContent = `${editing ? 'Update' : 'Add'} ${qty > 1 ? qty + ' ' : ''}${editing ? 'in' : 'to'} order · ${money(unitPrice(it, selections) * qty)}`;
      }
      sheet.querySelectorAll('.opt').forEach(b => b.onclick = () => {
        const g = groups.find(x => x.id === b.dataset.g);
        if(!g) return;
        const has = selections.some(s => s.group_id === g.id && s.option_id === b.dataset.o);
        if(g.multi_select){
          selections = has ? selections.filter(s => !(s.group_id === g.id && s.option_id === b.dataset.o)) : selections.concat([{group_id: g.id, option_id: b.dataset.o}]);
        } else {
          selections = selections.filter(s => s.group_id !== g.id);
          // Pick-one: tapping the chosen option again clears it, unless the group is required.
          if(!has || g.required) selections.push({group_id: g.id, option_id: b.dataset.o});
        }
        refresh();
      });
      $('#q-minus').onclick = () => { qty = Math.max(1, qty - 1); refresh(); };
      $('#q-plus').onclick = () => { qty = Math.min(20, qty + 1); refresh(); };
      $('#it-add').onclick = () => {
        const missing = missingGroups();
        if(missing.length){
          // Say what's missing next to the button, and take them to (and focus) the first empty group.
          tried = true; refresh();
          const first = groupEl(missing[0]);
          if(first){
            first.scrollIntoView({block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth'});
            first.focus({preventScroll: true});
          }
          return;
        }
        const notes = $('#it-note').value.trim();
        const mods = sortSelections(it, selections);
        const others = S.cart.filter(l => l !== editing);
        const same = others.find(l => l.recipe_id === it.id && !l.notes && !notes && JSON.stringify(sortSelections(it, l.modifiers)) === JSON.stringify(mods));
        if(same){ same.quantity = Math.min(20, same.quantity + qty); if(editing) S.cart = others; }
        else if(editing) Object.assign(editing, {quantity: qty, modifiers: mods, notes});
        else S.cart.push({key: Math.random().toString(36).slice(2), recipe_id: it.id, quantity: qty, modifiers: mods, notes});
        saveCart();
        if(editing){ render(true); openCartSheet(); toast(`Updated ${it.name}`); return; }
        closeSheet();
        toast(`Added ${it.name}`);
        render(true);
      };
      refresh();
    });
  }
  // One option group in the item sheet. Short labels (Hot / Iced, sizes) sit two to a row so a
  // drink with many groups stays short; long labels get the full width.
  function groupHtml(g, gi){
    const short = g.options.length >= 2 && g.options.length <= 6 &&g.options.every(o => String(o.label || '').length <= 14);
    const titleId = 'g-title-' + gi;
    return `<section class="group${g.required ? ' is-req' : ''}" data-group="${esc(g.id)}" role="group" aria-labelledby="${titleId}" tabindex="-1">
      <div class="group-title"><h4 id="${titleId}">${esc(g.name)}</h4><small class="g-hint${g.required ? ' req' : ''}">${esc(groupHint(g))}</small></div>
      <div class="opts${short ? ' opts-2' : ''}">${g.options.map(o => optionHtml(g, o)).join('')}</div></section>`;
  }
  function groupHint(g){
    if(g.required) return g.multi_select ? 'Required · choose 1 or more' : 'Required · choose 1';
    return g.multi_select ? 'Optional · choose any' : 'Optional · choose 1';
  }
  function optionHtml(g, o){
    const delta = Number(o.price_delta) || 0;
    // A swap (e.g. "Non-dairy milk") replaces something in the drink: say so under the label.
    const swap = String(o.kind || '').toUpperCase() === 'SWAP';
    return `<button class="opt${g.multi_select ? ' multi' : ''}${swap ? ' swap' : ''}" aria-pressed="false" data-g="${esc(g.id)}" data-o="${esc(o.id)}">
      <span class="tick">${ico('check', {size: 14})}</span>
      <span class="opt-label">${esc(o.label)}${swap ? '<span class="opt-sub">In place of the usual</span>' : ''}</span>
      ${delta ? `<span class="delta">${delta > 0 ? '+' : '−'}${money(Math.abs(delta))}</span>` : ''}</button>`;
  }

  function openCartSheet(){
    const t = cartTotals();
    const dineInTable = S.menu.table.kind === 'DINE_IN';
    const body = `
      ${S.cart.map(l => {
        const it = itemById(l.recipe_id);
        if(!it) return '';
        const labels = selectionLabels(it, l.modifiers);
        const fix = lineNeedsChoice(l);
        return `<div class="cart-line${fix ? ' fix' : ''}"><div class="grow"><b>${esc(it.name)}</b>
          ${labels.length ? `<div class="mods">${esc(labels.join(', '))}</div>` : ''}
          ${l.notes ? `<div class="mods">“${esc(l.notes)}”</div>` : ''}
          ${fix ? `<div class="fix-note"><span>The choices for this item changed.</span><button class="btn btn-quiet fix-btn" data-fix="${esc(l.key)}">Choose again</button></div>` : ''}
          <div class="mini-qty"><button data-dec="${esc(l.key)}" aria-label="One less">${ico('minus', {size: 20})}</button><span>${l.quantity}</span><button data-inc="${esc(l.key)}" aria-label="One more">${ico('plus', {size: 20})}</button></div></div>
          <div class="line-total">${money(unitPrice(it, l.modifiers) * l.quantity)}</div></div>`;
      }).join('')}
      ${dineInTable ? `<div class="seg" role="group" aria-label="Dine in or take away">
          <button data-type="DINE_IN" aria-pressed="${S.orderType === 'DINE_IN'}">Dine in</button>
          <button data-type="TAKEAWAY" aria-pressed="${S.orderType === 'TAKEAWAY'}">Take away</button></div>` : ''}
      <div class="field gap-top"><label for="c-note">Note for the barista (optional)</label>
        <input class="input" id="c-note" maxlength="200" value="${esc(S.note)}" placeholder="e.g. Please bring water"></div>
      <div class="totals">
        <div><span>Subtotal</span><span>${money(t.subtotal)}</span></div>
        ${t.service ? `<div><span>Service charge (${S.menu.service_charge_pct}%)</span><span>${money(t.service)}</span></div>` : ''}
        ${t.tax ? `<div><span>Tax (${S.menu.tax_pct}%)</span><span>${money(t.tax)}</span></div>` : ''}
        <div class="grand"><span>Total</span><span>${money(t.total)}</span></div>
      </div>
      <p class="pay-note">${esc(S.menu.payment_note || 'Pay at the counter.')}</p>
      <div class="form-error err-after" id="c-err" role="alert"></div>`;
    openSheet('Your order', body, `<button class="btn btn-main" id="c-place">Place order · ${money(t.total)}</button>`, (sheet) => {
      $('#sheet-root').dataset.kind = 'order';
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
      sheet.querySelectorAll('[data-fix]').forEach(b => b.onclick = () => {
        const l = S.cart.find(x => x.key === b.dataset.fix);
        S.note = $('#c-note').value;
        if(l) openItemSheet(l.recipe_id, l.key);
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
    // A line whose choices the menu no longer accepts would be refused: ask first.
    const fix = S.cart.find(lineNeedsChoice);
    if(fix){
      const it = itemById(fix.recipe_id);
      err.textContent = `Tap "Choose again" on ${it ? it.name : 'the marked item'} first.`;
      const b = document.querySelector(`[data-fix="${CSS.escape(fix.key)}"]`);
      if(b){ b.scrollIntoView({block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth'}); b.focus({preventScroll: true}); }
      return;
    }
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
        if(r.error === 'ITEM_UNAVAILABLE'){ refreshMenuQuietly(); }
        if(r.error === 'BAD_OPTION' || r.error === 'OPTION_REQUIRED'){
          // The item's choices changed (e.g. the shop made Hot or iced required): fetch the menu,
          // then show the cart again with "Choose again" on the lines that need it.
          const text = err.textContent;
          await refreshMenuQuietly();
          if($('#c-place')){
            openCartSheet();
            $('#c-err').textContent = S.cart.some(lineNeedsChoice) ? 'Some choices changed. Tap "Choose again" on the marked item.' : text;
          }
        }
        if(r.error === 'REGISTER_FIRST'){ S.customer = null; closeSheet(); render(); }
        if(r.error === 'SHOP_CLOSED'){
          // The last shift closed while they were ordering: show the closed screen. The cart
          // is NOT cleared (it stays saved on this phone for when the shop opens).
          S.menu.is_open = false; S.menu.items = [];
          closeSheet(); window.scrollTo({top: 0}); render();
          toast(MSG.SHOP_CLOSED);
        }
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
  function refreshMenuQuietly(){ return checkMenu(); }

  // "I've ordered here before". prefill = {phone, nickname} when we come from a PHONE_TAKEN answer.
  function openRelinkSheet(prefill){
    prefill = prefill || {};
    const filled = !!prefill.phone;
    openSheet('Welcome back', `
      <p class="sheet-desc lead">${filled
        ? 'Check the name: use the same one you gave us before. We\'ll connect this phone to your visits.'
        : 'Enter the mobile number and the name you used before. We\'ll connect this phone to your visits.'}</p>
      <div class="field"><label for="r-phone">Mobile number</label><input class="input" id="r-phone" inputmode="tel" autocomplete="tel" placeholder="0917 123 4567"></div>
      <div class="field"><label for="r-name">Name or nickname you used</label><input class="input" id="r-name" maxlength="30" autocomplete="nickname"></div>
      <div class="form-error" id="r-err" role="alert"></div>
      ${filled ? '' : '<p class="sheet-desc small">Didn\'t give us a number before? Just start fresh, and ask our staff to join your old visits to the new name.</p>'}`,
      `<button class="btn btn-main" id="r-go">Connect this phone</button>`, () => {
        if(prefill.phone) $('#r-phone').value = prefill.phone;
        if(prefill.nickname) $('#r-name').value = prefill.nickname;
        if(filled) (prefill.nickname ? $('#r-go') : $('#r-name')).focus();
        $('#r-go').onclick = async () => {
          const btn = $('#r-go'), err = $('#r-err');
          btn.disabled = true; err.textContent = '';
          if(S.signIn && !(await signedIn())){
            err.textContent = S.signInErr + ' Close this and tap "Try again".'; btn.disabled = false; return;
          }
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
    openSheet(`Not ${name}?`, `<p class="sheet-desc">This phone will forget ${esc(name)}. You can then enter your own name. ${esc(name)}'s visits are kept safe.</p>`,
      `<div class="btn-row"><button class="btn btn-quiet" id="nm-cancel">Keep ${esc(name)}</button><button class="btn btn-main" id="nm-go">Use my name</button></div>`, () => {
        $('#nm-cancel').onclick = closeSheet;
        $('#nm-go').onclick = async () => {
          $('#nm-go').disabled = true;
          try{ await cloud.rpc('qr_forget_device', {p_token: token}); }catch(e){}
          await cloud.signOut();
          // With the person check on, show the name screen first: the check's box lives there.
          const later = captchaOn();
          if(!later){ try{ await cloud.signInAnonymously(); }catch(e){ S.canOrder = false; S.blockedReason = errText(e); } }
          S.customer = null; S.orders = []; S.cart = []; saveCart(); S.view = 'menu';
          closeSheet(); render();
          if(later) beginSignIn();
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
    // Ticket colour by stage (A2): received = butter, being prepared = olive, ready = sage.
    const stage = {PENDING: 'pending', PREPARING: 'preparing', READY: 'ready'}[o.status] || 'plain';
    $('#t-ticket').className = 'ticket stage-' + stage;
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
      {b: 'Ready', s: 'Pick it up at the counter'},   // every order, dine-in too (A5)
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
          : `<ol class="steps">${steps.map((s, i) => `<li class="step ${stepState(i + 1)}"><span class="dot">${stepState(i + 1) === 'done' ? ico('check', {size: 16}) : i + 1}</span><div><b>${s.b}</b><span>${s.s}</span></div></li>`).join('')}</ol>`}
        <div class="ticket-pay${payClass}"><span>${payText}</span><b>${money(o.total)}</b></div>
        <ul class="ticket-items">${(o.items || []).map(it => `<li><span>${it.quantity}× ${esc(it.name)}${(it.modifiers || []).length ? `<br><span class="mods">${esc(it.modifiers.map(m => m.label).join(', '))}</span>` : ''}</span><span>${money(it.line_total)}</span></li>`).join('')}</ul>`;
  }

  function phoneCardHtml(o){
    const bad = o.status === 'REJECTED' || o.status === 'CANCELLED';
    if(bad || !S.customer || S.customer.phone_hint) return '';
    return `<div class="card-quiet" id="phone-card"><h4>Keep your visits</h4>
      <p>Add your number so you keep your stamps if you change phones.</p>
      <div class="inline-form"><input class="input" id="pc-phone" inputmode="tel" autocomplete="tel" placeholder="0917 123 4567" aria-label="Mobile number"><button class="btn btn-main" id="pc-save">Save</button></div>
      <div class="form-error err-after" id="pc-err" role="alert"></div>
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
    const more = !isOpen() ? 'Back' : (bad ? 'Back to the menu' : 'Order something else');
    return `<button class="btn btn-main" id="order-more">${more}</button>
      ${o.status === 'PENDING' ? '<button class="btn btn-quiet" id="cancel-order">Cancel this order</button>' : ''}
      ${alert ? `<div class="inline-alert" role="alert">${esc(alert)}</div>` : ''}`;
  }
  function wireTicketActions(){
    $('#order-more').onclick = () => { S.view = 'menu'; render(); window.scrollTo({top: 0}); };
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
