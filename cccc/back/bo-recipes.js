/* =====================================================================
   BACK OFFICE — recipes & menu: recipe list, the recipe form (ingredients,
   production yield, counter / QR menu flags, description, photo, sort
   order) with the OPTIONS editor (modifier groups), and the recipe page.
   Costs come from ../shared/logic.js (recipeCost, recipeMetrics,
   recipeCostAsOf). A recipe and its ingredient lines (and, for a
   production recipe, its produced ingredient) are saved in ONE call.
   Option groups are stored as recipes.modifier_groups:
     [{id, name, required, multi_select,
       options:[{id, label, price_delta, ingredient_id, ingredient_qty_delta}]}]
   ===================================================================== */

/* ================= Recipes & menu ================= */
const recFilter = {search: '', category: '', type: '', hidden: false};
const recPicked = new Set();          // recipes ticked on the list (for "Remove selected")
function renderRecipes(){
  const bar = setTopbarActions(`<button class="btn btn-outline" id="btn-excel-import" type="button">Import from Excel</button>
    <button class="btn btn-outline" id="btn-excel-export" type="button">Export to Excel</button>
    <button class="btn btn-primary" id="btn-new-recipe">+ New recipe</button>`);
  bar.querySelector('#btn-new-recipe').onclick = () => openRecipeForm();
  const imp = bar.querySelector('#btn-excel-import'), exp = bar.querySelector('#btn-excel-export');
  imp.onclick = () => busy(imp, () => startExcelImport(), 'Opening…');
  exp.onclick = () => busy(exp, () => exportRecipesToExcel(), 'Preparing…');
  const content = document.getElementById('content');
  const cats = [...new Set(state.recipes.map(r => r.category).filter(Boolean))].sort();
  const activeRecipes = state.recipes.filter(r => r.active !== false);
  const typeTabs = [{id: '', label: 'All'}, ...RECIPE_TYPES];
  content.innerHTML = `
    <div class="toolbar-left" style="margin-bottom:14px;flex-wrap:wrap;">
      ${typeTabs.map(t => {
        const count = t.id ? activeRecipes.filter(r => recipeTypeOf(r) === t.id).length : activeRecipes.length;
        return `<button class="btn btn-sm ${recFilter.type === t.id ? 'btn-primary' : 'btn-outline'}" data-type-tab="${t.id}">${esc(t.label)} (${count})</button>`;
      }).join('')}
    </div>
    <div class="toolbar">
      <div class="toolbar-left">
        <div class="search-box"><input type="text" placeholder="Search recipes…" id="rec-search" value="${esc(recFilter.search)}" aria-label="Search recipes"></div>
        <select class="filter" id="rec-cat-filter" aria-label="Sub-category"><option value="">All sub-categories</option>${cats.map(c => `<option value="${esc(c)}" ${recFilter.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
        <label class="inline-check"><input type="checkbox" id="rec-hidden" ${recFilter.hidden ? 'checked' : ''}> Show inactive</label>
      </div>
      <div class="text-light" style="font-size:13px;">${plural(activeRecipes.length, 'active recipe')}</div>
    </div>
    <div class="rec-pick-bar" id="rec-pick-bar">
      <label class="chk"><input type="checkbox" id="rec-pick-all"> Select all shown</label>
      <button class="btn btn-sm btn-danger" id="rec-remove-picked" type="button" disabled>Remove selected (0)</button>
    </div>
    <div id="rec-grid-wrap"></div>`;
  document.getElementById('rec-pick-all').onchange = (e) => {
    recShownIds().forEach(id => { if(e.target.checked) recPicked.add(id); else recPicked.delete(id); });
    renderRecipesGrid();
  };
  const rm = document.getElementById('rec-remove-picked');
  rm.onclick = () => busy(rm, () => removePickedRecipes(), 'Checking…');
  content.querySelectorAll('[data-type-tab]').forEach(b => b.onclick = () => { recFilter.type = b.dataset.typeTab; renderRecipes(); });
  document.getElementById('rec-search').oninput = e => { recFilter.search = e.target.value; renderRecipesGrid(); };
  document.getElementById('rec-cat-filter').onchange = e => { recFilter.category = e.target.value; renderRecipesGrid(); };
  document.getElementById('rec-hidden').onchange = e => { recFilter.hidden = e.target.checked; renderRecipesGrid(); };
  renderRecipesGrid();
}
function recShownList(){
  let list = state.recipes.filter(r => recFilter.hidden || r.active !== false);
  if(recFilter.type) list = list.filter(r => recipeTypeOf(r) === recFilter.type);
  if(recFilter.search) list = list.filter(r => r.name.toLowerCase().includes(recFilter.search.toLowerCase()));
  if(recFilter.category) list = list.filter(r => r.category === recFilter.category);
  return list.sort(byName);
}
function recShownIds(){ return recShownList().map(r => r.id); }
// Ticks only count for recipes that are shown; the bar shows how many are ticked.
function refreshPickBar(){
  const shown = new Set(recShownIds());
  [...recPicked].forEach(id => { if(!shown.has(id)) recPicked.delete(id); });
  const rm = document.getElementById('rec-remove-picked'), all = document.getElementById('rec-pick-all');
  if(rm && !rm.dataset.busy){ rm.textContent = `Remove selected (${recPicked.size})`; rm.disabled = recPicked.size === 0; }
  if(all){ all.checked = shown.size > 0 && recPicked.size === shown.size; all.indeterminate = recPicked.size > 0 && recPicked.size < shown.size; all.disabled = shown.size === 0; }
}
function renderRecipesGrid(){
  const wrap = document.getElementById('rec-grid-wrap');
  if(!wrap) return;
  const list = recShownList();
  refreshPickBar();
  if(!list.length){
    wrap.innerHTML = `<div class="empty-state"><div class="big">📖</div>No recipes found.<br><br><button class="btn btn-primary" id="empty-add-rec">+ New recipe</button></div>`;
    wrap.querySelector('#empty-add-rec').onclick = () => openRecipeForm();
    return;
  }
  const warnPct = num(state.settings.food_cost_warning_pct) || 35;
  const mini = (label, value, cls) => `<div><div class="text-light" style="font-size:11px;text-transform:uppercase;">${label}</div><b class="${cls || ''}">${value}</b></div>`;
  wrap.innerHTML = `<div class="grid grid-3">${list.map(r => {
    const m = recipeMetrics(r);
    const sellsDirectly = num(r.selling_price) > 0;
    const warn = m.foodCostPct > warnPct;
    const stats = sellsDirectly
      ? mini('Price', fmtMoney(r.selling_price)) + mini('Cost', fmtMoney(m.cost)) + mini('Profit', fmtMoney(m.profit), m.profit >= 0 ? 'text-green' : 'text-red') + mini('Food cost', fmtNum(m.foodCostPct, 1) + '%')
      : mini('Batch cost', fmtMoney(m.cost)) + mini('Yield', r.expected_yield ? fmtNum(r.expected_yield, 0) + ' ' + esc(r.yield_unit || '') : '—') + mini('Cost / unit', num(r.expected_yield) > 0 ? fmtMoney(m.cost / num(r.expected_yield)) : '—');
    const flags = [
      isProductionRecipe(r) ? '<span class="badge badge-green">Produces stock</span>' : '',
      sellsDirectly && warn ? '<span class="badge badge-red">High cost %</span>' : '',
      r.active === false ? '<span class="badge badge-gray">Inactive</span>' : '',
      r.sold_out ? '<span class="badge badge-red">Sold out</span>' : '',
      sellsDirectly && r.pos_visible === false ? '<span class="badge badge-gray">Not at counter</span>' : '',
      sellsDirectly && r.qr_visible === false ? '<span class="badge badge-gray">Not on QR</span>' : '',
    ].join('');
    return `<div class="card clickable rec-card ${recPicked.has(r.id) ? 'picked' : ''}" data-id="${esc(r.id)}" style="cursor:pointer;" tabindex="0">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;">
        <div style="display:flex;gap:10px;align-items:center;min-width:0;">
          <label class="rec-tick" title="Select for removing"><input type="checkbox" data-pick="${esc(r.id)}" ${recPicked.has(r.id) ? 'checked' : ''} aria-label="Select ${esc(r.name)}"></label>
          ${r.image_url ? `<img class="thumb" src="${esc(r.image_url)}" alt="">` : ''}
          <div style="min-width:0;"><b style="font-size:16px;">${esc(r.name)}</b><div class="text-light" style="font-size:12px;">${esc(recipeTypeLabel(recipeTypeOf(r)))}${r.category ? ' · ' + esc(r.category) : ''}${(r.modifier_groups || []).length ? ' · ' + plural(r.modifier_groups.length, 'option group') : ''}</div></div>
        </div>
        <div class="pill-stack" style="justify-content:flex-end;">${flags}</div>
      </div>
      <div style="display:flex;justify-content:space-between;gap:8px;margin-top:14px;font-size:13.5px;">${stats}</div>
    </div>`;
  }).join('')}</div>`;
  wrap.querySelectorAll('[data-id]').forEach(card => {
    card.onclick = (e) => { if(e.target.closest('.rec-tick')) return; navigate('recipeDetail', card.dataset.id); };
    card.onkeydown = (e) => { if(e.key === 'Enter' && !e.target.closest('.rec-tick')) navigate('recipeDetail', card.dataset.id); };
  });
  wrap.querySelectorAll('[data-pick]').forEach(box => {
    box.onclick = (e) => e.stopPropagation();
    box.onchange = () => {
      if(box.checked) recPicked.add(box.dataset.pick); else recPicked.delete(box.dataset.pick);
      box.closest('.rec-card').classList.toggle('picked', box.checked);
      refreshPickBar();
    };
  });
}

/* ---- remove several recipes at once (owner request #6, 2026-10-25) ----
   Recipes without history are deleted (with their ingredient lines); recipes with sales or
   production history, or that make an inventory item, are made inactive instead (hidden).
   Everything in ONE all-or-nothing call, with one audit entry. */
function pickedRemoveDialog(del, hide){
  return new Promise(resolve => {
    let answered = false;
    const names = list => list.map(x => `<li>${esc(x.r.name)}${x.why ? ` <span class="text-light">— ${esc(x.why.join(' and '))}</span>` : ''}</li>`).join('');
    openModal({
      title: 'Remove recipes',
      body: `${del.length ? `<p><b>${plural(del.length, 'recipe')} will be deleted</b> (this cannot be undone):</p><ul class="rec-rm-list">${names(del)}</ul>` : ''}
        ${hide.length ? `<p style="margin-top:12px;"><b>${plural(hide.length, 'recipe')} will be hidden instead</b> (made inactive: off the counter and the QR menu).
          ${hide.length === 1 ? 'It has' : 'They have'} sales or production history, or make an inventory item, so deleting would break your records. You can show inactive recipes again with "Show inactive".</p>
          <ul class="rec-rm-list">${names(hide)}</ul>` : ''}`,
      foot: `<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-danger" data-ok>Remove ${plural(del.length + hide.length, 'recipe')}</button>`,
      onClose: () => { if(!answered) resolve(false); },
      onMount: (root) => {
        root.querySelector('[data-cancel]').onclick = () => { answered = true; closeModal(); resolve(false); };
        root.querySelector('[data-ok]').onclick = () => { answered = true; closeModal(); resolve(true); };
      },
    });
  });
}
async function removePickedRecipes(){
  const picked = [...recPicked].map(id => state.recipes.find(r => r.id === id)).filter(Boolean);
  if(!picked.length) return;
  let reasons;
  try{ reasons = await recipeHistoryReasons(picked.map(r => r.id)); }
  catch(err){ toast('Could not check the recipes\' history: ' + friendlyError(err), 'error'); return; }
  const del = [], hide = [];
  picked.forEach(r => { if(reasons[r.id] && reasons[r.id].length) hide.push({r, why: reasons[r.id]}); else del.push({r}); });
  if(!await pickedRemoveDialog(del, hide)) return;
  const now = nowISO(), ops = [];
  del.forEach(({r}) => { ops.push(Ops.delWhere('recipe_ingredients', {recipe_id: r.id})); ops.push(Ops.del('recipes', r.id)); });
  hide.forEach(({r}) => ops.push(hideRecipeOp(r.id, now)));
  const details = [del.length ? 'Deleted: ' + del.map(x => x.r.name).join(', ') : '', hide.length ? 'Hidden (has history): ' + hide.map(x => x.r.name).join(', ') : ''].filter(Boolean).join(' · ');
  ops.push(Ops.audit('Recipes removed', details, null));
  const msg = [del.length ? plural(del.length, 'recipe') + ' deleted' : '', hide.length ? plural(hide.length, 'recipe') + ' hidden' : ''].filter(Boolean).join(', ');
  if(await boSave(ops, {success: msg})){
    recPicked.clear();
    if(state.route === 'recipes') renderRecipes();
  }
}

