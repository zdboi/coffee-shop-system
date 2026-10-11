/* =====================================================================
   BACK OFFICE — new screens added for CCCC:
   Sales Calendar · Transactions · QR Orders · Customers · Staff & PINs ·
   Devices · QR Ordering setup · Audit Log · Import / Restore
   (The inventory, recipe, costing, purchasing, production and report
   screens from the previous version live in app.js, unchanged in logic.)
   ===================================================================== */

/* ---------- Sales Calendar ---------- */
function renderCalendarScreen(){
  const content = document.getElementById('content');
  renderSalesCalendar(content);
}

/* ---------- Transactions (read-only list; refunds/voids happen at the counter) ---------- */
let txFilter = {search:'', status:'', from:'', to:''};
function renderTransactions(){
  const content = document.getElementById('content');
  content.innerHTML = `
    <div class="toolbar">
      <div class="toolbar-left">
        <div class="search-box"><input type="text" id="tx-search" placeholder="Transaction #, item or customer…" value="${escapeHtml(txFilter.search)}"></div>
        <select class="filter" id="tx-status"><option value="">All statuses</option>${['COMPLETED','PARTIALLY_REFUNDED','REFUNDED','VOIDED','HELD'].map(s=>`<option value="${s}" ${txFilter.status===s?'selected':''}>${s.replace(/_/g,' ').toLowerCase()}</option>`).join('')}</select>
        <input type="date" class="filter" id="tx-from" value="${txFilter.from}" title="From">
        <input type="date" class="filter" id="tx-to" value="${txFilter.to}" title="To">
      </div>
      <div class="text-light" style="font-size:13px;" id="tx-count"></div>
    </div>
    <div id="tx-wrap"></div>`;
  const rerender = ()=> renderTransactionsTable();
  document.getElementById('tx-search').oninput = (e)=>{ txFilter.search = e.target.value; rerender(); };
  document.getElementById('tx-status').onchange = (e)=>{ txFilter.status = e.target.value; rerender(); };
  document.getElementById('tx-from').onchange = async (e)=>{ txFilter.from = e.target.value; if(txFilter.from){ try{ await Data.ensureRange(txFilter.from); }catch(err){ toast(friendlyError(err),'error'); } } rerender(); };
  document.getElementById('tx-to').onchange = (e)=>{ txFilter.to = e.target.value; rerender(); };
  rerender();
}
function renderTransactionsTable(){
  const wrap = document.getElementById('tx-wrap');
  let list = state.sales.slice();
  if(txFilter.status) list = list.filter(s=>s.status===txFilter.status);
  if(txFilter.from) list = list.filter(s=> s.transaction_date >= new Date(txFilter.from+'T00:00:00').toISOString());
  if(txFilter.to) list = list.filter(s=> s.transaction_date < new Date(new Date(txFilter.to+'T00:00:00').getTime()+86400000).toISOString());
  if(txFilter.search){
    const q = txFilter.search.toLowerCase();
    const itemHits = new Set(state.saleItems.filter(i=> (i.name||'').toLowerCase().includes(q)).map(i=>i.saleId));
    const custHits = new Set(state.customers.filter(c=> (c.nickname||'').toLowerCase().includes(q)).map(c=>c.id));
    list = list.filter(s=> (s.transaction_number||'').toLowerCase().includes(q) || itemHits.has(s.id) || (s.customer_id && custHits.has(s.customer_id)));
  }
  list.sort((a,b)=> String(b.transaction_date).localeCompare(String(a.transaction_date)));
  document.getElementById('tx-count').textContent = `${list.length} transaction${list.length===1?'':'s'} · history loaded from ${fmtDate(Data.loadedFrom)}`;
  if(!list.length){ wrap.innerHTML = emptyBlock('No transactions match. Pick an earlier "From" date to load older history.'); return; }
  const custName = (id)=> (state.customers.find(c=>c.id===id)||{}).nickname;
  wrap.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Transaction #</th><th>Date / time</th><th>Cashier</th><th>Customer</th><th>Status</th><th>Payment</th><th>Total</th></tr></thead><tbody>
    ${list.slice(0,300).map(s=>`<tr class="clickable" data-sale="${s.id}"><td><b>${escapeHtml(s.transaction_number||'')}</b>${s.order_id?' <span class="badge badge-gray">QR</span>':''}</td>
      <td>${fmtDate(s.transaction_date)} ${new Date(s.transaction_date).toLocaleTimeString('en-PH',{hour:'numeric',minute:'2-digit'})}</td>
      <td>${escapeHtml(s.cashier||'')}</td><td>${escapeHtml(custName(s.customer_id)||'—')}</td>
      <td>${boSaleBadge(s.status)}</td><td>${escapeHtml(paymentMethodForSale(s.id)||'—')}</td><td>${fmtMoney(s.grand_total)}</td></tr>`).join('')}
  </tbody></table></div>${list.length>300?'<p class="hint">Showing the latest 300. Narrow the dates to see others.</p>':''}`;
  wrap.querySelectorAll('[data-sale]').forEach(tr=> tr.onclick = ()=> openSaleModal(tr.dataset.sale));
}
function boSaleBadge(status){
  const map = {COMPLETED:'badge-green', VOIDED:'badge-red', REFUNDED:'badge-red', PARTIALLY_REFUNDED:'badge-yellow', HELD:'badge-gray'};
  return `<span class="badge ${map[status]||'badge-gray'}">${escapeHtml(String(status||'').replace(/_/g,' '))}</span>`;
}
async function openSaleModal(saleId){
  const sale = state.sales.find(s=>s.id===saleId);
  if(!sale) return;
  const items = await DB.byIndex('saleItems','saleId', saleId);
  const pays = await DB.byIndex('payments','saleId', saleId);
  const refunds = state.refunds.filter(r=>r.saleId===saleId);
  const cust = sale.customer_id ? state.customers.find(c=>c.id===sale.customer_id) : null;
  openModal({title: escapeHtml(sale.transaction_number||'Transaction'), wide:true, body:`
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;">${boSaleBadge(sale.status)}
      <span class="tag-pill">${fmtDate(sale.transaction_date)} ${new Date(sale.transaction_date).toLocaleTimeString()}</span>
      <span class="tag-pill">Cashier: ${escapeHtml(sale.cashier||'')}</span>
      ${cust?`<span class="tag-pill">Customer: ${escapeHtml(cust.nickname)}</span>`:''}</div>
    <div class="table-wrap" style="box-shadow:none;"><table><thead><tr><th>Item</th><th>Qty</th><th>Unit</th><th>Total</th></tr></thead><tbody>
      ${items.map(i=>`<tr><td><b>${escapeHtml(i.name)}</b>${(i.modifiers||[]).length?`<div class="text-light" style="font-size:12px;">${i.modifiers.map(m=>escapeHtml(m.label)).join(', ')}</div>`:''}</td><td>${i.quantity}</td><td>${fmtMoney(i.unit_price)}</td><td>${fmtMoney(i.line_total)}</td></tr>`).join('') || '<tr><td colspan="4" class="text-light">No lines loaded.</td></tr>'}
    </tbody></table></div>
    <div style="margin-top:12px;font-size:13.5px;line-height:1.8;">
      <div>Subtotal <b>${fmtMoney(sale.subtotal)}</b> · Discount <b>${fmtMoney(sale.discount_amount)}</b> · Tax <b>${fmtMoney(sale.tax_amount)}</b> · Service <b>${fmtMoney(sale.service_charge_amount)}</b></div>
      <div style="font-size:16px;">Total <b>${fmtMoney(sale.grand_total)}</b></div>
      ${pays.map(p=>`<div>Paid by <b>${escapeHtml(p.method)}</b> ${fmtMoney(p.amount)}${p.reference?` · ref ${escapeHtml(p.reference)}`:''}</div>`).join('')}
      ${refunds.map(r=>`<div class="text-red">${escapeHtml(r.type.replace(/_/g,' '))} ${fmtMoney(r.amount)} on ${fmtDate(r.date)} — ${escapeHtml(r.reason||'')} (approved by ${escapeHtml(r.approved_by||'')})</div>`).join('')}
    </div>
    <p class="hint">Refunds and voids are done at the counter (Front Office → Sales History) with a manager PIN.</p>`,
    foot:`<button class="btn btn-primary" data-cancel>Close</button>`,
    onMount:(root)=>{ root.querySelector('[data-cancel]').onclick = closeModal; }});
}

/* ---------- QR orders (history) ---------- */
let ordFilter = {status:'', search:''};
function renderOrdersHistory(){
  const content = document.getElementById('content');
  const open = state.orders.filter(o=>['NEW','ACCEPTED','READY'].includes(o.status)).length;
  content.innerHTML = `
    <div class="grid grid-4" style="margin-bottom:16px;">
      ${statCard('Open right now', open, 'new, preparing or ready')}
      ${statCard('QR orders today', state.orders.filter(o=> fmtDate(o.created_at)===fmtDate(new Date().toISOString())).length, '')}
      ${statCard('Completed (loaded)', state.orders.filter(o=>o.status==='COMPLETED').length, `last ${Data.DEFS.orders.window.maxDays} days + open`)}
      ${statCard('QR ordering', state.settings.qr_ordering_enabled ? 'On' : 'Off', '<a class="linklike" id="go-qr-setup">change in QR Ordering</a>')}
    </div>
    <div class="toolbar"><div class="toolbar-left">
      <div class="search-box"><input type="text" id="ord-search" placeholder="Order #, customer or table…" value="${escapeHtml(ordFilter.search)}"></div>
      <select class="filter" id="ord-status"><option value="">All statuses</option>${['NEW','ACCEPTED','READY','COMPLETED','REJECTED','CANCELLED'].map(s=>`<option ${ordFilter.status===s?'selected':''} value="${s}">${s.toLowerCase()}</option>`).join('')}</select>
    </div><div class="text-light" style="font-size:13px;">The live queue is on the counter tablet (Front Office → QR Orders).</div></div>
    <div id="ord-wrap"></div>`;
  document.getElementById('go-qr-setup').onclick = ()=> navigate('qr');
  document.getElementById('ord-search').oninput = (e)=>{ ordFilter.search = e.target.value; renderOrdersTable(); };
  document.getElementById('ord-status').onchange = (e)=>{ ordFilter.status = e.target.value; renderOrdersTable(); };
  renderOrdersTable();
}
function orderStatusBadge(s){
  const map = {NEW:'badge-yellow', ACCEPTED:'badge-yellow', READY:'badge-green', COMPLETED:'badge-green', REJECTED:'badge-red', CANCELLED:'badge-gray'};
  const label = {NEW:'New', ACCEPTED:'Preparing', READY:'Ready', COMPLETED:'Completed', REJECTED:'Rejected', CANCELLED:'Cancelled'};
  return `<span class="badge ${map[s]||'badge-gray'}">${label[s]||escapeHtml(s)}</span>`;
}
function renderOrdersTable(){
  const wrap = document.getElementById('ord-wrap');
  let list = state.orders.slice().sort((a,b)=> String(b.created_at).localeCompare(String(a.created_at)));
  if(ordFilter.status) list = list.filter(o=>o.status===ordFilter.status);
  if(ordFilter.search){ const q = ordFilter.search.toLowerCase(); list = list.filter(o=> [o.order_number,o.customer_name,o.table_label].some(v=> String(v||'').toLowerCase().includes(q))); }
  if(!list.length){ wrap.innerHTML = emptyBlock('No QR orders yet.'); return; }
  wrap.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Order</th><th>Placed</th><th>Customer</th><th>Table</th><th>Items</th><th>Subtotal</th><th>Status</th></tr></thead><tbody>
    ${list.map(o=>`<tr class="clickable" data-order="${o.id}"><td><b>${escapeHtml(o.order_number)}</b></td><td>${fmtDate(o.created_at)} ${new Date(o.created_at).toLocaleTimeString('en-PH',{hour:'numeric',minute:'2-digit'})}</td>
      <td>${escapeHtml(o.customer_name||'—')}</td><td>${escapeHtml(o.table_label||'')} ${o.order_type==='TAKEAWAY'?'<span class="badge badge-gray">Take-away</span>':''}</td>
      <td>${o.item_count}</td><td>${fmtMoney(o.subtotal)}</td><td>${orderStatusBadge(o.status)}</td></tr>`).join('')}
  </tbody></table></div>`;
  wrap.querySelectorAll('[data-order]').forEach(tr=> tr.onclick = ()=> openOrderModal(tr.dataset.order));
}
function openOrderModal(orderId){
  const o = state.orders.find(x=>x.id===orderId);
  if(!o) return;
  const items = state.orderItems.filter(i=>i.orderId===orderId);
  const sale = o.sale_id ? state.sales.find(s=>s.id===o.sale_id) : null;
  openModal({title:`QR order ${escapeHtml(o.order_number)}`, body:`
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;">${orderStatusBadge(o.status)}<span class="tag-pill">${escapeHtml(o.table_label||'')}</span><span class="tag-pill">${o.order_type==='TAKEAWAY'?'Take-away':'Dine-in'}</span><span class="tag-pill">${escapeHtml(o.customer_name||'')}</span></div>
    ${items.map(i=>`<div style="padding:6px 0;border-bottom:1px solid var(--beige);"><b>${i.quantity} × ${escapeHtml(i.name)}</b> <span style="float:right;">${fmtMoney(i.line_total)}</span>
      ${(i.modifiers||[]).length?`<div class="text-light" style="font-size:12px;">${i.modifiers.map(m=>escapeHtml(m.label)).join(', ')}</div>`:''}${i.note?`<div style="font-size:12px;">Note: ${escapeHtml(i.note)}</div>`:''}</div>`).join('')}
    ${o.note?`<p style="margin-top:10px;"><b>Order note:</b> ${escapeHtml(o.note)}</p>`:''}
    <p style="margin-top:10px;font-size:13px;line-height:1.7;">Placed ${new Date(o.created_at).toLocaleString()}${o.accepted_at?`<br>Accepted ${new Date(o.accepted_at).toLocaleTimeString()}`:''}${o.ready_at?`<br>Ready ${new Date(o.ready_at).toLocaleTimeString()}`:''}${o.completed_at?`<br>Completed ${new Date(o.completed_at).toLocaleTimeString()}`:''}${o.status_reason?`<br>Reason: ${escapeHtml(o.status_reason)}`:''}${o.handled_by_name?`<br>Handled by ${escapeHtml(o.handled_by_name)}`:''}</p>
    ${sale?`<p><a class="linklike" id="ord-sale">Rung up as ${escapeHtml(sale.transaction_number)} (${fmtMoney(sale.grand_total)}) →</a></p>`:''}`,
    foot:`<button class="btn btn-primary" data-cancel>Close</button>`,
    onMount:(root)=>{ root.querySelector('[data-cancel]').onclick = closeModal; const l = root.querySelector('#ord-sale'); if(l) l.onclick = ()=> openSaleModal(sale.id); }});
}

