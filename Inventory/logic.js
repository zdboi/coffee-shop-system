/* ================= Business logic: units, costing, inventory ================= */

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
// unitsPerPurchaseUnit: for box/pack purchases, how many base units each purchase unit contains.
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
  // count-based, or purchase unit is box/pack -> use explicit conversion factor
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
// Returns {latest, weightedAvg, lowest, highest, count, totalQty, totalSpend}
function computeCostingStats(purchases, asOfDate){
  let list = purchases.slice();
  if(asOfDate){
    const cutoff = new Date(asOfDate).getTime();
    list = list.filter(p => new Date(p.purchase_date).getTime() <= cutoff);
  }
  if(list.length === 0) return {latest:null, weightedAvg:null, lowest:null, highest:null, count:0, totalQty:0, totalSpend:0};
  list.sort((a,b)=> new Date(a.purchase_date) - new Date(b.purchase_date));
  const latest = list[list.length-1].price_per_base_unit;
  let totalQty=0, totalSpend=0, lowest=Infinity, highest=-Infinity;
  list.forEach(p=>{
    totalQty += Number(p.base_quantity)||0;
    totalSpend += Number(p.total_price)||0;
    if(p.price_per_base_unit < lowest) lowest = p.price_per_base_unit;
    if(p.price_per_base_unit > highest) highest = p.price_per_base_unit;
  });
  const weightedAvg = totalQty>0 ? totalSpend/totalQty : latest;
  return {latest, weightedAvg, lowest, highest, count:list.length, totalQty, totalSpend};
}

// Current cost per costing method setting ('latest' | 'weighted_average')
function currentCostFor(ingredient, purchasesForIngredient, method){
  const stats = computeCostingStats(purchasesForIngredient);
  if(stats.count === 0) return 0;
  return method === 'latest' ? stats.latest : stats.weightedAvg;
}

/* ---------- Inventory ---------- */
const TXN_SIGN = {
  PURCHASE: 1,
  INITIAL_STOCK: 1,
  USAGE: -1,
  WASTE: -1,
  ADJUSTMENT: 1, // adjustment quantity itself carries the sign
  PRODUCTION: 1,      // NEW: a produced batch adds its actual yield to the produced item's stock
  PRODUCTION_USE: -1, // NEW: raw/produced ingredients consumed while making a production batch
  SALE_USAGE: -1,      // POS: ingredients consumed by a completed sale
  SALE_REVERSAL: 1,    // POS: inventory returned by a refund/void
};

function computeStockFromTransactions(transactions){
  let stock = 0;
  const sorted = transactions.slice().sort((a,b)=> new Date(a.transaction_date) - new Date(b.transaction_date));
  sorted.forEach(t=>{
    const q = Number(t.quantity)||0;
    if(t.transaction_type === 'ADJUSTMENT'){
      stock += q; // signed value already
    } else {
      stock += TXN_SIGN[t.transaction_type] * Math.abs(q);
    }
  });
  return stock;
}

/* ---------- Production batches ---------- */
// Adapts production batch records into the same shape computeCostingStats() expects,
// so batch-level cost stats (latest/weighted-avg/lowest/highest actual cost) can reuse
// the exact same math as purchase-based costing.
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
   SHARED APPLICATION STATE & DOMAIN LOGIC
   Used identically by the Inventory app and the POS app — both are pages
   on the same origin sharing the SAME IndexedDB database, so this is the
   one, single-source-of-truth costing/inventory engine for both. The POS
   never recomputes ingredient costs or stock with its own logic; it calls
   these exact functions, per the "must come from the existing recipe
   system, not hard-coded POS logic" requirement.
   ===================================================================== */

const state = {
  ingredients: [], categories: [], suppliers: [], purchases: [], recipes: [],
  recipeIngredients: [], inventoryTransactions: [], waste: [], productionBatches: [],
  sales: [], saleItems: [], payments: [], refunds: [], auditLog: [], users: [],
  shifts: [], cashMovements: [],
  settings: {}, route: 'dashboard', routeParam: null,
};

const SCHEMA_VERSION = 4; // bumped for the shift management / cash handling update

