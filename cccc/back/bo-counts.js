/* =====================================================================
   BACK OFFICE — release 1.5 (Wave 3), owner only:
     B9  Count at closing: which items staff count before Close shift
         (ingredients.count_at_close), the Stock counts screen (each count
         with its shift, staff, lines, missing value and flags), "Revise"
         (revise_stock_count, owner only, needs a note) and flagged counts
         in "Needs review".
     B7  Barista drink kit: the daily calibration kit the counter's one-tap
         button opens (settings.barista_kit, saved with apply_changes).
     B8  R&D log: projects (rnd_projects, apply_changes) and ingredients used
         per project (log_rnd_usage / delete_rnd_usage). R&D counts as waste
         (reason RND) in the Waste report and Net income (bo-money.js).
   Counts, R&D usage and stock are worked out by the SERVER; this file only
   shows them. Every text from the database is escaped (esc).
   ===================================================================== */

function rndStatusLabel(s){ return ({ACTIVE: 'Active', DONE: 'Done', DROPPED: 'Dropped'})[s] || String(s || ''); }
function rndStatusBadge(s){ return `<span class="badge ${s === 'ACTIVE' ? 'badge-green' : 'badge-gray'}">${esc(rndStatusLabel(s))}</span>`; }
// "1.5 kg" from a stock-unit amount (shown in the unit staff typed when known)
function countQtyText(q, unit, shownUnit, ing){ return formatQuantity(num(q), unit || '', shownUnit || unit || '', 3, ing && ing.weight_g_per_ml); }
function signedQtyText(q, unit){ const v = num(q); return (v > 0 ? '+' : v < 0 ? '−' : '') + formatQuantity(Math.abs(v), unit || '', unit || '', 3); }

/* ================= B9: which items are counted at closing ================= */
// Counters made before 1.5 can't send a count, so a tick there makes Close shift fail (COUNT_REQUIRED).
// The database does not record which app version a counter runs, so the warning always shows.
const COUNT_TICK_WARNING = 'Counters must be updated to 1.5 before you tick items, or they can\'t close shifts.';
function countTickWarningHtml(extra){
  return `<div class="notice warn count-tick-warn" role="note">${icon('alert', {size: 16})} <b>${esc(COUNT_TICK_WARNING)}</b>${extra ? ' ' + extra : ''}</div>`;
}
function countAtCloseList(){ return stockIngredientsList().filter(i => i.count_at_close).sort(byName); }
function countItemKind(i){ return isProducedItem(i) ? 'House-made' : (suppliedRecipeFor(i.id) ? 'Supplied' : 'Raw'); }
// One window to tick / untick every stock item (raw, house-made, supplied), saved in ONE apply_changes call.
function openCountItemsPicker(){
  if(!BO.has15){ toast('Available after the 1.5 database update is installed.', 'warn'); return; }
  const list = stockIngredientsList().slice().sort(byName);
  if(!list.length){ toast('Add an ingredient first', 'warn'); return; }
  const groups = ['Raw', 'House-made', 'Supplied'].map(k => [k, list.filter(i => countItemKind(i) === k)]).filter(g => g[1].length);
  const body = `
    ${countTickWarningHtml()}
    <p class="hint" style="margin-top:0;">Staff type the amount they count for each ticked item before Close shift. They don't see how much the system expects. Missing stock is saved as waste ("Missing at count"); extra stock raises the stock and shows in Needs review.</p>
    <div class="field-inline" style="margin-bottom:8px;"><input type="search" id="ci-search" placeholder="Find an item…" aria-label="Find an item" style="flex:1 1 200px;">
      <button class="btn btn-sm btn-ghost" type="button" id="ci-none">Untick all</button></div>
    <div class="ci-list" id="ci-list">${groups.map(([k, items]) => `<div class="ci-group"><div class="ci-head">${esc(k)}</div>
      ${items.map(i => `<label class="chk ci-item" data-name="${esc(String(i.name || '').toLowerCase())}"><input type="checkbox" data-ci="${esc(i.id)}" ${i.count_at_close ? 'checked' : ''}> ${esc(i.name)} <span class="text-light">(${esc(unitLabel(i.base_unit))})</span></label>`).join('')}</div>`).join('')}</div>
    <p class="hint" id="ci-sum" role="status"></p>`;
  openModal({title: 'Count at closing', wide: true, body,
    foot: `<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" id="ci-save">Save ticks</button>`,
    onMount: (root) => {
      const q = (s) => root.querySelector(s);
      q('[data-cancel]').onclick = closeModal;
      const sum = () => { const n = root.querySelectorAll('[data-ci]:checked').length; q('#ci-sum').textContent = n ? `${plural(n, 'item')} will be counted at closing.` : 'Nothing is counted at closing.'; };
      root.querySelectorAll('[data-ci]').forEach(c => c.onchange = sum); sum();
      q('#ci-none').onclick = () => { root.querySelectorAll('[data-ci]').forEach(c => { c.checked = false; }); sum(); };
      q('#ci-search').oninput = (e) => { const t = e.target.value.trim().toLowerCase(); root.querySelectorAll('.ci-item').forEach(l => { l.style.display = !t || l.dataset.name.includes(t) ? '' : 'none'; }); };
      const save = q('#ci-save');
      save.onclick = () => busy(save, async () => {
        const now = nowISO(), on = [], off = [], ops = [];
        root.querySelectorAll('[data-ci]').forEach(c => {
          const ing = ingredientById(c.dataset.ci);
          if(!ing || !!ing.count_at_close === c.checked) return;
          ops.push(Ops.update('ingredients', {id: ing.id, count_at_close: c.checked, updated_at: now}));
          (c.checked ? on : off).push(ing.name);
        });
        if(!ops.length){ closeModal(); return; }
        ops.push(Ops.audit('Count at closing changed', [on.length ? 'Ticked: ' + on.join(', ') : '', off.length ? 'Unticked: ' + off.join(', ') : ''].filter(Boolean).join(' · ')));
        if(await boSave(ops, {success: 'Saved. Counters pick this up within a few minutes.'})){ closeModal(); if(state.route === 'stockCounts') renderStockCounts(); else if(state.route === 'settings') renderSettings(); }
      });
    }});
}
// The tick inside the ingredient / supplied item forms (with the warning next to it).
function countTickFieldHtml(id, checked){
  if(!BO.has15) return '';
  return `<div class="card soft-card count-tick-card" style="margin:4px 0 12px;">
    <label class="chk" style="margin:0;"><input type="checkbox" id="${esc(id)}" ${checked ? 'checked' : ''}> <b>Count at closing</b></label>
    <div class="hint" style="margin-top:2px;">Staff count this item before Close shift. Missing stock is saved as waste.</div>
    <div class="hint count-tick-hint">${icon('alert', {size: 14})} ${esc(COUNT_TICK_WARNING)}</div></div>`;
}

