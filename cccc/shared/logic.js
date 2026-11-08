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

/* ---- ONE unit converter (release 1.4, A10) ----
   Same rule as the database's _unit_family / _unit_factor / _to_base_qty (010):
   - families: g / kg (weight), mL / L (volume); case and spaces ignored ("l" = "L");
     anything else (pcs, box, pack...) is a count unit that only matches itself;
   - same unit -> unchanged; same family -> x1000 / ÷1000;
   - g <-> mL only through the item's "weighs" (gPerMl = grams one mL weighs):
     mL = g ÷ w, g = mL × w; otherwise impossible (null = the server's BAD_UNIT);
   - rounded to 6 decimals (_unitRound), except "same unit" which is returned as is.
   Used by recipe lines, option extras, waste, purchases, stock and costing. */
function _unitNorm(u){ return String(u == null ? '' : u).trim().toLowerCase(); }
function unitFamily(unit){
  const k = _unitNorm(unit);
  if(k === 'g' || k === 'kg') return 'weight';
  if(k === 'ml' || k === 'l') return 'volume';
  return 'count';
}
// How many of the family's small unit one unit is (kg = 1000 g, L = 1000 mL); counts: 1.
function unitFactor(unit){ const k = _unitNorm(unit); return (k === 'kg' || k === 'l') ? 1000 : 1; }
function _unitRound(n){ return Math.round(n * 1e6) / 1e6; }
// toBaseQty(qty, unit, baseUnit, gPerMl?) -> qty in baseUnit, or null when it can't be converted.
// unit empty / missing = already in baseUnit. qty missing / not a number -> null.
function toBaseQty(qty, unit, baseUnit, gPerMl){
  if(qty === null || qty === undefined || qty === '') return null;
  const q = Number(qty);
  if(!isFinite(q)) return null;
  const typed = (unit == null || String(unit).trim() === '') ? baseUnit : unit;
  const u = _unitNorm(typed), b = _unitNorm(baseUnit);
  if(u === b) return q;
  const fu = unitFamily(u), fb = unitFamily(b);
  if(fu === fb && fu !== 'count') return _unitRound(q * unitFactor(u) / unitFactor(b));
  const w = Number(gPerMl);
  if(isFinite(w) && w > 0){
    if(fu === 'weight' && fb === 'volume') return _unitRound(q * unitFactor(u) / w / unitFactor(b));
    if(fu === 'volume' && fb === 'weight') return _unitRound(q * unitFactor(u) * w / unitFactor(b));
  }
  return null;
}
// The same for an ingredient row (its base_unit and weight_g_per_ml).
function ingredientQtyToBase(ingredient, qty, unit){
  if(!ingredient) return null;
  return toBaseQty(qty, unit, ingredient.base_unit, ingredient.weight_g_per_ml);
}

// Convert a purchase quantity+unit into base-unit quantity for the ingredient's base_unit.
// g/kg and mL/L (and g <-> mL with gPerMl, the item's "weighs") go through toBaseQty;
// a count unit that isn't the base unit (box, pack) uses unitsPerPurchaseUnit; else 1:1.
function toBaseQuantity(quantity, purchaseUnit, baseUnit, unitsPerPurchaseUnit, gPerMl){
  quantity = Number(quantity)||0;
  if(purchaseUnit === baseUnit) return quantity;
  if(purchaseUnit){
    const v = toBaseQty(quantity, purchaseUnit, baseUnit, gPerMl);
    if(v !== null) return v;
  }
  if(unitsPerPurchaseUnit && Number(unitsPerPurchaseUnit) > 0){
    return quantity * Number(unitsPerPurchaseUnit);
  }
  return quantity; // fallback: 1:1
}

/* ---- Unit conversion for typing/display (owner request #3, 2026-10-25) ----
   Every STORED quantity stays in the ingredient's base unit. These helpers only
   convert what the owner types (e.g. 150 mL for a base unit of L) and how a
   base quantity is shown. gPerMl (optional, release 1.4) = the item's "weighs":
   with it, a house-made sauce counted in L can also be typed / shown in g or kg. */
// Units the owner may type for an ingredient with this base unit (its own family first).
function compatibleUnits(baseUnit, gPerMl){
  const fam = unitFamily(baseUnit);
  const w = Number(gPerMl) > 0;
  if(fam === 'weight') return w ? ['g','kg','ml','L'] : ['g','kg'];
  if(fam === 'volume') return w ? ['ml','L','g','kg'] : ['ml','L'];
  return baseUnit ? [baseUnit] : [];
}
function unitsForIngredient(ingredient){
  return ingredient ? compatibleUnits(ingredient.base_unit, ingredient.weight_g_per_ml) : [];
}
// qty in fromUnit -> qty in toUnit; null when the units don't convert (see toBaseQty).
function convertQuantity(qty, fromUnit, toUnit, gPerMl){
  const q = Number(qty);
  if(!isFinite(q)) return null;
  if(fromUnit === toUnit) return q;
  if(_unitNorm(fromUnit) === '' || _unitNorm(toUnit) === '') return null;
  return toBaseQty(q, fromUnit, toUnit, gPerMl);
}
// Typed qty+unit -> base-unit qty (unit missing = already base). null if incompatible.
function toBaseUnit(qty, unit, baseUnit, gPerMl){
  return convertQuantity(qty, unit || baseUnit, baseUnit, gPerMl);
}
// Base-unit qty -> {qty, unit} in displayUnit (falls back to baseUnit when missing/incompatible).
function fromBaseUnit(qtyBase, baseUnit, displayUnit, gPerMl){
  const q = Number(qtyBase) || 0;
  if(displayUnit && displayUnit !== baseUnit){
    const v = convertQuantity(q, baseUnit, displayUnit, gPerMl);
    if(v != null) return {qty: v, unit: displayUnit};
  }
  return {qty: _unitRound(q), unit: baseUnit};
}
function unitLabel(unit){ return unit === 'ml' ? 'mL' : (unit == null ? '' : String(unit)); }
// e.g. formatQuantity(0.15, 'L', 'ml') -> "150 mL"; formatQuantity(100, 'g', 'kg') -> "0.1 kg"
function formatQuantity(qtyBase, baseUnit, displayUnit, dp=2, gPerMl){
  const r = fromBaseUnit(qtyBase, baseUnit, displayUnit, gPerMl);
  const s = String(Number(Number(r.qty).toFixed(dp)));   // trims trailing zeros
  const lbl = unitLabel(r.unit);
  return lbl ? s + ' ' + lbl : s;
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
  ingredientBrands: [],      // ingredient_brands rows (Back Office; the counter keeps [])
  brandStock: [],            // bo_bootstrap.brand_stock / ingredient_brand_stock() (Back Office; counter [])
  floorShapes: [],           // floor_shapes rows (fo_bootstrap / bo_bootstrap / fo_floor_plan)
  settings: {}, route: 'dashboard', routeParam: null,
};

// Settings stored in Supabase (shared by every device of the shop)
const DEFAULT_SETTINGS = {
  currency:'PHP', costing_method:'weighted_average',
  low_stock_default_threshold: 10, food_cost_warning_pct: 35,
  theme:'CCCC',   // 'CCCC' = brand look (default) | 'CUSTOM' = the colours/logo/font below. Old rows: 'light'/'dark' = CCCC.
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
  loyalty_enabled: false,
  stamps_per_reward: 10,   // pre-1.2 setting, no longer used by the server (kept for older apps)
  // Stamp card (008). A full value: the Back Office saves it with the other settings.
  loyalty_rewards: {card_size: 15, rewards: [
    {stamp: 5,  type: 'AMOUNT_OFF', amount: 10, label: '₱10 off'},
    {stamp: 10, type: 'AMOUNT_OFF', amount: 50, label: '₱50 off'},
    {stamp: 15, type: 'FREE_ITEM', label: 'One free drink or food'}]},
  timezone: 'Asia/Manila', order_page_url: '',
  payout_review_limit: 1000,
};
// Settings that belong to THIS device only (backups, Google Drive link)
const DEVICE_DEFAULTS = {
  autoBackupLocal:false, autoBackupGDrive:false, backupFrequency:'daily',
  lastLocalBackup:null, lastGDriveBackup:null,
  gdriveClientId:'', gdriveConnected:false, gdriveFolderId:'',
};
const DEVICE_SETTINGS_KEY = 'cccc.device.settings';
const SERVER_SETTING_KEYS = Object.keys(DEFAULT_SETTINGS);
// Optional receipt settings read only when the server row has them (column names to be
// confirmed for 009): the shop's TIN and an extra header line under the address.
const RECEIPT_EXTRA_KEYS = ['business_tin', 'receipt_header'];

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
  ['tax_pct','service_charge_pct','low_stock_default_threshold','food_cost_warning_pct','backup_retain_count','stamps_per_reward','payout_review_limit']
    .forEach(k => { s[k] = Number(s[k])||0; });
  // Sub-category tile colours (column added by 008). Kept out of DEFAULT_SETTINGS so a
  // full settings save never sends the column to a database that doesn't have it yet.
  s.subcategory_colors = cleanSubcategoryColors(row && row.subcategory_colors);
  // Release 1.3 (009): the arranged sub-category list, same rule ([] when the column isn't there).
  s.subcategory_order = cleanSubcategoryOrder(row && row.subcategory_order);
  // Optional receipt lines (only when the database has these columns): kept out of
  // DEFAULT_SETTINGS for the same reason. Missing -> '' (nothing printed).
  RECEIPT_EXTRA_KEYS.forEach(k => { s[k] = (row && typeof row[k] === 'string') ? row[k] : ''; });
  // Stamp card: always a fresh, valid copy (a bad / missing value -> the default, like the server).
  s.loyalty_rewards = cleanLoyaltyRewards(s.loyalty_rewards);
  state.settings = Object.assign(s, loadDeviceSettings());
  return state.settings;
}
function serverSettingsRow(){
  const row = {};
  SERVER_SETTING_KEYS.forEach(k => { row[k] = state.settings[k]; });
  // The counter's offline copy keeps the tile colours too (only when there are any).
  if(state.settings.subcategory_colors && Object.keys(state.settings.subcategory_colors).length)
    row.subcategory_colors = Object.assign({}, state.settings.subcategory_colors);
  if(Array.isArray(state.settings.subcategory_order) && state.settings.subcategory_order.length)
    row.subcategory_order = state.settings.subcategory_order.slice();
  RECEIPT_EXTRA_KEYS.forEach(k => { if(state.settings[k]) row[k] = state.settings[k]; });
  row.updated_at = new Date().toISOString();
  return row;
}

