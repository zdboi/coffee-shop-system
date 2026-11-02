// Unit checks (node, no browser, no database) for the release 1.4 shared core in cccc/shared/logic.js + ui.js:
// one unit converter (weighs), recipe lines typed in other units, options (extras, swaps, cups/lids,
// library groups, required groups), merged ingredients + operating supplies, supplied items,
// waste op data, error texts. Run: node tests/unit/core14_check.js [repo]   (adopted from core-sync-engineer 2026-11-03)
const fs = require('fs');
const vm = require('vm');
const crypto = require('crypto');
const ROOT = process.argv[2] || require('path').resolve(__dirname, '..', '..');
const ctx = {console, Math, JSON, Number, Object, Array, isFinite, Cloud: {uuid: () => crypto.randomUUID()},
  localStorage: {getItem: () => null, setItem: () => {}, removeItem: () => {}}};
ctx.window = ctx; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(ROOT + '/cccc/shared/ui.js', 'utf8'), ctx);
vm.runInContext(fs.readFileSync(ROOT + '/cccc/shared/logic.js', 'utf8'), ctx);
const r = (code) => vm.runInContext(code, ctx);
let checks = 0, failed = 0;
function eq(name, got, want){
  checks++;
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if(g === w) console.log('ok   ' + name);
  else { failed++; console.log('FAIL ' + name + '\n     got  ' + g + '\n     want ' + w); }
}
const throwsCode = (code) => { try{ r(code); return 'no error'; }catch(e){ return e.code || e.message; } };

/* ---------- units ---------- */
eq('toBaseQty 1 kg -> 1000 g', r(`toBaseQty(1,'kg','g')`), 1000);
eq('toBaseQty case ignored: 250 ML -> 0.25 l', r(`toBaseQty(250,'ML','l')`), 0.25);
eq('toBaseQty empty unit = base', r(`toBaseQty(3,'','pcs')`), 3);
eq('toBaseQty g -> L without weighs = null (BAD_UNIT)', r(`toBaseQty(25,'g','L')`), null);
eq('toBaseQty 25 g of caramel (1.25 g/mL) -> 0.02 L', r(`toBaseQty(25,'g','L',1.25)`), 0.02);
eq('toBaseQty 0.2 L of caramel -> 250 g', r(`toBaseQty(0.2,'L','g',1.25)`), 250);
eq('toBaseQty 1 kg -> 800 mL at 1.25', r(`toBaseQty(1,'kg','ml',1.25)`), 800);
eq('toBaseQty pcs -> box = null', r(`toBaseQty(1,'pcs','box')`), null);
eq('toBaseQty not a number = null', r(`toBaseQty('x','g','g')`), null);
eq('compatibleUnits(L, 1.25) adds g / kg', r(`compatibleUnits('L', 1.25)`), ['ml','L','g','kg']);
eq('compatibleUnits(g, 0.9) adds mL / L', r(`compatibleUnits('g', 0.9)`), ['g','kg','ml','L']);
eq('compatibleUnits(pcs, 1.25) stays pcs', r(`compatibleUnits('pcs', 1.25)`), ['pcs']);
eq('compatibleUnits(L) without weighs unchanged', r(`compatibleUnits('L')`), ['ml','L']);
eq('convertQuantity 100 g -> mL at 1.25 = 80', r(`convertQuantity(100,'g','ml',1.25)`), 80);
eq('convertQuantity g -> mL without weighs = null (as before)', r(`convertQuantity(100,'g','ml')`), null);
eq('formatQuantity 0.02 L shown in g at 1.25 = "25 g"', r(`formatQuantity(0.02,'L','g',2,1.25)`), '25 g');
eq('toBaseQuantity purchase 2 kg -> 2000 g', r(`toBaseQuantity(2,'kg','g')`), 2000);
eq('toBaseQuantity purchase 3 box x 50 = 150 pcs', r(`toBaseQuantity(3,'box','pcs',50)`), 150);
eq('toBaseQuantity purchase 2.5 kg of a sauce counted in L (1.25) = 2 L', r(`toBaseQuantity(2.5,'kg','L',null,1.25)`), 2);

