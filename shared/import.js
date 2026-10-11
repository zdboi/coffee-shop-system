/* =====================================================================
   IMPORTER — brings data from the old on-device apps (or a backup file)
   into Supabase.

   • Works with backup .json files from the old Inventory/POS apps AND with
     backups made by this new Back Office.
   • Can also read the old apps' data straight from this browser.
   • Safe to run twice: old ids are turned into fixed new ids, so importing
     the same file again updates records instead of duplicating them.
   • Never deletes anything already in Supabase.
   ===================================================================== */
const Importer = (function(){
  // Which fields point at which other records: [field, targetStore, required]
  const REFS = {
    ingredients: [['categoryId','categories',false],['supplierId','suppliers',false],['source_recipe_id','recipes',false]],
    purchases: [['ingredientId','ingredients',true],['supplierId','suppliers',false]],
    recipes: [['produced_ingredient_id','ingredients',false]],
    recipeIngredients: [['recipeId','recipes',true],['ingredientId','ingredients',true]],
    productionBatches: [['recipeId','recipes',false],['producedIngredientId','ingredients',false]],
    waste: [['ingredientId','ingredients',true]],
    inventoryTransactions: [['ingredientId','ingredients',true]],
    sales: [['shift_id','shifts',false],['cashier_id','users',false],['customer_id','customers',false]],
    saleItems: [['saleId','sales',true],['recipeId','recipes',false]],
    payments: [['saleId','sales',true]],
    refunds: [['saleId','sales',true],['shift_id','shifts',false],['approved_by_id','users',false]],
    shifts: [['cashier_id','users',false]],
    cashMovements: [['shift_id','shifts',true],['performed_by','users',false]],
    auditLog: [['actor_id','users',false]],
    customers: [],
    diningTables: [],
    users: [],
    categories: [], suppliers: [],
  };
  const ORDER = ['categories','suppliers','ingredients','recipes','recipeIngredients','purchases','productionBatches','waste',
    'users','shifts','customers','sales','saleItems','payments','refunds','cashMovements','inventoryTransactions','auditLog','diningTables'];

  async function stableUuid(key){
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
    const b = new Uint8Array(buf).slice(0,16);
    b[6] = (b[6] & 0x0f) | 0x50; b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map(x=>x.toString(16).padStart(2,'0')).join('');
    return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
  }

  function summarize(payload){
    const d = (payload && payload.data) || {};
    const counts = {};
    ORDER.forEach(s=>{ if(Array.isArray(d[s]) && d[s].length) counts[s] = d[s].filter(r=>!r._synthetic).length; });
    return {counts, hasSettings: !!d.settings, exportedAt: payload && payload.exported_at, appName: payload && (payload.app_name_at_export || payload.app)};
  }

  async function run(payload, {includeSettings=true, onProgress}={}){
    if(!payload || !payload.data) throw Object.assign(new Error('bad file'), {friendly:'This does not look like a backup file from this system.'});
    const src = payload.data;
    const biz = Data.businessId;
    const idMap = new Map();          // old id -> new uuid
    const known = {};                 // store -> Set(new ids present in this import)
    const notes = [];

    // 1) give every record a UUID (keeps existing UUIDs)
    for(const store of ORDER){
      known[store] = new Set();
      for(const r of (src[store]||[])){
        if(!r || r._synthetic || r.id==null) continue;
        const nid = isUuid(r.id) ? r.id : await stableUuid(biz + ':' + r.id);
        idMap.set(String(r.id), nid);
        known[store].add(nid);
      }
    }
    // existing records already in Supabase also count as valid targets
    const existingCache = {};
    const existing = (store) => existingCache[store] || (existingCache[store] = new Set((state[store]||[]).map(x=>x.id)));
    const mapId = (v) => (v==null || v==='') ? null : (idMap.get(String(v)) || (isUuid(v) ? v : null));
    const nameToStaff = new Map();
    (src.users||[]).forEach(u=> nameToStaff.set(String(u.name||'').trim().toLowerCase(), mapId(u.id)));
    (state.users||[]).forEach(u=> { const k = String(u.name||'').trim().toLowerCase(); if(!nameToStaff.has(k)) nameToStaff.set(k, u.id); });
    const mapMods = (mods) => Array.isArray(mods) ? mods.map(m => Object.assign({}, m, m && m.ingredientId ? {ingredientId: mapId(m.ingredientId)} : {})) : mods;

    // 2) build clean records
    const out = {};
    let skipped = 0;
    for(const store of ORDER){
      const rows = [];
      for(const r0 of (src[store]||[])){
        if(!r0 || r0._synthetic || r0.id==null) continue;
        const r = JSON.parse(JSON.stringify(r0));
        const oldId = String(r.id);
        r.id = mapId(r.id);
        if(!isUuid(oldId) && Data.DEFS[store] && Data.DEFS[store].cols.includes('local_id')) r.local_id = oldId;
        let ok = true;
        for(const [field, target, required] of (REFS[store]||[])){
          if(r[field]==null || r[field]==='') { if(required) ok = false; continue; }
          const nid = mapId(r[field]);
          const valid = nid && (known[target].has(nid) || existing(target).has(nid));
          if(valid) r[field] = nid;
          else if(required) ok = false;
          else r[field] = null;
        }
        if(!ok){ skipped++; continue; }
        // nested references
        if(store==='recipes' && Array.isArray(r.modifierGroups)){
          r.modifierGroups = r.modifierGroups.map(g=> Object.assign({}, g, {options: (g.options||[]).map(o=> Object.assign({}, o, o.ingredientId ? {ingredientId: mapId(o.ingredientId)} : {}))}));
        }
        if(store==='saleItems') r.modifiers = mapMods(r.modifiers);
        if(store==='refunds' && Array.isArray(r.items)){
          r.items = r.items.map(it=> Object.assign({}, it, {saleItemId: mapId(it.saleItemId), recipeId: mapId(it.recipeId), modifiers: mapMods(it.modifiers)}));
        }
        if(store==='inventoryTransactions' || store==='auditLog'){
          if(r.reference_id) r.reference_id = idMap.get(String(r.reference_id)) || r.reference_id;
        }
        if(store==='sales' && !r.cashier_id && r.cashier){ r.cashier_id = nameToStaff.get(String(r.cashier).trim().toLowerCase()) || null; }
        if(store==='users'){ delete r.pin_hash; r.role = ['ADMIN','MANAGER','CASHIER'].includes(r.role) ? r.role : 'CASHIER'; }
        // keep history out of the "recently changed" loads
        const when = r.transaction_date || r.date || r.at || r.purchase_date || r.production_date || r.created_at;
        if(['inventoryTransactions','refunds','auditLog','cashMovements','purchases','productionBatches','waste','payments'].includes(store) && when){
          r.inserted_at = new Date(when).toISOString();
        }
        rows.push(r);
      }
      out[store] = rows;
    }
    // sale lines arrive "when their sale happened"
    const saleDate = new Map((out.sales||[]).map(s=>[s.id, s.transaction_date]));
    (out.saleItems||[]).forEach(it=>{ const d = saleDate.get(it.saleId); if(d) it.inserted_at = new Date(d).toISOString(); });
    (out.payments||[]).forEach(p=>{ const d = saleDate.get(p.saleId); if(d) p.inserted_at = new Date(d).toISOString(); });

    // 3) upload in dependency order
    const total = ORDER.reduce((s,k)=> s + (out[k]||[]).length, 0);
    let done = 0;
    for(const store of ORDER){
      const rows = out[store]||[];
      for(let i=0;i<rows.length;i+=400){
        const part = rows.slice(i, i+400);
        await Data.bulkPut(store, part);
        done += part.length;
        if(onProgress) onProgress(done, total, store);
      }
    }

    // 4) settings (shop name, logo, colours, tax…)
    if(includeSettings && src.settings){
      const keep = {...state.settings};
      const incoming = src.settings;
      Object.keys(Data.SETTINGS_MAP).forEach(k=>{ if(incoming[k]!==undefined && incoming[k]!==null && incoming[k]!=='') keep[k] = incoming[k]; });
      if(incoming.gdriveClientId) keep.gdriveClientId = incoming.gdriveClientId;
      await DB.put('settings', keep);
    }
    const oldUsers = (out.users||[]).length;
    if(oldUsers) notes.push(`${oldUsers} staff member(s) imported without PINs — set their PINs in Staff & PINs.`);
    if((src.orders||[]).length) notes.push('QR order history is not restored from backups (sales are).');
    return {imported: done, skipped, notes};
  }

  // Read the old apps' data directly from this browser (same website address).
  async function readOldBrowserData(){
    if(typeof indexedDB==='undefined') return null;
    if(indexedDB.databases){
      const list = await indexedDB.databases();
      if(!list.some(d=>d.name==='coffeeShopDB')) return null;
    }
    const db = await new Promise((resolve)=>{
      const req = indexedDB.open('coffeeShopDB');
      req.onsuccess = ()=> resolve(req.result);
      req.onerror = ()=> resolve(null);
      req.onupgradeneeded = (e)=> { e.target.transaction.abort(); resolve(null); }; // it didn't exist: don't create it
    });
    if(!db) return null;
    const data = {};
    const names = [...db.objectStoreNames];
    for(const s of names){
      if(s==='deviceConfig') continue;
      data[s] = await new Promise((resolve)=>{
        const r = db.transaction(s,'readonly').objectStore(s).getAll();
        r.onsuccess = ()=> resolve(r.result||[]); r.onerror = ()=> resolve([]);
      });
    }
    db.close();
    if(Array.isArray(data.settings)){ data.settings = data.settings.find(x=>x.key==='app') || null; }
    return {app:'Old Inventory/POS (this browser)', exported_at: new Date().toISOString(), data};
  }

  return {run, summarize, readOldBrowserData, stableUuid};
})();
