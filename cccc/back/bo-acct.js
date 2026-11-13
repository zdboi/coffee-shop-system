/* =============================================================================
   Back Office — release 1.6 ("Money", Wave 4)
   - Accounting overview (B1): the money of ANY range of days, from the server's
     accounting_report (013). The Sales calendar reads the same report, so the two
     pages always agree. Replaces the month-only Net income page.
   - Senior / PWD report (B19): the only place the full ID numbers can be read.
   - Settings → Payments & discounts: the shop's payment methods with their extra
     charge (B4, B5) and the Senior / PWD discount %.
   ============================================================================= */

/* ---------- the shared report (also used by the Sales calendar) ---------- */
const ACCT_CACHE = new Map();     // 'from|to' -> {at, promise}
const ACCT_CACHE_MS = 30000;
function acctClearCache(){ ACCT_CACHE.clear(); }
// accounting_report(from, to), kept for half a minute so the pages don't ask twice.
function acctReport(from, to, opts){
  const key = from + '|' + to, hit = ACCT_CACHE.get(key);
  if(hit && !(opts && opts.fresh) && Date.now() - hit.at < ACCT_CACHE_MS) return hit.promise;
  const promise = cloud.rpc('accounting_report', {p_from: from, p_to: to});
  ACCT_CACHE.set(key, {at: Date.now(), promise});
  promise.catch(() => { if(ACCT_CACHE.get(key) && ACCT_CACHE.get(key).promise === promise) ACCT_CACHE.delete(key); });
  return promise;
}
function keyDaysBetween(a, b){ return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000); }
function signedMoney(v){ v = num(v); return (v < 0 ? '−' : '') + fmtMoney(Math.abs(v)); }

/* ================= Accounting overview ================= */
const ACCT = {preset: 'month', from: '', to: '', compare: false};
let ACCT_LAST = null;   // {from, to, r, prev}

// [label, amount (signed as it counts), kind, hint] — the screen and the CSV share these lines.
// kind: line | sub (a running total) | total | part (already inside the line above) | info
function acctLines(r){
  const t = (r && r.totals) || {};
  const L = [];
  const add = (label, v, kind, hint) => L.push([label, num(v), kind || 'line', hint || '']);
  add('Item sales (before discounts)', t.item_sales, 'line', 'Menu prices × quantities of finished sales.');
  if(num(t.discounts)) add('Discounts (approved by a manager)', -num(t.discounts));
  if(num(t.loyalty_rewards)) add('Stamp rewards', -num(t.loyalty_rewards));
  if(num(t.senior_discounts)) add('Senior / PWD discounts', -num(t.senior_discounts));
  if(num(t.vat_exempt)) add('VAT taken out for Senior / PWD', -num(t.vat_exempt));
  if(num(t.tax)) add('Tax added', t.tax);
  if(num(t.service_charge)) add('Service charge', t.service_charge);
  if(num(t.payment_charges)) add('Payment charges customers paid', t.payment_charges);
  add('Sales (what customers paid)', t.sales, 'sub');
  add('Refunds', -num(t.refunds));
  add('Net sales', t.net_sales, 'sub', 'Sales minus refunds.');
  if(num(t.tax_owed)) add('Tax collected (owed, not income)', -num(t.tax_owed));
  if(num(t.payment_fees)) add('Payment fees (the charges of your payment methods)', -num(t.payment_fees), 'line',
    'Counted on every sale by a method with a charge. When the charge was added, the customer\'s payment above cancels it out; when it was waived, the shop absorbs it.');
  if(num(t.charges_waived)) add('Of which waived (absorbed by the shop)', -num(t.charges_waived), 'part');
  add('Ingredients used for sales', -num(t.ingredients_sold));
  add('Ingredients wasted', -num(t.ingredients_wasted));
  const wr = t.waste_by_reason || {};
  Object.keys(wr).sort().forEach(k => { if(num(wr[k])) add('Of which ' + String(wasteReasonLabel(k)).toLowerCase(), -num(wr[k]), 'part'); });
  const by = t.expenses_by_category || {};
  EXPENSE_CATEGORIES.forEach(c => { if(num(by[c.id])) add('Expenses: ' + c.label, -num(by[c.id])); });
  Object.keys(by).filter(k => !EXPENSE_CATEGORIES.some(c => c.id === k)).forEach(k => { if(num(by[k])) add('Expenses: ' + k, -num(by[k])); });
  add('Net income', t.net_income, 'total');
  return L;
}
function acctRangeLabel(a, b){ return a === b ? fmtDay(a) : `${fmtDay(a)} to ${fmtDay(b)}`; }