const CATEGORY_SEED = ['Coffee','Dairy & Milk Alternatives','Syrups & Sauces','Sweeteners','Tea & Powders','Ice & Water','Packaging','Raw materials','Other'];
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
  let current = stats.count ? (method==='latest'?stats.latest:stats.weightedAvg) : 0;
  let costSource = 'purchases', inUse = null;
  // Release 1.4 (A8): no purchases yet -> the typed "price paid per piece" (standard_cost),
  // like the server's _ingredient_unit_cost. Items without standard_cost: 0 as before.
  if(!stats.count && _hasNum(ing.standard_cost)){ current = Number(ing.standard_cost); costSource = 'standard_cost'; }
  // Release 1.2 (owner: "cost follows what we're currently using"): an ingredient with
  // brands costs what the lot in use now cost (its purchase price per base unit).
  // No lot in use, or that lot has no price (e.g. starting stock) -> the method above.
  if(ingredientHasBrands(ingredientId)){
    inUse = inUseBrand(ingredientId);
    if(inUse && inUse.price_per_base_unit !== null){ current = inUse.price_per_base_unit; costSource = 'in_use_lot'; }
  }
  return {...stats, current, method, isProduced:false, costSource, inUseBrand: inUse};
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

function _hasNum(v){ return v !== null && v !== undefined && v !== '' && isFinite(Number(v)); }

// A recipe line's amount in the ingredient's stock unit (release 1.4, A10):
// entered_quantity + unit (as typed, e.g. 25 g of a sauce counted in L) converted with
// the ingredient's "weighs" -- the same number the database stores in quantity -- else
// quantity as stored (1.3 lines, or a unit that doesn't convert).
function recipeLineQty(ri){
  if(!ri) return 0;
  if(_hasNum(ri.entered_quantity)){
    const v = ingredientQtyToBase(ingredientById(ri.ingredient_id), ri.entered_quantity, ri.unit);
    if(v !== null) return v;
  }
  return Number(ri.quantity) || 0;
}

// Each line: {...recipe_ingredients row, quantity: in stock units (recipeLineQty), unitCost, lineCost, isProduced}
function recipeCost(recipeId, visiting){
  visiting = visiting || new Set();
  if(visiting.has('recipe:'+recipeId)) return {lines:[], total:0, cyclic:true};
  visiting.add('recipe:'+recipeId);
  const items = state.recipeIngredients.filter(ri=>ri.recipe_id===recipeId);
  let total = 0;
  const lines = items.map(ri=>{
    const costing = ingredientCosting(ri.ingredient_id, visiting);
    const cost = costing.current || 0;
    const qty = recipeLineQty(ri);
    const lineCost = cost * qty;
    total += lineCost;
    return {...ri, quantity: qty, unitCost:cost, lineCost, isProduced: costing.isProduced};
  });
  return {lines, total};
}

// recipeMetrics(recipe, modifiers?) -> {cost, lines, profit, foodCostPct, price}
// Without modifiers: exactly as before (the recipe's own lines at the menu price).
// With modifiers (release 1.4): cost of what one item with those options takes from stock
// (recipeCostWithOptions: extras added, swaps taken off/put on) at menu price + the options' prices.
function recipeMetrics(recipe, modifiers){
  if(Array.isArray(modifiers) && modifiers.length){
    const rc = recipeCostWithOptions(recipe.id, modifiers);
    const price = menuUnitPrice(recipe, modifiers);
    return {cost: rc.total, lines: rc.lines, profit: price - rc.total, foodCostPct: price>0 ? rc.total/price*100 : 0, price};
  }
  const {total, lines} = recipeCost(recipe.id);
  const price = Number(recipe.selling_price)||0;
  const profit = price - total;
  const foodCostPct = price>0 ? (total/price*100) : 0;
  return {cost:total, lines, profit, foodCostPct, price};
}

// Cost of ONE item with these options (release 1.4): the stock lines a sale would take
// (inventoryLinesForSaleLine, quantity 1) × each ingredient's current cost.
// -> {lines: [{ingredient_id, quantity, kind, label, unitCost, lineCost}], total}
function recipeCostWithOptions(recipeId, modifiers){
  let total = 0;
  const lines = inventoryLinesForSaleLine(recipeId, 1, modifiers || []).map(l => {
    const unitCost = ingredientCosting(l.ingredient_id).current || 0;
    const lineCost = unitCost * l.quantity;
    total += lineCost;
    return Object.assign({}, l, {unitCost, lineCost});
  });
  return {lines, total};
}
// How much choosing one option changes the cost of one item (₱; a swap to a dearer milk > 0).
function optionCostDelta(recipeId, modifier){
  return recipeCostWithOptions(recipeId, [modifier]).total - recipeCostWithOptions(recipeId, []).total;
}

// Menu price of one item with these options: selling_price + Σ price_delta
// (the server's _menu_unit_price rule; library options and swaps included).
function menuUnitPrice(recipe, modifiers){
  return (Number(recipe && recipe.selling_price) || 0) + (modifiers || []).reduce((s, m) => s + (Number(m && m.price_delta) || 0), 0);
}

/* ---- Supplied items (release 1.4, A8): bought and resold per piece ---- */
function isSuppliedRecipe(recipe){ return !!(recipe && recipe.supplied_ingredient_id); }
// Same numbers save_supplied_item returns: cost = the latest purchase's price per piece,
// else the typed cost (ingredients.standard_cost), else 0;
// margin = price − cost (centavos), margin_pct = margin ÷ price × 100 (1 decimal; null at price 0).
// -> {ingredient_id, cost_per_piece, selling_price, margin, margin_pct, cost_source: 'purchase'|'standard_cost'|'none'}
function suppliedItemCosting(recipe){
  const iid = recipe && recipe.supplied_ingredient_id;
  const ing = iid ? ingredientById(iid) : null;
  const latest = (iid ? purchasesFor(iid) : []).slice().sort((a, b) =>
    String(b.purchase_date || '').localeCompare(String(a.purchase_date || '')) || String(b.created_at || '').localeCompare(String(a.created_at || '')))[0];
  let cost = 0, source = 'none';
  if(latest && _hasNum(latest.price_per_base_unit)){ cost = Number(latest.price_per_base_unit); source = 'purchase'; }
  else if(ing && _hasNum(ing.standard_cost)){ cost = Number(ing.standard_cost); source = 'standard_cost'; }
  const price = Number(recipe && recipe.selling_price) || 0;
  return {ingredient_id: iid || null, cost_per_piece: Math.round(cost * 1e4) / 1e4, selling_price: price,
    margin: roundMoney(price - cost), margin_pct: price > 0 ? _round1((price - cost) / price * 100) : null, cost_source: source};
}
function _round1(n){ const a = Math.round(Math.abs(n) * 10 + 1e-9) / 10; return n < 0 ? -a : a; }

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
      cost = stats.count ? (method==='latest'?stats.latest:stats.weightedAvg) : ((ing && _hasNum(ing.standard_cost)) ? Number(ing.standard_cost) : 0);
    }
    total += cost * recipeLineQty(ri);
  });
  return total;
}

/* ================= Merged ingredients and operating supplies (release 1.4, A12 / A11) =================
   - Merged: an ingredient with merged_into set became a brand of a general ingredient
     (it stays, switched off, so old offline counters can still upload). Hide it from
     every list and picker; its amounts go to the general one.
   - Operating supplies: an ingredient in a category with kind 'EXPENSE' is not stock.
     Hide it from stock counts, low stock, inventory value and recipe pickers; counter
     stock lines never include it (the server drops them too: _clean_stock_lines). */
function isMergedIngredient(ing){ return !!(ing && ing.merged_into); }
function isExpenseCategory(cat){
  if(typeof cat === 'string') cat = (state.categories || []).find(c => c.id === cat);
  return !!cat && String(cat.kind || 'STOCK').toUpperCase() === 'EXPENSE';
}
function isExpenseIngredient(ingOrId){
  const ing = typeof ingOrId === 'string' ? ingredientById(ingOrId) : ingOrId;
  return !!(ing && ing.category_id && isExpenseCategory(ing.category_id));
}
// Counted stock: active, not merged away, not an operating supply.
function isStockIngredient(ing){ return !!ing && ing.active !== false && !isMergedIngredient(ing) && !isExpenseIngredient(ing); }
function stockIngredientsList(){ return state.ingredients.filter(isStockIngredient); }
// Operating supplies that can be picked on an expense (active, not merged).
function expenseIngredientsList(){ return state.ingredients.filter(i => i.active !== false && !isMergedIngredient(i) && isExpenseIngredient(i)); }
function expenseCategoriesList(){ return (state.categories || []).filter(c => isExpenseCategory(c)); }
// Ingredients for a picker (recipe lines, option extras, swaps, waste, counts...).
// Default: stock ingredients only (active, not merged, not operating supplies), house-made included.
// opts: {produced: false -> leave house-made out, expense: true -> include operating supplies,
//        inactive: true -> include switched-off ones (never merged ones), keep: [ids always kept, e.g. the current value]}
function ingredientPickerList(opts){
  opts = opts || {};
  const keep = new Set(opts.keep || []);
  return state.ingredients.filter(i => {
    if(keep.has(i.id)) return true;
    if(isMergedIngredient(i)) return false;
    if(i.active === false && !opts.inactive) return false;
    if(opts.produced === false && isProducedItem(i)) return false;
    if(!opts.expense && isExpenseIngredient(i)) return false;
    return true;
  });
}
// Where an ingredient's stock lives now (server _merge_target): itself, or the ingredient it
// was merged into (followed up to 10 steps), with the factor its amounts are multiplied by
// (kg merged into g -> 1000). -> {id, factor, ingredient} (unknown id -> itself, factor 1, ingredient null).
function mergeTarget(ingredientId){
  let id = ingredientId, f = 1, row = ingredientById(id);
  for(let i = 0; row && row.merged_into && i < 10; i++){
    const next = ingredientById(row.merged_into);
    if(!next) break;
    f = f * unitFactor(row.base_unit) / unitFactor(next.base_unit);
    id = next.id; row = next;
  }
  return {id, factor: f, ingredient: row || null};
}
// Stock lines cleaned like the server's _clean_stock_lines: a merged ingredient's line goes to the
// general ingredient (amount × factor), operating supplies are left out; lines of one ingredient
// are added together (first line's kind / label kept), amounts rounded to 6 decimals, only > 0 kept.
function cleanStockLines(lines){
  const order = [], by = {};
  (lines || []).forEach(l => {
    if(!l || !l.ingredient_id) return;
    const t = mergeTarget(l.ingredient_id);
    if(isExpenseIngredient(t.id)) return;
    const q = (Number(l.quantity) || 0) * t.factor;
    if(!by[t.id]){ by[t.id] = Object.assign({}, l, {ingredient_id: t.id, quantity: 0}); order.push(t.id); }
    by[t.id].quantity += q;
  });
  return order.map(id => Object.assign(by[id], {quantity: _unitRound(by[id].quantity)})).filter(l => l.quantity > 0);
}