/* ================= B9: Stock counts screen ================= */
const scFilter = {preset: '30d', from: '', to: '', review: false};
let SC_DATA = null;
async function loadCountsToReview(){
  if(!BO.has15) return [];
  try{ return await cloud.select('stock_counts', {eq: {needs_review: true}, order: 'counted_at.desc', limit: 500}) || []; }
  catch(e){ if(/stock_counts|relation|42P01|404/i.test(String(e && (e.message || e.code || e.status) || ''))) return []; throw e; }
}
// Lines + shifts of a list of counts (read in parts of 100).
async function countDetails(counts){
  const ids = counts.map(c => c.id), shiftIds = [...new Set(counts.map(c => c.shift_id).filter(Boolean))];
  const lines = [], shifts = [];
  for(let i = 0; i < ids.length; i += 100) lines.push(...(await cloud.select('stock_count_lines', {in: {count_id: ids.slice(i, i + 100)}, order: 'name.asc'}) || []));
  for(let i = 0; i < shiftIds.length; i += 100) shifts.push(...(await cloud.select('shifts', {select: 'id,shift_number,cashier_name,opened_at,closed_at,device_id', in: {id: shiftIds.slice(i, i + 100)}}) || []));
  return {lines, shifts};
}
function countShiftText(c, shifts){
  const sh = (shifts || []).find(s => s.id === c.shift_id);
  if(!sh) return c.shift_id ? 'Shift' : '—';
  return (sh.shift_number || 'Shift') + (sh.opened_at ? ' · opened ' + fmtShopDateTime(sh.opened_at) : '');
}
function countDeviceName(c){ const d = state.devices.find(x => x.id === c.device_id); return d ? (d.device_name || d.device_tag || 'Counter') : (c.device_id ? 'A counter' : '—'); }
function countFlagsHtml(c){
  if(!c.needs_review) return c.reviewed_at ? '<span class="badge badge-gray">Reviewed</span>' : '';
  return `<div class="review-flag">${icon('alert', {size: 16})} ${esc(countReviewText(c.review_reason) || 'Flagged by the server')}</div>`;
}
async function renderStockCounts(){
  if(state.route !== 'stockCounts') return;
  const bar = setTopbarActions(`<button class="btn btn-primary" id="btn-count-items">Choose items to count</button>`);
  bar.querySelector('#btn-count-items').onclick = openCountItemsPicker;
  const content = document.getElementById('content');
  if(!BO.has15){ content.innerHTML = emptyBlock('Stock counts are available after the 1.5 database update (012) is installed.'); return; }
  const ticked = countAtCloseList();
  content.innerHTML = `
    ${countTickWarningHtml()}
    <div class="card soft-card sc-ticked" style="margin-bottom:14px;"><b>Counted at closing:</b> ${ticked.length ? ticked.map(i => `<span class="ready-pill">${esc(i.name)}</span>`).join(' ') : '<span class="text-light">nothing ticked yet. Use "Choose items to count".</span>'}</div>
    <div class="toolbar"><div class="toolbar-left">${rangePickerHtml(scFilter, 'sc')}
      <label class="inline-check"><input type="checkbox" id="sc-review" ${scFilter.review ? 'checked' : ''}> Needs review only</label></div>
      <div class="text-light" style="font-size:13px;" id="sc-count"></div></div>
    <div id="sc-wrap"><div class="loading-line">Loading counts…</div></div>`;
  wireRangePicker(content, scFilter, 'sc', () => drawStockCounts());
  content.querySelector('#sc-review').onchange = (e) => { scFilter.review = e.target.checked; drawStockCounts(); };
  await drawStockCounts();
}
async function drawStockCounts(){
  const wrap = document.getElementById('sc-wrap'); if(!wrap) return;
  const [a, b] = presetKeys(scFilter.preset, scFilter), key = a + '|' + b + '|' + scFilter.review;
  wrap.classList.add('dim');
  let counts, det;
  try{
    counts = scFilter.review ? await loadCountsToReview()
      : await cloud.select('stock_counts', {gte: {count_date: a}, lte: {count_date: b}, order: 'counted_at.desc', limit: 300}) || [];
    det = await countDetails(counts);
  }catch(e){ wrap.classList.remove('dim'); wrap.innerHTML = emptyBlock(esc(friendlyError(e))); return; }
  wrap.classList.remove('dim');
  const [a2, b2] = presetKeys(scFilter.preset, scFilter);
  if(state.route !== 'stockCounts' || key !== a2 + '|' + b2 + '|' + scFilter.review) return;
  SC_DATA = {counts, lines: det.lines, shifts: det.shifts};
  const cnt = document.getElementById('sc-count');
  if(cnt) cnt.textContent = `${plural(counts.length, 'count')} · missing ${fmtMoney(counts.reduce((s, c) => s + num(c.shortage_cost), 0))}`;
  if(!counts.length){ wrap.innerHTML = emptyBlock(scFilter.review ? 'No count needs review.' : 'No counts in these dates. Counts appear here when staff count the ticked items before Close shift.'); return; }
  wrap.innerHTML = `<div class="table-wrap"><table class="sc-table"><thead><tr><th>Counted</th><th>Shift</th><th>Staff</th><th class="num">Items</th><th class="num">Differ</th><th class="num">Missing value</th><th>Status</th><th></th></tr></thead><tbody>
    ${counts.map(c => { const ls = det.lines.filter(l => l.count_id === c.id), diff = ls.filter(l => Math.abs(num(l.difference)) > 0.000001);
      return `<tr class="clickable${c.needs_review ? ' wr-flag-row' : ''}" data-count="${esc(c.id)}">
      <td>${esc(fmtShopDateTime(c.counted_at))}<div class="hint">${esc(countDeviceName(c))}</div></td>
      <td>${esc(countShiftText(c, det.shifts))}</td>
      <td>${esc(c.staff_name || '—')}</td>
      <td class="num">${ls.length}</td><td class="num">${diff.length}</td>
      <td class="num"><b>${fmtMoney(c.shortage_cost)}</b></td>
      <td>${c.status === 'REVISED' ? '<span class="badge badge-yellow">Revised</span>' : '<span class="badge badge-gray">Submitted</span>'}${countFlagsHtml(c)}</td>
      <td><button class="btn btn-sm btn-ghost" data-count-open="${esc(c.id)}">Open</button></td></tr>`; }).join('')}
  </tbody></table></div>`;
  wrap.querySelectorAll('tr[data-count]').forEach(tr => tr.onclick = () => openCountModal(tr.dataset.count));
}
// One count: its lines (counted vs expected, difference, missing value), flags, and Revise / Mark as reviewed.
async function openCountModal(countId, afterSave){
  let c, lines, shifts;
  try{
    const r = await cloud.select('stock_counts', {eq: {id: countId}, limit: 1});      // always fresh (it may have been revised)
    c = r && r[0];
    if(!c){ toast(friendlyError('COUNT_NOT_FOUND'), 'error'); return; }
    const det = await countDetails([c]); lines = det.lines; shifts = det.shifts;
  }catch(e){ toast(friendlyError(e), 'error'); return; }
  const ingOf = (l) => ingredientById(l.ingredient_id);
  const body = `
    <div class="grid grid-4 kpi-sans" style="margin-bottom:12px;">
      ${statCard('Counted', esc(fmtShopDateTime(c.counted_at)), esc(countDeviceName(c)))}
      ${statCard('Staff', esc(c.staff_name || '—'), esc(countShiftText(c, shifts)))}
      ${statCard('Missing value', fmtMoney(c.shortage_cost), 'saved as waste ("Missing at count")')}
      ${statCard('Status', c.status === 'REVISED' ? 'Revised' : 'Submitted', c.revised_at ? esc('by ' + (c.revised_by_name || 'owner') + ', ' + fmtShopDateTime(c.revised_at)) : '')}
    </div>
    ${c.needs_review ? `<div class="notice warn"><b>Needs review:</b> ${esc(countReviewText(c.review_reason) || 'Flagged by the server')}. Check with the staff member, then mark it reviewed or revise the amounts.</div>` : ''}
    ${c.note ? `<p class="hint">Staff note: ${esc(c.note)}</p>` : ''}
    ${c.revision_note ? `<p class="hint">Revision note: ${esc(c.revision_note)}</p>` : ''}
    <div class="table-wrap" style="box-shadow:none;"><table class="sc-lines"><thead><tr><th>Item</th><th class="num">Expected</th><th class="num">Counted</th><th class="num">Difference</th><th class="num">Missing value</th><th>New count</th></tr></thead><tbody>
      ${lines.map(l => { const ing = ingOf(l), d = num(l.difference);
        const units = ing ? unitsForIngredient(ing) : [l.unit];
        return `<tr data-line="${esc(l.ingredient_id)}"><td><b>${esc(l.name || ingName(l.ingredient_id))}</b>${l.original_counted != null && Math.abs(num(l.original_counted) - num(l.counted)) > 0.000001 ? `<div class="hint">first counted ${esc(countQtyText(l.original_counted, l.unit))}</div>` : ''}</td>
        <td class="num">${esc(countQtyText(l.expected, l.unit))}</td>
        <td class="num">${esc(countQtyText(l.counted, l.unit))}${l.entered_unit && l.entered_unit !== l.unit ? `<div class="hint">typed ${esc(fmtNum(l.entered_quantity, 3))} ${esc(unitLabel(l.entered_unit))}</div>` : ''}</td>
        <td class="num ${d < -0.000001 ? 'text-red' : d > 0.000001 ? 'text-green' : ''}">${Math.abs(d) <= 0.000001 ? '—' : esc(signedQtyText(d, l.unit))}</td>
        <td class="num">${num(l.cost) ? fmtMoney(l.cost) : '—'}</td>
        <td><div class="sc-new"><input type="number" step="any" min="0" data-new="${esc(l.ingredient_id)}" value="${esc(String(Number(num(l.counted).toFixed(6))))}" aria-label="New count for ${esc(l.name || '')}">
          <select data-new-unit="${esc(l.ingredient_id)}" aria-label="Unit">${units.map(u => `<option value="${esc(u)}" ${u === l.unit ? 'selected' : ''}>${esc(unitLabel(u))}</option>`).join('')}</select></div></td></tr>`; }).join('') || '<tr><td colspan="6" class="text-light">No lines.</td></tr>'}
    </tbody></table></div>
    <p class="hint">Expected = the stock the system had when the count arrived. Changing a count re-works the missing (waste) and extra (stock raised) amounts; the expected amounts stay.</p>
    <div class="form-row"><label for="sc-note">Why are you changing it? (needed when an amount changes)</label><textarea id="sc-note" rows="2" maxlength="200" placeholder="e.g. Recounted the milk with the closing staff"></textarea></div>`;
  openModal({title: 'Stock count', wide: true, body,
    foot: `<button class="btn btn-outline" data-cancel>Close</button>${c.needs_review ? '<button class="btn btn-outline" id="sc-reviewed">Mark as reviewed</button>' : ''}<button class="btn btn-primary" id="sc-revise">Save revision</button>`,
    onMount: (root) => {
      const q = (s) => root.querySelector(s);
      q('[data-cancel]').onclick = closeModal;
      root.querySelectorAll('[data-new-unit]').forEach(sel => {
        const input = root.querySelector(`[data-new="${CSS.escape(sel.dataset.newUnit)}"]`);
        const ing = ingredientById(sel.dataset.newUnit);
        if(ing && Number(ing.weight_g_per_ml) > 0) sel.dataset.w = String(ing.weight_g_per_ml);
        wireUnitConvert(input, sel);
      });
      const run = async (btn, linesToSend, note, success) => busy(btn, async () => {
        let r;
        const seq = BO_MODAL_SEQ;
        try{ r = await cloud.rpc('revise_stock_count', {p_count_id: c.id, p_lines: linesToSend, p_note: note || null}); }
        catch(e){ toast(friendlyError(e), 'error'); return; }
        try{ await boLoad(); }catch(e){ console.warn(e); }
        boGuardLateClose(seq);
        toast(success);
        closeModal();
        await refreshReviewCount();
        if(afterSave) afterSave(r); else if(state.route === 'stockCounts') drawStockCounts(); else rerender();
      }, 'Saving…');
      const rv = q('#sc-reviewed');
      if(rv) rv.onclick = () => run(rv, [], null, 'Marked as reviewed');
      const save = q('#sc-revise');
      save.onclick = () => {
        const changed = [];
        let bad = false;
        lines.forEach(l => {
          const input = root.querySelector(`[data-new="${CSS.escape(l.ingredient_id)}"]`), sel = root.querySelector(`[data-new-unit="${CSS.escape(l.ingredient_id)}"]`);
          if(!input || input.value === ''){ bad = bad || (input && input.value === ''); return; }
          const v = Number(input.value), ing = ingOf(l);
          if(!(v >= 0)){ bad = true; return; }
          const base = ing ? typedToBase(v, sel.value, l.unit || ing.base_unit, ing.weight_g_per_ml) : v;
          if(base == null){ bad = true; return; }
          if(Math.abs(base - num(l.counted)) > 0.000001) changed.push({ingredient_id: l.ingredient_id, quantity: v, unit: sel.value});
        });
        if(bad){ toast('Enter a count of 0 or more for every item', 'error'); return; }
        const note = q('#sc-note').value.trim();
        if(!changed.length){ toast(c.needs_review ? 'No amount changed. Use "Mark as reviewed" if the count is right.' : 'No amount changed.', 'warn'); return; }
        if(!note){ toast(friendlyError('NOTE_REQUIRED'), 'error'); q('#sc-note').focus(); return; }
        run(save, changed, note, 'Count revised. Stock and waste were worked out again.');
      };
    }});
}

