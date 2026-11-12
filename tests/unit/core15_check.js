// Unit checks (node, no browser, no database) for the release 1.5 shared core (cccc/shared/ui.js + logic.js):
// shop day in Manila whatever the device zone, TXN_SIGN PARTNER_RETURN, stock_count op data + blind-count
// differences, production scaling / "max I can make" / partner debt maths, new error texts.
// Run: node tests/unit/core15_check.js [repo]      (run_all.sh also runs it with TZ=America/Los_Angeles and TZ=Pacific/Kiritimati)
// Adopted by Z 2026-11-12 from the shared-core work's scratch check.
const fs = require('fs');
const vm = require('vm');
const crypto = require('crypto');
const ROOT = process.argv[2] || require('path').resolve(__dirname, '..', '..');
const ctx = {console, Math, JSON, Number, Object, Array, isFinite, Intl, Date, Cloud: {uuid: () => crypto.randomUUID()},
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
console.log('device TZ = ' + (process.env.TZ || '(system)'));

/* ---------- shop day (Asia/Manila, UTC+8, no daylight saving) ---------- */
r(`state.settings = {timezone: 'Asia/Manila', costing_method: 'weighted_average'};`);
eq('todayISO: 17:00 UTC on Nov 10 = Nov 11 in Manila', r(`todayISO(new Date('2026-11-10T17:00:00Z'))`), '2026-11-11');
eq('todayISO: 15:59 UTC on Nov 10 = Nov 10 in Manila', r(`todayISO(new Date('2026-11-10T15:59:59Z'))`), '2026-11-10');
eq('todayISO: ISO string accepted', r(`todayISO('2026-12-31T16:00:00Z')`), '2027-01-01');
eq('todayISO(): today in Manila', r(`todayISO()`), new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10));
eq('shopDayKey with settings {timezone: UTC}', r(`shopDayKey(new Date('2026-11-10T17:00:00Z'), {timezone: 'UTC'})`), '2026-11-10');
eq('shopTimeZone: unknown zone -> Asia/Manila', r(`shopTimeZone({timezone: 'Mars/Olympus'})`), 'Asia/Manila');
eq('shopTimeZone: blank -> Asia/Manila', r(`shopTimeZone({timezone: ' '})`), 'Asia/Manila');
eq('shopDayStartOf(2026-11-11) = 2026-11-10T16:00Z', r(`shopDayStartOf('2026-11-11').toISOString()`), '2026-11-10T16:00:00.000Z');
eq('shopMidnight(01:00 Manila) = that day 00:00 Manila', r(`shopMidnight(new Date('2026-11-10T17:00:00Z')).toISOString()`), '2026-11-10T16:00:00.000Z');
eq('shopMidnight(23:59 Manila) same day', r(`shopMidnight(new Date('2026-11-11T15:59:00Z')).toISOString()`), '2026-11-10T16:00:00.000Z');
eq('shopDayRange(2026-03-01): [Feb 28 16:00Z, Mar 1 16:00Z)', r(`(x => [x.from.toISOString(), x.to.toISOString()])(shopDayRange('2026-03-01'))`), ['2026-02-28T16:00:00.000Z', '2026-03-01T16:00:00.000Z']);
eq('shopKeyAddDays across a month', r(`shopKeyAddDays('2026-02-28', 1)`), '2026-03-01');
eq('shopDayStartOf with a DST zone (New York, Mar 8 2026)', r(`shopDayStartOf('2026-03-08', {timezone: 'America/New_York'}).toISOString()`), '2026-03-08T05:00:00.000Z');
eq('shopDayStartOf with a DST zone (New York, Mar 9 2026)', r(`shopDayStartOf('2026-03-09', {timezone: 'America/New_York'}).toISOString()`), '2026-03-09T04:00:00.000Z');
eq('no state (QR page): Manila', (() => { const c2 = {Intl, Date, Object, String, Number, Math, JSON, Array}; c2.window = c2; vm.createContext(c2);
  vm.runInContext(fs.readFileSync(ROOT + '/cccc/shared/ui.js', 'utf8'), c2); return vm.runInContext(`todayISO(new Date('2026-11-10T17:00:00Z'))`, c2); })(), '2026-11-11');

