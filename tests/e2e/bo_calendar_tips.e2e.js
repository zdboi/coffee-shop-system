// Back Office calendar, day view: the hover label of the "Sales by hour" chart must sit over the hour
// it describes (a screenshot showed the 7–8am label over the 8am bar). Checked at 1280 and 768 px.
// Sales are seeded on a fixed day (Mon 5 Oct 2026, Manila) at 7:30, 8:15, 8:45 and 13:10.
// For every hour slot the pointer is moved to the left quarter, the middle and the right quarter of
// the slot; the label must name that hour, and its middle must lie inside that hour's slot (so it is
// over that hour's bar, not the next one).
// Needs a fresh seed:  tests/e2e_reset.sh [db] && tests/restart_fake.sh [port] [db]
// Run:                 FAKE_PORT=8787 FAKE_DB=cccc node tests/e2e/bo_calendar_tips.e2e.js
const H = require('./lib/h');
const B = require('./bo/bo_helpers');
const { chromium } = require(H.PLAYWRIGHT);
const {sql, ok} = H;
const NAME = 'bo_calendar_tips.e2e';
const DAY = '2026-10-05';

(async () => {
  const biz = sql(`select business_id from profiles where id='00000000-0000-0000-0000-0000000000a1'`);
  const at = [['07:30', 150], ['08:15', 110], ['08:45', 65], ['13:10', 200]];
  at.forEach(([t, amt], i) => {
    sql(`insert into sales(id, business_id, transaction_number, transaction_date, status, cashier_name, subtotal, discount_amount, tax_amount, service_charge_amount, grand_total, source)
         values (gen_random_uuid(), '${biz}', 'POS-T-2026-00000${i + 1}', '${DAY} ${t}:00+08', 'COMPLETED', 'Cathy Cashier', ${amt}, 0, 0, 0, ${amt}, 'COUNTER')`);
  });
  const browser = await chromium.launch();
  const errors = [];
  for(const vp of [{width: 1280, height: 900}, {width: 768, height: 1024}]){
    const ctx = await browser.newContext({viewport: vp, timezoneId: 'Asia/Manila'});
    const page = await ctx.newPage(); H.attach(page, errors, 'BO' + vp.width);
    await H.boLogin(page);
    await B.go(page, 'calendar');
    await page.evaluate((d) => { CAL.anchor = d; CAL.view = 'day'; return renderCalendar(); }, DAY);
    await page.waitForSelector('.cal-svg .cal-hit');
    const card = page.locator('.cal-card', {has: page.locator('h3', {hasText: 'Sales by hour'})});
    await card.scrollIntoViewIfNeeded();
    const slots = await card.locator('.cal-hit').evaluateAll(ns => ns.map(n => { const r = n.getBoundingClientRect(); return {left: r.left, right: r.right, top: r.top, bottom: r.bottom, label: (n.getAttribute('aria-label') || '').split(':')[0]}; }));
    ok(slots.length >= 14 && /7am–8am/.test(slots[0].label), `${vp.width}px: hourly chart has a slot per hour from 7am (${slots.length} slots)`, slots.map(s => s.label).join(', '));
    const bad = [];
    let checked = 0;
    for(const s of slots){
      const y = s.top + (s.bottom - s.top) * 0.6;
      for(const f of [0.25, 0.5, 0.75]){
        const x = s.left + (s.right - s.left) * f;
        await page.mouse.move(x, y);
        await page.waitForTimeout(30);
        const tip = await page.evaluate(() => { const t = document.querySelector('.cal-tip'); if(!t || t.style.display === 'none') return null; const r = t.getBoundingClientRect(); return {left: r.left, right: r.right, text: t.textContent}; });
        checked++;
        if(!tip){ bad.push(`${s.label}@${f}: no label`); continue; }
        const mid = (tip.left + tip.right) / 2;
        const names = tip.text.includes(s.label);
        const over = mid >= s.left && mid <= s.right;
        if(!names || !over){
          const under = slots.find(o => mid >= o.left && mid <= o.right);
          bad.push(`${s.label}@${Math.round(f * 100)}%: label "${tip.text.replace(/\s+/g, ' ').slice(0, 40)}" centred at x=${Math.round(mid)} (${under ? 'over ' + under.label : 'outside the chart'}; slot ${Math.round(s.left)}-${Math.round(s.right)})`);
        }
      }
    }
    // the screenshot case: pointer on the 7am bar
    const s7 = slots[0];
    await page.mouse.move(s7.left + (s7.right - s7.left) * 0.75, s7.top + (s7.bottom - s7.top) * 0.6);
    await page.waitForTimeout(50);
    await H.shot(page, `bo-calendar-tip-7am-${vp.width}`);
    ok(bad.length === 0, `${vp.width}px: every hover label sits over the hour it names (${checked} pointer positions, ${bad.length} off)`, bad.slice(0, 6).join(' | ') + (bad.length > 6 ? ` | … ${bad.length - 6} more` : ''));
    const tip7 = await page.evaluate(() => { const r = document.querySelector('.cal-tip').getBoundingClientRect(); return {left: r.left, right: r.right}; });
    const mid7 = (tip7.left + tip7.right) / 2;
    const under7 = slots.find(o => mid7 >= o.left && mid7 <= o.right);
    ok(under7 === s7, `${vp.width}px: pointer on the 7am bar -> the 7–8am label sits over the 7am bar (screenshot case)`, `label centred at x=${Math.round(mid7)}, over ${under7 ? under7.label : 'nothing'}; 7am slot ${Math.round(s7.left)}-${Math.round(s7.right)}`);
    await ctx.close();
  }
  // the owner's laptop on another time zone still sees the shop's (Manila) day and hours
  {
    const ctx = await browser.newContext({viewport: {width: 1280, height: 900}, timezoneId: 'America/Los_Angeles'});
    const page = await ctx.newPage(); H.attach(page, errors, 'BO-LA');
    await H.boLogin(page);
    await B.go(page, 'calendar');
    await page.evaluate((d) => { CAL.anchor = d; CAL.view = 'day'; return renderCalendar(); }, DAY);
    await page.waitForSelector('.cal-svg .cal-hit');
    const bars = await page.$$eval('.cal-card .cal-hit', ns => ns.map(n => n.getAttribute('aria-label')));
    const want = ['7am–8am: ₱150.00', '8am–9am: ₱175.00', '1pm–2pm: ₱200.00'];
    ok(want.every(w => bars.includes(w)) && H.money(await B.statValue(page, 'Net sales')) === 525, 'laptop on Los Angeles time: the day and its hours are still Manila\'s (7am ₱150, 8am ₱175, 1pm ₱200; ₱525)', bars.filter(b => !/₱0\.00/.test(b)).join(', '));
    await ctx.close();
  }
  ok(errors.length === 0, 'no browser errors', errors.join(' | '));
  await browser.close();
  process.exit(H.summary(NAME));
})().catch(e => H.abort(NAME, e));