/* ================= Options: library groups, extras, swaps (release 1.4, A9) =================
   recipes.modifier_groups is built by the DATABASE: library groups that apply (id 'lib_<uuid>',
   library_group_id set) + the recipe's own groups. Every option looks like
     {id, label, price_delta, kind: 'PLAIN'|'EXTRA'|'SWAP',
      ingredient_id, ingredient_qty_delta,        (first extra, for 1.3 counters)
      extras:  [{ingredient_id, quantity}],       (stock taken per item, stock units)
      removes: [{ingredient_id, quantity}]}       (SWAP: stock NOT taken per item)
   Own groups of older recipes may have only ingredient_id + ingredient_qty_delta. */
function recipeOptionGroups(recipe){
  const g = recipe && recipe.modifier_groups;
  return Array.isArray(g) ? g.filter(x => x && typeof x === 'object') : [];
}
function isLibraryGroup(group){ return !!group && (String(group.id || '').indexOf('lib_') === 0 || !!group.library_group_id); }
function optionKind(option){
  const k = String((option && option.kind) || '').toUpperCase();
  if(k === 'PLAIN' || k === 'EXTRA' || k === 'SWAP') return k;
  return optionStockExtras(option).length ? 'EXTRA' : 'PLAIN';
}
// Stock one item takes for an option, in stock units (server _option_extras):
// "extras" when the option has them (an amount typed with a unit is converted with the
// ingredient's "weighs"), else the old pair ingredient_id × ingredient_qty_delta (may be < 0).
function optionStockExtras(option){
  if(!option) return [];
  if(Array.isArray(option.extras)){
    const out = [];
    option.extras.forEach(e => {
      if(!e || typeof e !== 'object' || !e.ingredient_id) return;
      let q = null;
      if(Object.prototype.hasOwnProperty.call(e, 'entered_quantity')){
        const ing = ingredientById(e.ingredient_id);
        q = ing ? ingredientQtyToBase(ing, e.entered_quantity, e.unit) : (_hasNum(e.quantity) ? Number(e.quantity) : null);
      } else q = _hasNum(e.quantity) ? Number(e.quantity) : null;
      if(q !== null && q > 0) out.push({ingredient_id: e.ingredient_id, quantity: q});
    });
    return out;
  }
  if(option.ingredient_id && Number(option.ingredient_qty_delta)) return [{ingredient_id: option.ingredient_id, quantity: Number(option.ingredient_qty_delta)}];
  return [];
}
// Stock one item does NOT take for an option (a swap's "from" amount), stock units.
function optionStockRemoves(option){
  if(!option || !Array.isArray(option.removes)) return [];
  return option.removes.filter(e => e && e.ingredient_id && _hasNum(e.quantity)).map(e => ({ingredient_id: e.ingredient_id, quantity: Number(e.quantity)}));
}
// The recipe's option a chosen modifier refers to (server rule, _recipe_stock_lines): group id +
// option id first, else group name + label. -> {group, option} | null
// strictIds: true -> a modifier that has a group_id is matched by ids only (the waste check,
// _resolve_options).
function findRecipeOption(recipe, m, strictIds){
  if(!m || typeof m !== 'object') return null;
  const groups = recipeOptionGroups(recipe);
  const opts = (g) => Array.isArray(g.options) ? g.options : [];
  if(m.group_id != null && m.option_id != null){
    for(const g of groups){ if(g.id === m.group_id){ const o = opts(g).find(x => x && x.id === m.option_id); if(o) return {group: g, option: o}; } }
  }
  if(strictIds && Object.prototype.hasOwnProperty.call(m, 'group_id')) return null;
  if(m.group != null && m.label != null){
    for(const g of groups){ if(g.name === m.group){ const o = opts(g).find(x => x && x.label === m.label); if(o) return {group: g, option: o}; } }
  }
  return null;
}
// The modifier a cart line / sale item keeps for a chosen option (release 1.4 shape):
//   {group, label, price_delta, group_id, option_id, kind, ingredient_id, ingredient_qty_delta,
//    extras: [{ingredient_id, quantity}], removes: [{ingredient_id, quantity}],
//    SWAP only: swap_from_ingredient_id, swap_to_ingredient_id, swap_rule: 'LINE_TOTAL'}
// Non-swap options: extras / removes are a snapshot in stock units, so a refund later puts back
// exactly what the sale took even if the option changes. A SWAP keeps its extras / removes for
// display only; its stock is worked out by the swap rule (inventoryLinesForSaleLine, step 2).
// group, label and price_delta are what the server's price check (_menu_unit_price) reads.
// (An old option with a negative amount, e.g. "Less sugar" −5 g, is kept as removes [{sugar, 5}].)
function modifierFromOption(group, option){
  const kind = optionKind(option);
  const all = optionStockExtras(option), removes = optionStockRemoves(option);
  const extras = all.filter(e => e.quantity > 0);
  all.filter(e => e.quantity < 0).forEach(e => removes.push({ingredient_id: e.ingredient_id, quantity: -e.quantity}));
  // 1.3 fields: as the server set them on the option (a SWAP: none, so an old reader never
  // deducts the "to" ingredient on top of the recipe), else the first extra.
  const first = all[0];
  const legacyId = kind === 'SWAP' ? null : (option.ingredient_id !== undefined ? (option.ingredient_id || null) : (first ? first.ingredient_id : null));
  const legacyQty = legacyId ? (option.ingredient_id !== undefined ? (Number(option.ingredient_qty_delta) || 0) : first.quantity) : 0;
  const out = {group: group.name, label: option.label, price_delta: Number(option.price_delta) || 0,
    group_id: group.id, option_id: option.id, kind,
    ingredient_id: legacyId, ingredient_qty_delta: legacyQty,
    extras, removes};
  if(kind === 'SWAP'){
    out.swap_from_ingredient_id = option.swap_from_ingredient_id || null;
    out.swap_to_ingredient_id = option.swap_to_ingredient_id || null;
    out.swap_rule = 'LINE_TOTAL';
  }
  return out;
}
// selections [{group_id, option_id}] (the counter's picker) -> modifiers, in selection order.
// Selections that aren't on the recipe are left out (checkOptionSelections reports them).
function modifiersFromSelections(recipe, selections){
  const out = [];
  (selections || []).forEach(s => { const f = findRecipeOption(recipe, s); if(f) out.push(modifierFromOption(f.group, f.option)); });
  return out;
}
// The shared check of a choice of options (the counter must enforce required groups, like
// qr_place_order does). selections: [{group_id, option_id}] or modifiers [{group, label}].
// -> {ok, missing: [{group_id, name}]  (required groups with nothing chosen, menu order),
//     problems: [{group_id, option_id, group, label, reason: 'UNKNOWN'|'DUPLICATE'|'ONE_ONLY'}]}
// opts.strictIds: match modifiers that carry a group_id by ids only (as the server's waste check).
// The result also has resolved: [{group, label, group_id, option_id}] for the options found.
function checkOptionSelections(recipe, selections, opts){
  const groups = recipeOptionGroups(recipe);
  const seen = new Set(), chosenGroups = {}, problems = [], resolved = [];
  (selections || []).forEach(s => {
    if(!s) return;
    const f = findRecipeOption(recipe, s, !!(opts && opts.strictIds));
    if(!f){ problems.push({group_id: s.group_id || null, option_id: s.option_id || null, group: s.group || null, label: s.label || null, reason: 'UNKNOWN'}); return; }
    const key = f.group.id + ':' + f.option.id;
    const base = {group_id: f.group.id, option_id: f.option.id, group: f.group.name, label: f.option.label};
    if(seen.has(key)){ problems.push(Object.assign(base, {reason: 'DUPLICATE'})); return; }
    if(chosenGroups[f.group.id] && !f.group.multi_select){ problems.push(Object.assign(base, {reason: 'ONE_ONLY'})); return; }
    seen.add(key); chosenGroups[f.group.id] = true;
    resolved.push({group: f.group.name, label: f.option.label, group_id: f.group.id, option_id: f.option.id});
  });
  const missing = groups.filter(g => g.required && !chosenGroups[g.id]).map(g => ({group_id: g.id, name: g.name}));
  return {ok: !missing.length && !problems.length, missing, problems, resolved};
}
// Just the required groups with nothing chosen: [{group_id, name}] ([] = fine).
function missingRequiredGroups(recipe, selections){ return checkOptionSelections(recipe, selections).missing; }

// How a chosen modifier moves stock per item:
//   {swap: {from, to}}       a swap by the LINE_TOTAL rule (step 2 of inventoryLinesForSaleLine)
//   {extras, removes}        everything else (step 1), stock units
// Which one:
//   snapshot with swap_rule 'LINE_TOTAL' (1.4 carts, QR orders, sale items) -> swap (from / to of the snapshot)
//   snapshot with extras / removes lists, no swap_rule -> extras − removes as stored (the older rule;
//                            so refunds of sales made before the LINE_TOTAL rule return what they took)
//   1.3 snapshot (ingredient_id / ingredient_qty_delta) -> that single pair
//   bare choice ({group_id, option_id} / {group, label}) -> the recipe's option now, like the server:
//                            a SWAP on the menu -> swap; else its extras (an option no longer on the menu takes nothing)
function modifierStock(recipe, m){
  const none = {extras: [], removes: []};
  if(!m || typeof m !== 'object') return none;
  const has = (k) => Object.prototype.hasOwnProperty.call(m, k);
  if(m.swap_rule === 'LINE_TOTAL') return {swap: {from: m.swap_from_ingredient_id || null, to: m.swap_to_ingredient_id || null}};
  if(Array.isArray(m.extras) || Array.isArray(m.removes)){
    return {extras: Array.isArray(m.extras) ? optionStockExtras(m) : optionStockExtras({ingredient_id: m.ingredient_id, ingredient_qty_delta: m.ingredient_qty_delta}),
            removes: optionStockRemoves(m)};
  }
  if(has('ingredient_id') || has('ingredient_qty_delta')) return {extras: optionStockExtras({ingredient_id: m.ingredient_id, ingredient_qty_delta: m.ingredient_qty_delta}), removes: []};
  const f = findRecipeOption(recipe, m);
  if(!f) return none;
  if(String(f.option.kind || '').toUpperCase() === 'SWAP') return {swap: {from: f.option.swap_from_ingredient_id || null, to: f.option.swap_to_ingredient_id || null}};
  return {extras: optionStockExtras(f.option), removes: []};
}

