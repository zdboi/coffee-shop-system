// Release 1.6 counter (browser): checkout with the shop's payment methods + the charge tick (added / waived /
// waived by default), Senior / PWD dialog (name + ID required, a line split, name shown as text), the sale and
// its record on the server, the ID number not left in this browser's storage once uploaded (Z), smart count at
// Close shift. Adopted by Z 2026-11-13 from the counter work's scratch checks (w4/fo16-checks.js, 15 checks).
// Needs a fresh seed:  tests/e2e_reset.sh [db] && tests/restart_fake.sh [port] [db]
// Run:                 FAKE_PORT=8787 FAKE_DB=cccc node tests/e2e/fo16.e2e.js
const path = require('path');
const H = require('./lib/h');
const {chromium} = require(H.PLAYWRIGHT);
const {sql, ok, until, must, typePin} = H;
const SH = H.SHOTS + '/fo16-';
require('fs').mkdirSync(SH, {recursive: true});
const BEANS = '22222222-0000-0000-0000-000000000001', MILK = '22222222-0000-0000-0000-000000000002';
sql(`update settings set service_charge_pct = 0, tax_pct = 0, tax_inclusive = false, senior_discount_pct = 20,
  payment_methods = '[{"id":"CASH","label":"Cash","active":true,"charge_type":"NONE","charge_value":0},
    {"id":"GCASH","label":"GCash","active":true,"reference":true,"charge_type":"PERCENT","charge_value":2,"charge_default":"ADD"},
    {"id":"QR","label":"QR payment","active":true,"reference":true,"charge_type":"NONE","charge_value":0},
    {"id":"CARD","label":"Card","active":true,"reference":true,"charge_type":"FIXED","charge_value":15,"charge_default":"WAIVE"},
    {"id":"BANK","label":"Bank transfer","active":true,"reference":true,"charge_type":"NONE","charge_value":0},
    {"id":"MAYA","label":"Maya","active":false,"charge_type":"NONE","charge_value":0}]'::jsonb`);