/* ---------- stock line types ---------- */
eq('TXN_SIGN PARTNER_RETURN = -1', r(`TXN_SIGN.PARTNER_RETURN`), -1);
eq('signedQty PARTNER_RETURN 250 -> -250', r(`signedQty({transaction_type:'PARTNER_RETURN', quantity: 250})`), -250);
eq('stock sum with a return', r(`computeStockFromTransactions([{transaction_type:'PURCHASE',quantity:1000},{transaction_type:'PARTNER_RETURN',quantity:300},{transaction_type:'ADJUSTMENT',quantity:-50}])`), 650);
eq('labels', r(`[txnTypeLabel('PARTNER_RETURN'), wasteReasonLabel('RND'), wasteReasonLabel('COUNT_SHORTAGE'), wasteReasonLabel('CALIBRATION')]`), ['Returned to partner', 'R&D', 'Missing at count', 'Calibration / barista drink']);
eq('the counter still cannot send RND / COUNT_SHORTAGE waste', throwsCode(`buildWasteData({reason:'RND', items:[{ingredient_id:'beans', quantity:1}]})`), 'BAD_WASTE_REASON');

/* ---------- a small shop ---------- */
r(`
state.categories = [{id:'c1', name:'Stock', kind:'STOCK'}, {id:'cx', name:'Operating supplies', kind:'EXPENSE'}];
state.ingredients = [
  {id:'beans', name:'Beans', base_unit:'g', category_id:'c1', count_at_close:true},
  {id:'milk',  name:'Fresh milk', base_unit:'ml', category_id:'c1', count_at_close:true},
  {id:'arla',  name:'Arla milk', base_unit:'L', category_id:'c1', active:false, merged_into:'milk', count_at_close:true},
  {id:'sugar', name:'Sugar', base_unit:'kg', category_id:'c1'},
  {id:'cups',  name:'Cups', base_unit:'pcs', category_id:'c1', count_at_close:true, active:false},
  {id:'napkin',name:'Napkins', base_unit:'pcs', category_id:'cx', count_at_close:true},
  {id:'cara',  name:'Caramel sauce', base_unit:'L', category_id:'c1', is_produced_item:true, source_recipe_id:'r-cara', weight_g_per_ml:1.25}];
state.recipes = [{id:'r-cara', name:'Caramel sauce', is_production_recipe:true, produced_ingredient_id:'cara', expected_yield: 2, yield_unit:'L'}];
state.recipeIngredients = [
  {recipe_id:'r-cara', ingredient_id:'sugar', quantity: 1},          // 1 kg
  {recipe_id:'r-cara', ingredient_id:'arla',  quantity: 0.5},        // 0.5 L of a merged item -> 500 mL of Fresh milk
  {recipe_id:'r-cara', ingredient_id:'milk',  quantity: 250},        // + 250 mL
  {recipe_id:'r-cara', ingredient_id:'napkin',quantity: 2}];         // operating supply: left out
state.purchases = [
  {ingredient_id:'sugar', purchase_date:'2026-11-01', base_quantity: 10, total_price: 700, price_per_base_unit: 70},
  {ingredient_id:'sugar', purchase_date:'2026-11-08', base_quantity: 5,  total_price: 400, price_per_base_unit: 80},
  {ingredient_id:'milk',  purchase_date:'2026-11-05', base_quantity: 1000, total_price: 95, price_per_base_unit: 0.095}];
state.productionBatches = [];
state.stock = {beans: 1200, milk: 1800, sugar: 3.333, cara: 0};
`);

