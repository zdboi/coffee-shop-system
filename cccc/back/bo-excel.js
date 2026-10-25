/* =====================================================================
   BACK OFFICE — recipes from / to Excel (owner request #5, 2026-10-25).
   * A small .xlsx reader and writer of our own (on top of JSZip, which is
     loaded only when an Excel button is clicked, from ../shared/vendor/).
     Reads shared strings, inline strings, numbers, booleans and the SAVED
     value of formula cells (formulas are never worked out here).
   * Import: one sheet = one recipe, in the owner's costing layout
       A2 "menu name" · header row  item | UOM | Unit price | quantity | Amount [| unit]
       lines … "yield" · "total cost" · "mark up" · "selling price" (+ bottle, cup + ice …)
     A preview (nothing saved yet) lets the owner check every sheet and every
     ingredient; then ONE apply_changes call saves it all (or nothing).
   * Export: the same layout (so the file can be imported again), plus a first
     "Ingredients" sheet.
   Every cell of a file is untrusted: all text shown goes through esc(), every
   write goes through apply_changes, and file / sheet sizes are capped.
   ===================================================================== */

const XL_LIMITS = {files: 10, fileBytes: 5 * 1024 * 1024, sheets: 200, rows: 500, xmlBytes: 20 * 1024 * 1024, totalXmlBytes: 60 * 1024 * 1024, cellsPerSheet: 20000};
const XL_JSZIP_SRC = '../shared/vendor/jszip.min.js';
let xlJsZipPromise = null;

// Loads JSZip once, from our own copy (never another site).
function loadJSZip(){
  if(window.JSZip) return Promise.resolve(window.JSZip);
  if(xlJsZipPromise) return xlJsZipPromise;
  xlJsZipPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = XL_JSZIP_SRC;
    s.async = true;
    s.onload = () => window.JSZip ? resolve(window.JSZip) : reject(new Error('XL_LOAD'));
    s.onerror = () => { s.remove(); reject(new Error('XL_LOAD')); };
    document.head.appendChild(s);
  }).catch(e => { xlJsZipPromise = null; throw e; });
  return xlJsZipPromise;
}
const XL_LOAD_TEXT = 'The Excel tool could not be loaded. Check the internet connection, reload the page and try again.';

