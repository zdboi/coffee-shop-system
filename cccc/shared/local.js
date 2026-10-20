/* =====================================================================
   LocalDB — small IndexedDB wrapper for things that must live on THIS
   device: the counter's offline menu copy, the queue of sales waiting
   to upload ("outbox"), uploads that failed, and device-only settings.
   Falls back to memory if the browser blocks IndexedDB.
   ===================================================================== */
const LocalDB = (() => {
  const NAME = 'cccc-local';
  const VERSION = 1;
  let dbPromise = null;
  let memory = null; // fallback store when IndexedDB is unavailable

  function open(){
    if(dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      let req;
      try{ req = indexedDB.open(NAME, VERSION); }
      catch(e){ memory = memory || {kv:{}, outbox:[], failed:[], seq:1}; resolve(null); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        if(!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if(!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', {keyPath: 'seq', autoIncrement: true});
        if(!db.objectStoreNames.contains('failed')) db.createObjectStore('failed', {keyPath: 'seq'});
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { memory = memory || {kv:{}, outbox:[], failed:[], seq:1}; resolve(null); };
      req.onblocked = () => {};
    });
    return dbPromise;
  }

  function run(store, mode, fn){
    return open().then(db => new Promise((resolve, reject) => {
      if(!db){ resolve(fn(null)); return; }
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      let result;
      const r = fn(s);
      if(r && typeof r.onsuccess !== 'undefined'){ r.onsuccess = () => { result = r.result; }; }
      else result = r;
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  }

  const api = {
    async get(key){
      return run('kv', 'readonly', s => s ? s.get(key) : memory.kv[key]);
    },
    async set(key, value){
      return run('kv', 'readwrite', s => { if(s) return s.put(value, key); memory.kv[key] = value; });
    },
    async del(key){
      return run('kv', 'readwrite', s => { if(s) return s.delete(key); delete memory.kv[key]; });
    },

    // ---- outbox: operations waiting to be sent, oldest first ----
    async outboxAdd(op){
      return run('outbox', 'readwrite', s => {
        if(s) return s.add(Object.assign({}, op, {queued_at: new Date().toISOString()}));
        memory.outbox.push(Object.assign({seq: memory.seq++}, op, {queued_at: new Date().toISOString()}));
      });
    },
    async outboxAll(){
      return run('outbox', 'readonly', s => s ? s.getAll() : memory.outbox.slice());
    },
    async outboxRemove(seqs){
      if(!seqs || !seqs.length) return;
      return run('outbox', 'readwrite', s => {
        if(s){ seqs.forEach(seq => s.delete(seq)); return; }
        memory.outbox = memory.outbox.filter(o => !seqs.includes(o.seq));
      });
    },
    async outboxCount(){
      return run('outbox', 'readonly', s => s ? s.count() : memory.outbox.length);
    },

    // ---- failed: operations the server refused (kept so nothing is lost) ----
    async failedAdd(entry){
      return run('failed', 'readwrite', s => { if(s) return s.put(entry); memory.failed.push(entry); });
    },
    async failedAll(){
      return run('failed', 'readonly', s => s ? s.getAll() : memory.failed.slice());
    },
    async failedRemove(seq){
      return run('failed', 'readwrite', s => { if(s) return s.delete(seq); memory.failed = memory.failed.filter(f => f.seq !== seq); });
    },
    usingMemoryFallback(){ return !!memory; },
  };
  return api;
})();
