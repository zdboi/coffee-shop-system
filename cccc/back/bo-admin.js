/* =====================================================================
   BACK OFFICE — setup: tables & QR codes, staff & PINs, counter devices,
   audit log and settings (general, branding, receipts, QR ordering,
   loyalty).
   ===================================================================== */

/* ================= QR helpers ================= */
function qrSvg(text){
  const q = qrcode(0, 'M');
  q.addData(String(text));
  q.make();
  return q.createSvgTag({cellSize: 4, margin: 4, scalable: true});
}
function orderPageBase(){
  const custom = String(state.settings.order_page_url || '').trim();
  if(custom){ try{ return new URL(custom, location.href).href; }catch(e){ /* fall through */ } }
  return new URL('../order/', location.href).href;
}
function tableOrderUrl(t){
  const u = new URL(orderPageBase());
  u.searchParams.set('t', t.qr_token);
  return u.href;
}
function randomToken(){
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}
async function copyText(text){
  try{ await navigator.clipboard.writeText(text); toast('Link copied'); }
  catch(e){ window.prompt('Copy this link:', text); }
}

/* ================= Tables & QR codes ================= */
function sortedTables(){
  return state.tables.slice().sort((a, b) => (a.kind === 'TAKEAWAY') - (b.kind === 'TAKEAWAY') || num(a.sort_order) - num(b.sort_order) || String(a.label).localeCompare(String(b.label), undefined, {numeric: true}));
}
function renderTables(){
  if(state.route !== 'tables') return;      // a save finished after the owner moved on
  const bar = setTopbarActions(`<button class="btn btn-amber" id="print-qr">🖨 Print QR codes</button>`);
  bar.querySelector('#print-qr').onclick = openPrintQrPicker;
  const content = document.getElementById('content');
  const tables = sortedTables();
  const menu = state.recipes.filter(r => r.active !== false && num(r.selling_price) > 0).sort((a, b) => posCategoryOf(a).localeCompare(posCategoryOf(b)) || num(a.sort_order) - num(b.sort_order) || byName(a, b));
  const s = state.settings;
  content.innerHTML = `
    ${s.qr_ordering_enabled ? '' : `<div class="notice warn">QR ordering is <b>off</b>: customers can see the menu but can't order. <a class="linklike" id="go-qr-on">Turn it on in Settings</a>.</div>`}
    <div class="card">
      <p class="hint" style="margin-top:0;">Each table has its own QR code, so orders arrive with the table name. The <b>Takeaway</b> code is for the counter (order ahead, pick up). If a printed code is misused, use <b>New code</b> — the old one stops working.</p>
      <div class="table-wrap" style="box-shadow:none;"><table><thead><tr><th>QR</th><th>Name</th><th>Type</th><th class="num">Order</th><th>Status</th><th></th></tr></thead><tbody>
        ${tables.length ? tables.map(t => `<tr class="${t.active ? '' : 'muted-row'}">
          <td><div class="qr-mini" aria-hidden="true">${qrSvg(tableOrderUrl(t))}</div></td>
          <td><b>${esc(t.label)}</b></td><td>${t.kind === 'TAKEAWAY' ? 'Takeaway' : 'Table'}</td><td class="num">${esc(num(t.sort_order))}</td>
          <td>${t.active ? '<span class="badge badge-green">On</span>' : '<span class="badge badge-gray">Off</span>'}</td>
          <td class="row-actions">
            <button class="btn btn-sm btn-ghost" data-copy="${esc(t.id)}">Copy link</button>
            <a class="btn btn-sm btn-ghost" href="${esc(tableOrderUrl(t))}" target="_blank" rel="noopener">Open</a>
            <button class="btn btn-sm btn-ghost" data-edit="${esc(t.id)}">Edit</button>
            <button class="btn btn-sm btn-ghost" data-recode="${esc(t.id)}">New code</button>
            <button class="btn btn-sm btn-ghost" data-toggle="${esc(t.id)}">${t.active ? 'Turn off' : 'Turn on'}</button></td></tr>`).join('')
          : '<tr><td colspan="6" class="text-light" style="padding:14px;">No tables yet.</td></tr>'}
      </tbody></table></div>
      <div class="field-inline" style="margin-top:12px;">
        <button class="btn btn-primary btn-sm" id="add-tables">+ Add tables</button>
        <button class="btn btn-outline btn-sm" id="add-takeaway">+ Add a takeaway code</button>
      </div>
      <p class="hint">Customer order page: <span class="mono">${esc(orderPageBase())}</span> ${s.order_page_url ? '(set in Settings → QR ordering)' : '(worked out from this site\'s address; you can change it in Settings → QR ordering)'}</p>
    </div>
    <div class="section-title">Menu on the QR page</div>
    <div class="card">
      <p class="hint" style="margin-top:0;">Active recipes with a selling price can appear. Hide items here or mark them sold out for the day. Photos, descriptions and options (size, milk, extra shot) are edited in <a class="linklike" id="go-recipes">Recipes &amp; menu</a>.</p>
      <div class="table-wrap" style="box-shadow:none;"><table><thead><tr><th>Item</th><th>Menu section</th><th class="num">Price</th><th>Options</th><th>On QR menu</th><th>Sold out</th></tr></thead><tbody>
        ${menu.length ? menu.map(r => `<tr><td><b>${esc(r.name)}</b>${r.pos_visible === false ? ' <span class="badge badge-gray">not on counter</span>' : ''}</td><td>${esc(posCategoryOf(r))}</td><td class="num">${fmtMoney(r.selling_price)}</td>
          <td>${(r.modifier_groups || []).length ? r.modifier_groups.map(g => esc(g.name)).join(', ') : '<span class="text-light">—</span>'}</td>
          <td><label class="switch" title="Show on the QR menu"><input type="checkbox" data-qrvis="${esc(r.id)}" ${r.qr_visible !== false ? 'checked' : ''} aria-label="Show ${esc(r.name)} on the QR menu"><span class="slider-tog"></span></label></td>
          <td><label class="switch" title="Sold out"><input type="checkbox" data-soldout="${esc(r.id)}" ${r.sold_out ? 'checked' : ''} aria-label="${esc(r.name)} is sold out"><span class="slider-tog"></span></label></td></tr>`).join('')
          : '<tr><td colspan="6" class="text-light" style="padding:14px;">No recipes with a selling price yet.</td></tr>'}
      </tbody></table></div>
    </div>`;
  const on = content.querySelector('#go-qr-on'); if(on) on.onclick = () => { BO_SETTINGS_TAB = 'qr'; navigate('settings'); };
  content.querySelector('#go-recipes').onclick = () => navigate('recipes');
  content.querySelector('#add-tables').onclick = () => openAddTablesModal('DINE_IN');
  content.querySelector('#add-takeaway').onclick = () => openAddTablesModal('TAKEAWAY');
  const T = (id) => state.tables.find(x => x.id === id);
  content.querySelectorAll('[data-copy]').forEach(b => b.onclick = () => copyText(tableOrderUrl(T(b.dataset.copy))));
  content.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => openTableForm(T(b.dataset.edit)));
  content.querySelectorAll('[data-toggle]').forEach(b => b.onclick = () => busy(b, async () => {
    const t = T(b.dataset.toggle);
    if(await boSave([Ops.update('dining_tables', {id: t.id, active: !t.active, updated_at: nowISO()}), Ops.audit(t.active ? 'Table QR turned off' : 'Table QR turned on', t.label, t.id)])) renderTables();
  }, '…'));
  content.querySelectorAll('[data-recode]').forEach(b => b.onclick = async () => {
    const t = T(b.dataset.recode);
    const ok = await confirmDialog(`Make a new QR code for <b>${esc(t.label)}</b>? The old printed code stops working — print the new one and replace it.`, 'Make a new code');
    if(!ok) return;
    if(await boSave([Ops.update('dining_tables', {id: t.id, qr_token: randomToken(), updated_at: nowISO()}), Ops.audit('Table QR code replaced', t.label, t.id)], {success: 'New code made — print it'})) renderTables();
  });
  content.querySelectorAll('[data-qrvis]').forEach(inp => inp.onchange = async () => {
    const r = state.recipes.find(x => x.id === inp.dataset.qrvis);
    if(!await boSave([Ops.update('recipes', {id: r.id, qr_visible: inp.checked, updated_at: nowISO()})], {success: `${r.name}: ${inp.checked ? 'shown on' : 'hidden from'} the QR menu`})) inp.checked = !inp.checked;
  });
  content.querySelectorAll('[data-soldout]').forEach(inp => inp.onchange = async () => {
    const r = state.recipes.find(x => x.id === inp.dataset.soldout);
    if(!await boSave([Ops.update('recipes', {id: r.id, sold_out: inp.checked, updated_at: nowISO()}), Ops.audit(inp.checked ? 'Marked sold out' : 'Available again', r.name, r.id)], {success: `${r.name}: ${inp.checked ? 'sold out' : 'available again'}`})) inp.checked = !inp.checked;
  });
}
function openAddTablesModal(kind){
  const dineIn = state.tables.filter(t => t.kind === 'DINE_IN');
  const nums = dineIn.map(t => Number((/(\d+)\s*$/.exec(t.label) || [])[1])).filter(n => n > 0);
  const next = nums.length ? Math.max(...nums) + 1 : 1;
  openModal({title: kind === 'TAKEAWAY' ? 'Add a takeaway code' : 'Add tables', body: kind === 'TAKEAWAY'
    ? `<div class="form-row"><label for="at-label">Name</label><input id="at-label" maxlength="30" value="Takeaway"></div><p class="hint">Customers scan it at the counter to order ahead and pick up.</p>`
    : `<div class="form-grid"><div class="form-row"><label for="at-from">From table number</label><input type="number" id="at-from" min="1" step="1" value="${next}"></div>
       <div class="form-row"><label for="at-to">To table number</label><input type="number" id="at-to" min="1" step="1" value="${next + 4}"></div></div>
       <div class="form-row"><label for="at-prefix">Name before the number</label><input id="at-prefix" maxlength="20" value="Table"></div>
       <p class="hint" id="at-preview"></p>`,
    foot: `<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" id="at-save">Add</button>`,
    onMount: (root) => {
      root.querySelector('[data-cancel]').onclick = closeModal;
      const pv = root.querySelector('#at-preview');
      const upd = () => { if(pv){ const a = Math.floor(num(root.querySelector('#at-from').value)), z = Math.floor(num(root.querySelector('#at-to').value)), p = root.querySelector('#at-prefix').value.trim() || 'Table'; pv.textContent = a > 0 && z >= a ? `Makes ${z - a + 1} codes: "${p} ${a}"${z > a ? ` … "${p} ${z}"` : ''}.` : 'Check the numbers.'; } };
      root.querySelectorAll('input').forEach(i => i.oninput = upd); upd();
      const save = root.querySelector('#at-save');
      save.onclick = () => busy(save, async () => {
        let labels = [];
        if(kind === 'TAKEAWAY') labels = [root.querySelector('#at-label').value.trim() || 'Takeaway'];
        else {
          const a = Math.floor(num(root.querySelector('#at-from').value)), z = Math.floor(num(root.querySelector('#at-to').value));
          const p = root.querySelector('#at-prefix').value.trim() || 'Table';
          if(!(a >= 1 && z >= a && z - a < 100)){ toast('Check the table numbers (up to 100 at a time)', 'error'); return; }
          for(let n = a; n <= z; n++) labels.push(`${p} ${n}`);
        }
        const existing = new Set(state.tables.map(t => t.label.toLowerCase()));
        const dup = labels.find(l => existing.has(l.toLowerCase()));
        if(dup){ toast(`"${dup}" already exists. Choose other numbers or names.`, 'error'); return; }
        const now = nowISO();
        const ops = labels.map((label, i) => Ops.upsert('dining_tables', {id: uid(), label, kind, qr_token: randomToken(), active: true,
          sort_order: kind === 'TAKEAWAY' ? 0 : (Number((/(\d+)\s*$/.exec(label) || [])[1]) || (i + 1)), created_at: now, updated_at: now}));
        ops.push(Ops.audit('Tables added', labels.join(', ')));
        if(await boSave(ops, {success: `${plural(labels.length, 'QR code')} made`})){ closeModal(); renderTables(); }
      });
    }});
}
function openTableForm(t){
  openModal({title: 'Edit ' + esc(t.label), body: `
    <div class="form-row"><label for="tf-label">Name</label><input id="tf-label" maxlength="30" value="${esc(t.label)}"></div>
    <div class="form-grid">
      <div class="form-row"><label for="tf-kind">Type</label><select id="tf-kind"><option value="DINE_IN" ${t.kind === 'DINE_IN' ? 'selected' : ''}>Table (dine-in)</option><option value="TAKEAWAY" ${t.kind === 'TAKEAWAY' ? 'selected' : ''}>Takeaway</option></select></div>
      <div class="form-row"><label for="tf-sort">Order in lists</label><input id="tf-sort" type="number" step="1" value="${esc(num(t.sort_order))}"></div>
    </div>
    <div class="form-row"><label>Order link</label><div class="link-box">${esc(tableOrderUrl(t))}</div></div>`,
    foot: `<button class="btn btn-danger" id="tf-del" style="margin-right:auto;">Delete</button><button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" id="tf-save">Save</button>`,
    onMount: (root) => {
      root.querySelector('[data-cancel]').onclick = closeModal;
      const save = root.querySelector('#tf-save');
      save.onclick = () => busy(save, async () => {
        const label = root.querySelector('#tf-label').value.trim();
        if(!label){ toast('Enter a name', 'error'); return; }
        if(state.tables.some(x => x.id !== t.id && x.label.toLowerCase() === label.toLowerCase())){ toast('Another table already has that name', 'error'); return; }
        if(await boSave([Ops.update('dining_tables', {id: t.id, label, kind: root.querySelector('#tf-kind').value, sort_order: Math.round(num(root.querySelector('#tf-sort').value)), updated_at: nowISO()}), Ops.audit('Table updated', label, t.id)], {success: 'Saved'})){ closeModal(); renderTables(); }
      });
      const del = root.querySelector('#tf-del');
      del.onclick = () => busy(del, async () => {
        const ok = await confirmDialog(`Delete <b>${esc(t.label)}</b>? Its printed QR code stops working. Past orders keep the table name. (To stop orders for a while, use "Turn off" instead.)`, 'Delete');
        if(ok && await boSave([Ops.del('dining_tables', t.id), Ops.audit('Table deleted', t.label, t.id)], {success: 'Table deleted'})){ closeModal(); renderTables(); }
      }, '…');
    }});
}
function openPrintQrPicker(){
  const tables = sortedTables().filter(t => t.active);
  if(!tables.length){ toast('Turn on or add a table first', 'warn'); return; }
  openModal({title: 'Print QR codes', body: `
    <p class="hint" style="margin-top:0;">Choose the codes to print. Each prints as a card with your logo, shop name and the table name — 4 per A4 page. Cut them out and put one on each table.</p>
    <div class="chk-row" style="flex-direction:column;gap:6px;">${tables.map(t => `<label class="chk"><input type="checkbox" data-pt="${esc(t.id)}" checked> ${esc(t.label)}</label>`).join('')}</div>`,
    foot: `<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" id="pq-go">Print</button>`,
    onMount: (root) => {
      root.querySelector('[data-cancel]').onclick = closeModal;
      root.querySelector('#pq-go').onclick = () => {
        const ids = [...root.querySelectorAll('[data-pt]:checked')].map(i => i.dataset.pt);
        if(!ids.length){ toast('Choose at least one code', 'error'); return; }
        closeModal();
        printQrSheet(tables.filter(t => ids.includes(t.id)));
      };
    }});
}
function printQrSheet(tables){
  const s = state.settings;
  const shop = businessName() || appDisplayName();
  const win = openPrintWindow(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>QR codes — ${esc(shop)}</title>
    <style>
      body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;margin:0;padding:12mm;color:#1c110a;}
      .grid{display:grid;grid-template-columns:repeat(2,1fr);gap:8mm;}
      .card{border:1.5px solid #1c110a;border-radius:6mm;padding:7mm 6mm;text-align:center;page-break-inside:avoid;break-inside:avoid;}
      .card img.logo{width:16mm;height:16mm;object-fit:contain;}
      .shop{font-size:15pt;font-weight:700;margin-top:2mm;}
      .scan{font-size:11pt;margin:2mm 0 3mm;}
      .qr{width:56mm;height:56mm;margin:0 auto;} .qr svg{width:100%;height:100%;display:block;}
      .label{font-size:20pt;font-weight:800;margin-top:2mm;}
      .hint{font-size:8.5pt;color:#555;margin-top:1mm;}
      .noprint{font-size:12px;margin-bottom:8mm;}
      @media print{body{padding:8mm;} .noprint{display:none;}}
    </style></head><body>
    <p class="noprint">Print on A4. Cut along the borders and put one on each table. <button onclick="print()">Print</button></p>
    <div class="grid">${tables.map(t => `<div class="card">${s.logo_url ? `<img class="logo" src="${esc(s.logo_url)}" alt="">` : ''}
      <div class="shop">${esc(shop)}</div>
      <div class="scan">${t.kind === 'TAKEAWAY' ? 'Scan to order ahead for pickup' : 'Scan to order from your table'}</div>
      <div class="qr">${qrSvg(tableOrderUrl(t))}</div>
      <div class="label">${esc(t.label)}</div>
      <div class="hint">${esc(s.qr_payment_note || 'Pay at the counter')}</div></div>`).join('')}</div>
    </body></html>`, false);
  if(win) applyChanges([Ops.audit('QR codes printed', `${tables.length} code(s)`)]).catch(() => {});
}

/* ================= Staff & PINs ================= */
const ROLE_LABEL = {CASHIER: 'Cashier', MANAGER: 'Manager', ADMIN: 'Admin'};
function renderStaff(){
  if(state.route !== 'staff') return;      // a save finished after the owner moved on
  setTopbarActions(`<button class="btn btn-primary" id="add-staff">+ Add staff member</button>`).querySelector('#add-staff').onclick = () => openStaffForm(null);
  const content = document.getElementById('content');
  const staff = state.staff.slice().sort((a, b) => (a.active === false) - (b.active === false) || byName(a, b));
  const me = BO.ownerStaff;
  content.innerHTML = `
    <div class="settings-block" style="max-width:1000px;">
      ${pinUpdateBannerHtml()}
      <p class="hint" style="margin-bottom:12px;">Everyone who uses a counter signs in there with their own PIN: <b>6 digits for managers and admins</b>, 4–6 digits for cashiers. PINs are checked by the server and stored scrambled — nobody can read them, so if someone forgets theirs, set a new one here.
        <b>Cashiers</b> sell. <b>Managers</b> can also approve discounts, refunds and voids. <b>Admin</b> is the same as a manager at the counter. A PIN never opens the Back Office — only your email login does.</p>
      <p class="hint" style="margin-bottom:12px;"><b>PIN stopped working?</b> If someone says the counter tells them <i>“Two staff members share this PIN”</i>, give one of those two people a new PIN here (press <b>Change PIN</b>). The counter never says who shares it — PINs are stored scrambled — so pick either person.</p>
      ${me && !me.has_pin ? `<div class="notice warn">You have no counter PIN yet. <a class="linklike" id="set-own-pin">Set your own PIN</a> so you can sign in at the counter.</div>` : ''}
      <div class="table-wrap"><table><thead><tr><th>Name</th><th>Role</th><th>PIN</th><th>Status</th><th></th></tr></thead><tbody>
        ${staff.map(u => `<tr class="${u.active === false ? 'muted-row' : ''}"><td><b>${esc(u.name)}</b>${me && u.id === me.id ? ' <span class="text-light">(you, the owner)</span>' : ''}${u.local_id ? ' <span class="badge badge-gray" title="Brought in from the old app">imported</span>' : ''}</td>
          <td>${esc(ROLE_LABEL[u.role] || u.role)}</td>
          <td>${u.has_pin ? (BO.pinUpdateNeeded.includes(String(u.id)) ? '<span class="badge badge-red" title="Managers and admins need a 6-digit PIN">Needs a new 6-digit PIN</span>' : '<span class="badge badge-green">Set</span>') : '<span class="badge badge-yellow">Not set</span>'}</td>
          <td>${u.active !== false ? '<span class="badge badge-green">Active</span>' : '<span class="badge badge-gray">Inactive</span>'}</td>
          <td class="row-actions"><button class="btn btn-sm btn-ghost" data-pin="${esc(u.id)}">${u.has_pin ? (BO.pinUpdateNeeded.includes(String(u.id)) ? 'Set new PIN' : 'Change PIN') : 'Set PIN'}</button>
            <button class="btn btn-sm btn-ghost" data-edit="${esc(u.id)}">Edit</button>
            ${me && u.id === me.id ? '' : `<button class="btn btn-sm btn-ghost" data-toggle="${esc(u.id)}">${u.active !== false ? 'Deactivate' : 'Reactivate'}</button>`}</td></tr>`).join('')}
      </tbody></table></div>
    </div>`;
  wirePinUpdateBanner(content);
  const own = content.querySelector('#set-own-pin'); if(own) own.onclick = () => openSetPinModal(me.id);
  content.querySelectorAll('[data-pin]').forEach(b => b.onclick = () => openSetPinModal(b.dataset.pin));
  content.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => openStaffForm(b.dataset.edit));
  content.querySelectorAll('[data-toggle]').forEach(b => b.onclick = async () => {
    const u = state.staff.find(x => x.id === b.dataset.toggle);
    if(BO.ownerStaff && u.id === BO.ownerStaff.id) return;
    const deactivate = u.active !== false;
    if(deactivate){
      const ok = await confirmDialog(`Deactivate <b>${esc(u.name)}</b>? Their PIN stops working at every counter straight away. Their past sales stay.`, 'Deactivate');
      if(!ok) return;
    }
    if(await boSave([Ops.update('staff', {id: u.id, active: !deactivate, updated_at: nowISO()}), Ops.audit(deactivate ? 'Staff deactivated' : 'Staff reactivated', u.name, u.id)], {success: deactivate ? 'Staff member deactivated' : 'Staff member reactivated'})) renderStaff();
  });
}
function openStaffForm(id){
  const u = id ? state.staff.find(x => x.id === id) : null;
  const isOwner = u && BO.ownerStaff && u.id === BO.ownerStaff.id;
  openModal({title: u ? 'Edit staff member' : 'Add staff member', body: `
    <div class="form-row"><label for="sf-name">Name</label><input id="sf-name" maxlength="40" value="${esc(u ? u.name : '')}" placeholder="e.g. Maria Santos" autocomplete="off"></div>
    <div class="form-row"><label for="sf-role">Role</label><select id="sf-role" ${isOwner ? 'disabled' : ''}>${['CASHIER', 'MANAGER', 'ADMIN'].map(r => `<option value="${r}" ${(u ? u.role : 'CASHIER') === r ? 'selected' : ''}>${ROLE_LABEL[r]}</option>`).join('')}</select>
      ${isOwner ? '<div class="hint">Your own role stays Admin.</div>' : '<div class="hint">Managers and admins can approve discounts, refunds and voids at the counter.</div>'}</div>
    <div id="sf-pin-block" style="${u ? 'display:none;' : ''}">
      ${u ? `<div class="notice warn" style="margin-bottom:10px;">Managers and admins need a <b>6-digit PIN</b>. Set ${esc(u.name)}'s new PIN now (it replaces the old one). Without a 6-digit PIN they can still sell at the counter but can't approve refunds, voids or discounts.</div>` : ''}
      <div class="form-grid"><div class="form-row"><label for="sf-pin" id="sf-pin-label">PIN (${pinRuleText(u ? u.role : 'CASHIER')})</label><input id="sf-pin" type="password" inputmode="numeric" maxlength="6" autocomplete="new-password"></div>
      <div class="form-row"><label for="sf-pin2">Type the PIN again</label><input id="sf-pin2" type="password" inputmode="numeric" maxlength="6" autocomplete="new-password"></div></div>${u ? '' : '<div class="hint">You can also set the PIN later.</div>'}</div>`,
    foot: `<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" id="sf-save">${u ? 'Save' : 'Add staff member'}</button>`,
    onMount: (root) => {
      root.querySelector('[data-cancel]').onclick = closeModal;
      // A cashier who becomes a manager or admin needs a new 6-digit PIN, asked for here.
      const promoted = (role) => !!(u && !isOwner && !pinNeedsSix(u.role) && pinNeedsSix(role));
      const roleSel = root.querySelector('#sf-role');
      const syncPinBlock = () => {
        const role = isOwner ? 'ADMIN' : roleSel.value;
        root.querySelector('#sf-pin-label').textContent = `${u ? 'New PIN' : 'PIN'} (${pinRuleText(role)})`;
        if(u) root.querySelector('#sf-pin-block').style.display = promoted(role) ? '' : 'none';
      };
      roleSel.onchange = syncPinBlock;
      syncPinBlock();
      const save = root.querySelector('#sf-save');
      save.onclick = () => busy(save, async () => {
        const name = root.querySelector('#sf-name').value.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
        const role = isOwner ? 'ADMIN' : root.querySelector('#sf-role').value;
        const needPin = promoted(role);
        const pin = (!u || needPin) ? root.querySelector('#sf-pin').value.trim() : '';
        if(!name){ toast('Enter a name', 'error'); return; }
        if(state.staff.some(x => x.id !== (u && u.id) && x.active !== false && x.name.toLowerCase() === name.toLowerCase())){ toast('Someone active already has that name — add a surname or initial so receipts are clear.', 'error'); return; }
        if(needPin && !pin){ toast(`Set a 6-digit PIN for ${name} — managers and admins need one`, 'error'); return; }
        if(pin){
          const bad = pinProblem(pin, role);
          if(bad){ toast(bad, 'error'); return; }
          if(pin !== root.querySelector('#sf-pin2').value.trim()){ toast('The two PINs are different', 'error'); return; }
        }
        const rec = u ? {id: u.id, name, role, updated_at: nowISO()} : {id: uid(), name, role, active: true, created_at: nowISO(), updated_at: nowISO()};
        const ok = await boSave([u ? Ops.update('staff', rec) : Ops.upsert('staff', rec), Ops.audit(u ? 'Staff updated' : 'Staff added', `${name} (${ROLE_LABEL[role]})${u && u.role !== role ? ' — was ' + ROLE_LABEL[u.role] : ''}`, rec.id)], {reload: !pin});
        if(!ok) return;
        if(pin){
          try{
            const r = await cloud.rpc('staff_set_pin', {p_staff_id: rec.id, p_pin: pin});
            if(r && r.error){ await boLoad().catch(() => {}); toast(`${name} was ${u ? 'saved' : 'added'}, but the PIN was not set: ${friendlyError(r)}`, 'error'); closeModal(); renderStaff(); return; }
          }catch(e){ await boLoad().catch(() => {}); toast(`${name} was ${u ? 'saved' : 'added'}, but the PIN was not set: ${friendlyError(e)}`, 'error'); closeModal(); renderStaff(); return; }
          if(u) applyChanges([Ops.audit('PIN set', `${name} (new ${ROLE_LABEL[role]} PIN)`, u.id)]).catch(() => {});
          await boLoad().catch(() => {});
        }
        toast(u ? 'Saved' : 'Staff member added');
        closeModal(); renderStaff();
      });
    }});
}
function openSetPinModal(staffId){
  const u = state.staff.find(x => x.id === staffId);
  if(!u) return;
  const six = pinNeedsSix(u.role);
  openModal({title: 'PIN for ' + esc(u.name), body: `
    ${six ? `<p class="hint" style="margin-top:0;">${esc(ROLE_LABEL[u.role] || u.role)}s need a PIN of exactly <b>6 digits</b>.</p>` : ''}
    <div class="form-grid">
      <div class="form-row"><label for="sp-pin">New PIN (${pinRuleText(u.role)})</label><input id="sp-pin" type="password" inputmode="numeric" maxlength="6" autocomplete="new-password"></div>
      <div class="form-row"><label for="sp-pin2">Type it again</label><input id="sp-pin2" type="password" inputmode="numeric" maxlength="6" autocomplete="new-password"></div>
    </div>
    <p class="hint">Each person needs a different PIN, because the PIN alone tells the counter who is signing in. Setting a new PIN signs this person out of every counter.</p>`,
    foot: `<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" id="sp-save">Save PIN</button>`,
    onMount: (root) => {
      root.querySelector('[data-cancel]').onclick = closeModal;
      setTimeout(() => root.querySelector('#sp-pin').focus(), 30);
      const save = root.querySelector('#sp-save');
      save.onclick = () => busy(save, async () => {
        const a = root.querySelector('#sp-pin').value.trim(), b = root.querySelector('#sp-pin2').value.trim();
        const bad = pinProblem(a, u.role);
        if(bad){ toast(bad, 'error'); return; }
        if(a !== b){ toast('The two PINs are different', 'error'); return; }
        try{
          const r = await cloud.rpc('staff_set_pin', {p_staff_id: staffId, p_pin: a});
          if(r && r.error){ toast(friendlyError(r), 'error'); return; }
        }catch(e){ toast(friendlyError(e), 'error'); return; }
        applyChanges([Ops.audit('PIN set', u.name, u.id)]).catch(() => {});
        await boLoad().catch(() => {});
        toast('PIN saved'); closeModal(); if(state.route === 'staff') renderStaff(); else if(state.route === 'dashboard') rerender();
      });
    }});
}

/* ================= Devices (counters) ================= */
function renderDevices(){
  if(state.route !== 'devices') return;      // a save finished after the owner moved on
  setTopbarActions(`<button class="btn btn-primary" id="pair-new">+ Pair a counter</button>`).querySelector('#pair-new').onclick = openPairingModal;
  const content = document.getElementById('content');
  const list = state.devices.slice().sort((a, b) => (b.active !== false) - (a.active !== false) || String(a.device_tag).localeCompare(String(b.device_tag)));
  content.innerHTML = `
    <div class="settings-block" style="max-width:1000px;">
      ${pinLockoutAlertHtml()}
      <p class="hint" style="margin-bottom:12px;">A counter (tablet, phone or laptop) is paired once with a code from here. After that, staff only need their PIN. Each counter gets a letter used in its receipt numbers (POS-<b>A</b>-2026-000123), so two counters never clash.</p>
      <div class="table-wrap"><table><thead><tr><th>Letter</th><th>Name</th><th>Paired</th><th>Last seen</th><th>Status</th><th></th></tr></thead><tbody>
        ${list.length ? list.map(d => `<tr class="${d.active === false ? 'muted-row' : ''}"><td><b>${esc(d.device_tag || '')}</b></td><td>${esc(d.device_name || '')}</td>
          <td>${d.paired_at ? esc(fmtShopDate(d.paired_at)) : '—'}</td><td>${d.last_seen_at ? esc(timeAgo(d.last_seen_at)) : '—'}</td>
          <td>${d.active !== false ? '<span class="badge badge-green">Active</span>' : '<span class="badge badge-gray">Removed</span>'}</td>
          <td class="row-actions">${d.active !== false ? `<button class="btn btn-sm btn-ghost" data-rename="${esc(d.id)}">Rename</button><button class="btn btn-sm btn-ghost" data-unlock="${esc(d.id)}" title="After too many wrong PINs the counter locks for a while">Unlock PIN pad</button><button class="btn btn-sm btn-ghost" data-remove="${esc(d.id)}">Remove</button>` : ''}</td></tr>`).join('')
          : '<tr><td colspan="6" class="text-light" style="padding:18px;">No counters yet. Use "+ Pair a counter".</td></tr>'}
      </tbody></table></div>
    </div>`;
  const D = (id) => state.devices.find(x => x.id === id);
  content.querySelectorAll('[data-remove]').forEach(b => b.onclick = async () => {
    const d = D(b.dataset.remove);
    const ok = await confirmDialog(`Remove <b>${esc(d.device_name || 'this counter')}</b>? It stops working straight away and must be paired again to be used. If it is offline with sales not yet uploaded, those stay on it until it is paired again.`, 'Remove counter');
    if(!ok) return;
    try{ await cloud.rpc('revoke_device', {p_device_id: d.id}); }catch(e){ toast(friendlyError(e), 'error'); return; }
    applyChanges([Ops.audit('Counter removed', d.device_name || d.device_tag, d.id)]).catch(() => {});
    await boLoad().catch(() => {});
    toast('Counter removed'); renderDevices();
  });
  wirePinLockoutAlert(content);
  content.querySelectorAll('[data-unlock]').forEach(b => b.onclick = () => busy(b, () => unlockDevicePin(b.dataset.unlock), 'Unlocking…'));
  content.querySelectorAll('[data-rename]').forEach(b => b.onclick = () => {
    const d = D(b.dataset.rename);
    openModal({title: 'Rename counter', body: `<div class="form-row"><label for="dv-name">Name</label><input id="dv-name" maxlength="30" value="${esc(d.device_name || '')}"></div>`,
      foot: `<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" id="dv-save">Save</button>`,
      onMount: (root) => {
        root.querySelector('[data-cancel]').onclick = closeModal;
        const save = root.querySelector('#dv-save');
        save.onclick = () => busy(save, async () => {
          const name = root.querySelector('#dv-name').value.replace(/[<>]/g, '').trim().slice(0, 30);
          if(!name){ toast('Enter a name', 'error'); return; }
          if(await boSave([Ops.update('devices', {id: d.id, device_name: name}), Ops.audit('Counter renamed', `${d.device_name || ''} → ${name}`, d.id)], {success: 'Saved'})){ closeModal(); renderDevices(); }
        });
      }});
  });
}
function openPairingModal(){
  let timer = null;
  openModal({title: 'Pair a counter', body: `
    <div class="form-row"><label for="pd-name">Counter name</label><input id="pd-name" maxlength="30" placeholder="e.g. Front counter iPad"></div>
    <div id="pd-result"><p class="hint">You get a 6-letter code that works once, for 15 minutes.</p></div>`,
    foot: `<button class="btn btn-outline" data-cancel>Close</button><button class="btn btn-primary" id="pd-make">Get a pairing code</button>`,
    onClose: () => { clearInterval(timer); boLoad().then(() => { if(state.route === 'devices') renderDevices(); }).catch(() => {}); },
    onMount: (root) => {
      root.querySelector('[data-cancel]').onclick = closeModal;
      const make = root.querySelector('#pd-make');
      make.onclick = () => busy(make, makeCode, 'Getting a code…').then(() => { if(make.dataset.label && make.isConnected) make.textContent = make.dataset.label; });
      const makeCode = async () => {
        const name = root.querySelector('#pd-name').value.replace(/[<>]/g, '').trim();
        let res;
        try{ res = await cloud.rpc('create_device_pairing_code', {p_device_name: name || null}); }
        catch(e){ toast(friendlyError(e), 'error'); return; }
        const link = new URL('../front/?pair=' + encodeURIComponent(res.code), location.href).href;
        applyChanges([Ops.audit('Pairing code made', name || 'Counter')]).catch(() => {});
        root.querySelector('#pd-result').innerHTML = `
          <div class="pair-box"><div><div class="big-code" aria-label="Pairing code">${esc(res.code)}</div>
            <div class="hint" id="pd-expiry">Works once, until ${esc(fmtShopTime(res.expires_at))}.</div></div>
            <div class="qr-img" title="Scan with the counter's camera">${qrSvg(link)}</div></div>
          <ol class="hint" style="line-height:1.9;padding-left:18px;margin-top:10px;">
            <li>On the counter, scan this QR code with the camera — or open <b>${esc(new URL('../front/', location.href).href)}</b>.</li>
            <li>Type the code if it is not filled in, then tap <b>Pair this counter</b>.</li>
            <li>Staff can then sign in with their PIN.</li></ol>`;
        make.dataset.label = 'Make another code';
        clearInterval(timer);
        timer = setInterval(() => {
          const left = new Date(res.expires_at).getTime() - Date.now();
          const ex = document.getElementById('pd-expiry');
          if(!ex){ clearInterval(timer); return; }
          if(left <= 0){ ex.textContent = 'This code has expired. Make another one.'; clearInterval(timer); }
          else ex.textContent = `Works once, for ${Math.ceil(left / 60000)} more minute(s) (until ${fmtShopTime(res.expires_at)}).`;
        }, 15000);
      };
    }});
}

/* ================= Audit log ================= */
const auditFilter = {preset: '7d', from: '', to: '', search: ''};
let AUDIT_ROWS = [];
async function renderAuditLog(){
  const bar = setTopbarActions(`<button class="btn btn-outline" id="au-csv">Download CSV</button>`);
  bar.querySelector('#au-csv').onclick = () => {
    if(!AUDIT_ROWS.length){ toast('Nothing to export', 'warn'); return; }
    downloadFile(`${fileNameSlug()}-audit-log-${shopTodayKey()}.csv`, toCSV(['When', 'Action', 'By', 'Signed in at the counter', 'Details'], filteredAudit().map(e => [fmtShopDateTime(e.at), e.action, e.actor_name, auditSignedInOther(e), e.details])), 'text/csv');
  };
  const content = document.getElementById('content');
  content.innerHTML = `<div class="toolbar"><div class="toolbar-left">${rangePickerHtml(auditFilter, 'au')}
      <div class="search-box"><input id="au-search" placeholder="Search action, person or details…" value="${esc(auditFilter.search)}" aria-label="Search the audit log"></div></div>
    <div class="text-light" style="font-size:13px;" id="au-count"></div></div>
    <div id="au-wrap"><div class="loading-line">Loading…</div></div>`;
  wireRangePicker(content, auditFilter, 'au', loadAudit);
  content.querySelector('#au-search').oninput = debounce((e) => { auditFilter.search = e.target.value; drawAudit(); }, 150);
  await loadAudit();
}
async function loadAudit(){
  const wrap = document.getElementById('au-wrap'); if(!wrap) return;
  wrap.classList.add('dim');
  try{
    const [a, b] = presetKeys(auditFilter.preset, auditFilter);
    const r = dayRange(a, b);
    AUDIT_ROWS = await cloud.select('audit_log', {gte: {at: r.from.toISOString()}, lt: {at: r.to.toISOString()}, order: 'at.desc', limit: 3000}) || [];
  }catch(e){ wrap.classList.remove('dim'); wrap.innerHTML = emptyBlock(esc(friendlyError(e))); return; }
  wrap.classList.remove('dim');
  drawAudit();
}
// The staff member the server saw signed in, when it is not the person named on the entry.
function auditSignedInOther(e){
  if(!e || !e.signed_in_staff_id || (e.actor_id && String(e.actor_id) === String(e.signed_in_staff_id))) return '';
  return staffName(e.signed_in_staff_id) || 'another staff member';
}
function filteredAudit(){
  if(!auditFilter.search) return AUDIT_ROWS;
  const q = auditFilter.search.toLowerCase();
  return AUDIT_ROWS.filter(e => [e.action, e.actor_name, e.details].some(v => String(v || '').toLowerCase().includes(q)));
}
function drawAudit(){
  const wrap = document.getElementById('au-wrap'); if(!wrap) return;
  const list = filteredAudit();
  document.getElementById('au-count').textContent = `${plural(list.length, 'entry', 'entries')}${AUDIT_ROWS.length >= 3000 ? ' (latest 3,000 — choose fewer days to see older ones)' : ''}`;
  wrap.innerHTML = list.length ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Action</th><th>By</th><th>Details</th></tr></thead><tbody>
    ${list.slice(0, 600).map(e => `<tr><td style="white-space:nowrap;">${esc(fmtShopDateTime(e.at))}</td><td><b>${esc(e.action)}</b></td><td>${esc(e.actor_name || '')}${auditSignedInOther(e) ? `<div class="signed-in-diff" title="The server saw a different staff member signed in at the counter">signed in: ${esc(auditSignedInOther(e))}</div>` : ''}</td><td class="text-light">${esc(e.details || '')}</td></tr>`).join('')}
  </tbody></table></div>${list.length > 600 ? '<p class="hint">Showing the latest 600. Search or download the CSV for the rest.</p>' : ''}` : emptyBlock('No entries for these dates.');
}

/* ================= Settings ================= */
let BO_SETTINGS_TAB = 'general';
const COLOR_KEYS = ['primary_color', 'secondary_color', 'accent_color', 'background_color', 'card_color', 'text_color'];
const COLOR_LABEL = {primary_color: 'Main', secondary_color: 'Second', accent_color: 'Accent', background_color: 'Background', card_color: 'Cards', text_color: 'Text'};
const COLOR_PRESETS = {
  Coffee:   {primary_color:'#5C4033', secondary_color:'#8B6F47', accent_color:'#C08A5C', background_color:'#F5EFE6', card_color:'#FFFDF9', text_color:'#2C1E14'},
  Espresso: {primary_color:'#241209', secondary_color:'#3b2418', accent_color:'#c17a3d', background_color:'#efe6d8', card_color:'#fffaf2', text_color:'#1c110a'},
  Cream:    {primary_color:'#8a6f4f', secondary_color:'#a98a5b', accent_color:'#c9a35c', background_color:'#fdf8ee', card_color:'#ffffff', text_color:'#4a3c28'},
  Forest:   {primary_color:'#1f2e22', secondary_color:'#33513f', accent_color:'#7a9b6e', background_color:'#f1f4ee', card_color:'#ffffff', text_color:'#20281f'},
  Minimal:  {primary_color:'#222222', secondary_color:'#444444', accent_color:'#888888', background_color:'#fafafa', card_color:'#ffffff', text_color:'#1a1a1a'},
  Dark:     {primary_color:'#0f0f0f', secondary_color:'#2a2a2a', accent_color:'#c17a3d', background_color:'#1c1c1c', card_color:'#2b2b2b', text_color:'#f0ece4'},
};
const SETTINGS_TABS = [{id: 'general', label: 'General'}, {id: 'branding', label: 'Branding'}, {id: 'receipt', label: 'Receipts & tax'}, {id: 'qr', label: 'QR ordering'}, {id: 'loyalty', label: 'Loyalty'}];

// Saves the shop settings row (+ the business name when it changed) in one call.
async function saveSettings(changes, auditAction, auditDetails){
  const draft = Object.assign({}, state.settings, changes);
  const row = {};
  SERVER_SETTING_KEYS.forEach(k => { row[k] = draft[k]; });
  if(BO.hasPayoutLimit) row.payout_review_limit = num(draft.payout_review_limit);
  row.updated_at = nowISO();
  const ops = [Ops.upsert('settings', row)];
  const name = String(draft.business_name || '').trim();
  if(name && (!state.business || state.business.name !== name)) ops.push(Ops.upsert('businesses', {name}));
  ops.push(Ops.audit(auditAction || 'Settings saved', auditDetails || ''));
  const ok = await boSave(ops, {success: 'Saved — counters pick this up within a few minutes'});
  applyCustomTheme();
  return ok;
}
function renderSettings(){
  if(state.route !== 'settings') return;      // a save finished after the owner moved on
  const content = document.getElementById('content');
  const s = state.settings;
  const tab = BO_SETTINGS_TAB;
  let html = '';
  if(tab === 'general') html = `
    <div class="card">
      <div class="form-grid">
        <div class="form-row"><label>Currency</label><input value="Philippine peso (₱)" disabled></div>
        <div class="form-row"><label>Time zone</label><input value="${esc(shopTz())} (Philippines)" disabled></div>
      </div>
      <div class="form-row"><label for="set-costing">Costing method</label>
        <select id="set-costing"><option value="weighted_average" ${s.costing_method !== 'latest' ? 'selected' : ''}>Weighted average cost</option><option value="latest" ${s.costing_method === 'latest' ? 'selected' : ''}>Latest purchase cost</option></select></div>
      <div class="hint" style="margin:-6px 0 14px;"><b>Weighted average</b>: total spent ÷ total quantity bought, across all purchases — smooths out price spikes. <b>Latest purchase</b>: uses only your most recent price — reacts straight away to price changes.</div>
      <div class="form-grid">
        <div class="form-row"><label for="set-lowstock">Default low-stock level (new ingredients)</label><input type="number" min="0" step="any" id="set-lowstock" value="${esc(num(s.low_stock_default_threshold))}"></div>
        <div class="form-row"><label for="set-foodcost">Food cost warning %</label><input type="number" min="0" max="100" step="any" id="set-foodcost" value="${esc(num(s.food_cost_warning_pct))}"></div>
      </div>
      <div class="form-row" style="max-width:360px;"><label for="set-payout-limit">Ask me to review cash pay-outs above (₱)</label><input type="number" min="0" step="any" id="set-payout-limit" value="${esc(num(s.payout_review_limit))}" ${BO.hasPayoutLimit ? '' : 'disabled'}>
        <div class="hint">${BO.hasPayoutLimit ? 'A pay-out (cash taken out of a counter drawer) bigger than this shows in Transactions → "Needs review".' : 'Available after the latest database update is installed.'}</div></div>
      <div class="toggle-row" style="border:none;"><span>Dark theme<br><span class="hint">For the Back Office and the counters.</span></span><label class="switch"><input type="checkbox" id="set-dark" ${s.theme === 'dark' ? 'checked' : ''}><span class="slider-tog"></span></label></div>
      <button class="btn btn-primary" id="save-general">Save</button>
    </div>`;
  if(tab === 'branding') html = `
    <div class="card">
      <div class="form-grid">
        <div class="form-row"><label for="cz-business">Shop name</label><input id="cz-business" maxlength="80" value="${esc(s.business_name || (state.business && state.business.name) || '')}" placeholder="e.g. Cavite City Coffee Club"></div>
        <div class="form-row"><label for="cz-appname">App name</label><input id="cz-appname" maxlength="40" value="${esc(s.app_name || 'Brew Ledger')}" placeholder="Brew Ledger"></div>
      </div>
      <div class="hint" style="margin:-6px 0 14px;">The shop name shows on receipts, the counters, the QR order page and printed reports.</div>
      <div class="form-row"><label>Logo</label></div>
      <div class="field-inline" style="margin-bottom:16px;">
        <div class="logo-preview" id="cz-logo-preview">${s.logo_url ? `<img src="${esc(s.logo_url)}" alt="">` : '<span style="font-size:22px;">☕</span>'}</div>
        <button class="btn btn-outline btn-sm" id="cz-logo-upload">Upload a logo</button>
        <button class="btn btn-ghost btn-sm" id="cz-logo-remove" ${!s.logo_url ? 'disabled' : ''}>Remove logo</button>
        <input type="file" id="cz-logo-input" accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp" style="display:none;">
      </div>
      <div class="form-row"><label>Ready-made colours</label></div>
      <div class="field-inline" style="gap:12px;margin-bottom:16px;">
        ${Object.entries(COLOR_PRESETS).map(([name, p]) => `<div style="text-align:center;"><button type="button" class="preset-swatch" data-preset="${name}" style="background:linear-gradient(135deg, ${p.primary_color} 50%, ${p.accent_color} 50%);" aria-label="${name} colours"></button><div class="text-light" style="font-size:11px;margin-top:4px;">${name}</div></div>`).join('')}
      </div>
      <div class="form-row"><label>Colours</label></div>
      <div style="display:flex;flex-wrap:wrap;gap:4px 24px;margin-bottom:6px;">
        ${COLOR_KEYS.map(k => `<div class="color-field"><span class="cf-label">${COLOR_LABEL[k]}</span><input type="color" id="cz-${k}" value="${esc(s[k])}" aria-label="${COLOR_LABEL[k]} colour"><input type="text" id="cz-${k}-hex" value="${esc(s[k])}" maxlength="7" aria-label="${COLOR_LABEL[k]} colour code"></div>`).join('')}
      </div>
      <button class="btn btn-ghost btn-sm" id="cz-reset-colors" style="margin-bottom:16px;">Back to the default colours</button>
      <div class="form-grid">
        <div class="form-row"><label for="cz-font">Font</label><select id="cz-font">${FONT_OPTIONS.map(f => `<option value="${f.id}" ${s.font_family === f.id ? 'selected' : ''}>${esc(f.label)}</option>`).join('')}</select></div>
        <div class="form-row"><label for="cz-fontsize">Text size</label><select id="cz-fontsize">${['small', 'medium', 'large'].map(z => `<option value="${z}" ${s.font_size === z ? 'selected' : ''}>${z[0].toUpperCase() + z.slice(1)}</option>`).join('')}</select></div>
      </div>
      <div class="hint" style="margin-bottom:14px;">Changes show here straight away as a preview. Counters and the QR page update after you save.</div>
      <div class="field-inline"><button class="btn btn-primary" id="cz-save">Save branding</button><button class="btn btn-outline" id="cz-reset-all">Reset all to defaults</button></div>
    </div>`;
  if(tab === 'receipt') html = `
    <div class="card">
      <div class="form-grid">
        <div class="form-row"><label for="set-address">Shop address</label><input id="set-address" maxlength="200" value="${esc(s.business_address || '')}"></div>
        <div class="form-row"><label for="set-contact">Contact number</label><input id="set-contact" maxlength="60" value="${esc(s.business_contact || '')}"></div>
      </div>
      <div class="form-grid">
        <div class="form-row"><label for="set-tax">Tax %</label><input type="number" step="any" min="0" max="100" id="set-tax" value="${esc(num(s.tax_pct))}"></div>
        <div class="form-row"><label for="set-service">Service charge %</label><input type="number" step="any" min="0" max="100" id="set-service" value="${esc(num(s.service_charge_pct))}"></div>
      </div>
      <label class="chk" style="margin-bottom:12px;"><input type="checkbox" id="set-taxincl" ${s.tax_inclusive ? 'checked' : ''}> Menu prices already include tax (no tax is added at the counter)</label>
      <div class="form-row"><label for="set-footer">Message at the bottom of receipts</label><input id="set-footer" maxlength="160" value="${esc(s.receipt_footer || '')}"></div>
      <div class="field-inline"><button class="btn btn-primary" id="save-receipt">Save</button><button class="btn btn-outline" id="preview-receipt">See a sample receipt</button></div>
      <p class="hint">Tax and service charge apply to new sales on the counters and QR orders once the counters reload their menu (within a few minutes).</p>
    </div>`;
  if(tab === 'qr') html = `
    <div class="card">
      <div class="toggle-row"><span><b>Take QR orders</b><br><span class="hint">When off, customers can still see the menu but can't order.</span></span><label class="switch"><input type="checkbox" id="qr-on" ${s.qr_ordering_enabled ? 'checked' : ''}><span class="slider-tog"></span></label></div>
      <div class="toggle-row"><span><b>Hide items that are out of stock</b><br><span class="hint">Uses your ingredient stock. Leave off unless you record purchases and stock counts regularly.</span></span><label class="switch"><input type="checkbox" id="qr-hide" ${s.qr_hide_out_of_stock ? 'checked' : ''}><span class="slider-tog"></span></label></div>
      <div class="form-row" style="margin-top:12px;"><label for="qr-welcome">Welcome message</label><input id="qr-welcome" maxlength="160" value="${esc(s.qr_welcome_message || '')}" placeholder="e.g. Order from your phone, pay at the counter."></div>
      <div class="form-row"><label for="qr-pay">Payment note shown to customers</label><input id="qr-pay" maxlength="160" value="${esc(s.qr_payment_note || '')}" placeholder="e.g. Please pay at the counter when your order is called."></div>
      <div class="form-row"><label for="qr-url">Order page address (optional)</label><input id="qr-url" maxlength="300" value="${esc(s.order_page_url || '')}" placeholder="${esc(new URL('../order/', location.href).href)}">
        <div class="hint">Leave empty to use this website's own order page. The table codes are this address plus "?t=" and the table's code — change it only if you move the order page, then print the QR codes again.</div></div>
      <button class="btn btn-primary" id="qr-save">Save</button>
    </div>`;
  if(tab === 'loyalty') html = `
    <div class="card">
      <div class="toggle-row"><span><b>Loyalty stamps</b><br><span class="hint">Customers see their stamp card on the QR order page.</span></span><label class="switch"><input type="checkbox" id="ly-on" ${s.loyalty_enabled ? 'checked' : ''}><span class="slider-tog"></span></label></div>
      <div class="form-row" style="margin-top:12px;max-width:260px;"><label for="ly-stamps">Stamps for one reward</label><input type="number" min="1" max="50" step="1" id="ly-stamps" value="${esc(num(s.stamps_per_reward) || 10)}"></div>
      <button class="btn btn-primary" id="ly-save">Save</button>
    </div>`;
  content.innerHTML = `<div class="settings-block" style="max-width:760px;">
    <div class="seg" style="margin-bottom:16px;flex-wrap:wrap;" role="tablist">${SETTINGS_TABS.map(t => `<button class="seg-btn ${tab === t.id ? 'active' : ''}" data-tab="${t.id}" role="tab" aria-selected="${tab === t.id}">${t.label}</button>`).join('')}</div>
    ${html}
    <p class="hint" style="margin-top:14px;">Backups, importing old data and Google Drive are in <a class="linklike" id="go-backup">Backup &amp; import</a>.</p></div>`;
  content.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { applyCustomTheme(); BO_SETTINGS_TAB = b.dataset.tab; renderSettings(); });
  content.querySelector('#go-backup').onclick = () => navigate('backup');
  const $ = (id) => content.querySelector('#' + id);

  if(tab === 'general'){
    $('save-general').onclick = (e) => busy(e.currentTarget, async () => {
      const ch = {costing_method: $('set-costing').value, low_stock_default_threshold: Math.max(0, num($('set-lowstock').value)),
        food_cost_warning_pct: Math.max(0, num($('set-foodcost').value)) || 35, theme: $('set-dark').checked ? 'dark' : 'light'};
      if(BO.hasPayoutLimit){
        const lim = $('set-payout-limit').value.trim();
        if(lim === '' || !(num(lim) >= 0)){ toast('Enter the pay-out amount to review (₱0 or more)', 'error'); return; }
        ch.payout_review_limit = Math.round(num(lim) * 100) / 100;
      }
      await saveSettings(ch, 'Settings saved', `costing ${ch.costing_method === 'latest' ? 'latest purchase' : 'weighted average'}${ch.payout_review_limit != null ? ' · review pay-outs above ' + fmtMoney(ch.payout_review_limit) : ''}`);
    });
  }
  if(tab === 'receipt'){
    const read = () => ({business_address: $('set-address').value.trim(), business_contact: $('set-contact').value.trim(),
      tax_pct: Math.max(0, num($('set-tax').value)), service_charge_pct: Math.max(0, num($('set-service').value)),
      tax_inclusive: $('set-taxincl').checked, receipt_footer: $('set-footer').value.trim()});
    $('save-receipt').onclick = (e) => busy(e.currentTarget, async () => {
      const ch = read();
      if(ch.tax_pct > 100 || ch.service_charge_pct > 100){ toast('Percentages must be 100 or less', 'error'); return; }
      await saveSettings(ch, 'Receipt settings saved', `tax ${ch.tax_pct}%${ch.tax_inclusive ? ' (included)' : ''} · service ${ch.service_charge_pct}%`);
    });
    $('preview-receipt').onclick = () => {
      const keep = state.settings;
      state.settings = Object.assign({}, keep, read());
      const t = computeSaleTotals([{unit_price: 150, quantity: 2}, {unit_price: 65, quantity: 1}], null);
      const sale = {transaction_number: 'POS-A-SAMPLE', transaction_date: nowISO(), cashier_name: boActorName(), status: 'COMPLETED',
        subtotal: t.subtotal, discount_amount: 0, tax_amount: t.tax, service_charge_amount: t.serviceCharge, grand_total: t.grandTotal};
      const items = [{name: 'Iced Latte', quantity: 2, line_total: 300, modifiers: [{label: '16oz', price_delta: 0}]}, {name: 'Ensaymada', quantity: 1, line_total: 65}];
      try{ openPrintWindow(receiptHtml(sale, items, [{method: 'CASH', amount: t.grandTotal, tendered: Math.ceil(t.grandTotal / 100) * 100, change: Math.ceil(t.grandTotal / 100) * 100 - t.grandTotal}]), false); }
      finally{ state.settings = keep; }
    };
  }
  if(tab === 'qr'){
    $('qr-save').onclick = (e) => busy(e.currentTarget, async () => {
      const url = $('qr-url').value.trim();
      if(url){ try{ const u = new URL(url); if(!/^https?:$/.test(u.protocol)) throw new Error(); }catch(err){ toast('The order page address must start with https://', 'error'); return; } }
      const ch = {qr_ordering_enabled: $('qr-on').checked, qr_hide_out_of_stock: $('qr-hide').checked,
        qr_welcome_message: $('qr-welcome').value.trim(), qr_payment_note: $('qr-pay').value.trim(), order_page_url: url};
      await saveSettings(ch, 'QR ordering settings saved', ch.qr_ordering_enabled ? 'ordering on' : 'ordering off');
    });
  }
  if(tab === 'loyalty'){
    $('ly-save').onclick = (e) => busy(e.currentTarget, async () => {
      const n = Math.round(num($('ly-stamps').value));
      if(n < 1 || n > 50){ toast('Choose 1 to 50 stamps', 'error'); return; }
      await saveSettings({loyalty_enabled: $('ly-on').checked, stamps_per_reward: n}, 'Loyalty settings saved', `${$('ly-on').checked ? 'on' : 'off'}, ${n} stamps`);
    });
  }
  if(tab === 'branding'){
    let pendingLogo;   // undefined = unchanged, null = remove, Blob = new
    const draft = () => {
      const d = Object.assign({}, state.settings);
      d.business_name = $('cz-business').value.trim();
      d.app_name = $('cz-appname').value.trim() || 'Brew Ledger';
      COLOR_KEYS.forEach(k => { d[k] = $('cz-' + k).value; });
      d.font_family = $('cz-font').value; d.font_size = $('cz-fontsize').value;
      return d;
    };
    const preview = () => applyCustomTheme(draft());
    COLOR_KEYS.forEach(k => {
      $('cz-' + k).oninput = () => { $('cz-' + k + '-hex').value = $('cz-' + k).value; preview(); };
      $('cz-' + k + '-hex').oninput = () => { const v = $('cz-' + k + '-hex').value.trim(); if(/^#[0-9a-fA-F]{6}$/.test(v)){ $('cz-' + k).value = v; preview(); } };
    });
    $('cz-font').onchange = preview; $('cz-fontsize').onchange = preview;
    content.querySelectorAll('[data-preset]').forEach(sw => sw.onclick = () => {
      const p = COLOR_PRESETS[sw.dataset.preset];
      COLOR_KEYS.forEach(k => { $('cz-' + k).value = p[k]; $('cz-' + k + '-hex').value = p[k]; });
      preview();
    });
    $('cz-reset-colors').onclick = () => { COLOR_KEYS.forEach(k => { $('cz-' + k).value = DEFAULT_SETTINGS[k]; $('cz-' + k + '-hex').value = DEFAULT_SETTINGS[k]; }); preview(); };
    $('cz-logo-upload').onclick = () => $('cz-logo-input').click();
    $('cz-logo-input').onchange = async (e) => {
      const f = e.target.files[0]; if(!f) return;
      try{
        pendingLogo = await resizeImage(f, 256, 'image/png');
        $('cz-logo-preview').innerHTML = `<img src="${URL.createObjectURL(pendingLogo)}" alt="">`;
        $('cz-logo-remove').disabled = false;
        toast('Logo ready — press "Save branding" to use it');
      }catch(err){ toast(err.message || 'Could not read that picture', 'error'); }
    };
    $('cz-logo-remove').onclick = () => { pendingLogo = null; $('cz-logo-preview').innerHTML = '<span style="font-size:22px;">☕</span>'; $('cz-logo-remove').disabled = true; };
    $('cz-save').onclick = (e) => busy(e.currentTarget, async () => {
      const d = draft();
      if(!d.business_name){ toast('Enter the shop name', 'error'); return; }
      const bad = COLOR_KEYS.find(k => !/^#[0-9a-fA-F]{6}$/.test(d[k]));
      if(bad){ toast(`The ${COLOR_LABEL[bad].toLowerCase()} colour is not a valid colour code`, 'error'); return; }
      const ch = {business_name: d.business_name, app_name: d.app_name, font_family: d.font_family, font_size: d.font_size};
      COLOR_KEYS.forEach(k => { ch[k] = d[k]; });
      if(pendingLogo === null) ch.logo_url = null;
      else if(pendingLogo){
        try{ ch.logo_url = await uploadShopImage(pendingLogo, `logo-${Date.now()}.png`, 'image/png'); }
        catch(err){ toast('The logo could not be uploaded: ' + friendlyError(err), 'error'); return; }
      }
      if(await saveSettings(ch, 'Branding saved', d.business_name)){ pendingLogo = undefined; renderShell(); if(state.route === 'settings') navigate('settings'); }
    });
    $('cz-reset-all').onclick = async () => {
      const ok = await confirmDialog('Reset the app name, logo, colours and font to the defaults? (The shop name stays.)', 'Reset');
      if(!ok) return;
      const ch = {app_name: DEFAULT_SETTINGS.app_name, logo_url: null, font_family: DEFAULT_SETTINGS.font_family, font_size: DEFAULT_SETTINGS.font_size};
      COLOR_KEYS.forEach(k => { ch[k] = DEFAULT_SETTINGS[k]; });
      if(await saveSettings(ch, 'Branding reset', '')){ renderShell(); if(state.route === 'settings') navigate('settings'); }
    };
  }
}