/* ================= B7: Barista drink kit ================= */
// settings.barista_kit = [{ingredient_id, quantity, unit}] (at most 20, each item once; the server: BAD_BARISTA_KIT).
function openBaristaKitForm(){
  if(!BO.has15){ toast('Available after the 1.5 database update is installed.', 'warn'); return; }
  const items = stockIngredientsList().slice().sort(byName);
  if(!items.length){ toast('Add an ingredient first', 'warn'); return; }
  let draft = cleanBaristaKit(state.settings.barista_kit).map(l => Object.assign({}, l));
  const body = `
    <p class="hint" style="margin-top:0;">The usual daily calibration: espresso pulls, milk, sauces and syrups. At the counter, one tap on <b>Barista drink</b> opens this kit; staff adjust the amounts and save it as waste ("Calibration / barista drink").</p>
    <div class="table-wrap" style="box-shadow:none;"><table class="kit-table"><thead><tr><th>Item</th><th>Amount</th><th></th></tr></thead><tbody id="kit-rows"></tbody></table></div>
    <div class="field-inline" style="margin-top:8px;"><button class="btn btn-sm btn-outline" type="button" id="kit-add">+ Add item</button><span class="hint" id="kit-cost" role="status"></span></div>`;
  openModal({title: 'Barista drink kit', wide: true, body,
    foot: `<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" id="kit-save">Save kit</button>`,
    onMount: (root) => {
      const q = (s) => root.querySelector(s);
      q('[data-cancel]').onclick = closeModal;
      const read = () => { draft = [...root.querySelectorAll('#kit-rows tr[data-k]')].map(tr => ({ingredient_id: tr.querySelector('[data-kit-ing]').value, quantity: tr.querySelector('[data-kit-qty]').value, unit: tr.querySelector('[data-kit-unit]').value})); };
      const cost = () => {
        read();
        const ok = draft.filter(l => l.ingredient_id && Number(l.quantity) > 0);
        let c = 0; try{ c = wasteCostPreview(ok.map(l => ({ingredient_id: l.ingredient_id, quantity: Number(l.quantity), unit: l.unit}))); }catch(e){ c = 0; }
        q('#kit-cost').textContent = ok.length ? `About ${fmtMoney(c)} a day at today's costs` : '';
      };
      const draw = () => {
        q('#kit-rows').innerHTML = draft.map((l, k) => { const ing = ingredientById(l.ingredient_id) || items[0];
          return `<tr data-k="${k}"><td><select data-kit-ing aria-label="Item">${items.map(i => `<option value="${esc(i.id)}" ${i.id === ing.id ? 'selected' : ''}>${esc(i.name)}</option>`).join('')}${l.ingredient_id && !items.some(i => i.id === l.ingredient_id) ? `<option value="${esc(l.ingredient_id)}" selected>${esc(ingName(l.ingredient_id))} (not a stock item now)</option>` : ''}</select></td>
            <td><div class="sc-new"><input type="number" step="any" min="0" data-kit-qty value="${esc(l.quantity == null ? '' : String(l.quantity))}" aria-label="Amount"><select data-kit-unit aria-label="Unit">${unitOptionsHtml(ing.base_unit, l.unit || ing.base_unit, ing.weight_g_per_ml)}</select></div></td>
            <td><button class="btn btn-sm btn-ghost" type="button" data-kit-rm="${k}" aria-label="Remove">${icon('x', {size: 16})}</button></td></tr>`; }).join('')
          || '<tr><td colspan="3" class="text-light">No items yet. Use "+ Add item".</td></tr>';
        root.querySelectorAll('#kit-rows tr[data-k]').forEach(tr => {
          const ingSel = tr.querySelector('[data-kit-ing]'), unit = tr.querySelector('[data-kit-unit]'), qty = tr.querySelector('[data-kit-qty]');
          ingSel.onchange = () => { const i = ingredientById(ingSel.value); if(i) resetUnitSelect(unit, i.base_unit, i.weight_g_per_ml); cost(); };
          wireUnitConvert(qty, unit, cost); qty.addEventListener('input', cost);
        });
        root.querySelectorAll('[data-kit-rm]').forEach(b => b.onclick = () => { read(); draft.splice(Number(b.dataset.kitRm), 1); draw(); });
        q('#kit-add').disabled = draft.length >= BARISTA_KIT_MAX;
        cost();
      };
      q('#kit-add').onclick = () => { read(); if(draft.length >= BARISTA_KIT_MAX) return; const used = new Set(draft.map(l => l.ingredient_id)); const next = items.find(i => !used.has(i.id)) || items[0]; draft.push({ingredient_id: next.id, quantity: '', unit: next.base_unit}); draw(); };
      draw();
      const save = q('#kit-save');
      save.onclick = () => busy(save, async () => {
        read();
        const seen = new Set();
        for(const l of draft){
          if(!(Number(l.quantity) > 0) || Number(l.quantity) > 100000){ toast('Give every item an amount above 0 (or remove it)', 'error'); return; }
          if(seen.has(l.ingredient_id)){ toast(`${ingName(l.ingredient_id)} is in the kit twice. Keep it once.`, 'error'); return; }
          seen.add(l.ingredient_id);
        }
        const kit = cleanBaristaKit(draft.map(l => { const i = ingredientById(l.ingredient_id); return {ingredient_id: l.ingredient_id, quantity: Number(l.quantity), unit: i && l.unit === i.base_unit ? null : l.unit}; }));
        const text = kit.map(l => { const i = ingredientById(l.ingredient_id); return `${ingName(l.ingredient_id)} ${fmtNum(l.quantity, 3)} ${unitLabel(l.unit || (i && i.base_unit) || '')}`.trim(); }).join(', ');
        if(await boSave([Ops.update('settings', {barista_kit: kit, updated_at: nowISO()}), Ops.audit('Barista drink kit saved', text || 'Kit emptied')],
          {success: 'Barista drink kit saved. Counters pick it up within a few minutes.'})){ closeModal(); if(state.route === 'settings') renderSettings(); }
      });
    }});
}

