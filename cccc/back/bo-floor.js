/* =====================================================================
   BACK OFFICE — floor plan editor (release 1.2), shown on Tables & QR codes.

   The plan is a 1000 x 1000 grid (database contract 008, section A); the
   screen scales it to fit. Every item stores its TOP-LEFT corner
   (pos_x, pos_y), its size (width, height) and a rotation in degrees that
   turns it around its CENTRE (like CSS transform: rotate()).
     - dining tables (kind DINE_IN): shape SQUARE / ROUND / RECT, seats.
       pos_x empty = "not on the plan yet" -> shown in the tray.
     - floor_shapes: COUNTER, WALL, DOOR, PLANT, LABEL, OTHER (shape RECT / ROUND).
   Nothing is saved while the owner drags: "Save layout" sends every change
   in ONE apply_changes call (all or nothing). Leaving with unsaved changes
   asks first.
   Pointer events (mouse, pen and touch on a tablet) and the keyboard:
   arrow keys move the selected item (Shift = bigger steps), R / Shift+R
   turn it 15 degrees, Delete takes it off the plan, Escape lets go.
   ===================================================================== */

const FP_SIZE = 1000;          // plan units across and down
const FP_SNAP = 10;            // grid step when "Snap to grid" is on
const FP_MIN = 20;             // smallest width / height offered here (the database allows 10 for tables, 1 for shapes)
const FP_TABLE_SHAPES = {
  SQUARE: {label: 'Square table', short: 'Square', w: 80, h: 80, ic: 'table-square'},
  ROUND:  {label: 'Round table',  short: 'Round',  w: 90, h: 90, ic: 'table-round'},
  RECT:   {label: 'Long table',   short: 'Long',   w: 180, h: 80, ic: 'table-square'},
};
const FP_KINDS = {
  COUNTER: {label: 'Counter', w: 300, h: 90,  shape: 'RECT'},
  WALL:    {label: 'Wall',    w: 300, h: 16,  shape: 'RECT'},
  DOOR:    {label: 'Door',    w: 120, h: 50,  shape: 'RECT'},
  PLANT:   {label: 'Plant',   w: 60,  h: 60,  shape: 'ROUND'},
  LABEL:   {label: 'Label',   w: 160, h: 50,  shape: 'RECT'},
  OTHER:   {label: 'Other',   w: 100, h: 100, shape: 'RECT'},
};
const FP_TABLE_FIELDS = ['label', 'shape', 'pos_x', 'pos_y', 'width', 'height', 'rotation', 'seats'];
const FP_SHAPE_FIELDS = ['kind', 'label', 'shape', 'pos_x', 'pos_y', 'width', 'height', 'rotation', 'sort_order'];

// The draft being edited. tables / shapes: id -> editable copy. Kept across re-draws of the
// Tables screen (e.g. after "Add tables") while there are unsaved changes.
const FP = {tables: null, shapes: null, deleted: new Set(), newTables: new Set(), dirty: false, sel: null, snap: true, drag: null};