/* ---------- a small menu ---------- */
r(`
state.settings = {costing_method: 'weighted_average'};
state.categories = [{id:'c1', name:'Dairy', kind:'STOCK'}, {id:'cx', name:'Operating supplies', kind:'EXPENSE'}];
state.ingredients = [
  {id:'milk', name:'Fresh milk', base_unit:'ml', category_id:'c1'}, {id:'oat', name:'Oat milk', base_unit:'L', category_id:'c1'},
  {id:'beans', name:'Beans', base_unit:'g', category_id:'c1'}, {id:'cara', name:'Caramel', base_unit:'L', is_produced_item:true, weight_g_per_ml:1.25, category_id:'c1'},
  {id:'cup', name:'Iced cup', base_unit:'pcs', category_id:'c1'}, {id:'lid', name:'Lid', base_unit:'pcs', category_id:'c1'},
  {id:'napkin', name:'Napkins', base_unit:'pcs', category_id:'cx'},
  {id:'arla', name:'Arla milk', base_unit:'L', category_id:'c1', active:false, merged_into:'milk'},
  {id:'ens', name:'Ensaymada', base_unit:'pcs', category_id:'c1', standard_cost: 18},
  {id:'sugar', name:'Sugar', base_unit:'g', category_id:'c1'}];
const lib = {id:'lib_g1', library_group_id:'g1', name:'Hot or iced', required:true, multi_select:false, options:[
  {id:'hot', label:'Hot', price_delta:0, kind:'PLAIN', ingredient_id:null, ingredient_qty_delta:0, extras:[], removes:[]},
  {id:'iced', label:'Iced', price_delta:10, kind:'EXTRA', ingredient_id:'cup', ingredient_qty_delta:1, extras:[{ingredient_id:'cup', quantity:1},{ingredient_id:'lid', quantity:1}], removes:[]}]};
const swap = {id:'lib_g2', library_group_id:'g2', name:'Milk', required:false, multi_select:false, options:[
  {id:'oat', label:'Oat milk', price_delta:25, kind:'SWAP', ingredient_id:null, ingredient_qty_delta:0, extras:[{ingredient_id:'oat', quantity:0.2}], removes:[{ingredient_id:'milk', quantity:200}], swap_from_ingredient_id:'milk', swap_to_ingredient_id:'oat'}]};
const own = {id:'own1', name:'Extras', required:false, multi_select:true, options:[
  {id:'shot', label:'Extra shot', price_delta:30, ingredient_id:'beans', ingredient_qty_delta:18},
  {id:'less', label:'Less sugar', price_delta:0, ingredient_id:'sugar', ingredient_qty_delta:-5},
  {id:'pump', label:'Caramel pump', price_delta:20, extras:[{ingredient_id:'cara', entered_quantity:10, unit:'g', quantity:0.008}]},
  {id:'nap', label:'Napkin', price_delta:0, extras:[{ingredient_id:'napkin', quantity:1}]}]};
state.recipes = [{id:'latte', name:'Latte', selling_price:140, recipe_type:'DRINKS', modifier_groups:[lib, swap, own]},
  {id:'ens-r', name:'Ensaymada', selling_price:45, recipe_type:'PASTRY', supplied_ingredient_id:'ens', modifier_groups:[]}];
state.recipeIngredients = [{recipe_id:'latte', ingredient_id:'milk', quantity:200}, {recipe_id:'latte', ingredient_id:'beans', quantity:18},
  {recipe_id:'latte', ingredient_id:'sugar', quantity:10}, {recipe_id:'latte', ingredient_id:'cara', quantity:0, entered_quantity:25, unit:'g'},
  {recipe_id:'ens-r', ingredient_id:'ens', quantity:1}];
state.purchases = [{ingredient_id:'milk', purchase_date:'2026-11-01', base_quantity:1000, total_price:100, price_per_base_unit:0.1},
  {ingredient_id:'oat', purchase_date:'2026-11-01', base_quantity:1, total_price:250, price_per_base_unit:250},
  {ingredient_id:'beans', purchase_date:'2026-11-01', base_quantity:1000, total_price:1000, price_per_base_unit:1},
  {ingredient_id:'cup', purchase_date:'2026-11-01', base_quantity:100, total_price:300, price_per_base_unit:3},
  {ingredient_id:'lid', purchase_date:'2026-11-01', base_quantity:100, total_price:100, price_per_base_unit:1},
  {ingredient_id:'sugar', purchase_date:'2026-11-01', base_quantity:1000, total_price:80, price_per_base_unit:0.08}];
state.productionBatches = []; state.ingredientBrands = []; state.brandStock = [];
var LAT = state.recipes[0];`);
const lines = (code) => r(code).map(l => l.ingredient_id + ':' + l.quantity).sort();

