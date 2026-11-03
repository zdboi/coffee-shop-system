/* =====================================================================
   BACK OFFICE — release 1.4 (Wave 2)
     A9  Options library: shared option groups (Hot / Iced, take-away cup,
         extra shot, non-dairy milk swap...) applied to item types or
         sub-categories, with a per-item untick / tick-on.
     A8  Supplied items: food and pastries bought ready-made and resold
         per piece (one form: save_supplied_item).
   The DATABASE copies library groups into every recipe's modifier_groups
   (id 'lib_<group id>'); this file only writes option_groups and the
   per-item ticks (option_group_recipes, mode EXCLUDE / INCLUDE) through
   apply_changes, never library groups inside a recipe.
   Form checks use the shared optionGroupProblem(); margins use
   suppliedItemCosting() (../shared/logic.js).
   ===================================================================== */

const LIB_KIND_LABEL = {PLAIN: 'Price only', EXTRA: 'Uses stock', SWAP: 'Swap an ingredient'};
const LIB_MAX_EXTRAS = 5;

function libGroups(){
  return (state.optionGroups || []).slice().sort((a, b) => num(a.sort_order) - num(b.sort_order)
    || String(a.name || '').toLowerCase().localeCompare(String(b.name || '').toLowerCase()) || String(a.id).localeCompare(String(b.id)));
}
function libGroupById(id){ return (state.optionGroups || []).find(g => g.id === id) || null; }
function libTick(groupId, recipeId){ return (state.optionGroupRecipes || []).find(x => x.group_id === groupId && x.recipe_id === recipeId) || null; }
// Same rule as the database (_library_groups_for): the item's type OR its sub-category (case and outer
// spaces ignored) is in applies_to; production recipes (house-made sauces) never by default.
// r = a recipe or the recipe form's values {recipe_type, category, is_production_recipe}.
function libDefaultApplies(g, r){
  if(!g || !r || r.is_production_recipe) return false;
  const a = (g.applies_to && typeof g.applies_to === 'object') ? g.applies_to : {};
  if((Array.isArray(a.recipe_types) ? a.recipe_types : []).includes(r.recipe_type || 'DRINKS')) return true;
  const c = String(r.category || '').trim().toLowerCase();
  return !!c && (Array.isArray(a.subcategories) ? a.subcategories : []).some(x => String(x).trim().toLowerCase() === c);
}
// Where the group goes by default, in words ("Drinks, Iced coffee")
function libAppliesText(g){
  const a = (g && g.applies_to) || {};
  const parts = (a.recipe_types || []).map(t => recipeTypeLabel(t)).concat((a.subcategories || []).map(String));
  return parts.length ? parts.join(', ') : 'no items by default (tick it on per item)';
}
// Recipes that have the group now (the database's copy is the truth)
function libRecipesWith(g){ return state.recipes.filter(r => recipeOptionGroups(r).some(x => x.library_group_id === g.id || x.id === 'lib_' + g.id)); }
// What a LIBRARY option does (not worked out for one item yet), as escaped HTML
function libOptionEffectHtml(o){
  const kind = String(o.kind || 'PLAIN').toUpperCase();
  if(kind === 'SWAP') return `<span class="text-light">takes off ${esc(ingName(o.swap_from_ingredient_id))}, puts on the same amount of ${esc(ingName(o.swap_to_ingredient_id))}</span>`;
  const ex = Array.isArray(o.extras) ? o.extras.filter(e => e && e.ingredient_id) : [];
  if(!ex.length) return '';
  return `<span class="text-light">${ex.map(e => {
    const i = ingredientById(e.ingredient_id) || {};
    const q = _hasNum(e.entered_quantity) ? `${fmtNum(e.entered_quantity, 4).replace(/\.?0+$/, '')} ${unitLabel(e.unit || i.base_unit)}` : formatQuantity(e.quantity, i.base_unit, i.base_unit, 4);
    return '+' + esc(q) + ' ' + esc(ingName(e.ingredient_id));
  }).join(', ')}</span>`;
}

/* ================= Options library screen ================= */
// One-tap starters (owner's examples). Nothing is created until the owner presses Save in the form.
function libGuessIngredient(re, not){
  return ingredientPickerList().filter(i => re.test(i.name) && !(not && not.test(i.name))).sort(byName)[0] || null;
}
function libStarters(){
  const cup = libGuessIngredient(/cup/i, /lid/i), lid = libGuessIngredient(/lid/i);
  const iced = libGuessIngredient(/(iced|cold|clear|plastic).*cup|cup.*(iced|cold|clear|plastic)/i, /lid/i);
  const beans = libGuessIngredient(/bean|espresso|coffee/i, /cold brew/i);
  const milk = libGuessIngredient(/milk/i, /non|oat|soy|almond|condensed|evap|powder|coconut/i);
  const alt = libGuessIngredient(/non.?dairy|oat|soy|almond/i);
  const ex = (ing, qty, unit) => ing ? {ingredient_id: ing.id, entered_quantity: qty, unit: unit || ing.base_unit} : null;
  return [
    {key: 'hoticed', title: 'Hot or iced', about: 'A required choice on every drink.',
      group: {name: 'Hot or iced', required: true, multi_select: false, applies_to: {recipe_types: ['DRINKS'], subcategories: []},
        options: [{label: 'Hot', price_delta: 0, kind: 'PLAIN'}, {label: 'Iced', price_delta: 0, kind: 'PLAIN'}]}},
    {key: 'cup', title: 'Take-away cup', about: 'Takes a cup and a lid from stock. Check the cup and lid items.',
      group: {name: 'Take-away cup', required: false, multi_select: false, applies_to: {recipe_types: ['DRINKS'], subcategories: []},
        options: [{label: 'Hot cup', price_delta: 0, kind: 'EXTRA', extras: [ex(cup, 1), ex(lid, 1)].filter(Boolean)},
                  {label: 'Iced cup', price_delta: 0, kind: 'EXTRA', extras: [ex(iced || cup, 1), ex(lid, 1)].filter(Boolean)}]}},
    {key: 'shot', title: 'Extra shot', about: 'Adds coffee beans to the drink (e.g. 18 g) for an extra price.',
      group: {name: 'Add-ons', required: false, multi_select: true, applies_to: {recipe_types: ['DRINKS'], subcategories: []},
        options: [{label: 'Extra double shot', price_delta: 30, kind: 'EXTRA', extras: [ex(beans, beans && unitFamily(beans.base_unit) === 'weight' ? (beans.base_unit === 'kg' ? 0.018 : 18) : 1)].filter(Boolean)}]}},
    {key: 'nondairy', title: 'Non-dairy milk swap', about: 'Takes the normal milk off and puts the same amount of non-dairy milk on. One extra price for all items.',
      group: {name: 'Milk', required: false, multi_select: false, applies_to: {recipe_types: ['DRINKS'], subcategories: []},
        options: [{label: 'Non-dairy milk', price_delta: 30, kind: 'SWAP', swap_from_ingredient_id: milk ? milk.id : '', swap_to_ingredient_id: alt ? alt.id : ''}]}},
  ];
}

