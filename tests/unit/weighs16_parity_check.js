// Release 1.6 (013 section 7c, owner 2026-11-13): "weighs" on BOUGHT items too. Counter (shared logic.js) vs the
// server (_to_base_qty, the recipe-line trigger, _recipe_stock_lines) on a LOCAL test database, inside one
// transaction that is rolled back. Z, 2026-11-13.
// Bought items: Fresh milk (mL, 1 mL weighs 1.03 g), Vanilla syrup (L, 1.3 g/mL), Soy milk (mL), Beans (g), Sugar (g).
// Latte = milk typed 206 g (-> 200 mL) + syrup typed 13 g (-> 0.01 L) + beans 18 g. Library options:
//   16 oz  EXTRA milk typed 61.8 g (-> 60 mL) · Pump  EXTRA syrup typed 6.5 g (-> 0.005 L)
//   Soy    SWAP milk -> soy (the whole milk, size extra too) · Sugar instead  SWAP syrup -> sugar (0.01 L = 10 mL x 1.3 = 13 g)
// Hand math: 1 latte = milk 200, syrup 0.01, beans 18 · 2 x (16 oz + pump) = milk 520, syrup 0.03, beans 36
//            16 oz + soy = soy 260, no milk · syrup -> sugar = sugar 13, no syrup
// Cost (milk ₱0.10/mL, syrup ₱500/L, beans ₱1/g): latte 20 + 5 + 18 = ₱43.00; with a pump ₱45.50.
// Run: node tests/unit/weighs16_parity_check.js <repo> <database>   (needs a shop: tests/e2e_reset.sh <db>)
const fs = require('fs');
const vm = require('vm');
const {execFileSync} = require('child_process');
const crypto = require('crypto');
const ROOT = process.argv[2] || require('path').resolve(__dirname, '..', '..');
const DB = process.argv[3] || 'cccc';
if(!/^[a-z_][a-z0-9_]*$/.test(DB)) throw new Error('database name must be plain lowercase');
const ctx = {console, Math, JSON, Number, Object, Array, isFinite, Cloud: {uuid: () => crypto.randomUUID()},
  localStorage: {getItem: () => null, setItem: () => {}, removeItem: () => {}}};
