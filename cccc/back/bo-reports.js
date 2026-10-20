/* =====================================================================
   BACK OFFICE — reports: every report from the original Inventory app
   (same formulas) plus sales reports for a chosen date range.
   Print / PDF and CSV for each. Cells are plain values or {money: n}
   so the screen shows ₱ amounts and the CSV keeps plain numbers.
   ===================================================================== */

const REPORTS = [
  // stock & menu (original app)
  {id: 'priceChanges', group: 'stock', name: 'Ingredient cost changes'},
  {id: 'purchaseHistory', group: 'stock', name: 'Purchase history'},
  {id: 'inventoryValue', group: 'stock', name: 'Inventory value'},
  {id: 'lowStock', group: 'stock', name: 'Low stock'},
  {id: 'waste', group: 'stock', name: 'Waste'},
  {id: 'production', group: 'stock', name: 'Production'},
  {id: 'recipeCosting', group: 'stock', name: 'Recipe costing'},
  {id: 'foodCost', group: 'stock', name: 'Food cost'},
  {id: 'grossProfit', group: 'stock', name: 'Gross profit'},
  {id: 'expensiveIngredients', group: 'stock', name: 'Most expensive ingredients'},
  {id: 'profitableRecipes', group: 'stock', name: 'Most profitable recipes'},
  // sales (date range)
  {id: 'salesByDay', group: 'sales', name: 'Sales by day'},
  {id: 'salesByItem', group: 'sales', name: 'Sales by item'},
  {id: 'salesByCategory', group: 'sales', name: 'Sales by menu section'},
  {id: 'salesByHour', group: 'sales', name: 'Sales by hour'},
  {id: 'payments', group: 'sales', name: 'Payment methods'},
  {id: 'cashiers', group: 'sales', name: 'Cashiers'},
  {id: 'shifts', group: 'sales', name: 'Shifts & cash'},
  {id: 'refunds', group: 'sales', name: 'Refunds & voids'},
  {id: 'discounts', group: 'sales', name: 'Discounts'},
];
const repState = {active: 'priceChanges', preset: '7d', from: '', to: ''};
const M = (v) => ({money: num(v)});
function cellText(c){ return c && typeof c === 'object' && 'money' in c ? fmtMoney(c.money) : (c == null ? '' : String(c)); }
function cellCsv(c){ return c && typeof c === 'object' && 'money' in c ? c.money.toFixed(2) : (c == null ? '' : c); }
function cellNum(c){ return (c && typeof c === 'object' && 'money' in c) || typeof c === 'number'; }