function renderOptionLibrary(){
  const bar = setTopbarActions(`<button class="btn btn-primary" id="btn-new-libgroup">+ New option group</button>`);
  bar.querySelector('#btn-new-libgroup').onclick = () => openLibraryGroupForm(null);
  const content = document.getElementById('content');
  const groups = libGroups();
  const names = new Set(groups.map(g => String(g.name).trim().toLowerCase()));
  const starters = libStarters().filter(s => !names.has(s.group.name.toLowerCase()));
  content.innerHTML = `
    <a class="linklike" id="lib-back" style="font-size:13px;">← Back to recipes &amp; menu</a>
    <p class="hint" style="margin:10px 0 14px;max-width:760px;">Make an option group once and it shows on every item of the types or sub-categories you choose (for example all Drinks). Untick it on an item that doesn't offer it, in that item's recipe form. Changing a group here changes it on every item. Items keep their own option groups too.</p>
    ${starters.length ? `<div class="card lib-starters"><b>Starters</b> <span class="hint">One tap opens the form filled in; nothing is saved until you press Save.</span>
      <div class="lib-starter-row">${starters.map(s => `<button class="btn btn-sm btn-outline" type="button" data-starter="${esc(s.key)}" title="${esc(s.about)}">${icon('plus', {size: 16})} ${esc(s.title)}</button>`).join('')}</div></div>` : ''}
    <div id="lib-list">${groups.length ? groups.map((g, i) => libGroupCardHtml(g, i, groups.length)).join('') : emptyBlock('No shared option groups yet. Start with one of the starters above, or "+ New option group".')}</div>`;
  content.querySelector('#lib-back').onclick = () => navigate('recipes');
  content.querySelectorAll('[data-starter]').forEach(b => b.onclick = () => {
    const s = libStarters().find(x => x.key === b.dataset.starter);
    if(s) openLibraryGroupForm(null, s.group);
  });
  content.querySelectorAll('[data-lib-edit]').forEach(b => b.onclick = () => openLibraryGroupForm(b.dataset.libEdit));
  content.querySelectorAll('[data-lib-items]').forEach(b => b.onclick = () => openLibraryItems(b.dataset.libItems));
  content.querySelectorAll('[data-lib-toggle]').forEach(b => b.onclick = () => busy(b, () => toggleLibraryGroup(b.dataset.libToggle), '…'));
  content.querySelectorAll('[data-lib-del]').forEach(b => b.onclick = () => deleteLibraryGroup(b.dataset.libDel));
  content.querySelectorAll('[data-lib-move]').forEach(b => b.onclick = () => busy(b, () => moveLibraryGroup(b.dataset.libGroup, Number(b.dataset.libMove)), '…'));
}
function libGroupCardHtml(g, i, n){
  const on = libRecipesWith(g);
  const unticked = (state.optionGroupRecipes || []).filter(x => x.group_id === g.id && x.mode === 'EXCLUDE').length;
  const opts = Array.isArray(g.options) ? g.options : [];
  return `<div class="card lib-card ${g.active === false ? 'lib-off' : ''}" data-lib-card="${esc(g.id)}">
    <div class="lib-card-head">
      <div style="min-width:0;"><b class="lib-name">${esc(g.name)}</b>
        <div class="pill-stack" style="margin-top:4px;">
          <span class="tag-pill">${g.multi_select ? 'Pick any number' : 'Pick one'}</span>
          ${g.required ? '<span class="badge badge-yellow">Customer must choose</span>' : ''}
          ${g.active === false ? '<span class="badge badge-gray">Switched off</span>' : ''}
        </div></div>
      <div class="row-actions">
        <button class="btn btn-sm btn-ghost" data-lib-move="-1" data-lib-group="${esc(g.id)}" ${i === 0 ? 'disabled' : ''} aria-label="Move ${esc(g.name)} up">${icon('chevron-down', {size: 18, className: 'rot180'})}</button>
        <button class="btn btn-sm btn-ghost" data-lib-move="1" data-lib-group="${esc(g.id)}" ${i === n - 1 ? 'disabled' : ''} aria-label="Move ${esc(g.name)} down">${icon('chevron-down', {size: 18})}</button>
        <button class="btn btn-sm btn-outline" data-lib-edit="${esc(g.id)}">Edit</button>
      </div>
    </div>
    <div class="lib-applies"><span class="text-light">On by default for:</span> ${esc(libAppliesText(g))}</div>
    <ul class="lib-opts">${opts.map(o => `<li><b>${esc(o.label)}</b>${num(o.price_delta) ? ` <span>${num(o.price_delta) > 0 ? '+' : ''}${fmtMoney(o.price_delta)}</span>` : ''} <span class="badge badge-gray">${esc(LIB_KIND_LABEL[String(o.kind || 'PLAIN').toUpperCase()] || 'Price only')}</span> ${libOptionEffectHtml(o)}</li>`).join('')}</ul>
    <div class="lib-foot">
      <span>On <b>${on.length}</b> ${on.length === 1 ? 'item' : 'items'}${unticked ? ` · unticked on ${unticked}` : ''}</span>
      <span class="row-actions">
        <button class="btn btn-sm btn-ghost" data-lib-items="${esc(g.id)}">Choose items</button>
        <button class="btn btn-sm btn-ghost" data-lib-toggle="${esc(g.id)}">${g.active === false ? 'Switch on' : 'Switch off'}</button>
        <button class="btn btn-sm btn-ghost" data-lib-del="${esc(g.id)}">Delete</button>
      </span>
    </div>
  </div>`;
}
async function toggleLibraryGroup(id){
  const g = libGroupById(id); if(!g) return;
  const on = g.active === false;
  if(await boSave([Ops.update('option_groups', {id: g.id, active: on}), Ops.audit(on ? 'Option group switched on' : 'Option group switched off', g.name, g.id)],
    {success: on ? `${g.name} is on the items again` : `${g.name} is off every item (kept here)`})) rerender();
}
async function deleteLibraryGroup(id){
  const g = libGroupById(id); if(!g) return;
  const n = libRecipesWith(g).length;
  const ok = await confirmDialog(`Delete the option group <b>${esc(g.name)}</b>? It comes off ${plural(n, 'item')}. Sales already made keep their options. To keep it for later, use "Switch off" instead.`, 'Delete group');
  if(!ok) return;
  if(await boSave([Ops.del('option_groups', g.id), Ops.audit('Option group deleted', g.name, g.id)], {success: 'Option group deleted'})) rerender();
}
async function moveLibraryGroup(id, by){
  const list = libGroups();
  const i = list.findIndex(g => g.id === id), j = i + by;
  if(i < 0 || j < 0 || j >= list.length) return;
  const t = list[i]; list[i] = list[j]; list[j] = t;
  const ops = list.map((g, k) => num(g.sort_order) !== (k + 1) * 10 ? Ops.update('option_groups', {id: g.id, sort_order: (k + 1) * 10}) : null).filter(Boolean);
  if(await boSave(ops)) rerender();
}

