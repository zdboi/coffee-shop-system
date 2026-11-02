/* =====================================================================
   BACK OFFICE — Start fresh before opening (release 1.3, owner item A4).
   A one-time clear of the TEST sales before a date the owner picks:
   sales (with their items, payments, refunds, rewards used and the stock
   they took / put back), cash pay-ins / outs, closed shifts and QR orders.
   Everything else is kept. The database does the work in ONE call
   (start_fresh, owner only); start_fresh_preview shows the numbers first.
   Steps on this screen (each one unlocks the next):
     1. download a backup (or tick "I already have a backup from today")
     2. pick the date -> preview (what goes, what stays, stock changes)
     3. no open shifts + type START FRESH -> start_fresh -> result, reload
   ===================================================================== */

const FRESH_CONFIRM = 'START FRESH';
// Kept for this page session only: a reload of the Back Office asks for the backup again.
const FRESH = {backupAt: null, haveBackup: false, when: '', preview: null, previewFor: '', openShifts: [], result: null};

const FRESH_REMOVE_LABEL = {
  sales: 'Sales', sale_items: 'Items on those sales', payments: 'Payments', refunds: 'Refunds and voids',
  loyalty_redemptions: 'Stamp card rewards used', shifts: 'Closed shifts', cash_movements: 'Cash pay-ins and pay-outs',
  qr_orders: 'QR orders', stock_lines: 'Stock lines from sales and refunds', customers_affected: 'Customers whose stamps and visits are recounted',
};
const FRESH_KEEP_LABEL = {
  sales: 'Sales on or after the date', shifts: 'Shifts', cash_movements: 'Cash pay-ins and pay-outs', qr_orders: 'QR orders',
  stock_lines: 'Other stock lines (purchases, production, waste, counts)', recipes: 'Recipes', ingredients: 'Ingredients',
  ingredient_brands: 'Ingredient brands', purchases: 'Purchases', production_batches: 'Production batches', waste: 'Waste records',
  staff: 'Staff', devices: 'Counters', customers: 'Customers', dining_tables: 'Tables and QR codes', floor_shapes: 'Floor plan shapes',
  audit_log: 'Audit log entries', sync_operations: 'Counter upload receipts',
};

// 'YYYY-MM-DDTHH:MM' in the shop's time zone <-> a Date
function freshLocalValue(d){
  const p = tzParts(d);
  return `${p.key}T${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`;
}
function freshParseLocal(v){
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(String(v || ''));
  if(!m) return null;
  const d = new Date(shopDayStart(m[1]).getTime() + (+m[2]) * 3600000 + (+m[3]) * 60000);
  return isNaN(d) ? null : d;
}
function freshDefaultValue(){ return shopTodayKey() + 'T00:00'; }
function freshUnlocked(){ return !!(FRESH.backupAt || FRESH.haveBackup); }
function freshDateProblem(v){
  const d = freshParseLocal(v);
  if(!d) return 'Choose a date and time.';
  if(d.getTime() > Date.now()) return 'The date can\'t be in the future. Pick today or an earlier day.';
  return '';
}
function freshNumber(n){ return Number(n || 0).toLocaleString('en-PH'); }
function freshCountRows(obj, labels){
  const keys = Object.keys(labels).filter(k => obj && k in obj);
  return keys.map(k => `<tr><td>${esc(labels[k])}</td><td class="num"><b>${freshNumber(obj[k])}</b></td></tr>`).join('');
}
function freshStockTable(list){
  if(!list || !list.length) return '<p class="hint">No stock numbers change (no sales took stock before this date).</p>';
  return `<div class="table-wrap fresh-stock"><table><thead><tr><th>Ingredient</th><th class="num">Stock now</th><th class="num">After Start fresh</th><th class="num">Change</th></tr></thead><tbody>
    ${list.map(x => {
      const now = num(x.stock_now), after = num(x.stock_after), diff = after - now, u = x.base_unit || '';
      return `<tr><td><b>${esc(x.name || 'Ingredient')}</b></td><td class="num">${fmtNum(now, 2)} ${esc(u)}</td><td class="num">${fmtNum(after, 2)} ${esc(u)}</td>
        <td class="num ${diff > 0 ? 'text-green' : diff < 0 ? 'text-red' : ''}">${diff > 0 ? '+' : ''}${fmtNum(diff, 2)} ${esc(u)}</td></tr>`;
    }).join('')}</tbody></table></div>`;
}
function freshShiftList(list){
  if(!list.length) return '';
  return `<ul class="fresh-shifts">${list.map(sh => {
    const dev = (state.devices || []).find(d => d.id === sh.device_id);
    const where = dev ? ([dev.device_tag, dev.device_name].filter(Boolean).join(' · ') || 'Counter') : 'A counter';
    return `<li><b>${esc(where)}</b> — ${esc(sh.cashier_name || 'staff')}${sh.shift_number ? ' · ' + esc(sh.shift_number) : ''}, open since ${esc(fmtShopDateTime(sh.opened_at))}</li>`;
  }).join('')}</ul>`;
}