ctx.window = ctx; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(ROOT + '/cccc/shared/ui.js', 'utf8'), ctx);
vm.runInContext(fs.readFileSync(ROOT + '/cccc/shared/logic.js', 'utf8'), ctx);
const r = (code) => vm.runInContext(code, ctx);
const psql = (sql) => execFileSync('psql', ['-h', '/tmp', '-p', '54329', '-U', 'postgres', '-d', DB, '-v', 'ON_ERROR_STOP=1', '-Atq'], {input: sql, encoding: 'utf8', maxBuffer: 1 << 26});
const biz = psql(`select business_id from public.profiles where id = '00000000-0000-0000-0000-0000000000a1';`).trim();
if(!biz) throw new Error('no shop in ' + DB);
const L = (v) => v === null || v === undefined ? 'null' : "'" + String(v).replace(/'/g, "''") + "'";
const J = (v) => L(JSON.stringify(v)) + '::jsonb';
const U = () => crypto.randomUUID();
let checks = 0, failed = 0;
const ok = (cond, name, extra) => { checks++; if(cond) console.log('ok   ' + name); else { failed++; console.log('FAIL ' + name + (extra ? '   [got: ' + extra + ']' : '')); } };

const id = {cat: U(), milk: U(), syrup: U(), soy: U(), beans: U(), sugar: U(), latte: U(), gSize: U(), gPump: U(), gAlt: U()};
let setup = 'begin;\n';
setup += `insert into public.categories(id, business_id, name, kind) values (${L(id.cat)}, ${L(biz)}, 'Weighs16 stock', 'STOCK');\n`;
[[id.milk, 'W16 Fresh milk', 'ml', 1.03], [id.syrup, 'W16 Vanilla syrup', 'L', 1.3], [id.soy, 'W16 Soy milk', 'ml', null], [id.beans, 'W16 Beans', 'g', null], [id.sugar, 'W16 Sugar', 'g', null]]
  .forEach(([i, n, u, w]) => { setup += `insert into public.ingredients(id, business_id, name, base_unit, is_produced_item, weight_g_per_ml, category_id) values (${L(i)}, ${L(biz)}, ${L(n)}, ${L(u)}, false, ${w === null ? 'null' : w}, ${L(id.cat)});\n`; });
setup += `insert into public.recipes(id, business_id, name, recipe_type, category, selling_price, modifier_groups) values (${L(id.latte)}, ${L(biz)}, 'W16 Vanilla latte', 'DRINKS', 'Iced coffee', 160, '[]');\n`;
[[id.milk, 206, 'g'], [id.syrup, 13, 'g'], [id.beans, 18, 'g']].forEach(([iid, q, u]) => {
  setup += `insert into public.recipe_ingredients(business_id, recipe_id, ingredient_id, quantity, entered_quantity, unit) values (${L(biz)}, ${L(id.latte)}, ${L(iid)}, 0, ${q}, ${L(u)});\n`;
});
const groups = [
  [id.gSize, 'W16 Size', 1, [{id: '12', label: '12 oz', price_delta: 0, kind: 'PLAIN'}, {id: '16', label: '16 oz', price_delta: 20, kind: 'EXTRA', extras: [{ingredient_id: id.milk, entered_quantity: 61.8, unit: 'g'}]}]],
  [id.gPump, 'W16 Pump', 2, [{id: 'pump', label: 'Extra pump', price_delta: 15, kind: 'EXTRA', extras: [{ingredient_id: id.syrup, entered_quantity: 6.5, unit: 'g'}]}]],
  [id.gAlt, 'W16 Swaps', 3, [{id: 'soy', label: 'Soy milk', price_delta: 20, kind: 'SWAP', swap_from_ingredient_id: id.milk, swap_to_ingredient_id: id.soy},
                            {id: 'sug', label: 'Sugar instead', price_delta: 0, kind: 'SWAP', swap_from_ingredient_id: id.syrup, swap_to_ingredient_id: id.sugar}]],
];
groups.forEach(([gid, n, so, options]) => {
  setup += `insert into public.option_groups(id, business_id, name, required, multi_select, sort_order, applies_to, options) values (${L(gid)}, ${L(biz)}, ${L(n)}, false, true, ${so}, ${J({recipe_types: ['DRINKS'], subcategories: []})}, ${J(options)});\n`;
});
const g = (gid, oid) => ({group_id: 'lib_' + gid, option_id: oid});
const cases = [
  {qty: 1, mods: []},
  {qty: 2, mods: [g(id.gSize, '16'), g(id.gPump, 'pump')]},
  {qty: 1, mods: [g(id.gSize, '16'), g(id.gAlt, 'soy')]},
  {qty: 1, mods: [g(id.gAlt, 'sug')]},
];
const q = setup + `select json_build_object(
  'ingredients', (select json_agg(to_jsonb(x)) from public.ingredients x where x.category_id = ${L(id.cat)}),
  'recipes', (select json_agg(to_jsonb(x)) from public.recipes x where x.id = ${L(id.latte)}),
  'recipe_ingredients', (select json_agg(to_jsonb(x)) from public.recipe_ingredients x where x.recipe_id = ${L(id.latte)}),
  'lines', (select json_agg(public._recipe_stock_lines(${L(biz)}, ${L(id.latte)}, c.qty, c.mods) order by c.i) from (values ${cases.map((c, i) => `(${i}, ${c.qty}, ${J(c.mods)})`).join(', ')}) c(i, qty, mods)),
  'g_to_ml', public._to_base_qty(103, 'g', 'ml', 1.03), 'kg_to_l', public._to_base_qty(1.3, 'kg', 'L', 1.3));\nrollback;\n`;
const st = JSON.parse(psql(q).trim().split('\n').pop());
ctx.__st = st;
r(`state.categories = [{id: ${JSON.stringify(id.cat)}, name: 'Weighs16 stock', kind: 'STOCK'}]; state.ingredients = __st.ingredients; state.recipes = __st.recipes; state.recipeIngredients = __st.recipe_ingredients;
   state.productionBatches = []; state.ingredientBrands = []; state.brandStock = []; state.settings = {costing_method: 'weighted_average'};
   state.purchases = [{ingredient_id: ${JSON.stringify(id.milk)}, purchase_date: '2026-11-01', base_quantity: 1000, total_price: 100, price_per_base_unit: 0.1},
     {ingredient_id: ${JSON.stringify(id.syrup)}, purchase_date: '2026-11-01', base_quantity: 1, total_price: 500, price_per_base_unit: 500},
     {ingredient_id: ${JSON.stringify(id.beans)}, purchase_date: '2026-11-01', base_quantity: 1000, total_price: 1000, price_per_base_unit: 1}];`);
const asMap = (ls) => { const m = {}; (ls || []).forEach(l => { m[l.ingredient_id] = (m[l.ingredient_id] || 0) + Number(l.quantity); }); return m; };
const near = (a, b) => Math.abs((a || 0) - (b || 0)) < 1e-6;
const same = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].every(k => near(a[k], b[k]));
const show = (m) => JSON.stringify(Object.fromEntries(Object.entries(m).map(([k, v]) => [Object.keys(id).find(x => id[x] === k) || k, v])));

