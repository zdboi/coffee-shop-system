/* =====================================================================
   BACK OFFICE — kitchen & stock: ingredients, purchases, production,
   inventory (waste, stock adjustments), costing and suppliers.
   (Recipes & menu, with the options editor, are in bo-recipes.js.)
   Same screens and formulas as the original Inventory app; costs and
   stock come from ../shared/logic.js (ingredientCosting, recipeCost,
   recipeMetrics, recipeCostAsOf, toBaseQuantity, stockStatus).
   Related rows are saved together in ONE apply_changes call.
   ===================================================================== */

const UNITS = ['g','kg','ml','L','pcs','box','pack'];
const YIELD_UNITS = ['g','kg','ml','L','pcs'];

function txnTypeBadge(type){
  const colors = {PURCHASE:'badge-green', INITIAL_STOCK:'badge-gray', USAGE:'badge-yellow', WASTE:'badge-red', ADJUSTMENT:'badge-gray',
    PRODUCTION:'badge-green', PRODUCTION_USE:'badge-yellow', SALE_USAGE:'badge-yellow', SALE_REVERSAL:'badge-green'};
  const label = {PURCHASE:'Purchase', INITIAL_STOCK:'Starting stock', USAGE:'Usage', WASTE:'Waste', ADJUSTMENT:'Adjustment',
    PRODUCTION:'Produced', PRODUCTION_USE:'Used in production', SALE_USAGE:'Sold', SALE_REVERSAL:'Refund / void'};
  return `<span class="badge ${colors[type] || 'badge-gray'}">${esc(label[type] || String(type || '').replace(/_/g, ' '))}</span>`;
}
/* ---- typing a quantity in the unit the owner wants (owner request #3, 2026-10-25) ----
   The number is typed in any unit of the ingredient's family (g/kg, mL/L); what is SAVED is always the
   ingredient's base unit (toBaseUnit). Changing the dropdown converts the number already typed. */
function unitOptionsHtml(baseUnit, selected){
  const list = compatibleUnits(baseUnit);
  const sel = list.includes(selected) ? selected : baseUnit;
  return list.map(u => `<option value="${esc(u)}" ${u === sel ? 'selected' : ''}>${esc(unitLabel(u))}</option>`).join('');
}
function unitSelectHtml(id, baseUnit, selected, label){
  return `<select id="${esc(id)}" class="unit-pick" aria-label="${esc(label || 'Unit')}" style="width:auto;min-width:70px;flex:0 0 auto;">${unitOptionsHtml(baseUnit, selected)}</select>`;
}
// quantity input + unit dropdown side by side
function qtyWithUnitHtml(inputId, selectId, baseUnit, attrs, label){
  return `<div style="display:flex;gap:6px;align-items:center;"><input type="number" step="any" id="${esc(inputId)}" ${attrs || ''} style="flex:1 1 auto;min-width:0;">${unitSelectHtml(selectId, baseUnit, baseUnit, label)}</div>`;
}
// Changing the unit (lead decision 2026-10-26, after QA):
//  - a number the owner TYPED keeps its number and only changes unit (type 1.5, pick kg -> 1.5 kg = 1500 g);
//  - a number filled from saved data and not edited since is converted (800 mL -> 0.8 L).
// The hints next to each box show what will be saved. onChange runs afterwards.
// Code that fills a box from saved data calls markFilled(input) so it converts again.
function markFilled(input){ if(input) delete input.dataset.typed; }
function wireUnitConvert(input, select, onChange){
  select.dataset.prev = select.value;
  if(input) input.addEventListener('input', () => { input.dataset.typed = '1'; });
  select.addEventListener('change', () => {
    const from = select.dataset.prev, to = select.value;
    if(input && input.value !== '' && input.dataset.typed !== '1' && from && from !== to){
      const v = convertQuantity(input.value, from, to);
      if(v != null) input.value = String(v);
    }
    select.dataset.prev = to;
    if(onChange) onChange();
  });
}
// Another ingredient chosen: offer its units again (keeps the chosen unit when it still fits)
function resetUnitSelect(select, baseUnit){
  const keep = compatibleUnits(baseUnit).includes(select.value) ? select.value : baseUnit;
  select.innerHTML = unitOptionsHtml(baseUnit, keep);
  select.dataset.prev = select.value;
}
// typed quantity -> base unit (null when it can't be converted)
function typedToBase(value, unit, baseUnit){ return toBaseUnit(num(value), unit || baseUnit, baseUnit); }
// "1.5 L (1500 mL)" when the typed unit is not the base unit, else "1500 mL"
function typedQtyText(qtyBase, baseUnit, typedUnit){
  const base = formatQuantity(qtyBase, baseUnit, baseUnit);
  return typedUnit && typedUnit !== baseUnit ? `${formatQuantity(qtyBase, baseUnit, typedUnit)} (${base})` : base;
}

function activeIngredientsSorted(){ return state.ingredients.filter(i => i.active !== false).sort(byName); }
function ingredientOptionsGrouped(selectedId, excludeId){
  const raw = rawIngredientsList().filter(i => i.id !== excludeId).sort(byName);
  const produced = producedIngredientsList().filter(i => i.id !== excludeId).sort(byName);
  let html = '';
  if(raw.length) html += `<optgroup label="Raw ingredients">${raw.map(i => `<option value="${esc(i.id)}" ${selectedId === i.id ? 'selected' : ''}>${esc(i.name)} (${esc(i.base_unit)})</option>`).join('')}</optgroup>`;
  if(produced.length) html += `<optgroup label="Produced items (house-made)">${produced.map(i => `<option value="${esc(i.id)}" ${selectedId === i.id ? 'selected' : ''}>${esc(i.name)} (house-made, ${esc(i.base_unit)})</option>`).join('')}</optgroup>`;
  // an inactive ingredient still used by this line stays selectable
  const cur = selectedId && ingredientById(selectedId);
  if(cur && cur.active === false) html += `<option value="${esc(cur.id)}" selected>${esc(cur.name)} (inactive)</option>`;
  return html;
}
// Recipes whose options use this ingredient as an "extra" (e.g. Extra shot -> beans)
function recipesUsingAsOption(ingredientId){
  return state.recipes.filter(r => (r.modifier_groups || []).some(g => (g.options || []).some(o => o.ingredient_id === ingredientId)));
}

/* ================= Ingredients ================= */
const ingFilter = {search: '', category: '', status: '', type: '', inactive: false};

