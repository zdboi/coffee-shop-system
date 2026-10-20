/* =====================================================================
   SALES CALENDAR — Day / Week / Month / Shift views with an hourly sales
   chart, an item-by-hour matrix, and CSV export. Shared by the Back Office
   and the Front Office (managers). Reads only `state` (via the data layer),
   so numbers always match the other reports.
   ===================================================================== */
const CAL = { view: 'month', anchor: null, shiftId: null, lastTable: null, busy: false };
const CAL_COUNTED = ['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'];

(function injectCalendarStyles(){
  if (typeof document === 'undefined' || document.getElementById('cal-styles')) return;
  const css = `
  .cal-toolbar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:16px;}
  .cal-seg{display:inline-flex;background:var(--beige);border-radius:10px;padding:3px;gap:2px;}
  .cal-seg button{border:none;background:transparent;padding:7px 14px;border-radius:8px;font-weight:600;font-size:13.5px;color:var(--text);min-height:36px;}
  .cal-seg button.on{background:var(--white);box-shadow:var(--shadow);}
  .cal-nav{display:inline-flex;align-items:center;gap:6px;}
  .cal-nav .cal-label{font-family:var(--font-display);font-size:18px;font-weight:600;min-width:190px;text-align:center;color:var(--espresso);}
  .cal-spacer{flex:1;}
  .cal-kpis{margin-bottom:16px;}
  .cal-kpis .stat-card .value{font-family:var(--font-body);font-size:24px;}
  .cal-card{margin-bottom:16px;}
  .cal-card h3{font-size:14px;font-weight:700;margin-bottom:2px;color:var(--espresso);}
  .cal-card .cal-sub{font-size:12px;color:var(--text-light);margin-bottom:10px;}
  .cal-svg{width:100%;height:auto;display:block;overflow:visible;}
  .cal-svg text{font-family:var(--font-body);font-size:11px;fill:var(--text-light);}
  .cal-svg .cal-val{fill:var(--text);font-weight:600;}
  .cal-bar{transition:opacity .1s;}
  .cal-hit:hover + .cal-bar, .cal-hit:focus + .cal-bar{opacity:.75;}
  .cal-hit{fill:transparent;cursor:pointer;outline:none;}
  .cal-month{display:grid;grid-template-columns:repeat(7,1fr);gap:4px;}
  .cal-dow{font-size:11px;font-weight:700;color:var(--text-light);text-transform:uppercase;text-align:center;padding:4px 0;}
  .cal-day{border:none;border-radius:8px;min-height:74px;padding:6px 8px;text-align:left;display:flex;flex-direction:column;justify-content:space-between;cursor:pointer;font-family:inherit;}
  .cal-day.out{opacity:.35;}
  .cal-day.today{box-shadow:inset 0 0 0 2px var(--amber);}
  .cal-day .d{font-size:12px;font-weight:700;}
  .cal-day .v{font-size:13px;font-weight:700;}
  .cal-day .n{font-size:11px;opacity:.85;}
  .cal-scale{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--text-light);margin-top:10px;}
  .cal-scale span.sw{width:18px;height:12px;border-radius:3px;display:inline-block;}
  .cal-matrix{overflow-x:auto;}
  .cal-matrix table{border-collapse:separate;border-spacing:2px;width:auto;min-width:100%;}
  .cal-matrix th,.cal-matrix td{padding:5px 7px;font-size:12px;text-align:center;border:none;white-space:nowrap;font-variant-numeric:tabular-nums;}
  .cal-matrix th{color:var(--text-light);font-weight:700;background:transparent;}
  .cal-matrix td.name{text-align:left;font-weight:600;position:sticky;left:0;background:var(--white);}
  .cal-matrix td.tot{font-weight:700;}
  .cal-matrix td.cell{border-radius:4px;min-width:30px;}
  .cal-tip{position:fixed;z-index:900;pointer-events:none;background:var(--espresso-dark);color:var(--cream);padding:8px 10px;border-radius:8px;font-size:12px;box-shadow:var(--shadow);line-height:1.45;max-width:240px;}
  .cal-tip b{font-size:14px;color:#fff;}
  .cal-loading{opacity:.45;pointer-events:none;}
  .cal-empty{padding:26px 0;text-align:center;color:var(--text-light);font-size:13.5px;}
  @media(max-width:700px){.cal-day{min-height:56px;padding:4px;} .cal-day .n{display:none;} .cal-nav .cal-label{min-width:130px;font-size:15px;}}
  `;
  const s = document.createElement('style'); s.id = 'cal-styles'; s.textContent = css; document.head.appendChild(s);
})();

