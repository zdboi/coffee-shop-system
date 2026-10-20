/* =====================================================================
   BACK OFFICE — backups and importing.
   * Back up: everything in the shop's database -> one JSON file (or a
     chosen folder, or Google Drive). Optional automatic backups per device.
   * Import: a backup from this Back Office, a backup file from the old
     offline Inventory / POS apps, or the old apps' data read straight
     from this browser (IndexedDB "coffeeShopDB").
     - Old ids become new UUIDs; the old id is kept in `local_id`.
     - Rows already imported (same local_id / same id) are skipped, so
       running it twice is safe. Links between records are kept.
     - Nothing already in the database is changed or deleted (insert-only).
     - Old staff keep their old PINs (staff_import_legacy_pin).
   ===================================================================== */

const BACKUP_TABLES = ['categories', 'suppliers', 'ingredients', 'recipes', 'recipe_ingredients', 'purchases', 'production_batches', 'waste',
  'inventory_transactions', 'staff', 'dining_tables', 'devices', 'stores', 'customers', 'shifts', 'sales', 'sale_items', 'payments',
  'refunds', 'cash_movements', 'qr_orders', 'audit_log'];
// insert order (parents first). devices / stores are never imported (they belong to real counters / this shop).
const IMPORT_ORDER = ['categories', 'suppliers', 'ingredients', 'recipes', 'recipe_ingredients', 'purchases', 'production_batches', 'waste',
  'staff', 'dining_tables', 'customers', 'shifts', 'sales', 'sale_items', 'payments', 'refunds', 'cash_movements', 'inventory_transactions',
  'qr_orders', 'audit_log'];
const TABLE_LABEL = {categories: 'categories', suppliers: 'suppliers', ingredients: 'ingredients', recipes: 'recipes', recipe_ingredients: 'recipe ingredient lines',
  purchases: 'purchases', production_batches: 'production batches', waste: 'waste records', inventory_transactions: 'stock movements', staff: 'staff',
  dining_tables: 'tables', customers: 'customers', shifts: 'shifts', sales: 'sales', sale_items: 'sale lines', payments: 'payments', refunds: 'refunds / voids',
  cash_movements: 'cash pay-ins / pay-outs', qr_orders: 'QR orders', audit_log: 'audit log entries'};
// old app store -> new table
const OLD_STORES = {categories: 'categories', suppliers: 'suppliers', ingredients: 'ingredients', recipes: 'recipes', recipeIngredients: 'recipe_ingredients',
  purchases: 'purchases', productionBatches: 'production_batches', waste: 'waste', inventoryTransactions: 'inventory_transactions', users: 'staff',
  shifts: 'shifts', sales: 'sales', saleItems: 'sale_items', payments: 'payments', refunds: 'refunds', cashMovements: 'cash_movements', auditLog: 'audit_log'};

/* ================= backup (export) ================= */
async function buildCloudBackup(onProgress){
  const data = {};
  let i = 0;
  for(const t of BACKUP_TABLES){
    if(onProgress) onProgress(i++, BACKUP_TABLES.length, t);
    data[t] = await cloud.selectAll(t, {order: 'id.asc'});
  }
  // counters' secret keys / logins are not needed in a backup
  data.devices = (data.devices || []).map(d => { const x = Object.assign({}, d); delete x.device_key; delete x.auth_user_id; return x; });
  const srow = await cloud.select('settings', {limit: 1});
  data.settings = (srow && srow[0]) || null;
  return {app: 'CCCC Back Office', format: 'cccc-backup', version: 5, exported_at: nowISO(),
    business: state.business ? {id: state.business.id, name: state.business.name} : null, data};
}
async function exportBackup(silent, tag){
  const payload = await buildCloudBackup();
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const filename = `${fileNameSlug()}-backup${tag ? '-' + tag : ''}-${stamp}.json`;
  const content = JSON.stringify(payload);
  let wroteToFolder = false;
  try{ wroteToFolder = await writeBackupToFolder(filename, content, num(state.settings.backup_retain_count) || 10); }
  catch(e){ console.warn('folder backup failed, downloading instead', e); }
  if(!wroteToFolder) downloadFile(filename, content, 'application/json');
  state.settings.lastLocalBackup = nowISO();
  saveDeviceSettings();
  const total = BACKUP_TABLES.reduce((s, t) => s + (payload.data[t] || []).length, 0);
  if(!silent) toast(wroteToFolder ? `Backup saved in your folder — ${filename}` : `Backup downloaded (${total.toLocaleString('en-PH')} records)`);
  return {filename, total};
}
async function maybeAutoBackup(){
  const s = state.settings;
  if(!s.autoBackupLocal && !s.autoBackupGDrive) return;
  if(s.autoBackupLocal && isBackupDue(s.lastLocalBackup, s.backupFrequency)){
    try{ await exportBackup(true, 'auto'); toast('Automatic backup saved'); }
    catch(e){ console.warn(e); toast('The automatic backup did not work — back up from Backup & import.', 'warn'); }
  }
  if(s.autoBackupGDrive && isBackupDue(s.lastGDriveBackup, s.backupFrequency)){
    if(!s.gdriveConnected || !gdriveAccessToken) toast('Automatic Google Drive backup skipped — connect Google Drive again in Backup & import.', 'warn');
    else { try{ await gdriveBackup(true, () => buildCloudBackup()); }catch(e){ toast('The Google Drive backup did not work. Your data is safe online; it will try again later.', 'warn'); } }
  }
}
window.addEventListener('online', () => { if(BO.started) maybeAutoBackup().catch(() => {}); });

/* ================= reading old data ================= */
async function readOldBrowserData(){
  if(typeof indexedDB === 'undefined') return null;
  try{
    if(indexedDB.databases){
      const list = await indexedDB.databases();
      if(!list.some(d => d.name === 'coffeeShopDB')) return null;
    }
  }catch(e){ /* ask the database directly below */ }
  const db = await new Promise((resolve) => {
    let req;
    try{ req = indexedDB.open('coffeeShopDB'); }catch(e){ resolve(null); return; }
    let created = false;
    req.onupgradeneeded = (e) => { created = true; e.target.transaction.abort(); };   // it didn't exist: don't create it
    req.onsuccess = () => resolve(created ? null : req.result);
    req.onerror = () => resolve(null);
  });
  if(!db) return null;
  const data = {};
  for(const s of [...db.objectStoreNames]){
    if(s === 'deviceConfig') continue;
    data[s] = await new Promise((resolve) => {
      try{
        const r = db.transaction(s, 'readonly').objectStore(s).getAll();
        r.onsuccess = () => resolve(r.result || []); r.onerror = () => resolve([]);
      }catch(e){ resolve([]); }
    });
  }
  db.close();
  if(Array.isArray(data.settings)) data.settings = data.settings.find(x => x.key === 'app') || null;
  const any = Object.keys(OLD_STORES).some(k => (data[k] || []).length);
  if(!any) return null;
  return {app: 'Old Inventory / POS apps (this browser)', exported_at: nowISO(), data};
}
function payloadKind(p){
  if(!p || typeof p !== 'object' || !p.data || typeof p.data !== 'object') return null;
  if(p.format === 'cccc-backup' || Array.isArray(p.data.recipe_ingredients) || Array.isArray(p.data.inventory_transactions)) return 'cccc';
  if(Object.keys(OLD_STORES).some(k => Array.isArray(p.data[k]))) return 'old';
  return null;
}
function summarizePayload(p){
  const kind = payloadKind(p);
  const counts = {};
  if(kind === 'old') Object.keys(OLD_STORES).forEach(k => { const n = (p.data[k] || []).length; if(n) counts[OLD_STORES[k]] = (counts[OLD_STORES[k]] || 0) + n; });
  if(kind === 'cccc') IMPORT_ORDER.forEach(t => { const n = (p.data[t] || []).length; if(n) counts[t] = n; });
  return {kind, counts, hasSettings: !!p.data.settings, exportedAt: p.exported_at, appName: p.app_name_at_export || p.app || '', business: p.business};
}