function renderIngredients(){
  const bar = setTopbarActions(`<button class="btn btn-outline" id="btn-manage-categories">Manage categories</button> <button class="btn btn-primary" id="btn-new-ingredient">+ Add ingredient</button>`);
  bar.querySelector('#btn-new-ingredient').onclick = () => openIngredientForm();
  bar.querySelector('#btn-manage-categories').onclick = () => openCategoryManager();
  if(ingFilter.category && !state.categories.some(c => c.id === ingFilter.category)) ingFilter.category = '';   // that category was removed
  const content = document.getElementById('content');
  content.innerHTML = `
    <div class="toolbar">
      <div class="toolbar-left">
        <div class="search-box"><input type="text" placeholder="Search ingredients…" id="ing-search" value="${esc(ingFilter.search)}" aria-label="Search ingredients"></div>
        <select class="filter" id="ing-type-filter" aria-label="Type">
          <option value="">All types</option>
          <option value="RAW" ${ingFilter.type === 'RAW' ? 'selected' : ''}>Raw ingredients</option>
          <option value="PRODUCED" ${ingFilter.type === 'PRODUCED' ? 'selected' : ''}>Produced items</option>
        </select>
        <select class="filter" id="ing-cat-filter" aria-label="Category"><option value="">All categories</option>${selectOptions(state.categories.slice().sort(byName), ingFilter.category)}</select>
        <select class="filter" id="ing-status-filter" aria-label="Stock status">
          <option value="">All stock levels</option>
          <option value="IN" ${ingFilter.status === 'IN' ? 'selected' : ''}>In stock</option>
          <option value="LOW" ${ingFilter.status === 'LOW' ? 'selected' : ''}>Low stock</option>
          <option value="OUT" ${ingFilter.status === 'OUT' ? 'selected' : ''}>Out of stock</option>
        </select>
        <label class="inline-check"><input type="checkbox" id="ing-inactive" ${ingFilter.inactive ? 'checked' : ''}> Show inactive</label>
      </div>
      <div class="text-light" style="font-size:13px;">${state.ingredients.filter(i => i.active !== false).length} active ingredients</div>
    </div>
    <div id="ing-table-wrap"></div>`;
  const q = (id) => document.getElementById(id);
  q('ing-search').oninput = (e) => { ingFilter.search = e.target.value; renderIngredientsTable(); };
  q('ing-type-filter').onchange = (e) => { ingFilter.type = e.target.value; renderIngredientsTable(); };
  q('ing-cat-filter').onchange = (e) => { ingFilter.category = e.target.value; renderIngredientsTable(); };
  q('ing-status-filter').onchange = (e) => { ingFilter.status = e.target.value; renderIngredientsTable(); };
  q('ing-inactive').onchange = (e) => { ingFilter.inactive = e.target.checked; renderIngredientsTable(); };
  renderIngredientsTable();
}
function renderIngredientsTable(){
  const wrap = document.getElementById('ing-table-wrap');
  if(!wrap) return;
  let list = state.ingredients.filter(i => ingFilter.inactive || i.active !== false);
  if(ingFilter.search) list = list.filter(i => i.name.toLowerCase().includes(ingFilter.search.toLowerCase()));
  if(ingFilter.type === 'RAW') list = list.filter(i => !isProducedItem(i));
  if(ingFilter.type === 'PRODUCED') list = list.filter(i => isProducedItem(i));
  if(ingFilter.category) list = list.filter(i => i.category_id === ingFilter.category);
  if(ingFilter.status) list = list.filter(i => stockStatus(ingredientStock(i.id), i.reorder_level) === ingFilter.status);
  list.sort(byName);
  if(!list.length){
    wrap.innerHTML = `<div class="table-wrap"><div class="empty-state"><div class="big">${icon('box', {size: 40})}</div>No ingredients found.<br><br><button class="btn btn-primary" id="empty-add-ing">+ Add ingredient</button></div></div>`;
    wrap.querySelector('#empty-add-ing').onclick = () => openIngredientForm();
    return;
  }
  wrap.innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>Ingredient</th><th>Type</th><th>Category</th><th class="num">Stock</th><th>Unit</th><th class="num">Current cost</th><th class="num">Reorder level</th><th>Status</th><th></th></tr></thead>
    <tbody>${list.map(i => {
      const stock = ingredientStock(i.id), costing = ingredientCosting(i.id);
      return `<tr class="clickable ${i.active === false ? 'muted-row' : ''}" data-id="${esc(i.id)}">
        <td><b>${esc(i.name)}</b>${i.active === false ? ' <span class="badge badge-gray">Inactive</span>' : ''}</td>
        <td>${isProducedItem(i) ? '<span class="badge badge-gray">Produced</span>' : '<span class="badge badge-gray" style="opacity:.6;">Raw</span>'}</td>
        <td>${esc(catName(i.category_id))}</td>
        <td class="num">${fmtNum(stock, 2)}${brandInUseLine(i.id)}</td><td>${esc(i.base_unit)}</td>
        <td class="num">${fmtMoney(costing.current)}/${esc(i.base_unit)}</td>
        <td class="num">${fmtNum(i.reorder_level, 1)}</td>
        <td>${statusBadge(stockStatus(stock, i.reorder_level))}</td>
        <td><button class="btn btn-sm btn-ghost" data-edit="${esc(i.id)}">Edit</button></td>
      </tr>`;
    }).join('')}</tbody></table></div>`;
  wrap.querySelectorAll('tr[data-id]').forEach(tr => tr.onclick = (e) => { if(e.target.closest('[data-edit]')) return; navigate('ingredientDetail', tr.dataset.id); });
  wrap.querySelectorAll('[data-edit]').forEach(b => b.onclick = (e) => { e.stopPropagation(); openIngredientForm(b.dataset.edit); });
}

function openIngredientForm(id){
  const editing = id ? ingredientById(id) : null;
  const produced = editing && isProducedItem(editing);
  const sourceRecipe = produced ? sourceRecipeForIngredient(editing) : null;
  const s = state.settings;
  const body = `
    ${produced ? `<div class="card soft-card" style="margin-bottom:14px;font-size:13px;">
      This is a <b>produced item</b>, linked to the recipe <a class="linklike" id="goto-source-recipe">${esc(sourceRecipe ? sourceRecipe.name : '(recipe deleted)')}</a>.
      Its name, base unit and yield are managed from that recipe. Reorder level, category, supplier and storage details can still be edited here.</div>` : ''}
    ${editing && editing.active === false ? `<div class="notice warn">This ingredient is inactive: it is hidden from lists and new recipes. Its history is kept.</div>` : ''}
    <div class="form-row"><label for="f-name">Ingredient name</label><input id="f-name" maxlength="80" value="${esc(editing ? editing.name : '')}" placeholder="e.g. Milk" ${produced ? 'disabled' : ''}></div>
    <div class="form-grid">
      <div class="form-row"><label for="f-cat">Category</label><select id="f-cat">${selectOptions(state.categories.slice().sort(byName), editing ? editing.category_id : (state.categories.slice().sort(byName)[0] || {}).id)}</select>
        <div class="hint"><a class="linklike" id="f-cat-new">+ New category</a></div>
        <div id="f-cat-new-row" style="display:none;margin-top:6px;gap:6px;align-items:center;"><input id="f-cat-new-name" maxlength="80" placeholder="New category name" aria-label="New category name" style="flex:1 1 auto;min-width:0;"><button class="btn btn-sm btn-primary" type="button" id="f-cat-new-save">Add</button></div></div>
      <div class="form-row"><label for="f-sup">Default supplier</label><select id="f-sup"><option value="">—</option>${selectOptions(state.suppliers.slice().sort(byName), editing ? editing.supplier_id : '')}</select></div>
    </div>
    <div class="form-grid">
      <div class="form-row"><label for="f-unit">Base unit</label><select id="f-unit" ${produced ? 'disabled' : ''}>${UNITS.map(u => `<option value="${u}" ${editing && editing.base_unit === u ? 'selected' : ''}>${u}</option>`).join('')}</select><div class="hint">The unit costing and recipes use (e.g. g, ml, pcs)</div></div>
      <div class="form-row"><label for="f-reorder">Reorder level</label><input id="f-reorder" type="number" step="any" min="0" value="${esc(editing ? num(editing.reorder_level) : num(s.low_stock_default_threshold))}"></div>
    </div>
    ${produced ? `<div class="form-grid">
      <div class="form-row"><label for="f-shelflife">Shelf life (days, optional)</label><input id="f-shelflife" type="number" step="1" min="0" value="${esc(editing.shelf_life_days || '')}"></div>
      <div class="form-row"><label for="f-storage">Storage notes</label><input id="f-storage" maxlength="120" value="${esc(editing.storage_notes || '')}" placeholder="e.g. Refrigerated"></div>
    </div>` : ''}
    ${!editing ? `<div class="form-grid"><div class="form-row"><label for="f-initial">Starting stock (optional)</label>${qtyWithUnitHtml('f-initial', 'f-initial-unit', UNITS[0], 'min="0" value="0"', 'Starting stock unit')}<div class="hint" id="f-initial-hint">Recorded as starting stock in the inventory history</div></div>
      <div class="form-row"><label for="f-initial-brand">Brand of this stock (optional)</label><input id="f-initial-brand" maxlength="60" placeholder="e.g. Laciate" autocomplete="off"><div class="hint">Adds the brand to this ingredient. More brands can be added on its page.</div></div></div>` : ''}
    <div class="form-row"><label for="f-notes">Notes</label><textarea id="f-notes" rows="2">${esc(editing ? (editing.notes || '') : '')}</textarea></div>`;
  const foot = `
    ${editing ? (editing.active === false
      ? `<button class="btn btn-outline" id="btn-reactivate-ing" style="margin-right:auto;">Make active again</button>`
      : `<button class="btn btn-danger" id="btn-delete-ing" style="margin-right:auto;">Delete</button>`) : ''}
    <button class="btn btn-outline" data-cancel>Cancel</button>
    <button class="btn btn-primary" id="btn-save-ing">${editing ? 'Save changes' : 'Add ingredient'}</button>`;
  openModal({title: editing ? 'Edit ingredient' : 'Add ingredient', body, foot, onMount: (root) => {
    root.querySelector('[data-cancel]').onclick = closeModal;
    const goto = root.querySelector('#goto-source-recipe');
    if(goto && sourceRecipe) goto.onclick = () => { closeModal(); navigate('recipeDetail', sourceRecipe.id); };
    // add a category without leaving this form; the dropdown refreshes and picks it
    root.querySelector('#f-cat-new').onclick = () => { const r = root.querySelector('#f-cat-new-row'); r.style.display = 'flex'; root.querySelector('#f-cat-new-name').focus(); };
    const catSave = root.querySelector('#f-cat-new-save');
    catSave.onclick = () => busy(catSave, async () => {
      const made = await addCategory(root.querySelector('#f-cat-new-name').value);
      if(!made) return;
      const sel = root.querySelector('#f-cat');
      sel.innerHTML = selectOptions(state.categories.slice().sort(byName), made.id);
      sel.value = made.id;
      root.querySelector('#f-cat-new-name').value = '';
      root.querySelector('#f-cat-new-row').style.display = 'none';
      if(state.route === 'ingredients') renderIngredients();      // the category filter behind the form too
    });
    const initIn = root.querySelector('#f-initial'), initUnit = root.querySelector('#f-initial-unit');
    if(initIn && initUnit){
      const unitSel = root.querySelector('#f-unit');
      const hint = () => {
        const bu = unitSel.value, q = typedToBase(initIn.value, initUnit.value, bu);
        root.querySelector('#f-initial-hint').textContent = 'Recorded as starting stock in the inventory history'
          + (initUnit.value !== bu && q > 0 ? ` (saved as ${formatQuantity(q, bu, bu)})` : '');
      };
      resetUnitSelect(initUnit, unitSel.value);
      wireUnitConvert(initIn, initUnit, hint);
      unitSel.addEventListener('change', () => { resetUnitSelect(initUnit, unitSel.value); hint(); });
      initIn.addEventListener('input', hint);
    }
    const react = root.querySelector('#btn-reactivate-ing');
    if(react) react.onclick = () => busy(react, async () => {
      const ok = await boSave([Ops.update('ingredients', {id: editing.id, active: true, updated_at: nowISO()}), Ops.audit('Ingredient made active', editing.name, editing.id)], {success: 'Ingredient is active again'});
      if(ok){ closeModal(); rerender(); }
    });
    const del = root.querySelector('#btn-delete-ing');
    if(del) del.onclick = () => busy(del, async () => {
      let hasStockHistory = false;
      try{
        const t = await cloud.select('inventory_transactions', {select: 'id', eq: {ingredient_id: editing.id}, limit: 1});
        hasStockHistory = (t || []).length > 0;
      }catch(e){ hasStockHistory = true; }
      const used = state.recipeIngredients.some(ri => ri.ingredient_id === editing.id) || recipesUsingAsOption(editing.id).length > 0;
      if(used || purchasesFor(editing.id).length || productionBatchesFor(editing.id).length || hasStockHistory || produced){
        const ok = await confirmDialog(`<b>${esc(editing.name)}</b> ${produced ? 'is a produced item linked to a recipe' : 'is used in recipes or has stock history'}, so it can't be deleted. Mark it <b>inactive</b> instead? It will be hidden from active lists, and its history is kept.`, 'Make inactive');
        if(!ok) return;
        if(await boSave([Ops.update('ingredients', {id: editing.id, active: false, updated_at: nowISO()}), Ops.audit('Ingredient made inactive', editing.name, editing.id)], {success: 'Ingredient marked inactive'})){ closeModal(); navigate('ingredients'); }
        return;
      }
      const ok = await confirmDialog(`Delete <b>${esc(editing.name)}</b>? This cannot be undone.`, 'Delete');
      if(!ok) return;
      if(await boSave([Ops.del('ingredients', editing.id), Ops.audit('Ingredient deleted', editing.name, editing.id)], {success: 'Ingredient deleted'})){ closeModal(); navigate('ingredients'); }
    }, 'Checking…');
    const save = root.querySelector('#btn-save-ing');
    save.onclick = () => busy(save, async () => {
      const name = produced ? editing.name : root.querySelector('#f-name').value.trim();
      if(!name){ toast('Enter an ingredient name', 'error'); return; }
      if(state.ingredients.some(i => i.id !== (editing && editing.id) && i.active !== false && i.name.trim().toLowerCase() === name.toLowerCase())){
        const ok = await confirmDialog(`There is already an ingredient called <b>${esc(name)}</b>. Save another one with the same name?`, 'Save anyway');
        if(!ok) return;
      }
      const now = nowISO();
      const fields = {
        name, category_id: root.querySelector('#f-cat').value || null,
        supplier_id: root.querySelector('#f-sup').value || null,
        base_unit: produced ? editing.base_unit : root.querySelector('#f-unit').value,
        reorder_level: num(root.querySelector('#f-reorder').value),
        notes: root.querySelector('#f-notes').value, updated_at: now,
      };
      if(produced){
        fields.shelf_life_days = Number(root.querySelector('#f-shelflife').value) || null;
        fields.storage_notes = root.querySelector('#f-storage').value;
      }
      const ops = [];
      let newId = null;
      if(editing){
        ops.push(Ops.update('ingredients', Object.assign({id: editing.id}, fields)));
        if(editing.base_unit !== fields.base_unit) ops.push(Ops.audit('Ingredient unit changed', `${name}: ${editing.base_unit} → ${fields.base_unit}`, editing.id));
      } else {
        newId = uid();
        ops.push(Ops.upsert('ingredients', Object.assign({id: newId, is_produced_item: false, active: true, created_at: now}, fields)));
        const initUnitSel = root.querySelector('#f-initial-unit');
        const initQty = typedToBase(root.querySelector('#f-initial').value, initUnitSel && initUnitSel.value, fields.base_unit);
        if(initQty == null && num(root.querySelector('#f-initial').value) > 0){ toast('That starting stock unit does not fit the base unit — choose the unit again', 'error'); return; }
        // optional brand: the brand row first, then the stock line that names it (same call)
        const brandName0 = cleanBrandName((root.querySelector('#f-initial-brand') || {}).value);
        let brandId = null;
        if(brandName0 === false){ toast('A brand name can have at most 60 characters', 'error'); return; }
        if(brandName0){
          brandId = uid();
          ops.push(Ops.upsert('ingredient_brands', {id: brandId, ingredient_id: newId, name: brandName0, active: true, sort_order: 1, created_at: now, updated_at: now}));
        }
        if(initQty > 0) ops.push(Ops.upsert('inventory_transactions', {id: uid(), ingredient_id: newId, transaction_type: 'INITIAL_STOCK', quantity: initQty, reference_id: null, transaction_date: shopTodayKey(),
          brand_id: brandId,
          notes: 'Starting stock' + (initUnitSel && initUnitSel.value !== fields.base_unit ? ` (${formatQuantity(initQty, fields.base_unit, initUnitSel.value)})` : '') + (brandName0 ? ' · ' + brandName0 : ''), created_at: now}));
        ops.push(Ops.audit('Ingredient added', name, newId));
      }
      if(await boSave(ops, {success: editing ? 'Ingredient updated' : 'Ingredient added'})){
        closeModal();
        if(state.route === 'ingredientDetail') navigate('ingredientDetail', editing ? editing.id : newId); else rerender();
      }
    });
  }});
}

/* ================= Categories (owner request #4, 2026-10-25) =================
   Add, rename and remove ingredient categories. Removing one that ingredients use moves them first
   (to another category or "Uncategorized"), in the SAME apply_changes call as the delete
   (ingredient updates before the delete, or the database refuses it).
   "House-Made / Produced" is found by its exact name (logic.js producedCategoryId, and the start-up
   set-up in bo-core.js adds it again when missing), so it can't be renamed or removed here. */