eq('recipeLineQty: 25 g of caramel counted in L (1.25 g/mL) = 0.02 L', r(`recipeLineQty(state.recipeIngredients[3])`), 0.02);
eq('plain latte: recipe lines (caramel typed in g converted)', lines(`inventoryLinesForSaleLine('latte', 1, [])`), ['beans:18', 'cara:0.02', 'milk:200', 'sugar:10']);
eq('iced: cup AND lid', lines(`inventoryLinesForSaleLine('latte', 2, [{group_id:'lib_g1', option_id:'iced'}])`), ['beans:36', 'cara:0.04', 'cup:2', 'lid:2', 'milk:400', 'sugar:20']);
eq('oat swap: milk taken off, oat put on (no milk line)', lines(`inventoryLinesForSaleLine('latte', 1, [{group:'Milk', label:'Oat milk'}])`), ['beans:18', 'cara:0.02', 'oat:0.2', 'sugar:10']);
eq('negative old option lowers the total (sugar 10 - 5 = 5), not added', lines(`inventoryLinesForSaleLine('latte', 1, [{group:'Extras', label:'Less sugar'}])`), ['beans:18', 'cara:0.02', 'milk:200', 'sugar:5']);
eq('own option extras typed in g (caramel pump 10 g = 0.008 L) + shot; napkin (operating supply) dropped',
  lines(`inventoryLinesForSaleLine('latte', 1, [{group_id:'own1', option_id:'pump'}, {group_id:'own1', option_id:'shot'}, {group_id:'own1', option_id:'nap'}])`), ['beans:36', 'cara:0.028', 'milk:200', 'sugar:10']);
eq('...the napkin is kept with {raw:true} (server _recipe_stock_lines)', r(`inventoryLinesForSaleLine('latte', 1, [{group_id:'own1', option_id:'nap'}], {raw:true})`).some(l => l.ingredient_id === 'napkin'), true);
eq('an option no longer on the menu takes nothing', lines(`inventoryLinesForSaleLine('latte', 1, [{group:'Gone', label:'Gone'}])`), ['beans:18', 'cara:0.02', 'milk:200', 'sugar:10']);
eq('1.3 snapshot (ingredient_id + delta) is used as it was sold (not the menu now)', lines(`inventoryLinesForSaleLine('latte', 1, [{group:'Hot or iced', label:'Iced', ingredient_id:'cup', ingredient_qty_delta:1}])`), ['beans:18', 'cara:0.02', 'cup:1', 'milk:200', 'sugar:10']);
eq('1.4 snapshot (extras/removes) wins over the menu', lines(`inventoryLinesForSaleLine('latte', 1, [{group:'Milk', label:'Oat milk', extras:[{ingredient_id:'oat', quantity:0.15}], removes:[{ingredient_id:'milk', quantity:150}]}])`), ['beans:18', 'cara:0.02', 'milk:50', 'oat:0.15', 'sugar:10']);
eq('kind / label kept for notes', r(`inventoryLinesForSaleLine('latte', 1, [{group:'Hot or iced', label:'Iced'}]).filter(l => l.ingredient_id === 'cup').map(l => l.kind + ' ' + l.label)`), ['modifier Iced']);
eq('merged ingredient: a recipe line on Arla (L) goes to Fresh milk (mL) x1000', (r(`state.recipeIngredients.push({recipe_id:'ens-r', ingredient_id:'arla', quantity:0.05})`), lines(`inventoryLinesForSaleLine('ens-r', 1, [])`)), ['ens:1', 'milk:50']);
r(`state.recipeIngredients.pop()`);
eq('mergeTarget(arla) = milk x1000', r(`(function(){ const t = mergeTarget('arla'); return [t.id, t.factor]; })()`), ['milk', 1000]);

