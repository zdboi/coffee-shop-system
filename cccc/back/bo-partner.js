/* =====================================================================
   BACK OFFICE — release 1.5 (Wave 3, B15), owner only: batches made by a
   partner branch (TCO, the owner's first shop: a supplier ticked
   "Partner branch") and the "To return to TCO" list.
     partner_batch_preview / produce_partner_batch  — the batch (the product's
         stock goes up; our ingredients are NOT taken; its cost = what we owe)
     v_partner_to_return                             — open debts
     partner_return (ingredients back, partly or fully) / partner_pay (pesos)
   Returning ingredients or paying is settling the batch's cost: never counted
   again as ingredients used, waste or an expense (the server keeps it so).
   The production form itself (batch size, "Max I can make") is in bo-stock.js.
   ===================================================================== */

function partnerSuppliers(){ return state.suppliers.filter(s => s.is_partner_branch).sort(byName); }
function partnerName(id){ const s = state.suppliers.find(x => x.id === id); return s ? s.name : 'partner branch'; }
// "TCO" when there is one partner branch, else "partner branches"
function partnerListTitle(){ const p = partnerSuppliers(); return p.length === 1 ? p[0].name : 'partner branches'; }
function scaleText(scale){
  const s = Number(scale);
  if(!(s > 0)) return '';
  if(Math.abs(s - 0.5) < 1e-9) return '½×';
  return String(Number(s.toFixed(3))) + '×';
}
function debtKindLabel(k){ return k === 'PESOS' ? 'Pesos' : 'Same ingredients back'; }