sql(`update ingredients set count_at_close = false`);
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({viewport: {width: 1280, height: 860}, timezoneId: 'Asia/Manila'});
  const page = await ctx.newPage();
  const errors = []; H.attach(page, errors, 'FO');
  ctx.on('page', p => { if(p !== page) p.waitForLoadState().then(() => p.close()).catch(() => {}); });
  const modalText = () => page.evaluate(() => { const m = document.getElementById('active-modal-overlay'); return m ? m.innerText : ''; });
  const addLatte = async (n) => { for(let i = 0; i < (n || 1); i++){ await page.click('.pos-product-card:has-text("Americano")'); await page.waitForTimeout(250);
    if(await page.$('#active-modal-overlay')){ const add = await page.$('#active-modal-overlay .btn-primary'); if(add) await add.click(); await page.waitForTimeout(250); } } };
  const lastSale = () => H.one(`select s.*, (select method from payments p where p.sale_id = s.id limit 1) as method from sales s order by created_at desc limit 1`);
  try{
    await page.goto(H.BASE + '/cccc/front/');
    await page.waitForSelector('#su-code');
    await page.fill('#su-code', 'TESTAB'); await page.click('#su-pair');
    await page.waitForSelector('#pin-gate', {state: 'visible'});
    await typePin(page, '1111');
    await H.startShift(page, 1000);
    await page.waitForSelector('.pos-product-card', {timeout: 15000});

    // ---- payment methods from the settings
    await addLatte(1);
    await page.click('#checkout-btn'); await page.waitForSelector('#pay-methods');
    const labels = await page.$$eval('[data-method] span', s => s.map(x => x.textContent));
    ok(JSON.stringify(labels) === JSON.stringify(['Cash', 'GCash', 'QR payment', 'Card', 'Bank transfer']), 'checkout shows the shop\'s active methods in order (Maya off)', labels);
    ok(!(await page.$('#pay-charge-add')), 'cash: no charge line');
    await page.click('[data-method="GCASH"]'); await page.waitForTimeout(200);
    ok(await page.isChecked('#pay-charge-add') && /₱112\.20/.test(await page.textContent('#due-val')), 'GCash 2%: charge line ticked, total 112.20', await page.textContent('#due-val'));
    await page.screenshot({path: SH + 'charge.png'});
    await page.uncheck('#pay-charge-add'); await page.waitForTimeout(150);
    ok(/₱110\.00/.test(await page.textContent('#due-val')) && /Waived/.test(await page.textContent('#pay-charge-note')), 'untick = waived: total back to 110.00');
    await page.click('[data-method="CARD"]'); await page.waitForTimeout(150);
    ok(!(await page.isChecked('#pay-charge-add')) && /₱110\.00/.test(await page.textContent('#due-val')), 'Card ₱15 is waived by default');
    await page.click('[data-method="GCASH"]'); await page.waitForTimeout(150);
    ok(await page.isChecked('#pay-charge-add'), 'back to GCash: added by default again');
    await page.check('#pay-confirmed'); await page.click('#complete-sale-btn');
    await must(() => sql(`select count(*) from sales where payment_fee > 0`) === '1', 'GCash sale uploaded', 20000);
    let s = lastSale();
    ok(Number(s.grand_total) === 112.2 && Number(s.payment_charge) === 2.2 && Number(s.payment_fee) === 2.2 && s.method === 'GCASH' && !s.needs_review, 'GCash sale saved: 112.20 = 110 + 2.20 charge, not flagged', s);
    await page.keyboard.press('Escape').catch(() => {}); await page.waitForTimeout(300);
    if(await page.$('#active-modal-overlay')) await page.click('#active-modal-overlay [data-cancel], #active-modal-overlay [data-close]').catch(() => {});

    // ---- Senior / PWD on 1 of 2 lattes
    await addLatte(2);
    await page.click('#senior-add'); await page.waitForSelector('#sn-save');
    await page.click('#sn-save');
    ok(/Type the name/.test(await page.evaluate(() => [...document.querySelectorAll('.toast')].map(t => t.textContent).join('|'))), 'Senior: name required');
    await page.fill('#sn-name', 'Lola <b>Remedios</b>'); await page.fill('#sn-id', 'SC-0012345');
    await page.check('[data-sn-line]');
    const q = await page.$('[data-sn-qty]'); if(q) await q.fill('1');
    await page.screenshot({path: SH + 'senior-dialog.png'});
    await page.click('#sn-save'); await page.waitForTimeout(300);
    const cartTxt = await page.textContent('#pos-cart-panel');
    ok(/Senior citizen discount \(20%\)/.test(cartTxt) && /-₱22\.00/.test(cartTxt), 'cart shows the Senior discount -22.00', cartTxt.slice(0, 400));
    ok(await page.$$eval('#pos-cart-panel b b', x => x.length) === 0, 'name shown as text');
    await page.screenshot({path: SH + 'senior-cart.png'});
    await page.click('#checkout-btn'); await page.waitForSelector('#pay-methods');
    ok(/₱198\.00/.test(await page.textContent('#due-val')), 'due 198.00 (220 - 22)');
    await page.click('[data-quick]'); await page.click('#complete-sale-btn');
    await must(() => sql(`select count(*) from sales where senior_discount > 0`) === '1', 'Senior sale uploaded', 20000);
    s = lastSale();
    ok(Number(s.grand_total) === 198 && Number(s.senior_discount) === 22 && s.senior_kind === 'SENIOR' && Number(s.senior_items_amount) === 110 && !s.needs_review, 'Senior sale saved, not flagged', s);
    ok(sql(`select holder_name || '|' || id_number from senior_discount_records`) === 'Lola <b>Remedios</b>|SC-0012345', 'record saved with name + ID');
    ok(sql(`select count(*) from sale_items where sale_id = '${s.id}'`) === '2' && sql(`select sum(senior_discount) from sale_items where sale_id = '${s.id}'`) === '22', 'the 2-Americano line was split; 22 on the Senior line');
    // Z: once uploaded, the full ID number is nowhere in this browser's storage (outbox emptied; the receipt copy is in memory only)
    await must(() => sql(`select count(*) from sync_operations where entity_id = '${s.id}'`) === '1', 'Senior sale op recorded', 10000);
    await page.waitForTimeout(1500);
    const stored = await page.evaluate(async () => {
      const hits = [];
      for(let i = 0; i < localStorage.length; i++){ const k = localStorage.key(i); if(String(localStorage.getItem(k)).includes('SC-0012345')) hits.push('localStorage:' + k); }
      for(let i = 0; i < sessionStorage.length; i++){ const k = sessionStorage.key(i); if(String(sessionStorage.getItem(k)).includes('SC-0012345')) hits.push('sessionStorage:' + k); }
      const dbs = indexedDB.databases ? await indexedDB.databases() : [];
      for(const d of dbs){
        const db = await new Promise((res, rej) => { const r = indexedDB.open(d.name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
        for(const st of [...db.objectStoreNames]){
          const all = await new Promise((res) => { const tx = db.transaction(st, 'readonly'); const q = tx.objectStore(st).getAll(); q.onsuccess = () => res(q.result); q.onerror = () => res([]); });
          if(JSON.stringify(all).includes('SC-0012345')) hits.push('indexedDB:' + d.name + '/' + st);
        }
        db.close();
      }
      return hits;
    });
    ok(stored.length === 0, 'Z: after upload the full ID number is in no local / session storage or IndexedDB store', stored);
    await page.keyboard.press('Escape').catch(() => {}); await page.waitForTimeout(300);

    // ---- smart count: tick beans + milk; milk moved (sold), beans counted "recently"
    sql(`update ingredients set count_at_close = true where id in ('${BEANS}', '${MILK}')`);
    await page.reload();
    await page.waitForFunction(() => document.getElementById('app').style.display === 'flex' || document.getElementById('pin-gate').style.display === 'flex', null, {timeout: 20000});
    if(!(await page.isVisible('#app'))){ await typePin(page, '1111'); await page.waitForSelector('#app', {state: 'visible'}); }
    await page.click('.nav-item[data-route="shift"]'); await page.waitForTimeout(500);
    await page.click('#close-shift-btn'); await page.waitForTimeout(1500);
    let txt = await modalText();
    ok(/count before closing/i.test(txt) && /Espresso beans/.test(txt) && /Milk/.test(txt), 'never counted: both asked', txt.slice(0, 300));
    await page.screenshot({path: SH + 'count.png'});
    console.log(`\n${H.failures() ? 'FAIL' : 'PASS'}`);
  }catch(e){ ok(false, 'stopped: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e)); await page.screenshot({path: SH + 'abort.png'}); }
  console.log('errors:', errors.slice(0, 8).join('\n'));
  H.summary('fo16.e2e');
  process.exit(H.failures() ? 1 : 0);
  await browser.close();
})();