/* ---------- modifiers, validator, price ---------- */
eq('modifierFromOption(swap): 1.3 fields empty, extras/removes snapshot', r(`modifierFromOption(LAT.modifier_groups[1], LAT.modifier_groups[1].options[0])`),
  {group:'Milk', label:'Oat milk', price_delta:25, group_id:'lib_g2', option_id:'oat', kind:'SWAP', ingredient_id:null, ingredient_qty_delta:0,
   extras:[{ingredient_id:'oat', quantity:0.2}], removes:[{ingredient_id:'milk', quantity:200}]});
eq('modifierFromOption(old negative): removes sugar 5, 1.3 delta -5 kept', r(`(function(){ const m = modifierFromOption(LAT.modifier_groups[2], LAT.modifier_groups[2].options[1]); return [m.kind, m.ingredient_qty_delta, m.extras, m.removes]; })()`),
  ['EXTRA', -5, [], [{ingredient_id:'sugar', quantity:5}]]);
eq('modifiersFromSelections + menuUnitPrice (140 + 10 iced + 25 oat)', r(`menuUnitPrice(LAT, modifiersFromSelections(LAT, [{group_id:'lib_g1', option_id:'iced'}, {group_id:'lib_g2', option_id:'oat'}]))`), 175);
eq('required group missing', r(`checkOptionSelections(LAT, [{group_id:'lib_g2', option_id:'oat'}])`), {ok:false, missing:[{group_id:'lib_g1', name:'Hot or iced'}], problems:[], resolved:[{group:'Milk', label:'Oat milk', group_id:'lib_g2', option_id:'oat'}]});
eq('required group chosen -> ok', r(`checkOptionSelections(LAT, [{group_id:'lib_g1', option_id:'hot'}]).ok`), true);
eq('two choices in a one-choice group -> ONE_ONLY', r(`checkOptionSelections(LAT, [{group_id:'lib_g1', option_id:'hot'}, {group_id:'lib_g1', option_id:'iced'}]).problems.map(p => p.reason)`), ['ONE_ONLY']);
eq('same option twice -> DUPLICATE; unknown -> UNKNOWN', r(`checkOptionSelections(LAT, [{group_id:'lib_g1', option_id:'hot'}, {group_id:'own1', option_id:'shot'}, {group_id:'own1', option_id:'shot'}, {group_id:'x', option_id:'y'}]).problems.map(p => p.reason)`), ['DUPLICATE', 'UNKNOWN']);
eq('modifiers {group,label} accepted by the validator', r(`missingRequiredGroups(LAT, [{group:'Hot or iced', label:'Iced'}])`), []);
eq('isLibraryGroup', r(`[isLibraryGroup(LAT.modifier_groups[0]), isLibraryGroup(LAT.modifier_groups[2])]`), [true, false]);