/* ---- "To return to TCO" ---- */
let PARTNER_DEBTS = null;     // rows of v_partner_to_return
async function loadPartnerDebts(){
  if(!BO.has15){ PARTNER_DEBTS = []; return PARTNER_DEBTS; }
  PARTNER_DEBTS = await cloud.selectAll('v_partner_to_return', {order: 'production_date.asc,created_at.asc'}) || [];
  return PARTNER_DEBTS;
}
// rows -> [{debt_id, kind, supplier_id, supplier_name, batch_number, production_date, product_name, lines: [...], value_remaining}]
function groupPartnerDebts(rows){
  const by = new Map();
  (rows || []).forEach(r => {
    if(!by.has(r.debt_id)) by.set(r.debt_id, {debt_id: r.debt_id, kind: r.kind, supplier_id: r.supplier_id, supplier_name: r.supplier_name, batch_id: r.batch_id,
      batch_number: r.batch_number, production_date: r.production_date, product_name: r.product_name, created_at: r.created_at, lines: [], value_remaining: 0});
    const d = by.get(r.debt_id);
    d.lines.push(r);
    d.value_remaining += num(r.value_remaining);
  });
  return [...by.values()];
}
// The section on the Production screen. Draws into `box` (loads the view first).
async function drawToReturn(box){
  if(!box) return;
  if(!BO.has15){ box.innerHTML = ''; return; }
  box.innerHTML = '<div class="loading-line">Loading what we owe…</div>';
  try{ await loadPartnerDebts(); }catch(e){ box.innerHTML = emptyBlock(esc(friendlyError(e))); return; }
  if(!box.isConnected) return;
  const debts = groupPartnerDebts(PARTNER_DEBTS);
  const partners = partnerSuppliers();
  const total = debts.reduce((s, d) => s + d.value_remaining, 0);
  box.innerHTML = `
    <div class="section-title" id="to-return-title">To return to ${esc(partnerListTitle())}</div>
    ${!partners.length && !debts.length ? `<p class="hint">To record batches made by TCO, tick <b>Partner branch</b> on TCO in <a class="linklike" data-go-sup>Suppliers</a>. Then choose "Made by a partner branch" when you produce.</p>` : ''}
    ${debts.length ? `<p class="hint" style="margin-top:-6px;">${plural(debts.length, 'batch', 'batches')} not settled yet · worth ${fmtMoney(total)} at our costs. Returning ingredients or paying settles the batch's cost: it is not counted again as an expense or as ingredients used.</p>
    <div class="table-wrap" id="to-return-list"><table><thead><tr><th>Batch</th><th>From</th><th>What we owe</th><th class="num">Still owed</th><th></th></tr></thead><tbody>
      ${debts.map(d => `<tr data-debt="${esc(d.debt_id)}"><td><b>${esc(d.product_name || 'Batch')}</b><div class="hint">${esc(d.batch_number || '')} · ${fmtDay(d.production_date)}</div></td>
        <td>${esc(d.supplier_name || '')}<div class="hint">${esc(debtKindLabel(d.kind))}</div></td>
        <td>${d.kind === 'PESOS' ? `${fmtMoney(d.lines[0].remaining)} <span class="text-light">of ${fmtMoney(d.lines[0].owed)}</span>`
          : d.lines.map(l => `<div>${esc(formatQuantity(num(l.remaining), l.unit, l.unit, 3))} ${esc(l.ingredient_name || ingName(l.ingredient_id))}${num(l.returned) > 0 ? ` <span class="text-light">(of ${esc(formatQuantity(num(l.owed), l.unit, l.unit, 3))})</span>` : ''}</div>`).join('')}</td>
        <td class="num"><b>${fmtMoney(d.value_remaining)}</b></td>
        <td class="row-actions">${d.kind === 'PESOS' ? `<button class="btn btn-sm btn-primary" data-debt-pay="${esc(d.debt_id)}">Pay</button>` : `<button class="btn btn-sm btn-primary" data-debt-return="${esc(d.debt_id)}">Return ingredients</button>`}</td></tr>`).join('')}
    </tbody></table></div>` : (partners.length ? emptyBlock(`Nothing to return to ${esc(partnerListTitle())}.`) : '')}`;
  box.querySelectorAll('[data-go-sup]').forEach(a => a.onclick = () => navigate('suppliers'));
  box.querySelectorAll('[data-debt-return]').forEach(b => b.onclick = () => openPartnerReturn(debts.find(d => d.debt_id === b.dataset.debtReturn), box));
  box.querySelectorAll('[data-debt-pay]').forEach(b => b.onclick = () => openPartnerPay(debts.find(d => d.debt_id === b.dataset.debtPay), box));
}
// After a return / payment: reload the shop data (stock) and the list.
async function afterSettlement(box, seq, msg){
  try{ await boLoad(); }catch(e){ console.warn(e); }
  boGuardLateClose(seq);
  toast(msg);
  closeModal();
  if(state.route === 'production') renderProduction(); else if(box) drawToReturn(box);
}
function openPartnerReturn(d, box){
  if(!d) return;
  const today = shopTodayKey();
  const body = `
    <p class="hint" style="margin-top:0;">${esc(d.product_name || 'Batch')} ${esc(d.batch_number || '')}, made by <b>${esc(d.supplier_name || '')}</b> on ${esc(fmtDay(d.production_date))}. Enter what you give back now (all of it or part of it). It leaves our stock as "Returned to partner".</p>
    <div class="table-wrap" style="box-shadow:none;"><table class="kit-table"><thead><tr><th>Ingredient</th><th class="num">Still owed</th><th class="num">In stock</th><th>Returning now</th></tr></thead><tbody>
      ${d.lines.map(l => { const ing = ingredientById(l.ingredient_id) || {base_unit: l.unit};
        return `<tr><td><b>${esc(l.ingredient_name || ingName(l.ingredient_id))}</b></td><td class="num">${esc(formatQuantity(num(l.remaining), l.unit, l.unit, 3))}</td>
        <td class="num">${esc(formatQuantity(ingredientStock(l.ingredient_id), l.unit, l.unit, 2))}</td>
        <td><div class="sc-new"><input type="number" step="any" min="0" data-ret="${esc(l.ingredient_id)}" value="${esc(String(Number(num(l.remaining).toFixed(6))))}" aria-label="Returning now">
          <select data-ret-unit="${esc(l.ingredient_id)}" aria-label="Unit">${unitOptionsHtml(l.unit, l.unit, ing.weight_g_per_ml)}</select></div></td></tr>`; }).join('')}
    </tbody></table></div>
    <div class="form-grid" style="margin-top:10px;">
      <div class="form-row"><label for="pr-ret-date">Returned on</label><input type="date" id="pr-ret-date" value="${esc(today)}" max="${esc(keyAddDays(today, 1))}"></div>
      <div class="form-row"><label for="pr-ret-note">Note (optional)</label><input id="pr-ret-note" maxlength="200" placeholder="e.g. Dropped off by Jun"></div>
    </div>
    <p class="hint" id="pr-ret-warn" role="status"></p>`;
  openModal({title: 'Return ingredients', wide: true, body,
    foot: `<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" id="pr-ret-save">Record return</button>`,
    onMount: (root) => {
      const q = (s) => root.querySelector(s);
      q('[data-cancel]').onclick = closeModal;
      const warn = () => {
        const low = d.lines.filter(l => { const inp = root.querySelector(`[data-ret="${CSS.escape(l.ingredient_id)}"]`), sel = root.querySelector(`[data-ret-unit="${CSS.escape(l.ingredient_id)}"]`); const ing = ingredientById(l.ingredient_id);
          const v = inp && inp.value !== '' ? typedToBase(inp.value, sel.value, l.unit, ing && ing.weight_g_per_ml) : 0; return v > ingredientStock(l.ingredient_id) + 1e-6; });
        q('#pr-ret-warn').innerHTML = low.length ? `<span class="text-red">Our recorded stock of ${low.map(l => esc(l.ingredient_name || ingName(l.ingredient_id))).join(', ')} goes below zero. Record any missing purchase too.</span>` : '';
      };
      root.querySelectorAll('[data-ret-unit]').forEach(sel => { const inp = root.querySelector(`[data-ret="${CSS.escape(sel.dataset.retUnit)}"]`); const ing = ingredientById(sel.dataset.retUnit); if(ing && Number(ing.weight_g_per_ml) > 0) sel.dataset.w = String(ing.weight_g_per_ml); wireUnitConvert(inp, sel, warn); inp.addEventListener('input', warn); });
      warn();
      const save = q('#pr-ret-save');
      save.onclick = () => busy(save, async () => {
        const lines = [];
        for(const l of d.lines){
          const inp = root.querySelector(`[data-ret="${CSS.escape(l.ingredient_id)}"]`), sel = root.querySelector(`[data-ret-unit="${CSS.escape(l.ingredient_id)}"]`);
          if(inp.value === '' || Number(inp.value) === 0) continue;
          if(!(Number(inp.value) > 0)){ toast('Amounts must be above 0 (or leave the line empty)', 'error'); return; }
          const ing = ingredientById(l.ingredient_id);
          const base = typedToBase(inp.value, sel.value, l.unit, ing && ing.weight_g_per_ml);
          if(base == null){ toast(friendlyError('BAD_UNIT'), 'error'); return; }
          if(base > num(l.remaining) + 0.000001){ toast(`${l.ingredient_name || ingName(l.ingredient_id)}: ${friendlyError('RETURN_EXCEEDS_DEBT')}`, 'error'); return; }
          lines.push({ingredient_id: l.ingredient_id, quantity: Number(inp.value), unit: sel.value});
        }
        if(!lines.length){ toast('Enter what you are returning', 'error'); return; }
        const seq = BO_MODAL_SEQ;
        let r;
        try{ r = await cloud.rpc('partner_return', {p: {id: uid(), debt_id: d.debt_id, returned_on: q('#pr-ret-date').value || shopTodayKey(), note: q('#pr-ret-note').value.trim().slice(0, 200) || null, lines}}); }
        catch(e){ toast(friendlyError(e), 'error'); return; }
        const below = r && Array.isArray(r.stock_below_zero) ? r.stock_below_zero : [];
        await afterSettlement(box, seq, (r && r.status === 'SETTLED' ? 'Returned. This batch is settled.' : 'Return recorded. The rest stays on the list.')
          + (below.length ? ` Stock of ${below.map(ingName).join(', ')} is now below zero.` : ''));
      }, 'Saving…');
    }});
}
function openPartnerPay(d, box){
  if(!d) return;
  const left = num(d.lines[0] && d.lines[0].remaining), today = shopTodayKey();
  const body = `
    <p class="hint" style="margin-top:0;">${esc(d.product_name || 'Batch')} ${esc(d.batch_number || '')}, made by <b>${esc(d.supplier_name || '')}</b> on ${esc(fmtDay(d.production_date))}. Still owed: <b>${fmtMoney(left)}</b>. Paying part of it is fine.</p>
    <div class="form-grid">
      <div class="form-row"><label for="pp-amount">Amount paid (₱)</label><input type="number" id="pp-amount" step="any" min="0" max="${esc(String(left))}" value="${esc(String(left))}"></div>
      <div class="form-row"><label for="pp-date">Paid on</label><input type="date" id="pp-date" value="${esc(today)}" max="${esc(keyAddDays(today, 1))}"></div>
    </div>
    <div class="form-row"><label for="pp-note">Note (optional)</label><input id="pp-note" maxlength="200" placeholder="e.g. GCash ref 1234"></div>
    <p class="hint">Not an expense: the batch already carries this cost.</p>`;
  openModal({title: 'Pay ' + esc(d.supplier_name || 'partner'), body,
    foot: `<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" id="pp-save">Record payment</button>`,
    onMount: (root) => {
      const q = (s) => root.querySelector(s);
      q('[data-cancel]').onclick = closeModal;
      const save = q('#pp-save');
      save.onclick = () => busy(save, async () => {
        const amt = Math.round(Number(q('#pp-amount').value) * 100) / 100;
        if(!(amt > 0)){ toast('Enter an amount above ₱0', 'error'); q('#pp-amount').focus(); return; }
        if(amt > left + 0.01){ toast(friendlyError('PAYMENT_TOO_LARGE'), 'error'); return; }
        const seq = BO_MODAL_SEQ;
        let r;
        try{ r = await cloud.rpc('partner_pay', {p: {id: uid(), debt_id: d.debt_id, paid_on: q('#pp-date').value || shopTodayKey(), amount: amt, note: q('#pp-note').value.trim().slice(0, 200) || null}}); }
        catch(e){ toast(friendlyError(e), 'error'); return; }
        await afterSettlement(box, seq, r && r.status === 'SETTLED' ? 'Paid in full. This batch is settled.' : `Payment recorded. ${fmtMoney(r && r.remaining)} still owed.`);
      }, 'Saving…');
    }});
}