/* ---------- Customers (loyalty groundwork) ---------- */
let custFilter = {search:'', sort:'last'};
function renderCustomers(){
  const content = document.getElementById('content');
  const active = state.customers.filter(c=>!c.merged_into);
  const returning = active.filter(c=> (c.visit_count||0) >= 2).length;
  const withPhone = active.filter(c=> c.phone).length;
  content.innerHTML = `
    <div class="grid grid-4" style="margin-bottom:16px;">
      ${statCard('Customers', active.length, 'signed up by QR or at the counter')}
      ${statCard('Returning', returning, 'visited on 2 or more days')}
      ${statCard('With mobile number', withPhone, 'can recover their account')}
      ${statCard('Spent by customers', fmtMoney(active.reduce((s,c)=>s+Number(c.total_spent||0),0)), 'after refunds')}
    </div>
    <div class="toolbar"><div class="toolbar-left">
      <div class="search-box"><input type="text" id="cust-search" placeholder="Nickname or mobile…" value="${escapeHtml(custFilter.search)}"></div>
      <select class="filter" id="cust-sort">
        <option value="last" ${custFilter.sort==='last'?'selected':''}>Sort: last visit</option>
        <option value="visits" ${custFilter.sort==='visits'?'selected':''}>Sort: most visits</option>
        <option value="spent" ${custFilter.sort==='spent'?'selected':''}>Sort: most spent</option>
        <option value="new" ${custFilter.sort==='new'?'selected':''}>Sort: newest</option>
      </select>
    </div><div class="text-light" style="font-size:13px;">Points and stamp rewards can be built on these numbers later.</div></div>
    <div id="cust-wrap"></div>`;
  document.getElementById('cust-search').oninput = (e)=>{ custFilter.search = e.target.value; renderCustomersTable(); };
  document.getElementById('cust-sort').onchange = (e)=>{ custFilter.sort = e.target.value; renderCustomersTable(); };
  renderCustomersTable();
}
function renderCustomersTable(){
  const wrap = document.getElementById('cust-wrap');
  let list = state.customers.filter(c=>!c.merged_into);
  if(custFilter.search){
    const q = custFilter.search.toLowerCase(), digits = custFilter.search.replace(/\D/g,'');
    list = list.filter(c=> (c.nickname||'').toLowerCase().includes(q) || (digits.length>=3 && String(c.phone||'').includes(digits)));
  }
  const sorters = {
    last:(a,b)=> String(b.last_visit_at||b.created_at).localeCompare(String(a.last_visit_at||a.created_at)),
    visits:(a,b)=> (b.visit_count||0)-(a.visit_count||0), spent:(a,b)=> Number(b.total_spent||0)-Number(a.total_spent||0),
    new:(a,b)=> String(b.created_at).localeCompare(String(a.created_at)),
  };
  list.sort(sorters[custFilter.sort]);
  if(!list.length){ wrap.innerHTML = emptyBlock('No customers yet. They appear here when someone enters a nickname on the QR order page, or when you add one at the counter.'); return; }
  wrap.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Nickname</th><th>Mobile</th><th>Visits</th><th>Orders</th><th>Total spent</th><th>Last visit</th><th>Joined</th></tr></thead><tbody>
    ${list.slice(0,500).map(c=>`<tr class="clickable" data-cust="${c.id}"><td><b>${escapeHtml(c.nickname)}</b></td><td>${c.phone?escapeHtml(formatPhone(c.phone)):'<span class="text-light">—</span>'}</td>
      <td>${c.visit_count||0}</td><td>${c.order_count||0}</td><td>${fmtMoney(c.total_spent)}</td><td>${c.last_visit_at?fmtDate(c.last_visit_at):'—'}</td><td>${fmtDate(c.created_at)}</td></tr>`).join('')}
  </tbody></table></div>`;
  wrap.querySelectorAll('[data-cust]').forEach(tr=> tr.onclick = ()=> openCustomerModal(tr.dataset.cust));
}
function openCustomerModal(id){
  const c = state.customers.find(x=>x.id===id);
  if(!c) return;
  const sales = state.sales.filter(s=>s.customer_id===id).sort((a,b)=> String(b.transaction_date).localeCompare(String(a.transaction_date)));
  const others = state.customers.filter(x=> x.id!==id && !x.merged_into).sort((a,b)=> a.nickname.localeCompare(b.nickname));
  openModal({title: escapeHtml(c.nickname), wide:true, body:`
    <div class="grid grid-4" style="margin-bottom:14px;">${statCard('Visits', c.visit_count||0,'days with a purchase')}${statCard('Orders', c.order_count||0,'')}${statCard('Total spent', fmtMoney(c.total_spent),'')}${statCard('Member since', fmtDate(c.created_at),'')}</div>
    <div class="form-grid">
      <div class="form-row"><label>Nickname</label><input id="cu-nick" maxlength="30" value="${escapeHtml(c.nickname)}"></div>
      <div class="form-row"><label>Mobile number</label><input id="cu-phone" inputmode="tel" value="${escapeHtml(c.phone?formatPhone(c.phone):'')}" placeholder="0917 123 4567"></div>
    </div>
    <div class="form-row"><label>Notes (staff only)</label><textarea id="cu-notes" rows="2" placeholder="e.g. Likes oat milk">${escapeHtml(c.notes||'')}</textarea></div>
    <div class="section-title" style="font-size:15px;">Recent purchases (loaded history)</div>
    ${sales.length? `<div class="table-wrap" style="box-shadow:none;"><table><thead><tr><th>Date</th><th>Transaction</th><th>Total</th><th>Status</th></tr></thead><tbody>${sales.slice(0,15).map(s=>`<tr><td>${fmtDate(s.transaction_date)}</td><td>${escapeHtml(s.transaction_number)}</td><td>${fmtMoney(s.grand_total)}</td><td>${boSaleBadge(s.status)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="hint">No purchases in the loaded history.</p>'}
    <div class="section-title" style="font-size:15px;">Duplicate account?</div>
    <p class="hint">If the same person signed up twice (new phone, cleared browser), merge the other account into this one. Their visits, orders and phone links move here.</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap;"><select class="filter" id="cu-merge"><option value="">Choose the duplicate…</option>${others.map(o=>`<option value="${o.id}">${escapeHtml(o.nickname)}${o.phone?' · '+escapeHtml(formatPhone(o.phone)):''} · ${o.visit_count||0} visits</option>`).join('')}</select>
      <button class="btn btn-outline btn-sm" id="cu-merge-btn">Merge into ${escapeHtml(c.nickname)}</button></div>`,
    foot:`<button class="btn btn-outline" data-cancel>Close</button><button class="btn btn-primary" id="cu-save">Save</button>`,
    onMount:(root)=>{
      root.querySelector('[data-cancel]').onclick = closeModal;
      root.querySelector('#cu-save').onclick = async ()=>{
        const nick = root.querySelector('#cu-nick').value.trim();
        const rawPhone = root.querySelector('#cu-phone').value.trim();
        const phone = rawPhone ? normalizePhone(rawPhone) : null;
        if(!nick){ toast('Enter a nickname','error'); return; }
        if(rawPhone && !phone){ toast('Check the mobile number','error'); return; }
        if(phone && state.customers.some(x=> x.id!==c.id && !x.merged_into && x.phone===phone)){ toast('Another customer already has that number — merge them instead','error'); return; }
        await DB.put('customers', Object.assign(c, {nickname:nick, phone, notes: root.querySelector('#cu-notes').value}));
        await logAudit('Customer updated', BO.actorName(), nick, c.id);
        closeModal(); toast('Customer saved'); renderCustomersTable();
      };
      root.querySelector('#cu-merge-btn').onclick = async ()=>{
        const other = root.querySelector('#cu-merge').value;
        if(!other){ toast('Choose the duplicate account first','error'); return; }
        const o = state.customers.find(x=>x.id===other);
        const ok = await confirmDialog(`Merge "${escapeHtml(o.nickname)}" into "${escapeHtml(c.nickname)}"? This cannot be undone.`);
        if(!ok) return;
        const res = await Data.rpc('merge_customers', {p_keep: c.id, p_merge: other});
        if(rpcFailed(res)){ toast(rpcMessage(res),'error'); return; }
        await logAudit('Customers merged', BO.actorName(), `${o.nickname} → ${c.nickname}`, c.id);
        await Data.refresh({fullMasters:true});
        closeModal(); toast('Customers merged'); renderCustomers();
      };
    }});
}

/* ---------- Staff & PINs ---------- */
async function renderStaff(){
  const content = document.getElementById('content');
  content.innerHTML = `<div class="empty-state">Loading…</div>`;
  let pinStatus = [];
  try{ pinStatus = await Data.rpc('staff_pin_status'); }catch(e){ toast(friendlyError(e),'error'); }
  const hasPin = new Set((pinStatus||[]).map(p=>p.staff_id));
  const staff = state.users.slice().sort((a,b)=> (a.active===false)-(b.active===false) || a.name.localeCompare(b.name));
  const admins = state.profiles.slice().sort((a,b)=> String(a.name).localeCompare(String(b.name)));
  content.innerHTML = `
    <div class="settings-block" style="max-width:980px;">
      <div class="section-title" style="margin-top:0;">Counter staff</div>
      <p class="hint" style="margin-bottom:10px;">Everyone who uses the counter tablet signs in with a 4–6 digit PIN. PINs are checked by the server and stored scrambled. <b>Cashiers</b> sell; <b>managers</b> can also approve discounts, refunds and voids; <b>admins</b> can do everything at the counter.</p>
      <div class="table-wrap"><table><thead><tr><th>Name</th><th>Role</th><th>PIN</th><th>Back Office login</th><th>Status</th><th></th></tr></thead><tbody>
        ${staff.map(u=>`<tr><td><b>${escapeHtml(u.name)}</b>${u.profile_id===BO.profile.id?' <span class="text-light">(you)</span>':''}</td><td>${escapeHtml(u.role)}</td>
          <td>${hasPin.has(u.id)?'<span class="badge badge-green">Set</span>':'<span class="badge badge-yellow">Not set</span>'}</td>
          <td>${u.profile_id?'✓':'—'}</td>
          <td>${u.active!==false?'<span class="badge badge-green">Active</span>':'<span class="badge badge-gray">Inactive</span>'}</td>
          <td style="white-space:nowrap;"><button class="btn btn-sm btn-ghost" data-pin="${u.id}">${hasPin.has(u.id)?'Change PIN':'Set PIN'}</button>
            <button class="btn btn-sm btn-ghost" data-edit-staff="${u.id}">Edit</button>
            <button class="btn btn-sm btn-ghost" data-toggle-staff="${u.id}">${u.active!==false?'Deactivate':'Reactivate'}</button></td></tr>`).join('')}
      </tbody></table></div>
      <button class="btn btn-primary btn-sm" id="add-staff" style="margin-top:12px;">+ Add staff member</button>

      <div class="section-title">Back Office logins (admins)</div>
      <p class="hint" style="margin-bottom:10px;">Only admins can open the Back Office. To add a co-owner or another admin, create an invite code and send it to them.</p>
      <div class="table-wrap"><table><thead><tr><th>Name</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>
        ${admins.map(p=>`<tr><td><b>${escapeHtml(p.name||'')}</b>${p.id===BO.profile.id?' <span class="text-light">(you)</span>':''}</td><td>${escapeHtml(p.role)}</td>
          <td>${p.active!==false?'<span class="badge badge-green">Active</span>':'<span class="badge badge-gray">Blocked</span>'}</td>
          <td>${p.id!==BO.profile.id?`<button class="btn btn-sm btn-ghost" data-toggle-profile="${p.id}">${p.active!==false?'Block':'Unblock'}</button>`:''}</td></tr>`).join('')}
      </tbody></table></div>
      <button class="btn btn-outline btn-sm" id="invite-admin" style="margin-top:12px;">Create admin invite code</button>
    </div>`;
  content.querySelector('#add-staff').onclick = ()=> openStaffForm(null);
  content.querySelectorAll('[data-edit-staff]').forEach(b=> b.onclick = ()=> openStaffForm(b.dataset.editStaff));
  content.querySelectorAll('[data-pin]').forEach(b=> b.onclick = ()=> openSetPinModal(b.dataset.pin));
  content.querySelectorAll('[data-toggle-staff]').forEach(b=> b.onclick = async ()=>{
    const u = state.users.find(x=>x.id===b.dataset.toggleStaff);
    if(u.profile_id===BO.profile.id && u.active!==false){ const ok = await confirmDialog('This is your own counter login. Deactivate it?'); if(!ok) return; }
    u.active = u.active===false;
    await DB.put('users', u);
    await logAudit(u.active?'Staff reactivated':'Staff deactivated', BO.actorName(), u.name, u.id);
    renderStaff();
  });
  content.querySelectorAll('[data-toggle-profile]').forEach(b=> b.onclick = async ()=>{
    const p = state.profiles.find(x=>x.id===b.dataset.toggleProfile);
    const ok = await confirmDialog(p.active!==false ? `Block ${escapeHtml(p.name)} from the Back Office?` : `Allow ${escapeHtml(p.name)} back into the Back Office?`);
    if(!ok) return;
    p.active = p.active===false;
    await DB.put('profiles', p);
    await logAudit(p.active?'Admin unblocked':'Admin blocked', BO.actorName(), p.name, p.id);
    renderStaff();
  });
  content.querySelector('#invite-admin').onclick = async ()=>{
    const res = await Data.rpc('create_staff_invite', {p_role:'ADMIN'});
    if(rpcFailed(res)){ toast(rpcMessage(res),'error'); return; }
    await logAudit('Admin invite created', BO.actorName(), 'expires '+fmtDate(res.expires_at));
    openModal({title:'Admin invite code', body:`
      <p>Send this code to the person you want to add as an admin. It works once and expires on <b>${fmtDate(res.expires_at)}</b>.</p>
      <div class="big-code">${escapeHtml(res.code.slice(0,5))}-${escapeHtml(res.code.slice(5))}</div>
      <ol class="hint" style="line-height:1.8;padding-left:18px;"><li>They open <b>${escapeHtml(siteBaseUrl())}backoffice/</b></li><li>Tap <b>“Have an invite code?”</b></li><li>Enter the code, their name, email and a password.</li></ol>`,
      foot:`<button class="btn btn-primary" data-cancel>Done</button>`, onMount:(root)=> root.querySelector('[data-cancel]').onclick = closeModal});
  };
}
function openStaffForm(id){
  const u = id ? state.users.find(x=>x.id===id) : null;
  openModal({title: u?'Edit staff member':'Add staff member', body:`
    <div class="form-row"><label>Name</label><input id="sf-name" value="${escapeHtml(u?u.name:'')}" placeholder="e.g. Maria Santos"></div>
    <div class="form-row"><label>Role</label><select id="sf-role">${['CASHIER','MANAGER','ADMIN'].map(r=>`<option value="${r}" ${u&&u.role===r?'selected':''}>${r[0]+r.slice(1).toLowerCase()}</option>`).join('')}</select></div>
    ${u?'':`<div class="form-row"><label>PIN (4–6 digits)</label><input id="sf-pin" type="password" inputmode="numeric" maxlength="6" autocomplete="off"><div class="hint">You can also set it later.</div></div>`}`,
    foot:`<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" id="sf-save">${u?'Save':'Add'}</button>`,
    onMount:(root)=>{
      root.querySelector('[data-cancel]').onclick = closeModal;
      root.querySelector('#sf-save').onclick = async ()=>{
        const name = root.querySelector('#sf-name').value.trim();
        const role = root.querySelector('#sf-role').value;
        const pin = u ? '' : root.querySelector('#sf-pin').value.trim();
        if(!name){ toast('Enter a name','error'); return; }
        if(pin && !/^\d{4,6}$/.test(pin)){ toast('PIN must be 4 to 6 digits','error'); return; }
        const rec = u || {id: uid(), active:true, created_at: new Date().toISOString()};
        rec.name = name; rec.role = role;
        await DB.put('users', rec);
        if(pin){
          const res = await Data.rpc('set_staff_pin', {p_staff: rec.id, p_pin: pin});
          if(rpcFailed(res)){ toast(rpcMessage(res),'error'); closeModal(); renderStaff(); return; }
        }
        await logAudit(u?'Staff updated':'Staff created', BO.actorName(), `${name} (${role})`, rec.id);
        closeModal(); toast(u?'Saved':'Staff member added'); renderStaff();
      };
    }});
}
function openSetPinModal(staffId){
  const u = state.users.find(x=>x.id===staffId);
  openModal({title:`PIN for ${escapeHtml(u.name)}`, body:`
    <div class="form-row"><label>New PIN (4–6 digits)</label><input id="sp-pin" type="password" inputmode="numeric" maxlength="6" autocomplete="off"></div>
    <div class="form-row"><label>Type it again</label><input id="sp-pin2" type="password" inputmode="numeric" maxlength="6" autocomplete="off"></div>
    <p class="hint">Each person needs a different PIN, because the PIN alone tells the counter who is signing in.</p>`,
    foot:`<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" id="sp-save">Save PIN</button>`,
    onMount:(root)=>{
      root.querySelector('[data-cancel]').onclick = closeModal;
      root.querySelector('#sp-save').onclick = async ()=>{
        const a = root.querySelector('#sp-pin').value.trim(), b = root.querySelector('#sp-pin2').value.trim();
        if(!/^\d{4,6}$/.test(a)){ toast('PIN must be 4 to 6 digits','error'); return; }
        if(a!==b){ toast('The two PINs do not match','error'); return; }
        const res = await Data.rpc('set_staff_pin', {p_staff: staffId, p_pin: a});
        if(rpcFailed(res)){ toast(rpcMessage(res),'error'); return; }
        await logAudit('PIN set', BO.actorName(), u.name, u.id);
        closeModal(); toast('PIN saved'); renderStaff();
      };
    }});
}