/* ---------- cart stock check (Q6) uses the new lines ---------- */
r(`state.stock = {milk: 1000, beans: 1000, sugar: 1000, cara: 1, oat: 0.1, cup: 0, lid: 5}`);
eq('swap: oat short (0.2 needed, 0.1 left); milk not needed', r(`cartStockProblems([{recipe_id:'latte', name:'Latte', quantity:1, modifiers:[{group:'Milk', label:'Oat milk'}]}]).map(p => p.short_ingredients.map(s => s.ingredient_id + ':' + s.needed))`), [['oat:0.2']]);
eq('cups are counted stock: iced with 0 cups is short', r(`cartStockProblems([{recipe_id:'latte', name:'Latte', quantity:1, modifiers:[{group:'Hot or iced', label:'Iced'}]}]).map(p => p.short_ingredients.map(s => s.ingredient_id))`), [['cup']]);
eq('hot latte fits', r(`cartStockProblems([{recipe_id:'latte', name:'Latte', quantity:1, modifiers:[{group:'Hot or iced', label:'Hot'}]}])`), []);
eq('operating supply never makes a line short', r(`cartStockProblems([{recipe_id:'latte', name:'Latte', quantity:1, modifiers:[{group_id:'own1', option_id:'nap'}]}])`), []);

eq('recipeMakeableCount: hot 5 (milk), iced 0 (no cups), oat swap 0 (0.1 L oat)', r(`[recipeMakeableCount('latte', [{group:'Hot or iced', label:'Hot'}]), recipeMakeableCount('latte', [{group:'Hot or iced', label:'Iced'}]), recipeMakeableCount('latte', [{group:'Milk', label:'Oat milk'}])]`), [5, 0, 0]);
eq('recipeMakeableCount: nothing tracked -> 99', r(`recipeMakeableCount('nothing', [])`), 99);

/* ---------- costing ---------- */
eq('recipeCost uses converted lines (caramel 0.02 L, cost 0 = no batches)', r(`recipeCost('latte').lines.map(l => l.quantity)`), [200, 18, 10, 0.02]);
eq('plain latte cost = 20 + 18 + 0.8', r(`Math.round(recipeCostWithOptions('latte', []).total * 100) / 100`), 38.8);
eq('oat swap cost delta = 0.2 L x 250 - 200 mL x 0.1 = +30', r(`Math.round(optionCostDelta('latte', {group:'Milk', label:'Oat milk'}) * 100) / 100`), 30);
eq('iced adds cup 3 + lid 1', r(`Math.round(optionCostDelta('latte', {group:'Hot or iced', label:'Iced'}) * 100) / 100`), 4);
eq('recipeMetrics with options: price 175, cost 38.8 + 4 + 30', r(`(function(){ const m = recipeMetrics(LAT, modifiersFromSelections(LAT, [{group_id:'lib_g1', option_id:'iced'}, {group_id:'lib_g2', option_id:'oat'}])); return [m.price, Math.round(m.cost * 100) / 100]; })()`), [175, 72.8]);
eq('recipeMetrics without options unchanged shape (+price)', r(`Object.keys(recipeMetrics(LAT)).join()`), 'cost,lines,profit,foodCostPct,price');
eq('supplied item, no purchases: cost = standard_cost', r(`ingredientCosting('ens').current`), 18);
eq('suppliedItemCosting (no purchase): 18 / 45 -> margin 27, 60%', r(`suppliedItemCosting(state.recipes[1])`), {ingredient_id:'ens', cost_per_piece:18, selling_price:45, margin:27, margin_pct:60, cost_source:'standard_cost'});
r(`state.purchases.push({ingredient_id:'ens', purchase_date:'2026-11-02', created_at:'2026-11-02T01:00:00Z', base_quantity:12, total_price:240, price_per_base_unit:20}, {ingredient_id:'ens', purchase_date:'2026-11-01', base_quantity:12, total_price:120, price_per_base_unit:10})`);
eq('suppliedItemCosting: latest purchase price per piece (20)', r(`[suppliedItemCosting(state.recipes[1]).cost_per_piece, suppliedItemCosting(state.recipes[1]).margin_pct]`), [20, 55.6]);
eq('ingredientCosting with purchases ignores standard_cost (weighted average 15)', r(`ingredientCosting('ens').current`), 15);

