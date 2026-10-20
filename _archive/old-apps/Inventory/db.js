/* ================= IndexedDB layer ================= */
const DB_NAME = 'coffeeShopDB';
// v1 -> v2 -> v3 -> v4: additive-only migrations. Each version ONLY adds new object
// stores/indexes. We never touch, recreate, or rewrite any existing store, so
// pre-existing ingredients, recipes, purchases, inventory, and sales are never at risk
// during an upgrade. New fields on existing records are applied lazily wherever they're
// read, rather than by rewriting old rows — the safest possible migration strategy.
// v3 adds the POS stores: sales, saleItems, payments, refunds, auditLog, users.
// v4 adds: shifts, cashMovements, and a `shift_id` index on the existing `sales` store
// (adding an index to an existing store is safe — older rows just have `undefined` for
// that field until re-saved, and simply won't appear in shift-scoped queries, which is
// correct: they predate shifts existing at all).
const DB_VERSION = 4;
const STORES = ['categories','suppliers','ingredients','purchases','recipes','recipeIngredients','inventoryTransactions','waste','settings','productionBatches','sales','saleItems','payments','refunds','auditLog','users','deviceConfig','shifts','cashMovements'];

let _db = null;
let _wasUpgraded = false; // set true if this open() performed a real schema upgrade (not a fresh install)

function openDB(){
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      const upgradeTx = e.target.transaction;
      if(e.oldVersion > 0) _wasUpgraded = true; // existing database being upgraded, not a brand-new install
      if(!db.objectStoreNames.contains('categories')) db.createObjectStore('categories',{keyPath:'id'});
      if(!db.objectStoreNames.contains('suppliers')) db.createObjectStore('suppliers',{keyPath:'id'});
      if(!db.objectStoreNames.contains('ingredients')){
        const s = db.createObjectStore('ingredients',{keyPath:'id'});
        s.createIndex('name','name',{unique:false});
        s.createIndex('categoryId','categoryId',{unique:false});
      }
      if(!db.objectStoreNames.contains('purchases')){
        const s = db.createObjectStore('purchases',{keyPath:'id'});
        s.createIndex('ingredientId','ingredientId',{unique:false});
        s.createIndex('supplierId','supplierId',{unique:false});
        s.createIndex('purchase_date','purchase_date',{unique:false});
      }
      if(!db.objectStoreNames.contains('recipes')){
        const s = db.createObjectStore('recipes',{keyPath:'id'});
        s.createIndex('name','name',{unique:false});
      }
      if(!db.objectStoreNames.contains('recipeIngredients')){
        const s = db.createObjectStore('recipeIngredients',{keyPath:'id'});
        s.createIndex('recipeId','recipeId',{unique:false});
        s.createIndex('ingredientId','ingredientId',{unique:false});
      }
      if(!db.objectStoreNames.contains('inventoryTransactions')){
        const s = db.createObjectStore('inventoryTransactions',{keyPath:'id'});
        s.createIndex('ingredientId','ingredientId',{unique:false});
        s.createIndex('transaction_date','transaction_date',{unique:false});
      }
      if(!db.objectStoreNames.contains('waste')){
        const s = db.createObjectStore('waste',{keyPath:'id'});
        s.createIndex('ingredientId','ingredientId',{unique:false});
      }
      if(!db.objectStoreNames.contains('settings')) db.createObjectStore('settings',{keyPath:'key'});
      if(!db.objectStoreNames.contains('productionBatches')){
        const s = db.createObjectStore('productionBatches',{keyPath:'id'});
        s.createIndex('recipeId','recipeId',{unique:false});
        s.createIndex('producedIngredientId','producedIngredientId',{unique:false});
        s.createIndex('production_date','production_date',{unique:false});
      }
      // ---- v3: POS ----
      let salesStore;
      if(!db.objectStoreNames.contains('sales')){
        salesStore = db.createObjectStore('sales',{keyPath:'id'});
        salesStore.createIndex('transaction_date','transaction_date',{unique:false});
        salesStore.createIndex('transaction_number','transaction_number',{unique:false});
        salesStore.createIndex('status','status',{unique:false});
        salesStore.createIndex('cashier','cashier',{unique:false});
        salesStore.createIndex('sync_status','sync_status',{unique:false});
      } else {
        salesStore = upgradeTx.objectStore('sales');
      }
      // NEW in v4: index the existing `sales` store by shift_id (safe on a store that
      // already has rows — see comment above).
      if(!salesStore.indexNames.contains('shift_id')){
        salesStore.createIndex('shift_id','shift_id',{unique:false});
      }
      if(!db.objectStoreNames.contains('saleItems')){
        const s = db.createObjectStore('saleItems',{keyPath:'id'});
        s.createIndex('saleId','saleId',{unique:false});
        s.createIndex('recipeId','recipeId',{unique:false});
      }
      if(!db.objectStoreNames.contains('payments')){
        const s = db.createObjectStore('payments',{keyPath:'id'});
        s.createIndex('saleId','saleId',{unique:false});
        s.createIndex('method','method',{unique:false});
      }
      if(!db.objectStoreNames.contains('refunds')){
        const s = db.createObjectStore('refunds',{keyPath:'id'});
        s.createIndex('saleId','saleId',{unique:false});
        s.createIndex('date','date',{unique:false});
      }
      if(!db.objectStoreNames.contains('auditLog')){
        const s = db.createObjectStore('auditLog',{keyPath:'id'});
        s.createIndex('at','at',{unique:false});
        s.createIndex('action','action',{unique:false});
      }
      if(!db.objectStoreNames.contains('users')){
        db.createObjectStore('users',{keyPath:'id'});
      }
      // Device-local config (NOT part of JSON backups — e.g. a saved folder handle for
      // direct-to-folder backups). This is inherently device-specific, not portable data.
      if(!db.objectStoreNames.contains('deviceConfig')){
        db.createObjectStore('deviceConfig',{keyPath:'key'});
      }
      // ---- NEW in v4: shifts & cash management ----
      if(!db.objectStoreNames.contains('shifts')){
        const s = db.createObjectStore('shifts',{keyPath:'id'});
        s.createIndex('status','status',{unique:false});
        s.createIndex('cashier_id','cashier_id',{unique:false});
        s.createIndex('opened_at','opened_at',{unique:false});
      }
      if(!db.objectStoreNames.contains('cashMovements')){
        const s = db.createObjectStore('cashMovements',{keyPath:'id'});
        s.createIndex('shift_id','shift_id',{unique:false});
      }
    };
    req.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
    req.onerror = (e) => reject(e.target.error);
  });
}

