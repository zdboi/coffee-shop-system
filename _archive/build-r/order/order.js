/* =====================================================================
   QR ORDER PAGE (customers' phones)

   • The menu and prices come from public_menu() — the phone never sees
     costs, recipes or other customers.
   • First visit: the customer enters a nickname (mobile number optional).
     This makes an anonymous login that stays on this phone, so next time
     the page says "Welcome back, Zed!" with no sign-in.
   • Orders go through place_order(), which works out every price itself.
   • Payment happens at the counter.
   ===================================================================== */
(function(){
  'use strict';
  const params = new URLSearchParams(location.search);
  const LAST = 'cccc-order-last';
  let saved = {};
  try{ saved = JSON.parse(localStorage.getItem(LAST)||'{}'); }catch(e){}
  const Q = {
    b: params.get('b') || saved.b || null,
    t: params.get('t') || (params.get('b') ? null : saved.t) || null,
    sb: null, menu: null, customer: null, bag: [], orders: [], cat: null,
    orderType: 'DINE_IN', note: '', pollTimer: null, busy: false,
  };
  const $ = (id)=> document.getElementById(id);
  const esc = (s)=> String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const peso = (n)=> '₱' + (Number(n)||0).toLocaleString('en-PH', {minimumFractionDigits: (Number(n)%1 ? 2 : 0), maximumFractionDigits: 2});
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const bagKey = ()=> `cccc-bag-${Q.b}-${Q.t||''}`;

  /* ---------- small UI helpers ---------- */
  let toastTimer = null;
  function toast(msg, bad){
    const el = $('toast');
    el.textContent = msg; el.className = 'toast' + (bad?' bad':''); el.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(()=> el.hidden = true, 3800);
  }
  function fatal(title, text){
    document.getElementById('page').innerHTML = `<div class="fatal"><h1>${esc(title)}</h1><p>${esc(text)}</p></div>`;
    $('bag-bar').hidden = true;
  }
  function errText(e){
    const m = String((e && (e.message||e.error)) || e || '');
    if(!navigator.onLine || /Failed to fetch|NetworkError|Load failed/i.test(m)) return 'No internet connection. Check your data or Wi-Fi and try again.';
    if(/anonymous/i.test(m)) return 'Ordering by phone is not set up yet. Please order at the counter.';
    return (e && e.message) || 'Something went wrong. Please try again or order at the counter.';
  }
  async function rpc(name, args){
    const {data, error} = await Q.sb.rpc(name, args);
    if(error) throw error;
    return data;
  }

  /* ---------- theme from the shop's branding ---------- */
  function hexOk(h){ return /^#[0-9a-f]{6}$/i.test(String(h||'')); }
  function lum(hex){ const n = parseInt(hex.slice(1),16); const c = [(n>>16)&255,(n>>8)&255,n&255].map(v=>{ v/=255; return v<=0.03928? v/12.92 : Math.pow((v+0.055)/1.055,2.4); }); return 0.2126*c[0]+0.7152*c[1]+0.0722*c[2]; }
  function applyShopTheme(shop){
    const c = (shop && shop.colors) || {};
    const root = document.documentElement.style;
    const set = (v, hex)=>{ if(hexOk(hex)) root.setProperty(v, hex); };
    set('--ink', c.text); set('--paper', c.background); set('--card', c.card);
    set('--brand', c.primary); set('--leaf', c.secondary); set('--amber', c.accent);
    if(hexOk(c.primary)) root.setProperty('--on-brand', lum(c.primary) > 0.45 ? '#1c110a' : '#fbf6ee');
    if(hexOk(c.secondary)) root.setProperty('--on-leaf', lum(c.secondary) > 0.45 ? '#1c110a' : '#ffffff');
    if(hexOk(c.text)){ const n = parseInt(c.text.slice(1),16); const rgb = `${(n>>16)&255},${(n>>8)&255},${n&255}`; root.setProperty('--line', `rgba(${rgb},.13)`); root.setProperty('--soft', `rgba(${rgb},.64)`); }
    const meta = document.querySelector('meta[name="theme-color"]'); if(meta && hexOk(c.background)) meta.content = c.background;
  }

  /* ---------- start ---------- */
  async function init(){
    if(!Q.b || !UUID.test(Q.b)){ fatal('Scan the QR code on your table', 'This page opens from the QR code at the shop.'); return; }
    try{ localStorage.setItem(LAST, JSON.stringify({b:Q.b, t:Q.t})); }catch(e){}
    try{ Q.sb = createSupabase('cccc-customer'); }
    catch(e){ fatal('Can’t load the menu', 'Check your internet connection and reload the page.'); return; }
    let menu;
    try{ menu = await rpc('public_menu', {p_business: Q.b, p_table_code: Q.t}); }
    catch(e){ fatal('Can’t load the menu', errText(e)); return; }
    if(!menu || menu.ok === false){ fatal('Shop not found', 'Please scan the QR code on your table again.'); return; }
    Q.menu = menu;
    if(menu.table && menu.table.kind === 'TAKEAWAY') Q.orderType = 'TAKEAWAY';
    applyShopTheme(menu.shop);
    document.title = `Order — ${menu.shop.name}`;
    try{ Q.bag = JSON.parse(localStorage.getItem(bagKey())||'[]').filter(l=> menu.items.some(i=>i.id===l.recipe_id)); }catch(e){ Q.bag = []; }
    renderHead(); renderNotice(); renderMenu(); renderBagBar();
    const {data:{session}} = await Q.sb.auth.getSession();
    if(session){
      try{ const me = await rpc('customer_me', {p_business: Q.b}); Q.customer = me && me.customer; }catch(e){ /* show join card */ }
    }
    renderMember();
    if(Q.customer) await loadOrders();
    document.addEventListener('visibilitychange', ()=>{ if(document.visibilityState==='visible' && Q.customer) loadOrders(); });
  }

  /* ---------- header & notices ---------- */
  function renderHead(){
    const shop = Q.menu.shop;
    $('shop-head').hidden = false;
    $('shop-name').textContent = shop.name || 'Order';
    if(shop.logo){ $('shop-logo').src = shop.logo; $('shop-logo').hidden = false; }
    const chip = $('table-chip');
    if(Q.menu.table){ chip.textContent = Q.menu.table.label; chip.hidden = false; }
    const fn = $('foot-note');
    fn.textContent = shop.pay_note || 'Please pay at the counter.';
    fn.hidden = false;
  }
  function canOrder(){ return Q.menu.shop.ordering_open && !!Q.menu.table; }
  function renderNotice(){
    const n = $('notice');
    let msg = '';
    if(!Q.menu.shop.ordering_open) msg = Q.menu.shop.closed_message || 'Phone ordering is closed right now. Please order at the counter.';
    else if(Q.menu.table_error || !Q.menu.table) msg = 'This QR code isn’t active. Please ask the staff, or order at the counter.';
    else if(Q.menu.shop.welcome) msg = Q.menu.shop.welcome;
    n.textContent = msg; n.hidden = !msg;
    n.style.borderColor = canOrder() ? 'var(--line)' : 'var(--amber)';
  }

  /* ---------- member (club) card / join ---------- */
  function renderMember(){
    const box = $('member');
    const c = Q.customer;
    if(c){
      const visits = c.visit_count || 0;
      const shown = visits === 0 ? 0 : (visits % 10 === 0 ? 10 : visits % 10);
      const since = new Date(c.member_since).toLocaleDateString('en-PH', {month:'short', year:'numeric'});
      box.innerHTML = `<div class="club-card">
        <div class="hello">${visits ? 'Welcome back,' : 'Welcome,'}</div>
        <div class="name">${esc(c.nickname)}!</div>
        <div class="stamps" aria-label="${visits} visits">${Array.from({length:10}, (_,i)=>`<span class="stamp ${i<shown?'on':''}"></span>`).join('')}</div>
        <div class="club-meta"><span>${visits} visit${visits===1?'':'s'} <span class="muted">· member since ${esc(since)}</span></span><button class="linkish" id="not-me">Not ${esc(c.nickname)}?</button></div>
        ${c.has_phone ? '' : `<div class="phone-ask">Add your mobile number so you keep your visits if you change phones.
          <form id="phone-form"><input id="pa-phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="0917 123 4567" aria-label="Mobile number"><button type="submit">Save</button></form></div>`}
      </div>`;
      $('not-me').onclick = forgetMe;
      const pf = $('phone-form');
      if(pf) pf.onsubmit = async (e)=>{
        e.preventDefault();
        const raw = $('pa-phone').value.trim();
        if(!normalizePhone(raw)){ toast('Please check the mobile number.', true); return; }
        try{
          const res = await rpc('customer_update_me', {p_business: Q.b, p_nickname: null, p_phone: raw});
          if(rpcFailed(res)){ toast(rpcMessage(res), true); return; }
          Q.customer = res.customer; renderMember(); toast('Saved. Your visits are safe if you change phones.');
        }catch(err){ toast(errText(err), true); }
      };
      return;
    }
    box.innerHTML = joinFormHtml('new');
    wireJoinForm('new');
  }
  function joinFormHtml(mode){
    const shop = esc(Q.menu.shop.name || 'the shop');
    if(mode === 'link') return `<div class="join" id="join">
      <h2>Welcome back</h2>
      <p class="lead">Enter the nickname and mobile number you used before.</p>
      <form id="join-form">
        <label class="field"><span>Nickname</span><input id="j-nick" maxlength="30" autocomplete="nickname" required></label>
        <label class="field"><span>Mobile number</span><input id="j-phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="0917 123 4567" required></label>
        <button class="btn btn-main" type="submit">Continue</button>
        <div class="btn-row"><button class="btn btn-quiet" type="button" id="j-switch">I’m new here</button></div>
        <div class="form-msg" id="j-msg" role="status"></div>
      </form></div>`;
    return `<div class="join" id="join">
      <h2>What should we call you?</h2>
      <p class="lead">Your nickname goes on your order so we know who it's for. We'll remember you on this phone next time.</p>
      <form id="join-form">
        <label class="field"><span>Name or nickname</span><input id="j-nick" maxlength="30" autocomplete="nickname" placeholder="e.g. Zed" required></label>
        <label class="field"><span>Mobile number (optional)</span><input id="j-phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="0917 123 4567">
          <small>Add your number so you keep your visits if you change phones.</small></label>
        <label class="consent"><input type="checkbox" id="j-ok"> <span>I agree that ${shop} keeps my nickname (and number, if I give one) to remember my orders and visits.</span></label>
        <button class="btn btn-main" type="submit">Continue</button>
        <div class="btn-row"><button class="btn btn-quiet" type="button" id="j-switch">I’ve been here before</button></div>
        <div class="form-msg" id="j-msg" role="status"></div>
      </form></div>`;
  }
  function wireJoinForm(mode, onDone){
    const form = $('join-form');
    $('j-switch').onclick = ()=>{
      const host = $('join').parentElement;
      host.innerHTML = joinFormHtml(mode === 'new' ? 'link' : 'new');
      wireJoinForm(mode === 'new' ? 'link' : 'new', onDone);
    };
    form.onsubmit = async (e)=>{
      e.preventDefault();
      if(Q.busy) return;
      const msg = $('j-msg'); msg.textContent = '';
      const nick = $('j-nick').value.trim();
      const phone = $('j-phone').value.trim();
      if(!nick){ msg.textContent = 'Please enter a name or nickname.'; return; }
      if(phone && !normalizePhone(phone)){ msg.textContent = 'Please check the mobile number (e.g. 0917 123 4567).'; return; }
      if(mode === 'new' && !$('j-ok').checked){ msg.textContent = 'Please tick the box to continue.'; return; }
      Q.busy = true; form.querySelector('button[type=submit]').disabled = true;
      try{
        const {data:{session}} = await Q.sb.auth.getSession();
        if(!session){ const r = await Q.sb.auth.signInAnonymously(); if(r.error) throw r.error; }
        const res = mode === 'new'
          ? await rpc('customer_register', {p_business: Q.b, p_nickname: nick, p_phone: phone || null, p_consent: true})
          : await rpc('customer_link_phone', {p_business: Q.b, p_nickname: nick, p_phone: phone});
        if(rpcFailed(res)){ msg.textContent = rpcMessage(res); return; }
        Q.customer = res.customer;
        if(onDone){ closeSheet(); onDone(); }
        renderMember();
        await loadOrders();
        toast(mode === 'new' ? `Nice to meet you, ${Q.customer.nickname}!` : `Welcome back, ${Q.customer.nickname}!`);
      }catch(err){ msg.textContent = errText(err); }
      finally{ Q.busy = false; const b = form.querySelector('button[type=submit]'); if(b) b.disabled = false; }
    };
  }
  async function forgetMe(){
    if(!confirm(`Not ${Q.customer.nickname}? This phone will forget that name. (Their visits are kept.)`)) return;
    try{ await rpc('customer_forget_device', {p_business: Q.b}); }catch(e){ /* still forget locally */ }
    Q.customer = null; Q.orders = [];
    renderMember(); renderOrders();
  }

  /* ---------- menu ---------- */
  function categories(){
    const seen = [];
    Q.menu.items.forEach(i=>{ if(!seen.includes(i.category)) seen.push(i.category); });
    return seen;
  }
  function renderMenu(){
    const cats = categories();
    const nav = $('cats');
    if(cats.length > 1){
      nav.hidden = false;
      nav.innerHTML = cats.map((c,i)=>`<button data-cat="${i}" class="${i===0?'on':''}">${esc(c)}</button>`).join('');
      nav.querySelectorAll('button').forEach(b=> b.onclick = ()=>{
        nav.querySelectorAll('button').forEach(x=> x.classList.toggle('on', x===b));
        const h = document.getElementById('cat-'+b.dataset.cat);
        if(h) h.scrollIntoView({behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block:'start'});
      });
    }
    const main = $('menu');
    if(!Q.menu.items.length){ main.innerHTML = `<p class="empty">The menu is being updated. Please order at the counter.</p>`; return; }
    const inBag = (id)=> Q.bag.filter(l=>l.recipe_id===id).reduce((s,l)=>s+l.quantity,0);
    main.innerHTML = cats.map((c,ci)=>`<h2 id="cat-${ci}">${esc(c)}</h2>` + Q.menu.items.filter(i=>i.category===c).map(i=>{
      const n = inBag(i.id);
      return `<button class="item ${i.available?'':'out'}" data-item="${esc(i.id)}" ${i.available?'':'aria-disabled="true"'}>
        <span class="txt"><span class="nm">${esc(i.name)}</span>${n?`<span class="in-bag">${n} in order</span>`:''}
          ${i.description?`<span class="ds">${esc(i.description)}</span>`:''}
          <span class="pr">${peso(i.price)}${(i.modifier_groups||[]).length?'<span style="font-weight:500;color:var(--soft);"> +options</span>':''}${i.available?'':'<span class="out-tag">Sold out</span>'}</span></span>
        ${i.image_url?`<img src="${esc(i.image_url)}" alt="" loading="lazy">`:''}
      </button>`;
    }).join('')).join('');
    main.querySelectorAll('[data-item]').forEach(b=> b.onclick = ()=>{
      const item = Q.menu.items.find(x=>x.id===b.dataset.item);
      if(!item.available){ toast(`${item.name} is sold out right now.`); return; }
      openItemSheet(item);
    });
  }

  /* ---------- sheets ---------- */
  function openSheet(html){
    const s = $('sheet');
    s.innerHTML = `<div class="grab"></div><button class="close" aria-label="Close">✕</button>` + html;
    s.hidden = false; $('sheet-backdrop').hidden = false;
    document.body.style.overflow = 'hidden';
    s.querySelector('.close').onclick = closeSheet;
    $('sheet-backdrop').onclick = closeSheet;
    setTimeout(()=>{ const f = s.querySelector('input,button.opt,.btn'); if(f) f.focus({preventScroll:true}); }, 60);
    return s;
  }
  function closeSheet(){
    $('sheet').hidden = true; $('sheet-backdrop').hidden = true; document.body.style.overflow = '';
  }
  document.addEventListener('keydown', (e)=>{ if(e.key==='Escape' && !$('sheet').hidden) closeSheet(); });

  function openItemSheet(item){
    const groups = item.modifier_groups || [];
    const picks = {}; // groupId -> [optionIds]
    let qty = 1;
    const price = ()=> Number(item.price) + groups.reduce((s,g)=> s + (picks[g.id]||[]).reduce((t,oid)=> t + Number((g.options.find(o=>o.id===oid)||{}).priceDelta||0), 0), 0);
    const s = openSheet(`
      <h3>${esc(item.name)}</h3>
      ${item.image_url?`<img class="hero" src="${esc(item.image_url)}" alt="">`:''}
      ${item.description?`<p class="ds">${esc(item.description)}</p>`:''}
      ${groups.map(g=>`<div class="group" data-group="${esc(g.id)}">
        <div class="group-title">${esc(g.name)} <em class="${g.required?'need':''}">${g.required?'Choose one':(g.multiSelect?'Optional, choose any':'Optional')}</em></div>
        <div class="opts">${g.options.map(o=>`<button type="button" class="opt" aria-pressed="false" data-g="${esc(g.id)}" data-o="${esc(o.id)}">${esc(o.label)}${Number(o.priceDelta)?` <small>${Number(o.priceDelta)>0?'+':''}${peso(o.priceDelta)}</small>`:''}</button>`).join('')}</div>
      </div>`).join('')}
      <label class="field" style="margin-top:18px;"><span>Note for the barista (optional)</span><input id="it-note" maxlength="140" placeholder="e.g. less ice"></label>
      <div class="qty"><button type="button" id="q-minus" aria-label="One less">−</button><output id="q-val">1</output><button type="button" id="q-plus" aria-label="One more">+</button></div>
      <button class="btn btn-main" id="it-add" ${canOrder()?'':'disabled'}></button>
      ${canOrder()?'':`<p class="form-msg" style="text-align:center;">${esc(!Q.menu.shop.ordering_open ? 'Phone ordering is closed right now.' : 'This QR code isn’t active.')}</p>`}`);
    const refresh = ()=>{
      s.querySelectorAll('.opt').forEach(b=> b.setAttribute('aria-pressed', (picks[b.dataset.g]||[]).includes(b.dataset.o) ? 'true' : 'false'));
      $('q-val').textContent = qty;
      $('it-add').textContent = `Add to order · ${peso(price()*qty)}`;
    };
    s.querySelectorAll('.opt').forEach(b=> b.onclick = ()=>{
      const g = groups.find(x=>x.id===b.dataset.g);
      const cur = picks[g.id] || [];
      if(g.multiSelect) picks[g.id] = cur.includes(b.dataset.o) ? cur.filter(x=>x!==b.dataset.o) : cur.concat(b.dataset.o);
      else picks[g.id] = cur.includes(b.dataset.o) && !g.required ? [] : [b.dataset.o];
      refresh();
    });
    $('q-minus').onclick = ()=>{ qty = Math.max(1, qty-1); refresh(); };
    $('q-plus').onclick = ()=>{ qty = Math.min(20, qty+1); refresh(); };
    $('it-add').onclick = ()=>{
      const missing = groups.filter(g=> g.required && !(picks[g.id]||[]).length);
      if(missing.length){ toast(`Please choose ${missing.map(g=>g.name).join(' and ')}.`, true); return; }
      const options = groups.flatMap(g=> (picks[g.id]||[]).map(oid=>({group_id:g.id, option_id:oid})));
      const labels = groups.flatMap(g=> (picks[g.id]||[]).map(oid=> (g.options.find(o=>o.id===oid)||{}).label));
      const note = $('it-note').value.trim();
      const key = item.id + '|' + options.map(o=>o.option_id).sort().join(',') + '|' + note;
      const existing = Q.bag.find(l=>l.key===key);
      if(existing) existing.quantity = Math.min(20, existing.quantity + qty);
      else Q.bag.push({key, recipe_id:item.id, name:item.name, unit:price(), quantity:qty, options, labels, note});
      saveBag(); closeSheet(); renderMenu(); renderBagBar();
      toast(`Added ${qty} × ${item.name}`);
    };
    refresh();
  }

  function saveBag(){ try{ localStorage.setItem(bagKey(), JSON.stringify(Q.bag)); }catch(e){} }
  function bagTotals(){
    const sub = Q.bag.reduce((s,l)=> s + l.unit*l.quantity, 0);
    const shop = Q.menu.shop;
    const tax = shop.tax_inclusive ? 0 : sub * (Number(shop.tax_pct)||0) / 100;
    const svc = sub * (Number(shop.service_charge_pct)||0) / 100;
    return {sub, tax, svc, total: sub + tax + svc, count: Q.bag.reduce((s,l)=>s+l.quantity,0)};
  }
  function renderBagBar(){
    const bar = $('bag-bar');
    const t = bagTotals();
    if(!t.count){ bar.hidden = true; return; }
    bar.hidden = false;
    bar.innerHTML = `<span>View order <span class="count">${t.count}</span></span><span>${peso(t.sub)}</span>`;
    bar.onclick = openBagSheet;
  }
  function openBagSheet(){
    const isTakeawayTable = Q.menu.table && Q.menu.table.kind === 'TAKEAWAY';
    const draw = ()=>{
      const t = bagTotals();
      if(!t.count){ closeSheet(); renderBagBar(); renderMenu(); return; }
      const s = openSheet(`
        <h3>Your order</h3>
        <div>${Q.bag.map((l,i)=>`<div class="bag-line"><div class="txt"><div class="nm">${esc(l.name)}</div>
          ${l.labels.length?`<div class="md">${l.labels.map(esc).join(', ')}</div>`:''}${l.note?`<div class="md">“${esc(l.note)}”</div>`:''}
          <div class="ctl"><button type="button" data-dec="${i}" aria-label="One less">−</button><b>${l.quantity}</b><button type="button" data-inc="${i}" aria-label="One more">+</button></div></div>
          <div class="amt">${peso(l.unit*l.quantity)}</div></div>`).join('')}</div>
        ${isTakeawayTable ? '' : `<div class="seg" role="group" aria-label="Where will you have it?">
          <button type="button" data-type="DINE_IN" aria-pressed="${Q.orderType==='DINE_IN'}">Here at ${esc(Q.menu.table ? Q.menu.table.label : 'the table')}</button>
          <button type="button" data-type="TAKEAWAY" aria-pressed="${Q.orderType==='TAKEAWAY'}">Take-away</button></div>`}
        <label class="field" style="margin-top:12px;"><span>Note for the whole order (optional)</span><input id="b-note" maxlength="300" value="${esc(Q.note)}"></label>
        <div class="totals">
          <div><span>Items</span><span>${peso(t.sub)}</span></div>
          ${t.tax?`<div><span>Tax</span><span>${peso(t.tax)}</span></div>`:''}
          ${t.svc?`<div><span>Service charge</span><span>${peso(t.svc)}</span></div>`:''}
          <div class="grand"><span>Total</span><span>${peso(t.total)}</span></div>
          <small>${esc(Q.menu.shop.pay_note || 'Please pay at the counter.')} The final amount is confirmed there.</small>
        </div>
        <button class="btn btn-main" id="place" ${canOrder()?'':'disabled'}>Place order</button>
        <div class="form-msg" id="place-msg" role="status">${canOrder()?'':esc(!Q.menu.shop.ordering_open ? (Q.menu.shop.closed_message||'Phone ordering is closed right now.') : 'This QR code isn’t active.')}</div>`);
      s.querySelectorAll('[data-dec]').forEach(b=> b.onclick = ()=>{ const l = Q.bag[+b.dataset.dec]; l.quantity--; if(l.quantity<=0) Q.bag.splice(+b.dataset.dec,1); saveBag(); renderBagBar(); draw(); });
      s.querySelectorAll('[data-inc]').forEach(b=> b.onclick = ()=>{ const l = Q.bag[+b.dataset.inc]; l.quantity = Math.min(20, l.quantity+1); saveBag(); renderBagBar(); draw(); });
      s.querySelectorAll('[data-type]').forEach(b=> b.onclick = ()=>{ Q.orderType = b.dataset.type; Q.note = $('b-note').value; draw(); });
      $('b-note').oninput = (e)=>{ Q.note = e.target.value; };
      $('place').onclick = placeOrder;
    };
    draw();
  }

  async function placeOrder(){
    if(Q.busy) return;
    if(!Q.customer){
      // ask for a nickname first, then place the order
      const s = openSheet(`<div id="join-host">${joinFormHtml('new')}</div>`);
      s.querySelector('.join').style.border = 'none'; s.querySelector('.join').style.padding = '0';
      wireJoinForm('new', ()=> setTimeout(placeOrder, 50));
      return;
    }
    Q.busy = true;
    const btn = $('place'); if(btn){ btn.disabled = true; btn.textContent = 'Sending…'; }
    try{
      const items = Q.bag.map(l=>({recipe_id:l.recipe_id, quantity:l.quantity, options:l.options, note:l.note||null}));
      const res = await rpc('place_order', {p_business:Q.b, p_table_code:Q.t, p_order_type:Q.orderType, p_items:items, p_note:Q.note||null});
      if(rpcFailed(res)){
        const m = $('place-msg'); if(m) m.textContent = rpcMessage(res);
        if(res && (res.error==='invalid_item' || res.error==='sold_out' || res.error==='invalid_option')) refreshMenuQuietly();
        return;
      }
      Q.bag = []; Q.note = ''; saveBag();
      closeSheet(); renderBagBar(); renderMenu();
      await loadOrders();
      window.scrollTo({top:0, behavior:'smooth'});
      toast(`Order ${res.order.order_number} sent. We’ll start on it soon.`);
    }catch(e){
      const m = $('place-msg'); if(m) m.textContent = errText(e);
    }finally{
      Q.busy = false;
      const b = $('place'); if(b){ b.disabled = !canOrder(); b.textContent = 'Place order'; }
    }
  }
  async function refreshMenuQuietly(){
    try{
      const menu = await rpc('public_menu', {p_business: Q.b, p_table_code: Q.t});
      if(menu && menu.ok !== false){ Q.menu = menu; Q.bag = Q.bag.filter(l=> menu.items.some(i=>i.id===l.recipe_id && i.available)); saveBag(); renderNotice(); renderMenu(); renderBagBar(); }
    }catch(e){}
  }

  /* ---------- my orders (live status) ---------- */
  const STEP = {NEW:0, ACCEPTED:1, READY:2, COMPLETED:3};
  const STATUS_TEXT = {
    NEW: 'Sent. Waiting for the barista to accept it.',
    ACCEPTED: 'We’re making it now.',
    READY: 'Ready! Please pick it up at the counter.',
    COMPLETED: 'Done. Enjoy!',
    REJECTED: 'Sorry, we couldn’t take this order.',
    CANCELLED: 'Cancelled.',
  };
  async function loadOrders(){
    if(!Q.customer) return;
    try{
      const res = await rpc('my_orders', {p_business: Q.b});
      const before = JSON.stringify((Q.orders||[]).map(o=>[o.id,o.status]));
      Q.orders = (res && res.orders) || [];
      const ready = Q.orders.find(o=> o.status==='READY' && !before.includes(`"${o.id}","READY"`));
      if(ready && before !== '[]' && navigator.vibrate) navigator.vibrate([120,80,120]);
      renderOrders();
    }catch(e){ /* keep showing the last known status */ }
    clearTimeout(Q.pollTimer);
    const open = Q.orders.some(o=> ['NEW','ACCEPTED','READY'].includes(o.status));
    if(open && document.visibilityState === 'visible') Q.pollTimer = setTimeout(loadOrders, 8000);
  }
  function renderOrders(){
    const box = $('my-orders');
    const list = (Q.orders||[]).filter(o=> ['NEW','ACCEPTED','READY'].includes(o.status) || (Date.now() - new Date(o.created_at).getTime() < 3*3600*1000));
    if(!list.length){ box.innerHTML = ''; return; }
    box.innerHTML = list.slice(0,3).map(o=>{
      const step = STEP[o.status];
      const bad = o.status==='REJECTED' || o.status==='CANCELLED';
      return `<div class="ticket ${bad?'bad':''}">
        <div class="ticket-top"><div class="num">${esc(o.order_number)}</div><div class="where">${esc(o.table_label||'')}<br>${o.order_type==='TAKEAWAY'?'Take-away':'Dine-in'} · ${peso(o.subtotal)}</div></div>
        <div class="msg">${esc(STATUS_TEXT[o.status]||o.status)}${o.status_reason && bad ? ` ${esc(o.status_reason)}.` : ''}</div>
        ${bad ? '' : `<ol class="steps">${['Sent','Making','Ready','Done'].map((label,i)=>`<li class="${i<step?'done':i===step?'now':''}">${label}</li>`).join('')}</ol>`}
        <div class="lines">${(o.items||[]).map(i=>`${i.quantity} × ${esc(i.name)}`).join(', ')}</div>
        ${o.status==='NEW'?`<div class="t-actions"><span></span><button class="linkish" data-cancel="${esc(o.id)}">Cancel this order</button></div>`:''}
      </div>`;
    }).join('');
    box.querySelectorAll('[data-cancel]').forEach(b=> b.onclick = async ()=>{
      if(!confirm('Cancel this order?')) return;
      try{
        const res = await rpc('cancel_my_order', {p_business: Q.b, p_order: b.dataset.cancel});
        if(rpcFailed(res)) toast(rpcMessage(res), true); else toast('Order cancelled.');
      }catch(e){ toast(errText(e), true); }
      loadOrders();
    });
  }

  window.addEventListener('DOMContentLoaded', ()=>{ init().catch(e=>{ console.error(e); fatal('Something went wrong', errText(e)); }); });
})();