function fpNum(v, d){ const n = Number(v); return isFinite(n) ? n : d; }
function fpClamp(v, lo, hi){ return Math.min(hi, Math.max(lo, v)); }
function fpRound(v){ return Math.round(v); }
function fpSnapV(v){ return FP.snap ? Math.round(v / FP_SNAP) * FP_SNAP : Math.round(v); }
function fpIsDineIn(t){ return t && t.kind !== 'TAKEAWAY'; }
function fpTableDraft(t){
  const s = FP_TABLE_SHAPES[t.shape] ? t.shape : 'SQUARE';
  return {id: t.id, label: t.label || '', shape: s,
    pos_x: t.pos_x == null || t.pos_x === '' ? null : fpNum(t.pos_x, 0), pos_y: t.pos_y == null || t.pos_y === '' ? null : fpNum(t.pos_y, 0),
    width: fpNum(t.width, FP_TABLE_SHAPES[s].w) || FP_TABLE_SHAPES[s].w, height: fpNum(t.height, FP_TABLE_SHAPES[s].h) || FP_TABLE_SHAPES[s].h,
    rotation: fpNum(t.rotation, 0) || 0, seats: t.seats == null || t.seats === '' ? null : fpNum(t.seats, null),
    active: t.active !== false, touched: new Set()};
}
function fpShapeDraft(f){
  const k = FP_KINDS[f.kind] ? f.kind : 'OTHER';
  return {id: f.id, kind: k, label: f.label == null ? '' : String(f.label), shape: f.shape === 'ROUND' ? 'ROUND' : 'RECT',
    pos_x: fpNum(f.pos_x, 0), pos_y: fpNum(f.pos_y, 0), width: fpNum(f.width, FP_KINDS[k].w) || FP_KINDS[k].w, height: fpNum(f.height, FP_KINDS[k].h) || FP_KINDS[k].h,
    rotation: fpNum(f.rotation, 0) || 0, sort_order: fpNum(f.sort_order, 0), created_at: f.created_at || null, isNew: false, touched: new Set()};
}
// Builds the draft from the saved data, or (with unsaved changes) keeps the draft and only
// takes in what changed elsewhere: new tables, removed tables, and the fields not edited here.
function fpSync(){
  const tables = state.tables.filter(fpIsDineIn);
  const shapes = state.floorShapes || [];
  if(!FP.tables || !FP.dirty){
    FP.tables = new Map(tables.map(t => [t.id, fpTableDraft(t)]));
    FP.shapes = new Map(shapes.map(f => [f.id, fpShapeDraft(f)]));
    FP.deleted = new Set(); FP.newTables = new Set(); FP.dirty = false;
  } else {
    tables.forEach(t => {
      const d = FP.tables.get(t.id);
      if(!d){ FP.tables.set(t.id, fpTableDraft(t)); return; }
      const fresh = fpTableDraft(t);
      FP_TABLE_FIELDS.forEach(k => { if(!d.touched.has(k)) d[k] = fresh[k]; });
      d.active = fresh.active;
    });
    [...FP.tables.keys()].forEach(id => { if(!FP.newTables.has(id) && !tables.some(t => t.id === id)) FP.tables.delete(id); });
    shapes.forEach(f => { if(!FP.shapes.has(f.id) && !FP.deleted.has(f.id)) FP.shapes.set(f.id, fpShapeDraft(f)); });
  }
  if(FP.sel && !fpSelected()) FP.sel = null;
}
function fpSelected(){
  if(!FP.sel) return null;
  const d = FP.sel.type === 't' ? FP.tables.get(FP.sel.id) : FP.shapes.get(FP.sel.id);
  if(!d || (FP.sel.type === 't' && d.pos_x == null)) return null;
  return d;
}
function fpPlaced(d){ return d.pos_x != null && d.pos_y != null; }
function fpTouch(d, keys){ keys.forEach(k => d.touched.add(k)); fpSetDirty(true); }
function fpSetDirty(on){
  FP.dirty = !!on;
  const st = document.getElementById('fp-status');
  if(st){
    st.textContent = FP.dirty ? 'Unsaved changes' : 'All changes saved';
    st.className = 'fp-status' + (FP.dirty ? ' dirty' : '');
  }
  const dis = document.getElementById('fp-discard'); if(dis) dis.disabled = !FP.dirty;
}
// Called by navigate() / the refresh in bo-core.js.
function fpHasUnsaved(){ return !!(FP.dirty && FP.tables); }
function fpForget(){ FP.dirty = false; FP.tables = null; FP.shapes = null; FP.sel = null; }
window.addEventListener('beforeunload', (e) => { if(fpHasUnsaved() && state.route === 'tables'){ e.preventDefault(); e.returnValue = ''; } });

/* ---------- geometry ---------- */
function fpBox(d){ return {x: d.pos_x, y: d.pos_y, w: d.width, h: d.height}; }
// keeps an item inside the plan: size first, then position
function fpFit(d){
  d.width = fpClamp(fpRound(d.width), FP_MIN, FP_SIZE);
  d.height = fpClamp(fpRound(d.height), d.kind === 'WALL' ? 10 : FP_MIN, FP_SIZE);   // walls may be thin
  if(fpPlaced(d)){
    d.pos_x = fpClamp(fpRound(d.pos_x), 0, FP_SIZE - d.width);
    d.pos_y = fpClamp(fpRound(d.pos_y), 0, FP_SIZE - d.height);
  }
  d.rotation = ((fpRound(d.rotation) % 360) + 360) % 360;
}
// a free spot for a new item of this size (first gap on a coarse grid, else the middle)
function fpFreeSpot(w, h){
  const boxes = [];
  FP.tables.forEach(d => { if(fpPlaced(d)) boxes.push(fpBox(d)); });
  FP.shapes.forEach(d => boxes.push(fpBox(d)));
  const hit = (x, y) => boxes.some(b => x < b.x + b.w + 10 && x + w + 10 > b.x && y < b.y + b.h + 10 && y + h + 10 > b.y);
  for(let y = 40; y + h <= FP_SIZE - 20; y += 50){
    for(let x = 40; x + w <= FP_SIZE - 20; x += 50){ if(!hit(x, y)) return {x, y}; }
  }
  return {x: Math.round((FP_SIZE - w) / 2), y: Math.round((FP_SIZE - h) / 2)};
}