/* ---------- count at closing ---------- */
eq('ticked items: active, not merged, not operating supply; by name', r(`countAtCloseIngredients().map(i => i.id)`), ['beans', 'milk']);
eq('countLineBase 1.2 kg beans -> 1200 g', r(`countLineBase({ingredient_id:'beans', quantity:1.2, unit:'kg'}).quantity`), 1200);
eq('countLineBase merged Arla 1.5 (its own unit L) -> 1500 mL of Fresh milk', r(`(b => [b.ingredient_id, b.quantity])(countLineBase({ingredient_id:'arla', quantity:1.5}))`), ['milk', 1500]);
eq('countLineBase beans in mL = null (BAD_UNIT)', r(`countLineBase({ingredient_id:'beans', quantity:1, unit:'ml'})`), null);
const good = `{shift_id:'sh1', staff_id:'st1', note:'  closing  ', lines:[{ingredient_id:'beans', quantity:1.15, unit:'kg'},{ingredient_id:'milk', quantity:1.8, unit:'L'}]}`;
eq('buildStockCountData: shape', r(`(d => [typeof d.id, d.shift_id, d.staff_id, typeof d.counted_at, d.note, d.lines])(buildStockCountData(${good}))`),
  ['string', 'sh1', 'st1', 'string', 'closing', [{ingredient_id:'beans', quantity:1.15, unit:'kg'}, {ingredient_id:'milk', quantity:1.8, unit:'L'}]]);
eq('buildStockCountData keeps a given id (retries)', r(`buildStockCountData(Object.assign(${good}, {id:'c-1'})).id`), 'c-1');
eq('missing ticked item -> COUNT_REQUIRED + missing', (() => { try{ r(`buildStockCountData({lines:[{ingredient_id:'beans', quantity:1}]})`); return 'no error'; }catch(e){ return [e.code, e.missing]; } })(), ['COUNT_REQUIRED', [{ingredient_id:'milk', name:'Fresh milk'}]]);
eq('requireAll:false allows a partial count', r(`buildStockCountData({lines:[{ingredient_id:'beans', quantity:1}]}, {requireAll:false}).lines.length`), 1);
eq('no lines -> COUNT_REQUIRED', throwsCode(`buildStockCountData({lines:[]})`), 'COUNT_REQUIRED');
eq('not ticked item -> BAD_COUNT', throwsCode(`buildStockCountData({lines:[{ingredient_id:'beans', quantity:1},{ingredient_id:'milk', quantity:1},{ingredient_id:'sugar', quantity:1}]})`), 'BAD_COUNT');
eq('operating supply -> BAD_COUNT', throwsCode(`buildStockCountData({lines:[{ingredient_id:'napkin', quantity:1}]}, {requireAll:false})`), 'BAD_COUNT');
eq('same item twice (merged name + general) -> BAD_COUNT', throwsCode(`buildStockCountData({lines:[{ingredient_id:'milk', quantity:1},{ingredient_id:'arla', quantity:1},{ingredient_id:'beans', quantity:1}]})`), 'BAD_COUNT');
eq('negative -> BAD_QUANTITY', throwsCode(`buildStockCountData({lines:[{ingredient_id:'beans', quantity:-1},{ingredient_id:'milk', quantity:1}]})`), 'BAD_QUANTITY');
eq('blank amount -> BAD_QUANTITY', throwsCode(`buildStockCountData({lines:[{ingredient_id:'beans', quantity:''},{ingredient_id:'milk', quantity:1}]})`), 'BAD_QUANTITY');
eq('too large -> BAD_QUANTITY', throwsCode(`buildStockCountData({lines:[{ingredient_id:'beans', quantity:10000001},{ingredient_id:'milk', quantity:1}]})`), 'BAD_QUANTITY');
eq('0 is a valid count', r(`buildStockCountData({lines:[{ingredient_id:'beans', quantity:0},{ingredient_id:'milk', quantity:0}]}).lines[0].quantity`), 0);
eq('wrong unit -> BAD_UNIT', throwsCode(`buildStockCountData({lines:[{ingredient_id:'beans', quantity:1, unit:'pcs'},{ingredient_id:'milk', quantity:1}]})`), 'BAD_UNIT');
eq('unknown item -> UNKNOWN_INGREDIENT', throwsCode(`buildStockCountData({lines:[{ingredient_id:'zzz', quantity:1}]})`), 'UNKNOWN_INGREDIENT');
eq('nothing ticked -> BAD_COUNT', (() => { r(`state.ingredients.forEach(i => { i._t = i.count_at_close; i.count_at_close = false; })`);
  const c = throwsCode(`buildStockCountData({lines:[{ingredient_id:'beans', quantity:1}]})`); r(`state.ingredients.forEach(i => { i.count_at_close = i._t; delete i._t; })`); return c; })(), 'BAD_COUNT');