/* ---- the group form ---- */
function libIngOptions(sel, placeholder){
  return `<option value="">${esc(placeholder || 'Choose…')}</option>` + ingredientPickerList({keep: sel ? [sel] : []}).sort(byName)
    .map(i => `<option value="${esc(i.id)}" ${sel === i.id ? 'selected' : ''}>${esc(i.name)} (${esc(unitLabel(i.base_unit))})</option>`).join('');
}
function libExtraRowHtml(e){
  e = e || {};
  const ing = e.ingredient_id ? ingredientById(e.ingredient_id) : null;
  const typed = _hasNum(e.entered_quantity);
  const unit = ing ? (typed && e.unit && unitsForIngredient(ing).includes(e.unit) ? e.unit : ing.base_unit) : '';
  const qty = typed ? num(e.entered_quantity) : (_hasNum(e.quantity) ? num(e.quantity) : '');
  return `<div class="lib-extra">
    <select class="lx-ing" aria-label="Stock item">${libIngOptions(e.ingredient_id || '', 'Stock item…')}</select>
    <input class="lx-qty" type="number" step="any" min="0" value="${esc(qty === '' ? '' : qtyInputValue(qty))}" placeholder="Amount" aria-label="Amount per item">
    <select class="lx-unit" aria-label="Unit" ${ing ? '' : 'disabled'}>${ing ? recUnitOptionsHtml(ing.base_unit, unit, ing.weight_g_per_ml) : ''}</select>
    <button type="button" class="btn btn-sm btn-ghost lx-rm" aria-label="Remove this stock item">${icon('x', {size: 18})}</button>
  </div>`;
}
function libOptionHtml(o){
  o = o || {kind: 'PLAIN', price_delta: 0};
  const kind = String(o.kind || 'PLAIN').toUpperCase();
  const extras = Array.isArray(o.extras) ? o.extras.filter(e => e && e.ingredient_id) : [];
  return `<div class="lib-opt" data-opt="${esc(o.id || uid())}">
    <div class="lib-opt-main">
      <input class="lo-label" maxlength="40" value="${esc(o.label || '')}" placeholder="Option, e.g. Iced" aria-label="Option name">
      <label class="lib-price"><span>₱</span><input class="lo-price" type="number" step="any" value="${esc(num(o.price_delta) || '')}" placeholder="0" aria-label="Extra price in pesos"></label>
      <select class="lo-kind" aria-label="What this option does">${['PLAIN', 'EXTRA', 'SWAP'].map(k => `<option value="${k}" ${kind === k ? 'selected' : ''}>${esc(LIB_KIND_LABEL[k])}</option>`).join('')}</select>
      <button type="button" class="btn btn-sm btn-ghost lo-rm" aria-label="Remove this option">${icon('trash', {size: 18})}</button>
    </div>
    <div class="lib-opt-extra" ${kind === 'EXTRA' ? '' : 'hidden'}>
      <div class="lib-extras">${(extras.length ? extras : [null]).map(libExtraRowHtml).join('')}</div>
      <button type="button" class="btn btn-sm btn-outline lx-add">+ Add stock item</button>
      <span class="hint">Taken from stock for each item sold with this option (up to ${LIB_MAX_EXTRAS}, e.g. a cup and a lid).</span>
    </div>
    <div class="lib-opt-swap" ${kind === 'SWAP' ? '' : 'hidden'}>
      <label>Takes off <select class="ls-from" aria-label="Ingredient taken off">${libIngOptions(o.swap_from_ingredient_id || '', 'Ingredient…')}</select></label>
      <label>Puts on <select class="ls-to" aria-label="Ingredient put on instead">${libIngOptions(o.swap_to_ingredient_id || '', 'Ingredient…')}</select></label>
      <span class="hint">The same amount the item's recipe uses (a 12 oz and a 16 oz drink differ). Only items that use the first ingredient get this option. The price is the one extra price for all items.</span>
    </div>
  </div>`;
}
function openLibraryGroupForm(id, preset){
  const editing = id ? libGroupById(id) : null;
  const g = editing || Object.assign({name: '', required: false, multi_select: false, active: true, applies_to: {recipe_types: ['DRINKS'], subcategories: []}, options: []}, preset || {});
  const a = (g.applies_to && typeof g.applies_to === 'object') ? g.applies_to : {};
  const subsKnown = subcategoriesForOrder().map(x => x.name);
  const chosenSubs = (a.subcategories || []).map(String);
  const subs = [...new Set(subsKnown.concat(chosenSubs.filter(s => !subsKnown.some(k => subcategoryKey(k) === subcategoryKey(s)))))];
  const subOn = (s) => chosenSubs.some(x => subcategoryKey(x) === subcategoryKey(s));
  const body = `
    <div class="form-grid">
      <div class="form-row"><label for="lg-name">Group name</label><input id="lg-name" maxlength="40" value="${esc(g.name || '')}" placeholder="e.g. Hot or iced"></div>
      <div class="form-row"><label for="lg-multi">How many can be chosen</label><select id="lg-multi"><option value="one" ${g.multi_select ? '' : 'selected'}>Pick one</option><option value="many" ${g.multi_select ? 'selected' : ''}>Pick any number</option></select></div>
    </div>
    <div class="chk-row">
      <label class="chk"><input type="checkbox" id="lg-req" ${g.required ? 'checked' : ''}> Customer must choose (e.g. Hot or Iced)</label>
      <label class="chk"><input type="checkbox" id="lg-active" ${g.active !== false ? 'checked' : ''}> On (shown on the items)</label>
    </div>
    <fieldset class="lib-applies-box"><legend>On by default for</legend>
      <div class="chk-row">${RECIPE_TYPES.map(t => `<label class="chk"><input type="checkbox" data-lg-type="${t.id}" ${(a.recipe_types || []).includes(t.id) ? 'checked' : ''}> All ${esc(t.label)}</label>`).join('')}</div>
      ${subs.length ? `<div class="hint" style="margin:6px 0 4px;">or only these sub-categories:</div>
      <div class="lib-sub-chips">${subs.map(s => `<label class="lib-chip"><input type="checkbox" data-lg-sub="${esc(s)}" ${subOn(s) ? 'checked' : ''}><span>${esc(s)}</span></label>`).join('')}</div>` : ''}
      <div class="hint">House-made production recipes (sauces, syrups) never get shared options unless you tick one on in that recipe.</div>
    </fieldset>
    <div class="section-title" style="margin-top:14px;font-size:15px;">Options</div>
    <div id="lg-opts">${(g.options && g.options.length ? g.options : [null, null]).map(libOptionHtml).join('')}</div>
    <button type="button" class="btn btn-sm btn-outline" id="lg-add-opt" style="margin-top:6px;">+ Add option</button>
    <div class="notice warn" id="lg-problem" style="display:none;margin-top:12px;"></div>
    ${editing ? `<p class="hint" style="margin-top:12px;">Saving changes this group on every item that has it (${plural(libRecipesWith(editing).length, 'item')} now). Counters pick it up within a few minutes.</p>` : ''}`;
  openModal({title: editing ? 'Edit option group' : 'New option group', wide: true, body,
    foot: `<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" id="lg-save">${editing ? 'Save changes' : 'Save group'}</button>`,
    onMount: (root) => {
      root.querySelector('[data-cancel]').onclick = closeModal;
      const optsBox = root.querySelector('#lg-opts');
      root.querySelector('#lg-add-opt').onclick = () => {
        if(optsBox.querySelectorAll('.lib-opt').length >= 30){ toast('A group can have at most 30 options', 'error'); return; }
        optsBox.insertAdjacentHTML('beforeend', libOptionHtml(null));
        optsBox.querySelector('.lib-opt:last-child .lo-label').focus();
      };
      optsBox.addEventListener('click', (e) => {
        const b = e.target.closest('button'); if(!b) return;
        const opt = b.closest('.lib-opt');
        if(b.classList.contains('lo-rm')) opt.remove();
        else if(b.classList.contains('lx-rm')){ const box = b.closest('.lib-extras'); b.closest('.lib-extra').remove(); if(!box.children.length) box.insertAdjacentHTML('beforeend', libExtraRowHtml(null)); }
        else if(b.classList.contains('lx-add')){
          const box = opt.querySelector('.lib-extras');
          if(box.children.length >= LIB_MAX_EXTRAS){ toast(`An option can use at most ${LIB_MAX_EXTRAS} stock items`, 'error'); return; }
          box.insertAdjacentHTML('beforeend', libExtraRowHtml(null));
        }
      });
      optsBox.addEventListener('change', (e) => {
        const t = e.target, opt = t.closest('.lib-opt'); if(!opt) return;
        if(t.classList.contains('lo-kind')){
          opt.querySelector('.lib-opt-extra').hidden = t.value !== 'EXTRA';
          opt.querySelector('.lib-opt-swap').hidden = t.value !== 'SWAP';
        }
        if(t.classList.contains('lx-ing')){
          const row = t.closest('.lib-extra'), sel = row.querySelector('.lx-unit');
          fillUnitSelect(sel, ingredientById(t.value), sel.value);
          if(!ingredientById(t.value)) sel.disabled = true;
        }
        if(t.classList.contains('lx-unit')) convertShownQty(t.closest('.lib-extra').querySelector('.lx-qty'), t);
      });
      optsBox.addEventListener('input', (e) => { if(e.target.classList.contains('lx-qty')) markTyped(e.target); });
      // fill the unit pickers' "previous unit" so a change converts a saved amount
      optsBox.querySelectorAll('.lib-extra').forEach(row => { const ing = ingredientById(row.querySelector('.lx-ing').value); const sel = row.querySelector('.lx-unit'); if(ing) fillUnitSelect(sel, ing, sel.value); });
      const save = root.querySelector('#lg-save');
      save.onclick = () => busy(save, async () => {
        const r = readLibraryGroupForm(root, editing);
        const problemBox = root.querySelector('#lg-problem');
        if(r.error){ problemBox.textContent = r.error; problemBox.style.display = 'block'; toast(r.error, 'error'); return; }
        problemBox.style.display = 'none';
        const row = r.group;
        const ops = [Ops.upsert('option_groups', row), Ops.audit(editing ? 'Option group updated' : 'Option group added', `${row.name}: ${row.options.map(o => o.label).join(', ')}`, row.id)];
        let ok = false;
        try{ await applyChanges(ops); ok = true; }
        catch(err){ const m = friendlyError(err); problemBox.textContent = m; problemBox.style.display = 'block'; toast(m, 'error'); return; }
        if(ok){
          const seq = BO_MODAL_SEQ;
          try{ await boLoad(); }catch(e){ console.warn(e); }
          boGuardLateClose(seq);
          const n = libRecipesWith(libGroupById(row.id) || row).length;
          toast(`${row.name} saved — on ${plural(n, 'item')}`);
          closeModal(); if(state.route === 'optionLibrary') rerender();
        }
      });
    }});
}
// Reads the form -> {group} (a full option_groups row) or {error} (plain words)
function readLibraryGroupForm(root, editing){
  const name = root.querySelector('#lg-name').value.trim();
  const types = [...root.querySelectorAll('[data-lg-type]:checked')].map(b => b.dataset.lgType);
  const subs = [...root.querySelectorAll('[data-lg-sub]:checked')].map(b => b.dataset.lgSub.trim());
  const options = [];
  for(const box of root.querySelectorAll('.lib-opt')){
    const label = box.querySelector('.lo-label').value.trim();
    const kind = box.querySelector('.lo-kind').value;
    const price = box.querySelector('.lo-price').value === '' ? 0 : Number(box.querySelector('.lo-price').value);
    const filled = label || num(price) || (kind === 'SWAP' && (box.querySelector('.ls-from').value || box.querySelector('.ls-to').value));
    if(!filled) continue;                       // an empty row is ignored
    if(!label) return {error: 'Give every option a name (or remove the empty one).'};
    if(!isFinite(price)) return {error: `"${label}": the price is not a number.`};
    const o = {id: box.dataset.opt, label, price_delta: Math.round(price * 100) / 100, kind};
    if(kind === 'EXTRA'){
      o.extras = [];
      for(const row of box.querySelectorAll('.lib-extra')){
        const ing = ingredientById(row.querySelector('.lx-ing').value);
        const q = row.querySelector('.lx-qty').value;
        if(!ing && q === '') continue;
        if(!ing) return {error: `"${label}": choose the stock item for the amount ${q}.`};
        if(!(Number(q) > 0)) return {error: `"${label}": enter an amount above 0 for ${ing.name}.`};
        const unit = row.querySelector('.lx-unit').value || ing.base_unit;
        if(ingredientQtyToBase(ing, q, unit) === null) return {error: `"${label}": ${unitLabel(unit)} doesn't fit ${ing.name}. Choose one of its units.`};
        o.extras.push({ingredient_id: ing.id, entered_quantity: Number(q), unit});
      }
      if(!o.extras.length) return {error: `"${label}" uses stock: choose at least one stock item and amount (or set it to "Price only").`};
    } else if(kind === 'SWAP'){
      o.swap_from_ingredient_id = box.querySelector('.ls-from').value || null;
      o.swap_to_ingredient_id = box.querySelector('.ls-to').value || null;
      if(!o.swap_from_ingredient_id || !o.swap_to_ingredient_id) return {error: `"${label}": choose the ingredient taken off and the one put on.`};
      if(o.swap_from_ingredient_id === o.swap_to_ingredient_id) return {error: `"${label}": the two ingredients must be different.`};
      if(o.price_delta < 0) return {error: `"${label}": a swap's price must be ₱0 or more.`};
      const x = ingredientById(o.swap_from_ingredient_id), y = ingredientById(o.swap_to_ingredient_id);
      if(x && y && toBaseQty(1, x.base_unit, y.base_unit, y.weight_g_per_ml || x.weight_g_per_ml) === null)
        return {error: `"${label}": ${x.name} (${unitLabel(x.base_unit)}) and ${y.name} (${unitLabel(y.base_unit)}) are counted in units that don't convert.`};
    }
    options.push(o);
  }
  if(!options.length) return {error: 'Add at least one option.'};
  const g = {name, options, applies_to: {recipe_types: types, subcategories: subs}};
  const p = optionGroupProblem(g);                 // the database's own checks (shared)
  if(p) return {error: p.text};
  const now = nowISO();
  const maxSort = libGroups().reduce((m, x) => Math.max(m, num(x.sort_order)), 0);
  return {group: {id: editing ? editing.id : uid(), name, required: root.querySelector('#lg-req').checked,
    multi_select: root.querySelector('#lg-multi').value === 'many', options, applies_to: g.applies_to,
    sort_order: editing ? num(editing.sort_order) : maxSort + 10, active: root.querySelector('#lg-active').checked,
    created_at: editing ? editing.created_at : now, updated_at: now}};
}

