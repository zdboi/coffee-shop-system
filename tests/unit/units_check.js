// Unit checks (node, no browser, no database) for the batch-1 unit helpers in cccc/shared/logic.js:
//   compatibleUnits, convertQuantity, toBaseUnit, fromBaseUnit, unitLabel, formatQuantity
// + CATEGORY_SEED (Raw materials added) + toBaseQuantity (purchase maths) unchanged.
// Rule (CLAUDE.md / owner request #3): every STORED quantity is in the ingredient's base unit;
// these helpers only convert what is typed and how it is shown.
// Run:  node tests/unit/units_check.js [repo path]
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const ROOT = process.argv[2] || path.resolve(__dirname, '..', '..');
const ctx = {console}; ctx.window = ctx; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'cccc/shared/logic.js'), 'utf8'), ctx);
const r = (s) => vm.runInContext(s, ctx);

let checks = 0, failed = 0;
function eq(name, got, exp){
  checks++;
  const good = JSON.stringify(got) === JSON.stringify(exp);
  if(!good) failed++;
  console.log((good ? 'ok   ' : 'FAIL ') + name + (good ? '' : '   [got: ' + JSON.stringify(got) + ', expected ' + JSON.stringify(exp) + ']'));
}

// ---- which units can be typed for a base unit
eq('compatibleUnits(g) = g, kg', r("compatibleUnits('g')"), ['g', 'kg']);
eq('compatibleUnits(kg) = g, kg', r("compatibleUnits('kg')"), ['g', 'kg']);
eq('compatibleUnits(ml) = ml, L', r("compatibleUnits('ml')"), ['ml', 'L']);
eq('compatibleUnits(L) = ml, L', r("compatibleUnits('L')"), ['ml', 'L']);
eq('compatibleUnits(pcs) = pcs only', r("compatibleUnits('pcs')"), ['pcs']);
eq('compatibleUnits(box) = box only (pack size is per purchase)', r("compatibleUnits('box')"), ['box']);
eq('compatibleUnits(empty) = none', r("compatibleUnits('')"), []);

// ---- conversions
eq('1 L -> 1000 ml', r("convertQuantity(1,'L','ml')"), 1000);
eq('150 ml -> 0.15 L', r("convertQuantity(150,'ml','L')"), 0.15);
eq('2.5 kg -> 2500 g', r("convertQuantity(2.5,'kg','g')"), 2500);
eq('100 g -> 0.1 kg', r("convertQuantity(100,'g','kg')"), 0.1);
eq('"0.25" (text) kg -> 250 g', r("convertQuantity('0.25','kg','g')"), 250);
eq('same unit unchanged (pcs)', r("convertQuantity(3,'pcs','pcs')"), 3);
eq('weight -> volume refused (null)', r("convertQuantity(5,'g','ml')"), null);
eq('volume -> weight refused (null)', r("convertQuantity(5,'L','kg')"), null);
eq('pcs -> box refused (null)', r("convertQuantity(3,'pcs','box')"), null);
eq('not a number -> null', r("convertQuantity('abc','g','kg')"), null);
eq('Infinity -> null', r("convertQuantity(Infinity,'g','kg')"), null);
eq('unknown unit -> null', r("convertQuantity(1,'oz','g')"), null);
eq('float noise rounded (0.1+0.2 ml -> 0.0003 L)', r("convertQuantity(0.1+0.2,'ml','L')"), 0.0003);
eq('rounded to 6 decimals (333.3333333 ml -> 0.333333 L)', r("convertQuantity(333.3333333,'ml','L')"), 0.333333);
eq('negative amounts convert too (adjustment -0.5 L -> -500 ml)', r("convertQuantity(-0.5,'L','ml')"), -500);