eq('stockCountCoversTicked', r(`[stockCountCoversTicked([{ingredient_id:'beans', quantity:1},{ingredient_id:'arla', quantity:1}]).ok, stockCountCoversTicked([{ingredient_id:'beans', quantity:1}]).missing.map(m=>m.ingredient_id)]`), [true, ['milk']]);
eq('countDifferences: only items that differ (1.15 kg vs 1200 g, 1.8 L = 1800 mL)', r(`countDifferences(${good}.lines)`),
  [{ingredient_id:'beans', name:'Beans', unit:'g', counted:1150, expected:1200, difference:-50, kind:'MISSING'}]);
eq('countDifferences: extra', r(`countDifferences([{ingredient_id:'milk', quantity:2, unit:'L'}])`), [{ingredient_id:'milk', name:'Fresh milk', unit:'ml', counted:2000, expected:1800, difference:200, kind:'EXTRA'}]);
eq('countDifferences: own expected map + tolerance 0.000001', r(`countDifferences([{ingredient_id:'beans', quantity:5.0000005},{ingredient_id:'milk', quantity:3}], {beans:5, milk:3.5})`).map(d => [d.ingredient_id, d.difference]), [['milk', -0.5]]);
eq('countDifferences: merged name counted against the general item', r(`countDifferences([{ingredient_id:'arla', quantity:1.7}]).map(d => [d.ingredient_id, d.difference])`), [['milk', -100]]);
eq('countDifferences: no stock row = expected 0', r(`countDifferences([{ingredient_id:'beans', quantity:3}], {}).map(d => d.difference)`), [3]);
eq('stockCountDeltas: WASTE for missing, ADJUSTMENT for extra', r(`stockCountDeltas({lines:[{ingredient_id:'beans', quantity:1.15, unit:'kg'},{ingredient_id:'milk', quantity:2, unit:'L'}]})`),
  [{ingredient_id:'beans', transaction_type:'WASTE', quantity:50}, {ingredient_id:'milk', transaction_type:'ADJUSTMENT', quantity:200}]);
eq('applyStockDeltas(stockCountDeltas) brings stock to the count', r(`(() => { const s = Object.assign({}, state.stock); applyStockDeltas(stockCountDeltas({lines:[{ingredient_id:'beans', quantity:1.15, unit:'kg'},{ingredient_id:'milk', quantity:2, unit:'L'}]}));
  const out = [state.stock.beans, state.stock.milk]; state.stock = s; return out; })()`), [1150, 2000]);
eq('countReviewText', r(`countReviewText('COUNT_EXTRA, LARGE_SHORTAGE')`), 'More counted than expected (stock was raised to the count); Missing stock worth more than the review limit');

/* ---------- production scaling ---------- */
eq('scaleProduction 1x: merged milk added to Fresh milk, napkins left out, by name', r(`scaleProduction('r-cara', 1)`),
  [{ingredient_id:'milk', name:'Fresh milk', unit:'ml', quantity:750}, {ingredient_id:'sugar', name:'Sugar', unit:'kg', quantity:1}]);