/* ---- choose the items a group is on (from the library side) ---- */
function openLibraryItems(id){
  const g = libGroupById(id); if(!g) return;
  const list = state.recipes.filter(r => r.active !== false && !isSuppliedRecipe(r) || (r.active !== false && isSuppliedRecipe(r))).filter(r => !isProductionRecipe(r) || libTick(g.id, r.id));
  const groups = recGroups(list);
  const applies = (r) => { const t = libTick(g.id, r.id); return t ? t.mode === 'INCLUDE' : libDefaultApplies(g, r); };
  openModal({title: 'Items with ' + esc(g.name), wide: true, body: `
      <p class="hint" style="margin-top:0;">Ticked items offer <b>${esc(g.name)}</b>. By default it is on for: ${esc(libAppliesText(g))}. Untick items that don't offer it; tick others on.</p>
      ${groups.map(sec => `<div class="lib-items-sec"><div class="lib-items-head"><b>${esc(sec.name)}</b></div>
        <div class="lib-items-grid">${sec.items.map(r => `<label class="chk"><input type="checkbox" data-li="${esc(r.id)}" ${applies(r) ? 'checked' : ''}> ${esc(r.name)}${libDefaultApplies(g, r) ? '' : ' <span class="text-light">(ticked on)</span>'}</label>`).join('')}</div></div>`).join('') || emptyLine('No active items yet.')}`,
    foot: `<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" id="li-save">Save</button>`,
    onMount: (root) => {
      root.querySelector('[data-cancel]').onclick = closeModal;
      const save = root.querySelector('#li-save');
      save.onclick = () => busy(save, async () => {
        const ops = [];
        root.querySelectorAll('[data-li]').forEach(box => {
          const r = state.recipes.find(x => x.id === box.dataset.li); if(!r) return;
          libTickOp(g, r.id, libDefaultApplies(g, r), box.checked).forEach(o => ops.push(o));
        });
        if(!ops.length){ closeModal(); return; }
        ops.push(Ops.audit('Option group items changed', g.name, g.id));
        if(await boSave(ops, {success: `${g.name}: items saved`})){ closeModal(); if(state.route === 'optionLibrary') rerender(); }
      });
    }});
}
// The tick row needed so the group is (want=true) or isn't (false) on one item -> [ops]
function libTickOp(g, recipeId, isDefault, want){
  const mode = want === isDefault ? null : (want ? 'INCLUDE' : 'EXCLUDE');
  const ex = libTick(g.id, recipeId);
  if(!mode) return ex ? [Ops.del('option_group_recipes', ex.id)] : [];
  if(ex && ex.mode === mode) return [];
  return [ex ? Ops.update('option_group_recipes', {id: ex.id, mode}) : Ops.upsert('option_group_recipes', {id: uid(), group_id: g.id, recipe_id: recipeId, mode, created_at: nowISO()})];
}