const DEFAULT_SETTINGS = {
  key:'app', currency:'PHP', currencySymbol:'₱', costingMethod:'weighted_average',
  lowStockDefaultThreshold: 10, foodCostWarningPct: 35, theme:'light',
  autoBackupLocal:false, autoBackupGDrive:false, backupFrequency:'daily',
  lastLocalBackup:null, lastGDriveBackup:null,
  gdriveClientId:'', gdriveConnected:false, gdriveFolderId:'',
  schemaVersion: 1, // legacy DBs read as 1 until migrated; used only for the one-time safety backup
  // ---- Customization (application_settings) ----
  business_name: '', app_name: 'Brew Ledger', logo: null, // logo: dataURL string or null
  primary_color: '#241209', secondary_color: '#33513f', accent_color: '#c17a3d',
  background_color: '#f7f1e6', card_color: '#fffdf9', text_color: '#2c1e14',
  font_family: 'default', font_size: 'medium',
  // ---- POS / receipt / business info ----
  business_address: '', business_contact: '',
  tax_pct: 0, service_charge_pct: 0, tax_inclusive: false,
  receipt_footer: 'Thank you! Please come again.',
  device_tag: '', // short auto-generated code identifying this device/terminal, for transaction numbering
  backup_retain_count: 10,
};

const CATEGORY_SEED = ['Coffee','Dairy & Milk Alternatives','Syrups & Sauces','Sweeteners','Tea & Powders','Ice & Water','Packaging','Other'];
const PRODUCED_CATEGORY_NAME = 'House-Made / Produced';
const ALL_STORES_FOR_BACKUP = ['categories','suppliers','ingredients','purchases','recipes','recipeIngredients',
  'inventoryTransactions','waste','productionBatches','sales','saleItems','payments','refunds','auditLog','users',
  'shifts','cashMovements'];

function uid(prefix){
  return (prefix?prefix+'_':'') + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,9);
}

function shortDeviceTag(){
  return Math.random().toString(36).slice(2,6).toUpperCase();
}

async function loadAll(){
  const results = await Promise.all(ALL_STORES_FOR_BACKUP.map(s => DB.all(s)));
  ALL_STORES_FOR_BACKUP.forEach((s,i)=>{ state[s] = results[i]; });
}

async function seedInitialData(){
  const cats = CATEGORY_SEED.map(name => ({id: uid('cat'), name}));
  await DB.bulkPut('categories', cats);
  const bySupplier = {id: uid('sup'), name:'Local Supplier', contact:'', phone:'', email:'', address:'', notes:'Default supplier — edit or add more in Suppliers.'};
  await DB.put('suppliers', bySupplier);
}

// Additive-only: create the "House-Made / Produced" category if it doesn't exist yet.
async function ensureProducedCategory(){
  if(!state.categories.some(c=>c.name===PRODUCED_CATEGORY_NAME)){
    const cat = {id: uid('cat'), name: PRODUCED_CATEGORY_NAME};
    await DB.put('categories', cat);
    state.categories.push(cat);
  }
}
function producedCategoryId(){
  return state.categories.find(c=>c.name===PRODUCED_CATEGORY_NAME)?.id;
}

/* ================= Shared domain helpers ================= */
function catName(id){ return state.categories.find(c=>c.id===id)?.name || '—'; }
function supName(id){ return state.suppliers.find(s=>s.id===id)?.name || '—'; }
function ingName(id){ return state.ingredients.find(i=>i.id===id)?.name || '(deleted ingredient)'; }
function ingredientById(id){ return state.ingredients.find(i=>i.id===id); }
function purchasesFor(ingredientId){ return state.purchases.filter(p=>p.ingredientId===ingredientId); }
function txnsFor(ingredientId){ return state.inventoryTransactions.filter(t=>t.ingredientId===ingredientId); }
function costingMethod(){ return state.settings.costingMethod || 'weighted_average'; }
function appDisplayName(){ return (state.settings && state.settings.app_name) || 'Brew Ledger'; }
function businessName(){ return (state.settings && state.settings.business_name) || ''; }