/* ---- the original inventory reports (unchanged formulas) ---- */
function stockReport(id){
  const warnPct = num(state.settings.food_cost_warning_pct) || 35;
  const active = state.ingredients.filter(i => i.active !== false);
  const sellable = state.recipes.filter(r => r.active !== false && num(r.selling_price) > 0);
  switch(id){
    case 'priceChanges': {
      const monthAgo = new Date(); monthAgo.setMonth(monthAgo.getMonth() - 1);
      const iso = monthAgo.toISOString();
      return {headers: ['Ingredient', 'Cost about 1 month ago', 'Current cost', 'Change %'], rows: active.slice().sort(byName).map(i => {
        const cur = ingredientCosting(i.id).current || 0;
        let prev;
        if(isProducedItem(i)){
          const r = sourceRecipeForIngredient(i);
          prev = r ? recipeCostAsOf(r.id, iso) / (num(r.expected_yield) || 1) : cur;
        } else {
          const st = computeCostingStats(purchasesFor(i.id), iso);
          prev = st.count ? (costingMethod() === 'latest' ? st.latest : st.weightedAvg) : cur;
        }
        const change = prev ? (cur - prev) / prev * 100 : 0;
        return [i.name, M(prev), M(cur), fmtNum(change, 1) + '%'];
      })};
    }
    case 'purchaseHistory':
      return {headers: ['Date', 'Ingredient', 'Supplier', 'Invoice #', 'Quantity', 'Total price', 'Price / base unit'], rows: state.purchases.slice().sort((a, b) => String(b.purchase_date).localeCompare(String(a.purchase_date)))
        .map(p => [dayValue(p.purchase_date), ingName(p.ingredient_id), supName(p.supplier_id), p.invoice_number || '—', fmtNum(p.quantity, 2) + ' ' + (p.purchase_unit || ''), M(p.total_price), M(p.price_per_base_unit)])};
    case 'inventoryValue': {
      const rows = active.slice().sort(byName).map(i => { const s = ingredientStock(i.id), c = ingredientCosting(i.id).current || 0; return [i.name, fmtNum(s, 2) + ' ' + i.base_unit, M(c), M(s * c)]; });
      const total = rows.reduce((s, r) => s + r[3].money, 0);
      return {headers: ['Ingredient', 'Stock', 'Unit cost', 'Inventory value'], rows, total: ['Total', '', '', M(total)]};
    }
    case 'lowStock':
      return {headers: ['Ingredient', 'Stock', 'Reorder level', 'Status'], rows: active.filter(i => stockStatus(ingredientStock(i.id), i.reorder_level) !== 'IN').sort(byName)
        .map(i => [i.name, fmtNum(ingredientStock(i.id), 2) + ' ' + i.base_unit, fmtNum(i.reorder_level, 1), statusBadgeText(stockStatus(ingredientStock(i.id), i.reorder_level))])};
    case 'waste': {
      const rows = state.waste.slice().sort((a, b) => String(b.date).localeCompare(String(a.date))).map(w => [dayValue(w.date), ingName(w.ingredient_id), fmtNum(w.quantity, 2) + ' ' + (w.unit || ''), w.reason || '', M(num(w.quantity) * (ingredientCosting(w.ingredient_id).current || 0))]);
      return {headers: ['Date', 'Ingredient', 'Quantity', 'Reason', 'Waste cost'], rows, total: ['Total', '', '', '', M(rows.reduce((s, r) => s + r[4].money, 0))]};
    }
    case 'production':
      return {headers: ['Date', 'Batch #', 'Product', 'Quantity produced', 'Production cost', 'Cost / unit'], rows: state.productionBatches.slice().sort((a, b) => String(b.production_date).localeCompare(String(a.production_date)))
        .map(b => [dayValue(b.production_date), b.batch_number || '—', ingName(b.produced_ingredient_id), fmtNum(b.actual_yield, 2) + ' ' + (b.yield_unit || ''), M(b.raw_cost_total), M(b.actual_cost_per_unit)])};
    case 'recipeCosting':
      return {headers: ['Recipe', 'Type', 'Selling price', 'Recipe cost', 'Gross profit', 'Food cost %'], rows: state.recipes.filter(r => r.active !== false).sort(byName).map(r => {
        const m = recipeMetrics(r), sells = num(r.selling_price) > 0;
        return [r.name, recipeTypeLabel(recipeTypeOf(r)), sells ? M(r.selling_price) : '—', M(m.cost), sells ? M(m.profit) : '—', sells ? fmtNum(m.foodCostPct, 1) + '%' : '—'];
      })};
    case 'foodCost':
      return {headers: ['Recipe', 'Food cost %', 'Status'], rows: sellable.slice().sort(byName).map(r => { const m = recipeMetrics(r); return [r.name, fmtNum(m.foodCostPct, 1) + '%', m.foodCostPct > warnPct ? 'HIGH' : 'OK']; })};
    case 'grossProfit':
      return {headers: ['Recipe', 'Gross profit'], rows: sellable.map(r => ({r, m: recipeMetrics(r)})).sort((a, b) => b.m.profit - a.m.profit).map(x => [x.r.name, M(x.m.profit)])};
    case 'expensiveIngredients':
      return {headers: ['Ingredient', 'Current cost'], rows: active.map(i => ({n: i.name, c: ingredientCosting(i.id).current || 0, u: i.base_unit})).sort((a, b) => b.c - a.c).map(x => [x.n, fmtMoney(x.c) + ' / ' + x.u])};
    case 'profitableRecipes':
      return {headers: ['Recipe', 'Gross profit', 'Food cost %'], rows: sellable.map(r => ({r, m: recipeMetrics(r)})).sort((a, b) => b.m.profit - a.m.profit).map(x => [x.r.name, M(x.m.profit), fmtNum(x.m.foodCostPct, 1) + '%'])};
  }
  return {headers: [], rows: []};
}