/* ---------- drawing ---------- */
function fpSeatsText(d){ return d.seats ? plural(d.seats, 'seat') : ''; }
function fpItemName(d, type){
  if(type === 't') return d.label || 'Table';
  return (d.label && d.label.trim()) || FP_KINDS[d.kind].label;
}
function fpItemHtml(d, type){
  const sel = FP.sel && FP.sel.type === type && FP.sel.id === d.id;
  const cls = type === 't'
    ? `fp-item fp-table fp-${d.shape.toLowerCase()}${d.active ? '' : ' fp-off'}`
    : `fp-item fp-shape fp-k-${d.kind.toLowerCase()}${d.shape === 'ROUND' ? ' fp-round' : ''}`;
  const name = fpItemName(d, type);
  const aria = type === 't'
    ? `${name}${d.seats ? ', ' + fpSeatsText(d) : ''}${d.active ? '' : ', turned off'}. Arrow keys move it, R turns it.`
    : `${FP_KINDS[d.kind].label}${d.label ? ': ' + d.label : ''}. Arrow keys move it, R turns it.`;
  const inner = type === 't'
    ? `<span class="fp-lb">${esc(name)}</span>${d.seats ? `<small>${esc(fpSeatsText(d))}</small>` : ''}`
    : (d.kind === 'WALL' || (d.kind === 'PLANT' && !d.label) ? '' : `<span class="fp-sl">${esc(name)}</span>`);   // walls and plain plants: no text
  return `<div class="${cls}${sel ? ' selected' : ''}" data-fp="${type}:${esc(d.id)}" tabindex="0" role="button" aria-pressed="${sel ? 'true' : 'false'}" aria-label="${esc(aria)}" style="${fpItemStyle(d)}">${inner}
    ${sel ? '<span class="fp-h fp-h-e" data-h="e" aria-hidden="true"></span><span class="fp-h fp-h-s" data-h="s" aria-hidden="true"></span><span class="fp-h fp-h-se" data-h="se" aria-hidden="true"></span>' : ''}</div>`;
}
function fpItemStyle(d){
  const p = (v) => (v / FP_SIZE * 100).toFixed(3) + '%';
  return `left:${p(d.pos_x)};top:${p(d.pos_y)};width:${p(d.width)};height:${p(d.height)};transform:rotate(${fpRound(d.rotation)}deg);`;
}
function fpDrawPlan(){
  const plan = document.getElementById('fp-plan');
  if(!plan) return;
  const items = [];
  // shapes under the tables, in their saved order
  [...FP.shapes.values()].sort((a, b) => a.sort_order - b.sort_order).forEach(d => items.push(fpItemHtml(d, 's')));
  [...FP.tables.values()].filter(fpPlaced).forEach(d => items.push(fpItemHtml(d, 't')));
  plan.innerHTML = items.join('') + (items.length ? '' : `<div class="fp-empty">Drag a table from “Not on the plan yet”, or use the buttons above to add tables and shapes.</div>`);
}
function fpRedrawItem(type, id){
  const plan = document.getElementById('fp-plan');
  const d = type === 't' ? FP.tables.get(id) : FP.shapes.get(id);
  const el = plan && plan.querySelector(`[data-fp="${type}:${CSS.escape(id)}"]`);
  if(!el || !d) return fpDrawPlan();
  el.setAttribute('style', fpItemStyle(d));
}
function fpDrawTray(){
  const tray = document.getElementById('fp-tray');
  if(!tray) return;
  const list = [...FP.tables.values()].filter(d => !fpPlaced(d)).sort((a, b) => String(a.label).localeCompare(String(b.label), undefined, {numeric: true}));
  tray.innerHTML = `<h3 class="fp-side-title">Not on the plan yet</h3>
    ${list.length ? `<p class="hint" style="margin:0 0 8px;">Drag a table onto the plan, or tap it to put it in a free spot.</p>
      <div class="fp-chips">${list.map(d => `<button type="button" class="fp-chip" data-fp-tray="${esc(d.id)}" aria-label="Put ${esc(d.label)} on the plan">${icon(FP_TABLE_SHAPES[d.shape].ic, {size: 20})}<span>${esc(d.label)}</span></button>`).join('')}</div>`
      : '<p class="hint" style="margin:0;">Every table is on the plan.</p>'}`;
}
function fpDrawInspector(){
  const box = document.getElementById('fp-inspector');
  if(!box) return;
  const d = fpSelected();
  if(!d){ box.innerHTML = `<h3 class="fp-side-title">Selected</h3><p class="hint" style="margin:0;">Tap a table or a shape on the plan to change its name, size or direction.</p>`; return; }
  const isT = FP.sel.type === 't';
  const rotRow = `<div class="form-row"><label>Direction</label><div class="fp-rot">
      <button type="button" class="btn btn-sm btn-outline" id="fp-rot-l" aria-label="Turn 15 degrees to the left">${icon('chevron-left', {size: 18})} 15°</button>
      <span class="fp-rot-val" id="fp-rot-val">${fpRound(d.rotation)}°</span>
      <button type="button" class="btn btn-sm btn-outline" id="fp-rot-r" aria-label="Turn 15 degrees to the right">15° ${icon('chevron-right', {size: 18})}</button></div></div>`;
  const sizeRow = `<div class="form-grid fp-grid2"><div class="form-row"><label for="fp-w">Width</label><input id="fp-w" type="number" min="${FP_MIN}" max="${FP_SIZE}" step="10" value="${fpRound(d.width)}"></div>
      <div class="form-row"><label for="fp-h">Height</label><input id="fp-h" type="number" min="${d.kind === 'WALL' ? 10 : FP_MIN}" max="${FP_SIZE}" step="10" value="${fpRound(d.height)}"></div></div>`;
  box.innerHTML = isT ? `<h3 class="fp-side-title">Table</h3>
      <div class="form-row"><label for="fp-label">Name</label><input id="fp-label" maxlength="30" value="${esc(d.label)}"></div>
      <div class="form-grid fp-grid2">
        <div class="form-row"><label for="fp-seats">Seats</label><input id="fp-seats" type="number" min="1" max="99" step="1" value="${d.seats == null ? '' : esc(d.seats)}" placeholder="—"></div>
        <div class="form-row"><label for="fp-shape">Shape</label><select id="fp-shape">${Object.keys(FP_TABLE_SHAPES).map(k => `<option value="${k}" ${d.shape === k ? 'selected' : ''}>${FP_TABLE_SHAPES[k].short}</option>`).join('')}</select></div>
      </div>
      ${sizeRow}${rotRow}
      ${d.active ? '' : '<p class="hint">This table\'s QR code is turned off.</p>'}
      <button type="button" class="btn btn-sm btn-outline btn-block" id="fp-unplace">Take off the plan</button>`
    : `<h3 class="fp-side-title">Shape</h3>
      <div class="form-grid fp-grid2">
        <div class="form-row"><label for="fp-kind">Kind</label><select id="fp-kind">${Object.keys(FP_KINDS).map(k => `<option value="${k}" ${d.kind === k ? 'selected' : ''}>${FP_KINDS[k].label}</option>`).join('')}</select></div>
        <div class="form-row"><label for="fp-sshape">Outline</label><select id="fp-sshape"><option value="RECT" ${d.shape === 'RECT' ? 'selected' : ''}>Box</option><option value="ROUND" ${d.shape === 'ROUND' ? 'selected' : ''}>Round</option></select></div>
      </div>
      <div class="form-row"><label for="fp-slabel">Text on it (optional)</label><input id="fp-slabel" maxlength="40" value="${esc(d.label)}" placeholder="${esc(FP_KINDS[d.kind].label)}"></div>
      ${sizeRow}${rotRow}
      <button type="button" class="btn btn-sm btn-danger btn-block" id="fp-delete">${icon('trash', {size: 18})} Delete shape</button>`;
  const $ = (id) => box.querySelector('#' + id);
  const type = FP.sel.type, id = d.id;
  const redraw = () => { fpFit(d); fpRedrawItem(type, id); };
  const redrawFull = () => { fpFit(d); fpDrawPlan(); };
  $('fp-w').oninput = () => { const v = fpNum($('fp-w').value, 0); if(v >= FP_MIN){ d.width = v; fpTouch(d, ['width', 'pos_x']); redraw(); } };
  $('fp-h').oninput = () => { const v = fpNum($('fp-h').value, 0); if(v >= (d.kind === 'WALL' ? 10 : FP_MIN)){ d.height = v; fpTouch(d, ['height', 'pos_y']); redraw(); } };
  $('fp-w').onchange = () => { $('fp-w').value = fpRound(d.width); };
  $('fp-h').onchange = () => { $('fp-h').value = fpRound(d.height); };
  $('fp-rot-l').onclick = () => fpRotate(d, -15);
  $('fp-rot-r').onclick = () => fpRotate(d, 15);
  if(isT){
    $('fp-label').oninput = () => { d.label = $('fp-label').value.replace(/[<>]/g, ''); fpTouch(d, ['label']); redrawFull(); };
    $('fp-seats').oninput = () => {
      const raw = $('fp-seats').value.trim();
      d.seats = raw === '' ? null : Math.round(fpNum(raw, 0)) || null;
      fpTouch(d, ['seats']); redrawFull();
    };
    $('fp-shape').onchange = () => {
      const was = d.shape; d.shape = $('fp-shape').value;
      // a round or square table stays square-ish, a long table gets its usual length
      if(d.shape === 'RECT' && was !== 'RECT' && d.width <= d.height){ d.width = FP_TABLE_SHAPES.RECT.w; d.height = FP_TABLE_SHAPES.RECT.h; }
      if(d.shape !== 'RECT' && was === 'RECT'){ const s = Math.max(d.height, FP_TABLE_SHAPES[d.shape].h); d.width = s; d.height = s; }
      fpTouch(d, ['shape', 'width', 'height', 'pos_x', 'pos_y']); fpFit(d); fpDrawPlan(); fpDrawInspector();
    };
    $('fp-unplace').onclick = () => fpUnplace(d);
  } else {
    $('fp-kind').onchange = () => { d.kind = $('fp-kind').value; fpTouch(d, ['kind']); fpDrawPlan(); fpDrawInspector(); };
    $('fp-sshape').onchange = () => { d.shape = $('fp-sshape').value; fpTouch(d, ['shape']); redrawFull(); };
    $('fp-slabel').oninput = () => { d.label = $('fp-slabel').value.replace(/[<>]/g, '').slice(0, 40); fpTouch(d, ['label']); redrawFull(); };
    $('fp-delete').onclick = () => fpDeleteShape(d);
  }
}
function fpRefreshInspectorNumbers(){
  const d = fpSelected(); if(!d) return;
  const w = document.getElementById('fp-w'), h = document.getElementById('fp-h'), r = document.getElementById('fp-rot-val');
  if(w && document.activeElement !== w) w.value = fpRound(d.width);
  if(h && document.activeElement !== h) h.value = fpRound(d.height);
  if(r) r.textContent = fpRound(d.rotation) + '°';
}
function fpDrawAll(){ fpDrawPlan(); fpDrawTray(); fpDrawInspector(); fpSetDirty(FP.dirty); }
function fpFocusSelected(){
  if(!FP.sel) return;
  const el = document.querySelector(`#fp-plan [data-fp="${FP.sel.type}:${CSS.escape(FP.sel.id)}"]`);
  if(el) el.focus({preventScroll: true});
}

