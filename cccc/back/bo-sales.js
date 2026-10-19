/* =====================================================================
   BACK OFFICE — sales: the sales calendar (day / week / month / shift),
   transactions (detail, reprint, refund / void as the owner, "needs
   review"), QR order history and customers.
   Numbers reconcile with the counter: a sale counts unless it is HELD or
   VOIDED (same rule as shiftMetrics); refunds count on the day they were
   made; shift figures come from shiftMetrics() in ../shared/logic.js.
   ===================================================================== */

/* ================= loading sales for a time range ================= */
async function salesForRange(range, force){
  const key = range.from.toISOString() + '|' + range.to.toISOString();
  const hit = BO.salesCache.get(key);
  if(hit && !force && Date.now() - hit.at < 60 * 1000) return hit.data;
  const r = await cloud.rpc('sales_report', {p_from: range.from.toISOString(), p_to: range.to.toISOString()}, {timeout: 60000}) || {};
  const data = {from: range.from, to: range.to,
    sales: r.sales || [], saleItems: r.sale_items || [], payments: r.payments || [], refunds: r.refunds || [],
    shifts: r.shifts || [], cashMovements: r.cash_movements || [], qrOrders: r.qr_orders || []};
  BO.salesCache.set(key, {at: Date.now(), data});
  if(BO.salesCache.size > 30) BO.salesCache.delete(BO.salesCache.keys().next().value);
  return data;
}
const COUNTED = (s) => s.status !== 'HELD' && s.status !== 'VOIDED';
function inRange(t, from, to){ const x = new Date(t).getTime(); return x >= from.getTime() && x < to.getTime(); }
function salesIn(ds, from, to){ return ds.sales.filter(s => COUNTED(s) && inRange(s.transaction_date, from || ds.from, to || ds.to)); }
function refundsIn(ds, from, to){ return ds.refunds.filter(r => r.type !== 'VOID' && inRange(r.date, from || ds.from, to || ds.to)); }
function payMethod(ds, saleId){ const p = ds.payments.find(x => x.sale_id === saleId); return p ? p.method : null; }
function payLabel(m){ const p = PAYMENT_METHODS.find(x => x.id === m); return p ? p.label : (m || '—'); }
// Totals for a set of counted sales (+ the refunds made in the same period).
function salesSummary(ds, sales, refunds){
  refunds = refunds || refundsIn(ds);
  const gross = sales.reduce((s, x) => s + num(x.grand_total), 0);
  const ref = refunds.reduce((s, r) => s + num(r.amount), 0);
  const ids = new Set(sales.map(s => s.id));
  const items = ds.saleItems.filter(i => ids.has(i.sale_id)).reduce((s, i) => s + num(i.quantity), 0);
  return {gross, refunds: ref, net: gross - ref, count: sales.length, avg: sales.length ? gross / sales.length : 0, items,
    qr: sales.filter(s => s.source === 'QR' || s.qr_order_id).length,
    discounts: sales.reduce((s, x) => s + num(x.discount_amount), 0)};
}

/* ================= tooltips (shared by the charts) =================
   Text is set with textContent, never as HTML. */
let calTipEl = null;
let CAL_TIPS = [];
function calTipAdd(value, lines){ CAL_TIPS.push({value, lines: lines || []}); return CAL_TIPS.length - 1; }
// The label is centred on the bar / cell it describes (not on the pointer), so it always sits over the
// hour or day it names. Near the edges it is nudged inside the chart's card; if that would move it off
// its own bar, it stays on its bar and is only kept inside the window.
function calTip(i, ev, anchor){
  if(i == null || !CAL_TIPS[i]){ if(calTipEl) calTipEl.style.display = 'none'; return; }
  if(!calTipEl){ calTipEl = document.createElement('div'); calTipEl.className = 'cal-tip'; calTipEl.setAttribute('role', 'tooltip'); document.body.appendChild(calTipEl); }
  const tip = CAL_TIPS[i];
  calTipEl.textContent = '';
  const v = document.createElement('span'); v.className = 'tv'; v.textContent = tip.value; calTipEl.appendChild(v);
  tip.lines.forEach(l => { const d = document.createElement('div'); d.textContent = l; calTipEl.appendChild(d); });
  calTipEl.style.display = 'block';
  const el = anchor || (ev && ev.currentTarget) || (ev && ev.target);
  const a = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
  const pointer = ev && ev.clientX != null && ev.type !== 'focus';
  const w = calTipEl.offsetWidth, h = calTipEl.offsetHeight;
  const vw = window.innerWidth;
  const cx = a ? a.left + a.width / 2 : (pointer ? ev.clientX : 0);
  let x = cx - w / 2;
  const card = el && el.closest ? el.closest('.cal-card') : null;
  const box = card ? card.getBoundingClientRect() : null;
  if(box){
    const nudged = Math.max(box.left + 4, Math.min(box.right - w - 4, x));
    // keep the nudge only while the label is still over its own bar / cell
    if(!a || (nudged + w / 2 >= a.left && nudged + w / 2 <= a.right)) x = nudged;
  }
  x = Math.max(8, Math.min(vw - w - 8, x));
  let y = pointer ? ev.clientY : (a ? a.top : 0);
  y = y - h - 12 < 8 ? y + 18 : y - h - 12;
  calTipEl.style.left = x + 'px'; calTipEl.style.top = y + 'px';
}
function calWireTips(root){
  root.querySelectorAll('[data-tip]').forEach(n => {
    const i = Number(n.getAttribute('data-tip'));
    const showTip = (ev) => calTip(i, ev, n);
    n.addEventListener('pointermove', showTip);
    n.addEventListener('focus', showTip);
    n.addEventListener('pointerleave', () => calTip(null));
    n.addEventListener('blur', () => calTip(null));
  });
}

