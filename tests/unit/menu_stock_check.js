// Unit checks (release 1.3) for:
//   A16  sortSubcategoryNames / subcategoryBlock / subcategoryKey (ui.js, pure; the QR page can use it)
//        cleanSubcategoryOrder / subcategoryOrder / subcategoryTypeMap / sortSubcategories / subcategoryRank (logic.js)
//        settings.subcategory_order read from the server row (009), missing column -> []
//   Q6   cartStockProblems (logic.js): cart lines vs the counter's stock + sold-out items
// Run:  node tests/unit/menu_stock_check.js   (REPO=<repo> optional; tests/run_all.sh runs it)
const fs = require('fs'), vm = require('vm'), path = require('path');
const {makeEnv} = require('./printer_env.js');

let checks = 0, failed = 0;
function eq(name, got, exp){
  checks++;
  const good = JSON.stringify(got) === JSON.stringify(exp);
  if(!good) failed++;
  console.log((good ? 'ok   ' : 'FAIL ') + name + (good ? '' : '\n   got:      ' + JSON.stringify(got) + '\n   expected: ' + JSON.stringify(exp)));
}

/* ---------- ui.js alone (like the QR page: no logic.js) ---------- */
{
  const ctx = {console, document: {currentScript: null}}; ctx.window = ctx; vm.createContext(ctx);
  const ROOT = process.env.REPO || path.resolve(__dirname, '..', '..');
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'cccc/shared/ui.js'), 'utf8'), ctx);
  const r = (s) => vm.runInContext(s, ctx);
  eq('ui.js alone: sortSubcategoryNames exists, logic helpers do not', [r('typeof sortSubcategoryNames'), r('typeof sortSubcategories')], ['function', 'undefined']);
  eq('blocks: drinks 0, pastry 1, food 2, others 3 (types or labels, any case)',
    r(`['DRINKS','Drinks','PASTRY','pastry','FOOD','Food','SAUCES_SYRUPS','', null, 'Merch'].map(subcategoryBlock)`), [0, 0, 1, 1, 2, 2, 3, 3, 3, 3]);
  eq('subcategoryKey ignores case + extra spaces', r(`subcategoryKey('  Iced   Coffee ')`), 'iced coffee');
  const types = `{'Iced coffee':'DRINKS','Hot coffee':'DRINKS','Non-coffee':'DRINKS','Bread':'PASTRY','Cakes':'PASTRY','Rice meals':'FOOD','Pasta':'FOOD','Syrups':'SAUCES_SYRUPS','Merch':undefined}`;
  const names = `['Pasta','Bread','Merch','Syrups','Iced coffee','Rice meals','Cakes','Non-coffee','Hot coffee']`;
  eq('no order: drinks, pastry, food, others; A to Z inside', r(`sortSubcategoryNames(${names}, ${types}, [])`),
    ['Hot coffee', 'Iced coffee', 'Non-coffee', 'Bread', 'Cakes', 'Pasta', 'Rice meals', 'Merch', 'Syrups']);
  eq('owner order inside each block; drinks still first even if listed later', r(`sortSubcategoryNames(${names}, ${types}, ['Cakes','Rice meals','Non-coffee','Iced coffee','Bread'])`),
    ['Non-coffee', 'Iced coffee', 'Hot coffee', 'Cakes', 'Bread', 'Rice meals', 'Pasta', 'Merch', 'Syrups']);
  eq('order names match without case / spaces', r(`sortSubcategoryNames(['Iced coffee','Hot coffee'], {'Iced coffee':'DRINKS','Hot coffee':'DRINKS'}, ['  hot   COFFEE'])`), ['Hot coffee', 'Iced coffee']);
  eq('typeOf as a function', r(`sortSubcategoryNames(['Food','Drinks','Pastry'], n => n, null)`), ['Drinks', 'Pastry', 'Food']);
  eq('typeOf map lookup is case-insensitive', r(`sortSubcategoryNames(['bread','iced'], {'Bread':'PASTRY','ICED':'DRINKS'}, [])`), ['iced', 'bread']);
  eq('bad inputs: no crash', [r(`sortSubcategoryNames(null, null, 'x')`), r(`sortSubcategoryNames(['B','A'], null, [1, null, 'B'])`)], [[], ['B', 'A']]);
  eq('names like constructor / toString / __proto__ / hasOwnProperty sort as plain names (not listed -> A to Z)',
    r(`sortSubcategoryNames(['toString','constructor','Iced','hasOwnProperty','__proto__','valueOf'], n => 'DRINKS', ['Iced'])`),
    ['Iced', '__proto__', 'constructor', 'hasOwnProperty', 'toString', 'valueOf']);
  eq('…and follow the owner order when listed', r(`sortSubcategoryNames(['Iced','constructor','toString'], n => 'DRINKS', ['toString','constructor'])`), ['toString', 'constructor', 'Iced']);
  eq('…with a {name: type} map too', r(`sortSubcategoryNames(['constructor','Bread'], {Bread: 'PASTRY'}, [])`), ['Bread', 'constructor']);
  eq('input array not changed', r(`(function(){ const a = ['Pasta','Hot coffee']; sortSubcategoryNames(a, {'Pasta':'FOOD','Hot coffee':'DRINKS'}, []); return a; })()`), ['Pasta', 'Hot coffee']);
}