function tx(store, mode='readonly'){
  return _db.transaction(store, mode).objectStore(store);
}

const DB = {
  async all(store){
    return new Promise((resolve,reject)=>{
      const req = tx(store).getAll();
      req.onsuccess = ()=>resolve(req.result);
      req.onerror = ()=>reject(req.error);
    });
  },
  async get(store, id){
    return new Promise((resolve,reject)=>{
      const req = tx(store).get(id);
      req.onsuccess = ()=>resolve(req.result);
      req.onerror = ()=>reject(req.error);
    });
  },
  async put(store, obj){
    return new Promise((resolve,reject)=>{
      const req = tx(store,'readwrite').put(obj);
      req.onsuccess = ()=>resolve(obj);
      req.onerror = ()=>reject(req.error);
    });
  },
  async bulkPut(store, arr){
    return new Promise((resolve,reject)=>{
      const t = _db.transaction(store,'readwrite');
      const os = t.objectStore(store);
      arr.forEach(o=>os.put(o));
      t.oncomplete = ()=>resolve();
      t.onerror = ()=>reject(t.error);
    });
  },
  async delete(store, id){
    return new Promise((resolve,reject)=>{
      const req = tx(store,'readwrite').delete(id);
      req.onsuccess = ()=>resolve();
      req.onerror = ()=>reject(req.error);
    });
  },
  async byIndex(store, index, value){
    return new Promise((resolve,reject)=>{
      const req = tx(store).index(index).getAll(value);
      req.onsuccess = ()=>resolve(req.result);
      req.onerror = ()=>reject(req.error);
    });
  },
  async clearStore(store){
    return new Promise((resolve,reject)=>{
      const req = tx(store,'readwrite').clear();
      req.onsuccess = ()=>resolve();
      req.onerror = ()=>reject(req.error);
    });
  },
  // Cursor-based pagination over an index — only `limit` records are ever pulled into
  // JS at once, so Sales History stays fast regardless of how many years of transactions
  // are stored. `direction`: 'next' (ascending) or 'prev' (descending, newest-first).
  async pageByIndex(store, indexName, {limit=50, offset=0, direction='prev'}={}){
    return new Promise((resolve,reject)=>{
      const req = tx(store).index(indexName).openCursor(null, direction);
      const items = [];
      let advanced = (offset===0);
      req.onsuccess = (e)=>{
        const cursor = e.target.result;
        if(!cursor){ resolve(items); return; }
        if(!advanced){ advanced = true; cursor.advance(offset); return; }
        items.push(cursor.value);
        if(items.length>=limit){ resolve(items); return; }
        cursor.continue();
      };
      req.onerror = ()=>reject(req.error);
    });
  },
  async countByIndex(store, indexName, value){
    return new Promise((resolve,reject)=>{
      const req = value!==undefined ? tx(store).index(indexName).count(value) : tx(store).count();
      req.onsuccess = ()=>resolve(req.result);
      req.onerror = ()=>reject(req.error);
    });
  }
};