// Ingredients used by one cart/sale line: the server's _recipe_stock_lines rule (010, lead
// decision 2026-11-03 "a non-dairy drink is fully non-dairy"):
//   1. per ONE item, per ingredient: recipe lines (stock units, recipeLineQty, > 0) + every chosen
//      non-swap option's stock (modifierStock: extras − removes, or the old single pair);
//   2. then each chosen SWAP (from ≠ to), in the order chosen: the item's WHOLE total of "from"
//      (recipe + extras, e.g. a 16 oz size's extra milk) moves to "to", converted to its stock unit
//      (g↔kg, mL↔L, g↔mL through "to"'s weighs, else "from"'s); "from" becomes 0. A later swap of a
//      "from" already swapped moves nothing (it still adds its price); a "from" total of 0, or an
//      amount that can't be converted, moves nothing. The swap's own extras / removes are never used;
//   3. × quantity, rounded to 6 decimals, only amounts > 0 kept;
//   then cleaned (cleanStockLines): merged ingredients -> their general ingredient,
//   operating supplies left out.
// -> [{ingredient_id, quantity (> 0, stock unit), kind: 'recipe'|'modifier', label (modifier only)}]
//    one line per ingredient. Shared by sales (deduct), refunds/voids (put back), waste,
//    the stock check before payment and costing.
// opts.raw: true -> skip the cleaning step (exactly _recipe_stock_lines; parity checks).
function inventoryLinesForSaleLine(recipeId, quantity, modifiers, opts){
  const Q = Number(quantity) || 0;
  const recipe = state.recipes.find(r => r.id === recipeId) || null;
  const order = [], by = {};
  const add = (id, q, kind, label) => {
    if(!id || !isFinite(q)) return;
    if(!by[id]){ by[id] = {ingredient_id: id, quantity: 0, kind}; if(kind === 'modifier') by[id].label = label; order.push(id); }
    by[id].quantity += q;
  };
  state.recipeIngredients.forEach(ri => {
    if(ri.recipe_id !== recipeId) return;
    const q = recipeLineQty(ri);
    if(q > 0) add(ri.ingredient_id, q, 'recipe');
  });
  const mods = (Array.isArray(modifiers) ? modifiers : []).map(m => ({m, st: modifierStock(recipe, m)}));
  mods.forEach(({m, st}) => {
    if(st.swap) return;
    st.extras.forEach(e => add(e.ingredient_id, e.quantity, 'modifier', m.label));
    st.removes.forEach(e => add(e.ingredient_id, -e.quantity, 'modifier', m.label));
  });
  const done = new Set();
  mods.forEach(({m, st}) => {
    if(!st.swap) return;
    const from = st.swap.from, to = st.swap.to;
    if(!from || !to || from === to || done.has(from)) return;
    done.add(from);
    const amt = by[from] ? by[from].quantity : 0;
    if(!(amt > 0)) return;
    const x = ingredientById(from), y = ingredientById(to);
    if(!x || !y) return;
    const w = _hasNum(y.weight_g_per_ml) ? y.weight_g_per_ml : x.weight_g_per_ml;
    const conv = toBaseQty(amt, x.base_unit, y.base_unit, w);
    if(!(conv > 0)) return;
    by[from].quantity = 0;
    add(to, conv, 'modifier', m.label);
  });
  const out = order.map(id => Object.assign(by[id], {quantity: _unitRound(by[id].quantity * Q)})).filter(l => l.quantity > 0);
  return (opts && opts.raw) ? out : cleanStockLines(out);
}

// How many of an item (with these options) the stock on hand can make now: the lowest
// floor(stock ÷ amount per item) over its stock lines (same lines as a sale; state.stock or
// the stock map given). No stock lines (nothing tracked) -> 99, like the counter's tile badge.
function recipeMakeableCount(recipeId, modifiers, stock){
  stock = stock || state.stock || {};
  let lowest = Infinity;
  inventoryLinesForSaleLine(recipeId, 1, modifiers || []).forEach(l => {
    lowest = Math.min(lowest, Math.floor(((Number(stock[l.ingredient_id]) || 0) + STOCK_EPSILON) / l.quantity));
  });
  return lowest === Infinity ? 99 : Math.max(0, lowest);
}

/* ================= Counter waste log (release 1.4, A15) =================
   fo_sync op 'waste' (contract A15): the counter sends WHAT was wasted; the server works out
   the stock and cost itself. Only COMPLIMENTARY needs a manager's approval (like a discount). */
const WASTE_REASONS = [
  {id: 'CALIBRATION',   label: 'Calibration / barista drink'},
  {id: 'SPILLAGE',      label: 'Spillage'},
  {id: 'COMPLIMENTARY', label: 'Complimentary', needs_approval: true},
  {id: 'EXPIRED',       label: 'Expired / spoiled'},
  {id: 'OTHER',         label: 'Other', needs_note: true},
];
function wasteReasonLabel(id){ const r = WASTE_REASONS.find(x => x.id === id); return r ? r.label : String(id == null ? '' : id); }
const WASTE_MAX_ITEMS = 30, WASTE_MAX_RECIPE_QTY = 100, WASTE_MAX_BASE_QTY = 1000000, WASTE_NOTE_MAX = 200, WASTE_MAX_OPTIONS = 20;
function _codeError(code){ const e = new Error(code); e.code = code; return e; }
// buildWasteData({reason, note, staff_id, shift_id, items, approved_by, approval_token, id?, logged_at?})
//   items: [{recipe_id, quantity, modifiers}] (modifiers: cart modifiers, or {group_id, option_id}/{group, label})
//        | [{ingredient_id, quantity, unit}]  (unit: any unit that converts; empty = stock unit)
// -> the op's data, ready for Sync.queue('waste', data):
//   {id, reason, note, staff_id, shift_id, logged_at, items, approved_by, approval_token}
//   items sent as {recipe_id, quantity, modifiers: [{group, label, group_id, option_id}] (the options
//   found on the item's current menu, like the server keeps)} or
//   {ingredient_id, quantity, unit}. id is made ONCE here: keep the same data for retries.
// Throws an Error whose message/code is the server's code (friendlyError gives the words):
//   BAD_WASTE_REASON, NOTE_REQUIRED, BAD_WASTE (no items / > 30 / unreadable; an option not on the
//   item now, chosen twice, two in a pick-one group, > 20 options: e.problems lists them),
//   OPTION_REQUIRED (a required group not chosen: e.missing = [{group_id, name}]; the server would say
//   BAD_WASTE), BAD_QUANTITY, BAD_UNIT, UNKNOWN_RECIPE / UNKNOWN_INGREDIENT (not in this counter's menu copy),
//   APPROVAL_REQUIRED (COMPLIMENTARY without approved_by + approval_token).
function buildWasteData(input){
  input = input || {};
  const reason = String(input.reason || '').trim().toUpperCase();
  if(!WASTE_REASONS.some(r => r.id === reason)) throw _codeError('BAD_WASTE_REASON');
  const note = String(input.note == null ? '' : input.note).trim().slice(0, WASTE_NOTE_MAX);
  if(reason === 'OTHER' && !note) throw _codeError('NOTE_REQUIRED');
  const list = Array.isArray(input.items) ? input.items : [];
  if(list.length < 1 || list.length > WASTE_MAX_ITEMS) throw _codeError('BAD_WASTE');
  const items = list.map(it => {
    if(!it || typeof it !== 'object') throw _codeError('BAD_WASTE');
    const q = Number(it.quantity);
    if(!_hasNum(it.quantity) || q <= 0) throw _codeError('BAD_QUANTITY');
    if(it.recipe_id){
      const rec = state.recipes.find(r => r.id === it.recipe_id);
      if(!rec) throw _codeError('UNKNOWN_RECIPE');
      if(q > WASTE_MAX_RECIPE_QTY) throw _codeError('BAD_QUANTITY');
      // options checked against the menu like the server (_resolve_options): at most 20, each on
      // the item now, none twice, one per pick-one group, every required group chosen.
      if(it.modifiers != null && !Array.isArray(it.modifiers)) throw _codeError('BAD_WASTE');
      const mods = it.modifiers || [];
      if(mods.length > WASTE_MAX_OPTIONS || mods.some(m => !m || typeof m !== 'object' || Array.isArray(m))) throw _codeError('BAD_WASTE');
      const chk = checkOptionSelections(rec, mods, {strictIds: true});
      if(chk.problems.length){ const e = _codeError('BAD_WASTE'); e.problems = chk.problems; e.recipe_id = rec.id; throw e; }
      if(chk.missing.length){ const e = _codeError('OPTION_REQUIRED'); e.missing = chk.missing; e.recipe_id = rec.id; throw e; }
      return {recipe_id: it.recipe_id, quantity: q, modifiers: chk.resolved};
    }
    if(it.ingredient_id){
      const ing = ingredientById(it.ingredient_id);
      if(!ing) throw _codeError('UNKNOWN_INGREDIENT');
      const unit = (it.unit == null || String(it.unit).trim() === '') ? null : String(it.unit).trim();
      const t = mergeTarget(ing.id), fin = t.ingredient || ing;
      const base = toBaseQty(q, unit || ing.base_unit, fin.base_unit, fin.weight_g_per_ml);
      if(base === null) throw _codeError('BAD_UNIT');
      if(base > WASTE_MAX_BASE_QTY) throw _codeError('BAD_QUANTITY');
      return {ingredient_id: ing.id, quantity: q, unit};
    }
    throw _codeError('BAD_WASTE');
  });
  const comp = reason === 'COMPLIMENTARY';
  if(comp && (!input.approved_by || !input.approval_token)) throw _codeError('APPROVAL_REQUIRED');
  return {id: input.id || uid(), reason, note: note || null, staff_id: input.staff_id || null, shift_id: input.shift_id || null,
    logged_at: input.logged_at || new Date().toISOString(), items,
    approved_by: comp ? input.approved_by : null, approval_token: comp ? input.approval_token : null};
}
// The stock a waste entry takes off, as the server will work it out (for the counter's own
// stock numbers until the next refresh): [{ingredient_id, quantity}] one line per ingredient.
// Menu items: the recipe's own modifiers on the CURRENT menu (as the server does), so pass the
// data from buildWasteData (or the items). Ingredients: typed amount converted to the stock unit
// of the ingredient it now lives in. Operating supplies left out.
function wasteStockLines(dataOrItems){
  const items = Array.isArray(dataOrItems) ? dataOrItems : ((dataOrItems && dataOrItems.items) || []);
  const lines = [];
  items.forEach(it => {
    if(!it) return;
    if(it.recipe_id){ inventoryLinesForSaleLine(it.recipe_id, it.quantity, (it.modifiers || []).map(m => ({group: m.group, label: m.label, group_id: m.group_id, option_id: m.option_id})), {raw: true}).forEach(l => lines.push(l)); return; }
    const ing = ingredientById(it.ingredient_id);
    if(!ing) return;
    const t = mergeTarget(ing.id), fin = t.ingredient || ing;
    const q = toBaseQty(it.quantity, it.unit || ing.base_unit, fin.base_unit, fin.weight_g_per_ml);
    if(q !== null && q > 0) lines.push({ingredient_id: t.id, quantity: q, kind: 'ingredient'});
  });
  return cleanStockLines(lines).map(l => ({ingredient_id: l.ingredient_id, quantity: l.quantity}));
}
// Ready for applyStockDeltas(): [{ingredient_id, transaction_type: 'WASTE', quantity}]
function wasteStockDeltas(dataOrItems){
  return wasteStockLines(dataOrItems).map(l => ({ingredient_id: l.ingredient_id, transaction_type: 'WASTE', quantity: l.quantity}));
}
// Cost of a waste entry at today's costs (preview only; the server's report uses its own costing).
function wasteCostPreview(dataOrItems){
  return wasteStockLines(dataOrItems).reduce((s, l) => s + l.quantity * (ingredientCosting(l.ingredient_id).current || 0), 0);
}

