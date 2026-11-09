/* =====================================================================
   BACK OFFICE — release 1.4 (A12): Merge ingredients.
   Tick ingredients on the Ingredients list -> "Merge into one" -> name the
   general ingredient (or pick an existing one), its stock unit, and the
   brand name each picked ingredient becomes -> merge_ingredients_preview
   (changes nothing) -> confirm -> merge_ingredients (all-or-nothing).
   Each picked ingredient becomes a brand of the general one and keeps its
   purchases and stock (g/kg, mL/L converted); recipe lines, option extras /
   swaps and production lines are repointed by the database.
   ===================================================================== */

function isUuidLike(v){ return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || '')); }
function mergeFamilyUnits(unit){
  const f = unitFamily(unit);
  return f === 'weight' ? ['g', 'kg'] : f === 'volume' ? ['ml', 'L'] : [unit];
}
// Picked ingredients the database will refuse, with the reason in plain words (shown before asking)
function mergeBlockers(list){
  const out = [];
  list.forEach(i => {
    if(isMergedIngredient(i)) out.push({i, why: 'already merged into ' + ingName(i.merged_into)});
    else if(isProducedItem(i)) out.push({i, why: 'a house-made item (can\'t be merged)'});
    else if(suppliedRecipeFor(i.id)) out.push({i, why: 'the stock item of a supplied menu item'});
  });
  return out;
}