/* ---- units in recipes (owner request #3, 2026-10-25) ----
   The owner may type a recipe or option amount in any unit of the ingredient's family
   (150 mL of an ingredient kept in L). What is STORED is always the ingredient's base unit
   (quantity / ingredient_qty_delta); the chosen unit is kept only to show it the same way
   again (recipe_ingredients.unit, option.unit). Changing the unit converts the shown number. */
function qtyInputValue(q){ const n = Number(q); return isFinite(n) ? String(Number(n.toFixed(6))) : ''; }
function recUnitOptionsHtml(baseUnit, selected){
  return compatibleUnits(baseUnit).map(u => `<option value="${esc(u)}" ${u === selected ? 'selected' : ''}>${esc(unitLabel(u))}</option>`).join('');
}
// Fills a unit dropdown for this ingredient; keeps `preferred` when it fits, else the base unit.
function fillUnitSelect(sel, ing, preferred){
  if(!ing){ sel.innerHTML = ''; sel.dataset.prev = ''; sel.disabled = true; return; }
  const units = compatibleUnits(ing.base_unit);
  const u = units.includes(preferred) ? preferred : ing.base_unit;
  sel.innerHTML = recUnitOptionsHtml(ing.base_unit, u);
  sel.value = u; sel.dataset.prev = u; sel.dataset.base = ing.base_unit;
  sel.disabled = units.length < 2;
}
// The unit dropdown changed (owner decision 2026-10-26):
//  * a number the owner TYPED keeps its number, only its unit changes (typed 1.5, pick kg -> 1.5 kg);
//  * a number filled in from saved data (not edited yet) is converted (saved 100 g -> 0.1 kg).
// Typing in the box marks it (input.dataset.typed); see markTyped().
function markTyped(input){ input.dataset.typed = '1'; }
function convertShownQty(input, sel){
  const from = sel.dataset.prev, to = sel.value;
  if(input.value !== '' && from && to && from !== to && !input.dataset.typed){
    const v = convertQuantity(input.value, from, to);
    if(v != null) input.value = qtyInputValue(v);
  }
  sel.dataset.prev = to;
}
// "saved as 1500 g" under a box typed in another unit than the base unit (empty otherwise)
function savedAsText(value, unit, baseUnit){
  if(!baseUnit || !unit || unit === baseUnit || value === '' || value == null) return '';
  const v = toBaseUnit(num(value), unit, baseUnit);
  return v == null ? '' : 'saved as ' + formatQuantity(v, baseUnit, baseUnit, 4);
}
// cost of one shown unit (cost per base unit x base units in one shown unit), e.g. ₱0.10/mL -> ₱100.00 / L
function costPerShownUnit(costPerBase, baseUnit, unit){
  const f = unit && unit !== baseUnit ? convertQuantity(1, unit, baseUnit) : 1;
  return num(costPerBase) * (f == null ? 1 : f);
}
// Typed amount + chosen unit -> amount in the ingredient's base unit.
function baseQtyOf(value, unit, baseUnit){
  if(!baseUnit) return num(value);
  const v = toBaseUnit(num(value), unit || baseUnit, baseUnit);
  return v == null ? num(value) : v;
}
function rowBaseQty(tr){
  const ing = ingredientById(tr.querySelector('.ri-ing').value);
  return ing ? baseQtyOf(tr.querySelector('.ri-qty').value, tr.querySelector('.ri-unit').value, ing.base_unit) : 0;
}
// Shown amount for a stored base quantity, e.g. "150" + "mL" (4 decimals where tiny amounts matter)
function shownQty(qtyBase, baseUnit, unit){
  const r = fromBaseUnit(qtyBase, baseUnit, unit);
  return {num: String(Number(Number(r.qty).toFixed(4))), unit: unitLabel(r.unit)};
}