/* ================= Expenses (release 1.4, A11; Back Office, owner only) ================= */
const EXPENSE_CATEGORIES = [
  {id: 'SUPPLIES',  label: 'Operating supplies'},
  {id: 'RENT',      label: 'Rent'},
  {id: 'UTILITIES', label: 'Utilities (power, water)'},
  {id: 'INTERNET',  label: 'Internet'},
  {id: 'WAGES',     label: 'Wages'},
  {id: 'REPAIRS',   label: 'Repairs'},
  {id: 'OTHER',     label: 'Other'},
];
function expenseCategoryLabel(id){ const c = EXPENSE_CATEGORIES.find(x => x.id === id); return c ? c.label : String(id == null ? '' : id); }

/* ================= Option library: the database's checks, for the form (release 1.4, A9) =================
   optionGroupProblem({name, options, applies_to}) -> null when fine, else {field, text}
   (same rules as _library_group_problem; the server still checks: BAD_OPTION_GROUP: <field>). */
const OPTION_GROUP_RECIPE_TYPES = ['DRINKS', 'SAUCES_SYRUPS', 'PASTRY', 'FOOD'];
function optionGroupProblem(group){
  const P = (field) => ({field, text: optionGroupProblemText(field)});
  if(!group || typeof group !== 'object') return P('options');
  const name = String(group.name == null ? '' : group.name).trim();
  if(name.length < 1 || name.length > 40) return P('name');
  const a = group.applies_to == null ? {recipe_types: [], subcategories: []} : group.applies_to;
  if(!a || typeof a !== 'object' || Array.isArray(a)) return P('applies_to');
  const types = a.recipe_types == null ? [] : a.recipe_types, subs = a.subcategories == null ? [] : a.subcategories;
  if(!Array.isArray(types) || !Array.isArray(subs)) return P('applies_to');
  if(types.some(t => typeof t !== 'string' || OPTION_GROUP_RECIPE_TYPES.indexOf(t) < 0)) return P('recipe_types');
  if(subs.length > 100 || subs.some(t => typeof t !== 'string' || t.trim().length < 1 || t.trim().length > 40)) return P('subcategories');
  const opts = group.options;
  if(!Array.isArray(opts) || opts.length < 1 || opts.length > 30) return P('options');
  const ids = new Set(), labels = new Set();
  for(const o of opts){
    if(!o || typeof o !== 'object' || Array.isArray(o)) return P('option');
    const id = String(o.id == null ? '' : o.id);
    if(id.length < 1 || id.length > 64 || ids.has(id)) return P('option id');
    ids.add(id);
    const lab = String(o.label == null ? '' : o.label).trim();
    if(lab.length < 1 || lab.length > 40 || labels.has(lab.toLowerCase())) return P('option label');
    labels.add(lab.toLowerCase());
    const p = (o.price_delta == null || o.price_delta === '') ? 0 : Number(o.price_delta);
    if(!isFinite(p) || p < -100000 || p > 100000) return P('price_delta');
    const kind = String(o.kind == null ? 'PLAIN' : o.kind).toUpperCase();
    if(['PLAIN', 'EXTRA', 'SWAP'].indexOf(kind) < 0) return P('kind');
    if(kind === 'SWAP'){
      if(p < 0) return P('price_delta');
      if(!o.swap_from_ingredient_id || !o.swap_to_ingredient_id || o.swap_from_ingredient_id === o.swap_to_ingredient_id) return P('swap');
      if(!ingredientById(o.swap_from_ingredient_id) || !ingredientById(o.swap_to_ingredient_id)) return P('swap');
    } else if(Object.prototype.hasOwnProperty.call(o, 'extras')){
      if(!Array.isArray(o.extras) || o.extras.length > 5) return P('extras');
      for(const e of o.extras){
        const q = Number(e && (e.entered_quantity != null ? e.entered_quantity : e.quantity));
        if(!e || typeof e !== 'object' || !ingredientById(e.ingredient_id) || !(q > 0) || q > 1000000) return P('extras');
        if(e.entered_quantity != null && ingredientQtyToBase(ingredientById(e.ingredient_id), e.entered_quantity, e.unit) === null) return P('extras unit');
      }
    }
  }
  return null;
}
// Plain words for a BAD_OPTION_GROUP reason (also used by friendlyError in ui.js when present there).
function optionGroupProblemText(field){ return (typeof OPTION_GROUP_PROBLEM_TEXT !== 'undefined' && OPTION_GROUP_PROBLEM_TEXT[field]) || 'Check the option group and try again.'; }

/* ================= Stock check at payment (release 1.3, Q6) =================
   Owner decision 2026-11-02: an item that has run out must be REMOVED before payment
   (counter sales and QR orders alike; no "Add anyway?").
   cartStockProblems(lines, stock?) -> [{line, index, recipe_id, name, sold_out,
       short_ingredients: [{ingredient_id, name, needed, available}], alone_ok}]
   - lines: cart lines {recipe_id, name, quantity, modifiers} (the counter's posState.cart,
     or a QR order's items).
   - Every line is turned into stock lines with inventoryLinesForSaleLine (recipe + option
     extras − swap removes, cups and lids included, merged ingredients counted on their
     general ingredient, operating supplies left out: exactly what the sale will deduct,
     release 1.4), SUMMED over the whole cart per ingredient,
     so two lattes share the milk. An ingredient is short when the cart needs more than
     the counter's stock number by more than 0.001 of the base unit (state.stock;
     missing = 0, same as the server's _recipe_makeable / 009 OUT_OF_STOCK rule).
     Every line that uses a short ingredient is listed.
     needed = what the WHOLE cart needs of it, available = stock now.
   - A recipe marked sold out (recipes.sold_out) is always listed (sold_out: true).
   - alone_ok: this line would fit the stock if it were the only line (helps the cashier
     choose which line to remove); false for sold-out lines.
   - stock: optional {ingredient_id: qty} instead of state.stock (tests, previews).
   Returns [] when the cart can be paid. Lines keep their order; index = position in lines. */