/* ================= converting old (camelCase) records ================= */
async function stableUuid(key){
  if(!(window.crypto && crypto.subtle)) return uid();
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  const b = new Uint8Array(buf).slice(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50; b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));
const nOrNull = (v) => v === '' || v == null || !isFinite(Number(v)) ? null : Number(v);
const dateOnly = (v) => { if(!v) return null; const s = String(v); if(/^\d{4}-\d{2}-\d{2}$/.test(s)) return s; const d = new Date(s); return isNaN(d) ? null : dayKeyOf(d); };
const isoOrNull = (v) => { if(!v) return null; const d = new Date(v); return isNaN(d) ? null : d.toISOString(); };
const oldModifier = (m, mapId) => m ? {group: m.group || '', label: m.label || '', price_delta: num(m.price_delta != null ? m.price_delta : m.priceDelta),
  ingredient_id: mapId(m.ingredient_id || m.ingredientId) || null, ingredient_qty_delta: num(m.ingredient_qty_delta != null ? m.ingredient_qty_delta : m.ingredientQtyDelta)} : m;
const PAY_IDS = ['CASH', 'GCASH', 'MAYA', 'CARD', 'BANK', 'OTHER'];

// Turns an old-app payload into rows for the new tables. `existing` = what is already in the
// database (by local_id and by name), so earlier imports are recognised and links reuse their ids.
async function convertOldPayload(payload, existing, notes){
  const src = payload.data;
  const biz = state.business.id;
  const idMap = new Map();       // `${table}:${oldId}` and plain oldId -> new uuid
  const skipInsert = new Set();  // new ids that already exist (not sent again)
  const keyOf = (t, oldId) => t + ':' + String(oldId);
  for(const [store, table] of Object.entries(OLD_STORES)){
    const ex = existing[table] || {byLocal: new Map(), byName: new Map()};
    for(const r of (src[store] || [])){
      if(!r || r.id == null || r._synthetic) continue;
      const oldId = String(r.id);
      let nid = ex.byLocal.get(oldId);
      if(!nid && (table === 'categories' || table === 'suppliers' || table === 'staff')){
        nid = ex.byName.get(String(r.name || '').trim().toLowerCase());     // same name already in the shop: link to it
      }
      if(nid) skipInsert.add(nid);
      else nid = await stableUuid(`${biz}:${table}:${oldId}`);
      idMap.set(keyOf(table, oldId), nid);
      if(!idMap.has(oldId)) idMap.set(oldId, nid);
    }
  }
  const ref = (table, v) => (v == null || v === '') ? null : (idMap.get(keyOf(table, v)) || null);
  const anyRef = (v) => (v == null || v === '') ? null : (idMap.get(String(v)) || null);
  const modMap = (v) => anyRef(v) || (isUuid(v) && state.ingredients.some(i => i.id === v) ? v : null);
  const staffByName = new Map();
  (src.users || []).forEach(u => staffByName.set(String(u.name || '').trim().toLowerCase(), ref('staff', u.id)));
  state.staff.forEach(u => { const k = String(u.name || '').trim().toLowerCase(); if(!staffByName.has(k)) staffByName.set(k, u.id); });
  const staffNamed = (n) => n ? (staffByName.get(String(n).trim().toLowerCase()) || null) : null;

  const out = {}; IMPORT_ORDER.forEach(t => { out[t] = []; });
  const legacyPins = [];
  let unlinked = 0, held = 0, already = 0;
  const add = (table, oldId, row) => {
    row.id = ref(table, oldId); row.local_id = String(oldId);
    if(skipInsert.has(row.id)) already++; else out[table].push(row);
  };
  // what the refund check below needs to know (every finished sale, every refund and every sale / put-back stock line,
  // whether it is new or already in the shop)
  const saleInfo = new Map(), refundSeen = [], stockSeen = [], ingredientInfo = new Map();
  const ok = (cond) => { if(!cond) unlinked++; return cond; };
  const each = (store, fn) => (src[store] || []).forEach(r => { if(r && r.id != null && !r._synthetic) fn(r); });

  each('categories', r => add('categories', r.id, {name: String(r.name || 'Category').slice(0, 80)}));
  each('suppliers', r => add('suppliers', r.id, {name: String(r.name || 'Supplier').slice(0, 80), contact: r.contact || '', phone: r.phone || '', email: r.email || '', address: r.address || '', notes: r.notes || ''}));
  each('ingredients', r => ingredientInfo.set(ref('ingredients', r.id), {name: r.name || 'an ingredient', unit: r.base_unit || ''}));
  each('ingredients', r => add('ingredients', r.id, {name: r.name || 'Ingredient', category_id: ref('categories', r.categoryId || r.category_id), supplier_id: ref('suppliers', r.supplierId || r.supplier_id),
    base_unit: r.base_unit || 'pcs', reorder_level: num(r.reorder_level), notes: r.notes || '', is_produced_item: !!r.is_produced_item,
    _source_recipe_id: ref('recipes', r.source_recipe_id || r.sourceRecipeId), shelf_life_days: nOrNull(r.shelf_life_days), storage_notes: r.storage_notes || '',
    active: r.active !== false, created_at: isoOrNull(r.created_at) || nowISO(), updated_at: isoOrNull(r.updated_at) || nowISO()}));
  each('recipes', r => {
    const groups = (r.modifier_groups || r.modifierGroups || []).map(g => ({id: String(g.id || uid()), name: g.name || '', required: !!g.required, multi_select: !!(g.multi_select != null ? g.multi_select : g.multiSelect),
      options: (g.options || []).map(o => ({id: String(o.id || uid()), label: o.label || '', price_delta: num(o.price_delta != null ? o.price_delta : o.priceDelta),
        ingredient_id: modMap(o.ingredient_id || o.ingredientId), ingredient_qty_delta: num(o.ingredient_qty_delta != null ? o.ingredient_qty_delta : o.ingredientQtyDelta)}))}));
    add('recipes', r.id, {name: r.name || 'Recipe', recipe_type: ['DRINKS', 'SAUCES_SYRUPS', 'PASTRY', 'FOOD'].includes(r.recipe_type) ? r.recipe_type : 'DRINKS',
      category: r.category || '', selling_price: num(r.selling_price), notes: r.notes || '', is_production_recipe: !!r.is_production_recipe,
      expected_yield: nOrNull(r.expected_yield), yield_unit: r.yield_unit || null, production_instructions: r.production_instructions || '',
      produced_ingredient_id: ref('ingredients', r.produced_ingredient_id || r.producedIngredientId), pos_visible: r.pos_visible !== false,
      modifier_groups: groups, description: r.description || null, active: r.active !== false,
      created_at: isoOrNull(r.created_at) || nowISO(), updated_at: isoOrNull(r.updated_at) || nowISO()});
  });
  each('recipeIngredients', r => {
    const rid = ref('recipes', r.recipeId || r.recipe_id), iid = ref('ingredients', r.ingredientId || r.ingredient_id);
    if(ok(rid && iid)) add('recipe_ingredients', r.id, {recipe_id: rid, ingredient_id: iid, quantity: num(r.quantity), unit: r.unit || null});
  });
  each('purchases', r => {
    const iid = ref('ingredients', r.ingredientId || r.ingredient_id);
    if(ok(iid)) add('purchases', r.id, {ingredient_id: iid, supplier_id: ref('suppliers', r.supplierId || r.supplier_id), purchase_date: dateOnly(r.purchase_date) || dateOnly(r.created_at) || shopTodayKey(),
      invoice_number: r.invoice_number || '', quantity: num(r.quantity), purchase_unit: r.purchase_unit || null, base_quantity: num(r.base_quantity),
      total_price: num(r.total_price), price_per_base_unit: num(r.price_per_base_unit), notes: r.notes || '', created_at: isoOrNull(r.created_at) || nowISO()});
  });
  each('productionBatches', r => add('production_batches', r.id, {recipe_id: ref('recipes', r.recipeId || r.recipe_id), produced_ingredient_id: ref('ingredients', r.producedIngredientId || r.produced_ingredient_id),
    batch_number: r.batch_number || '', production_date: dateOnly(r.production_date), expected_yield: nOrNull(r.expected_yield), actual_yield: nOrNull(r.actual_yield),
    yield_unit: r.yield_unit || null, raw_cost_total: num(r.raw_cost_total), actual_cost_per_unit: num(r.actual_cost_per_unit), waste_reason: r.waste_reason || '',
    notes: r.notes || '', created_at: isoOrNull(r.created_at) || nowISO()}));
  each('waste', r => {
    const iid = ref('ingredients', r.ingredientId || r.ingredient_id);
    if(ok(iid)) add('waste', r.id, {ingredient_id: iid, quantity: num(r.quantity), unit: r.unit || null, reason: r.reason || '', date: dateOnly(r.date), notes: r.notes || '', created_at: isoOrNull(r.created_at || r.date) || nowISO()});
  });
  each('users', r => {
    const role = ['ADMIN', 'MANAGER', 'CASHIER'].includes(r.role) ? r.role : 'CASHIER';
    const nid = ref('staff', r.id);
    add('staff', r.id, {name: String(r.name || 'Staff').slice(0, 40), role, active: r.active !== false, created_at: isoOrNull(r.created_at) || nowISO(), updated_at: nowISO()});
    if(/^[0-9a-f]{64}$/i.test(String(r.pin_hash || '')) && r.active !== false) legacyPins.push({staff_id: nid, name: r.name, sha256: String(r.pin_hash).toLowerCase()});
  });
  each('shifts', r => add('shifts', r.id, {shift_number: r.shift_number || '', cashier_id: ref('staff', r.cashier_id), cashier_name: r.cashier_name || '',
    opened_at: isoOrNull(r.opened_at), closed_at: isoOrNull(r.closed_at), status: r.status === 'CLOSED' ? 'CLOSED' : 'ACTIVE',
    opening_cash: nOrNull(r.opening_cash), declared_cash: nOrNull(r.declared_cash), expected_cash: nOrNull(r.expected_cash), cash_variance: nOrNull(r.cash_variance),
    gross_sales: nOrNull(r.gross_sales), net_sales: nOrNull(r.net_sales), cash_sales: nOrNull(r.cash_sales), card_sales: nOrNull(r.card_sales), other_sales: nOrNull(r.other_sales),
    refunds_total: nOrNull(r.refunds_total), voids_total: nOrNull(r.voids_total), transaction_count: nOrNull(r.transaction_count), notes: r.notes || '',
    created_at: isoOrNull(r.created_at) || isoOrNull(r.opened_at) || nowISO(), updated_at: isoOrNull(r.updated_at) || nowISO()}));
  const heldIds = new Set();
  each('sales', r => {
    if(r.status === 'HELD'){ held++; heldIds.add(String(r.id)); return; }
    saleInfo.set(ref('sales', r.id), {number: r.transaction_number || '', total: num(r.grand_total)});
    add('sales', r.id, {transaction_number: r.transaction_number || '', transaction_date: isoOrNull(r.transaction_date) || isoOrNull(r.created_at),
      status: ['COMPLETED', 'VOIDED', 'REFUNDED', 'PARTIALLY_REFUNDED'].includes(r.status) ? r.status : 'COMPLETED',
      cashier_id: ref('staff', r.cashier_id) || staffNamed(r.cashier || r.cashier_name), cashier_name: r.cashier_name || r.cashier || '', shift_id: ref('shifts', r.shift_id),
      subtotal: num(r.subtotal), discount_type: r.discount_type || null, discount_value: num(r.discount_value), discount_amount: num(r.discount_amount),
      tax_amount: num(r.tax_amount), service_charge_amount: num(r.service_charge_amount), grand_total: num(r.grand_total), notes: r.notes || '',
      source: 'COUNTER', created_at: isoOrNull(r.created_at) || isoOrNull(r.transaction_date) || nowISO(), updated_at: nowISO()});
  });
  const saleOk = (old) => !heldIds.has(String(old)) && ref('sales', old);
  each('saleItems', r => {
    const sid = r.saleId || r.sale_id;
    if(heldIds.has(String(sid))) return;
    if(ok(saleOk(sid))) add('sale_items', r.id, {sale_id: ref('sales', sid), recipe_id: ref('recipes', r.recipeId || r.recipe_id), name: r.name || '',
      quantity: num(r.quantity), unit_price: num(r.unit_price != null ? r.unit_price : r.unitPrice), modifiers: (r.modifiers || []).map(m => oldModifier(m, modMap)),
      line_total: num(r.line_total), created_at: isoOrNull(r.created_at) || nowISO()});
  });
  each('payments', r => {
    const sid = r.saleId || r.sale_id;
    if(heldIds.has(String(sid))) return;
    if(ok(saleOk(sid))) add('payments', r.id, {sale_id: ref('sales', sid), method: PAY_IDS.includes(String(r.method).toUpperCase()) ? String(r.method).toUpperCase() : 'OTHER',
      amount: num(r.amount), tendered: nOrNull(r.tendered), change: nOrNull(r.change), reference: r.reference || null, status: r.status || 'CONFIRMED', created_at: isoOrNull(r.created_at) || nowISO()});
  });
  // Old refunds are history: money the old app already handed back, at the line price and without limits.
  // imported_at tells the database so (it then checks only the two hard limits - see checkOldRefunds below);
  // only the owner's Back Office can set it.
  const importedAt = nowISO();
  each('refunds', r => {
    const sid = r.saleId || r.sale_id;
    if(!ok(saleOk(sid))) return;
    const row = {sale_id: ref('sales', sid), shift_id: ref('shifts', r.shift_id),
      type: ['VOID', 'FULL_REFUND', 'PARTIAL_REFUND'].includes(r.type) ? r.type : 'PARTIAL_REFUND', amount: num(r.amount), reason: r.reason || '',
      items: (r.items || []).map(it => ({sale_item_id: ref('sale_items', it.saleItemId || it.sale_item_id), quantity: num(it.quantity), recipe_id: ref('recipes', it.recipeId || it.recipe_id), modifiers: (it.modifiers || []).map(m => oldModifier(m, modMap))})),
      approved_by: isUuid(r.approved_by) ? ref('staff', r.approved_by) : staffNamed(r.approved_by_name || r.approved_by), approved_by_name: r.approved_by_name || (isUuid(r.approved_by) ? '' : r.approved_by) || '',
      date: isoOrNull(r.date) || nowISO(), notes: r.notes || '', created_at: isoOrNull(r.created_at || r.date) || nowISO(), imported_at: importedAt};
    add('refunds', r.id, row);
    refundSeen.push({id: row.id, sale_id: row.sale_id, amount: row.amount, date: row.date, isNew: !skipInsert.has(row.id)});
  });
  each('cashMovements', r => {
    const sh = ref('shifts', r.shift_id);
    if(ok(sh)) add('cash_movements', r.id, {shift_id: sh, type: r.type === 'PAY_OUT' ? 'PAY_OUT' : 'PAY_IN', amount: num(r.amount), reason: r.reason || '',
      performed_by: ref('staff', r.performed_by) || staffNamed(r.performed_by_name), performed_by_name: r.performed_by_name || '', at: isoOrNull(r.at) || nowISO(), created_at: isoOrNull(r.created_at || r.at) || nowISO()});
  });
  each('inventoryTransactions', r => {
    const iid = ref('ingredients', r.ingredientId || r.ingredient_id);
    const type = ['PURCHASE', 'INITIAL_STOCK', 'USAGE', 'WASTE', 'ADJUSTMENT', 'PRODUCTION', 'PRODUCTION_USE', 'SALE_USAGE', 'SALE_REVERSAL'].includes(r.transaction_type) ? r.transaction_type : null;
    if(r.transaction_type === 'SALE_USAGE' && heldIds.has(String(r.reference_id))) return;
    if(!ok(iid && type)) return;
    const row = {ingredient_id: iid, transaction_type: type, quantity: num(r.quantity),
      reference_id: r.reference_id == null ? null : (anyRef(r.reference_id) || String(r.reference_id)), transaction_date: dateOnly(r.transaction_date) || dateOnly(r.created_at) || shopTodayKey(),
      notes: r.notes || '', created_at: isoOrNull(r.created_at) || nowISO()};
    add('inventory_transactions', r.id, row);
    if(type === 'SALE_USAGE' || type === 'SALE_REVERSAL') stockSeen.push({ingredient_id: iid, type, qty: Math.abs(row.quantity), reference_id: row.reference_id});
  });
  each('auditLog', r => add('audit_log', r.id, {action: r.action || '', actor_id: staffNamed(r.actor || r.actor_name), actor_name: r.actor || r.actor_name || '',
    details: r.details || '', reference_id: r.reference_id == null ? null : (anyRef(r.reference_id) || String(r.reference_id)), at: isoOrNull(r.at) || nowISO()}));

  // The database now refuses refunds that give back more than the sale had left, or put back more stock than the sale
  // took out - for every login. Old refunds that break either are left out here and listed for the owner.
  const leftOut = [];
  const dropped = new Set();
  if(refundSeen.some(x => x.isNew)){
    const found = checkOldRefunds(refundSeen, stockSeen, saleInfo, (existing.refunds && existing.refunds.rows) || [], ingredientInfo);
    found.forEach(f => { dropped.add(f.id); leftOut.push(f); });
    if(dropped.size){
      out.refunds = out.refunds.filter(r => !dropped.has(r.id));
      out.inventory_transactions = out.inventory_transactions.filter(l => {
        const mine = l.transaction_type === 'SALE_REVERSAL' && dropped.has(l.reference_id);
        if(mine) found.find(f => f.id === l.reference_id).lines++;
        return !mine;
      });
    }
  }

  if(held) notes.push(`${plural(held, 'held (unfinished) order was', 'held (unfinished) orders were')} left out.`);
  const openShifts = out.shifts.filter(s => s.status === 'ACTIVE').length;
  if(openShifts) notes.push(`${plural(openShifts, 'shift was', 'shifts were')} still open in the old app and came in as open (they don't affect today's counters).`);
  ['orders', 'orderItems', 'diningTables', 'customers'].forEach(k => { if((src[k] || []).length) notes.push(`"${k}" from that file are not brought in.`); });
  return {tables: out, legacyPins, unlinked, already, leftOut, dropped, saleNumbers: new Map([...saleInfo].map(([id, v]) => [id, v.number])),
    settings: src.settings ? mapOldSettings(src.settings) : null};
}

