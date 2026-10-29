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

/* ---- Unit conversion for typing/display (owner request #3, 2026-10-25) ----
   Every STORED quantity stays in the ingredient's base unit. These helpers only
   convert what the owner types (e.g. 150 mL for a base unit of L) and how a
   base quantity is shown. They never touch money or stock formulas. */
function _unitRound(n){ return Math.round(n * 1e6) / 1e6; }
function _unitTable(unit){
  if(unit in WEIGHT_UNITS) return WEIGHT_UNITS;
  if(unit in VOLUME_UNITS) return VOLUME_UNITS;
  return null;
}
// Units the owner may type for an ingredient with this base unit.
function compatibleUnits(baseUnit){
  if(baseUnit in WEIGHT_UNITS) return ['g','kg'];
  if(baseUnit in VOLUME_UNITS) return ['ml','L'];
  return baseUnit ? [baseUnit] : [];
}
// qty in fromUnit -> qty in toUnit; null when the units are not the same family.
function convertQuantity(qty, fromUnit, toUnit){
  const q = Number(qty);
  if(!isFinite(q)) return null;
  if(fromUnit === toUnit) return q;
  const t = _unitTable(fromUnit);
  if(!t || !(toUnit in t)) return null;   // different family, or count units
  return _unitRound(q * (t[fromUnit] / t[toUnit]));
}
// Typed qty+unit -> base-unit qty (unit missing = already base). null if incompatible.
function toBaseUnit(qty, unit, baseUnit){
  return convertQuantity(qty, unit || baseUnit, baseUnit);
}
// Base-unit qty -> {qty, unit} in displayUnit (falls back to baseUnit when missing/incompatible).
function fromBaseUnit(qtyBase, baseUnit, displayUnit){
  const q = Number(qtyBase) || 0;
  if(displayUnit && displayUnit !== baseUnit){
    const v = convertQuantity(q, baseUnit, displayUnit);
    if(v != null) return {qty: v, unit: displayUnit};
  }
  return {qty: _unitRound(q), unit: baseUnit};
}
function unitLabel(unit){ return unit === 'ml' ? 'mL' : (unit == null ? '' : String(unit)); }
// e.g. formatQuantity(0.15, 'L', 'ml') -> "150 mL"; formatQuantity(100, 'g', 'kg') -> "0.1 kg"
function formatQuantity(qtyBase, baseUnit, displayUnit, dp=2){
  const r = fromBaseUnit(qtyBase, baseUnit, displayUnit);
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
  // Release 1.2 (owner: "cost follows what we're currently using"): an ingredient with
  // brands costs what the lot in use now cost (its purchase price per base unit).
  // No lot in use, or that lot has no price (e.g. starting stock) -> the method above.
  let costSource = 'purchases', inUse = null;
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
// Cart lines a FREE_ITEM reward may be used on: a drink / pastry / food item with quantity > 0.
function rewardEligibleLines(lines){
  return (lines || []).filter(l => {
    if(!l || !l.recipe_id || !(Number(l.quantity) > 0)) return false;
    const rec = state.recipes.find(r => r.id === l.recipe_id);
    return !!rec && REWARD_ITEM_TYPES.includes(recipeTypeOf(rec));
  });
}
// How much a chosen ready reward takes off this cart (₱, centavos):
//   AMOUNT_OFF -> its amount;
//   FREE_ITEM  -> the price of ONE of the chosen item (cart line unit_price = recipe price
//                 + chosen options). If the same item is on several lines the DEAREST line
//                 counts, as on the server.
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
      if(l && l.recipe_id === rid && Number(l.quantity) > 0) amt = Math.max(amt, Math.max(0, Number(l.unit_price) || 0));
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
