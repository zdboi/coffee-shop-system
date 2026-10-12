/* =====================================================================
   SHARED BUSINESS LOGIC — units, costing, inventory, production, shifts,
   branding. Carried over from the original offline app (same formulas);
   field names now match the Supabase columns (snake_case) so records go
   to and from the database unchanged.
   Used by Front Office and Back Office.
   ===================================================================== */

// Base units per category
const WEIGHT_UNITS = {g:1, kg:1000};
const VOLUME_UNITS = {ml:1, L:1000};
const COUNT_UNITS = {pcs:1, box:null, pack:null}; // box/pack conversion is purchase-specific

function unitFamily(unit){
  if(unit in WEIGHT_UNITS) return 'weight';
  if(unit in VOLUME_UNITS) return 'volume';
  return 'count';
}

// Convert a purchase quantity+unit into base-unit quantity for the ingredient's base_unit.
function toBaseQuantity(quantity, purchaseUnit, baseUnit, unitsPerPurchaseUnit){
  quantity = Number(quantity)||0;
  if(purchaseUnit === baseUnit) return quantity;
  const fam = unitFamily(baseUnit);
  if(fam === 'weight' && purchaseUnit in WEIGHT_UNITS && baseUnit in WEIGHT_UNITS){
    return quantity * (WEIGHT_UNITS[purchaseUnit] / WEIGHT_UNITS[baseUnit]);
  }
  if(fam === 'volume' && purchaseUnit in VOLUME_UNITS && baseUnit in VOLUME_UNITS){
    return quantity * (VOLUME_UNITS[purchaseUnit] / VOLUME_UNITS[baseUnit]);
  }
  if(unitsPerPurchaseUnit && Number(unitsPerPurchaseUnit) > 0){
    return quantity * Number(unitsPerPurchaseUnit);
  }
  return quantity; // fallback: 1:1
}

function fmtMoney(n){
  const s = (Number(n)||0).toFixed(2);
  return '₱' + Number(s).toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2});
}
function fmtNum(n, dp=2){
  return Number(Number(n)||0).toFixed(dp);
}
function fmtDate(d){
  if(!d) return '—';
  const dt = new Date(d);
  if(isNaN(dt)) return d;
  return dt.toLocaleDateString('en-PH',{year:'numeric',month:'short',day:'numeric'});
}

/* ---------- Costing from purchase history ---------- */
function computeCostingStats(purchases, asOfDate){
  let list = purchases.slice();
  if(asOfDate){
    const cutoff = new Date(asOfDate).getTime();
    list = list.filter(p => new Date(p.purchase_date).getTime() <= cutoff);
  }
  if(list.length === 0) return {latest:null, weightedAvg:null, lowest:null, highest:null, count:0, totalQty:0, totalSpend:0};
  list.sort((a,b)=> new Date(a.purchase_date) - new Date(b.purchase_date));
  const latest = Number(list[list.length-1].price_per_base_unit);
  let totalQty=0, totalSpend=0, lowest=Infinity, highest=-Infinity;
  list.forEach(p=>{
    const ppu = Number(p.price_per_base_unit);
    totalQty += Number(p.base_quantity)||0;
    totalSpend += Number(p.total_price)||0;
    if(ppu < lowest) lowest = ppu;
    if(ppu > highest) highest = ppu;
  });
  const weightedAvg = totalQty>0 ? totalSpend/totalQty : latest;
  return {latest, weightedAvg, lowest, highest, count:list.length, totalQty, totalSpend};
}

function currentCostFor(ingredient, purchasesForIngredient, method){
  const stats = computeCostingStats(purchasesForIngredient);
  if(stats.count === 0) return 0;
  return method === 'latest' ? stats.latest : stats.weightedAvg;
}

/* ---------- Inventory ---------- */
const TXN_SIGN = {
  PURCHASE: 1, INITIAL_STOCK: 1, USAGE: -1, WASTE: -1,
  ADJUSTMENT: 1, // adjustment quantity itself carries the sign
  PRODUCTION: 1, PRODUCTION_USE: -1,
  SALE_USAGE: -1, SALE_REVERSAL: 1,
};
function signedQty(t){
  const q = Number(t.quantity)||0;
  return t.transaction_type === 'ADJUSTMENT' ? q : (TXN_SIGN[t.transaction_type]||0) * Math.abs(q);
}
function computeStockFromTransactions(transactions){
  return transactions.reduce((s,t)=> s + signedQty(t), 0);
}

function productionBatchesAsCostRecords(batches){
  return batches.map(b => ({
    purchase_date: b.production_date,
    base_quantity: Number(b.actual_yield) || 0,
    total_price: Number(b.raw_cost_total) || 0,
    price_per_base_unit: Number(b.actual_cost_per_unit) || 0,
  }));
}

function stockStatus(stock, reorderLevel){
  reorderLevel = Number(reorderLevel)||0;
  if(stock <= 0) return 'OUT';
  if(stock <= reorderLevel) return 'LOW';
  return 'IN';
}

/* =====================================================================
   SHARED APPLICATION STATE
   ===================================================================== */
const state = {
  business: null, device: null,
  ingredients: [], categories: [], suppliers: [], purchases: [], recipes: [],
  recipeIngredients: [], waste: [], productionBatches: [],
  stock: {},                 // ingredient_id -> quantity on hand (from the server, plus local changes)
  ingredientTxns: {},        // ingredient_id -> inventory history (loaded when opened)
  sales: [], saleItems: [], payments: [], refunds: [], shifts: [], cashMovements: [],
  staff: [], tables: [], devices: [], stores: [], qrOrders: [],
  settings: {}, route: 'dashboard', routeParam: null,
};