const ri = (iid) => st.recipe_ingredients.find(x => x.ingredient_id === iid);
ok(near(st.g_to_ml, 100) && near(st.kg_to_l, 1), 'server units: 103 g of milk (1.03) = 100 mL; 1.3 kg of syrup (1.3) = 1 L', st.g_to_ml + ' / ' + st.kg_to_l);
ok(near(ri(id.milk).quantity, 200) && near(ri(id.syrup).quantity, 0.01) && near(ri(id.beans).quantity, 18), 'server: recipe lines typed in g on BOUGHT items saved in the stock unit (milk 200 mL, syrup 0.01 L)', JSON.stringify(st.recipe_ingredients.map(x => x.quantity)));
ok(near(r(`recipeLineQty(state.recipeIngredients.find(x => x.ingredient_id === ${JSON.stringify(id.milk)}))`), 200), 'counter: recipeLineQty of the milk line = 200 mL');
const want = [
  {[id.milk]: 200, [id.syrup]: 0.01, [id.beans]: 18},
  {[id.milk]: 520, [id.syrup]: 0.03, [id.beans]: 36},
  {[id.soy]: 260, [id.syrup]: 0.01, [id.beans]: 18},
  {[id.milk]: 200, [id.sugar]: 13, [id.beans]: 18},
];
const names = ['1 latte', '2 x (16 oz + pump): extras typed in g', '16 oz + soy: the whole milk (size extra too) moves', 'syrup -> sugar: 0.01 L x 1.3 g/mL = 13 g'];
cases.forEach((c, i) => {
  ctx.__c = c;
  const js = asMap(r(`inventoryLinesForSaleLine(${JSON.stringify(id.latte)}, __c.qty, __c.mods, {raw: true})`));
  const sv = asMap(st.lines[i]);
  ok(same(sv, want[i]), 'server stock lines: ' + names[i], show(sv));
  ok(same(js, sv), 'counter stock lines = server: ' + names[i], show(js));
});
const cost = r(`recipeCost(${JSON.stringify(id.latte)})`);
const cost2 = r(`recipeCostWithOptions(${JSON.stringify(id.latte)}, [${JSON.stringify(g(id.gPump, 'pump'))}])`);
const num = (x) => typeof x === 'number' ? x : (x && (x.total != null ? x.total : x.cost));
ok(near(Math.round(num(cost) * 100) / 100, 43), 'counter recipe cost: 20 + 5 + 18 = ₱43.00', JSON.stringify(cost));
ok(near(Math.round(num(cost2) * 100) / 100, 45.5), 'counter recipe cost with an extra pump (6.5 g = 0.005 L): ₱45.50', JSON.stringify(cost2));
console.log(`SUMMARY unit/weighs16_parity_check: ${checks} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