/* ---------- actions ---------- */
function fpSelect(type, id, focus){
  const same = FP.sel && FP.sel.type === type && FP.sel.id === id;
  FP.sel = type ? {type, id} : null;
  if(!same){ fpDrawPlan(); fpDrawInspector(); }
  if(focus) fpFocusSelected();
}
function fpRotate(d, by){
  d.rotation = d.rotation + by;
  fpTouch(d, ['rotation']); fpFit(d);
  fpRedrawItem(FP.sel.type, d.id); fpRefreshInspectorNumbers();
}
function fpUnplace(d){
  d.pos_x = null; d.pos_y = null;
  fpTouch(d, ['pos_x', 'pos_y']);
  FP.sel = null; fpDrawAll();
  toast(`${d.label} is off the plan (its QR code still works)`);
}
function fpDeleteShape(d){
  FP.shapes.delete(d.id);
  if(!d.isNew) FP.deleted.add(d.id);
  FP.sel = null; fpSetDirty(true); fpDrawAll();
}
function fpPlaceTable(id, x, y){
  const d = FP.tables.get(id); if(!d) return;
  if(x == null){ const s = fpFreeSpot(d.width, d.height); x = s.x; y = s.y; }
  d.pos_x = fpSnapV(x); d.pos_y = fpSnapV(y);
  fpTouch(d, ['pos_x', 'pos_y', 'width', 'height', 'shape']); fpFit(d);
  FP.sel = {type: 't', id};
  fpDrawAll(); fpFocusSelected();
}
function fpNextTableLabel(){
  const labels = new Set(state.tables.map(t => String(t.label).toLowerCase()));
  FP.tables.forEach(d => labels.add(String(d.label).toLowerCase()));
  const nums = [...labels].map(l => Number((/(\d+)\s*$/.exec(l) || [])[1])).filter(n => n > 0);
  let n = nums.length ? Math.max(...nums) + 1 : 1;
  while(labels.has(('table ' + n).toLowerCase())) n++;
  return 'Table ' + n;
}
function fpAddTable(shape){
  const def = FP_TABLE_SHAPES[shape] || FP_TABLE_SHAPES.SQUARE;
  const id = uid();
  const spot = fpFreeSpot(def.w, def.h);
  const d = {id, label: fpNextTableLabel(), shape: FP_TABLE_SHAPES[shape] ? shape : 'SQUARE', pos_x: fpSnapV(spot.x), pos_y: fpSnapV(spot.y), width: def.w, height: def.h,
    rotation: 0, seats: shape === 'RECT' ? 6 : (shape === 'ROUND' ? 2 : 4), active: true, touched: new Set(FP_TABLE_FIELDS), qr_token: randomToken()};
  fpFit(d);
  FP.tables.set(id, d); FP.newTables.add(id);
  FP.sel = {type: 't', id};
  fpSetDirty(true); fpDrawAll(); fpFocusSelected();
}
function fpAddShape(kind){
  const def = FP_KINDS[kind]; if(!def) return;
  const id = uid();
  const spot = fpFreeSpot(def.w, def.h);
  const maxOrder = [...FP.shapes.values()].reduce((m, s) => Math.max(m, s.sort_order), 0);
  const d = {id, kind, label: kind === 'LABEL' ? 'Label' : '', shape: def.shape, pos_x: fpSnapV(spot.x), pos_y: fpSnapV(spot.y), width: def.w, height: def.h,
    rotation: 0, sort_order: maxOrder + 1, created_at: null, isNew: true, touched: new Set(FP_SHAPE_FIELDS)};
  fpFit(d);
  FP.shapes.set(id, d);
  FP.sel = {type: 's', id};
  fpSetDirty(true); fpDrawAll(); fpFocusSelected();
}
function fpDiscard(){
  FP.dirty = false; FP.tables = null; FP.sel = null;
  fpSync(); fpDrawAll();
  toast('Changes to the floor plan were undone');
}