// Settings stored in Supabase (shared by every device of the shop)
const DEFAULT_SETTINGS = {
  currency:'PHP', costing_method:'weighted_average',
  low_stock_default_threshold: 10, food_cost_warning_pct: 35, theme:'light',
  business_name: '', app_name: 'Brew Ledger', logo_url: null,
  primary_color: '#241209', secondary_color: '#33513f', accent_color: '#c17a3d',
  background_color: '#f7f1e6', card_color: '#fffdf9', text_color: '#2c1e14',
  font_family: 'default', font_size: 'medium',
  business_address: '', business_contact: '',
  tax_pct: 0, service_charge_pct: 0, tax_inclusive: false,
  receipt_footer: 'Thank you! Please come again.',
  backup_retain_count: 10,
  qr_ordering_enabled: true, qr_welcome_message: 'Order from your phone, pay at the counter.',
  qr_payment_note: 'Please pay at the counter when your order is called.', qr_hide_out_of_stock: false,
  loyalty_enabled: false, stamps_per_reward: 10, timezone: 'Asia/Manila', order_page_url: '',
};
// Settings that belong to THIS device only (backups, Google Drive link)
const DEVICE_DEFAULTS = {
  autoBackupLocal:false, autoBackupGDrive:false, backupFrequency:'daily',
  lastLocalBackup:null, lastGDriveBackup:null,
  gdriveClientId:'', gdriveConnected:false, gdriveFolderId:'',
};
const DEVICE_SETTINGS_KEY = 'cccc.device.settings';
const SERVER_SETTING_KEYS = Object.keys(DEFAULT_SETTINGS);

function loadDeviceSettings(){
  try{ return Object.assign({}, DEVICE_DEFAULTS, JSON.parse(localStorage.getItem(DEVICE_SETTINGS_KEY)||'{}')); }
  catch(e){ return Object.assign({}, DEVICE_DEFAULTS); }
}
function saveDeviceSettings(){
  const out = {};
  Object.keys(DEVICE_DEFAULTS).forEach(k => { out[k] = state.settings[k]; });
  try{ localStorage.setItem(DEVICE_SETTINGS_KEY, JSON.stringify(out)); }catch(e){}
}
// Merge the server row (may be null on a brand-new shop) with defaults + device settings.
function setSettingsFromServer(row){
  const s = Object.assign({}, DEFAULT_SETTINGS);
  if(row) SERVER_SETTING_KEYS.forEach(k => { if(row[k] !== undefined && row[k] !== null) s[k] = row[k]; });
  ['tax_pct','service_charge_pct','low_stock_default_threshold','food_cost_warning_pct','backup_retain_count','stamps_per_reward']
    .forEach(k => { s[k] = Number(s[k])||0; });
  state.settings = Object.assign(s, loadDeviceSettings());
  return state.settings;
}
function serverSettingsRow(){
  const row = {};
  SERVER_SETTING_KEYS.forEach(k => { row[k] = state.settings[k]; });
  row.updated_at = new Date().toISOString();
  return row;
}

const CATEGORY_SEED = ['Coffee','Dairy & Milk Alternatives','Syrups & Sauces','Sweeteners','Tea & Powders','Ice & Water','Packaging','Other'];
const PRODUCED_CATEGORY_NAME = 'House-Made / Produced';

function uid(){ return Cloud.uuid(); }

/* ================= Shared domain helpers ================= */
function catName(id){ return state.categories.find(c=>c.id===id)?.name || '—'; }
function supName(id){ return state.suppliers.find(s=>s.id===id)?.name || '—'; }
function ingName(id){ return state.ingredients.find(i=>i.id===id)?.name || '(deleted ingredient)'; }
function ingredientById(id){ return state.ingredients.find(i=>i.id===id); }
function purchasesFor(ingredientId){ return state.purchases.filter(p=>p.ingredient_id===ingredientId); }
function txnsFor(ingredientId){ return state.ingredientTxns[ingredientId] || []; }
function costingMethod(){ return state.settings.costing_method || 'weighted_average'; }
function appDisplayName(){ return (state.settings && state.settings.app_name) || 'Brew Ledger'; }
function businessName(){ return (state.settings && state.settings.business_name) || (state.business && state.business.name) || ''; }
function producedCategoryId(){ return state.categories.find(c=>c.name===PRODUCED_CATEGORY_NAME)?.id; }

const RECIPE_TYPES = [
  {id:'DRINKS', label:'Drinks'},
  {id:'SAUCES_SYRUPS', label:'Sauces / Syrups'},
  {id:'PASTRY', label:'Pastry'},
  {id:'FOOD', label:'Food'},
];
function recipeTypeOf(recipe){ return recipe.recipe_type || 'DRINKS'; }
function recipeTypeLabel(typeId){ return RECIPE_TYPES.find(t=>t.id===typeId)?.label || typeId; }
function posCategoryOf(recipe){ return (recipe.category && recipe.category.trim()) || recipeTypeLabel(recipeTypeOf(recipe)); }

function isProducedItem(ingredient){ return !!(ingredient && ingredient.is_produced_item); }
function isProductionRecipe(recipe){ return !!(recipe && recipe.is_production_recipe); }
function producedIngredientForRecipe(recipeId){
  const recipe = state.recipes.find(r=>r.id===recipeId);
  if(!recipe || !recipe.produced_ingredient_id) return null;
  return ingredientById(recipe.produced_ingredient_id);
}
function sourceRecipeForIngredient(ingredient){
  if(!ingredient || !ingredient.source_recipe_id) return null;
  return state.recipes.find(r=>r.id===ingredient.source_recipe_id) || null;
}
function productionBatchesFor(ingredientId){
  return state.productionBatches.filter(b=>b.produced_ingredient_id===ingredientId);
}
function rawIngredientsList(){ return state.ingredients.filter(i=>i.active!==false && !isProducedItem(i)); }
function producedIngredientsList(){ return state.ingredients.filter(i=>i.active!==false && isProducedItem(i)); }
function productionRecipesList(){ return state.recipes.filter(r=>r.active!==false && isProductionRecipe(r)); }