/* ---- sales reports (same counting rules as the calendar and the counter) ---- */
function salesReport(id, ds){
  const sales = salesIn(ds), refunds = refundsIn(ds);
  const sum = salesSummary(ds, sales, refunds);
  const ids = new Set(sales.map(s => s.id));
  const items = ds.saleItems.filter(i => ids.has(i.sale_id));
  switch(id){
    case 'salesByDay': {
      const by = {};
      const row = (k) => (by[k] = by[k] || {n: 0, gross: 0, ref: 0, disc: 0, tax: 0, svc: 0});
      sales.forEach(s => { const r = row(dayKeyOf(s.transaction_date)); r.n++; r.gross += num(s.grand_total); r.disc += num(s.discount_amount); r.tax += num(s.tax_amount); r.svc += num(s.service_charge_amount); });
      refunds.forEach(x => { row(dayKeyOf(x.date)).ref += num(x.amount); });
      const rows = Object.keys(by).sort().map(k => { const r = by[k]; return [k, r.n, M(r.gross), M(r.ref), M(r.gross - r.ref), M(r.disc), M(r.tax + r.svc)]; });
      return {headers: ['Date', 'Transactions', SALES_LABELS.sales, SALES_LABELS.refunds, SALES_LABELS.netSales, SALES_LABELS.discounts, SALES_LABELS.taxAndService], rows,
        total: ['Total', sum.count, M(sum.gross), M(sum.refunds), M(sum.net), M(sum.discounts), M(sales.reduce((s, x) => s + num(x.tax_amount) + num(x.service_charge_amount), 0))]};
    }
    case 'salesByItem': {
      const by = new Map();
      items.forEach(i => {
        const r = by.get(i.name) || {name: i.name, qty: 0, rev: 0, cost: 0};
        r.qty += num(i.quantity); r.rev += num(i.line_total);
        // ingredients this line used (recipe + option extras), at today's costs
        if(i.recipe_id) inventoryLinesForSaleLine(i.recipe_id, num(i.quantity), i.modifiers || []).forEach(l => { r.cost += l.quantity * (ingredientCosting(l.ingredient_id).current || 0); });
        by.set(i.name, r);
      });
      const rows = [...by.values()].sort((a, b) => b.rev - a.rev).map(r => [r.name, fmtNum(r.qty, 0), M(r.rev), M(r.cost), M(r.rev - r.cost), r.rev > 0 ? fmtNum(r.cost / r.rev * 100, 1) + '%' : '—']);
      const tq = [...by.values()].reduce((s, r) => s + r.qty, 0), tr = [...by.values()].reduce((s, r) => s + r.rev, 0), tc = [...by.values()].reduce((s, r) => s + r.cost, 0);
      return {headers: ['Item', 'Sold', SALES_LABELS.itemSales, 'Ingredient cost (today\'s prices)', 'Gross profit', 'Food cost %'], rows,
        total: ['Total', fmtNum(tq, 0), M(tr), M(tc), M(tr - tc), tr > 0 ? fmtNum(tc / tr * 100, 1) + '%' : '—'],
        note: 'Item prices are before sale discounts and tax. Ingredient cost uses today\'s costs and includes extras used by options. Voided sales are left out; refunds are not taken off per item.'};
    }
    case 'salesByCategory': {
      const by = {};
      items.forEach(i => {
        const r = state.recipes.find(x => x.id === i.recipe_id);
        const k = r ? posCategoryOf(r) : 'Not on the menu';
        by[k] = by[k] || {qty: 0, rev: 0}; by[k].qty += num(i.quantity); by[k].rev += num(i.line_total);
      });
      const total = Object.values(by).reduce((s, r) => s + r.rev, 0);
      return {headers: ['Menu section', 'Items sold', SALES_LABELS.itemSales, 'Share'], rows: Object.entries(by).sort((a, b) => b[1].rev - a[1].rev).map(([k, r]) => [k, fmtNum(r.qty, 0), M(r.rev), total > 0 ? fmtNum(r.rev / total * 100, 1) + '%' : '—'])};
    }
    case 'salesByHour': {
      const hours = Array.from({length: 24}, (_, h) => ({h, n: 0, t: 0}));
      sales.forEach(s => { const h = hourOf(s.transaction_date); hours[h].n++; hours[h].t += num(s.grand_total); });
      const days = Math.max(1, Math.round((ds.to - ds.from) / 86400000));
      return {headers: ['Hour', 'Transactions', 'Sales', 'Average per day'], rows: hours.filter(x => x.n).map(x => [`${calHourLabel(x.h)}–${calHourLabel((x.h + 1) % 24)}`, x.n, M(x.t), M(x.t / days)])};
    }
    case 'payments': {
      const by = {};
      sales.forEach(s => { const m = payLabel(payMethod(ds, s.id)); by[m] = by[m] || {n: 0, t: 0}; by[m].n++; by[m].t += num(s.grand_total); });
      return {headers: ['Payment method', 'Transactions', 'Total', 'Share'], rows: Object.entries(by).sort((a, b) => b[1].t - a[1].t).map(([m, v]) => [m, v.n, M(v.t), sum.gross > 0 ? fmtNum(v.t / sum.gross * 100, 1) + '%' : '—'])};
    }
    case 'cashiers': {
      const by = {};
      const row = (n) => (by[n] = by[n] || {n: 0, t: 0, voids: 0, refundsDone: 0, refundAmt: 0});
      ds.sales.filter(s => s.status !== 'HELD' && inRange(s.transaction_date, ds.from, ds.to)).forEach(s => {
        const r = row(s.cashier_name || '—');
        if(s.status === 'VOIDED') r.voids++; else { r.n++; r.t += num(s.grand_total); }
      });
      ds.refunds.filter(x => inRange(x.date, ds.from, ds.to)).forEach(x => { const r = row(x.approved_by_name || '—'); r.refundsDone++; r.refundAmt += num(x.amount); });
      return {headers: ['Name', 'Transactions', 'Sales', 'Voided sales', 'Refunds / voids approved', 'Amount approved'], rows: Object.entries(by).sort((a, b) => b[1].t - a[1].t).map(([n, r]) => [n, r.n, M(r.t), r.voids, r.refundsDone, M(r.refundAmt)])};
    }
    case 'shifts':
      return {headers: ['Shift', 'Cashier', 'Opened', 'Closed', SALES_LABELS.netSales, 'Expected cash', 'Counted cash', 'Over / short'], rows: ds.shifts.filter(s => inRange(s.opened_at, ds.from, ds.to)).sort((a, b) => String(a.opened_at).localeCompare(String(b.opened_at))).map(s => {
        const m = shiftMetrics(s, ds), closed = s.status === 'CLOSED';
        return [s.shift_number || '', s.cashier_name || '', fmtShopDateTime(s.opened_at), closed ? fmtShopDateTime(s.closed_at) : 'open',
          M(closed && s.net_sales != null ? s.net_sales : m.netSales), M(closed && s.expected_cash != null ? s.expected_cash : m.expectedCash), closed ? M(s.declared_cash) : '—', closed ? M(s.cash_variance) : '—'];
      }), note: 'Closed shifts show the figures saved when the shift was closed.'};
    case 'refunds':
      return {headers: ['Date', 'Receipt #', 'Type', 'Amount', 'Reason', 'Approved by'], rows: ds.refunds.filter(x => inRange(x.date, ds.from, ds.to)).sort((a, b) => String(a.date).localeCompare(String(b.date))).map(x => {
        const s = ds.sales.find(y => y.id === x.sale_id);
        return [fmtShopDateTime(x.date), s ? s.transaction_number : '(older sale)', ({VOID: 'Void', FULL_REFUND: 'Full refund', PARTIAL_REFUND: 'Partial refund'})[x.type] || x.type, M(x.amount), x.reason || '', x.approved_by_name || ''];
      })};
    case 'discounts':
      return {headers: ['Date', 'Receipt #', 'Cashier', 'Discount', 'Amount', 'Approved by', 'Sale total'], rows: sales.filter(s => num(s.discount_amount) > 0).map(s => [fmtShopDateTime(s.transaction_date), s.transaction_number || '', s.cashier_name || '',
        s.discount_type === 'percent' ? fmtNum(s.discount_value, 0) + '%' : 'fixed', M(s.discount_amount), s.discount_approved_by_name || '', M(s.grand_total)]),
        total: ['Total', '', '', '', M(sum.discounts), '', '']};
  }
  return {headers: [], rows: []};
}