const RECIPE_TYPES = [
  {id:'DRINKS', label:'Drinks'},
  {id:'SAUCES_SYRUPS', label:'Sauces / Syrups'},
  {id:'PASTRY', label:'Pastry'},
  {id:'FOOD', label:'Food'},
];
function recipeTypeOf(recipe){ return recipe.recipe_type || 'DRINKS'; }
function recipeTypeLabel(typeId){ return RECIPE_TYPES.find(t=>t.id===typeId)?.label || typeId; }

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
  return state.productionBatches.filter(b=>b.producedIngredientId===ingredientId);
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
  return computeStockFromTransactions(txnsFor(ingredientId));
}

function recipeCost(recipeId, visiting){
  visiting = visiting || new Set();
  if(visiting.has('recipe:'+recipeId)) return {lines:[], total:0, cyclic:true};
  visiting.add('recipe:'+recipeId);
  const items = state.recipeIngredients.filter(ri=>ri.recipeId===recipeId);
  let total = 0;
  const lines = items.map(ri=>{
    const costing = ingredientCosting(ri.ingredientId, visiting);
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
  const items = state.recipeIngredients.filter(ri=>ri.recipeId===recipeId);
  const method = costingMethod();
  let total = 0;
  items.forEach(ri=>{
    const ing = ingredientById(ri.ingredientId);
    let cost = 0;
    if(ing && isProducedItem(ing)){
      const recipe = sourceRecipeForIngredient(ing);
      if(recipe && Number(recipe.expected_yield) > 0){
        cost = recipeCostAsOf(recipe.id, date, visiting) / Number(recipe.expected_yield);
      } else {
        const stats = computeCostingStats(productionBatchesAsCostRecords(productionBatchesFor(ri.ingredientId)), date);
        cost = stats.count ? stats.weightedAvg : 0;
      }
    } else {
      const stats = computeCostingStats(purchasesFor(ri.ingredientId), date);
      cost = stats.count ? (method==='latest'?stats.latest:stats.weightedAvg) : 0;
    }
    total += cost * Number(ri.quantity||0);
  });
  return total;
}

/* ================= Shared backup/restore core (pure — no UI calls) ================= */
function fileNameSlug(){
  return ((appDisplayName()||'brew-ledger').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'')) || 'brew-ledger';
}
function downloadFile(filename, content, mime){
  const blob = new Blob([content], {type: mime});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 2000);
}
async function buildBackupPayload(){
  await loadAll();
  const data = {};
  ALL_STORES_FOR_BACKUP.forEach(s => { data[s] = state[s]; });
  data.settings = state.settings;
  return {
    app: 'Coffee Shop System (Inventory + POS)', version: SCHEMA_VERSION, exported_at: new Date().toISOString(),
    app_name_at_export: appDisplayName(),
    data,
  };
}
// Pure DB-level restore. Callers (each app's own restoreFromPayload wrapper) are
// responsible for refreshing their own UI afterwards.
async function restoreFromPayloadCore(payload){
  const d = payload.data;
  for(const store of ALL_STORES_FOR_BACKUP){
    await DB.clearStore(store);
    if(d[store] && d[store].length) await DB.bulkPut(store, d[store]);
  }
  if(d.settings){
    const merged = {...DEFAULT_SETTINGS, ...d.settings, key:'app'};
    await DB.put('settings', merged);
    state.settings = merged;
  }
  await loadAll();
}
async function estimateDbSize(){
  try{
    const payload = await buildBackupPayload();
    const bytes = new Blob([JSON.stringify(payload)]).size;
    if(bytes<1024) return bytes+' B';
    if(bytes<1024*1024) return (bytes/1024).toFixed(1)+' KB';
    return (bytes/1024/1024).toFixed(2)+' MB';
  }catch(e){ return 'unknown'; }
}

/* ================= POS-shared: transaction numbering, totals, audit ================= */
// Human-readable transaction numbers are unique per device by construction (device_tag +
// year + sequence). The internal `id` (uid()) is what's actually guaranteed globally unique
// even across devices — see ARCHITECTURE.md for why real-time cross-device numbering needs
// a server, which this build intentionally does not fake.
function nextTransactionNumber(){
  const year = new Date().getFullYear();
  const tag = state.settings.device_tag || 'A';
  const countThisYear = state.sales.filter(s => s.transaction_number && s.transaction_number.includes(`-${tag}-${year}-`)).length;
  return `POS-${tag}-${year}-${String(countThisYear+1).padStart(6,'0')}`;
}