function ingredientCosting(ingredientId, visiting){
  visiting = visiting || new Set();
  const ing = ingredientById(ingredientId);
  if(!ing) return {current:0, count:0, latest:null, weightedAvg:null, lowest:null, highest:null, method:null, isProduced:false};

  if(isProducedItem(ing)){
    const batchStats = computeCostingStats(productionBatchesAsCostRecords(productionBatchesFor(ingredientId)));
    let current = 0;
    let cyclic = false;
    if(visiting.has(ingredientId)){
      cyclic = true;
      current = batchStats.count ? batchStats.weightedAvg : 0;
    } else {
      visiting.add(ingredientId);
      const recipe = sourceRecipeForIngredient(ing);
      if(recipe && Number(recipe.expected_yield) > 0){
        const rc = recipeCost(recipe.id, visiting);
        current = rc.total / Number(recipe.expected_yield);
      } else if(batchStats.count){
        current = batchStats.weightedAvg;
      }
    }
    return {...batchStats, current, method:'live_recipe', isProduced:true, cyclic};
  }

  const stats = computeCostingStats(purchasesFor(ingredientId));
  const method = costingMethod();
  const current = stats.count ? (method==='latest'?stats.latest:stats.weightedAvg) : 0;
  return {...stats, current, method, isProduced:false};
}

function ingredientStock(ingredientId){
  return Number(state.stock[ingredientId]) || 0;
}
// Apply inventory movements to the local stock numbers right away (the server is the
// source of truth; the next refresh replaces these numbers with the server's).
function applyStockDeltas(txns){
  (txns||[]).forEach(t=>{ state.stock[t.ingredient_id] = (Number(state.stock[t.ingredient_id])||0) + signedQty(t); });
}
function setStockFromServer(rows){
  state.stock = {};
  (rows||[]).forEach(r=>{ state.stock[r.ingredient_id] = Number(r.stock)||0; });
}

function recipeCost(recipeId, visiting){
  visiting = visiting || new Set();
  if(visiting.has('recipe:'+recipeId)) return {lines:[], total:0, cyclic:true};
  visiting.add('recipe:'+recipeId);
  const items = state.recipeIngredients.filter(ri=>ri.recipe_id===recipeId);
  let total = 0;
  const lines = items.map(ri=>{
    const costing = ingredientCosting(ri.ingredient_id, visiting);
    const cost = costing.current || 0;
    const lineCost = cost * Number(ri.quantity||0);
    total += lineCost;
    return {...ri, unitCost:cost, lineCost, isProduced: costing.isProduced};
  });
  return {lines, total};
}

function recipeMetrics(recipe){
  const {total, lines} = recipeCost(recipe.id);
  const price = Number(recipe.selling_price)||0;
  const profit = price - total;
  const foodCostPct = price>0 ? (total/price*100) : 0;
  return {cost:total, lines, profit, foodCostPct};
}

function recipeCostAsOf(recipeId, date, visiting){
  visiting = visiting || new Set();
  if(visiting.has('recipe:'+recipeId)) return 0;
  visiting.add('recipe:'+recipeId);
  const items = state.recipeIngredients.filter(ri=>ri.recipe_id===recipeId);
  const method = costingMethod();
  let total = 0;
  items.forEach(ri=>{
    const ing = ingredientById(ri.ingredient_id);
    let cost = 0;
    if(ing && isProducedItem(ing)){
      const recipe = sourceRecipeForIngredient(ing);
      if(recipe && Number(recipe.expected_yield) > 0){
        cost = recipeCostAsOf(recipe.id, date, visiting) / Number(recipe.expected_yield);
      } else {
        const stats = computeCostingStats(productionBatchesAsCostRecords(productionBatchesFor(ri.ingredient_id)), date);
        cost = stats.count ? stats.weightedAvg : 0;
      }
    } else {
      const stats = computeCostingStats(purchasesFor(ri.ingredient_id), date);
      cost = stats.count ? (method==='latest'?stats.latest:stats.weightedAvg) : 0;
    }
    total += cost * Number(ri.quantity||0);
  });
  return total;
}

// Ingredients used by one cart/sale line: the recipe's ingredients x quantity, plus any
// modifier that uses extra stock (e.g. "Extra shot" = +18 g beans). Same traversal the
// original POS used, shared by sales (deduct) and refunds/voids (return to stock).
function inventoryLinesForSaleLine(recipeId, quantity, modifiers){
  const out = [];
  const {lines} = recipeCost(recipeId);
  lines.forEach(l=>{
    const qty = Number(l.quantity||0) * Number(quantity||0);
    if(qty > 0) out.push({ingredient_id: l.ingredient_id, quantity: qty, kind:'recipe'});
  });
  (modifiers||[]).forEach(m=>{
    if(m.ingredient_id && Number(m.ingredient_qty_delta)){
      out.push({ingredient_id: m.ingredient_id, quantity: Number(m.ingredient_qty_delta) * Number(quantity||0), kind:'modifier', label: m.label});
    }
  });
  return out;
}

/* ================= Files ================= */
function fileNameSlug(){
  return ((businessName()||appDisplayName()||'cccc').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'')) || 'cccc';
}
function downloadFile(filename, content, mime){
  const blob = content instanceof Blob ? content : new Blob([content], {type: mime});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 2000);
}
function toCSV(headers, rows){
  const esc = c => `"${String(c==null?'':c).replace(/"/g,'""')}"`;
  return [headers.map(esc).join(','), ...rows.map(r=>r.map(esc).join(','))].join('\n');
}