/* ---- the card on Backup & import that opens this screen ---- */
function startFreshCardHtml(){
  return `<div class="section-title">Start fresh before opening</div>
    <div class="card fresh-entry">
      <p style="margin-top:0;"><b>Clear the test sales once, before the shop opens for real.</b> Your menu, stock setup, staff, counters and customers stay.</p>
      <p class="hint">Only for the owner, only once. You make a backup first and type a confirmation.</p>
      <button class="btn btn-outline btn-danger-line" id="btn-open-fresh" type="button">${icon('alert', {size: 18})} Open Start fresh</button>
    </div>`;
}

/* ---- the screen ---- */
function renderStartFresh(){
  if(state.route !== 'startFresh') return;
  const content = document.getElementById('content');
  setTopbarActions(`<button class="btn btn-outline" id="btn-fresh-back" type="button">${icon('chevron-left', {size: 18})} Backup &amp; import</button>`)
    .querySelector('#btn-fresh-back').onclick = () => navigate('backup');
  if(!BO.isOwner){
    content.innerHTML = emptyBlock('Only the shop owner can start fresh. Sign in with the owner\'s email.');
    return;
  }
  if(!FRESH.when) FRESH.when = freshDefaultValue();
  const unlocked = freshUnlocked();
  const maxVal = freshLocalValue(new Date());
  const r = FRESH.result;
  content.innerHTML = `<div class="settings-block fresh" style="max-width:860px;">
    <div class="fresh-warning" role="note">
      <div class="fresh-warning-ic">${icon('alert', {size: 34})}</div>
      <div><h2>Read this first</h2>
        <p>This removes sales and money records <b>for good</b>. Use it once, before opening day, to clear what you rang up while testing. It can't be undone, except by restoring a backup.</p></div>
    </div>

    <div class="grid grid-2 fresh-lists">
      <div class="card"><h3 class="fresh-h">${icon('trash', {size: 18})} Removed (before the date you pick)</h3>
        <ul><li>Sales rung up (or uploaded) before the date, with their items and payments</li><li>Held orders left from testing</li><li>Refunds and voids, and stamp card rewards used</li>
          <li>The stock those sales took out and refunds put back (so that stock comes back)</li>
          <li>Cash pay-ins and pay-outs</li><li>Closed shifts that only had these records</li><li>QR orders</li></ul></div>
      <div class="card"><h3 class="fresh-h">${icon('check', {size: 18})} Kept</h3>
        <ul><li>Menu, recipes, options and prices</li><li>Ingredients, brands, purchases, production, waste and stock counts</li>
          <li>Staff and PINs, counters, tables, QR codes and floor plan</li><li>Settings and the audit log</li>
          <li>Customers (their stamps, visits and total spent are recounted from the sales that stay)</li></ul></div>
    </div>

    ${r ? '' : staleShiftsAlertHtml()}
    ${r ? freshResultHtml(r) : `
    <ol class="fresh-steps">
      <li class="fresh-step ${unlocked ? 'done' : 'current'}" id="fresh-step1">
        <div class="fresh-step-head"><span class="fresh-num">1</span><h3>Download a backup first</h3>${unlocked ? '<span class="badge badge-green">Done</span>' : ''}</div>
        <p class="hint">A copy of everything as it is now, in one file. If something goes wrong, it can bring your records back. It has customers' names and numbers: keep it private.</p>
        <div class="field-inline"><button class="btn btn-primary" id="fresh-backup" type="button">${icon('download', {size: 18})} Download a backup</button>
          ${FRESH.backupAt ? `<span class="text-green"><b>Backup downloaded at ${esc(fmtShopTime(FRESH.backupAt))}</b></span>` : ''}</div>
        <label class="chk" style="margin-top:10px;"><input type="checkbox" id="fresh-have" ${FRESH.haveBackup ? 'checked' : ''}> I already have a backup from today</label>
      </li>
      <li class="fresh-step ${!unlocked ? 'locked' : FRESH.preview ? 'done' : 'current'}" id="fresh-step2" ${unlocked ? '' : 'aria-disabled="true"'}>
        <div class="fresh-step-head"><span class="fresh-num">2</span><h3>Pick the date and check what goes</h3>${!unlocked ? `<span class="badge badge-gray">${icon('lock', {size: 14})} Do step 1 first</span>` : ''}</div>
        <p class="hint">Everything rung up <b>before</b> this moment (shop time, ${esc(shopTz())}) is removed. Sales from this moment on stay. It can't be in the future.</p>
        <div class="field-inline">
          <div class="form-row" style="margin:0;"><label for="fresh-when">Remove everything before</label>
            <input type="datetime-local" id="fresh-when" value="${esc(FRESH.when)}" max="${esc(maxVal)}" ${unlocked ? '' : 'disabled'}></div>
          <button class="btn btn-outline" id="fresh-check" type="button" ${unlocked ? '' : 'disabled'}>Check what will be removed</button>
        </div>
        <div class="hint text-red" id="fresh-date-msg"></div>
        <div id="fresh-preview">${FRESH.preview && FRESH.previewFor === FRESH.when ? freshPreviewHtml(FRESH.preview) : ''}</div>
      </li>
      <li class="fresh-step ${FRESH.preview && FRESH.previewFor === FRESH.when ? 'current' : 'locked'}" id="fresh-step3">
        <div class="fresh-step-head"><span class="fresh-num">3</span><h3>Confirm</h3>${FRESH.preview && FRESH.previewFor === FRESH.when ? '' : `<span class="badge badge-gray">${icon('lock', {size: 14})} Do step 2 first</span>`}</div>
        <div id="fresh-confirm">${FRESH.preview && FRESH.previewFor === FRESH.when ? freshConfirmHtml(FRESH.preview) : '<p class="hint">Check what will be removed first.</p>'}</div>
      </li>
    </ol>`}
  </div>`;
  wireStartFresh(content);
}

