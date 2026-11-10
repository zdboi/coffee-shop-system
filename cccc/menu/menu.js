/* =====================================================================
   PUBLIC MENU LINK (release 1.4.1, B10; tabs + swipe panels 1.4.2)
   Opened from a shared link: .../cccc/menu/?shop=<code>   (default code: cccc)
   - View only: no ordering, no sign-in, no customer data.
   - One call to public_menu(p_shop) with the public anon key and NO login
     (the client below never signs in, so no anonymous user is ever made).
   - Prices come from the database; this page only shows them.
   - The last menu is kept on the phone so it shows at once next time, then
     it is refreshed. No polling: it loads again only when reopened.
   ===================================================================== */
(function(){
  'use strict';
  // A client with its own storage key that nothing ever writes a login to:
  // every request goes out with just the public anon key.
  const cloud = Cloud.createClient({storageKey: 'cccc.menu.public'});
  const params = new URLSearchParams(location.search);
  const rawShop = String(params.get('shop') == null ? 'cccc' : params.get('shop')).trim().toLowerCase() || 'cccc';
  const shopOk = /^[a-z0-9][a-z0-9-]{0,39}$/.test(rawShop);
  const CACHE_KEY = 'cccc.menu.cache.' + (shopOk ? rawShop : 'x');
  const REFRESH_AFTER_MS = 60 * 1000;   // reopened after a minute away → fetch again

  const S = {menu: null, loadedAt: 0, hiddenAt: 0, loading: false, stale: false,
    cats: [], active: 0, activeName: null, liveTab: 0, lock: null};   // tabs (1.4.2)
  const $ = (sel, root) => (root || document).querySelector(sel);

  /* ---------------- helpers ---------------- */
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function ico(name, size){ try{ return typeof window.icon === 'function' ? window.icon(name, {size}) : ''; }catch(e){ return ''; } }
  // ₱120, ₱120.50 (whole pesos without .00, like the mock)
  function peso(n){
    const v = Number(n) || 0;
    return '₱' + v.toLocaleString('en-PH', {minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2});
  }
  function delta(n){
    const v = Number(n) || 0;
    if(v > 0) return ' +' + peso(v);
    if(v < 0) return ' −' + peso(-v);
    return '';
  }
  // Only http(s) links go into href/src (the database already checks; this is a second guard).
  function safeUrl(u){
    const s = typeof u === 'string' ? u.trim() : '';
    return /^https?:\/\/[^\s"'<>`\\]+$/i.test(s) ? s : '';
  }
  function reducedMotion(){ try{ return matchMedia('(prefers-reduced-motion: reduce)').matches; }catch(e){ return false; } }

  /* ---------------- theme (same rules as the QR page) ---------------- */
  const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
  function hexMix(hex, toward, pct){
    let h = hex.slice(1); if(h.length === 3) h = h.split('').map(c => c + c).join('');
    const n = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
    return '#' + n.map(v => Math.round(v + (toward - v) * pct / 100).toString(16).padStart(2, '0')).join('');
  }
  function isCustom(menu){ return !!(menu && menu.theme && String(menu.theme.theme || '').toUpperCase() === 'CUSTOM'); }
  function applyTheme(menu){
    const t = (menu && menu.theme) || {};
    const custom = isCustom(menu);
    const root = document.documentElement.style;
    ['--cc-terracotta','--cc-terracotta-deep','--cc-terracotta-tint','--cc-butter','--cc-paper','--cc-cream','--cc-card','--cc-ink']
      .forEach(v => root.removeProperty(v));
    const ok = (v) => typeof v === 'string' && HEX.test(v);
    if(custom){
      if(ok(t.secondary_color)){
        root.setProperty('--cc-terracotta', t.secondary_color);
        root.setProperty('--cc-terracotta-deep', hexMix(t.secondary_color, 0, 22));
        root.setProperty('--cc-terracotta-tint', hexMix(t.secondary_color, 255, 85));
      }
      if(ok(t.accent_color)) root.setProperty('--cc-butter', t.accent_color);
      if(ok(t.background_color)){ root.setProperty('--cc-paper', t.background_color); root.setProperty('--cc-cream', hexMix(t.background_color, 0, 4)); }
      if(ok(t.card_color)) root.setProperty('--cc-card', t.card_color);
      if(ok(t.text_color)) root.setProperty('--cc-ink', t.text_color);
    }
    const meta = document.querySelector('meta[name="theme-color"]');
    if(meta) meta.setAttribute('content', custom && ok(t.secondary_color) ? t.secondary_color : '#B5432B');

    const shop = (menu && menu.shop) || {};
    const name = String(shop.name || '').trim() || 'Cavite City Coffee Club';
    if(custom){
      const logo = safeUrl(shop.logo_url);
      $('#brand-logo').innerHTML = logo ? `<img src="${esc(logo)}" alt="" width="60" height="60" decoding="async">` : '';
      $('#brand-logo').hidden = !logo;
      $('#brand-name').innerHTML = `<span class="brand-name-text">${esc(name)}</span>`;
    }else{
      $('#brand-logo').hidden = false;
      $('#brand-logo').innerHTML = `<img src="../shared/brand/tile-icon-192.webp" alt="" width="60" height="60" decoding="async">`;
      $('#brand-name').innerHTML = `<img class="brand-wordmark" src="../shared/brand/wordmark-terracotta.webp" alt="${esc(name)}" width="142" height="60" decoding="async">`;
    }
    document.title = name + ' — Menu';
  }

  /* ---------------- sub-categories: order + colour squares ---------------- */
  const TILE_KEYS = {terracotta: 1, deep_terracotta: 1, olive: 1, ink: 1, cocoa: 1, gold: 1, butter: 1, sage: 1, clay: 1, sky: 1};
  const LIGHT_KEYS = {gold: 1, butter: 1, sage: 1, clay: 1, sky: 1};
  function norm(x){ return String(x).trim().replace(/\s+/g, ' ').toLowerCase(); }
  function tileKeyFor(name){
    const map = S.menu && S.menu.subcategory_colors;
    if(!map || typeof map !== 'object' || Array.isArray(map) || name == null) return null;
    const good = (k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(TILE_KEYS, k) ? k : null;
    if(Object.prototype.hasOwnProperty.call(map, name)) return good(map[name]);
    const hit = Object.keys(map).find(k => norm(k) === norm(name));
    return hit === undefined ? null : good(map[hit]);
  }
  function squareHtml(name){
    const k = tileKeyFor(name);
    const style = k ? ` style="--sq:var(--tile-${k}-bg)"` : '';
    return `<span class="sq${k && LIGHT_KEYS[k] ? ' sq-light' : ''}"${style} aria-hidden="true"></span>`;
  }
  function orderedCategories(items){
    const cats = [], types = {};
    items.forEach(i => {
      const c = String(i.category == null ? '' : i.category) || 'Menu';
      if(!cats.includes(c)){ cats.push(c); types[c] = i.recipe_type; }
    });
    if(typeof window.sortSubcategoryNames !== 'function') return {cats, types};
    try{ return {cats: sortSubcategoryNames(cats, (n) => types[n], S.menu.subcategory_order), types}; }
    catch(e){ return {cats, types}; }
  }
  function catOf(it){ return String(it.category == null ? '' : it.category) || 'Menu'; }

  /* ---------------- option prices, e.g. "12oz · 16oz +₱20" ---------------- */
  const MAX_GROUP_LINES = 3, MAX_OPTS_PER_LINE = 6;
  function optionLines(it){
    const groups = Array.isArray(it.options) ? it.options : [];
    const lines = [];
    groups.forEach(g => {
      const opts = (g && Array.isArray(g.options)) ? g.options : [];
      if(!opts.length) return;
      // Free choices are only worth listing when the group has a priced one too (sizes),
      // or when it is a short required pick (Hot · Iced). Long free lists are left out.
      const priced = opts.filter(o => Number(o.price_delta));
      const show = priced.length ? opts : (g.required && opts.length <= 4 ? opts : []);
      if(!show.length) return;
      const parts = show.slice(0, MAX_OPTS_PER_LINE).map(o => esc(o.label) + esc(delta(o.price_delta)));
      if(show.length > MAX_OPTS_PER_LINE) parts.push(`${show.length - MAX_OPTS_PER_LINE} more`);
      lines.push(parts.join(' · '));
    });
    if(lines.length > MAX_GROUP_LINES){
      const more = lines.length - MAX_GROUP_LINES;
      lines.length = MAX_GROUP_LINES;
      lines.push(`More options at the counter (${more})`);
    }
    return lines;
  }

  /* ---------------- pieces ---------------- */
  function photoHtml(url, cls){
    const src = safeUrl(url);
    if(src) return `<span class="${cls}"><img src="${esc(src)}" alt="" loading="lazy" decoding="async"></span>`;
    return `<span class="${cls} nophoto" aria-hidden="true">${ico('cup', 28)}</span>`;
  }
  function soldBadge(){ return `<span class="sold-badge">Sold out today</span>`; }

  function listCard(it, idx){
    const off = !!it.sold_out;
    const lines = off ? [] : optionLines(it);
    return `<article class="card${off ? ' off' : ''}" id="item-${idx}">
      ${photoHtml(it.image_url, 'thumb')}
      <div class="card-body">
        <div class="card-top"><h3 class="iname">${esc(it.name)}</h3><span class="iprice">${esc(peso(it.price))}</span></div>
        ${it.description && !off ? `<p class="idesc">${esc(it.description)}</p>` : ''}
        ${lines.map(l => `<p class="iopts">${l}</p>`).join('')}
        ${off ? soldBadge() : ''}
      </div>
    </article>`;
  }
  function gridCard(it, idx){
    const off = !!it.sold_out;
    const lines = off ? [] : optionLines(it).slice(0, 2);
    return `<article class="gcard${off ? ' off' : ''}" id="item-${idx}">
      ${photoHtml(it.image_url, 'gphoto')}
      <h3 class="iname">${esc(it.name)}</h3>
      ${lines.map(l => `<p class="iopts">${l}</p>`).join('')}
      <span class="iprice">${esc(peso(it.price))}</span>
      ${off ? soldBadge() : ''}
    </article>`;
  }
  function highlightHtml(m){
    const h = m.highlight;
    if(!h || typeof h !== 'object' || !h.name) return '';
    const idx = Number.isInteger(h.item_index) && m.items[h.item_index] ? h.item_index : -1;
    const off = !!h.sold_out;
    const label = String(h.label || '').trim() || 'Today\'s pick';
    const src = safeUrl(h.image_url);
    const photo = src
      ? `<span class="hl-photo"><img src="${esc(src)}" alt="${esc(h.name)}" decoding="async" fetchpriority="high"></span>`
      : `<span class="hl-photo nophoto" aria-hidden="true">${ico('cup', 56)}</span>`;
    const inner = `
      ${photo}
      <span class="hl-body">
        <span class="hl-label">${esc(label)}</span>
        <span class="hl-row"><span class="hl-name disp" role="heading" aria-level="2">${esc(h.name)}</span><span class="hl-price">${esc(peso(h.price))}</span></span>
        ${h.blurb ? `<span class="hl-blurb">${esc(h.blurb)}</span>` : ''}
        ${off ? soldBadge() : ''}
      </span>`;
    return idx >= 0
      ? `<a class="hl${off ? ' off' : ''}" href="#item-${idx}" data-jump="item-${idx}">${inner}</a>`
      : `<div class="hl${off ? ' off' : ''}">${inner}</div>`;
  }
  const PIN = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="9.5" r="2.5" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
  const CLOCK = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7v5l3 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  function visitHtml(v){
    v = v || {};
    const addr = String(v.address || '').trim(), hours = String(v.hours || '').trim();
    const map = safeUrl(v.map_url), fb = safeUrl(v.facebook_url), ig = safeUrl(v.instagram_url);
    if(!addr && !hours && !map && !fb && !ig) return '';
    const ext = (url, cls, text) => `<a class="${cls}" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${text}<span class="sr-only"> (opens in a new tab)</span></a>`;
    const socials = [fb && ext(fb, 'vbtn vbtn-line', 'Facebook'), ig && ext(ig, 'vbtn vbtn-line', 'Instagram')].filter(Boolean);
    return `<section class="visit" aria-labelledby="visit-h">
      <h2 class="disp visit-h" id="visit-h">Visit us</h2>
      ${addr ? `<div class="vrow">${PIN}<p>${esc(addr)}</p></div>` : ''}
      ${hours ? `<div class="vrow">${CLOCK}<p>${esc(hours)}</p></div>` : ''}
      ${map ? ext(map, 'vbtn vbtn-main', 'Open in Maps') : ''}
      ${socials.length ? `<div class="vsocial${socials.length === 1 ? ' one' : ''}">${socials.join('')}</div>` : ''}
    </section>`;
  }
  function priceNote(p){
    p = p || {};
    const tax = Number(p.tax_pct) || 0, sc = Number(p.service_charge_pct) || 0;
    const bits = [];
    if(tax > 0 && !p.tax_inclusive) bits.push(`${tax}% tax`);
    if(sc > 0) bits.push(`a ${sc}% service charge`);
    if(!bits.length) return '';
    return `Prices don't include ${bits.join(' and ')}, added when you pay.`;
  }

  /* ---------------- render ---------------- */
  function render(){
    const m = S.menu;
    applyTheme(m);
    const items = Array.isArray(m.items) ? m.items : [];
    const main = $('#menu-main');
    if(!items.length){
      S.cats = [];
      main.innerHTML = `${staleHtml()}<div class="empty"><h2 class="disp">Menu coming soon</h2><p>We're updating our menu. Drop by the counter to see what's brewing today.</p></div>${visitHtml(m.visit)}${footHtml(m)}`;
      return;
    }
    const {cats, types} = orderedCategories(items);
    const multi = cats.length > 1;
    // Keep the tab the person was on when the menu refreshes (by name; else the same place).
    let active = S.activeName != null ? cats.indexOf(S.activeName) : -1;
    if(active < 0) active = Math.min(Math.max(0, S.active | 0), cats.length - 1);
    S.cats = cats; S.active = active; S.activeName = cats[active]; S.lock = null;

    // Sub-category tabs (1.4.2): under the highlight card, sticky while scrolling; the panels below swipe.
    const tabs = multi ? `<div class="chips" id="chips"><div class="chips-in" role="tablist" aria-label="Menu sections">${cats.map((c, i) =>
      `<button type="button" class="chip" role="tab" id="tab-btn-${i}" aria-controls="sec-${i}" aria-selected="false" tabindex="-1" data-tab="${i}">${esc(c)}</button>`).join('')}</div></div>` : '';
    const panels = cats.map((c, i) => {
      const its = [];
      items.forEach((it, idx) => { if(catOf(it) === c) its.push([it, idx]); });
      const grid = types[c] === 'PASTRY';
      const nav = multi ? `<div class="pnav">
          ${i > 0 ? `<button type="button" class="pbtn prev" data-go="${i - 1}">${CHEV_L}<span><span class="sr-only">Previous: </span>${esc(cats[i - 1])}</span></button>` : ''}
          ${i < cats.length - 1 ? `<button type="button" class="pbtn next" data-go="${i + 1}"><span><span class="sr-only">Next: </span>${esc(cats[i + 1])}</span>${CHEV_R}</button>` : ''}
        </div>` : '';
      return `<section class="sec panel" id="sec-${i}" ${multi ? `role="tabpanel" aria-labelledby="tab-btn-${i}" tabindex="0"` : `aria-labelledby="sec-h-${i}"`}>
        <h2 class="disp sec-h" id="sec-h-${i}">${squareHtml(c)}<span>${esc(c)}</span></h2>
        <div class="${grid ? 'grid' : 'list'}">${its.map(([it, idx]) => grid ? gridCard(it, idx) : listCard(it, idx)).join('')}</div>
        ${nav}
      </section>`;
    }).join('');
    main.innerHTML = `${staleHtml()}${highlightHtml(m)}${tabs}<div class="track${multi ? '' : ' single'}" id="track">${panels}</div>${visitHtml(m.visit)}${footHtml(m)}`;
    setupTrack();
  }
  const CHEV_L = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const CHEV_R = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  function staleHtml(){
    if(!S.stale) return '';
    return `<div class="stale" role="status">${ico('wifi-off', 18)}<span>Showing the menu we saved earlier. We couldn't reach the shop just now.</span><button type="button" class="retry" data-retry>Try again</button></div>`;
  }
  function footHtml(m){
    const note = priceNote(m.pricing);
    // truncated: the database sends at most 300 items; the rest are on the counter's menu.
    const more = m.truncated === true ? `<p class="foot foot-more">Some items aren't shown here — ask us at the counter.</p>` : '';
    return `${more}<p class="foot">Order and pay at the counter, or scan the QR code on your table.<br>${note ? esc(note) + '<br>' : ''}Prices may change; this menu updates live.</p>`;
  }
  function renderNotFound(){
    applyTheme(null);
    S.cats = [];
    $('#menu-main').innerHTML = `<div class="empty">
      <h2 class="disp">This menu isn't available right now</h2>
      <p>The link may be old, or the shop has paused it for now. Please ask our staff, or try again later. Salamat!</p>
    </div>`;
  }
  function renderOffline(){
    S.cats = [];
    $('#menu-main').innerHTML = `<div class="empty">
      <h2 class="disp">We couldn't open the menu</h2>
      <p>Check your internet connection, then try again.</p>
      <button type="button" class="vbtn vbtn-main retry-big" data-retry>Try again</button>
    </div>`;
  }

  /* ---------------- tabs + swipe track (1.4.2) ----------------
     One panel per sub-category in a horizontal scroll-snap track. The track is
     exactly as tall as the active panel, so the PAGE does all vertical scrolling
     (no scroll box inside a scroll box: no iOS scroll traps). Other panels are
     clipped and `inert` until they become active. */
  let resizeObs = null, settleTimer = 0, unlockTimer = 0;
  const HAS_SCROLLEND = 'onscrollend' in window;
  const trackEl = () => document.getElementById('track');
  const panelEls = () => Array.from(document.querySelectorAll('#track > .panel'));
  const isMulti = () => (S.cats || []).length > 1;
  function smooth(){ return reducedMotion() ? 'auto' : 'smooth'; }

  function markTabs(i){
    const all = document.querySelectorAll('#chips .chip');
    all.forEach((c, j) => {
      const on = j === i;
      c.classList.toggle('on', on);
      c.setAttribute('aria-selected', on ? 'true' : 'false');
      c.tabIndex = on ? 0 : -1;
    });
    const on = all[i];
    if(on && on.parentElement){   // bring the active tab into view inside the tab row only
      const row = on.parentElement;
      const left = Math.max(0, on.offsetLeft - (row.clientWidth - on.offsetWidth) / 2);
      try{ row.scrollTo({left, behavior: smooth()}); }catch(e){ row.scrollLeft = left; }
    }
  }
  function sizeTrack(){
    const t = trackEl();
    if(!t) return;
    if(!isMulti()){ t.style.height = ''; return; }
    const p = panelEls()[S.active];
    if(p) t.style.height = p.offsetHeight + 'px';
  }
  function panelLeft(i){ const t = trackEl(); return t ? i * t.clientWidth : 0; }
  function indexAtScroll(){
    const t = trackEl();
    if(!t || !t.clientWidth) return S.active;
    return Math.max(0, Math.min(S.cats.length - 1, Math.round(t.scrollLeft / t.clientWidth)));
  }
  // Scroll the page up to the panel's top if the person had scrolled past it
  // (a short panel after a long one would otherwise leave them in the footer).
  function alignPage(force){
    const t = trackEl();
    if(!t) return;
    const chips = $('#chips');
    const top = Math.max(0, Math.round(t.getBoundingClientRect().top + window.scrollY - (chips ? chips.offsetHeight : 0) - 8));
    if(force || window.scrollY > top) window.scrollTo(0, top);
  }
  function setHash(i, mode){
    const h = '#tab-' + (i + 1);
    if(!mode || location.hash === h) return;
    try{ history[mode === 'push' ? 'pushState' : 'replaceState'](null, '', h); }catch(e){}
  }
  // o: {scroll: 'smooth'|'instant', hash: 'push'|'replace', align: bool}
  function setActive(i, o){
    o = o || {};
    const n = (S.cats || []).length;
    if(!n) return;
    i = Math.max(0, Math.min(n - 1, i | 0));
    S.active = i; S.activeName = S.cats[i];
    if(!isMulti()) return;
    markTabs(i);
    panelEls().forEach((p, j) => { if(j === i) p.removeAttribute('inert'); else p.setAttribute('inert', ''); });
    sizeTrack();
    const t = trackEl();
    if(o.scroll && t){
      const left = panelLeft(i);
      if(Math.abs(t.scrollLeft - left) > 1){
        // While we slide, the tabs we pass over must not light up one by one.
        S.lock = i;
        clearTimeout(unlockTimer);
        unlockTimer = setTimeout(() => { S.lock = null; }, 1200);
        // Slide only to a near panel; a far one (many tabs) is shown at once instead of racing past the rest.
        const near = Math.abs(t.scrollLeft - left) <= 2.5 * t.clientWidth;
        const how = o.scroll === 'smooth' && near ? smooth() : 'auto';
        try{ t.scrollTo({left, behavior: how}); }catch(e){ t.scrollLeft = left; }
      }
    }
    setHash(i, o.hash);
    if(o.align) alignPage(false);
  }
  function settle(){
    clearTimeout(settleTimer);
    if(!isMulti()) return;
    const i = indexAtScroll();
    const locked = S.lock;
    S.lock = null;
    if(locked != null && i !== locked) return;   // a slide we started was interrupted mid-way; the next settle decides
    if(i !== S.active) setActive(i, {hash: 'replace', align: true});
    else markTabs(i);
  }
  function setupTrack(){
    const t = trackEl();
    if(resizeObs){ resizeObs.disconnect(); resizeObs = null; }
    if(!t) return;
    if(!isMulti()){ sizeTrack(); return; }
    t.addEventListener('scroll', () => {
      if(S.lock == null){
        const i = indexAtScroll();
        if(i !== S.liveTab){ S.liveTab = i; markTabs(i); }   // the tab follows the finger
      }
      if(!HAS_SCROLLEND){ clearTimeout(settleTimer); settleTimer = setTimeout(settle, 160); }
    }, {passive: true});
    if(HAS_SCROLLEND) t.addEventListener('scrollend', settle);
    if(typeof ResizeObserver === 'function'){
      resizeObs = new ResizeObserver(() => sizeTrack());
      panelEls().forEach(p => resizeObs.observe(p));
    }
    S.liveTab = S.active;
    setActive(S.active, {scroll: 'instant'});
  }
  function hashTarget(){
    const h = (location.hash || '').slice(1);
    let m = /^tab-(\d{1,4})$/.exec(h);
    if(m) return {tab: Number(m[1]) - 1};
    m = /^sec-(\d{1,4})$/.exec(h);                 // links shared before 1.4.2
    if(m) return {tab: Number(m[1])};
    if(/^item-\d{1,5}$/.test(h)) return {item: h};
    return null;
  }

  /* ---------------- data ---------------- */
  function readCache(){
    try{
      const c = JSON.parse(localStorage.getItem(CACHE_KEY));
      return c && c.data && Array.isArray(c.data.items) ? c : null;
    }catch(e){ return null; }
  }
  function writeCache(data){
    try{ localStorage.setItem(CACHE_KEY, JSON.stringify({at: Date.now(), data})); }catch(e){ /* storage full or private mode */ }
  }
  function dropCache(){ try{ localStorage.removeItem(CACHE_KEY); }catch(e){} }

  async function load(){
    if(S.loading) return;
    if(!shopOk){ renderNotFound(); return; }
    S.loading = true;
    try{
      const data = await cloud.rpc('public_menu', {p_shop: rawShop});
      S.loadedAt = Date.now();
      if(!data || typeof data !== 'object' || data.error || !Array.isArray(data.items)){
        S.menu = null; dropCache(); renderNotFound(); return;
      }
      const keepY = window.scrollY;
      const hadMenu = !!S.menu;
      S.menu = data; S.stale = false;
      writeCache(data);
      render();
      if(hadMenu) window.scrollTo(0, keepY);
      else jumpToHash();
    }catch(e){
      if(S.menu){ S.stale = true; render(); }
      else renderOffline();
    }finally{
      S.loading = false;
    }
  }

  // Opened from a shared link (#tab-3) or the back button: show that tab.
  function jumpToHash(fromHistory){
    const h = hashTarget();
    if(!(S.cats || []).length) return;
    if(!h){   // back to the plain link: first tab
      if(fromHistory){ setActive(0, {scroll: 'instant'}); alignPage(false); }
      return;
    }
    if(h.item){ jumpToItem(h.item, {instant: true, flash: false, hash: false}); return; }
    if(h.tab < 0 || h.tab >= S.cats.length) return;
    setActive(h.tab, {scroll: 'instant'});
    alignPage(!fromHistory);
  }
  // Highlight card → its sub-category tab, then the item itself (with a short glow).
  function jumpToItem(id, o){
    const t = document.getElementById(id);
    if(!t) return false;
    const p = t.closest('.panel');
    const i = panelEls().indexOf(p);
    if(i >= 0) setActive(i, {scroll: 'instant', hash: o.hash ? 'replace' : null});
    const chips = $('#chips');
    const top = Math.max(0, t.getBoundingClientRect().top + window.scrollY - (chips ? chips.offsetHeight : 0) - 14);
    try{ window.scrollTo({top, behavior: o.instant ? 'auto' : smooth()}); }catch(e){ window.scrollTo(0, top); }
    // Move keyboard focus with the jump (without a second scroll).
    if(!t.hasAttribute('tabindex')) t.setAttribute('tabindex', '-1');
    try{ t.focus({preventScroll: true}); }catch(err){ t.focus(); }
    if(o.flash){ t.classList.remove('flash'); void t.offsetWidth; t.classList.add('flash'); }
    return true;
  }

  /* ---------------- events ---------------- */
  document.addEventListener('click', (e) => {
    const r = e.target.closest('[data-retry]');
    if(r){ e.preventDefault(); load(); return; }
    const tab = e.target.closest('#chips [data-tab]');
    if(tab){
      const i = Number(tab.getAttribute('data-tab'));
      setActive(i, {scroll: 'smooth', hash: i === S.active ? null : 'push', align: true});
      return;
    }
    const go = e.target.closest('[data-go]');
    if(go){
      const i = Number(go.getAttribute('data-go'));
      setActive(i, {scroll: 'smooth', hash: 'push', align: true});
      const p = panelEls()[S.active];   // the button's own panel is now inert: keep focus somewhere useful
      if(p){ try{ p.focus({preventScroll: true}); }catch(err){} }
      return;
    }
    const j = e.target.closest('[data-jump]');
    if(j){
      if(jumpToItem(j.getAttribute('data-jump'), {instant: false, flash: true, hash: true})) e.preventDefault();
    }
  });
  // Tabs keyboard: ← → move between tabs (and show that panel), Home / End jump to the ends.
  document.addEventListener('keydown', (e) => {
    const tab = e.target.closest && e.target.closest('#chips [data-tab]');
    if(!tab || e.altKey || e.ctrlKey || e.metaKey) return;
    const n = (S.cats || []).length;
    const cur = Number(tab.getAttribute('data-tab'));
    let i = null;
    if(e.key === 'ArrowRight') i = (cur + 1) % n;
    else if(e.key === 'ArrowLeft') i = (cur - 1 + n) % n;
    else if(e.key === 'Home') i = 0;
    else if(e.key === 'End') i = n - 1;
    if(i == null) return;
    e.preventDefault();
    setActive(i, {scroll: 'smooth', hash: 'replace', align: true});
    const b = document.getElementById('tab-btn-' + i);
    if(b) b.focus();
  });
  window.addEventListener('popstate', () => jumpToHash(true));
  window.addEventListener('hashchange', () => jumpToHash(true));
  window.addEventListener('resize', () => {
    // Width changed (rotation): put the active panel back in place and re-measure.
    const t = trackEl();
    if(!t || !isMulti()) return;
    S.lock = S.active;
    t.scrollLeft = panelLeft(S.active);
    sizeTrack();
    clearTimeout(unlockTimer);
    unlockTimer = setTimeout(() => { S.lock = null; }, 200);
  });
  // A photo that fails to load turns into the no-photo tile.
  document.addEventListener('error', (e) => {
    const img = e.target;
    if(!img || img.tagName !== 'IMG') return;
    const box = img.parentElement;
    if(box && /\b(thumb|gphoto|hl-photo)\b/.test(box.className)){
      box.classList.add('nophoto'); box.setAttribute('aria-hidden', 'true');
      box.innerHTML = ico('cup', box.classList.contains('hl-photo') ? 56 : 28);
    }else if(box && box.id === 'brand-logo'){ box.hidden = true; }
  }, true);
  // Reopened (tab switched back, or back/forward cache): refresh once, no polling.
  document.addEventListener('visibilitychange', () => {
    if(document.visibilityState === 'hidden'){ S.hiddenAt = Date.now(); return; }
    if(S.hiddenAt && Date.now() - S.hiddenAt > REFRESH_AFTER_MS) load();
  });
  window.addEventListener('pageshow', (e) => { if(e.persisted && Date.now() - S.loadedAt > REFRESH_AFTER_MS) load(); });

  /* ---------------- start ---------------- */
  if(shopOk){
    const cached = readCache();
    if(cached){ S.menu = cached.data; render(); jumpToHash(); }
  }
  load();
})();