/* ---------- Devices ---------- */
function renderDevices(){
  const content = document.getElementById('content');
  const list = state.devices.slice().sort((a,b)=> (b.active===true)-(a.active===true) || String(a.device_tag).localeCompare(String(b.device_tag)));
  const staffName = (id)=> (state.users.find(u=>u.id===id)||{}).name;
  content.innerHTML = `
    <div class="settings-block" style="max-width:980px;">
      <p class="hint" style="margin-bottom:12px;">A counter tablet (or phone/laptop) is paired once with a one-time code. After that, staff only need their PIN. Each device gets a letter used in its receipt numbers (POS-<b>A</b>-2026-000123), so two counters never clash.</p>
      <div class="table-wrap"><table><thead><tr><th>Letter</th><th>Name</th><th>Paired</th><th>Last seen</th><th>Signed in</th><th>Status</th><th></th></tr></thead><tbody>
        ${list.length? list.map(d=>`<tr><td><b>${escapeHtml(d.device_tag||'')}</b></td><td>${escapeHtml(d.device_name||'')}</td><td>${d.paired_at?fmtDate(d.paired_at):'—'}</td>
          <td>${d.last_seen_at? new Date(d.last_seen_at).toLocaleString('en-PH',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}) : '—'}</td>
          <td>${escapeHtml(staffName(d.current_staff_id)||'—')}</td>
          <td>${d.active?'<span class="badge badge-green">Active</span>':'<span class="badge badge-gray">Removed</span>'}</td>
          <td style="white-space:nowrap;">${d.active?`<button class="btn btn-sm btn-ghost" data-rename="${d.id}">Rename</button><button class="btn btn-sm btn-ghost" data-remove="${d.id}">Remove</button>`:''}</td></tr>`).join('')
          : `<tr><td colspan="7" class="text-light" style="padding:18px;">No devices yet.</td></tr>`}
      </tbody></table></div>
      <button class="btn btn-primary" id="pair-new" style="margin-top:14px;">+ Pair a counter device</button>
    </div>`;
  content.querySelector('#pair-new').onclick = openPairingModal;
  content.querySelectorAll('[data-remove]').forEach(b=> b.onclick = async ()=>{
    const d = state.devices.find(x=>x.id===b.dataset.remove);
    const ok = await confirmDialog(`Remove “${escapeHtml(d.device_name)}”? It will stop working until it is paired again. Sales it hasn't uploaded yet (if it is offline) will be lost.`);
    if(!ok) return;
    Object.assign(d, {active:false, auth_user_id:null, current_staff_id:null});
    await DB.put('devices', d);
    await logAudit('Device removed', BO.actorName(), d.device_name, d.id);
    renderDevices();
  });
  content.querySelectorAll('[data-rename]').forEach(b=> b.onclick = ()=>{
    const d = state.devices.find(x=>x.id===b.dataset.rename);
    openModal({title:'Rename device', body:`<div class="form-row"><label>Name</label><input id="dv-name" value="${escapeHtml(d.device_name||'')}"></div>`,
      foot:`<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" id="dv-save">Save</button>`,
      onMount:(root)=>{ root.querySelector('[data-cancel]').onclick = closeModal;
        root.querySelector('#dv-save').onclick = async ()=>{ d.device_name = root.querySelector('#dv-name').value.trim() || d.device_name; await DB.put('devices', d); closeModal(); renderDevices(); }; }});
  });
}
function openPairingModal(){
  openModal({title:'Pair a counter device', body:`
    <div class="form-row"><label>Device name</label><input id="pd-name" placeholder="e.g. Front counter iPad"></div>
    <div id="pd-result"></div>`,
    foot:`<button class="btn btn-outline" data-cancel>Close</button><button class="btn btn-primary" id="pd-make">Get pairing code</button>`,
    onMount:(root)=>{
      root.querySelector('[data-cancel]').onclick = ()=>{ closeModal(); Data.refresh({fullMasters:true}).then(()=>{ if(state.route==='devices') renderDevices(); }); };
      root.querySelector('#pd-make').onclick = async ()=>{
        const res = await Data.rpc('create_pairing_code', {p_device_name: root.querySelector('#pd-name').value.trim() || null});
        if(rpcFailed(res)){ toast(rpcMessage(res),'error'); return; }
        await logAudit('Pairing code created', BO.actorName(), root.querySelector('#pd-name').value.trim());
        root.querySelector('#pd-result').innerHTML = `
          <div class="big-code">${escapeHtml(res.code.slice(0,4))}-${escapeHtml(res.code.slice(4))}</div>
          <ol class="hint" style="line-height:1.8;padding-left:18px;">
            <li>On the tablet, open <b>${escapeHtml(siteBaseUrl())}frontoffice/</b></li>
            <li>Type this code and tap <b>Pair</b>.</li>
            <li>The code works once and expires at <b>${new Date(res.expires_at).toLocaleTimeString('en-PH',{hour:'numeric',minute:'2-digit'})}</b>.</li></ol>`;
        root.querySelector('#pd-make').textContent = 'Make another code';
      };
    }});
}