async function renderAccounting(){
  if(!BO.has16){ renderNetIncome(); return; }       // older database: the month-only page
  const content = document.getElementById('content');
  content.innerHTML = `
    <div class="toolbar">
      <div class="toolbar-left">${rangePickerHtml(ACCT, 'ac')}
        <label class="chk" style="margin-left:6px;"><input type="checkbox" id="ac-compare" ${ACCT.compare ? 'checked' : ''}> Compare with the period before</label></div>
      <div class="field-inline"><button class="btn btn-outline btn-sm" id="ac-csv">Export CSV</button>
        <button class="btn btn-ghost btn-sm" id="ac-go-cal">Day by day →</button><button class="btn btn-ghost btn-sm" id="ac-go-exp">Expenses →</button></div>
    </div>
    <div id="ac-body"><div class="loading-line">Working it out…</div></div>`;
  wireRangePicker(content, ACCT, 'ac', () => drawAccounting());
  content.querySelector('#ac-compare').onchange = (e) => { ACCT.compare = e.target.checked; drawAccounting(); };
  content.querySelector('#ac-csv').onclick = exportAccountingCSV;
  content.querySelector('#ac-go-exp').onclick = () => navigate('expenses');
  content.querySelector('#ac-go-cal').onclick = () => {
    const [a, b] = presetKeys(ACCT.preset, ACCT);
    if(typeof calSetRange === 'function') calSetRange(a, b);
    navigate('calendar');
  };
  await drawAccounting();
}
async function drawAccounting(){
  const wrap = document.getElementById('ac-body'); if(!wrap) return;
  const [a, b] = presetKeys(ACCT.preset, ACCT);
  if(keyDaysBetween(a, b) > 400){ wrap.innerHTML = emptyBlock(esc(friendlyError({message: 'BAD_RANGE'}))); return; }
  const key = a + '|' + b + '|' + ACCT.compare;
  wrap.classList.add('dim');
  let r, prev = null;
  try{
    const len = keyDaysBetween(a, b) + 1;
    const pb = keyAddDays(a, -1), pa = keyAddDays(pb, -(len - 1));
    [r, prev] = await Promise.all([acctReport(a, b), ACCT.compare ? acctReport(pa, pb) : Promise.resolve(null)]);
  }catch(e){
    wrap.classList.remove('dim');
    wrap.innerHTML = emptyBlock(esc(friendlyError(e))); return;
  }
  const [a2, b2] = presetKeys(ACCT.preset, ACCT);
  if(state.route !== 'netIncome' || key !== a2 + '|' + b2 + '|' + ACCT.compare) return;   // the owner moved on meanwhile
  ACCT_LAST = {from: a, to: b, r, prev};
  wrap.classList.remove('dim');
  wrap.innerHTML = accountingHtml(a, b, r, prev);
  const go = (id, fn) => { const el = wrap.querySelector(id); if(el) el.onclick = fn; };
  go('#ac-senior-link', () => { SENIOR_REP.preset = ACCT.preset; SENIOR_REP.from = ACCT.from; SENIOR_REP.to = ACCT.to; navigate('seniorReport'); });
  go('#ac-pay-settings', () => { BO_SETTINGS_TAB = 'payments'; navigate('settings'); });
}
function accountingHtml(a, b, r, prev){
  const t = r.totals || {}, pt = prev ? (prev.totals || {}) : null;
  const ni = num(t.net_income);
  const lines = acctLines(r);
  const prevBy = {};
  if(prev) acctLines(prev).forEach(([label, v]) => { prevBy[label] = v; });
  const change = (now, before) => {
    if(before === undefined) return '<span class="text-light">new</span>';
    const d = now - before;
    if(Math.abs(d) < 0.005) return '<span class="text-light">same</span>';
    const pct = Math.abs(before) > 0.005 ? ` (${d > 0 ? '+' : '−'}${Math.abs(Math.round(d / Math.abs(before) * 100))}%)` : '';
    return `${d > 0 ? '+' : '−'}${fmtMoney(Math.abs(d))}${pct}`;
  };
  const items = t.items || {};
  const methods = Array.isArray(r.payment_methods) ? r.payment_methods : [];
  const waived = Array.isArray(r.waived_list) ? r.waived_list : [];
  const anyCharge = methods.some(m => num(m.fees) || num(m.charges));
  const over = num(t.cash_over_short);
  return `
    <div class="grid grid-4 kpi-sans" style="margin-bottom:16px;">
      ${statCard('Sales', fmtMoney(t.sales), plural(num(t.sale_count), 'sale') + (pt ? ' · before: ' + fmtMoney(pt.sales) : ''))}
      ${statCard('Net sales', fmtMoney(t.net_sales), 'Sales minus refunds' + (pt ? ' · before: ' + fmtMoney(pt.net_sales) : ''))}
      ${statCard('Costs', fmtMoney(num(t.ingredients_sold) + num(t.ingredients_wasted) + num(t.expenses) + num(t.payment_fees)), `${fmtMoney(num(t.ingredients_sold) + num(t.ingredients_wasted))} ingredients · ${fmtMoney(t.expenses)} expenses${num(t.payment_fees) ? ' · ' + fmtMoney(t.payment_fees) + ' payment fees' : ''}`)}
      ${statCard('Net income', `<span class="${ni < 0 ? 'text-red' : 'text-green'}">${signedMoney(ni)}</span>`, pt ? 'before: ' + signedMoney(pt.net_income) : esc(acctRangeLabel(a, b)))}
    </div>
    <div class="card ni-statement">
      <h3 class="ni-title">${esc(acctRangeLabel(a, b))} <span class="text-light">· shop time${prev ? ` · compared with ${esc(acctRangeLabel(prev.from, prev.to))}` : ''}</span></h3>
      <table class="ni-table" id="ac-table"><thead class="${prev ? '' : 'sr-only'}"><tr><th></th><th class="num">This period</th>${prev ? '<th class="num">Before</th><th class="num">Change</th>' : ''}</tr></thead><tbody>
        ${lines.map(([label, v, kind, hint]) => `<tr class="${kind.split(' ').map(k => 'ni-' + k).join(' ')}" ${hint ? `title="${esc(hint)}"` : ''}><td>${esc(label)}</td><td class="num">${signedMoney(v)}</td>${prev ? `<td class="num text-light">${prevBy[label] === undefined ? '—' : signedMoney(prevBy[label])}</td><td class="num">${change(v, prevBy[label])}</td>` : ''}</tr>`).join('')}
      </tbody></table>
      <p class="hint" style="margin-bottom:0;">Ingredients are costed with your costing method (${costingMethod() === 'latest' ? 'latest purchase price' : 'weighted average'}) as of ${esc(fmtDay(b))}, so wasted amounts can differ slightly from the Waste report, which keeps the cost on the day it was logged. Stock counts, R&amp;D and barista drinks are inside "Ingredients wasted".</p>
    </div>
    <div class="grid grid-3" style="margin-top:16px;">
      <div class="card"><h3 class="ni-title">Voids</h3><div class="big-num">${plural(num(t.void_count), 'void')}</div>
        <p class="hint" style="margin-bottom:0;">${num(t.void_count) ? fmtMoney(t.voids) + ' cancelled. ' : ''}A voided sale is not counted in Sales, so it is not taken off again.</p></div>
      <div class="card"><h3 class="ni-title">Cash over / short</h3><div class="big-num ${over < -0.005 ? 'text-red' : (over > 0.005 ? 'text-green' : '')}">${Math.abs(over) < 0.005 ? fmtMoney(0) : (over > 0 ? '+' : '−') + fmtMoney(Math.abs(over))}</div>
        <p class="hint" style="margin-bottom:0;">${plural(num(t.shifts_closed), 'shift')} closed in these days. Counted cash minus expected cash. Not part of net income.</p></div>
      <div class="card"><h3 class="ni-title">Items sold</h3><div class="big-num">${fmtQtyPlain(num(items.drinks) + num(items.food) + num(items.other))}</div>
        <p class="hint" style="margin-bottom:0;">${fmtQtyPlain(items.drinks)} drinks · ${fmtQtyPlain(items.food)} food / pastries${num(items.other) ? ' · ' + fmtQtyPlain(items.other) + ' other' : ''}</p></div>
    </div>
    <div class="card" style="margin-top:16px;">
      <h3 class="ni-title">Payment methods</h3>
      ${methods.length ? `<div class="table-wrap" style="box-shadow:none;"><table><thead><tr><th>Method</th><th class="num">Sales</th><th class="num">Total</th>${anyCharge ? '<th class="num">Charges paid by customers</th><th class="num">Fees</th><th class="num">Waived (you absorbed)</th>' : ''}</tr></thead>
        <tbody>${methods.map(m => `<tr><td><b>${esc(m.label || m.method)}</b></td><td class="num">${num(m.count)}</td><td class="num">${fmtMoney(m.total)}</td>${anyCharge ? `<td class="num">${fmtMoney(m.charges)}</td><td class="num">${fmtMoney(m.fees)}</td><td class="num">${num(m.waived) ? fmtMoney(m.waived) : '—'}</td>` : ''}</tr>`).join('')}</tbody></table></div>`
        : '<p class="text-light">No sales in these days.</p>'}
      <p class="hint" style="margin-bottom:0;">Totals are what customers paid (refunds not taken off). Set the methods and their charges in <a class="linklike" id="ac-pay-settings">Settings → Payments &amp; discounts</a>.</p>
    </div>
    ${waived.length ? `<div class="card" style="margin-top:16px;">
      <h3 class="ni-title">Charges waived <span class="text-light">· ${fmtMoney(t.charges_waived)} absorbed by the shop</span></h3>
      <div class="table-wrap" style="box-shadow:none;"><table><thead><tr><th>When</th><th>Receipt</th><th>Method</th><th>Waived by</th><th class="num">Amount</th></tr></thead>
        <tbody>${waived.map(w => `<tr><td>${esc(fmtShopDateTime(w.date))}</td><td>${esc(w.transaction_number || '')}</td><td>${esc(payLabel(w.method))}</td><td>${esc(w.cashier_name || '')}</td><td class="num">${fmtMoney(w.amount)}</td></tr>`).join('')}</tbody></table></div>
      ${waived.length >= 200 ? '<p class="hint" style="margin-bottom:0;">Showing the latest 200.</p>' : ''}</div>` : ''}
    ${num(t.senior_discounts) ? `<p class="hint" style="margin-top:14px;">Senior / PWD discounts given: ${fmtMoney(num(t.senior_discounts) + num(t.vat_exempt))} (with the VAT taken out). <a class="linklike" id="ac-senior-link">See the Senior / PWD report</a>.</p>` : ''}`;
}
// 12 -> "12", 2.5 -> "2.5"
function fmtQtyPlain(v){ const n = num(v); return (Math.round(n * 100) / 100).toLocaleString('en-PH'); }
function exportAccountingCSV(){
  const L = ACCT_LAST;
  if(!L){ toast('Nothing to export', 'warn'); return; }
  const prevBy = {};
  if(L.prev) acctLines(L.prev).forEach(([label, v]) => { prevBy[label] = v; });
  const rows = acctLines(L.r).map(([label, v]) => L.prev ? [label, v.toFixed(2), prevBy[label] === undefined ? '' : prevBy[label].toFixed(2)] : [label, v.toFixed(2)]);
  const t = L.r.totals || {};
  rows.push(['Voids (count)', String(num(t.void_count))], ['Voids (amount, not in sales)', num(t.voids).toFixed(2)],
    ['Cash over / short', num(t.cash_over_short).toFixed(2)], ['Drinks sold', String(num((t.items || {}).drinks))], ['Food / pastries sold', String(num((t.items || {}).food))]);
  rows.push([]);
  rows.push(['Day', 'Sales', 'Refunds', 'Net sales', 'Voids', 'Waste', 'Expenses', 'Net income', 'Drinks', 'Food / pastries']);
  (L.r.days || []).forEach(d => rows.push([d.day, num(d.sales).toFixed(2), num(d.refunds).toFixed(2), num(d.net_sales).toFixed(2), num(d.voids).toFixed(2),
    num(d.waste).toFixed(2), num(d.expenses).toFixed(2), num(d.net_income).toFixed(2), String(num(d.drinks)), String(num(d.food))]));
  rows.push([]);
  rows.push(['Payment method', 'Sales', 'Total', 'Charges paid by customers', 'Fees', 'Waived']);
  (L.r.payment_methods || []).forEach(m => rows.push([m.label || m.method, String(num(m.count)), num(m.total).toFixed(2), num(m.charges).toFixed(2), num(m.fees).toFixed(2), num(m.waived).toFixed(2)]));
  downloadFile(`${fileNameSlug()}-accounting-${L.from}-to-${L.to}.csv`,
    toCSV(['Accounting overview ' + L.from + ' to ' + L.to, 'Amount'].concat(L.prev ? ['Period before'] : []), rows), 'text/csv');
  toast('Accounting overview exported as CSV');
}