/* ---- the two hard limits the database keeps for refunds (section 8b of the database script) ----
   money: all refunds of a sale together can't be more than the sale's total (1 centavo of rounding allowed);
   stock: per ingredient, the stock all refunds of a sale put back can't be more than the sale took out.
   Old refunds are looked at one sale at a time, oldest first: the first ones that fit are kept and an old refund that
   would break a limit is left out (with its stock lines). Refunds already in the shop count as given.
   refunds:   [{id, sale_id, amount, date, isNew}]   (every old refund linked to a sale; isNew = not in the shop yet)
   stock:     [{ingredient_id, type: SALE_USAGE | SALE_REVERSAL, qty, reference_id}]  (reference = sale id / refund id)
   inShop:    refund rows already in the shop [{sale_id, amount}]
   Returns the refunds that must be left out: [{id, sale, amount, date, why, lines: 0}] */
function checkOldRefunds(refunds, stock, saleInfo, inShop, ingredientInfo){
  const cents = (n) => Math.round(roundMoney(n) * 100);
  const usage = new Map(), back = new Map();
  stock.forEach(l => {
    const map = l.type === 'SALE_USAGE' ? usage : back, key = l.reference_id;
    if(!key) return;
    const m = map.get(key) || new Map(); m.set(l.ingredient_id, (m.get(l.ingredient_id) || 0) + l.qty); map.set(key, m);
  });
  const given = new Map();     // sale id -> centavos already given back in the shop
  (inShop || []).forEach(r => given.set(r.sale_id, (given.get(r.sale_id) || 0) + Math.max(0, cents(r.amount))));
  const putBack = new Map();   // sale id -> Map(ingredient id -> qty) for refunds that are kept (already in the shop, or accepted now)
  const take = (saleId, refundId) => {
    const m = putBack.get(saleId) || new Map(); putBack.set(saleId, m);
    (back.get(refundId) || new Map()).forEach((q, ing) => m.set(ing, (m.get(ing) || 0) + q));
  };
  refunds.filter(r => !r.isNew).forEach(r => take(r.sale_id, r.id));
  const bySale = new Map();
  refunds.filter(r => r.isNew).forEach(r => { const l = bySale.get(r.sale_id) || []; l.push(r); bySale.set(r.sale_id, l); });
  const out = [];
  bySale.forEach((list, saleId) => {
    const info = saleInfo.get(saleId) || {number: '', total: 0};
    const total = cents(info.total);
    list.slice().sort((a, b) => String(a.date).localeCompare(String(b.date))).forEach(r => {
      const amount = cents(r.amount), left = Math.max(0, total - (given.get(saleId) || 0));
      const drop = (why) => out.push({id: r.id, sale: info.number || '(sale without a number)', amount: r.amount, date: r.date, why, lines: 0});
      if(amount < 0) return drop('its amount is not valid');
      if(amount > left + 1){
        const already = total - left;
        return drop(already > 0
          ? `it gave back ${fmtMoney(amount / 100)}, but only ${fmtMoney(left / 100)} of this ${fmtMoney(total / 100)} sale was left to give back (${fmtMoney(already / 100)} was already refunded)`
          : `it gave back ${fmtMoney(amount / 100)}, which is more than the whole sale (${fmtMoney(total / 100)})`);
      }
      const sold = usage.get(saleId) || new Map(), kept = putBack.get(saleId) || new Map();
      for(const [ing, q] of (back.get(r.id) || new Map())){
        const took = sold.get(ing) || 0;
        if((kept.get(ing) || 0) + q > took + 0.001){
          const i = ingredientInfo.get(ing) || {name: 'an ingredient', unit: ''};
          return drop(`it put back ${fmtNum(q, 2)} ${i.unit} of ${i.name} but the sale only took out ${fmtNum(took, 2)} ${i.unit}${(kept.get(ing) || 0) ? ' (some was already put back by another refund)' : ''}`.replace(/\s+/g, ' '));
        }
      }
      given.set(saleId, (given.get(saleId) || 0) + amount);
      take(saleId, r.id);
    });
  });
  return out;
}
function mapOldSettings(o){
  const s = {};
  const pairs = {costingMethod: 'costing_method', costing_method: 'costing_method', lowStockDefaultThreshold: 'low_stock_default_threshold', low_stock_default_threshold: 'low_stock_default_threshold',
    foodCostWarningPct: 'food_cost_warning_pct', food_cost_warning_pct: 'food_cost_warning_pct'};
  Object.keys(pairs).forEach(k => { if(o[k] != null && o[k] !== '') s[pairs[k]] = o[k]; });
  ['theme', 'business_name', 'app_name', 'primary_color', 'secondary_color', 'accent_color', 'background_color', 'card_color', 'text_color', 'font_family', 'font_size',
    'business_address', 'business_contact', 'tax_pct', 'service_charge_pct', 'tax_inclusive', 'receipt_footer', 'backup_retain_count',
    'qr_ordering_enabled', 'qr_welcome_message', 'qr_payment_note', 'qr_hide_out_of_stock', 'loyalty_enabled', 'stamps_per_reward', 'order_page_url', 'logo_url']
    .forEach(k => { if(o[k] != null && o[k] !== '') s[k] = o[k]; });
  if(o.logo && !s.logo_url) s._logo_data = o.logo;      // data URL from the old app: uploaded during import
  if(o.gdriveClientId) s._gdriveClientId = o.gdriveClientId;
  return s;
}