/* ---------- logic.js wrappers + settings ---------- */
{
  const {r} = makeEnv();
  r(`state.recipes = [
    {id:'r1', name:'Spanish latte', category:'Iced coffee', recipe_type:'DRINKS', sort_order:1},
    {id:'r2', name:'Americano', category:'Hot coffee', recipe_type:'DRINKS', sort_order:2},
    {id:'r3', name:'Ensaymada', category:'Bread', recipe_type:'PASTRY', sort_order:3},
    {id:'r4', name:'Tapsilog', category:'Rice meals', recipe_type:'FOOD', sort_order:4},
    {id:'r5', name:'Cookie', category:'Snacks', recipe_type:'PASTRY', sort_order:5},
    {id:'r6', name:'Chips', category:'Snacks', recipe_type:'FOOD', sort_order:6},
    {id:'r7', name:'Nachos', category:'Snacks', recipe_type:'FOOD', sort_order:7},
    {id:'r8', name:'Brownie', category:'Mixed', recipe_type:'PASTRY', sort_order:8},
    {id:'r9', name:'Sandwich', category:'Mixed', recipe_type:'FOOD', sort_order:9},
    {id:'r10', name:'Matcha', category:'', recipe_type:'DRINKS', sort_order:10},
    {id:'r11', name:'Old', category:'Gone', recipe_type:'DRINKS', active:false},
  ];`);
  eq('type map: majority wins (Snacks = FOOD 2:1), tie -> first item (Mixed = PASTRY), empty category -> type label', r(`subcategoryTypeMap()`),
    {'Iced coffee': 'DRINKS', 'Hot coffee': 'DRINKS', 'Bread': 'PASTRY', 'Rice meals': 'FOOD', 'Snacks': 'FOOD', 'Mixed': 'PASTRY', 'Drinks': 'DRINKS'});
  r(`setSettingsFromServer({business_name:'X'})`);
  eq('008 database (no subcategory_order column) -> []', r(`state.settings.subcategory_order`), []);
  eq('…and serverSettingsRow leaves it out', r(`'subcategory_order' in serverSettingsRow()`), false);
  eq('no order: A to Z per block', r(`sortSubcategories(['Snacks','Mixed','Rice meals','Bread','Hot coffee','Iced coffee','Drinks'])`),
    ['Drinks', 'Hot coffee', 'Iced coffee', 'Bread', 'Mixed', 'Rice meals', 'Snacks']);
  r(`setSettingsFromServer({subcategory_order: ['Rice meals', 'Iced coffee', 'Bread', '  ', 'iced coffee', 42, 'x'.repeat(41), 'Drinks']})`);
  eq('009 order cleaned (blank, duplicate, non-text, >40 chars dropped)', r(`state.settings.subcategory_order`), ['Rice meals', 'Iced coffee', 'Bread', 'Drinks']);
  eq('…kept in the counter offline copy', r(`serverSettingsRow().subcategory_order`), ['Rice meals', 'Iced coffee', 'Bread', 'Drinks']);
  eq('order as JSON text also read', r(`cleanSubcategoryOrder('["A","B"]')`), ['A', 'B']);
  eq('sortSubcategories follows the order, drinks block first', r(`sortSubcategories(['Snacks','Mixed','Rice meals','Bread','Hot coffee','Iced coffee','Drinks'])`),
    ['Iced coffee', 'Drinks', 'Hot coffee', 'Bread', 'Mixed', 'Rice meals', 'Snacks']);
  eq('sortSubcategories with a {name: type} map (Back Office / QR data)', r(`sortSubcategories(['Rice meals','Iced coffee'], {'Rice meals':'FOOD','Iced coffee':'DRINKS'})`), ['Iced coffee', 'Rice meals']);
  eq('sortSubcategories with a recipe list', r(`sortSubcategories(['Snacks','Bread'], [{name:'a', category:'Snacks', recipe_type:'DRINKS'}, {name:'b', category:'Bread', recipe_type:'PASTRY'}])`), ['Snacks', 'Bread']);
  eq('subcategoryRank numbers', r(`['Iced coffee','Drinks','Hot coffee','Bread','Mixed','Rice meals','Snacks','Nope'].map(n => subcategoryRank(n))`),
    [1, 3, 999, 1002, 1999, 2000, 2999, 3999]);
  eq('rank sort = sortSubcategories (ties A to Z)', r(`(function(){ const n = ['Snacks','Mixed','Rice meals','Bread','Hot coffee','Iced coffee','Drinks'];
    return n.slice().sort((a,b) => subcategoryRank(a) - subcategoryRank(b) || a.localeCompare(b)).join() === sortSubcategories(n).join(); })()`), true);
  eq('logic wrappers: recipes in sub-categories "constructor" / "toString" get their own type',
    r(`(function(){ const rs = [{name:'a', category:'constructor', recipe_type:'FOOD'}, {name:'b', category:'toString', recipe_type:'PASTRY'}, {name:'c', category:'Iced', recipe_type:'DRINKS'}];
      const m = subcategoryTypeMap(rs); return [m.constructor, m.toString, sortSubcategories(['constructor','toString','Iced'], rs), subcategoryRank('constructor', rs) >= 2000, subcategoryRank('toString', rs) < 2000]; })()`),
    ['FOOD', 'PASTRY', ['Iced', 'toString', 'constructor'], true, true]);
  eq('logic wrappers: unknown name "constructor" -> last block, not a crash', r(`subcategoryRank('constructor', {Iced: 'DRINKS'})`), 3999);
  r(`setSettingsFromServer({business_tin: '123-456', receipt_header: 'VAT reg.'})`);
  eq('optional receipt lines read when the row has them', r(`[state.settings.business_tin, state.settings.receipt_header, serverSettingsRow().business_tin]`), ['123-456', 'VAT reg.', '123-456']);
  r(`setSettingsFromServer({})`);
  eq('…else empty and not sent', r(`[state.settings.business_tin, 'business_tin' in serverSettingsRow()]`), ['', false]);
}