function openMergeTool(ids){
  const picked = (ids || []).map(ingredientById).filter(Boolean);
  if(!picked.length){ toast('Tick the ingredients to merge first', 'warn'); return; }
  const blockers = mergeBlockers(picked);
  if(blockers.length){
    openModal({title: 'These can\'t be merged', body: `<p>Untick these first:</p><ul class="rec-rm-list">${blockers.map(b => `<li><b>${esc(b.i.name)}</b> <span class="text-light">— ${esc(b.why)}</span></li>`).join('')}</ul>`,
      foot: '<button class="btn btn-primary" data-cancel>OK</button>', onMount: (root) => { root.querySelector('[data-cancel]').onclick = closeModal; }});
    return;
  }
  const fams = [...new Set(picked.map(i => unitFamily(i.base_unit) === 'count' ? 'count:' + i.base_unit : unitFamily(i.base_unit)))];
  const first = picked[0];
  const unitChoices = mergeFamilyUnits(first.base_unit);
  // ingredients that could be the general one (same family, not picked, mergeable)
  const intoList = ingredientPickerList({produced: false}).filter(i => !picked.some(p => p.id === i.id) && !suppliedRecipeFor(i.id)
    && (unitFamily(i.base_unit) === 'count' ? 'count:' + i.base_unit : unitFamily(i.base_unit)) === fams[0]).sort(byName);
  const single = picked.length === 1;
  const body = `
    <p class="hint" style="margin-top:0;">Each ingredient below becomes a <b>brand</b> of one general ingredient and keeps its purchases and stock. Recipes, options and production recipes are moved to the general ingredient. You see exactly what will change before anything is saved.</p>
    ${fams.length > 1 ? `<div class="notice warn">${esc(ERROR_TEXT.MERGE_UNIT_MISMATCH)}</div>` : ''}
    <fieldset class="mg-mode"><legend>Merge into</legend>
      <label class="chk"><input type="radio" name="mg-mode" value="new" ${single ? 'disabled' : 'checked'}> A new general ingredient</label>
      <label class="chk"><input type="radio" name="mg-mode" value="into" ${single ? 'checked' : ''} ${intoList.length ? '' : 'disabled'}> An ingredient I already have${intoList.length ? '' : ' (none counted the same way)'}</label>
    </fieldset>
    <div class="form-grid" id="mg-new-row">
      <div class="form-row"><label for="mg-name">General ingredient name</label><input id="mg-name" maxlength="80" placeholder="e.g. Full Cream Milk"></div>
      <div class="form-row"><label for="mg-unit">Counted in</label><select id="mg-unit">${unitChoices.map(u => `<option value="${esc(u)}" ${u === first.base_unit ? 'selected' : ''}>${esc(unitLabel(u))}</option>`).join('')}</select></div>
    </div>
    <div class="form-grid" id="mg-into-row" style="display:none;">
      <div class="form-row"><label for="mg-into">Existing ingredient</label><select id="mg-into">${intoList.map(i => `<option value="${esc(i.id)}">${esc(i.name)} (${esc(unitLabel(i.base_unit))})</option>`).join('')}</select></div>
      <div class="form-row"><label for="mg-rename">New name (optional)</label><input id="mg-rename" maxlength="80" placeholder="keep its name"></div>
    </div>
    <div class="section-title" style="font-size:15px;margin-top:6px;">Brand names</div>
    <table class="ri-table mg-brands"><thead><tr><th>Ingredient now</th><th>Becomes the brand</th><th class="num">Stock</th></tr></thead><tbody>
      ${picked.map(i => `<tr><td><b>${esc(i.name)}</b></td><td><input data-mg-brand="${esc(i.id)}" maxlength="60" value="${esc(i.name)}" aria-label="Brand name for ${esc(i.name)}"></td><td class="num">${esc(formatQuantity(ingredientStock(i.id), i.base_unit, i.base_unit))}</td></tr>`).join('')}
    </tbody></table>
    <p class="hint">Brands an ingredient already has move over too, with their stock.</p>
    <div id="mg-preview"></div>`;
  openModal({title: 'Merge ' + plural(picked.length, 'ingredient'), wide: true, body,
    foot: `<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-outline" id="mg-preview-btn">Show what will change</button><button class="btn btn-primary" id="mg-go" disabled>Merge</button>`,
    onMount: (root) => {
      const q = (s) => root.querySelector(s);
      q('[data-cancel]').onclick = closeModal;
      let plan = null, planKey = '';
      const args = () => {
        const mode = (root.querySelector('input[name="mg-mode"]:checked') || {}).value || 'new';
        const brands = {};
        root.querySelectorAll('[data-mg-brand]').forEach(b => { const v = cleanBrandName(b.value); if(v) brands[b.dataset.mgBrand] = v; });
        // uuid[] as a Postgres array literal "{id,id}" (accepted by PostgREST and the local stand-in alike)
        const ids = '{' + picked.map(i => i.id).filter(isUuidLike).join(',') + '}';
        return mode === 'into'
          ? {p_ids: ids, p_name: q('#mg-rename').value.trim() || null, p_into: q('#mg-into').value || null, p_base_unit: null, p_brand_names: brands}
          : {p_ids: ids, p_name: q('#mg-name').value.trim(), p_into: null, p_base_unit: q('#mg-unit').value, p_brand_names: brands};
      };
      const stale = () => { if(plan && JSON.stringify(args()) !== planKey){ plan = null; q('#mg-go').disabled = true; q('#mg-preview').innerHTML = '<p class="hint">Something changed: press "Show what will change" again.</p>'; } };
      const syncMode = () => {
        const into = (root.querySelector('input[name="mg-mode"]:checked') || {}).value === 'into';
        q('#mg-new-row').style.display = into ? 'none' : '';
        q('#mg-into-row').style.display = into ? '' : 'none';
        stale();
      };
      root.querySelectorAll('input[name="mg-mode"]').forEach(r => r.onchange = syncMode);
      root.querySelectorAll('input, select').forEach(n => { n.addEventListener('input', stale); n.addEventListener('change', stale); });
      syncMode();
      const pv = q('#mg-preview-btn');
      pv.onclick = () => busy(pv, async () => {
        const a = args();
        for(const id of Object.keys(a.p_brand_names)) if(cleanBrandName(a.p_brand_names[id]) === false){ toast('A brand name can have at most 60 characters', 'error'); return; }
        if(!a.p_into && !a.p_name){ toast('Type the general ingredient\'s name', 'error'); q('#mg-name').focus(); return; }
        try{ plan = await cloud.rpc('merge_ingredients_preview', a); planKey = JSON.stringify(a); }
        catch(err){ plan = null; q('#mg-go').disabled = true; q('#mg-preview').innerHTML = `<div class="notice warn mg-error">${esc(friendlyError(err))}</div>`; return; }
        q('#mg-preview').innerHTML = mergePlanHtml(plan);
        q('#mg-go').disabled = false;
        q('#mg-preview').scrollIntoView({block: 'nearest'});
      }, 'Checking…');
      const go = q('#mg-go');
      go.onclick = () => busy(go, async () => {
        if(!plan) return;
        const a = JSON.parse(planKey);
        const seq = BO_MODAL_SEQ;
        let res;
        try{ res = await cloud.rpc('merge_ingredients', a); }
        catch(err){ q('#mg-preview').insertAdjacentHTML('afterbegin', `<div class="notice warn mg-error">${esc(friendlyError(err))}</div>`); toast(friendlyError(err), 'error'); return; }
        try{ await boLoad(); }catch(e){ console.warn(e); }
        boGuardLateClose(seq);
        ingPicked.clear();
        toast(`Merged into ${(res && res.general && res.general.name) || 'one ingredient'}`);
        closeModal();
        if(res && res.ingredient_id) navigate('ingredientDetail', res.ingredient_id); else rerender();
      }, 'Merging…');
    }});
}