function freshPreviewHtml(p){
  const rm = p.remove || {}, keep = p.keep || {};
  const nothing = !num(rm.sales) && !num(rm.cash_movements) && !num(rm.qr_orders) && !num(rm.shifts) && !num(rm.refunds) && !num(rm.stock_lines);
  return `<div class="fresh-preview">
    <p style="margin:12px 0 8px;">Before <b>${esc(fmtShopDateTime(p.before))}</b>:</p>
    ${nothing ? '<div class="notice ok">Nothing is dated before this moment, so nothing would be removed.</div>' : ''}
    <div class="grid grid-2">
      <div><h4 class="fresh-h4 text-red">Will be removed</h4><table class="fresh-count"><tbody>${freshCountRows(rm, FRESH_REMOVE_LABEL)}</tbody></table></div>
      <div><h4 class="fresh-h4">Will be kept</h4><table class="fresh-count"><tbody>${freshCountRows(keep, FRESH_KEEP_LABEL)}</tbody></table></div>
    </div>
    <h4 class="fresh-h4" style="margin-top:14px;">Stock changes</h4>
    <p class="hint" style="margin-top:0;">The stock the removed sales took out comes back (and stock put back by removed refunds goes out again).</p>
    ${freshStockTable(p.stock_changes)}
  </div>`;
}
function freshConfirmHtml(p){
  const open = FRESH.openShifts.length || num(p.open_shifts);
  if(open){
    return `<div class="notice error" id="fresh-open-shifts"><b>${plural(open, 'counter has an open shift', 'counters have open shifts')}.</b>
      Start fresh can't run while a shift is open. Close ${open === 1 ? 'it' : 'them'} at the counter (Close shift), then check again.
      ${freshShiftList(FRESH.openShifts)}</div>
      <button class="btn btn-outline" id="fresh-recheck" type="button">${icon('refresh', {size: 18})} Check again</button>`;
  }
  return `<div class="notice warn"><b>Last check.</b> This removes the records counted in step 2, for good. Counters show the change the next time they load.</div>
    <div class="form-row" style="max-width:360px;"><label for="fresh-type" class="fresh-type-label">Type <b>${FRESH_CONFIRM}</b> to confirm</label>
      <input id="fresh-type" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="${FRESH_CONFIRM}"></div>
    <div class="hint" id="fresh-type-msg"></div>
    <button class="btn btn-danger fresh-go" id="fresh-go" type="button" disabled>${icon('trash', {size: 18})} Start fresh now</button>`;
}
function freshResultHtml(r){
  return `<div class="card fresh-result">
    <div class="notice ok"><b>Done. The shop has started fresh.</b> Everything before ${esc(fmtShopDateTime(r.before))} was removed. The Back Office has loaded the new numbers.</div>
    <div class="grid grid-2">
      <div><h4 class="fresh-h4">Removed</h4><table class="fresh-count"><tbody>${freshCountRows(r.removed || {}, FRESH_REMOVE_LABEL)}</tbody></table></div>
      <div><h4 class="fresh-h4">Kept</h4><table class="fresh-count"><tbody>${freshCountRows(r.kept || {}, FRESH_KEEP_LABEL)}</tbody></table></div>
    </div>
    <h4 class="fresh-h4" style="margin-top:14px;">Stock changes</h4>
    ${freshStockTable(r.stock_changes)}
    <p class="hint">Counters pick up the change within a few minutes (or press Refresh on the counter). A sale dated before this moment that a counter uploads later is still saved, and marked "Needs review".</p>
    <div class="field-inline"><button class="btn btn-primary" id="fresh-done" type="button">Go to the dashboard</button></div>
  </div>`;
}