/* ================= chart helpers (plain SVG, one series, one hue) ================= */
function calCssVar(name, fallback){ try{ const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); return v || fallback; }catch(e){ return fallback; } }
function calHex(h){ h = String(h).trim().replace('#', ''); if(h.length === 3) h = h.split('').map(c => c + c).join(''); const n = parseInt(h, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function calMix(a, b, t){ const A = calHex(a), B = calHex(b); return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, '0')).join(''); }
function calLum(hex){ const [r, g, b] = calHex(hex).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; }
// Sequential ramp in ONE hue (the shop's secondary colour): more = darker.
function calShade(t){
  const card = calCssVar('--white', '#fffdf9'), hue = calCssVar('--green', '#33513f');
  if(!(t > 0)) return {bg: calMix(card, calCssVar('--beige', '#e9dcc4'), 0.35), fg: calCssVar('--text', '#2c1e14')};
  const bg = calMix(card, hue, 0.12 + 0.78 * Math.min(1, t));
  return {bg, fg: calLum(bg) < 0.32 ? '#ffffff' : calCssVar('--text', '#2c1e14')};
}
function calNiceMax(v){ if(v <= 0) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))); const f = v / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p; }
function calCompact(n){
  n = num(n);
  if(Math.abs(n) >= 1e6) return '₱' + (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if(Math.abs(n) >= 1e4) return '₱' + (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return '₱' + Math.round(n).toLocaleString('en-PH');
}
function calHourLabel(h){ const hh = h % 12 === 0 ? 12 : h % 12; return hh + (h < 12 ? 'am' : 'pm'); }
function calHourRange(hours){
  const used = hours.filter(x => x.count > 0).map(x => x.h);
  let lo = used.length ? Math.min(...used) : 7, hi = used.length ? Math.max(...used) : 20;
  return [Math.min(lo, 7), Math.max(hi, 20)];
}
// Thin columns (<= 24px) with a 4px rounded top, square at the baseline, hairline grid,
// only the peak labelled; every value is in the tooltip AND in the table under the chart.
function calColumns(points, title){
  if(!points.length) return '';
  const W = 760, H = 230, padL = 56, padR = 10, padT = 22, padB = 28;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const max = calNiceMax(Math.max(...points.map(p => p.value), 0));
  const slot = plotW / points.length, barW = Math.min(24, Math.max(4, slot * 0.6));
  const hue = calCssVar('--green', '#33513f'), grid = calCssVar('--beige', '#e9dcc4');
  const peak = points.reduce((a, b) => b.value > a.value ? b : a, points[0]);
  const labelEvery = points.length > 16 ? 2 : 1;
  let svg = `<svg class="cal-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">`;
  [0, max / 2, max].forEach(t => {
    const y = padT + plotH - (t / max) * plotH;
    svg += `<line x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}" stroke="${grid}" stroke-width="1"/><text x="${padL - 8}" y="${y + 4}" text-anchor="end">${esc(calCompact(t))}</text>`;
  });
  points.forEach((p, i) => {
    const cx = padL + slot * i + slot / 2;
    const h = max > 0 ? (p.value / max) * plotH : 0;
    const x = cx - barW / 2, y = padT + plotH - h, r = Math.min(4, h / 2, barW / 2);
    const tip = calTipAdd(fmtMoney(p.value), [p.label].concat(p.sub ? [p.sub] : []));
    svg += `<rect class="cal-hit" x="${padL + slot * i}" y="${padT}" width="${slot}" height="${plotH}" tabindex="0" data-tip="${tip}" ${p.key ? `data-key="${esc(p.key)}"` : ''} aria-label="${esc(p.label + ': ' + fmtMoney(p.value))}"/>`;
    if(h > 0) svg += `<path class="cal-bar" pointer-events="none" fill="${hue}" d="M${x},${padT + plotH} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + barW - r},${y} Q${x + barW},${y} ${x + barW},${y + r} L${x + barW},${padT + plotH} Z"/>`;
    if(i % labelEvery === 0) svg += `<text x="${cx}" y="${H - 9}" text-anchor="middle">${esc(p.short || p.label)}</text>`;
    if(p === peak && p.value > 0) svg += `<text class="cal-val" x="${cx}" y="${y - 6}" text-anchor="middle">${esc(calCompact(p.value))}</text>`;
  });
  svg += `<line x1="${padL}" x2="${W - padR}" y1="${padT + plotH}" y2="${padT + plotH}" stroke="${calMix(grid, calCssVar('--text', '#2c1e14'), 0.25)}" stroke-width="1"/>`;
  return svg + '</svg>';
}
// The table twin of a chart (same numbers, readable without hovering)
function calTableTwin(headers, rows){
  return `<details class="table-twin"><summary>Show these numbers as a table</summary><div class="table-wrap" style="box-shadow:none;"><table>
    <thead><tr>${headers.map((h, i) => `<th${i ? ' class="num"' : ''}>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(r => `<tr>${r.map((c, i) => `<td${i ? ' class="num"' : ''}>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details>`;
}
// "Sales ₱X − refunds ₱Y": the same words as the counter's reports (SALES_LABELS in the shared logic).
function salesMinusRefundsText(sales, refunds){
  return `${SALES_LABELS.sales} ${fmtMoney(sales)} − ${SALES_LABELS.refunds.toLowerCase()} ${fmtMoney(refunds)}`;
}
function calKpis(sum){
  return `<div class="grid grid-4 cal-kpis">
    ${statCard(SALES_LABELS.netSales, fmtMoney(sum.net), sum.refunds > 0 ? salesMinusRefundsText(sum.gross, sum.refunds) : 'no refunds')}
    ${statCard('Transactions', sum.count.toLocaleString('en-PH'), sum.qr ? `${sum.qr} from QR orders` : 'voided sales not counted')}
    ${statCard('Average sale', fmtMoney(sum.avg), sum.discounts > 0 ? `${fmtMoney(sum.discounts)} in discounts` : '')}
    ${statCard('Items sold', sum.items.toLocaleString('en-PH'), '')}
  </div>`;
}

/* ================= Sales calendar ================= */
const CAL = {view: 'month', anchor: null, shiftId: null, lastTable: null};
function calRange(){
  const a = CAL.anchor || shopTodayKey();
  if(CAL.view === 'day') return {fromKey: a, toKey: a, label: keyLabel(a)};
  if(CAL.view === 'week'){
    const start = keyAddDays(a, -keyDow(a)), end = keyAddDays(start, 6);
    return {fromKey: start, toKey: end, label: `${keyLabel(start, {month: 'short', day: 'numeric'})} – ${keyLabel(end, {month: 'short', day: 'numeric', year: 'numeric'})}`};
  }
  const start = keyMonthStart(a), end = keyAddDays(keyAddMonths(start, 1), -1);
  return {fromKey: start, toKey: end, label: keyLabel(start, {month: 'long', year: 'numeric'})};
}
async function renderCalendar(){
  if(!CAL.anchor) CAL.anchor = shopTodayKey();
  const content = document.getElementById('content');
  const range = calRange();
  content.innerHTML = `
    <div class="cal-toolbar">
      <div class="seg" role="tablist" aria-label="Calendar view">${['day', 'week', 'month', 'shift'].map(v => `<button class="seg-btn ${CAL.view === v ? 'active' : ''}" data-view="${v}" role="tab" aria-selected="${CAL.view === v}">${v[0].toUpperCase() + v.slice(1)}</button>`).join('')}</div>
      <div class="cal-nav">
        <button class="btn btn-outline btn-sm" id="cal-prev" aria-label="Previous">◀</button>
        <span class="cal-label">${esc(range.label)}</span>
        <button class="btn btn-outline btn-sm" id="cal-next" aria-label="Next">▶</button>
        <button class="btn btn-ghost btn-sm" id="cal-today">Today</button>
      </div>
      <div class="cal-spacer"></div>
      <button class="btn btn-outline btn-sm" id="cal-export">Export CSV</button>
    </div>
    <div id="cal-body"><div class="cal-empty">Loading sales…</div></div>`;
  content.querySelectorAll('[data-view]').forEach(b => b.onclick = () => { CAL.view = b.dataset.view; renderCalendar(); });
  const step = (dir) => {
    const a = CAL.anchor;
    if(CAL.view === 'day') CAL.anchor = keyAddDays(a, dir);
    else if(CAL.view === 'week') CAL.anchor = keyAddDays(a, 7 * dir);
    else CAL.anchor = keyAddMonths(keyMonthStart(a), dir);
    renderCalendar();
  };
  content.querySelector('#cal-prev').onclick = () => step(-1);
  content.querySelector('#cal-next').onclick = () => step(1);
  content.querySelector('#cal-today').onclick = () => { CAL.anchor = shopTodayKey(); renderCalendar(); };
  content.querySelector('#cal-export').onclick = calExportCSV;
  const body = content.querySelector('#cal-body');
  CAL_TIPS = [];
  let ds;
  try{
    // the shift view also loads a day either side, for shifts that cross midnight
    const r = CAL.view === 'shift' ? dayRange(keyAddDays(range.fromKey, -1), keyAddDays(range.toKey, 1)) : dayRange(range.fromKey, range.toKey);
    ds = await salesForRange(r);
  }catch(e){ body.innerHTML = emptyBlock(esc(friendlyError(e))); return; }
  if(state.route !== 'calendar' || !body.isConnected) return;
  const r = dayRange(range.fromKey, range.toKey);
  if(CAL.view === 'month') calRenderMonth(body, ds, range, r);
  else if(CAL.view === 'week') calRenderWeek(body, ds, range, r);
  else if(CAL.view === 'day') calRenderDay(body, ds, range, r);
  else calRenderShift(body, ds, range, r);
  calWireTips(body);
  body.querySelectorAll('[data-day],[data-key]').forEach(n => n.addEventListener('click', () => { CAL.anchor = n.dataset.day || n.dataset.key; CAL.view = 'day'; calTip(null); renderCalendar(); }));
}
function calByDay(ds, r){
  const byDay = {};
  salesIn(ds, r.from, r.to).forEach(s => { const k = dayKeyOf(s.transaction_date); (byDay[k] = byDay[k] || {gross: 0, count: 0, ref: 0}); byDay[k].gross += num(s.grand_total); byDay[k].count++; });
  refundsIn(ds, r.from, r.to).forEach(x => { const k = dayKeyOf(x.date); (byDay[k] = byDay[k] || {gross: 0, count: 0, ref: 0}); byDay[k].ref += num(x.amount); });
  return byDay;
}
function calRenderMonth(body, ds, range, r){
  const byDay = calByDay(ds, r);
  const sales = salesIn(ds, r.from, r.to), sum = salesSummary(ds, sales, refundsIn(ds, r.from, r.to));
  const max = Math.max(0, ...Object.values(byDay).map(d => d.gross - d.ref));
  const best = Object.entries(byDay).sort((a, b) => (b[1].gross - b[1].ref) - (a[1].gross - a[1].ref))[0];
  const todayKey = shopTodayKey();
  let cells = BO_DOW.map(d => `<div class="cal-dow">${d}</div>`).join('');
  const rows = [];
  let k = keyAddDays(range.fromKey, -keyDow(range.fromKey));
  const lastCell = keyAddDays(range.toKey, 6 - keyDow(range.toKey));
  for(; k <= lastCell; k = keyAddDays(k, 1)){
    const v = byDay[k], inMonth = k >= range.fromKey && k <= range.toKey;
    const net = v ? v.gross - v.ref : 0;
    const sh = calShade(max > 0 ? net / max : 0);
    const dayName = keyLabel(k, {weekday: 'long', month: 'short', day: 'numeric'});
    const tip = v ? calTipAdd(fmtMoney(net), [dayName, plural(v.count, 'transaction')].concat(v.ref ? [fmtMoney(v.ref) + ' refunded'] : [])) : calTipAdd('No sales', [dayName]);
    cells += `<button class="cal-day ${inMonth ? '' : 'out'} ${k === todayKey ? 'today' : ''}" style="background:${sh.bg};color:${sh.fg}" data-day="${k}" data-tip="${tip}" aria-label="${esc(dayName + ': ' + (v ? fmtMoney(net) : 'no sales'))}">
      <span class="d">${Number(k.slice(8))}</span>${v ? `<span><span class="v">${esc(calCompact(net))}</span><br><span class="n">${v.count} sale${v.count === 1 ? '' : 's'}</span></span>` : ''}</button>`;
    if(inMonth) rows.push([k, v ? v.count : 0, (v ? v.gross : 0).toFixed(2), (v ? v.ref : 0).toFixed(2), net.toFixed(2)]);
  }
  CAL.lastTable = {name: 'daily-' + range.fromKey.slice(0, 7), headers: ['Date', 'Transactions', SALES_LABELS.sales, SALES_LABELS.refunds, SALES_LABELS.netSales], rows};
  body.innerHTML = `${calKpis(sum)}
    <div class="card cal-card">
      <h3>Daily sales</h3>
      <div class="cal-sub">${best ? `Best day: ${esc(keyLabel(best[0], {weekday: 'long', month: 'short', day: 'numeric'}))} (${fmtMoney(best[1].gross - best[1].ref)}). ` : ''}Darker = more sales. Tap a day to see it hour by hour.</div>
      <div class="cal-month">${cells}</div>
      <div class="cal-scale">Less ${[0.0001, 0.25, 0.5, 0.75, 1].map(t => `<span class="sw" style="background:${calShade(t).bg}"></span>`).join('')} More</div>
      ${calTableTwin(['Date', 'Transactions', SALES_LABELS.sales, SALES_LABELS.refunds, SALES_LABELS.netSales], rows.filter(x => x[1] || Number(x[3])).map(x => [keyLabel(x[0], {weekday: 'short', month: 'short', day: 'numeric'}), x[1], fmtMoney(x[2]), fmtMoney(x[3]), fmtMoney(x[4])]))}
    </div>`;
}
function calRenderWeek(body, ds, range, r){
  const sales = salesIn(ds, r.from, r.to), refunds = refundsIn(ds, r.from, r.to);
  const sum = salesSummary(ds, sales, refunds);
  const days = Array.from({length: 7}, (_, i) => keyAddDays(range.fromKey, i));
  const points = days.map(k => {
    const s = sales.filter(x => dayKeyOf(x.transaction_date) === k);
    const ref = refunds.filter(x => dayKeyOf(x.date) === k).reduce((a, x) => a + num(x.amount), 0);
    return {key: k, value: s.reduce((a, x) => a + num(x.grand_total), 0) - ref, label: keyLabel(k, {weekday: 'long', month: 'short', day: 'numeric'}), short: keyLabel(k, {weekday: 'short'}), sub: plural(s.length, 'transaction'), count: s.length};
  });
  const grid = {}; let max = 0;
  const hourly = Array.from({length: 24}, (_, h) => ({h, total: 0, count: 0}));
  sales.forEach(s => {
    const k = dayKeyOf(s.transaction_date), h = hourOf(s.transaction_date);
    grid[k + '|' + h] = (grid[k + '|' + h] || 0) + num(s.grand_total);
    max = Math.max(max, grid[k + '|' + h]);
    hourly[h].count++; hourly[h].total += num(s.grand_total);
  });
  const [lo, hi] = calHourRange(hourly);
  const hours = []; for(let h = lo; h <= hi; h++) hours.push(h);
  const rows = [];
  let heat = `<div class="cal-matrix"><table><thead><tr><th></th>${days.map(k => `<th>${esc(keyLabel(k, {weekday: 'short', day: 'numeric'}))}</th>`).join('')}</tr></thead><tbody>`;
  hours.forEach(h => {
    heat += `<tr><th style="text-align:right;">${calHourLabel(h)}</th>`;
    const row = [calHourLabel(h)];
    days.forEach(k => {
      const v = grid[k + '|' + h] || 0, sh = calShade(max > 0 ? v / max : 0);
      const tip = v ? calTipAdd(fmtMoney(v), [`${keyLabel(k, {weekday: 'short', month: 'short', day: 'numeric'})} · ${calHourLabel(h)}–${calHourLabel((h + 1) % 24)}`]) : null;
      heat += `<td class="cell" style="background:${v ? sh.bg : 'transparent'};color:${v ? sh.fg : 'var(--text-light)'}" ${tip != null ? `data-tip="${tip}" tabindex="0"` : ''}>${v ? esc(calCompact(v)) : '·'}</td>`;
      row.push(v.toFixed(2));
    });
    heat += '</tr>'; rows.push(row);
  });
  heat += '</tbody></table></div>';
  CAL.lastTable = {name: 'week-by-hour-' + range.fromKey, headers: ['Hour', ...days], rows};
  body.innerHTML = `${calKpis(sum)}
    <div class="card cal-card"><h3>${esc(SALES_LABELS.netSales)} by day</h3><div class="cal-sub">${esc(SALES_LABELS.netSales)} = ${esc(SALES_LABELS.sales.toLowerCase())} minus ${esc(SALES_LABELS.refunds.toLowerCase())}. Tap a day to see it hour by hour.</div>
      <div class="cal-chart">${calColumns(points, SALES_LABELS.netSales + ' by day')}</div>
      ${calTableTwin(['Day', 'Transactions', SALES_LABELS.netSales], points.map(p => [p.label, p.count, fmtMoney(p.value)]))}</div>
    <div class="card cal-card"><h3>Busiest hours this week</h3><div class="cal-sub">Sales by hour and day. Darker = busier — useful for planning staff.</div>${sales.length ? heat : '<div class="cal-empty">No sales this week.</div>'}</div>`;
}
function calItemMatrix(ds, sales){
  const saleHour = new Map(sales.map(s => [s.id, hourOf(s.transaction_date)]));
  const rows = new Map();
  ds.saleItems.forEach(i => {
    if(!saleHour.has(i.sale_id)) return;
    const h = saleHour.get(i.sale_id);
    const r = rows.get(i.name) || {name: i.name, total: 0, revenue: 0, hours: {}};
    r.total += num(i.quantity); r.revenue += num(i.line_total);
    r.hours[h] = (r.hours[h] || 0) + num(i.quantity);
    rows.set(i.name, r);
  });
  return [...rows.values()].sort((a, b) => b.total - a.total);
}
function calMatrixHtml(rows, hours){
  if(!rows.length) return '<div class="cal-empty">No items sold in this period.</div>';
  const limit = 40;
  const max = Math.max(1, ...rows.flatMap(r => hours.map(h => r.hours[h] || 0)));
  const colTotals = hours.map(h => rows.reduce((s, r) => s + (r.hours[h] || 0), 0));
  let html = `<div class="cal-matrix"><table><thead><tr><th style="text-align:left;">Item</th>${hours.map(h => `<th>${calHourLabel(h)}</th>`).join('')}<th>Total</th></tr></thead><tbody>`;
  rows.slice(0, limit).forEach(r => {
    html += `<tr><td class="name" title="${esc(r.name)}">${esc(r.name)}</td>`;
    hours.forEach(h => {
      const v = r.hours[h] || 0, sh = calShade(v / max);
      const tip = v ? calTipAdd(`${fmtNum(v, 0)} sold`, [`${r.name} · ${calHourLabel(h)}–${calHourLabel((h + 1) % 24)}`]) : null;
      html += `<td class="cell" style="background:${v ? sh.bg : 'transparent'};color:${v ? sh.fg : 'var(--text-light)'}" ${tip != null ? `data-tip="${tip}" tabindex="0"` : ''}>${v ? fmtNum(v, 0) : '·'}</td>`;
    });
    html += `<td class="tot">${fmtNum(r.total, 0)}</td></tr>`;
  });
  html += `<tr><td class="name">All items</td>${colTotals.map(v => `<td class="tot">${v ? fmtNum(v, 0) : '·'}</td>`).join('')}<td class="tot">${fmtNum(colTotals.reduce((a, b) => a + b, 0), 0)}</td></tr></tbody></table></div>`;
  if(rows.length > limit) html += `<div class="cal-sub" style="margin-top:6px;">Showing the top ${limit} of ${rows.length} items. The CSV export has all of them.</div>`;
  return html;
}
function calDayDetail(ds, sales, refunds, nameSuffix){
  const sum = salesSummary(ds, sales, refunds);
  const byHour = Array.from({length: 24}, (_, h) => ({h, total: 0, count: 0}));
  sales.forEach(s => { const h = hourOf(s.transaction_date); byHour[h].total += num(s.grand_total); byHour[h].count++; });
  const [lo, hi] = calHourRange(byHour);
  const hours = []; for(let h = lo; h <= hi; h++) hours.push(h);
  const points = hours.map(h => ({value: byHour[h].total, label: `${calHourLabel(h)}–${calHourLabel((h + 1) % 24)}`, short: calHourLabel(h), sub: plural(byHour[h].count, 'transaction'), count: byHour[h].count}));
  const matrix = calItemMatrix(ds, sales);
  const pay = {};
  sales.forEach(s => { const m = payMethod(ds, s.id) || '—'; pay[m] = pay[m] || {n: 0, total: 0}; pay[m].n++; pay[m].total += num(s.grand_total); });
  const peak = byHour.reduce((a, b) => b.total > a.total ? b : a, byHour[0]);
  CAL.lastTable = {name: 'items-by-hour' + (nameSuffix || ''), headers: ['Item', ...hours.map(calHourLabel), 'Total qty', 'Revenue'],
    rows: matrix.map(r => [r.name, ...hours.map(h => r.hours[h] || 0), r.total, r.revenue.toFixed(2)])};
  return `${calKpis(sum)}
    <div class="card cal-card"><h3>Sales by hour</h3><div class="cal-sub">${peak.total > 0 ? `Busiest hour: ${calHourLabel(peak.h)}–${calHourLabel((peak.h + 1) % 24)} (${fmtMoney(peak.total)}, ${plural(peak.count, 'transaction')}).` : 'No sales yet.'} The chart shows ${esc(SALES_LABELS.sales)}: ${esc(SALES_HINTS.sales.charAt(0).toLowerCase() + SALES_HINTS.sales.slice(1))}</div>
      <div class="cal-chart">${calColumns(points, 'Sales by hour')}</div>
      ${calTableTwin(['Hour', 'Transactions', 'Sales'], points.filter(p => p.count).map(p => [p.label, p.count, fmtMoney(p.value)]))}</div>
    <div class="card cal-card"><h3>Items by hour</h3><div class="cal-sub">How many of each item sold in each hour (refunds are not taken off).</div>${calMatrixHtml(matrix, hours)}</div>
    <div class="card cal-card"><h3>Payment methods</h3>${Object.keys(pay).length ? `<div class="table-wrap" style="box-shadow:none;"><table><thead><tr><th>Method</th><th class="num">Transactions</th><th class="num">Total</th></tr></thead><tbody>${Object.entries(pay).sort((a, b) => b[1].total - a[1].total).map(([m, v]) => `<tr><td>${esc(payLabel(m))}</td><td class="num">${v.n}</td><td class="num">${fmtMoney(v.total)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="cal-empty">No payments.</div>'}</div>`;
}
function calRenderDay(body, ds, range, r){
  const sales = salesIn(ds, r.from, r.to), refunds = refundsIn(ds, r.from, r.to);
  const shifts = ds.shifts.filter(s => inRange(s.opened_at, r.from, r.to)).sort((a, b) => String(a.opened_at).localeCompare(String(b.opened_at)));
  body.innerHTML = calDayDetail(ds, sales, refunds, '-' + range.fromKey) + (shifts.length ? `
    <div class="card cal-card"><h3>Shifts that day</h3><div class="table-wrap" style="box-shadow:none;"><table><thead><tr><th>Shift</th><th>Cashier</th><th>Opened</th><th>Closed</th><th class="num">${esc(SALES_LABELS.netSales)}</th><th class="num">Cash over / short</th><th></th></tr></thead><tbody>
      ${shifts.map(s => { const m = shiftMetrics(s, ds); return `<tr><td>${esc(s.shift_number || '')}</td><td>${esc(s.cashier_name || '')}</td><td>${fmtShopTime(s.opened_at)}</td><td>${s.closed_at ? fmtShopTime(s.closed_at) : '<span class="badge badge-green">Open</span>'}</td><td class="num">${fmtMoney(m.netSales)}</td><td class="num">${s.status === 'CLOSED' ? (num(s.cash_variance) >= 0 ? '+' : '') + fmtMoney(s.cash_variance) : '—'}</td><td><button class="btn btn-ghost btn-sm" data-open-shift="${esc(s.id)}">View</button></td></tr>`; }).join('')}
    </tbody></table></div></div>` : '');
  body.querySelectorAll('[data-open-shift]').forEach(b => b.onclick = () => { CAL.shiftId = b.dataset.openShift; CAL.view = 'shift'; renderCalendar(); });
}
function calRenderShift(body, ds, range, r){
  const shifts = ds.shifts.filter(s => inRange(s.opened_at, r.from, r.to) || s.id === CAL.shiftId).sort((a, b) => String(b.opened_at).localeCompare(String(a.opened_at)));
  if(!shifts.length){ body.innerHTML = `<div class="card"><div class="cal-empty">No shifts in ${esc(range.label)}. Use ◀ ▶ to pick another month.</div></div>`; CAL.lastTable = null; return; }
  const shift = shifts.find(s => s.id === CAL.shiftId) || shifts[0];
  CAL.shiftId = shift.id;
  const m = shiftMetrics(shift, ds);            // same maths as the counter's shift report
  const closed = shift.status === 'CLOSED';
  const expected = closed && shift.expected_cash != null ? num(shift.expected_cash) : m.expectedCash;
  const lateDiff = closed && shift.expected_cash != null ? m.expectedCash - num(shift.expected_cash) : 0;
  const sales = ds.sales.filter(s => s.shift_id === shift.id && COUNTED(s));
  const refunds = ds.refunds.filter(x => x.shift_id === shift.id && x.type !== 'VOID');
  body.innerHTML = `
    <div class="toolbar" style="margin-bottom:12px;"><div class="toolbar-left">
      <select class="filter" id="cal-shift-pick" aria-label="Choose a shift">${shifts.map(s => `<option value="${esc(s.id)}" ${s.id === shift.id ? 'selected' : ''}>${esc(s.shift_number || 'Shift')} · ${esc(s.cashier_name || '')} · ${fmtShopDate(s.opened_at)}${s.status === 'ACTIVE' ? ' (open)' : ''}</option>`).join('')}</select>
      <button class="btn btn-outline btn-sm" id="cal-shift-print">🖨 Print shift report</button>
    </div></div>
    <div class="grid grid-4 cal-kpis">
      ${statCard('Opened', esc(fmtShopDateTime(shift.opened_at)), shift.closed_at ? 'closed ' + esc(fmtShopTime(shift.closed_at)) + (shift.closed_by_name && shift.closed_by_name !== shift.cashier_name ? ' by ' + esc(shift.closed_by_name) : '') : 'still open')}
      ${statCard('Expected cash', fmtMoney(expected), `opening ${fmtMoney(m.openingCash)} · pay in ${fmtMoney(m.payIns)} · pay out ${fmtMoney(m.payOuts)}`)}
      ${statCard('Counted cash', closed ? fmtMoney(shift.declared_cash) : '—', closed ? '' : 'shift still open')}
      ${statCard('Cash over / short', closed ? (num(shift.cash_variance) >= 0 ? '+' : '') + fmtMoney(shift.cash_variance) : '—', closed ? (Math.abs(num(shift.cash_variance)) < 0.005 ? 'balanced' : (num(shift.cash_variance) > 0 ? 'over' : 'short')) : '')}
    </div>
    ${Math.abs(lateDiff) > 0.009 ? `<div class="notice warn">Sales or refunds uploaded after this shift closed change its expected cash by ${fmtMoney(lateDiff)} (now ${fmtMoney(m.expectedCash)}). The figures above are what the cashier saw when closing.</div>` : ''}
    <div class="grid grid-4 cal-kpis">
      ${statCard('Cash sales', fmtMoney(m.cashGross), '')}${statCard('Card', fmtMoney(m.cardGross), '')}${statCard('GCash / Maya / other', fmtMoney(m.otherGross), '')}${statCard('Refunds / voids', fmtMoney(m.refundsOnly) + ' / ' + fmtMoney(m.voidsOnly), `${m.voidedCount} voided sale${m.voidedCount === 1 ? '' : 's'}`)}
    </div>
    ${shift.notes ? `<p class="hint" style="margin-bottom:12px;">Notes: ${esc(shift.notes)}</p>` : ''}
    ${calDayDetail(ds, sales, refunds, '-' + (shift.shift_number || 'shift'))}`;
  body.querySelector('#cal-shift-pick').onchange = (e) => { CAL.shiftId = e.target.value; CAL_TIPS = []; calRenderShift(body, ds, range, r); calWireTips(body); };
  body.querySelector('#cal-shift-print').onclick = () => printShiftSummary(shift, m);
}
function printShiftSummary(shift, m){
  const closed = shift.status === 'CLOSED';
  const v = (k, live) => closed && shift[k] != null ? shift[k] : live;
  openPrintWindow(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Shift report ${esc(shift.shift_number || '')}</title>
    <style>body{font-family:Georgia,serif;max-width:420px;margin:24px auto;color:#241209;font-size:13px;} .row{display:flex;justify-content:space-between;padding:3px 0;} hr{border:none;border-top:1px dashed #999;margin:10px 0;} h1{font-size:17px;} .hint{font-size:11px;color:#6f5c48;}</style></head><body>
    <h1>${esc(businessName() || appDisplayName())} — Shift report</h1>
    <div>${esc(shift.shift_number || '')} · ${esc(shift.cashier_name || '')}</div>
    <div>${esc(fmtShopDateTime(shift.opened_at))} → ${closed ? esc(fmtShopDateTime(shift.closed_at)) : 'still open'}</div><hr>
    ${salesSummaryRows(m, shift).map(r => `<div class="row"${r.total ? ' style="font-size:14px;"' : ''}><span>${esc(r.label)}</span><${r.total ? 'b' : 'span'}>${r.sign}${fmtMoney(r.amount)}</${r.total ? 'b' : 'span'}></div>`).join('')}
    <div class="row"><span>Transactions</span><b>${esc(v('transaction_count', m.transactionCount))}</b></div>
    <div class="row"><span>${esc(SALES_LABELS.voids)}</span><b>${fmtMoney(v('voids_total', m.voids))}</b></div>
    <div class="hint">${esc(SALES_HINTS.voids)}</div><hr>
    <div class="row"><span>Cash</span><b>${fmtMoney(v('cash_sales', m.cashGross))}</b></div>
    <div class="row"><span>Card</span><b>${fmtMoney(v('card_sales', m.cardGross))}</b></div>
    <div class="row"><span>GCash / Maya / other</span><b>${fmtMoney(v('other_sales', m.otherGross))}</b></div><hr>
    <div class="row"><span>Opening cash</span><b>${fmtMoney(shift.opening_cash)}</b></div>
    <div class="row"><span>Pay ins / outs</span><b>+${fmtMoney(m.payIns)} / -${fmtMoney(m.payOuts)}</b></div>
    <div class="row"><span>Expected cash</span><b>${fmtMoney(v('expected_cash', m.expectedCash))}</b></div>
    ${closed ? `<div class="row"><span>Counted cash</span><b>${fmtMoney(shift.declared_cash)}</b></div><div class="row" style="font-size:15px;"><span><b>Over / short</b></span><b>${num(shift.cash_variance) >= 0 ? '+' : ''}${fmtMoney(shift.cash_variance)}</b></div>` : ''}
    ${shift.notes ? `<hr><div>${esc(shift.notes)}</div>` : ''}</body></html>`, true);
}
function calExportCSV(){
  const t = CAL.lastTable;
  if(!t || !t.rows.length){ toast('Nothing to export for this view', 'warn'); return; }
  downloadFile(`${fileNameSlug()}-calendar-${CAL.view}-${t.name}.csv`, toCSV(t.headers, t.rows), 'text/csv');
  toast('Calendar exported as CSV');
}

/* ================= date-range picker used by Transactions / QR orders / Reports ================= */
const RANGE_PRESETS = [
  {id: 'today', label: 'Today'}, {id: 'yesterday', label: 'Yesterday'}, {id: '7d', label: 'Last 7 days'},
  {id: '30d', label: 'Last 30 days'}, {id: 'month', label: 'This month'}, {id: 'lastmonth', label: 'Last month'}, {id: 'custom', label: 'Choose dates'},
];
function presetKeys(p, custom){
  const t = shopTodayKey();
  switch(p){
    case 'today': return [t, t];
    case 'yesterday': return [keyAddDays(t, -1), keyAddDays(t, -1)];
    case '7d': return [keyAddDays(t, -6), t];
    case '30d': return [keyAddDays(t, -29), t];
    case 'month': return [keyMonthStart(t), t];
    case 'lastmonth': { const s = keyAddMonths(keyMonthStart(t), -1); return [s, keyAddDays(keyMonthStart(t), -1)]; }
    default: {
      let a = (custom && custom.from) || keyAddDays(t, -6), b = (custom && custom.to) || t;
      if(a > b){ const x = a; a = b; b = x; }
      return [a, b];
    }
  }
}
function rangePickerHtml(f, idp){
  return `<select class="filter" id="${idp}-preset" aria-label="Dates">${RANGE_PRESETS.map(p => `<option value="${p.id}" ${f.preset === p.id ? 'selected' : ''}>${p.label}</option>`).join('')}</select>
    <span id="${idp}-custom" style="display:${f.preset === 'custom' ? 'inline-flex' : 'none'};gap:6px;align-items:center;">
      <input type="date" class="filter" id="${idp}-from" value="${esc(f.from || '')}" aria-label="From"> to <input type="date" class="filter" id="${idp}-to" value="${esc(f.to || '')}" aria-label="To"></span>`;
}
function wireRangePicker(root, f, idp, onChange){
  const preset = root.querySelector('#' + idp + '-preset');
  preset.onchange = () => {
    f.preset = preset.value;
    if(f.preset === 'custom' && !f.from){ const [a, b] = presetKeys('7d'); f.from = a; f.to = b; root.querySelector('#' + idp + '-from').value = a; root.querySelector('#' + idp + '-to').value = b; }
    root.querySelector('#' + idp + '-custom').style.display = f.preset === 'custom' ? 'inline-flex' : 'none';
    onChange();
  };
  root.querySelector('#' + idp + '-from').onchange = (e) => { f.from = e.target.value; onChange(); };
  root.querySelector('#' + idp + '-to').onchange = (e) => { f.to = e.target.value; onChange(); };
}

/* ================= Transactions ================= */
const txFilter = {preset: 'today', from: '', to: '', status: '', method: '', cashier: '', source: '', search: '', review: false};
// Plain words for the server's review codes come from the shared reviewReasonText() (ui.js); escape before use.
function reviewText(reason){ return reviewReasonText(reason); }
function reviewCodes(reason){ return String(reason || '').split(/\s*,\s*/).map(x => x.trim()).filter(Boolean); }
// What to look at for each reason, shown in the sale window.
const REVIEW_CHECK_HINT = {
  PRICE_BELOW_MENU: 'compare the prices with today\'s menu prices below',
  NOT_ON_MENU: 'check the items marked "not on the menu" below',
  TAX_MISMATCH: 'compare the tax and service charge with Settings → Receipts & tax',
  PAYMENT_MISMATCH: 'compare the payments with the total',
  STAFF_MISMATCH: 'check who was signed in at the counter (shown above)',
};
function reviewHint(reason){
  const h = reviewCodes(reason).map(c => REVIEW_CHECK_HINT[c]).filter(Boolean);
  return h.length ? 'To check: ' + h.join('; ') + '.' : 'Check the sale below.';
}
// The staff member the server saw signed in at the counter, when it is not the recorded person.
function signedInOther(row, recordedId){
  if(!row || !row.signed_in_staff_id || (recordedId && String(recordedId) === String(row.signed_in_staff_id))) return '';
  return staffName(row.signed_in_staff_id) || 'another staff member';
}

async function renderTransactions(){
  const content = document.getElementById('content');
  content.innerHTML = `
    <div class="toolbar">
      <div class="toolbar-left">
        ${rangePickerHtml(txFilter, 'tx')}
        <select class="filter" id="tx-status" aria-label="Status"><option value="">All statuses</option>${['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'VOIDED'].map(s => `<option value="${s}" ${txFilter.status === s ? 'selected' : ''}>${({COMPLETED: 'Completed', PARTIALLY_REFUNDED: 'Partly refunded', REFUNDED: 'Refunded', VOIDED: 'Voided'})[s]}</option>`).join('')}</select>
        <select class="filter" id="tx-method" aria-label="Payment"><option value="">All payments</option>${PAYMENT_METHODS.map(p => `<option value="${p.id}" ${txFilter.method === p.id ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</select>
        <select class="filter" id="tx-source" aria-label="Source"><option value="">Counter and QR</option><option value="COUNTER" ${txFilter.source === 'COUNTER' ? 'selected' : ''}>Counter only</option><option value="QR" ${txFilter.source === 'QR' ? 'selected' : ''}>QR orders only</option></select>
        <select class="filter" id="tx-cashier" aria-label="Cashier"><option value="">All cashiers</option></select>
        <div class="search-box"><input type="text" id="tx-search" placeholder="Receipt #, item or cashier…" value="${esc(txFilter.search)}" aria-label="Search transactions"></div>
        <label class="inline-check"><input type="checkbox" id="tx-review" ${txFilter.review ? 'checked' : ''}> Needs review only <span class="nav-badge" id="tx-review-count" style="display:${BO.counts.needs_review ? 'inline-flex' : 'none'};">${BO.counts.needs_review}</span></label>
      </div>
      <div class="text-light" style="font-size:13px;" id="tx-count"></div>
    </div>
    <div id="tx-wrap"><div class="loading-line">Loading…</div></div>`;
  const reload = () => loadTransactions();
  wireRangePicker(content, txFilter, 'tx', reload);
  const redraw = () => drawTransactions();
  content.querySelector('#tx-status').onchange = (e) => { txFilter.status = e.target.value; redraw(); };
  content.querySelector('#tx-method').onchange = (e) => { txFilter.method = e.target.value; redraw(); };
  content.querySelector('#tx-source').onchange = (e) => { txFilter.source = e.target.value; redraw(); };
  content.querySelector('#tx-cashier').onchange = (e) => { txFilter.cashier = e.target.value; redraw(); };
  content.querySelector('#tx-search').oninput = debounce((e) => { txFilter.search = e.target.value; redraw(); }, 150);
  content.querySelector('#tx-review').onchange = (e) => { txFilter.review = e.target.checked; reload(); };
  await loadTransactions();
}
let TX_DATA = null;
async function loadTransactions(force){
  const wrap = document.getElementById('tx-wrap');
  if(!wrap) return;
  wrap.classList.add('dim');
  try{
    if(txFilter.review){
      // every flagged sale, whatever its date
      const [sales, payouts, flaggedRefunds] = await Promise.all([
        cloud.select('sales', {eq: {needs_review: true}, order: 'transaction_date.desc', limit: 500}),
        loadPayoutsToReview(),
        loadRefundsToReview(),
      ]);
      const ids = (sales || []).map(s => s.id);
      const payments = [];
      for(let i = 0; i < ids.length; i += 80){ payments.push(...(await cloud.select('payments', {in: {sale_id: ids.slice(i, i + 80)}}) || [])); }
      // the receipt numbers of flagged refunds' sales
      const rSaleIds = [...new Set((flaggedRefunds || []).map(r => r.sale_id).filter(Boolean))];
      const refundSales = [];
      for(let i = 0; i < rSaleIds.length; i += 80){ refundSales.push(...(await cloud.select('sales', {select: 'id,transaction_number,cashier_name', in: {id: rSaleIds.slice(i, i + 80)}}) || [])); }
      TX_DATA = {sales: sales || [], payments, saleItems: [], refunds: [], payouts: payouts || [], flaggedRefunds: flaggedRefunds || [], refundSales, review: true};
      BO.reviewSales = TX_DATA.sales.length; BO.reviewPayouts = TX_DATA.payouts.length; BO.reviewRefunds = TX_DATA.flaggedRefunds.length;
      BO.counts.needs_review = BO.reviewSales + BO.reviewRefunds + BO.reviewPayouts; updateNavBadges();
    } else {
      const [a, b] = presetKeys(txFilter.preset, txFilter);
      TX_DATA = await salesForRange(dayRange(a, b), force);
    }
  }catch(e){
    wrap.classList.remove('dim');
    wrap.innerHTML = emptyBlock(esc(friendlyError(e)));
    return;
  }
  wrap.classList.remove('dim');
  const sel = document.getElementById('tx-cashier');
  if(sel){
    const names = [...new Set(TX_DATA.sales.map(s => s.cashier_name).filter(Boolean))].sort();
    sel.innerHTML = `<option value="">All cashiers</option>` + names.map(n => `<option value="${esc(n)}" ${txFilter.cashier === n ? 'selected' : ''}>${esc(n)}</option>`).join('');
  }
  const rc = document.getElementById('tx-review-count');
  if(rc){ rc.textContent = BO.counts.needs_review; rc.style.display = BO.counts.needs_review ? 'inline-flex' : 'none'; }
  drawTransactions();
}
function drawTransactions(){
  const wrap = document.getElementById('tx-wrap');
  if(!wrap || !TX_DATA) return;
  const ds = TX_DATA;
  let list = ds.sales.filter(s => s.status !== 'HELD');
  if(txFilter.status) list = list.filter(s => s.status === txFilter.status);
  if(txFilter.method) list = list.filter(s => payMethod(ds, s.id) === txFilter.method);
  if(txFilter.source) list = list.filter(s => (s.source || 'COUNTER') === txFilter.source);
  if(txFilter.cashier) list = list.filter(s => s.cashier_name === txFilter.cashier);
  if(txFilter.search){
    const q = txFilter.search.toLowerCase();
    const itemHits = new Set(ds.saleItems.filter(i => (i.name || '').toLowerCase().includes(q)).map(i => i.sale_id));
    list = list.filter(s => (s.transaction_number || '').toLowerCase().includes(q) || (s.cashier_name || '').toLowerCase().includes(q) || itemHits.has(s.id));
  }
  list.sort((a, b) => String(b.transaction_date).localeCompare(String(a.transaction_date)));
  const counted = list.filter(COUNTED);
  const total = counted.reduce((s, x) => s + num(x.grand_total), 0);
  document.getElementById('tx-count').textContent = `${plural(list.length, 'transaction')} · ${fmtMoney(total)} (voided not counted)`;
  const payoutsHtml = ds.review ? reviewPayoutsHtml(ds.payouts || []) + reviewRefundsHtml(ds) : '';
  if(!list.length){
    wrap.innerHTML = payoutsHtml + (ds.review ? (payoutsHtml ? '' : emptyBlock('Nothing needs review. 👍')) : emptyBlock('No transactions match. Try other dates or filters.'));
    wireReviewPayouts(wrap);
    return;
  }
  const shown = list.slice(0, 400);
  wrap.innerHTML = payoutsHtml + (payoutsHtml ? '<div class="section-title" style="font-size:16px;">Sales to review</div>' : '') + `<div class="table-wrap"><table><thead><tr><th>Receipt #</th><th>Date / time</th><th>Cashier</th><th>Payment</th><th>Status</th><th class="num">Total</th><th></th></tr></thead><tbody>
    ${shown.map(s => `<tr class="clickable" data-sale="${esc(s.id)}"><td><b>${esc(s.transaction_number || '')}</b>${s.source === 'QR' ? ' <span class="badge badge-gray">QR</span>' : ''}${s.needs_review ? ` <span class="review-flag" title="${esc(reviewText(s.review_reason))}">Needs review</span>` : ''}${s.offline ? ' <span class="badge badge-gray" title="Rung up while the counter was offline">offline</span>' : ''}${s.needs_review && ds.review ? `<div class="review-why">${esc(reviewText(s.review_reason))}</div>` : ''}</td>
      <td>${esc(fmtShopDateTime(s.transaction_date))}</td><td>${esc(s.cashier_name || '')}${signedInOther(s, s.cashier_id) ? `<div class="signed-in-diff" title="The server saw a different staff member signed in at the counter">signed in: ${esc(signedInOther(s, s.cashier_id))}</div>` : ''}</td><td>${esc(payLabel(payMethod(ds, s.id)))}</td>
      <td>${saleStatusBadge(s.status)}</td><td class="num">${fmtMoney(s.grand_total)}</td>
      <td><button class="btn btn-sm btn-ghost" data-reprint="${esc(s.id)}">Reprint</button></td></tr>`).join('')}
  </tbody></table></div>${list.length > shown.length ? `<p class="hint">Showing the latest ${shown.length} of ${list.length}. Narrow the dates or filters to see the others.</p>` : ''}`;
  wrap.querySelectorAll('tr[data-sale]').forEach(tr => tr.onclick = (e) => { if(e.target.closest('[data-reprint]')) return; openSaleModal(tr.dataset.sale); });
  wrap.querySelectorAll('[data-reprint]').forEach(b => b.onclick = (e) => { e.stopPropagation(); reprintSale(b.dataset.reprint); });
  wireReviewPayouts(wrap);
}
// Pay-outs above the review limit (settings.payout_review_limit), flagged by the server.
function reviewPayoutsHtml(list){
  if(!list.length) return '';
  return `<div class="section-title" style="margin-top:0;font-size:16px;">Large pay-outs to review</div>
    <p class="hint" style="margin-top:-6px;">Cash taken out of a counter drawer above ${fmtMoney(state.settings.payout_review_limit)} (change the amount in Settings → General). Check the reason with the person who did it, then mark it reviewed.</p>
    <div class="table-wrap" id="tx-payouts"><table><thead><tr><th>Date / time</th><th>By</th><th>Reason</th><th class="num">Amount</th><th></th></tr></thead><tbody>
    ${list.map(m => `<tr data-payout="${esc(m.id)}"><td>${esc(fmtShopDateTime(m.at || m.created_at))}</td>
      <td>${esc(m.performed_by_name || '')}${signedInOther(m, m.performed_by) ? `<div class="signed-in-diff">signed in: ${esc(signedInOther(m, m.performed_by))}</div>` : ''}</td>
      <td>${esc(m.reason || '—')}</td><td class="num">${fmtMoney(m.amount)}</td>
      <td><button class="btn btn-sm btn-outline" data-payout-reviewed="${esc(m.id)}">Mark as reviewed</button></td></tr>`).join('')}
    </tbody></table></div>`;
}
// Refunds the server flagged (e.g. STAFF_MISMATCH: done by someone other than who was signed in).
const REFUND_TYPE_LABEL = {VOID: 'Void', FULL_REFUND: 'Full refund', PARTIAL_REFUND: 'Partial refund'};
function reviewRefundsHtml(ds){
  const list = ds.flaggedRefunds || [];
  if(!list.length) return '';
  const saleOf = (id) => (ds.refundSales || []).find(x => x.id === id) || {};
  return `<div class="section-title" style="font-size:16px;${(ds.payouts || []).length ? '' : 'margin-top:0;'}">Refunds and voids to review</div>
    <div class="table-wrap" id="tx-flagged-refunds"><table><thead><tr><th>Date / time</th><th>Sale</th><th>Type</th><th>Done by</th><th>Why</th><th class="num">Amount</th><th></th></tr></thead><tbody>
    ${list.map(r => `<tr data-flagged-refund="${esc(r.id)}"><td>${esc(fmtShopDateTime(r.date || r.created_at))}</td>
      <td><a class="linklike" data-open-sale="${esc(r.sale_id)}">${esc(saleOf(r.sale_id).transaction_number || 'Open sale')}</a></td>
      <td>${esc(REFUND_TYPE_LABEL[r.type] || r.type || '')}</td>
      <td>${esc(r.performed_by_name || r.approved_by_name || '')}${signedInOther(r, r.performed_by) ? `<div class="signed-in-diff">signed in: ${esc(signedInOther(r, r.performed_by))}</div>` : (r.signed_in_staff_id ? '' : '<div class="signed-in-diff">no online sign-in on that counter</div>')}</td>
      <td>${esc(reviewText(r.review_reason))}</td><td class="num">${fmtMoney(r.amount)}</td>
      <td><button class="btn btn-sm btn-outline" data-refund-reviewed="${esc(r.id)}">Mark as reviewed</button></td></tr>`).join('')}
    </tbody></table></div>`;
}
function wireReviewPayouts(root){
  root.querySelectorAll('[data-open-sale]').forEach(a => a.onclick = () => openSaleModal(a.dataset.openSale));
  root.querySelectorAll('[data-refund-reviewed]').forEach(b => b.onclick = () => busy(b, async () => {
    const r = ((TX_DATA && TX_DATA.flaggedRefunds) || []).find(x => x.id === b.dataset.refundReviewed);
    if(!r) return;
    const sn = ((TX_DATA.refundSales || []).find(x => x.id === r.sale_id) || {}).transaction_number || '';
    const ok = await boSave([Ops.update('refunds', {id: r.id, needs_review: false}),
      Ops.audit('Refund reviewed', `${sn} — ${fmtMoney(r.amount)} — ${reviewText(r.review_reason)}`, r.id)],
      {reload: false, dropSales: true, success: 'Marked as reviewed'});
    if(ok){ await loadTransactions(true); }
  }, '…'));
  root.querySelectorAll('[data-payout-reviewed]').forEach(b => b.onclick = () => busy(b, async () => {
    const m = ((TX_DATA && TX_DATA.payouts) || []).find(x => x.id === b.dataset.payoutReviewed);
    if(!m) return;
    const ok = await boSave([Ops.update('cash_movements', {id: m.id, needs_review: false}),
      Ops.audit('Pay-out reviewed', `${fmtMoney(m.amount)} by ${m.performed_by_name || 'staff'}${m.reason ? ' — ' + m.reason : ''}`, m.id)],
      {reload: false, dropSales: true, success: 'Marked as reviewed'});
    if(ok){ await loadTransactions(true); }
  }, '…'));
}

// Loads everything about one sale fresh from the server.
async function loadSaleBundle(saleId){
  const [sales, items, payments, refunds] = await Promise.all([
    cloud.select('sales', {eq: {id: saleId}, limit: 1}),
    cloud.select('sale_items', {eq: {sale_id: saleId}, order: 'created_at.asc'}),
    cloud.select('payments', {eq: {sale_id: saleId}}),
    cloud.select('refunds', {eq: {sale_id: saleId}, order: 'date.asc'}),
  ]);
  const sale = (sales || [])[0];
  if(!sale) throw new Error('That sale was not found.');
  let qr = null, customer = null;
  if(sale.qr_order_id){ try{ qr = ((await cloud.select('qr_orders', {eq: {id: sale.qr_order_id}, limit: 1})) || [])[0] || null; }catch(e){} }
  if(sale.customer_id){ try{ customer = ((await cloud.select('customers', {eq: {id: sale.customer_id}, limit: 1})) || [])[0] || null; }catch(e){} }
  return {sale, items: items || [], payments: payments || [], refunds: refunds || [], qr, customer};
}
async function reprintSale(saleId){
  try{
    const b = await loadSaleBundle(saleId);
    openPrintWindow(receiptHtml(b.sale, b.items, b.payments, {qrOrder: b.qr, customerName: b.customer ? b.customer.nickname : (b.qr ? b.qr.customer_nickname : null)}), true);
  }catch(e){ toast(friendlyError(e), 'error'); }
}
// Today's menu price for a sold line (recipe price + the matching options' price changes) —
// shown only as a guide when checking a flagged sale.
function menuPriceNow(item){
  const r = state.recipes.find(x => x.id === item.recipe_id);
  if(!r) return null;
  let p = num(r.selling_price);
  (item.modifiers || []).forEach(m => {
    const g = (r.modifier_groups || []).find(x => x.name === m.group);
    const o = g && (g.options || []).find(x => x.label === m.label);
    p += o ? num(o.price_delta) : Math.max(0, num(m.price_delta));
  });
  return p;
}
async function openSaleModal(saleId){
  let b;
  try{ b = await loadSaleBundle(saleId); }catch(e){ toast(friendlyError(e), 'error'); return; }
  const {sale, items, payments, refunds, qr, customer} = b;
  const pay = payments[0] || {};
  const refunded = refunds.reduce((s, r) => s + num(r.amount), 0);
  const canRefund = (sale.status === 'COMPLETED' || sale.status === 'PARTIALLY_REFUNDED') && refundLeft(sale, refunded) > 0.01;     // same rule as the server
  const canVoid = sale.status === 'COMPLETED' && !refunds.length;
  openModal({title: 'Sale ' + esc(sale.transaction_number || ''), wide: true, body: `
    <div class="pill-stack" style="margin-bottom:12px;">${saleStatusBadge(sale.status)}
      <span class="tag-pill">${esc(fmtShopDateTime(sale.transaction_date))}</span>
      <span class="tag-pill">Cashier: ${esc(sale.cashier_name || '')}</span>
      ${signedInOther(sale, sale.cashier_id) ? `<span class="tag-pill signed-in-diff" title="The server saw a different staff member signed in at the counter when this sale was uploaded">Signed in at the counter: ${esc(signedInOther(sale, sale.cashier_id))}</span>`
        : (!sale.signed_in_staff_id && reviewCodes(sale.review_reason).includes('STAFF_MISMATCH') ? '<span class="tag-pill signed-in-diff">No online sign-in recorded on that counter</span>' : '')}
      ${sale.source === 'QR' ? `<span class="tag-pill">QR order${qr ? ' ' + esc(qr.order_number) + (qr.table_label ? ' · ' + esc(qr.table_label) : '') : ''}</span>` : ''}
      ${customer ? `<span class="tag-pill">Customer: ${esc(customer.nickname)}</span>` : ''}
      ${sale.offline ? '<span class="tag-pill">Rung up offline</span>' : ''}</div>
    ${sale.needs_review ? `<div class="notice warn"><b>Needs review:</b> ${esc(reviewText(sale.review_reason))}. ${esc(reviewHint(sale.review_reason))} Then mark it reviewed. <button class="btn btn-sm btn-outline" id="sm-reviewed" style="margin-left:6px;">Mark as reviewed</button></div>`
      : (sale.review_reason ? `<p class="hint">Checked earlier — it was flagged: ${esc(reviewText(sale.review_reason))}.</p>` : '')}
    <div class="table-wrap" style="box-shadow:none;"><table><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Unit price</th>${sale.needs_review ? '<th class="num">Menu price today</th>' : ''}<th class="num">Total</th></tr></thead><tbody>
      ${items.map(i => { const mp = sale.needs_review ? menuPriceNow(i) : null; return `<tr><td><b>${esc(i.name)}</b>${(i.modifiers || []).length ? `<div class="text-light" style="font-size:12px;">${i.modifiers.map(m => esc(m.label)).join(', ')}</div>` : ''}${i.notes ? `<div class="text-light" style="font-size:12px;">“${esc(i.notes)}”</div>` : ''}</td>
        <td class="num">${fmtNum(i.quantity, 0)}</td><td class="num">${fmtMoney(i.unit_price)}</td>${sale.needs_review ? `<td class="num ${mp != null && num(i.unit_price) < mp - 0.02 ? 'text-red' : ''}">${mp == null ? 'not on the menu' : fmtMoney(mp)}</td>` : ''}<td class="num">${fmtMoney(i.line_total)}</td></tr>`; }).join('') || '<tr><td colspan="4" class="text-light">No items.</td></tr>'}
    </tbody></table></div>
    <div class="kv-list" style="margin-top:12px;">
      <div>Subtotal <b>${fmtMoney(sale.subtotal)}</b>${num(sale.discount_amount) > 0 ? ` · Discount <b>-${fmtMoney(sale.discount_amount)}</b>${sale.discount_approved_by_name ? ' (approved by ' + esc(sale.discount_approved_by_name) + ')' : ''}` : ''}${num(sale.tax_amount) > 0 ? ` · Tax <b>${fmtMoney(sale.tax_amount)}</b>` : ''}${num(sale.service_charge_amount) > 0 ? ` · Service charge <b>${fmtMoney(sale.service_charge_amount)}</b>` : ''}</div>
      <div style="font-size:16px;">Total <b>${fmtMoney(sale.grand_total)}</b></div>
      ${payments.map(p => `<div>Paid by <b>${esc(payLabel(p.method))}</b> ${fmtMoney(p.amount)}${p.method === 'CASH' && p.tendered != null ? ` (cash ${fmtMoney(p.tendered)}, change ${fmtMoney(p.change)})` : ''}${p.reference ? ' · ref ' + esc(p.reference) : ''}</div>`).join('') || '<div class="text-light">No payment recorded.</div>'}
    </div>
    ${refunds.length ? `<div class="section-title" style="font-size:15px;">Refunds and voids</div><div class="table-wrap" style="box-shadow:none;"><table><thead><tr><th>Date</th><th>Type</th><th class="num">Amount</th><th>Reason</th><th>Approved by</th></tr></thead><tbody>
      ${refunds.map(r => `<tr><td>${esc(fmtShopDateTime(r.date))}</td><td>${esc(({VOID: 'Void', FULL_REFUND: 'Full refund', PARTIAL_REFUND: 'Partial refund'})[r.type] || r.type)}</td><td class="num">${fmtMoney(r.amount)}</td><td>${esc(r.reason || '—')}</td><td>${esc(r.approved_by_name || '')}${r.performed_by_name && r.performed_by_name !== r.approved_by_name ? `<div class="text-light" style="font-size:12px;">done by ${esc(r.performed_by_name)}</div>` : ''}${signedInOther(r, r.performed_by || r.approved_by) ? `<div class="signed-in-diff">signed in: ${esc(signedInOther(r, r.performed_by || r.approved_by))}</div>` : ''}</td></tr>`).join('')}</tbody></table></div>` : ''}`,
    foot: `${canVoid ? '<button class="btn btn-danger" id="sm-void">Void sale</button>' : ''}${canRefund ? '<button class="btn btn-amber" id="sm-refund">Refund</button>' : ''}<span style="flex:1;"></span><button class="btn btn-outline" id="sm-print">🖨 Reprint receipt</button><button class="btn btn-primary" data-close>Close</button>`,
    onMount: (root) => {
      root.querySelector('[data-close]').onclick = closeModal;
      root.querySelector('#sm-print').onclick = () => openPrintWindow(receiptHtml(sale, items, payments, {qrOrder: qr, customerName: customer ? customer.nickname : (qr ? qr.customer_nickname : null)}), true);
      const rv = root.querySelector('#sm-reviewed');
      if(rv) rv.onclick = () => busy(rv, async () => {
        const ok = await boSave([Ops.update('sales', {id: sale.id, needs_review: false}), Ops.audit('Sale reviewed', `${sale.transaction_number} — ${reviewText(sale.review_reason)}`, sale.id)], {reload: false, dropSales: true, success: 'Marked as reviewed'});
        if(ok){ closeModal(); await refreshReviewCount(); if(state.route === 'transactions') loadTransactions(true); }
      });
      const v = root.querySelector('#sm-void'); if(v) v.onclick = () => openOwnerRefund(b, 'VOID');
      const r = root.querySelector('#sm-refund'); if(r) r.onclick = () => openOwnerRefund(b, 'REFUND');
    }});
}

// Refund or void done by the owner. Everything is saved in ONE call: the refund, the stock
// put back (same amounts the sale took: inventoryLinesForSaleLine, capped at what this sale
// actually deducted), the sale's new status, the customer's totals and the audit entry.
async function openOwnerRefund(bundle, kind){
  const {sale, items, refunds} = bundle;
  const isVoid = kind === 'VOID';
  let openShifts = [], stockRows = [];
  try{
    openShifts = await cloud.select('shifts', {eq: {status: 'ACTIVE'}, order: 'opened_at.desc'}) || [];
    const refs = [sale.id].concat(refunds.map(r => r.id));
    stockRows = await cloud.select('inventory_transactions', {in: {reference_id: refs}}) || [];
  }catch(e){ toast(friendlyError(e), 'error'); return; }
  // The refund rule is the shared one (owner decision 2026-10-12): the customer gets back what they paid
  // for the returned items - their share after the sale's discount, plus tax and service charge. The
  // server checks the same rule, so the screen can never offer more than it would accept.
  const prior = refundPriorFor(sale.id, refunds);
  const prevAmount = prior.amount;
  const remaining = refundLeft(sale, prior);
  const alreadyQty = prior.quantities;
  const maxQty = (it) => Math.max(0, num(it.quantity) - (alreadyQty[it.id] || 0));
  openModal({title: isVoid ? 'Void sale ' + esc(sale.transaction_number) : 'Refund sale ' + esc(sale.transaction_number), wide: true, body: `
    ${isVoid ? `<p>This voids <b>${esc(sale.transaction_number)}</b> (${fmtMoney(sale.grand_total)}) and puts all its items back in stock. The sale stays in the history, marked voided.</p>`
      : `<p>Choose what to refund. Up to <b>${fmtMoney(remaining)}</b> is left to refund on this sale.</p>
      <table class="ri-table"><thead><tr><th>Item</th><th>Sold</th><th>Already refunded</th><th>Refund now</th></tr></thead><tbody>
        ${items.map(it => `<tr data-item="${esc(it.id)}"><td>${esc(it.name)}${(it.modifiers || []).length ? `<div class="text-light" style="font-size:12px;">${it.modifiers.map(m => esc(m.label)).join(', ')}</div>` : ''}</td><td>${fmtNum(it.quantity, 0)}</td><td>${fmtNum(alreadyQty[it.id] || 0, 0)}</td>
          <td><input type="number" min="0" step="1" max="${maxQty(it)}" value="0" class="rv-qty" style="width:80px;" ${maxQty(it) ? '' : 'disabled'} aria-label="Quantity to refund"></td></tr>`).join('')}
      </tbody></table>
      <div class="form-row" style="margin-top:12px;max-width:320px;"><label for="rv-amount">Amount to give back (₱)</label><input type="number" step="any" min="0" max="${remaining}" id="rv-amount" value="0"><div class="hint" id="rv-amount-hint">Worked out from what the customer paid for these items (after the discount, with tax and service charge). You can lower it, not raise it.</div></div>`}
    <div class="form-row"><label for="rv-reason">Reason</label><input id="rv-reason" maxlength="200" placeholder="${isVoid ? 'e.g. Entered by mistake' : 'e.g. Customer changed their order'}"></div>
    <div class="form-row"><label for="rv-shift">Where does the money come from?</label><select id="rv-shift">
      <option value="">Not from a counter drawer (e.g. I paid it back myself)</option>
      ${openShifts.map(s => `<option value="${esc(s.id)}">The drawer of the open shift ${esc(s.shift_number || '')} (${esc(s.cashier_name || '')})</option>`).join('')}
    </select><div class="hint">Choosing an open shift takes a cash refund out of that drawer's expected cash.</div></div>
    <div class="notice" id="rv-preview" style="margin-top:8px;"></div>`,
    foot: `<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-danger" id="rv-confirm">${isVoid ? 'Void this sale' : 'Refund'}</button>`,
    onMount: (root) => {
      root.querySelector('[data-cancel]').onclick = closeModal;
      const amountInput = root.querySelector('#rv-amount');
      function chosen(){
        if(isVoid) return items.map(it => ({it, qty: num(it.quantity)}));
        return [...root.querySelectorAll('[data-item]')].map(row => ({it: items.find(x => x.id === row.dataset.item), qty: Math.floor(num(row.querySelector('.rv-qty').value))})).filter(x => x.qty > 0);
      }
      // the most these items can give back (shared rule; 0 until something is chosen)
      function computed(){
        const sel = chosen();
        if(!sel.length) return 0;
        return refundAmountForItems(sale, items, sel.map(x => ({sale_item_id: x.it.id, quantity: x.qty})), prior);
      }
      function preview(){
        const p = root.querySelector('#rv-preview');
        const sel = chosen();
        p.textContent = isVoid ? `${fmtMoney(sale.grand_total)} will be voided and ${plural(sel.reduce((s, x) => s + x.qty, 0), 'item')} put back in stock.`
          : (sel.length ? `${plural(sel.reduce((s, x) => s + x.qty, 0), 'item')} back to stock, ${fmtMoney(num(amountInput.value))} back to the customer.` : 'Choose at least one item to refund.');
      }
      if(!isVoid){
        const syncMax = () => { amountInput.max = String(computed()); };
        root.querySelectorAll('.rv-qty').forEach(inp => inp.oninput = () => { amountInput.value = computed().toFixed(2); syncMax(); preview(); });
        // the amount can be lowered but never raised above what these items give back
        amountInput.oninput = () => { if(num(amountInput.value) > computed()) amountInput.value = computed().toFixed(2); preview(); };
        syncMax();
      }
      preview();
      const go = root.querySelector('#rv-confirm');
      go.onclick = () => busy(go, async () => {
        const sel = chosen();
        const reason = root.querySelector('#rv-reason').value.trim();
        if(!sel.length){ toast('Choose at least one item to refund', 'error'); return; }
        for(const x of sel){ if(x.qty > maxQty(x.it)){ toast(`${x.it.name}: you can refund at most ${fmtNum(maxQty(x.it), 0)}`, 'error'); return; } }
        // a void gives back everything that is left (the whole sale: voids are only offered on sales without refunds)
        const amount = isVoid ? remaining : roundMoney(amountInput.value);
        const most = isVoid ? remaining : computed();
        if(!isVoid && (amount < 0 || amount > most + 0.001)){ toast(`For these items the amount must be between ₱0 and ${fmtMoney(most)}`, 'error'); return; }
        if(!reason){ toast('Enter a reason — it shows in the audit log', 'error'); return; }
        const now = nowISO();
        // FULL_REFUND / REFUNDED once nothing is left to give back, otherwise a partial refund
        const nothingLeft = refundLeft(sale, prevAmount + amount) === 0;
        const refund = {id: uid(), sale_id: sale.id, shift_id: root.querySelector('#rv-shift').value || null,
          type: isVoid ? 'VOID' : (nothingLeft ? 'FULL_REFUND' : 'PARTIAL_REFUND'),
          amount, reason, items: sel.map(x => ({sale_item_id: x.it.id, quantity: x.qty, recipe_id: x.it.recipe_id, modifiers: x.it.modifiers || []})),
          approved_by: boActorId(), approved_by_name: boActorName(), date: now, notes: 'Done in the Back Office', created_at: now};
        const newStatus = isVoid ? 'VOIDED' : (nothingLeft ? 'REFUNDED' : 'PARTIALLY_REFUNDED');
        // stock back: what the recipe uses (shared logic), never more than this sale took out
        const left = {};
        stockRows.forEach(t => {
          if(t.reference_id === sale.id && t.transaction_type === 'SALE_USAGE') left[t.ingredient_id] = (left[t.ingredient_id] || 0) + Math.abs(num(t.quantity));
          if(t.reference_id !== sale.id && t.transaction_type === 'SALE_REVERSAL') left[t.ingredient_id] = (left[t.ingredient_id] || 0) - Math.abs(num(t.quantity));
        });
        const ops = [Ops.upsert('refunds', refund)];
        const back = {};
        sel.forEach(x => inventoryLinesForSaleLine(x.it.recipe_id, x.qty, x.it.modifiers).forEach(l => {
          const can = Math.max(0, (left[l.ingredient_id] || 0) - (back[l.ingredient_id] || 0));
          const q = Math.min(l.quantity, can);
          if(q <= 0) return;
          back[l.ingredient_id] = (back[l.ingredient_id] || 0) + q;
          ops.push(Ops.upsert('inventory_transactions', {id: uid(), ingredient_id: l.ingredient_id, transaction_type: 'SALE_REVERSAL', quantity: q, reference_id: refund.id,
            transaction_date: shopTodayKey(), notes: `${isVoid ? 'Void' : 'Refund'}${l.kind === 'modifier' ? ' option "' + (l.label || '') + '"' : ''} of ${sale.transaction_number} (Back Office)`, created_at: now}));
        }));
        ops.push(Ops.update('sales', {id: sale.id, status: newStatus, updated_at: now}));
        if(sale.customer_id){
          try{
            const c = ((await cloud.select('customers', {eq: {id: sale.customer_id}, limit: 1})) || [])[0];
            if(c) ops.push(Ops.update('customers', {id: c.id, total_spent: Math.max(0, num(c.total_spent) - amount),
              visit_count: refund.type === 'VOID' || refund.type === 'FULL_REFUND' ? Math.max(0, num(c.visit_count) - 1) : num(c.visit_count), updated_at: now}));
          }catch(e){ /* customer totals are a nicety */ }
        }
        ops.push(Ops.audit(isVoid ? 'Sale voided' : 'Refund', `${sale.transaction_number} — ${fmtMoney(amount)} — ${reason} (Back Office)`, sale.id));
        if(await boSave(ops, {dropSales: true, success: isVoid ? 'Sale voided — stock put back' : 'Refund saved — stock put back'})){
          closeModal();
          if(state.route === 'transactions') loadTransactions(true); else rerender();
        }
      });
    }});
}

/* ================= QR orders (history) ================= */
const qrFilter = {preset: 'today', from: '', to: '', status: '', search: ''};
const QR_STATUS = {PENDING: ['New', 'badge-yellow'], PREPARING: ['Preparing', 'badge-yellow'], READY: ['Ready', 'badge-green'], COMPLETED: ['Completed', 'badge-green'], REJECTED: ['Rejected', 'badge-red'], CANCELLED: ['Cancelled', 'badge-gray']};
function qrStatusBadge(s){ const x = QR_STATUS[s] || [s, 'badge-gray']; return `<span class="badge ${x[1]}">${esc(x[0])}</span>`; }
let QR_DATA = null;
async function renderQrOrders(){
  const content = document.getElementById('content');
  content.innerHTML = `
    <div class="grid grid-4 kpi-sans" id="qr-kpis" style="margin-bottom:16px;"></div>
    <div class="toolbar"><div class="toolbar-left">
      ${rangePickerHtml(qrFilter, 'qo')}
      <select class="filter" id="qo-status" aria-label="Status"><option value="">All statuses</option>${Object.keys(QR_STATUS).map(s => `<option value="${s}" ${qrFilter.status === s ? 'selected' : ''}>${QR_STATUS[s][0]}</option>`).join('')}</select>
      <div class="search-box"><input type="text" id="qo-search" placeholder="Order #, customer or table…" value="${esc(qrFilter.search)}" aria-label="Search QR orders"></div>
    </div><div class="text-light" style="font-size:13px;">The live queue is on the counter (Front Office → QR orders).</div></div>
    <div id="qo-wrap"><div class="loading-line">Loading…</div></div>`;
  wireRangePicker(content, qrFilter, 'qo', () => loadQrOrders());
  content.querySelector('#qo-status').onchange = (e) => { qrFilter.status = e.target.value; drawQrOrders(); };
  content.querySelector('#qo-search').oninput = debounce((e) => { qrFilter.search = e.target.value; drawQrOrders(); }, 150);
  await loadQrOrders();
}
async function loadQrOrders(){
  const wrap = document.getElementById('qo-wrap'); if(!wrap) return;
  wrap.classList.add('dim');
  try{ const [a, b] = presetKeys(qrFilter.preset, qrFilter); QR_DATA = await salesForRange(dayRange(a, b)); }
  catch(e){ wrap.classList.remove('dim'); wrap.innerHTML = emptyBlock(esc(friendlyError(e))); return; }
  wrap.classList.remove('dim');
  drawQrOrders();
}
function drawQrOrders(){
  const wrap = document.getElementById('qo-wrap'); if(!wrap || !QR_DATA) return;
  const all = QR_DATA.qrOrders;
  const k = document.getElementById('qr-kpis');
  if(k){
    k.innerHTML = statCard('Open right now', BO.counts.open_qr_orders, 'new, preparing or ready')
      + statCard('QR orders in these dates', all.length, `${fmtMoney(all.filter(o => o.paid_at).reduce((s, o) => s + num(o.total), 0))} paid`)
      + statCard('Completed', all.filter(o => o.status === 'COMPLETED').length, '')
      + statCard('QR ordering', state.settings.qr_ordering_enabled ? 'On' : 'Off', '<a class="linklike" id="go-qr-settings">change in Settings</a>');
    k.querySelector('#go-qr-settings').onclick = () => { BO_SETTINGS_TAB = 'qr'; navigate('settings'); };
  }
  let list = all.slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  if(qrFilter.status) list = list.filter(o => o.status === qrFilter.status);
  if(qrFilter.search){ const q = qrFilter.search.toLowerCase(); list = list.filter(o => [o.order_number, o.customer_nickname, o.table_label].some(v => String(v || '').toLowerCase().includes(q))); }
  if(!list.length){ wrap.innerHTML = emptyBlock('No QR orders in these dates.'); return; }
  wrap.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Order</th><th>Placed</th><th>Customer</th><th>Table</th><th class="num">Items</th><th class="num">Total</th><th>Paid</th><th>Status</th></tr></thead><tbody>
    ${list.map(o => `<tr class="clickable" data-order="${esc(o.id)}"><td><b>${esc(o.order_number)}</b></td><td>${esc(fmtShopDateTime(o.created_at))}</td>
      <td>${esc(o.customer_nickname || '—')}</td><td>${esc(o.table_label || '')} ${o.order_type === 'TAKEAWAY' ? '<span class="badge badge-gray">Takeaway</span>' : ''}</td>
      <td class="num">${(o.items || []).reduce((s, i) => s + num(i.quantity), 0)}</td><td class="num">${fmtMoney(o.total)}</td><td>${o.paid_at ? '✓' : '—'}</td><td>${qrStatusBadge(o.status)}</td></tr>`).join('')}
  </tbody></table></div>`;
  wrap.querySelectorAll('[data-order]').forEach(tr => tr.onclick = () => openQrOrderModal(QR_DATA.qrOrders.find(o => o.id === tr.dataset.order)));
}
function openQrOrderModal(o){
  if(!o) return;
  openModal({title: 'QR order ' + esc(o.order_number), body: `
    <div class="pill-stack" style="margin-bottom:10px;">${qrStatusBadge(o.status)}<span class="tag-pill">${esc(o.table_label || '')}</span><span class="tag-pill">${o.order_type === 'TAKEAWAY' ? 'Takeaway' : 'Dine-in'}</span>${o.customer_nickname ? `<span class="tag-pill">${esc(o.customer_nickname)}</span>` : ''}</div>
    ${(o.items || []).map(i => `<div style="padding:6px 0;border-bottom:1px solid var(--beige);"><b>${fmtNum(i.quantity, 0)} × ${esc(i.name)}</b> <span style="float:right;">${fmtMoney(i.line_total)}</span>
      ${(i.modifiers || []).length ? `<div class="text-light" style="font-size:12px;">${i.modifiers.map(m => esc(m.label)).join(', ')}</div>` : ''}${i.notes ? `<div style="font-size:12px;">Note: ${esc(i.notes)}</div>` : ''}</div>`).join('')}
    <div class="kv-list" style="margin-top:8px;">Subtotal ${fmtMoney(o.subtotal)}${num(o.tax_amount) ? ' · Tax ' + fmtMoney(o.tax_amount) : ''}${num(o.service_charge_amount) ? ' · Service ' + fmtMoney(o.service_charge_amount) : ''} · <b>Total ${fmtMoney(o.total)}</b></div>
    ${o.customer_note ? `<p style="margin-top:10px;"><b>Customer note:</b> ${esc(o.customer_note)}</p>` : ''}
    <p class="kv-list" style="margin-top:10px;">Placed ${esc(fmtShopDateTime(o.created_at))}${o.accepted_at ? '<br>Accepted ' + esc(fmtShopTime(o.accepted_at)) : ''}${o.paid_at ? '<br>Paid ' + esc(fmtShopTime(o.paid_at)) : ''}${o.ready_at ? '<br>Ready ' + esc(fmtShopTime(o.ready_at)) : ''}${o.completed_at ? '<br>Completed ' + esc(fmtShopTime(o.completed_at)) : ''}${o.reject_reason ? '<br>Reason: ' + esc(o.reject_reason) : ''}${o.handled_by_name ? '<br>Handled by ' + esc(o.handled_by_name) : ''}</p>
    ${o.sale_id ? `<p><a class="linklike" id="qo-sale">See the sale for this order →</a></p>` : ''}`,
    foot: `<button class="btn btn-primary" data-close>Close</button>`,
    onMount: (root) => { root.querySelector('[data-close]').onclick = closeModal; const l = root.querySelector('#qo-sale'); if(l) l.onclick = () => openSaleModal(o.sale_id); }});
}

/* ================= Customers ================= */
const custFilter = {search: '', sort: 'last'};
let CUSTOMERS = null;
function normPhone(raw){
  const d = String(raw || '').replace(/\D/g, '');
  if(/^639\d{9}$/.test(d)) return '+' + d;
  if(/^09\d{9}$/.test(d)) return '+63' + d.slice(1);
  if(/^9\d{9}$/.test(d)) return '+63' + d;
  return null;
}
function formatPhone(p){
  const s = String(p || '');
  const m = /^\+63(9\d{2})(\d{3})(\d{4})$/.exec(s);
  return m ? `0${m[1]} ${m[2]} ${m[3]}` : s;
}
async function loadCustomers(){
  CUSTOMERS = await cloud.selectAll('customers', {is: {merged_into: null}, order: 'last_seen_at.desc'});
  BO.counts.customer_count = CUSTOMERS.length;
  return CUSTOMERS;
}
async function renderCustomers(){
  if(state.route !== 'customers') return;      // a save finished after the owner moved on
  const bar = setTopbarActions(`<button class="btn btn-outline" id="cust-csv">Download CSV</button>`);
  bar.querySelector('#cust-csv').onclick = exportCustomersCSV;
  const content = document.getElementById('content');
  content.innerHTML = `<div class="loading-line">Loading customers…</div>`;
  try{ await loadCustomers(); }catch(e){ content.innerHTML = emptyBlock(esc(friendlyError(e))); return; }
  if(state.route !== 'customers') return;
  const list = CUSTOMERS;
  const loyalty = !!state.settings.loyalty_enabled;
  content.innerHTML = `
    <div class="grid grid-4 kpi-sans" style="margin-bottom:16px;">
      ${statCard('Customers', list.length, 'from QR sign-ups or added at the counter')}
      ${statCard('Returning', list.filter(c => num(c.visit_count) >= 2).length, '2 or more visits')}
      ${statCard('With mobile number', list.filter(c => c.phone).length, 'can find their account again')}
      ${statCard('Spent by customers', fmtMoney(list.reduce((s, c) => s + num(c.total_spent), 0)), 'after refunds')}
    </div>
    <div class="toolbar"><div class="toolbar-left">
      <div class="search-box"><input type="text" id="cust-search" placeholder="Nickname or mobile…" value="${esc(custFilter.search)}" aria-label="Search customers"></div>
      <select class="filter" id="cust-sort" aria-label="Sort">
        ${[['last', 'Sort: last seen'], ['visits', 'Sort: most visits'], ['spent', 'Sort: most spent'], ['new', 'Sort: newest']].map(([v, l]) => `<option value="${v}" ${custFilter.sort === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
    </div><div class="text-light" style="font-size:13px;">${loyalty ? `Loyalty is on: ${esc(state.settings.stamps_per_reward)} stamps = 1 reward.` : 'Personal data: keep it private (Data Privacy Act).'}</div></div>
    <div id="cust-wrap"></div>`;
  content.querySelector('#cust-search').oninput = debounce((e) => { custFilter.search = e.target.value; drawCustomers(); }, 120);
  content.querySelector('#cust-sort').onchange = (e) => { custFilter.sort = e.target.value; drawCustomers(); };
  drawCustomers();
}
function drawCustomers(){
  const wrap = document.getElementById('cust-wrap'); if(!wrap || !CUSTOMERS) return;
  let list = CUSTOMERS.slice();
  if(custFilter.search){
    const q = custFilter.search.toLowerCase().trim(), digits = custFilter.search.replace(/\D/g, '');
    list = list.filter(c => (c.nickname || '').toLowerCase().includes(q) || (digits.length >= 3 && (String(c.phone || '').includes(digits) || formatPhone(c.phone).replace(/\D/g, '').includes(digits))));
  }
  const sorters = {
    last: (a, b) => String(b.last_seen_at || b.created_at).localeCompare(String(a.last_seen_at || a.created_at)),
    visits: (a, b) => num(b.visit_count) - num(a.visit_count), spent: (a, b) => num(b.total_spent) - num(a.total_spent),
    new: (a, b) => String(b.created_at).localeCompare(String(a.created_at)),
  };
  list.sort(sorters[custFilter.sort] || sorters.last);
  if(!list.length){ wrap.innerHTML = emptyBlock(CUSTOMERS.length ? 'No customer matches that search.' : 'No customers yet. They appear here when someone enters a nickname on the QR order page, or is added at the counter.'); return; }
  const loyalty = !!state.settings.loyalty_enabled;
  wrap.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Nickname</th><th>Mobile</th><th class="num">Visits</th>${loyalty ? '<th class="num">Stamps</th>' : ''}<th class="num">Total spent</th><th>Last order</th><th>Joined</th><th>From</th></tr></thead><tbody>
    ${list.slice(0, 600).map(c => `<tr class="clickable" data-cust="${esc(c.id)}"><td><b>${esc(c.nickname)}</b></td><td>${c.phone ? esc(formatPhone(c.phone)) : '<span class="text-light">—</span>'}</td>
      <td class="num">${num(c.visit_count)}</td>${loyalty ? `<td class="num">${num(c.stamps)}</td>` : ''}<td class="num">${fmtMoney(c.total_spent)}</td>
      <td>${c.last_order_at ? esc(fmtShopDate(c.last_order_at)) : '—'}</td><td>${esc(fmtShopDate(c.first_seen_at || c.created_at))}</td><td>${esc(c.source === 'COUNTER' ? 'Counter' : 'QR')}</td></tr>`).join('')}
  </tbody></table></div>${list.length > 600 ? '<p class="hint">Showing the first 600. Search to find others.</p>' : ''}`;
  wrap.querySelectorAll('[data-cust]').forEach(tr => tr.onclick = () => openCustomerModal(tr.dataset.cust));
}
async function exportCustomersCSV(){
  const ok = await confirmDialog('The file has customers\' names and mobile numbers. Keep it private and delete it when you are done with it.', 'Download');
  if(!ok) return;
  try{
    const list = CUSTOMERS || await loadCustomers();
    downloadFile(`${fileNameSlug()}-customers-${shopTodayKey()}.csv`, toCSV(['Nickname', 'Mobile', 'Visits', 'Stamps', 'Total spent', 'First seen', 'Last order', 'Source', 'Notes'],
      list.map(c => [c.nickname, c.phone ? formatPhone(c.phone) : '', num(c.visit_count), num(c.stamps), num(c.total_spent).toFixed(2), dayKeyOf(c.first_seen_at || c.created_at), c.last_order_at ? dayKeyOf(c.last_order_at) : '', c.source || '', c.notes || ''])), 'text/csv');
    applyChanges([Ops.audit('Customer list downloaded', `${list.length} customers`)]).catch(() => {});
  }catch(e){ toast(friendlyError(e), 'error'); }
}
async function openCustomerModal(id){
  const c = (CUSTOMERS || []).find(x => x.id === id);
  if(!c) return;
  let sales = [], orders = [];
  try{
    [sales, orders] = await Promise.all([
      cloud.select('sales', {eq: {customer_id: id}, order: 'transaction_date.desc', limit: 50}),
      cloud.select('qr_orders', {eq: {customer_id: id}, order: 'created_at.desc', limit: 50}),
    ]);
  }catch(e){ toast(friendlyError(e), 'error'); }
  sales = (sales || []).filter(s => s.status !== 'HELD');
  const others = (CUSTOMERS || []).filter(x => x.id !== id).sort((a, b) => String(a.nickname).localeCompare(String(b.nickname)));
  const loyalty = !!state.settings.loyalty_enabled;
  openModal({title: esc(c.nickname), wide: true, body: `
    <div class="grid grid-4 kpi-sans" style="margin-bottom:14px;">${statCard('Visits', num(c.visit_count), 'paid orders')}${statCard('Total spent', fmtMoney(c.total_spent), 'after refunds')}${loyalty ? statCard('Stamps', num(c.stamps), `${esc(state.settings.stamps_per_reward)} = 1 reward`) : statCard('QR orders', (orders || []).length, 'latest 50')}${statCard('Customer since', esc(fmtShopDate(c.first_seen_at || c.created_at)), c.source === 'COUNTER' ? 'added at the counter' : 'signed up by QR')}</div>
    <div class="form-grid">
      <div class="form-row"><label for="cu-nick">Nickname</label><input id="cu-nick" maxlength="30" value="${esc(c.nickname)}"></div>
      <div class="form-row"><label for="cu-phone">Mobile number</label><input id="cu-phone" inputmode="tel" maxlength="20" value="${esc(c.phone ? formatPhone(c.phone) : '')}" placeholder="0917 123 4567"></div>
    </div>
    <div class="form-row"><label for="cu-notes">Notes (staff only)</label><textarea id="cu-notes" rows="2" placeholder="e.g. Likes oat milk">${esc(c.notes || '')}</textarea></div>
    <div class="section-title" style="font-size:15px;">Purchases</div>
    ${sales.length ? `<div class="table-wrap" style="box-shadow:none;max-height:240px;"><table><thead><tr><th>Date</th><th>Receipt #</th><th class="num">Total</th><th>Status</th></tr></thead><tbody>${sales.map(s => `<tr class="clickable" data-sale="${esc(s.id)}"><td>${esc(fmtShopDateTime(s.transaction_date))}</td><td>${esc(s.transaction_number || '')}</td><td class="num">${fmtMoney(s.grand_total)}</td><td>${saleStatusBadge(s.status)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="hint">No purchases linked yet.</p>'}
    ${(orders || []).length ? `<div class="section-title" style="font-size:15px;">QR orders</div><div class="table-wrap" style="box-shadow:none;max-height:200px;"><table><thead><tr><th>Placed</th><th>Order</th><th>Table</th><th class="num">Total</th><th>Status</th></tr></thead><tbody>${orders.map(o => `<tr><td>${esc(fmtShopDateTime(o.created_at))}</td><td>${esc(o.order_number)}</td><td>${esc(o.table_label || '')}</td><td class="num">${fmtMoney(o.total)}</td><td>${qrStatusBadge(o.status)}</td></tr>`).join('')}</tbody></table></div>` : ''}
    <div class="section-title" style="font-size:15px;">Same person twice?</div>
    <p class="hint">If this person signed up twice (new phone, cleared browser), merge the other record into this one. Visits, spending, orders and phone links move here; the other record is closed.</p>
    <div class="field-inline"><select class="filter" id="cu-merge" style="max-width:100%;"><option value="">Choose the duplicate…</option>${others.map(o => `<option value="${esc(o.id)}">${esc(o.nickname)}${o.phone ? ' · ' + esc(formatPhone(o.phone)) : ''} · ${num(o.visit_count)} visits</option>`).join('')}</select>
      <button class="btn btn-outline btn-sm" id="cu-merge-btn">Merge into ${esc(c.nickname)}</button></div>
    <div class="section-title" style="font-size:15px;">Delete on request</div>
    <p class="hint">If the customer asks you to delete their data, this removes their nickname, number and notes for good — also from records merged into this one, from their QR orders and order notes, and from earlier audit-log entries. Their past sales stay (without their name), so your sales totals don't change.</p>
    <button class="btn btn-danger btn-sm" id="cu-delete">Delete this customer's data</button>`,
    foot: `<button class="btn btn-outline" data-cancel>Close</button><button class="btn btn-primary" id="cu-save">Save changes</button>`,
    onMount: (root) => {
      root.querySelector('[data-cancel]').onclick = closeModal;
      root.querySelectorAll('[data-sale]').forEach(tr => tr.onclick = () => openSaleModal(tr.dataset.sale));
      const save = root.querySelector('#cu-save');
      save.onclick = () => busy(save, async () => {
        const nick = root.querySelector('#cu-nick').value.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 30);
        const raw = root.querySelector('#cu-phone').value.trim();
        const phone = raw ? normPhone(raw) : null;
        if(!nick){ toast('Enter a nickname', 'error'); return; }
        if(raw && !phone){ toast('Enter a Philippine mobile number, e.g. 0917 123 4567', 'error'); return; }
        if(phone && CUSTOMERS.some(x => x.id !== c.id && x.phone === phone)){ toast('Another customer already has that number — merge them instead.', 'error'); return; }
        if(await boSave([Ops.update('customers', {id: c.id, nickname: nick, phone, notes: root.querySelector('#cu-notes').value.trim(), updated_at: nowISO()}), Ops.audit('Customer updated', nick, c.id)], {reload: false, success: 'Customer saved'})){
          closeModal(); renderCustomers();
        }
      });
      const mb = root.querySelector('#cu-merge-btn');
      mb.onclick = () => busy(mb, async () => {
        const otherId = root.querySelector('#cu-merge').value;
        if(!otherId){ toast('Choose the duplicate record first', 'error'); return; }
        const o = CUSTOMERS.find(x => x.id === otherId);
        const ok = await confirmDialog(`Merge <b>${esc(o.nickname)}</b> into <b>${esc(c.nickname)}</b>? This cannot be undone.`, 'Merge');
        if(!ok) return;
        try{
          await cloud.rpc('merge_customers', {p_keep: c.id, p_merge: otherId});
          applyChanges([Ops.audit('Customers merged', `${o.nickname} → ${c.nickname}`, c.id)]).catch(() => {});
          toast('Customers merged'); closeModal(); renderCustomers();
        }catch(e){ toast(friendlyError(e), 'error'); }
      }, 'Merging…');
      const del = root.querySelector('#cu-delete');
      del.onclick = () => busy(del, async () => {
        const ok = await confirmDialog(`Delete <b>${esc(c.nickname)}</b>'s data for good? Their name and number are removed from the customer list (with any records merged into it), their QR orders and order notes, and earlier audit-log entries. This cannot be undone.`, 'Delete for good');
        if(!ok) return;
        try{
          const plan = await customerDeletePlan(c);
          if(await boSave(plan.ops, {reload: false, dropSales: true, success: 'Customer data deleted'})){ closeModal(); renderCustomers(); }
        }catch(e){ toast(friendlyError(e), 'error'); }
      }, 'Deleting…');
    }});
}

/* ================= deleting a customer's data (on request) =================
   One all-or-nothing save that:
   - follows merge chains all the way down (records merged into this one, and into those...);
   - unlinks their sales and QR orders, and removes their nickname from the orders and order notes;
   - replaces their nickname in earlier audit-log entries;
   - deletes every record of the chain (deepest first, so no "merged into" link is left dangling). */
const DELETED_CUSTOMER_TEXT = '[deleted customer]';
function nicknameScrubber(names){
  const list = [...new Set(names.map(n => String(n || '').trim()).filter(n => n.length >= 2))].sort((a, b) => b.length - a.length);
  if(!list.length) return (t) => t;
  const rx = new RegExp('(^|[^\\p{L}\\p{N}])(' + list.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')(?=$|[^\\p{L}\\p{N}])', 'giu');
  return (t) => t == null ? t : String(t).replace(rx, (m, pre) => pre + DELETED_CUSTOMER_TEXT);
}
async function customerDeletePlan(c){
  // 1) the whole merge chain
  const chain = [c];
  const seen = new Set([c.id]);
  let frontier = [c.id];
  for(let depth = 0; frontier.length && depth < 50; depth++){
    const next = [];
    for(let i = 0; i < frontier.length; i += 80){
      const rows = await cloud.selectAll('customers', {in: {merged_into: frontier.slice(i, i + 80)}}) || [];
      rows.forEach(r => { if(!seen.has(r.id)){ seen.add(r.id); chain.push(r); next.push(r.id); } });
    }
    frontier = next;
  }
  const ids = chain.map(x => x.id);
  const scrub = nicknameScrubber(chain.map(x => x.nickname));
  // 2) everything linked to any record of the chain
  const orders = [], sales = [];
  for(let i = 0; i < ids.length; i += 80){
    const part = ids.slice(i, i + 80);
    orders.push(...(await cloud.selectAll('qr_orders', {in: {customer_id: part}}) || []));
    sales.push(...(await cloud.selectAll('sales', {in: {customer_id: part}}) || []));
  }
  // 3) audit entries naming them (by link or by nickname)
  const audit = new Map();
  for(let i = 0; i < ids.length; i += 80){
    ((await cloud.selectAll('audit_log', {in: {reference_id: ids.slice(i, i + 80)}})) || []).forEach(r => audit.set(r.id, r));
  }
  for(const n of new Set(chain.map(x => String(x.nickname || '').trim()).filter(n => n.length >= 2))){
    const pat = '*' + n.replace(/[*%,()]/g, '_') + '*';
    ((await cloud.selectAll('audit_log', {ilike: {details: pat}})) || []).forEach(r => audit.set(r.id, r));
  }
  const ops = [];
  orders.forEach(o => {
    const row = {id: o.id, customer_id: null, customer_nickname: null};
    if(o.customer_note) row.customer_note = scrub(o.customer_note);
    if(Array.isArray(o.items) && o.items.some(it => it && it.notes && scrub(it.notes) !== it.notes)){
      row.items = o.items.map(it => it && it.notes ? Object.assign({}, it, {notes: scrub(it.notes)}) : it);
    }
    ops.push(Ops.update('qr_orders', row));
  });
  sales.forEach(s => ops.push(Ops.update('sales', {id: s.id, customer_id: null})));
  let auditChanged = 0;
  audit.forEach(r => {
    const details = scrub(r.details);
    if(details !== r.details){ ops.push(Ops.update('audit_log', {id: r.id, details})); auditChanged++; }
  });
  // deepest records first (a record is deleted before the one it was merged into)
  chain.slice().reverse().forEach(x => ops.push(Ops.del('customers', x.id)));
  const merged = chain.length - 1;
  ops.push(Ops.audit('Customer data deleted on request', `1 customer record${merged ? ' + ' + merged + ' merged record(s)' : ''}; ${plural(orders.length, 'QR order')} and ${plural(sales.length, 'sale')} unlinked; ${plural(auditChanged, 'audit entry', 'audit entries')} cleaned`));
  return {ops, chain, orders, sales, auditChanged};
}