/* ---------- hide helpers ---------- */
eq('stockIngredientsList hides merged + operating supplies', r(`stockIngredientsList().map(i => i.id)`), ['milk','oat','beans','cara','cup','lid','ens','sugar']);
eq('ingredientPickerList default = same; expense:true adds napkin; keep keeps arla', r(`[ingredientPickerList().length, ingredientPickerList({expense:true}).some(i => i.id === 'napkin'), ingredientPickerList({keep:['arla']}).some(i => i.id === 'arla'), ingredientPickerList({produced:false}).some(i => i.id === 'cara')]`), [8, true, true, false]);
eq('isExpenseIngredient / isExpenseCategory', r(`[isExpenseIngredient('napkin'), isExpenseIngredient('milk'), isExpenseCategory('cx'), expenseCategoriesList().length, expenseIngredientsList().map(i => i.id)]`), [true, false, true, 1, ['napkin']]);

/* ---------- waste ---------- */
eq('waste: bad reason', throwsCode(`buildWasteData({reason:'STAMP', items:[{recipe_id:'latte', quantity:1}]})`), 'BAD_WASTE_REASON');
eq('waste: OTHER needs a note', throwsCode(`buildWasteData({reason:'other', note:'  ', items:[{recipe_id:'latte', quantity:1}]})`), 'NOTE_REQUIRED');
eq('waste: no items', throwsCode(`buildWasteData({reason:'SPILLAGE', items:[]})`), 'BAD_WASTE');
eq('waste: 31 items', throwsCode(`buildWasteData({reason:'SPILLAGE', items:Array.from({length:31}, () => ({recipe_id:'latte', quantity:1}))})`), 'BAD_WASTE');
eq('waste: quantity 0', throwsCode(`buildWasteData({reason:'SPILLAGE', items:[{recipe_id:'latte', quantity:0}]})`), 'BAD_QUANTITY');
eq('waste: 101 lattes', throwsCode(`buildWasteData({reason:'SPILLAGE', items:[{recipe_id:'latte', quantity:101}]})`), 'BAD_QUANTITY');
eq('waste: grams of cups', throwsCode(`buildWasteData({reason:'SPILLAGE', items:[{ingredient_id:'cup', quantity:5, unit:'g'}]})`), 'BAD_UNIT');
eq('waste: COMPLIMENTARY without approval', throwsCode(`buildWasteData({reason:'COMPLIMENTARY', items:[{recipe_id:'latte', quantity:1, modifiers:[{group:'Hot or iced', label:'Hot'}]}]})`), 'APPROVAL_REQUIRED');
eq('waste: required Hot/Iced missing -> OPTION_REQUIRED (+ e.missing)', (() => { try{ r(`buildWasteData({reason:'SPILLAGE', items:[{recipe_id:'latte', quantity:1}]})`); }catch(e){ return [e.code, e.missing]; } })(), ['OPTION_REQUIRED', [{group_id:'lib_g1', name:'Hot or iced'}]]);
eq('waste: stale group_id with the right name -> BAD_WASTE (ids only when given, like the server)', throwsCode(`buildWasteData({reason:'SPILLAGE', items:[{recipe_id:'latte', quantity:1, modifiers:[{group_id:'old', option_id:'hot', group:'Hot or iced', label:'Hot'}]}]})`), 'BAD_WASTE');
eq('waste: two in a pick-one group -> BAD_WASTE', throwsCode(`buildWasteData({reason:'SPILLAGE', items:[{recipe_id:'latte', quantity:1, modifiers:[{group:'Hot or iced', label:'Hot'}, {group:'Hot or iced', label:'Iced'}]}]})`), 'BAD_WASTE');
eq('waste: 21 options -> BAD_WASTE', throwsCode(`buildWasteData({reason:'SPILLAGE', items:[{recipe_id:'latte', quantity:1, modifiers:Array.from({length:21}, () => ({group:'Hot or iced', label:'Hot'}))}]})`), 'BAD_WASTE');
eq('waste: snapshot modifiers from the cart are resolved to {group,label,group_id,option_id}', r(`buildWasteData({reason:'SPILLAGE', items:[{recipe_id:'latte', quantity:1, modifiers: modifiersFromSelections(LAT, [{group_id:'lib_g1', option_id:'hot'}])}]}).items[0].modifiers`), [{group:'Hot or iced', label:'Hot', group_id:'lib_g1', option_id:'hot'}]);
eq('waste: unknown recipe', throwsCode(`buildWasteData({reason:'SPILLAGE', items:[{recipe_id:'nope', quantity:1}]})`), 'UNKNOWN_RECIPE');
const wd = r(`(function(){ return buildWasteData({reason:'complimentary', note:'For the mayor', staff_id:'s1', shift_id:'sh1', approved_by:'m1', approval_token:'tok',
  items:[{recipe_id:'latte', quantity:1, modifiers: modifiersFromSelections(LAT, [{group_id:'lib_g1', option_id:'iced'}, {group_id:'lib_g2', option_id:'oat'}])}, {ingredient_id:'cara', quantity:250, unit:'g'}]}); })()`);