const UNCATEGORIZED_NAME = 'Uncategorized';
const SUGGESTED_CATEGORY = 'Raw materials';
function categoryKey(name){ return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase(); }
function categoryNamed(name, exceptId){ const k = categoryKey(name); return state.categories.find(c => c.id !== exceptId && categoryKey(c.name) === k) || null; }
function isLockedCategory(c){ return !!c && c.name === PRODUCED_CATEGORY_NAME; }
function ingredientsInCategory(id){ return state.ingredients.filter(i => i.category_id === id); }
function cleanCategoryName(raw){
  const name = String(raw || '').trim().replace(/\s+/g, ' ');
  if(!name){ toast('Enter a category name', 'error'); return null; }
  if(name.length > 80){ toast('Keep the name under 80 characters', 'error'); return null; }
  return name;
}
// returns the new category (after the reload) or null
async function addCategory(raw){
  const name = cleanCategoryName(raw); if(!name) return null;
  const dup = categoryNamed(name);
  if(dup){ toast(`There is already a category called "${dup.name}"`, 'error'); return null; }
  const row = {id: uid(), name};
  if(!await boSave([Ops.upsert('categories', row), Ops.audit('Category added', name, row.id)], {success: 'Category added'})) return null;
  return state.categories.find(c => c.id === row.id) || row;
}
function categoryManagerBody(){
  const list = state.categories.slice().sort(byName);
  const hideHint = (() => { try{ return localStorage.getItem('cccc.bo.hideRawMaterialsHint') === '1'; }catch(e){ return false; } })();
  const suggest = !categoryNamed(SUGGESTED_CATEGORY) && !hideHint;
  return `
    <div class="form-row" style="display:flex;gap:8px;align-items:center;margin-bottom:12px;">
      <input id="cat-new-name" maxlength="80" placeholder="New category, e.g. Raw materials" aria-label="New category name" style="flex:1 1 auto;min-width:0;">
      <button class="btn btn-primary" id="cat-add">Add</button>
    </div>
    ${suggest ? `<div class="notice" id="cat-suggest" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">Suggested: <b>${esc(SUGGESTED_CATEGORY)}</b>
      <button class="btn btn-sm btn-outline" id="cat-suggest-add">Add "${esc(SUGGESTED_CATEGORY)}"</button><a class="linklike" id="cat-suggest-hide" style="font-size:12.5px;">Not needed</a></div>` : ''}
    ${list.length ? `<div class="table-wrap" style="box-shadow:none;"><table><thead><tr><th>Category</th><th class="num">Ingredients</th><th></th></tr></thead><tbody>
      ${list.map(c => {
        const n = ingredientsInCategory(c.id).length, locked = isLockedCategory(c);
        return `<tr data-cat-row="${esc(c.id)}"><td><b>${esc(c.name)}</b>${locked ? ' <span class="badge badge-gray" title="Production puts new house-made items here">Used by production</span>' : ''}</td>
          <td class="num">${n}</td>
          <td class="row-actions">${locked ? '<span class="hint">Kept for production</span>' : `<button class="btn btn-sm btn-ghost" data-cat-rename="${esc(c.id)}">Rename</button><button class="btn btn-sm btn-ghost" data-cat-remove="${esc(c.id)}">Remove</button>`}</td></tr>`;
      }).join('')}</tbody></table></div>` : emptyBlock('No categories yet.')}
    <p class="hint" style="margin-bottom:0;">"${esc(PRODUCED_CATEGORY_NAME)}" holds the items you make yourself (production), so it stays as it is. The Raw / Produced type filter on the Ingredients screen is separate and still works.</p>`;
}
// Text typed in "New category" survives every redraw of the window (after a save, or coming back
// from Rename / Remove); it is cleared only when that name itself was added.
let catDraft = '';
// While a change is saving, the whole window is locked (boxes and buttons), the pressed button says "Saving…".
async function lockCategoryWindow(root, btn, fn, label){
  const box = root.closest('.modal') || root;
  const nodes = [...box.querySelectorAll('input, button, select, textarea')].filter(n => !n.disabled);
  const old = btn ? btn.innerHTML : '';
  nodes.forEach(n => { n.disabled = true; });
  if(btn) btn.textContent = label || 'Saving…';
  try{ return await fn(); }
  finally{ nodes.forEach(n => { if(n.isConnected) n.disabled = false; }); if(btn && btn.isConnected) btn.innerHTML = old; }
}
function openCategoryManager(){
  const after = () => { if(state.route === 'ingredients') renderIngredients(); };
  openModal({title: 'Manage categories', wide: true, body: categoryManagerBody(), foot: `<button class="btn btn-outline" data-cancel>Close</button>`,
    onClose: after,
    onMount: (root) => {
      root.querySelector('[data-cancel]').onclick = closeModal;
      const add = root.querySelector('#cat-add'), input = root.querySelector('#cat-new-name');
      input.value = catDraft;
      input.addEventListener('input', () => { catDraft = input.value; });
      add.onclick = () => { if(add.disabled) return; lockCategoryWindow(root, add, async () => {
        const typed = input.value;
        if(await addCategory(typed)){ if(catDraft === typed) catDraft = ''; openCategoryManager(); }
      }); };
      input.onkeydown = (e) => { if(e.key === 'Enter') add.click(); };
      const sAdd = root.querySelector('#cat-suggest-add');
      if(sAdd) sAdd.onclick = () => lockCategoryWindow(root, sAdd, async () => { if(await addCategory(SUGGESTED_CATEGORY)) openCategoryManager(); });
      const sHide = root.querySelector('#cat-suggest-hide');
      if(sHide) sHide.onclick = () => { try{ localStorage.setItem('cccc.bo.hideRawMaterialsHint', '1'); }catch(e){} root.querySelector('#cat-suggest').remove(); };
      root.querySelectorAll('[data-cat-rename]').forEach(b => b.onclick = () => openCategoryRename(b.dataset.catRename));
      root.querySelectorAll('[data-cat-remove]').forEach(b => b.onclick = () => lockCategoryWindow(root, b, () => removeCategoryFlow(b.dataset.catRemove), '…'));
    }});
}
function openCategoryRename(id){
  const c = state.categories.find(x => x.id === id);
  if(!c || isLockedCategory(c)) return;
  openModal({title: 'Rename category', body: `<div class="form-row"><label for="cat-rename">New name</label><input id="cat-rename" maxlength="80" value="${esc(c.name)}"></div>
      <p class="hint">${plural(ingredientsInCategory(c.id).length, 'ingredient')} keep${ingredientsInCategory(c.id).length === 1 ? 's' : ''} this category under its new name.</p>`,
    foot: `<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" id="cat-rename-save">Rename</button>`,
    onMount: (root) => {
      root.querySelector('[data-cancel]').onclick = () => openCategoryManager();
      const save = root.querySelector('#cat-rename-save');
      save.onclick = () => lockCategoryWindow(root, save, async () => {
        const name = cleanCategoryName(root.querySelector('#cat-rename').value); if(!name) return;
        if(name === c.name){ openCategoryManager(); return; }
        const dup = categoryNamed(name, c.id);
        if(dup){ toast(`There is already a category called "${dup.name}"`, 'error'); return; }
        if(name === PRODUCED_CATEGORY_NAME){ toast('That name is kept for production — choose another one', 'error'); return; }
        if(await boSave([Ops.update('categories', {id: c.id, name}), Ops.audit('Category renamed', `${c.name} → ${name}`, c.id)], {success: 'Category renamed'})) openCategoryManager();
      });
    }});
}
async function removeCategoryFlow(id){
  const c = state.categories.find(x => x.id === id);
  if(!c || isLockedCategory(c)) return;
  const users = ingredientsInCategory(c.id);
  if(!users.length){
    const ok = await confirmDialog(`Remove the category <b>${esc(c.name)}</b>? No ingredient uses it.`, 'Remove');
    if(ok) await boSave([Ops.del('categories', c.id), Ops.audit('Category removed', c.name, c.id)], {success: 'Category removed'});
    openCategoryManager();
    return;
  }
  const others = state.categories.filter(x => x.id !== c.id).sort(byName);
  const uncat = others.find(x => categoryKey(x.name) === categoryKey(UNCATEGORIZED_NAME));
  const canMakeUncat = categoryKey(c.name) !== categoryKey(UNCATEGORIZED_NAME);
  const opts = others.map(x => `<option value="${esc(x.id)}" ${uncat && x.id === uncat.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')
    + (!uncat && canMakeUncat ? `<option value="__new_uncat" selected>${esc(UNCATEGORIZED_NAME)} (new)</option>` : '');
  if(!opts){ toast('Add another category first, so these ingredients have somewhere to go', 'error'); openCategoryManager(); return; }
  openModal({title: 'Remove category', body: `
      <p><b>${esc(c.name)}</b> is used by ${plural(users.length, 'ingredient')}${users.length <= 6 ? ` (${users.map(i => esc(i.name)).join(', ')})` : ''}. Where should ${users.length === 1 ? 'it' : 'they'} go?</p>
      <div class="form-row"><label for="cat-move-to">Move to</label><select id="cat-move-to">${opts}</select></div>
      <p class="hint">The ingredients are moved and the category removed together. Nothing else changes.</p>`,
    foot: `<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-danger" id="cat-move-go">Move and remove</button>`,
    onMount: (root) => {
      root.querySelector('[data-cancel]').onclick = () => openCategoryManager();
      const go = root.querySelector('#cat-move-go');
      go.onclick = () => lockCategoryWindow(root, go, async () => {
        let target = root.querySelector('#cat-move-to').value;
        const ops = [];
        let targetName;
        if(target === '__new_uncat'){
          target = uid(); targetName = UNCATEGORIZED_NAME;
          ops.push(Ops.upsert('categories', {id: target, name: UNCATEGORIZED_NAME}));
        } else targetName = (state.categories.find(x => x.id === target) || {}).name || '';
        const now = nowISO();
        users.forEach(i => ops.push(Ops.update('ingredients', {id: i.id, category_id: target, updated_at: now})));   // moves first …
        ops.push(Ops.del('categories', c.id));                                                                      // … then the delete
        ops.push(Ops.audit('Category removed', `${c.name} — ${plural(users.length, 'ingredient')} moved to ${targetName}`, c.id));
        if(await boSave(ops, {success: `Category removed — ${plural(users.length, 'ingredient')} moved to ${targetName}`})) openCategoryManager();
      }, 'Moving…');
    }});
}

/* ---- ingredient detail ---- */
function renderIngredientDetail(id){
  const content = document.getElementById('content');
  const ing = ingredientById(id);
  if(!ing){ content.innerHTML = emptyBlock('Ingredient not found. <a class="linklike" id="back-ing">Back to ingredients</a>'); content.querySelector('#back-ing').onclick = () => navigate('ingredients'); return; }
  document.getElementById('topbar-title').textContent = ing.name;
  const costing = ingredientCosting(id);
  const produced = isProducedItem(ing);
  const sourceRecipe = produced ? sourceRecipeForIngredient(ing) : null;
  const stock = ingredientStock(id);
  const status = stockStatus(stock, ing.reorder_level);
  const purchases = purchasesFor(id).sort((a, b) => String(b.purchase_date).localeCompare(String(a.purchase_date)));
  const batches = productionBatchesFor(id).sort((a, b) => String(b.production_date).localeCompare(String(a.production_date)));
  const usingRecipes = state.recipes.filter(r => state.recipeIngredients.some(ri => ri.recipe_id === r.id && ri.ingredient_id === id));
  const optionRecipes = recipesUsingAsOption(id);
  const hasCurrentCost = produced ? (sourceRecipe && num(sourceRecipe.expected_yield) > 0) : costing.count > 0;
  const u = esc(ing.base_unit);

  content.innerHTML = `
    <a class="linklike" id="back-ing" style="font-size:13px;">← Back to ingredients</a>
    <div class="ingredient-detail-header" style="margin-top:10px;gap:12px;flex-wrap:wrap;">
      <div>
        <h2 class="display page-title">${esc(ing.name)} ${ing.active === false ? '<span class="badge badge-gray">Inactive</span>' : ''} ${produced ? '<span class="badge badge-gray">Produced</span>' : ''}</h2>
        <div class="pill-stack" style="margin-top:6px;">
          <span class="tag-pill">${esc(catName(ing.category_id))}</span><span class="tag-pill">${u}</span>${statusBadge(status)}
          ${produced && sourceRecipe ? `<a class="linklike" data-recipe="${esc(sourceRecipe.id)}" style="font-size:12.5px;">Recipe: ${esc(sourceRecipe.name)} →</a>` : ''}
        </div>
      </div>
      <div class="field-inline">
        ${produced ? '<button class="btn btn-amber" id="produce-btn">+ Produce</button>' : '<button class="btn btn-outline" id="buy-btn">+ Record purchase</button>'}
        <button class="btn btn-outline" id="edit-ing-btn">Edit ingredient</button>
      </div>
    </div>
    <div class="grid grid-4" style="margin-top:20px;">
      ${statCard('Current stock', fmtNum(stock, 2) + ' ' + u, 'Reorder at ' + fmtNum(ing.reorder_level, 1))}
      ${statCard('Current cost', hasCurrentCost ? fmtMoney(costing.current) + '/' + u : '—', produced ? 'Live cost from recipe' : (costing.method === 'latest' ? 'Latest purchase' : 'Weighted average'))}
      ${statCard(produced ? 'Latest batch cost' : 'Latest purchase cost', costing.latest != null ? fmtMoney(costing.latest) : '—', '')}
      ${statCard(produced ? 'Weighted avg. batch cost' : 'Weighted average cost', costing.weightedAvg != null ? fmtMoney(costing.weightedAvg) : '—', produced ? plural(costing.count, 'batch', 'batches') : plural(costing.count, 'purchase'))}
    </div>
    <div class="grid grid-2" style="margin-top:16px;">
      ${statCard('Lowest / highest cost', costing.count ? `${fmtMoney(costing.lowest)} / ${fmtMoney(costing.highest)}` : '—', produced ? 'across production batches' : 'across purchase history')}
      ${statCard('Inventory value', fmtMoney(stock * (costing.current || 0)), 'stock × current cost')}
    </div>
    ${produced ? '' : brandSectionHtml(ing)}
    ${produced ? `<p class="hint" style="margin-top:10px;">This item's cost in other recipes is worked out live from its recipe (${esc(sourceRecipe ? sourceRecipe.name : '—')}) and today's ingredient costs, so it updates by itself — the same way a raw ingredient updates when you record a new purchase. Batch figures above are for reference.</p>` : ''}
    ${produced ? `
      <div class="section-title">Production history</div>
      ${batches.length ? `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Batch #</th><th class="num">Expected</th><th class="num">Actual yield</th><th class="num">Production cost</th><th class="num">Cost/unit</th></tr></thead>
        <tbody>${batches.map(b => `<tr><td>${fmtDay(b.production_date)}</td><td>${esc(b.batch_number || '—')}</td><td class="num">${fmtNum(b.expected_yield, 2)} ${esc(b.yield_unit || '')}</td><td class="num">${fmtNum(b.actual_yield, 2)} ${esc(b.yield_unit || '')}</td><td class="num">${fmtMoney(b.raw_cost_total)}</td><td class="num mono">${fmtMoney(b.actual_cost_per_unit)}/${esc(b.yield_unit || '')}</td></tr>`).join('')}</tbody></table></div>`
        : emptyBlock('No production batches recorded yet. Use "+ Produce" to make your first batch.')}` : `
      <div class="section-title">Purchase history</div>
      ${purchases.length ? `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Supplier</th><th>Brand</th><th>Invoice #</th><th class="num">Quantity</th><th>Unit</th><th class="num">Total price</th><th class="num">Price / base unit</th></tr></thead>
        <tbody>${purchases.map(p => `<tr><td>${fmtDay(p.purchase_date)}</td><td>${esc(supName(p.supplier_id))}</td><td>${p.brand_id ? esc(brandName(p.brand_id)) : '<span class="text-light">—</span>'}</td><td>${esc(p.invoice_number || '—')}</td><td class="num">${fmtNum(p.quantity, 2)}</td><td>${esc(p.purchase_unit || '')}</td><td class="num">${fmtMoney(p.total_price)}</td><td class="num mono">${fmtMoney(p.price_per_base_unit)}/${u}</td></tr>`).join('')}</tbody></table></div>`
        : emptyBlock('No purchases recorded yet for this ingredient.')}`}
    <div class="section-title">Inventory history</div>
    <div id="ing-history"><div class="loading-line">Loading the stock history…</div></div>
    <div class="section-title">${produced ? 'Used by (recipes using this produced item)' : 'Recipes using this ingredient'}</div>
    ${usingRecipes.length ? `<div class="grid grid-3">${usingRecipes.map(r => `<div class="card"><a class="linklike" data-recipe="${esc(r.id)}">${esc(r.name)}</a><div class="text-light" style="font-size:12.5px;margin-top:4px;">${esc(recipeTypeLabel(recipeTypeOf(r)))}${r.active === false ? ' · inactive' : ''}</div></div>`).join('')}</div>`
      : emptyBlock('This ingredient is not used in any recipe.')}
    ${optionRecipes.length ? `<p class="hint" style="margin-top:10px;">Also used as an extra by options in: ${optionRecipes.map(r => `<a class="linklike" data-recipe="${esc(r.id)}">${esc(r.name)}</a>`).join(', ')}.</p>` : ''}`;
  content.querySelector('#back-ing').onclick = () => navigate('ingredients');
  content.querySelector('#edit-ing-btn').onclick = () => openIngredientForm(id);
  const pb = content.querySelector('#produce-btn'); if(pb) pb.onclick = () => openProductionForm(sourceRecipe ? sourceRecipe.id : null);
  const bb = content.querySelector('#buy-btn'); if(bb) bb.onclick = () => openPurchaseForm(id);
  if(!produced) wireBrandSection(content, ing);
  content.querySelectorAll('[data-recipe]').forEach(a => a.onclick = () => navigate('recipeDetail', a.dataset.recipe));
  loadIngredientTxns(id).then(txns => {
    const box = document.getElementById('ing-history');
    if(!box || state.route !== 'ingredientDetail' || state.routeParam !== id) return;
    box.innerHTML = txns.length ? `<div class="table-wrap" style="max-height:520px;"><table><thead><tr><th>Date</th><th>Type</th><th class="num">Quantity</th><th class="num">Running stock</th><th>Notes</th></tr></thead><tbody>${runningStockRows(txns, ing.base_unit)}</tbody></table></div>`
      : emptyBlock('No stock movements yet.');
  }).catch(e => { const box = document.getElementById('ing-history'); if(box) box.innerHTML = emptyBlock(esc(friendlyError(e))); });
}
function runningStockRows(txns, unit){
  const asc = txns.slice().sort((a, b) => String(a.transaction_date).localeCompare(String(b.transaction_date)) || String(a.created_at || '').localeCompare(String(b.created_at || '')));
  let running = 0;
  const rows = asc.map(t => { running += signedQty(t); return Object.assign({}, t, {running}); });
  return rows.reverse().map(t => `<tr>
    <td>${fmtDay(t.transaction_date)}</td><td>${txnTypeBadge(t.transaction_type)}</td>
    <td class="num">${signedQty(t) > 0 ? '+' : ''}${fmtNum(signedQty(t), 2)} ${esc(unit)}</td>
    <td class="num"><b>${fmtNum(t.running, 2)} ${esc(unit)}</b></td>
    <td class="text-light">${esc(t.notes || '—')}</td></tr>`).join('');
}

