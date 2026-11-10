/* =====================================================================
   BACK OFFICE — release 1.4 (Wave 2), owner only:
     A11 Expenses log (rent, utilities, wages, operating supplies...) with an
         optional receipt photo in the PRIVATE "expense-photos" bucket
         (path "<business id>/<file>"), and the monthly Net income report
         (net_income_report: the database does the sums).
     A15 Waste report (waste_report): counter waste logs + Back Office waste,
         per day and per reason, with cost, who, approvals and review flags.
   Every text from the database (notes, names, option labels) is escaped.
   CSV files go through the shared formula-safe toCSV().
   ===================================================================== */

function monthKeyNow(){ return shopTodayKey().slice(0, 7); }
function monthLabel(ym){ const [y, m] = String(ym).split('-').map(Number); return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString('en-PH', {month: 'long', year: 'numeric', timeZone: 'UTC'}); }
function monthLastDay(ym){ return keyAddDays(keyAddMonths(ym + '-01', 1), -1); }

/* ================= Expenses ================= */
const expFilter = {month: '', category: ''};
let EXP_ROWS = [];
async function renderExpenses(){
  if(!expFilter.month) expFilter.month = monthKeyNow();
  const bar = setTopbarActions(`<button class="btn btn-primary" id="btn-new-expense">+ Add expense</button>`);
  bar.querySelector('#btn-new-expense').onclick = () => openExpenseForm(null);
  const content = document.getElementById('content');
  content.innerHTML = `
    <div class="toolbar">
      <div class="toolbar-left">
        <label class="sr-only" for="exp-month">Month</label><input type="month" class="filter" id="exp-month" value="${esc(expFilter.month)}" max="${esc(monthKeyNow())}">
        <select class="filter" id="exp-cat" aria-label="Category"><option value="">All categories</option>${EXPENSE_CATEGORIES.map(c => `<option value="${c.id}" ${expFilter.category === c.id ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select>
      </div>
      <div class="field-inline"><button class="btn btn-outline btn-sm" id="exp-csv">Export CSV</button><button class="btn btn-ghost btn-sm" id="exp-go-net">See net income →</button></div>
    </div>
    <div id="exp-body"><div class="loading-line">Loading expenses…</div></div>`;
  content.querySelector('#exp-month').onchange = (e) => { if(e.target.value){ expFilter.month = e.target.value; drawExpenses(); } };
  content.querySelector('#exp-cat').onchange = (e) => { expFilter.category = e.target.value; drawExpenses(true); };
  content.querySelector('#exp-csv').onclick = exportExpensesCSV;
  content.querySelector('#exp-go-net').onclick = () => { netState.month = expFilter.month; navigate('netIncome'); };
  await drawExpenses();
}
async function drawExpenses(cached){
  const wrap = document.getElementById('exp-body'); if(!wrap) return;
  const month = expFilter.month;
  if(!cached){
    wrap.classList.add('dim');
    try{
      EXP_ROWS = await cloud.selectAll('expenses', {gte: {expense_date: month + '-01'}, lte: {expense_date: monthLastDay(month)}, order: 'expense_date.desc,created_at.desc'});
    }catch(e){ wrap.classList.remove('dim'); wrap.innerHTML = emptyBlock(esc(friendlyError(e))); return; }
    wrap.classList.remove('dim');
    if(state.route !== 'expenses' || expFilter.month !== month) return;
  }
  const list = EXP_ROWS.filter(x => !expFilter.category || x.category === expFilter.category);
  const total = list.reduce((s, x) => s + num(x.amount), 0);
  const byCat = {};
  EXP_ROWS.forEach(x => { byCat[x.category] = (byCat[x.category] || 0) + num(x.amount); });
  wrap.innerHTML = `
    <div class="grid grid-4 kpi-sans" style="margin-bottom:16px;">
      ${statCard(expFilter.category ? esc(expenseCategoryLabel(expFilter.category)) : 'Expenses this month', fmtMoney(total), esc(monthLabel(month)) + ' · ' + plural(list.length, 'entry', 'entries'))}
      ${EXPENSE_CATEGORIES.filter(c => byCat[c.id]).sort((a, b) => byCat[b.id] - byCat[a.id]).slice(0, 3).map(c => statCard(esc(c.label), fmtMoney(byCat[c.id]), '')).join('')}
    </div>
    ${list.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Date</th><th>Category</th><th>Note</th><th>Item</th><th class="num">Amount</th><th>Receipt</th><th></th></tr></thead>
      <tbody>${list.map(x => `<tr data-exp="${esc(x.id)}">
        <td>${fmtDay(x.expense_date)}</td><td>${esc(expenseCategoryLabel(x.category))}</td>
        <td class="exp-note">${esc(x.note || '')}</td>
        <td>${x.ingredient_id ? esc(ingName(x.ingredient_id)) + (x.quantity ? ` <span class="text-light">${esc(fmtNum(x.quantity, 2))} ${esc(unitLabel(x.unit || ''))}</span>` : '') : '<span class="text-light">—</span>'}</td>
        <td class="num"><b>${fmtMoney(x.amount)}</b></td>
        <td>${x.photo_path ? `<button class="btn btn-sm btn-ghost" data-exp-photo="${esc(x.id)}">View</button>` : '<span class="text-light">—</span>'}</td>
        <td class="row-actions"><button class="btn btn-sm btn-ghost" data-exp-edit="${esc(x.id)}">Edit</button><button class="btn btn-sm btn-ghost" data-exp-del="${esc(x.id)}">Delete</button></td></tr>`).join('')}
      <tr style="background:var(--beige);font-weight:700;"><td colspan="4">Total</td><td class="num">${fmtMoney(total)}</td><td colspan="2"></td></tr>
      </tbody></table></div>` : emptyBlock(`No expenses in ${esc(monthLabel(month))}${expFilter.category ? ' for ' + esc(expenseCategoryLabel(expFilter.category)) : ''} yet. <br><br><button class="btn btn-primary" id="exp-empty-add">+ Add expense</button>`)}
    <p class="hint" style="margin-top:10px;">Operating supplies bought on the Purchases screen are saved here automatically (category "Operating supplies"). Wages here are a simple amount per entry, not payroll.</p>`;
  const ea = wrap.querySelector('#exp-empty-add'); if(ea) ea.onclick = () => openExpenseForm(null);
  wrap.querySelectorAll('[data-exp-edit]').forEach(b => b.onclick = () => openExpenseForm(EXP_ROWS.find(x => x.id === b.dataset.expEdit)));
  wrap.querySelectorAll('[data-exp-del]').forEach(b => b.onclick = () => deleteExpense(EXP_ROWS.find(x => x.id === b.dataset.expDel)));
  wrap.querySelectorAll('[data-exp-photo]').forEach(b => b.onclick = () => busy(b, () => showExpensePhoto(EXP_ROWS.find(x => x.id === b.dataset.expPhoto)), '…'));
}
function exportExpensesCSV(){
  const list = EXP_ROWS.filter(x => !expFilter.category || x.category === expFilter.category);
  if(!list.length){ toast('Nothing to export', 'warn'); return; }
  const rows = list.map(x => [dayValue(x.expense_date), expenseCategoryLabel(x.category), x.note || '', x.ingredient_id ? ingName(x.ingredient_id) : '', x.quantity == null ? '' : x.quantity, x.unit || '', x.supplier_id ? supName(x.supplier_id) : '', num(x.amount).toFixed(2)]);
  rows.push(['Total', '', '', '', '', '', '', list.reduce((s, x) => s + num(x.amount), 0).toFixed(2)]);
  downloadFile(`${fileNameSlug()}-expenses-${expFilter.month}.csv`, toCSV(['Date', 'Category', 'Note', 'Item', 'Quantity', 'Unit', 'Supplier', 'Amount'], rows), 'text/csv');
  toast('Expenses exported as CSV');
}
// Receipt photos live in a PRIVATE bucket: read with the owner's login (never a public link).
async function fetchExpensePhoto(path){
  return URL.createObjectURL(await cloud.download('expense-photos', path));
}
// Old receipt files are removed AFTER the row change saved; a failure only goes to the console.
// Only files in this shop's own folder ("<business_id>/...") are ever removed.
function removeExpensePhoto(path){
  if(!path || !state.business || String(path).indexOf(state.business.id + '/') !== 0 || /\.\./.test(String(path))) return;
  cloud.remove('expense-photos', [path]).catch(e => console.warn('old receipt photo not removed', path, e));
}
async function showExpensePhoto(x){
  if(!x || !x.photo_path) return;
  let url;
  try{ url = await fetchExpensePhoto(x.photo_path); }catch(e){ toast(friendlyError(e), 'error'); return; }
  openModal({title: 'Receipt', body: `<img src="${esc(url)}" alt="Receipt photo" class="exp-receipt"><p class="hint">${esc(fmtDay(x.expense_date))} · ${esc(expenseCategoryLabel(x.category))} · ${fmtMoney(x.amount)}</p>`,
    foot: '<button class="btn btn-primary" data-cancel>Close</button>',
    onClose: () => URL.revokeObjectURL(url), onMount: (root) => { root.querySelector('[data-cancel]').onclick = closeModal; }});
}
async function deleteExpense(x){
  if(!x) return;
  const ok = await confirmDialog(`Delete this expense: <b>${esc(expenseCategoryLabel(x.category))}</b>, ${fmtMoney(x.amount)} on ${esc(fmtDay(x.expense_date))}${x.note ? ` (${esc(x.note)})` : ''}? This cannot be undone.`, 'Delete expense');
  if(!ok) return;
  if(await boSave([Ops.del('expenses', x.id), Ops.audit('Expense deleted', `${expenseCategoryLabel(x.category)} — ${fmtMoney(x.amount)} (${dayValue(x.expense_date)})${x.note ? ' · ' + x.note : ''}`, x.id)], {success: 'Expense deleted', reload: false})){ removeExpensePhoto(x.photo_path); drawExpenses(); }
}
function openExpenseForm(x){
  const editing = x || null;
  const today = shopTodayKey();
  const supplies = expenseIngredientsList().sort(byName);
  const body = `
    <div class="form-grid">
      <div class="form-row"><label for="ex-date">Date</label><input type="date" id="ex-date" value="${esc(editing ? dayValue(editing.expense_date) : today)}" max="${esc(keyAddDays(today, 1))}"></div>
      <div class="form-row"><label for="ex-cat">Category</label><select id="ex-cat">${EXPENSE_CATEGORIES.map(c => `<option value="${c.id}" ${(editing ? editing.category : (expFilter.category || 'RENT')) === c.id ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select></div>
    </div>
    <div class="form-row"><label for="ex-amount">Amount (₱)</label><input type="number" id="ex-amount" step="any" min="0" value="${esc(editing ? num(editing.amount) : '')}" placeholder="e.g. 12000"></div>
    <div class="form-grid" id="ex-supply-row" style="display:none;">
      <div class="form-row"><label for="ex-ing">Item (optional)</label><select id="ex-ing"><option value="">—</option>${supplies.map(i => `<option value="${esc(i.id)}" ${editing && editing.ingredient_id === i.id ? 'selected' : ''}>${esc(i.name)}</option>`).join('')}${editing && editing.ingredient_id && !supplies.some(i => i.id === editing.ingredient_id) ? `<option value="${esc(editing.ingredient_id)}" selected>${esc(ingName(editing.ingredient_id))}</option>` : ''}</select></div>
      <div class="form-row"><label for="ex-sup">Supplier (optional)</label><select id="ex-sup"><option value="">—</option>${selectOptions(state.suppliers.slice().sort(byName), editing ? editing.supplier_id : '')}</select></div>
    </div>
    <div class="form-row"><label for="ex-note">Note (optional)</label><textarea id="ex-note" rows="2" maxlength="500" placeholder="e.g. Meralco, October">${esc(editing ? (editing.note || '') : '')}</textarea></div>
    <div class="form-row"><label>Receipt photo (optional)</label>
      <div class="field-inline">
        <span id="ex-photo-state" class="text-light">${editing && editing.photo_path ? 'A photo is saved' : 'No photo'}</span>
        <button class="btn btn-outline btn-sm" type="button" id="ex-photo-btn">Choose a photo</button>
        <button class="btn btn-ghost btn-sm" type="button" id="ex-photo-rm" ${editing && editing.photo_path ? '' : 'style="display:none;"'}>Remove photo</button>
        <input type="file" id="ex-photo" accept="image/*" style="display:none;">
      </div>
      <div class="hint">Kept private: only your owner login can open it. Shrunk before uploading.</div></div>`;
  openModal({title: editing ? 'Edit expense' : 'Add expense', body,
    foot: `<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" id="ex-save">${editing ? 'Save changes' : 'Add expense'}</button>`,
    onMount: (root) => {
      const q = (s) => root.querySelector(s);
      q('[data-cancel]').onclick = closeModal;
      const syncCat = () => { q('#ex-supply-row').style.display = q('#ex-cat').value === 'SUPPLIES' ? '' : 'none'; };
      q('#ex-cat').onchange = syncCat; syncCat();
      let photo = {path: editing ? editing.photo_path || null : null, blob: null};
      q('#ex-photo-btn').onclick = () => q('#ex-photo').click();
      q('#ex-photo-rm').onclick = () => { photo = {path: null, blob: null}; q('#ex-photo-state').textContent = 'No photo'; q('#ex-photo-rm').style.display = 'none'; };
      q('#ex-photo').onchange = async (e) => {
        const f = e.target.files[0]; if(!f) return;
        try{ photo = {path: null, blob: await resizeImage(f, 1400, 'image/jpeg', 0.8)}; q('#ex-photo-state').textContent = 'New photo: ' + f.name; q('#ex-photo-rm').style.display = ''; }
        catch(err){ toast(err.message || 'Could not read that picture', 'error'); }
      };
      const save = q('#ex-save');
      save.onclick = () => busy(save, async () => {
        const amount = Number(q('#ex-amount').value);
        if(!(amount > 0)){ toast('Enter an amount above ₱0', 'error'); q('#ex-amount').focus(); return; }
        if(amount > 100000000){ toast('That amount is too large', 'error'); return; }
        const date = q('#ex-date').value;
        if(!/^\d{4}-\d{2}-\d{2}$/.test(date)){ toast('Choose a date', 'error'); return; }
        const id = editing ? editing.id : uid(), cat = q('#ex-cat').value, now = nowISO();
        let path = photo.path;
        if(photo.blob){
          if(!state.business){ toast('The shop is not loaded yet.', 'error'); return; }
          path = `${state.business.id}/${id}-${Date.now()}.jpg`;
          try{ await cloud.upload('expense-photos', path, photo.blob, 'image/jpeg'); }
          catch(err){ toast('The receipt photo could not be uploaded: ' + friendlyError(err) + ' Remove the photo or try again.', 'error'); return; }
        }
        const row = {id, expense_date: date, category: cat, amount: Math.round(amount * 100) / 100,
          note: q('#ex-note').value.trim().slice(0, 500) || null, photo_path: path || null,
          ingredient_id: cat === 'SUPPLIES' ? (q('#ex-ing').value || null) : null,
          supplier_id: cat === 'SUPPLIES' ? (q('#ex-sup').value || null) : null,
          updated_at: now};
        if(editing){ if(cat !== 'SUPPLIES'){ row.quantity = null; row.unit = null; } }
        else Object.assign(row, {created_by: cloud.userId(), created_at: now});
        const ops = [editing ? Ops.update('expenses', row) : Ops.upsert('expenses', row),
          Ops.audit(editing ? 'Expense updated' : 'Expense recorded', `${expenseCategoryLabel(cat)} — ${fmtMoney(row.amount)} (${date})${row.note ? ' · ' + row.note : ''}`, id)];
        if(await boSave(ops, {success: editing ? 'Expense updated' : 'Expense added', reload: false})){
          if(editing && editing.photo_path && editing.photo_path !== row.photo_path) removeExpensePhoto(editing.photo_path);    // replaced or removed
          closeModal();
          if(state.route === 'expenses'){ if(date.slice(0, 7) !== expFilter.month) expFilter.month = date.slice(0, 7); renderExpenses(); }
        }
        else if(photo.blob && path) removeExpensePhoto(path);       // the row was not saved: don't leave the new file behind
      });
    }});
}

/* ================= Net income (monthly) ================= */
const netState = {month: ''};
let NET_LAST = null;
async function renderNetIncome(){
  if(!netState.month) netState.month = monthKeyNow();
  const content = document.getElementById('content');
  content.innerHTML = `
    <div class="toolbar">
      <div class="toolbar-left">
        <button class="btn btn-sm btn-ghost" id="ni-prev" aria-label="Previous month">${icon('chevron-left', {size: 18})}</button>
        <label class="sr-only" for="ni-month">Month</label><input type="month" class="filter" id="ni-month" value="${esc(netState.month)}" max="${esc(monthKeyNow())}">
        <button class="btn btn-sm btn-ghost" id="ni-next" aria-label="Next month" ${netState.month >= monthKeyNow() ? 'disabled' : ''}>${icon('chevron-right', {size: 18})}</button>
      </div>
      <div class="field-inline"><button class="btn btn-outline btn-sm" id="ni-csv">Export CSV</button><button class="btn btn-ghost btn-sm" id="ni-go-exp">Expenses →</button></div>
    </div>
    <div id="ni-body"><div class="loading-line">Working it out…</div></div>`;
  const setMonth = (m) => { netState.month = m; renderNetIncome(); };
  content.querySelector('#ni-month').onchange = (e) => { if(e.target.value) setMonth(e.target.value); };
  content.querySelector('#ni-prev').onclick = () => setMonth(keyAddMonths(netState.month + '-01', -1).slice(0, 7));
  content.querySelector('#ni-next').onclick = () => setMonth(keyAddMonths(netState.month + '-01', 1).slice(0, 7));
  content.querySelector('#ni-csv').onclick = exportNetIncomeCSV;
  content.querySelector('#ni-go-exp').onclick = () => { expFilter.month = netState.month; navigate('expenses'); };
  const month = netState.month;
  let r;
  try{ r = await cloud.rpc('net_income_report', {p_month: month + '-01'}); }
  catch(e){ const w = document.getElementById('ni-body'); if(w) w.innerHTML = emptyBlock(esc(friendlyError(e))); return; }
  if(state.route !== 'netIncome' || netState.month !== month) return;
  NET_LAST = r;
  const w = document.getElementById('ni-body'); if(!w) return;
  w.innerHTML = netIncomeHtml(r);
}
// [label, amount (₱, signed as it counts), kind] — shared by the screen and the CSV
function netIncomeLines(r){
  const S = r.sales || {}, I = r.ingredients || {}, E = r.expenses || {}, by = E.by_category || {};
  const L = [
    ['Sales (finished, not voided)', num(S.gross), 'line'],
    ['Refunds', -num(S.refunds), 'line'],
    ['Tax collected (owed, not income)', -num(S.tax), 'line'],
    ['Net sales', num(S.net), 'sub'],
    ['Ingredients used for sales', -num(I.sold), 'line'],
    ['Ingredients wasted', -num(I.wasted), 'line'],
  ];
  // 012: parts of the waste line (already inside "Ingredients wasted", never taken off again)
  if(num(I.rnd)) L.push(['Of which R&D (in the line above)', -num(I.rnd), 'part']);
  (Array.isArray(r.rnd_projects) ? r.rnd_projects : []).forEach(p => { if(num(p.cost)) L.push(['R&D project: ' + (p.name || 'project'), -num(p.cost), 'part sub2']); });
  if(num(I.count_shortage)) L.push(['Of which missing at count (in the line above)', -num(I.count_shortage), 'part']);
  EXPENSE_CATEGORIES.forEach(c => { if(by[c.id]) L.push(['Expenses: ' + c.label, -num(by[c.id]), 'line']); });
  Object.keys(by).filter(k => !EXPENSE_CATEGORIES.some(c => c.id === k)).forEach(k => L.push(['Expenses: ' + k, -num(by[k]), 'line']));
  L.push(['Net income', num(r.net_income), 'total']);
  return L;
}
function netIncomeHtml(r){
  const S = r.sales || {}, I = r.ingredients || {}, E = r.expenses || {};
  const ni = num(r.net_income);
  const signed = (v) => (v < 0 ? '−' : '') + fmtMoney(Math.abs(v));
  return `
    <div class="grid grid-4 kpi-sans" style="margin-bottom:16px;">
      ${statCard('Net sales', fmtMoney(S.net), plural(num(S.count), 'sale') + ' · tax taken out')}
      ${statCard('Ingredients used', fmtMoney(I.used), `${fmtMoney(I.sold)} sold · ${fmtMoney(I.wasted)} wasted<div class="ni-cost-note">Costed at this month's ingredient cost, so wasted amounts can differ slightly from the Waste report, which keeps the cost on the day it was logged.</div>`)}
      ${statCard('Expenses', fmtMoney(E.total), '<a class="linklike" id="ni-exp-link">see the list</a>')}
      ${statCard('Net income', `<span class="${ni < 0 ? 'text-red' : 'text-green'}">${signed(ni)}</span>`, esc(monthLabel(r.month || netState.month)))}
    </div>
    <div class="card ni-statement">
      <h3 class="ni-title">${esc(monthLabel(r.month || netState.month))} <span class="text-light">· ${esc(fmtDay(r.from))} to ${esc(fmtDay(r.to))}, shop time</span></h3>
      <table class="ni-table"><tbody>
        ${netIncomeLines(r).map(([label, v, kind]) => `<tr class="${kind.split(' ').map(k => 'ni-' + k).join(' ')}"><td>${esc(label)}</td><td class="num">${kind === 'line' && v > 0 ? '' : ''}${signed(v)}</td></tr>`).join('')}
      </tbody></table>
      <p class="hint" style="margin-bottom:0;">Service charge collected: ${fmtMoney(S.service_charge)} (kept in net sales as income). Ingredients are costed with your costing method (${costingMethod() === 'latest' ? 'latest purchase price' : 'weighted average'}) as of the month's last day; stock counts and production are not costs here. Refunds count in the month they were given.</p>
    </div>`;
}
document.addEventListener('click', (e) => { if(e.target && e.target.id === 'ni-exp-link'){ expFilter.month = netState.month; navigate('expenses'); } });
function exportNetIncomeCSV(){
  const r = NET_LAST;
  if(!r){ toast('Nothing to export', 'warn'); return; }
  const rows = netIncomeLines(r).map(([label, v]) => [label, v.toFixed(2)]);
  rows.push(['Service charge collected (in net sales)', num((r.sales || {}).service_charge).toFixed(2)]);
  downloadFile(`${fileNameSlug()}-net-income-${r.month || netState.month}.csv`, toCSV(['Net income ' + (r.month || netState.month), 'Amount'], rows), 'text/csv');
  toast('Net income exported as CSV');
}

/* ================= Waste report (A15) ================= */
const wrState = {preset: 'month', from: '', to: ''};
let WR_LAST = null;
// A reason code (counter waste, R&D, missing at count) in plain words; the Back Office "Record waste" form
// keeps the words the owner chose (e.g. "Expired"), shown as they are. (012 labels every waste-log row
// without a counter as OFFICE, so the code check no longer depends on the source.)
const WASTE_REASON_CODES = ['CALIBRATION', 'SPILLAGE', 'COMPLIMENTARY', 'EXPIRED', 'OTHER', 'RND', 'COUNT_SHORTAGE'];
function wasteReasonText(entry){
  const r = String((entry && entry.reason) || '');
  return WASTE_REASON_CODES.includes(r) ? wasteReasonLabel(r) : (r || 'Other');
}
function wasteWhereText(x){ return x.source === 'COUNTER' ? 'Counter' : (x.reason === 'RND' ? 'R&D' : 'Back Office'); }
async function renderWasteReport(){
  const content = document.getElementById('content');
  content.innerHTML = `
    <div class="toolbar">
      <div class="toolbar-left">${rangePickerHtml(wrState, 'wr')}</div>
      <div class="field-inline"><button class="btn btn-outline btn-sm" id="wr-csv">Export CSV</button><button class="btn btn-ghost btn-sm" id="wr-go-inv">Record waste in the Back Office →</button></div>
    </div>
    <div id="wr-body"><div class="loading-line">Working it out…</div></div>`;
  wireRangePicker(content, wrState, 'wr', () => drawWasteReport());
  content.querySelector('#wr-csv').onclick = exportWasteCSV;
  content.querySelector('#wr-go-inv').onclick = () => navigate('inventory');
  await drawWasteReport();
}
async function drawWasteReport(){
  const wrap = document.getElementById('wr-body'); if(!wrap) return;
  const [a, b] = presetKeys(wrState.preset, wrState);
  const key = a + '|' + b;
  wrap.classList.add('dim');
  let r, flags = {};
  try{
    r = await cloud.rpc('waste_report', {p_from: a, p_to: b});
    // every flagged row (counter or office): its reason codes are on the waste_logs row
    const ids = (r.entries || []).filter(x => x.needs_review).map(x => x.id);
    for(let i = 0; i < ids.length; i += 100){
      const rows = await cloud.select('waste_logs', {select: 'id,review_reason,staff_id,signed_in_staff_id', in: {id: ids.slice(i, i + 100)}}).catch(() => []);
      (rows || []).forEach(x => { flags[x.id] = x.review_reason || ''; });
    }
  }catch(e){ wrap.classList.remove('dim'); wrap.innerHTML = emptyBlock(esc(friendlyError(e))); return; }
  wrap.classList.remove('dim');
  const [a2, b2] = presetKeys(wrState.preset, wrState);
  if(state.route !== 'wasteReport' || key !== a2 + '|' + b2) return;
  WR_LAST = Object.assign({}, r, {flags, label: a === b ? keyLabel(a) : `${keyLabel(a)} – ${keyLabel(b)}`});
  const entries = r.entries || [];
  if(!entries.length){ wrap.innerHTML = `<p class="hint">${esc(WR_LAST.label)}</p>` + emptyBlock('No waste logged in these dates.'); return; }
  const flagged = entries.filter(x => x.needs_review);
  const comp = entries.filter(x => x.source === 'COUNTER' && x.reason === 'COMPLIMENTARY');
  const rnd = entries.filter(x => x.reason === 'RND'), shortage = entries.filter(x => x.reason === 'COUNT_SHORTAGE');
  // per day: one row per day, a column per reason (cost)
  const reasons = (r.by_reason || []).map(x => x.reason);
  const reasonLabelOf = (code) => { const e = entries.find(x => x.reason === code); return e ? wasteReasonText(e) : (WASTE_REASONS.some(w => w.id === code) ? wasteReasonLabel(code) : String(code)); };
  const days = {};
  (r.by_day || []).forEach(d => { const k = dayValue(d.day); (days[k] = days[k] || {total: 0, n: 0, by: {}}); days[k].by[d.reason] = (days[k].by[d.reason] || 0) + num(d.cost); days[k].total += num(d.cost); days[k].n += num(d.entries); });
  const dayKeys = Object.keys(days).sort().reverse();
  wrap.innerHTML = `
    <p class="hint" style="margin:-6px 0 10px;">${esc(WR_LAST.label)} · shop time (${esc(shopTz())}) · costs at the cost of the day it was logged</p>
    <div class="grid grid-4 kpi-sans" style="margin-bottom:16px;">
      ${statCard('Waste cost', fmtMoney(r.total_cost), plural(entries.length, 'entry', 'entries'))}
      ${statCard('From counters', fmtMoney(entries.filter(x => x.source === 'COUNTER').reduce((s, x) => s + num(x.cost), 0)), plural(entries.filter(x => x.source === 'COUNTER').length, 'entry', 'entries'))}
      ${statCard('Complimentary', fmtMoney(comp.reduce((s, x) => s + num(x.cost), 0)), plural(comp.length, 'entry', 'entries') + ', manager approved')}
      ${statCard('To review', flagged.length, flagged.length ? 'see the flags below' : 'nothing flagged')}
    </div>
    ${(r.by_project || []).length || shortage.length ? `<div class="grid grid-4 kpi-sans" style="margin-bottom:16px;">
      ${statCard('R&amp;D', fmtMoney(rnd.reduce((s, x) => s + num(x.cost), 0)), plural(rnd.length, 'entry', 'entries') + ' · <a class="linklike" data-go-rnd>R&amp;D log</a>')}
      ${statCard('Missing at count', fmtMoney(shortage.reduce((s, x) => s + num(x.cost), 0)), plural(shortage.length, 'count') + ' · <a class="linklike" data-go-counts>stock counts</a>')}
    </div>` : ''}
    ${(r.by_project || []).length ? `<div class="card wr-projects" style="margin-bottom:16px;"><b>R&amp;D cost by project</b>
      <table class="wr-small"><thead><tr><th>Project</th><th>Status</th><th class="num">Entries</th><th class="num">Cost</th></tr></thead><tbody>
        ${r.by_project.map(p => `<tr><td>${esc(p.name || '')}</td><td>${esc(rndStatusLabel(p.status))}</td><td class="num">${esc(String(p.entries))}</td><td class="num">${fmtMoney(p.cost)}</td></tr>`).join('')}
      </tbody></table></div>` : ''}
    <div class="grid grid-2 wr-grid">
      <div class="card"><b>By reason</b>
        <table class="wr-small"><thead><tr><th>Reason</th><th class="num">Entries</th><th class="num">Cost</th></tr></thead><tbody>
          ${(r.by_reason || []).map(x => `<tr><td>${esc(reasonLabelOf(x.reason))}</td><td class="num">${esc(String(x.entries))}</td><td class="num">${fmtMoney(x.cost)}</td></tr>`).join('')}
        </tbody></table></div>
      <div class="card"><b>By day</b>
        <div class="wr-days"><table class="wr-small"><thead><tr><th>Day</th><th class="num">Entries</th><th>Biggest reason</th><th class="num">Cost</th></tr></thead><tbody>
          ${dayKeys.map(k => { const d = days[k]; const top = Object.keys(d.by).sort((x, y) => d.by[y] - d.by[x])[0]; return `<tr><td>${esc(keyLabel(k, {weekday: 'short', month: 'short', day: 'numeric'}))}</td><td class="num">${d.n}</td><td>${esc(reasonLabelOf(top))}</td><td class="num">${fmtMoney(d.total)}</td></tr>`; }).join('')}
        </tbody></table></div></div>
    </div>
    <div class="section-title">Entries ${entries.length >= 500 ? '<span class="text-light">(newest 500)</span>' : ''}</div>
    <div class="table-wrap"><table class="wr-entries">
      <thead><tr><th>Day</th><th>Where</th><th>Reason</th><th>What</th><th>Who</th><th class="num">Cost</th></tr></thead>
      <tbody>${entries.map(x => `<tr class="${x.needs_review ? 'wr-flag-row' : ''}">
        <td>${fmtDay(x.day)}</td>
        <td><span class="badge badge-gray"${x.source === 'COUNTER' ? '' : ' style="opacity:.7;"'}>${esc(wasteWhereText(x))}</span></td>
        <td>${esc(wasteReasonText(x))}${x.project_name ? `<div class="hint">Project: ${esc(x.project_name)}</div>` : ''}${x.note ? `<div class="hint">${esc(x.note)}</div>` : ''}</td>
        <td>${(x.items || []).map(it => `<div>${esc(fmtNum(it.quantity, 2).replace(/\.00$/, ''))}${it.unit ? ' ' + esc(unitLabel(it.unit)) : ' ×'} ${esc(it.name || (it.recipe_id ? 'menu item' : 'ingredient'))}${Array.isArray(it.modifiers) && it.modifiers.length ? ` <span class="text-light">(${it.modifiers.map(m => esc((m && m.label) || '')).join(', ')})</span>` : ''} <span class="text-light">${fmtMoney(it.cost)}</span></div>`).join('')}</td>
        <td>${esc(x.staff_name || (x.source === 'OFFICE' ? 'Back Office' : '—'))}${x.approved_by_name ? `<div class="hint">Approved by ${esc(x.approved_by_name)}</div>` : ''}
          ${x.needs_review ? `<div class="review-flag">${icon('alert', {size: 16})} ${esc(reviewReasonText(flags[x.id] || ''))}</div>` : ''}</td>
        <td class="num"><b>${fmtMoney(x.cost)}</b></td></tr>`).join('')}</tbody></table></div>
    <p class="hint wr-cost-note" style="margin-top:8px;">Costs here are kept at the ingredient cost on the day the waste was logged, so they can differ slightly from Net income, which values the month's waste at that month's cost.</p>
    <p class="hint" style="margin-top:4px;">Counter waste is taken from stock the same way a sale is (recipe and options). Stamp-card freebies are not waste: they show as ₱0 sales with a loyalty reward. R&amp;D usage and stock missing at a closing count are waste too.</p>`;
  wrap.querySelectorAll('[data-go-rnd]').forEach(a => a.onclick = () => navigate('rnd'));
  wrap.querySelectorAll('[data-go-counts]').forEach(a => a.onclick = () => navigate('stockCounts'));
}
function exportWasteCSV(){
  const r = WR_LAST;
  if(!r || !(r.entries || []).length){ toast('Nothing to export', 'warn'); return; }
  const rows = [];
  r.entries.forEach(x => (x.items && x.items.length ? x.items : [{}]).forEach((it, k) => rows.push([
    dayValue(x.day), wasteWhereText(x), wasteReasonText(x) + (x.project_name ? ' (' + x.project_name + ')' : ''), x.note || '',
    it.name || '', it.quantity == null ? '' : it.quantity, it.unit || '', Array.isArray(it.modifiers) ? it.modifiers.map(m => (m && m.label) || '').join(' / ') : '',
    num(it.cost).toFixed(2), k === 0 ? num(x.cost).toFixed(2) : '', x.staff_name || '', x.approved_by_name || '', x.needs_review ? reviewReasonText(r.flags[x.id] || '') : ''])));
  rows.push(['Total', '', '', '', '', '', '', '', '', num(r.total_cost).toFixed(2), '', '', '']);
  downloadFile(`${fileNameSlug()}-waste-${dayValue(r.from)}-${dayValue(r.to)}.csv`,
    toCSV(['Day', 'Where', 'Reason', 'Note', 'Item', 'Quantity', 'Unit', 'Options', 'Item cost', 'Entry cost', 'Staff', 'Approved by', 'Review'], rows), 'text/csv');
  toast('Waste report exported as CSV');
}