async function freshLoadOpenShifts(){
  try{ FRESH.openShifts = await cloud.select('shifts', {eq: {status: 'ACTIVE'}, order: 'opened_at.desc'}) || []; }
  catch(e){ FRESH.openShifts = []; }
}

function wireStartFresh(root){
  const $ = (id) => root.querySelector('#' + id);
  if($('fresh-done')) $('fresh-done').onclick = () => { FRESH.result = null; navigate('dashboard'); };
  if(FRESH.result) return;
  $('fresh-backup').onclick = (e) => busy(e.currentTarget, async () => {
    try{
      await exportBackup(false, 'before-start-fresh');
      FRESH.backupAt = nowISO();
      applyChanges([Ops.audit('Backup made', 'Before Start fresh')]).catch(() => {});
      renderStartFresh();
    }catch(err){ toast('The backup did not work: ' + friendlyError(err), 'error'); }
  }, 'Making the backup…');
  $('fresh-have').onchange = (e) => { FRESH.haveBackup = e.target.checked; if(!freshUnlocked()){ FRESH.preview = null; } renderStartFresh(); };
  const when = $('fresh-when'), msg = $('fresh-date-msg');
  when.onchange = when.oninput = () => {
    FRESH.when = when.value;
    msg.textContent = freshDateProblem(when.value);
    if(FRESH.preview && FRESH.previewFor !== FRESH.when){
      FRESH.preview = null;
      $('fresh-preview').innerHTML = '';
      $('fresh-confirm').innerHTML = '<p class="hint">The date changed. Check what will be removed again.</p>';
      const s3 = $('fresh-step3'); s3.classList.remove('current'); s3.classList.add('locked');
    }
  };
  $('fresh-check').onclick = (e) => busy(e.currentTarget, async () => {
    if(!freshUnlocked()) return;
    const problem = freshDateProblem(when.value);
    msg.textContent = problem;
    if(problem) return;
    const before = freshParseLocal(when.value);
    try{
      const [p] = await Promise.all([cloud.rpc('start_fresh_preview', {p_before: before.toISOString()}, {timeout: 60000}), freshLoadOpenShifts()]);
      FRESH.preview = p || {};
      FRESH.previewFor = when.value;
      renderStartFresh();
      const pv = document.getElementById('fresh-preview');
      if(pv) pv.scrollIntoView({block: 'nearest'});
    }catch(err){ msg.textContent = friendlyError(err); }
  }, 'Checking…');
  const recheck = $('fresh-recheck');
  if(recheck) recheck.onclick = () => busy(recheck, async () => {
    const before = freshParseLocal(FRESH.previewFor);
    try{
      const [p] = await Promise.all([cloud.rpc('start_fresh_preview', {p_before: before.toISOString()}, {timeout: 60000}), freshLoadOpenShifts()]);
      FRESH.preview = p || {};
      renderStartFresh();
      if(!FRESH.openShifts.length && !num(FRESH.preview.open_shifts)) toast('All shifts are closed now');
    }catch(err){ toast(friendlyError(err), 'error'); }
  }, 'Checking…');
  const type = $('fresh-type'), go = $('fresh-go'), tmsg = $('fresh-type-msg');
  if(type && go){
    type.oninput = () => {
      const v = type.value;
      go.disabled = v !== FRESH_CONFIRM;
      tmsg.textContent = !v || v === FRESH_CONFIRM ? '' : (v.trim().toUpperCase() === FRESH_CONFIRM ? 'Type it exactly: START FRESH, in capital letters, with one space.' : '');
    };
    type.onpaste = (e) => e.preventDefault();      // typed on purpose, not pasted
    go.onclick = () => busy(go, async () => {
      if(type.value !== FRESH_CONFIRM){ tmsg.textContent = ERROR_TEXT.CONFIRM_REQUIRED; return; }
      const before = freshParseLocal(FRESH.previewFor);
      if(!before || before.getTime() > Date.now()){ tmsg.textContent = ERROR_TEXT.BAD_DATE; return; }
      const ok = await confirmDialog(`Remove all sales and money records dated before <b>${esc(fmtShopDateTime(before))}</b>? This can't be undone.`, 'Yes, start fresh');
      if(!ok) return;
      let res;
      try{ res = await cloud.rpc('start_fresh', {p_before: before.toISOString(), p_confirm: type.value}, {timeout: 120000}); }
      catch(err){
        const code = (err && err.code) || errorCode(err && err.message);
        if(code === 'SHIFT_STILL_OPEN'){ await freshLoadOpenShifts(); FRESH.preview = Object.assign({}, FRESH.preview, {open_shifts: Math.max(1, FRESH.openShifts.length)}); renderStartFresh(); }
        toast(friendlyError(err), 'error');
        return;
      }
      FRESH.result = res || {done: true, before: before.toISOString()};
      FRESH.preview = null; FRESH.previewFor = '';
      BO.salesCache.clear();
      try{ await boLoad(); }catch(e){ console.warn('reload after Start fresh failed', e); }
      try{ await refreshReviewCount(); }catch(e){}
      updateNavBadges();
      toast('Started fresh');
      if(state.route === 'startFresh'){
        document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.route === 'backup'));
        renderStartFresh();
      }
    }, 'Starting fresh…');
  }
}