eq('waste data shape', [Object.keys(wd).join(), wd.reason, wd.approved_by, wd.approval_token, /^[0-9a-f-]{36}$/.test(wd.id)], ['id,reason,note,staff_id,shift_id,logged_at,items,approved_by,approval_token', 'COMPLIMENTARY', 'm1', 'tok', true]);
eq('waste items sent without stock amounts', wd.items, [{recipe_id:'latte', quantity:1, modifiers:[{group:'Hot or iced', label:'Iced', group_id:'lib_g1', option_id:'iced'}, {group:'Milk', label:'Oat milk', group_id:'lib_g2', option_id:'oat'}]}, {ingredient_id:'cara', quantity:250, unit:'g'}]);
ctx.__wd = wd;
eq('wasteStockDeltas: iced oat latte + 250 g caramel (0.2 L)', r(`wasteStockDeltas(__wd).map(l => l.ingredient_id + ':' + l.quantity + ':' + l.transaction_type).sort()`),
  ['beans:18:WASTE', 'cara:0.22:WASTE', 'cup:1:WASTE', 'lid:1:WASTE', 'oat:0.2:WASTE', 'sugar:10:WASTE']);
eq('waste approval fields dropped for other reasons', r(`(function(){ const d = buildWasteData({reason:'SPILLAGE', approved_by:'m1', approval_token:'t', items:[{ingredient_id:'arla', quantity:1, unit:'L'}]}); return [d.approved_by, d.approval_token, d.note]; })()`), [null, null, null]);
eq('waste of a merged ingredient goes to the general one (1 L Arla = 1000 mL milk)', r(`wasteStockLines([{ingredient_id:'arla', quantity:1, unit:'L'}])`), [{ingredient_id:'milk', quantity:1000}]);
eq('waste labels', r(`[wasteReasonLabel('CALIBRATION'), WASTE_REASONS.filter(x => x.needs_approval).map(x => x.id), expenseCategoryLabel('UTILITIES')]`), ['Calibration / barista drink', ['COMPLIMENTARY'], 'Utilities (power, water)']);

