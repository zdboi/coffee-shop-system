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
    signIn: null, signInErr: '', signInPromise: null,   // first sign-in with the person check (beginSignIn)
  };

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
        S.customer = r.customer || null;
        await loadOrders();
      }catch(e){ S.canOrder = false; S.blockedReason = errText(e); }
    }
    const openOne = S.orders.find(o => ['PENDING','PREPARING','READY'].includes(o.status));
    if(openOne && params.get('view') !== 'menu'){ S.view = 'order'; S.orderId = openOne.id; }
    render();
    if(signInLater) beginSignIn();
    schedulePoll();
  }

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
    $('#main').innerHTML = `<div class="empty"><h1 class="disp">${esc(title)}</h1><p>${esc(text)}</p>
      ${retry ? '<p><button class="btn btn-main" id="retry">Try again</button></p>' : ''}</div>`;
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
    const d = new Date(c.first_seen_at);
    const since = isNaN(d) ? '' : d.toLocaleDateString('en-PH', {month: 'short', year: 'numeric', timeZone: 'Asia/Manila'});
    const visits = Number(c.visit_count) || 0;
    const meta = [visits ? `${visits} ${visits === 1 ? 'visit' : 'visits'}` : 'New member', since ? `member since ${esc(since)}` : ''].filter(Boolean).join(' · ');
    return `<section class="hello" aria-label="Your visits">
      <h1><span class="member-hello">${S.justRegistered ? 'Welcome to the club,' : 'Welcome back,'}</span> <span class="member-name">${esc(c.nickname)}</span>!</h1>
      <p class="hello-meta"><span>${meta}</span><button class="textlink" id="not-me">Not ${esc(c.nickname)}?</button></p>
    </section>
    ${stampCardHtml(c)}`;
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
      const txt = n === 0 ? `Get your first stamp with today's order. ${left} to ${rewardName(next)}.`
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
    return `<section class="stampcard" id="stamp-card" aria-labelledby="stamp-title">
      <div class="stampcard-head"><h2 class="disp sc-title" id="stamp-title">Stamp card</h2><span class="disp">${cardNo > 1 ? 'Card ' + cardNo : 'Bienvenido!'}</span></div>
      <div class="stampcard-body">
        <div class="stamps" role="img" aria-label="${esc(txt.sr)}">${cells.join('')}</div>
        <p class="stamp-line" aria-hidden="true">${esc(txt.line)}</p>
        <p class="stamp-rule">One stamp for a drink and one for food, each day.</p>
        <ul class="rewards">${(card.milestones || []).map(m => `<li><span>${esc(ord(m.stamp))} stamp: ${esc(m.label || rewardName(m))}</span>${tag(m)}</li>`).join('')}</ul>
      </div>
    </section>`;
  }
  // Stamps change when the shop takes payment: fetch the customer again (quietly).
  async function refreshCustomer(){
    try{
      const r = await cloud.rpc('qr_session', {p_token: token});
      if(r && r.customer){ S.customer = r.customer; render(true); }
    }catch(e){}
  }

  function renderWelcome(){
    // Keep a person check that is still running (its box holds the check's own frame).
    const runningBox = S.signIn === 'pending' ? $('#w-captcha-box') : null;
    $('#main').innerHTML = `
      ${joinCardHtml()}
      <div class="welcome-copy">
        <h1 class="disp">What should we call you?</h1>
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
      <div class="captcha" id="w-captcha" hidden>
        <div class="captcha-box" id="w-captcha-box"></div>
        <div id="w-captcha-fail"></div>
      </div>
      <button class="btn btn-main" id="w-go">Start ordering</button>
      <p class="center"><button class="textlink" id="w-relink">I've ordered here before on another phone</button></p>
      ${menuHtml(true)}`;
    const name = $('#w-name'), preview = $('#w-preview');
    name.oninput = () => {
      const v = name.value.trim();
      preview.textContent = v || 'there';
      preview.classList.toggle('placeholder', !v);
    };
    $('#w-phone').oninput = () => { $('#w-help').innerHTML = ''; };
    $('#w-go').onclick = register;
    $('#w-relink').onclick = () => openRelinkSheet();
    wireMenu();
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
      btn.textContent = 'Start ordering';
      if(!ok){ btn.disabled = false; const retry = $('#w-captcha-retry'); if(retry) retry.focus(); return; }
    }
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
      ${preview ? '<h2 class="disp menu-title">On the menu</h2>' : ''}
      <nav class="cats" aria-label="Menu sections">${cats.map((c, i) => `<button class="cat ${i === 0 ? 'on' : ''}" data-cat="${i}">${esc(c)}</button>`).join('')}</nav>
      ${cats.map((c, i) => `<section class="menu-section" id="cat-${i}"><h2 class="disp">${esc(c)}</h2><div class="items">
        ${items.filter(it => it.category === c).map(it => `
          <button class="item ${it.available ? '' : 'off'}" data-item="${esc(it.id)}" ${(!it.available || preview || !S.canOrder) ? 'aria-disabled="true"' : ''}>
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
      <div class="sheet-head"><h3>${esc(title)}</h3><button class="sheet-close" id="sheet-x" aria-label="Close">${ico('x', {size: 22})}</button></div>
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
      ${it.description ? `<p class="sheet-desc">${esc(it.description)}</p>` : ''}
      ${groups.map(g => `<div class="group" data-group="${esc(g.id)}">
        <div class="group-title"><span>${esc(g.name)}</span><small class="${g.required ? 'req' : ''}">${g.required ? 'Choose 1' : (g.multi_select ? 'Optional · any' : 'Optional')}</small></div>
        <div class="opts">${g.options.map(o => `<button class="opt ${g.multi_select ? 'multi' : ''}" aria-pressed="false" data-g="${esc(g.id)}" data-o="${esc(o.id)}">
          <span class="tick">${ico('check', {size: 14})}</span><span class="opt-label">${esc(o.label)}</span>${Number(o.price_delta) ? `<span class="delta">+${money(o.price_delta)}</span>` : ''}</button>`).join('')}</div></div>`).join('')}
      <div class="field gap-top"><label for="it-note">Special request (optional)</label>
        <input class="input" id="it-note" maxlength="140" placeholder="e.g. less ice"></div>
      <div class="qty"><button id="q-minus" aria-label="One less">${ico('minus', {size: 22})}</button><span id="q-val" aria-live="polite">1</span><button id="q-plus" aria-label="One more">${ico('plus', {size: 22})}</button></div>`;
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