/* ---------- QR ordering setup ---------- */
function renderQrSetup(){
  const content = document.getElementById('content');
  const s = state.settings;
  const tables = state.diningTables.slice().sort((a,b)=> (a.kind==='TAKEAWAY')-(b.kind==='TAKEAWAY') || (a.sort_order||0)-(b.sort_order||0) || a.label.localeCompare(b.label, undefined, {numeric:true}));
  const menu = state.recipes.filter(r=> r.active!==false && Number(r.selling_price)>0).sort((a,b)=> posCategoryLabel(a).localeCompare(posCategoryLabel(b)) || a.name.localeCompare(b.name));
  const base = siteBaseUrl();
  content.innerHTML = `
    <div class="settings-block" style="max-width:1000px;">
      <div class="section-title" style="margin-top:0;">Phone ordering</div>
      <div class="card">
        <div class="toggle-row"><span><b>Take QR orders</b><br><span class="hint">When off, customers can still see the menu but can't order.</span></span><label class="switch"><input type="checkbox" id="qr-on" ${s.qr_ordering_enabled?'checked':''}><span class="slider-tog"></span></label></div>
        <div class="toggle-row"><span><b>Hide items that are out of stock</b><br><span class="hint">Uses your ingredient stock. Leave off unless you record purchases and stock counts regularly.</span></span><label class="switch"><input type="checkbox" id="qr-hide" ${s.qr_hide_out_of_stock?'checked':''}><span class="slider-tog"></span></label></div>
        <div class="form-row" style="margin-top:12px;"><label>Welcome message (optional)</label><input id="qr-welcome" maxlength="140" value="${escapeHtml(s.qr_welcome_text||'')}" placeholder="e.g. Order from your table — we'll bring it over!"></div>
        <div class="form-grid">
          <div class="form-row"><label>Message when ordering is off</label><input id="qr-closed" maxlength="160" value="${escapeHtml(s.qr_closed_message||'')}"></div>
          <div class="form-row"><label>Payment note shown to customers</label><input id="qr-pay" maxlength="120" value="${escapeHtml(s.qr_pay_note||'')}"></div>
        </div>
        <div class="form-row" style="max-width:260px;"><label>Most open orders per customer</label><input type="number" min="1" max="10" id="qr-max" value="${s.qr_max_open_orders||3}"><div class="hint">Stops pranks and accidental repeat orders.</div></div>
        <button class="btn btn-primary btn-sm" id="qr-save">Save</button>
      </div>

      <div class="section-title">Tables & QR codes</div>
      <div class="card">
        <p class="hint" style="margin-top:0;">Each table gets its own QR code, so orders arrive with the table number. Add one <b>Take-away / pickup</b> code for the counter too. If a QR code is ever misused, use “New code” to replace it.</p>
        <div class="table-wrap" style="box-shadow:none;"><table><thead><tr><th>Name</th><th>Type</th><th>Code</th><th>Status</th><th></th></tr></thead><tbody>
          ${tables.length? tables.map(t=>`<tr><td><b>${escapeHtml(t.label)}</b></td><td>${t.kind==='TAKEAWAY'?'Take-away':'Table'}</td><td class="mono">${escapeHtml(t.code)}</td>
            <td>${t.active?'<span class="badge badge-green">Active</span>':'<span class="badge badge-gray">Off</span>'}</td>
            <td style="white-space:nowrap;"><button class="btn btn-sm btn-ghost" data-open-qr="${t.id}">Open link</button><button class="btn btn-sm btn-ghost" data-recode="${t.id}">New code</button><button class="btn btn-sm btn-ghost" data-toggle-table="${t.id}">${t.active?'Turn off':'Turn on'}</button></td></tr>`).join('')
            : `<tr><td colspan="5" class="text-light" style="padding:14px;">No tables yet.</td></tr>`}
        </tbody></table></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;">
          <button class="btn btn-primary btn-sm" id="add-tables">+ Add tables</button>
          <button class="btn btn-outline btn-sm" id="add-takeaway">+ Add take-away code</button>
          <button class="btn btn-amber btn-sm" id="print-qr" ${tables.some(t=>t.active)?'':'disabled'}>🖨 Print QR codes</button>
        </div>
        <p class="hint">Customer page: <span class="mono">${escapeHtml(base)}order/</span></p>
      </div>

      <div class="section-title">Menu on the QR page</div>
      <div class="card">
        <p class="hint" style="margin-top:0;">Every recipe with a selling price can appear. Turn items off here, or mark them sold out for the day. Descriptions, photos and options (size, milk, extra shot) are edited in <a class="linklike" id="go-recipes">Recipes</a>.</p>
        <div class="table-wrap" style="box-shadow:none;"><table><thead><tr><th>Item</th><th>Category</th><th>Price</th><th>Options</th><th>On QR menu</th><th>Sold out</th></tr></thead><tbody>
          ${menu.length? menu.map(r=>`<tr><td><b>${escapeHtml(r.name)}</b>${r.pos_visible===false?' <span class="badge badge-gray">hidden at counter</span>':''}</td><td>${escapeHtml(posCategoryLabel(r))}</td><td>${fmtMoney(r.selling_price)}</td>
            <td>${(r.modifierGroups||[]).length? (r.modifierGroups||[]).map(g=>escapeHtml(g.name)).join(', ') : '<span class="text-light">—</span>'}</td>
            <td><label class="switch"><input type="checkbox" data-qrvis="${r.id}" ${r.qr_visible!==false?'checked':''}><span class="slider-tog"></span></label></td>
            <td><label class="switch"><input type="checkbox" data-soldout="${r.id}" ${r.sold_out?'checked':''}><span class="slider-tog"></span></label></td></tr>`).join('')
            : `<tr><td colspan="6" class="text-light" style="padding:14px;">No recipes with a selling price yet.</td></tr>`}
        </tbody></table></div>
      </div>
    </div>`;
  content.querySelector('#go-recipes').onclick = ()=> navigate('recipes');
  content.querySelector('#qr-save').onclick = async ()=>{
    Object.assign(s, {
      qr_ordering_enabled: content.querySelector('#qr-on').checked,
      qr_hide_out_of_stock: content.querySelector('#qr-hide').checked,
      qr_welcome_text: content.querySelector('#qr-welcome').value.trim(),
      qr_closed_message: content.querySelector('#qr-closed').value.trim(),
      qr_pay_note: content.querySelector('#qr-pay').value.trim(),
      qr_max_open_orders: Math.max(1, Math.min(10, Number(content.querySelector('#qr-max').value)||3)),
    });
    await DB.put('settings', s);
    await logAudit('QR settings saved', BO.actorName(), s.qr_ordering_enabled?'ordering on':'ordering off');
    toast('QR ordering settings saved');
  };
  content.querySelector('#add-tables').onclick = ()=> openAddTablesModal('TABLE');
  content.querySelector('#add-takeaway').onclick = ()=> openAddTablesModal('TAKEAWAY');
  content.querySelector('#print-qr').onclick = printQrSheet;
  content.querySelectorAll('[data-open-qr]').forEach(b=> b.onclick = ()=>{ const t = state.diningTables.find(x=>x.id===b.dataset.openQr); window.open(qrOrderUrl(t), '_blank'); });
  content.querySelectorAll('[data-toggle-table]').forEach(b=> b.onclick = async ()=>{ const t = state.diningTables.find(x=>x.id===b.dataset.toggleTable); t.active = !t.active; await DB.put('diningTables', t); renderQrSetup(); });
  content.querySelectorAll('[data-recode]').forEach(b=> b.onclick = async ()=>{
    const t = state.diningTables.find(x=>x.id===b.dataset.recode);
    const ok = await confirmDialog(`Make a new QR code for ${escapeHtml(t.label)}? The old printed code will stop working — print and replace it.`);
    if(!ok) return;
    t.code = randomTableCode(); await DB.put('diningTables', t);
    await logAudit('Table QR code replaced', BO.actorName(), t.label, t.id);
    renderQrSetup();
  });
  content.querySelectorAll('[data-qrvis]').forEach(inp=> inp.onchange = async ()=>{ const r = state.recipes.find(x=>x.id===inp.dataset.qrvis); r.qr_visible = inp.checked; await DB.put('recipes', r); toast(`${r.name}: ${inp.checked?'shown on':'hidden from'} the QR menu`); });
  content.querySelectorAll('[data-soldout]').forEach(inp=> inp.onchange = async ()=>{ const r = state.recipes.find(x=>x.id===inp.dataset.soldout); r.sold_out = inp.checked; await DB.put('recipes', r); toast(`${r.name}: ${inp.checked?'sold out':'available again'}`); });
}
function posCategoryLabel(r){ return (r.category && r.category.trim()) || recipeTypeLabel(recipeTypeOf(r)); }
function randomTableCode(){
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const b = new Uint8Array(6); crypto.getRandomValues(b);
  return [...b].map(x=> A[x % 32]).join('');
}
function qrOrderUrl(t){ return `${siteBaseUrl()}order/?b=${Data.businessId}&t=${encodeURIComponent(t.code)}`; }
function openAddTablesModal(kind){
  const existing = state.diningTables.filter(t=>t.kind==='TABLE').length;
  openModal({title: kind==='TAKEAWAY'?'Add a take-away code':'Add tables', body: kind==='TAKEAWAY' ? `
    <div class="form-row"><label>Name</label><input id="at-label" value="Take-away"></div>` : `
    <div class="form-grid"><div class="form-row"><label>From table number</label><input type="number" id="at-from" min="1" value="${existing+1}"></div>
    <div class="form-row"><label>To table number</label><input type="number" id="at-to" min="1" value="${existing+5}"></div></div>
    <p class="hint">Creates “Table ${existing+1}”, “Table ${existing+2}”… each with its own QR code.</p>`,
    foot:`<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" id="at-save">Add</button>`,
    onMount:(root)=>{
      root.querySelector('[data-cancel]').onclick = closeModal;
      root.querySelector('#at-save').onclick = async ()=>{
        let labels = [];
        if(kind==='TAKEAWAY') labels = [root.querySelector('#at-label').value.trim() || 'Take-away'];
        else {
          const a = Number(root.querySelector('#at-from').value), z = Number(root.querySelector('#at-to').value);
          if(!(a>=1 && z>=a && z-a<100)){ toast('Check the table numbers (up to 100 at a time)','error'); return; }
          for(let n=a;n<=z;n++) labels.push('Table '+n);
        }
        const recs = labels.map((label,i)=>({id: uid(), label, code: randomTableCode(), kind, active:true, sort_order: kind==='TAKEAWAY'?999:(existing+i+1), created_at:new Date().toISOString()}));
        await DB.bulkPut('diningTables', recs);
        await logAudit('Tables added', BO.actorName(), labels.join(', '));
        closeModal(); toast(`${recs.length} QR code${recs.length===1?'':'s'} created`); renderQrSetup();
      };
    }});
}
function loadQrLibrary(){
  return new Promise((resolve, reject)=>{
    if(window.qrcode) return resolve(window.qrcode);
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js';
    s.onload = ()=> window.qrcode ? resolve(window.qrcode) : reject(new Error('QR library missing'));
    s.onerror = ()=> reject(Object.assign(new Error('QR library failed'), {friendly:'Could not load the QR code maker. Check the internet connection.'}));
    document.head.appendChild(s);
  });
}
function qrSvg(text, cell){
  const q = window.qrcode(0, 'M'); q.addData(text); q.make();
  return q.createSvgTag(cell||5, 2);
}
async function printQrSheet(){
  try{ await loadQrLibrary(); }catch(e){ toast(friendlyError(e),'error'); return; }
  const tables = state.diningTables.filter(t=>t.active).sort((a,b)=> (a.kind==='TAKEAWAY')-(b.kind==='TAKEAWAY') || (a.sort_order||0)-(b.sort_order||0));
  const s = state.settings;
  const win = window.open('', '_blank');
  if(!win){ toast('Please allow pop-ups to print QR codes','error'); return; }
  win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>QR codes — ${escapeHtml(businessName()||appDisplayName())}</title>
    <style>
      body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;margin:0;padding:12mm;color:#1c110a;}
      .grid{display:grid;grid-template-columns:repeat(2,1fr);gap:8mm;}
      .card{border:1.5px solid #1c110a;border-radius:6mm;padding:7mm 6mm;text-align:center;page-break-inside:avoid;}
      .card img.logo{width:16mm;height:16mm;object-fit:contain;}
      .shop{font-size:15pt;font-weight:700;margin-top:2mm;}
      .scan{font-size:11pt;margin:2mm 0 3mm;}
      .card svg{width:52mm;height:52mm;}
      .label{font-size:20pt;font-weight:800;margin-top:2mm;}
      .hint{font-size:8.5pt;color:#555;margin-top:1mm;}
      @media print{body{padding:8mm;} .noprint{display:none;}}
    </style></head><body>
    <p class="noprint">Print on A4. Cut along the borders and place one on each table. <button onclick="print()">Print</button></p>
    <div class="grid">${tables.map(t=>`<div class="card">${s.logo?`<img class="logo" src="${s.logo}">`:''}
      <div class="shop">${escapeHtml(businessName()||appDisplayName())}</div>
      <div class="scan">${t.kind==='TAKEAWAY'?'Scan to order for pickup':'Scan to order from your table'}</div>
      ${qrSvg(qrOrderUrl(t), 5)}
      <div class="label">${escapeHtml(t.label)}</div>
      <div class="hint">Pay at the counter</div></div>`).join('')}</div>
    </body></html>`);
  win.document.close(); win.focus();
  await logAudit('QR codes printed', BO.actorName(), `${tables.length} codes`);
}

/* ---------- Audit log ---------- */
let auditSearch = '';
function renderAuditLog(){
  const content = document.getElementById('content');
  content.innerHTML = `<div class="toolbar"><div class="toolbar-left"><div class="search-box"><input id="au-search" placeholder="Search action, person or details…" value="${escapeHtml(auditSearch)}"></div></div>
    <div class="text-light" style="font-size:13px;">Last ${Data.DEFS.auditLog.window.maxDays} days. The audit log can't be edited or deleted by anyone.</div></div><div id="au-wrap"></div>`;
  const draw = ()=>{
    let list = state.auditLog.slice().sort((a,b)=> String(b.at).localeCompare(String(a.at)));
    if(auditSearch){ const q = auditSearch.toLowerCase(); list = list.filter(e=> [e.action,e.actor,e.details].some(v=> String(v||'').toLowerCase().includes(q))); }
    document.getElementById('au-wrap').innerHTML = list.length ? `<div class="table-wrap"><table><thead><tr><th>Date / time</th><th>Action</th><th>By</th><th>Details</th></tr></thead><tbody>
      ${list.slice(0,500).map(e=>`<tr><td style="white-space:nowrap;">${fmtDate(e.at)} ${new Date(e.at).toLocaleTimeString('en-PH',{hour:'numeric',minute:'2-digit'})}</td><td><b>${escapeHtml(e.action)}</b></td><td>${escapeHtml(e.actor)}</td><td class="text-light">${escapeHtml(e.details)}</td></tr>`).join('')}
    </tbody></table></div>` : emptyBlock('No entries.');
  };
  content.querySelector('#au-search').oninput = (e)=>{ auditSearch = e.target.value; draw(); };
  draw();
}

/* ---------- Import / restore ---------- */
async function openImportTool(){
  let oldLocal = null;
  try{ oldLocal = await Importer.readOldBrowserData(); }catch(e){ oldLocal = null; }
  const localSummary = oldLocal ? Importer.summarize(oldLocal) : null;
  const hasLocal = localSummary && Object.keys(localSummary.counts).length;
  openModal({title:'Import data', wide:true, body:`
    <p>Bring in data from the old Inventory / POS apps, or restore a backup made here. Importing <b>adds and updates</b> records; it never deletes anything. Running it twice with the same file is safe.</p>
    ${hasLocal ? `<div class="card" style="background:var(--beige);box-shadow:none;margin:12px 0;">
      <b>Old app data found in this browser</b>
      <div class="hint">${Object.entries(localSummary.counts).map(([k,v])=>`${v} ${escapeHtml(k)}`).join(' · ')}</div>
      <button class="btn btn-primary btn-sm" id="imp-local" style="margin-top:8px;">Use this data</button></div>` : ''}
    <div class="form-row" style="margin-top:12px;"><label>Or choose a backup file (.json)</label><input type="file" id="imp-file" accept=".json,application/json"></div>
    <div id="imp-preview"></div>`,
    foot:`<button class="btn btn-outline" data-cancel>Close</button>`,
    onMount:(root)=>{
      root.querySelector('[data-cancel]').onclick = closeModal;
      const preview = (payload)=>{
        const sum = Importer.summarize(payload);
        const rows = Object.entries(sum.counts);
        if(!rows.length){ root.querySelector('#imp-preview').innerHTML = `<p class="text-red">Nothing to import in that file.</p>`; return; }
        root.querySelector('#imp-preview').innerHTML = `
          <div class="section-title" style="font-size:15px;">What will be imported</div>
          <div class="hint" style="margin-bottom:8px;">${escapeHtml(sum.appName||'Backup')}${sum.exportedAt?' · saved '+fmtDate(sum.exportedAt):''}</div>
          <div class="table-wrap" style="box-shadow:none;"><table><tbody>${rows.map(([k,v])=>`<tr><td>${escapeHtml(k)}</td><td style="text-align:right;"><b>${v}</b></td></tr>`).join('')}</tbody></table></div>
          ${sum.hasSettings?`<label style="display:flex;gap:8px;align-items:center;margin-top:10px;"><input type="checkbox" id="imp-settings" checked style="width:16px;height:16px;"> Also bring in the shop name, logo, colours, tax and receipt settings</label>`:''}
          <div id="imp-progress" style="margin-top:12px;"></div>
          <button class="btn btn-primary" id="imp-go" style="margin-top:10px;">Import now</button>`;
        root.querySelector('#imp-go').onclick = async ()=>{
          const btn = root.querySelector('#imp-go'); btn.disabled = true; btn.textContent = 'Importing…';
          const prog = root.querySelector('#imp-progress');
          try{
            const inclSettings = root.querySelector('#imp-settings') ? root.querySelector('#imp-settings').checked : false;
            const res = await restoreFromPayloadCore(payload, (done,total,store)=>{ prog.innerHTML = `<div class="hint">Uploading ${escapeHtml(store)}… ${done} / ${total}</div><div style="height:8px;background:var(--beige);border-radius:4px;"><div style="height:8px;border-radius:4px;background:var(--green);width:${Math.round(done/Math.max(1,total)*100)}%"></div></div>`; }, inclSettings);
            await logAudit('Data imported', BO.actorName(), `${res.imported} records, ${res.skipped} skipped`);
            applyCustomTheme(); renderShell();
            prog.innerHTML = `<div class="card" style="background:#e3efe7;box-shadow:none;"><b>Done.</b> ${res.imported} records imported${res.skipped?`, ${res.skipped} skipped (they pointed at records that no longer exist)`:''}.${res.notes.map(n=>`<div class="hint">• ${escapeHtml(n)}</div>`).join('')}</div>`;
            btn.textContent = 'Imported';
          }catch(e){
            console.error(e);
            prog.innerHTML = `<p class="text-red">Import stopped: ${escapeHtml(friendlyError(e))}. Nothing is lost — fix the problem and run it again.</p>`;
            btn.disabled = false; btn.textContent = 'Try again';
          }
        };
      };
      if(hasLocal) root.querySelector('#imp-local').onclick = ()=> preview(oldLocal);
      root.querySelector('#imp-file').onchange = async (e)=>{
        const f = e.target.files[0]; if(!f) return;
        try{ const payload = JSON.parse(await f.text()); if(!payload.data) throw new Error('no data'); preview(payload); }
        catch(err){ root.querySelector('#imp-preview').innerHTML = `<p class="text-red">That file isn't a backup from this system.</p>`; }
      };
    }});
}
