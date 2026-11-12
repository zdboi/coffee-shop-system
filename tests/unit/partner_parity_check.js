// Parity (release 1.5, B15): logic.js scaleProduction + partnerDebtPlan vs the server's _partner_batch_plan (012).
// Run: node tests/unit/partner_parity_check.js <repo> <database>     (needs a freshly seeded shop: tests/e2e_reset.sh <db>;
// loads unit/parity15/fixture.sql itself; adopted by Z 2026-11-12 from the shared-core work)
const fs = require('fs'), vm = require('vm'), {execFileSync} = require('child_process'), crypto = require('crypto');
const path = require('path');
const ROOT = process.argv[2] || path.resolve(__dirname, '..', '..'), DB = process.argv[3] || 'cccc';
if(!/^[a-z_][a-z0-9_]*$/.test(DB)) throw new Error('database name must be plain lowercase');
const psqlRaw = (args) => execFileSync('psql', ['-h', '/tmp', '-p', '54329', '-U', 'postgres', '-d', DB, '-At', '-v', 'ON_ERROR_STOP=1'].concat(args), {encoding: 'utf8', env: Object.assign({}, process.env, {PGOPTIONS: '-c client_min_messages=warning'})}).trim();
const BIZ = psqlRaw(['-c', "select business_id from public.profiles where id = '00000000-0000-0000-0000-0000000000a1'"]);
if(!BIZ) throw new Error('no seeded shop in ' + DB + ' (run tests/e2e_reset.sh ' + DB + ' first)');
// the fixture (once per database)
if(psqlRaw(['-c', "select count(*) from public.ingredients where id = 'a0000000-0000-0000-0000-000000000001'"]) === '0') psqlRaw(['-q', '-f', path.join(__dirname, 'parity15', 'fixture.sql')]);
const q = (sql) => JSON.parse(execFileSync('psql', ['-h', '/tmp', '-p', '54329', '-U', 'postgres', '-d', DB, '-At', '-c', sql], {encoding: 'utf8'}).trim() || 'null');
const rows = (t, where) => q(`select coalesce(json_agg(x), '[]') from (select * from public.${t} where business_id = '${BIZ}' ${where || ''}) x`);
const ctx = {console, Intl, Date, Cloud: {uuid: () => crypto.randomUUID()}, localStorage: {getItem: () => null, setItem() {}, removeItem() {}}};
ctx.window = ctx; vm.createContext(ctx);
for(const f of ['ui.js', 'logic.js']) vm.runInContext(fs.readFileSync(ROOT + '/cccc/shared/' + f, 'utf8'), ctx);
const costs = Object.fromEntries(rows('ingredient_costs').map(c => [c.ingredient_id, c.standard_cost]));
Object.assign(vm.runInContext('state', ctx), {
  settings: Object.assign({timezone: 'Asia/Manila'}, q(`select row_to_json(s) from public.settings s where business_id = '${BIZ}'`)),
  categories: rows('categories'), ingredients: rows('ingredients').map(i => Object.assign(i, costs[i.id] != null ? {standard_cost: costs[i.id]} : {})),
  recipes: rows('recipes'), recipeIngredients: rows('recipe_ingredients'), purchases: rows('purchases'), productionBatches: rows('production_batches')});
let checks = 0, failed = 0;
const eq = (name, got, want) => { checks++; const g = JSON.stringify(got), w = JSON.stringify(want);
  if(g === w) console.log('ok   ' + name); else { failed++; console.log('FAIL ' + name + '\n     js     ' + g + '\n     server ' + w); } };
const near = (a, b, tol) => Math.abs(Number(a) - Number(b)) <= tol;
const SUP = 'd0000000-0000-0000-0000-000000000001';
const cases = [];
for(const rec of ['b0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000002'])
  for(const scale of [0.5, 1, 2, 1.3333333, 0.05, 7.77, 100])
    for(const day of ['2026-11-01', '2026-11-05', '2026-11-10', '2026-11-11'])
      cases.push({recipe_id: rec, supplier_id: SUP, debt_kind: 'INGREDIENTS', scale, production_date: day});
cases.push({recipe_id: 'b0000000-0000-0000-0000-000000000001', supplier_id: SUP, debt_kind: 'PESOS', expected_yield: 2.25, production_date: '2026-11-10'});
for(const p of cases){
  const srv = q(`select public._partner_batch_plan('${BIZ}', '${JSON.stringify(p)}'::jsonb)`);
  const scale = p.scale != null ? p.scale : vm.runInContext(`productionScaleFromYield('${p.recipe_id}', ${p.expected_yield})`, ctx);
  ctx.__a = [p.recipe_id, scale, p.production_date];
  const js = vm.runInContext(`(() => { const [r, s, d] = __a; const lines = partnerDebtLines(r, s); const plan = partnerDebtPlan(lines, null, d);
    return {scale: cleanProductionScale(s), expected_yield: productionYield(r, s), lines: plan.lines, value: plan.value}; })()`, ctx);
  const tag = `${p.recipe_id.slice(-1)} x${scale} ${p.production_date} ${p.debt_kind}`;
  eq(tag + ': scale + expected yield', [js.scale, js.expected_yield], [Number(srv.scale), Number(srv.expected_yield)]);
  eq(tag + ': lines (id, qty)', js.lines.map(l => [l.ingredient_id, l.quantity]).sort(), srv.lines.map(l => [l.ingredient_id, Number(l.quantity)]).sort());
  const byId = Object.fromEntries(srv.lines.map(l => [l.ingredient_id, l]));
  eq(tag + ': unit costs (6 dp) + line values', js.lines.every(l => byId[l.ingredient_id] && near(l.unit_cost, byId[l.ingredient_id].unit_cost, 1e-6) && near(l.value, byId[l.ingredient_id].value, 1e-9)), true);
  eq(tag + ': value', js.value, Number(srv.value));
}
// shop day: same as the server's _shop_day now
eq('todayISO() = _shop_day(now())', vm.runInContext('todayISO()', ctx), q(`select to_json(public._shop_day('${BIZ}', now()))`));
console.log(`SUMMARY unit/partner_parity_check: ${checks} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
