// Builds two small FAKE costing workbooks in the owner's layout (no real data), with cached formula values.
const H = require('../e2e/lib/h.js');   // needs a stand-in running on FAKE_PORT (tests/restart_fake.sh)
const { chromium } = require(H.PLAYWRIGHT);
const fs = require('fs');
const OUT = require('path').join(__dirname, '/');   // writes next to this file (tests/fixtures/)
(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  await page.goto(H.BASE + '/cccc/back/');
  await page.waitForFunction(() => typeof writeXlsx === 'function');
  const files = await page.evaluate(async () => {
    const JSZip = await loadJSZip();
    // costing sheet: lines [item, pack, price, qty, amount?]; amount = formula D/C*E when pack given
    function sheet(stale, lines, tail, extra){
      const rows = [[], ['menu name', stale], [], ['Ingredients'], [null, 'item', 'UOM', 'Unit price', 'quantity', 'Amount']];
      const first = 6;
      lines.forEach(l => {
        const r = rows.length + 1;
        if(l === null){ rows.push([]); return; }
        const [item, pack, price, qty, amount] = l;
        if(pack != null && price != null && qty != null) rows.push([null, item, pack, price, qty, {f: `D${r}/C${r}*E${r}`, v: price / pack * qty}]);
        else rows.push([null, item, pack, price, qty, amount]);
      });
      const last = rows.length;
      const sum = rows.slice(first - 1, last).reduce((t, r) => t + (r[5] == null ? 0 : (typeof r[5] === 'object' ? r[5].v : r[5])), 0);
      (tail || []).forEach(t => {
        if(t[0] === 'total cost') rows.push([null, 'total cost', null, null, null, {f: `SUM(F${first}:F${last})`, v: sum}]);
        else if(t[0] === 'yield') rows.push([null, 'yield', null, null, t[1]]);
        else if(t[0] === 'mark up') rows.push([null, 'mark up ', null, null, null, t[1]]);
        else rows.push([null, t[0], null, null, null, t[1]]);
      });
      (extra || []).forEach(([r, c, v]) => { while(rows.length < r) rows.push([]); rows[r - 1] = rows[r - 1] || []; rows[r - 1][c - 1] = v; });
      return rows;
    }
    // Every name and number below is MADE UP (round test values). Only the STRUCTURE copies the owner's layout:
    // a menu item with a side table, a house-made sauce, a batch item with a duplicated line, a bottled item
    // (bottle line after the total), a sheet with a second block, an empty sheet, a notes sheet, and the
    // same house-made name in both files.
    const cafe = [
      {name: 'Test Mocha', rows: sheet('Old Copy', [['test sauce', 1000, 100, 40], ['double shot', 1000, 500, 20], ['milk', 1000, 100, 200], null, ['ice', null, null, null, 5], ['take out cup', null, null, null, 10], ['vanilla']],
        [['total cost'], ['mark up', 1], ['selling price', 123]], [[5, 9, 'item'], [5, 10, 'UOM'], [5, 11, 'Unit price'], [5, 12, 'quantity'], [5, 13, 'Amount'], [6, 9, 'topping x'], [6, 10, 1000], [6, 11, 100], [6, 12, 10]])},
      {name: 'Test Sauce', rows: sheet('Old Copy', [['cocoa powder', 1000, 300, 200], ['sugar', 1000, 100, 500], ['salt', null, null, null, 5], ['milk', 1000, 100, 300]], [['yield', 1000], ['total cost']])},
      {name: 'Test Roll', rows: sheet('Old Copy', [['flour', 1000, 100, 500], ['eggs', 1, 10, 2], ['brand x butter', 500, 200, 50], ['brand x butter', 500, 200, 40], ['spice x', null, null, null, 4]], [['yield', 8], ['total cost']])},
      {name: 'Test Bottled Brew', rows: sheet('Old Copy', [['brew concentrate', 1000, 200, 100], ['water', 1000, 10, 100]], [['yield', 200], ['total cost'], ['bottle', 25]])},
      {name: 'Test Cookie Drink', rows: (() => { const r = sheet('Old Copy', [['double shot', 1000, 500, 20], ['milk', 1000, 100, 200]], [['total cost'], ['selling price', null]]);
        while(r.length < 23) r.push([]);
        r.push([null, 'item', 'UOM', 'Unit price', 'quantity', 'Amount'], [null, 'double shot', 1000, 500, 10, {f: 'D25/C25*E25', v: 5}], [null, 'selling price', null, null, null, 150]); return r; })()},
      {name: 'Sheet1', rows: []},
      {name: 'Notes', rows: [['Made-up prices for tests']]},
    ];
    const pastry = [
      {name: 'Test Cookies', rows: sheet('test cookies', [['all purpose flour', 1000, 100, 300], ['baking soda', null, null, null, 2], ['eggs', 1, 10, 2], ['chocolate x', 1000, 300, 200]], [['yield', 20], ['total cost']])},
      {name: 'Test Sauce', rows: sheet('Test Sauce', [['cocoa powder', 1000, 300, 200], ['sugar', 1000, 100, 500]], [['yield', 900], ['total cost']])},
    ];
    const b64 = async (blob) => { const buf = new Uint8Array(await blob.arrayBuffer()); let s = ''; buf.forEach(c => s += String.fromCharCode(c)); return btoa(s); };
    return {cafe: await b64(await writeXlsx(JSZip, cafe)), pastry: await b64(await writeXlsx(JSZip, pastry))};
  });
  fs.writeFileSync(OUT + 'demo_cafe_costing.xlsx', Buffer.from(files.cafe, 'base64'));
  fs.writeFileSync(OUT + 'demo_pastry_costing.xlsx', Buffer.from(files.pastry, 'base64'));
  await browser.close();
  console.log('written');
})();