/* ---- recipe history: which recipes can't be deleted (they'd break records) ----
   A recipe used by a sale, a production batch, or that makes an inventory item is
   kept (made inactive) instead. Checked BEFORE saving, so one all-or-nothing call
   deletes the rest (a delete that hits such a reference would fail the whole call). */
async function recipeHistoryReasons(ids){
  const reasons = {};
  const add = (id, why) => { (reasons[id] = reasons[id] || []).includes(why) || reasons[id].push(why); };
  ids.forEach(id => {
    const r = state.recipes.find(x => x.id === id);
    if(r && r.produced_ingredient_id) add(id, 'makes an inventory item');
    if(state.ingredients.some(i => i.source_recipe_id === id)) add(id, 'makes an inventory item');
    if(state.productionBatches.some(b => b.recipe_id === id)) add(id, 'has production history');
  });
  // one small question per recipe and table ("is there at least one row?"), a few at a time,
  // so a recipe with many sales can't hide another recipe's history
  const ask = async (id) => {
    const [sold, made] = await Promise.all([
      cloud.select('sale_items', {select: 'id', eq: {recipe_id: id}, limit: 1}),
      cloud.select('production_batches', {select: 'id', eq: {recipe_id: id}, limit: 1}),
    ]);
    if((sold || []).length) add(id, 'has sales history');
    if((made || []).length) add(id, 'has production history');
  };
  for(let i = 0; i < ids.length; i += 8) await Promise.all(ids.slice(i, i + 8).map(ask));
  return reasons;
}
function hideRecipeOp(id, now){ return Ops.update('recipes', {id, active: false, pos_visible: false, qr_visible: false, updated_at: now || nowISO()}); }

/* ---- the options (modifier groups) editor, used inside the recipe form ---- */
function optionsEditor(container, groups){
  const ingOptions = (sel) => `<option value="">— none —</option>` + state.ingredients.filter(i => i.active !== false || i.id === sel).sort(byName)
    .map(i => `<option value="${esc(i.id)}" ${sel === i.id ? 'selected' : ''}>${esc(i.name)} (${esc(unitLabel(i.base_unit))})</option>`).join('');
  function optionRowHtml(o){
    o = o || {id: uid(), label: '', price_delta: 0, ingredient_id: '', ingredient_qty_delta: 0};
    const ing = o.ingredient_id ? ingredientById(o.ingredient_id) : null;
    const shown = ing ? fromBaseUnit(o.ingredient_qty_delta, ing.base_unit, o.unit) : {qty: num(o.ingredient_qty_delta), unit: ''};
    const units = ing ? compatibleUnits(ing.base_unit) : [];
    return `<tr data-opt="${esc(o.id)}">
      <td><input class="mo-label" maxlength="40" value="${esc(o.label || '')}" placeholder="e.g. Large" aria-label="Option name"></td>
      <td><input class="mo-price" type="number" step="any" value="${esc(num(o.price_delta))}" style="min-width:76px;" aria-label="Price change in pesos"></td>
      <td><select class="mo-ing" aria-label="Uses extra ingredient">${ingOptions(o.ingredient_id || '')}</select></td>
      <td><input class="mo-qty" type="number" step="any" value="${esc(qtyInputValue(shown.qty))}" style="min-width:76px;" aria-label="Extra amount"><div class="hint mo-saved">${esc(ing ? savedAsText(shown.qty, shown.unit, ing.base_unit) : '')}</div></td>
      <td><select class="mo-unit" aria-label="Unit of the extra amount" data-prev="${esc(shown.unit)}" data-base="${esc(ing ? ing.base_unit : '')}" ${units.length < 2 ? 'disabled' : ''}>${ing ? recUnitOptionsHtml(ing.base_unit, shown.unit) : ''}</select></td>
      <td><button type="button" class="btn btn-sm btn-ghost mo-rm" title="Remove this option" aria-label="Remove this option">✕</button></td></tr>`;
  }
  function addGroup(g){
    g = g || {id: uid(), name: '', required: false, multi_select: false, options: []};
    const box = document.createElement('div');
    box.className = 'mod-ed-group'; box.dataset.group = g.id;
    box.innerHTML = `<div class="mod-ed-head">
        <input class="mg-name" maxlength="40" value="${esc(g.name || '')}" placeholder="Group name, e.g. Size" aria-label="Option group name">
        <select class="mg-multi" aria-label="How many can be chosen"><option value="one" ${g.multi_select ? '' : 'selected'}>Pick one</option><option value="many" ${g.multi_select ? 'selected' : ''}>Pick any number</option></select>
        <label class="chk"><input type="checkbox" class="mg-req" ${g.required ? 'checked' : ''}> Customer must choose</label>
        <button type="button" class="btn btn-sm btn-ghost mod-move" data-move="-1" title="Move up" aria-label="Move group up">↑</button>
        <button type="button" class="btn btn-sm btn-ghost mod-move" data-move="1" title="Move down" aria-label="Move group down">↓</button>
        <button type="button" class="btn btn-sm btn-ghost mg-rm">Remove group</button></div>
      <table class="ri-table"><thead><tr><th>Option</th><th>Price change ₱</th><th>Uses extra</th><th>Extra amount</th><th>Unit</th><th></th></tr></thead>
        <tbody>${((g.options || []).length ? g.options : [null]).map(optionRowHtml).join('')}</tbody></table>
      <button type="button" class="btn btn-sm btn-outline mo-add" style="margin-top:6px;">+ Add option</button>`;
    container.appendChild(box);
  }
  container.addEventListener('click', (e) => {
    const t = e.target.closest('button'); if(!t) return;
    const box = t.closest('.mod-ed-group');
    if(t.classList.contains('mo-rm')) t.closest('tr').remove();
    else if(t.classList.contains('mg-rm')) box.remove();
    else if(t.classList.contains('mo-add')){ box.querySelector('tbody').insertAdjacentHTML('beforeend', optionRowHtml(null)); box.querySelector('tbody tr:last-child .mo-label').focus(); }
    else if(t.dataset.move){
      if(t.dataset.move === '-1' && box.previousElementSibling) container.insertBefore(box, box.previousElementSibling);
      if(t.dataset.move === '1' && box.nextElementSibling) container.insertBefore(box.nextElementSibling, box);
    }
  });
  const savedHint = (tr) => {
    const ing = ingredientById(tr.querySelector('.mo-ing').value);
    tr.querySelector('.mo-saved').textContent = ing ? savedAsText(tr.querySelector('.mo-qty').value, tr.querySelector('.mo-unit').value, ing.base_unit) : '';
  };
  container.addEventListener('change', (e) => {
    const t = e.target, tr = t.closest('tr');
    if(!tr || !tr.querySelector('.mo-saved')) return;
    if(t.classList.contains('mo-ing')) fillUnitSelect(tr.querySelector('.mo-unit'), ingredientById(t.value), tr.querySelector('.mo-unit').value);
    else if(t.classList.contains('mo-unit')) convertShownQty(tr.querySelector('.mo-qty'), t);
    savedHint(tr);
  });
  container.addEventListener('input', (e) => {
    const t = e.target, tr = t.closest('tr');
    if(!tr || !t.classList.contains('mo-qty')) return;
    markTyped(t); savedHint(tr);
  });
  (groups || []).forEach(addGroup);
  return {
    addGroup: () => { addGroup(null); const n = container.querySelector('.mod-ed-group:last-child .mg-name'); if(n) n.focus(); },
    // Returns {groups} or {error}
    read(){
      const groups = [];
      for(const box of container.querySelectorAll('.mod-ed-group')){
        const name = box.querySelector('.mg-name').value.trim();
        const options = [...box.querySelectorAll('tbody tr')].map(tr => {
          const ing = ingredientById(tr.querySelector('.mo-ing').value);
          const unit = ing ? (tr.querySelector('.mo-unit').value || ing.base_unit) : null;
          // stored in the ingredient's BASE unit (what the counter and the server deduct); unit = how it was typed
          return {
            id: tr.dataset.opt, label: tr.querySelector('.mo-label').value.trim(),
            price_delta: num(tr.querySelector('.mo-price').value),
            ingredient_id: ing ? ing.id : null,
            ingredient_qty_delta: ing ? baseQtyOf(tr.querySelector('.mo-qty').value, unit, ing.base_unit) : num(tr.querySelector('.mo-qty').value),
            unit,
          };
        }).filter(o => o.label);
        if(!name && !options.length) continue;                 // empty group: ignored
        if(!name) return {error: 'Give every option group a name (e.g. Size).'};
        if(!options.length) return {error: `Add at least one option to "${name}", or remove the group.`};
        if(groups.some(g => g.name.toLowerCase() === name.toLowerCase())) return {error: `There are two option groups called "${name}". Give them different names.`};
        const seen = new Set();
        for(const o of options){
          if(seen.has(o.label.toLowerCase())) return {error: `"${name}" has the option "${o.label}" twice.`};
          seen.add(o.label.toLowerCase());
          if(o.ingredient_id && !o.ingredient_qty_delta) return {error: `In "${name}", give an extra amount for "${o.label}" (or set "Uses extra" to none).`};
          if(!o.ingredient_id) o.ingredient_qty_delta = 0;
        }
        groups.push({id: box.dataset.group, name, required: box.querySelector('.mg-req').checked,
          multi_select: box.querySelector('.mg-multi').value === 'many', options});
      }
      return {groups};
    },
  };
}