/* ================= converting a backup made by this Back Office ================= */
// Links each table has: [column, parent table, required]. A link to a record that is neither
// in the shop nor in the backup is cleared (optional) or the row is skipped (required).
const CCCC_LINKS = {
  ingredients: [['category_id', 'categories'], ['supplier_id', 'suppliers']],
  recipes: [['produced_ingredient_id', 'ingredients']],
  recipe_ingredients: [['recipe_id', 'recipes', true], ['ingredient_id', 'ingredients', true]],
  purchases: [['ingredient_id', 'ingredients', true], ['supplier_id', 'suppliers']],
  production_batches: [['recipe_id', 'recipes'], ['produced_ingredient_id', 'ingredients']],
  waste: [['ingredient_id', 'ingredients', true]],
  inventory_transactions: [['ingredient_id', 'ingredients', true]],
  sales: [['shift_id', 'shifts']],
  sale_items: [['sale_id', 'sales', true], ['recipe_id', 'recipes']],
  payments: [['sale_id', 'sales', true]],
  refunds: [['sale_id', 'sales', true], ['shift_id', 'shifts']],
  cash_movements: [['shift_id', 'shifts']],
  qr_orders: [['table_id', 'dining_tables'], ['customer_id', 'customers']],
  customers: [['merged_into', 'customers']],
};
function ccccTablesNeeded(payload){
  const need = new Set();
  IMPORT_ORDER.forEach(t => { if((payload.data[t] || []).length){ need.add(t); (CCCC_LINKS[t] || []).forEach(l => need.add(l[1])); } });
  return [...need];
}
function convertCcccPayload(payload, existingIds, notes){
  const src = payload.data;
  const out = {}; IMPORT_ORDER.forEach(t => { out[t] = []; });
  const sameShop = payload.business && state.business && payload.business.id === state.business.id;
  const inFile = {}; IMPORT_ORDER.forEach(t => { inFile[t] = new Set((src[t] || []).filter(r => r && isUuid(r.id)).map(r => r.id)); });
  const has = (t, id) => !!id && ((existingIds[t] && existingIds[t].has(id)) || inFile[t].has(id));
  const deviceIds = new Set(state.devices.map(d => d.id)), storeIds = new Set(state.stores.map(s => s.id));
  const phones = new Set((existingIds._customerPhones || []));
  let skippedPhones = 0, unlinked = 0, already = 0;
  IMPORT_ORDER.forEach(t => {
    (src[t] || []).forEach(r0 => {
      if(!r0 || !isUuid(r0.id)) return;
      if(existingIds[t] && existingIds[t].has(r0.id)){ already++; return; }     // already here: never overwritten
      const r = Object.assign({}, r0);
      delete r.business_id;
      let ok = true;
      (CCCC_LINKS[t] || []).forEach(([col, parent, required]) => {
        if(r[col] == null || r[col] === '') { if(required) ok = false; return; }
        if(!has(parent, r[col])){ if(required) ok = false; else r[col] = null; }
      });
      if(!ok){ unlinked++; return; }
      if('device_id' in r && r.device_id && !deviceIds.has(r.device_id)) r.device_id = null;
      if('store_id' in r && r.store_id && !storeIds.has(r.store_id)) r.store_id = null;
      if(t === 'ingredients'){ r._source_recipe_id = has('recipes', r.source_recipe_id) ? r.source_recipe_id : null; r.source_recipe_id = null; }
      if(t === 'staff' && r.profile_id && r.profile_id !== cloud.userId()) r.profile_id = null;
      if(t === 'dining_tables' && !sameShop) r.qr_token = randomToken();
      if(t === 'customers' && r.phone && !r.merged_into){ if(phones.has(r.phone)){ r.phone = null; skippedPhones++; } else phones.add(r.phone); }
      out[t].push(r);
    });
  });
  if(skippedPhones) notes.push(`${plural(skippedPhones, 'customer')} came in without a mobile number because another customer already has it (merge them in Customers if they are the same person).`);
  if(!sameShop && payload.business) notes.push('This backup is from another shop account: its table QR codes got new codes.');
  return {tables: out, legacyPins: [], unlinked, already, leftOut: [], dropped: new Set(),
    saleNumbers: new Map((src.sales || []).filter(x => x && x.id).map(x => [x.id, x.transaction_number || ''])),
    settings: src.settings ? mapOldSettings(src.settings) : null};
}