/* ---- in the recipe form: the shared groups, read-only, with a tick per item ---- */
function libraryTicksHtml(editing){
  const groups = libGroups().filter(g => g.active !== false);
  if(!groups.length) return `<p class="hint" style="margin:4px 0 0;">No shared option groups yet. Use the <b>Options library</b> (Recipes &amp; menu) to set up Hot / Iced, cups, extra shot or a milk swap once for many items.</p>`;
  return `<div class="lib-ticks">${groups.map(g => {
    const t = editing ? libTick(g.id, editing.id) : null;
    const opts = (g.options || []).map(o => esc(o.label) + (num(o.price_delta) ? ` ${num(o.price_delta) > 0 ? '+' : ''}${fmtMoney(o.price_delta)}` : '')).join(', ');
    return `<label class="lib-tick-row"><input type="checkbox" data-lib-tick="${esc(g.id)}" data-mode="${esc(t ? t.mode : '')}">
      <span><b>${esc(g.name)}</b>${g.required ? ' <span class="badge badge-yellow">must choose</span>' : ''} <span class="text-light">${opts}</span><br><span class="hint lib-tick-why" data-lib-why="${esc(g.id)}"></span></span></label>`;
  }).join('')}</div>`;
}
function wireLibraryTicks(root, editing, formFn){
  const sync = () => root.querySelectorAll('[data-lib-tick]').forEach(box => {
    const g = libGroupById(box.dataset.libTick); if(!g) return;
    const def = libDefaultApplies(g, formFn());
    if(!box.dataset.touched) box.checked = box.dataset.mode === 'INCLUDE' ? true : box.dataset.mode === 'EXCLUDE' ? false : def;
    const why = root.querySelector(`[data-lib-why="${CSS.escape(g.id)}"]`);
    if(why) why.textContent = def ? (box.checked ? 'On for ' + libAppliesText(g) + '.' : 'Unticked for this item (on for ' + libAppliesText(g) + ').')
      : (box.checked ? 'Ticked on for this item.' : 'Not on this kind of item; tick to add it.');
    const swapOnly = (g.options || []).length && (g.options || []).every(o => String(o.kind || '').toUpperCase() === 'SWAP');
    if(why && box.checked && swapOnly) why.textContent += ' Shows only when the item uses the ingredient it swaps.';
  });
  root.querySelectorAll('[data-lib-tick]').forEach(box => box.onchange = () => { box.dataset.touched = '1'; sync(); });
  ['#r-type', '#r-cat', '#r-produces'].forEach(sel => { const n = root.querySelector(sel); if(n){ n.addEventListener('change', sync); n.addEventListener('input', sync); } });
  sync();
}
// Ops for the ticks of this recipe (sent after the recipe in the same call)
function libraryTickOps(root, recipeId, f){
  const ops = [];
  root.querySelectorAll('[data-lib-tick]').forEach(box => {
    const g = libGroupById(box.dataset.libTick); if(!g) return;
    libTickOp(g, recipeId, libDefaultApplies(g, f), box.checked).forEach(o => ops.push(o));
  });
  return ops;
}