/* ================= Sale totals ================= */
// Recompute a sale's totals from source line items rather than trusting any cached total.
function computeSaleTotals(lines, discount, settings){
  settings = settings || state.settings;
  const subtotal = lines.reduce((s,l)=> s + (Number(l.unit_price||0) * Number(l.quantity||0)), 0);
  let discountAmt = 0;
  if(discount && discount.type==='percent') discountAmt = subtotal * (Number(discount.value)||0)/100;
  else if(discount && discount.type==='fixed') discountAmt = Number(discount.value)||0;
  discountAmt = Math.min(discountAmt, subtotal);
  const afterDiscount = subtotal - discountAmt;
  const taxPct = Number(settings.tax_pct)||0;
  const servicePct = Number(settings.service_charge_pct)||0;
  const tax = settings.tax_inclusive ? 0 : afterDiscount * taxPct/100;
  const serviceCharge = afterDiscount * servicePct/100;
  const grandTotal = afterDiscount + tax + serviceCharge;
  return {subtotal, discountAmt, tax, serviceCharge, grandTotal: Math.round(grandTotal*100)/100};
}

/* ================= Refunds: how much money goes back =================
   Owner decision 2026-10-12: a partial refund gives back what the customer actually
   paid for the returned items — their share after the sale's discount, plus tax and
   service charge. The counter and the Back Office both use refundAmountForItems();
   the database checks the same rule (_refund_items_cap in 004_cccc_online_qr.sql). */

// A peso amount rounded to centavos the way the database rounds (half away from zero).
// Binary noise is removed first, so 1.005 (stored as 1.00499999…) gives 1.01, not 1.00.
function roundMoney(n){
  n = Number(n);
  if(!isFinite(n) || n === 0) return 0;
  if(Math.abs(n) >= 1e13) return n;   // beyond ₱10 trillion a number has no centavos left to round
  const parts = Math.abs(n).toPrecision(15).split('e');
  const cents = Math.round(Number(parts[0] + 'e' + ((Number(parts[1]) || 0) + 2)));
  const out = cents / 100;
  return (n < 0 && out) ? -out : out;
}

// What is still left to give back on a sale: grand total minus the refunds already
// made on it (never below 0), in centavos. priorAmount: a number (₱) or {amount}.
function refundLeft(sale, priorAmount){
  const prior = (priorAmount && typeof priorAmount === 'object') ? priorAmount.amount : priorAmount;
  const g = Number(sale && sale.grand_total) || 0;
  return roundMoney(Math.max(0, g - Math.max(0, Number(prior) || 0)));
}

// The "prior" argument of refundAmountForItems() for one sale, from refund rows
// ({sale_id, amount, items:[{sale_item_id, quantity}]}). exceptRefundId leaves one out.
// Returns {amount: ₱ already given back, quantities: {[sale_item_id]: qty already returned}}.
function refundPriorFor(saleId, refunds, exceptRefundId){
  const out = {amount: 0, quantities: {}};
  (refunds || []).forEach(r => {
    if(!r || r.sale_id !== saleId || (exceptRefundId && r.id === exceptRefundId)) return;
    out.amount += Math.max(0, Number(r.amount) || 0);
    let list = r.items;
    if(typeof list === 'string'){ try{ list = JSON.parse(list); }catch(e){ list = null; } }
    (Array.isArray(list) ? list : []).forEach(it => {
      const q = Math.max(0, Number(it && it.quantity) || 0);
      if(!it || it.sale_item_id == null || !q) return;
      out.quantities[it.sale_item_id] = (out.quantities[it.sale_item_id] || 0) + q;
    });
  });
  out.amount = roundMoney(out.amount);
  return out;
}

// Unit price of a sale line (falls back to line_total / quantity for old rows), never below 0.
function saleItemUnitPrice(it){
  if(!it) return 0;
  let u = (it.unit_price === null || it.unit_price === undefined || it.unit_price === '') ? NaN : Number(it.unit_price);
  if(!isFinite(u)){ const q = Number(it.quantity); u = q ? Number(it.line_total) / q : 0; }
  return (isFinite(u) && u > 0) ? u : 0;
}

// How much money a refund of these lines gives back (₱, rounded to centavos).
//   sale:        {subtotal, grand_total}
//   items:       the sale's sale_items rows [{id, unit_price, quantity, line_total}]
//   refundItems: lines being returned now [{sale_item_id, quantity}]
//   prior:       {amount: ₱ already refunded on this sale, quantities: {[sale_item_id]: qty already returned}}
//                (optional; refundPriorFor() builds it from refund rows)
// S = subtotal, G = grand total, L = unit price × quantity of the lines returned now
// (a line counts only up to what is not returned yet; lines of another sale count 0).
//   left = max(0, G − prior.amount)
//   every item of the sale fully returned after this refund -> left
//   otherwise -> min(left, round(L × G / S, 2))          (S = 0 -> 0)
// So a void or a refund of everything gives back exactly what is left, and several
// partial refunds of a sale add up to its grand total.
function refundAmountForItems(sale, items, refundItems, prior){
  prior = prior || {};
  const priorQty = prior.quantities || {};
  const left = refundLeft(sale, prior.amount);
  const now = {};
  (refundItems || []).forEach(ri => {
    if(!ri || ri.sale_item_id == null) return;
    now[ri.sale_item_id] = (now[ri.sale_item_id] || 0) + Math.max(0, Number(ri.quantity) || 0);
  });
  let returnedValue = 0, everything = true;
  (items || []).forEach(it => {
    if(!it) return;
    const sold = Math.max(0, Number(it.quantity) || 0);
    const before = Math.max(0, Number(priorQty[it.id]) || 0);
    const q = now[it.id] || 0;
    returnedValue += saleItemUnitPrice(it) * Math.min(q, Math.max(0, sold - before));
    if(before + q < sold - 0.0001) everything = false;
  });
  if(everything) return left;
  // S and G count in centavos: a subtotal saved as 634.3600000000001 is ₱634.36.
  const S = roundMoney(sale && sale.subtotal);
  if(S <= 0) return 0;
  const G = Math.max(0, roundMoney(sale && sale.grand_total));
  return Math.min(left, roundMoney(returnedValue * G / S));
}