// ---- typed -> base, base -> shown
eq('toBaseUnit 150 ml for base L = 0.15', r("toBaseUnit(150,'ml','L')"), 0.15);
eq('toBaseUnit 0.5 L for base ml = 500', r("toBaseUnit(0.5,'L','ml')"), 500);
eq('toBaseUnit 1.2 kg for base g = 1200', r("toBaseUnit(1.2,'kg','g')"), 1200);
eq('toBaseUnit with no unit = already base', r("toBaseUnit(2,'','kg')"), 2);
eq('toBaseUnit incompatible unit = null (never saved as-is)', r("toBaseUnit(2,'g','L')"), null);
eq('fromBaseUnit 0.15 L shown in ml = 150 ml', r("fromBaseUnit(0.15,'L','ml')"), {qty: 150, unit: 'ml'});
eq('fromBaseUnit 2500 g shown in kg = 2.5 kg', r("fromBaseUnit(2500,'g','kg')"), {qty: 2.5, unit: 'kg'});
eq('fromBaseUnit incompatible display unit falls back to base', r("fromBaseUnit(2,'L','g')"), {qty: 2, unit: 'L'});
eq('fromBaseUnit no display unit = base', r("fromBaseUnit(2,'pcs')"), {qty: 2, unit: 'pcs'});
eq('fromBaseUnit missing amount = 0', r("fromBaseUnit(null,'g','kg')"), {qty: 0, unit: 'kg'});

// round trip: what is typed, stored in base and shown again is the same number
let rtBad = [];
for(const [base, disp] of [['g', 'kg'], ['kg', 'g'], ['ml', 'L'], ['L', 'ml']]){
  for(const typed of [0.001, 0.15, 1, 2.5, 12.345, 150, 999.999, 1234.5]){
    const stored = r(`toBaseUnit(${typed},'${disp}','${base}')`);
    const shown = r(`fromBaseUnit(${stored},'${base}','${disp}')`);
    if(Math.abs(shown.qty - typed) > 1e-6 || shown.unit !== disp) rtBad.push(`${typed} ${disp} (base ${base}) -> ${stored} -> ${shown.qty}`);
  }
}
eq('round trip typed -> base -> shown keeps the number (32 cases, base g/kg/ml/L)', rtBad, []);

// ---- labels and display
eq('unitLabel(ml) = mL', r("unitLabel('ml')"), 'mL');
eq('unitLabel(L) = L', r("unitLabel('L')"), 'L');
eq('unitLabel(kg) = kg', r("unitLabel('kg')"), 'kg');
eq('unitLabel(null) = empty', r("unitLabel(null)"), '');
eq('formatQuantity 0.15 L as ml = "150 mL"', r("formatQuantity(0.15,'L','ml')"), '150 mL');
eq('formatQuantity 100 g as kg = "0.1 kg"', r("formatQuantity(100,'g','kg')"), '0.1 kg');
eq('formatQuantity 1 g as kg, 4 dp = "0.001 kg"', r("formatQuantity(1,'g','kg',4)"), '0.001 kg');
eq('formatQuantity trims trailing zeros (1500 ml as L = "1.5 L")', r("formatQuantity(1500,'ml','L')"), '1.5 L');
eq('formatQuantity base unit when no display unit ("3 pcs")', r("formatQuantity(3,'pcs')"), '3 pcs');

// ---- purchase maths (money path) unchanged by batch 1
eq('toBaseQuantity 2 L bought, base ml = 2000', r("toBaseQuantity(2,'L','ml')"), 2000);
eq('toBaseQuantity 1 kg bought, base g = 1000', r("toBaseQuantity(1,'kg','g')"), 1000);
eq('toBaseQuantity 3 box x 50 pcs = 150', r("toBaseQuantity(3,'box','pcs',50)"), 150);
eq('toBaseQuantity same unit = unchanged', r("toBaseQuantity(7,'g','g')"), 7);

// ---- starter categories
const seed = r('CATEGORY_SEED');
eq('CATEGORY_SEED has 9 names incl. "Raw materials" (+ House-Made made by the server = 10)', [seed.length, seed.includes('Raw materials')], [9, true]);
eq('CATEGORY_SEED has no duplicates (case-insensitive)', new Set(seed.map(s => s.toLowerCase())).size, seed.length);

console.log(`SUMMARY unit/units_check: ${checks} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