/* ================= Ingredient brands (release 1.2) =================
   Each ingredient can have brands (e.g. milk: Laciate, Alaska). A purchase, starting stock or
   stock added by hand can name one. The server works out what is left of each brand, oldest
   stock first (first in, first out), and which brand is being used now (bo_bootstrap
   brand_stock; read with brandStockFor / inUseBrand / brandsFor from ../shared/logic.js).
   A brand that a purchase or stock line names can't be deleted (BRAND_IN_USE): switch it off. */
function cleanBrandName(raw){
  const n = String(raw == null ? '' : raw).replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
  if(n.length > 60) return false;
  return n;
}
// small line under the stock number in lists: the brand being used now
function brandInUseLine(ingredientId){
  if(!brandsFor(ingredientId, true).length) return '';
  const u = inUseBrand(ingredientId);
  return u ? `<span class="brand-tag" title="Being used now (oldest stock first)">${esc(u.brand_id ? u.brand_name : 'Brand not set')}</span>` : '';
}
// fills a Brand dropdown with the ingredient's active brands (optional); hides the row when there are none
function fillBrandSelect(sel, hint, ingredientId, what){
  if(!sel) return;
  const list = brandsFor(ingredientId);
  const row = sel.closest('.form-row');
  sel.innerHTML = `<option value="">No brand / not sure</option>` + list.map(b => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('');
  if(hint) hint.textContent = list.length ? `Optional: which brand ${what} is.` : '';
  if(row && row.id === 'p-brand-row'){
    sel.disabled = !list.length;
    if(hint && !list.length) hint.textContent = 'This ingredient has no brands. Add them on its page if you buy more than one brand.';
  }
}
function brandUsed(b){
  if(state.purchases.some(p => p.brand_id === b.id)) return true;
  const e = brandStockFor(b.ingredient_id);
  return !!(e && (e.lots || []).some(l => l.brand_id === b.id));
}
function brandSectionHtml(ing){
  const u = ing.base_unit;
  const all = brandsFor(ing.id, true);
  const stockEntry = brandStockFor(ing.id);
  const left = {};
  ((stockEntry && stockEntry.brands) || []).forEach(x => { left[x.brand_id || ''] = num(x.remaining); });
  const inUse = inUseBrand(ing.id);
  const inUseText = !all.length ? '' : inUse
    ? `<div class="brand-inuse" id="brand-inuse">${icon('check', {size: 20})}<span>In use now: <b>${esc(inUse.brand_id ? inUse.brand_name : 'brand not set')}</b> (oldest stock first)${inUse.price_per_base_unit != null ? ` · ${fmtMoney(inUse.price_per_base_unit)} per ${esc(u)}` : ''} · ${esc(fmtNum(inUse.remaining, 2))} ${esc(u)} left of that delivery</span></div>`
    : `<div class="brand-inuse none" id="brand-inuse">${icon('info', {size: 20})}<span>No stock yet, so no brand is in use.</span></div>`;
  const notSet = left[''] > 0 ? `<tr class="muted-row"><td><b>Not set</b><div class="sub-line">stock without a brand</div></td><td class="num">${fmtNum(left[''], 2)} ${esc(u)}</td><td></td><td></td></tr>` : '';
  return `<div class="section-title">Brands</div>
    <div class="card" id="brand-card">
      ${inUseText}
      ${all.length ? `<div class="table-wrap" style="box-shadow:none;"><table><thead><tr><th>Brand</th><th class="num">Stock now</th><th>Status</th><th></th></tr></thead><tbody>
        ${all.map((b, i) => `<tr class="${b.active === false ? 'muted-row' : ''}" data-brand-row="${esc(b.id)}"><td><b>${esc(b.name)}</b>${inUse && inUse.brand_id === b.id ? ' <span class="badge badge-green">In use now</span>' : ''}</td>
          <td class="num">${fmtNum(left[b.id] || 0, 2)} ${esc(u)}</td>
          <td>${b.active !== false ? '<span class="badge badge-green">On</span>' : '<span class="badge badge-gray">Off</span>'}</td>
          <td class="row-actions"><span class="brand-order"><button class="btn btn-sm btn-ghost" data-brand-move="-1" data-brand="${esc(b.id)}" ${i === 0 ? 'disabled' : ''} aria-label="Move ${esc(b.name)} up">${icon('chevron-down', {size: 18, className: 'rot180'})}</button><button class="btn btn-sm btn-ghost" data-brand-move="1" data-brand="${esc(b.id)}" ${i === all.length - 1 ? 'disabled' : ''} aria-label="Move ${esc(b.name)} down">${icon('chevron-down', {size: 18})}</button></span>
            <button class="btn btn-sm btn-ghost" data-brand-rename="${esc(b.id)}">Rename</button>
            <button class="btn btn-sm btn-ghost" data-brand-toggle="${esc(b.id)}">${b.active !== false ? 'Switch off' : 'Switch on'}</button>
            ${brandUsed(b) ? '' : `<button class="btn btn-sm btn-ghost" data-brand-del="${esc(b.id)}">Delete</button>`}</td></tr>`).join('')}
        ${notSet}
      </tbody></table></div>` : `<p class="hint" style="margin-top:0;">Buy more than one brand of ${esc(ing.name)}? Add the brands here. Then each purchase can say which brand it was, and you see how much of each is left and which one is being used now (oldest stock first).</p>`}
      <div class="brand-add"><label class="sr-only" for="brand-new-name">New brand name</label><input id="brand-new-name" maxlength="60" placeholder="New brand, e.g. Laciate" autocomplete="off"><button class="btn btn-primary btn-sm" id="brand-add" type="button">${icon('plus', {size: 18})} Add brand</button></div>
      ${all.length ? '<p class="hint" style="margin-bottom:0;">A brand that is on a purchase or stock can\'t be deleted — switch it off instead. Switched-off brands keep their history but are not offered for new purchases.</p>' : ''}
    </div>`;
}
function wireBrandSection(root, ing){
  const card = root.querySelector('#brand-card'); if(!card) return;
  const again = () => { if(state.route === 'ingredientDetail' && state.routeParam === ing.id) navigate('ingredientDetail', ing.id); };
  const B = (id) => state.ingredientBrands.find(b => b.id === id);
  const nameTaken = (name, exceptId) => brandsFor(ing.id, true).some(b => b.id !== exceptId && b.name.trim().toLowerCase() === name.toLowerCase());
  const add = card.querySelector('#brand-add'), input = card.querySelector('#brand-new-name');
  input.onkeydown = (e) => { if(e.key === 'Enter'){ e.preventDefault(); add.click(); } };
  add.onclick = () => busy(add, async () => {
    const name = cleanBrandName(input.value);
    if(name === false){ toast('A brand name can have at most 60 characters', 'error'); return; }
    if(!name){ toast('Type the brand name first', 'error'); input.focus(); return; }
    if(nameTaken(name)){ toast(`${ing.name} already has a brand called "${name}"`, 'error'); return; }
    const now = nowISO();
    const order = brandsFor(ing.id, true).reduce((m, b) => Math.max(m, num(b.sort_order)), 0) + 1;
    const id = uid();
    if(await boSave([Ops.upsert('ingredient_brands', {id, ingredient_id: ing.id, name, active: true, sort_order: order, created_at: now, updated_at: now}),
      Ops.audit('Brand added', `${ing.name}: ${name}`, id)], {success: `Brand "${name}" added`})) again();
  }, 'Adding…');
  card.querySelectorAll('[data-brand-toggle]').forEach(btn => btn.onclick = () => busy(btn, async () => {
    const b = B(btn.dataset.brandToggle); if(!b) return;
    const on = b.active === false;
    if(await boSave([Ops.update('ingredient_brands', {id: b.id, active: on, updated_at: nowISO()}), Ops.audit(on ? 'Brand switched on' : 'Brand switched off', `${ing.name}: ${b.name}`, b.id)],
      {success: on ? `${b.name} is offered again` : `${b.name} is switched off (its history stays)`})) again();
  }, '…'));
  card.querySelectorAll('[data-brand-rename]').forEach(btn => btn.onclick = () => {
    const b = B(btn.dataset.brandRename); if(!b) return;
    openModal({title: 'Rename brand', body: `<div class="form-row"><label for="br-name">Brand name</label><input id="br-name" maxlength="60" value="${esc(b.name)}"></div><p class="hint">Purchases and stock keep pointing at this brand; only the name changes.</p>`,
      foot: `<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" id="br-save">Save</button>`,
      onMount: (m) => {
        m.querySelector('[data-cancel]').onclick = closeModal;
        const save = m.querySelector('#br-save');
        save.onclick = () => busy(save, async () => {
          const name = cleanBrandName(m.querySelector('#br-name').value);
          if(!name){ toast(name === false ? 'A brand name can have at most 60 characters' : 'Enter a name', 'error'); return; }
          if(nameTaken(name, b.id)){ toast(`${ing.name} already has a brand called "${name}"`, 'error'); return; }
          if(await boSave([Ops.update('ingredient_brands', {id: b.id, name, updated_at: nowISO()}), Ops.audit('Brand renamed', `${ing.name}: ${b.name} → ${name}`, b.id)], {success: 'Saved'})){ closeModal(); again(); }
        });
      }});
  });
  card.querySelectorAll('[data-brand-move]').forEach(btn => btn.onclick = () => busy(btn, async () => {
    const list = brandsFor(ing.id, true);
    const i = list.findIndex(b => b.id === btn.dataset.brand), j = i + Number(btn.dataset.brandMove);
    if(i < 0 || j < 0 || j >= list.length) return;
    const t = list[i]; list[i] = list[j]; list[j] = t;
    const now = nowISO();
    const ops = list.map((b, k) => num(b.sort_order) !== k + 1 ? Ops.update('ingredient_brands', {id: b.id, sort_order: k + 1, updated_at: now}) : null).filter(Boolean);
    if(await boSave(ops)) again();
  }, '…'));
  card.querySelectorAll('[data-brand-del]').forEach(btn => btn.onclick = async () => {
    const b = B(btn.dataset.brandDel); if(!b) return;
    const ok = await confirmDialog(`Delete the brand <b>${esc(b.name)}</b>? (A brand that is on a purchase or stock can't be deleted — switch it off instead.)`, 'Delete brand');
    if(!ok) return;
    if(await boSave([Ops.del('ingredient_brands', b.id), Ops.audit('Brand deleted', `${ing.name}: ${b.name}`, b.id)], {success: 'Brand deleted'})) again();
  });
}

/* ================= Purchases ================= */
const purFilter = {search: '', supplier: ''};
function renderPurchases(){
  setTopbarActions(`<button class="btn btn-primary" id="btn-new-purchase">+ New purchase</button>`)
    .querySelector('#btn-new-purchase').onclick = () => openPurchaseForm();
  const content = document.getElementById('content');
  content.innerHTML = `
    <div class="toolbar">
      <div class="toolbar-left">
        <div class="search-box"><input type="text" placeholder="Search by ingredient or invoice…" id="pur-search" value="${esc(purFilter.search)}" aria-label="Search purchases"></div>
        <select class="filter" id="pur-sup-filter" aria-label="Supplier"><option value="">All suppliers</option>${selectOptions(state.suppliers.slice().sort(byName), purFilter.supplier)}</select>
      </div>
      <div class="text-light" style="font-size:13px;">${plural(state.purchases.length, 'purchase record')}</div>
    </div>
    <div id="pur-table-wrap"></div>`;
  document.getElementById('pur-search').oninput = e => { purFilter.search = e.target.value; renderPurchasesTable(); };
  document.getElementById('pur-sup-filter').onchange = e => { purFilter.supplier = e.target.value; renderPurchasesTable(); };
  renderPurchasesTable();
}
function renderPurchasesTable(){
  const wrap = document.getElementById('pur-table-wrap');
  if(!wrap) return;
  let list = state.purchases.slice();
  if(purFilter.search){
    const q = purFilter.search.toLowerCase();
    list = list.filter(p => ingName(p.ingredient_id).toLowerCase().includes(q) || (p.invoice_number || '').toLowerCase().includes(q));
  }
  if(purFilter.supplier) list = list.filter(p => p.supplier_id === purFilter.supplier);
  list.sort((a, b) => String(b.purchase_date).localeCompare(String(a.purchase_date)) || String(b.created_at).localeCompare(String(a.created_at)));
  if(!list.length){
    wrap.innerHTML = `<div class="table-wrap"><div class="empty-state"><div class="big">${icon('inbox', {size: 40})}</div>No purchases recorded yet.<br><br><button class="btn btn-primary" id="empty-add-pur">+ New purchase</button></div></div>`;
    wrap.querySelector('#empty-add-pur').onclick = () => openPurchaseForm();
    return;
  }
  wrap.innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>Date</th><th>Ingredient</th><th>Supplier</th><th>Invoice #</th><th class="num">Qty</th><th>Unit</th><th class="num">Total price</th><th class="num">Price/base unit</th><th></th></tr></thead>
    <tbody>${list.map(p => `<tr>
      <td>${fmtDay(p.purchase_date)}</td>
      <td><a class="linklike" data-ing="${esc(p.ingredient_id)}">${esc(ingName(p.ingredient_id))}</a>${p.brand_id ? `<span class="brand-tag">${esc(brandName(p.brand_id))}</span>` : ''}</td>
      <td>${esc(supName(p.supplier_id))}</td><td>${esc(p.invoice_number || '—')}</td>
      <td class="num">${fmtNum(p.quantity, 2)}</td><td>${esc(p.purchase_unit || '')}</td>
      <td class="num">${fmtMoney(p.total_price)}</td><td class="num mono">${fmtMoney(p.price_per_base_unit)}</td>
      <td><button class="btn btn-sm btn-ghost" data-del="${esc(p.id)}">Delete</button></td></tr>`).join('')}</tbody></table></div>`;
  wrap.querySelectorAll('[data-ing]').forEach(a => a.onclick = () => navigate('ingredientDetail', a.dataset.ing));
  wrap.querySelectorAll('[data-del]').forEach(btn => btn.onclick = async () => {
    const p = state.purchases.find(x => x.id === btn.dataset.del);
    if(!p) return;
    const ok = await confirmDialog(`Delete this purchase of <b>${esc(ingName(p.ingredient_id))}</b> (${fmtMoney(p.total_price)}, ${fmtDay(p.purchase_date)})? Its stock is taken off again and costs are worked out again. This cannot be undone.`, 'Delete purchase');
    if(!ok) return;
    await boSave([
      Ops.delWhere('inventory_transactions', {reference_id: p.id, transaction_type: 'PURCHASE'}),
      Ops.del('purchases', p.id),
      Ops.audit('Purchase deleted', `${ingName(p.ingredient_id)} — ${fmtMoney(p.total_price)} (${p.purchase_date})`, p.id),
    ], {success: 'Purchase deleted'}) && renderPurchasesTable();
  });
}

function openPurchaseForm(prefillIngredientId){
  const list = activeIngredientsSorted();
  if(!list.length){ toast('Add an ingredient first', 'warn'); return; }
  const today = shopTodayKey();
  const body = `
    <div class="form-row"><label for="p-ing">Ingredient</label><select id="p-ing">${list.map(i => `<option value="${esc(i.id)}" ${prefillIngredientId === i.id ? 'selected' : ''}>${esc(i.name)} (${esc(i.base_unit)})</option>`).join('')}</select></div>
    <div class="form-grid">
      <div class="form-row"><label for="p-sup">Supplier</label><select id="p-sup"><option value="">—</option>${selectOptions(state.suppliers.slice().sort(byName), '')}</select></div>
      <div class="form-row" id="p-brand-row"><label for="p-brand">Brand</label><select id="p-brand"></select><div class="hint" id="p-brand-hint"></div></div>
    </div>
    <div class="form-grid">
      <div class="form-row"><label for="p-date">Purchase date</label><input type="date" id="p-date" value="${today}" max="${keyAddDays(today, 1)}"></div>
    </div>
    <div class="form-grid">
      <div class="form-row"><label for="p-invoice">Invoice number</label><input id="p-invoice" maxlength="60" placeholder="optional"></div>
    </div>
    <div class="form-row"><label for="p-price">Total price (₱)</label><input type="number" step="any" min="0" id="p-price" placeholder="0.00"></div>
    <div class="form-grid">
      <div class="form-row"><label for="p-qty">Quantity purchased</label><input type="number" step="any" min="0" id="p-qty" placeholder="e.g. 1000"></div>
      <div class="form-row"><label for="p-unit">Purchase unit</label><select id="p-unit">${UNITS.map(u => `<option value="${u}">${u}</option>`).join('')}</select></div>
    </div>
    <div class="form-row" id="p-conversion-row" style="display:none;">
      <label for="p-conversion">Base units per purchase unit</label>
      <input type="number" step="any" min="0" id="p-conversion" placeholder="e.g. 100 (for a box of 100 cups)">
      <div class="hint" id="p-conv-hint"></div>
    </div>
    <div class="form-row"><label for="p-notes">Notes</label><textarea id="p-notes" rows="2"></textarea></div>
    <div class="card soft-card"><b>Preview:</b> <span id="p-preview-text">Enter quantity and price to see the cost per base unit.</span></div>`;
  const foot = `<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" id="btn-save-pur">Save purchase</button>`;
  openModal({title: 'New purchase', body, foot, onMount: (root) => {
    root.querySelector('[data-cancel]').onclick = closeModal;
    const ingSel = root.querySelector('#p-ing'), unitSel = root.querySelector('#p-unit');
    const qtyInput = root.querySelector('#p-qty'), priceInput = root.querySelector('#p-price');
    const convRow = root.querySelector('#p-conversion-row'), convInput = root.querySelector('#p-conversion');
    const preview = root.querySelector('#p-preview-text');
    const currentIngredient = () => ingredientById(ingSel.value);
    // Same rule as the original app: weight<->weight and volume<->volume convert by themselves.
    function needsConversion(){
      const ing = currentIngredient(); if(!ing) return false;
      const pu = unitSel.value, bu = ing.base_unit;
      if(pu === bu) return false;
      const fam = unitFamily(bu);
      if(fam === 'weight' && pu in WEIGHT_UNITS) return false;
      if(fam === 'volume' && pu in VOLUME_UNITS) return false;
      return true;
    }
    function updateConvVisibility(){
      const ing = currentIngredient();
      if(needsConversion()){
        convRow.style.display = 'block';
        root.querySelector('#p-conv-hint').textContent = `How many ${ing.base_unit} are in one ${unitSel.value}? (e.g. a box of 100 cups → 100)`;
      } else convRow.style.display = 'none';
      updatePreview();
    }
    function updatePreview(){
      const ing = currentIngredient(); if(!ing){ preview.textContent = 'Select an ingredient.'; return; }
      const qty = num(qtyInput.value), price = num(priceInput.value), conv = num(convInput.value);
      if(qty <= 0 || price <= 0){ preview.textContent = 'Enter quantity and price to see the cost per base unit.'; return; }
      const baseQty = toBaseQuantity(qty, unitSel.value, ing.base_unit, conv);
      if(baseQty <= 0){ preview.textContent = 'Enter the base-unit conversion above to work out the cost.'; return; }
      preview.textContent = `${fmtNum(qty, 2)} ${unitSel.value} → ${fmtNum(baseQty, 2)} ${ing.base_unit} in total. Cost = ${fmtMoney(price / baseQty)} per ${ing.base_unit}.`;
    }
    const setDefaultUnit = () => { const ing = currentIngredient(); if(ing){ unitSel.value = ing.base_unit; const s = ing.supplier_id; if(s) root.querySelector('#p-sup').value = s; } };
    const fillBrands = () => fillBrandSelect(root.querySelector('#p-brand'), root.querySelector('#p-brand-hint'), ingSel.value, 'this purchase');
    setDefaultUnit(); fillBrands();
    ingSel.onchange = () => { setDefaultUnit(); fillBrands(); updateConvVisibility(); };
    unitSel.onchange = updateConvVisibility;
    qtyInput.oninput = updatePreview; priceInput.oninput = updatePreview; convInput.oninput = updatePreview;
    updateConvVisibility();
    const save = root.querySelector('#btn-save-pur');
    save.onclick = () => busy(save, async () => {
      const ing = currentIngredient();
      const qty = num(qtyInput.value), price = num(priceInput.value), conv = num(convInput.value);
      if(!ing){ toast('Select an ingredient', 'error'); return; }
      if(qty <= 0){ toast('Enter a valid quantity', 'error'); return; }
      if(price <= 0){ toast('Enter a valid total price', 'error'); return; }
      if(needsConversion() && conv <= 0){ toast('Enter the base-unit conversion for this purchase unit', 'error'); return; }
      const baseQty = toBaseQuantity(qty, unitSel.value, ing.base_unit, conv);
      if(baseQty <= 0){ toast('Could not work out the base quantity — check the units', 'error'); return; }
      const now = nowISO();
      const purchase = {
        id: uid(), ingredient_id: ing.id, supplier_id: root.querySelector('#p-sup').value || null,
        purchase_date: root.querySelector('#p-date').value || shopTodayKey(),
        invoice_number: root.querySelector('#p-invoice').value.trim(),
        quantity: qty, purchase_unit: unitSel.value, base_quantity: baseQty,
        total_price: price, price_per_base_unit: price / baseQty,
        brand_id: root.querySelector('#p-brand').value || null,
        notes: root.querySelector('#p-notes').value, created_at: now,
      };
      const ok = await boSave([
        Ops.upsert('purchases', purchase),
        Ops.upsert('inventory_transactions', {id: uid(), ingredient_id: ing.id, transaction_type: 'PURCHASE', quantity: baseQty, reference_id: purchase.id,
          transaction_date: purchase.purchase_date, notes: `Purchase${purchase.invoice_number ? ' #' + purchase.invoice_number : ''}`, created_at: now}),
        Ops.audit('Purchase recorded', `${ing.name}${purchase.brand_id ? ' (' + brandName(purchase.brand_id) + ')' : ''} — ${fmtNum(qty, 2)} ${unitSel.value} for ${fmtMoney(price)}`, purchase.id),
      ], {success: 'Purchase recorded — costs updated'});
      if(ok){ closeModal(); if(state.route === 'ingredientDetail') navigate('ingredientDetail', ing.id); else rerender(); }
    });
  }});
}

/* ================= Production ================= */
const prodFilter = {search: '', recipe: '', type: ''};
function renderProduction(){
  setTopbarActions(`<button class="btn btn-primary" id="btn-new-production">+ New production</button>`)
    .querySelector('#btn-new-production').onclick = () => openProductionForm();
  const content = document.getElementById('content');
  const today = shopTodayKey();
  const weekStart = keyAddDays(today, -6), monthStart = keyMonthStart(today);
  const batches = state.productionBatches;
  const d = (b) => dayValue(b.production_date);
  const todays = batches.filter(b => d(b) === today);
  const thisWeek = batches.filter(b => d(b) >= weekStart);
  const thisMonth = batches.filter(b => d(b) >= monthStart);
  const costThisMonth = thisMonth.reduce((s, b) => s + num(b.raw_cost_total), 0);
  const wasteThisMonth = thisMonth.reduce((s, b) => s + Math.max(0, num(b.expected_yield) - num(b.actual_yield)) * num(b.actual_cost_per_unit), 0);
  const producedItems = producedIngredientsList().sort(byName);
  content.innerHTML = `
    <div class="grid grid-4">
      ${statCard('Production today', todays.length, `${thisWeek.length} this week`)}
      ${statCard('Production this month', thisMonth.length, `${batches.length} all-time`)}
      ${statCard('Production cost this month', fmtMoney(costThisMonth), '')}
      ${statCard('Production waste this month', fmtMoney(wasteThisMonth), 'yield loss, at cost')}
    </div>
    <div class="section-title">Production inventory</div>
    ${producedItems.length ? `<div class="grid grid-4">${producedItems.map(i => {
      const stock = ingredientStock(i.id);
      return `<div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;"><a class="linklike" data-ing="${esc(i.id)}">${esc(i.name)}</a>${statusBadge(stockStatus(stock, i.reorder_level))}</div>
        <div style="font-size:22px;font-weight:650;margin-top:6px;">${fmtNum(stock, 2)} ${esc(i.base_unit)}</div>
        <button class="btn btn-sm btn-amber" style="margin-top:8px;" data-produce-recipe="${esc(i.source_recipe_id || '')}">+ Produce</button>
      </div>`;
    }).join('')}</div>` : emptyBlock('No production recipes yet. Mark a recipe (e.g. a sauce or syrup) as "produces an inventory item" to get started.')}
    <div class="toolbar" style="margin-top:28px;">
      <div class="toolbar-left">
        <div class="search-box"><input type="text" placeholder="Search batch # or product…" id="prod-search" value="${esc(prodFilter.search)}" aria-label="Search production"></div>
        <select class="filter" id="prod-recipe-filter" aria-label="Product"><option value="">All products</option>${selectOptions(productionRecipesList().sort(byName), prodFilter.recipe)}</select>
        <select class="filter" id="prod-type-filter" aria-label="Recipe type"><option value="">All types</option>${RECIPE_TYPES.map(t => `<option value="${t.id}" ${prodFilter.type === t.id ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}</select>
      </div>
      <div class="text-light" style="font-size:13px;">${plural(batches.length, 'production record')}</div>
    </div>
    <div id="prod-history-wrap"></div>`;
  content.querySelectorAll('[data-ing]').forEach(a => a.onclick = () => navigate('ingredientDetail', a.dataset.ing));
  content.querySelectorAll('[data-produce-recipe]').forEach(b => b.onclick = () => openProductionForm(b.dataset.produceRecipe || null));
  document.getElementById('prod-search').oninput = e => { prodFilter.search = e.target.value; renderProductionHistory(); };
  document.getElementById('prod-recipe-filter').onchange = e => { prodFilter.recipe = e.target.value; renderProductionHistory(); };
  document.getElementById('prod-type-filter').onchange = e => { prodFilter.type = e.target.value; renderProductionHistory(); };
  renderProductionHistory();
}
function renderProductionHistory(){
  const wrap = document.getElementById('prod-history-wrap');
  if(!wrap) return;
  let list = state.productionBatches.slice();
  if(prodFilter.recipe) list = list.filter(b => b.recipe_id === prodFilter.recipe);
  if(prodFilter.type) list = list.filter(b => { const r = state.recipes.find(x => x.id === b.recipe_id); return r && recipeTypeOf(r) === prodFilter.type; });
  if(prodFilter.search){
    const q = prodFilter.search.toLowerCase();
    list = list.filter(b => (b.batch_number || '').toLowerCase().includes(q) || ingName(b.produced_ingredient_id).toLowerCase().includes(q));
  }
  list.sort((a, b) => String(b.production_date).localeCompare(String(a.production_date)) || String(b.created_at).localeCompare(String(a.created_at)));
  if(!list.length){ wrap.innerHTML = emptyBlock('No production records found.'); return; }
  wrap.innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>Date</th><th>Batch #</th><th>Product</th><th>Recipe type</th><th class="num">Qty produced</th><th>Unit</th><th class="num">Production cost</th><th class="num">Cost/unit</th><th>Status</th></tr></thead>
    <tbody>${list.map(b => {
      const recipe = state.recipes.find(r => r.id === b.recipe_id);
      const shortfall = num(b.expected_yield) - num(b.actual_yield);
      const status = shortfall > 0.0001 ? `<span class="badge badge-yellow">Short ${fmtNum(shortfall, 1)} ${esc(b.yield_unit || '')}</span>` : '<span class="badge badge-green">On target</span>';
      return `<tr><td>${fmtDay(b.production_date)}</td><td>${esc(b.batch_number || '—')}</td>
        <td><a class="linklike" data-ing="${esc(b.produced_ingredient_id)}">${esc(ingName(b.produced_ingredient_id))}</a></td>
        <td>${recipe ? esc(recipeTypeLabel(recipeTypeOf(recipe))) : '—'}</td>
        <td class="num">${fmtNum(b.actual_yield, 2)}</td><td>${esc(b.yield_unit || '')}</td>
        <td class="num">${fmtMoney(b.raw_cost_total)}</td><td class="num mono">${fmtMoney(b.actual_cost_per_unit)}</td><td>${status}</td></tr>`;
    }).join('')}</tbody></table></div>`;
  wrap.querySelectorAll('[data-ing]').forEach(a => a.onclick = () => navigate('ingredientDetail', a.dataset.ing));
}
function nextBatchNumber(recipe){
  const prefix = (recipe.name || 'BATCH').split(/\s+/).map(w => w[0] || '').join('').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4) || 'BATCH';
  const datePart = shopTodayKey().replace(/-/g, '');
  const todaysCount = state.productionBatches.filter(b => b.recipe_id === recipe.id && b.batch_number && b.batch_number.includes(datePart)).length;
  return `${prefix}-${datePart}-${String(todaysCount + 1).padStart(3, '0')}`;
}
function openProductionForm(prefillRecipeId){
  const recipes = productionRecipesList().sort(byName);
  if(!recipes.length){ toast('No production recipes yet — mark a recipe as "produces an inventory item" first.', 'warn'); return; }
  const body = `
    <div class="form-row"><label for="pr-recipe">Product / recipe</label><select id="pr-recipe">${recipes.map(r => `<option value="${esc(r.id)}" ${prefillRecipeId === r.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></div>
    <div class="form-grid">
      <div class="form-row"><label for="pr-date">Production date</label><input type="date" id="pr-date" value="${shopTodayKey()}"></div>
      <div class="form-row"><label for="pr-batch">Batch number</label><input id="pr-batch" maxlength="40"></div>
    </div>
    <div class="form-grid">
      <div class="form-row"><label for="pr-expected">Expected yield</label>${qtyWithUnitHtml('pr-expected', 'pr-expected-unit', '', 'min="0"', 'Expected yield unit')}<div class="hint" id="pr-yield-unit-hint"></div></div>
      <div class="form-row"><label for="pr-actual">Actual yield</label>${qtyWithUnitHtml('pr-actual', 'pr-actual-unit', '', 'min="0" placeholder="What you actually got"', 'Actual yield unit')}<div class="hint" id="pr-actual-hint"></div></div>
    </div>
    <div class="form-row" id="pr-waste-row" style="display:none;"><label for="pr-waste-reason">Why less than expected?</label><select id="pr-waste-reason"><option>Evaporation</option><option>Spillage</option><option>Overcooking</option><option>Preparation loss</option><option>Other</option></select></div>
    <div class="form-row"><label for="pr-notes">Notes</label><textarea id="pr-notes" rows="2"></textarea></div>
    <div class="card soft-card">
      <div class="grid grid-2">
        <div><div class="text-light" style="font-size:11px;text-transform:uppercase;font-weight:700;">Estimated batch cost</div><div id="pr-est-cost" style="font-size:20px;font-weight:650;">—</div></div>
        <div><div class="text-light" style="font-size:11px;text-transform:uppercase;font-weight:700;">Estimated cost / unit</div><div id="pr-est-unit-cost" style="font-size:20px;font-weight:650;">—</div></div>
      </div>
      <div id="pr-uses" class="hint" style="margin-top:8px;"></div>
      <p class="hint mb-0">Ingredients are scaled from the recipe by expected yield ÷ the recipe's normal yield, then taken out of stock. Cost per unit uses the actual yield.</p>
    </div>`;
  const foot = `<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" id="btn-save-prod">Produce batch</button>`;
  openModal({title: 'New production', wide: true, body, foot, onMount: (root) => {
    root.querySelector('[data-cancel]').onclick = closeModal;
    const recipeSel = root.querySelector('#pr-recipe'), expectedInput = root.querySelector('#pr-expected');
    const actualInput = root.querySelector('#pr-actual'), batchInput = root.querySelector('#pr-batch');
    const expUnit = root.querySelector('#pr-expected-unit'), actUnit = root.querySelector('#pr-actual-unit');
    const currentRecipe = () => state.recipes.find(r => r.id === recipeSel.value);
    // Yields are typed in any unit of the recipe's yield unit family and saved in the recipe's yield unit
    // (= the produced item's base unit), like every other stored quantity.
    const yUnit = () => { const r = currentRecipe(); return (r && r.yield_unit) || ''; };
    const inYieldUnit = (input, sel) => { const v = typedToBase(input.value, sel.value, yUnit()); return v == null ? 0 : v; };
    function loadDefaults(){
      const recipe = currentRecipe(); if(!recipe) return;
      resetUnitSelect(expUnit, yUnit()); expUnit.value = yUnit(); expUnit.dataset.prev = expUnit.value;
      resetUnitSelect(actUnit, yUnit()); actUnit.value = yUnit(); actUnit.dataset.prev = actUnit.value;
      expUnit.style.display = actUnit.style.display = compatibleUnits(yUnit()).length > 1 ? '' : 'none';
      expectedInput.value = recipe.expected_yield || ''; markFilled(expectedInput);
      root.querySelector('#pr-yield-unit-hint').textContent = `Unit: ${recipe.yield_unit || '—'} (recipe normal yield: ${fmtNum(recipe.expected_yield, 0)} ${recipe.yield_unit || ''})`;
      batchInput.value = nextBatchNumber(recipe);
      updatePreview();
    }
    function updatePreview(){
      const recipe = currentRecipe(); if(!recipe) return;
      const expected = inYieldUnit(expectedInput, expUnit), actual = inYieldUnit(actualInput, actUnit), baseYield = num(recipe.expected_yield);
      const multiplier = baseYield > 0 ? expected / baseYield : 0;
      const yu = yUnit();
      root.querySelector('#pr-actual-hint').textContent = [expUnit.value !== yu && expected > 0 ? `Expected: ${formatQuantity(expected, yu, yu)}` : '',
        actUnit.value !== yu && actual > 0 ? `Actual: ${formatQuantity(actual, yu, yu)}` : ''].filter(Boolean).join(' · ');
      const rc = recipeCost(recipe.id);
      const estCost = rc.total * multiplier;
      root.querySelector('#pr-est-cost').textContent = expected > 0 ? fmtMoney(estCost) : '—';
      root.querySelector('#pr-est-unit-cost').textContent = actual > 0 ? fmtMoney(estCost / actual) + '/' + unitLabel(recipe.yield_unit || '') : '—';
      root.querySelector('#pr-waste-row').style.display = (expected > 0 && actual > 0 && actual < expected) ? 'block' : 'none';
      const short = rc.lines.filter(l => num(l.quantity) * multiplier > ingredientStock(l.ingredient_id) + 1e-9);
      root.querySelector('#pr-uses').innerHTML = multiplier > 0 ? 'Uses: ' + rc.lines.map(l => `${esc(ingName(l.ingredient_id))} ${fmtNum(num(l.quantity) * multiplier, 2)} ${esc((ingredientById(l.ingredient_id) || {}).base_unit || '')}`).join(' · ')
        + (short.length ? `<br><span class="text-red">Not enough stock recorded for: ${short.map(l => esc(ingName(l.ingredient_id))).join(', ')} (it will go below zero).</span>` : '') : '';
    }
    recipeSel.onchange = loadDefaults;
    expectedInput.oninput = updatePreview; actualInput.oninput = updatePreview;
    wireUnitConvert(expectedInput, expUnit, updatePreview); wireUnitConvert(actualInput, actUnit, updatePreview);
    loadDefaults();
    const save = root.querySelector('#btn-save-prod');
    save.onclick = () => busy(save, async () => {
      const recipe = currentRecipe();
      if(!recipe){ toast('Select a product / recipe', 'error'); return; }
      const producedIng = ingredientById(recipe.produced_ingredient_id);
      if(!producedIng){ toast('This recipe is not linked to an inventory item — edit the recipe first.', 'error'); return; }
      const baseYield = num(recipe.expected_yield), expected = inYieldUnit(expectedInput, expUnit), actual = inYieldUnit(actualInput, actUnit);
      if(baseYield <= 0){ toast('This recipe has no expected yield — edit the recipe first.', 'error'); return; }
      if(expected <= 0){ toast('Enter an expected yield for this batch', 'error'); return; }
      if(actual <= 0){ toast('Enter the actual yield produced', 'error'); return; }
      const multiplier = expected / baseYield;
      const rc = recipeCost(recipe.id);               // today's live ingredient costs, locked into this batch
      const rawCostTotal = rc.total * multiplier;
      const now = nowISO();
      const prodDate = root.querySelector('#pr-date').value || shopTodayKey();
      const batch = {
        id: uid(), recipe_id: recipe.id, produced_ingredient_id: producedIng.id,
        batch_number: batchInput.value.trim() || nextBatchNumber(recipe),
        production_date: prodDate, expected_yield: expected, actual_yield: actual, yield_unit: recipe.yield_unit,
        raw_cost_total: rawCostTotal, actual_cost_per_unit: rawCostTotal / actual,
        waste_reason: actual < expected ? (root.querySelector('#pr-waste-reason').value || '') : '',
        notes: root.querySelector('#pr-notes').value, created_at: now,
      };
      const ops = [Ops.upsert('production_batches', batch)];
      rc.lines.forEach(line => {
        const usedQty = num(line.quantity) * multiplier;
        if(usedQty <= 0) return;
        ops.push(Ops.upsert('inventory_transactions', {id: uid(), ingredient_id: line.ingredient_id, transaction_type: 'PRODUCTION_USE', quantity: usedQty,
          reference_id: batch.id, transaction_date: prodDate, notes: `Used in production batch ${batch.batch_number} (${recipe.name})`, created_at: now}));
      });
      // stock is in the produced item's base unit (normally the same as the recipe's yield unit)
      const producedQty = producedIng.base_unit && recipe.yield_unit && producedIng.base_unit !== recipe.yield_unit
        ? (convertQuantity(actual, recipe.yield_unit, producedIng.base_unit) ?? actual) : actual;
      ops.push(Ops.upsert('inventory_transactions', {id: uid(), ingredient_id: producedIng.id, transaction_type: 'PRODUCTION', quantity: producedQty,
        reference_id: batch.id, transaction_date: prodDate, notes: `Batch ${batch.batch_number}`, created_at: now}));
      const actualText = typedQtyText(actual, recipe.yield_unit || '', actUnit.value);
      ops.push(Ops.audit('Batch produced', `${batch.batch_number}: ${actualText} of ${producedIng.name}`, batch.id));
      if(await boSave(ops, {success: `Produced ${actualText} of ${producedIng.name} — stock updated`})){
        closeModal();
        if(state.route === 'production') rerender(); else navigate('production');
      }
    }, 'Producing…');
  }});
}

/* ================= Inventory (waste, adjustments) ================= */
const invFilter = {type: '', status: ''};
function renderInventory(){
  const bar = setTopbarActions(`<button class="btn btn-outline" id="btn-new-waste">Record waste</button> <button class="btn btn-primary" id="btn-new-adjustment">Adjust stock</button>`);
  bar.querySelector('#btn-new-waste').onclick = () => openWasteForm();
  bar.querySelector('#btn-new-adjustment').onclick = () => openAdjustmentForm();
  const content = document.getElementById('content');
  const allActive = state.ingredients.filter(i => i.active !== false);
  const totalValue = allActive.reduce((s, i) => s + ingredientStock(i.id) * (ingredientCosting(i.id).current || 0), 0);
  const recentWaste = state.waste.slice().sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.created_at || '').localeCompare(String(a.created_at || ''))).slice(0, 15);
  content.innerHTML = `
    <div class="grid grid-3" style="margin-bottom:18px;">
      ${statCard('Total inventory value', fmtMoney(totalValue), '')}
      ${statCard('Low stock items', allActive.filter(i => stockStatus(ingredientStock(i.id), i.reorder_level) === 'LOW').length, '')}
      ${statCard('Out of stock items', allActive.filter(i => stockStatus(ingredientStock(i.id), i.reorder_level) === 'OUT').length, '')}
    </div>
    <div class="toolbar"><div class="toolbar-left">
      <select class="filter" id="inv-type-filter" aria-label="Type"><option value="">All</option><option value="RAW" ${invFilter.type === 'RAW' ? 'selected' : ''}>Raw ingredients</option><option value="PRODUCED" ${invFilter.type === 'PRODUCED' ? 'selected' : ''}>Produced items</option></select>
      <select class="filter" id="inv-status-filter" aria-label="Stock status"><option value="">All stock levels</option><option value="LOW" ${invFilter.status === 'LOW' ? 'selected' : ''}>Low stock</option><option value="OUT" ${invFilter.status === 'OUT' ? 'selected' : ''}>Out of stock</option></select>
    </div></div>
    <div id="inv-table-wrap"></div>
    <div class="section-title">Recent waste</div>
    ${recentWaste.length ? `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Ingredient</th><th class="num">Quantity</th><th>Reason</th><th class="num">Waste cost</th><th>Notes</th></tr></thead><tbody>
      ${recentWaste.map(w => `<tr><td>${fmtDay(w.date)}</td><td>${esc(ingName(w.ingredient_id))}</td><td class="num">${esc(wasteQtyText(w))}</td><td>${esc(w.reason || '')}</td><td class="num">${fmtMoney(num(w.quantity) * (ingredientCosting(w.ingredient_id).current || 0))}</td><td class="text-light">${esc(w.notes || '')}</td></tr>`).join('')}
    </tbody></table></div>` : emptyBlock('No waste recorded.')}`;
  document.getElementById('inv-type-filter').onchange = e => { invFilter.type = e.target.value; renderInventoryTable(); };
  document.getElementById('inv-status-filter').onchange = e => { invFilter.status = e.target.value; renderInventoryTable(); };
  renderInventoryTable();
}
function renderInventoryTable(){
  const wrap = document.getElementById('inv-table-wrap');
  if(!wrap) return;
  let list = state.ingredients.filter(i => i.active !== false);
  if(invFilter.type === 'RAW') list = list.filter(i => !isProducedItem(i));
  if(invFilter.type === 'PRODUCED') list = list.filter(i => isProducedItem(i));
  if(invFilter.status) list = list.filter(i => stockStatus(ingredientStock(i.id), i.reorder_level) === invFilter.status);
  list.sort(byName);
  if(!list.length){ wrap.innerHTML = emptyBlock('No inventory items match this filter.'); return; }
  wrap.innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>Ingredient</th><th>Type</th><th class="num">Current stock</th><th>Unit</th><th class="num">Current unit cost</th><th class="num">Inventory value</th><th class="num">Reorder level</th><th>Status</th><th></th></tr></thead>
    <tbody>${list.map(i => {
      const stock = ingredientStock(i.id), cost = ingredientCosting(i.id).current || 0, produced = isProducedItem(i);
      return `<tr class="clickable" data-id="${esc(i.id)}">
        <td><b>${esc(i.name)}</b></td>
        <td>${produced ? '<span class="badge badge-gray">Produced</span>' : '<span class="badge badge-gray" style="opacity:.6;">Raw</span>'}</td>
        <td class="num">${fmtNum(stock, 2)}</td><td>${esc(i.base_unit)}</td>
        <td class="num">${fmtMoney(cost)}</td><td class="num"><b>${fmtMoney(stock * cost)}</b></td>
        <td class="num">${fmtNum(i.reorder_level, 1)}</td><td>${statusBadge(stockStatus(stock, i.reorder_level))}</td>
        <td class="row-actions"><button class="btn btn-sm btn-ghost" data-adjust="${esc(i.id)}">Adjust</button>${produced ? `<button class="btn btn-sm btn-amber" data-produce="${esc(i.id)}">+ Produce</button>` : ''}</td>
      </tr>`;
    }).join('')}</tbody></table></div>`;
  wrap.querySelectorAll('tr[data-id]').forEach(tr => tr.onclick = (e) => { if(e.target.closest('button')) return; navigate('ingredientDetail', tr.dataset.id); });
  wrap.querySelectorAll('[data-produce]').forEach(b => b.onclick = (e) => { e.stopPropagation(); openProductionForm((sourceRecipeForIngredient(ingredientById(b.dataset.produce)) || {}).id); });
  wrap.querySelectorAll('[data-adjust]').forEach(b => b.onclick = (e) => { e.stopPropagation(); openAdjustmentForm(b.dataset.adjust); });
}
// waste.quantity is in the ingredient's base unit; waste.unit is the unit the owner typed (shown back in it)
function wasteQtyText(w){
  const ing = ingredientById(w.ingredient_id);
  return ing && ing.base_unit ? formatQuantity(w.quantity, ing.base_unit, w.unit || ing.base_unit) : `${fmtNum(w.quantity, 2)} ${unitLabel(w.unit || '')}`.trim();
}
function openWasteForm(prefillId){
  const list = activeIngredientsSorted();
  if(!list.length){ toast('Add an ingredient first', 'warn'); return; }
  const body = `
    <div class="form-row"><label for="w-ing">Ingredient</label><select id="w-ing">${list.map(i => `<option value="${esc(i.id)}" ${prefillId === i.id ? 'selected' : ''}>${esc(i.name)} (${esc(i.base_unit)})</option>`).join('')}</select></div>
    <div class="form-grid">
      <div class="form-row"><label for="w-qty">Quantity wasted</label>${qtyWithUnitHtml('w-qty', 'w-unit', (ingredientById(prefillId) || list[0]).base_unit, 'min="0" placeholder="0"', 'Waste unit')}<div class="hint" id="w-stock"></div></div>
      <div class="form-row"><label for="w-date">Date</label><input type="date" id="w-date" value="${shopTodayKey()}"></div>
    </div>
    <div class="form-row"><label for="w-reason">Reason</label><select id="w-reason"><option>Expired</option><option>Spillage</option><option>Over-portioned</option><option>Spoiled</option><option>Prep error</option><option>Other</option></select></div>
    <div class="form-row"><label for="w-notes">Notes</label><textarea id="w-notes" rows="2"></textarea></div>`;
  openModal({title: 'Record waste', body, foot: `<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-amber" id="btn-save-waste">Record waste</button>`, onMount: (root) => {
    root.querySelector('[data-cancel]').onclick = closeModal;
    const wQty = root.querySelector('#w-qty'), wUnit = root.querySelector('#w-unit');
    const showStock = () => {
      const i = ingredientById(root.querySelector('#w-ing').value);
      if(!i){ root.querySelector('#w-stock').textContent = ''; return; }
      const q = typedToBase(wQty.value, wUnit.value, i.base_unit);
      root.querySelector('#w-stock').textContent = `In stock now: ${formatQuantity(ingredientStock(i.id), i.base_unit, wUnit.value)}`
        + (wUnit.value !== i.base_unit && q > 0 ? ` · takes off ${formatQuantity(q, i.base_unit, i.base_unit)}` : '');
    };
    root.querySelector('#w-ing').onchange = () => { const i = ingredientById(root.querySelector('#w-ing').value); if(i) resetUnitSelect(wUnit, i.base_unit); showStock(); };
    wireUnitConvert(wQty, wUnit, showStock); wQty.addEventListener('input', showStock);
    resetUnitSelect(wUnit, (ingredientById(root.querySelector('#w-ing').value) || {}).base_unit); showStock();
    const save = root.querySelector('#btn-save-waste');
    save.onclick = () => busy(save, async () => {
      const ing = ingredientById(root.querySelector('#w-ing').value);
      if(!ing){ toast('Choose an ingredient', 'error'); return; }
      const typedUnit = compatibleUnits(ing.base_unit).includes(wUnit.value) ? wUnit.value : ing.base_unit;
      const qty = typedToBase(wQty.value, typedUnit, ing.base_unit);       // saved in the base unit
      if(!(qty > 0)){ toast('Enter a valid quantity', 'error'); return; }
      const date = root.querySelector('#w-date').value || shopTodayKey();
      const reason = root.querySelector('#w-reason').value, notes = root.querySelector('#w-notes').value, now = nowISO();
      const rec = {id: uid(), ingredient_id: ing.id, quantity: qty, unit: typedUnit, reason, date, notes, created_at: now};
      if(await boSave([
        Ops.upsert('waste', rec),
        Ops.upsert('inventory_transactions', {id: uid(), ingredient_id: ing.id, transaction_type: 'WASTE', quantity: qty, reference_id: rec.id, transaction_date: date, notes: reason + (notes ? ' — ' + notes : ''), created_at: now}),
        Ops.audit('Waste recorded', `${ing.name} — ${typedQtyText(qty, ing.base_unit, typedUnit)} (${reason})`, rec.id),
      ], {success: 'Waste recorded'})){ closeModal(); rerender(); }
    });
  }});
}
function openAdjustmentForm(prefillId){
  const list = activeIngredientsSorted();
  if(!list.length){ toast('Add an ingredient first', 'warn'); return; }
  const body = `
    <div class="form-row"><label for="a-ing">Ingredient</label><select id="a-ing">${list.map(i => `<option value="${esc(i.id)}" ${prefillId === i.id ? 'selected' : ''}>${esc(i.name)} (${esc(i.base_unit)})</option>`).join('')}</select><div class="hint" id="a-stock"></div></div>
    <div class="seg" style="margin-bottom:12px;"><button class="seg-btn active" type="button" data-mode="delta">Add or take off an amount</button><button class="seg-btn" type="button" data-mode="count">I counted it</button></div>
    <div class="form-row" id="a-delta-row"><label for="a-qty">Adjustment amount (use a minus to reduce, e.g. -50)</label>${qtyWithUnitHtml('a-qty', 'a-qty-unit', (ingredientById(prefillId) || list[0]).base_unit, 'placeholder="e.g. -50 or 20"', 'Adjustment unit')}<div class="hint" id="a-qty-hint"></div></div>
    <div class="form-row" id="a-count-row" style="display:none;"><label for="a-count">Amount counted on the shelf</label>${qtyWithUnitHtml('a-count', 'a-count-unit', (ingredientById(prefillId) || list[0]).base_unit, 'min="0"', 'Counted unit')}<div class="hint" id="a-count-hint"></div></div>
    <div class="form-row" id="a-brand-row" style="display:none;"><label for="a-brand">Brand of the stock added (optional)</label><select id="a-brand"></select><div class="hint" id="a-brand-hint"></div></div>
    <div class="form-row"><label for="a-date">Date</label><input type="date" id="a-date" value="${shopTodayKey()}"></div>
    <div class="form-row"><label for="a-notes">Reason / notes</label><textarea id="a-notes" rows="2" placeholder="e.g. Physical stock count correction"></textarea></div>`;
  openModal({title: 'Adjust stock', body, foot: `<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" id="btn-save-adj">Save adjustment</button>`, onMount: (root) => {
    root.querySelector('[data-cancel]').onclick = closeModal;
    let mode = 'delta';
    const cur = () => ingredientById(root.querySelector('#a-ing').value);
    const qIn = root.querySelector('#a-qty'), qUnit = root.querySelector('#a-qty-unit');
    const cIn = root.querySelector('#a-count'), cUnit = root.querySelector('#a-count-unit');
    const signed = (q, bu, unit) => (q >= 0 ? '+' : '−') + formatQuantity(Math.abs(q), bu, unit);
    const countDelta = (i) => { const c = typedToBase(cIn.value, cUnit.value, i.base_unit); return c == null ? null : Math.round((c - ingredientStock(i.id)) * 1e6) / 1e6; };
    const refresh = () => {
      const i = cur();
      root.querySelector('#a-stock').textContent = i ? `In stock now: ${formatQuantity(ingredientStock(i.id), i.base_unit, mode === 'count' ? cUnit.value : qUnit.value)}` : '';
      const d = i && cIn.value !== '' ? countDelta(i) : null;
      root.querySelector('#a-count-hint').textContent = d != null ? `Change: ${signed(d, i.base_unit, i.base_unit)}${cUnit.value !== i.base_unit ? ' (' + signed(d, i.base_unit, cUnit.value) + ')' : ''}` : '';
      const q = i && qIn.value !== '' ? typedToBase(qIn.value, qUnit.value, i.base_unit) : null;
      root.querySelector('#a-qty-hint').textContent = q && qUnit.value !== i.base_unit ? `Change: ${signed(q, i.base_unit, i.base_unit)}` : '';
      // a brand can only be named on stock that is ADDED (the database: BRAND_NOT_ALLOWED otherwise)
      const adds = mode === 'count' ? (d != null && d > 0) : (q != null && q > 0);
      root.querySelector('#a-brand-row').style.display = adds && i && brandsFor(i.id).length ? 'block' : 'none';
    };
    const fillAdjBrands = () => fillBrandSelect(root.querySelector('#a-brand'), root.querySelector('#a-brand-hint'), root.querySelector('#a-ing').value, 'the stock added');
    fillAdjBrands();
    root.querySelector('#a-ing').onchange = () => { const i = cur(); if(i){ resetUnitSelect(qUnit, i.base_unit); resetUnitSelect(cUnit, i.base_unit); } fillAdjBrands(); refresh(); };
    cIn.oninput = refresh; qIn.oninput = refresh;
    wireUnitConvert(qIn, qUnit, refresh); wireUnitConvert(cIn, cUnit, refresh);
    { const i = cur(); if(i){ resetUnitSelect(qUnit, i.base_unit); resetUnitSelect(cUnit, i.base_unit); } }
    refresh();
    root.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => {
      mode = b.dataset.mode;
      root.querySelectorAll('[data-mode]').forEach(x => x.classList.toggle('active', x === b));
      root.querySelector('#a-delta-row').style.display = mode === 'delta' ? 'block' : 'none';
      root.querySelector('#a-count-row').style.display = mode === 'count' ? 'block' : 'none';
      refresh();
    });
    const save = root.querySelector('#btn-save-adj');
    save.onclick = () => busy(save, async () => {
      const ing = cur();
      if(!ing){ toast('Choose an ingredient', 'error'); return; }
      let qty;                                   // always saved in the base unit
      const typedUnit = mode === 'count' ? cUnit.value : qUnit.value;
      if(mode === 'count'){
        if(cIn.value === ''){ toast('Enter the amount you counted', 'error'); return; }
        qty = countDelta(ing);
      } else qty = typedToBase(qIn.value, qUnit.value, ing.base_unit);
      if(qty == null){ toast('Choose the unit again — it does not fit this ingredient', 'error'); return; }
      if(!qty){ toast(mode === 'count' ? 'The count matches the stock — nothing to change' : 'Enter an amount that is not zero', mode === 'count' ? 'warn' : 'error'); return; }
      const notes = root.querySelector('#a-notes').value.trim() || (mode === 'count' ? 'Stock count' : '');
      const id = uid();
      const brandId = qty > 0 && root.querySelector('#a-brand-row').style.display !== 'none' ? (root.querySelector('#a-brand').value || null) : null;
      if(await boSave([
        Ops.upsert('inventory_transactions', {id, ingredient_id: ing.id, transaction_type: 'ADJUSTMENT', quantity: qty, reference_id: null, transaction_date: root.querySelector('#a-date').value || shopTodayKey(), brand_id: brandId, notes, created_at: nowISO()}),
        Ops.audit('Stock adjusted', `${ing.name}${brandId ? ' (' + brandName(brandId) + ')' : ''} ${qty > 0 ? '+' : '-'}${typedQtyText(Math.abs(qty), ing.base_unit, typedUnit)}${mode === 'count' ? ` (counted ${formatQuantity(typedToBase(cIn.value, cUnit.value, ing.base_unit), ing.base_unit, cUnit.value)})` : ''}${notes ? ' — ' + notes : ''}`, id),
      ], {success: 'Stock adjusted'})){ closeModal(); rerender(); }
    });
  }});
}