eq('scaleProduction 0.5x', r(`scaleProduction('r-cara', 0.5).map(l => l.quantity)`), [375, 0.5]);
eq('scaleProduction 2x (recipe object)', r(`scaleProduction(state.recipes[0], 2).map(l => l.quantity)`), [1500, 2]);
eq('scaleProduction custom 1.3333333x: scale rounded to 6 dp first (server)', r(`scaleProduction('r-cara', 1.3333333).map(l => l.quantity)`), [999.99975, 1.333333]);
eq('scaleProduction bad scales -> []', r(`[0, -1, 101, 'x', null].map(s => scaleProduction('r-cara', s).length)`), [0, 0, 0, 0, 0]);
eq('productionYield / productionScaleFromYield', r(`[productionYield('r-cara', 0.5), productionScaleFromYield('r-cara', 3), productionScaleFromYield('r-cara', 0)]`), [1, 1.5, null]);
eq('maxBatchFromStock: sugar 3.333 kg limits (3.333x -> 3.3x)', r(`maxBatchFromStock('r-cara', {milk: 5000, sugar: 3.333})`), {scale: 3.3, limiting_ingredient_id: 'sugar', exact: 3.333});
eq('maxBatchFromStock: milk 1800 mL limits (2.4x)', r(`maxBatchFromStock('r-cara', {milk:1800, sugar:10})`), {scale: 2.4, limiting_ingredient_id: 'milk', exact: 2.4});
eq('maxBatchFromStock: 0.001 tolerance (1799.9995 mL still 2.4x)', r(`maxBatchFromStock('r-cara', {milk:1799.9995, sugar:10}).scale`), 2.4);
eq('maxBatchFromStock: no milk -> 0', r(`maxBatchFromStock('r-cara', {sugar:10})`), {scale: 0, limiting_ingredient_id: 'milk', exact: 0});
eq('maxBatchFromStock: negative stock -> 0', r(`maxBatchFromStock('r-cara', {milk:-5, sugar:10}).scale`), 0);
eq('maxBatchFromStock: capped at 100x', r(`maxBatchFromStock('r-cara', {milk:1e9, sugar:1e9}).scale`), 100);
eq('maxBatchFromStock: 0.04x possible -> 0', r(`maxBatchFromStock('r-cara', {milk:30, sugar:10}).scale`), 0);
eq('maxBatchFromStock: recipe without stock lines', r(`maxBatchFromStock({id:'none'})`), {scale: null, limiting_ingredient_id: null, exact: null});
eq('scaleProduction(max) never needs more than stock', r(`(() => { const m = maxBatchFromStock('r-cara'); return m.scale > 0 && scaleProduction('r-cara', m.scale).every(l => l.quantity <= state.stock[l.ingredient_id] + 0.001); })()`), true);

/* ---------- costs as of a day + partner debts ---------- */
eq('ingredientUnitCostAsOf sugar (weighted avg 1100/15)', r(`ingredientUnitCostAsOf('sugar', '2026-11-10')`), 1100 / 15);
eq('ingredientUnitCostAsOf sugar before 2nd purchase = 70', r(`ingredientUnitCostAsOf('sugar', '2026-11-05')`), 70);
eq('ingredientUnitCostAsOf sugar before any purchase = 0', r(`ingredientUnitCostAsOf('sugar', '2026-10-01')`), 0);
eq('ingredientUnitCostAsOf latest method', r(`(() => { state.settings.costing_method = 'latest'; const c = ingredientUnitCostAsOf('sugar', '2026-11-10'); state.settings.costing_method = 'weighted_average'; return c; })()`), 80);
eq('ingredientUnitCostAsOf standard_cost fallback', r(`(() => { const i = ingredientById('beans'); i.standard_cost = 1.5; const c = ingredientUnitCostAsOf('beans', '2026-11-10'); delete i.standard_cost; return c; })()`), 1.5);
eq('ingredientUnitCostAsOf house-made = recipe cost / yield', r(`Math.round(ingredientUnitCostAsOf('cara', '2026-11-10') * 1e6) / 1e6`),
  Math.round((1 * 1100 / 15 + 250 * 0.095 /* milk own line */ + 0 /* arla: no purchases of its own */) / 2 * 1e6) / 1e6);