/* ================= running an import ================= */
async function existingForOld(payload){
  const ex = {};
  for(const [store, table] of Object.entries(OLD_STORES)){
    if(!(payload.data[store] || []).length) continue;
    const rows = await cloud.selectAll(table, {select: 'id,local_id' + (['categories', 'suppliers', 'staff'].includes(table) ? ',name' : '') + (table === 'refunds' ? ',sale_id,amount' : ''), order: 'id.asc'});
    const byLocal = new Map(), byName = new Map();
    rows.forEach(r => { if(r.local_id) byLocal.set(String(r.local_id), r.id); if(r.name && !byName.has(String(r.name).trim().toLowerCase())) byName.set(String(r.name).trim().toLowerCase(), r.id); });
    ex[table] = {byLocal, byName, rows: table === 'refunds' ? rows : null};     // refunds: every refund in the shop (the money check counts them)
  }
  return ex;
}
async function existingForCccc(payload){
  const ex = {};
  for(const t of ccccTablesNeeded(payload)){
    const rows = await cloud.selectAll(t, {select: t === 'customers' ? 'id,phone' : 'id', order: 'id.asc'});
    ex[t] = new Set(rows.map(r => r.id));
    if(t === 'customers') ex._customerPhones = rows.filter(r => r.phone).map(r => r.phone);
  }
  return ex;
}
// payload -> {imported, already, unlinked, pins, notes}
async function runImport(payload, opts){
  opts = opts || {};
  const kind = payloadKind(payload);
  if(!kind) throw new Error('This file is not a backup from this system or the old apps.');
  const progress = opts.onProgress || (() => {});
  const notes = [];
  progress(0, 1, 'Checking what is already in the shop…');
  let conv, totalIn = 0;
  if(kind === 'old'){
    const ex = await existingForOld(payload);
    conv = await convertOldPayload(payload, ex, notes);
    Object.keys(OLD_STORES).forEach(k => { totalIn += (payload.data[k] || []).filter(r => r && r.id != null && !r._synthetic).length; });
  } else {
    const ex = await existingForCccc(payload);
    conv = convertCcccPayload(payload, ex, notes);
    IMPORT_ORDER.forEach(t => { totalIn += (payload.data[t] || []).length; });
  }
  const T = conv.tables;
  const toSend = IMPORT_ORDER.reduce((s, t) => s + T[t].length, 0);
  let done = 0;
  const strip = (r) => { const x = Object.assign({}, r); delete x._source_recipe_id; return x; };
  const leftOut = conv.leftOut.slice();     // refunds that were not brought in: [{sale, amount, date, why, lines}]
  const dropped = conv.dropped;              // ids of those refunds (their put-back stock lines are left out too)
  const refusedLines = [];                   // sale numbers of stock lines the database refused one by one
  const refundSale = new Map(T.refunds.map(r => [r.id, r.sale_id]));
  const addedBy = {}; IMPORT_ORDER.forEach(t => { addedBy[t] = 0; });     // what was really sent, per table
  const opFor = (t, r) => Ops.insertIgnore(t, strip(t === 'ingredients' ? Object.assign({}, r, {source_recipe_id: null}) : r));
  // Refund limits are checked by the database for every save. The check above should already have left out every
  // refund that breaks them; if the database still refuses a refund or a stock line, only THAT one is left out.
  const isLimitError = (e) => /^(REFUND_TOO_LARGE|RETURN_TOO_LARGE|SALE_NOT_REFUNDABLE|SALE_NOT_FOUND|BAD_AMOUNT)$/.test(errorCode(e && e.message) || '');
  for(const t of IMPORT_ORDER){
    let rows = T[t];
    if(t === 'inventory_transactions'){
      // stock the sales took out first, stock the refunds put back last, so a "put back" line never arrives before its sale's own lines
      rows = rows.filter(l => {      // lines of a refund the database refused a moment ago are left out too
        const mine = l.transaction_type === 'SALE_REVERSAL' && dropped.has(l.reference_id);
        if(mine){ const f = leftOut.find(x => x.id === l.reference_id); if(f) f.lines++; }
        return !mine;
      });
      rows = rows.filter(l => l.transaction_type !== 'SALE_REVERSAL').concat(rows.filter(l => l.transaction_type === 'SALE_REVERSAL'));
    }
    for(let i = 0; i < rows.length; i += 150){
      const part = rows.slice(i, i + 150);
      progress(done, toSend, `Saving ${TABLE_LABEL[t]}… ${done.toLocaleString('en-PH')} of ${toSend.toLocaleString('en-PH')}`);
      try{
        await applyChanges(part.map(r => opFor(t, r)));
        addedBy[t] += part.length;
      }catch(e){
        if(!(t === 'refunds' || t === 'inventory_transactions') || !isLimitError(e)) throw e;
        for(const r of part){
          try{ await applyChanges([opFor(t, r)]); addedBy[t]++; }
          catch(e2){
            if(!isLimitError(e2)) throw e2;
            if(t === 'refunds'){
              dropped.add(r.id);
              leftOut.push({id: r.id, sale: (conv.saleNumbers.get(r.sale_id)) || '(older sale)', amount: r.amount, date: r.date, why: `the database refused it (${String(friendlyError(e2)).replace(/[.\s]+$/, '')})`, lines: 0});
            } else refusedLines.push(conv.saleNumbers.get(refundSale.get(r.reference_id)) || 'an older sale');
          }
        }
      }
      done += part.length;
    }
    if(t === 'recipes'){
      // now that the recipes exist, link produced items back to their recipes
      const links = T.ingredients.filter(r => r._source_recipe_id);
      for(let i = 0; i < links.length; i += 150) await applyChanges(links.slice(i, i + 150).map(r => Ops.update('ingredients', {id: r.id, source_recipe_id: r._source_recipe_id})));
    }
  }
  // old staff keep their old PINs (does nothing if the person already has a PIN)
  let pins = 0, pinFails = 0, pinKept = [];
  if(conv.legacyPins.length){
    let hasPin = new Set();
    try{ const d = await cloud.rpc('bo_bootstrap', {}); hasPin = new Set((d.staff || []).filter(s => s.has_pin).map(s => s.id)); }catch(e){ /* the server keeps an existing PIN anyway */ }
    for(const p of conv.legacyPins){
      if(hasPin.has(p.staff_id)){ pinKept.push(p.name); continue; }      // already has a PIN here: that one stays
      try{ await cloud.rpc('staff_import_legacy_pin', {p_staff_id: p.staff_id, p_sha256: p.sha256}); pins++; }
      catch(e){ pinFails++; console.warn('legacy PIN not imported', p.name, e); }
    }
    if(pins) notes.push(`${plural(pins, 'staff member keeps', 'staff members keep')} their old PIN from the old app. Check in Staff & PINs that no two people share a PIN.`);
    if(pinKept.length) notes.push(`${pinKept.join(', ')} already had a PIN here, so that PIN stays.`);
    if(pinFails) notes.push(`${plural(pinFails, 'old PIN')} could not be brought in — set those PINs in Staff & PINs.`);
  }
  // settings (optional)
  if(opts.includeSettings && conv.settings){
    const ch = Object.assign({}, conv.settings);
    if(ch._logo_data){
      try{
        const blob = await (await fetch(ch._logo_data)).blob();
        ch.logo_url = await uploadShopImage(blob, `logo-${Date.now()}.${/png/.test(blob.type) ? 'png' : 'jpg'}`, blob.type || 'image/png');
      }catch(e){ notes.push('The old logo could not be uploaded — add it again in Settings → Branding.'); }
    }
    if(ch._gdriveClientId && !state.settings.gdriveClientId){ state.settings.gdriveClientId = ch._gdriveClientId; saveDeviceSettings(); }
    delete ch._logo_data; delete ch._gdriveClientId;
    const row = {};
    SERVER_SETTING_KEYS.forEach(k => { row[k] = k in ch ? ch[k] : state.settings[k]; });
    row.updated_at = nowISO();
    const ops = [Ops.upsert('settings', row)];
    if(ch.business_name) ops.push(Ops.upsert('businesses', {name: String(ch.business_name)}));
    await applyChanges(ops);
    notes.push('Shop name, colours, tax and receipt settings were brought in.');
  }
  const already = conv.already;
  const imported = IMPORT_ORDER.reduce((n, t) => n + addedBy[t], 0);
  if(refusedLines.length) notes.push(`${plural(refusedLines.length, 'stock line was', 'stock lines were')} left out (sale ${[...new Set(refusedLines)].join(', ')}) because the database would not accept more stock put back than the sale took out.`);
  await applyChanges([Ops.audit('Data imported', `${imported} new records, ${already} already here${conv.unlinked ? ', ' + conv.unlinked + ' not linked' : ''}${leftOut.length ? ', ' + plural(leftOut.length, 'refund') + ' left out' : ''} (${kind === 'old' ? 'old apps' : 'Back Office backup'})`)]).catch(() => {});
  progress(1, 1, 'Done');
  return {imported, already, unlinked: conv.unlinked, notes, leftOut, kind, perTable: IMPORT_ORDER.filter(t => addedBy[t]).map(t => [TABLE_LABEL[t], addedBy[t]])};
}