let REP_LAST = null;
async function renderReports(){
  const content = document.getElementById('content');
  const def = REPORTS.find(r => r.id === repState.active) || REPORTS[0];
  const btns = (group) => REPORTS.filter(r => r.group === group).map(r => `<button class="btn btn-sm ${repState.active === r.id ? 'btn-primary' : 'btn-outline'}" data-report="${r.id}">${esc(r.name)}</button>`).join('');
  content.innerHTML = `
    <div class="card" style="margin-bottom:16px;">
      <div class="text-light" style="font-size:11.5px;text-transform:uppercase;font-weight:700;margin-bottom:6px;">Stock &amp; menu</div>
      <div class="toolbar-left">${btns('stock')}</div>
      <div class="text-light" style="font-size:11.5px;text-transform:uppercase;font-weight:700;margin:14px 0 6px;">Sales</div>
      <div class="toolbar-left">${btns('sales')}</div>
    </div>
    <div class="toolbar">
      <div class="toolbar-left"><b style="font-size:16px;">${esc(def.name)}</b>${def.group === 'sales' ? rangePickerHtml(repState, 'rep') : ''}</div>
      <div class="field-inline"><button class="btn btn-outline btn-sm" id="print-report">🖨 Print / PDF</button><button class="btn btn-outline btn-sm" id="export-report-csv">Export CSV</button></div>
    </div>
    <div id="report-body"><div class="loading-line">Working it out…</div></div>`;
  content.querySelectorAll('[data-report]').forEach(b => b.onclick = () => { repState.active = b.dataset.report; renderReports(); });
  content.querySelector('#export-report-csv').onclick = exportReportCSV;
  content.querySelector('#print-report').onclick = printReport;
  if(def.group === 'sales') wireRangePicker(content, repState, 'rep', () => drawReport());
  drawReport();
}
async function drawReport(){
  const wrap = document.getElementById('report-body'); if(!wrap) return;
  const def = REPORTS.find(r => r.id === repState.active) || REPORTS[0];
  let rep, label = '';
  try{
    if(def.group === 'sales'){
      wrap.classList.add('dim');
      const [a, b] = presetKeys(repState.preset, repState);
      label = a === b ? keyLabel(a) : `${keyLabel(a)} – ${keyLabel(b)}`;
      const ds = await salesForRange(dayRange(a, b));
      rep = salesReport(def.id, ds);
    } else rep = stockReport(def.id);
  }catch(e){ wrap.classList.remove('dim'); wrap.innerHTML = emptyBlock(esc(friendlyError(e))); return; }
  wrap.classList.remove('dim');
  if(state.route !== 'reports' || repState.active !== def.id) return;
  REP_LAST = Object.assign({id: def.id, name: def.name, label}, rep);
  if(!rep.rows.length){ wrap.innerHTML = emptyBlock(def.group === 'sales' ? 'No sales in these dates.' : 'No data for this report yet.'); return; }
  const numCols = rep.headers.map((_, i) => rep.rows.some(r => cellNum(r[i])));
  const td = (c, i) => `<td${numCols[i] ? ' class="num"' : ''}>${esc(cellText(c))}</td>`;
  wrap.innerHTML = `${label ? `<p class="hint" style="margin:-6px 0 10px;">${esc(label)} · shop time (${esc(shopTz())})</p>` : ''}
    <div class="table-wrap"><table><thead><tr>${rep.headers.map((h, i) => `<th${numCols[i] ? ' class="num"' : ''}>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${rep.rows.map(r => `<tr>${r.map(td).join('')}</tr>`).join('')}
    ${rep.total ? `<tr style="background:var(--beige);font-weight:700;">${rep.total.map(td).join('')}</tr>` : ''}</tbody></table></div>
    ${rep.note ? `<p class="hint" style="margin-top:8px;">${esc(rep.note)}</p>` : ''}`;
}
function exportReportCSV(){
  const r = REP_LAST;
  if(!r || !r.rows.length){ toast('Nothing to export', 'warn'); return; }
  const rows = r.rows.map(x => x.map(cellCsv)).concat(r.total ? [r.total.map(cellCsv)] : []);
  downloadFile(`${fileNameSlug()}-${r.id}-report-${shopTodayKey()}.csv`, toCSV(r.headers, rows), 'text/csv');
  toast('Report exported as CSV');
}
function printReport(){
  const r = REP_LAST;
  if(!r || !r.rows.length){ toast('Nothing to print', 'warn'); return; }
  const s = state.settings;
  openPrintWindow(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(r.name)} — ${esc(businessName() || appDisplayName())}</title>
    <style>
      body{font-family:Georgia,'Times New Roman',serif;padding:36px;color:#241209;}
      .header{display:flex;align-items:center;gap:14px;border-bottom:2px solid #241209;padding-bottom:14px;margin-bottom:16px;}
      .header img{width:44px;height:44px;object-fit:contain;border-radius:6px;}
      h1{font-size:19px;margin:0;} .sub{font-size:13px;color:#6f5c48;margin-top:2px;} .meta{font-size:11.5px;color:#6f5c48;margin-bottom:16px;}
      table{width:100%;border-collapse:collapse;} th,td{border:1px solid #d8c8a4;padding:6px 10px;text-align:left;font-size:12px;} th{background:#e9dcc4;}
      tr.total td{font-weight:700;background:#f3ead9;} @media print{body{padding:12px;}}
    </style></head><body>
    <div class="header">${s.logo_url ? `<img src="${esc(s.logo_url)}" alt="">` : ''}<div><h1>${esc(businessName() || appDisplayName())}</h1><div class="sub">${esc(r.name)} report${r.label ? ' · ' + esc(r.label) : ''}</div></div></div>
    <div class="meta">Printed from the Back Office on ${esc(fmtShopDateTime(new Date()))}</div>
    <table><thead><tr>${r.headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${r.rows.map(x => `<tr>${x.map(c => `<td>${esc(cellText(c))}</td>`).join('')}</tr>`).join('')}${r.total ? `<tr class="total">${r.total.map(c => `<td>${esc(cellText(c))}</td>`).join('')}</tr>` : ''}</tbody></table>
    ${r.note ? `<p style="font-size:11px;color:#6f5c48;">${esc(r.note)}</p>` : ''}</body></html>`, true);
}