// The preview (merge_ingredients_preview's plan) in plain words. Every name is escaped.
function mergePlanHtml(p){
  const g = p.general || {};
  const u = g.base_unit;
  const q = (n, unit) => formatQuantity(n, unit, unit);
  const src = p.sources || [];
  const rec = p.recipes || [], optR = p.option_recipes || [], lib = p.library_groups || [];
  return `<div class="card mg-plan">
    <h3 class="mg-plan-title">What will change</h3>
    <div class="mg-general"><b>${esc(g.name || '')}</b> ${g.is_new ? '<span class="badge badge-green">New ingredient</span>' : '<span class="badge badge-gray">Existing ingredient</span>'}
      <span class="text-light">counted in ${esc(unitLabel(u))} · stock ${g.is_new ? '' : esc(q(g.stock_now, u)) + ' → '}<b>${esc(q(g.stock_after, u))}</b></span></div>
    <table class="ri-table"><thead><tr><th>Ingredient</th><th>Becomes the brand</th><th class="num">Stock moved</th><th class="num">Purchases</th></tr></thead><tbody>
      ${src.map(s => `<tr><td><b>${esc(s.name)}</b></td>
        <td>${s.becomes_brand ? esc(s.becomes_brand) : '<span class="text-light">(only its brands)</span>'}${(s.brands || []).length ? `<div class="hint">+ its brands: ${(s.brands || []).map(b => esc(b.new_name) + (b.new_name !== b.name ? ` <span class="text-light">(was ${esc(b.name)})</span>` : '')).join(', ')}</div>` : ''}</td>
        <td class="num">${esc(q(s.stock, s.base_unit))}${s.base_unit !== u ? `<div class="hint">= ${esc(q(s.stock_in_general_unit, u))} (×${esc(String(Number(s.factor)))})</div>` : ''}</td>
        <td class="num">${esc(String(s.purchases || 0))}</td></tr>`).join('')}
    </tbody></table>
    <ul class="mg-list">
      <li>${rec.length ? `<b>${plural(rec.length, 'recipe')}</b> will use ${esc(g.name || '')}: ${rec.map(r => esc(r.name) + (r.is_production_recipe ? ' <span class="text-light">(production)</span>' : '') + (r.lines_combined ? ` <span class="text-light">(${plural(r.lines_combined, 'line')} combined)</span>` : '')).join(', ')}` : 'No recipe uses these ingredients.'}</li>
      ${optR.length ? `<li><b>Options on ${plural(optR.length, 'item')}</b> are moved: ${optR.map(r => esc(r.name)).join(', ')}</li>` : ''}
      ${lib.length ? `<li><b>Options library:</b> ${lib.map(x => esc(x.name)).join(', ')}</li>` : ''}
      ${p.open_qr_orders ? `<li>${plural(p.open_qr_orders, 'open QR order')} will take ${esc(g.name || '')} when paid.</li>` : ''}
      ${p.waste_records ? `<li>${plural(p.waste_records, 'waste record')} moved.</li>` : ''}
      <li>The picked ingredients are switched off and shown as "Merged into ${esc(g.name || '')}" under "Show inactive". Older counters can still upload.</li>
    </ul>
    <p class="hint mb-0">This can't be undone in one step. A backup first is a good idea (Backup &amp; import).</p>
  </div>`;
}