/* ================= Backup & import screen ================= */
async function renderBackup(){
  if(state.route !== 'backup') return;      // a save finished after the owner moved on
  const content = document.getElementById('content');
  const s = state.settings;
  content.innerHTML = `<div class="settings-block" style="max-width:820px;">
    <div class="section-title" style="margin-top:0;">Back up now</div>
    <div class="card">
      <p class="hint" style="margin-top:0;">Your data is kept online and shared by the Back Office and every counter. A backup is an extra copy you keep: one file with all ingredients, recipes, purchases, sales, customers, staff (without PINs) and settings. It contains customers' names and numbers — keep it private.</p>
      <div class="kv-list"><div>Last backup from this device: <b>${s.lastLocalBackup ? esc(fmtShopDateTime(s.lastLocalBackup)) : 'never'}</b></div>
        <div>Saving to: <b id="backup-folder-label">this browser's Downloads</b></div></div>
      <div class="field-inline" style="margin-top:12px;"><button class="btn btn-primary" id="btn-backup">Download a backup</button></div>
    </div>

    <div class="section-title">Import data</div>
    <div class="card">
      <p class="hint" style="margin-top:0;">Bring in data from the old offline Inventory / POS apps, or restore a backup made here. Importing only <b>adds</b> records that aren't here yet — it never changes or deletes anything, and running it twice is safe. An old refund that gives back more than its sale had left, or puts back more stock than the sale took out, is left out and listed when the import is done.</p>
      <div id="imp-local"><div class="hint">Looking for old app data in this browser…</div></div>
      <div class="form-row" style="margin-top:12px;"><label for="imp-file">Or choose a backup file (.json)</label><input type="file" id="imp-file" accept=".json,application/json"></div>
      <div id="imp-preview"></div>
    </div>

    <div class="section-title">Backup folder</div>
    <div class="card">
      ${FS_ACCESS_SUPPORTED ? `<p class="hint" style="margin-top:0;">Save backups straight into a folder — a USB drive, an external drive, or a folder synced by Google Drive / OneDrive. The oldest backups beyond the number below are cleaned up by themselves. If the folder isn't there when a backup runs (e.g. USB unplugged), the file downloads normally instead.</p>
        <div class="field-inline"><button class="btn btn-outline btn-sm" id="btn-choose-folder">Choose a folder</button><button class="btn btn-ghost btn-sm" id="btn-clear-folder">Use Downloads instead</button></div>
        <div class="form-row" style="margin-top:14px;max-width:260px;"><label for="set-retain">Backups to keep in that folder</label><input type="number" id="set-retain" value="${esc(num(s.backup_retain_count) || 10)}" min="1" max="365"></div>`
      : `<p class="hint" style="margin:0;">This browser can't save into a chosen folder (that needs Chrome or Edge on a computer). Backups download normally — move them to a USB drive or another safe place yourself.</p>`}
    </div>

    <div class="section-title">Automatic backups on this device</div>
    <div class="card">
      <div class="toggle-row"><span>Automatic backup file</span><label class="switch"><input type="checkbox" id="tog-local" ${s.autoBackupLocal ? 'checked' : ''}><span class="slider-tog"></span></label></div>
      <div class="toggle-row"><span>Automatic Google Drive backup</span><label class="switch"><input type="checkbox" id="tog-gdrive" ${s.autoBackupGDrive ? 'checked' : ''}><span class="slider-tog"></span></label></div>
      <div class="form-row" style="margin-top:12px;max-width:260px;"><label for="set-frequency">How often</label>
        <select id="set-frequency">${[['daily', 'Every day'], ['weekly', 'Every week'], ['monthly', 'Every month'], ['yearly', 'Every year'], ['manual', 'Only when I press the button']].map(([v, l]) => `<option value="${v}" ${s.backupFrequency === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      ${s.backupFrequency !== 'manual' ? `<p class="hint">Next backup due: <b>${esc(fmtShopDate(nextBackupDueDate(s.lastLocalBackup, s.backupFrequency)))}</b>. It runs when the Back Office is open on this device — a closed browser can't run backups, so a missed one runs the next time you open it.</p>` : ''}
    </div>

    <div class="section-title">Google Drive (optional)</div>
    <div class="card">
      <div style="margin-bottom:12px;">Status: ${s.gdriveConnected && gdriveAccessToken ? '<span class="badge badge-green">Connected</span>' : (s.gdriveConnected ? '<span class="badge badge-yellow">Connect again to use it</span>' : '<span class="badge badge-gray">Not connected</span>')}</div>
      <p class="hint" style="margin-bottom:12px;">An extra copy of your backups in your own Google Drive, in a folder called "${esc(GDRIVE_FOLDER_NAME)}". You need a Google OAuth Client ID (type "Web application", with the Drive API turned on) from Google Cloud Console. This app never sees your Google password.</p>
      <div class="form-row"><label for="set-gdrive-clientid">Google OAuth Client ID</label><input id="set-gdrive-clientid" value="${esc(s.gdriveClientId || '')}" placeholder="xxxxx.apps.googleusercontent.com"></div>
      <div class="field-inline">
        <button class="btn btn-outline btn-sm" id="btn-save-clientid">Save Client ID</button>
        <button class="btn btn-primary btn-sm" id="btn-gdrive-connect">${s.gdriveConnected ? 'Connect again' : 'Connect Google Drive'}</button>
        <button class="btn btn-amber btn-sm" id="btn-gdrive-backup" ${!(s.gdriveConnected && gdriveAccessToken) ? 'disabled' : ''}>Back up to Google Drive</button>
        <button class="btn btn-outline btn-sm" id="btn-gdrive-restore" ${!(s.gdriveConnected && gdriveAccessToken) ? 'disabled' : ''}>Import from Google Drive</button>
      </div>
    </div>
  </div>`;
  const $ = (id) => content.querySelector('#' + id);
  getSavedBackupFolderHandle().then(h => { const l = document.getElementById('backup-folder-label'); if(l && h) l.textContent = '📁 ' + h.name + ' (chosen folder)'; });
  $('btn-backup').onclick = (e) => busy(e.currentTarget, async () => {
    try{ await exportBackup(false); applyChanges([Ops.audit('Backup made', 'Downloaded / saved a backup file')]).catch(() => {}); renderBackup(); }
    catch(err){ toast('The backup did not work: ' + friendlyError(err), 'error'); }
  }, 'Making the backup…');
  if(FS_ACCESS_SUPPORTED){
    $('btn-choose-folder').onclick = async () => {
      try{ const h = await chooseBackupFolder(); $('backup-folder-label').textContent = '📁 ' + h.name + ' (chosen folder)'; toast('Folder chosen — backups will be saved there'); }
      catch(e){ if(e.name !== 'AbortError') toast('Could not use that folder: ' + (e.message || e), 'error'); }
    };
    $('btn-clear-folder').onclick = async () => { await clearBackupFolder(); $('backup-folder-label').textContent = 'this browser\'s Downloads'; toast('Backups will download normally'); };
    $('set-retain').onchange = async (e) => { const n = Math.max(1, Math.round(num(e.target.value)) || 10); await saveSettings({backup_retain_count: n}, 'Backup setting saved', `keep ${n} backups`); };
  }
  $('tog-local').onchange = (e) => { s.autoBackupLocal = e.target.checked; saveDeviceSettings(); toast('Saved for this device'); };
  $('tog-gdrive').onchange = (e) => { s.autoBackupGDrive = e.target.checked; saveDeviceSettings(); toast('Saved for this device'); };
  $('set-frequency').onchange = (e) => { s.backupFrequency = e.target.value; saveDeviceSettings(); renderBackup(); };
  $('btn-save-clientid').onclick = () => { s.gdriveClientId = $('set-gdrive-clientid').value.trim(); saveDeviceSettings(); toast('Client ID saved on this device'); };
  $('btn-gdrive-connect').onclick = () => gdriveConnect(() => renderBackup());
  $('btn-gdrive-backup').onclick = (e) => busy(e.currentTarget, async () => { if(await gdriveBackup(false, () => buildCloudBackup())) applyChanges([Ops.audit('Backup made', 'Google Drive')]).catch(() => {}); }, 'Backing up…');
  $('btn-gdrive-restore').onclick = gdriveImportFlow;
  $('imp-file').onchange = async (e) => {
    const f = e.target.files[0]; if(!f) return;
    let payload = null;
    try{ payload = JSON.parse(await f.text()); }catch(err){ payload = null; }
    if(!payloadKind(payload)){ $('imp-preview').innerHTML = '<p class="text-red" style="margin-top:8px;">That file isn\'t a backup from this system or the old apps.</p>'; return; }
    showImportPreview(payload, $('imp-preview'));
  };
  // old app data in this browser?
  let old = null;
  try{ old = await readOldBrowserData(); }catch(e){ old = null; }
  const box = document.getElementById('imp-local');
  if(!box) return;
  if(old){
    const sum = summarizePayload(old);
    box.innerHTML = `<div class="card soft-card"><b>Old app data found in this browser</b>
      <div class="hint">${Object.entries(sum.counts).map(([k, v]) => `${v.toLocaleString('en-PH')} ${esc(TABLE_LABEL[k] || k)}`).join(' · ')}</div>
      <button class="btn btn-primary btn-sm" id="imp-use-local" style="margin-top:8px;">Use this data</button></div>`;
    box.querySelector('#imp-use-local').onclick = () => showImportPreview(old, document.getElementById('imp-preview'));
  } else box.innerHTML = '<p class="hint">No old app data in this browser. (Open the Back Office in the same browser you used the old apps in, or choose a backup file below.)</p>';
}
// The old refunds that were not brought in, in plain words: which sale, how much, and why.
function leftOutRefundsHtml(list, kind){
  if(!list || !list.length) return '';
  const old = kind === 'old';
  return `<div class="notice warn" id="imp-left-out" style="margin-top:10px;"><b>${plural(list.length, (old ? 'old ' : '') + 'refund was', (old ? 'old ' : '') + 'refunds were')} not brought in.</b>
    The system refuses a refund that gives back more than the sale had left, or puts back more stock than the sale took out.${old ? ' The old app did not check this.' : ''}
    The sales themselves came in as they were, and ${list.length === 1 ? 'this refund is' : 'these refunds are'} still in ${old ? 'your old backup file' : 'the backup file'}.
    <ul style="margin:8px 0 0 18px;">${list.map(f => `<li><b>Sale ${esc(f.sale)}</b> — ${esc(fmtMoney(f.amount))} refund${f.date ? ' on ' + esc(fmtShopDate(f.date)) : ''}: ${esc(String(f.why).replace(/[.\s]+$/, ''))}.${f.lines ? ` The stock it put back (${esc(plural(f.lines, 'stock line'))}) was left out too.` : ''}</li>`).join('')}</ul></div>`;
}
function showImportPreview(payload, target){
  const sum = summarizePayload(payload);
  const rows = Object.entries(sum.counts);
  if(!rows.length){ target.innerHTML = '<p class="text-red" style="margin-top:8px;">There is nothing to import in that data.</p>'; return; }
  const untouched = state.settings.app_name === DEFAULT_SETTINGS.app_name && !state.settings.logo_url;
  target.innerHTML = `
    <div class="section-title" style="font-size:15px;">What is in it</div>
    <div class="hint" style="margin-bottom:8px;">${esc(sum.kind === 'old' ? 'Old Inventory / POS apps' : 'Back Office backup')}${sum.appName ? ' · ' + esc(sum.appName) : ''}${sum.exportedAt ? ' · saved ' + esc(fmtShopDateTime(sum.exportedAt)) : ''}</div>
    <div class="table-wrap" style="box-shadow:none;"><table><tbody>${rows.map(([k, v]) => `<tr><td>${esc(TABLE_LABEL[k] || k)}</td><td class="num"><b>${v.toLocaleString('en-PH')}</b></td></tr>`).join('')}</tbody></table></div>
    ${sum.hasSettings ? `<label class="chk" style="margin-top:10px;"><input type="checkbox" id="imp-settings" ${untouched ? 'checked' : ''}> Also bring in the shop name, logo, colours, tax and receipt settings (replaces the current ones)</label>` : ''}
    <div id="imp-progress" style="margin-top:12px;"></div>
    <button class="btn btn-primary" id="imp-go" style="margin-top:10px;">Import now</button>`;
  const go = target.querySelector('#imp-go');
  go.onclick = async () => {
    const ok = await confirmDialog('Import this data now? Only records that are not here yet are added. Nothing is changed or deleted.', 'Import');
    if(!ok) return;
    go.disabled = true; go.textContent = 'Importing…';
    const prog = target.querySelector('#imp-progress');
    try{
      const res = await runImport(payload, {includeSettings: !!(target.querySelector('#imp-settings') && target.querySelector('#imp-settings').checked),
        onProgress: (done, total, text) => { prog.innerHTML = `<div class="hint">${esc(text)}</div><div class="progress"><div style="width:${Math.round(done / Math.max(1, total) * 100)}%"></div></div>`; }});
      await boLoad().catch(() => {});
      BO.salesCache.clear();
      applyCustomTheme(); renderShell();
      prog.innerHTML = `<div class="notice ok"><b>Done.</b> ${res.imported.toLocaleString('en-PH')} new records added${res.already ? `, ${res.already.toLocaleString('en-PH')} were already here (skipped)` : ''}${res.unlinked ? `, ${res.unlinked} skipped because what they belong to is missing` : ''}.
        ${res.perTable.length ? `<div class="hint">${res.perTable.map(([l, n]) => `${n.toLocaleString('en-PH')} ${esc(l)}`).join(' · ')}</div>` : ''}
        ${res.notes.map(n => `<div class="hint">• ${esc(n)}</div>`).join('')}</div>${leftOutRefundsHtml(res.leftOut, res.kind)}`;
      go.textContent = 'Imported';
    }catch(e){
      console.error(e);
      prog.innerHTML = `<p class="text-red">The import stopped: ${esc(friendlyError(e))}. Nothing is lost — whatever was saved stays, and running the import again carries on from there.</p>`;
      go.disabled = false; go.textContent = 'Try again';
    }
  };
}
async function gdriveImportFlow(){
  if(!state.settings.gdriveConnected || !gdriveAccessToken){ toast('Connect Google Drive first', 'error'); return; }
  let files;
  try{ files = await gdriveListBackups(); }catch(e){ toast('Could not list the Google Drive backups', 'error'); return; }
  if(!files.length){ toast('No backups found in your Google Drive folder', 'warn'); return; }
  openModal({title: 'Import from Google Drive', wide: true, body: `<p class="hint" style="margin-top:0;">Choose a backup. Only records that are not here yet are added — nothing is changed or deleted.</p>
    <div class="table-wrap" style="box-shadow:none;"><table><thead><tr><th>File</th><th>Saved</th><th></th></tr></thead><tbody>
    ${files.map(f => `<tr><td>${esc(f.name)}</td><td>${esc(fmtShopDateTime(f.modifiedTime))}</td><td><button class="btn btn-sm btn-primary" data-file="${esc(f.id)}">Choose</button></td></tr>`).join('')}</tbody></table></div>
    <div id="gd-preview"></div>`,
    foot: `<button class="btn btn-outline" data-cancel>Close</button>`,
    onMount: (root) => {
      root.querySelector('[data-cancel]').onclick = closeModal;
      root.querySelectorAll('[data-file]').forEach(b => b.onclick = () => busy(b, async () => {
        try{
          const payload = await gdriveDownloadBackup(b.dataset.file);
          if(!payloadKind(payload)){ toast('That file isn\'t a backup from this system', 'error'); return; }
          showImportPreview(payload, root.querySelector('#gd-preview'));
        }catch(e){ toast('Could not download that backup', 'error'); }
      }, '…'));
    }});
}