/* ---------- option group form check ---------- */
const okGroup = `{name:'Milk', applies_to:{recipe_types:['DRINKS'], subcategories:[]}, options:[{id:'o1', label:'Oat', price_delta:20, kind:'SWAP', swap_from_ingredient_id:'milk', swap_to_ingredient_id:'oat'}]}`;
eq('optionGroupProblem: fine', r(`optionGroupProblem(${okGroup})`), null);
eq('optionGroupProblem: swap to itself', r(`optionGroupProblem({name:'M', options:[{id:'o', label:'x', kind:'SWAP', swap_from_ingredient_id:'milk', swap_to_ingredient_id:'milk'}]}).field`), 'swap');
eq('optionGroupProblem: negative swap price', r(`optionGroupProblem({name:'M', options:[{id:'o', label:'x', price_delta:-1, kind:'SWAP', swap_from_ingredient_id:'milk', swap_to_ingredient_id:'oat'}]}).field`), 'price_delta');
eq('optionGroupProblem: duplicate label (case ignored)', r(`optionGroupProblem({name:'M', options:[{id:'a', label:'Iced'}, {id:'b', label:'iced '}]}).field`), 'option label');
eq('optionGroupProblem: 6 extras', r(`optionGroupProblem({name:'M', options:[{id:'a', label:'x', kind:'EXTRA', extras:Array.from({length:6}, () => ({ingredient_id:'cup', quantity:1}))}]}).field`), 'extras');
eq('optionGroupProblem: grams of cups', r(`optionGroupProblem({name:'M', options:[{id:'a', label:'x', kind:'EXTRA', extras:[{ingredient_id:'cup', entered_quantity:1, unit:'g'}]}]}).field`), 'extras unit');
eq('optionGroupProblem: unknown type', r(`optionGroupProblem({name:'M', applies_to:{recipe_types:['COFFEE']}, options:[{id:'a', label:'x'}]}).field`), 'recipe_types');

/* ---------- error texts ---------- */
const codes = ['BAD_WASTE','BAD_WASTE_REASON','NOTE_REQUIRED','BAD_QUANTITY','BAD_UNIT','WEIGHS_PRODUCED_ONLY','WEIGHS_BAD_UNIT','EXPENSE_ITEM_NOT_STOCK',
  'BAD_OPTION_GROUP','BAD_OPTION','OPTION_REQUIRED','BAD_NAME','NAME_TAKEN','BAD_TYPE','BAD_PRICE','NOT_A_SUPPLIED_ITEM','SUPPLIED_NEEDS_PCS',
  'MERGE_TOO_FEW','MERGE_TOO_MANY','MERGE_UNKNOWN_INGREDIENT','MERGE_ALREADY_MERGED','MERGE_PRODUCED_NOT_ALLOWED','MERGE_SUPPLIED_NOT_ALLOWED','MERGE_UNIT_MISMATCH','BUSY_TRY_AGAIN','BAD_DATE'];
eq('every 1.4 code has a text (no raw code shown)', codes.filter(c => { const t = r(`friendlyError({message: ${JSON.stringify(c)}})`); return !t || t === c || /[A-Z]{3,}_[A-Z]/.test(t); }), []);
eq('BAD_OPTION_GROUP: extras -> the detail', r(`friendlyError({message:'BAD_OPTION_GROUP: extras'})`), 'The option group could not be saved. Each option can use at most 5 stock items, each with an amount above 0.');
eq('BAD_OPTION_GROUP with an unknown detail -> the general text', r(`friendlyError({message:'BAD_OPTION_GROUP: weird'})`), r(`ERROR_TEXT.BAD_OPTION_GROUP`));
eq('fo_sync result text BAD_UNIT', r(`friendlyError({status:'error', message:'BAD_UNIT'})`), r(`ERROR_TEXT.BAD_UNIT`));
eq('the waste Error thrown by buildWasteData reads well', (() => { try{ r(`buildWasteData({reason:'OTHER', items:[{recipe_id:'latte', quantity:1}]})`); }catch(e){ ctx.__e = e; } return r(`friendlyError(__e)`); })(), r(`ERROR_TEXT.NOTE_REQUIRED`));

console.log(`\nSUMMARY unit/core14_check: ${checks} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