// ---------- small helpers ----------
function calDay(d){ const x = new Date(d); x.setHours(0,0,0,0); return x; }
function calKey(d){ const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,'0')}-${String(x.getDate()).padStart(2,'0')}`; }
function calAddDays(d, n){ const x = new Date(d); x.setDate(x.getDate()+n); return x; }
function calHourLabel(h){ const ap = h<12?'a':'p'; const hh = h%12===0?12:h%12; return hh+ap; }
function calCompact(n){
  n = Number(n)||0;
  if(Math.abs(n) >= 1e6) return '₱'+(n/1e6).toFixed(1).replace(/\.0$/,'')+'M';
  if(Math.abs(n) >= 1e4) return '₱'+(n/1e3).toFixed(1).replace(/\.0$/,'')+'K';
  return '₱'+Math.round(n).toLocaleString('en-PH');
}
function calCssVar(name, fallback){
  try{ const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); return v || fallback; }catch(e){ return fallback; }
}
function calHex(h){ h = String(h).trim().replace('#',''); if(h.length===3) h = h.split('').map(c=>c+c).join(''); const n = parseInt(h,16); return [(n>>16)&255,(n>>8)&255,n&255]; }
function calMix(a, b, t){ const A = calHex(a), B = calHex(b); return '#'+A.map((v,i)=> Math.round(v+(B[i]-v)*t).toString(16).padStart(2,'0')).join(''); }
function calLum(hex){ const [r,g,b] = calHex(hex).map(v=>{ v/=255; return v<=0.03928? v/12.92 : Math.pow((v+0.055)/1.055,2.4); }); return 0.2126*r+0.7152*g+0.0722*b; }
// sequential ramp: one hue (the shop's secondary colour) from the card colour to full strength
function calShade(t){
  const card = calCssVar('--white', '#fffdf9'), hue = calCssVar('--green', '#33513f');
  if(!(t>0)) return {bg: calMix(card, calCssVar('--beige','#e9dcc4'), 0.35), fg: calCssVar('--text','#2c1e14')};
  const bg = calMix(card, hue, 0.12 + 0.78*Math.min(1,t));
  return {bg, fg: calLum(bg) < 0.32 ? '#ffffff' : calCssVar('--text','#2c1e14')};
}
function calNiceMax(v){
  if(v<=0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v))); const f = v/p;
  return (f<=1?1: f<=2?2: f<=2.5?2.5: f<=5?5: 10)*p;
}

// ---------- the numbers ----------
function calSalesBetween(fromMs, toMs){
  return state.sales.filter(s=>{
    if(!CAL_COUNTED.includes(s.status)) return false;
    const t = new Date(s.transaction_date).getTime();
    return t>=fromMs && t<toMs;
  });
}
function calRefundsBetween(fromMs, toMs){
  return state.refunds.filter(r=> r.type!=='VOID' && (()=>{ const t = new Date(r.date).getTime(); return t>=fromMs && t<toMs; })());
}
function calSummary(sales, refunds){
  const gross = sales.reduce((s,x)=> s + Number(x.grand_total||0), 0);
  const ref = (refunds||[]).reduce((s,r)=> s + Number(r.amount||0), 0);
  const ids = new Set(sales.map(s=>s.id));
  const items = state.saleItems.filter(i=> ids.has(i.saleId)).reduce((s,i)=> s + Number(i.quantity||0), 0);
  const qr = sales.filter(s=> s.order_id).length;
  return {gross, refunds: ref, net: gross - ref, count: sales.length, avg: sales.length? gross/sales.length : 0, items, qr};
}
function calByHour(sales){
  const hours = Array.from({length:24}, (_,h)=>({h, total:0, count:0}));
  sales.forEach(s=>{ const h = new Date(s.transaction_date).getHours(); hours[h].total += Number(s.grand_total||0); hours[h].count++; });
  return hours;
}
function calHourRange(hours){
  const used = hours.filter(x=>x.count>0).map(x=>x.h);
  let lo = used.length? Math.min(...used) : 7, hi = used.length? Math.max(...used) : 20;
  lo = Math.min(lo, 7); hi = Math.max(hi, 20);
  return [lo, hi];
}
function calItemMatrix(sales){
  const saleHour = new Map(sales.map(s=>[s.id, new Date(s.transaction_date).getHours()]));
  const rows = new Map();
  state.saleItems.forEach(i=>{
    if(!saleHour.has(i.saleId)) return;
    const h = saleHour.get(i.saleId);
    const r = rows.get(i.name) || {name:i.name, total:0, revenue:0, hours:{}};
    r.total += Number(i.quantity||0); r.revenue += Number(i.line_total||0);
    r.hours[h] = (r.hours[h]||0) + Number(i.quantity||0);
    rows.set(i.name, r);
  });
  return [...rows.values()].sort((a,b)=> b.total - a.total);
}

// ---------- tooltip ----------
let calTipEl = null;
function calTip(html, ev){
  if(!calTipEl){ calTipEl = document.createElement('div'); calTipEl.className = 'cal-tip'; document.body.appendChild(calTipEl); }
  if(!html){ calTipEl.style.display='none'; return; }
  calTipEl.innerHTML = html; calTipEl.style.display='block';
  const r = ev && ev.target && ev.target.getBoundingClientRect ? ev.target.getBoundingClientRect() : null;
  let x = ev && ev.clientX!=null ? ev.clientX : (r? r.left + r.width/2 : 0);
  let y = ev && ev.clientY!=null ? ev.clientY : (r? r.top : 0);
  const w = calTipEl.offsetWidth, h = calTipEl.offsetHeight;
  x = Math.min(window.innerWidth - w - 8, Math.max(8, x + 12));
  y = Math.max(8, y - h - 12);
  calTipEl.style.left = x+'px'; calTipEl.style.top = y+'px';
}
function calWireTips(root){
  root.querySelectorAll('[data-tip]').forEach(el=>{
    const show = (ev)=> calTip(el.getAttribute('data-tip'), ev);
    el.addEventListener('pointermove', show);
    el.addEventListener('focus', show);
    el.addEventListener('pointerleave', ()=> calTip(null));
    el.addEventListener('blur', ()=> calTip(null));
  });
}
const calAttr = (s)=> String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');

// ---------- charts ----------
// Single-series column chart (one colour, thin bars, rounded tops, hairline grid).
function calColumns(points, {height=220, labelEvery=1, valueFmt=fmtMoney, tipTitle}={}){
  if(!points.length) return '';
  const W = 760, H = height, padL = 52, padR = 8, padT = 22, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const max = calNiceMax(Math.max(...points.map(p=>p.value), 0));
  const slot = plotW / points.length;
  const barW = Math.min(24, Math.max(4, slot*0.62));
  const hue = calCssVar('--green', '#33513f'), grid = calCssVar('--beige', '#e9dcc4');
  const ticks = [0, max/2, max];
  const peak = points.reduce((a,b)=> b.value > a.value ? b : a, points[0]);
  let svg = `<svg class="cal-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${calAttr(tipTitle||'chart')}">`;
  ticks.forEach(t=>{
    const y = padT + plotH - (t/max)*plotH;
    svg += `<line x1="${padL}" x2="${W-padR}" y1="${y}" y2="${y}" stroke="${grid}" stroke-width="1"/>`;
    svg += `<text x="${padL-8}" y="${y+4}" text-anchor="end">${calCompact(t)}</text>`;
  });
  points.forEach((p,i)=>{
    const cx = padL + slot*i + slot/2;
    const h = max>0 ? (p.value/max)*plotH : 0;
    const x = cx - barW/2, y = padT + plotH - h;
    const r = Math.min(4, h/2, barW/2);
    const tip = `<b>${calAttr(valueFmt(p.value))}</b><br>${calAttr(p.label)}${p.sub?'<br>'+calAttr(p.sub):''}`;
    svg += `<rect class="cal-hit" x="${padL+slot*i}" y="${padT}" width="${slot}" height="${plotH}" tabindex="0" data-tip="${calAttr(tip)}" ${p.key?`data-key="${p.key}"`:''}/>`;
    if(h>0) svg += `<path class="cal-bar" pointer-events="none" fill="${hue}" d="M${x},${padT+plotH} L${x},${y+r} Q${x},${y} ${x+r},${y} L${x+barW-r},${y} Q${x+barW},${y} ${x+barW},${y+r} L${x+barW},${padT+plotH} Z"/>`;
    if(i % labelEvery === 0) svg += `<text x="${cx}" y="${H-8}" text-anchor="middle">${calAttr(p.short||p.label)}</text>`;
    if(p===peak && p.value>0) svg += `<text class="cal-val" x="${cx}" y="${y-6}" text-anchor="middle">${calAttr(calCompact(p.value))}</text>`;
  });
  svg += `<line x1="${padL}" x2="${W-padR}" y1="${padT+plotH}" y2="${padT+plotH}" stroke="${calMix(grid, calCssVar('--text','#2c1e14'), 0.25)}" stroke-width="1"/>`;
  return svg + '</svg>';
}

function calMatrixHtml(rows, hours, {limit=40}={}){
  if(!rows.length) return `<div class="cal-empty">No items sold in this period.</div>`;
  const max = Math.max(1, ...rows.flatMap(r=> hours.map(h=> r.hours[h]||0)));
  const shown = rows.slice(0, limit);
  const colTotals = hours.map(h=> rows.reduce((s,r)=> s + (r.hours[h]||0), 0));
  let html = `<div class="cal-matrix"><table><thead><tr><th style="text-align:left;">Item</th>${hours.map(h=>`<th>${calHourLabel(h)}</th>`).join('')}<th>Total</th></tr></thead><tbody>`;
  shown.forEach(r=>{
    html += `<tr><td class="name">${escapeHtml(r.name)}</td>`;
    hours.forEach(h=>{
      const v = r.hours[h]||0;
      const sh = calShade(v/max);
      html += `<td class="cell" style="background:${v?sh.bg:'transparent'};color:${v?sh.fg:'var(--text-light)'}" ${v?`data-tip="${calAttr(`<b>${v} sold</b><br>${escapeHtml(r.name)} · ${calHourLabel(h)}–${calHourLabel((h+1)%24)}`)}"`:''}>${v||'·'}</td>`;
    });
    html += `<td class="tot">${r.total}</td></tr>`;
  });
  html += `<tr><td class="name">All items</td>${colTotals.map(v=>`<td class="tot">${v||'·'}</td>`).join('')}<td class="tot">${colTotals.reduce((a,b)=>a+b,0)}</td></tr>`;
  html += `</tbody></table></div>`;
  if(rows.length > limit) html += `<div class="cal-sub" style="margin-top:6px;">Showing the top ${limit} of ${rows.length} items. The CSV export has all of them.</div>`;
  return html;
}

function calKpis(sum){
  return `<div class="grid grid-4 cal-kpis">
    ${statCard('Net sales', fmtMoney(sum.net), sum.refunds>0 ? `${fmtMoney(sum.gross)} before ${fmtMoney(sum.refunds)} refunds` : 'after refunds')}
    ${statCard('Transactions', sum.count.toLocaleString(), sum.qr ? `${sum.qr} from QR orders` : '')}
    ${statCard('Average ticket', fmtMoney(sum.avg), '')}
    ${statCard('Items sold', sum.items.toLocaleString(), '')}
  </div>`;
}

// ---------- range for the current view ----------
function calRange(){
  const a = calDay(CAL.anchor || new Date());
  if(CAL.view==='day') return {from:a, to:calAddDays(a,1), label: a.toLocaleDateString('en-PH',{weekday:'short', month:'short', day:'numeric', year:'numeric'})};
  if(CAL.view==='week'){
    const start = calAddDays(a, -a.getDay());
    const end = calAddDays(start, 7);
    return {from:start, to:end, label: `${start.toLocaleDateString('en-PH',{month:'short',day:'numeric'})} – ${calAddDays(end,-1).toLocaleDateString('en-PH',{month:'short',day:'numeric', year:'numeric'})}`};
  }
  if(CAL.view==='month'){
    const start = new Date(a.getFullYear(), a.getMonth(), 1);
    const end = new Date(a.getFullYear(), a.getMonth()+1, 1);
    return {from:start, to:end, label: start.toLocaleDateString('en-PH',{month:'long', year:'numeric'})};
  }
  // shift view: the month around the anchor, for choosing shifts
  const start = new Date(a.getFullYear(), a.getMonth(), 1);
  return {from:start, to:new Date(a.getFullYear(), a.getMonth()+1, 1), label: start.toLocaleDateString('en-PH',{month:'long', year:'numeric'})};
}

// ---------- main render ----------
async function renderSalesCalendar(container){
  if(!CAL.anchor) CAL.anchor = new Date();
  const range = calRange();
  container.innerHTML = `
    <div class="cal">
      <div class="cal-toolbar">
        <div class="cal-seg" role="tablist">${['day','week','month','shift'].map(v=>`<button data-view="${v}" class="${CAL.view===v?'on':''}" role="tab" aria-selected="${CAL.view===v}">${v[0].toUpperCase()+v.slice(1)}</button>`).join('')}</div>
        <div class="cal-nav">
          <button class="btn btn-outline btn-sm" id="cal-prev" aria-label="Previous">◀</button>
          <span class="cal-label">${escapeHtml(range.label)}</span>
          <button class="btn btn-outline btn-sm" id="cal-next" aria-label="Next">▶</button>
          <button class="btn btn-ghost btn-sm" id="cal-today">Today</button>
        </div>
        <div class="cal-spacer"></div>
        <button class="btn btn-outline btn-sm" id="cal-export">Export CSV</button>
      </div>
      <div id="cal-body"><div class="cal-empty">Loading…</div></div>
    </div>`;
  container.querySelectorAll('[data-view]').forEach(b=> b.onclick = ()=>{ CAL.view = b.dataset.view; renderSalesCalendar(container); });
  const step = (dir)=>{
    const a = new Date(CAL.anchor);
    if(CAL.view==='day') a.setDate(a.getDate()+dir);
    else if(CAL.view==='week') a.setDate(a.getDate()+7*dir);
    else a.setMonth(a.getMonth()+dir, 1);
    CAL.anchor = a; renderSalesCalendar(container);
  };
  container.querySelector('#cal-prev').onclick = ()=> step(-1);
  container.querySelector('#cal-next').onclick = ()=> step(1);
  container.querySelector('#cal-today').onclick = ()=>{ CAL.anchor = new Date(); renderSalesCalendar(container); };
  container.querySelector('#cal-export').onclick = calExportCSV;

  const body = container.querySelector('#cal-body');
  // make sure older history is loaded for this range
  try{
    if(typeof Data!=='undefined' && Data.loadedFrom && range.from.toISOString() < Data.loadedFrom){
      body.innerHTML = `<div class="cal-empty">Loading older sales from the database…</div>`;
      await Data.ensureRange(range.from);
    }
  }catch(e){
    body.innerHTML = `<div class="cal-empty">${escapeHtml(friendlyError(e))}</div>`;
    return;
  }
  if(CAL.view==='month') calRenderMonth(body, range);
  else if(CAL.view==='week') calRenderWeek(body, range);
  else if(CAL.view==='day') calRenderDay(body, range);
  else calRenderShift(body, range);
  calWireTips(body);
  body.querySelectorAll('[data-day]').forEach(el=> el.addEventListener('click', ()=>{ CAL.anchor = new Date(el.dataset.day+'T12:00:00'); CAL.view='day'; calTip(null); renderSalesCalendar(container); }));
  body.querySelectorAll('[data-key]').forEach(el=> el.addEventListener('click', ()=>{ CAL.anchor = new Date(el.dataset.key+'T12:00:00'); CAL.view='day'; calTip(null); renderSalesCalendar(container); }));
}

function calRenderMonth(body, range){
  const sales = calSalesBetween(range.from.getTime(), range.to.getTime());
  const refunds = calRefundsBetween(range.from.getTime(), range.to.getTime());
  const byDay = {};
  sales.forEach(s=>{ const k = calKey(s.transaction_date); (byDay[k] = byDay[k] || {gross:0,count:0,ref:0}); byDay[k].gross += Number(s.grand_total||0); byDay[k].count++; });
  refunds.forEach(r=>{ const k = calKey(r.date); (byDay[k] = byDay[k] || {gross:0,count:0,ref:0}); byDay[k].ref += Number(r.amount||0); });
  const max = Math.max(0, ...Object.values(byDay).map(d=> d.gross - d.ref));
  const sum = calSummary(sales, refunds);
  const best = Object.entries(byDay).sort((a,b)=> (b[1].gross-b[1].ref) - (a[1].gross-a[1].ref))[0];
  const start = calAddDays(range.from, -range.from.getDay());
  const todayKey = calKey(new Date());
  let cells = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d=>`<div class="cal-dow">${d}</div>`).join('');
  const rows = [];
  for(let d = new Date(start); d < range.to || d.getDay()!==0; d = calAddDays(d,1)){
    const k = calKey(d), v = byDay[k];
    const inMonth = d.getMonth()===range.from.getMonth();
    const net = v ? v.gross - v.ref : 0;
    const sh = calShade(max>0 ? net/max : 0);
    const tip = v ? `<b>${fmtMoney(net)}</b><br>${d.toLocaleDateString('en-PH',{weekday:'long', month:'short', day:'numeric'})}<br>${v.count} transaction${v.count===1?'':'s'}${v.ref?`<br>${fmtMoney(v.ref)} refunded`:''}` : `<b>No sales</b><br>${d.toLocaleDateString('en-PH',{weekday:'long', month:'short', day:'numeric'})}`;
    cells += `<button class="cal-day ${inMonth?'':'out'} ${k===todayKey?'today':''}" style="background:${sh.bg};color:${sh.fg}" data-day="${k}" data-tip="${calAttr(tip)}" aria-label="${calAttr(k+': '+fmtMoney(net))}">
      <span class="d">${d.getDate()}</span>${v?`<span><span class="v">${calCompact(net)}</span><br><span class="n">${v.count} txn</span></span>`:''}</button>`;
    if(inMonth) rows.push([k, v?v.count:0, v?v.gross.toFixed(2):'0.00', v?v.ref.toFixed(2):'0.00', net.toFixed(2)]);
    if(d.getDay()===6 && d >= range.to) break;
  }
  CAL.lastTable = {name:'daily', headers:['Date','Transactions','Gross','Refunds','Net'], rows};
  body.innerHTML = `${calKpis(sum)}
    <div class="card cal-card">
      <h3>Daily sales</h3>
      <div class="cal-sub">${best ? `Best day: ${new Date(best[0]+'T12:00:00').toLocaleDateString('en-PH',{weekday:'long', month:'short', day:'numeric'})} (${fmtMoney(best[1].gross-best[1].ref)}). ` : ''}Darker = more sales. Tap a day for its hourly view.</div>
      <div class="cal-month">${cells}</div>
      <div class="cal-scale">Less ${[0,0.25,0.5,0.75,1].map(t=>`<span class="sw" style="background:${calShade(t||0.0001).bg}"></span>`).join('')} More</div>
    </div>`;
}

function calRenderWeek(body, range){
  const sales = calSalesBetween(range.from.getTime(), range.to.getTime());
  const refunds = calRefundsBetween(range.from.getTime(), range.to.getTime());
  const sum = calSummary(sales, refunds);
  const days = Array.from({length:7}, (_,i)=> calAddDays(range.from, i));
  const points = days.map(d=>{
    const k = calKey(d);
    const ds = sales.filter(s=> calKey(s.transaction_date)===k);
    const dr = refunds.filter(r=> calKey(r.date)===k).reduce((s,r)=> s+Number(r.amount||0), 0);
    const v = ds.reduce((s,x)=> s+Number(x.grand_total||0), 0) - dr;
    return {key:k, value:v, label:d.toLocaleDateString('en-PH',{weekday:'long', month:'short', day:'numeric'}), short:d.toLocaleDateString('en-PH',{weekday:'short'}), sub:`${ds.length} transaction${ds.length===1?'':'s'}`};
  });
  // hour × day heat table
  const grid = {}; let max = 0;
  sales.forEach(s=>{ const k = calKey(s.transaction_date), h = new Date(s.transaction_date).getHours(); grid[k+'|'+h] = (grid[k+'|'+h]||0) + Number(s.grand_total||0); max = Math.max(max, grid[k+'|'+h]); });
  const [lo, hi] = calHourRange(calByHour(sales));
  const hours = []; for(let h=lo; h<=hi; h++) hours.push(h);
  let heat = `<div class="cal-matrix"><table><thead><tr><th></th>${days.map(d=>`<th>${d.toLocaleDateString('en-PH',{weekday:'short', day:'numeric'})}</th>`).join('')}</tr></thead><tbody>`;
  const rows = [];
  hours.forEach(h=>{
    heat += `<tr><th style="text-align:right;">${calHourLabel(h)}</th>`;
    const row = [calHourLabel(h)];
    days.forEach(d=>{
      const k = calKey(d), v = grid[k+'|'+h]||0, sh = calShade(max>0? v/max : 0);
      heat += `<td class="cell" style="background:${v?sh.bg:'transparent'};color:${v?sh.fg:'var(--text-light)'}" ${v?`data-tip="${calAttr(`<b>${fmtMoney(v)}</b><br>${d.toLocaleDateString('en-PH',{weekday:'short', month:'short', day:'numeric'})} · ${calHourLabel(h)}–${calHourLabel((h+1)%24)}`)}"`:''}>${v?calCompact(v):'·'}</td>`;
      row.push(v.toFixed(2));
    });
    heat += `</tr>`; rows.push(row);
  });
  heat += `</tbody></table></div>`;
  CAL.lastTable = {name:'week-by-hour', headers:['Hour', ...days.map(calKey)], rows};
  body.innerHTML = `${calKpis(sum)}
    <div class="card cal-card"><h3>Net sales by day</h3><div class="cal-sub">Tap a day for its hourly view.</div>${calColumns(points, {height:200, tipTitle:'Net sales by day'})}</div>
    <div class="card cal-card"><h3>Busiest hours this week</h3><div class="cal-sub">Sales by hour and day. Darker = busier. Useful for planning staff.</div>${sales.length? heat : '<div class="cal-empty">No sales this week.</div>'}</div>`;
}

function calDayDetail(sales, refunds, titleSuffix){
  const sum = calSummary(sales, refunds);
  const byHour = calByHour(sales);
  const [lo, hi] = calHourRange(byHour);
  const hours = []; for(let h=lo; h<=hi; h++) hours.push(h);
  const points = hours.map(h=>({value: byHour[h].total, label:`${calHourLabel(h)}–${calHourLabel((h+1)%24)}`, short: calHourLabel(h), sub:`${byHour[h].count} transaction${byHour[h].count===1?'':'s'}`}));
  const matrix = calItemMatrix(sales);
  const pay = {};
  sales.forEach(s=>{ const m = paymentMethodForSale(s.id) || '—'; pay[m] = pay[m] || {n:0,total:0}; pay[m].n++; pay[m].total += Number(s.grand_total||0); });
  const peak = byHour.reduce((a,b)=> b.total>a.total? b : a, byHour[0]);
  CAL.lastTable = {name:'items-by-hour'+(titleSuffix||''), headers:['Item', ...hours.map(calHourLabel), 'Total qty', 'Revenue'],
    rows: matrix.map(r=> [r.name, ...hours.map(h=> r.hours[h]||0), r.total, r.revenue.toFixed(2)])};
  return `${calKpis(sum)}
    <div class="card cal-card"><h3>Sales by hour</h3><div class="cal-sub">${peak.total>0 ? `Busiest hour: ${calHourLabel(peak.h)}–${calHourLabel((peak.h+1)%24)} (${fmtMoney(peak.total)}, ${peak.count} transactions).` : 'No sales yet.'}</div>${calColumns(points, {tipTitle:'Sales by hour'})}</div>
    <div class="card cal-card"><h3>Items by hour</h3><div class="cal-sub">How many of each item sold in each hour (before refunds).</div>${calMatrixHtml(matrix, hours)}</div>
    <div class="card cal-card"><h3>Payment methods</h3>${Object.keys(pay).length ? `<div class="table-wrap" style="box-shadow:none;"><table><thead><tr><th>Method</th><th>Transactions</th><th>Total</th></tr></thead><tbody>${Object.entries(pay).sort((a,b)=>b[1].total-a[1].total).map(([m,v])=>`<tr><td>${escapeHtml(m)}</td><td>${v.n}</td><td>${fmtMoney(v.total)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="cal-empty">No payments.</div>'}</div>`;
}

function calRenderDay(body, range){
  const sales = calSalesBetween(range.from.getTime(), range.to.getTime());
  const refunds = calRefundsBetween(range.from.getTime(), range.to.getTime());
  const shifts = state.shifts.filter(s=>{ const o = new Date(s.opened_at).getTime(); return o>=range.from.getTime() && o<range.to.getTime(); });
  body.innerHTML = calDayDetail(sales, refunds, '-'+calKey(range.from)) +
    (shifts.length ? `<div class="card cal-card"><h3>Shifts that day</h3><div class="table-wrap" style="box-shadow:none;"><table><thead><tr><th>Shift</th><th>Cashier</th><th>Opened</th><th>Closed</th><th>Net sales</th><th>Cash variance</th><th></th></tr></thead><tbody>
      ${shifts.map(s=>`<tr><td>${escapeHtml(s.shift_number||'')}</td><td>${escapeHtml(s.cashier_name||'')}</td><td>${new Date(s.opened_at).toLocaleTimeString('en-PH',{hour:'numeric',minute:'2-digit'})}</td><td>${s.closed_at?new Date(s.closed_at).toLocaleTimeString('en-PH',{hour:'numeric',minute:'2-digit'}):'<span class="badge badge-green">Open</span>'}</td><td>${fmtMoney(shiftMetrics(s).netSales)}</td><td>${s.status==='CLOSED'?fmtMoney(s.cash_variance):'—'}</td><td><button class="btn btn-ghost btn-sm" data-open-shift="${s.id}">View</button></td></tr>`).join('')}
      </tbody></table></div></div>` : '');
  body.querySelectorAll('[data-open-shift]').forEach(b=> b.onclick = ()=>{ CAL.shiftId = b.dataset.openShift; CAL.view = 'shift'; renderSalesCalendar(body.closest('.cal').parentElement); });
}

function calRenderShift(body, range){
  const shifts = state.shifts.filter(s=>{ const o = new Date(s.opened_at).getTime(); return o>=range.from.getTime() && o<range.to.getTime(); })
    .sort((a,b)=> new Date(b.opened_at) - new Date(a.opened_at));
  if(CAL.shiftId && !shifts.some(s=>s.id===CAL.shiftId)){
    const s = state.shifts.find(x=>x.id===CAL.shiftId); if(s) shifts.unshift(s);
  }
  if(!shifts.length){ body.innerHTML = `<div class="card"><div class="cal-empty">No shifts in ${escapeHtml(range.label)}. Use ◀ ▶ to pick another month.</div></div>`; return; }
  const shift = shifts.find(s=>s.id===CAL.shiftId) || shifts[0];
  CAL.shiftId = shift.id;
  const m = shiftMetrics(shift);
  const sales = state.sales.filter(s=> s.shift_id===shift.id && CAL_COUNTED.includes(s.status));
  const refunds = state.refunds.filter(r=> r.shift_id===shift.id && r.type!=='VOID');
  body.innerHTML = `
    <div class="toolbar" style="margin-bottom:12px;"><div class="toolbar-left">
      <select class="filter" id="cal-shift-pick">${shifts.map(s=>`<option value="${s.id}" ${s.id===shift.id?'selected':''}>${escapeHtml(s.shift_number||'Shift')} · ${escapeHtml(s.cashier_name||'')} · ${fmtDate(s.opened_at)}${s.status==='ACTIVE'?' (open)':''}</option>`).join('')}</select>
    </div></div>
    <div class="grid grid-4 cal-kpis">
      ${statCard('Opened', new Date(shift.opened_at).toLocaleString('en-PH',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}), shift.closed_at ? 'closed '+new Date(shift.closed_at).toLocaleTimeString('en-PH',{hour:'numeric',minute:'2-digit'}) : 'still open')}
      ${statCard('Expected cash', fmtMoney(m.expectedCash), `opening ${fmtMoney(m.openingCash)}`)}
      ${statCard('Declared cash', shift.status==='CLOSED'? fmtMoney(shift.declared_cash) : '—', '')}
      ${statCard('Cash variance', shift.status==='CLOSED'? (shift.cash_variance>=0?'+':'')+fmtMoney(shift.cash_variance) : '—', shift.status==='CLOSED' ? (Math.abs(shift.cash_variance)<0.005?'balanced':(shift.cash_variance>0?'over':'short')) : '')}
    </div>
    ${calDayDetail(sales, refunds, '-'+(shift.shift_number||'shift'))}`;
  body.querySelector('#cal-shift-pick').onchange = (e)=>{ CAL.shiftId = e.target.value; calRenderShift(body, range); calWireTips(body); };
}

function calExportCSV(){
  const t = CAL.lastTable;
  if(!t || !t.rows.length){ toast('Nothing to export for this view', 'warn'); return; }
  const esc = (c)=> `"${String(c).replace(/"/g,'""')}"`;
  const csv = [t.headers.map(esc).join(','), ...t.rows.map(r=> r.map(esc).join(','))].join('\n');
  downloadFile(`${fileNameSlug()}-calendar-${CAL.view}-${t.name}.csv`, csv, 'text/csv');
  toast('Calendar exported as CSV');
}