/* ---------- Q6: cartStockProblems ---------- */
{
  const {r} = makeEnv();
  r(`state.ingredients = [{id:'milk', name:'Fresh milk', base_unit:'ml'}, {id:'beans', name:'Coffee beans', base_unit:'g'}, {id:'oat', name:'Oat milk', base_unit:'ml'}, {id:'flour', name:'Flour', base_unit:'g'}];
     state.recipes = [{id:'latte', name:'Latte'}, {id:'amer', name:'Americano'}, {id:'bread', name:'Pandesal', sold_out: true}, {id:'water', name:'Water'}];
     state.recipeIngredients = [
       {recipe_id:'latte', ingredient_id:'milk', quantity:200}, {recipe_id:'latte', ingredient_id:'beans', quantity:18},
       {recipe_id:'amer', ingredient_id:'beans', quantity:18}, {recipe_id:'bread', ingredient_id:'flour', quantity:50}];
     state.purchases = []; state.productionBatches = [];
     state.stock = {milk: 300, beans: 100, oat: 0, flour: 1000};`);
  const latte = (q, mods) => `{recipe_id:'latte', name:'Latte', quantity:${q}, modifiers:${mods || '[]'}}`;
  eq('one latte fits -> no problems', r(`cartStockProblems([${latte(1)}])`), []);
  eq('empty cart -> []', r(`cartStockProblems([])`), []);
  const two = r(`cartStockProblems([${latte(1)}, ${latte(1)}])`);
  eq('two lattes share the milk: 400 needed, 300 left -> both lines listed', two.map(p => [p.index, p.recipe_id, p.sold_out, p.alone_ok, p.short_ingredients]),
    [[0, 'latte', false, true, [{ingredient_id: 'milk', name: 'Fresh milk', needed: 400, available: 300}]],
     [1, 'latte', false, true, [{ingredient_id: 'milk', name: 'Fresh milk', needed: 400, available: 300}]]]);
  eq('quantity counts (2 lattes on one line)', r(`cartStockProblems([${latte(2)}])`).map(p => [p.alone_ok, p.short_ingredients[0].needed]), [[false, 400]]);
  eq('an americano with enough beans is not listed while the lattes are short on milk',
    r(`cartStockProblems([${latte(2)}, {recipe_id:'amer', name:'Americano', quantity:1, modifiers:[]}])`).map(p => p.recipe_id), ['latte']);
  eq('beans shared across different recipes (6 x 18 = 108 > 100)',
    r(`cartStockProblems([${latte(1)}, {recipe_id:'amer', name:'Americano', quantity:5, modifiers:[]}])`).map(p => [p.recipe_id, p.short_ingredients.map(s => s.ingredient_id + ':' + s.needed + '/' + s.available).join()]),
    [['latte', 'beans:108/100'], ['amer', 'beans:108/100']]);
  eq('option extras count (oat milk +150 with 0 in stock)',
    r(`cartStockProblems([${latte(1, "[{label:'Oat', ingredient_id:'oat', ingredient_qty_delta:150}]")}])`).map(p => p.short_ingredients.map(s => s.ingredient_id)), [['oat']]);
  eq('sold-out item always listed, even with stock', r(`cartStockProblems([{recipe_id:'bread', name:'Pandesal', quantity:1, modifiers:[]}])`).map(p => [p.sold_out, p.alone_ok, p.short_ingredients.length]), [[true, false, 0]]);
  eq('ingredient never stocked (missing) counts as 0, like the server',
    (r(`state.stock = {beans: 100}`), r(`cartStockProblems([${latte(1)}])`).map(p => p.short_ingredients.map(s => s.ingredient_id + ':' + s.available))), [['milk:0']]);
  eq('item with no recipe ingredients is never short', r(`cartStockProblems([{recipe_id:'water', name:'Water', quantity:5}])`), []);
  eq('exactly enough is fine (300 needed, 300 left)', (r(`state.stock = {milk: 300, beans: 100}`), r(`cartStockProblems([{recipe_id:'latte', name:'Latte', quantity:1.5, modifiers:[]}])`)), []);
  eq('floating-point noise ignored (0.1 + 0.2 vs 0.3)', (r(`state.recipeIngredients.push({recipe_id:'water', ingredient_id:'oat', quantity:0.1}); state.stock = {oat: 0.3}`),
    r(`cartStockProblems([{recipe_id:'water', name:'W', quantity:1}, {recipe_id:'water', name:'W', quantity:2}])`)), []);
  eq('within 0.001 of the stock is fine (server tolerance), more is short',
    [r(`cartStockProblems([{recipe_id:'latte', name:'L', quantity:1, modifiers:[]}], {milk: 199.9995, beans: 100}).length`), r(`cartStockProblems([{recipe_id:'latte', name:'L', quantity:1, modifiers:[]}], {milk: 199.99, beans: 100}).length`)], [0, 1]);
  eq('a negative option amount still takes stock off (as the sale does: |qty|)',
    r(`cartStockProblems([{recipe_id:'amer', name:'A', quantity:1, modifiers:[{label:'Less oat', ingredient_id:'oat', ingredient_qty_delta:-30}]}], {beans: 100, oat: 10})`).map(p => p.short_ingredients.map(x => x.ingredient_id + ':' + x.needed)), [['oat:30']]);
  eq('explicit stock argument used instead of state.stock', r(`cartStockProblems([${latte(1)}], {milk: 0, beans: 100}).length`), 1);
  eq('the line object is returned as given (counter can remove it)', r(`(function(){ const l = ${latte(9)}; return cartStockProblems([l], {})[0].line === l; })()`), true);
}

console.log(`\nSUMMARY unit/menu_stock_check: ${checks} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