eq('partnerDebtLines = scaleProduction', r(`JSON.stringify(partnerDebtLines('r-cara', 0.5)) === JSON.stringify(scaleProduction('r-cara', 0.5))`), true);
eq('partnerDebtPlan: line values (centavos), unit_cost 6 dp, total = round(sum)', r(`partnerDebtPlan(partnerDebtLines('r-cara', 1), {milk: 0.095, sugar: 1100/15})`),
  {lines: [{ingredient_id:'milk', name:'Fresh milk', unit:'ml', quantity:750, unit_cost:0.095, value:71.25},
           {ingredient_id:'sugar', name:'Sugar', unit:'kg', quantity:1, unit_cost:73.333333, value:73.33}], value: 144.58});
eq('partnerDebtValue: total is not the sum of rounded lines', r(`partnerDebtValue([{ingredient_id:'a', quantity:1},{ingredient_id:'b', quantity:1}], {a: 0.004, b: 0.004})`), 0.01);
eq('partnerDebtValue: costs as a function', r(`partnerDebtValue([{ingredient_id:'a', quantity:3}], id => 2.5)`), 7.5);
eq('partnerDebtValue: default costs as of a day', r(`partnerDebtValue(partnerDebtLines('r-cara', 1), null, '2026-11-05')`), Math.round((750 * 0.095 + 70) * 100) / 100);

/* ---------- error texts ---------- */
const codes = ['TABLE_FULL','GUEST_TABLE_BUSY','UNPAID_ORDERS','SIGN_OUT_FIRST','USERNAME_TAKEN','BAD_USERNAME','TOO_MANY_ATTEMPTS',
  'RETURN_EXCEEDS_DEBT','PAYMENT_TOO_LARGE','NOT_IN_DEBT','WRONG_DEBT_KIND','PARTNER_BATCH_HAS_DEBT','BAD_BARISTA_KIT','NOTE_REQUIRED',
  'COUNT_REQUIRED','BAD_COUNT','FORBIDDEN_ROW','COUNT_NOT_FOUND','BAD_RND','UNKNOWN_PROJECT','PROJECT_CLOSED','PROJECT_NAME_TAKEN','PROJECT_HAS_USAGE',
  'NOT_A_PRODUCTION_RECIPE','NOT_A_PARTNER','BAD_DEBT_KIND','BAD_SCALE','BAD_YIELD','NO_INGREDIENTS','DEBT_VALUE_ZERO','PARTNER_HAS_DEBTS',
  'DEBT_NOT_FOUND','DEBT_NOT_OPEN','BAD_RETURN','BAD_PAYMENT','CARD_NOT_ISSUED','REGISTER_FIRST','TOO_MANY_OPEN_ORDERS','TABLE_NOT_FOUND'];
eq('every new code has a text', codes.filter(c => !r(`ERROR_TEXT`)[c]), []);
eq('friendlyError of an fo_sync answer', r(`friendlyError({status:'error', message:'COUNT_REQUIRED'})`), 'Count the ticked items before closing the shift.');
eq('friendlyError of a raised owner RPC error', r(`friendlyError(new Error('RETURN_EXCEEDS_DEBT'))`), r(`ERROR_TEXT.RETURN_EXCEEDS_DEBT`));
eq('friendlyError of a QR {error} answer', r(`friendlyError({error:'TABLE_FULL'})`), r(`ERROR_TEXT.TABLE_FULL`));
eq('a thrown count Error reads well', (() => { try{ r(`buildStockCountData({lines:[]})`); }catch(e){ ctx.__e = e; } return r(`friendlyError(__e)`); })(), 'Count the ticked items before closing the shift.');
eq('customer text for TOO_MANY_ATTEMPTS', r(`customerFriendlyError({error:'TOO_MANY_ATTEMPTS'})`), 'Too many tries. Please ask our staff at the counter, or try again later.');
eq('customerFriendlyError falls back to friendlyError', r(`customerFriendlyError({error:'TABLE_FULL'})`), r(`ERROR_TEXT.TABLE_FULL`));
eq('staff TOO_MANY_ATTEMPTS unchanged', r(`friendlyError('TOO_MANY_ATTEMPTS')`), 'Too many tries. Please wait a few minutes and try again.');
const leak = codes.filter(c => /registered|not found.*number|no account/i.test(r(`ERROR_TEXT`)[c] || ''));
eq('no customer text says whether a number is registered', leak, []);