const STOCK_EPSILON = 0.001;   // same as the server's OUT_OF_STOCK check (009 _sale_stock_review)
function cartStockProblems(lines, stock){
  stock = stock || state.stock || {};
  const have = (id) => Number(stock[id]) || 0;
  const per = (lines || []).map(line => {
    const sum = {};
    if(line && line.recipe_id){
      inventoryLinesForSaleLine(line.recipe_id, line.quantity, line.modifiers).forEach(l => {
        sum[l.ingredient_id] = (sum[l.ingredient_id] || 0) + Math.abs(Number(l.quantity) || 0);   // a sale always takes |qty| off (signedQty)
      });
    }
    return sum;
  });
  const total = {};
  per.forEach(sum => Object.keys(sum).forEach(id => { total[id] = (total[id] || 0) + sum[id]; }));
  const shortIds = new Set(Object.keys(total).filter(id => total[id] > 0 && total[id] - have(id) > STOCK_EPSILON));
  const out = [];
  (lines || []).forEach((line, index) => {
    if(!line) return;
    const rec = state.recipes.find(r => r.id === line.recipe_id);
    const soldOut = !!(rec && rec.sold_out);
    const short = Object.keys(per[index]).filter(id => per[index][id] > 0 && shortIds.has(id)).map(id => ({
      ingredient_id: id, name: ingName(id), needed: _unitRound(total[id]), available: _unitRound(have(id)),
    }));
    if(!soldOut && !short.length) return;
    const aloneOk = !soldOut && Object.keys(per[index]).every(id => !(per[index][id] > 0) || per[index][id] - have(id) <= STOCK_EPSILON);
    out.push({line, index, recipe_id: line.recipe_id, name: line.name || (rec && rec.name) || '',
      sold_out: soldOut, short_ingredients: short, alone_ok: aloneOk});
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
// CSV for Excel. A text cell starting with = + - @ tab or CR gets a leading ' so a
// spreadsheet never runs it as a formula. Numbers (JS numbers, or plain numeric text
// such as "-5.00" from toFixed) are left as they are so they stay numbers.
const CSV_PLAIN_NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
function csvSafeCell(c){
  if(c == null) return '';
  if(typeof c === 'number') return String(c);
  const s = String(c);
  if(/^[=+\-@\t\r]/.test(s) && !CSV_PLAIN_NUMBER.test(s)) return "'" + s;
  return s;
}
function toCSV(headers, rows){
  const esc = c => `"${csvSafeCell(c).replace(/"/g,'""')}"`;
  return [headers.map(esc).join(','), ...rows.map(r=>r.map(esc).join(','))].join('\n');
}

/* ================= Sale totals ================= */
// Recompute a sale's totals from source line items rather than trusting any cached total.
//   lines:    [{unit_price, quantity}]
//   discount: the manager discount {type:'percent'|'fixed', value} or null
//   settings: tax / service settings (default state.settings)
//   loyalty:  optional stamp-card reward (release 1.2): a number (₱), or {amount} /
//             {loyalty_discount}. Missing / 0 -> exactly the pre-1.2 result.
// S = subtotal, D = discount (at most S), R = min(reward, S − D) rounded to centavos
// (the server's rule in _loyalty_reward_amount), base = S − D − R,
// tax = inclusive ? 0 : base × tax%, service = base × service%, grand = base + tax + service.
// Returns {subtotal, discountAmt, loyaltyDiscount, tax, serviceCharge, grandTotal}.
function computeSaleTotals(lines, discount, settings, loyalty){
  settings = settings || state.settings;
  const subtotal = lines.reduce((s,l)=> s + (Number(l.unit_price||0) * Number(l.quantity||0)), 0);
  let discountAmt = 0;
  if(discount && discount.type==='percent') discountAmt = subtotal * (Number(discount.value)||0)/100;
  else if(discount && discount.type==='fixed') discountAmt = Number(discount.value)||0;
  discountAmt = Math.min(discountAmt, subtotal);
  const afterDiscount = subtotal - discountAmt;
  const loyaltyDiscount = capLoyaltyAmount(loyalty, afterDiscount);
  // R is rounded to centavos, so it can be up to ₱0.005 more than S − D: base never below 0
  // (the server refuses a negative tax / service charge; grand 0 is within its 2-centavo check).
  const base = loyaltyDiscount ? Math.max(0, afterDiscount - loyaltyDiscount) : afterDiscount;
  const taxPct = Number(settings.tax_pct)||0;
  const servicePct = Number(settings.service_charge_pct)||0;
  const tax = settings.tax_inclusive ? 0 : base * taxPct/100;
  const serviceCharge = base * servicePct/100;
  const grandTotal = base + tax + serviceCharge;
  return {subtotal, discountAmt, loyaltyDiscount, tax, serviceCharge, grandTotal: Math.round(grandTotal*100)/100};
}
// A reward amount (number, {amount} or {loyalty_discount}) capped at what is left after
// the manager discount, never below 0, rounded to centavos like the server.
function capLoyaltyAmount(loyalty, afterDiscount){
  let r = loyalty;
  if(r && typeof r === 'object') r = (r.loyalty_discount !== undefined && r.loyalty_discount !== null) ? r.loyalty_discount : r.amount;
  r = Number(r);
  if(!isFinite(r) || r <= 0) return 0;
  return roundMoney(Math.min(r, Math.max(0, Number(afterDiscount) || 0)));
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

/* ================= Stamp card (release 1.2, 008) =================
   The SERVER decides stamps, cards and which rewards are ready (_loyalty_summary)
   and checks every reward used on a sale. These helpers only read its answer for
   the screens and work out the money a chosen reward takes off the cart, by the
   same rule the server uses (_loyalty_reward_amount), so the two agree. */
const DEFAULT_LOYALTY_REWARDS = {card_size: 15, rewards: [
  {stamp: 5,  type: 'AMOUNT_OFF', amount: 10, label: '₱10 off'},
  {stamp: 10, type: 'AMOUNT_OFF', amount: 50, label: '₱50 off'},
  {stamp: 15, type: 'FREE_ITEM', label: 'One free drink or food'},
]};
// Recipe types a FREE_ITEM reward may be used on (same list as the server).
const REWARD_ITEM_TYPES = ['DRINKS', 'PASTRY', 'FOOD'];
function _isWholeNum(v){ return typeof v === 'number' && isFinite(v) && Math.floor(v) === v; }
// Same rule as the database's _valid_loyalty_rewards (else BAD_LOYALTY_REWARDS):
// {card_size: whole 1..100, rewards: 1..10 of {stamp: whole 1..card_size, each once,
//  type AMOUNT_OFF (amount above 0, at most 10000) | FREE_ITEM, label: text up to 40 or none}}.
function isValidLoyaltyRewards(p){
  if(!p || typeof p !== 'object' || Array.isArray(p)) return false;
  const size = p.card_size;
  if(!_isWholeNum(size) || size < 1 || size > 100) return false;
  if(!Array.isArray(p.rewards) || p.rewards.length < 1 || p.rewards.length > 10) return false;
  const seen = new Set();
  for(const r of p.rewards){
    if(!r || typeof r !== 'object' || Array.isArray(r) || !_isWholeNum(r.stamp)) return false;
    if(r.stamp < 1 || r.stamp > size || seen.has(r.stamp)) return false;
    seen.add(r.stamp);
    if(r.type !== 'AMOUNT_OFF' && r.type !== 'FREE_ITEM') return false;
    if(r.type === 'AMOUNT_OFF' && (typeof r.amount !== 'number' || !isFinite(r.amount) || r.amount <= 0 || r.amount > 10000)) return false;
    if(r.label !== undefined && r.label !== null && (typeof r.label !== 'string' || r.label.length > 40)) return false;
  }
  return true;
}
// A fresh copy of a valid stamp-card setting, else of the default (like the server's _loyalty_config).
function cleanLoyaltyRewards(p){
  if(typeof p === 'string'){ try{ p = JSON.parse(p); }catch(e){ p = null; } }
  return JSON.parse(JSON.stringify(isValidLoyaltyRewards(p) ? p : DEFAULT_LOYALTY_REWARDS));
}
// The shop's stamp card (settings.loyalty_rewards), rewards sorted by stamp.
function loyaltyConfig(settings){
  const c = cleanLoyaltyRewards((settings || (state && state.settings) || {}).loyalty_rewards);
  c.rewards.sort((a, b) => a.stamp - b.stamp);
  return c;
}
// Words for a reward: its label, else "₱10.00 off" / "One free drink or food".
function rewardLabel(r){
  if(!r) return '';
  if(r.label && String(r.label).trim()) return String(r.label);
  return r.type === 'AMOUNT_OFF' ? fmtMoney(r.amount) + ' off' : 'One free drink or food';
}
// "2:5" = the stamp-5 reward of card 2 (one reward can be used once).
function rewardKey(r){ return r ? (Number(r.card_no) || 1) + ':' + Number(r.stamp != null ? r.stamp : r.milestone) : ''; }
function _normReward(r){
  return {card_no: Number(r.card_no) || 1, stamp: Number(r.stamp), type: r.type,
          amount: (r.amount === null || r.amount === undefined || r.amount === '') ? null : Number(r.amount),
          label: rewardLabel(r)};
}
// Every reward the customer can use now (this card and earlier ones), oldest first,
// straight from the server's summary: [{card_no, stamp, type, amount, label}].
function readyRewards(summary){
  const list = summary && Array.isArray(summary.ready_rewards) ? summary.ready_rewards : [];
  return list.filter(r => r && (r.type === 'AMOUNT_OFF' || r.type === 'FREE_ITEM') && isFinite(Number(r.stamp)))
    .map(_normReward)
    .sort((a, b) => a.card_no - b.card_no || a.stamp - b.stamp);
}
// The stamp card to draw, from the server's summary (statuses from the server; the
// config only fills in when an older answer has no card):
//   {card_size, card_no, stamps_on_card, total_stamps,
//    milestones: [{stamp, type, amount, label, status: 'locked'|'ready'|'redeemed', to_go}],
//    next: {stamp, type, amount, label, to_go} | null   (the next locked reward on this card),
//    ready: readyRewards(summary), ready_count}
// to_go = stamps still needed for that reward (0 when reached).
function loyaltyCardView(summary, rewardsConfig){
  summary = summary || {};
  const cfg = cleanLoyaltyRewards(rewardsConfig || (state && state.settings && state.settings.loyalty_rewards));
  const card = summary.card && typeof summary.card === 'object' ? summary.card : null;
  const total = Math.max(0, Number(summary.total_stamps) || 0);
  const size = Math.max(1, Number(card && card.card_size) || cfg.card_size);
  const cardNo = Math.max(1, Number(card && card.card_no) || Math.max(Math.ceil(total / size), 1));
  const onCard = (card && card.stamps_on_card != null) ? Math.max(0, Number(card.stamps_on_card) || 0) : Math.max(0, total - (cardNo - 1) * size);
  const source = (card && Array.isArray(card.milestones) && card.milestones.length) ? card.milestones : cfg.rewards;
  const milestones = source.map(m => {
    const stamp = Number(m.stamp);
    const reached = onCard >= stamp;
    let status = m.status;
    if(status !== 'locked' && status !== 'ready' && status !== 'redeemed') status = reached ? 'ready' : 'locked';
    const r = _normReward(Object.assign({}, m, {card_no: cardNo}));
    return {stamp, type: r.type, amount: r.amount, label: r.label, status, to_go: Math.max(0, stamp - onCard)};
  }).sort((a, b) => a.stamp - b.stamp);
  const next = milestones.find(m => m.status === 'locked') || null;
  const ready = readyRewards(summary);
  return {card_size: size, card_no: cardNo, stamps_on_card: onCard, total_stamps: total, milestones,
    next: next ? {stamp: next.stamp, type: next.type, amount: next.amount, label: next.label, to_go: next.to_go} : null,
    ready, ready_count: ready.length};
}
// A line a FREE_ITEM reward can use: a whole quantity of at least 1 (server rule, 008 M3).
function _wholeQtyLine(l){ const q = Number(l && l.quantity); return isFinite(q) && q >= 1 && Math.floor(q) === q; }
// Cart lines a FREE_ITEM reward may be used on: a drink / pastry / food item, whole quantity >= 1.
function rewardEligibleLines(lines){
  return (lines || []).filter(l => {
    if(!l || !l.recipe_id || !_wholeQtyLine(l)) return false;
    const rec = state.recipes.find(r => r.id === l.recipe_id);
    return !!rec && REWARD_ITEM_TYPES.includes(recipeTypeOf(rec));
  });
}
// How much a chosen ready reward takes off this cart (₱, centavos):
//   AMOUNT_OFF -> its amount;
//   FREE_ITEM  -> the price of ONE of the chosen item: per line min(unit_price, line_total)
//                 (unit_price = recipe price + chosen options); only lines with a whole
//                 quantity >= 1 count, and if the item is on several the DEAREST counts (server rule).
//   Both capped at subtotal − manager discount.
//   choice: the chosen cart line ({recipe_id}) or a recipe id (FREE_ITEM only).
// Returns 0 when nothing applies (e.g. FREE_ITEM with no matching line).
function loyaltyRewardAmount(reward, lines, discount, choice){
  if(!reward) return 0;
  lines = lines || [];
  let amt = 0;
  if(reward.type === 'AMOUNT_OFF'){
    amt = Math.max(0, Number(reward.amount) || 0);
  } else if(reward.type === 'FREE_ITEM'){
    const rid = choice && typeof choice === 'object' ? choice.recipe_id : choice;
    if(!rid) return 0;
    lines.forEach(l => {
      if(!l || l.recipe_id !== rid || !_wholeQtyLine(l)) return;
      const unit = Math.max(0, Number(l.unit_price) || 0);
      const lt = (l.line_total === undefined || l.line_total === null || l.line_total === '') ? unit * Number(l.quantity) : Math.max(0, Number(l.line_total) || 0);
      amt = Math.max(amt, Math.min(unit, lt));
    });
  } else return 0;
  const t = computeSaleTotals(lines, discount, {tax_pct: 0, service_charge_pct: 0});
  return capLoyaltyAmount(amt, t.subtotal - t.discountAmt);
}
// The two fields a counter 'sale' op carries for a reward (contract D, put them on data.sale):
//   {loyalty_reward: {customer_id, card_no, milestone, recipe_id (FREE_ITEM only)}, loyalty_discount}
// amount = computeSaleTotals(..., amount).loyaltyDiscount. No reward -> {loyalty_discount: 0}.
function saleLoyaltyFields(reward, customerId, amount, recipeId){
  if(!reward || !customerId) return {loyalty_discount: 0};
  const lr = {customer_id: customerId, card_no: Number(reward.card_no) || 1, milestone: Number(reward.stamp != null ? reward.stamp : reward.milestone)};
  if(reward.type === 'FREE_ITEM' && recipeId) lr.recipe_id = recipeId;
  return {loyalty_reward: lr, loyalty_discount: roundMoney(amount)};
}

/* ================= Ingredient brands, first in first out (release 1.2, 008) =================
   The server works out which lot (delivery) is being used now and what is left of
   each brand (bo_bootstrap.brand_stock / ingredient_brand_stock()). These only read it:
   state.brandStock = [{ingredient_id, stock, in_use, brands, lots}], state.ingredientBrands =
   ingredient_brands rows. The counter has neither (both stay []). */
function brandStockFor(ingredientId){
  return (state.brandStock || []).find(b => b && b.ingredient_id === ingredientId) || null;
}
// The brand being used now (the oldest lot that still has stock):
// {brand_id, brand_name ('Not set' when the lot has no brand), price_per_base_unit (null = no price),
//  lot_id, lot_date, remaining} | null
function inUseBrand(ingredientId){
  const e = brandStockFor(ingredientId);
  const u = e && e.in_use;
  if(!u || typeof u !== 'object') return null;
  const p = (u.price_per_base_unit === null || u.price_per_base_unit === undefined || u.price_per_base_unit === '') ? null : Number(u.price_per_base_unit);
  return {brand_id: u.brand_id || null, brand_name: u.brand_id ? (u.brand_name || 'Not set') : 'Not set',
    price_per_base_unit: (p !== null && isFinite(p)) ? p : null,
    lot_id: u.lot_id || null, lot_date: u.lot_date || null, remaining: Number(u.remaining) || 0};
}
function brandsFor(ingredientId, includeInactive){
  return (state.ingredientBrands || []).filter(b => b && b.ingredient_id === ingredientId && (includeInactive || b.active !== false))
    .sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0) || String(a.name).localeCompare(String(b.name)));
}
function brandName(brandId){
  if(!brandId) return 'Not set';
  const b = (state.ingredientBrands || []).find(x => x.id === brandId);
  return b ? b.name : 'Not set';
}
function ingredientHasBrands(ingredientId){ return brandsFor(ingredientId).length > 0; }

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

/* ================= Branding / theme (shared) =================
   Release 1.2: settings.theme decides the look (brandTheme() in ui.js).
   - 'CCCC' (default; also missing / old 'light' / old 'dark'): the brand look from
     brand/tokens.css. Saved colours and fonts are NOT applied and no outside font is loaded.
   - 'CUSTOM': the shop's saved colours and font, mapped onto the --cc-* tokens. */
const FONT_OPTIONS = [
  {id:'default', label:'Default (CCCC brand fonts)', bodyStack:null},
  {id:'system', label:'System Default (fully offline)', bodyStack:"-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"},
  {id:'inter', label:'Inter', bodyStack:"'Inter', system-ui, sans-serif", cdn:'Inter:wght@400;500;600;700'},
  {id:'roboto', label:'Roboto', bodyStack:"'Roboto', system-ui, sans-serif", cdn:'Roboto:wght@400;500;700'},
  {id:'opensans', label:'Open Sans', bodyStack:"'Open Sans', system-ui, sans-serif", cdn:'Open+Sans:wght@400;600;700'},
  {id:'nunito', label:'Nunito', bodyStack:"'Nunito', system-ui, sans-serif", cdn:'Nunito:wght@400;600;700'},
  {id:'poppins', label:'Poppins', bodyStack:"'Poppins', system-ui, sans-serif", cdn:'Poppins:wght@400;500;600;700'},
];
const FONT_SIZES = {small:'13.5px', medium:'15px', large:'16.5px'};

function _hexParts(hex){
  hex = String(hex == null ? '' : hex).trim().replace('#','');
  if(hex.length===3) hex = hex.split('').map(c=>c+c).join('');
  if(!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
  const num = parseInt(hex,16);
  return [(num>>16)&0xFF, (num>>8)&0xFF, num&0xFF];
}
function _hexOf(rgb){ return '#'+rgb.map(v=>Math.max(0,Math.min(255,Math.round(v))).toString(16).padStart(2,'0')).join(''); }
function lightenHex(hex, percent){
  const p = _hexParts(hex);
  if(!p) return hex;
  return _hexOf(p.map(v => v+(255-v)*percent/100));
}
function darkenHex(hex, percent){
  const p = _hexParts(hex);
  if(!p) return hex;
  return _hexOf(p.map(v => v*(1-percent/100)));
}
function isHexColor(v){ return _hexParts(v) !== null; }

// Every CSS variable the custom theme may set on <html>; cleared again for the CCCC look.
const CUSTOM_THEME_VARS = ['--ui-dark','--cc-terracotta','--cc-terracotta-deep','--cc-terracotta-tint','--cc-butter',
  '--cc-paper','--cc-cream','--cc-card','--cc-ink','--cc-font-body','--cc-font-display'];

function applyFontChoice(fontId){
  const root = document.documentElement.style;
  const opt = FONT_OPTIONS.find(f=>f.id===fontId) || FONT_OPTIONS[0];
  if(opt.cdn && !document.getElementById('font-cdn-'+opt.id)){
    const link = document.createElement('link');
    link.id = 'font-cdn-'+opt.id; link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?family=${opt.cdn}&display=swap`;
    document.head.appendChild(link);
  }
  if(opt.bodyStack) root.setProperty('--cc-font-body', opt.bodyStack);
  else root.removeProperty('--cc-font-body');
  if(fontId==='system') root.setProperty('--cc-font-display', opt.bodyStack);
  else root.removeProperty('--cc-font-display');
}
// overrides: a settings-like object (Back Office preview), else state.settings.
function applyCustomTheme(overrides){
  const s = overrides || state.settings || {};
  const root = document.documentElement.style;
  CUSTOM_THEME_VARS.forEach(v => root.removeProperty(v));
  // Old (pre-1.2) variables this function used to set: clear them so the brand mapping in styles.css applies.
  ['--espresso-dark','--espresso','--green','--green-light','--amber','--cream','--white','--text','--font-body','--font-display']
    .forEach(v => root.removeProperty(v));
  root.setProperty('--base-font-size', FONT_SIZES[s.font_size]||FONT_SIZES.medium);
  if(brandTheme(s) === 'CUSTOM'){
    const set = (v, hex) => { if(isHexColor(hex)) root.setProperty(v, hex); };
    set('--ui-dark', s.primary_color);                       // sidebar, sign-in backdrop, toasts
    if(isHexColor(s.secondary_color)){                        // main buttons, active item
      root.setProperty('--cc-terracotta', s.secondary_color);
      root.setProperty('--cc-terracotta-deep', darkenHex(s.secondary_color, 22));
      root.setProperty('--cc-terracotta-tint', lightenHex(s.secondary_color, 85));
    }
    set('--cc-butter', s.accent_color);                       // accents on dark, badges
    set('--cc-paper', s.background_color);
    if(isHexColor(s.background_color)) root.setProperty('--cc-cream', darkenHex(s.background_color, 3));
    set('--cc-card', s.card_color);
    set('--cc-ink', s.text_color);
    applyFontChoice(s.font_family);
  }
  document.body.classList.toggle('dark', s.theme==='dark');   // old dark mode (pre-1.2 setting)
}

/* ================= Sub-category tile colours (release 1.2) =================
   The database stores a KEY per sub-category name (settings.subcategory_colors,
   e.g. {"Iced coffee": "terracotta"}); the colours live in brand/tokens.css.
   Raw colour codes are never accepted here. */
const TILE_COLORS = {
  terracotta:      {label:'Terracotta'},
  deep_terracotta: {label:'Deep terracotta'},
  olive:           {label:'Olive'},
  gold:            {label:'Gold', light:true},
  butter:          {label:'Butter', light:true},
  ink:             {label:'Ink'},
  sage:            {label:'Sage', light:true},
  clay:            {label:'Clay', light:true},
  cocoa:           {label:'Cocoa'},
  sky:             {label:'Sky', light:true},
};
const TILE_COLOR_KEYS = Object.keys(TILE_COLORS);
function isTileColorKey(key){ return typeof key === 'string' && Object.prototype.hasOwnProperty.call(TILE_COLORS, key); }
// Keeps only {name: known key} pairs (same rule as the database check).
function cleanSubcategoryColors(map){
  const out = {};
  if(!map || typeof map !== 'object' || Array.isArray(map)) return out;
  Object.keys(map).forEach(name => {
    const n = String(name).trim();
    if(n && n.length <= 40 && isTileColorKey(map[name])) out[name] = map[name];
  });
  return out;
}
// tileColorKeyFor('Iced coffee') -> 'terracotta' | null (not set / unknown).
// Exact name first, then a case- and space-insensitive match.
function tileColorKeyFor(subcategoryName){
  const map = state && state.settings && state.settings.subcategory_colors;
  if(!map || typeof map !== 'object' || subcategoryName == null) return null;
  const name = String(subcategoryName);
  if(Object.prototype.hasOwnProperty.call(map, name)) return isTileColorKey(map[name]) ? map[name] : null;
  const want = name.trim().toLowerCase();
  if(!want) return null;
  const hit = Object.keys(map).find(k => k.trim().toLowerCase() === want);
  return hit && isTileColorKey(map[hit]) ? map[hit] : null;
}
// tileStyleVars('olive') -> 'background:var(--tile-olive-bg);color:var(--tile-olive-fg);'
// Light tiles also get a thin border so they show on the paper background.
// Unknown / empty key -> '' (the screen keeps its default tile look).
function tileStyleVars(key){
  if(!isTileColorKey(key)) return '';
  return `background:var(--tile-${key}-bg);color:var(--tile-${key}-fg);`
    + (TILE_COLORS[key].light ? 'border-color:var(--tile-border-light);border-style:solid;border-width:1px;' : '');
}

/* ================= Sub-category order (release 1.3, A16) =================
   settings.subcategory_order (009): the owner's arranged list of sub-category names.
   Rule (owner): drinks sub-categories ALWAYS first, then pastry, then food, then the rest;
   inside each block the owner's order; names not in the list go to the end of their
   block, A to Z. The pure sorter is sortSubcategoryNames() in ui.js (the QR page has no
   logic.js); these wrap it with the shop's recipes and settings. */
// Keeps a clean list: text names, trimmed, 1..40 characters, each once (case-insensitive), at most 100
// (the 009 database rule _valid_subcategory_order; the Back Office can save the result as it is).
function cleanSubcategoryOrder(list){
  if(typeof list === 'string'){ try{ list = JSON.parse(list); }catch(e){ list = null; } }
  if(!Array.isArray(list)) return [];
  const seen = new Set(), out = [];
  list.forEach(n => {
    if(typeof n !== 'string') return;
    const t = n.trim();
    const k = subcategoryKey(t);
    if(!t || t.length > 40 || seen.has(k) || out.length >= 100) return;
    seen.add(k); out.push(t);
  });
  return out;
}
// The shop's arranged list ([] when 009 isn't installed yet or nothing is arranged).
function subcategoryOrder(settings){
  const s = settings || (state && state.settings) || {};
  return cleanSubcategoryOrder(s.subcategory_order);
}
// {sub-category name: recipe_type} for recipes (default: the shop's active recipes).
// A sub-category's type = the type most of its items have; a tie goes to the type of
// its first item (menu order: sort_order, then name).
function subcategoryTypeMap(recipes){
  const list = (recipes || state.recipes || []).filter(r => r && r.active !== false)
    .slice().sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0) || String(a.name || '').localeCompare(String(b.name || '')));
  const counts = Object.create(null), first = Object.create(null);   // no inherited keys ("constructor" is a name)
  list.forEach(r => {
    const name = posCategoryOf(r), t = recipeTypeOf(r);
    counts[name] = counts[name] || Object.create(null);
    counts[name][t] = (counts[name][t] || 0) + 1;
    if(!(name in first)) first[name] = t;
  });
  const out = Object.create(null);
  Object.keys(counts).forEach(name => {
    let best = first[name], bestN = counts[name][best];
    Object.keys(counts[name]).forEach(t => { if(counts[name][t] > bestN){ best = t; bestN = counts[name][t]; } });
    out[name] = best;
  });
  return out;
}
function _subcategoryTypeOf(recipesOrTypes){
  if(typeof recipesOrTypes === 'function') return recipesOrTypes;
  const map = (recipesOrTypes && !Array.isArray(recipesOrTypes) && typeof recipesOrTypes === 'object')
    ? recipesOrTypes : subcategoryTypeMap(Array.isArray(recipesOrTypes) ? recipesOrTypes : undefined);
  const loose = Object.create(null);
  Object.keys(map).forEach(k => { loose[subcategoryKey(k)] = map[k]; });
  return (name) => Object.prototype.hasOwnProperty.call(map, name) ? map[name] : loose[subcategoryKey(name)];
}
// sortSubcategories(names, recipesOrTypes?) -> a new array in menu order.
//   recipesOrTypes: recipe rows (default state.recipes), a {name: recipe_type} map, or a
//   function name -> recipe_type. The order comes from state.settings.subcategory_order.
function sortSubcategories(names, recipesOrTypes){
  return sortSubcategoryNames(names, _subcategoryTypeOf(recipesOrTypes), subcategoryOrder());
}
// A number to sort by (smaller = earlier): block × 1000 + place in the owner's list
// (999 when not listed; ties among unlisted names are broken A to Z by the sorter).
function subcategoryRank(name, recipesOrTypes){
  const typeOf = _subcategoryTypeOf(recipesOrTypes);
  const order = subcategoryOrder().map(subcategoryKey);
  const i = order.indexOf(subcategoryKey(name));
  return subcategoryBlock(typeOf(name)) * 1000 + (i < 0 ? 999 : Math.min(i, 998));
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

// Release 1.2: the stamp-card rewards line. Kept out of SALES_LABELS / SALES_HINTS so
// those stay as they were (tests pin their keys); salesSummaryRows() uses these words.
const LOYALTY_SALES_LABEL = 'Loyalty rewards';
const LOYALTY_SALES_HINT = 'Stamp card rewards customers used, taken off after discounts.';

// The full accounting picture for one shift (same maths as the original POS, incl. the
// void double-count fix). `data` lets reports pass their own loaded records; otherwise state.
// Sales figures (finished sales = not HELD, not VOIDED):
//   itemSales     = Σ subtotals                  ("Item sales (before discounts)")
//   discounts     = Σ discounts
//   loyaltyRewards = Σ loyalty_discount (stamp card rewards, release 1.2)
//   itemSales − discounts − loyaltyRewards + taxAndService = sales
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
  const loyaltyRewards = nonVoided.reduce((s,x)=> s + Number(x.loyalty_discount||0), 0);
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
    itemSales: grossSales, discounts: discountTotal, loyaltyRewards, taxAndService: taxTotal + serviceTotal,
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
// The "Loyalty rewards" row (after Discounts) appears only when rewards were used
// (m.loyaltyRewards > 0), so a shift without rewards shows the same rows as before.
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
    loyaltyRewards: Number(m.loyaltyRewards) || 0,
    taxAndService: m.taxAndService,
    sales: (savedNet !== null && savedRefunds !== null) ? savedNet + savedRefunds : m.sales,
    refunds: savedRefunds !== null ? savedRefunds : m.refunds,
    netSales: savedNet !== null ? savedNet : m.netSales,
  };
  const sign = {discounts: '-', loyaltyRewards: '-', taxAndService: '+', refunds: '-'};
  const keys = ['itemSales', 'discounts'].concat(v.loyaltyRewards > 0 ? ['loyaltyRewards'] : [], ['taxAndService', 'sales', 'refunds', 'netSales']);
  return keys.map(key => ({
    key, label: key === 'loyaltyRewards' ? LOYALTY_SALES_LABEL : SALES_LABELS[key],
    hint: key === 'loyaltyRewards' ? LOYALTY_SALES_HINT : SALES_HINTS[key], amount: Number(v[key]) || 0,
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
// opts.rewardLabel: words of the stamp reward used (e.g. "₱10 off"), shown as
// "Stamp reward: ₱10 off" when sale.loyalty_discount > 0 (else just "Stamp reward").
// opts.paperWidth: 58 | 80 (release 1.3). Missing: this counter's printer setting when
// printer.js is loaded (Printer.settings().paper_width), else 80 (the layout used before 1.3).
// 58 mm: a narrower page (@page size 58mm) for small receipt printers in the print dialog.
function receiptHtml(sale, items, payments, opts){
  opts = opts || {};
  const s = state.settings;
  const pay = (payments||[])[0] || {};
  let paper = Number(opts.paperWidth);
  if(paper !== 58 && paper !== 80){
    try{ paper = (typeof Printer !== 'undefined' && Printer.settings) ? Number(Printer.settings().paper_width) : 80; }catch(e){ paper = 80; }
    if(paper !== 58) paper = 80;
  }
  const printCss = paper === 58
    ? `@page{size:58mm auto;margin:0;} body{width:200px;font-size:11.5px;}
      @media print{ body{width:58mm;margin:0;padding:0 1.5mm;box-sizing:border-box;font-size:9.5px;} .biz{font-size:12.5px;} .small,.modline{font-size:8.5px;} .logo{width:34px;height:34px;} }`
    : `@media print{ body{width:80mm;margin:0;font-size:11px;} }`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Receipt ${escapeHtml(sale.transaction_number||'')}</title>
    <style>
      body{font-family:'Courier New',monospace;width:300px;margin:20px auto;color:#111;font-size:12.5px;}
      .center{text-align:center;} .row{display:flex;justify-content:space-between;gap:8px;}
      hr{border:none;border-top:1px dashed #888;margin:8px 0;}
      .logo{width:44px;height:44px;object-fit:contain;margin:0 auto 6px;display:block;}
      .biz{font-weight:700;font-size:15px;} .small{font-size:11px;color:#555;}
      .items td{padding:2px 0;vertical-align:top;} table{width:100%;border-collapse:collapse;}
      .modline{font-size:10.5px;color:#555;padding-left:8px;}
      ${printCss}
    </style></head><body class="paper-${paper}">
    <div class="center">
      ${s.logo_url?`<img class="logo" src="${escapeHtml(s.logo_url)}">`:''}
      <div class="biz">${escapeHtml(businessName()||appDisplayName())}</div>
      ${s.business_address?`<div class="small">${escapeHtml(s.business_address)}</div>`:''}
      ${s.business_contact?`<div class="small">${escapeHtml(s.business_contact)}</div>`:''}
      ${s.business_tin?`<div class="small">TIN: ${escapeHtml(s.business_tin)}</div>`:''}
      ${s.receipt_header?`<div class="small">${escapeHtml(s.receipt_header)}</div>`:''}
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
    ${Number(sale.loyalty_discount)>0?`<div class="row"><span>${opts.rewardLabel?'Stamp reward: '+escapeHtml(opts.rewardLabel):'Stamp reward'}</span><span>-${fmtMoney(sale.loyalty_discount)}</span></div>`:''}
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