// Recompute a sale's totals from source line items rather than trusting any cached/carried
// total — defense against stale UI state (not a security boundary; see ARCHITECTURE.md).
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

async function logAudit(action, actorName, details, referenceId){
  const entry = {
    id: uid('audit'), action, actor: actorName||'Unknown', details: details||'',
    reference_id: referenceId||null, at: new Date().toISOString(),
  };
  await DB.put('auditLog', entry);
  state.auditLog.push(entry);
  return entry;
}

/* ================= Backup location, scheduling & retention (shared) =================
   Uses the File System Access API (Chrome/Edge) to save backups directly into a chosen
   folder — e.g. a USB drive, an external drive, or a synced local network folder — and to
   enforce a retention count by deleting the oldest backups in THAT folder. Firefox/Safari
   don't support this API; on those browsers backups fall back to a normal file download,
   which is why every backup call still also triggers the download path as a safety net. */
const FS_ACCESS_SUPPORTED = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

async function getSavedBackupFolderHandle(){
  try{ const rec = await DB.get('deviceConfig','backupFolderHandle'); return rec ? rec.handle : null; }
  catch(e){ return null; }
}
async function chooseBackupFolder(){
  if(!FS_ACCESS_SUPPORTED) throw new Error('Choosing a backup folder needs Chrome or Edge — this browser will use normal downloads instead.');
  const handle = await window.showDirectoryPicker({mode:'readwrite'});
  await DB.put('deviceConfig', {key:'backupFolderHandle', handle, name: handle.name});
  return handle;
}
async function clearBackupFolder(){
  await DB.delete('deviceConfig','backupFolderHandle');
}
async function verifyFolderPermission(handle){
  if(!handle) return false;
  const opts = {mode:'readwrite'};
  if((await handle.queryPermission(opts))==='granted') return true;
  if((await handle.requestPermission(opts))==='granted') return true;
  return false;
}
// Writes into the chosen folder AND enforces retention (deletes oldest matching files
// beyond retainCount). Returns true if written to the folder, false if unavailable
// (caller should still fall back to a normal browser download either way).
async function writeBackupToFolder(filename, contentString, retainCount){
  const handle = await getSavedBackupFolderHandle();
  if(!handle) return false;
  const ok = await verifyFolderPermission(handle);
  if(!ok) return false;
  const fileHandle = await handle.getFileHandle(filename, {create:true});
  const writable = await fileHandle.createWritable();
  await writable.write(contentString);
  await writable.close();
  // Retention: list files matching our backup naming pattern, delete oldest beyond retainCount
  if(retainCount && retainCount>0){
    const entries = [];
    for await (const [name, entry] of handle.entries()){
      if(entry.kind==='file' && /-backup-.*\.json$/.test(name)) entries.push(name);
    }
    entries.sort(); // timestamped filenames sort chronologically
    const toDelete = entries.slice(0, Math.max(0, entries.length - retainCount));
    for(const name of toDelete){
      try{ await handle.removeEntry(name); }catch(e){ /* best-effort */ }
    }
  }
  return true;
}

// Given a last-backup ISO timestamp and a frequency, returns the next due Date.
// "yearly"/"monthly"/"weekly"/"daily" all follow a catch-up-on-open model: if the device
// was off when a backup was due, it simply runs the next time the app is opened — there is
// no OS-level background scheduler for a browser tab, so this is the honest, correct model.
function nextBackupDueDate(lastBackupISO, frequency){
  const last = lastBackupISO ? new Date(lastBackupISO) : null;
  if(!last) return new Date(); // never backed up — due now
  const next = new Date(last);
  if(frequency==='yearly') next.setFullYear(next.getFullYear()+1);
  else if(frequency==='monthly') next.setMonth(next.getMonth()+1);
  else if(frequency==='weekly') next.setDate(next.getDate()+7);
  else next.setDate(next.getDate()+1); // daily / default
  return next;
}
function isBackupDue(lastBackupISO, frequency){
  if(frequency==='manual') return false;
  return new Date() >= nextBackupDueDate(lastBackupISO, frequency);
}