/* ================= Costing ================= */
let costingSort = 'name', costingTypeFilter = '';
function renderCosting(){
  const content = document.getElementById('content');
  content.innerHTML = `
    <div class="toolbar">
      <div class="toolbar-left">
        <select class="filter" id="cost-type-filter" aria-label="Recipe type"><option value="">All recipe types</option>${RECIPE_TYPES.map(t => `<option value="${t.id}" ${costingTypeFilter === t.id ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}</select>
        <select class="filter" id="cost-sort" aria-label="Sort">
          ${[['name','Sort: recipe name'],['costHigh','Sort: highest cost'],['costLow','Sort: lowest cost'],['fcpHigh','Sort: highest food cost %'],['profitHigh','Sort: highest gross profit'],['profitLow','Sort: lowest gross profit']].map(([v, l]) => `<option value="${v}" ${costingSort === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </div>
      <div class="text-light" style="font-size:13px;">Costing method: <b>${costingMethod() === 'latest' ? 'Latest purchase cost' : 'Weighted average cost'}</b> (change it in <a class="linklike" id="go-settings">Settings</a>)</div>
    </div>
    <div id="costing-table-wrap"></div>`;
  document.getElementById('cost-sort').onchange = e => { costingSort = e.target.value; renderCostingTable(); };
  document.getElementById('cost-type-filter').onchange = e => { costingTypeFilter = e.target.value; renderCostingTable(); };
  document.getElementById('go-settings').onclick = () => navigate('settings');
  renderCostingTable();
}
function renderCostingTable(){
  const wrap = document.getElementById('costing-table-wrap');
  if(!wrap) return;
  let list = state.recipes.filter(r => r.active !== false);
  if(costingTypeFilter) list = list.filter(r => recipeTypeOf(r) === costingTypeFilter);
  list = list.map(r => Object.assign({recipe: r}, recipeMetrics(r)));
  const sorters = {
    name: (a, b) => byName(a.recipe, b.recipe), costHigh: (a, b) => b.cost - a.cost, costLow: (a, b) => a.cost - b.cost,
    fcpHigh: (a, b) => b.foodCostPct - a.foodCostPct, profitHigh: (a, b) => b.profit - a.profit, profitLow: (a, b) => a.profit - b.profit,
  };
  list.sort(sorters[costingSort] || sorters.name);
  if(!list.length){ wrap.innerHTML = emptyBlock('No recipes match this filter.'); return; }
  const warnPct = num(state.settings.food_cost_warning_pct) || 35;
  wrap.innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>Recipe</th><th>Type</th><th class="num">Selling price</th><th class="num">Recipe cost</th><th class="num">Gross profit</th><th class="num">Food cost %</th><th>Status</th></tr></thead>
    <tbody>${list.map(r => {
      const sells = num(r.recipe.selling_price) > 0, warn = sells && r.foodCostPct > warnPct;
      return `<tr class="clickable" data-id="${esc(r.recipe.id)}">
        <td><b>${esc(r.recipe.name)}</b></td><td>${esc(recipeTypeLabel(recipeTypeOf(r.recipe)))}</td>
        <td class="num">${sells ? fmtMoney(r.recipe.selling_price) : '—'}</td><td class="num">${fmtMoney(r.cost)}</td>
        <td class="num ${r.profit >= 0 ? 'text-green' : 'text-red'}">${sells ? fmtMoney(r.profit) : '—'}</td>
        <td class="num">${sells ? fmtNum(r.foodCostPct, 1) + '%' : '—'}</td>
        <td>${!sells ? '<span class="badge badge-gray">Not sold directly</span>' : (warn ? '<span class="badge badge-red">High</span>' : '<span class="badge badge-green">Healthy</span>')}</td></tr>`;
    }).join('')}</tbody></table></div>`;
  wrap.querySelectorAll('[data-id]').forEach(tr => tr.onclick = () => navigate('recipeDetail', tr.dataset.id));
}

/* ================= Suppliers ================= */
function renderSuppliers(){
  if(state.route !== 'suppliers') return;      // a save finished after the owner moved on
  setTopbarActions(`<button class="btn btn-primary" id="btn-new-supplier">+ Add supplier</button>`)
    .querySelector('#btn-new-supplier').onclick = () => openSupplierForm();
  const content = document.getElementById('content');
  const list = state.suppliers.slice().sort(byName);
  content.innerHTML = list.length ? `<div class="grid grid-3">${list.map(s => {
    const sp = state.purchases.filter(p => p.supplier_id === s.id);
    const total = sp.reduce((sum, p) => sum + num(p.total_price), 0);
    const avg = sp.length ? total / sp.length : 0;
    const ingCount = new Set(sp.map(p => p.ingredient_id)).size;
    return `<div class="card">
      <div style="display:flex;justify-content:space-between;gap:8px;"><b style="font-size:16px;">${esc(s.name)}</b><button class="btn btn-sm btn-ghost" data-edit="${esc(s.id)}">Edit</button></div>
      <div class="text-light" style="font-size:13px;margin:6px 0;">${esc(s.contact || '')}${s.phone ? ' · ' + esc(s.phone) : ''}${s.email ? ' · ' + esc(s.email) : ''}</div>
      <div style="margin-top:10px;font-size:13.5px;">
        <div>Total purchases: <b>${fmtMoney(total)}</b> (${plural(sp.length, 'order')})</div>
        <div>Average purchase: <b>${fmtMoney(avg)}</b></div>
        <div>Ingredients supplied: <b>${ingCount}</b></div>
      </div></div>`;
  }).join('')}</div>` : emptyBlock('No suppliers yet. Use "+ Add supplier".');
  content.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => openSupplierForm(b.dataset.edit));
}
function openSupplierForm(id){
  const editing = id ? state.suppliers.find(s => s.id === id) : null;
  const v = (k) => esc(editing ? (editing[k] || '') : '');
  const body = `
    <div class="form-row"><label for="s-name">Supplier name</label><input id="s-name" maxlength="80" value="${v('name')}"></div>
    <div class="form-grid">
      <div class="form-row"><label for="s-contact">Contact person</label><input id="s-contact" maxlength="80" value="${v('contact')}"></div>
      <div class="form-row"><label for="s-phone">Phone</label><input id="s-phone" maxlength="40" inputmode="tel" value="${v('phone')}"></div>
    </div>
    <div class="form-grid">
      <div class="form-row"><label for="s-email">Email</label><input id="s-email" type="email" maxlength="120" value="${v('email')}"></div>
      <div class="form-row"><label for="s-address">Address</label><input id="s-address" maxlength="200" value="${v('address')}"></div>
    </div>
    <div class="form-row"><label for="s-notes">Notes</label><textarea id="s-notes" rows="2">${v('notes')}</textarea></div>`;
  const foot = `${editing ? '<button class="btn btn-danger" id="s-delete" style="margin-right:auto;">Delete</button>' : ''}<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" id="s-save">${editing ? 'Save' : 'Add supplier'}</button>`;
  openModal({title: editing ? 'Edit supplier' : 'Add supplier', body, foot, onMount: (root) => {
    root.querySelector('[data-cancel]').onclick = closeModal;
    const del = root.querySelector('#s-delete');
    if(del) del.onclick = () => busy(del, async () => {
      if(state.purchases.some(p => p.supplier_id === editing.id)){ toast('This supplier has purchase history, so it cannot be deleted.', 'error'); return; }
      const usedBy = state.ingredients.filter(i => i.supplier_id === editing.id);
      if(usedBy.length){ toast(`${usedBy.length} ingredient(s) use this supplier as their default (e.g. ${usedBy[0].name}). Change that first.`, 'error'); return; }
      const ok = await confirmDialog(`Delete the supplier <b>${esc(editing.name)}</b>?`, 'Delete');
      if(ok && await boSave([Ops.del('suppliers', editing.id), Ops.audit('Supplier deleted', editing.name, editing.id)], {success: 'Supplier deleted'})){ closeModal(); renderSuppliers(); }
    }, 'Checking…');
    const save = root.querySelector('#s-save');
    save.onclick = () => busy(save, async () => {
      const name = root.querySelector('#s-name').value.trim();
      if(!name){ toast('Enter the supplier name', 'error'); return; }
      const row = {id: editing ? editing.id : uid(), name,
        contact: root.querySelector('#s-contact').value.trim(), phone: root.querySelector('#s-phone').value.trim(),
        email: root.querySelector('#s-email').value.trim(), address: root.querySelector('#s-address').value.trim(),
        notes: root.querySelector('#s-notes').value};
      if(await boSave([editing ? Ops.update('suppliers', row) : Ops.upsert('suppliers', row), Ops.audit(editing ? 'Supplier updated' : 'Supplier added', name, row.id)], {success: editing ? 'Supplier updated' : 'Supplier added'})){ closeModal(); renderSuppliers(); }
    });
  }});
}