const PAYMENT_METHODS = [
  {id:'CASH', label:'Cash', ic:'💵'},
  {id:'GCASH', label:'GCash', ic:'📱'},
  {id:'MAYA', label:'Maya', ic:'📲'},
  {id:'CARD', label:'Card', ic:'💳'},
  {id:'OTHER', label:'Other', ic:'⋯'},
];

/* ================= Backup folder (Chrome/Edge) & schedule ================= */
const FS_ACCESS_SUPPORTED = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

async function getSavedBackupFolderHandle(){
  try{ const rec = await LocalDB.get('backupFolderHandle'); return rec ? rec.handle : null; }
  catch(e){ return null; }
}
async function chooseBackupFolder(){
  if(!FS_ACCESS_SUPPORTED) throw new Error('Choosing a backup folder needs Chrome or Edge — this browser will use normal downloads instead.');
  const handle = await window.showDirectoryPicker({mode:'readwrite'});
  await LocalDB.set('backupFolderHandle', {handle, name: handle.name});
  return handle;
}
async function clearBackupFolder(){ await LocalDB.del('backupFolderHandle'); }
async function verifyFolderPermission(handle){
  if(!handle) return false;
  const opts = {mode:'readwrite'};
  if((await handle.queryPermission(opts))==='granted') return true;
  if((await handle.requestPermission(opts))==='granted') return true;
  return false;
}
async function writeBackupToFolder(filename, contentString, retainCount){
  const handle = await getSavedBackupFolderHandle();
  if(!handle) return false;
  const ok = await verifyFolderPermission(handle);
  if(!ok) return false;
  const fileHandle = await handle.getFileHandle(filename, {create:true});
  const writable = await fileHandle.createWritable();
  await writable.write(contentString);
  await writable.close();
  if(retainCount && retainCount>0){
    const entries = [];
    for await (const [name, entry] of handle.entries()){
      if(entry.kind==='file' && /-backup-.*\.json$/.test(name)) entries.push(name);
    }
    entries.sort();
    const toDelete = entries.slice(0, Math.max(0, entries.length - retainCount));
    for(const name of toDelete){ try{ await handle.removeEntry(name); }catch(e){} }
  }
  return true;
}
function nextBackupDueDate(lastBackupISO, frequency){
  const last = lastBackupISO ? new Date(lastBackupISO) : null;
  if(!last) return new Date();
  const next = new Date(last);
  if(frequency==='yearly') next.setFullYear(next.getFullYear()+1);
  else if(frequency==='monthly') next.setMonth(next.getMonth()+1);
  else if(frequency==='weekly') next.setDate(next.getDate()+7);
  else next.setDate(next.getDate()+1);
  return next;
}
function isBackupDue(lastBackupISO, frequency){
  if(frequency==='manual') return false;
  return new Date() >= nextBackupDueDate(lastBackupISO, frequency);
}

/* ================= Branding / theme (shared) ================= */
const FONT_OPTIONS = [
  {id:'default', label:'Default (Fraunces + Inter)', bodyStack:"'Inter', system-ui, -apple-system, sans-serif"},
  {id:'system', label:'System Default (fully offline)', bodyStack:"-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"},
  {id:'inter', label:'Inter', bodyStack:"'Inter', system-ui, sans-serif", cdn:'Inter:wght@400;500;600;700'},
  {id:'roboto', label:'Roboto', bodyStack:"'Roboto', system-ui, sans-serif", cdn:'Roboto:wght@400;500;700'},
  {id:'opensans', label:'Open Sans', bodyStack:"'Open Sans', system-ui, sans-serif", cdn:'Open+Sans:wght@400;600;700'},
  {id:'nunito', label:'Nunito', bodyStack:"'Nunito', system-ui, sans-serif", cdn:'Nunito:wght@400;600;700'},
  {id:'poppins', label:'Poppins', bodyStack:"'Poppins', system-ui, sans-serif", cdn:'Poppins:wght@400;500;600;700'},
];
const FONT_SIZES = {small:'13.5px', medium:'15px', large:'16.5px'};