/* ================= Supplied items (A8) ================= */
// The margin while typing, from the SHARED rule (suppliedItemCosting): the item's latest purchase if it
// has one, else the price paid typed here. The typed cost is shown through a stand-in stock item for
// this one synchronous call only.
function liveSuppliedCosting(ingredientId, typedCost, price){
  const recipe = {supplied_ingredient_id: ingredientId || '__new_supplied__', selling_price: price};
  const saved = state.ingredients;
  const real = ingredientId ? ingredientById(ingredientId) : null;
  const stand = Object.assign({}, real || {id: recipe.supplied_ingredient_id, base_unit: 'pcs'}, {standard_cost: _hasNum(typedCost) ? Number(typedCost) : (real ? real.standard_cost : null)});
  state.ingredients = saved.filter(i => i.id !== stand.id).concat([stand]);
  try{ return suppliedItemCosting(recipe); }
  finally{ state.ingredients = saved; }
}
function suppliedCategoryDefault(){
  const stock = state.categories.filter(c => !isExpenseCategory(c) && c.name !== PRODUCED_CATEGORY_NAME).sort(byName);
  return (stock.find(c => /pastr|bread|bake|food/i.test(c.name)) || stock[0] || {}).id || '';
}
function openSuppliedItemForm(recipeId, opts){
  opts = opts || {};
  const r = recipeId ? state.recipes.find(x => x.id === recipeId) : null;
  const ing = r ? ingredientById(r.supplied_ingredient_id) : null;
  if(r && !ing){ toast('The stock item of this supplied item is missing. Refresh and try again.', 'error'); return; }
  const cats = state.categories.filter(c => !isExpenseCategory(c)).sort(byName);
  const costShown = ing && _hasNum(ing.standard_cost) ? num(ing.standard_cost) : (r ? suppliedItemCosting(r).cost_per_piece : '');
  const subs = [...new Set(state.recipes.filter(x => ['PASTRY', 'FOOD'].includes(recipeTypeOf(x))).map(x => x.category).filter(Boolean))];
  const body = `
    <p class="hint" style="margin-top:0;">For food and pastries you buy ready-made and resell. Stock is counted in pieces: purchases add pieces, each sale takes 1, and no stock means sold out.</p>
    <div class="form-grid">
      <div class="form-row"><label for="si-name">Name</label><input id="si-name" maxlength="80" value="${esc(r ? r.name : '')}" placeholder="e.g. Ensaymada"></div>
      <div class="form-row"><label for="si-type">Type</label><select id="si-type"><option value="PASTRY" ${!r || recipeTypeOf(r) === 'PASTRY' ? 'selected' : ''}>Pastry</option><option value="FOOD" ${r && recipeTypeOf(r) === 'FOOD' ? 'selected' : ''}>Food</option></select></div>
    </div>
    <div class="form-grid">
      <div class="form-row"><label for="si-sub">Sub-category (menu section)</label><input id="si-sub" maxlength="40" list="si-sub-list" value="${esc(r ? (r.category || '') : '')}" placeholder="e.g. Pastries"><datalist id="si-sub-list">${subs.map(c => `<option value="${esc(c)}">`).join('')}</datalist></div>
      <div class="form-row"><label for="si-sup">Supplier</label><select id="si-sup"><option value="">—</option>${selectOptions(state.suppliers.slice().sort(byName), ing ? ing.supplier_id : '')}</select></div>
    </div>
    <div class="form-grid">
      <div class="form-row"><label for="si-cost">Price paid per piece (₱)</label><input id="si-cost" type="number" step="any" min="0" value="${esc(costShown === '' ? '' : costShown)}" placeholder="e.g. 25"><div class="hint" id="si-cost-hint"></div></div>
      <div class="form-row"><label for="si-price">Selling price (₱)</label><input id="si-price" type="number" step="any" min="0" value="${esc(r ? num(r.selling_price) : '')}" placeholder="e.g. 45"></div>
    </div>
    <div class="si-margin" id="si-margin" role="status" aria-live="polite"></div>
    <div class="form-grid">
      <div class="form-row"><label for="si-cat">Stock category</label><select id="si-cat">${selectOptions(cats, ing ? ing.category_id : suppliedCategoryDefault())}</select></div>
      <div class="form-row"><label for="si-reorder">Low stock at (pieces)</label><input id="si-reorder" type="number" step="1" min="0" value="${esc(ing ? num(ing.reorder_level) : 5)}"></div>
    </div>
    <div class="card soft-card" style="margin-top:4px;">
      <b style="font-size:14px;">Counter &amp; QR menu</b>
      <div class="chk-row">
        <label class="chk"><input type="checkbox" id="si-pos" ${!r || r.pos_visible !== false ? 'checked' : ''}> Show on the counter</label>
        <label class="chk"><input type="checkbox" id="si-qr" ${!r || r.qr_visible !== false ? 'checked' : ''}> Show on the QR menu</label>
        ${r ? `<label class="chk"><input type="checkbox" id="si-active" ${r.active !== false ? 'checked' : ''}> Active</label>` : ''}
      </div>
      <div class="form-grid" style="margin-top:8px;">
        <div class="form-row"><label for="si-desc">Menu description (optional)</label><input id="si-desc" maxlength="160" value="${esc(r ? (r.description || '') : '')}"></div>
        <div class="form-row"><label for="si-sort">Menu order (smaller shows first)</label><input id="si-sort" type="number" step="1" value="${esc(r ? num(r.sort_order) : 0)}"></div>
      </div>
      <div class="form-row mb-0"><label>Photo (optional)</label>
        <div class="field-inline">
          <div class="logo-preview" id="si-photo-prev" style="width:56px;height:56px;">${r && r.image_url ? `<img src="${esc(r.image_url)}" alt="">` : '<span class="text-light" style="font-size:11px;">No photo</span>'}</div>
          <button class="btn btn-outline btn-sm" type="button" id="si-photo-btn">Choose a photo</button>
          <button class="btn btn-ghost btn-sm" type="button" id="si-photo-rm">Remove photo</button>
          <input type="file" id="si-photo" accept="image/*" style="display:none;">
        </div>
        <div class="hint">Shrunk to about 600 pixels before uploading.</div></div>
    </div>
    <details class="card soft-card si-restock" id="si-restock" style="margin-top:12px;" ${opts.restock || !r ? 'open' : ''}>
      <summary><b>${r ? 'Restock now (optional)' : 'Starting stock (optional)'}</b> <span class="hint">records a purchase of pieces</span></summary>
      <div class="form-grid" style="margin-top:8px;">
        <div class="form-row"><label for="si-rq">Pieces bought</label><input id="si-rq" type="number" step="1" min="0" placeholder="e.g. 24"></div>
        <div class="form-row"><label for="si-rdate">Date</label><input id="si-rdate" type="date" value="${shopTodayKey()}" max="${keyAddDays(shopTodayKey(), 1)}"></div>
      </div>
      <div class="form-grid">
        <div class="form-row"><label for="si-rtotal">Total paid (₱, optional)</label><input id="si-rtotal" type="number" step="any" min="0" placeholder="empty = pieces × price paid"></div>
        <div class="form-row"><label for="si-rinv">Invoice number (optional)</label><input id="si-rinv" maxlength="60"></div>
      </div>
      ${r ? `<div class="hint">In stock now: ${esc(fmtNum(ingredientStock(ing.id), 0))} pcs. Later deliveries can also be recorded under Purchases.</div>` : ''}
    </details>`;
  openModal({title: r ? 'Edit supplied item' : 'New supplied item', wide: true, body,
    foot: `<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" id="si-save">${r ? 'Save changes' : 'Add supplied item'}</button>`,
    onMount: (root) => {
      root.querySelector('[data-cancel]').onclick = closeModal;
      const q = (s) => root.querySelector(s);
      let photo = {url: r ? (r.image_url || null) : null, blob: null};
      q('#si-photo-btn').onclick = () => q('#si-photo').click();
      q('#si-photo-rm').onclick = () => { photo = {url: null, blob: null}; q('#si-photo-prev').innerHTML = '<span class="text-light" style="font-size:11px;">No photo</span>'; };
      q('#si-photo').onchange = async (e) => {
        const f = e.target.files[0]; if(!f) return;
        try{ const blob = await resizeImage(f, 600, 'image/jpeg', 0.82); photo = {url: null, blob}; q('#si-photo-prev').innerHTML = `<img src="${URL.createObjectURL(blob)}" alt="">`; }
        catch(err){ toast(err.message || 'Could not read that picture', 'error'); }
      };
      const margin = () => {
        const cost = q('#si-cost').value, price = num(q('#si-price').value);
        const c = liveSuppliedCosting(ing ? ing.id : null, cost === '' ? null : cost, price);
        q('#si-cost-hint').textContent = c.cost_source === 'purchase' ? `Your latest purchase was ${fmtMoney(c.cost_per_piece)} a piece; the margin uses that.` : '';
        const box = q('#si-margin');
        if(!(price > 0)){ box.innerHTML = '<span class="text-light">Type the selling price to see the margin.</span>'; box.className = 'si-margin'; return; }
        box.className = 'si-margin ' + (c.margin < 0 ? 'neg' : 'pos');
        box.innerHTML = `Margin per piece: <b>${fmtMoney(c.margin)}</b>${c.margin_pct == null ? '' : ` (<b>${esc(fmtNum(c.margin_pct, 1))}%</b> of the price)`} · you pay ${fmtMoney(c.cost_per_piece)}, you sell at ${fmtMoney(c.selling_price)}`;
      };
      ['#si-cost', '#si-price'].forEach(s => q(s).addEventListener('input', margin));
      margin();
      const save = q('#si-save');
      save.onclick = () => busy(save, async () => {
        const name = q('#si-name').value.trim(), price = q('#si-price').value, cost = q('#si-cost').value;
        if(!name){ toast('Enter a name', 'error'); q('#si-name').focus(); return; }
        if(price === '' || !(Number(price) >= 0)){ toast('Enter the selling price (₱0 or more)', 'error'); q('#si-price').focus(); return; }
        if(cost !== '' && !(Number(cost) >= 0)){ toast('The price paid per piece must be ₱0 or more', 'error'); return; }
        const rq = q('#si-rq').value;
        if(rq !== '' && !(Number(rq) > 0)){ toast('Pieces bought must be above 0 (or leave it empty)', 'error'); return; }
        if(rq !== '' && cost === '' && q('#si-rtotal').value === ''){ toast('Enter the price paid per piece or the total paid for the restock', 'error'); return; }
        let imageUrl = photo.url;
        if(photo.blob){
          try{ imageUrl = await uploadShopImage(photo.blob, `${r ? r.id : uid()}-${Date.now()}.jpg`, 'image/jpeg'); }
          catch(err){ toast('The photo could not be uploaded: ' + friendlyError(err) + ' Remove the photo or try again.', 'error'); return; }
        }
        const item = {name, recipe_type: q('#si-type').value, subcategory: q('#si-sub').value.trim(),
          supplier_id: q('#si-sup').value || null, category_id: q('#si-cat').value || null,
          selling_price: Number(price), image_url: imageUrl || null, description: q('#si-desc').value.trim(),
          pos_visible: q('#si-pos').checked, qr_visible: q('#si-qr').checked,
          sort_order: Math.round(num(q('#si-sort').value)), reorder_level: num(q('#si-reorder').value)};
        if(cost !== '') item.cost_per_piece = Number(cost);
        if(r){ item.recipe_id = r.id; item.ingredient_id = ing.id; const a = q('#si-active'); if(a) item.active = a.checked; }
        if(rq !== ''){
          item.restock = {quantity: Number(rq), purchase_date: q('#si-rdate').value || shopTodayKey(), invoice_number: q('#si-rinv').value.trim() || null};
          if(q('#si-rtotal').value !== '') item.restock.total_price = Number(q('#si-rtotal').value);
          else if(cost !== '') item.restock.cost_per_piece = Number(cost);
        }
        let res;
        const seq = BO_MODAL_SEQ;
        try{ res = await cloud.rpc('save_supplied_item', {p_item: item}); }
        catch(err){ toast(friendlyError(err), 'error'); return; }
        applyChanges([Ops.audit(r ? 'Supplied item updated' : 'Supplied item added',
          `${name} — sells ${fmtMoney(item.selling_price)}, paid ${fmtMoney(res && res.cost_per_piece)} a piece${item.restock ? `, restocked ${item.restock.quantity} pcs` : ''}`, res && res.recipe_id)]).catch(() => {});
        try{ await boLoad(); }catch(e){ console.warn(e); }
        boGuardLateClose(seq);
        toast(`${name} saved — margin ${fmtMoney(res && res.margin)}${res && res.margin_pct != null ? ' (' + fmtNum(res.margin_pct, 1) + '%)' : ''}`);
        closeModal();
        navigate('recipeDetail', res && res.recipe_id ? res.recipe_id : (r && r.id));
      });
    }});
}