/* ================= B8: R&D log ================= */
let RND = {projects: [], logs: [], items: []};
async function loadRnd(){
  const [projects, logs] = await Promise.all([
    cloud.selectAll('rnd_projects', {order: 'name.asc'}),
    cloud.select('waste_logs', {eq: {reason: 'RND'}, order: 'waste_date.desc,logged_at.desc', limit: 300}),
  ]);
  const ids = (logs || []).map(l => l.id), items = [];
  for(let i = 0; i < ids.length; i += 100) items.push(...(await cloud.select('waste_log_items', {in: {waste_log_id: ids.slice(i, i + 100)}}) || []));
  RND = {projects: projects || [], logs: logs || [], items};
  return RND;
}
async function renderRnd(){
  if(state.route !== 'rnd') return;
  const bar = setTopbarActions(`<button class="btn btn-outline" id="btn-rnd-project">+ New project</button> <button class="btn btn-primary" id="btn-rnd-log">Log usage</button>`);
  bar.querySelector('#btn-rnd-project').onclick = () => openRndProjectForm(null);
  bar.querySelector('#btn-rnd-log').onclick = () => openRndUsageForm(null);
  const content = document.getElementById('content');
  if(!BO.has15){ content.innerHTML = emptyBlock('The R&D log is available after the 1.5 database update (012) is installed.'); return; }
  content.innerHTML = '<div class="loading-line">Loading R&amp;D…</div>';
  try{ await loadRnd(); }catch(e){ content.innerHTML = emptyBlock(esc(friendlyError(e))); return; }
  if(state.route !== 'rnd') return;
  const costOf = (pid) => RND.logs.filter(l => l.rnd_project_id === pid).reduce((s, l) => s + num(l.total_cost), 0);
  const total = RND.logs.reduce((s, l) => s + num(l.total_cost), 0);
  const month = keyMonthStart(shopTodayKey());
  const monthCost = RND.logs.filter(l => dayValue(l.waste_date) >= month).reduce((s, l) => s + num(l.total_cost), 0);
  const projName = (id) => (RND.projects.find(p => p.id === id) || {}).name || 'Project';
  content.innerHTML = `
    <div class="grid grid-4 kpi-sans" style="margin-bottom:16px;">
      ${statCard('R&amp;D this month', fmtMoney(monthCost), 'counted as waste')}
      ${statCard('R&amp;D shown below', fmtMoney(total), plural(RND.logs.length, 'entry', 'entries') + (RND.logs.length >= 300 ? ' (newest 300)' : ''))}
      ${statCard('Active projects', RND.projects.filter(p => p.status === 'ACTIVE').length, plural(RND.projects.length, 'project') + ' in all')}
      ${statCard('Reports', '<a class="linklike" id="rnd-go-waste">Waste report</a>', 'cost per project')}
    </div>
    <div class="section-title" style="margin-top:0;">Projects</div>
    ${RND.projects.length ? `<div class="table-wrap"><table><thead><tr><th>Project</th><th>Status</th><th>Notes</th><th class="num">Entries</th><th class="num">Cost</th><th></th></tr></thead><tbody>
      ${RND.projects.map(p => `<tr><td><b>${esc(p.name)}</b></td><td>${rndStatusBadge(p.status)}</td><td class="text-light">${esc(p.notes || '')}</td>
        <td class="num">${RND.logs.filter(l => l.rnd_project_id === p.id).length}</td><td class="num">${fmtMoney(costOf(p.id))}</td>
        <td class="row-actions">${p.status === 'ACTIVE' ? `<button class="btn btn-sm btn-ghost" data-rnd-log="${esc(p.id)}">Log usage</button>` : ''}<button class="btn btn-sm btn-ghost" data-rnd-edit="${esc(p.id)}">Edit</button></td></tr>`).join('')}
    </tbody></table></div>` : emptyBlock('No R&amp;D projects yet. Use "+ New project" (for example "Ube latte"), then log the ingredients you try.')}
    <div class="section-title">Usage</div>
    ${RND.logs.length ? `<div class="table-wrap"><table class="rnd-usage"><thead><tr><th>Day</th><th>Project</th><th>What</th><th>Note</th><th class="num">Cost</th><th></th></tr></thead><tbody>
      ${RND.logs.map(l => `<tr><td>${fmtDay(l.waste_date)}</td><td>${esc(projName(l.rnd_project_id))}</td>
        <td>${RND.items.filter(i => i.waste_log_id === l.id).map(i => `<div>${esc(fmtNum(i.quantity, 3).replace(/\.000$/, ''))}${i.unit ? ' ' + esc(unitLabel(i.unit)) : (i.recipe_id ? ' ×' : '')} ${esc(i.name || '')} <span class="text-light">${fmtMoney(i.cost)}</span></div>`).join('')}</td>
        <td class="text-light">${esc(l.note || '')}</td><td class="num"><b>${fmtMoney(l.total_cost)}</b></td>
        <td><button class="btn btn-sm btn-ghost" data-rnd-del="${esc(l.id)}">Delete</button></td></tr>`).join('')}
    </tbody></table></div>` : emptyBlock('No R&amp;D usage logged yet.')}
    <p class="hint" style="margin-top:8px;">R&amp;D usage is taken out of stock and counted as waste (reason "R&amp;D"), so it shows in the Waste report and Net income. Deleting an entry puts its stock back.</p>`;
  content.querySelector('#rnd-go-waste').onclick = () => navigate('wasteReport');
  content.querySelectorAll('[data-rnd-edit]').forEach(b => b.onclick = () => openRndProjectForm(RND.projects.find(p => p.id === b.dataset.rndEdit)));
  content.querySelectorAll('[data-rnd-log]').forEach(b => b.onclick = () => openRndUsageForm(b.dataset.rndLog));
  content.querySelectorAll('[data-rnd-del]').forEach(b => b.onclick = () => deleteRndUsage(RND.logs.find(l => l.id === b.dataset.rndDel)));
}
function openRndProjectForm(p){
  const editing = p || null;
  const body = `
    <div class="form-row"><label for="rp-name">Project name</label><input id="rp-name" maxlength="80" value="${esc(editing ? editing.name : '')}" placeholder="e.g. Ube latte"></div>
    <div class="form-row"><label for="rp-status">Status</label><select id="rp-status">${['ACTIVE', 'DONE', 'DROPPED'].map(s => `<option value="${s}" ${(editing ? editing.status : 'ACTIVE') === s ? 'selected' : ''}>${esc(rndStatusLabel(s))}</option>`).join('')}</select>
      <div class="hint">Usage can be logged only while a project is active. Done or dropped projects keep their costs in the reports.</div></div>
    <div class="form-row"><label for="rp-notes">Notes (optional)</label><textarea id="rp-notes" rows="2" maxlength="500">${esc(editing ? (editing.notes || '') : '')}</textarea></div>`;
  openModal({title: editing ? 'Edit R&amp;D project' : 'New R&amp;D project', body,
    foot: `${editing ? '<button class="btn btn-danger" id="rp-del" style="margin-right:auto;">Delete</button>' : ''}<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" id="rp-save">${editing ? 'Save changes' : 'Add project'}</button>`,
    onMount: (root) => {
      const q = (s) => root.querySelector(s);
      q('[data-cancel]').onclick = closeModal;
      const del = q('#rp-del');
      if(del) del.onclick = () => busy(del, async () => {
        if(RND.logs.some(l => l.rnd_project_id === editing.id)){ toast(friendlyError('PROJECT_HAS_USAGE'), 'error'); return; }
        const ok = await confirmDialog(`Delete the R&amp;D project <b>${esc(editing.name)}</b>?`, 'Delete');
        if(ok && await boSave([Ops.del('rnd_projects', editing.id), Ops.audit('R&D project deleted', editing.name, editing.id)], {reload: false, success: 'Project deleted'})){ closeModal(); renderRnd(); }
      }, 'Checking…');
      const save = q('#rp-save');
      save.onclick = () => busy(save, async () => {
        const name = q('#rp-name').value.replace(/\s+/g, ' ').trim();
        if(!name){ toast('Enter a project name', 'error'); q('#rp-name').focus(); return; }
        if(RND.projects.some(x => x.id !== (editing && editing.id) && String(x.name).trim().toLowerCase() === name.toLowerCase())){ toast(friendlyError('PROJECT_NAME_TAKEN'), 'error'); return; }
        const now = nowISO();
        const row = {id: editing ? editing.id : uid(), name, status: q('#rp-status').value, notes: q('#rp-notes').value.trim().slice(0, 500) || null, updated_at: now};
        if(!editing) row.created_at = now;
        if(await boSave([editing ? Ops.update('rnd_projects', row) : Ops.upsert('rnd_projects', row),
          Ops.audit(editing ? 'R&D project updated' : 'R&D project added', `${name} (${rndStatusLabel(row.status)})`, row.id)], {reload: false, success: editing ? 'Project saved' : 'Project added'})){
          closeModal(); renderRnd();
        }
      });
    }});
}
function openRndUsageForm(projectId){
  const active = RND.projects.filter(p => p.status === 'ACTIVE').sort(byName);
  if(!active.length){ toast('Add an active R&D project first ("+ New project").', 'warn'); return; }
  const ings = stockIngredientsList().slice().sort(byName);
  const menu = state.recipes.filter(r => r.active !== false && !isProductionRecipe(r)).sort(byName);
  const today = shopTodayKey();
  let lines = [{kind: 'ING', id: (ings[0] || {}).id, quantity: '', unit: (ings[0] || {}).base_unit}];
  const body = `
    <div class="form-grid">
      <div class="form-row"><label for="ru-project">Project</label><select id="ru-project">${active.map(p => `<option value="${esc(p.id)}" ${p.id === projectId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
      <div class="form-row"><label for="ru-date">Day used</label><input type="date" id="ru-date" value="${esc(today)}" max="${esc(keyAddDays(today, 1))}" min="${esc(keyAddDays(today, -400))}"></div>
    </div>
    <div class="table-wrap" style="box-shadow:none;"><table class="kit-table"><thead><tr><th>Used</th><th>Amount</th><th></th></tr></thead><tbody id="ru-rows"></tbody></table></div>
    <div class="field-inline" style="margin-top:8px;"><button class="btn btn-sm btn-outline" type="button" id="ru-add">+ Ingredient</button>${menu.length ? '<button class="btn btn-sm btn-outline" type="button" id="ru-add-menu">+ Menu item</button>' : ''}<span class="hint" id="ru-cost" role="status"></span></div>
    <div class="form-row" style="margin-top:10px;"><label for="ru-note">Note (optional)</label><input id="ru-note" maxlength="200" placeholder="e.g. Trial 2: less syrup"></div>
    <p class="hint">Taken out of stock and counted as waste (reason "R&amp;D"). The server works out the stock and the cost.</p>`;
  openModal({title: 'Log R&amp;D usage', wide: true, body,
    foot: `<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" id="ru-save">Log usage</button>`,
    onMount: (root) => {
      const q = (s) => root.querySelector(s);
      q('[data-cancel]').onclick = closeModal;
      const read = () => { lines = [...root.querySelectorAll('#ru-rows tr[data-k]')].map(tr => ({kind: tr.dataset.kind, id: tr.querySelector('[data-ru-id]').value, quantity: tr.querySelector('[data-ru-qty]').value, unit: (tr.querySelector('[data-ru-unit]') || {}).value || null})); };
      const asItems = () => lines.filter(l => l.id && Number(l.quantity) > 0).map(l => l.kind === 'MENU' ? {recipe_id: l.id, quantity: Number(l.quantity), modifiers: []} : {ingredient_id: l.id, quantity: Number(l.quantity), unit: l.unit});
      const cost = () => { read(); let c = 0; try{ c = wasteCostPreview(asItems()); }catch(e){ c = 0; } q('#ru-cost').textContent = asItems().length ? `About ${fmtMoney(c)} at today's costs` : ''; };
      const draw = () => {
        q('#ru-rows').innerHTML = lines.map((l, k) => {
          if(l.kind === 'MENU') return `<tr data-k="${k}" data-kind="MENU"><td><select data-ru-id aria-label="Menu item">${menu.map(r => `<option value="${esc(r.id)}" ${r.id === l.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></td>
            <td><div class="sc-new"><input type="number" step="1" min="1" max="100" data-ru-qty value="${esc(l.quantity)}" aria-label="How many"><span class="text-light">×</span></div></td>
            <td><button class="btn btn-sm btn-ghost" type="button" data-ru-rm="${k}" aria-label="Remove">${icon('x', {size: 16})}</button></td></tr>`;
          const ing = ingredientById(l.id) || ings[0] || {};
          return `<tr data-k="${k}" data-kind="ING"><td><select data-ru-id aria-label="Ingredient">${ings.map(i => `<option value="${esc(i.id)}" ${i.id === ing.id ? 'selected' : ''}>${esc(i.name)}</option>`).join('')}</select></td>
            <td><div class="sc-new"><input type="number" step="any" min="0" data-ru-qty value="${esc(l.quantity)}" aria-label="Amount"><select data-ru-unit aria-label="Unit">${unitOptionsHtml(ing.base_unit, l.unit || ing.base_unit, ing.weight_g_per_ml)}</select></div></td>
            <td><button class="btn btn-sm btn-ghost" type="button" data-ru-rm="${k}" aria-label="Remove">${icon('x', {size: 16})}</button></td></tr>`;
        }).join('') || '<tr><td colspan="3" class="text-light">Add what was used.</td></tr>';
        root.querySelectorAll('#ru-rows tr[data-k]').forEach(tr => {
          const sel = tr.querySelector('[data-ru-id]'), qty = tr.querySelector('[data-ru-qty]'), unit = tr.querySelector('[data-ru-unit]');
          sel.onchange = () => { if(unit){ const i = ingredientById(sel.value); if(i) resetUnitSelect(unit, i.base_unit, i.weight_g_per_ml); } cost(); };
          if(unit) wireUnitConvert(qty, unit, cost);
          qty.addEventListener('input', cost);
        });
        root.querySelectorAll('[data-ru-rm]').forEach(b => b.onclick = () => { read(); lines.splice(Number(b.dataset.ruRm), 1); draw(); });
        cost();
      };
      q('#ru-add').onclick = () => { read(); if(lines.length >= 30) return; lines.push({kind: 'ING', id: (ings[0] || {}).id, quantity: '', unit: (ings[0] || {}).base_unit}); draw(); };
      const am = q('#ru-add-menu'); if(am) am.onclick = () => { read(); if(lines.length >= 30) return; lines.push({kind: 'MENU', id: menu[0].id, quantity: '1'}); draw(); };
      draw();
      const save = q('#ru-save');
      save.onclick = () => busy(save, async () => {
        read();
        const items = asItems();
        if(!items.length || items.length !== lines.length){ toast('Give every line an amount above 0 (or remove it)', 'error'); return; }
        const date = q('#ru-date').value || today;
        const p = {id: uid(), project_id: q('#ru-project').value, used_on: date, note: q('#ru-note').value.trim().slice(0, 200) || null, items};
        let r;
        try{ r = await cloud.rpc('log_rnd_usage', {p}); }
        catch(e){ toast(friendlyError(e), 'error'); return; }
        const seq = BO_MODAL_SEQ;
        try{ await boLoad(); }catch(e){ console.warn(e); }
        boGuardLateClose(seq);
        toast(`R&D usage logged: ${fmtMoney(r && r.total_cost)}`);
        closeModal();
        if(state.route === 'rnd') renderRnd();
      }, 'Logging…');
    }});
}
async function deleteRndUsage(l){
  if(!l) return;
  const ok = await confirmDialog(`Delete this R&amp;D entry (${esc(fmtDay(l.waste_date))}, ${fmtMoney(l.total_cost)})? Its stock is put back.`, 'Delete entry');
  if(!ok) return;
  try{
    const r = await cloud.rpc('delete_rnd_usage', {p_id: l.id});
    try{ await boLoad(); }catch(e){ console.warn(e); }
    toast(r && r.deleted ? 'Entry deleted, stock put back' : 'That entry was already gone');
  }catch(e){ toast(friendlyError(e), 'error'); return; }
  if(state.route === 'rnd') renderRnd();
}
