/* =====================================================================
   DATA LAYER — Supabase is the one database for every app.

   It replaces the old on-device IndexedDB `DB` object but keeps the same
   interface, so the existing screens (ingredients, recipes, costing, POS,
   shifts, refunds…) keep their logic unchanged:

     DB.all(store)  DB.get(store, id)  DB.put(store, obj)  DB.bulkPut(store, arr)
     DB.delete(store, id)  DB.byIndex(store, field, value)  DB.pageByIndex(...)

   Two ways of saving:
     'strict' (Back Office) — each save goes straight to Supabase. If it fails
              (no internet, not allowed…) an error is shown and nothing changes.
     'queued' (Front Office) — each save is applied on the tablet at once and
              sent to Supabase in the background. If the internet drops, saves
              wait in an on-device "outbox" and upload by themselves later.
   ===================================================================== */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------- tables
  function def(table, o) {
    return Object.assign({ table, map: {}, cols: [], dateCols: [], writeCols: null, writeMode: 'upsert',
      appendOnly: false, window: null, sync: null, parent: null, children: [], local: false }, o || {});
  }
  const DEFS = {
    categories: def('categories', { cols: ['id', 'local_id', 'name', 'created_at'] }),
    suppliers: def('suppliers', { cols: ['id', 'local_id', 'name', 'contact', 'phone', 'email', 'address', 'notes', 'created_at'] }),
    ingredients: def('ingredients', {
      map: { categoryId: 'category_id', supplierId: 'supplier_id' },
      cols: ['id', 'local_id', 'name', 'category_id', 'supplier_id', 'base_unit', 'reorder_level', 'notes', 'is_produced_item',
        'source_recipe_id', 'shelf_life_days', 'storage_notes', 'active', 'created_at', 'updated_at'] }),
    purchases: def('purchases', {
      map: { ingredientId: 'ingredient_id', supplierId: 'supplier_id' },
      cols: ['id', 'local_id', 'ingredient_id', 'supplier_id', 'purchase_date', 'invoice_number', 'quantity', 'purchase_unit',
        'base_quantity', 'total_price', 'price_per_base_unit', 'notes', 'created_at', 'inserted_at'],
      dateCols: ['purchase_date'], sync: 'inserted_at' }),
    recipes: def('recipes', {
      map: { modifierGroups: 'modifier_groups' },
      cols: ['id', 'local_id', 'name', 'recipe_type', 'category', 'selling_price', 'notes', 'is_production_recipe', 'expected_yield',
        'yield_unit', 'production_instructions', 'produced_ingredient_id', 'pos_visible', 'modifier_groups', 'active', 'created_at',
        'updated_at', 'description', 'image_url', 'qr_visible', 'sold_out', 'sort_order'] }),
    recipeIngredients: def('recipe_ingredients', {
      map: { recipeId: 'recipe_id', ingredientId: 'ingredient_id' },
      cols: ['id', 'local_id', 'recipe_id', 'ingredient_id', 'quantity', 'unit'] }),
    productionBatches: def('production_batches', {
      map: { recipeId: 'recipe_id', producedIngredientId: 'produced_ingredient_id' },
      cols: ['id', 'local_id', 'recipe_id', 'produced_ingredient_id', 'batch_number', 'production_date', 'expected_yield', 'actual_yield',
        'yield_unit', 'raw_cost_total', 'actual_cost_per_unit', 'waste_reason', 'notes', 'created_at', 'inserted_at'],
      dateCols: ['production_date'], sync: 'inserted_at' }),
    waste: def('waste', {
      map: { ingredientId: 'ingredient_id' },
      cols: ['id', 'local_id', 'ingredient_id', 'quantity', 'unit', 'reason', 'date', 'notes', 'created_at', 'inserted_at'],
      dateCols: ['date'], sync: 'inserted_at' }),
    inventoryTransactions: def('inventory_transactions', {
      map: { ingredientId: 'ingredient_id' },
      cols: ['id', 'local_id', 'ingredient_id', 'transaction_type', 'quantity', 'reference_id', 'transaction_date', 'notes',
        'created_at', 'inserted_at'],
      dateCols: ['transaction_date'], appendOnly: true, window: { col: 'transaction_date', isDate: true }, sync: 'inserted_at' }),
    sales: def('sales', {
      map: { cashier: 'cashier_name' },
      cols: ['id', 'local_id', 'store_id', 'device_id', 'shift_id', 'transaction_number', 'transaction_date', 'status', 'cashier_id',
        'cashier_name', 'subtotal', 'discount_type', 'discount_value', 'discount_amount', 'tax_amount', 'service_charge_amount',
        'grand_total', 'notes', 'created_at', 'updated_at', 'customer_id', 'order_id'],
      window: { col: 'transaction_date', extra: ['status', 'eq', 'HELD'] }, sync: 'updated_at',
      children: ['saleItems', 'payments', 'refunds'] }),
    saleItems: def('sale_items', {
      map: { saleId: 'sale_id', recipeId: 'recipe_id' },
      cols: ['id', 'local_id', 'sale_id', 'recipe_id', 'name', 'quantity', 'unit_price', 'modifiers', 'line_total', 'created_at', 'inserted_at'],
      appendOnly: true, parent: { store: 'sales', field: 'saleId', col: 'sale_id' }, sync: 'inserted_at' }),
    payments: def('payments', {
      map: { saleId: 'sale_id' },
      cols: ['id', 'local_id', 'sale_id', 'method', 'amount', 'tendered', 'change', 'reference', 'status', 'created_at', 'inserted_at'],
      appendOnly: true, parent: { store: 'sales', field: 'saleId', col: 'sale_id' }, sync: 'inserted_at' }),
    refunds: def('refunds', {
      map: { saleId: 'sale_id', approved_by: 'approved_by_name', approved_by_id: 'approved_by' },
      cols: ['id', 'local_id', 'sale_id', 'shift_id', 'type', 'amount', 'reason', 'items', 'approved_by', 'approved_by_name', 'date',
        'notes', 'created_at', 'inserted_at'],
      appendOnly: true, parent: { store: 'sales', field: 'saleId', col: 'sale_id' }, window: { col: 'date' }, sync: 'inserted_at' }),
    auditLog: def('audit_log', {
      map: { actor: 'actor_name' },
      cols: ['id', 'local_id', 'action', 'actor_id', 'actor_name', 'details', 'reference_id', 'at', 'inserted_at'],
      appendOnly: true, window: { col: 'at', maxDays: 45 }, sync: 'inserted_at' }),
    users: def('staff', { cols: ['id', 'local_id', 'name', 'role', 'active', 'profile_id', 'created_at', 'updated_at'] }),
    shifts: def('shifts', {
      cols: ['id', 'local_id', 'store_id', 'device_id', 'cashier_id', 'cashier_name', 'shift_number', 'opened_at', 'closed_at',
        'status', 'opening_cash', 'declared_cash', 'expected_cash', 'cash_variance', 'gross_sales', 'net_sales', 'cash_sales',
        'card_sales', 'other_sales', 'refunds_total', 'voids_total', 'transaction_count', 'notes', 'created_at', 'updated_at'],
      window: { col: 'opened_at', extra: ['status', 'eq', 'ACTIVE'] }, sync: 'updated_at' }),
    cashMovements: def('cash_movements', {
      cols: ['id', 'local_id', 'shift_id', 'type', 'amount', 'reason', 'performed_by', 'performed_by_name', 'at', 'created_at', 'inserted_at'],
      appendOnly: true, window: { col: 'at' }, sync: 'inserted_at' }),
    diningTables: def('dining_tables', { cols: ['id', 'label', 'code', 'kind', 'active', 'sort_order', 'created_at'] }),
    customers: def('customers', {
      cols: ['id', 'nickname', 'phone', 'consent_at', 'order_count', 'visit_count', 'total_spent', 'first_visit_at', 'last_visit_at',
        'last_seen_at', 'notes', 'merged_into', 'created_at', 'updated_at'],
      writeCols: ['id', 'nickname', 'phone', 'notes', 'consent_at', 'created_at'], sync: 'updated_at' }),
    orders: def('orders', {
      cols: ['id', 'order_number', 'customer_id', 'customer_name', 'table_id', 'table_label', 'order_type', 'status', 'note',
        'subtotal', 'item_count', 'sale_id', 'status_reason', 'handled_by_name', 'created_at', 'accepted_at', 'ready_at',
        'completed_at', 'cancelled_at', 'updated_at'],
      writeCols: ['id', 'status', 'status_reason', 'handled_by_name', 'sale_id'], writeMode: 'update',
      window: { col: 'created_at', maxDays: 3, extra: ['status', 'in', ['NEW', 'ACCEPTED', 'READY']] }, sync: 'updated_at',
      children: ['orderItems'] }),
    orderItems: def('order_items', {
      map: { orderId: 'order_id', recipeId: 'recipe_id' },
      cols: ['id', 'order_id', 'recipe_id', 'name', 'quantity', 'unit_price', 'modifiers', 'line_total', 'note', 'created_at'],
      appendOnly: true, parent: { store: 'orders', field: 'orderId', col: 'order_id' }, sync: 'created_at' }),
    devices: def('devices', {
      cols: ['id', 'store_id', 'device_tag', 'device_name', 'device_type', 'last_seen_at', 'created_at', 'active',
        'current_staff_id', 'staff_signed_in_at', 'paired_at', 'auth_user_id'],
      writeCols: ['id', 'device_name', 'active', 'auth_user_id', 'current_staff_id'], writeMode: 'update' }),
    profiles: def('profiles', {
      cols: ['id', 'store_id', 'name', 'role', 'active', 'created_at', 'updated_at'],
      writeCols: ['id', 'name', 'role', 'active'], writeMode: 'update' }),
    stores: def('stores', { cols: ['id', 'name', 'address', 'contact', 'created_at'] }),
  };
  // Server-only "arrived at" columns are read but only sent when present (importer).
  const UUID_LIKE = /(^id$|_id$|^approved_by$|^performed_by$|^merged_into$)/;

  // Shared settings live in the `settings` table; the rest stay on this device.
  const SETTINGS_MAP = {
    currency: 'currency', costingMethod: 'costing_method', lowStockDefaultThreshold: 'low_stock_default_threshold',
    foodCostWarningPct: 'food_cost_warning_pct', business_name: 'business_name', app_name: 'app_name', logo: 'logo_url',
    primary_color: 'primary_color', secondary_color: 'secondary_color', accent_color: 'accent_color',
    background_color: 'background_color', card_color: 'card_color', text_color: 'text_color', font_family: 'font_family',
    font_size: 'font_size', business_address: 'business_address', business_contact: 'business_contact', tax_pct: 'tax_pct',
    service_charge_pct: 'service_charge_pct', tax_inclusive: 'tax_inclusive', receipt_footer: 'receipt_footer',
    backup_retain_count: 'backup_retain_count', qr_ordering_enabled: 'qr_ordering_enabled',
    qr_hide_out_of_stock: 'qr_hide_out_of_stock', qr_welcome_text: 'qr_welcome_text', qr_closed_message: 'qr_closed_message',
    qr_pay_note: 'qr_pay_note', qr_max_open_orders: 'qr_max_open_orders', timezone: 'timezone',
  };
  const SETTINGS_EXTRA = ['gdriveClientId', 'history_days'];

  // ---------------------------------------------------------------- helpers
  const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isoDaysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString(); };
  const dateOnly = (v) => (v == null || v === '' ? null : String(v).slice(0, 10));
  const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

  function isNetworkError(e) {
    if (!e) return false;
    const msg = String(e.message || e.details || e || '');
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
    return e.status === 0 || /Failed to fetch|NetworkError|Load failed|network|fetch failed|ECONNREFUSED|timeout/i.test(msg);
  }

  // The tablet's login token ran out (e.g. after a long time offline). Not the record's
  // fault: refresh the login and try again later instead of setting the record aside.
  function isAuthExpired(e) {
    if (!e) return false;
    const msg = String(e.message || '') + ' ' + String(e.code || '');
    return e.status === 401 || /PGRST30[13]|JWT expired|jwt expired|invalid JWT|Invalid Refresh Token/i.test(msg);
  }

  // Turn a Supabase error into a sentence a person can act on.
  function friendlyError(e) {
    if (!e) return 'Something went wrong.';
    if (e.friendly) return e.friendly;
    const code = e.code || '';
    const msg = String(e.message || e);
    if (isNetworkError(e)) return 'No internet connection. Please try again when you are back online.';
    if (code === '42501' || /row-level security|permission denied/i.test(msg)) return "You don't have permission to do that.";
    if (code === '23503') return 'This is still used by other records, so it can\'t be removed. Mark it inactive instead.';
    if (code === '23505') return 'That already exists.';
    if (code === '23502') return 'Some required information is missing.';
    if (/JWT|jwt|token/i.test(msg)) return 'Your sign-in expired. Please sign in again.';
    return msg.length > 160 ? msg.slice(0, 160) + '…' : msg;
  }

  function toRow(store, obj, businessId) {
    const d = DEFS[store];
    const row = {};
    const mappedDb = new Set(Object.values(d.map));
    for (const k of Object.keys(obj)) {
      let col;
      if (d.map[k]) col = d.map[k];
      else if (mappedDb.has(k)) continue; // app never sets the DB-side name directly
      else col = k;
      if (!d.cols.includes(col)) continue;
      if (d.writeCols && !d.writeCols.includes(col)) continue;
      let v = obj[k];
      if (v === undefined) continue;
      if (d.dateCols.includes(col)) v = dateOnly(v);
      if (v === '' && UUID_LIKE.test(col)) v = null;
      if (typeof v === 'number' && !isFinite(v)) v = null;
      row[col] = v;
    }
    if (d.writeMode !== 'update') row.business_id = businessId;
    return row;
  }

  function fromRow(store, row) {
    const d = DEFS[store];
    const obj = {};
    const reverse = {};
    for (const [appKey, col] of Object.entries(d.map)) reverse[col] = appKey;
    for (const [col, v] of Object.entries(row)) {
      if (col === 'business_id') continue;
      if (reverse[col]) obj[reverse[col]] = v;
      else if (!Object.prototype.hasOwnProperty.call(d.map, col)) obj[col] = v;
    }
    if (store === 'recipes' && !Array.isArray(obj.modifierGroups)) obj.modifierGroups = [];
    return obj;
  }

  // ---------------------------------------------------------------- local (on-device) storage
  const LocalDB = {
    _db: null, name: 'cccc-local',
    open(name) {
      this.name = name || this.name;
      if (typeof indexedDB === 'undefined') return Promise.resolve(null);
      return new Promise((resolve) => {
        const req = indexedDB.open(this.name, 1);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true });
          if (!db.objectStoreNames.contains('failed')) db.createObjectStore('failed', { keyPath: 'seq', autoIncrement: true });
          if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'key' });
        };
        req.onsuccess = (e) => { this._db = e.target.result; resolve(this._db); };
        req.onerror = () => resolve(null);
      });
    },
    _req(storeName, mode, fn) {
      return new Promise((resolve, reject) => {
        if (!this._db) { resolve(null); return; }
        const t = this._db.transaction(storeName, mode);
        const os = t.objectStore(storeName);
        let result;
        const r = fn(os);
        if (r) r.onsuccess = () => { result = r.result; };
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      });
    },
    all(s) { return this._req(s, 'readonly', (os) => os.getAll()).then((r) => r || []); },
    add(s, v) { return this._req(s, 'readwrite', (os) => os.add(v)); },
    put(s, v) { return this._req(s, 'readwrite', (os) => os.put(v)); },
    del(s, k) { return this._req(s, 'readwrite', (os) => os.delete(k)); },
    get(s, k) { return this._req(s, 'readonly', (os) => os.get(k)); },
    clear(s) { return this._req(s, 'readwrite', (os) => os.clear()); },
  };

  const prefsKey = () => 'cccc-prefs-' + Data.appName;
  function loadPrefs() { try { return JSON.parse(localStorage.getItem(prefsKey()) || '{}'); } catch (e) { return {}; } }
  function savePrefs(p) { try { localStorage.setItem(prefsKey(), JSON.stringify(p)); } catch (e) { /* private mode */ } }

  // ---------------------------------------------------------------- the Data object
  const Data = {
    sb: null, businessId: null, appName: 'app', mode: 'strict',
    stores: [], windowDays: 60, loadedFrom: null, lastServerTime: null, lastFullMasterLoad: 0,
    outbox: [], failed: [], syncing: false, listeners: [], online: true,
    _flushTimer: null, _retryDelay: 4000, _snapTimer: null, _lastSharedSettings: null,

    async init(opts) {
      Object.assign(this, opts);
      this.online = typeof navigator === 'undefined' ? true : navigator.onLine !== false;
      await LocalDB.open('cccc-local-' + this.appName);
      if (this.mode === 'queued') {
        this.outbox = (await LocalDB.all('outbox')) || [];
        this.failed = (await LocalDB.all('failed')) || [];
      }
      if (typeof window !== 'undefined') {
        window.addEventListener('online', () => { this.online = true; this._emit(); this.flush(); });
        window.addEventListener('offline', () => { this.online = false; this._emit(); });
      }
      for (const s of this.stores) if (!Array.isArray(state[s])) state[s] = [];
    },

    onStatus(cb) { this.listeners.push(cb); cb(this.status()); },
    status() {
      return { online: this.online, pending: this.outbox.length, failed: this.failed.length, syncing: this.syncing,
        lastSync: this.lastSyncAt || null };
    },
    _emit() { const s = this.status(); this.listeners.forEach((cb) => { try { cb(s); } catch (e) { /* ignore */ } }); },

    // ------------------------------------------------ reading from Supabase
    async _select(table, build) {
      const out = [];
      const PAGE = 1000;
      for (let from = 0; ; from += PAGE) {
        let q = this.sb.from(table).select('*');
        q = build ? build(q) : q;
        const { data, error } = await q.order('id', { ascending: true }).range(from, from + PAGE - 1);
        if (error) throw error;
        out.push(...(data || []));
        if (!data || data.length < PAGE) break;
      }
      return out;
    },
    async _selectByIds(table, col, ids) {
      const out = [];
      for (const part of chunk([...new Set(ids)].filter(Boolean), 120)) {
        const rows = await this._select(table, (q) => q.eq('business_id', this.businessId).in(col, part));
        out.push(...rows);
      }
      return out;
    },
    _merge(store, rows, replaceWhere) {
      const arr = state[store] || (state[store] = []);
      if (replaceWhere) {
        for (let i = arr.length - 1; i >= 0; i--) if (replaceWhere(arr[i])) arr.splice(i, 1);
      }
      const index = new Map(arr.map((o, i) => [o.id, i]));
      for (const r of rows) {
        const obj = fromRow(store, r);
        if (index.has(obj.id)) arr[index.get(obj.id)] = obj;
        else { index.set(obj.id, arr.length); arr.push(obj); }
      }
    },
    _replaceAll(store, rows) {
      const arr = state[store] || (state[store] = []);
      arr.length = 0;
      for (const r of rows) arr.push(fromRow(store, r));
    },

    async loadSettings() {
      const { data, error } = await this.sb.from('settings').select('*').eq('business_id', this.businessId).maybeSingle();
      if (error) throw error;
      const row = data || {};
      const shared = {};
      for (const [appKey, col] of Object.entries(SETTINGS_MAP)) if (row[col] !== undefined && row[col] !== null) shared[appKey] = row[col];
      const extra = row.extra && typeof row.extra === 'object' ? row.extra : {};
      for (const k of SETTINGS_EXTRA) if (extra[k] !== undefined) shared[k] = extra[k];
      this._lastSharedSettings = clone(shared);
      this._settingsExtra = extra;
      const base = typeof DEFAULT_SETTINGS !== 'undefined' ? DEFAULT_SETTINGS : {};
      state.settings = Object.assign({}, base, shared, loadPrefs(), this.deviceSettings || {}, { key: 'app' });
      return state.settings;
    },

    windowStart() {
      return this.loadedFrom || isoDaysAgo(this.windowDays);
    },

    // Full load: all small "master" tables, plus a date window of the busy ones.
    async loadAll() {
      const from = this.loadedFrom = this.loadedFrom || isoDaysAgo(this.windowDays);
      const t0 = await this.serverTime();
      await this.loadSettings();
      const jobs = this.stores.map(async (store) => {
        const d = DEFS[store];
        if (!d || store === 'settings') return;
        if (d.parent) return; // children are loaded with their parents below
        const rows = await this._loadStoreWindow(store, from);
        this._replaceAll(store, rows);
      });
      await Promise.all(jobs);
      // children (sale items, payments, refunds, order items)
      for (const store of this.stores) {
        const d = DEFS[store];
        if (!d || !d.parent || !this.stores.includes(d.parent.store)) continue;
        const parentIds = new Set(state[d.parent.store].map((p) => p.id));
        let rows;
        if (d.sync === 'inserted_at' || d.sync === 'created_at') {
          const margin = new Date(new Date(from).getTime() - 2 * 86400000).toISOString();
          rows = await this._select(d.table, (q) => q.eq('business_id', this.businessId).gte(d.sync, margin));
          const got = new Set(rows.map((r) => r[d.parent.col]));
          const missing = [...parentIds].filter((id) => !got.has(id));
          if (missing.length && missing.length <= 600) rows = rows.concat(await this._selectByIds(d.table, d.parent.col, missing));
        } else {
          rows = await this._selectByIds(d.table, d.parent.col, [...parentIds]);
        }
        if (d.window && store === 'refunds') {
          const extra = await this._select(d.table, (q) => q.eq('business_id', this.businessId).gte(d.window.col, from));
          rows = rows.concat(extra);
        }
        const seen = new Set();
        rows = rows.filter((r) => (parentIds.has(r[d.parent.col]) || store === 'refunds') && !seen.has(r.id) && seen.add(r.id));
        this._replaceAll(store, rows);
      }
      if (this.stores.includes('inventoryTransactions')) await this._loadOpeningBalances(from);
      this._reapplyOutbox();
      this.lastServerTime = t0;
      this.lastFullMasterLoad = Date.now();
      this.lastSyncAt = new Date().toISOString();
      this._emit();
      this.scheduleSnapshot();
    },

    async _loadStoreWindow(store, from, to) {
      const d = DEFS[store];
      if (!d.window) return this._select(d.table, (q) => q.eq('business_id', this.businessId));
      let start = from;
      if (d.window.maxDays) {
        const cap = isoDaysAgo(d.window.maxDays);
        if (cap > start) start = cap;
      }
      const startVal = d.window.isDate ? dateOnly(start) : start;
      const toVal = to ? (d.window.isDate ? dateOnly(to) : to) : null;
      let rows = await this._select(d.table, (q) => {
        q = q.eq('business_id', this.businessId).gte(d.window.col, startVal);
        return toVal ? q.lt(d.window.col, toVal) : q;
      });
      if (d.window.extra && !to) {
        const [col, op, v] = d.window.extra;
        const more = await this._select(d.table, (q) => (op === 'in' ? q.eq('business_id', this.businessId).in(col, v) : q.eq('business_id', this.businessId).eq(col, v)));
        const ids = new Set(rows.map((r) => r.id));
        rows = rows.concat(more.filter((r) => !ids.has(r.id)));
      }
      return rows;
    },

    async _loadOpeningBalances(from) {
      const { data, error } = await this.sb.rpc('stock_balances_before', { p_before: dateOnly(from) });
      if (error) throw error;
      const arr = state.inventoryTransactions;
      for (let i = arr.length - 1; i >= 0; i--) if (arr[i]._synthetic) arr.splice(i, 1);
      const day = new Date(new Date(dateOnly(from) + 'T00:00:00Z').getTime() - 86400000).toISOString().slice(0, 10);
      for (const b of data || []) {
        if (!b.qty) continue;
        arr.push({ id: 'opening-' + b.ingredient_id, ingredientId: b.ingredient_id, transaction_type: 'ADJUSTMENT',
          quantity: Number(b.qty), reference_id: null, transaction_date: day, notes: 'Balance brought forward', _synthetic: true,
          created_at: day });
      }
    },

    async serverTime() {
      try {
        const { data, error } = await this.sb.rpc('server_time');
        if (error) throw error;
        return data;
      } catch (e) { return new Date().toISOString(); }
    },

    // Quick refresh: reload the small tables and fetch only what is new elsewhere.
    async refresh({ fullMasters } = {}) {
      if (!this.online) return false;
      if (!this.lastServerTime) { await this.loadAll(); return true; }
      this.syncing = true; this._emit();
      try {
        const t0 = await this.serverTime();
        const since = new Date(new Date(this.lastServerTime).getTime() - 60000).toISOString();
        await this.loadSettings();
        const doFull = fullMasters || Date.now() - this.lastFullMasterLoad > 20 * 60000;
        let needOpening = false;
        for (const store of this.stores) {
          const d = DEFS[store];
          if (!d || d.parent) continue;
          if (!d.sync) { this._replaceAll(store, await this._select(d.table, (q) => q.eq('business_id', this.businessId))); continue; }
          if (doFull && !d.window) { this._replaceAll(store, await this._select(d.table, (q) => q.eq('business_id', this.businessId))); continue; }
          let rows = await this._select(d.table, (q) => q.eq('business_id', this.businessId).gte(d.sync, since));
          if (store === 'inventoryTransactions' && this.loadedFrom) {
            // a back-dated entry older than the loaded window belongs in the carried-forward balance
            const cut = dateOnly(this.loadedFrom);
            if (rows.some((x) => String(x.transaction_date) < cut)) needOpening = true;
            rows = rows.filter((x) => String(x.transaction_date) >= cut);
          }
          this._merge(store, rows);
          // children of changed parents are reloaded completely (handles replaced lines)
          for (const childStore of d.children) {
            if (!this.stores.includes(childStore)) continue;
            const cd = DEFS[childStore];
            const parentIds = rows.map((r) => r.id);
            if (!parentIds.length) continue;
            const fresh = await this._selectByIds(cd.table, cd.parent.col, parentIds);
            const set = new Set(parentIds);
            this._merge(childStore, fresh, (o) => set.has(o[cd.parent.field]) && !o._pending);
          }
        }
        for (const store of this.stores) {
          const d = DEFS[store];
          if (!d || !d.parent || !d.sync) continue;
          const rows = await this._select(d.table, (q) => q.eq('business_id', this.businessId).gte(d.sync, since));
          this._merge(store, rows);
        }
        if (needOpening) await this._loadOpeningBalances(this.loadedFrom);
        if (doFull) this.lastFullMasterLoad = Date.now();
        this._reapplyOutbox();
        this.lastServerTime = t0;
        this.lastSyncAt = new Date().toISOString();
        this.scheduleSnapshot();
        return true;
      } finally {
        this.syncing = false; this._emit();
      }
    },

    // Make sure history back to `fromDate` is loaded (reports / calendar / older sales).
    async ensureRange(fromDate) {
      const want = new Date(fromDate);
      if (isNaN(want)) return;
      const wantIso = new Date(want.getFullYear(), want.getMonth(), want.getDate()).toISOString();
      if (!this.loadedFrom || wantIso >= this.loadedFrom) return;
      if (!this.online) throw Object.assign(new Error('offline'), { friendly: 'Older history needs an internet connection.' });
      const to = this.loadedFrom;
      for (const store of this.stores) {
        const d = DEFS[store];
        if (!d || !d.window || d.parent) continue;
        if (d.window.maxDays && store !== 'sales') continue;
        const rows = await this._loadStoreWindow(store, wantIso, to);
        this._merge(store, rows);
        for (const childStore of d.children) {
          if (!this.stores.includes(childStore)) continue;
          const cd = DEFS[childStore];
          this._merge(childStore, await this._selectByIds(cd.table, cd.parent.col, rows.map((r) => r.id)));
        }
      }
      if (this.stores.includes('refunds')) {
        this._merge('refunds', await this._select('refunds', (q) => q.eq('business_id', this.businessId).gte('date', wantIso).lt('date', to)));
      }
      this.loadedFrom = wantIso;
      if (this.stores.includes('inventoryTransactions')) await this._loadOpeningBalances(wantIso);
      this.scheduleSnapshot();
    },
    historyLoadedFrom() { return this.loadedFrom; },

    // Everything, no date window (for backups).
    async fetchEverything(stores) {
      const out = {};
      for (const store of stores) {
        const d = DEFS[store];
        if (!d) continue;
        const rows = await this._select(d.table, (q) => q.eq('business_id', this.businessId));
        out[store] = rows.map((r) => fromRow(store, r));
      }
      return out;
    },

    // ------------------------------------------------ writing
    _applyLocalPut(store, obj) {
      const arr = state[store] || (state[store] = []);
      const i = arr.findIndex((o) => o.id === obj.id);
      if (i >= 0) { if (arr[i] !== obj) arr[i] = obj; } else arr.push(obj);
    },
    _applyLocalDelete(store, id) {
      const arr = state[store] || [];
      const i = arr.findIndex((o) => o.id === id);
      if (i >= 0) arr.splice(i, 1);
    },

    async _send(op) {
      const d = DEFS[op.store];
      if (op.kind === 'upsert') {
        const rows = op.rows || [op.row];
        if (d.writeMode === 'update') {
          for (const row of rows) {
            const { id, ...patch } = row;
            const { error } = await this.sb.from(d.table).update(patch).eq('id', id).eq('business_id', this.businessId);
            if (error) throw error;
          }
          return;
        }
        const { error } = await this.sb.from(d.table).upsert(rows, { onConflict: 'id', ignoreDuplicates: !!d.appendOnly, defaultToNull: false });
        if (error) throw error;
      } else if (op.kind === 'delete') {
        const ids = op.ids || [op.id];
        const { error } = await this.sb.from(d.table).delete().eq('business_id', this.businessId).in('id', ids);
        if (error) throw error;
      }
    },

    async put(store, obj) {
      if (store === 'settings') return this.putSettings(obj);
      const d = DEFS[store];
      if (!d) throw new Error('Unknown store ' + store);
      const row = toRow(store, obj, this.businessId);
      if (this.mode === 'strict') {
        await this._send({ kind: 'upsert', store, row });
        this._applyLocalPut(store, obj);
      } else {
        this._applyLocalPut(store, obj);
        await this._enqueue({ kind: 'upsert', store, row, obj: clone(obj) });
      }
      return obj;
    },

    async bulkPut(store, arr) {
      if (!arr || !arr.length) return;
      const d = DEFS[store];
      const rows = arr.map((o) => toRow(store, o, this.businessId));
      if (this.mode === 'strict') {
        // group by identical column sets so missing columns keep their defaults
        const groups = new Map();
        rows.forEach((r) => { const k = Object.keys(r).sort().join(','); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); });
        for (const g of groups.values()) for (const part of chunk(g, 500)) await this._send({ kind: 'upsert', store, rows: part });
        arr.forEach((o) => this._applyLocalPut(store, o));
      } else {
        for (const o of arr) await this.put(store, o);
      }
    },

    async del(store, id) {
      const d = DEFS[store];
      if (!d) throw new Error('Unknown store ' + store);
      if (this.mode === 'strict') {
        await this._send({ kind: 'delete', store, id });
        this._applyLocalDelete(store, id);
      } else {
        this._applyLocalDelete(store, id);
        await this._enqueue({ kind: 'delete', store, id });
      }
    },

    async putSettings(s) {
      const shared = {};
      for (const k of Object.keys(SETTINGS_MAP)) if (s[k] !== undefined) shared[k] = s[k];
      for (const k of SETTINGS_EXTRA) if (s[k] !== undefined) shared[k] = s[k];
      const local = {};
      const skip = new Set(['key', ...Object.keys(SETTINGS_MAP), ...SETTINGS_EXTRA, ...Object.keys(this.deviceSettings || {})]);
      for (const k of Object.keys(s)) if (!skip.has(k) && !k.startsWith('__')) local[k] = s[k];
      savePrefs(local);
      state.settings = s;
      const norm = (v) => (v === undefined || v === null || v === '' ? null : v);
      const last = this._lastSharedSettings || {};
      const changed = [...new Set([...Object.keys(shared), ...Object.keys(last)])]
        .some((k) => JSON.stringify(norm(shared[k])) !== JSON.stringify(norm(last[k])));
      if (!changed) return s; // only this device's preferences changed
      const patch = {};
      for (const [k, col] of Object.entries(SETTINGS_MAP)) if (shared[k] !== undefined) patch[col] = shared[k];
      const extra = Object.assign({}, this._settingsExtra || {});
      for (const k of SETTINGS_EXTRA) if (shared[k] !== undefined) extra[k] = shared[k];
      patch.extra = extra;
      const { error } = await this.sb.from('settings').update(patch).eq('business_id', this.businessId);
      if (error) throw error;
      if (patch.business_name) {
        await this.sb.from('businesses').update({ name: patch.business_name }).eq('id', this.businessId);
      }
      this._lastSharedSettings = clone(shared);
      this._settingsExtra = extra;
      return s;
    },

    // ------------------------------------------------ outbox (queued mode)
    async _enqueue(op) {
      op.at = new Date().toISOString();
      const seq = await LocalDB.add('outbox', op);
      op.seq = seq == null ? (this._memSeq = (this._memSeq || 0) + 1) : seq;
      this.outbox.push(op);
      this._emit();
      this.scheduleSnapshot();
      clearTimeout(this._flushTimer);
      this._flushTimer = setTimeout(() => this.flush(), 60);
    },

    _reapplyOutbox() {
      for (const op of this.outbox) {
        if (op.kind === 'upsert' && op.obj) {
          const obj = Object.assign(clone(op.obj), { _pending: true });
          this._applyLocalPut(op.store, obj);
        } else if (op.kind === 'delete') {
          this._applyLocalDelete(op.store, op.id);
        }
      }
    },

    async flush() {
      if (this.mode !== 'queued') return;
      if (this._flushing) return this._flushing;
      if (!this.outbox.length) return;
      this._flushing = (async () => {
        await null; // make sure _flushing is set before the work (and its cleanup) runs
        this.syncing = true; this._emit();
        try {
          while (this.outbox.length) {
            if (!this.online && typeof navigator !== 'undefined' && navigator.onLine === false) break;
            // group consecutive operations on the same table into one request
            const first = this.outbox[0];
            const group = [first];
            const sig = (op) => op.kind + '|' + op.store + '|' + (op.row ? Object.keys(op.row).sort().join(',') : '');
            for (let i = 1; i < this.outbox.length && group.length < 200; i++) {
              const op = this.outbox[i];
              if (sig(op) !== sig(first)) break;
              group.push(op);
            }
            // the same record saved twice in a row: only its latest version needs sending
            const latest = new Map();
            if (first.kind === 'upsert') group.forEach((g) => latest.set(g.row.id, g.row));
            const batch = first.kind === 'upsert'
              ? { kind: 'upsert', store: first.store, rows: [...latest.values()] }
              : { kind: 'delete', store: first.store, ids: group.map((g) => g.id) };
            const waitAndRetry = (e) => {
              if (isAuthExpired(e) && this.sb && this.sb.auth && this.sb.auth.refreshSession) this.sb.auth.refreshSession().catch(() => {});
              this._scheduleRetry();
            };
            try {
              await this._send(batch);
              await this._done(group);
              this._retryDelay = 4000;
            } catch (e) {
              if (isNetworkError(e) || isAuthExpired(e)) { waitAndRetry(e); break; }
              if (group.length > 1) {
                // find the one bad record; send the rest
                for (const op of group) {
                  try { await this._send(op.kind === 'upsert' ? { kind: 'upsert', store: op.store, rows: [op.row] } : op); await this._done([op]); }
                  catch (e2) {
                    if (isNetworkError(e2) || isAuthExpired(e2)) { waitAndRetry(e2); return; }
                    await this._fail(op, e2);
                  }
                }
              } else {
                await this._fail(first, e);
              }
            }
          }
        } finally {
          this.syncing = false; this._flushing = null; this._emit(); this.scheduleSnapshot();
        }
      })();
      return this._flushing;
    },
    async _done(ops) {
      for (const op of ops) {
        await LocalDB.del('outbox', op.seq);
        const i = this.outbox.indexOf(op);
        if (i >= 0) this.outbox.splice(i, 1);
        if (op.kind === 'upsert' && op.obj) {
          const live = (state[op.store] || []).find((o) => o.id === op.obj.id);
          if (live && live._pending && !this.outbox.some((o) => o.obj && o.obj.id === live.id)) delete live._pending;
        }
      }
      this._emit();
    },
    async _fail(op, e) {
      const rec = Object.assign({}, op, { error: { code: e.code || '', message: String(e.message || e) }, failed_at: new Date().toISOString() });
      delete rec.seq;
      await LocalDB.add('failed', rec);
      this.failed = LocalDB._db ? await LocalDB.all('failed') : [...this.failed, rec];
      await this._done([op]);
      if (typeof console !== "undefined" && !globalThis.__QUIET__) console.warn("Upload failed and was set aside", rec.error);
    },
    _scheduleRetry() {
      clearTimeout(this._retryTimer);
      this._retryTimer = setTimeout(() => this.flush(), this._retryDelay);
      this._retryDelay = Math.min(this._retryDelay * 2, 60000);
    },
    async retryFailed() {
      const failed = LocalDB._db ? await LocalDB.all('failed') : this.failed.slice();
      await LocalDB.clear('failed');
      this.failed = [];
      for (const f of failed) { delete f.error; delete f.failed_at; delete f.seq; await this._enqueue(f); }
      return this.flush();
    },
    async discardFailed() { await LocalDB.clear('failed'); this.failed = []; this._emit(); },

    // ------------------------------------------------ offline snapshot (queued mode)
    scheduleSnapshot() {
      if (this.mode !== 'queued') return;
      clearTimeout(this._snapTimer);
      this._snapTimer = setTimeout(() => this.saveSnapshot(), 1500);
    },
    async saveSnapshot() {
      const snap = { key: 'snapshot', at: new Date().toISOString(), loadedFrom: this.loadedFrom, settings: state.settings, data: {} };
      for (const s of this.stores) snap.data[s] = state[s];
      try { await LocalDB.put('kv', JSON.parse(JSON.stringify(snap))); } catch (e) { /* storage full */ }
    },
    async loadSnapshot() {
      const snap = await LocalDB.get('kv', 'snapshot');
      if (!snap) return false;
      for (const s of this.stores) state[s] = snap.data[s] || [];
      state.settings = Object.assign({}, snap.settings || {}, loadPrefs(), this.deviceSettings || {}, { key: 'app' });
      this.loadedFrom = snap.loadedFrom;
      this._reapplyOutbox();
      this.lastSyncAt = snap.at;
      return true;
    },
    async clearLocal() {
      await LocalDB.clear('outbox'); await LocalDB.clear('failed'); await LocalDB.clear('kv');
      this.outbox = []; this.failed = [];
    },

    // ------------------------------------------------ misc
    async rpc(name, args) {
      const { data, error } = await this.sb.rpc(name, args || {});
      if (error) throw error;
      return data;
    },
    LocalDB, DEFS, toRow, fromRow, friendlyError, isNetworkError, isAuthExpired, SETTINGS_MAP,
  };

  // ---------------------------------------------------------------- the old DB interface
  const DB = {
    async all(store) { return store === 'settings' ? [state.settings] : (state[store] || (state[store] = [])); },
    async get(store, id) {
      if (store === 'settings') return state.settings || null;
      if (store === 'deviceConfig') return LocalDB.get('kv', 'deviceConfig:' + id).then((r) => (r ? r.value : undefined));
      return (state[store] || []).find((o) => o.id === id);
    },
    async put(store, obj) {
      if (store === 'deviceConfig') { await LocalDB.put('kv', { key: 'deviceConfig:' + obj.key, value: obj }); return obj; }
      return Data.put(store, obj);
    },
    async bulkPut(store, arr) { return Data.bulkPut(store, arr); },
    async delete(store, id) {
      if (store === 'deviceConfig') return LocalDB.del('kv', 'deviceConfig:' + id);
      return Data.del(store, id);
    },
    async byIndex(store, field, value) {
      let res = (state[store] || []).filter((o) => o[field] === value);
      const d = DEFS[store];
      if (!res.length && d && d.parent && d.parent.field === field && Data.online && Data.sb) {
        try {
          const rows = await Data._selectByIds(d.table, d.parent.col, [value]);
          Data._merge(store, rows);
          res = (state[store] || []).filter((o) => o[field] === value);
        } catch (e) { /* offline or not allowed: keep what we have */ }
      }
      return res;
    },
    async pageByIndex(store, indexName, { limit = 50, offset = 0, direction = 'prev' } = {}) {
      const sorted = () => (state[store] || []).filter((o) => !o._synthetic).slice().sort((a, b) => {
        const x = String(a[indexName] || ''), y = String(b[indexName] || '');
        return direction === 'prev' ? (x < y ? 1 : x > y ? -1 : 0) : (x < y ? -1 : x > y ? 1 : 0);
      });
      let list = sorted();
      if (list.length < offset + limit && Data.online && Data.loadedFrom && store === 'sales') {
        const older = new Date(new Date(Data.loadedFrom).getTime() - 60 * 86400000);
        try { await Data.ensureRange(older); list = sorted(); } catch (e) { /* offline */ }
      }
      return list.slice(offset, offset + limit);
    },
    async countByIndex(store, indexName, value) {
      return (state[store] || []).filter((o) => value === undefined || o[indexName] === value).length;
    },
    async clearStore() { throw new Error('Clearing a whole table is not available any more.'); },
  };

  global.Data = Data;
  global.DB = DB;
  global.friendlyError = friendlyError;
})(typeof window !== 'undefined' ? window : globalThis);
