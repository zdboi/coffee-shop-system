/* Back Office — Settings → Menu link (release 1.4.1, B10)
   A view-only menu page anyone can open from a link (cccc/menu/). Here the owner:
   - switches the link on or off (settings.menu_public, off by default),
   - sees, copies and opens the link (built from settings.public_code),
   - can change the shop code (advanced: old links stop working),
   - fills the public "Visit us" box (address, hours, map, Facebook, Instagram),
   - picks one highlighted item with a label and a short text.
   All of it is saved with ONE Ops.update('settings', …) through apply_changes; the database
   checks every field again (011) and its error codes are put in plain words below. */

// The public site address: every menu link starts with this (one place to change it).
const MENU_SITE_BASE = 'https://zdboi.github.io/coffee-shop-system/';
// The shop that owns the short link (/menu/ at the site root, with the social preview tags).
const MENU_SHORT_LINK_CODE = 'cccc';
const MENU_LINK_KEYS = ['menu_public', 'public_code', 'public_address', 'public_hours', 'public_map_url',
  'public_facebook_url', 'public_instagram_url', 'menu_highlight_recipe_id', 'menu_highlight_label', 'menu_highlight_blurb'];
// Brought in from a Back Office backup (bo-import.js). The on/off switch, the shop code and the
// highlighted item are left out on purpose: a file never switches a public link on, never takes
// another shop's code, and never points at an item that may not exist in this shop.
const MENU_IMPORT_KEYS = ['public_address', 'public_hours', 'public_map_url', 'public_facebook_url', 'public_instagram_url',
  'menu_highlight_label', 'menu_highlight_blurb'];
const MENU_DEFAULT_LABEL = "Today's pick";
const MENU_CODE_RE = /^[a-z0-9][a-z0-9-]{0,28}[a-z0-9]$/;
const MENU_FB_HOSTS = ['facebook.com', 'www.facebook.com', 'm.facebook.com', 'web.facebook.com', 'fb.com', 'www.fb.com', 'fb.me'];
const MENU_IG_HOSTS = ['instagram.com', 'www.instagram.com'];

// The database's answers for this screen, in plain words (011). Listed for the lead so they can
// also go into the shared ERROR_TEXT (ui.js); until then this screen uses its own copy.
const MENU_ERROR_TEXT = {
  MENU_CODE_NEEDED: 'The menu link needs a shop code before it can be switched on. Enter one under "Shop code".',
  BAD_PUBLIC_CODE: 'The shop code can only use small letters (a–z), numbers and "-", 2 to 30 characters, and can\'t start or end with "-".',
  PUBLIC_CODE_TAKEN: 'Another shop already uses that shop code. Choose a different one.',
  BAD_PUBLIC_ADDRESS: 'The address is too long (200 characters at most) or has characters that can\'t be shown.',
  BAD_PUBLIC_HOURS: 'The opening hours are too long (300 characters at most) or have characters that can\'t be shown.',
  BAD_MAP_URL: 'The Google Maps link must be a full web address starting with https://, without spaces.',
  BAD_FACEBOOK_URL: 'The Facebook link must be a facebook.com (or fb.com / fb.me) address starting with https://.',
  BAD_INSTAGRAM_URL: 'The Instagram link must be an instagram.com address starting with https://.',
  BAD_HIGHLIGHT: 'That item can\'t be highlighted: it must be active, shown on the counter and on the QR menu, and have a price. Pick another item or clear it.',
  BAD_HIGHLIGHT_LABEL: 'The highlight label can be at most 30 characters.',
  BAD_HIGHLIGHT_BLURB: 'The highlight text can be at most 140 characters.',
};
function menuFriendlyError(e){
  const raw = typeof e === 'string' ? e : String((e && (e.message || e.error)) || '');
  const code = (e && e.code && MENU_ERROR_TEXT[e.code]) ? e.code : errorCode(raw);
  if(code && MENU_ERROR_TEXT[code]) return MENU_ERROR_TEXT[code];
  // apply_changes refuses an item id of another shop with FORBIDDEN_ROW: here only the highlight can do that
  if(code === 'FORBIDDEN_ROW') return MENU_ERROR_TEXT.BAD_HIGHLIGHT;
  return friendlyError(e);
}