/* ================= Senior / PWD report (B19) ================= */
const SENIOR_REP = {preset: 'month', from: '', to: ''};
let SENIOR_LAST = null;
async function renderSeniorReport(){
  const content = document.getElementById('content');
  if(!BO.has16){ content.innerHTML = emptyBlock('The Senior / PWD report is available after the 1.6 database update (013) is installed.'); return; }
  content.innerHTML = `
    <div class="toolbar">
      <div class="toolbar-left">${rangePickerHtml(SENIOR_REP, 'sr')}</div>
      <div class="field-inline"><button class="btn btn-outline btn-sm" id="sr-csv">Export CSV</button></div>
    </div>
    <div id="sr-body"><div class="loading-line">Loading…</div></div>`;
  wireRangePicker(content, SENIOR_REP, 'sr', () => drawSeniorReport());
  content.querySelector('#sr-csv').onclick = exportSeniorCSV;
  await drawSeniorReport();
}
async function drawSeniorReport(){
  const wrap = document.getElementById('sr-body'); if(!wrap) return;
  const [a, b] = presetKeys(SENIOR_REP.preset, SENIOR_REP);
  wrap.classList.add('dim');
  let rows;
  try{ rows = await cloud.rpc('senior_report', {p_from: a, p_to: b}); }
  catch(e){ wrap.classList.remove('dim'); wrap.innerHTML = emptyBlock(esc(friendlyError(e))); return; }
  if(state.route !== 'seniorReport') return;
  rows = Array.isArray(rows) ? rows : [];
  SENIOR_LAST = {from: a, to: b, rows};
  wrap.classList.remove('dim');
  const sum = (k) => rows.reduce((s, x) => s + num(x[k]), 0);
  const pct = seniorDiscountPct();
  wrap.innerHTML = `
    <div class="grid grid-4 kpi-sans" style="margin-bottom:16px;">
      ${statCard('Senior / PWD sales', String(rows.length), esc(acctRangeLabel(a, b)))}
      ${statCard('Their items', fmtMoney(sum('items_amount')), 'at menu prices')}
      ${statCard('VAT taken out', fmtMoney(sum('vat_exempt')), state.settings.tax_inclusive && num(state.settings.tax_pct) > 0 ? 'prices include ' + num(state.settings.tax_pct) + '% tax' : 'your prices don\'t include VAT')}
      ${statCard('Discounts given', fmtMoney(sum('discount')), pct > 0 ? `the shop's discount is ${pct}%` : 'the discount is switched off')}
    </div>
    ${rows.length ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Receipt</th><th>For</th><th>Name on the ID</th><th>ID number</th><th class="num">Their items</th><th class="num">VAT out</th><th class="num">Discount</th><th class="num">Paid (whole sale)</th><th>Cashier</th></tr></thead>
      <tbody>${rows.map(x => `<tr><td>${esc(fmtShopDateTime(x.date))}</td>
        <td>${esc(x.transaction_number || '')}${x.status && x.status !== 'COMPLETED' ? ` <span class="tag soft">${esc(String(x.status).replace(/_/g, ' ').toLowerCase())}</span>` : ''}</td>
        <td>${esc(seniorKindLabel(x.kind))}</td><td>${esc(x.holder_name || '')}</td><td>${esc(x.id_number || '')}</td>
        <td class="num">${fmtMoney(x.items_amount)}</td><td class="num">${num(x.vat_exempt) ? fmtMoney(x.vat_exempt) : '—'}</td>
        <td class="num">${fmtMoney(x.discount)}${x.pct != null && num(x.pct) !== pct ? ` <span class="text-light">(${num(x.pct)}%)</span>` : ''}</td>
        <td class="num">${fmtMoney(x.grand_total)}</td><td>${esc(x.cashier_name || '')}</td></tr>`).join('')}
      <tr class="total-row"><td colspan="5"><b>Total</b></td><td class="num"><b>${fmtMoney(sum('items_amount'))}</b></td><td class="num"><b>${fmtMoney(sum('vat_exempt'))}</b></td><td class="num"><b>${fmtMoney(sum('discount'))}</b></td><td></td><td></td></tr>
      </tbody></table></div>` : emptyBlock('No Senior / PWD discounts in these days.')}
    <p class="hint">Only you (the owner) can open this list: the counters never see ID numbers again after a sale. Voided sales are left out; refunded ones are marked. Keep the exported file somewhere safe: it holds personal details.</p>`;
}
function exportSeniorCSV(){
  const L = SENIOR_LAST;
  if(!L || !L.rows.length){ toast('Nothing to export', 'warn'); return; }
  const rows = L.rows.map(x => [fmtShopDateTime(x.date), x.transaction_number || '', x.status || '', seniorKindLabel(x.kind), x.holder_name || '', x.id_number || '',
    num(x.items_amount).toFixed(2), num(x.vat_exempt).toFixed(2), num(x.discount).toFixed(2), x.pct == null ? '' : String(num(x.pct)), num(x.grand_total).toFixed(2), x.cashier_name || '']);
  downloadFile(`${fileNameSlug()}-senior-pwd-${L.from}-to-${L.to}.csv`,
    toCSV(['When', 'Receipt', 'Status', 'For', 'Name on the ID', 'ID number', 'Their items', 'VAT taken out', 'Discount', 'Discount %', 'Paid (whole sale)', 'Cashier'], rows), 'text/csv');
  toast('Senior / PWD report exported as CSV');
}

/* ================= Settings → Payments & discounts (B4, B5, B19) ================= */
const BUILTIN_PAY_IDS = ['CASH', 'GCASH', 'QR', 'CARD', 'BANK', 'MAYA', 'OTHER'];
let PM_DRAFT = null;
function paymentSettingsHtml(){
  if(!BO.has16) return `<div class="card">${emptyBlock('Payment methods and the Senior / PWD discount are available after the 1.6 database update (013) is installed.')}</div>`;
  PM_DRAFT = paymentMethodList().map(m => Object.assign({}, m));
  const pct = seniorDiscountPct();
  return `
    <div class="card" id="pm-card">
      <b style="font-size:15px;">Payment methods</b>
      <p class="hint" style="margin:4px 0 12px;">These are the buttons at the counter's checkout, in this order. Switch a method off to hide it; old sales keep their method.</p>
      <div id="pm-rows"></div>
      <div class="field-inline" style="margin-top:12px;"><button class="btn btn-outline btn-sm" type="button" id="pm-add">${icon('plus', {size: 16})} Add a payment method</button></div>
      <p class="hint" style="margin:12px 0;"><b>Extra charge:</b> a % or a peso amount on top of the bill for that method. At the counter it shows as its own line with an "Add to bill" tick, so staff can add it or waive it for a sale. In your Accounting overview the charge counts as that method's fee on every sale, added or waived: when it's added the customer's payment cancels it out, and when it's waived the shop absorbs it. So don't also log these fees under Expenses.</p>
      <button class="btn btn-primary" id="pm-save">Save payment methods</button>
    </div>
    <div class="card" style="margin-top:16px;" id="sn-card">
      <b style="font-size:15px;">Senior / PWD discount</b>
      <div class="form-row" style="max-width:260px;margin-top:10px;"><label for="sn-pct">Discount %</label><input type="number" min="0" max="100" step="any" id="sn-pct" value="${esc(pct)}">
        <div class="hint">0 hides the Senior / PWD button at the counter.</div></div>
      <p class="hint" style="margin:0 0 12px;">The cashier types the name and ID number and ticks the customer's own items. ${state.settings.tax_inclusive && num(state.settings.tax_pct) > 0
        ? `Your prices include ${num(state.settings.tax_pct)}% tax, so the VAT is taken out of those items first and the discount comes off the rest.`
        : (num(state.settings.tax_pct) > 0 ? 'No tax is added on those items.' : 'Your shop charges no tax, so only the discount applies.')}
        It can't be combined with another discount or a stamp reward on the same sale, and it needs no manager PIN. Every use is listed in <a class="linklike" id="sn-go-report">Money → Senior / PWD report</a>.</p>
      <button class="btn btn-primary" id="sn-save">Save</button>
    </div>`;
}
function pmRowsHtml(){
  return PM_DRAFT.map((m, i) => {
    const cash = m.id === 'CASH';
    return `<div class="pm-row" data-i="${i}">
      <div class="pm-move"><button type="button" class="btn btn-ghost btn-sm icon-only" data-pm-up="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Move ${esc(m.label || 'method')} up">${icon('chevron-up', {size: 16})}</button>
        <button type="button" class="btn btn-ghost btn-sm icon-only" data-pm-down="${i}" ${i === PM_DRAFT.length - 1 ? 'disabled' : ''} aria-label="Move ${esc(m.label || 'method')} down">${icon('chevron-down', {size: 16})}</button></div>
      <div class="pm-main">
        <div class="pm-line">
          <input class="pm-label" data-pm-label="${i}" maxlength="24" value="${esc(m.label)}" placeholder="Name, e.g. PayMaya" aria-label="Name of the payment method">
          <label class="switch" title="${cash ? 'Cash is always on' : 'Show at the counter'}"><input type="checkbox" data-pm-active="${i}" ${m.active ? 'checked' : ''} ${cash ? 'disabled' : ''} aria-label="${esc(m.label || 'method')} on"><span class="slider-tog"></span></label>
          ${!m.id || !BUILTIN_PAY_IDS.includes(m.id) ? `<button type="button" class="btn btn-ghost btn-sm icon-only" data-pm-del="${i}" aria-label="Remove ${esc(m.label || 'method')}">${icon('trash', {size: 16})}</button>` : ''}
        </div>
        ${cash ? '<div class="hint">Cash is always on and has no extra charge (the cash drawer depends on it).</div>' : `<div class="pm-line pm-opts">
          <label class="chk"><input type="checkbox" data-pm-ref="${i}" ${m.reference ? 'checked' : ''}> Ask for a reference number</label>
          <span class="pm-charge">Extra charge
            <select data-pm-type="${i}" aria-label="Extra charge for ${esc(m.label || 'method')}"><option value="NONE" ${m.charge_type === 'NONE' ? 'selected' : ''}>None</option><option value="PERCENT" ${m.charge_type === 'PERCENT' ? 'selected' : ''}>% of the bill</option><option value="FIXED" ${m.charge_type === 'FIXED' ? 'selected' : ''}>₱ amount</option></select>
            <input type="number" min="0" step="any" data-pm-val="${i}" value="${m.charge_type === 'NONE' ? '' : esc(m.charge_value)}" ${m.charge_type === 'NONE' ? 'hidden' : ''} style="width:86px;" aria-label="Charge value">
            <select data-pm-def="${i}" ${m.charge_type === 'NONE' ? 'hidden' : ''} aria-label="At the counter"><option value="ADD" ${m.charge_default !== 'WAIVE' ? 'selected' : ''}>Added unless unticked</option><option value="WAIVE" ${m.charge_default === 'WAIVE' ? 'selected' : ''}>Waived unless ticked</option></select>
          </span></div>`}
      </div></div>`;
  }).join('');
}
// A new method's code from its name: "Pay Maya 2" -> PAY_MAYA_2 (kept unique).
function pmIdFromLabel(label, taken){
  let base = String(label || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 16);
  if(!/^[A-Z]/.test(base)) base = 'M_' + base;
  base = base.replace(/_+$/, '');
  if(base.length < 2) base = 'METHOD';
  let id = base, n = 2;
  while(taken.includes(id)) id = (base.slice(0, 16) + '_' + (n++)).slice(0, 20);
  return id;
}
// Same rules as the server's _valid_payment_methods, in plain words ('' = fine).
function pmProblem(list){
  if(!list.length) return 'Keep at least Cash in the list.';
  if(list.length > 12) return 'At most 12 payment methods.';
  const names = new Set();
  for(const m of list){
    const label = String(m.label || '').trim();
    if(!label) return 'Every payment method needs a name.';
    if(label.length > 24) return `"${label}" is too long: 24 characters at most.`;
    if(names.has(label.toLowerCase())) return `Two methods are called "${label}". Give each its own name.`;
    names.add(label.toLowerCase());
    if(m.charge_type === 'PERCENT' && !(num(m.charge_value) > 0 && num(m.charge_value) <= 25)) return `${label}: type a charge above 0 and at most 25%.`;
    if(m.charge_type === 'FIXED' && !(num(m.charge_value) > 0 && num(m.charge_value) <= 1000)) return `${label}: type a charge above ₱0 and at most ₱1,000.`;
  }
  return '';
}
function wirePaymentSettings(root){
  if(!BO.has16) return;
  const rows = root.querySelector('#pm-rows');
  const read = () => {
    PM_DRAFT.forEach((m, i) => {
      const q = (a) => rows.querySelector(`[${a}="${i}"]`);
      if(q('data-pm-label')) m.label = q('data-pm-label').value;
      if(q('data-pm-active') && m.id !== 'CASH') m.active = q('data-pm-active').checked;
      if(q('data-pm-ref')) m.reference = q('data-pm-ref').checked;
      if(q('data-pm-type')){
        m.charge_type = q('data-pm-type').value;
        m.charge_value = m.charge_type === 'NONE' ? 0 : num(q('data-pm-val').value);
        m.charge_default = q('data-pm-def').value === 'WAIVE' ? 'WAIVE' : 'ADD';
      }
    });
  };
  const draw = () => {
    rows.innerHTML = pmRowsHtml();
    rows.querySelectorAll('[data-pm-up]').forEach(b => b.onclick = () => { read(); const i = +b.dataset.pmUp; PM_DRAFT.splice(i - 1, 0, PM_DRAFT.splice(i, 1)[0]); draw(); });
    rows.querySelectorAll('[data-pm-down]').forEach(b => b.onclick = () => { read(); const i = +b.dataset.pmDown; PM_DRAFT.splice(i + 1, 0, PM_DRAFT.splice(i, 1)[0]); draw(); });
    rows.querySelectorAll('[data-pm-del]').forEach(b => b.onclick = () => { read(); PM_DRAFT.splice(+b.dataset.pmDel, 1); draw(); });
    rows.querySelectorAll('[data-pm-type]').forEach(sel => sel.onchange = () => { read(); draw(); });
  };
  draw();
  root.querySelector('#pm-add').onclick = () => {
    read();
    if(PM_DRAFT.length >= 12){ toast('At most 12 payment methods.', 'warn'); return; }
    PM_DRAFT.push({id: '', label: '', active: true, reference: true, charge_type: 'NONE', charge_value: 0, charge_default: 'ADD'});
    draw();
    const inputs = rows.querySelectorAll('.pm-label'); if(inputs.length) inputs[inputs.length - 1].focus();
  };
  root.querySelector('#pm-save').onclick = (e) => busy(e.currentTarget, async () => {
    read();
    const bad = pmProblem(PM_DRAFT);
    if(bad){ toast(bad, 'error'); return; }
    const taken = PM_DRAFT.map(m => m.id).filter(Boolean);
    const list = PM_DRAFT.map(m => {
      const id = m.id || pmIdFromLabel(m.label, taken);
      if(!m.id) taken.push(id);
      return {id, label: String(m.label).trim(), active: id === 'CASH' ? true : !!m.active, reference: id === 'CASH' ? false : !!m.reference,
        charge_type: id === 'CASH' ? 'NONE' : m.charge_type, charge_value: (id === 'CASH' || m.charge_type === 'NONE') ? 0 : Math.round(num(m.charge_value) * 100) / 100,
        charge_default: m.charge_default === 'WAIVE' ? 'WAIVE' : 'ADD'};
    });
    const words = list.filter(m => m.active).map(m => m.label + (m.charge_type === 'NONE' ? '' : ` (+${paymentChargeWords(m)}${m.charge_default === 'WAIVE' ? ', waived by default' : ''})`)).join(', ');
    const ok = await boSave([Ops.update('settings', {payment_methods: list, updated_at: nowISO()}), Ops.audit('Payment methods saved', words)],
      {success: 'Payment methods saved — counters pick this up within a few minutes'});
    if(ok){ acctClearCache(); if(state.route === 'settings') renderSettings(); }
  });
  root.querySelector('#sn-go-report').onclick = () => navigate('seniorReport');
  root.querySelector('#sn-save').onclick = (e) => busy(e.currentTarget, async () => {
    const raw = root.querySelector('#sn-pct').value.trim();
    const v = Number(raw);
    if(raw === '' || !isFinite(v) || v < 0 || v > 100){ toast(friendlyError({message: 'BAD_SENIOR_PCT'}), 'error'); return; }
    const pct = Math.round(v * 100) / 100;
    const ok = await boSave([Ops.update('settings', {senior_discount_pct: pct, updated_at: nowISO()}), Ops.audit('Senior / PWD discount saved', pct > 0 ? pct + '%' : 'switched off')],
      {success: 'Saved — counters pick this up within a few minutes'});
    if(ok && state.route === 'settings') renderSettings();
  });
}

/* ================= Investors & start-up costs (B2, owner decisions 2026-11-13) =================
   - Investors: name, amount, date, note. Each one's share = amount ÷ total (worked out here,
     never stored), so adding, removing or changing anyone updates every share by itself.
   - Start-up costs: what was spent to open the shop. Kept apart from Expenses on purpose: they are
     NOT taken off any month's net income. "Cash left" = invested − start-up costs.
   - Rows can be pasted straight from Excel (name, amount per line).
   Owner only (the database refuses everyone else). Every save writes an audit line. */
const STARTUP_CATEGORIES = [
  {id: 'EQUIPMENT', label: 'Equipment'}, {id: 'RENOVATION', label: 'Renovation & furniture'}, {id: 'SUPPLIES', label: 'Supplies & tools'},
  {id: 'STOCK', label: 'First stock (beans, milk…)'}, {id: 'TRANSPORT', label: 'Transport & delivery'},
  {id: 'SENT_TO_STAFF', label: 'Money sent to staff'}, {id: 'OTHER', label: 'Other'},
];
function startupCategoryLabel(id){ const c = STARTUP_CATEGORIES.find(x => x.id === id); return c ? c.label : 'Other'; }
const INV = {investors: [], costs: [], share: {preset: 'month', from: '', to: ''}, costFilter: ''};
// "₱1,234.50" / "1234.5" / "=1000+758" (Excel copies the value, but be kind) -> number or NaN
function parsePeso(t){
  t = String(t == null ? '' : t).replace(/[₱,\s]/g, '').replace(/^php/i, '');
  if(/^=?\d+(\.\d+)?(\+\d+(\.\d+)?)*$/.test(t)) return t.replace(/^=/, '').split('+').reduce((s, x) => s + Number(x), 0);
  return NaN;
}
// Pasted Excel cells -> [{name, amount}] (+ the lines that couldn't be read)
function parsePastedRows(text){
  const rows = [], bad = [];
  String(text || '').split(/\r?\n/).forEach((line, i) => {
    if(!line.trim()) return;
    let parts = line.split('\t');
    if(parts.length < 2) parts = line.split(/\s{2,}|,(?=\s*[₱\d=])/);
    if(parts.length < 2){ const m = line.match(/^(.*?)[\s]+([₱\d,.=+]+)\s*$/); if(m) parts = [m[1], m[2]]; }
    const name = String(parts[0] || '').replace(/[\x00-\x1F\x7F]/g, ' ').replace(/\s+/g, ' ').trim();
    const amount = parsePeso(parts.slice(1).find(x => String(x).trim() !== ''));
    if(!name || !(amount > 0) || amount > 100000000){ bad.push(i + 1); return; }
    rows.push({name: name.slice(0, 120), amount: Math.round(amount * 100) / 100});
  });
  return {rows, bad};
}
function investorShares(list){
  const total = list.reduce((s, x) => s + num(x.amount), 0);
  return {total, pct: (x) => total > 0 ? num(x.amount) / total * 100 : 0};
}
function pctText(v){ return (Math.round(v * 100) / 100).toLocaleString('en-PH', {maximumFractionDigits: 2}) + '%'; }

async function renderInvestors(){
  const content = document.getElementById('content');
  if(!BO.has16){ content.innerHTML = emptyBlock('Investors and start-up costs are available after the 1.6 database update (013) is installed.'); return; }
  const bar = setTopbarActions(`<button class="btn btn-outline" id="btn-inv-csv">Export CSV</button>`);
  bar.querySelector('#btn-inv-csv').onclick = exportInvestorsCSV;
  content.innerHTML = `<div class="loading-line">Loading…</div>`;
  try{
    [INV.investors, INV.costs] = await Promise.all([
      cloud.selectAll('investors', {order: 'amount.desc,name.asc'}),
      cloud.selectAll('startup_costs', {order: 'cost_date.asc.nullsfirst,created_at.asc'})]);
  }catch(e){ content.innerHTML = emptyBlock(esc(friendlyError(e))); return; }
  if(state.route !== 'investors') return;
  drawInvestors();
}
function drawInvestors(){
  const content = document.getElementById('content'); if(!content) return;
  const {total, pct} = investorShares(INV.investors);
  const spent = INV.costs.reduce((s, x) => s + num(x.amount), 0);
  const left = total - spent;
  const byCat = {};
  INV.costs.forEach(c => { byCat[c.category] = (byCat[c.category] || 0) + num(c.amount); });
  const shown = INV.costFilter ? INV.costs.filter(c => c.category === INV.costFilter) : INV.costs;
  content.innerHTML = `
    <div class="grid grid-3 kpi-sans" style="margin-bottom:16px;">
      ${statCard('Invested', fmtMoney(total), plural(INV.investors.length, 'investor'))}
      ${statCard('Start-up costs', fmtMoney(spent), plural(INV.costs.length, 'item') + ' · not part of monthly net income')}
      ${statCard('Left from the investments', `<span class="${left < 0 ? 'text-red' : ''}">${signedMoney(left)}</span>`, 'invested minus start-up costs')}
    </div>
    <div class="card" style="margin-bottom:16px;">
      <div class="toolbar" style="margin-bottom:8px;"><h3 class="ni-title" style="margin:0;">Investors</h3>
        <div class="field-inline"><button class="btn btn-outline btn-sm" id="inv-paste">Paste from Excel</button><button class="btn btn-primary btn-sm" id="inv-add">${icon('plus', {size: 16})} Add investor</button></div></div>
      ${INV.investors.length ? `<div class="table-wrap" style="box-shadow:none;"><table><thead><tr><th>Name</th><th class="num">Invested</th><th class="num">Share</th><th>Date</th><th>Note</th><th><span class="sr-only">Change</span></th></tr></thead><tbody>
        ${INV.investors.map(x => `<tr><td><b>${esc(x.name)}</b></td><td class="num">${fmtMoney(x.amount)}</td><td class="num">${pctText(pct(x))}</td>
          <td>${x.invested_on ? esc(fmtDay(x.invested_on)) : '<span class="text-light">—</span>'}</td><td class="text-light">${esc(x.notes || '')}</td>
          <td class="wr-actions"><button class="btn btn-ghost btn-sm" data-inv-edit="${esc(x.id)}">Edit</button><button class="btn btn-ghost btn-sm" data-inv-del="${esc(x.id)}">Remove</button></td></tr>`).join('')}
        <tr class="total-row"><td><b>Total</b></td><td class="num"><b>${fmtMoney(total)}</b></td><td class="num"><b>100%</b></td><td colspan="3"></td></tr>
      </tbody></table></div>` : emptyBlock('No investors yet. Add them one by one, or copy the names and amounts from Excel and use "Paste from Excel".')}
      <p class="hint" style="margin-bottom:0;">Each share is the person's amount ÷ the total, so it updates by itself when you add, remove or change an investor. To replace someone, edit their name and amount (the audit log keeps the old values).</p>
    </div>
    ${INV.investors.length ? `<div class="card" style="margin-bottom:16px;" id="inv-share-card">
      <div class="toolbar" style="margin-bottom:8px;"><h3 class="ni-title" style="margin:0;">Share of net income</h3><div class="toolbar-left">${rangePickerHtml(INV.share, 'is')}</div></div>
      <div id="inv-share"><div class="loading-line">Working it out…</div></div>
      <p class="hint" style="margin-bottom:0;">For information: net income from the Accounting overview for these days × each share. Nothing is paid out by this page.</p>
    </div>` : ''}
    <div class="card">
      <div class="toolbar" style="margin-bottom:8px;"><h3 class="ni-title" style="margin:0;">Start-up costs</h3>
        <div class="field-inline"><select class="filter" id="sc-cat-filter" aria-label="Show category"><option value="">All categories</option>${STARTUP_CATEGORIES.map(c => `<option value="${c.id}" ${INV.costFilter === c.id ? 'selected' : ''}>${esc(c.label)}${byCat[c.id] ? ' · ' + fmtMoney(byCat[c.id]) : ''}</option>`).join('')}</select>
          <button class="btn btn-outline btn-sm" id="sc-paste">Paste from Excel</button><button class="btn btn-primary btn-sm" id="sc-add">${icon('plus', {size: 16})} Add a cost</button></div></div>
      ${shown.length ? `<div class="table-wrap" style="box-shadow:none;"><table><thead><tr><th>What</th><th>Category</th><th>Date</th><th class="num">Amount</th><th><span class="sr-only">Change</span></th></tr></thead><tbody>
        ${shown.map(c => `<tr><td>${esc(c.name)}${c.notes ? `<div class="text-light" style="font-size:12px;">${esc(c.notes)}</div>` : ''}</td><td>${esc(startupCategoryLabel(c.category))}</td>
          <td>${c.cost_date ? esc(fmtDay(c.cost_date)) : '<span class="text-light">—</span>'}</td><td class="num">${fmtMoney(c.amount)}</td>
          <td class="wr-actions"><button class="btn btn-ghost btn-sm" data-sc-edit="${esc(c.id)}">Edit</button><button class="btn btn-ghost btn-sm" data-sc-del="${esc(c.id)}">Delete</button></td></tr>`).join('')}
        <tr class="total-row"><td colspan="3"><b>Total${INV.costFilter ? ' · ' + esc(startupCategoryLabel(INV.costFilter)) : ''}</b></td><td class="num"><b>${fmtMoney(shown.reduce((s, x) => s + num(x.amount), 0))}</b></td><td></td></tr>
      </tbody></table></div>` : emptyBlock(INV.costs.length ? 'Nothing in this category.' : 'No start-up costs yet. Copy the item names and prices from Excel and use "Paste from Excel".')}
      <p class="hint" style="margin-bottom:0;">What the shop spent to open (equipment, renovation, first stock…). These are kept apart from Expenses: they are not taken off any month's net income. Running costs after opening go in <a class="linklike" id="sc-go-exp">Expenses</a>.</p>
    </div>`;
  const $ = (s) => content.querySelector(s);
  $('#inv-add').onclick = () => openInvestorForm(null);
  $('#inv-paste').onclick = () => openPasteRows('investors');
  $('#sc-add').onclick = () => openStartupForm(null);
  $('#sc-paste').onclick = () => openPasteRows('startup_costs');
  $('#sc-go-exp').onclick = () => navigate('expenses');
  $('#sc-cat-filter').onchange = (e) => { INV.costFilter = e.target.value; drawInvestors(); };
  content.querySelectorAll('[data-inv-edit]').forEach(b => b.onclick = () => openInvestorForm(INV.investors.find(x => x.id === b.dataset.invEdit)));
  content.querySelectorAll('[data-inv-del]').forEach(b => b.onclick = () => removeInvestor(INV.investors.find(x => x.id === b.dataset.invDel)));
  content.querySelectorAll('[data-sc-edit]').forEach(b => b.onclick = () => openStartupForm(INV.costs.find(x => x.id === b.dataset.scEdit)));
  content.querySelectorAll('[data-sc-del]').forEach(b => b.onclick = () => removeStartupCost(INV.costs.find(x => x.id === b.dataset.scDel)));
  if($('#inv-share-card')){ wireRangePicker(content, INV.share, 'is', () => drawInvestorShare()); drawInvestorShare(); }
}
async function drawInvestorShare(){
  const box = document.getElementById('inv-share'); if(!box) return;
  const [a, b] = presetKeys(INV.share.preset, INV.share);
  let r;
  try{ r = await acctReport(a, b); }catch(e){ box.innerHTML = `<p class="text-light">${esc(friendlyError(e))}</p>`; return; }
  if(!box.isConnected) return;
  const ni = num((r.totals || {}).net_income);
  const {pct} = investorShares(INV.investors);
  box.innerHTML = `<p style="margin:0 0 8px;">Net income ${esc(acctRangeLabel(a, b))}: <b class="${ni < 0 ? 'text-red' : ''}">${signedMoney(ni)}</b></p>
    <div class="table-wrap" style="box-shadow:none;"><table><thead><tr><th>Investor</th><th class="num">Share</th><th class="num">Their part</th></tr></thead><tbody>
    ${INV.investors.map(x => `<tr><td>${esc(x.name)}</td><td class="num">${pctText(pct(x))}</td><td class="num">${signedMoney(ni * pct(x) / 100)}</td></tr>`).join('')}</tbody></table></div>`;
}
function openInvestorForm(x){
  const isNew = !x;
  openModal({title: isNew ? 'Add investor' : 'Edit investor', body: `
    <div class="form-row"><label for="if-name">Name</label><input id="if-name" maxlength="80" value="${esc(x ? x.name : '')}"></div>
    <div class="form-grid">
      <div class="form-row"><label for="if-amt">Amount invested (₱)</label><input id="if-amt" type="number" min="0" step="any" inputmode="decimal" value="${x ? esc(num(x.amount)) : ''}"></div>
      <div class="form-row"><label for="if-date">Date <span class="text-light">(optional)</span></label><input id="if-date" type="date" value="${esc(x && x.invested_on || '')}"></div>
    </div>
    <div class="form-row"><label for="if-note">Note <span class="text-light">(optional)</span></label><input id="if-note" maxlength="500" value="${esc(x && x.notes || '')}"></div>`,
    foot: `<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" id="if-save">Save</button>`,
    onMount: (root) => {
      root.querySelector('[data-cancel]').onclick = closeModal;
      root.querySelector('#if-save').onclick = (e) => busy(e.currentTarget, async () => {
        const name = root.querySelector('#if-name').value.replace(/\s+/g, ' ').trim();
        const amount = Math.round(num(root.querySelector('#if-amt').value) * 100) / 100;
        if(!name){ toast('Type the investor\'s name.', 'error'); return; }
        if(!(amount > 0) || amount > 100000000){ toast('Type the amount invested (more than ₱0, at most ₱100,000,000).', 'error'); return; }
        if(INV.investors.some(o => o.id !== (x && x.id) && o.name.trim().toLowerCase() === name.toLowerCase())){ toast(`There is already an investor called "${name}".`, 'error'); return; }
        const row = {id: x ? x.id : uid(), name, amount, invested_on: root.querySelector('#if-date').value || null, notes: root.querySelector('#if-note').value.trim() || null, updated_at: nowISO()};
        const what = isNew ? `${name}: ${fmtMoney(amount)}` : `${x.name}: ${fmtMoney(x.amount)} -> ${name}: ${fmtMoney(amount)}`;
        if(await boSave([Ops.upsert('investors', row), Ops.audit(isNew ? 'Investor added' : 'Investor changed', what, row.id)], {reload: false, success: 'Saved'})){ closeModal(); renderInvestors(); }
      });
      setTimeout(() => root.querySelector('#if-name').focus(), 50);
    }});
}
async function removeInvestor(x){
  if(!x) return;
  if(!(await confirmDialog(`Remove <b>${esc(x.name)}</b> (${fmtMoney(x.amount)})? Everyone else's share goes up to match. The audit log keeps a record.`, 'Remove investor'))) return;
  if(await boSave([Ops.del('investors', x.id), Ops.audit('Investor removed', `${x.name}: ${fmtMoney(x.amount)}`, x.id)], {reload: false, success: 'Removed'})) renderInvestors();
}
function startupCategoryOptions(sel){ return STARTUP_CATEGORIES.map(c => `<option value="${c.id}" ${sel === c.id ? 'selected' : ''}>${esc(c.label)}</option>`).join(''); }
function openStartupForm(c){
  const isNew = !c;
  openModal({title: isNew ? 'Add a start-up cost' : 'Edit start-up cost', body: `
    <div class="form-row"><label for="sf-name">What</label><input id="sf-name" maxlength="120" value="${esc(c ? c.name : '')}" placeholder="e.g. Espresso machine"></div>
    <div class="form-grid">
      <div class="form-row"><label for="sf-amt">Amount (₱)</label><input id="sf-amt" type="number" min="0" step="any" inputmode="decimal" value="${c ? esc(num(c.amount)) : ''}"></div>
      <div class="form-row"><label for="sf-date">Date <span class="text-light">(optional)</span></label><input id="sf-date" type="date" value="${esc(c && c.cost_date || '')}"></div>
    </div>
    <div class="form-row"><label for="sf-cat">Category</label><select id="sf-cat">${startupCategoryOptions(c ? c.category : 'OTHER')}</select></div>
    <div class="form-row"><label for="sf-note">Note <span class="text-light">(optional)</span></label><input id="sf-note" maxlength="500" value="${esc(c && c.notes || '')}"></div>`,
    foot: `<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" id="sf-save">Save</button>`,
    onMount: (root) => {
      root.querySelector('[data-cancel]').onclick = closeModal;
      root.querySelector('#sf-save').onclick = (e) => busy(e.currentTarget, async () => {
        const name = root.querySelector('#sf-name').value.replace(/\s+/g, ' ').trim();
        const amount = Math.round(num(root.querySelector('#sf-amt').value) * 100) / 100;
        if(!name){ toast('Type what it was.', 'error'); return; }
        if(!(amount > 0) || amount > 100000000){ toast('Type the amount (more than ₱0, at most ₱100,000,000).', 'error'); return; }
        const row = {id: c ? c.id : uid(), name, amount, cost_date: root.querySelector('#sf-date').value || null, category: root.querySelector('#sf-cat').value,
          notes: root.querySelector('#sf-note').value.trim() || null, updated_at: nowISO()};
        const what = isNew ? `${name}: ${fmtMoney(amount)}` : `${c.name}: ${fmtMoney(c.amount)} -> ${name}: ${fmtMoney(amount)}`;
        if(await boSave([Ops.upsert('startup_costs', row), Ops.audit(isNew ? 'Start-up cost added' : 'Start-up cost changed', what, row.id)], {reload: false, success: 'Saved'})){ closeModal(); renderInvestors(); }
      });
      setTimeout(() => root.querySelector('#sf-name').focus(), 50);
    }});
}
async function removeStartupCost(c){
  if(!c) return;
  if(!(await confirmDialog(`Delete <b>${esc(c.name)}</b> (${fmtMoney(c.amount)}) from the start-up costs?`, 'Delete'))) return;
  if(await boSave([Ops.del('startup_costs', c.id), Ops.audit('Start-up cost deleted', `${c.name}: ${fmtMoney(c.amount)}`, c.id)], {reload: false, success: 'Deleted'})) renderInvestors();
}
// Paste rows copied from Excel: two columns (name, amount). Preview first, then save all at once.
function openPasteRows(table){
  const isInv = table === 'investors';
  openModal({title: isInv ? 'Paste investors from Excel' : 'Paste start-up costs from Excel', wide: true, body: `
    <p class="hint" style="margin-top:0;">In Excel, select the two columns (${isInv ? 'name and amount invested' : 'what it was and the price'}), copy (Ctrl+C), then paste here (Ctrl+V). One row per line. Rows without a name or an amount are skipped${isInv ? '' : ', and a total row is left out if you copied it'}.</p>
    <textarea id="pr-text" rows="10" style="width:100%;font-family:inherit;" placeholder="${isInv ? 'Mama Lorna\t50000' : 'Espresso machine\t29990'}"></textarea>
    <div class="form-grid" style="margin-top:10px;">
      <div class="form-row"><label for="pr-date">Date for all of them <span class="text-light">(optional)</span></label><input type="date" id="pr-date"></div>
      ${isInv ? '' : `<div class="form-row"><label for="pr-cat">Category for all of them</label><select id="pr-cat">${startupCategoryOptions('OTHER')}</select><div class="hint">You can change each one afterwards.</div></div>`}
    </div>
    <div id="pr-preview" class="hint"></div>`,
    foot: `<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" id="pr-save" disabled>Add</button>`,
    onMount: (root) => {
      root.querySelector('[data-cancel]').onclick = closeModal;
      let parsed = {rows: [], bad: []};
      const ta = root.querySelector('#pr-text'), save = root.querySelector('#pr-save'), pv = root.querySelector('#pr-preview');
      const update = () => {
        parsed = parsePastedRows(ta.value);
        parsed.rows = parsed.rows.filter(r => !/^(total|sub-?total|grand total)$/i.test(r.name));
        const dupes = isInv ? parsed.rows.filter((r, i) => parsed.rows.findIndex(o => o.name.toLowerCase() === r.name.toLowerCase()) !== i || INV.investors.some(o => o.name.trim().toLowerCase() === r.name.toLowerCase())) : [];
        const sum = parsed.rows.reduce((s, r) => s + r.amount, 0);
        pv.innerHTML = parsed.rows.length ? `<b>${plural(parsed.rows.length, isInv ? 'investor' : 'item')}, ${fmtMoney(sum)} in all.</b>${parsed.bad.length ? ` Skipped line${parsed.bad.length === 1 ? '' : 's'} ${parsed.bad.slice(0, 10).join(', ')}${parsed.bad.length > 10 ? '…' : ''} (no name, or no amount between ₱0 and ₱100,000,000).` : ''}
          ${dupes.length ? `<div class="text-red">Already on the list or twice in what you pasted: ${dupes.map(d => esc(d.name)).join(', ')}. Remove ${dupes.length === 1 ? 'it' : 'them'} first.</div>` : ''}
          <div style="max-height:180px;overflow:auto;margin-top:6px;">${parsed.rows.slice(0, 200).map(r => `<div>${esc(r.name)} · ${fmtMoney(r.amount)}</div>`).join('')}</div>`
          : (ta.value.trim() ? 'Nothing could be read yet: each line needs a name and an amount.' : '');
        save.disabled = !parsed.rows.length || parsed.rows.length > 200 || dupes.length > 0;
        if(parsed.rows.length > 200) pv.innerHTML += '<div class="text-red">At most 200 rows at a time.</div>';
      };
      ta.oninput = update;
      save.onclick = (e) => busy(e.currentTarget, async () => {
        const date = root.querySelector('#pr-date').value || null, now = nowISO();
        const cat = isInv ? null : root.querySelector('#pr-cat').value;
        const ops = parsed.rows.map(r => Ops.upsert(table, isInv ? {id: uid(), name: r.name.slice(0, 80), amount: r.amount, invested_on: date, updated_at: now}
          : {id: uid(), name: r.name, amount: r.amount, cost_date: date, category: cat, updated_at: now}));
        const sum = parsed.rows.reduce((s, r) => s + r.amount, 0);
        ops.push(Ops.audit(isInv ? 'Investors pasted' : 'Start-up costs pasted', `${plural(parsed.rows.length, 'row')}, ${fmtMoney(sum)}`));
        if(await boSave(ops, {reload: false, success: `Added ${plural(parsed.rows.length, 'row')}`})){ closeModal(); renderInvestors(); }
      });
      setTimeout(() => ta.focus(), 50);
    }});
}
function exportInvestorsCSV(){
  if(!INV.investors.length && !INV.costs.length){ toast('Nothing to export', 'warn'); return; }
  const {total, pct} = investorShares(INV.investors);
  const rows = INV.investors.map(x => ['Investor', x.name, num(x.amount).toFixed(2), pctText(pct(x)), x.invested_on || '', x.notes || '']);
  rows.push(['Investors total', '', total.toFixed(2), '100%', '', '']);
  INV.costs.forEach(c => rows.push(['Start-up cost', c.name, num(c.amount).toFixed(2), startupCategoryLabel(c.category), c.cost_date || '', c.notes || '']));
  const spent = INV.costs.reduce((s, x) => s + num(x.amount), 0);
  rows.push(['Start-up costs total', '', spent.toFixed(2), '', '', ''], ['Left from the investments', '', (total - spent).toFixed(2), '', '', '']);
  downloadFile(`${fileNameSlug()}-investors-startup.csv`, toCSV(['Kind', 'Name', 'Amount', 'Share / category', 'Date', 'Note'], rows), 'text/csv');
  toast('Exported as CSV');
}