function openRecipeForm(id){
  const editing = id ? state.recipes.find(r => r.id === id) : null;
  const existingLines = editing ? state.recipeIngredients.filter(ri => ri.recipe_id === editing.id) : [];
  const alreadyLinked = editing && editing.produced_ingredient_id;   // once linked, can't unlink here (protects its stock history)
  // Expected yield is stored in the produced item's base unit (that's what production adds to stock);
  // the owner may type it in another unit of the same family (e.g. 1.5 L for an item counted in mL).
  const linkedIng = alreadyLinked ? ingredientById(editing.produced_ingredient_id) : null;
  const linkedBase = linkedIng ? linkedIng.base_unit : null;
  const yieldShown = editing && editing.expected_yield != null && editing.expected_yield !== ''
    ? (linkedBase ? (convertQuantity(editing.expected_yield, editing.yield_unit || linkedBase, linkedBase) ?? num(editing.expected_yield)) : num(editing.expected_yield)) : '';
  const body = `
    <div class="form-grid">
      <div class="form-row"><label for="r-name">Recipe name</label><input id="r-name" maxlength="80" value="${esc(editing ? editing.name : '')}" placeholder="e.g. Iced Spanish Latte"></div>
      <div class="form-row"><label for="r-type">Recipe type</label><select id="r-type">${RECIPE_TYPES.map(t => `<option value="${t.id}" ${editing && recipeTypeOf(editing) === t.id ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}</select></div>
    </div>
    <div class="form-grid">
      <div class="form-row"><label for="r-cat">Sub-category (menu section, optional)</label><input id="r-cat" maxlength="40" value="${esc(editing ? (editing.category || '') : '')}" placeholder="e.g. Iced, Hot, Pastries" list="r-cat-list"><datalist id="r-cat-list">${[...new Set(state.recipes.map(r => r.category).filter(Boolean))].map(c => `<option value="${esc(c)}">`).join('')}</datalist></div>
      <div class="form-row"><label for="r-price">Selling price (₱; 0 if not sold directly)</label><input type="number" step="any" min="0" id="r-price" value="${esc(editing ? num(editing.selling_price) : '')}"></div>
    </div>
    <div class="form-row"><label for="r-notes">Notes</label><textarea id="r-notes" rows="2">${esc(editing ? (editing.notes || '') : '')}</textarea></div>

    <div class="card soft-card">
      <label style="display:flex;align-items:center;gap:8px;font-size:14px;font-weight:600;cursor:${alreadyLinked ? 'default' : 'pointer'};">
        <input type="checkbox" id="r-produces" ${isProductionRecipe(editing) ? 'checked' : ''} ${alreadyLinked ? 'disabled' : ''} style="width:16px;height:16px;">
        This recipe produces an inventory item (e.g. a sauce, syrup or batch-made pastry)
      </label>
      ${alreadyLinked ? `<div class="hint">Linked to the inventory item "${esc(ingName(editing.produced_ingredient_id))}" — it can't be unlinked here, to protect its stock and production history.</div>` : ''}
      <div id="r-production-fields" style="display:none;margin-top:12px;">
        <div class="form-grid">
          <div class="form-row"><label for="r-yield">Expected yield</label><input type="number" step="any" min="0" id="r-yield" value="${esc(yieldShown === '' || !yieldShown ? '' : qtyInputValue(yieldShown))}" placeholder="e.g. 1000"></div>
          <div class="form-row"><label for="r-yield-unit">Yield unit</label><select id="r-yield-unit" ${(linkedBase && compatibleUnits(linkedBase).length < 2) || (alreadyLinked && !linkedBase) ? 'disabled' : ''} data-prev="${esc(linkedBase || (editing && editing.yield_unit) || YIELD_UNITS[0])}">${linkedBase
            ? recUnitOptionsHtml(linkedBase, linkedBase)
            : YIELD_UNITS.map(u => `<option value="${u}" ${editing && editing.yield_unit === u ? 'selected' : ''}>${esc(unitLabel(u))}</option>`).join('')}</select>
            ${linkedBase ? `<div class="hint">Saved in ${esc(unitLabel(linkedBase))}, the unit "${esc(ingName(editing.produced_ingredient_id))}" is counted in. <span id="r-yield-saved"></span></div>` : ''}</div>
        </div>
        <div class="form-row mb-0"><label for="r-instructions">Production instructions (optional)</label><textarea id="r-instructions" rows="2" placeholder="e.g. Simmer sugar and water to caramel, whisk in warm cream off the heat.">${esc(editing ? (editing.production_instructions || '') : '')}</textarea></div>
      </div>
    </div>

    <div class="card soft-card" style="margin-top:12px;">
      <b style="font-size:14px;">Counter &amp; QR menu</b>
      <div class="chk-row">
        <label class="chk"><input type="checkbox" id="r-posvis" ${!editing || editing.pos_visible !== false ? 'checked' : ''}> Show on the counter</label>
        <label class="chk"><input type="checkbox" id="r-qrvis" ${!editing || editing.qr_visible !== false ? 'checked' : ''}> Show on the QR menu</label>
        <label class="chk"><input type="checkbox" id="r-soldout" ${editing && editing.sold_out ? 'checked' : ''}> Sold out for now</label>
        ${editing ? `<label class="chk"><input type="checkbox" id="r-active" ${editing.active !== false ? 'checked' : ''}> Active</label>` : ''}
      </div>
      <div class="hint">Only active recipes with a selling price appear on the menus.</div>
      <div class="form-grid" style="margin-top:8px;">
        <div class="form-row"><label for="r-desc">Menu description (optional)</label><input id="r-desc" maxlength="160" value="${esc(editing ? (editing.description || '') : '')}" placeholder="e.g. Espresso with condensed milk"></div>
        <div class="form-row"><label for="r-sort">Menu order (smaller shows first)</label><input id="r-sort" type="number" step="1" value="${esc(editing ? num(editing.sort_order) : 0)}"></div>
      </div>
      <div class="form-row"><label>Photo (optional)</label>
        <div class="field-inline">
          <div class="logo-preview" id="r-photo-prev" style="width:56px;height:56px;">${editing && editing.image_url ? `<img src="${esc(editing.image_url)}" alt="">` : '<span>📷</span>'}</div>
          <button class="btn btn-outline btn-sm" type="button" id="r-photo-btn">Choose a photo</button>
          <button class="btn btn-ghost btn-sm" type="button" id="r-photo-rm">Remove photo</button>
          <input type="file" id="r-photo" accept="image/*" style="display:none;">
        </div>
        <div class="hint">Shrunk to about 600 pixels before uploading, so it loads fast on phones.</div>
      </div>
      <div style="margin-top:6px;"><b style="font-size:14px;">Options</b> <span class="hint">e.g. Size (12oz / 16oz +₱20), Milk (Oat +₱25), Add-ons (Extra shot +₱30). An option can also use more of an ingredient (16oz → +60 ml milk) so stock stays right.</span></div>
      <div id="mod-editor"></div>
      <button class="btn btn-outline btn-sm" type="button" id="mod-add-group" style="margin-top:8px;">+ Add option group</button>
    </div>

    <div class="section-title" style="margin-top:14px;font-size:15px;">Ingredients</div>
    <table class="ri-table" id="ri-table">
      <thead><tr><th style="width:34%;">Ingredient</th><th>Quantity</th><th>Unit</th><th>Unit cost</th><th>Total cost</th><th></th></tr></thead>
      <tbody id="ri-body"></tbody>
    </table>
    <button class="btn btn-outline btn-sm" id="ri-add-row" style="margin-top:10px;" type="button">+ Add ingredient</button>
    <div class="recipe-summary" id="r-summary"></div>`;
  const foot = `
    ${editing ? `<button class="btn btn-danger" id="btn-delete-rec" style="margin-right:auto;">Delete</button>` : ''}
    <button class="btn btn-outline" data-cancel>Cancel</button>
    <button class="btn btn-primary" id="btn-save-rec">${editing ? 'Save changes' : 'Create recipe'}</button>`;
  openModal({title: editing ? 'Edit recipe' : 'New recipe', wide: true, body, foot, onMount: (root) => {
    root.querySelector('[data-cancel]').onclick = closeModal;
    const tbody = root.querySelector('#ri-body');
    const excludeId = editing ? editing.produced_ingredient_id : null;
    const producesBox = root.querySelector('#r-produces');
    const prodFields = root.querySelector('#r-production-fields');
    const syncProduces = () => { prodFields.style.display = producesBox.checked ? 'block' : 'none'; refreshSummary(); };
    producesBox.onchange = () => { producesBox.dataset.touched = '1'; syncProduces(); };
    if(!editing){
      root.querySelector('#r-type').onchange = (e) => {
        if(e.target.value === 'SAUCES_SYRUPS' && !producesBox.dataset.touched){ producesBox.checked = true; syncProduces(); }
      };
    }

    // photo: shrunk now, uploaded when saving
    let photo = {url: editing ? (editing.image_url || null) : null, blob: null};
    root.querySelector('#r-photo-btn').onclick = () => root.querySelector('#r-photo').click();
    root.querySelector('#r-photo-rm').onclick = () => { photo = {url: null, blob: null}; root.querySelector('#r-photo-prev').innerHTML = '<span>📷</span>'; };
    root.querySelector('#r-photo').onchange = async (e) => {
      const f = e.target.files[0]; if(!f) return;
      try{
        const blob = await resizeImage(f, 600, 'image/jpeg', 0.82);
        photo = {url: null, blob};
        root.querySelector('#r-photo-prev').innerHTML = `<img src="${URL.createObjectURL(blob)}" alt="">`;
      }catch(err){ toast(err.message || 'Could not read that picture', 'error'); }
    };

    const optEd = optionsEditor(root.querySelector('#mod-editor'), editing ? editing.modifier_groups : []);
    root.querySelector('#mod-add-group').onclick = () => optEd.addGroup();

    function addRow(line){
      const lineIng = line ? ingredientById(line.ingredient_id) : null;
      const shown = lineIng ? fromBaseUnit(line.quantity, lineIng.base_unit, line.unit) : {qty: line ? num(line.quantity) : '', unit: ''};
      const tr = el(`<tr>
        <td><select class="ri-ing" aria-label="Ingredient"><option value="">Choose…</option>${ingredientOptionsGrouped(line ? line.ingredient_id : null, excludeId)}</select></td>
        <td><input type="number" step="any" min="0" class="ri-qty" value="${esc(line ? qtyInputValue(shown.qty) : '')}" placeholder="0" aria-label="Quantity"><div class="hint ri-saved"></div></td>
        <td><select class="ri-unit" aria-label="Unit"></select></td>
        <td class="ri-unitcost text-light">—</td>
        <td class="ri-totalcost"><b>—</b></td>
        <td><button class="btn btn-sm btn-ghost ri-remove" type="button" aria-label="Remove ingredient">✕</button></td></tr>`);
      tbody.appendChild(tr);
      const ingSel = tr.querySelector('.ri-ing'), qtyInput = tr.querySelector('.ri-qty'), unitSel = tr.querySelector('.ri-unit');
      fillUnitSelect(unitSel, lineIng, shown.unit);
      function refreshRow(){
        const ing = ingredientById(ingSel.value);
        const cost = ing ? (ingredientCosting(ing.id).current || 0) : 0;
        const u = ing ? (unitSel.value || ing.base_unit) : '';
        tr.querySelector('.ri-unitcost').innerHTML = ing ? fmtMoney(costPerShownUnit(cost, ing.base_unit, u)) + ' / ' + esc(unitLabel(u)) + (isProducedItem(ing) ? ' <span class="badge badge-gray" style="font-size:10px;">produced</span>' : '') : '—';
        tr.querySelector('.ri-saved').textContent = ing ? savedAsText(qtyInput.value, u, ing.base_unit) : '';
        tr.querySelector('.ri-totalcost').innerHTML = `<b>${fmtMoney(cost * rowBaseQty(tr))}</b>`;
        refreshSummary();
      }
      ingSel.onchange = () => { fillUnitSelect(unitSel, ingredientById(ingSel.value), unitSel.value); refreshRow(); };
      unitSel.onchange = () => { convertShownQty(qtyInput, unitSel); refreshRow(); };
      qtyInput.oninput = () => { markTyped(qtyInput); refreshRow(); };
      tr.querySelector('.ri-remove').onclick = () => { tr.remove(); refreshSummary(); };
      refreshRow();
    }
    function refreshSummary(){
      let total = 0;
      tbody.querySelectorAll('tr').forEach(tr => {
        const ing = ingredientById(tr.querySelector('.ri-ing').value);
        total += (ing ? (ingredientCosting(ing.id).current || 0) : 0) * rowBaseQty(tr);
      });
      const price = num(root.querySelector('#r-price').value);
      const profit = price - total, fcp = price > 0 ? total / price * 100 : 0;
      const yieldVal = yieldBaseQty();
      const ys = root.querySelector('#r-yield-saved');
      if(ys) ys.textContent = savedAsText(root.querySelector('#r-yield').value, root.querySelector('#r-yield-unit').value, linkedBase);
      root.querySelector('#r-summary').innerHTML = price > 0 ? `
        <div class="item"><div class="lbl">Total cost</div><div class="val">${fmtMoney(total)}</div></div>
        <div class="item"><div class="lbl">Selling price</div><div class="val">${fmtMoney(price)}</div></div>
        <div class="item"><div class="lbl">Gross profit</div><div class="val" style="color:${profit >= 0 ? '#2e6349' : '#a63d3d'}">${fmtMoney(profit)}</div></div>
        <div class="item"><div class="lbl">Food cost %</div><div class="val">${fmtNum(fcp, 1)}%</div></div>`
        : `<div class="item"><div class="lbl">Batch cost (at expected yield)</div><div class="val">${fmtMoney(total)}</div></div>
        ${yieldVal > 0 ? `<div class="item"><div class="lbl">Estimated cost / unit</div><div class="val">${fmtMoney(total / yieldVal)}</div></div>` : ''}`;
    }
    root.querySelector('#ri-add-row').onclick = () => addRow(null);
    root.querySelector('#r-price').oninput = refreshSummary;
    root.querySelector('#r-yield').oninput = () => { markTyped(root.querySelector('#r-yield')); refreshSummary(); };
    // the yield in the unit it is stored in (the produced item's base unit when already linked)
    function yieldBaseQty(){
      const v = num(root.querySelector('#r-yield').value);
      return linkedBase ? baseQtyOf(v, root.querySelector('#r-yield-unit').value, linkedBase) : v;
    }
    root.querySelector('#r-yield-unit').onchange = (e) => { convertShownQty(root.querySelector('#r-yield'), e.target); refreshSummary(); };
    if(existingLines.length) existingLines.forEach(addRow); else addRow(null);
    syncProduces();

    const delBtn = root.querySelector('#btn-delete-rec');
    if(delBtn) delBtn.onclick = () => busy(delBtn, async () => {
      if(alreadyLinked){
        const ok = await confirmDialog(`<b>${esc(editing.name)}</b> produces an inventory item, so it can't be deleted (that would break its stock history). Make it <b>inactive</b> instead? It will be hidden from the menus and the production list.`, 'Make inactive');
        if(ok && await boSave([Ops.update('recipes', {id: editing.id, active: false, pos_visible: false, qr_visible: false, updated_at: nowISO()}), Ops.audit('Recipe made inactive', editing.name, editing.id)], {success: 'Recipe made inactive'})){ closeModal(); navigate('recipes'); }
        return;
      }
      // sales or production history -> it can't be deleted (checked first: a refused delete would fail the call)
      let why;
      try{ why = (await recipeHistoryReasons([editing.id]))[editing.id]; }
      catch(err){ toast(friendlyError(err), 'error'); return; }
      if(why && why.length){
        const hide = await confirmDialog(`<b>${esc(editing.name)}</b> ${esc(why.join(' and '))}, so it can't be deleted. Hide it from the counter and the QR menu instead (make it inactive)?`, 'Hide it');
        if(hide && await boSave([hideRecipeOp(editing.id), Ops.audit('Recipe hidden', editing.name, editing.id)], {success: 'Recipe hidden'})){ closeModal(); navigate('recipes'); }
        return;
      }
      const ok = await confirmDialog(`Delete the recipe <b>${esc(editing.name)}</b>? This cannot be undone.`, 'Delete');
      if(!ok) return;
      try{
        await applyChanges([Ops.delWhere('recipe_ingredients', {recipe_id: editing.id}), Ops.del('recipes', editing.id), Ops.audit('Recipe deleted', editing.name, editing.id)]);
      }catch(err){
        if(/foreign key|still used/i.test(String(err.message || '')) || /still used/i.test(friendlyError(err))){
          const hide = await confirmDialog(`<b>${esc(editing.name)}</b> has sales or production history, so it can't be deleted. Hide it from the counter and the QR menu instead (make it inactive)?`, 'Hide it');
          if(hide && await boSave([Ops.update('recipes', {id: editing.id, active: false, pos_visible: false, qr_visible: false, updated_at: nowISO()}), Ops.audit('Recipe hidden', editing.name, editing.id)], {success: 'Recipe hidden'})){ closeModal(); navigate('recipes'); }
          return;
        }
        toast(friendlyError(err), 'error');
        return;
      }
      await boLoad().catch(() => {});
      toast('Recipe deleted'); closeModal(); navigate('recipes');
    }, 'Checking…');

    const saveBtn = root.querySelector('#btn-save-rec');
    saveBtn.onclick = () => busy(saveBtn, async () => {
      const name = root.querySelector('#r-name').value.trim();
      const price = num(root.querySelector('#r-price').value);
      const produces = producesBox.checked;
      const yieldQty = yieldBaseQty();
      const yieldUnit = linkedBase || root.querySelector('#r-yield-unit').value;
      if(!name){ toast('Enter a recipe name', 'error'); return; }
      if(price < 0){ toast('The selling price cannot be below zero', 'error'); return; }
      if(produces && yieldQty <= 0){ toast('Enter an expected yield above 0 for a production recipe', 'error'); return; }
      // quantity in the ingredient's base unit; unit = the unit it was typed in (shown again next time)
      const rows = [...tbody.querySelectorAll('tr')].map(tr => {
        const ing = ingredientById(tr.querySelector('.ri-ing').value);
        return {ingredient_id: ing ? ing.id : '', quantity: rowBaseQty(tr), unit: ing ? (tr.querySelector('.ri-unit').value || ing.base_unit) : null};
      }).filter(r => r.ingredient_id && r.quantity > 0);
      if(!rows.length){ toast('Add at least one ingredient with a quantity', 'error'); return; }
      if(excludeId && rows.some(r => r.ingredient_id === excludeId)){ toast('A recipe cannot use its own produced item as an ingredient', 'error'); return; }
      const dup = rows.find((r, i) => rows.findIndex(x => x.ingredient_id === r.ingredient_id) !== i);
      if(dup){ toast(`${ingName(dup.ingredient_id)} is listed twice — put the total in one line`, 'error'); return; }
      const opt = optEd.read();
      if(opt.error){ toast(opt.error, 'error'); return; }

      const now = nowISO();
      const recipeId = editing ? editing.id : uid();
      let imageUrl = photo.url;
      if(photo.blob){
        try{ imageUrl = await uploadShopImage(photo.blob, `${recipeId}-${Date.now()}.jpg`, 'image/jpeg'); }
        catch(err){ toast('The photo could not be uploaded: ' + friendlyError(err) + ' Remove the photo or try again.', 'error'); return; }
      }
      const recipe = Object.assign({}, editing || {created_at: now, active: true}, {
        id: recipeId, name, category: root.querySelector('#r-cat').value.trim(),
        recipe_type: root.querySelector('#r-type').value, selling_price: price,
        notes: root.querySelector('#r-notes').value, updated_at: now,
        is_production_recipe: produces,
        expected_yield: produces ? yieldQty : (editing ? editing.expected_yield : null),
        yield_unit: produces ? (alreadyLinked ? (linkedBase || editing.yield_unit) : yieldUnit) : (editing ? editing.yield_unit : null),
        production_instructions: produces ? root.querySelector('#r-instructions').value : (editing ? editing.production_instructions || '' : ''),
        pos_visible: root.querySelector('#r-posvis').checked,
        qr_visible: root.querySelector('#r-qrvis').checked,
        sold_out: root.querySelector('#r-soldout').checked,
        description: root.querySelector('#r-desc').value.trim(),
        sort_order: Math.round(num(root.querySelector('#r-sort').value)),
        image_url: imageUrl || null,
        modifier_groups: opt.groups,
      });
      const activeBox = root.querySelector('#r-active');
      if(activeBox) recipe.active = activeBox.checked;
      delete recipe.business_id;

      const ops = [];
      // One recipe <-> one produced ingredient (never duplicated). Its row and the recipe
      // point at each other, so: save the recipe, then the ingredient, then link them.
      let newIngredient = null;
      if(produces && !recipe.produced_ingredient_id){
        newIngredient = {
          id: uid(), name, category_id: producedCategoryId() || (state.categories[0] || {}).id || null,
          supplier_id: null, base_unit: yieldUnit, reorder_level: num(state.settings.low_stock_default_threshold),
          notes: `Auto-created from production recipe "${name}".`, is_produced_item: true, source_recipe_id: recipeId,
          shelf_life_days: null, storage_notes: '', active: true, created_at: now, updated_at: now,
        };
        ops.push(Ops.upsert('recipes', Object.assign({}, recipe, {produced_ingredient_id: null})));
        ops.push(Ops.upsert('ingredients', newIngredient));
        ops.push(Ops.update('recipes', {id: recipeId, produced_ingredient_id: newIngredient.id}));
      } else {
        ops.push(Ops.upsert('recipes', recipe));
        if(produces && recipe.produced_ingredient_id){
          const linked = ingredientById(recipe.produced_ingredient_id);
          if(linked && linked.name !== name) ops.push(Ops.update('ingredients', {id: linked.id, name, updated_at: now}));   // keep in sync with its recipe
        }
      }
      ops.push(Ops.delWhere('recipe_ingredients', {recipe_id: recipeId}));
      rows.forEach(r => ops.push(Ops.upsert('recipe_ingredients', {id: uid(), recipe_id: recipeId, ingredient_id: r.ingredient_id, quantity: r.quantity, unit: r.unit || (ingredientById(r.ingredient_id) || {}).base_unit || null})));
      const priceNote = editing && num(editing.selling_price) !== price ? ` · price ${fmtMoney(editing.selling_price)} → ${fmtMoney(price)}` : '';
      ops.push(Ops.audit(editing ? 'Recipe updated' : 'Recipe created', name + priceNote, recipeId));
      if(await boSave(ops, {success: editing ? 'Recipe updated' : 'Recipe created'})){
        closeModal();
        navigate('recipeDetail', recipeId);
      }
    });
  }});
}