/* ================= .xlsx reader ================= */
function xlColIndex(letters){ let n = 0; for(const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64); return n; }
function xlColName(n){ let s = ''; while(n > 0){ const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
function xlChildren(node, name){ return [...(node ? node.childNodes : [])].filter(n => n.nodeType === 1 && n.localName === name); }
function xlChild(node, name){ return xlChildren(node, name)[0] || null; }
// The text of a shared / inline string: its <t> parts, without phonetic hints (<rPh>).
function xlStringText(node){
  if(!node) return '';
  let out = '';
  for(const c of node.childNodes){
    if(c.nodeType !== 1) continue;
    if(c.localName === 't') out += c.textContent;
    else if(c.localName === 'r') out += xlStringText(c);
  }
  return out;
}
function xlParseXml(text){
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if(doc.getElementsByTagName('parsererror').length) throw new Error('XL_BAD');
  return doc;
}
class XlError extends Error {}

// Unpacks one part of the file as a stream, counting the bytes really produced (the size a
// file CLAIMS can be false), and stops as soon as it passes the limit, so a "zip bomb" can't
// fill the memory or freeze the tab.
function xlReadLimited(f, limit){
  return new Promise((resolve, reject) => {
    const parts = [];
    let n = 0, done = false;
    let st;
    try{ st = f.internalStream('uint8array'); }catch(e){ reject(e); return; }
    st.on('data', (chunk) => {
      if(done) return;
      n += chunk.length;
      if(n > limit){ done = true; try{ st.pause(); }catch(e){} parts.length = 0; reject(new XlError('too-big')); return; }
      parts.push(chunk);
    }).on('error', (e) => { if(!done){ done = true; reject(e); } })
      .on('end', () => {
        if(done) return;
        done = true;
        const all = new Uint8Array(n);
        let o = 0;
        parts.forEach(p => { all.set(p, o); o += p.length; });
        resolve(new TextDecoder('utf-8').decode(all));
      }).resume();
  });
}
async function xlEntryText(zip, path, budget){
  const f = zip.file(path);
  if(!f) return null;
  const declared = f._data && Number(f._data.uncompressedSize);
  if(declared && declared > XL_LIMITS.xmlBytes) throw new XlError('too-big');
  const left = Math.min(XL_LIMITS.xmlBytes, XL_LIMITS.totalXmlBytes - budget.used);
  if(left <= 0) throw new XlError('too-big');
  const text = await xlReadLimited(f, left);
  budget.used += text.length;
  return text;
}
function xlResolveTarget(target){
  let t = String(target || '');
  if(t.startsWith('/')) return t.slice(1);
  const parts = ('xl/' + t).split('/'), out = [];
  parts.forEach(p => { if(p === '..') out.pop(); else if(p && p !== '.') out.push(p); });
  return out.join('/');
}

// ArrayBuffer -> {sheets: [{name, cells: Map("r,c" -> value), rowCount, maxRow, maxCol}]}
async function readXlsx(JSZip, buf, fileName){
  let zip;
  try{ zip = await JSZip.loadAsync(buf); }
  catch(e){ throw new XlError(`"${fileName}" is not an Excel (.xlsx) file, or it is damaged.`); }
  const budget = {used: 0};
  try{
    const wbText = await xlEntryText(zip, 'xl/workbook.xml', budget);
    if(!wbText) throw new XlError(`"${fileName}" is not an Excel (.xlsx) file.`);
    const wb = xlParseXml(wbText);
    const relsText = await xlEntryText(zip, 'xl/_rels/workbook.xml.rels', budget);
    const rels = {};
    if(relsText) [...xlParseXml(relsText).getElementsByTagNameNS('*', 'Relationship')].forEach(r => { rels[r.getAttribute('Id')] = r.getAttribute('Target'); });
    const sheetNodes = [...wb.getElementsByTagNameNS('*', 'sheet')];
    if(sheetNodes.length > XL_LIMITS.sheets) throw new XlError(`"${fileName}" has ${sheetNodes.length} sheets. The most that can be read at once is ${XL_LIMITS.sheets}; split it into smaller files.`);
    const sstText = await xlEntryText(zip, 'xl/sharedStrings.xml', budget);
    const sst = sstText ? [...xlParseXml(sstText).getElementsByTagNameNS('*', 'si')].map(xlStringText) : [];
    const sheets = [];
    for(let i = 0; i < sheetNodes.length; i++){
      const sn = sheetNodes[i];
      const name = sn.getAttribute('name') || ('Sheet' + (i + 1));
      const rid = sn.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') || sn.getAttribute('r:id');
      const path = rels[rid] ? xlResolveTarget(rels[rid]) : `xl/worksheets/sheet${i + 1}.xml`;
      const text = await xlEntryText(zip, path, budget);
      const cells = new Map(), rowsWithValues = new Set();
      let maxRow = 0, maxCol = 0, count = 0;
      if(text){
        const doc = xlParseXml(text);
        let rowNo = 0;
        for(const row of doc.getElementsByTagNameNS('*', 'row')){
          rowNo = Number(row.getAttribute('r')) || rowNo + 1;
          let colNo = 0;
          for(const c of xlChildren(row, 'c')){
            const ref = /^([A-Z]+)(\d+)$/.exec(c.getAttribute('r') || '');
            colNo = ref ? xlColIndex(ref[1]) : colNo + 1;
            const r = ref ? Number(ref[2]) : rowNo;
            const t = c.getAttribute('t') || 'n';
            const v = xlChild(c, 'v');
            let val = null;
            if(t === 's'){ const k = v ? Number(v.textContent) : NaN; val = isFinite(k) && sst[k] != null ? sst[k] : null; }
            else if(t === 'inlineStr') val = xlStringText(xlChild(c, 'is'));
            else if(t === 'b') val = v ? v.textContent.trim() === '1' : null;
            else if(t === 'e') val = null;
            else if(t === 'str' || t === 'd') val = v ? v.textContent : null;
            else if(v && v.textContent.trim() !== ''){ const n = Number(v.textContent); val = isFinite(n) ? n : null; }
            if(val === null || val === '') continue;
            if(++count > XL_LIMITS.cellsPerSheet) throw new XlError(`The sheet "${name}" in "${fileName}" has too many filled cells to read.`);
            cells.set(r + ',' + colNo, val);
            rowsWithValues.add(r);
            if(r > maxRow) maxRow = r;
            if(colNo > maxCol) maxCol = colNo;
          }
        }
      }
      if(rowsWithValues.size > XL_LIMITS.rows) throw new XlError(`The sheet "${name}" in "${fileName}" has more than ${XL_LIMITS.rows} filled rows. The most that can be read is ${XL_LIMITS.rows} rows per sheet.`);
      sheets.push({name, cells, rowCount: rowsWithValues.size, maxRow, maxCol});
    }
    return {sheets};
  }catch(e){
    if(e instanceof XlError){
      if(e.message === 'too-big') throw new XlError(`"${fileName}" is too large inside to read safely. Save a smaller copy (fewer sheets) and try again.`);
      throw e;
    }
    throw new XlError(`"${fileName}" could not be read. Open it in Excel, save it again as an Excel Workbook (.xlsx) and try again.`);
  }
}

/* ================= .xlsx writer ================= */
function xlXmlText(s){
  return String(s == null ? '' : s)
    .replace(/[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/gu, '')
    .replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
}
// A cell for the writer: null | number | boolean | string (always TEXT, never a formula)
// | {f: 'D6/C6*E6', v: 12.5} (a formula WE wrote, with its saved value) | {text, bold: true}
function xlCellXml(ref, cell){
  if(cell == null || cell === '') return '';
  if(typeof cell === 'number') return isFinite(cell) ? `<c r="${ref}"><v>${cell}</v></c>` : '';
  if(typeof cell === 'boolean') return `<c r="${ref}" t="b"><v>${cell ? 1 : 0}</v></c>`;
  if(typeof cell === 'object' && cell.f){
    const v = Number(cell.v);
    return `<c r="${ref}"><f>${xlXmlText(cell.f)}</f>${isFinite(v) ? `<v>${v}</v>` : ''}</c>`;
  }
  const text = typeof cell === 'object' ? cell.text : cell;
  const style = typeof cell === 'object' && cell.bold ? ' s="1"' : '';
  return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xlXmlText(text)}</t></is></c>`;
}
// sheets: [{name, rows: [[cell, …] …] (row 1 first), widths: [chars per column]}] -> Blob
async function writeXlsx(JSZip, sheets){
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${xlXmlText(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  zip.file('xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`);
  sheets.forEach((s, i) => {
    const cols = (s.widths || []).map((w, c) => w ? `<col min="${c + 1}" max="${c + 1}" width="${w}" customWidth="1"/>` : '').join('');
    const rows = s.rows.map((row, r) => {
      const cells = (row || []).map((cell, c) => xlCellXml(xlColName(c + 1) + (r + 1), cell)).join('');
      return cells ? `<row r="${r + 1}">${cells}</row>` : '';
    }).join('');
    zip.file(`xl/worksheets/sheet${i + 1}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols ? `<cols>${cols}</cols>` : ''}<sheetData>${rows}</sheetData></worksheet>`);
  });
  return zip.generateAsync({type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', compression: 'DEFLATE'});
}

/* ================= reading the owner's costing sheets ================= */
function xlNorm(s){ return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase(); }
function xlHead(s){ return String(s == null ? '' : s).replace(/\s+/g, '').toLowerCase(); }
function xlTidy(s){ return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
// A number from a cell: numbers as they are; text only when it is a plain number (no unit letters).
function xlNum(v){
  if(typeof v === 'number') return isFinite(v) ? v : null;
  if(typeof v !== 'string') return null;
  const t = v.replace(/[₱,\s]/g, '');
  return /^-?(\d+\.?\d*|\.\d+)$/.test(t) ? Number(t) : null;
}
// A name from a file, made safe for the screens: no leading = + - @ tab / line breaks (they can
// make a spreadsheet run a formula), spaces tidied, cut to the screen's limit.
function xlCleanName(v, max){
  const t = xlTidy(String(v == null ? '' : v).replace(/^[=+\-@\t\r\n\s]+/, ''));
  return {text: t.slice(0, max).trim(), cut: t.length > max};
}
const XL_MAX = {name: 80, subcategory: 40, category: 80};
// how names are compared (a file's name and a name already in the shop get the same cleaning)
function xlKey(v){ return xlNorm(xlCleanName(v, XL_MAX.name).text); }
function xlUnit(t){
  const s = String(t == null ? '' : t).trim().toLowerCase().replace(/\.$/, '');
  if(['g', 'gram', 'grams', 'gm', 'gms'].includes(s)) return 'g';
  if(['kg', 'kilo', 'kilos', 'kgs'].includes(s)) return 'kg';
  if(['ml', 'milliliter', 'millilitre', 'milliliters', 'millilitres'].includes(s)) return 'ml';
  if(['l', 'liter', 'litre', 'liters', 'litres', 'ltr'].includes(s)) return 'L';
  if(['pc', 'pcs', 'piece', 'pieces', 'pc(s)', 'each'].includes(s)) return 'pcs';
  if(['box', 'boxes'].includes(s)) return 'box';
  if(['pack', 'packs'].includes(s)) return 'pack';
  return null;
}
const XL_HEAD_KEYS = {item: ['item'], uom: ['uom'], price: ['unitprice'], qty: ['quantity', 'qty'], amount: ['amount'], unit: ['unit']};
function xlFindHeader(sheet, fromRow, minCol, maxCol){
  for(let r = fromRow || 1; r <= sheet.maxRow; r++){
    const found = {};
    for(let c = minCol || 1; c <= (maxCol || sheet.maxCol); c++){
      const v = sheet.cells.get(r + ',' + c);
      if(typeof v !== 'string') continue;
      const h = xlHead(v);
      Object.keys(XL_HEAD_KEYS).forEach(k => { if(found[k] == null && XL_HEAD_KEYS[k].includes(h)) found[k] = c; });
    }
    if(found.item != null && found.uom != null && found.price != null && found.qty != null && found.amount != null){
      if(found.unit != null && found.unit < found.item) delete found.unit;
      return {row: r, cols: found};
    }
  }
  return null;
}
// The first table of a costing sheet -> {lines, yield, sellingPrice, ...} (null when the sheet has no table)
function xlParseCostingSheet(sheet){
  const head = xlFindHeader(sheet, 1);
  if(!head) return null;
  const C = head.cols, cell = (r, c) => c == null ? null : sheet.cells.get(r + ',' + c);
  const colsUsed = Object.values(C);
  const minC = Math.min(...colsUsed), maxC = Math.max(...colsUsed);
  const out = {headerRow: head.row, hasUnitCol: C.unit != null, lines: [], yield: null, yieldUnit: null, sellingPrice: null, markUp: null,
    totalCost: null, warnings: [], category: null, recipeType: null, nameless: 0};
  // optional "category" / "recipe type" cells above the table (written by our own export)
  for(let r = 1; r < head.row; r++) for(let c = 1; c <= sheet.maxCol; c++){
    const k = xlNorm(cell(r, c));
    if(k === 'category' && typeof cell(r, c + 1) === 'string') out.category = xlCleanName(cell(r, c + 1), XL_MAX.subcategory).text || null;
    if(k === 'recipe type' && typeof cell(r, c + 1) === 'string') out.recipeType = String(cell(r, c + 1)).trim().toUpperCase();
    if(k === 'menu name' && out.menuName == null && cell(r, c + 1) != null) out.menuName = String(cell(r, c + 1));
  }
  let after = false, stopRow = sheet.maxRow;
  // a second table below the first one (same columns): everything from there on is left out
  const second = xlFindHeader(sheet, head.row + 1, minC, maxC);
  if(second) stopRow = second.row - 1;
  // a table beside the first one (other columns) is left out too
  const beside = xlFindHeader(sheet, 1, maxC + 1, sheet.maxCol) || (minC > 1 ? xlFindHeader(sheet, 1, 1, minC - 1) : null);
  if(second || beside) out.warnings.push('An extra table on this sheet was not imported.');
  const outside = [];
  for(let r = head.row + 1; r <= stopRow; r++){
    for(let c = 1; c <= sheet.maxCol; c++) if((c < minC || c > maxC) && sheet.cells.has(r + ',' + c)) outside.push(xlColName(c) + r);
    const itemRaw = cell(r, C.item);
    const item = itemRaw == null ? '' : xlTidy(itemRaw);
    let label = item;
    if(!label) for(let c = minC; c <= maxC; c++){ const v = cell(r, c); if(typeof v === 'string' && xlNum(v) == null && v.trim()){ label = xlTidy(v); break; } }
    const key = xlNorm(label).replace(/[:.]+$/, '');
    const pack = xlNum(cell(r, C.uom)), price = xlNum(cell(r, C.price)), qty = xlNum(cell(r, C.qty)), amount = xlNum(cell(r, C.amount));
    const unitText = C.unit != null && typeof cell(r, C.unit) === 'string' ? String(cell(r, C.unit)).trim() : '';
    const firstNum = () => { for(let c = minC; c <= maxC; c++){ const n = xlNum(cell(r, c)); if(n != null) return n; } return null; };
    if(key === 'yield'){ out.yield = qty != null ? qty : (amount != null ? amount : firstNum()); out.yieldUnit = xlUnit(unitText); continue; }
    if(key === 'total cost' || key === 'total'){ after = true; out.totalCost = amount; continue; }
    if(key === 'mark up' || key === 'markup'){ out.markUp = amount != null ? amount : firstNum(); continue; }
    if(key === 'selling price' || key === 'srp'){ out.sellingPrice = amount != null ? amount : firstNum(); continue; }
    if(key === 'price' && (after || !item)) continue;
    if(!item){ if(pack != null || price != null) out.nameless++; continue; }
    const line = {row: r, name: item, key: xlKey(item), pack, price, qty, amount, unitText, after, kind: 'name', on: false, note: ''};
    if(pack != null && pack > 0 && price != null && price >= 0 && qty != null && qty > 0) line.kind = 'full';
    else if((pack == null || pack <= 0) && qty != null && qty > 0 && amount != null && amount > 0) line.kind = 'qa';
    else if(amount != null && amount > 0 && !(qty > 0)) line.kind = 'cost';
    else line.note = typeof cell(r, C.qty) === 'string' || typeof cell(r, C.uom) === 'string' ? 'Amount is not a plain number' : 'No amount or price';
    line.on = line.kind !== 'name' && !after;
    out.lines.push(line);
  }
  if(out.nameless) out.warnings.push(`${plural(out.nameless, 'row')} without an item name ${out.nameless === 1 ? 'was' : 'were'} skipped.`);
  if(outside.length && !beside) out.warnings.push(`Cells beside the recipe table were not imported (${outside.slice(0, 4).join(', ')}${outside.length > 4 ? '…' : ''}).`);
  return out;
}
// "Ingredients" sheet of our own export: name | category | unit | current cost | stock
function xlParseIngredientSheet(sheet){
  for(let r = 1; r <= Math.min(sheet.maxRow, 10); r++){
    const cols = {};
    for(let c = 1; c <= sheet.maxCol; c++){ const h = xlHead(sheet.cells.get(r + ',' + c)); if(['name', 'category', 'unit'].includes(h) && cols[h] == null) cols[h] = c; }
    if(cols.name == null || cols.unit == null) continue;
    const hints = new Map();
    for(let rr = r + 1; rr <= sheet.maxRow; rr++){
      const n = sheet.cells.get(rr + ',' + cols.name);
      if(typeof n !== 'string' || !n.trim()) continue;
      const cat = cols.category != null ? sheet.cells.get(rr + ',' + cols.category) : null;
      const catName = typeof cat === 'string' && cat.trim() && cat.trim() !== '—' ? xlCleanName(cat, XL_MAX.category).text : '';
      hints.set(xlKey(n), {unit: xlUnit(sheet.cells.get(rr + ',' + cols.unit)), category: catName || null});
    }
    return hints;
  }
  return null;
}

/* ---- guesses (the owner confirms every one in the preview) ---- */
const XL_PCS_WORDS = /\b(eggs?|egg yolks?|banana|bread|cookies?|lemon|onion|waffles?|tuna|ham)\b/;
const XL_ML_WORDS = /milk|cream|water|syrup|sauce|juice|shot|espresso|cold ?brew|sprite|soda|baileys|tequila|oil|extract|honey mix/;
function xlGuessUnit(name, pack){
  const n = xlNorm(name);
  if(pack === 1) return 'pcs';
  if(XL_PCS_WORDS.test(n) && (pack == null || pack <= 50)) return 'pcs';
  if(pack != null && pack > 1 && pack <= 24 && Number.isInteger(pack)) return 'pcs';   // e.g. a 12-can pack
  if(XL_ML_WORDS.test(n)) return 'ml';
  return 'g';
}
function xlGuessRecipeType(fileName, sheetName, type){
  if(/pastry/i.test(fileName)) return 'PASTRY';
  if(type === 'HOUSE' && /sauce|syrup/i.test(sheetName)) return 'SAUCES_SYRUPS';
  return 'DRINKS';
}
function xlGuessSheetType(p){
  if(num(p.sellingPrice) > 0) return 'MENU';
  if(p.yieldUnit) return 'HOUSE';
  const y = num(p.yield);
  const packaging = p.lines.some(l => /bottle|cup/.test(l.key));
  if(y >= 100) return packaging ? 'MENU' : 'HOUSE';
  if(y > 1) return 'BATCH';
  return 'MENU';
}
// most frequent value (ties -> the highest), with the range
function xlModePrice(list){
  const vals = list.filter(v => isFinite(v) && v >= 0).map(v => Math.round(v * 1e6) / 1e6);
  if(!vals.length) return null;
  const count = new Map();
  vals.forEach(v => count.set(v, (count.get(v) || 0) + 1));
  let best = null, bestN = 0;
  count.forEach((n, v) => { if(n > bestN || (n === bestN && v > best)){ best = v; bestN = n; } });
  return {value: best, min: Math.min(...vals), max: Math.max(...vals), n: vals.length, distinct: count.size};
}
const XL_TYPES = [
  {id: 'MENU', label: 'Menu item'},
  {id: 'BATCH', label: 'Menu item made in batches'},
  {id: 'HOUSE', label: 'House-made ingredient'},
  {id: 'SKIP', label: 'Skip this sheet'},
];
const XL_UNCAT = 'Uncategorized';

/* ================= import: pick files -> preview -> one save ================= */
function startExcelImport(){
  let input = document.getElementById('xl-file-input');
  if(input) input.remove();
  input = document.createElement('input');
  input.type = 'file'; input.multiple = true; input.id = 'xl-file-input';
  input.accept = '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  input.style.display = 'none';
  document.body.appendChild(input);
  input.onchange = () => { const files = [...input.files]; input.remove(); if(files.length) xlReadFiles(files); };
  input.click();
}
async function xlReadFiles(files){
  let JSZip;
  try{ JSZip = await loadJSZip(); }
  catch(e){ toast(XL_LOAD_TEXT, 'error'); return; }
  const problems = [], read = [];
  if(files.length > XL_LIMITS.files){
    toast(`Pick up to ${XL_LIMITS.files} Excel files at a time (you picked ${files.length}).`, 'error');
    return;
  }
  for(const f of files){
    if(!/\.xlsx$/i.test(f.name)){ problems.push(/\.xls$/i.test(f.name) ? `"${f.name}" is an old Excel file (.xls). Open it in Excel and save it as an Excel Workbook (.xlsx) first.` : `"${f.name}" is not an Excel (.xlsx) file.`); continue; }
    if(f.size > XL_LIMITS.fileBytes){ problems.push(`"${f.name}" is larger than 5 MB, so it was not read.`); continue; }
    try{ read.push({name: f.name, book: await readXlsx(JSZip, await f.arrayBuffer(), f.name)}); }
    catch(e){ problems.push(e instanceof XlError ? e.message : `"${f.name}" could not be read.`); }
  }
  if(!read.length){ toast(problems.join(' ') || 'Nothing to import.', 'error'); return; }
  openExcelPreview(xlBuildModel(read, problems));
}

function xlBuildModel(read, problems){
  const model = {files: [], problems, useStart: true, showOnMenus: false, ings: new Map(), hints: new Map(), seq: 0};
  read.forEach(({name, book}) => {
    const file = {name, sheets: [], skipped: []};
    book.sheets.forEach(sh => {
      if(!sh.cells.size) return;                                   // empty sheet: skipped silently
      const p = xlParseCostingSheet(sh);
      if(!p){
        const hints = xlParseIngredientSheet(sh);
        if(hints){ hints.forEach((v, k) => { if(!model.hints.has(k)) model.hints.set(k, v); }); return; }
        file.skipped.push({name: sh.name, why: 'no recipe table (item | UOM | Unit price | quantity | Amount)'});
        return;
      }
      const type = xlGuessSheetType(p);
      // our own export (unit column / category + recipe type cells): the full name is in "menu name" (B2),
      // the sheet name may be cut to 31 characters. The owner's own files: B2 is often a stale copy -> sheet name.
      const ours = p.hasUnitCol && (p.category != null || p.recipeType != null);
      const nameSource = ours && p.menuName != null && xlCleanName(p.menuName, XL_MAX.name).text ? p.menuName : sh.name;
      const nm = xlCleanName(nameSource, XL_MAX.name);
      const s = {uid: 's' + (++model.seq), file: name, sheetName: sh.name, p, lines: p.lines, type, name: nm.text || 'Recipe', nameCut: nm.cut || nm.text !== xlTidy(nameSource),
        category: p.category || XL_UNCAT, recipeType: RECIPE_TYPES.some(t => t.id === p.recipeType) ? p.recipeType : null,
        rtypeTouched: RECIPE_TYPES.some(t => t.id === p.recipeType), yieldQty: p.yield, yieldUnit: p.yieldUnit || (XL_ML_WORDS.test(xlNorm(sh.name)) ? 'ml' : 'g'),
        action: null, actionTouched: false, open: false, prodId: uid(), recipeId: uid()};
      if(!s.recipeType) s.recipeType = xlGuessRecipeType(name, sh.name, type);
      file.sheets.push(s);
    });
    model.files.push(file);
  });
  xlRefresh(model);
  return model;
}
function xlAllSheets(model){ return model.files.flatMap(f => f.sheets); }
function xlSheetActive(s){ return s.type !== 'SKIP' && s.action !== 'skip'; }
function xlExistingRecipe(name){ const k = xlKey(name); return state.recipes.find(r => xlKey(r.name) === k && r.active !== false) || state.recipes.find(r => xlKey(r.name) === k) || null; }
function xlExistingIngredient(key){ return state.ingredients.find(i => xlKey(i.name) === key && i.active !== false) || state.ingredients.find(i => xlKey(i.name) === key) || null; }
function xlFamilySmall(base){ return base === 'kg' ? 'g' : base === 'L' ? 'ml' : base; }

// Works out everything that depends on the owner's choices (called after every change).
function xlRefresh(model){
  const sheets = xlAllSheets(model);
  // 1. same name as a recipe already in the shop, or as an earlier sheet of this import
  const seen = new Map();
  sheets.forEach(s => {
    s.existing = xlExistingRecipe(s.name);
    const k = xlKey(s.name);
    s.dupOf = s.type !== 'SKIP' && seen.has(k) ? seen.get(k) : null;
    if(!s.actionTouched) s.action = s.existing || s.dupOf ? 'skip' : 'new';
    if(!s.existing && !s.dupOf && s.action !== 'new' && s.action !== 'skip') s.action = 'new';
    if(!s.existing && s.action === 'replace') s.action = s.dupOf ? 'copy' : 'new';
    if(s.type !== 'SKIP' && s.action !== 'skip' && !seen.has(k)) seen.set(k, s);
    if(!s.rtypeTouched) s.recipeType = xlGuessRecipeType(s.file, s.name, s.type);
  });
  // 2. house-made sheets (new recipes only) that other sheets' lines can link to, by name
  model.house = new Map();
  sheets.forEach(s => { if(s.type === 'HOUSE' && (s.action === 'new' || s.action === 'copy') && !model.house.has(xlKey(s.name))) model.house.set(xlKey(s.name), s); });
  // 3. every ingredient name used by a ticked line of an imported sheet
  model.ings.forEach(e => { e.uses = []; });
  sheets.forEach(s => {
    if(!xlSheetActive(s)) return;
    s.lines.forEach(l => {
      if(l.kind === 'name' || !l.on) return;
      let e = model.ings.get(l.key);
      if(!e){ const dn = xlCleanName(l.name, XL_MAX.name); e = {key: l.key, display: dn.text || 'Ingredient', displayCut: dn.cut || dn.text !== xlTidy(l.name), map: null, touched: false, unit: null, unitTouched: false, fileUnit: null, fileUnitTouched: false,
        cat: null, catTouched: false, start: null, startTouched: false, uses: [], newId: uid()}; model.ings.set(l.key, e); }
      e.uses.push({s, l});
    });
  });
  model.ings.forEach(e => {
    if(!e.uses.length) return;
    const hint = model.hints.get(e.key);
    const house = model.house.get(e.key);
    const houseSelf = house && e.uses.every(u => u.s === house);
    const existing = xlExistingIngredient(e.key);
    if(!e.touched) e.map = house && !houseSelf && !house.lines.some(l => l.on && l.key === e.key) ? 'house:' + house.uid : existing ? 'ing:' + existing.id : 'new';
    if(e.map.startsWith('house:') && ![...model.house.values()].some(h => 'house:' + h.uid === e.map)) e.map = existing ? 'ing:' + existing.id : 'new';
    if(e.map.startsWith('ing:') && !ingredientById(e.map.slice(4))) e.map = 'new';
    const fileUnits = e.uses.map(u => xlUnit(u.l.unitText)).filter(Boolean);
    // new ingredient: its unit (the file's unit column, our export's Ingredients sheet, or a guess)
    if(!e.unitTouched){
      const fullUse = e.uses.find(u => u.l.kind === 'full') || e.uses.find(u => u.l.kind === 'qa');
      e.unit = fileUnits[0] || (hint && hint.unit) || (fullUse ? xlGuessUnit(e.display, fullUse.l.pack) : 'pcs');
    }
    if(!e.catTouched) e.cat = hint && hint.category ? 'name:' + hint.category : 'name:' + XL_UNCAT;
    const ing = e.map.startsWith('ing:') ? ingredientById(e.map.slice(4)) : null;
    if(ing && (!e.fileUnitTouched || !compatibleUnits(ing.base_unit).includes(e.fileUnit))){
      const fu = fileUnits.find(u => compatibleUnits(ing.base_unit).includes(u));
      e.fileUnit = fu || xlFamilySmall(ing.base_unit);
    }
    e.price = xlEntryPrice(model, e);
    if(!e.startTouched) e.start = e.price ? e.price.value : null;
  });
  model.counts = xlCounts(model);
}
// base unit + "unit the file's numbers are in" for one ingredient entry
function xlEntryUnits(model, e){
  if(e.map.startsWith('house:')){ const h = xlAllSheets(model).find(s => 'house:' + s.uid === e.map); return {base: h ? h.yieldUnit : 'g', file: h ? h.yieldUnit : 'g', house: h}; }
  if(e.map.startsWith('ing:')){ const ing = ingredientById(e.map.slice(4)); return {base: ing.base_unit, file: e.fileUnit || ing.base_unit, ing}; }
  return {base: e.unit, file: e.unit};
}
function xlLineFileUnit(l, units){
  const u = xlUnit(l.unitText);
  return u && compatibleUnits(units.base).includes(u) ? u : units.file;
}
// price per BASE unit found in the files (most frequent, ties -> highest) + range
function xlEntryPrice(model, e){
  const units = xlEntryUnits(model, e);
  if(units.house) return null;
  const list = [];
  e.uses.forEach(({l}) => {
    const fu = xlLineFileUnit(l, units);
    if(l.kind === 'full'){ const pb = toBaseUnit(l.pack, fu, units.base); if(pb) list.push(l.price / pb); }
    else if(l.kind === 'qa'){ const qb = toBaseUnit(l.qty, fu, units.base); if(qb) list.push(l.amount / qb); }
  });
  if(!list.length) e.uses.forEach(({l}) => { if(l.kind === 'cost') list.push(l.amount); });   // "1 pc at ₱X"
  return xlModePrice(list);
}
// the cost per base unit used for "cost only" lines and for the preview's cost column
function xlEntryUnitCost(model, e){
  const units = xlEntryUnits(model, e);
  if(units.house) return 0;
  if(units.ing){ const c = ingredientCosting(units.ing.id).current || 0; if(c > 0) return c; }
  return num(e.start != null ? e.start : (e.price ? e.price.value : 0));
}
// One file line -> what will be saved: {ingKind, entry, qtyBase, unit, cost} or {skip: reason}
function xlResolveLine(model, s, l){
  if(l.kind === 'name') return {skip: l.note || 'No amount'};
  if(!l.on) return {skip: 'Not ticked'};
  const e = model.ings.get(l.key);
  if(!e) return {skip: 'Not ticked'};
  const units = xlEntryUnits(model, e);
  if(units.house && units.house === s) return {skip: 'A recipe can\'t use what it makes'};
  if(s.existing && s.action === 'replace' && units.ing && s.existing.produced_ingredient_id === units.ing.id) return {skip: 'A recipe can\'t use what it makes'};
  const fu = xlLineFileUnit(l, units);
  const unitCost = xlEntryUnitCost(model, e);
  let qty;
  if(l.kind === 'cost') qty = unitCost > 0 ? l.amount / unitCost : 1;
  else qty = toBaseUnit(l.qty, fu, units.base);
  if(qty == null) qty = num(l.qty);
  if(s.type === 'BATCH' && num(s.yieldQty) > 0) qty = qty / num(s.yieldQty);
  qty = Math.round(qty * 1e6) / 1e6;
  if(!(qty > 0)) return {skip: 'Amount is 0'};
  const unit = l.kind === 'cost' ? units.base : fu;
  return {e, units, qtyBase: qty, unit, cost: units.house ? null : qty * unitCost};
}
// cost of one line as the file has it (null when unknown)
function xlFileLineCost(l){
  if(l.kind === 'full') return l.price / l.pack * l.qty;
  if(l.kind === 'qa' || l.kind === 'cost') return l.amount;
  return null;
}
// true when what will be saved costs clearly more / less than the file says (e.g. a unit mix-up)
function xlCostDiffers(l, r, s){
  if(!r || r.skip || r.cost == null) return false;
  let fc = xlFileLineCost(l);
  if(fc == null) return false;
  if(s.type === 'BATCH' && num(s.yieldQty) > 0) fc = fc / num(s.yieldQty);
  return Math.abs(r.cost - fc) > Math.max(0.5, 0.25 * Math.abs(fc));
}
// a menu item with a selling price but no ingredient lines is still imported (e.g. a bought-in pastry)
function xlKeepsWithoutLines(s){ return s.type === 'MENU' && num(s.p.sellingPrice) > 0 && s.action !== 'replace'; }
function xlCounts(model){
  const sheets = xlAllSheets(model);
  const recipes = sheets.filter(s => xlSheetActive(s));
  const newIngs = [...model.ings.values()].filter(e => e.uses.length && e.map === 'new');
  const skipped = sheets.filter(s => !xlSheetActive(s)).length + model.files.reduce((n, f) => n + f.skipped.length, 0);
  return {recipes: recipes.length, newIngs: newIngs.length, skipped, house: recipes.filter(s => s.type === 'HOUSE').length};
}

/* ---- the preview ---- */
function xlMoney(n){ return n == null ? '—' : fmtMoney(n); }
function xlQtyText(q, unit){ return String(Number(Number(q).toFixed(4))) + ' ' + unitLabel(unit); }
function xlInFileText(l){
  const n = v => v == null ? '' : String(Number(Number(v).toFixed(4)));
  if(l.kind === 'full') return `${n(l.qty)} of ${n(l.pack)}${l.unitText ? ' ' + l.unitText : ''} at ${fmtMoney(l.price)}`;
  if(l.kind === 'qa') return `${n(l.qty)} for ${fmtMoney(l.amount)}`;
  if(l.kind === 'cost') return `${fmtMoney(l.amount)} (cost only)`;
  return [l.pack, l.price, l.qty, l.amount].some(v => v != null) ? 'incomplete' : 'name only';
}
function xlIngOptions(model, e){
  const house = [...model.house.values()];
  return `<option value="new" ${e.map === 'new' ? 'selected' : ''}>New ingredient</option>
    ${house.length ? `<optgroup label="Made by a sheet in this import">${house.map(h => `<option value="house:${esc(h.uid)}" ${e.map === 'house:' + h.uid ? 'selected' : ''}>${esc(h.name)} (house-made)</option>`).join('')}</optgroup>` : ''}
    <optgroup label="Ingredients you already have">${state.ingredients.filter(i => i.active !== false || e.map === 'ing:' + i.id).slice().sort(byName)
      .map(i => `<option value="ing:${esc(i.id)}" ${e.map === 'ing:' + i.id ? 'selected' : ''}>${esc(i.name)} (${esc(unitLabel(i.base_unit))})</option>`).join('')}</optgroup>`;
}
function xlCategoryOptions(selected){
  const names = new Set(state.categories.map(c => c.name));
  const opts = state.categories.slice().sort(byName).map(c => ({v: 'name:' + c.name, l: c.name}));
  if(!names.has(XL_UNCAT)) opts.unshift({v: 'name:' + XL_UNCAT, l: XL_UNCAT + ' (new)'});
  if(selected && !opts.some(o => o.v === selected)) opts.push({v: selected, l: selected.slice(5) + ' (new)'});
  return opts.map(o => `<option value="${esc(o.v)}" ${o.v === selected ? 'selected' : ''}>${esc(o.l)}</option>`).join('');
}
function xlIngredientsTable(model){
  const list = [...model.ings.values()].filter(e => e.uses.length).sort((a, b) => a.display.localeCompare(b.display));
  if(!list.length) return '<p class="text-light">No ingredient lines are ticked.</p>';
  return `<div class="table-wrap xl-table-wrap"><table class="xl-ing-table"><thead><tr><th>In the files</th><th>Save as</th><th>Unit</th><th>Category</th><th>Starting price</th><th class="num">Used in</th></tr></thead><tbody>
    ${list.map(e => {
      const units = xlEntryUnits(model, e);
      const ing = units.ing;
      const sheetsUsing = new Set(e.uses.map(u => u.s.uid)).size;
      let unitCell, catCell, priceCell;
      const range = e.price && e.price.distinct > 1 ? `<div class="hint">In the files: ${fmtMoney(e.price.min)}–${fmtMoney(e.price.max)} per ${esc(unitLabel(units.base))} (${e.price.distinct} prices)</div>`
        + (e.price.min > 0 && e.price.max / e.price.min >= 3 ? `<div class="hint xl-flag">Prices differ a lot: these may be different items, or packs in different units. Check the recipes marked "file: ₱…".</div>` : '') : '';
      if(units.house){
        unitCell = `<span class="text-light">${esc(unitLabel(units.base))} (yield unit)</span>`;
        catCell = '<span class="text-light">House-made</span>';
        priceCell = '<span class="text-light">From its recipe</span>';
      } else if(ing){
        const fam = compatibleUnits(ing.base_unit);
        unitCell = fam.length > 1 ? `<label class="xl-mini">numbers in the file are in <select data-i="${esc(e.key)}" data-f="funit">${fam.map(u => `<option value="${esc(u)}" ${u === e.fileUnit ? 'selected' : ''}>${esc(unitLabel(u))}</option>`).join('')}</select></label>` : esc(unitLabel(ing.base_unit));
        catCell = `<span class="text-light">${esc(catName(ing.category_id))}</span>`;
        const hasCost = isProducedItem(ing) || purchasesFor(ing.id).length > 0;
        priceCell = hasCost ? `<span class="text-light">Keeps its cost (${fmtMoney(ingredientCosting(ing.id).current || 0)}/${esc(unitLabel(ing.base_unit))})</span>`
          : `<input type="number" step="any" min="0" class="xl-price" data-i="${esc(e.key)}" data-f="start" value="${e.start == null ? '' : esc(String(Number(Number(e.start).toFixed(6))))}" aria-label="Starting price per ${esc(unitLabel(ing.base_unit))}"> <span class="text-light">/${esc(unitLabel(ing.base_unit))}</span>${range}`;
      } else {
        const opts = ['g', 'ml', 'pcs']; if(e.unit && !opts.includes(e.unit)) opts.push(e.unit);
        unitCell = `<select data-i="${esc(e.key)}" data-f="unit" aria-label="Unit of ${esc(e.display)}">${opts.map(u => `<option value="${esc(u)}" ${u === e.unit ? 'selected' : ''}>${esc(unitLabel(u))}</option>`).join('')}</select>`;
        catCell = `<select data-i="${esc(e.key)}" data-f="cat" aria-label="Category of ${esc(e.display)}">${xlCategoryOptions(e.cat)}</select>`;
        priceCell = `<input type="number" step="any" min="0" class="xl-price" data-i="${esc(e.key)}" data-f="start" value="${e.start == null ? '' : esc(String(Number(Number(e.start).toFixed(6))))}" aria-label="Starting price per ${esc(unitLabel(e.unit))}"> <span class="text-light">/${esc(unitLabel(e.unit))}</span>${range}`;
      }
      return `<tr><td><b>${esc(e.display)}</b>${e.displayCut ? '<div class="hint">Name shortened / tidied from the file</div>' : ''}</td>
        <td><select data-i="${esc(e.key)}" data-f="map" aria-label="Save ${esc(e.display)} as">${xlIngOptions(model, e)}</select></td>
        <td>${unitCell}</td><td>${catCell}</td><td>${priceCell}</td><td class="num">${plural(sheetsUsing, 'recipe')}</td></tr>`;
    }).join('')}</tbody></table></div>`;
}
function xlSheetHtml(model, s){
  const p = s.p;
  const active = xlSheetActive(s);
  const typeLabel = (XL_TYPES.find(t => t.id === s.type) || {}).label;
  const resolved = s.lines.map(l => ({l, r: active ? xlResolveLine(model, s, l) : {skip: 'Sheet skipped'}}));
  const fileCost = s.lines.filter(l => l.on && l.kind !== 'name').reduce((t, l) => t + num(l.kind === 'full' ? l.price / l.pack * l.qty : l.amount), 0);
  const warn = p.warnings.slice();
  if(s.nameCut) warn.push('The sheet name was shortened or tidied to make the recipe name.');
  if(s.type === 'MENU' && !(num(p.sellingPrice) > 0)) warn.push('No selling price found: it will be saved at ₱0 and stays off the menus until you set a price.');
  if(s.type === 'BATCH') warn.push(`Each line is divided by ${num(s.yieldQty) || '?'} (one piece); saved at ₱0 and off the menus until you set a price.`);
  if((s.type === 'HOUSE' || s.type === 'BATCH') && !(num(s.yieldQty) > 0)) warn.push('Enter the yield (how much one batch makes).');
  if(s.existing && s.action === 'replace' && s.type === 'HOUSE' && !s.existing.produced_ingredient_id) warn.push('The recipe you already have doesn\'t make an inventory item; only its ingredient lines are replaced.');
  const usable = resolved.filter(x => !x.r.skip).length;
  const off = resolved.filter(x => xlCostDiffers(x.l, x.r, s)).length;
  if(off) warn.push(`${plural(off, 'line')} will cost differently from the file (marked below). Check that ingredient's unit, starting price or match.`);
  if(active && !usable) warn.push(xlKeepsWithoutLines(s) ? 'No usable ingredient lines: saved as a menu item without ingredients (no cost, no stock used).' : 'No usable ingredient lines: this sheet will be skipped.');
  const actionSel = s.existing || s.dupOf ? `<div class="form-row"><label>${s.existing ? `You already have "${esc(s.existing.name)}"` : `Same name as a sheet in "${esc(s.dupOf.file)}"`}</label>
    <select data-s="${esc(s.uid)}" data-f="action">
      <option value="skip" ${s.action === 'skip' ? 'selected' : ''}>Skip this sheet</option>
      ${s.existing ? `<option value="replace" ${s.action === 'replace' ? 'selected' : ''}>Replace its ingredient lines</option>` : ''}
      <option value="copy" ${s.action === 'copy' ? 'selected' : ''}>Import as a copy ("${esc(xlCopyName(model, s))}")</option></select></div>` : '';
  return `<details class="xl-sheet ${active ? '' : 'xl-off'}" data-sheet="${esc(s.uid)}" ${s.open ? 'open' : ''}>
    <summary><b>${esc(s.name)}</b> <span class="tag-pill">${esc(active ? typeLabel : (s.type === 'SKIP' ? 'Skipped' : 'Skipped (same name)'))}</span>
      <span class="text-light">${plural(usable, 'line')}${num(p.sellingPrice) > 0 ? ' · sells at ' + fmtMoney(p.sellingPrice) : ''}${p.yield ? ' · yield ' + esc(String(p.yield)) : ''}</span>
      ${warn.length ? `<span class="badge badge-yellow">${plural(warn.length, 'note')}</span>` : ''}</summary>
    <div class="xl-sheet-body">
      <div class="xl-grid">
        <div class="form-row"><label>Sheet type</label><select data-s="${esc(s.uid)}" data-f="type">${XL_TYPES.map(t => `<option value="${t.id}" ${t.id === s.type ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}</select></div>
        <div class="form-row"><label>Recipe name</label><input data-s="${esc(s.uid)}" data-f="name" maxlength="80" value="${esc(s.name)}"></div>
        <div class="form-row"><label>Sub-category</label><input data-s="${esc(s.uid)}" data-f="category" maxlength="40" value="${esc(s.category)}"></div>
        <div class="form-row"><label>Recipe type</label><select data-s="${esc(s.uid)}" data-f="rtype">${RECIPE_TYPES.map(t => `<option value="${t.id}" ${t.id === s.recipeType ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}</select></div>
        ${s.type === 'HOUSE' || s.type === 'BATCH' ? `<div class="form-row"><label>${s.type === 'HOUSE' ? 'One batch makes' : 'Pieces per batch'}</label><div class="field-inline">
          <input type="number" step="any" min="0" data-s="${esc(s.uid)}" data-f="yield" value="${esc(s.yieldQty == null ? '' : String(s.yieldQty))}" style="max-width:110px;">
          ${s.type === 'HOUSE' ? `<select data-s="${esc(s.uid)}" data-f="yunit" aria-label="Yield unit">${['ml', 'g', 'pcs'].concat(['ml', 'g', 'pcs'].includes(s.yieldUnit) ? [] : [s.yieldUnit]).map(u => `<option value="${esc(u)}" ${u === s.yieldUnit ? 'selected' : ''}>${esc(unitLabel(u))}</option>`).join('')}</select>` : 'pcs'}</div></div>` : ''}
        ${actionSel}
      </div>
      ${warn.length ? `<ul class="xl-warn">${warn.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
      <div class="table-wrap xl-table-wrap"><table class="xl-lines"><thead><tr><th></th><th>Item</th><th>In the file</th><th>Will be saved as</th><th class="num">Cost</th></tr></thead><tbody>
      ${resolved.map(({l, r}, i) => {
        const tick = l.kind === 'name' ? '' : `<input type="checkbox" data-s="${esc(s.uid)}" data-l="${i}" data-f="on" ${l.on ? 'checked' : ''} aria-label="Import ${esc(l.name)}">`;
        const what = r.skip ? `<span class="text-light">Skipped: ${esc(r.skip)}</span>`
          : `${esc(xlQtyText(r.qtyBase, r.units.base))} of ${esc(r.units.house ? r.units.house.name + ' (house-made)' : r.units.ing ? r.units.ing.name : r.e.display + ' (new)')}${l.kind === 'cost' && Math.abs(r.qtyBase - 1) < 1e-9 ? ` <span class="text-light">(1 ${esc(unitLabel(r.units.base))} at ${fmtMoney(l.amount)})</span>` : ''}`;
        const differs = xlCostDiffers(l, r, s);
        return `<tr class="${r.skip ? 'muted-row' : ''}"><td>${tick}</td><td>${esc(l.name)}${l.after ? ' <span class="hint">(below "total cost")</span>' : ''}</td><td>${esc(xlInFileText(l))}</td><td>${what}</td><td class="num">${r.skip ? '' : xlMoney(r.cost)}${differs ? `<div><span class="badge badge-yellow" title="Cost in the file">file: ${fmtMoney(xlFileLineCost(l) / (s.type === 'BATCH' && num(s.yieldQty) > 0 ? num(s.yieldQty) : 1))}</span></div>` : ''}</td></tr>`;
      }).join('')}
      </tbody></table></div>
      <div class="hint">Cost of the ticked lines in the file: ${fmtMoney(fileCost)}${p.totalCost != null ? ` · "total cost" in the file: ${fmtMoney(p.totalCost)}` : ''}</div>
    </div></details>`;
}
function xlCopyName(model, s){
  const taken = new Set(state.recipes.map(r => xlKey(r.name)));
  xlAllSheets(model).forEach(o => { if(o !== s && xlSheetActive(o)) taken.add(xlKey(o.action === 'copy' ? o.copyName || o.name : o.name)); });
  const base = String(s.name).slice(0, XL_MAX.name - 6).trim();   // room for " (99)" within the 80 limit
  let n = 2, name;
  do{ name = `${base} (${n++})`; } while(taken.has(xlKey(name)) && n < 10000);
  return name;
}
function xlPreviewBody(model){
  const c = model.counts;
  return `${model.problems.length ? `<div class="notice warn"><b>Some files were not read:</b><ul class="xl-warn">${model.problems.map(p => `<li>${esc(p)}</li>`).join('')}</ul></div>` : ''}
    <div class="xl-summary" id="xl-summary"><b>${plural(c.recipes, 'recipe')}</b>, <b>${plural(c.newIngs, 'new ingredient')}</b>, ${plural(c.skipped, 'sheet')} skipped${c.house ? ` · ${c.house} house-made` : ''}.
      <span class="text-light">Nothing is saved until you press "Import".</span></div>
    <label class="chk" style="margin:8px 0 4px;"><input type="checkbox" id="xl-start" ${model.useStart ? 'checked' : ''}> Use the prices in the files as starting costs (no stock is added)</label>
    <div class="hint">Only for ingredients that have no purchases yet. Your real purchases take over the cost later.</div>
    <label class="chk" style="margin:8px 0 4px;"><input type="checkbox" id="xl-show" ${model.showOnMenus ? 'checked' : ''}> Show imported menu items on the counter and QR menu right away</label>
    <div class="hint">Left unticked, they stay hidden until you switch each one on (Recipes &amp; menu → the recipe → Edit recipe → "Show on the counter" / "Show on the QR menu").</div>
    <div class="section-title" style="font-size:15px;margin-top:14px;">Ingredients</div>
    <div class="hint">Matched to your ingredients by name. Pick another one if the file uses a different name (e.g. "double shot" for "Espresso"). New ingredients get no stock.</div>
    ${xlIngredientsTable(model)}
    ${model.files.map(f => `<div class="xl-file"><div class="section-title" style="font-size:15px;">${esc(f.name)}</div>
      ${f.sheets.map(s => xlSheetHtml(model, s)).join('')}
      ${f.skipped.length ? `<div class="hint">Not read: ${f.skipped.map(x => `"${esc(x.name)}" (${esc(x.why)})`).join(', ')}</div>` : ''}</div>`).join('')}`;
}
function openExcelPreview(model){
  const foot = () => `<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" id="xl-go" ${model.counts.recipes ? '' : 'disabled'}>Import ${plural(model.counts.recipes, 'recipe')}</button>`;
  openModal({title: 'Import recipes from Excel', wide: true, body: `<div id="xl-preview">${xlPreviewBody(model)}</div>`, foot: foot(), onMount: (root) => {
    root.querySelector('.modal').classList.add('xl-modal');
    const body = root.querySelector('.modal-body'), wrap = root.querySelector('#xl-preview');
    const rerender = () => {
      xlRefresh(model);
      const top = body.scrollTop;
      wrap.innerHTML = xlPreviewBody(model);
      root.querySelector('.modal-foot').innerHTML = foot();
      wireFoot();
      body.scrollTop = top;
    };
    const sheetOf = uid => xlAllSheets(model).find(s => s.uid === uid);
    wrap.addEventListener('toggle', (e) => { const d = e.target; if(d.dataset && d.dataset.sheet){ const s = sheetOf(d.dataset.sheet); if(s) s.open = d.open; } }, true);
    wrap.addEventListener('input', (e) => {
      const t = e.target, f = t.dataset.f;
      if(t.dataset.s){ const s = sheetOf(t.dataset.s); if(!s) return;
        if(f === 'category') s.category = t.value;
        if(f === 'name') s.name = t.value;
        if(f === 'yield') s.yieldQty = t.value === '' ? null : num(t.value);
      }
      if(t.dataset.i && f === 'start'){ const ent = model.ings.get(t.dataset.i); if(ent){ ent.start = t.value === '' ? null : Math.max(0, num(t.value)); ent.startTouched = true; } }
    });
    wrap.addEventListener('change', (e) => {
      const t = e.target, f = t.dataset.f;
      if(t.id === 'xl-start'){ model.useStart = t.checked; return; }
      if(t.id === 'xl-show'){ model.showOnMenus = t.checked; return; }
      if(t.dataset.s){
        const s = sheetOf(t.dataset.s); if(!s) return;
        if(f === 'type') s.type = t.value;
        else if(f === 'rtype'){ s.recipeType = t.value; s.rtypeTouched = true; }
        else if(f === 'action'){ s.action = t.value; s.actionTouched = true; }
        else if(f === 'yunit') s.yieldUnit = t.value;
        else if(f === 'on'){ const l = s.lines[Number(t.dataset.l)]; if(l) l.on = t.checked; }
        else if(f === 'name'){ s.name = xlTidy(t.value) || xlTidy(s.sheetName); if(!s.actionTouched) s.action = null; }
        else if(f === 'category'){ s.category = xlTidy(t.value); return; }
        else if(f !== 'yield') return;
        s.open = true;
        rerender();
      } else if(t.dataset.i){
        const ent = model.ings.get(t.dataset.i); if(!ent) return;
        if(f === 'map'){ ent.map = t.value; ent.touched = true; ent.fileUnitTouched = false; ent.startTouched = false; }
        else if(f === 'unit'){ ent.unit = t.value; ent.unitTouched = true; ent.startTouched = false; }
        else if(f === 'funit'){ ent.fileUnit = t.value; ent.fileUnitTouched = true; ent.startTouched = false; }
        else if(f === 'cat'){ ent.cat = t.value; ent.catTouched = true; return; }
        else if(f === 'start'){ rerender(); return; }
        else return;
        rerender();
      }
    });
    function wireFoot(){
      root.querySelector('[data-cancel]').onclick = closeModal;
      const go = root.querySelector('#xl-go');
      go.onclick = () => busy(go, () => xlCommit(model), 'Importing…');
    }
    wireFoot();
  }});
}

/* ---- saving: ONE apply_changes call ---- */
function xlBuildOps(model){
  xlRefresh(model);
  const now = nowISO(), today = shopTodayKey(), ops = [];
  const sheets = xlAllSheets(model).filter(xlSheetActive);
  for(const s of sheets){
    if(!xlCleanName(s.name, XL_MAX.name).text) return {error: `A sheet in "${s.file}" has no recipe name.`};
    if((s.type === 'HOUSE' || s.type === 'BATCH') && !(num(s.yieldQty) > 0)) return {error: `Enter the yield for "${s.name}" (or change its sheet type).`};
  }
  // categories (by name; "Uncategorized" is created when missing)
  const catIds = new Map(state.categories.map(c => [xlNorm(c.name), c.id]));
  const categoryId = (name) => {
    const k = xlNorm(name || XL_UNCAT);
    if(!catIds.has(k)){ const id = uid(); catIds.set(k, id); ops.push(Ops.upsert('categories', {id, name: xlCleanName(name || XL_UNCAT, XL_MAX.category).text || XL_UNCAT, created_at: now})); }
    return catIds.get(k);
  };
  // recipes + their lines
  const recipeOps = [], lineOps = [], usedEntries = new Set(), stats = {created: 0, replaced: 0, house: 0, lines: 0, skippedEmpty: []};
  const takenNames = new Set(state.recipes.map(r => xlKey(r.name)));
  const newIngredientRows = new Map();
  const ingredientIdFor = (r) => {
    if(r.units.house) return r.units.house.prodId;
    if(r.units.ing) return r.units.ing.id;
    usedEntries.add(r.e);
    return r.e.newId;
  };
  for(const s of sheets){
    const resolved = s.lines.map(l => xlResolveLine(model, s, l)).filter(r => !r.skip);
    if(!resolved.length && !xlKeepsWithoutLines(s)){ stats.skippedEmpty.push(s.name); continue; }
    // one line per ingredient (the same ingredient twice in a sheet is added up)
    const merged = new Map();
    resolved.forEach(r => {
      const id = ingredientIdFor(r);
      const m = merged.get(id);
      if(m){ m.quantity = Math.round((m.quantity + r.qtyBase) * 1e6) / 1e6; if(m.unit !== r.unit) m.unit = r.units.base; }
      else merged.set(id, {ingredient_id: id, quantity: r.qtyBase, unit: r.unit});
    });
    let recipeId;
    if(s.action === 'replace' && s.existing){
      recipeId = s.existing.id;
      recipeOps.push(Ops.update('recipes', {id: recipeId, updated_at: now}));
      lineOps.push(Ops.delWhere('recipe_ingredients', {recipe_id: recipeId}));
      stats.replaced++;
    } else {
      let name = xlCleanName(s.name, XL_MAX.name).text;
      if(s.action === 'copy' || takenNames.has(xlKey(name))){ let n = 2, base = name.slice(0, XL_MAX.name - 6).trim(); while(takenNames.has(xlKey(name)) && n < 10000) name = `${base} (${n++})`; }
      takenNames.add(xlKey(name));
      recipeId = s.recipeId;
      const house = s.type === 'HOUSE';
      const menuVisible = !!model.showOnMenus;
      const recipe = {id: recipeId, name, category: xlCleanName(s.category, XL_MAX.subcategory).text || XL_UNCAT, recipe_type: s.recipeType,
        selling_price: s.type === 'MENU' ? Math.max(0, num(s.p.sellingPrice)) : 0,
        notes: `Imported from Excel: ${s.file} / ${s.sheetName}` + (s.type === 'BATCH' ? ` (made in batches of ${num(s.yieldQty)}; amounts are per piece)` : ''),
        is_production_recipe: house, expected_yield: house ? num(s.yieldQty) : null, yield_unit: house ? s.yieldUnit : null,
        production_instructions: '', produced_ingredient_id: null, pos_visible: menuVisible, qr_visible: menuVisible, sold_out: false,
        description: '', sort_order: 0, image_url: null, modifier_groups: [], active: true, created_at: now, updated_at: now};
      recipeOps.push(Ops.upsert('recipes', recipe));
      if(house){
        // same order as the recipe form: recipe, its produced ingredient, then the link
        recipeOps.push(Ops.upsert('ingredients', {id: s.prodId, name, category_id: producedCategoryId() || categoryId(XL_UNCAT), supplier_id: null,
          base_unit: s.yieldUnit, reorder_level: num(state.settings.low_stock_default_threshold), notes: `Auto-created from production recipe "${name}" (Excel import).`,
          is_produced_item: true, source_recipe_id: recipeId, shelf_life_days: null, storage_notes: '', active: true, created_at: now, updated_at: now}));
        recipeOps.push(Ops.update('recipes', {id: recipeId, produced_ingredient_id: s.prodId}));
        stats.house++;
      }
      stats.created++;
    }
    merged.forEach(m => { lineOps.push(Ops.upsert('recipe_ingredients', {id: uid(), recipe_id: recipeId, ingredient_id: m.ingredient_id, quantity: m.quantity, unit: m.unit})); stats.lines++; });
  }
  if(!stats.created && !stats.replaced) return {error: 'None of the sheets has an ingredient line to import.'};
  // new raw ingredients (only those a saved line uses)
  usedEntries.forEach(e => {
    newIngredientRows.set(e.newId, {id: e.newId, name: xlCleanName(e.display, XL_MAX.name).text || 'Ingredient', category_id: categoryId(e.cat ? e.cat.slice(5) : XL_UNCAT), supplier_id: null,
      base_unit: e.unit, reorder_level: num(state.settings.low_stock_default_threshold), notes: 'Added from an Excel import.',
      is_produced_item: false, source_recipe_id: null, shelf_life_days: null, storage_notes: '', active: true, created_at: now, updated_at: now});
  });
  newIngredientRows.forEach(row => ops.push(Ops.upsert('ingredients', row)));
  ops.push(...recipeOps, ...lineOps);
  // starting prices: a ₱0, quantity-0 purchase that only carries the price (no stock line)
  let starts = 0;
  if(model.useStart){
    const priced = new Set();
    model.ings.forEach(e => {
      if(!e.uses.length || !(num(e.start) > 0)) return;
      let id = null, unit = null;
      if(e.map === 'new'){ if(!usedEntries.has(e)) return; id = e.newId; unit = e.unit; }
      else if(e.map.startsWith('ing:')){
        const ing = ingredientById(e.map.slice(4));
        if(!ing || isProducedItem(ing) || purchasesFor(ing.id).length) return;
        id = ing.id; unit = ing.base_unit;
      } else return;
      if(priced.has(id)) return;
      priced.add(id);
      ops.push(Ops.upsert('purchases', {id: uid(), ingredient_id: id, supplier_id: null, purchase_date: today, invoice_number: '',
        quantity: 0, purchase_unit: unit, base_quantity: 0, total_price: 0, price_per_base_unit: Math.round(num(e.start) * 1e6) / 1e6,
        notes: 'Starting price from Excel file', created_at: now}));
      starts++;
    });
  }
  const files = model.files.map(f => f.name).join(', ');
  const summary = `${files}: ${plural(stats.created, 'recipe')} added${stats.replaced ? `, ${stats.replaced} replaced` : ''}${stats.house ? ` (${stats.house} house-made)` : ''}, ${plural(newIngredientRows.size, 'new ingredient')}, ${plural(starts, 'starting price')}`;
  ops.push(Ops.audit('Recipes imported from Excel', summary, null));
  return {ops, stats, newIngredients: newIngredientRows.size, starts, summary};
}
async function xlCommit(model){
  const built = xlBuildOps(model);
  if(built.error){ toast(built.error, 'error'); return; }
  try{ await applyChanges(built.ops); }
  catch(e){
    console.error('Excel import failed', e);
    toast('Nothing was imported: ' + friendlyError(e), 'error');
    return;
  }
  try{ await boLoad(); }catch(e){ console.warn('reload after import failed', e); }
  const st = built.stats;
  const skipped = xlCounts(model).skipped + st.skippedEmpty.length;
  openModal({title: 'Recipes imported', body: `<p><b>${plural(st.created, 'recipe')} added</b>${st.replaced ? `, ${plural(st.replaced, 'recipe')} had their ingredient lines replaced` : ''}.</p>
      <ul class="xl-warn">
        ${st.house ? `<li>${plural(st.house, 'house-made ingredient recipe')} (each makes an inventory item).</li>` : ''}
        <li>${plural(built.newIngredients, 'new ingredient')} added (no stock: add purchases or a stock count as usual).</li>
        <li>${plural(built.starts, 'starting price')} saved from the files.</li>
        ${skipped ? `<li>${plural(skipped, 'sheet')} skipped${st.skippedEmpty.length ? ` (no ingredient lines: ${st.skippedEmpty.map(esc).join(', ')})` : ''}.</li>` : ''}
        <li>New recipes are in the sub-category "${esc(XL_UNCAT)}" unless you chose another.</li>
        ${model.showOnMenus ? '<li>Menu items with a selling price are now on the counter and the QR menu. Recipes without a selling price stay off until you set one.</li>'
          : '<li>The imported menu items are <b>hidden</b> from the counter and the QR menu. To sell one: Recipes &amp; menu → open it → Edit recipe → tick "Show on the counter" and "Show on the QR menu" (and set a selling price if it has none).</li>'}
      </ul>`,
    foot: `<button class="btn btn-primary" data-ok>Done</button>`,
    onMount: (root) => { root.querySelector('[data-ok]').onclick = closeModal; }});
  if(state.route === 'recipes') renderRecipes();
}

/* ================= export ================= */
function xlSafeSheetName(name, taken){
  let base = String(name || 'Recipe').replace(/[\[\]:*?\/\\]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^'+|'+$/g, '') || 'Recipe';
  let out = base.slice(0, 31).trim(), n = 2;
  while(taken.has(out.toLowerCase())){ const suf = ` (${n++})`; out = base.slice(0, 31 - suf.length).trim() + suf; }
  taken.add(out.toLowerCase());
  return out;
}
async function exportRecipesToExcel(){
  const recipes = state.recipes.filter(r => r.active !== false).sort(byName);
  if(!recipes.length){ toast('There are no active recipes to export.', 'error'); return; }
  let JSZip;
  try{ JSZip = await loadJSZip(); }
  catch(e){ toast(XL_LOAD_TEXT, 'error'); return; }
  const taken = new Set(['ingredients']);
  const B = (text) => ({text, bold: true});
  const ingRows = [[B('name'), B('category'), B('unit'), B('current cost'), B('stock')]];
  state.ingredients.filter(i => i.active !== false).sort(byName).forEach(i => {
    ingRows.push([i.name, i.category_id ? catName(i.category_id) : '', i.base_unit, Number((ingredientCosting(i.id).current || 0).toFixed(6)), Number(ingredientStock(i.id).toFixed(4))]);
  });
  const sheets = [{name: 'Ingredients', rows: ingRows, widths: [32, 24, 8, 14, 12]}];
  recipes.forEach(r => {
    const {lines} = recipeCost(r.id);
    const rows = [[], ['menu name', r.name, null, 'category', r.category || ''], [null, null, null, 'recipe type', recipeTypeOf(r)], ['Ingredients'],
      [null, B('item'), B('UOM'), B('Unit price'), B('quantity'), B('Amount'), B('unit')]];
    let total = 0;
    lines.forEach(l => {
      const ing = ingredientById(l.ingredient_id);
      const rowNo = rows.length + 1, cost = Number(l.unitCost) || 0, qty = Number(l.quantity) || 0;
      total += cost * qty;
      rows.push([null, ing ? ing.name : '(deleted ingredient)', 1, cost, qty, {f: `D${rowNo}/C${rowNo}*E${rowNo}`, v: cost * qty}, ing ? ing.base_unit : (l.unit || '')]);
    });
    const first = 6, last = Math.max(rows.length, first);
    rows.push([]);
    if(isProductionRecipe(r) && num(r.expected_yield) > 0) rows.push([null, 'yield', null, null, num(r.expected_yield), null, r.yield_unit || '']);
    rows.push([null, 'total cost', null, null, null, {f: `SUM(F${first}:F${last})`, v: total}]);
    if(!isProductionRecipe(r) || num(r.selling_price) > 0) rows.push([null, 'selling price', null, null, null, num(r.selling_price)]);
    sheets.push({name: xlSafeSheetName(r.name === 'Ingredients' ? r.name + ' (recipe)' : r.name, taken), rows, widths: [12, 30, 8, 12, 12, 12, 8]});
  });
  if(sheets.length > XL_LIMITS.sheets) toast(`Note: the file has ${sheets.length} sheets; importing it again needs files of ${XL_LIMITS.sheets} sheets or fewer.`, 'error');
  const blob = await writeXlsx(JSZip, sheets);
  downloadFile(`cccc-recipes-${shopTodayKey()}.xlsx`, blob);
  applyChanges([Ops.audit('Recipes exported to Excel', plural(recipes.length, 'recipe'), null)]).catch(() => {});
  toast(`Exported ${plural(recipes.length, 'recipe')}`);
}
