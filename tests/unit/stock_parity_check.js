// Parity check (release 1.4): inventoryLinesForSaleLine() in cccc/shared/logic.js against the
// database's _recipe_stock_lines() (cccc/supabase/010_release_1_4.sql) on a LOCAL test database
// with 010 installed. Builds a small menu inside one transaction (rolled back): stock units
// g/kg/mL/L/pcs, a house-made sauce with "weighs", recipe lines typed in other units, library
// groups (required Hot/Iced with cup + lid, a milk SWAP, an extra shot, a sauce pump typed in g),
// an untick (EXCLUDE), a tick-on (INCLUDE), and own groups (old single pair, a negative amount,
// own extras). Then random sale lines (choices by group_id+option_id or by group name+label):
// the server's stock lines must equal the JS ones (raw, and also after cleanStockLines when
// nothing is merged / an operating supply).
// Also checks _to_base_qty against toBaseQty on a grid of units.
// Run: node tests/unit/stock_parity_check.js <repo> <database> [cases]   (needs a shop: tests/e2e_reset.sh <db>; adopted from core-sync-engineer 2026-11-03)
const fs = require('fs');
const vm = require('vm');
const {execFileSync} = require('child_process');
const crypto = require('crypto');
const ROOT = process.argv[2] || require('path').resolve(__dirname, '..', '..');
const DB = process.argv[3] || 'cccc';
if(!/^[a-z_][a-z0-9_]*$/.test(DB)) throw new Error('database name must be plain lowercase');
const N = Number(process.argv[4] || 400);

const ctx = {console, Math, JSON, Number, Object, Array, isFinite, Cloud: {uuid: () => crypto.randomUUID()},
  localStorage: {getItem: () => null, setItem: () => {}, removeItem: () => {}}};
ctx.window = ctx; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(ROOT + '/cccc/shared/ui.js', 'utf8'), ctx);
vm.runInContext(fs.readFileSync(ROOT + '/cccc/shared/logic.js', 'utf8'), ctx);
const r = (code) => vm.runInContext(code, ctx);