/* ---------- B16 stamp card pass-through ---------- */
const sum16 = `{total_stamps: 20, card: {card_size: 15, card_no: 1, stamps_on_card: 15, saved_stamps: 5, last_reward_stamp: 15,
  milestones: [{stamp:5,type:'AMOUNT_OFF',amount:10,status:'redeemed'},{stamp:15,type:'FREE_ITEM',status:'ready'}]},
  ready_rewards: [{card_no:1, stamp:15, type:'FREE_ITEM'}],
  history: [{card_no: 0, filled_at: null, completed_at: null, rewards: []}]}`;
eq('loyaltyCardView: card_no from the server (20 stamps, still card 1)', r(`loyaltyCardView(${sum16}).card_no`), 1);
eq('loyaltyCardView: saved_stamps / last_reward_stamp / history passed through', r(`(v => [v.stamps_on_card, v.saved_stamps, v.last_reward_stamp, v.history.length])(loyaltyCardView(${sum16}))`), [15, 5, 15, 1]);
eq('loyaltyCardView: server card without card_no -> 1, not worked out', r(`loyaltyCardView({total_stamps: 40, card: {card_size: 15, stamps_on_card: 15}}).card_no`), 1);
eq('loyaltyCardView: old answer without a card still works it out', r(`(v => [v.card_no, v.stamps_on_card, v.saved_stamps, v.history])(loyaltyCardView({total_stamps: 20}))`), [2, 5, 0, []]);
eq('CARD_NOT_ISSUED text', r(`friendlyError({status:'error', message:'CARD_NOT_ISSUED'})`).startsWith("This reward's stamp card isn't open yet"), true);

/* ---------- B7 barista kit ---------- */
eq('cleanBaristaKit tidies', r(`cleanBaristaKit([{ingredient_id:'beans', quantity:'18', unit:'g', x:1},{ingredient_id:'beans', quantity:2},{ingredient_id:'milk', quantity:0},{quantity:3},{ingredient_id:'milk', quantity:150, unit:' '}])`),
  [{ingredient_id:'beans', quantity:18, unit:'g'}, {ingredient_id:'milk', quantity:150, unit:null}]);
eq('setSettingsFromServer keeps barista_kit; serverSettingsRow sends it back', r(`(() => { const old = state.settings; setSettingsFromServer({barista_kit: [{ingredient_id:'beans', quantity:18, unit:'g'}]});
  const a = state.settings.barista_kit.length, b = serverSettingsRow().barista_kit.length; setSettingsFromServer({}); const c = state.settings.barista_kit, d = 'barista_kit' in serverSettingsRow(); state.settings = old; return [a, b, c, d]; })()`), [1, 1, [], false]);
eq('baristaKitItems: unknown / non-stock items left out, merged kept', r(`baristaKitItems({barista_kit:[{ingredient_id:'beans', quantity:18},{ingredient_id:'zzz', quantity:1},{ingredient_id:'napkin', quantity:1},{ingredient_id:'arla', quantity:0.1, unit:'L'}]}).map(l => l.ingredient_id)`), ['beans', 'arla']);
eq('kit -> CALIBRATION waste data', r(`buildWasteData({reason:'CALIBRATION', items: baristaKitItems({barista_kit:[{ingredient_id:'beans', quantity:18, unit:'g'}]})}).items`), [{ingredient_id:'beans', quantity:18, unit:'g'}]);

console.log(`SUMMARY unit/core15_check: ${checks} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
