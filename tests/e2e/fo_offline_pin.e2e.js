// Offline PIN safety on the counter, adopted from hand_offline_pin.js: a PIN that fits two cashiers' offline copies is
//   refused (PIN_AMBIGUOUS wording), 5 wrong tries lock the pad for 5 minutes (then 15), the lock survives a reload,
//   a right PIN after the lock signs in and resets the count.
// Needs a fresh seed:  tests/e2e_reset.sh [db] && tests/restart_fake.sh [port] [db]
// Run:                 FAKE_PORT=8787 FAKE_DB=cccc node tests/e2e/fo_offline_pin.e2e.js
const H = require('./lib/h');
const { chromium } = require(H.PLAYWRIGHT);
const {sql, ok, must, until, typePin} = H;
const CATHY = '66666666-0000-0000-0000-000000000001', CARL = '66666666-0000-0000-0000-000000000003';
(async () => {
  sql(`insert into staff(id, business_id, name, role) select '${CARL}', business_id, 'Carl Cashier', 'CASHIER' from staff where id='${CATHY}'`);
  sql(`insert into staff_pins(staff_id, pin_hash) values ('${CARL}', extensions.crypt('3333', extensions.gen_salt('bf', 8)))`);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({viewport: {width: 1280, height: 860}, timezoneId: 'Asia/Manila', serviceWorkers: 'block'});
  const page = await ctx.newPage();
  const errors = []; H.attach(page, errors, 'FO');
  const block = (r) => r.abort('internetdisconnected');
  const goOffline = async () => { await ctx.route(/\/(rest|auth)\/v1\//, block); await page.evaluate(() => cloud.select('qr_orders', {limit: 1}).catch(() => {})); };
  const pinErr = async () => (await page.textContent('#pin-error')).trim();
  const tryPin = async (pin) => { await typePin(page, pin); await until(async () => !/Checking/.test(await pinErr()), 8000); return pinErr(); };
  try{
    await H.pairCounter(page, 'TESTAB');
    await typePin(page, '1111'); await page.waitForSelector('#ss-opening-cash');       // Cathy online -> copy saved
    await page.click('#lock-btn'); await page.waitForSelector('#pin-gate', {state: 'visible'});
    await typePin(page, '3333'); await page.waitForSelector('#ss-opening-cash');       // Carl online -> copy saved
    await page.click('#lock-btn'); await page.waitForSelector('#pin-gate', {state: 'visible'});
    ok(await until(async () => (await page.evaluate(async () => ((await LocalDB.get('fo.pinVerifiers')) || []).length)) === 2, 8000), 'two cashier PIN copies saved');
    // make Carl's saved copy fit PIN 1111 as well (the owner can end up here with an imported old PIN)
    await page.evaluate(async (carl) => {
      const l = (await LocalDB.get('fo.pinVerifiers')) || [];
      const v = l.find(x => x.staff_id === carl); v.hash = await pbkdf2Hex('1111', carl + ':' + deviceKey());
      await LocalDB.set('fo.pinVerifiers', l);
    }, CARL);
    await goOffline();
    // ---- ambiguous PIN
    let msg = await tryPin('1111');
    ok(/Two staff members share this PIN/.test(msg), 'offline: a PIN that fits two cashiers is refused with the plain message', msg);
    ok(!(await page.isVisible('#app')), 'nobody was signed in');
    ok(await page.evaluate(() => localStorage.getItem('cccc.offlinePin.lock')) === null, 'an ambiguous PIN does not count as a wrong try');
    // ---- Carl's real PIN no longer fits his copy (we replaced it) -> counts as wrong; 4 tries so far -> then 5th locks
    const msgs = [];
    for(let i = 0; i < 4; i++) msgs.push(await tryPin('9999'));
    ok(/Incorrect PIN/.test(msgs[0]) && /4 tries left/.test(msgs[0]), 'first wrong try: "4 tries left"', msgs[0]);
    ok(/1 try left/.test(msgs[3]), 'fourth wrong try: "1 try left"', msgs[3]);
    msg = await tryPin('9999');
    ok(/paused until \d+:\d\d (AM|PM) \(about [45] minutes\)/.test(msg) && /Too many wrong PINs while offline/.test(msg), '5th wrong try locks the pad and says until when', msg);
    let lock = await page.evaluate(() => JSON.parse(localStorage.getItem('cccc.offlinePin.lock')));
    const mins = (lock.until - Date.now()) / 60000;
    ok(mins > 4.5 && mins <= 5.01 && lock.locks === 1 && lock.fails === 0, 'locked for 5 minutes (first lockout)', lock);
    // right PIN while locked is still refused
    msg = await tryPin('3333');
    ok(/paused until/.test(msg) && !(await page.isVisible('#app')), 'a right PIN is refused while the pad is locked');
    ok(!/Back Office → Devices/.test(msg), 'the offline lock text does not promise an owner unlock that does not exist');
    // reload (still offline): the lock stays and is shown straight away
    await page.reload();
    await page.waitForSelector('#pin-gate', {state: 'visible', timeout: 20000});
    ok(await until(async () => /paused until/.test(await pinErr()), 5000), 'after a reload the pad still says it is paused (stored locally)', await pinErr());
    lock = await page.evaluate(() => JSON.parse(localStorage.getItem('cccc.offlinePin.lock')));
    ok(lock.locks === 1 && lock.until > Date.now(), 'lock survived the reload', lock);
    // time passes: lock over -> a wrong try counts again, a second lockout is longer
    await page.evaluate(() => { const l = JSON.parse(localStorage.getItem('cccc.offlinePin.lock')); l.until = Date.now() - 1000; localStorage.setItem('cccc.offlinePin.lock', JSON.stringify(l)); });
    for(let i = 0; i < 4; i++) await tryPin('9999');
    msg = await tryPin('9999');
    lock = await page.evaluate(() => JSON.parse(localStorage.getItem('cccc.offlinePin.lock')));
    ok(lock.locks === 2 && (lock.until - Date.now()) / 60000 > 14 && (lock.until - Date.now()) / 60000 <= 15.01, 'second lockout is 15 minutes', lock);
    // a right PIN (Cathy's, whose copy is still her own PIN?  her copy is 1111 -> ambiguous), so use Carl after fixing the planted copy
    await page.evaluate(async (carl) => {
      const l = (await LocalDB.get('fo.pinVerifiers')) || []; const v = l.find(x => x.staff_id === carl);
      v.hash = await pbkdf2Hex('3333', carl + ':' + deviceKey()); await LocalDB.set('fo.pinVerifiers', l);
      const k = JSON.parse(localStorage.getItem('cccc.offlinePin.lock')); k.until = Date.now() - 1000; localStorage.setItem('cccc.offlinePin.lock', JSON.stringify(k));
    }, CARL);
    await tryPin('3333');
    ok(await until(async () => await page.isVisible('#app'), 8000), 'after the lock ends a right PIN signs in offline');
    ok(await page.evaluate(() => localStorage.getItem('cccc.offlinePin.lock')) === null, 'a right PIN starts the count again');
    ok(errors.length === 0, 'no browser errors', errors.join(' | '));
  }catch(e){ console.log('STOPPED', e.message); await H.shot(page, 'hand-offline-pin'); ok(false, 'stopped: ' + e.message); }
  await browser.close();
  process.exit(H.summary('fo_offline_pin.e2e'));
})();