// The link for a saved code ('' when there is no code yet).
function menuLinkFor(code){
  code = String(code || '').trim().toLowerCase();
  if(!code) return '';
  if(code === MENU_SHORT_LINK_CODE) return MENU_SITE_BASE + 'menu/';
  return MENU_SITE_BASE + 'cccc/menu/?shop=' + encodeURIComponent(code);
}
// Items the menu page can show (same rule as the database: active, on the counter, on QR, priced).
function menuEligible(r){
  return !!r && r.active !== false && r.pos_visible !== false && r.qr_visible !== false && num(r.selling_price) > 0;
}
function menuItems(){
  return state.recipes.filter(menuEligible).sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
}
// A link typed by the owner, tidied: spaces trimmed, "https://" added when left out, http -> https.
function menuTidyUrl(v){
  v = String(v == null ? '' : v).trim();
  if(!v) return '';
  if(/^http:\/\//i.test(v)) v = 'https://' + v.slice(7);
  else if(!/^[a-z][a-z0-9+.-]*:/i.test(v)) v = 'https://' + v.replace(/^\/+/, '');
  return v;
}
// The same check as the database (_valid_public_url): '' = fine, else the error code.
function menuUrlProblem(v, hosts, code){
  if(!v) return '';
  if(v.length > 500 || !/^https:\/\/[^\s"'<>\\`]+$/.test(v)) return code;
  const host = (/^https:\/\/([^/?#]+)/.exec(v) || [])[1] || '';
  if(!/^[A-Za-z0-9.-]+$/.test(host)) return code;
  if(hosts && !hosts.includes(host.toLowerCase())) return code;
  return '';
}
function menuTextProblem(v, max, code){
  return v && (v.length > max || /[\x01-\x09\x0B-\x1F\x7F]/.test(v)) ? code : '';
}
// Values from a backup file that this database will accept (bo-import.js). Anything that would be
// refused is left out, so one odd field never stops the rest of the settings coming in.
function menuImportValues(src){
  const out = {};
  if(!src || typeof src !== 'object') return out;
  const str = (k) => typeof src[k] === 'string' ? src[k].trim() : '';
  const addr = str('public_address'), hours = str('public_hours');
  if(addr && !menuTextProblem(addr, 200, 'x')) out.public_address = addr;
  if(hours && !menuTextProblem(hours, 300, 'x')) out.public_hours = hours;
  [['public_map_url', null], ['public_facebook_url', MENU_FB_HOSTS], ['public_instagram_url', MENU_IG_HOSTS]].forEach(([k, hosts]) => {
    const v = str(k);
    if(v && !menuUrlProblem(v, hosts, 'x')) out[k] = v;
  });
  const clean = (v) => v.replace(/[\x00-\x1F\x7F]/g, ' ').trim();
  const label = clean(str('menu_highlight_label')), blurb = clean(str('menu_highlight_blurb'));
  if(label && label.length <= 30) out.menu_highlight_label = label;
  if(blurb && blurb.length <= 140) out.menu_highlight_blurb = blurb;
  return out;
}

function menuLinkHtml(){
  if(!BO.hasMenuLink) return `<div class="card"><h3 style="margin-top:0;">Menu link</h3>
    <p class="hint" style="margin:0;">Sharing your menu with a public link is available after the latest database update is installed.</p></div>`;
  const m = BO.menuLink;
  const link = menuLinkFor(m.public_code);
  const pick = m.menu_highlight_recipe_id ? state.recipes.find(r => r.id === m.menu_highlight_recipe_id) : null;
  return `
    <div class="card ml-card" id="ml-card">
      <h3 style="margin-top:0;">Menu link</h3>
      <p class="hint" style="margin-top:-4px;">A page anyone can open to see your menu, prices and photos — no ordering, no sign-in. It follows your menu and the counters' "sold out" marks.</p>
      <div class="toggle-row"><span><b>Share my menu with a public link</b><br><span class="hint" id="ml-status">${m.menu_public ? 'On: anyone with the link can see your menu.' : 'Off: the link shows "menu not found".'}</span></span>
        <label class="switch"><input type="checkbox" id="ml-on" ${m.menu_public ? 'checked' : ''} aria-label="Share my menu with a public link"><span class="slider-tog"></span></label></div>

      <div class="form-row" style="margin-top:14px;"><label for="ml-link">Your menu link</label>
        <div class="ml-link-row">
          <input id="ml-link" readonly value="${esc(link)}" placeholder="Add a shop code first (below)">
          <button class="btn btn-outline btn-sm" type="button" id="ml-copy" ${link ? '' : 'disabled'}>Copy link</button>
          <button class="btn btn-outline btn-sm" type="button" id="ml-open" ${link ? '' : 'disabled'}>Open</button>
        </div>
        <div class="hint">Put it on Facebook, Instagram, Messenger or a printed card.${m.menu_public ? '' : ' Switch the link on and save before you share it.'}</div></div>

      <div class="ml-preview">
        <div class="ml-preview-title">How the link looks when shared</div>
        <div class="ml-og">
          <img src="../shared/brand/menu-link-preview.png" alt="Link picture: Cavite City Coffee Club — Ano ang kape mo today?" loading="lazy" width="1200" height="630">
          <div class="ml-og-text"><span class="ml-og-host">zdboi.github.io</span><b>Cavite City Coffee Club — Menu</b><span>Ano ang kape mo today?</span></div>
        </div>
      </div>

      <details class="ml-adv" id="ml-adv">
        <summary>Shop code (advanced)</summary>
        <div class="form-row" style="margin-top:10px;max-width:360px;"><label for="ml-code">Shop code</label>
          <input id="ml-code" maxlength="30" autocomplete="off" spellcheck="false" value="${esc(m.public_code || '')}" placeholder="e.g. cccc">
          <div class="hint">The short name at the end of your link: small letters, numbers and "-" (2 to 30 characters).</div></div>
        <div class="notice warn" style="margin:0;">If you change the code, links you already shared (posts, printed cards) stop working. Share the new link afterwards.</div>
      </details>

      <h3 class="ml-h">Visit us</h3>
      <p class="hint" style="margin-top:-4px;">Shown in a box on the menu page. Leave a field empty to hide it.</p>
      <div class="form-row"><label for="ml-address">Address</label>
        <textarea id="ml-address" rows="2" maxlength="200" placeholder="e.g. 123 P. Burgos Ave, Caridad, Cavite City">${esc(m.public_address || '')}</textarea>
        <div class="hint">Where customers can find you.${s_receiptAddress() ? ' <a class="linklike" id="ml-use-address">Use my receipt address</a>' : ''}</div></div>
      <div class="form-row"><label for="ml-hours">Opening hours</label>
        <textarea id="ml-hours" rows="3" maxlength="300" placeholder="e.g. Mon–Fri 7am–9pm&#10;Sat–Sun 8am–10pm">${esc(m.public_hours || '')}</textarea>
        <div class="hint">One line per day or group of days.</div></div>
      <div class="form-row"><label for="ml-map">Google Maps link</label>
        <input id="ml-map" type="url" maxlength="500" inputmode="url" value="${esc(m.public_map_url || '')}" placeholder="https://maps.app.goo.gl/…">
        <div class="hint">In Google Maps, find your shop, tap Share, then Copy link and paste it here.</div></div>
      <div class="form-grid">
        <div class="form-row"><label for="ml-fb">Facebook page link</label>
          <input id="ml-fb" type="url" maxlength="500" inputmode="url" value="${esc(m.public_facebook_url || '')}" placeholder="https://www.facebook.com/yourpage">
          <div class="hint">The address of your Facebook page.</div></div>
        <div class="form-row"><label for="ml-ig">Instagram link</label>
          <input id="ml-ig" type="url" maxlength="500" inputmode="url" value="${esc(m.public_instagram_url || '')}" placeholder="https://www.instagram.com/yourshop">
          <div class="hint">The address of your Instagram profile.</div></div>
      </div>

      <h3 class="ml-h">Highlighted item</h3>
      <p class="hint" style="margin-top:-4px;">One item shown as a large card at the top of the menu. If it is sold out, it shows greyed.</p>
      <div id="ml-pick-box"></div>
      <div class="form-row ml-search" style="margin-top:10px;"><label for="ml-search">${pick ? 'Pick a different item' : 'Pick an item'}</label>
        <input id="ml-search" type="search" autocomplete="off" placeholder="Search your menu items" aria-controls="ml-results">
        <div class="ml-results" id="ml-results" role="listbox" aria-label="Menu items"></div>
        <div class="hint">Only items that are active, shown on the counter and on the QR menu, and have a price can be picked.</div></div>
      <div class="form-grid">
        <div class="form-row"><label for="ml-label">Label</label>
          <input id="ml-label" maxlength="30" value="${esc(m.menu_highlight_label || '')}" placeholder="${esc(MENU_DEFAULT_LABEL)}">
          <div class="hint">A few words above the item. Empty = "${esc(MENU_DEFAULT_LABEL)}".</div></div>
        <div class="form-row"><label for="ml-blurb">Short text <span class="text-light" id="ml-blurb-count"></span></label>
          <textarea id="ml-blurb" rows="2" maxlength="140" placeholder="e.g. Our house cold brew with sea-salt cream.">${esc(m.menu_highlight_blurb || '')}</textarea>
          <div class="hint">Optional, up to 140 characters.</div></div>
      </div>

      <div class="field-inline" style="margin-top:6px;"><button class="btn btn-primary" id="ml-save">Save menu link</button></div>
    </div>`;
}
function s_receiptAddress(){ return String(state.settings.business_address || '').trim(); }

function wireMenuLink(root){
  if(!BO.hasMenuLink) return;
  const $ = (id) => root.querySelector('#' + id);
  const m = BO.menuLink;
  let pickId = m.menu_highlight_recipe_id || null;

  const drawPick = () => {
    const box = $('ml-pick-box');
    if(!pickId){ box.innerHTML = `<div class="ml-pick ml-pick-empty">No item highlighted.</div>`; return; }
    const r = state.recipes.find(x => x.id === pickId);
    if(!r){ box.innerHTML = `<div class="ml-pick ml-pick-empty">The highlighted item was deleted. <button class="btn btn-ghost btn-sm" type="button" id="ml-clear">Clear</button></div>`; }
    else {
      const ok = menuEligible(r);
      box.innerHTML = `<div class="ml-pick">
        ${r.image_url ? `<img class="thumb" src="${esc(r.image_url)}" alt="">` : '<span class="thumb ml-nothumb" aria-hidden="true"></span>'}
        <span class="ml-pick-name"><b>${esc(r.name)}</b><span class="text-light">${esc(fmtMoney(r.selling_price))}${r.sold_out ? ' · sold out today' : ''}</span>
          ${ok ? '' : '<span class="ml-pick-warn">Not on the menu link right now (hidden, inactive or without a price), so no item is highlighted.</span>'}</span>
        <button class="btn btn-ghost btn-sm" type="button" id="ml-clear">Clear</button></div>`;
    }
    $('ml-clear').onclick = () => { pickId = null; drawPick(); $('ml-search').focus(); };
  };
  const drawResults = () => {
    const q = $('ml-search').value.trim().toLowerCase();
    const list = $('ml-results');
    if(!q && document.activeElement !== $('ml-search')){ list.innerHTML = ''; return; }
    const all = menuItems();
    const found = all.filter(r => !q || String(r.name || '').toLowerCase().includes(q) || String(r.category || '').toLowerCase().includes(q)).slice(0, 8);
    if(!all.length){ list.innerHTML = `<div class="ml-res-empty">No items can be highlighted yet: an item needs a price and must be shown on the counter and the QR menu.</div>`; return; }
    if(!found.length){ list.innerHTML = `<div class="ml-res-empty">No item matches "${esc(q)}".</div>`; return; }
    list.innerHTML = found.map(r => `<button type="button" class="ml-res" role="option" data-pick="${esc(r.id)}" aria-selected="${r.id === pickId}">
      <span>${esc(r.name)}${r.category ? ` <span class="text-light">· ${esc(r.category)}</span>` : ''}</span><span class="mono">${esc(fmtMoney(r.selling_price))}</span></button>`).join('');
    list.querySelectorAll('[data-pick]').forEach(b => b.onclick = () => {
      pickId = b.dataset.pick; $('ml-search').value = ''; list.innerHTML = ''; drawPick();
    });
  };
  drawPick();
  $('ml-search').oninput = drawResults;
  $('ml-search').onfocus = drawResults;
  $('ml-search').onkeydown = (e) => {
    if(e.key === 'Escape'){ $('ml-search').value = ''; $('ml-results').innerHTML = ''; }
    if(e.key === 'Enter'){ e.preventDefault(); const first = $('ml-results').querySelector('[data-pick]'); if(first) first.click(); }
  };
  // close the list when the owner clicks somewhere else on the card
  $('ml-card').addEventListener('click', (e) => { if(!e.target.closest('.ml-search')) $('ml-results').innerHTML = ''; });

  const blurbCount = () => { $('ml-blurb-count').textContent = `(${$('ml-blurb').value.length}/140)`; };
  $('ml-blurb').oninput = blurbCount; blurbCount();

  const useAddr = $('ml-use-address');
  if(useAddr) useAddr.onclick = async () => {
    const cur = $('ml-address').value.trim(), addr = s_receiptAddress();
    if(cur && cur !== addr && !await confirmDialog('Replace the address you typed with your receipt address?', 'Replace')) return;
    $('ml-address').value = addr.slice(0, 200);
  };
  $('ml-on').onchange = () => {
    const saved = !!m.menu_public, now = $('ml-on').checked;
    $('ml-status').textContent = now === saved ? (saved ? 'On: anyone with the link can see your menu.' : 'Off: the link shows "menu not found".')
      : (now ? 'Will be on after you press "Save menu link".' : 'Will be off after you press "Save menu link".');
  };
  $('ml-copy').onclick = () => menuCopyLink($('ml-link'));
  $('ml-open').onclick = () => { const u = $('ml-link').value; if(u) window.open(u, '_blank', 'noopener'); };

  $('ml-save').onclick = (e) => busy(e.currentTarget, async () => {
    const code = $('ml-code').value.trim().toLowerCase();
    ['ml-map', 'ml-fb', 'ml-ig'].forEach(id => { $(id).value = menuTidyUrl($(id).value); });
    const ch = {
      menu_public: $('ml-on').checked,
      public_code: code || null,
      public_address: $('ml-address').value.trim() || null,
      public_hours: $('ml-hours').value.replace(/\r\n?/g, '\n').trim() || null,
      public_map_url: $('ml-map').value || null,
      public_facebook_url: $('ml-fb').value || null,
      public_instagram_url: $('ml-ig').value || null,
      menu_highlight_recipe_id: pickId || null,
      menu_highlight_label: $('ml-label').value.replace(/[\x00-\x1F\x7F]/g, ' ').trim() || null,
      menu_highlight_blurb: $('ml-blurb').value.replace(/[\x00-\x1F\x7F]/g, ' ').trim() || null,
    };
    // the same checks as the database, so the owner sees the problem before anything is sent
    const problem = (code && !MENU_CODE_RE.test(code) && 'BAD_PUBLIC_CODE')
      || (ch.menu_public && !code && 'MENU_CODE_NEEDED')
      || menuTextProblem(ch.public_address, 200, 'BAD_PUBLIC_ADDRESS')
      || menuTextProblem(ch.public_hours, 300, 'BAD_PUBLIC_HOURS')
      || menuUrlProblem(ch.public_map_url, null, 'BAD_MAP_URL')
      || menuUrlProblem(ch.public_facebook_url, MENU_FB_HOSTS, 'BAD_FACEBOOK_URL')
      || menuUrlProblem(ch.public_instagram_url, MENU_IG_HOSTS, 'BAD_INSTAGRAM_URL')
      || (ch.menu_highlight_label && ch.menu_highlight_label.length > 30 && 'BAD_HIGHLIGHT_LABEL')
      || (ch.menu_highlight_blurb && ch.menu_highlight_blurb.length > 140 && 'BAD_HIGHLIGHT_BLURB')
      || (pickId && pickId !== m.menu_highlight_recipe_id && !menuEligible(state.recipes.find(r => r.id === pickId)) && 'BAD_HIGHLIGHT');
    if(problem){
      if(problem === 'BAD_PUBLIC_CODE' || problem === 'MENU_CODE_NEEDED') $('ml-adv').open = true;
      toast(MENU_ERROR_TEXT[problem], 'error'); return;
    }
    const oldCode = String(m.public_code || '');
    if(oldCode && code !== oldCode){
      const ok = await confirmDialog(code
        ? `Change the shop code from "${esc(oldCode)}" to "${esc(code)}"? Links you already shared stop working; share the new link afterwards.`
        : `Remove the shop code "${esc(oldCode)}"? The menu link stops working until you add a code again.`, 'Change code');
      if(!ok) return;
    }
    ch.updated_at = nowISO();
    const pickName = pickId ? ((state.recipes.find(r => r.id === pickId) || {}).name || '') : '';
    const ops = [Ops.update('settings', ch), Ops.audit('Menu link saved',
      `${ch.menu_public ? 'on' : 'off'}${code ? ' · code ' + code : ' · no code'}${code !== oldCode ? ' (was ' + (oldCode || 'none') + ')' : ''}${pickName ? ' · highlight ' + pickName : ''}`)];
    try{ await applyChanges(ops); }
    catch(err){ console.error('menu link save failed', err); toast(menuFriendlyError(err), 'error'); return; }
    try{ await boLoad(); }catch(err){ console.warn('reload after save failed', err); }
    toast(ch.menu_public ? 'Saved — your menu link is on' : 'Saved — your menu link is off');
    if(state.route === 'settings' && BO_SETTINGS_TAB === 'menu') renderSettings();
  });
}

// Copy the link: the clipboard when the browser allows it, else select the text and copy it,
// else show it in a box to copy by hand.
async function menuCopyLink(input){
  const text = input.value;
  if(!text) return;
  try{
    if(navigator.clipboard && window.isSecureContext){ await navigator.clipboard.writeText(text); toast('Link copied'); return; }
  }catch(e){ /* fall through */ }
  try{
    input.focus(); input.select(); input.setSelectionRange(0, text.length);
    if(document.execCommand && document.execCommand('copy')){ toast('Link copied'); return; }
  }catch(e){ /* fall through */ }
  window.prompt('Copy this link:', text);
}