let seed = 20261103;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const psql = (sql) => execFileSync('psql', ['-h', '/tmp', '-p', '54329', '-U', 'postgres', '-d', DB, '-v', 'ON_ERROR_STOP=1', '-Atq'], {input: sql, encoding: 'utf8', maxBuffer: 1 << 26});
const biz = psql('select id from public.businesses order by created_at limit 1;').trim();
if(!biz) throw new Error('no business in ' + DB);
const L = (v) => v === null || v === undefined ? 'null' : "'" + String(v).replace(/'/g, "''") + "'";
const J = (v) => L(JSON.stringify(v)) + '::jsonb';
const U = () => crypto.randomUUID();

let checks = 0, failed = 0;
const ok = (cond, name, extra) => { checks++; if(cond) return; failed++; console.log('FAIL ' + name + (extra ? '\n   ' + extra : '')); };

/* ---------- 1. _to_base_qty vs toBaseQty ---------- */
{
  const units = ['g', 'kg', 'ml', 'mL', 'L', 'l', 'pcs', 'box', '', ' Kg '];
  const qtys = [0, 1, 2.5, 0.333333333, 1250, 17.000001];
  const ws = [null, 1.25, 0.9, 3];
  const rows = [];
  let sql = 'select json_agg(x) from (values ';
  const vals = [];
  units.forEach(u => units.forEach(b => { if(b === '') return; qtys.forEach(q => ws.forEach(w => { rows.push([q, u, b, w]); vals.push(`(${rows.length - 1}, public._to_base_qty(${q}, ${L(u)}, ${L(b)}, ${w === null ? 'null' : w})::float8)`); })); }));
  sql += vals.join(',') + ') x(i, v);';
  const server = JSON.parse(psql(sql).trim());
  let bad = 0, first = '';
  server.forEach(s => {
    const [q, u, b, w] = rows[s.i];
    const js = r(`toBaseQty(${q}, ${JSON.stringify(u)}, ${JSON.stringify(b)}, ${w})`);
    const same = (js === null && s.v === null) || (js !== null && s.v !== null && Math.abs(js - s.v) <= 1e-6);
    if(!same){ bad++; if(!first) first = `${q} ${u} -> ${b} (w ${w}): js ${js} server ${s.v}`; }
  });
  ok(bad === 0, `toBaseQty = _to_base_qty on ${rows.length} unit cases`, first);
  console.log(`ok   units: ${rows.length} cases compared, ${bad} different`);
}

/* ---------- 2. the menu ---------- */
const id = {
  cat: U(), catExp: U(),
  milk: U(), oat: U(), beans: U(), caramel: U(), cup: U(), lid: U(), sugar: U(), choco: U(), napkin: U(),
  latte: U(), mocha: U(), amer: U(), caraLatte: U(), cookie: U(), sauceRec: U(), tea: U(),
  gHotIced: U(), gMilk: U(), gShot: U(), gPump: U(), gTake: U(), gSize: U(), gAlt: U(), soy: U(),
};
const ingRows = [
  [id.milk, 'Fresh milk', 'ml', false, null, id.cat], [id.oat, 'Oat milk', 'L', false, null, id.cat],
  [id.beans, 'Beans', 'kg', false, null, id.cat], [id.caramel, 'Caramel sauce', 'L', true, 1.25, id.cat],
  [id.cup, 'Iced cup', 'pcs', false, null, id.cat], [id.lid, 'Lid', 'pcs', false, null, id.cat],
  [id.sugar, 'Sugar', 'g', false, null, id.cat], [id.choco, 'Chocolate sauce', 'ml', true, 1.1, id.cat],
  [id.napkin, 'Napkins', 'pcs', false, null, id.catExp], [id.soy, 'Soy milk', 'ml', false, null, id.cat],
];
let setup = 'begin;\n';
setup += `insert into public.categories(id, business_id, name, kind) values (${L(id.cat)}, ${L(biz)}, 'Parity stock', 'STOCK'), (${L(id.catExp)}, ${L(biz)}, 'Parity supplies', 'EXPENSE');\n`;
ingRows.forEach(([i, n, u, prod, w, c]) => {
  setup += `insert into public.ingredients(id, business_id, name, base_unit, is_produced_item, weight_g_per_ml, category_id) values (${L(i)}, ${L(biz)}, ${L(n + ' ' + i.slice(0, 6))}, ${L(u)}, ${prod}, ${w === null ? 'null' : w}, ${L(c)});\n`;
});
// own groups
const ownLatte = [{id: 'sweet', name: 'Sweetness', required: false, multi_select: false, options: [
  {id: 'less', label: 'Less sugar', price_delta: 0, ingredient_id: id.sugar, ingredient_qty_delta: -5},
  {id: 'more', label: 'More sugar', price_delta: 0, ingredient_id: id.sugar, ingredient_qty_delta: 5},
  {id: 'none', label: 'No change', price_delta: 0}]},
  {id: 'top', name: 'Toppings', required: false, multi_select: true, options: [
  {id: 'choc', label: 'Choco drizzle', price_delta: 15, extras: [{ingredient_id: id.choco, entered_quantity: 11, unit: 'g'}, {ingredient_id: id.sugar, quantity: 2}]},
  {id: 'nap', label: 'Napkin', price_delta: 0, extras: [{ingredient_id: id.napkin, quantity: 1}]},
  {id: 'oldoat', label: 'Oat splash', price_delta: 10, ingredient_id: id.oat, ingredient_qty_delta: 0.03}]}];
const recipes = [
  [id.latte, 'Latte', 'DRINKS', 'Hot coffee', ownLatte, false],
  [id.mocha, 'Mocha', 'DRINKS', 'Iced coffee', [], false],
  [id.amer, 'Americano', 'DRINKS', 'Hot coffee', [], false],
  [id.caraLatte, 'Caramel latte', 'DRINKS', 'Iced coffee', [], false],
  [id.cookie, 'Cookie', 'PASTRY', 'Cookies', [], false],
  [id.sauceRec, 'Caramel batch', 'SAUCES_SYRUPS', '', [], true],
  [id.tea, 'Milk tea', 'DRINKS', 'Tea', [], false],
];
recipes.forEach(([i, n, t, c, g, prod]) => {
  setup += `insert into public.recipes(id, business_id, name, recipe_type, category, selling_price, modifier_groups, is_production_recipe) values (${L(i)}, ${L(biz)}, ${L(n + ' ' + i.slice(0, 6))}, ${L(t)}, ${L(c)}, 120, ${J(g)}, ${prod});\n`;
});
const lines = [
  [id.latte, id.milk, 200, null, null], [id.latte, id.beans, 0.018, null, null],
  [id.mocha, id.milk, null, 0.18, 'L'], [id.mocha, id.beans, null, 18, 'g'], [id.mocha, id.choco, null, 33, 'g'],
  [id.amer, id.beans, null, 20, 'g'],
  [id.caraLatte, id.milk, 150, null, null], [id.caraLatte, id.milk, null, 0.05, 'L'], [id.caraLatte, id.beans, 0.018, null, null], [id.caraLatte, id.caramel, null, 25, 'g'],
  [id.cookie, id.sugar, 30, null, null],
  [id.sauceRec, id.sugar, 500, null, null], [id.sauceRec, id.milk, 300, null, null],
  [id.tea, id.oat, null, 120, 'ml'], [id.tea, id.sugar, 10, null, null], [id.tea, id.napkin, 1, null, null],
];
lines.forEach(([rid, iid, q, eq, u]) => {
  setup += `insert into public.recipe_ingredients(business_id, recipe_id, ingredient_id, quantity, entered_quantity, unit) values (${L(biz)}, ${L(rid)}, ${L(iid)}, ${q === null ? 0 : q}, ${eq === null ? 'null' : eq}, ${L(u)});\n`;
});
const lib = [
  [id.gHotIced, 'Hot or iced', true, false, 1, {recipe_types: ['DRINKS'], subcategories: []}, [
    {id: 'hot', label: 'Hot', price_delta: 0, kind: 'PLAIN'},
    {id: 'iced', label: 'Iced', price_delta: 10, kind: 'EXTRA', extras: [{ingredient_id: id.cup, quantity: 1}, {ingredient_id: id.lid, quantity: 1}]}]],
  [id.gMilk, 'Milk', false, false, 2, {recipe_types: [], subcategories: ['hot coffee', ' Iced Coffee ', 'Tea']}, [
    {id: 'oat', label: 'Oat milk', price_delta: 25, kind: 'SWAP', swap_from_ingredient_id: id.milk, swap_to_ingredient_id: id.oat},
    {id: 'fresh', label: 'Fresh milk', price_delta: 0, kind: 'SWAP', swap_from_ingredient_id: id.oat, swap_to_ingredient_id: id.milk}]],
  [id.gShot, 'Add-ons', false, true, 3, {recipe_types: ['DRINKS'], subcategories: []}, [
    {id: 'shot', label: 'Extra shot', price_delta: 30, kind: 'EXTRA', extras: [{ingredient_id: id.beans, entered_quantity: 18, unit: 'g'}]},
    {id: 'pump', label: 'Caramel pump', price_delta: 20, kind: 'EXTRA', extras: [{ingredient_id: id.caramel, entered_quantity: 10, unit: 'g'}]},
    {id: 'sug', label: 'Sugar packet', price_delta: 0, kind: 'EXTRA', extras: [{ingredient_id: id.sugar, quantity: 5}, {ingredient_id: id.napkin, quantity: 2}]}]],
  [id.gTake, 'Take-away', false, false, 4, {recipe_types: [], subcategories: []}, [
    {id: 'bag', label: 'Paper bag', price_delta: 5, kind: 'EXTRA', extras: [{ingredient_id: id.cup, quantity: 1}]}]],
  // 010 LINE_TOTAL swap rule: a size's extra milk is swapped too; two swaps of one "from" (first wins);
  // conversions through "from"'s weighs (caramel L -> sugar g) and "to"'s weighs (beans kg -> choco mL)
  [id.gSize, 'Size', false, false, 5, {recipe_types: ['DRINKS'], subcategories: []}, [
    {id: '12', label: '12 oz', price_delta: 0, kind: 'PLAIN'},
    {id: '16', label: '16 oz', price_delta: 20, kind: 'EXTRA', extras: [{ingredient_id: id.milk, quantity: 60}, {ingredient_id: id.beans, quantity: 0.009}]}]],
  [id.gAlt, 'Alt milk', false, true, 6, {recipe_types: ['DRINKS'], subcategories: []}, [
    {id: 'soy', label: 'Soy milk', price_delta: 20, kind: 'SWAP', swap_from_ingredient_id: id.milk, swap_to_ingredient_id: id.soy},
    {id: 'oat2', label: 'Oat (alt)', price_delta: 25, kind: 'SWAP', swap_from_ingredient_id: id.milk, swap_to_ingredient_id: id.oat},
    {id: 'c2s', label: 'Sauce to sugar', price_delta: 0, kind: 'SWAP', swap_from_ingredient_id: id.caramel, swap_to_ingredient_id: id.sugar},
    {id: 'b2c', label: 'Beans to choco', price_delta: 0, kind: 'SWAP', swap_from_ingredient_id: id.beans, swap_to_ingredient_id: id.choco}]],
];
lib.forEach(([gid, n, req, multi, so, applies, options]) => {
  setup += `insert into public.option_groups(id, business_id, name, required, multi_select, sort_order, applies_to, options) values (${L(gid)}, ${L(biz)}, ${L(n)}, ${req}, ${multi}, ${so}, ${J(applies)}, ${J(options)});\n`;
});
setup += `insert into public.option_group_recipes(business_id, group_id, recipe_id, mode) values (${L(biz)}, ${L(id.gShot)}, ${L(id.amer)}, 'EXCLUDE'), (${L(biz)}, ${L(id.gTake)}, ${L(id.cookie)}, 'INCLUDE'), (${L(biz)}, ${L(id.gTake)}, ${L(id.sauceRec)}, 'INCLUDE');\n`;
const recIds = recipes.map(x => x[0]);
const readState = `select json_build_object(
  'ingredients', (select json_agg(to_jsonb(x)) from public.ingredients x where x.business_id = ${L(biz)}),
  'categories', (select json_agg(to_jsonb(x)) from public.categories x where x.business_id = ${L(biz)}),
  'recipes', (select json_agg(to_jsonb(x)) from public.recipes x where x.id in (${recIds.map(L).join(',')})),
  'recipe_ingredients', (select json_agg(to_jsonb(x)) from public.recipe_ingredients x where x.recipe_id in (${recIds.map(L).join(',')})));\n`;
const st = JSON.parse(psql(setup + readState + 'rollback;\n').trim());
ctx.__st = st;
r(`state.ingredients = __st.ingredients; state.categories = __st.categories; state.recipes = __st.recipes; state.recipeIngredients = __st.recipe_ingredients; state.purchases = []; state.productionBatches = []; state.settings = {}`);

/* ---------- 3. the built options are what the contract says ---------- */
const recOf = (rid) => st.recipes.find(x => x.id === rid);
const gids = (rid) => (recOf(rid).modifier_groups || []).map(g => g.id);
ok(JSON.stringify(gids(id.latte)) === JSON.stringify(['lib_' + id.gHotIced, 'lib_' + id.gMilk, 'lib_' + id.gShot, 'lib_' + id.gSize, 'lib_' + id.gAlt, 'sweet', 'top']), 'latte: library groups first (library order), then own groups', JSON.stringify(gids(id.latte)));
ok(!gids(id.amer).includes('lib_' + id.gShot), 'americano: unticked add-ons left out');
ok(!gids(id.amer).includes('lib_' + id.gMilk), 'americano: no milk -> the swap group (only swaps) is left out');
ok(JSON.stringify(gids(id.cookie)) === JSON.stringify(['lib_' + id.gTake]), 'cookie: only the ticked-on take-away group', JSON.stringify(gids(id.cookie)));
ok(JSON.stringify(gids(id.sauceRec)) === JSON.stringify(['lib_' + id.gTake]), 'production recipe: only INCLUDE groups');
const teaMilk = (recOf(id.tea).modifier_groups || []).find(g => g.id === 'lib_' + id.gMilk);
ok(teaMilk && teaMilk.options.map(o => o.id).join() === 'fresh', 'milk tea (oat in the recipe): only the oat -> fresh swap', teaMilk && JSON.stringify(teaMilk.options));
ok(r(`missingRequiredGroups(state.recipes.find(x => x.id === '${id.latte}'), []).map(g => g.name).join()`) === 'Hot or iced', 'required Hot/Iced reported missing by the shared validator');

/* ---------- 4. random sale lines: server vs JS ---------- */
const cases = [];
const sellable = [id.latte, id.mocha, id.amer, id.caraLatte, id.cookie, id.tea, id.sauceRec];
for(let c = 0; c < N; c++){
  const rid = pick(sellable);
  const groups = recOf(rid).modifier_groups || [];
  const mods = [];
  groups.forEach(g => {
    const opts = g.options || [];
    if(!opts.length) return;
    const chosen = g.multi_select ? opts.filter(() => rnd() < 0.4) : (rnd() < 0.7 ? [pick(opts)] : []);
    chosen.forEach(o => mods.push(rnd() < 0.5 ? {group_id: g.id, option_id: o.id} : {group: g.name, label: o.label}));
  });
  if(rnd() < 0.05) mods.push({group: 'Gone', label: 'Not on the menu'});
  for(let i = mods.length - 1; i > 0; i--){ const j = Math.floor(rnd() * (i + 1)); const t = mods[i]; mods[i] = mods[j]; mods[j] = t; }   // chosen order matters for swaps
  const qty = pick([1, 1, 1, 2, 3, 0.5, 1.5, 7]);
  cases.push({rid, mods, qty});
}
// fixed examples (contract A9 stock rule): 16 oz latte + soy -> no fresh milk, 260 mL soy;
// soy then oat (same "from") -> only soy moves; oat then soy -> only oat moves
const g = (gid, oid) => ({group_id: 'lib_' + gid, option_id: oid});
const FIX = cases.length;
cases.push({rid: id.latte, qty: 1, mods: [g(id.gHotIced, 'hot'), g(id.gSize, '16'), g(id.gAlt, 'soy')]});
cases.push({rid: id.latte, qty: 2, mods: [g(id.gHotIced, 'hot'), g(id.gAlt, 'soy'), g(id.gAlt, 'oat2')]});
cases.push({rid: id.latte, qty: 1, mods: [g(id.gAlt, 'oat2'), g(id.gAlt, 'soy'), g(id.gSize, '16')]});
cases.push({rid: id.caraLatte, qty: 1, mods: [g(id.gAlt, 'c2s'), g(id.gAlt, 'b2c'), g(id.gShot, 'shot')]});
let q2 = setup + 'select json_agg(x order by i) from (values ' +
  cases.map((c, i) => `(${i}, public._recipe_stock_lines(${L(biz)}, ${L(c.rid)}, ${c.qty}, ${J(c.mods)}))`).join(',\n') + ') x(i, lines);\nrollback;\n';
const server = JSON.parse(psql(q2).trim()).map(x => x.lines);
let bad = 0, badClean = 0, first = '', firstClean = '';
const asMap = (ls) => { const m = {}; (ls || []).forEach(l => { m[l.ingredient_id] = (m[l.ingredient_id] || 0) + Number(l.quantity); }); return m; };
const sameMap = (a, b) => { const k = new Set([...Object.keys(a), ...Object.keys(b)]); for(const x of k){ if(Math.abs((a[x] || 0) - (b[x] || 0)) > 1e-6) return false; } return true; };
cases.forEach((c, i) => {
  ctx.__c = c;
  const js = r(`inventoryLinesForSaleLine(__c.rid, __c.qty, __c.mods, {raw: true})`);
  const sv = asMap(server[i]);
  if(!sameMap(asMap(js), sv)){ bad++; if(!first) first = JSON.stringify({c, js, server: server[i]}); }
  // cleaned: the server drops operating supplies (napkins) in _clean_stock_lines
  const svClean = Object.assign({}, sv); delete svClean[id.napkin];
  const jsClean = r(`inventoryLinesForSaleLine(__c.rid, __c.qty, __c.mods)`);
  if(!sameMap(asMap(jsClean), svClean)){ badClean++; if(!firstClean) firstClean = JSON.stringify({c, jsClean, server: server[i]}); }
});
{
  const m = (i) => asMap(server[FIX + i]);
  const a = m(0), b = m(1), c = m(2), d = m(3);
  ok(!a[id.milk] && Math.abs(a[id.soy] - 260) < 1e-9 && Math.abs(a[id.beans] - 0.027) < 1e-9, 'server: 16 oz latte + soy = 0 fresh milk, 260 mL soy', JSON.stringify(a));
  ok(!b[id.milk] && Math.abs(b[id.soy] - 400) < 1e-9 && !b[id.oat], 'server: soy then oat (same from) -> only soy moves', JSON.stringify(b));
  ok(!c[id.milk] && !c[id.soy] && Math.abs(c[id.oat] - 0.26) < 1e-9, 'server: oat then soy -> only oat moves (incl. the 16 oz extra)', JSON.stringify(c));
  ok(!d[id.caramel] && !d[id.beans] && d[id.sugar] > 0 && d[id.choco] > 0, 'server: caramel L -> sugar g (from weighs), beans kg -> choco mL (to weighs, incl. extra shot)', JSON.stringify(d));
}
ok(bad === 0, `inventoryLinesForSaleLine(raw) = _recipe_stock_lines on ${N} random lines`, first);
ok(badClean === 0, `inventoryLinesForSaleLine = _recipe_stock_lines + _clean_stock_lines (operating supply dropped) on ${N} lines`, firstClean);
console.log(`ok   stock lines: ${N} random lines compared, ${bad} raw / ${badClean} cleaned different`);

// cleaned by the server itself, for a few lines
const q3 = setup + 'select json_agg(x order by i) from (values ' +
  cases.slice(0, 60).map((c, i) => `(${i}, public._clean_stock_lines(${L(biz)}, public._recipe_stock_lines(${L(biz)}, ${L(c.rid)}, ${c.qty}, ${J(c.mods)})))`).join(',\n') + ') x(i, lines);\nrollback;\n';
const server3 = JSON.parse(psql(q3).trim()).map(x => x.lines);
let bad3 = 0;
cases.slice(0, 60).forEach((c, i) => { ctx.__c = c; if(!sameMap(asMap(r(`inventoryLinesForSaleLine(__c.rid, __c.qty, __c.mods)`)), asMap(server3[i]))) bad3++; });
ok(bad3 === 0, 'cleaned lines = server _clean_stock_lines(_recipe_stock_lines(...)) on 60 lines');

/* ---------- 5. snapshot modifiers (what the counter will keep on the cart) give the same stock ---------- */
let bad5 = 0, first5 = '';
cases.forEach((c, i) => {
  ctx.__c = c;
  const snap = r(`(function(){ const rec = state.recipes.find(x => x.id === __c.rid); return __c.mods.map(m => { const f = findRecipeOption(rec, m); return f ? modifierFromOption(f.group, f.option) : null; }).filter(Boolean); })()`);
  ctx.__snap = snap;
  const js = r(`inventoryLinesForSaleLine(__c.rid, __c.qty, __snap, {raw: true})`);
  if(!sameMap(asMap(js), asMap(server[i]))){ bad5++; if(!first5) first5 = JSON.stringify({c, snap, js, server: server[i]}); }
});
ok(bad5 === 0, `modifierFromOption snapshots give the server's stock on ${N} lines`, first5);

/* ---------- 6. waste: server fo_sync-equivalent stock for ingredient items (unit conversion) ---------- */
const wItems = [[id.caramel, 500, 'g'], [id.caramel, 0.2, 'L'], [id.milk, 1, 'L'], [id.beans, 250, 'g'], [id.cup, 3, null], [id.oat, 330, 'ml']];
const q6 = setup + 'select json_agg(x order by i) from (values ' + wItems.map(([iid, q, u], i) =>
  `(${i}, (select public._to_base_qty(${q}, coalesce(${L(u)}, base_unit), base_unit, weight_g_per_ml)::float8 from public.ingredients where id = ${L(iid)}))`).join(',') + ') x(i, v);\nrollback;\n';
const server6 = JSON.parse(psql(q6).trim());
let bad6 = 0;
wItems.forEach(([iid, q, u], i) => {
  const js = r(`wasteStockLines([{ingredient_id: '${iid}', quantity: ${q}, unit: ${JSON.stringify(u)}}])`);
  if(!(js.length === 1 && Math.abs(js[0].quantity - server6[i].v) < 1e-6)) bad6++;
});
ok(bad6 === 0, 'wasteStockLines (ingredients, typed units incl. weighs) = server conversion');

/* ---------- 7. waste of menu items: buildWasteData + wasteStockLines vs _resolve_options + _recipe_stock_lines + _clean_stock_lines ---------- */
{
  const wcases = [];
  for(let c = 0; c < N; c++){
    const rid = pick(sellable);
    const groups = recOf(rid).modifier_groups || [];
    const mods = [];
    groups.forEach(g => {
      const opts = g.options || [];
      if(!opts.length) return;
      if(g.required && rnd() < 0.15) return;                       // required left out
      const chosen = g.multi_select ? opts.filter(() => rnd() < 0.4) : (rnd() < (g.required ? 1 : 0.6) ? [pick(opts)] : []);
      if(!g.multi_select && opts.length > 1 && rnd() < 0.05) chosen.push(opts.find(o => o !== chosen[0]) || opts[0]);   // two in a pick-one group
      chosen.forEach(o => {
        const f = rnd();
        if(f < 0.45) mods.push({group_id: g.id, option_id: o.id});
        else if(f < 0.9) mods.push({group: g.name, label: o.label});
        else if(f < 0.95) mods.push({group_id: g.id, option_id: o.id, group: g.name, label: o.label});
        else mods.push({group_id: 'stale', option_id: o.id, group: g.name, label: o.label});   // stale id: refused
      });
    });
    if(mods.length && rnd() < 0.04) mods.push(Object.assign({}, mods[0]));   // chosen twice
    if(rnd() < 0.03) mods.push({group: 'Gone', label: 'Not on the menu'});
    wcases.push({rid, mods, qty: pick([1, 2, 0.5, 3, 10])});
  }
  const fn = `create or replace function pg_temp.w(p_biz uuid, p_recipe uuid, p_qty numeric, p_mods jsonb) returns jsonb language plpgsql as $f$
begin
  return jsonb_build_object('lines', public._clean_stock_lines(p_biz, public._recipe_stock_lines(p_biz, p_recipe, p_qty, public._resolve_options(p_biz, p_recipe, p_mods))));
exception when others then return jsonb_build_object('error', sqlerrm);
end $f$;\n`;
  const q7 = setup + fn + 'select json_agg(x.v order by x.i) from (values ' + wcases.map((c, i) => `(${i}, pg_temp.w(${L(biz)}, ${L(c.rid)}, ${c.qty}, ${J(c.mods)}))`).join(',\n') + ') x(i, v);\nrollback;\n';
  const sv7 = JSON.parse(psql(q7).trim());
  let bad7 = 0, refused = 0, first7 = '';
  wcases.forEach((c, i) => {
    ctx.__c = c;
    let js;
    try{ js = {lines: r(`wasteStockLines(buildWasteData({reason:'SPILLAGE', items:[{recipe_id: __c.rid, quantity: __c.qty, modifiers: __c.mods}]}))`)}; }
    catch(e){ js = {error: e.code || e.message}; }
    const s = sv7[i];
    let same;
    if(s.error || js.error){ same = !!(s.error && js.error && /^BAD_WASTE/.test(s.error) && (js.error === 'BAD_WASTE' || js.error === 'OPTION_REQUIRED')); if(s.error) refused++; }
    else same = sameMap(asMap(js.lines), asMap(s.lines));
    if(!same){ bad7++; if(!first7) first7 = JSON.stringify({c, js, server: s}); }
  });
  ok(bad7 === 0, `waste of menu items: same stock / same refusals as the server on ${N} entries (${refused} refused)`, first7);
  console.log(`ok   waste: ${N} entries compared (${refused} refused by both), ${bad7} different`);
}

console.log(`SUMMARY unit/stock_parity_check: ${checks} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