function lightenHex(hex, percent){
  try{
    hex = String(hex).replace('#','');
    if(hex.length===3) hex = hex.split('').map(c=>c+c).join('');
    const num = parseInt(hex,16);
    let r=(num>>16)&0xFF, g=(num>>8)&0xFF, b=num&0xFF;
    r = Math.min(255, Math.round(r+(255-r)*percent/100));
    g = Math.min(255, Math.round(g+(255-g)*percent/100));
    b = Math.min(255, Math.round(b+(255-b)*percent/100));
    return '#'+[r,g,b].map(v=>v.toString(16).padStart(2,'0')).join('');
  }catch(e){ return hex; }
}
function applyFontChoice(fontId){
  const opt = FONT_OPTIONS.find(f=>f.id===fontId) || FONT_OPTIONS[0];
  if(opt.cdn && !document.getElementById('font-cdn-'+opt.id)){
    const link = document.createElement('link');
    link.id = 'font-cdn-'+opt.id; link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?family=${opt.cdn}&display=swap`;
    document.head.appendChild(link);
  }
  document.documentElement.style.setProperty('--font-body', opt.bodyStack);
  if(fontId==='system') document.documentElement.style.setProperty('--font-display', opt.bodyStack);
  else document.documentElement.style.removeProperty('--font-display');
}
function applyCustomTheme(overrides){
  const s = overrides || state.settings;
  const root = document.documentElement.style;
  root.setProperty('--espresso-dark', s.primary_color);
  root.setProperty('--espresso', s.primary_color);
  root.setProperty('--green', s.secondary_color);
  root.setProperty('--green-light', lightenHex(s.secondary_color, 18));
  root.setProperty('--amber', s.accent_color);
  root.setProperty('--cream', s.background_color);
  root.setProperty('--white', s.card_color);
  root.setProperty('--text', s.text_color);
  applyFontChoice(s.font_family);
  root.setProperty('--base-font-size', FONT_SIZES[s.font_size]||FONT_SIZES.medium);
  document.body.classList.toggle('dark', s.theme==='dark');
}

/* ================= Google Drive backups (optional, per device) ================= */
let gdriveAccessToken = null;
const GDRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const GDRIVE_FOLDER_NAME = 'Coffee Shop System Backups';

function loadGISScript(){
  return new Promise((resolve,reject)=>{
    if(window.google && window.google.accounts){ resolve(); return; }
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = resolve; s.onerror = ()=>reject(new Error('Could not load Google Identity Services — check your internet connection.'));
    document.head.appendChild(s);
  });
}
async function gdriveConnect(onConnected){
  const clientId = state.settings.gdriveClientId;
  if(!clientId){ toast('Enter and save your Google OAuth Client ID first', 'error'); return; }
  if(!navigator.onLine){ toast('You need an internet connection to connect Google Drive', 'error'); return; }
  try{
    await loadGISScript();
    const tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId, scope: GDRIVE_SCOPE,
      callback: async (resp)=>{
        if(resp.error){ toast('Google Drive connection failed: '+resp.error, 'error'); return; }
        gdriveAccessToken = resp.access_token;
        state.settings.gdriveConnected = true;
        saveDeviceSettings();
        toast('Google Drive connected');
        if(onConnected) onConnected();
      }
    });
    tokenClient.requestAccessToken();
  }catch(e){ toast(e.message || 'Could not connect to Google Drive', 'error'); }
}
async function ensureGDriveFolder(){
  const q = encodeURIComponent(`name='${GDRIVE_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`, {headers:{Authorization:`Bearer ${gdriveAccessToken}`}});
  const json = await res.json();
  if(json.files && json.files.length) return json.files[0].id;
  const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
    method:'POST', headers:{Authorization:`Bearer ${gdriveAccessToken}`, 'Content-Type':'application/json'},
    body: JSON.stringify({name: GDRIVE_FOLDER_NAME, mimeType:'application/vnd.google-apps.folder'})
  });
  const created = await createRes.json();
  return created.id;
}
// payloadBuilder: async () => backup object (the Back Office passes its cloud export)
async function gdriveBackup(silent, payloadBuilder){
  if(!state.settings.gdriveConnected || !gdriveAccessToken){ if(!silent) toast('Connect Google Drive first', 'error'); return false; }
  if(!navigator.onLine){ if(!silent) toast('No internet connection — backup will retry later.', 'warn'); return false; }
  try{
    const folderId = await ensureGDriveFolder();
    const payload = await payloadBuilder();
    const filename = `${fileNameSlug()}-backup-${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.json`;
    const metadata = {name: filename, parents:[folderId]};
    const boundary = 'coffeesystemboundary';
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(payload)}\r\n--${boundary}--`;
    const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
      method:'POST', headers:{Authorization:`Bearer ${gdriveAccessToken}`, 'Content-Type':`multipart/related; boundary=${boundary}`}, body
    });
    if(!res.ok) throw new Error('Upload failed with status '+res.status);
    const uploaded = await res.json();
    const verifyRes = await fetch(`https://www.googleapis.com/drive/v3/files/${uploaded.id}?fields=id,name,size`, {headers:{Authorization:`Bearer ${gdriveAccessToken}`}});
    const verified = await verifyRes.json();
    if(!verifyRes.ok || !verified.id || Number(verified.size||0) < 10){ throw new Error('Backup upload could not be verified on Google Drive'); }
    state.settings.lastGDriveBackup = new Date().toISOString();
    saveDeviceSettings();
    if(!silent) toast(`Backed up to Google Drive and verified (${(Number(verified.size)/1024).toFixed(1)} KB)`);
    return true;
  }catch(e){
    console.error(e);
    if(!silent) toast('Google Drive backup failed.', 'error');
    return false;
  }
}
async function gdriveListBackups(){
  const folderId = await ensureGDriveFolder();
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,modifiedTime,size)&orderBy=modifiedTime desc`, {headers:{Authorization:`Bearer ${gdriveAccessToken}`}});
  const json = await res.json();
  return json.files || [];
}
async function gdriveDownloadBackup(fileId){
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {headers:{Authorization:`Bearer ${gdriveAccessToken}`}});
  return res.json();
}

/* =====================================================================
   SHIFT MANAGEMENT & CASH HANDLING (shared)
   ===================================================================== */
function activeShift(){
  const devId = state.device ? state.device.id : null;
  return state.shifts.find(s => s.status === 'ACTIVE' && (!devId || s.device_id === devId)) || null;
}

function paymentMethodForSale(saleId){
  const pay = state.payments.find(p => p.sale_id === saleId);
  return pay ? pay.method : null;
}

// The same words for sales figures on every screen and report (2026-10-12). Keys match
// the fields of shiftMetrics(); salesSummaryRows() gives them in display order.
const SALES_LABELS = {
  itemSales: 'Item sales (before discounts)',
  discounts: 'Discounts',
  taxAndService: 'Tax & service',
  sales: 'Sales',
  refunds: 'Refunds',
  netSales: 'Net sales',
  voids: 'Voids',
};
const SALES_HINTS = {
  itemSales: 'Menu prices × quantities of finished sales, before discounts, tax and service.',
  discounts: 'Taken off the item sales.',
  taxAndService: 'Added on top of the item sales.',
  sales: 'What customers paid for finished sales. Voided sales are not counted.',
  refunds: 'Money given back to customers. Voids are not included (a voided sale is simply not counted).',
  netSales: 'Sales minus refunds.',
  voids: 'Sales cancelled in full. Already left out of Sales.',
};

// The full accounting picture for one shift (same maths as the original POS, incl. the
// void double-count fix). `data` lets reports pass their own loaded records; otherwise state.
// Sales figures (finished sales = not HELD, not VOIDED):
//   itemSales     = Σ subtotals                  ("Item sales (before discounts)")
//   discounts     = Σ discounts
//   taxAndService = Σ tax + Σ service charge
//   sales         = Σ grand totals               ("Sales": what customers paid)
//   refunds       = refunds made in this shift (voids not included)
//   netSales      = sales − refunds
// Older names kept for compatibility: grossSales (= itemSales; also what the shifts
// table's gross_sales column holds), discountTotal, taxTotal, serviceTotal, refundsOnly,
// voidsOnly.
function shiftMetrics(shift, data){
  if(!shift) return null;
  data = data || state;
  const payFor = (saleId) => { const p = data.payments.find(x => x.sale_id === saleId); return p ? p.method : null; };
  const shiftSales = data.sales.filter(s => s.shift_id === shift.id && s.status !== 'HELD');
  const nonVoided = shiftSales.filter(s => s.status !== 'VOIDED');
  const voidedCount = shiftSales.length - nonVoided.length;

  const grossSales = nonVoided.reduce((s,x)=> s + Number(x.subtotal||0), 0);
  const discountTotal = nonVoided.reduce((s,x)=> s + Number(x.discount_amount||0), 0);
  const taxTotal = nonVoided.reduce((s,x)=> s + Number(x.tax_amount||0), 0);
  const serviceTotal = nonVoided.reduce((s,x)=> s + Number(x.service_charge_amount||0), 0);
  const grossGrandTotal = nonVoided.reduce((s,x)=> s + Number(x.grand_total||0), 0);

  // Reversals are attributed to the shift they were PROCESSED in.
  const shiftReversals = data.refunds.filter(r => r.shift_id === shift.id);
  const refundsOnly = shiftReversals.filter(r => r.type !== 'VOID').reduce((s,r)=> s + Number(r.amount||0), 0);
  const voidsOnly = shiftReversals.filter(r => r.type === 'VOID').reduce((s,r)=> s + Number(r.amount||0), 0);
  const netSales = grossGrandTotal - refundsOnly;

  let cashGross=0, cardGross=0, otherGross=0;
  nonVoided.forEach(s=>{
    const m = payFor(s.id);
    const amt = Number(s.grand_total||0);
    if(m==='CASH') cashGross += amt;
    else if(m==='CARD') cardGross += amt;
    else otherGross += amt; // GCASH, MAYA, OTHER
  });

  // Only true refunds of CASH sales take money out of the drawer (voids are already
  // excluded from cashGross above — subtracting them again would double-count).
  let cashReversed = 0;
  shiftReversals.filter(r => r.type !== 'VOID').forEach(r=>{
    const sale = data.sales.find(s => s.id === r.sale_id);
    if(sale && payFor(sale.id) === 'CASH') cashReversed += Number(r.amount||0);
  });
  const netCashFromSales = cashGross - cashReversed;

  const shiftCashMovements = data.cashMovements.filter(m => m.shift_id === shift.id);
  const payIns = shiftCashMovements.filter(m => m.type==='PAY_IN').reduce((s,m)=> s + Number(m.amount||0), 0);
  const payOuts = shiftCashMovements.filter(m => m.type==='PAY_OUT').reduce((s,m)=> s + Number(m.amount||0), 0);

  const openingCash = Number(shift.opening_cash||0);
  const expectedCash = openingCash + netCashFromSales + payIns - payOuts;
  const isClosed = shift.status === 'CLOSED';
  const declaredCash = isClosed ? Number(shift.declared_cash||0) : null;
  const variance = isClosed ? (declaredCash - expectedCash) : null;

  return {
    transactionCount: nonVoided.length, voidedCount,
    // clear names (use these with SALES_LABELS)
    itemSales: grossSales, discounts: discountTotal, taxAndService: taxTotal + serviceTotal,
    sales: grossGrandTotal, refunds: refundsOnly, voids: voidsOnly, netSales,
    // older names, unchanged
    grossSales, discountTotal, taxTotal, serviceTotal,
    cashGross, cardGross, otherGross, netCashFromSales,
    refundsOnly, voidsOnly,
    payIns, payOuts, payInCount: shiftCashMovements.filter(m=>m.type==='PAY_IN').length,
    payOutCount: shiftCashMovements.filter(m=>m.type==='PAY_OUT').length,
    openingCash, expectedCash, declaredCash, variance,
    cashMovements: shiftCashMovements.slice().sort((a,b)=> new Date(b.at)-new Date(a.at)),
  };
}

// The sales lines of a shift report, in order, with the shared words:
//   [{key, label, hint, amount, sign:''|'-'|'+', total:bool}]
// m = shiftMetrics(shift, data). Pass the shift too: for a CLOSED shift the figures
// saved when it closed are used (gross_sales, refunds_total, net_sales; Sales =
// net_sales + refunds_total), like the X/Z reports do; discounts and tax & service are
// not saved on the shift, so they always come from m.
function salesSummaryRows(m, shift){
  if(!m) return [];
  const closed = !!(shift && shift.status === 'CLOSED');
  const saved = (k) => {
    if(!closed || shift[k] === null || shift[k] === undefined || shift[k] === '') return null;
    const n = Number(shift[k]);
    return isFinite(n) ? n : null;
  };
  const savedNet = saved('net_sales'), savedRefunds = saved('refunds_total'), savedItems = saved('gross_sales');
  const v = {
    itemSales: savedItems !== null ? savedItems : m.itemSales,
    discounts: m.discounts,
    taxAndService: m.taxAndService,
    sales: (savedNet !== null && savedRefunds !== null) ? savedNet + savedRefunds : m.sales,
    refunds: savedRefunds !== null ? savedRefunds : m.refunds,
    netSales: savedNet !== null ? savedNet : m.netSales,
  };
  const sign = {discounts: '-', taxAndService: '+', refunds: '-'};
  return ['itemSales', 'discounts', 'taxAndService', 'sales', 'refunds', 'netSales'].map(key => ({
    key, label: SALES_LABELS[key], hint: SALES_HINTS[key], amount: Number(v[key]) || 0,
    sign: sign[key] || '', total: key === 'sales' || key === 'netSales',
  }));
}

function shiftDuration(shift){
  const start = new Date(shift.opened_at).getTime();
  const end = shift.closed_at ? new Date(shift.closed_at).getTime() : Date.now();
  const mins = Math.max(0, Math.floor((end - start) / 60000));
  const h = Math.floor(mins/60), m = mins%60;
  return h>0 ? `${h}h ${m}m` : `${m}m`;
}

/* ================= Receipts (shared by Front Office + Back Office) ================= */
function receiptHtml(sale, items, payments, opts){
  opts = opts || {};
  const s = state.settings;
  const pay = (payments||[])[0] || {};
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Receipt ${escapeHtml(sale.transaction_number||'')}</title>
    <style>
      body{font-family:'Courier New',monospace;width:300px;margin:20px auto;color:#111;font-size:12.5px;}
      .center{text-align:center;} .row{display:flex;justify-content:space-between;gap:8px;}
      hr{border:none;border-top:1px dashed #888;margin:8px 0;}
      .logo{width:44px;height:44px;object-fit:contain;margin:0 auto 6px;display:block;}
      .biz{font-weight:700;font-size:15px;} .small{font-size:11px;color:#555;}
      .items td{padding:2px 0;vertical-align:top;} table{width:100%;border-collapse:collapse;}
      .modline{font-size:10.5px;color:#555;padding-left:8px;}
      @media print{ body{width:80mm;margin:0;font-size:11px;} }
    </style></head><body>
    <div class="center">
      ${s.logo_url?`<img class="logo" src="${escapeHtml(s.logo_url)}">`:''}
      <div class="biz">${escapeHtml(businessName()||appDisplayName())}</div>
      ${s.business_address?`<div class="small">${escapeHtml(s.business_address)}</div>`:''}
      ${s.business_contact?`<div class="small">${escapeHtml(s.business_contact)}</div>`:''}
    </div>
    <hr>
    <div class="row"><span>${escapeHtml(sale.transaction_number||'')}</span><span>${fmtDate(sale.transaction_date)}</span></div>
    <div class="row"><span>Cashier: ${escapeHtml(sale.cashier_name||'')}</span><span>${new Date(sale.transaction_date).toLocaleTimeString()}</span></div>
    ${opts.qrOrder?`<div class="row"><span>QR ${escapeHtml(opts.qrOrder.order_number)}</span><span>${escapeHtml(opts.qrOrder.table_label||'')}</span></div>`:''}
    ${opts.customerName?`<div class="row"><span>Customer</span><span>${escapeHtml(opts.customerName)}</span></div>`:''}
    <hr>
    <table class="items">
      ${(items||[]).map(it=>`<tr><td colspan="2">${Number(it.quantity)} × ${escapeHtml(it.name)}</td><td style="text-align:right;">${fmtMoney(it.line_total)}</td></tr>
        ${(it.modifiers||[]).map(m=>`<tr><td colspan="3" class="modline">— ${escapeHtml(m.label)}${Number(m.price_delta)?` (+${fmtMoney(m.price_delta)})`:''}</td></tr>`).join('')}
        ${it.notes?`<tr><td colspan="3" class="modline">“${escapeHtml(it.notes)}”</td></tr>`:''}`).join('')}
    </table>
    <hr>
    <!-- Customer receipt words: Subtotal = "Item sales (before discounts)", Total = what the customer paid ("Sales"). -->
    <div class="row"><span>Subtotal</span><span>${fmtMoney(sale.subtotal)}</span></div>
    ${Number(sale.discount_amount)>0?`<div class="row"><span>Discount</span><span>-${fmtMoney(sale.discount_amount)}</span></div>`:''}
    ${Number(sale.tax_amount)>0?`<div class="row"><span>Tax</span><span>${fmtMoney(sale.tax_amount)}</span></div>`:''}
    ${Number(sale.service_charge_amount)>0?`<div class="row"><span>Service charge</span><span>${fmtMoney(sale.service_charge_amount)}</span></div>`:''}
    <div class="row" style="font-weight:700;font-size:14px;margin-top:4px;"><span>Total</span><span>${fmtMoney(sale.grand_total)}</span></div>
    <hr>
    <div class="row"><span>Payment (${escapeHtml((PAYMENT_METHODS.find(x=>x.id===pay.method)||{}).label||pay.method||'—')})</span><span>${fmtMoney(pay.amount||sale.grand_total)}</span></div>
    ${pay.method==='CASH'?`<div class="row"><span>Cash received</span><span>${fmtMoney(pay.tendered)}</span></div><div class="row"><span>Change</span><span>${fmtMoney(pay.change)}</span></div>`:''}
    ${pay.reference?`<div class="row small"><span>Ref#</span><span>${escapeHtml(pay.reference)}</span></div>`:''}
    <hr>
    <div class="center small">${escapeHtml(s.receipt_footer||'Thank you!')}</div>
    ${sale.status!=='COMPLETED'?`<div class="center" style="margin-top:8px;font-weight:700;">*** ${escapeHtml(String(sale.status).replace(/_/g,' '))} ***</div>`:''}
    </body></html>`;
}
function openPrintWindow(html, autoPrint){
  const win = window.open('', '_blank');
  if(!win){ toast('Please allow pop-ups to view/print', 'error'); return null; }
  win.document.write(html);
  win.document.close();
  win.focus();
  if(autoPrint!==false) setTimeout(()=>{ try{ win.print(); }catch(e){} }, 350);
  return win;
}