/* ---- recipe detail ---- */
function renderRecipeDetail(id){
  const content = document.getElementById('content');
  const recipe = state.recipes.find(r => r.id === id);
  if(!recipe){ content.innerHTML = emptyBlock('Recipe not found. <a class="linklike" id="back-rec">Back to recipes</a>'); content.querySelector('#back-rec').onclick = () => navigate('recipes'); return; }
  document.getElementById('topbar-title').textContent = recipe.name;
  const m = recipeMetrics(recipe);
  // same points in time as the original app: now minus 1 and 3 months
  const monthAgoD = new Date(); monthAgoD.setMonth(monthAgoD.getMonth() - 1);
  const threeAgoD = new Date(); threeAgoD.setMonth(threeAgoD.getMonth() - 3);
  const monthAgo = monthAgoD.toISOString(), threeMonthsAgo = threeAgoD.toISOString();
  const costLastMonth = recipeCostAsOf(id, monthAgo);
  const costThreeMonths = recipeCostAsOf(id, threeMonthsAgo);
  const sellsDirectly = num(recipe.selling_price) > 0;
  const warn = sellsDirectly && m.foodCostPct > (num(state.settings.food_cost_warning_pct) || 35);
  const produces = isProductionRecipe(recipe);
  const producedIng = produces ? ingredientById(recipe.produced_ingredient_id) : null;
  const costPerUnit = produces && num(recipe.expected_yield) > 0 ? m.cost / num(recipe.expected_yield) : 0;
  const usedByRecipes = producedIng ? state.recipes.filter(r => r.active !== false && state.recipeIngredients.some(ri => ri.recipe_id === r.id && ri.ingredient_id === producedIng.id)) : [];
  const batches = producedIng ? productionBatchesFor(producedIng.id).sort((a, b) => String(b.production_date).localeCompare(String(a.production_date))) : [];
  const groups = recipe.modifier_groups || [];

  content.innerHTML = `
    <a class="linklike" id="back-rec" style="font-size:13px;">← Back to recipes</a>
    <div class="ingredient-detail-header" style="margin-top:10px;gap:12px;flex-wrap:wrap;">
      <div style="display:flex;gap:14px;align-items:center;">
        ${recipe.image_url ? `<img src="${esc(recipe.image_url)}" alt="" class="photo-thumb" style="width:72px;height:72px;">` : ''}
        <div>
          <h2 style="font-family:var(--font-display);font-size:26px;">${esc(recipe.name)}</h2>
          <div class="pill-stack" style="margin-top:6px;">
            <span class="tag-pill">${esc(recipeTypeLabel(recipeTypeOf(recipe)))}</span>
            ${recipe.category ? `<span class="tag-pill">${esc(recipe.category)}</span>` : ''}
            ${produces ? '<span class="badge badge-green">Production recipe</span>' : ''}
            ${recipe.active === false ? '<span class="badge badge-gray">Inactive</span>' : ''}
            ${sellsDirectly ? (warn ? '<span class="badge badge-red">High food cost %</span>' : '<span class="badge badge-green">Healthy margin</span>') : ''}
          </div>
        </div>
      </div>
      <div class="field-inline">
        ${produces ? '<button class="btn btn-amber" id="produce-this-btn">+ Produce this recipe</button>' : ''}
        <button class="btn btn-outline" id="edit-rec-btn">Edit recipe</button>
      </div>
    </div>
    ${sellsDirectly ? `<div class="grid grid-4" style="margin-top:20px;">
      ${statCard('Selling price', fmtMoney(recipe.selling_price), '')}
      ${statCard('Recipe cost (today)', fmtMoney(m.cost), '')}
      ${statCard('Gross profit', fmtMoney(m.profit), '')}
      ${statCard('Food cost %', fmtNum(m.foodCostPct, 1) + '%', warn ? 'Above the warning level' : '')}
    </div>` : `<div class="grid grid-4" style="margin-top:20px;">
      ${statCard('Batch cost (today)', fmtMoney(m.cost), 'at expected yield')}
      ${statCard('Expected yield', recipe.expected_yield ? fmtNum(recipe.expected_yield, 0) + ' ' + esc(recipe.yield_unit || '') : '—', '')}
      ${statCard('Estimated cost / unit', num(recipe.expected_yield) > 0 ? fmtMoney(costPerUnit) + '/' + esc(recipe.yield_unit || '') : '—', 'live, from current ingredient costs')}
      ${statCard('Current stock', producedIng ? fmtNum(ingredientStock(producedIng.id), 2) + ' ' + esc(producedIng.base_unit) : '—', producedIng ? statusBadgeText(stockStatus(ingredientStock(producedIng.id), producedIng.reorder_level)) : '')}
    </div>`}
    ${produces ? `<div class="section-title">Production details</div>
      <div class="card"><div class="grid grid-3">
        <div><div class="text-light" style="font-size:11px;text-transform:uppercase;font-weight:700;">Produces inventory item</div>${producedIng ? `<a class="linklike" data-ing="${esc(producedIng.id)}">${esc(producedIng.name)}</a>` : '—'}</div>
        <div><div class="text-light" style="font-size:11px;text-transform:uppercase;font-weight:700;">Reorder level</div>${producedIng ? fmtNum(producedIng.reorder_level, 1) + ' ' + esc(producedIng.base_unit) : '—'}</div>
        <div><div class="text-light" style="font-size:11px;text-transform:uppercase;font-weight:700;">Shelf life</div>${producedIng && producedIng.shelf_life_days ? esc(producedIng.shelf_life_days) + ' days' : '—'}</div>
      </div>
      ${recipe.production_instructions ? `<div style="margin-top:12px;"><div class="text-light" style="font-size:11px;text-transform:uppercase;font-weight:700;">Instructions</div><div style="margin-top:4px;font-size:13.5px;white-space:pre-wrap;">${esc(recipe.production_instructions)}</div></div>` : ''}
      </div>` : ''}
    ${sellsDirectly ? `<div class="section-title">Counter &amp; QR menu</div>
      <div class="card kv-list">
        <div class="pill-stack">${recipe.pos_visible !== false ? '<span class="badge badge-green">On the counter</span>' : '<span class="badge badge-gray">Hidden on the counter</span>'}
          ${recipe.qr_visible !== false ? '<span class="badge badge-green">On the QR menu</span>' : '<span class="badge badge-gray">Not on the QR menu</span>'}
          ${recipe.sold_out ? '<span class="badge badge-red">Sold out</span>' : ''}<span class="tag-pill">Menu order ${esc(num(recipe.sort_order))}</span></div>
        ${recipe.description ? `<div style="margin-top:6px;">${esc(recipe.description)}</div>` : ''}
        ${groups.length ? groups.map(g => `<div><b>${esc(g.name)}</b> <span class="text-light">(${g.multi_select ? 'pick any' : 'pick one'}${g.required ? ', required' : ''})</span>: ${(g.options || []).map(o => `${esc(o.label)}${num(o.price_delta) ? ` (${num(o.price_delta) > 0 ? '+' : ''}${fmtMoney(o.price_delta)})` : ''}${o.ingredient_id ? ` <span class="text-light">+${esc(formatQuantity(o.ingredient_qty_delta, (ingredientById(o.ingredient_id) || {}).base_unit, o.unit, 4))} ${esc(ingName(o.ingredient_id))}</span>` : ''}`).join(', ')}</div>`).join('')
          : '<div class="text-light">No options (size, milk…). Add them with "Edit recipe".</div>'}
      </div>` : ''}
    <div class="section-title">Ingredient breakdown</div>
    <div class="table-wrap"><table>
      <thead><tr><th>Ingredient</th><th>Type</th><th class="num">Quantity</th><th>Unit</th><th class="num">Unit cost</th><th class="num">Cost</th></tr></thead>
      <tbody>${m.lines.map(l => `<tr>
        <td><a class="linklike" data-ing="${esc(l.ingredient_id)}">${esc(ingName(l.ingredient_id))}</a></td>
        <td>${l.isProduced ? '<span class="badge badge-gray">Produced ingredient</span>' : '<span class="badge badge-gray" style="opacity:.6;">Raw ingredient</span>'}</td>
        ${(() => { const base = (ingredientById(l.ingredient_id) || {}).base_unit || l.unit;
          const r = fromBaseUnit(l.quantity, base, l.unit), q = shownQty(l.quantity, base, l.unit);
          return `<td class="num">${esc(q.num)}</td><td>${esc(q.unit)}</td><td class="num">${fmtMoney(costPerShownUnit(l.unitCost, base, r.unit))} / ${esc(unitLabel(r.unit))}</td>`; })()}<td class="num"><b>${fmtMoney(l.lineCost)}</b></td></tr>`).join('')}
      <tr style="background:var(--beige);"><td colspan="5" style="text-align:right;"><b>Total ${sellsDirectly ? 'recipe' : 'batch'} cost</b></td><td class="num"><b>${fmtMoney(m.cost)}</b></td></tr>
      </tbody></table></div>
    <div class="section-title">Cost history snapshot</div>
    <div class="grid grid-3">
      ${statCard('Cost today', fmtMoney(m.cost), '')}
      ${statCard('Cost about 1 month ago', fmtMoney(costLastMonth), 'worked out from history')}
      ${statCard('Cost about 3 months ago', fmtMoney(costThreeMonths), 'worked out from history')}
    </div>
    <p class="text-light" style="font-size:12.5px;margin-top:10px;">Past costs are worked out from purchases (and, for produced ingredients, production) dated on or before each point in time, using your costing method (${costingMethod() === 'latest' ? 'latest purchase cost' : 'weighted average cost'}).</p>
    ${produces ? `<div class="section-title">Used by</div>
      ${usedByRecipes.length ? `<div class="grid grid-3">${usedByRecipes.map(r => `<div class="card"><a class="linklike" data-recipe="${esc(r.id)}">${esc(r.name)}</a><div class="text-light" style="font-size:12.5px;margin-top:4px;">${esc(recipeTypeLabel(recipeTypeOf(r)))}</div></div>`).join('')}</div>` : emptyBlock('No other recipes use this produced item yet.')}
      <div class="section-title">Production batches</div>
      ${batches.length ? `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Batch #</th><th class="num">Expected</th><th class="num">Actual</th><th class="num">Cost</th><th class="num">Cost/unit</th></tr></thead>
        <tbody>${batches.map(b => `<tr><td>${fmtDay(b.production_date)}</td><td>${esc(b.batch_number || '—')}</td><td class="num">${fmtNum(b.expected_yield, 2)} ${esc(b.yield_unit || '')}</td><td class="num">${fmtNum(b.actual_yield, 2)} ${esc(b.yield_unit || '')}</td><td class="num">${fmtMoney(b.raw_cost_total)}</td><td class="num mono">${fmtMoney(b.actual_cost_per_unit)}</td></tr>`).join('')}</tbody></table></div>`
        : emptyBlock('No batches produced yet.')}` : ''}`;
  content.querySelector('#back-rec').onclick = () => navigate('recipes');
  content.querySelector('#edit-rec-btn').onclick = () => openRecipeForm(id);
  const pb = content.querySelector('#produce-this-btn'); if(pb) pb.onclick = () => openProductionForm(recipe.id);
  content.querySelectorAll('[data-ing]').forEach(a => a.onclick = () => navigate('ingredientDetail', a.dataset.ing));
  content.querySelectorAll('[data-recipe]').forEach(a => a.onclick = () => navigate('recipeDetail', a.dataset.recipe));
}
