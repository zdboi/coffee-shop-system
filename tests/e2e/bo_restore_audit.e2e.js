// Part 3 audit, item G3 (Z, 2026-11-14): does a Back Office BACKUP really RESTORE?
// Disaster drill: the shop's database is lost, the owner makes a new shop login and imports the
// last backup file. Compares the new shop with the old one, table by table and peso by peso.
//   1. source shop (SRC_DB, stand-in already running on FAKE_PORT): owner signs in -> buildCloudBackup()
//      = exactly what "Download backup" saves.
//   2. empty database (DST_DB): a new owner login (new empty shop) -> the stand-in is moved to DST_DB ->
//      owner signs in -> runImport(backup) = what "Import a backup file" does.
//   3. compare: rows per table, money (sales, payments, refunds, cash movements), stock per ingredient,
//      settings, and what a backup does NOT carry (listed, not failed, when it is by design).
// Run with tests/restore_audit.sh (makes the source data first). Never touches the real Supabase.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const H = require('./lib/h');
const { ok, PLAYWRIGHT, SHOTS, summary, abort, boLogin } = H;
const SRC = process.env.SRC_DB || 'db_rev_rsrc', DST = process.env.DST_DB || 'db_rev_rdst';
const PORT = String(H.PORT);
const REPO = path.resolve(__dirname, '..', '..');
for(const d of [SRC, DST]) if(!/^db_rev_[a-z0-9_]+$/.test(d)) throw new Error('SRC_DB / DST_DB must be Z probe databases (db_rev_...)');
const psql = (db, q) => execFileSync('psql', ['-h', '/tmp', '-p', '54329', '-U', 'postgres', '-d', db, '-At', '-q', '-v', 'ON_ERROR_STOP=1', '-c', q], {encoding: 'utf8'}).trim();
const J = (db, q) => JSON.parse(psql(db, `select coalesce(json_agg(t), '[]') from (${q}) t`));

// every number we compare, for the shop of the owner with this email
function snapshot(db, email){
  const biz = psql(db, `select business_id from profiles p join auth.users u on u.id = p.id where u.email = '${email}'`);
  const tables = J(db, `select c.relname as tname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
                        and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'business_id' and not a.attisdropped) order by 1`).map(r => r.tname);
  const counts = {};
  for(const t of tables) counts[t] = Number(psql(db, `select count(*) from public.${t} where business_id = '${biz}'`));
  const money = J(db, `select
      (select coalesce(sum(grand_total), 0) from sales where business_id = '${biz}' and status <> 'HELD') as sales_total,
      (select count(*) from sales where business_id = '${biz}' and status = 'COMPLETED') as sales_completed,
      (select coalesce(sum(amount), 0) from payments where business_id = '${biz}') as payments_total,
      (select coalesce(sum(amount), 0) from refunds where business_id = '${biz}') as refunds_total,
      (select coalesce(sum(amount), 0) from cash_movements where business_id = '${biz}') as cash_moves,
      (select coalesce(sum(amount), 0) from investors where business_id = '${biz}') as invested,
      (select coalesce(sum(amount), 0) from startup_costs where business_id = '${biz}') as startup,
      (select coalesce(sum(amount), 0) from expenses where business_id = '${biz}') as expenses,
      (select count(*) from senior_discount_records where business_id = '${biz}') as senior_records,
      (select count(*) from staff_pins sp join staff s on s.id = sp.staff_id where s.business_id = '${biz}') as staff_pins`)[0];
  const stock = Object.fromEntries(J(db, `select i.name, round(coalesce(v.stock, 0), 3) as s from ingredients i left join v_ingredient_stock v on v.ingredient_id = i.id
                                          where i.business_id = '${biz}' order by i.name`).map(r => [r.name, Number(r.s)]));
  const settings = J(db, `select tax_pct, service_charge_pct, tax_inclusive, loyalty_enabled, payment_methods, profit_split, loyalty_rewards, senior_discount_pct, business_name
                          from settings where business_id = '${biz}'`)[0] || {};
  return {biz, counts, money, stock, settings};
}