/* ================= Shared branding/theme application =================
   Used by BOTH apps' bootstrap so the shop's chosen name/logo/colors/font
   render identically everywhere, not just in whichever app the owner used
   to set them. The Settings FORM to edit these lives in the Inventory app;
   POS just needs to render with them. */
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
// Pass a settings-shaped object for LIVE PREVIEW before saving; omit to apply persisted settings.
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
}

/* ================= Google Drive Integration (shared) =================
   Requires the user to supply their own OAuth Client ID (Google Cloud Console, Drive API
   enabled). Uses Google Identity Services token flow (no server / client secret required)
   + Drive REST API via fetch. Shared so both Inventory and POS can trigger a backup of the
   one database they both write to. `gdriveAccessToken` is a per-page-load in-memory token
   (each app page re-authorizes on its own — this is a normal OAuth token-flow limitation,
   not a bug: the token itself is never persisted to disk for security). */
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
        await DB.put('settings', state.settings);
        toast('Google Drive connected');
        if(onConnected) onConnected();
      }
    });
    tokenClient.requestAccessToken();
  }catch(e){
    toast(e.message || 'Could not connect to Google Drive', 'error');
  }
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
// Uploads AND verifies the backup actually landed (re-fetches its metadata) rather than just
// trusting the upload response — the brief explicitly asks not to fake this.
async function gdriveBackup(silent){
  if(!state.settings.gdriveConnected || !gdriveAccessToken){ if(!silent) toast('Connect Google Drive first', 'error'); return false; }
  if(!navigator.onLine){ if(!silent) toast('No internet connection — backup will retry later. Your data is safe locally.', 'warn'); return false; }
  try{
    const folderId = await ensureGDriveFolder();
    const payload = await buildBackupPayload();
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
    // Verify: re-fetch the file's metadata to confirm it genuinely exists and has a real size,
    // rather than just trusting a 200 response.
    const verifyRes = await fetch(`https://www.googleapis.com/drive/v3/files/${uploaded.id}?fields=id,name,size`, {headers:{Authorization:`Bearer ${gdriveAccessToken}`}});
    const verified = await verifyRes.json();
    if(!verifyRes.ok || !verified.id || Number(verified.size||0) < 10){ throw new Error('Backup upload could not be verified on Google Drive'); }
    state.settings.lastGDriveBackup = new Date().toISOString();
    await DB.put('settings', state.settings);
    if(!silent) toast(`Backed up to Google Drive and verified (${(Number(verified.size)/1024).toFixed(1)} KB)`);
    return true;
  }catch(e){
    console.error(e);
    if(!silent) toast('Google Drive backup failed — your data remains safe locally.', 'error');
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
   A shift is required going forward for every new sale (sale.shift_id).
   Older sales predating this feature keep shift_id = null/undefined —
   they remain valid, they just don't roll up into shift-level reporting.
   ===================================================================== */

function activeShift(){
  return state.shifts.find(s => s.status === 'ACTIVE') || null;
}

function nextShiftNumber(){
  const tag = state.settings.device_tag || 'A';
  const year = new Date().getFullYear();
  const countThisYear = state.shifts.filter(s => s.shift_number && s.shift_number.includes(`-${tag}-${year}-`)).length;
  return `SHIFT-${tag}-${year}-${String(countThisYear + 1).padStart(4, '0')}`;
}

function paymentMethodForSale(saleId){
  const pay = state.payments.find(p => p.saleId === saleId);
  return pay ? pay.method : null;
}

// The full accounting picture for one shift — sales, payment mix, and the cash-drawer
// reconciliation math. Works for an ACTIVE shift (live, projected) or a CLOSED one
// (using its own snapshotted declared_cash/variance). Every number here is derived
// from actual sales/payments/refunds/cashMovements records, never estimated.
function shiftMetrics(shift){
  if(!shift) return null;
  const shiftSales = state.sales.filter(s => s.shift_id === shift.id && s.status !== 'HELD');
  const nonVoided = shiftSales.filter(s => s.status !== 'VOIDED');
  const voidedCount = shiftSales.length - nonVoided.length;

  const grossSales = nonVoided.reduce((s,x)=> s + Number(x.subtotal||0), 0);
  const discountTotal = nonVoided.reduce((s,x)=> s + Number(x.discount_amount||0), 0);
  const taxTotal = nonVoided.reduce((s,x)=> s + Number(x.tax_amount||0), 0);
  const serviceTotal = nonVoided.reduce((s,x)=> s + Number(x.service_charge_amount||0), 0);
  const grossGrandTotal = nonVoided.reduce((s,x)=> s + Number(x.grand_total||0), 0);

  // All reversals (both refund types AND voids) tied to THIS shift — attributed to the
  // shift the reversal was PROCESSED in, not necessarily the shift the original sale
  // happened in (e.g. refunding yesterday's sale during today's shift affects today's
  // cash drawer, not yesterday's already-closed one).
  const shiftReversals = state.refunds.filter(r => r.shift_id === shift.id);
  const refundsOnly = shiftReversals.filter(r => r.type !== 'VOID').reduce((s,r)=> s + Number(r.amount||0), 0);
  const voidsOnly = shiftReversals.filter(r => r.type === 'VOID').reduce((s,r)=> s + Number(r.amount||0), 0);
  const netSales = grossGrandTotal - refundsOnly; // voided sales are already excluded from grossGrandTotal

  let cashGross=0, cardGross=0, otherGross=0;
  nonVoided.forEach(s=>{
    const m = paymentMethodForSale(s.id);
    const amt = Number(s.grand_total||0);
    if(m==='CASH') cashGross += amt;
    else if(m==='CARD') cardGross += amt;
    else otherGross += amt; // GCASH + OTHER
  });

  // Cash actually returned to customers this shift, for CASH-paid sales only (a refund
  // on a card/GCash sale doesn't touch the physical drawer). VOID-type reversals are
  // deliberately excluded here: a voided sale is already excluded from cashGross above
  // (treated as if it never happened), so its cash was never counted as collected in
  // the first place — subtracting it again here would double-count the same amount and
  // make the drawer look short for a transaction that nets to zero. Only true refunds
  // (which reverse a sale that WAS counted as real revenue) reduce expected cash.
  let cashReversed = 0;
  shiftReversals.filter(r => r.type !== 'VOID').forEach(r=>{
    const sale = state.sales.find(s => s.id === r.saleId);
    if(sale && paymentMethodForSale(sale.id) === 'CASH') cashReversed += Number(r.amount||0);
  });
  const netCashFromSales = cashGross - cashReversed;

  const shiftCashMovements = state.cashMovements.filter(m => m.shift_id === shift.id);
  const payIns = shiftCashMovements.filter(m => m.type==='PAY_IN').reduce((s,m)=> s + Number(m.amount||0), 0);
  const payOuts = shiftCashMovements.filter(m => m.type==='PAY_OUT').reduce((s,m)=> s + Number(m.amount||0), 0);

  const openingCash = Number(shift.opening_cash||0);
  const expectedCash = openingCash + netCashFromSales + payIns - payOuts;
  const isClosed = shift.status === 'CLOSED';
  const declaredCash = isClosed ? Number(shift.declared_cash||0) : null;
  const variance = isClosed ? (declaredCash - expectedCash) : null;

  return {
    transactionCount: nonVoided.length, voidedCount,
    grossSales, discountTotal, taxTotal, serviceTotal, netSales,
    cashGross, cardGross, otherGross, netCashFromSales,
    refundsOnly, voidsOnly,
    payIns, payOuts, payInCount: shiftCashMovements.filter(m=>m.type==='PAY_IN').length,
    payOutCount: shiftCashMovements.filter(m=>m.type==='PAY_OUT').length,
    openingCash, expectedCash, declaredCash, variance,
    cashMovements: shiftCashMovements.slice().sort((a,b)=> new Date(b.at)-new Date(a.at)),
  };
}

// Duration string like "3h 24m" for a shift's header display.
function shiftDuration(shift){
  const start = new Date(shift.opened_at).getTime();
  const end = shift.closed_at ? new Date(shift.closed_at).getTime() : Date.now();
  const mins = Math.max(0, Math.floor((end - start) / 60000));
  const h = Math.floor(mins/60), m = mins%60;
  return h>0 ? `${h}h ${m}m` : `${m}m`;
}