/* ---------- saving: everything in ONE call ---------- */
function fpSaveOps(){
  const errors = [];
  const ops = [];
  const now = nowISO();
  const allLabels = new Map();     // lower-case label -> id (takeaway codes too)
  state.tables.filter(t => !fpIsDineIn(t)).forEach(t => allLabels.set(String(t.label).trim().toLowerCase(), t.id));
  let changedTables = 0, changedShapes = 0;
  FP.tables.forEach(d => {
    const label = String(d.label || '').replace(/\s+/g, ' ').trim();
    if(!label){ errors.push('Every table needs a name.'); return; }
    if(label.length > 30){ errors.push(`"${label}" is too long (30 characters at most).`); return; }
    const k = label.toLowerCase();
    if(allLabels.has(k) && allLabels.get(k) !== d.id){ errors.push(`Two tables are called "${label}". Give each table its own name.`); return; }
    allLabels.set(k, d.id);
    if(d.seats != null && !(Number.isInteger(d.seats) && d.seats >= 1 && d.seats <= 99)){ errors.push(`${label}: seats must be a whole number from 1 to 99 (or empty).`); return; }
    fpFit(d);
    const row = {label, shape: d.shape, pos_x: fpPlaced(d) ? d.pos_x : null, pos_y: fpPlaced(d) ? d.pos_y : null,
      width: d.width, height: d.height, rotation: d.rotation, seats: d.seats == null ? null : d.seats};
    if(FP.newTables.has(d.id)){
      const n = Number((/(\d+)\s*$/.exec(label) || [])[1]) || (state.tables.length + 1);
      ops.push(Ops.upsert('dining_tables', Object.assign({id: d.id, kind: 'DINE_IN', qr_token: d.qr_token || randomToken(), active: true, sort_order: n, created_at: now, updated_at: now}, row)));
      changedTables++;
      return;
    }
    const t = state.tables.find(x => x.id === d.id);
    if(!t) return;
    const base = fpTableDraft(t);
    const diff = {};
    FP_TABLE_FIELDS.forEach(f => { if(d.touched.has(f) && String(row[f]) !== String(f === 'label' ? String(t.label || '').trim() : base[f])) diff[f] = row[f]; });
    if(Object.keys(diff).length){ ops.push(Ops.update('dining_tables', Object.assign({id: d.id, updated_at: now}, diff))); changedTables++; }
  });
  FP.shapes.forEach(d => {
    fpFit(d);
    const label = String(d.label || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    const row = {id: d.id, kind: d.kind, label: label || null, shape: d.shape, pos_x: d.pos_x, pos_y: d.pos_y, width: d.width, height: d.height,
      rotation: d.rotation, sort_order: Math.round(d.sort_order), created_at: d.created_at || now, updated_at: now};
    if(d.isNew){ ops.push(Ops.upsert('floor_shapes', row)); changedShapes++; return; }
    const f = (state.floorShapes || []).find(x => x.id === d.id);
    const base = f ? fpShapeDraft(f) : null;
    if(!base || FP_SHAPE_FIELDS.some(k => String(row[k] == null ? '' : row[k]) !== String(base[k] == null ? '' : base[k]))){ ops.push(Ops.upsert('floor_shapes', row)); changedShapes++; }
  });
  FP.deleted.forEach(id => { ops.push(Ops.del('floor_shapes', id)); changedShapes++; });
  return {errors, ops, changedTables, changedShapes};
}
async function fpSave(btn){
  const r = fpSaveOps();
  if(r.errors.length){ toast(r.errors[0], 'error'); return; }
  if(!r.ops.length){ fpSetDirty(false); toast('Nothing to save — the plan is as saved'); return; }
  const parts = [];
  if(r.changedTables) parts.push(plural(r.changedTables, 'table'));
  if(r.changedShapes) parts.push(plural(r.changedShapes, 'shape'));
  r.ops.push(Ops.audit('Floor plan saved', parts.join(' and ') + ' changed'));
  await busy(btn, async () => {
    const ok = await boSave(r.ops, {success: 'Floor plan saved — counters show it within a few minutes'});
    if(ok){ FP.dirty = false; FP.tables = null; renderTables(); }
  });
}

/* ---------- the card on the Tables screen ---------- */
function floorPlanCardHtml(){
  return `<div class="card fp-card" id="fp-card">
    <div class="fp-toolbar">
      <div class="fp-add" role="group" aria-label="Add to the plan">
        ${Object.keys(FP_TABLE_SHAPES).map(k => `<button type="button" class="btn btn-sm btn-outline" data-fp-add-table="${k}">${icon(FP_TABLE_SHAPES[k].ic, {size: 20})} ${esc(FP_TABLE_SHAPES[k].label)}</button>`).join('')}
        <label class="sr-only" for="fp-add-shape">Add a shape</label>
        <select class="filter fp-add-shape" id="fp-add-shape"><option value="">${'+ Add a shape…'}</option>${Object.keys(FP_KINDS).map(k => `<option value="${k}">${esc(FP_KINDS[k].label)}</option>`).join('')}</select>
      </div>
      <div class="fp-save-bar">
        <label class="chk fp-snap"><input type="checkbox" id="fp-snap" ${FP.snap ? 'checked' : ''}> Snap to grid</label>
        <span class="fp-status" id="fp-status" role="status" aria-live="polite"></span>
        <button type="button" class="btn btn-sm btn-ghost" id="fp-discard">Undo changes</button>
        <button type="button" class="btn btn-sm btn-primary" id="fp-save">${icon('check', {size: 18})} Save layout</button>
      </div>
    </div>
    <div class="fp-layout">
      <div class="fp-stage"><div class="fp-plan" id="fp-plan" aria-label="Floor plan. Choose an item, then use the arrow keys to move it."></div></div>
      <aside class="fp-side">
        <div class="fp-panel" id="fp-tray"></div>
        <div class="fp-panel" id="fp-inspector"></div>
      </aside>
    </div>
    <p class="hint" style="margin-bottom:0;">Drag to move. Drag the corner dots to change the size. Keyboard: arrow keys move the selected item (hold Shift for bigger steps), R turns it, Delete takes it off the plan. Nothing is saved until you press <b>Save layout</b>.</p>
  </div>`;
}
function wireFloorPlan(root){
  fpSync();
  const card = root.querySelector('#fp-card');
  if(!card) return;
  fpDrawAll();
  card.querySelectorAll('[data-fp-add-table]').forEach(b => b.onclick = () => fpAddTable(b.dataset.fpAddTable));
  const addShape = card.querySelector('#fp-add-shape');
  addShape.onchange = () => { const k = addShape.value; addShape.value = ''; if(k) fpAddShape(k); };
  card.querySelector('#fp-snap').onchange = (e) => { FP.snap = e.target.checked; };
  card.querySelector('#fp-discard').onclick = async () => {
    if(!FP.dirty) return;
    if(await confirmDialog('Undo every change to the floor plan since it was last saved?', 'Undo changes')) fpDiscard();
  };
  const saveBtn = card.querySelector('#fp-save');
  saveBtn.onclick = () => fpSave(saveBtn);
  const plan = card.querySelector('#fp-plan');
  fpWirePlanPointer(plan);
  fpWirePlanKeys(plan);
  fpWireTray(card.querySelector('#fp-tray'), plan);
}
function fpPlanScale(plan){ const r = plan.getBoundingClientRect(); return {rect: r, s: r.width / FP_SIZE}; }
function fpItemFromEl(el){
  const m = /^([ts]):(.+)$/.exec(el.dataset.fp || '');
  if(!m) return null;
  const d = m[1] === 't' ? FP.tables.get(m[2]) : FP.shapes.get(m[2]);
  return d ? {type: m[1], id: m[2], d} : null;
}
function fpWirePlanPointer(plan){
  plan.addEventListener('pointerdown', (e) => {
    if(e.button != null && e.button > 0) return;
    const itemEl = e.target.closest('.fp-item');
    if(!itemEl){ if(FP.sel){ FP.sel = null; fpDrawPlan(); fpDrawInspector(); } return; }
    const it = fpItemFromEl(itemEl); if(!it) return;
    e.preventDefault();
    const handle = e.target.closest('.fp-h');
    if(!(FP.sel && FP.sel.type === it.type && FP.sel.id === it.id)){ fpSelect(it.type, it.id, false); }
    const {s} = fpPlanScale(plan);
    FP.drag = {mode: handle ? handle.dataset.h : 'move', type: it.type, id: it.id, pid: e.pointerId, x0: e.clientX, y0: e.clientY, s,
      orig: {x: it.d.pos_x, y: it.d.pos_y, w: it.d.width, h: it.d.height}, moved: false};
    try{ plan.setPointerCapture(e.pointerId); }catch(err){}
  });
  plan.addEventListener('pointermove', (e) => {
    const g = FP.drag; if(!g || g.pid !== e.pointerId) return;
    const d = g.type === 't' ? FP.tables.get(g.id) : FP.shapes.get(g.id); if(!d) return;
    const du = (e.clientX - g.x0) / g.s, dv = (e.clientY - g.y0) / g.s;
    if(!g.moved && Math.abs(du) + Math.abs(dv) < 3 / g.s) return;
    g.moved = true;
    if(g.mode === 'move'){
      d.pos_x = fpSnapV(g.orig.x + du); d.pos_y = fpSnapV(g.orig.y + dv);
      fpTouch(d, ['pos_x', 'pos_y']);
    } else {
      // the handles sit on the item's own (turned) sides: turn the pointer movement back first
      const a = -d.rotation * Math.PI / 180;
      const lu = du * Math.cos(a) - dv * Math.sin(a), lv = du * Math.sin(a) + dv * Math.cos(a);
      if(g.mode.includes('e')) d.width = Math.max(FP_MIN, fpSnapV(g.orig.w + lu));
      if(g.mode.includes('s')) d.height = Math.max(d.kind === 'WALL' ? 10 : FP_MIN, fpSnapV(g.orig.h + lv));
      fpTouch(d, ['width', 'height', 'pos_x', 'pos_y']);
    }
    fpFit(d);
    fpRedrawItem(g.type, g.id);
    fpRefreshInspectorNumbers();
  });
  const end = (e) => {
    const g = FP.drag; if(!g || g.pid !== e.pointerId) return;
    FP.drag = null;
    try{ plan.releasePointerCapture(e.pointerId); }catch(err){}
    fpFocusSelected();
  };
  plan.addEventListener('pointerup', end);
  plan.addEventListener('pointercancel', end);
}
function fpWirePlanKeys(plan){
  plan.addEventListener('focusin', (e) => {
    const el = e.target.closest('.fp-item');
    if(!el || FP.drag) return;
    const it = fpItemFromEl(el);
    if(it && !(FP.sel && FP.sel.type === it.type && FP.sel.id === it.id)){ fpSelect(it.type, it.id, true); }
  });
  plan.addEventListener('keydown', (e) => {
    const el = e.target.closest('.fp-item'); if(!el) return;
    const it = fpItemFromEl(el); if(!it) return;
    const d = it.d;
    const step = e.shiftKey ? 50 : (FP.snap ? FP_SNAP : 1);
    const moves = {ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step]};
    if(moves[e.key]){
      e.preventDefault();
      d.pos_x += moves[e.key][0]; d.pos_y += moves[e.key][1];
      fpTouch(d, ['pos_x', 'pos_y']); fpFit(d); fpRedrawItem(it.type, it.id);
      return;
    }
    if(e.key === 'r' || e.key === 'R'){ e.preventDefault(); fpRotate(d, e.shiftKey ? -15 : 15); return; }
    if(e.key === 'Delete' || e.key === 'Backspace'){
      e.preventDefault();
      if(it.type === 't') fpUnplace(d); else fpDeleteShape(d);
      plan.focus();
      return;
    }
    if(e.key === 'Escape'){ e.preventDefault(); FP.sel = null; fpDrawPlan(); fpDrawInspector(); plan.focus(); }
  });
  plan.tabIndex = -1;
}
// The tray: drag a chip onto the plan (pointer), or tap / press Enter to put it in a free spot.
function fpWireTray(tray, plan){
  let g = null, justDragged = false;
  tray.addEventListener('pointerdown', (e) => {
    const chip = e.target.closest('[data-fp-tray]'); if(!chip) return;
    if(e.button != null && e.button > 0) return;
    g = {id: chip.dataset.fpTray, pid: e.pointerId, x0: e.clientX, y0: e.clientY, ghost: null, chip};
    try{ chip.setPointerCapture(e.pointerId); }catch(err){}
  });
  tray.addEventListener('pointermove', (e) => {
    if(!g || g.pid !== e.pointerId) return;
    if(!g.ghost){
      if(Math.abs(e.clientX - g.x0) + Math.abs(e.clientY - g.y0) < 8) return;
      const d = FP.tables.get(g.id); if(!d) return;
      const {s} = fpPlanScale(plan);
      g.ghost = document.createElement('div');
      g.ghost.className = `fp-ghost fp-${d.shape.toLowerCase()}`;
      g.ghost.style.width = Math.max(36, d.width * s) + 'px';
      g.ghost.style.height = Math.max(36, d.height * s) + 'px';
      g.ghost.textContent = d.label;
      document.body.appendChild(g.ghost);
      g.w = d.width; g.h = d.height;
    }
    e.preventDefault();
    g.ghost.style.left = (e.clientX - g.ghost.offsetWidth / 2) + 'px';
    g.ghost.style.top = (e.clientY - g.ghost.offsetHeight / 2) + 'px';
    const r = plan.getBoundingClientRect();
    plan.classList.toggle('fp-drop', e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom);
  });
  const finish = (e, cancelled) => {
    if(!g || g.pid !== e.pointerId) return;
    const cur = g; g = null;
    try{ cur.chip.releasePointerCapture(e.pointerId); }catch(err){}
    plan.classList.remove('fp-drop');
    if(!cur.ghost) return;            // a tap: the click handler puts it in a free spot
    cur.ghost.remove();
    justDragged = true; setTimeout(() => { justDragged = false; }, 400);
    if(cancelled) return;
    const {rect, s} = fpPlanScale(plan);
    if(e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) return;
    fpPlaceTable(cur.id, (e.clientX - rect.left) / s - cur.w / 2, (e.clientY - rect.top) / s - cur.h / 2);
  };
  tray.addEventListener('pointerup', (e) => finish(e, false));
  tray.addEventListener('pointercancel', (e) => finish(e, true));
  tray.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-fp-tray]'); if(!chip) return;
    if(justDragged) return;
    fpPlaceTable(chip.dataset.fpTray);
  });
}