(async () => {
  const { chromium } = require(PLAYWRIGHT);
  const browser = await chromium.launch();
  try{
    // ---- 1. backup of the source shop
    const before = snapshot(SRC, 'owner@example.com');
    ok(before.counts.sales > 0 && before.counts.refunds > 0 && before.counts.investors > 0 && before.money.senior_records > 0,
       `source shop has data to restore (${before.counts.sales} sales, ${before.counts.refunds} refunds, ${before.counts.investors} investors, ${before.money.senior_records} Senior/PWD records)`, before.counts);
    const ctx1 = await browser.newContext({viewport: {width: 1280, height: 900}, timezoneId: 'Asia/Manila'});
    const p1 = await ctx1.newPage();
    const errs1 = []; p1.on('pageerror', e => errs1.push(String(e)));
    await boLogin(p1);
    const backup = await p1.evaluate(async () => buildCloudBackup());
    const file = path.join(SHOTS, `restore-audit-backup-${process.pid}.json`);
    fs.writeFileSync(file, JSON.stringify(backup));
    ok(backup && backup.format === 'cccc-backup', `backup made in the Back Office (${(fs.statSync(file).size / 1024).toFixed(0)} KB)`);
    const inFile = Object.keys(backup.data);
    await ctx1.close();

    // ---- 2. new empty shop on an empty database, import the file
    psql(DST, `insert into auth.users (email, encrypted_password, raw_user_meta_data) values
                ('restore@example.com', extensions.crypt('secret123', extensions.gen_salt('bf')), '{"business_name":"Restored shop","admin_name":"Zed"}')`);
    execFileSync(path.join(REPO, 'tests', 'restart_fake.sh'), [PORT, DST], {encoding: 'utf8'});
    const ctx2 = await browser.newContext({viewport: {width: 1280, height: 900}, timezoneId: 'Asia/Manila'});
    const p2 = await ctx2.newPage();
    const errs2 = []; p2.on('pageerror', e => errs2.push(String(e)));
    await boLogin(p2, 'restore@example.com', 'secret123');
    const res = await p2.evaluate(async (b) => {
      // includeSettings = the "also bring back the settings" tick in the import screen
      try{ const r = await runImport(b, {includeSettings: true}); return {imported: r.imported, already: r.already, notes: r.notes, leftOut: (r.leftOut || []).length}; }
      catch(e){ return {error: String(e && e.message || e)}; }
    }, backup);
    ok(res && !res.error, 'import of the backup into the new empty shop finished', res);
    console.log('# import result: ' + JSON.stringify(res).slice(0, 600));
    await ctx2.close();
    const after = snapshot(DST, 'restore@example.com');

    // ---- 3. compare
    const designOnly = {devices: 'counters are paired again', stores: 'made by the new shop', stock_counts: 'backup-only (D5)', stock_count_lines: 'backup-only (D5)',
      partner_debts: 'backup-only (D5)', partner_debt_lines: 'backup-only (D5)', partner_settlements: 'backup-only (D5)', sync_operations: 'upload log', staff_sessions: 'logins',
      auth_attempts: 'logins', device_pairing_codes: 'logins', customer_devices: 'QR phone logins (customers relink by number)', qr_order_counters: 'daily counter',
      pin_lock_events: 'alerts', start_fresh_runs: 'history', reconciliation_issues: 'checks', settings: 'compared below', profiles: 'logins', stock_line_owners: 'internal'};
    const missing = [];
    for(const t of Object.keys(before.counts)){
      const a = before.counts[t], b = after.counts[t] || 0;
      if(designOnly[t]){ if(a !== b) console.log(`#   ${t}: ${a} -> ${b} (not restored by design: ${designOnly[t]})`); continue; }
      // the new shop's own sign-up rows (owner staff row, "Takeaway / Counter" table) come on top
      const extra = t === 'staff' || t === 'dining_tables' ? 1 : 0;
      if(b < a) missing.push(`${t}: ${a} -> ${b}${inFile.includes(t) ? '' : ' (NOT IN THE BACKUP FILE)'}`);
      else if(b > a + extra) console.log(`#   ${t}: ${a} -> ${b} (more after restore)`);
    }
    ok(missing.length === 0, 'every business table comes back with all its rows', missing.join('; '));
    for(const k of ['sales_total', 'sales_completed', 'payments_total', 'refunds_total', 'cash_moves', 'expenses', 'invested', 'startup', 'senior_records']){
      ok(Number(before.money[k]) === Number(after.money[k]), `money / records match after restore: ${k} = ${before.money[k]}`, `${before.money[k]} -> ${after.money[k]}`);
    }
    const stockDiff = Object.keys(before.stock).filter(n => before.stock[n] !== after.stock[n]).map(n => `${n}: ${before.stock[n]} -> ${after.stock[n]}`);
    ok(stockDiff.length === 0, `stock per ingredient matches after restore (${Object.keys(before.stock).length} ingredients)`, stockDiff.join('; '));
    const setDiff = Object.keys(before.settings).filter(k => k !== 'business_name' && JSON.stringify(before.settings[k]) !== JSON.stringify(after.settings[k]));
    ok(setDiff.length === 0, 'shop settings (tax, service charge, payment methods, profit split, loyalty, Senior/PWD %) come back', setDiff.map(k => `${k}: ${JSON.stringify(before.settings[k])} -> ${JSON.stringify(after.settings[k])}`).join('; '));
    ok(Number(after.money.staff_pins) === 0, 'staff PINs are NOT in a backup (by design): after a restore the owner sets every PIN again', after.money.staff_pins);
    ok(errs1.length === 0 && errs2.length === 0, 'no page errors in either Back Office', errs1.concat(errs2).join(' | '));
  }catch(e){ abort('bo_restore_audit', e); }
  finally{
    await browser.close();
    try{ execFileSync(path.join(REPO, 'tests', 'restart_fake.sh'), [PORT, SRC], {encoding: 'utf8'}); }catch(e){}
  }
  process.exit(summary('bo_restore_audit.e2e'));
})();
