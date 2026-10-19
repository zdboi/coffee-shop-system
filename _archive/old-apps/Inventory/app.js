/* ================= App Bootstrap (Inventory-specific) =================
   Shared state, domain logic (costing/inventory), and backup core now live
   in logic.js so the POS app uses the exact same engine — see logic.js. */

async function bootstrap(){
  await openDB();
  state.settings = (await DB.get('settings','app')) || null;
  if(!state.settings){
    state.settings = {...DEFAULT_SETTINGS, schemaVersion: SCHEMA_VERSION, device_tag: shortDeviceTag()};
    await DB.put('settings', state.settings);
    await seedInitialData();
  } else {
    // Merge in any new setting keys introduced by this update without touching existing values.
    let changed = false;
    for(const k of Object.keys(DEFAULT_SETTINGS)){
      if(!(k in state.settings)){ state.settings[k] = DEFAULT_SETTINGS[k]; changed = true; }
    }
    if(!state.settings.device_tag){ state.settings.device_tag = shortDeviceTag(); changed = true; }
    if(changed) await DB.put('settings', state.settings);
  }
  await loadAll();
  await runMigrationSafetyCheck();
  await ensureProducedCategory();
  renderShell();
  navigate('dashboard');
  updateOnlinePill();
  applyCustomTheme();
  applyDynamicManifest();
  window.addEventListener('online', updateOnlinePill);
  window.addEventListener('offline', updateOnlinePill);
  maybeRegisterSW();
  maybeAutoBackup();
}

// One-time, best-effort safety net: schema changes are purely additive (see db.js) so no
// existing data is ever touched by them. Even so, an explicit backup checkpoint is taken
// automatically the first time a newer build runs against an older database.
async function runMigrationSafetyCheck(){
  if(_wasUpgraded && (state.settings.schemaVersion||1) < SCHEMA_VERSION){
    try{
      await exportDatabase(true, 'pre-update-safety-backup');
      toast('App updated — a safety backup was downloaded automatically.', 'success');
    }catch(e){ console.warn('Safety backup failed', e); }
    state.settings.schemaVersion = SCHEMA_VERSION;
    await DB.put('settings', state.settings);
  } else if((state.settings.schemaVersion||1) < SCHEMA_VERSION){
    state.settings.schemaVersion = SCHEMA_VERSION;
    await DB.put('settings', state.settings);
  }
}

function toast(msg, type='success'){
  const wrap = document.getElementById('toast-wrap');
  const el = document.createElement('div');
  el.className = 'toast '+type;
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(()=>{ el.style.opacity='0'; el.style.transition='opacity .3s'; setTimeout(()=>el.remove(),300); }, 3200);
}

function updateOnlinePill(){
  const pill = document.getElementById('offline-pill');
  if(!pill) return;
  if(navigator.onLine){ pill.className='online'; pill.innerHTML='<span class="dot"></span> Online'; }
  else { pill.className='offline'; pill.innerHTML='<span class="dot"></span> Offline — working locally'; }
}

function confirmDialog(message){
  return new Promise(resolve=>{
    openModal({
      title:'Please confirm', wide:false,
      body: `<p>${message}</p>`,
      foot: `<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-danger" data-ok>Confirm</button>`,
      onMount:(root)=>{
        root.querySelector('[data-cancel]').onclick = ()=>{closeModal(); resolve(false);};
        root.querySelector('[data-ok]').onclick = ()=>{closeModal(); resolve(true);};
      }
    });
  });
}

/* ================= Shell, Nav, Modal ================= */
const NAV_ITEMS = [
  {id:'dashboard', label:'Dashboard', ic:'◈'},
  {id:'ingredients', label:'Ingredients', ic:'🌿'},
  {id:'purchases', label:'Purchases', ic:'🧾'},
  {id:'production', label:'Production', ic:'🏭'},
  {id:'recipes', label:'Recipes', ic:'📖'},
  {id:'inventory', label:'Inventory', ic:'📦'},
  {id:'costing', label:'Costing', ic:'💰'},
  {id:'suppliers', label:'Suppliers', ic:'🚚'},
  {id:'reports', label:'Reports', ic:'📊'},
  {id:'settings', label:'Settings', ic:'⚙'},
];

function renderShell(){
  const logo = state.settings.logo ? `<img src="${state.settings.logo}" alt="logo" style="width:26px;height:26px;object-fit:contain;border-radius:6px;vertical-align:middle;margin-right:2px;">` : '☕';
  document.getElementById('sidebar').innerHTML = `
    <div class="brand">${logo} <span>${escapeHtml(appDisplayName())}</span><small>${escapeHtml(businessName()) || 'Inventory & Costing'}</small></div>
    <div id="nav">${NAV_ITEMS.map(n=>`<div class="nav-item" data-route="${n.id}"><span class="ic">${n.ic}</span><span class="label">${n.label}</span></div>`).join('')}</div>
    <div id="sidebar-foot"><span id="offline-pill" class="online"><span class="dot"></span> Online</span></div>
  `;
  document.getElementById('nav').addEventListener('click', (e)=>{
    const item = e.target.closest('.nav-item');
    if(item) navigate(item.dataset.route);
  });
  document.title = appDisplayName() + (businessName()? ' — '+businessName() : '');
}
function escapeHtml(s){ return String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

const ROUTE_TITLES = {
  dashboard:'Dashboard', ingredients:'Ingredients', purchases:'Purchases', production:'Production', recipes:'Recipes',
  inventory:'Inventory', costing:'Recipe Costing', suppliers:'Suppliers', reports:'Reports', settings:'Settings',
  ingredientDetail:'Ingredient Detail', recipeDetail:'Recipe',
};

function navigate(route, param=null){
  state.route = route; state.routeParam = param;
  document.querySelectorAll('.nav-item').forEach(el=> el.classList.toggle('active', el.dataset.route===route));
  document.getElementById('topbar-title').textContent = ROUTE_TITLES[route] || '';
  const renderers = {
    dashboard: renderDashboard, ingredients: renderIngredients, purchases: renderPurchases,
    production: renderProduction, recipes: renderRecipes, inventory: renderInventory, costing: renderCosting,
    suppliers: renderSuppliers, reports: renderReports, settings: renderSettings,
    ingredientDetail: ()=>renderIngredientDetail(param), recipeDetail: ()=>renderRecipeDetail(param),
  };
  renderTopbarActions(route);
  (renderers[route]||renderDashboard)();
}

function renderTopbarActions(route){
  const wrap = document.getElementById('topbar-actions');
  const map = {
    ingredients: `<button class="btn btn-primary" id="btn-new-ingredient">+ Add Ingredient</button>`,
    purchases: `<button class="btn btn-primary" id="btn-new-purchase">+ New Purchase</button>`,
    production: `<button class="btn btn-primary" id="btn-new-production">+ New Production</button>`,
    recipes: `<button class="btn btn-primary" id="btn-new-recipe">+ New Recipe</button>`,
    suppliers: `<button class="btn btn-primary" id="btn-new-supplier">+ Add Supplier</button>`,
    inventory: `<button class="btn btn-outline" id="btn-new-waste">Record Waste</button> <button class="btn btn-primary" id="btn-new-adjustment">Adjust Stock</button>`,
  };
  wrap.innerHTML = map[route] || '';
  if(route==='ingredients') wrap.querySelector('#btn-new-ingredient').onclick = ()=>openIngredientForm();
  if(route==='purchases') wrap.querySelector('#btn-new-purchase').onclick = ()=>openPurchaseForm();
  if(route==='production') wrap.querySelector('#btn-new-production').onclick = ()=>openProductionForm();
  if(route==='recipes') wrap.querySelector('#btn-new-recipe').onclick = ()=>openRecipeForm();
  if(route==='suppliers') wrap.querySelector('#btn-new-supplier').onclick = ()=>openSupplierForm();
  if(route==='inventory'){
    wrap.querySelector('#btn-new-waste').onclick = ()=>openWasteForm();
    wrap.querySelector('#btn-new-adjustment').onclick = ()=>openAdjustmentForm();
  }
}

function openModal({title, body, foot, wide, onMount}){
  closeModal();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'active-modal-overlay';
  overlay.innerHTML = `
    <div class="modal ${wide?'wide':''}">
      <div class="modal-head"><h2>${title}</h2><button class="close-x" id="modal-close">✕</button></div>
      <div class="modal-body">${body}</div>
      ${foot? `<div class="modal-foot">${foot}</div>`:''}
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#modal-close').onclick = closeModal;
  overlay.addEventListener('mousedown', (e)=>{ if(e.target===overlay) closeModal(); });
  if(onMount) onMount(overlay);
}
function closeModal(){
  const el = document.getElementById('active-modal-overlay');
  if(el) el.remove();
}

function el(html){
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

/* ================= Dashboard ================= */
function renderDashboard(){
  const content = document.getElementById('content');
  const activeIngredients = state.ingredients.filter(i=>i.active!==false);
  const rawActive = activeIngredients.filter(i=>!isProducedItem(i));
  const producedActive = activeIngredients.filter(i=>isProducedItem(i));
  const invValue = activeIngredients.reduce((sum,i)=> sum + ingredientStock(i.id) * (ingredientCosting(i.id).current||0), 0);
  const lowStockRaw = rawActive.filter(i=> stockStatus(ingredientStock(i.id), i.reorder_level)==='LOW');
  const outStockRaw = rawActive.filter(i=> stockStatus(ingredientStock(i.id), i.reorder_level)==='OUT');
  const lowStockProduced = producedActive.filter(i=> stockStatus(ingredientStock(i.id), i.reorder_level)==='LOW');
  const outStockProduced = producedActive.filter(i=> stockStatus(ingredientStock(i.id), i.reorder_level)==='OUT');

  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const purchasesThisMonth = state.purchases.filter(p=> new Date(p.purchase_date).getTime() >= monthStart);
  const purchaseTotal = purchasesThisMonth.reduce((s,p)=>s+Number(p.total_price||0),0);
  const wasteThisMonth = state.waste.filter(w=> new Date(w.date).getTime() >= monthStart);
  const wasteCost = wasteThisMonth.reduce((s,w)=> s + Number(w.quantity||0) * (ingredientCosting(w.ingredientId).current||0), 0);

  const productionToday = state.productionBatches.filter(b=> new Date(b.production_date).getTime() >= dayStart);
  const productionThisMonth = state.productionBatches.filter(b=> new Date(b.production_date).getTime() >= monthStart);
  const productionCostThisMonth = productionThisMonth.reduce((s,b)=>s+Number(b.raw_cost_total||0),0);
  const productionWasteThisMonth = productionThisMonth.reduce((s,b)=>{
    const wasteQty = Math.max(0, Number(b.expected_yield||0) - Number(b.actual_yield||0));
    const perUnit = Number(b.actual_cost_per_unit||0);
    return s + wasteQty*perUnit;
  }, 0);

  const activeRecipes = state.recipes.filter(r=>r.active!==false);
  const recipeStats = activeRecipes.map(r=>({recipe:r, ...recipeMetrics(r)}));
  const avgFoodCost = recipeStats.length ? recipeStats.reduce((s,r)=>s+r.foodCostPct,0)/recipeStats.length : 0;
  const highestCost = recipeStats.slice().sort((a,b)=>b.cost-a.cost)[0];
  const highestProfit = recipeStats.slice().sort((a,b)=>b.profit-a.profit)[0];

  const recentPurchases = state.purchases.slice().sort((a,b)=> new Date(b.created_at)-new Date(a.created_at)).slice(0,5);
  const recentTxns = state.inventoryTransactions.slice().sort((a,b)=> new Date(b.created_at)-new Date(a.created_at)).slice(0,5);
  const recentRecipes = state.recipes.slice().sort((a,b)=> new Date(b.updated_at||b.created_at)-new Date(a.updated_at||a.created_at)).slice(0,5);
  const recentProduction = state.productionBatches.slice().sort((a,b)=> new Date(b.created_at)-new Date(a.created_at)).slice(0,5);

  content.innerHTML = `
    <div class="grid grid-4">
      ${statCard('Total Ingredients', activeIngredients.length, `${rawActive.length} raw · ${producedActive.length} produced`)}
      ${statCard('Total Recipes', activeRecipes.length, `${state.recipes.length} total`)}
      ${statCard('Inventory Value', fmtMoney(invValue), 'at current cost')}
      ${statCard('Low Stock Ingredients', `${lowStockRaw.length} / ${outStockRaw.length}`, 'low / out of stock (raw)')}
    </div>
    <div class="grid grid-4" style="margin-top:16px;">
      ${statCard('Low Stock Produced Items', `${lowStockProduced.length} / ${outStockProduced.length}`, 'low / out of stock (house-made)')}
      ${statCard('Production Today', productionToday.length, `${productionThisMonth.length} this month`)}
      ${statCard('Purchases This Month', fmtMoney(purchaseTotal), `${purchasesThisMonth.length} purchases`)}
      ${statCard('Avg. Food Cost %', fmtNum(avgFoodCost,1)+'%', 'across active recipes')}
    </div>
    <div class="grid grid-4" style="margin-top:16px;">
      ${statCard('Production Cost This Month', fmtMoney(productionCostThisMonth), `${productionThisMonth.length} batches`)}
      ${statCard('Production Waste This Month', fmtMoney(productionWasteThisMonth), 'yield loss, at cost')}
      ${statCard('Waste This Month', fmtMoney(wasteCost), `${wasteThisMonth.length} ingredient entries`)}
      ${statCard('Highest Cost Recipe', highestCost? highestCost.recipe.name : '—', highestCost? fmtMoney(highestCost.cost):'')}
    </div>

    ${(lowStockProduced.length||outStockProduced.length) ? `
    <div class="section-title">⚠ Produced Items Running Low</div>
    <div class="grid grid-3">${[...outStockProduced, ...lowStockProduced].map(i=>`
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <b>${i.name}</b> ${statusBadge(stockStatus(ingredientStock(i.id), i.reorder_level))}
        </div>
        <div class="text-light" style="font-size:13px;margin-top:6px;">Current: ${fmtNum(ingredientStock(i.id),2)} ${i.base_unit} · Reorder at ${fmtNum(i.reorder_level,1)} ${i.base_unit}</div>
        <button class="btn btn-sm btn-amber" style="margin-top:10px;" data-produce="${i.id}">+ Produce Another Batch</button>
      </div>`).join('')}</div>
    ` : ''}

    <div class="section-title">Recent Activity</div>
    <div class="grid grid-3">
      <div class="card">
        <b>Recent Purchases</b>
        ${recentPurchases.length? recentPurchases.map(p=>`<div style="padding:8px 0;border-top:1px solid var(--beige);font-size:13.5px;">
          <b>${ingName(p.ingredientId)}</b> — ${fmtMoney(p.total_price)} <span class="text-light">(${fmtDate(p.purchase_date)})</span></div>`).join('') : emptyLine('No purchases yet')}
      </div>
      <div class="card">
        <b>Recently Produced</b>
        ${recentProduction.length? recentProduction.map(b=>`<div style="padding:8px 0;border-top:1px solid var(--beige);font-size:13.5px;">
          <b>${ingName(b.producedIngredientId)}</b> — ${fmtNum(b.actual_yield,1)} ${b.yield_unit} <span class="text-light">(${fmtDate(b.production_date)})</span></div>`).join('') : emptyLine('No production yet')}
      </div>
      <div class="card">
        <b>Recently Edited Recipes</b>
        ${recentRecipes.length? recentRecipes.map(r=>`<div style="padding:8px 0;border-top:1px solid var(--beige);font-size:13.5px;">
          <a class="linklike" data-recipe="${r.id}">${r.name}</a> <span class="text-light">(${fmtDate(r.updated_at||r.created_at)})</span></div>`).join('') : emptyLine('No recipes yet')}
      </div>
    </div>
    ${(highestProfit) ? `<div class="section-title">Highest Profit Recipe</div><div class="card">
      <b>${highestProfit.recipe.name}</b> — Gross profit ${fmtMoney(highestProfit.profit)} on selling price ${fmtMoney(highestProfit.recipe.selling_price)}
    </div>` : ''}
  `;
  content.querySelectorAll('[data-recipe]').forEach(a=> a.onclick = ()=>navigate('recipeDetail', a.dataset.recipe));
  content.querySelectorAll('[data-produce]').forEach(btn=> btn.onclick = ()=>openProductionForm(sourceRecipeForIngredient(ingredientById(btn.dataset.produce))?.id));
}

function statCard(label, value, sub){
  return `<div class="card stat-card"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub||''}</div></div>`;
}
function emptyLine(text){
  return `<div class="text-light" style="padding:14px 0;font-size:13.5px;">${text}</div>`;
}

/* ================= Ingredients ================= */
let ingFilterState = {search:'', category:'', status:'', type:''};

function renderIngredients(){
  const content = document.getElementById('content');
  content.innerHTML = `
    <div class="toolbar">
      <div class="toolbar-left">
        <div class="search-box"><input type="text" placeholder="Search ingredients..." id="ing-search" value="${ingFilterState.search}"></div>
        <select class="filter" id="ing-type-filter">
          <option value="">All Types</option>
          <option value="RAW" ${ingFilterState.type==='RAW'?'selected':''}>Raw Ingredients</option>
          <option value="PRODUCED" ${ingFilterState.type==='PRODUCED'?'selected':''}>Produced Items</option>
        </select>
        <select class="filter" id="ing-cat-filter">
          <option value="">All Categories</option>
          ${state.categories.map(c=>`<option value="${c.id}" ${ingFilterState.category===c.id?'selected':''}>${c.name}</option>`).join('')}
        </select>
        <select class="filter" id="ing-status-filter">
          <option value="">All Status</option>
          <option value="IN" ${ingFilterState.status==='IN'?'selected':''}>In Stock</option>
          <option value="LOW" ${ingFilterState.status==='LOW'?'selected':''}>Low Stock</option>
          <option value="OUT" ${ingFilterState.status==='OUT'?'selected':''}>Out of Stock</option>
        </select>
      </div>
      <div class="text-light" style="font-size:13px;">${state.ingredients.filter(i=>i.active!==false).length} active ingredients</div>
    </div>
    <div id="ing-table-wrap"></div>
  `;
  document.getElementById('ing-search').oninput = (e)=>{ ingFilterState.search = e.target.value; renderIngredientsTable(); };
  document.getElementById('ing-type-filter').onchange = (e)=>{ ingFilterState.type = e.target.value; renderIngredientsTable(); };
  document.getElementById('ing-cat-filter').onchange = (e)=>{ ingFilterState.category = e.target.value; renderIngredientsTable(); };
  document.getElementById('ing-status-filter').onchange = (e)=>{ ingFilterState.status = e.target.value; renderIngredientsTable(); };
  renderIngredientsTable();
}

function renderIngredientsTable(){
  const wrap = document.getElementById('ing-table-wrap');
  let list = state.ingredients.filter(i=>i.active!==false);
  if(ingFilterState.search) list = list.filter(i=> i.name.toLowerCase().includes(ingFilterState.search.toLowerCase()));
  if(ingFilterState.type==='RAW') list = list.filter(i=>!isProducedItem(i));
  if(ingFilterState.type==='PRODUCED') list = list.filter(i=>isProducedItem(i));
  if(ingFilterState.category) list = list.filter(i=> i.categoryId===ingFilterState.category);
  if(ingFilterState.status) list = list.filter(i=> stockStatus(ingredientStock(i.id), i.reorder_level)===ingFilterState.status);
  list.sort((a,b)=>a.name.localeCompare(b.name));

  if(list.length===0){ wrap.innerHTML = `<div class="table-wrap"><div class="empty-state"><div class="big">🌿</div>No ingredients found.<br><br><button class="btn btn-primary" id="empty-add-ing">+ Add Ingredient</button></div></div>`;
    wrap.querySelector('#empty-add-ing').onclick = ()=>openIngredientForm(); return; }

  wrap.innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>Ingredient</th><th>Type</th><th>Category</th><th>Stock</th><th>Unit</th><th>Current Cost</th><th>Reorder Lvl</th><th>Status</th><th></th></tr></thead>
    <tbody>
      ${list.map(i=>{
        const stock = ingredientStock(i.id);
        const costing = ingredientCosting(i.id);
        const status = stockStatus(stock, i.reorder_level);
        return `<tr class="clickable" data-id="${i.id}">
          <td><b>${i.name}</b></td>
          <td>${isProducedItem(i)?'<span class="badge badge-gray">Produced</span>':'<span class="badge badge-gray" style="opacity:.6;">Raw</span>'}</td>
          <td>${catName(i.categoryId)}</td>
          <td>${fmtNum(stock,2)}</td>
          <td>${i.base_unit}</td>
          <td>${fmtMoney(costing.current)}/${i.base_unit}</td>
          <td>${fmtNum(i.reorder_level,1)}</td>
          <td>${statusBadge(status)}</td>
          <td><button class="btn btn-sm btn-ghost" data-edit="${i.id}">Edit</button></td>
        </tr>`;
      }).join('')}
    </tbody>
  </table></div>`;
  wrap.querySelectorAll('tr[data-id]').forEach(tr=>{
    tr.onclick = (e)=>{ if(e.target.closest('[data-edit]')) return; navigate('ingredientDetail', tr.dataset.id); };
  });
  wrap.querySelectorAll('[data-edit]').forEach(btn=> btn.onclick=(e)=>{ e.stopPropagation(); openIngredientForm(btn.dataset.edit); });
}

function statusBadge(status){
  if(status==='IN') return `<span class="badge badge-green">In Stock</span>`;
  if(status==='LOW') return `<span class="badge badge-yellow">Low Stock</span>`;
  return `<span class="badge badge-red">Out of Stock</span>`;
}

function openIngredientForm(id){
  const editing = id ? ingredientById(id) : null;
  const produced = editing && isProducedItem(editing);
  const sourceRecipe = produced ? sourceRecipeForIngredient(editing) : null;
  const body = `
    ${produced?`<div class="card" style="background:var(--beige);box-shadow:none;margin-bottom:14px;font-size:13px;">
      This is a <b>produced item</b>, linked to the recipe <a class="linklike" id="goto-source-recipe">${sourceRecipe?sourceRecipe.name:'(recipe deleted)'}</a>.
      Name, base unit, and yield are managed from that recipe. Reorder level, category, supplier, and storage info can still be edited here.
    </div>`:''}
    <div class="form-row"><label>Ingredient Name</label><input id="f-name" value="${editing?editing.name:''}" placeholder="e.g. Milk" ${produced?'disabled':''}></div>
    <div class="form-grid">
      <div class="form-row"><label>Category</label><select id="f-cat">${state.categories.map(c=>`<option value="${c.id}" ${editing&&editing.categoryId===c.id?'selected':''}>${c.name}</option>`).join('')}</select></div>
      <div class="form-row"><label>Default Supplier</label><select id="f-sup"><option value="">—</option>${state.suppliers.map(s=>`<option value="${s.id}" ${editing&&editing.supplierId===s.id?'selected':''}>${s.name}</option>`).join('')}</select></div>
    </div>
    <div class="form-grid">
      <div class="form-row"><label>Base Unit</label><select id="f-unit" ${produced?'disabled':''}>
        ${['g','kg','ml','L','pcs','box','pack'].map(u=>`<option value="${u}" ${editing&&editing.base_unit===u?'selected':''}>${u}</option>`).join('')}
      </select><div class="hint">The unit costing & recipes will use (e.g. g, ml, pcs)</div></div>
      <div class="form-row"><label>Reorder Level</label><input id="f-reorder" type="number" step="any" value="${editing?editing.reorder_level:state.settings.lowStockDefaultThreshold}"></div>
    </div>
    ${produced?`<div class="form-grid">
      <div class="form-row"><label>Shelf Life (days, optional)</label><input id="f-shelflife" type="number" step="1" value="${editing.shelf_life_days||''}"></div>
      <div class="form-row"><label>Storage Notes</label><input id="f-storage" value="${editing.storage_notes||''}" placeholder="e.g. Refrigerated"></div>
    </div>`:''}
    ${!editing?`<div class="form-row"><label>Starting Stock (optional)</label><input id="f-initial" type="number" step="any" value="0"><div class="hint">Recorded as an INITIAL STOCK transaction</div></div>`:''}
    <div class="form-row"><label>Notes</label><textarea id="f-notes" rows="2">${editing?(editing.notes||''):''}</textarea></div>
  `;
  const foot = `
    ${editing?`<button class="btn btn-danger" id="btn-delete-ing" style="margin-right:auto;">Delete</button>`:''}
    <button class="btn btn-outline" data-cancel>Cancel</button>
    <button class="btn btn-primary" id="btn-save-ing">${editing?'Save Changes':'Add Ingredient'}</button>
  `;
  openModal({title: editing?'Edit Ingredient':'Add Ingredient', body, foot, onMount:(root)=>{
    root.querySelector('[data-cancel]').onclick = closeModal;
    if(produced && root.querySelector('#goto-source-recipe')){
      root.querySelector('#goto-source-recipe').onclick = ()=>{ closeModal(); navigate('recipeDetail', sourceRecipe.id); };
    }
    if(editing){
      root.querySelector('#btn-delete-ing').onclick = async ()=>{
        const usedInRecipes = state.recipeIngredients.some(ri=>ri.ingredientId===editing.id);
        const hasPurchases = purchasesFor(editing.id).length>0;
        const hasProduction = productionBatchesFor(editing.id).length>0;
        if(usedInRecipes || hasPurchases || hasProduction || produced){
          toast('This ingredient has history or is a linked produced item. Marking it Inactive instead.', 'warn');
          const ok = await confirmDialog(`"${editing.name}" ${produced?'is a produced item linked to a recipe':'is used in recipes or has purchase history'} and can't be deleted. Mark it INACTIVE instead? It will be hidden from active lists but history is preserved.`);
          if(ok){ editing.active=false; editing.updated_at=new Date().toISOString(); await DB.put('ingredients', editing); await loadAll(); closeModal(); navigate('ingredients'); toast('Ingredient marked inactive'); }
          return;
        }
        const ok = await confirmDialog(`Delete "${editing.name}"? This cannot be undone.`);
        if(ok){ await DB.delete('ingredients', editing.id); await loadAll(); closeModal(); navigate('ingredients'); toast('Ingredient deleted'); }
      };
    }
    root.querySelector('#btn-save-ing').onclick = async ()=>{
      const name = produced ? editing.name : root.querySelector('#f-name').value.trim();
      if(!name){ toast('Please enter an ingredient name','error'); return; }
      const now = new Date().toISOString();
      const obj = editing || {id: uid('ing'), created_at: now, active:true};
      obj.name = name;
      obj.categoryId = root.querySelector('#f-cat').value;
      obj.supplierId = root.querySelector('#f-sup').value || null;
      obj.base_unit = produced ? editing.base_unit : root.querySelector('#f-unit').value;
      obj.reorder_level = Number(root.querySelector('#f-reorder').value)||0;
      obj.notes = root.querySelector('#f-notes').value;
      if(produced){
        obj.shelf_life_days = Number(root.querySelector('#f-shelflife').value)||null;
        obj.storage_notes = root.querySelector('#f-storage').value;
      }
      obj.updated_at = now;
      await DB.put('ingredients', obj);
      if(!editing){
        const initQty = Number(root.querySelector('#f-initial')?.value)||0;
        if(initQty>0){
          await DB.put('inventoryTransactions', {id:uid('txn'), ingredientId:obj.id, transaction_type:'INITIAL_STOCK', quantity:initQty, reference_id:null, transaction_date:now, notes:'Starting stock', created_at:now});
        }
      }
      await loadAll();
      closeModal();
      toast(editing? 'Ingredient updated':'Ingredient added');
      if(state.route==='ingredientDetail') navigate('ingredientDetail', obj.id); else navigate('ingredients');
    };
  }});
}

/* ================= Ingredient Detail ================= */
function renderIngredientDetail(id){
  const content = document.getElementById('content');
  const ing = ingredientById(id);
  if(!ing){ content.innerHTML = `<div class="empty-state">Ingredient not found. <a class="linklike" onclick="navigate('ingredients')">Back to ingredients</a></div>`; return; }
  const costing = ingredientCosting(id);
  const produced = isProducedItem(ing);
  const sourceRecipe = produced ? sourceRecipeForIngredient(ing) : null;
  const stock = ingredientStock(id);
  const status = stockStatus(stock, ing.reorder_level);
  const purchases = purchasesFor(id).sort((a,b)=> new Date(b.purchase_date)-new Date(a.purchase_date));
  const batches = productionBatchesFor(id).sort((a,b)=> new Date(b.production_date)-new Date(a.production_date));
  const txns = txnsFor(id).sort((a,b)=> new Date(b.transaction_date)-new Date(a.transaction_date));
  const usingRecipes = state.recipes.filter(r=> state.recipeIngredients.some(ri=>ri.recipeId===r.id && ri.ingredientId===id));
  const hasCurrentCost = produced ? (sourceRecipe && Number(sourceRecipe.expected_yield)>0) : costing.count>0;

  content.innerHTML = `
    <a class="linklike" id="back-ing" style="font-size:13px;">← Back to Ingredients</a>
    <div class="ingredient-detail-header" style="margin-top:10px;">
      <div>
        <h2 style="font-family:var(--font-display);font-size:26px;">${ing.name} ${ing.active===false?'<span class="badge badge-gray">Inactive</span>':''} ${produced?'<span class="badge badge-gray">Produced</span>':''}</h2>
        <div style="margin-top:6px;display:flex;gap:8px;align-items:center;">
          <span class="tag-pill">${catName(ing.categoryId)}</span>
          <span class="tag-pill">${ing.base_unit}</span>
          ${statusBadge(status)}
          ${produced && sourceRecipe? `<a class="linklike" data-recipe="${sourceRecipe.id}" style="font-size:12.5px;">Recipe: ${sourceRecipe.name} →</a>`:''}
        </div>
      </div>
      <div style="display:flex;gap:8px;">
        ${produced?`<button class="btn btn-amber" id="produce-btn">+ Produce</button>`:''}
        <button class="btn btn-outline" id="edit-ing-btn">Edit Ingredient</button>
      </div>
    </div>

    <div class="grid grid-4" style="margin-top:20px;">
      ${statCard('Current Stock', fmtNum(stock,2)+' '+ing.base_unit, 'Reorder at '+fmtNum(ing.reorder_level,1))}
      ${statCard('Current Cost', hasCurrentCost?fmtMoney(costing.current)+'/'+ing.base_unit : '—', produced?'Live cost from recipe':(costing.method==='latest'?'Latest purchase':'Weighted average'))}
      ${statCard(produced?'Latest Batch Cost':'Latest Purchase Cost', costing.latest!=null?fmtMoney(costing.latest):'—', '')}
      ${statCard(produced?'Weighted Avg. Batch Cost':'Weighted Average Cost', costing.weightedAvg!=null?fmtMoney(costing.weightedAvg):'—', produced?`${costing.count} batch(es)`:`${costing.count} purchase(s)`)}
    </div>
    <div class="grid grid-2" style="margin-top:16px;">
      ${statCard('Lowest / Highest Cost', costing.count? `${fmtMoney(costing.lowest)} / ${fmtMoney(costing.highest)}`:'—', produced?'across production batches':'across purchase history')}
      ${statCard('Inventory Value', fmtMoney(stock*(costing.current||0)), 'stock × current cost')}
    </div>
    ${produced?`<p class="hint" style="margin-top:10px;">This item's cost in other recipes is calculated live from its recipe (${sourceRecipe?sourceRecipe.name:'—'}) and current ingredient costs — it updates automatically, the same way a raw ingredient updates when you record a new purchase. Batch figures above are for reference/reporting.</p>`:''}

    ${produced? `
    <div class="section-title">Production History</div>
    ${batches.length? `<div class="table-wrap"><table>
      <thead><tr><th>Date</th><th>Batch #</th><th>Expected</th><th>Actual Yield</th><th>Production Cost</th><th>Cost/Unit</th></tr></thead>
      <tbody>${batches.map(b=>`<tr>
        <td>${fmtDate(b.production_date)}</td><td>${b.batch_number||'—'}</td>
        <td>${fmtNum(b.expected_yield,2)} ${b.yield_unit}</td><td>${fmtNum(b.actual_yield,2)} ${b.yield_unit}</td>
        <td>${fmtMoney(b.raw_cost_total)}</td><td class="mono">${fmtMoney(b.actual_cost_per_unit)}/${b.yield_unit}</td>
      </tr>`).join('')}</tbody></table></div>` : emptyBlock('No production batches recorded yet. Click "+ Produce" to make your first batch.')}
    ` : `
    <div class="section-title">Purchase History</div>
    ${purchases.length? `<div class="table-wrap"><table>
      <thead><tr><th>Date</th><th>Supplier</th><th>Invoice #</th><th>Quantity</th><th>Unit</th><th>Total Price</th><th>Price / Base Unit</th></tr></thead>
      <tbody>${purchases.map(p=>`<tr>
        <td>${fmtDate(p.purchase_date)}</td><td>${supName(p.supplierId)}</td><td>${p.invoice_number||'—'}</td>
        <td>${fmtNum(p.quantity,2)}</td><td>${p.purchase_unit}</td><td>${fmtMoney(p.total_price)}</td>
        <td class="mono">${fmtMoney(p.price_per_base_unit)}/${ing.base_unit}</td>
      </tr>`).join('')}</tbody></table></div>` : emptyBlock('No purchases recorded yet for this ingredient.')}
    `}

    <div class="section-title">Inventory History</div>
    ${txns.length? `<div class="table-wrap"><table>
      <thead><tr><th>Date</th><th>Type</th><th>Quantity</th><th>Running Stock</th><th>Notes</th></tr></thead>
      <tbody>${runningStockRows(txns, ing.base_unit)}</tbody></table></div>` : emptyBlock('No inventory transactions yet.')}

    <div class="section-title">${produced?'Used By (Recipes Using This Produced Item)':'Recipes Using This Ingredient'}</div>
    ${usingRecipes.length? `<div class="grid grid-3">${usingRecipes.map(r=>`<div class="card"><a class="linklike" data-recipe="${r.id}">${r.name}</a><div class="text-light" style="font-size:12.5px;margin-top:4px;">${recipeTypeLabel(recipeTypeOf(r))}</div></div>`).join('')}</div>`
      : emptyBlock('This ingredient is not currently used in any recipe.')}
  `;
  content.querySelector('#back-ing').onclick = ()=>navigate('ingredients');
  content.querySelector('#edit-ing-btn').onclick = ()=>openIngredientForm(id);
  if(produced) content.querySelector('#produce-btn').onclick = ()=>openProductionForm(sourceRecipe?.id);
  content.querySelectorAll('[data-recipe]').forEach(a=> a.onclick = ()=>navigate('recipeDetail', a.dataset.recipe));
}
function catName_recipe(r){ return r.category || 'Uncategorized'; }

function runningStockRows(txnsDesc, unit){
  // txnsDesc is sorted newest first; compute running stock ascending then reverse
  const asc = txnsDesc.slice().sort((a,b)=> new Date(a.transaction_date)-new Date(b.transaction_date));
  let running = 0;
  const withRunning = asc.map(t=>{
    const q = Number(t.quantity)||0;
    running += t.transaction_type==='ADJUSTMENT'? q : TXN_SIGN[t.transaction_type]*Math.abs(q);
    return {...t, running};
  });
  return withRunning.reverse().map(t=>`<tr>
    <td>${fmtDate(t.transaction_date)}</td>
    <td>${txnTypeBadge(t.transaction_type)}</td>
    <td>${t.transaction_type==='ADJUSTMENT' && t.quantity>0?'+':''}${fmtNum(t.quantity,2)} ${unit}</td>
    <td><b>${fmtNum(t.running,2)} ${unit}</b></td>
    <td class="text-light">${t.notes||'—'}</td>
  </tr>`).join('');
}
function txnTypeBadge(type){
  const colors = {PURCHASE:'badge-green', INITIAL_STOCK:'badge-gray', USAGE:'badge-yellow', WASTE:'badge-red', ADJUSTMENT:'badge-gray', PRODUCTION:'badge-green', PRODUCTION_USE:'badge-yellow'};
  return `<span class="badge ${colors[type]||'badge-gray'}">${type.replace(/_/g,' ')}</span>`;
}
function emptyBlock(text){ return `<div class="card empty-state" style="box-shadow:var(--shadow);"><div style="padding:10px 0;">${text}</div></div>`; }

/* ================= Purchases ================= */
let purFilter = {search:'', supplier:''};

function renderPurchases(){
  const content = document.getElementById('content');
  content.innerHTML = `
    <div class="toolbar">
      <div class="toolbar-left">
        <div class="search-box"><input type="text" placeholder="Search by ingredient or invoice..." id="pur-search" value="${purFilter.search}"></div>
        <select class="filter" id="pur-sup-filter"><option value="">All Suppliers</option>${state.suppliers.map(s=>`<option value="${s.id}" ${purFilter.supplier===s.id?'selected':''}>${s.name}</option>`).join('')}</select>
      </div>
      <div class="text-light" style="font-size:13px;">${state.purchases.length} purchase records</div>
    </div>
    <div id="pur-table-wrap"></div>
  `;
  document.getElementById('pur-search').oninput = e=>{ purFilter.search=e.target.value; renderPurchasesTable(); };
  document.getElementById('pur-sup-filter').onchange = e=>{ purFilter.supplier=e.target.value; renderPurchasesTable(); };
  renderPurchasesTable();
}
function renderPurchasesTable(){
  const wrap = document.getElementById('pur-table-wrap');
  let list = state.purchases.slice();
  if(purFilter.search){
    const q = purFilter.search.toLowerCase();
    list = list.filter(p=> ingName(p.ingredientId).toLowerCase().includes(q) || (p.invoice_number||'').toLowerCase().includes(q));
  }
  if(purFilter.supplier) list = list.filter(p=>p.supplierId===purFilter.supplier);
  list.sort((a,b)=> new Date(b.purchase_date)-new Date(a.purchase_date));
  if(list.length===0){ wrap.innerHTML = `<div class="table-wrap"><div class="empty-state"><div class="big">🧾</div>No purchases recorded yet.<br><br><button class="btn btn-primary" id="empty-add-pur">+ New Purchase</button></div></div>`;
    wrap.querySelector('#empty-add-pur').onclick = ()=>openPurchaseForm(); return; }
  wrap.innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>Date</th><th>Ingredient</th><th>Supplier</th><th>Invoice #</th><th>Qty</th><th>Unit</th><th>Total Price</th><th>Price/Base Unit</th><th></th></tr></thead>
    <tbody>${list.map(p=>`<tr>
      <td>${fmtDate(p.purchase_date)}</td>
      <td><a class="linklike" data-ing="${p.ingredientId}">${ingName(p.ingredientId)}</a></td>
      <td>${supName(p.supplierId)}</td><td>${p.invoice_number||'—'}</td>
      <td>${fmtNum(p.quantity,2)}</td><td>${p.purchase_unit}</td>
      <td>${fmtMoney(p.total_price)}</td><td class="mono">${fmtMoney(p.price_per_base_unit)}</td>
      <td><button class="btn btn-sm btn-ghost" data-del="${p.id}">Delete</button></td>
    </tr>`).join('')}</tbody></table></div>`;
  wrap.querySelectorAll('[data-ing]').forEach(a=> a.onclick = ()=>navigate('ingredientDetail', a.dataset.ing));
  wrap.querySelectorAll('[data-del]').forEach(btn=> btn.onclick = async ()=>{
    const ok = await confirmDialog('Delete this purchase record? This will also remove its inventory addition and cannot be undone. Historical costing will be recalculated.');
    if(!ok) return;
    const p = state.purchases.find(x=>x.id===btn.dataset.del);
    await DB.delete('purchases', p.id);
    const linkedTxn = state.inventoryTransactions.find(t=> t.reference_id===p.id && t.transaction_type==='PURCHASE');
    if(linkedTxn) await DB.delete('inventoryTransactions', linkedTxn.id);
    await loadAll(); renderPurchasesTable(); toast('Purchase deleted');
  });
}

function openPurchaseForm(){
  const activeIngredients = state.ingredients.filter(i=>i.active!==false).sort((a,b)=>a.name.localeCompare(b.name));
  const body = `
    <div class="form-row"><label>Ingredient</label><select id="p-ing">${activeIngredients.map(i=>`<option value="${i.id}">${i.name} (${i.base_unit})</option>`).join('')}</select></div>
    <div class="form-grid">
      <div class="form-row"><label>Supplier</label><select id="p-sup"><option value="">—</option>${state.suppliers.map(s=>`<option value="${s.id}">${s.name}</option>`).join('')}</select></div>
      <div class="form-row"><label>Purchase Date</label><input type="date" id="p-date" value="${new Date().toISOString().slice(0,10)}"></div>
    </div>
    <div class="form-grid">
      <div class="form-row"><label>Invoice Number</label><input id="p-invoice" placeholder="optional"></div>
      <div class="form-row"><label>Total Price (₱)</label><input type="number" step="any" id="p-price" placeholder="0.00"></div>
    </div>
    <div class="form-grid">
      <div class="form-row"><label>Quantity Purchased</label><input type="number" step="any" id="p-qty" placeholder="e.g. 1000"></div>
      <div class="form-row"><label>Purchase Unit</label><select id="p-unit">${['g','kg','ml','L','pcs','box','pack'].map(u=>`<option value="${u}">${u}</option>`).join('')}</select></div>
    </div>
    <div class="form-row" id="p-conversion-row" style="display:none;">
      <label>Base units per purchase unit</label>
      <input type="number" step="any" id="p-conversion" placeholder="e.g. 100 (for a box of 100 cups)">
      <div class="hint" id="p-conv-hint"></div>
    </div>
    <div class="form-row"><label>Notes</label><textarea id="p-notes" rows="2"></textarea></div>
    <div class="card" id="p-preview" style="background:var(--beige);box-shadow:none;">
      <b>Preview:</b> <span id="p-preview-text">Enter quantity and price to see cost per base unit.</span>
    </div>
  `;
  const foot = `<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" id="btn-save-pur">Save Purchase</button>`;
  openModal({title:'New Purchase', body, foot, onMount:(root)=>{
    root.querySelector('[data-cancel]').onclick = closeModal;
    const ingSel = root.querySelector('#p-ing');
    const unitSel = root.querySelector('#p-unit');
    const qtyInput = root.querySelector('#p-qty');
    const priceInput = root.querySelector('#p-price');
    const convRow = root.querySelector('#p-conversion-row');
    const convInput = root.querySelector('#p-conversion');
    const preview = root.querySelector('#p-preview-text');

    function currentIngredient(){ return ingredientById(ingSel.value); }
    // Default the purchase unit to the ingredient's base unit for the common case (no conversion needed)
    (function setDefaultUnit(){ const ing = currentIngredient(); if(ing) unitSel.value = ing.base_unit; })();
    function needsConversion(){
      const ing = currentIngredient(); if(!ing) return false;
      const pu = unitSel.value, bu = ing.base_unit;
      if(pu===bu) return false;
      const fam = unitFamily(bu);
      if(fam==='weight' && pu in WEIGHT_UNITS) return false;
      if(fam==='volume' && pu in VOLUME_UNITS) return false;
      return true; // pcs from box/pack, or mismatched families
    }
    function updateConvVisibility(){
      const ing = currentIngredient();
      if(needsConversion()){
        convRow.style.display='block';
        root.querySelector('#p-conv-hint').textContent = `How many ${ing.base_unit} are in one ${unitSel.value}? (e.g. a box of 100 cups → 100)`;
      } else { convRow.style.display='none'; }
      updatePreview();
    }
    function updatePreview(){
      const ing = currentIngredient(); if(!ing){ preview.textContent='Select an ingredient.'; return; }
      const qty = Number(qtyInput.value)||0, price = Number(priceInput.value)||0;
      const conv = Number(convInput.value)||0;
      if(qty<=0 || price<=0){ preview.textContent = 'Enter quantity and price to see cost per base unit.'; return; }
      const baseQty = toBaseQuantity(qty, unitSel.value, ing.base_unit, conv);
      if(baseQty<=0){ preview.textContent = 'Enter the base-unit conversion above to calculate cost.'; return; }
      const perUnit = price/baseQty;
      preview.textContent = `${fmtNum(qty,2)} ${unitSel.value} → ${fmtNum(baseQty,2)} ${ing.base_unit} total. Cost = ${fmtMoney(perUnit)} per ${ing.base_unit}.`;
    }
    ingSel.onchange = ()=>{ const ing = currentIngredient(); if(ing) unitSel.value = ing.base_unit; updateConvVisibility(); };
    unitSel.onchange = updateConvVisibility;
    qtyInput.oninput = updatePreview; priceInput.oninput = updatePreview; convInput.oninput = updatePreview;
    updateConvVisibility();

    root.querySelector('#btn-save-pur').onclick = async ()=>{
      const ing = currentIngredient();
      const qty = Number(qtyInput.value)||0, price = Number(priceInput.value)||0;
      const conv = Number(convInput.value)||0;
      if(!ing){ toast('Select an ingredient','error'); return; }
      if(qty<=0){ toast('Enter a valid quantity','error'); return; }
      if(price<=0){ toast('Enter a valid total price','error'); return; }
      if(needsConversion() && conv<=0){ toast('Enter the base-unit conversion for this purchase unit','error'); return; }
      const baseQty = toBaseQuantity(qty, unitSel.value, ing.base_unit, conv);
      if(baseQty<=0){ toast('Could not calculate base quantity — check units','error'); return; }
      const now = new Date().toISOString();
      const purchase = {
        id: uid('pur'), ingredientId: ing.id, supplierId: root.querySelector('#p-sup').value || null,
        purchase_date: root.querySelector('#p-date').value || now.slice(0,10),
        invoice_number: root.querySelector('#p-invoice').value.trim(),
        quantity: qty, purchase_unit: unitSel.value, base_quantity: baseQty,
        total_price: price, price_per_base_unit: price/baseQty,
        notes: root.querySelector('#p-notes').value, created_at: now,
      };
      await DB.put('purchases', purchase);
      await DB.put('inventoryTransactions', {
        id: uid('txn'), ingredientId: ing.id, transaction_type:'PURCHASE', quantity: baseQty,
        reference_id: purchase.id, transaction_date: purchase.purchase_date, notes:`Purchase${purchase.invoice_number?' #'+purchase.invoice_number:''}`, created_at: now
      });
      await loadAll();
      closeModal();
      toast('Purchase recorded — costs recalculated automatically');
      if(state.route==='ingredientDetail') navigate('ingredientDetail', ing.id); else navigate('purchases');
    };
  }});
}

/* ================= Production ================= */
let prodFilter = {search:'', recipe:'', type:''};

function renderProduction(){
  const content = document.getElementById('content');
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const weekStart = dayStart - 6*24*3600*1000;
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const batches = state.productionBatches;
  const today = batches.filter(b=> new Date(b.production_date).getTime()>=dayStart);
  const thisWeek = batches.filter(b=> new Date(b.production_date).getTime()>=weekStart);
  const thisMonth = batches.filter(b=> new Date(b.production_date).getTime()>=monthStart);
  const costThisMonth = thisMonth.reduce((s,b)=>s+Number(b.raw_cost_total||0),0);
  const wasteThisMonth = thisMonth.reduce((s,b)=>{
    const w = Math.max(0, Number(b.expected_yield||0)-Number(b.actual_yield||0));
    return s + w*Number(b.actual_cost_per_unit||0);
  },0);
  const producedItems = producedIngredientsList();

  content.innerHTML = `
    <div class="grid grid-4">
      ${statCard('Production Today', today.length, `${thisWeek.length} this week`)}
      ${statCard('Production This Month', thisMonth.length, `${batches.length} all-time`)}
      ${statCard('Production Cost This Month', fmtMoney(costThisMonth),'')}
      ${statCard('Production Waste This Month', fmtMoney(wasteThisMonth),'yield loss, at cost')}
    </div>

    <div class="section-title">Production Inventory</div>
    ${producedItems.length? `<div class="grid grid-4">${producedItems.map(i=>{
      const stock = ingredientStock(i.id); const status = stockStatus(stock, i.reorder_level);
      return `<div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;"><a class="linklike" data-ing="${i.id}">${i.name}</a>${statusBadge(status)}</div>
        <div style="font-family:var(--font-display);font-size:22px;font-weight:600;margin-top:6px;">${fmtNum(stock,2)} ${i.base_unit}</div>
        <button class="btn btn-sm btn-amber" style="margin-top:8px;" data-produce-recipe="${i.source_recipe_id||''}">+ Produce</button>
      </div>`;
    }).join('')}</div>` : emptyBlock('No production recipes yet. Mark a recipe (e.g. a sauce or syrup) as "produces an inventory item" to get started.')}

    <div class="toolbar" style="margin-top:28px;">
      <div class="toolbar-left">
        <div class="search-box"><input type="text" placeholder="Search batch # or product..." id="prod-search" value="${prodFilter.search}"></div>
        <select class="filter" id="prod-recipe-filter"><option value="">All Products</option>${productionRecipesList().map(r=>`<option value="${r.id}" ${prodFilter.recipe===r.id?'selected':''}>${r.name}</option>`).join('')}</select>
        <select class="filter" id="prod-type-filter"><option value="">All Types</option>${RECIPE_TYPES.map(t=>`<option value="${t.id}" ${prodFilter.type===t.id?'selected':''}>${t.label}</option>`).join('')}</select>
      </div>
      <div class="text-light" style="font-size:13px;">${batches.length} production records</div>
    </div>
    <div id="prod-history-wrap"></div>
  `;
  content.querySelectorAll('[data-ing]').forEach(a=> a.onclick = ()=>navigate('ingredientDetail', a.dataset.ing));
  content.querySelectorAll('[data-produce-recipe]').forEach(btn=> btn.onclick = ()=>openProductionForm(btn.dataset.produceRecipe||null));
  document.getElementById('prod-search').oninput = e=>{ prodFilter.search=e.target.value; renderProductionHistory(); };
  document.getElementById('prod-recipe-filter').onchange = e=>{ prodFilter.recipe=e.target.value; renderProductionHistory(); };
  document.getElementById('prod-type-filter').onchange = e=>{ prodFilter.type=e.target.value; renderProductionHistory(); };
  renderProductionHistory();
}

function renderProductionHistory(){
  const wrap = document.getElementById('prod-history-wrap');
  let list = state.productionBatches.slice();
  if(prodFilter.recipe) list = list.filter(b=>b.recipeId===prodFilter.recipe);
  if(prodFilter.type) list = list.filter(b=>{ const r = state.recipes.find(x=>x.id===b.recipeId); return r && recipeTypeOf(r)===prodFilter.type; });
  if(prodFilter.search){
    const q = prodFilter.search.toLowerCase();
    list = list.filter(b=> (b.batch_number||'').toLowerCase().includes(q) || ingName(b.producedIngredientId).toLowerCase().includes(q));
  }
  list.sort((a,b)=> new Date(b.production_date)-new Date(a.production_date));
  if(list.length===0){ wrap.innerHTML = emptyBlock('No production records found.'); return; }
  wrap.innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>Date</th><th>Batch #</th><th>Product</th><th>Recipe Type</th><th>Qty Produced</th><th>Unit</th><th>Production Cost</th><th>Cost/Unit</th><th>Status</th></tr></thead>
    <tbody>${list.map(b=>{
      const recipe = state.recipes.find(r=>r.id===b.recipeId);
      const shortfall = Number(b.expected_yield||0) - Number(b.actual_yield||0);
      const status = shortfall>0.0001 ? `<span class="badge badge-yellow">Short ${fmtNum(shortfall,1)} ${b.yield_unit}</span>` : `<span class="badge badge-green">On Target</span>`;
      return `<tr>
        <td>${fmtDate(b.production_date)}</td><td>${b.batch_number||'—'}</td>
        <td><a class="linklike" data-ing="${b.producedIngredientId}">${ingName(b.producedIngredientId)}</a></td>
        <td>${recipe?recipeTypeLabel(recipeTypeOf(recipe)):'—'}</td>
        <td>${fmtNum(b.actual_yield,2)}</td><td>${b.yield_unit}</td>
        <td>${fmtMoney(b.raw_cost_total)}</td><td class="mono">${fmtMoney(b.actual_cost_per_unit)}</td>
        <td>${status}</td>
      </tr>`;
    }).join('')}</tbody></table></div>`;
  wrap.querySelectorAll('[data-ing]').forEach(a=> a.onclick = ()=>navigate('ingredientDetail', a.dataset.ing));
}

function nextBatchNumber(recipe){
  const prefix = (recipe.name||'BATCH').split(/\s+/).map(w=>w[0]).join('').toUpperCase().slice(0,4) || 'BATCH';
  const d = new Date();
  const datePart = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  const todaysCount = state.productionBatches.filter(b=> b.recipeId===recipe.id && b.batch_number && b.batch_number.includes(datePart)).length;
  return `${prefix}-${datePart}-${String(todaysCount+1).padStart(3,'0')}`;
}

function openProductionForm(prefillRecipeId){
  const recipes = productionRecipesList();
  if(recipes.length===0){
    toast('No production recipes yet — mark a recipe as "produces an inventory item" first.', 'warn');
    return;
  }
  const body = `
    <div class="form-row"><label>Product / Recipe</label><select id="pr-recipe">${recipes.map(r=>`<option value="${r.id}" ${prefillRecipeId===r.id?'selected':''}>${r.name}</option>`).join('')}</select></div>
    <div class="form-grid">
      <div class="form-row"><label>Production Date</label><input type="date" id="pr-date" value="${new Date().toISOString().slice(0,10)}"></div>
      <div class="form-row"><label>Batch Number</label><input id="pr-batch"></div>
    </div>
    <div class="form-grid">
      <div class="form-row"><label>Expected Yield</label><input type="number" step="any" id="pr-expected"><div class="hint" id="pr-yield-unit-hint"></div></div>
      <div class="form-row"><label>Actual Yield</label><input type="number" step="any" id="pr-actual" placeholder="What you actually got out"></div>
    </div>
    <div class="form-row" id="pr-waste-row" style="display:none;"><label>Waste Reason</label><select id="pr-waste-reason"><option>Evaporation</option><option>Spillage</option><option>Overcooking</option><option>Preparation Loss</option><option>Other</option></select></div>
    <div class="form-row"><label>Notes</label><textarea id="pr-notes" rows="2"></textarea></div>
    <div class="card" style="background:var(--beige);box-shadow:none;">
      <div class="grid grid-2">
        <div><div class="text-light" style="font-size:11px;text-transform:uppercase;font-weight:700;">Estimated Batch Cost</div><div id="pr-est-cost" style="font-family:var(--font-display);font-size:20px;font-weight:600;">—</div></div>
        <div><div class="text-light" style="font-size:11px;text-transform:uppercase;font-weight:700;">Estimated Cost / Unit</div><div id="pr-est-unit-cost" style="font-family:var(--font-display);font-size:20px;font-weight:600;">—</div></div>
      </div>
      <p class="hint mb-0">Raw ingredients are scaled from the recipe using Expected Yield ÷ the recipe's normal yield, then deducted from inventory. Cost per unit uses Actual Yield.</p>
    </div>
  `;
  const foot = `<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" id="btn-save-prod">Produce Batch</button>`;
  openModal({title:'New Production', wide:true, body, foot, onMount:(root)=>{
    root.querySelector('[data-cancel]').onclick = closeModal;
    const recipeSel = root.querySelector('#pr-recipe');
    const expectedInput = root.querySelector('#pr-expected');
    const actualInput = root.querySelector('#pr-actual');
    const batchInput = root.querySelector('#pr-batch');

    function currentRecipe(){ return state.recipes.find(r=>r.id===recipeSel.value); }
    function loadDefaults(){
      const recipe = currentRecipe();
      if(!recipe) return;
      expectedInput.value = recipe.expected_yield || '';
      root.querySelector('#pr-yield-unit-hint').textContent = 'Unit: ' + (recipe.yield_unit||'—') + ' (recipe default: ' + fmtNum(recipe.expected_yield,0) + ' ' + (recipe.yield_unit||'') + ')';
      batchInput.value = nextBatchNumber(recipe);
      updatePreview();
    }
    function updatePreview(){
      const recipe = currentRecipe(); if(!recipe) return;
      const expected = Number(expectedInput.value)||0;
      const actual = Number(actualInput.value)||0;
      const baseYield = Number(recipe.expected_yield)||0;
      const multiplier = baseYield>0 ? (expected/baseYield) : 0;
      const rc = recipeCost(recipe.id);
      const estCost = rc.total * multiplier;
      root.querySelector('#pr-est-cost').textContent = expected>0? fmtMoney(estCost) : '—';
      root.querySelector('#pr-est-unit-cost').textContent = actual>0? fmtMoney(estCost/actual)+'/'+recipe.yield_unit : '—';
      root.querySelector('#pr-waste-row').style.display = (expected>0 && actual>0 && actual<expected) ? 'block' : 'none';
    }
    recipeSel.onchange = loadDefaults;
    expectedInput.oninput = updatePreview; actualInput.oninput = updatePreview;
    loadDefaults();

    root.querySelector('#btn-save-prod').onclick = async ()=>{
      const recipe = currentRecipe();
      if(!recipe){ toast('Select a product/recipe','error'); return; }
      const producedIng = ingredientById(recipe.produced_ingredient_id);
      if(!producedIng){ toast('This recipe is not linked to an inventory item — edit the recipe first.','error'); return; }
      const baseYield = Number(recipe.expected_yield)||0;
      const expected = Number(expectedInput.value)||0;
      const actual = Number(actualInput.value)||0;
      if(baseYield<=0){ toast('This recipe has no expected yield set — edit the recipe first.','error'); return; }
      if(expected<=0){ toast('Enter an expected yield for this batch','error'); return; }
      if(actual<=0){ toast('Enter the actual yield produced','error'); return; }
      const multiplier = expected/baseYield;
      const rc = recipeCost(recipe.id); // current, live ingredient costs — locked into this batch record
      const rawCostTotal = rc.total * multiplier;
      const actualCostPerUnit = rawCostTotal/actual;
      const now = new Date().toISOString();
      const prodDate = root.querySelector('#pr-date').value || now.slice(0,10);
      const batch = {
        id: uid('batch'), recipeId: recipe.id, producedIngredientId: producedIng.id,
        batch_number: batchInput.value.trim() || nextBatchNumber(recipe),
        production_date: prodDate, expected_yield: expected, actual_yield: actual, yield_unit: recipe.yield_unit,
        raw_cost_total: rawCostTotal, actual_cost_per_unit: actualCostPerUnit,
        waste_reason: (actual<expected) ? (root.querySelector('#pr-waste-reason').value||'') : '',
        notes: root.querySelector('#pr-notes').value, created_at: now,
      };
      await DB.put('productionBatches', batch);
      // Deduct raw/produced ingredients used, scaled by the batch multiplier
      for(const line of rc.lines){
        const usedQty = Number(line.quantity||0) * multiplier;
        if(usedQty<=0) continue;
        await DB.put('inventoryTransactions', {
          id: uid('txn'), ingredientId: line.ingredientId, transaction_type:'PRODUCTION_USE', quantity: usedQty,
          reference_id: batch.id, transaction_date: prodDate, notes: `Used in production batch ${batch.batch_number} (${recipe.name})`, created_at: now,
        });
      }
      // Add the produced yield to the produced item's stock
      await DB.put('inventoryTransactions', {
        id: uid('txn'), ingredientId: producedIng.id, transaction_type:'PRODUCTION', quantity: actual,
        reference_id: batch.id, transaction_date: prodDate, notes: `Batch ${batch.batch_number}`, created_at: now,
      });
      await loadAll();
      closeModal();
      toast(`Produced ${fmtNum(actual,2)} ${recipe.yield_unit} of ${producedIng.name} — inventory updated automatically`);
      navigate('production');
    };
  }});
}

/* ================= Recipes ================= */
let recFilter = {search:'', category:'', type:''};

function renderRecipes(){
  const content = document.getElementById('content');
  const cats = [...new Set(state.recipes.map(r=>r.category).filter(Boolean))];
  const activeRecipes = state.recipes.filter(r=>r.active!==false);
  const typeTabs = [{id:'', label:'All'}, ...RECIPE_TYPES];
  content.innerHTML = `
    <div class="toolbar-left" style="margin-bottom:14px;flex-wrap:wrap;">
      ${typeTabs.map(t=>{
        const count = t.id? activeRecipes.filter(r=>recipeTypeOf(r)===t.id).length : activeRecipes.length;
        return `<button class="btn btn-sm ${recFilter.type===t.id?'btn-primary':'btn-outline'}" data-type-tab="${t.id}">${t.label} (${count})</button>`;
      }).join('')}
    </div>
    <div class="toolbar">
      <div class="toolbar-left">
        <div class="search-box"><input type="text" placeholder="Search recipes..." id="rec-search" value="${recFilter.search}"></div>
        <select class="filter" id="rec-cat-filter"><option value="">All Sub-Categories</option>${cats.map(c=>`<option ${recFilter.category===c?'selected':''}>${c}</option>`).join('')}</select>
      </div>
      <div class="text-light" style="font-size:13px;">${activeRecipes.length} active recipes</div>
    </div>
    <div id="rec-grid-wrap"></div>
  `;
  content.querySelectorAll('[data-type-tab]').forEach(b=> b.onclick = ()=>{ recFilter.type=b.dataset.typeTab; renderRecipes(); });
  document.getElementById('rec-search').oninput = e=>{ recFilter.search=e.target.value; renderRecipesGrid(); };
  document.getElementById('rec-cat-filter').onchange = e=>{ recFilter.category=e.target.value; renderRecipesGrid(); };
  renderRecipesGrid();
}
function renderRecipesGrid(){
  const wrap = document.getElementById('rec-grid-wrap');
  let list = state.recipes.filter(r=>r.active!==false);
  if(recFilter.type) list = list.filter(r=> recipeTypeOf(r)===recFilter.type);
  if(recFilter.search) list = list.filter(r=> r.name.toLowerCase().includes(recFilter.search.toLowerCase()));
  if(recFilter.category) list = list.filter(r=> r.category===recFilter.category);
  list.sort((a,b)=>a.name.localeCompare(b.name));
  if(list.length===0){ wrap.innerHTML = `<div class="empty-state"><div class="big">📖</div>No recipes found.<br><br><button class="btn btn-primary" id="empty-add-rec">+ New Recipe</button></div>`;
    wrap.querySelector('#empty-add-rec').onclick=()=>openRecipeForm(); return; }
  wrap.innerHTML = `<div class="grid grid-3">${list.map(r=>{
    const m = recipeMetrics(r);
    const warn = m.foodCostPct > (state.settings.foodCostWarningPct||35);
    const sellsDirectly = Number(r.selling_price) > 0;
    const statsRow = sellsDirectly ? `
        <div><div class="text-light" style="font-size:11px;text-transform:uppercase;">Price</div><b>${fmtMoney(r.selling_price)}</b></div>
        <div><div class="text-light" style="font-size:11px;text-transform:uppercase;">Cost</div><b>${fmtMoney(m.cost)}</b></div>
        <div><div class="text-light" style="font-size:11px;text-transform:uppercase;">Profit</div><b class="${m.profit>=0?'text-green':'text-red'}">${fmtMoney(m.profit)}</b></div>
        <div><div class="text-light" style="font-size:11px;text-transform:uppercase;">Food Cost</div><b>${fmtNum(m.foodCostPct,1)}%</b></div>
    ` : `
        <div><div class="text-light" style="font-size:11px;text-transform:uppercase;">Batch Cost</div><b>${fmtMoney(m.cost)}</b></div>
        <div><div class="text-light" style="font-size:11px;text-transform:uppercase;">Yield</div><b>${r.expected_yield?fmtNum(r.expected_yield,0)+' '+(r.yield_unit||''):'—'}</b></div>
        <div><div class="text-light" style="font-size:11px;text-transform:uppercase;">Cost / Unit</div><b>${r.expected_yield>0?fmtMoney(m.cost/r.expected_yield):'—'}</b></div>
    `;
    return `<div class="card clickable" data-id="${r.id}" style="cursor:pointer;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;">
        <div><b style="font-size:16px;">${r.name}</b><div class="text-light" style="font-size:12px;">${recipeTypeLabel(recipeTypeOf(r))}${r.category?' · '+r.category:''}</div></div>
        <div style="display:flex;gap:6px;">${isProductionRecipe(r)?'<span class="badge badge-green">Produces Inv.</span>':''}${sellsDirectly&&warn?'<span class="badge badge-red">High Cost%</span>':''}</div>
      </div>
      <div style="display:flex;justify-content:space-between;margin-top:14px;font-size:13.5px;">${statsRow}</div>
    </div>`;
  }).join('')}</div>`;
  wrap.querySelectorAll('[data-id]').forEach(card=> card.onclick = ()=>navigate('recipeDetail', card.dataset.id));
}

/* ---- Recipe Form (create/edit) ---- */
function ingredientOptionsGrouped(selectedId, excludeId){
  const raw = rawIngredientsList().filter(i=>i.id!==excludeId);
  const produced = producedIngredientsList().filter(i=>i.id!==excludeId);
  let html = '';
  if(raw.length) html += `<optgroup label="Raw Ingredients">${raw.map(i=>`<option value="${i.id}" ${selectedId===i.id?'selected':''}>${i.name}</option>`).join('')}</optgroup>`;
  if(produced.length) html += `<optgroup label="Produced Items (House-Made)">${produced.map(i=>`<option value="${i.id}" ${selectedId===i.id?'selected':''}>${i.name} 🏭</option>`).join('')}</optgroup>`;
  return html;
}

function openRecipeForm(id){
  const editing = id ? state.recipes.find(r=>r.id===id) : null;
  const existingLines = editing ? state.recipeIngredients.filter(ri=>ri.recipeId===editing.id) : [];
  const alreadyLinked = editing && editing.produced_ingredient_id; // once linked, can't unlink here (protects inventory history)

  const body = `
    <div class="form-grid">
      <div class="form-row"><label>Recipe Name</label><input id="r-name" value="${editing?editing.name:''}" placeholder="e.g. Iced Spanish Latte"></div>
      <div class="form-row"><label>Recipe Type</label><select id="r-type">${RECIPE_TYPES.map(t=>`<option value="${t.id}" ${editing&&recipeTypeOf(editing)===t.id?'selected':''}>${t.label}</option>`).join('')}</select></div>
    </div>
    <div class="form-grid">
      <div class="form-row"><label>Sub-Category (optional)</label><input id="r-cat" value="${editing?(editing.category||''):''}" placeholder="e.g. Milk-based, Iced"></div>
      <div class="form-row"><label>Selling Price (₱, leave 0 if not sold directly)</label><input type="number" step="any" id="r-price" value="${editing?editing.selling_price:''}"></div>
    </div>
    <div class="form-row"><label>Notes</label><textarea id="r-notes" rows="2">${editing?(editing.notes||''):''}</textarea></div>

    <div class="card" style="background:var(--beige);box-shadow:none;">
      <label style="display:flex;align-items:center;gap:8px;font-size:14px;font-weight:600;cursor:${alreadyLinked?'default':'pointer'};">
        <input type="checkbox" id="r-produces" ${isProductionRecipe(editing)?'checked':''} ${alreadyLinked?'disabled':''} style="width:16px;height:16px;">
        This recipe produces an inventory item (e.g. a sauce, syrup, or batch-made pastry)
      </label>
      ${alreadyLinked?`<div class="hint">Already linked to inventory item "${ingName(editing.produced_ingredient_id)}" — can't be unlinked here to protect its stock/production history.</div>`:''}
      <div id="r-production-fields" style="display:none;margin-top:12px;">
        <div class="form-grid">
          <div class="form-row"><label>Expected Yield</label><input type="number" step="any" id="r-yield" value="${editing?(editing.expected_yield||''):''}" placeholder="e.g. 1000"></div>
          <div class="form-row"><label>Yield Unit</label><select id="r-yield-unit" ${alreadyLinked?'disabled':''}>${['g','kg','ml','L','pcs'].map(u=>`<option value="${u}" ${editing&&editing.yield_unit===u?'selected':''}>${u}</option>`).join('')}</select></div>
        </div>
        <div class="form-row mb-0"><label>Production Instructions (optional)</label><textarea id="r-instructions" rows="2" placeholder="e.g. Simmer sugar and water to caramel, whisk in warm cream and butter off heat.">${editing?(editing.production_instructions||''):''}</textarea></div>
      </div>
    </div>

    <div class="section-title" style="margin-top:14px;font-size:15px;">Ingredients</div>
    <table class="ri-table" id="ri-table">
      <thead><tr><th style="width:32%;">Ingredient</th><th>Quantity</th><th>Unit</th><th>Unit Cost</th><th>Total Cost</th><th></th></tr></thead>
      <tbody id="ri-body"></tbody>
    </table>
    <button class="btn btn-outline btn-sm" id="ri-add-row" style="margin-top:10px;">+ Add Ingredient</button>

    <div class="recipe-summary" id="r-summary"></div>
  `;
  const foot = `
    ${editing?`<button class="btn btn-danger" id="btn-delete-rec" style="margin-right:auto;">Delete</button>`:''}
    <button class="btn btn-outline" data-cancel>Cancel</button>
    <button class="btn btn-primary" id="btn-save-rec">${editing?'Save Changes':'Create Recipe'}</button>
  `;
  openModal({title: editing?'Edit Recipe':'New Recipe', wide:true, body, foot, onMount:(root)=>{
    root.querySelector('[data-cancel]').onclick = closeModal;
    const tbody = root.querySelector('#ri-body');
    const excludeId = editing ? editing.produced_ingredient_id : null;
    const producesBox = root.querySelector('#r-produces');
    const prodFields = root.querySelector('#r-production-fields');

    function syncProducesVisibility(){ prodFields.style.display = producesBox.checked ? 'block' : 'none'; }
    producesBox.onchange = syncProducesVisibility;
    syncProducesVisibility();
    // Helpful default: new Sauces/Syrups recipes start pre-checked (still user-editable before save)
    if(!editing){
      root.querySelector('#r-type').onchange = (e)=>{
        if(e.target.value==='SAUCES_SYRUPS' && !producesBox.dataset.touched){ producesBox.checked = true; syncProducesVisibility(); }
      };
      producesBox.addEventListener('change', ()=>{ producesBox.dataset.touched = '1'; });
    }

    function addRow(line){
      const rowId = uid('row');
      const tr = el(`<tr data-row="${rowId}">
        <td><select class="ri-ing">${ingredientOptionsGrouped(line?line.ingredientId:null, excludeId)}</select></td>
        <td><input type="number" step="any" class="ri-qty" value="${line?line.quantity:''}" placeholder="0"></td>
        <td><span class="ri-unit text-light"></span></td>
        <td class="ri-unitcost text-light">—</td>
        <td class="ri-totalcost"><b>—</b></td>
        <td><button class="btn btn-sm btn-ghost ri-remove">✕</button></td>
      </tr>`);
      tbody.appendChild(tr);
      const ingSel = tr.querySelector('.ri-ing');
      const qtyInput = tr.querySelector('.ri-qty');
      function refreshRow(){
        const ing = ingredientById(ingSel.value);
        tr.querySelector('.ri-unit').textContent = ing?ing.base_unit:'';
        const cost = ing? (ingredientCosting(ing.id).current||0) : 0;
        tr.querySelector('.ri-unitcost').innerHTML = ing? fmtMoney(cost)+'/'+ing.base_unit + (isProducedItem(ing)?' <span class="badge badge-gray" style="font-size:10px;">produced</span>':'') : '—';
        const qty = Number(qtyInput.value)||0;
        tr.querySelector('.ri-totalcost').innerHTML = `<b>${fmtMoney(cost*qty)}</b>`;
        refreshSummary();
      }
      ingSel.onchange = refreshRow; qtyInput.oninput = refreshRow;
      tr.querySelector('.ri-remove').onclick = ()=>{ tr.remove(); refreshSummary(); };
      refreshRow();
    }

    function refreshSummary(){
      const rows = [...tbody.querySelectorAll('tr')];
      let total = 0;
      rows.forEach(tr=>{
        const ing = ingredientById(tr.querySelector('.ri-ing').value);
        const qty = Number(tr.querySelector('.ri-qty').value)||0;
        const cost = ing? (ingredientCosting(ing.id).current||0):0;
        total += cost*qty;
      });
      const price = Number(root.querySelector('#r-price').value)||0;
      const profit = price-total;
      const fcp = price>0? (total/price*100):0;
      const yieldVal = Number(root.querySelector('#r-yield')?.value)||0;
      root.querySelector('#r-summary').innerHTML = price>0 ? `
        <div class="item"><div class="lbl">Total Cost</div><div class="val">${fmtMoney(total)}</div></div>
        <div class="item"><div class="lbl">Selling Price</div><div class="val">${fmtMoney(price)}</div></div>
        <div class="item"><div class="lbl">Gross Profit</div><div class="val" style="color:${profit>=0?'#2e6349':'#a63d3d'}">${fmtMoney(profit)}</div></div>
        <div class="item"><div class="lbl">Food Cost %</div><div class="val">${fmtNum(fcp,1)}%</div></div>
      ` : `
        <div class="item"><div class="lbl">Batch Cost (at expected yield)</div><div class="val">${fmtMoney(total)}</div></div>
        ${yieldVal>0?`<div class="item"><div class="lbl">Estimated Cost / Unit</div><div class="val">${fmtMoney(total/yieldVal)}</div></div>`:''}
      `;
    }
    root.querySelector('#ri-add-row').onclick = ()=> addRow(null);
    root.querySelector('#r-price').oninput = refreshSummary;
    root.querySelector('#r-yield').oninput = refreshSummary;
    if(existingLines.length){ existingLines.forEach(addRow); } else { addRow(null); }
    refreshSummary();

    if(editing){
      root.querySelector('#btn-delete-rec').onclick = async ()=>{
        if(alreadyLinked){
          toast('This recipe produces an inventory item and cannot be deleted. Deactivate it instead by removing it from use.', 'error');
          return;
        }
        const ok = await confirmDialog(`Delete recipe "${editing.name}"? This cannot be undone.`);
        if(!ok) return;
        const lines = state.recipeIngredients.filter(ri=>ri.recipeId===editing.id);
        for(const l of lines) await DB.delete('recipeIngredients', l.id);
        await DB.delete('recipes', editing.id);
        await loadAll(); closeModal(); navigate('recipes'); toast('Recipe deleted');
      };
    }

    root.querySelector('#btn-save-rec').onclick = async ()=>{
      const name = root.querySelector('#r-name').value.trim();
      const price = Number(root.querySelector('#r-price').value)||0;
      const recipeType = root.querySelector('#r-type').value;
      const produces = producesBox.checked;
      const yieldQty = Number(root.querySelector('#r-yield')?.value)||0;
      const yieldUnit = root.querySelector('#r-yield-unit')?.value;
      if(!name){ toast('Enter a recipe name','error'); return; }
      if(produces && yieldQty<=0){ toast('Enter an expected yield greater than 0 for a production recipe','error'); return; }
      const rows = [...tbody.querySelectorAll('tr')].map(tr=>({
        ingredientId: tr.querySelector('.ri-ing').value, quantity: Number(tr.querySelector('.ri-qty').value)||0
      })).filter(r=>r.ingredientId && r.quantity>0);
      if(rows.length===0){ toast('Add at least one ingredient with a quantity','error'); return; }
      if(excludeId && rows.some(r=>r.ingredientId===excludeId)){ toast('A recipe cannot use its own produced item as an ingredient','error'); return; }

      const now = new Date().toISOString();
      const recipe = editing || {id: uid('rec'), created_at: now, active:true};
      recipe.name = name; recipe.category = root.querySelector('#r-cat').value.trim();
      recipe.recipe_type = recipeType;
      recipe.selling_price = price; recipe.notes = root.querySelector('#r-notes').value; recipe.updated_at = now;
      recipe.is_production_recipe = produces;
      recipe.expected_yield = produces ? yieldQty : (recipe.expected_yield||null);
      recipe.yield_unit = produces ? yieldUnit : (recipe.yield_unit||null);
      recipe.production_instructions = produces ? root.querySelector('#r-instructions').value : (recipe.production_instructions||'');

      // Create-or-sync the linked produced-item ingredient (never duplicated — one recipe <-> one ingredient)
      if(produces){
        if(recipe.produced_ingredient_id){
          const linkedIng = ingredientById(recipe.produced_ingredient_id);
          if(linkedIng){
            linkedIng.name = name; // keep in sync with the recipe that defines it
            linkedIng.updated_at = now;
            await DB.put('ingredients', linkedIng);
          }
        } else {
          const newIng = {
            id: uid('ing'), name, categoryId: producedCategoryId() || (state.categories[0]?.id),
            supplierId: null, base_unit: yieldUnit, reorder_level: state.settings.lowStockDefaultThreshold,
            notes: 'Auto-created from production recipe "'+name+'".', is_produced_item: true, source_recipe_id: recipe.id,
            shelf_life_days: null, storage_notes: '', active: true, created_at: now, updated_at: now,
          };
          await DB.put('ingredients', newIng);
          recipe.produced_ingredient_id = newIng.id;
        }
      }

      await DB.put('recipes', recipe);
      // replace recipe ingredient lines
      for(const l of existingLines) await DB.delete('recipeIngredients', l.id);
      for(const r of rows){
        const ing = ingredientById(r.ingredientId);
        await DB.put('recipeIngredients', {id: uid('ri'), recipeId: recipe.id, ingredientId: r.ingredientId, quantity: r.quantity, unit: ing.base_unit});
      }
      await loadAll();
      closeModal();
      toast(editing?'Recipe updated':'Recipe created');
      navigate('recipeDetail', recipe.id);
    };
  }});
}

/* ================= Recipe Detail ================= */
function renderRecipeDetail(id){
  const content = document.getElementById('content');
  const recipe = state.recipes.find(r=>r.id===id);
  if(!recipe){ content.innerHTML = `<div class="empty-state">Recipe not found. <a class="linklike" onclick="navigate('recipes')">Back</a></div>`; return; }
  const m = recipeMetrics(recipe);
  const now = new Date();
  const oneMonthAgo = new Date(now); oneMonthAgo.setMonth(now.getMonth()-1);
  const threeMonthsAgo = new Date(now); threeMonthsAgo.setMonth(now.getMonth()-3);
  const costLastMonth = recipeCostAsOf(id, oneMonthAgo.toISOString());
  const costThreeMonths = recipeCostAsOf(id, threeMonthsAgo.toISOString());
  const sellsDirectly = Number(recipe.selling_price) > 0;
  const warn = sellsDirectly && m.foodCostPct > (state.settings.foodCostWarningPct||35);
  const produces = isProductionRecipe(recipe);
  const producedIng = produces ? ingredientById(recipe.produced_ingredient_id) : null;
  const costPerUnit = (produces && recipe.expected_yield>0) ? m.cost/recipe.expected_yield : 0;
  const usedByRecipes = producedIng ? state.recipes.filter(r=> r.active!==false && state.recipeIngredients.some(ri=>ri.recipeId===r.id && ri.ingredientId===producedIng.id)) : [];
  const batches = producedIng ? productionBatchesFor(producedIng.id).sort((a,b)=> new Date(b.production_date)-new Date(a.production_date)) : [];

  content.innerHTML = `
    <a class="linklike" id="back-rec" style="font-size:13px;">← Back to Recipes</a>
    <div class="ingredient-detail-header" style="margin-top:10px;">
      <div>
        <h2 style="font-family:var(--font-display);font-size:26px;">${recipe.name}</h2>
        <div style="margin-top:6px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          <span class="tag-pill">${recipeTypeLabel(recipeTypeOf(recipe))}</span>
          ${recipe.category?`<span class="tag-pill">${recipe.category}</span>`:''}
          ${produces?'<span class="badge badge-green">Production Recipe</span>':''}
          ${sellsDirectly ? (warn?'<span class="badge badge-red">High Food Cost %</span>':'<span class="badge badge-green">Healthy Margin</span>') : ''}
        </div>
      </div>
      <div style="display:flex;gap:8px;">
        ${produces?`<button class="btn btn-amber" id="produce-this-btn">+ Produce This Recipe</button>`:''}
        <button class="btn btn-outline" id="edit-rec-btn">Edit Recipe</button>
      </div>
    </div>

    ${sellsDirectly ? `
    <div class="grid grid-4" style="margin-top:20px;">
      ${statCard('Selling Price', fmtMoney(recipe.selling_price),'')}
      ${statCard('Recipe Cost (today)', fmtMoney(m.cost),'')}
      ${statCard('Gross Profit', fmtMoney(m.profit),'')}
      ${statCard('Food Cost %', fmtNum(m.foodCostPct,1)+'%', warn? 'Above warning threshold':'')}
    </div>` : `
    <div class="grid grid-4" style="margin-top:20px;">
      ${statCard('Batch Cost (today)', fmtMoney(m.cost), 'at expected yield')}
      ${statCard('Expected Yield', recipe.expected_yield?fmtNum(recipe.expected_yield,0)+' '+recipe.yield_unit:'—','')}
      ${statCard('Estimated Cost / Unit', recipe.expected_yield>0?fmtMoney(costPerUnit)+'/'+recipe.yield_unit:'—','live, from current ingredient costs')}
      ${statCard('Current Stock', producedIng?fmtNum(ingredientStock(producedIng.id),2)+' '+producedIng.base_unit:'—', producedIng?statusBadgeText(stockStatus(ingredientStock(producedIng.id), producedIng.reorder_level)):'')}
    </div>`}

    ${produces ? `
    <div class="section-title">Production Details</div>
    <div class="card">
      <div class="grid grid-3">
        <div><div class="text-light" style="font-size:11px;text-transform:uppercase;font-weight:700;">Produces Inventory Item</div><a class="linklike" data-ing="${producedIng?.id}">${producedIng?producedIng.name:'—'}</a></div>
        <div><div class="text-light" style="font-size:11px;text-transform:uppercase;font-weight:700;">Reorder Level</div>${producedIng?fmtNum(producedIng.reorder_level,1)+' '+producedIng.base_unit:'—'}</div>
        <div><div class="text-light" style="font-size:11px;text-transform:uppercase;font-weight:700;">Shelf Life</div>${producedIng&&producedIng.shelf_life_days?producedIng.shelf_life_days+' days':'—'}</div>
      </div>
      ${recipe.production_instructions?`<div style="margin-top:12px;"><div class="text-light" style="font-size:11px;text-transform:uppercase;font-weight:700;">Instructions</div><div style="margin-top:4px;font-size:13.5px;">${escapeHtml(recipe.production_instructions)}</div></div>`:''}
    </div>
    ` : ''}

    <div class="section-title">Ingredient Breakdown</div>
    <div class="table-wrap"><table>
      <thead><tr><th>Ingredient</th><th>Type</th><th>Quantity</th><th>Unit</th><th>Unit Cost</th><th>Cost</th></tr></thead>
      <tbody>${m.lines.map(l=>`<tr>
        <td><a class="linklike" data-ing="${l.ingredientId}">${ingName(l.ingredientId)}</a></td>
        <td>${l.isProduced?'<span class="badge badge-gray">Produced Ingredient</span>':'<span class="badge badge-gray" style="opacity:.6;">Raw Ingredient</span>'}</td>
        <td>${fmtNum(l.quantity,2)}</td><td>${l.unit}</td>
        <td>${fmtMoney(l.unitCost)}</td><td><b>${fmtMoney(l.lineCost)}</b></td>
      </tr>`).join('')}
      <tr style="background:var(--beige);"><td colspan="5" style="text-align:right;"><b>Total ${sellsDirectly?'Recipe':'Batch'} Cost</b></td><td><b>${fmtMoney(m.cost)}</b></td></tr>
      </tbody></table></div>

    <div class="section-title">Cost History Snapshot</div>
    <div class="grid grid-3">
      ${statCard('Cost Today', fmtMoney(m.cost),'')}
      ${statCard('Cost ~1 Month Ago', fmtMoney(costLastMonth),'reconstructed from history')}
      ${statCard('Cost ~3 Months Ago', fmtMoney(costThreeMonths),'reconstructed from history')}
    </div>
    <p class="text-light" style="font-size:12.5px;margin-top:10px;">Historical costs are reconstructed from purchase (and, for produced ingredients, production) records dated on or before each point in time, using your selected costing method (${costingMethod()==='latest'?'Latest Purchase Cost':'Weighted Average Cost'}).</p>

    ${produces ? `
    <div class="section-title">Used By</div>
    ${usedByRecipes.length? `<div class="grid grid-3">${usedByRecipes.map(r=>`<div class="card"><a class="linklike" data-recipe="${r.id}">${r.name}</a><div class="text-light" style="font-size:12.5px;margin-top:4px;">${recipeTypeLabel(recipeTypeOf(r))}</div></div>`).join('')}</div>`
      : emptyBlock('No other recipes currently use this produced item.')}

    <div class="section-title">Production Batches</div>
    ${batches.length? `<div class="table-wrap"><table>
      <thead><tr><th>Date</th><th>Batch #</th><th>Expected</th><th>Actual</th><th>Cost</th><th>Cost/Unit</th></tr></thead>
      <tbody>${batches.map(b=>`<tr><td>${fmtDate(b.production_date)}</td><td>${b.batch_number||'—'}</td>
        <td>${fmtNum(b.expected_yield,2)} ${b.yield_unit}</td><td>${fmtNum(b.actual_yield,2)} ${b.yield_unit}</td>
        <td>${fmtMoney(b.raw_cost_total)}</td><td class="mono">${fmtMoney(b.actual_cost_per_unit)}</td></tr>`).join('')}</tbody></table></div>`
      : emptyBlock('No batches produced yet.')}
    ` : ''}
  `;
  content.querySelector('#back-rec').onclick = ()=>navigate('recipes');
  content.querySelector('#edit-rec-btn').onclick = ()=>openRecipeForm(id);
  if(produces) content.querySelector('#produce-this-btn').onclick = ()=>openProductionForm(recipe.id);
  content.querySelectorAll('[data-ing]').forEach(a=> a.onclick = ()=>navigate('ingredientDetail', a.dataset.ing));
  content.querySelectorAll('[data-recipe]').forEach(a=> a.onclick = ()=>navigate('recipeDetail', a.dataset.recipe));
}
function statusBadgeText(status){
  if(status==='IN') return 'In Stock'; if(status==='LOW') return 'Low Stock'; return 'Out of Stock';
}

/* ================= Inventory ================= */
let invFilter = {type:'', status:''};

function renderInventory(){
  const content = document.getElementById('content');
  const allActive = state.ingredients.filter(i=>i.active!==false);
  const totalValue = allActive.reduce((s,i)=> s+ ingredientStock(i.id)*(ingredientCosting(i.id).current||0), 0);
  content.innerHTML = `
    <div class="grid grid-3" style="margin-bottom:18px;">
      ${statCard('Total Inventory Value', fmtMoney(totalValue),'')}
      ${statCard('Low Stock Items', allActive.filter(i=>stockStatus(ingredientStock(i.id),i.reorder_level)==='LOW').length,'')}
      ${statCard('Out of Stock Items', allActive.filter(i=>stockStatus(ingredientStock(i.id),i.reorder_level)==='OUT').length,'')}
    </div>
    <div class="toolbar">
      <div class="toolbar-left">
        <select class="filter" id="inv-type-filter">
          <option value="">All</option>
          <option value="RAW" ${invFilter.type==='RAW'?'selected':''}>Raw Ingredients</option>
          <option value="PRODUCED" ${invFilter.type==='PRODUCED'?'selected':''}>Produced Items</option>
        </select>
        <select class="filter" id="inv-status-filter">
          <option value="">All Status</option>
          <option value="LOW" ${invFilter.status==='LOW'?'selected':''}>Low Stock</option>
          <option value="OUT" ${invFilter.status==='OUT'?'selected':''}>Out of Stock</option>
        </select>
      </div>
    </div>
    <div id="inv-table-wrap"></div>
  `;
  document.getElementById('inv-type-filter').onchange = e=>{ invFilter.type=e.target.value; renderInventoryTable(); };
  document.getElementById('inv-status-filter').onchange = e=>{ invFilter.status=e.target.value; renderInventoryTable(); };
  renderInventoryTable();
}

function renderInventoryTable(){
  const wrap = document.getElementById('inv-table-wrap');
  let list = state.ingredients.filter(i=>i.active!==false);
  if(invFilter.type==='RAW') list = list.filter(i=>!isProducedItem(i));
  if(invFilter.type==='PRODUCED') list = list.filter(i=>isProducedItem(i));
  if(invFilter.status) list = list.filter(i=> stockStatus(ingredientStock(i.id), i.reorder_level)===invFilter.status);
  list.sort((a,b)=>a.name.localeCompare(b.name));
  if(list.length===0){ wrap.innerHTML = emptyBlock('No inventory items match this filter.'); return; }
  wrap.innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>Ingredient</th><th>Type</th><th>Current Stock</th><th>Unit</th><th>Current Unit Cost</th><th>Inventory Value</th><th>Reorder Level</th><th>Status</th><th></th></tr></thead>
      <tbody>${list.map(i=>{
        const stock = ingredientStock(i.id); const cost = ingredientCosting(i.id).current||0;
        const produced = isProducedItem(i);
        return `<tr class="clickable" data-id="${i.id}">
          <td><b>${i.name}</b></td>
          <td>${produced?'<span class="badge badge-gray">Produced</span>':'<span class="badge badge-gray" style="opacity:.6;">Raw</span>'}</td>
          <td>${fmtNum(stock,2)}</td><td>${i.base_unit}</td>
          <td>${fmtMoney(cost)}</td><td><b>${fmtMoney(stock*cost)}</b></td>
          <td>${fmtNum(i.reorder_level,1)}</td><td>${statusBadge(stockStatus(stock,i.reorder_level))}</td>
          <td>${produced?`<button class="btn btn-sm btn-amber" data-produce="${i.id}">+ Produce</button>`:''}</td>
        </tr>`;
      }).join('')}</tbody></table></div>`;
  wrap.querySelectorAll('tr[data-id]').forEach(tr=> tr.onclick = (e)=>{ if(e.target.closest('[data-produce]')) return; navigate('ingredientDetail', tr.dataset.id); });
  wrap.querySelectorAll('[data-produce]').forEach(btn=> btn.onclick = (e)=>{ e.stopPropagation(); openProductionForm(sourceRecipeForIngredient(ingredientById(btn.dataset.produce))?.id); });
}

function openWasteForm(){
  const activeIngredients = state.ingredients.filter(i=>i.active!==false).sort((a,b)=>a.name.localeCompare(b.name));
  const body = `
    <div class="form-row"><label>Ingredient</label><select id="w-ing">${activeIngredients.map(i=>`<option value="${i.id}">${i.name} (${i.base_unit})</option>`).join('')}</select></div>
    <div class="form-grid">
      <div class="form-row"><label>Quantity Wasted</label><input type="number" step="any" id="w-qty" placeholder="0"></div>
      <div class="form-row"><label>Date</label><input type="date" id="w-date" value="${new Date().toISOString().slice(0,10)}"></div>
    </div>
    <div class="form-row"><label>Reason</label><select id="w-reason"><option>Expired</option><option>Spillage</option><option>Over-portioned</option><option>Spoiled</option><option>Prep error</option><option>Other</option></select></div>
    <div class="form-row"><label>Notes</label><textarea id="w-notes" rows="2"></textarea></div>
  `;
  const foot = `<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-amber" id="btn-save-waste">Record Waste</button>`;
  openModal({title:'Record Waste', body, foot, onMount:(root)=>{
    root.querySelector('[data-cancel]').onclick = closeModal;
    root.querySelector('#btn-save-waste').onclick = async ()=>{
      const ing = ingredientById(root.querySelector('#w-ing').value);
      const qty = Number(root.querySelector('#w-qty').value)||0;
      if(qty<=0){ toast('Enter a valid quantity','error'); return; }
      const date = root.querySelector('#w-date').value;
      const reason = root.querySelector('#w-reason').value;
      const notes = root.querySelector('#w-notes').value;
      const now = new Date().toISOString();
      const wasteRec = {id: uid('waste'), ingredientId: ing.id, quantity: qty, unit: ing.base_unit, reason, date, notes, created_at: now};
      await DB.put('waste', wasteRec);
      await DB.put('inventoryTransactions', {id: uid('txn'), ingredientId: ing.id, transaction_type:'WASTE', quantity: qty, reference_id: wasteRec.id, transaction_date: date, notes: reason, created_at: now});
      await loadAll(); closeModal(); toast('Waste recorded'); navigate(state.route, state.routeParam);
    };
  }});
}

function openAdjustmentForm(){
  const activeIngredients = state.ingredients.filter(i=>i.active!==false).sort((a,b)=>a.name.localeCompare(b.name));
  const body = `
    <div class="form-row"><label>Ingredient</label><select id="a-ing">${activeIngredients.map(i=>`<option value="${i.id}">${i.name} (${i.base_unit})</option>`).join('')}</select></div>
    <div class="form-row"><label>Adjustment Amount (use negative to reduce, e.g. -50)</label><input type="number" step="any" id="a-qty" placeholder="e.g. -50 or 20"></div>
    <div class="form-row"><label>Date</label><input type="date" id="a-date" value="${new Date().toISOString().slice(0,10)}"></div>
    <div class="form-row"><label>Reason / Notes</label><textarea id="a-notes" rows="2" placeholder="e.g. Physical stock count correction"></textarea></div>
  `;
  const foot = `<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" id="btn-save-adj">Save Adjustment</button>`;
  openModal({title:'Adjust Stock', body, foot, onMount:(root)=>{
    root.querySelector('[data-cancel]').onclick = closeModal;
    root.querySelector('#btn-save-adj').onclick = async ()=>{
      const ing = ingredientById(root.querySelector('#a-ing').value);
      const qty = Number(root.querySelector('#a-qty').value);
      if(!qty){ toast('Enter a non-zero adjustment amount','error'); return; }
      const now = new Date().toISOString();
      await DB.put('inventoryTransactions', {id: uid('txn'), ingredientId: ing.id, transaction_type:'ADJUSTMENT', quantity: qty, reference_id:null, transaction_date: root.querySelector('#a-date').value, notes: root.querySelector('#a-notes').value, created_at: now});
      await loadAll(); closeModal(); toast('Stock adjusted'); navigate(state.route, state.routeParam);
    };
  }});
}

/* ================= Costing Dashboard ================= */
let costingSort = 'name';
let costingTypeFilter = '';
function renderCosting(){
  const content = document.getElementById('content');
  content.innerHTML = `
    <div class="toolbar">
      <div class="toolbar-left">
        <select class="filter" id="cost-type-filter">
          <option value="">All Recipe Types</option>
          ${RECIPE_TYPES.map(t=>`<option value="${t.id}" ${costingTypeFilter===t.id?'selected':''}>${t.label}</option>`).join('')}
        </select>
        <select class="filter" id="cost-sort">
          <option value="name">Sort: Recipe Name</option>
          <option value="costHigh">Sort: Highest Cost</option>
          <option value="costLow">Sort: Lowest Cost</option>
          <option value="fcpHigh">Sort: Highest Food Cost %</option>
          <option value="profitHigh">Sort: Highest Gross Profit</option>
          <option value="profitLow">Sort: Lowest Gross Profit</option>
        </select>
      </div>
      <div class="text-light" style="font-size:13px;">Costing method: <b>${costingMethod()==='latest'?'Latest Purchase Cost':'Weighted Average Cost'}</b> (change in Settings)</div>
    </div>
    <div id="costing-table-wrap"></div>
  `;
  document.getElementById('cost-sort').onchange = e=>{ costingSort=e.target.value; renderCostingTable(); };
  document.getElementById('cost-type-filter').onchange = e=>{ costingTypeFilter=e.target.value; renderCostingTable(); };
  renderCostingTable();
}
function renderCostingTable(){
  const wrap = document.getElementById('costing-table-wrap');
  let list = state.recipes.filter(r=>r.active!==false);
  if(costingTypeFilter) list = list.filter(r=>recipeTypeOf(r)===costingTypeFilter);
  list = list.map(r=>({recipe:r, ...recipeMetrics(r)}));
  const sorters = {
    name:(a,b)=>a.recipe.name.localeCompare(b.recipe.name),
    costHigh:(a,b)=>b.cost-a.cost, costLow:(a,b)=>a.cost-b.cost,
    fcpHigh:(a,b)=>b.foodCostPct-a.foodCostPct, profitHigh:(a,b)=>b.profit-a.profit, profitLow:(a,b)=>a.profit-b.profit,
  };
  list.sort(sorters[costingSort]);
  if(list.length===0){ wrap.innerHTML = emptyBlock('No recipes match this filter.'); return; }
  const warnPct = state.settings.foodCostWarningPct||35;
  wrap.innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>Recipe</th><th>Type</th><th>Selling Price</th><th>Recipe Cost</th><th>Gross Profit</th><th>Food Cost %</th><th>Status</th></tr></thead>
    <tbody>${list.map(r=>{
      const sellsDirectly = Number(r.recipe.selling_price) > 0;
      const warn = sellsDirectly && r.foodCostPct > warnPct;
      return `<tr class="clickable" data-id="${r.recipe.id}">
        <td><b>${r.recipe.name}</b></td><td>${recipeTypeLabel(recipeTypeOf(r.recipe))}</td>
        <td>${sellsDirectly?fmtMoney(r.recipe.selling_price):'—'}</td>
        <td>${fmtMoney(r.cost)}</td><td class="${r.profit>=0?'text-green':'text-red'}">${sellsDirectly?fmtMoney(r.profit):'—'}</td>
        <td>${sellsDirectly?fmtNum(r.foodCostPct,1)+'%':'—'}</td>
        <td>${!sellsDirectly?'<span class="badge badge-gray">Not Sold Directly</span>':(warn?'<span class="badge badge-red">High</span>':'<span class="badge badge-green">Healthy</span>')}</td>
      </tr>`;
    }).join('')}</tbody></table></div>`;
  wrap.querySelectorAll('[data-id]').forEach(tr=> tr.onclick = ()=>navigate('recipeDetail', tr.dataset.id));
}

/* ================= Suppliers ================= */
function renderSuppliers(){
  const content = document.getElementById('content');
  const list = state.suppliers.slice().sort((a,b)=>a.name.localeCompare(b.name));
  content.innerHTML = list.length? `<div class="grid grid-3">${list.map(s=>{
    const supPurchases = state.purchases.filter(p=>p.supplierId===s.id);
    const total = supPurchases.reduce((sum,p)=>sum+Number(p.total_price||0),0);
    const avg = supPurchases.length? total/supPurchases.length : 0;
    const ingSet = [...new Set(supPurchases.map(p=>p.ingredientId))];
    return `<div class="card">
      <div style="display:flex;justify-content:space-between;"><b style="font-size:16px;">${s.name}</b>
        <button class="btn btn-sm btn-ghost" data-edit="${s.id}">Edit</button></div>
      <div class="text-light" style="font-size:13px;margin:6px 0;">${s.contact||''} ${s.phone?'· '+s.phone:''}</div>
      <div style="margin-top:10px;font-size:13.5px;">
        <div>Total Purchases: <b>${fmtMoney(total)}</b> (${supPurchases.length} orders)</div>
        <div>Avg. Purchase Price: <b>${fmtMoney(avg)}</b></div>
        <div>Ingredients Supplied: <b>${ingSet.length}</b></div>
      </div>
    </div>`;
  }).join('')}</div>` : emptyBlock('No suppliers yet.');
  content.querySelectorAll('[data-edit]').forEach(btn=> btn.onclick=(e)=>{e.stopPropagation();openSupplierForm(btn.dataset.edit);});
}
function openSupplierForm(id){
  const editing = id? state.suppliers.find(s=>s.id===id) : null;
  const body = `
    <div class="form-row"><label>Supplier Name</label><input id="s-name" value="${editing?editing.name:''}"></div>
    <div class="form-grid">
      <div class="form-row"><label>Contact Person</label><input id="s-contact" value="${editing?editing.contact||'':''}"></div>
      <div class="form-row"><label>Phone</label><input id="s-phone" value="${editing?editing.phone||'':''}"></div>
    </div>
    <div class="form-grid">
      <div class="form-row"><label>Email</label><input id="s-email" value="${editing?editing.email||'':''}"></div>
      <div class="form-row"><label>Address</label><input id="s-address" value="${editing?editing.address||'':''}"></div>
    </div>
    <div class="form-row"><label>Notes</label><textarea id="s-notes" rows="2">${editing?editing.notes||'':''}</textarea></div>
  `;
  const foot = `${editing?`<button class="btn btn-danger" id="s-delete" style="margin-right:auto;">Delete</button>`:''}<button class="btn btn-outline" data-cancel>Cancel</button><button class="btn btn-primary" id="s-save">${editing?'Save':'Add Supplier'}</button>`;
  openModal({title: editing?'Edit Supplier':'Add Supplier', body, foot, onMount:(root)=>{
    root.querySelector('[data-cancel]').onclick = closeModal;
    if(editing) root.querySelector('#s-delete').onclick = async ()=>{
      const used = state.purchases.some(p=>p.supplierId===editing.id);
      if(used){ toast('This supplier has purchase history and cannot be deleted.','error'); return; }
      const ok = await confirmDialog(`Delete supplier "${editing.name}"?`);
      if(ok){ await DB.delete('suppliers', editing.id); await loadAll(); closeModal(); renderSuppliers(); toast('Supplier deleted'); }
    };
    root.querySelector('#s-save').onclick = async ()=>{
      const name = root.querySelector('#s-name').value.trim();
      if(!name){ toast('Enter supplier name','error'); return; }
      const obj = editing || {id: uid('sup')};
      obj.name=name; obj.contact=root.querySelector('#s-contact').value; obj.phone=root.querySelector('#s-phone').value;
      obj.email=root.querySelector('#s-email').value; obj.address=root.querySelector('#s-address').value; obj.notes=root.querySelector('#s-notes').value;
      await DB.put('suppliers', obj); await loadAll(); closeModal(); renderSuppliers(); toast(editing?'Supplier updated':'Supplier added');
    };
  }});
}

/* ================= Reports ================= */
const REPORT_DEFS = [
  {id:'priceChanges', name:'Ingredient Cost Changes'},
  {id:'purchaseHistory', name:'Purchase History'},
  {id:'inventoryValue', name:'Inventory Value'},
  {id:'lowStock', name:'Low Stock'},
  {id:'waste', name:'Waste'},
  {id:'production', name:'Production'},
  {id:'recipeCosting', name:'Recipe Costing'},
  {id:'foodCost', name:'Food Cost'},
  {id:'grossProfit', name:'Gross Profit'},
  {id:'expensiveIngredients', name:'Most Expensive Ingredients'},
  {id:'profitableRecipes', name:'Most Profitable Recipes'},
];
let activeReport = 'priceChanges';
// fileNameSlug() is defined in logic.js (shared with POS backups).

function renderReports(){
  const content = document.getElementById('content');
  content.innerHTML = `
    <div class="toolbar">
      <div class="toolbar-left" style="flex-wrap:wrap;">
        ${REPORT_DEFS.map(r=>`<button class="btn btn-sm ${activeReport===r.id?'btn-primary':'btn-outline'}" data-report="${r.id}">${r.name}</button>`).join('')}
      </div>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-outline btn-sm" id="print-report">🖨 Print / PDF</button>
        <button class="btn btn-outline btn-sm" id="export-report-csv">Export CSV</button>
      </div>
    </div>
    <div id="report-body"></div>
  `;
  content.querySelectorAll('[data-report]').forEach(b=> b.onclick = ()=>{ activeReport=b.dataset.report; renderReports(); });
  content.querySelector('#export-report-csv').onclick = ()=> exportReportCSV(activeReport);
  content.querySelector('#print-report').onclick = ()=> printReport(activeReport);
  renderReportBody();
}

function reportData(id){
  switch(id){
    case 'priceChanges': {
      const now = new Date(); const monthAgo = new Date(now); monthAgo.setMonth(now.getMonth()-1);
      return state.ingredients.filter(i=>i.active!==false).map(i=>{
        const cur = ingredientCosting(i.id).current||0;
        const prev = isProducedItem(i) ? recipeCostAsOf(sourceRecipeForIngredient(i)?.id, monthAgo.toISOString())/(sourceRecipeForIngredient(i)?.expected_yield||1) : (()=>{ const prevStats = computeCostingStats(purchasesFor(i.id), monthAgo.toISOString()); return prevStats.count? (costingMethod()==='latest'?prevStats.latest:prevStats.weightedAvg) : cur; })();
        const change = prev? ((cur-prev)/prev*100):0;
        return {rows:[i.name, fmtMoney(prev), fmtMoney(cur), fmtNum(change,1)+'%']};
      });
    }
    case 'purchaseHistory':
      return state.purchases.slice().sort((a,b)=>new Date(b.purchase_date)-new Date(a.purchase_date)).map(p=>({rows:[fmtDate(p.purchase_date), ingName(p.ingredientId), supName(p.supplierId), p.invoice_number||'—', fmtNum(p.quantity,2)+' '+p.purchase_unit, fmtMoney(p.total_price), fmtMoney(p.price_per_base_unit)]}));
    case 'inventoryValue':
      return state.ingredients.filter(i=>i.active!==false).map(i=>{const stock=ingredientStock(i.id), cost=ingredientCosting(i.id).current||0; return {rows:[i.name, fmtNum(stock,2)+' '+i.base_unit, fmtMoney(cost), fmtMoney(stock*cost)]};});
    case 'lowStock':
      return state.ingredients.filter(i=>i.active!==false && stockStatus(ingredientStock(i.id),i.reorder_level)!=='IN').map(i=>({rows:[i.name, fmtNum(ingredientStock(i.id),2), fmtNum(i.reorder_level,1), stockStatus(ingredientStock(i.id),i.reorder_level)]}));
    case 'waste':
      return state.waste.slice().sort((a,b)=>new Date(b.date)-new Date(a.date)).map(w=>({rows:[fmtDate(w.date), ingName(w.ingredientId), fmtNum(w.quantity,2)+' '+w.unit, w.reason, fmtMoney(w.quantity*(ingredientCosting(w.ingredientId).current||0))]}));
    case 'production':
      return state.productionBatches.slice().sort((a,b)=>new Date(b.production_date)-new Date(a.production_date)).map(b=>({rows:[fmtDate(b.production_date), b.batch_number||'—', ingName(b.producedIngredientId), fmtNum(b.actual_yield,2)+' '+b.yield_unit, fmtMoney(b.raw_cost_total), fmtMoney(b.actual_cost_per_unit)]}));
    case 'recipeCosting':
      return state.recipes.filter(r=>r.active!==false).map(r=>{const m=recipeMetrics(r); return {rows:[r.name, recipeTypeLabel(recipeTypeOf(r)), Number(r.selling_price)>0?fmtMoney(r.selling_price):'—', fmtMoney(m.cost), Number(r.selling_price)>0?fmtMoney(m.profit):'—', Number(r.selling_price)>0?fmtNum(m.foodCostPct,1)+'%':'—']};});
    case 'foodCost':
      return state.recipes.filter(r=>r.active!==false && Number(r.selling_price)>0).map(r=>{const m=recipeMetrics(r); return {rows:[r.name, fmtNum(m.foodCostPct,1)+'%', m.foodCostPct>(state.settings.foodCostWarningPct||35)?'HIGH':'OK']};});
    case 'grossProfit':
      return state.recipes.filter(r=>r.active!==false && Number(r.selling_price)>0).sort((a,b)=>recipeMetrics(b).profit-recipeMetrics(a).profit).map(r=>{const m=recipeMetrics(r);return {rows:[r.name, fmtMoney(m.profit)]};});
    case 'expensiveIngredients':
      return state.ingredients.filter(i=>i.active!==false).map(i=>({name:i.name, cost:ingredientCosting(i.id).current||0})).sort((a,b)=>b.cost-a.cost).map(x=>({rows:[x.name, fmtMoney(x.cost)]}));
    case 'profitableRecipes':
      return state.recipes.filter(r=>r.active!==false && Number(r.selling_price)>0).map(r=>({r, m:recipeMetrics(r)})).sort((a,b)=>b.m.profit-a.m.profit).map(x=>({rows:[x.r.name, fmtMoney(x.m.profit), fmtNum(x.m.foodCostPct,1)+'%']}));
    default: return [];
  }
}
const REPORT_HEADERS = {
  priceChanges:['Ingredient','Cost ~1mo Ago','Current Cost','Change %'],
  purchaseHistory:['Date','Ingredient','Supplier','Invoice #','Quantity','Total Price','Price/Base Unit'],
  inventoryValue:['Ingredient','Stock','Unit Cost','Inventory Value'],
  lowStock:['Ingredient','Stock','Reorder Level','Status'],
  waste:['Date','Ingredient','Quantity','Reason','Waste Cost'],
  production:['Date','Batch #','Product','Quantity Produced','Production Cost','Cost/Unit'],
  recipeCosting:['Recipe','Type','Selling Price','Recipe Cost','Gross Profit','Food Cost %'],
  foodCost:['Recipe','Food Cost %','Status'],
  grossProfit:['Recipe','Gross Profit'],
  expensiveIngredients:['Ingredient','Current Cost'],
  profitableRecipes:['Recipe','Gross Profit','Food Cost %'],
};
function renderReportBody(){
  const wrap = document.getElementById('report-body');
  const headers = REPORT_HEADERS[activeReport];
  const data = reportData(activeReport);
  if(data.length===0){ wrap.innerHTML = emptyBlock('No data available for this report yet.'); return; }
  wrap.innerHTML = `<div class="table-wrap"><table><thead><tr>${headers.map(h=>`<th>${h}</th>`).join('')}</tr></thead>
    <tbody>${data.map(d=>`<tr>${d.rows.map(c=>`<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
function exportReportCSV(id){
  const headers = REPORT_HEADERS[id];
  const data = reportData(id);
  const csvRows = [headers.join(','), ...data.map(d=> d.rows.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(','))];
  downloadFile(`${fileNameSlug()}-${id}-report-${new Date().toISOString().slice(0,10)}.csv`, csvRows.join('\n'), 'text/csv');
  toast('Report exported as CSV');
}
// downloadFile() is defined in logic.js (shared with POS backups).

// Branded, printable report — opens a clean standalone view and triggers the browser's print dialog.
// Works fully offline: no network requests, everything is inlined.
function printReport(id){
  const headers = REPORT_HEADERS[id];
  const data = reportData(id);
  const reportName = REPORT_DEFS.find(r=>r.id===id)?.name || id;
  const win = window.open('', '_blank');
  if(!win){ toast('Please allow pop-ups for this site to print reports', 'error'); return; }
  const logoImg = state.settings.logo ? `<img src="${state.settings.logo}" alt="logo">` : '';
  win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(reportName)} — ${escapeHtml(appDisplayName())}</title>
    <style>
      body{font-family: Georgia, 'Times New Roman', serif; padding:36px; color:#241209;}
      .header{display:flex;align-items:center;gap:14px;border-bottom:2px solid #241209;padding-bottom:14px;margin-bottom:16px;}
      .header img{width:44px;height:44px;object-fit:contain;border-radius:6px;}
      h1{font-size:19px;margin:0;} .sub{font-size:13px;color:#6f5c48;margin-top:2px;}
      .meta{font-size:11.5px;color:#6f5c48;margin-bottom:16px;}
      table{width:100%;border-collapse:collapse;} th,td{border:1px solid #d8c8a4;padding:6px 10px;text-align:left;font-size:12px;}
      th{background:#e9dcc4;} @media print{ body{padding:12px;} }
    </style></head><body>
    <div class="header">${logoImg}<div><h1>${escapeHtml(businessName()||appDisplayName())}</h1><div class="sub">${escapeHtml(reportName)} Report</div></div></div>
    <div class="meta">Generated by ${escapeHtml(appDisplayName())} on ${escapeHtml(fmtDate(new Date().toISOString()))}</div>
    <table><thead><tr>${headers.map(h=>`<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>
    <tbody>${data.map(d=>`<tr>${d.rows.map(c=>`<td>${escapeHtml(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>
    </body></html>`);
  win.document.close();
  win.focus();
  setTimeout(()=>{ try{ win.print(); }catch(e){} }, 300);
}

/* ================= Settings ================= */
const COLOR_PRESETS = {
  Coffee:   {primary_color:'#5C4033', secondary_color:'#8B6F47', accent_color:'#C08A5C', background_color:'#F5EFE6', card_color:'#FFFDF9', text_color:'#2C1E14'},
  Espresso: {primary_color:'#241209', secondary_color:'#3b2418', accent_color:'#c17a3d', background_color:'#efe6d8', card_color:'#fffaf2', text_color:'#1c110a'},
  Cream:    {primary_color:'#8a6f4f', secondary_color:'#a98a5b', accent_color:'#c9a35c', background_color:'#fdf8ee', card_color:'#ffffff', text_color:'#4a3c28'},
  Forest:   {primary_color:'#1f2e22', secondary_color:'#33513f', accent_color:'#7a9b6e', background_color:'#f1f4ee', card_color:'#ffffff', text_color:'#20281f'},
  Minimal:  {primary_color:'#222222', secondary_color:'#444444', accent_color:'#888888', background_color:'#fafafa', card_color:'#ffffff', text_color:'#1a1a1a'},
  Dark:     {primary_color:'#0f0f0f', secondary_color:'#2a2a2a', accent_color:'#c17a3d', background_color:'#1c1c1c', card_color:'#2b2b2b', text_color:'#f0ece4'},
};
// FONT_OPTIONS / FONT_SIZES / lightenHex / applyFontChoice / applyCustomTheme are defined in
// logic.js (shared with POS, since both apps must render with the same shop branding).

function resizeImageToDataUrl(file, maxDim){
  return new Promise((resolve, reject)=>{
    const reader = new FileReader();
    reader.onerror = ()=>reject(new Error('Could not read file'));
    reader.onload = ()=>{
      const img = new Image();
      img.onerror = ()=>reject(new Error('Could not decode image'));
      img.onload = ()=>{
        let {width, height} = img;
        if(width > maxDim || height > maxDim){
          const scale = maxDim / Math.max(width, height);
          width = Math.round(width*scale); height = Math.round(height*scale);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/png', 0.9));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function renderSettings(){
  const content = document.getElementById('content');
  const s = state.settings;
  content.innerHTML = `
    <div class="settings-block">
      <div class="section-title" style="margin-top:0;">General</div>
      <div class="card">
        <div class="form-grid">
          <div class="form-row"><label>Currency</label><input value="Philippine Peso (₱)" disabled></div>
          <div class="form-row"><label>Default Costing Method</label>
            <select id="set-costing">
              <option value="weighted_average" ${s.costingMethod==='weighted_average'?'selected':''}>Weighted Average Cost</option>
              <option value="latest" ${s.costingMethod==='latest'?'selected':''}>Latest Purchase Cost</option>
            </select>
          </div>
        </div>
        <div class="hint" style="margin-bottom:14px;">
          <b>Weighted Average Cost</b>: total spend ÷ total quantity purchased across all history — smooths out price spikes.
          <b>Latest Purchase Cost</b>: uses only your most recent purchase price — reacts immediately to price changes.
        </div>
        <div class="form-grid">
          <div class="form-row"><label>Default Low Stock Threshold</label><input type="number" id="set-lowstock" value="${s.lowStockDefaultThreshold}"></div>
          <div class="form-row"><label>Food Cost Warning %</label><input type="number" id="set-foodcost" value="${s.foodCostWarningPct}"></div>
        </div>
        <button class="btn btn-primary btn-sm" id="save-general">Save Settings</button>
      </div>

      <div class="section-title">Customization</div>
      <div class="card">
        <div class="form-grid">
          <div class="form-row"><label>Business Name</label><input id="cz-business" value="${escapeHtml(s.business_name||'')}" placeholder="e.g. Juan's Coffee Shop"></div>
          <div class="form-row"><label>Application Name</label><input id="cz-appname" value="${escapeHtml(s.app_name||'Brew Ledger')}" placeholder="Brew Ledger"></div>
        </div>
        <div class="hint" style="margin-top:-6px;margin-bottom:14px;">Appears in the sidebar, browser tab, and printed reports. Renaming the installed PWA icon itself requires reinstalling after a name change.</div>

        <div class="form-row"><label>Logo</label></div>
        <div style="display:flex;align-items:center;gap:14px;margin-bottom:16px;">
          <div class="logo-preview" id="cz-logo-preview">${s.logo?`<img src="${s.logo}">`:'<span style="font-size:22px;">☕</span>'}</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button class="btn btn-outline btn-sm" id="cz-logo-upload">Upload / Change Logo</button>
            <button class="btn btn-ghost btn-sm" id="cz-logo-remove" ${!s.logo?'disabled':''}>Remove Logo</button>
            <input type="file" id="cz-logo-input" accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp" style="display:none;">
          </div>
        </div>

        <div class="form-row"><label>Preset Palettes</label></div>
        <div style="display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap;">
          ${Object.entries(COLOR_PRESETS).map(([name,p])=>`<div style="text-align:center;">
            <div class="preset-swatch" data-preset="${name}" style="background:linear-gradient(135deg, ${p.primary_color} 50%, ${p.accent_color} 50%);"></div>
            <div class="text-light" style="font-size:11px;margin-top:4px;">${name}</div>
          </div>`).join('')}
        </div>

        <div class="form-row"><label>Colors</label></div>
        <div style="display:flex;flex-wrap:wrap;gap:4px 24px;margin-bottom:6px;">
          ${['primary_color','secondary_color','accent_color','background_color','card_color','text_color'].map(key=>`
            <div class="color-field">
              <span class="cf-label">${key.replace('_color','').replace('_',' ')}</span>
              <input type="color" id="cz-${key}" value="${s[key]}">
              <input type="text" id="cz-${key}-hex" value="${s[key]}">
            </div>`).join('')}
        </div>
        <button class="btn btn-ghost btn-sm" id="cz-reset-colors" style="margin-bottom:16px;">Reset to Default Colors</button>

        <div class="form-grid">
          <div class="form-row"><label>Font</label><select id="cz-font">${FONT_OPTIONS.map(f=>`<option value="${f.id}" ${s.font_family===f.id?'selected':''}>${f.label}</option>`).join('')}</select></div>
          <div class="form-row"><label>Font Size</label><select id="cz-fontsize">
            <option value="small" ${s.font_size==='small'?'selected':''}>Small</option>
            <option value="medium" ${s.font_size==='medium'?'selected':''}>Medium</option>
            <option value="large" ${s.font_size==='large'?'selected':''}>Large</option>
          </select></div>
        </div>
        <div class="hint" style="margin-bottom:14px;">Named fonts (Inter, Roboto, etc.) load once online and are cached for offline use after that; "System Default" needs no network ever. The default Fraunces/Inter pairing is unchanged unless you pick something else here.</div>

        <div style="display:flex;gap:10px;">
          <button class="btn btn-primary" id="cz-save">Save Changes</button>
          <button class="btn btn-outline" id="cz-reset-all">Reset All Defaults</button>
        </div>
      </div>

      <div class="section-title">Backup & Data</div>
      <div class="card">
        <div style="font-size:13.5px;line-height:1.8;">
          <div>Last Local Backup: <b>${s.lastLocalBackup?fmtDate(s.lastLocalBackup):'Never'}</b></div>
          <div>Last Google Drive Backup: <b>${s.lastGDriveBackup?fmtDate(s.lastGDriveBackup):'Never'}</b></div>
          <div>Database Size (approx.): <b id="db-size">calculating…</b></div>
          <div>Ingredients: <b>${state.ingredients.length}</b> · Recipes: <b>${state.recipes.length}</b> · Purchases: <b>${state.purchases.length}</b> · Sales: <b>${state.sales.length}</b></div>
        </div>
        <div style="display:flex;gap:10px;margin-top:16px;flex-wrap:wrap;">
          <button class="btn btn-primary" id="btn-export-db">Back Up Now</button>
          <button class="btn btn-outline" id="btn-import-db">Import / Restore Database</button>
          <input type="file" id="import-file-input" accept=".json" style="display:none;">
        </div>
      </div>

      <div class="section-title">Backup Location</div>
      <div class="card">
        <div style="margin-bottom:10px;">Saving to: <b id="backup-folder-label">Browser downloads (default)</b></div>
        ${FS_ACCESS_SUPPORTED ? `
        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          <button class="btn btn-outline btn-sm" id="btn-choose-folder">Choose Folder (USB / External Drive / Local Folder)</button>
          <button class="btn btn-ghost btn-sm" id="btn-clear-folder">Use Default Downloads Instead</button>
        </div>
        <div class="form-row" style="margin-top:14px;max-width:260px;"><label>Backups to Keep in That Folder</label><input type="number" id="set-retain" value="${s.backup_retain_count||10}" min="1"></div>
        <p class="hint">Once a folder is chosen, backups are written straight there (e.g. a plugged-in USB or external drive, or a folder synced by OneDrive/Dropbox) and the oldest backups beyond the number above are cleaned up automatically. If the folder isn't available when a backup runs (e.g. USB unplugged), it safely falls back to a normal download.</p>
        ` : `<p class="hint">This browser doesn't support choosing a folder directly (that needs Chrome or Edge) — backups will download normally, and you can move them to a USB drive, external drive, or network folder yourself.</p>`}
      </div>

      <div class="section-title">Automatic Backup</div>
      <div class="card">
        <div class="toggle-row"><span>Automatic Local Backup</span>
          <label class="switch"><input type="checkbox" id="tog-local-backup" ${s.autoBackupLocal?'checked':''}><span class="slider-tog"></span></label></div>
        <div class="toggle-row"><span>Google Drive Automatic Backup</span>
          <label class="switch"><input type="checkbox" id="tog-gdrive-backup" ${s.autoBackupGDrive?'checked':''}><span class="slider-tog"></span></label></div>
        <div class="form-row" style="margin-top:12px;"><label>Backup Frequency</label>
          <select id="set-frequency">
            <option value="daily" ${s.backupFrequency==='daily'?'selected':''}>Every Day</option>
            <option value="weekly" ${s.backupFrequency==='weekly'?'selected':''}>Every Week</option>
            <option value="monthly" ${s.backupFrequency==='monthly'?'selected':''}>Every Month</option>
            <option value="yearly" ${s.backupFrequency==='yearly'?'selected':''}>Every Year</option>
            <option value="manual" ${s.backupFrequency==='manual'?'selected':''}>Manually Only</option>
          </select>
        </div>
        ${s.backupFrequency!=='manual' ? `<div class="hint">Next backup due: <b>${fmtDate(nextBackupDueDate(s.lastLocalBackup, s.backupFrequency).toISOString())}</b> — checked whenever the app is opened. A browser tab can't run in the background when closed, so if the device was off at the scheduled time, the backup simply runs at the next opportunity, as soon as ${escapeHtml(appDisplayName())} is opened again.</div>` : ''}
        <p class="hint">If an automatic Google Drive backup fails (e.g. no internet), your data stays safe locally, you'll see a notification, and ${escapeHtml(appDisplayName())} retries automatically once you're back online.</p>
      </div>

      <div class="section-title">Google Drive</div>

      <div class="card">
        <div style="margin-bottom:12px;">Status: ${s.gdriveConnected? '<span class="badge badge-green">Connected</span>' : '<span class="badge badge-gray">Not Connected</span>'}</div>
        <p class="hint" style="margin-bottom:12px;">Google Drive is entirely optional — ${escapeHtml(appDisplayName())} works fully offline without it. To connect, create an OAuth Client ID (Web application) in Google Cloud Console with the Drive API enabled, and paste it below. Backups are stored in a dedicated "Coffee Shop Inventory Backups" folder in your Drive using your own Google account — this app never sees your password.</p>
        <div class="form-row"><label>Google OAuth Client ID</label><input id="set-gdrive-clientid" value="${s.gdriveClientId||''}" placeholder="xxxxx.apps.googleusercontent.com"></div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          <button class="btn btn-outline btn-sm" id="btn-save-clientid">Save Client ID</button>
          <button class="btn btn-primary btn-sm" id="btn-gdrive-connect">${s.gdriveConnected?'Reconnect':'Connect Google Drive'}</button>
          <button class="btn btn-amber btn-sm" id="btn-gdrive-backup" ${!s.gdriveConnected?'disabled':''}>Backup to Google Drive</button>
          <button class="btn btn-outline btn-sm" id="btn-gdrive-restore" ${!s.gdriveConnected?'disabled':''}>Restore from Google Drive</button>
        </div>
      </div>

      <div class="section-title">Appearance</div>
      <div class="card">
        <div class="toggle-row mb-0" style="border:none;"><span>Dark Theme</span>
          <label class="switch"><input type="checkbox" id="tog-theme" ${s.theme==='dark'?'checked':''}><span class="slider-tog"></span></label></div>
      </div>
    </div>
  `;
  estimateDbSize().then(sz=>{ const elx = document.getElementById('db-size'); if(elx) elx.textContent = sz; });
  getSavedBackupFolderHandle().then(handle=>{
    const elx = document.getElementById('backup-folder-label');
    if(elx && handle) elx.textContent = `📁 ${handle.name}`;
  });

  document.getElementById('save-general').onclick = async ()=>{
    s.costingMethod = document.getElementById('set-costing').value;
    s.lowStockDefaultThreshold = Number(document.getElementById('set-lowstock').value)||10;
    s.foodCostWarningPct = Number(document.getElementById('set-foodcost').value)||35;
    await DB.put('settings', s); toast('Settings saved'); navigate('settings');
  };
  document.getElementById('btn-export-db').onclick = ()=> exportDatabase();
  document.getElementById('btn-import-db').onclick = ()=> document.getElementById('import-file-input').click();
  document.getElementById('import-file-input').onchange = (e)=> handleImportFile(e.target.files[0]);
  if(FS_ACCESS_SUPPORTED){
    document.getElementById('btn-choose-folder').onclick = async ()=>{
      try{ const handle = await chooseBackupFolder(); document.getElementById('backup-folder-label').textContent = `📁 ${handle.name}`; toast('Backup folder set — future backups save there automatically'); }
      catch(e){ if(e.name!=='AbortError') toast('Could not access that folder: '+e.message, 'error'); }
    };
    document.getElementById('btn-clear-folder').onclick = async ()=>{
      await clearBackupFolder(); document.getElementById('backup-folder-label').textContent = 'Browser downloads (default)'; toast('Reverted to normal downloads');
    };
    document.getElementById('set-retain')?.addEventListener('change', async (e)=>{ s.backup_retain_count = Number(e.target.value)||10; await DB.put('settings', s); });
  }

  document.getElementById('tog-local-backup').onchange = async (e)=>{ s.autoBackupLocal = e.target.checked; await DB.put('settings', s); toast('Preference saved'); };
  document.getElementById('tog-gdrive-backup').onchange = async (e)=>{ s.autoBackupGDrive = e.target.checked; await DB.put('settings', s); toast('Preference saved'); };
  document.getElementById('set-frequency').onchange = async (e)=>{ s.backupFrequency = e.target.value; await DB.put('settings', s); navigate('settings'); };
  document.getElementById('tog-theme').onchange = async (e)=>{ s.theme = e.target.checked?'dark':'light'; await DB.put('settings', s); applyTheme(); };

  document.getElementById('btn-save-clientid').onclick = async ()=>{
    s.gdriveClientId = document.getElementById('set-gdrive-clientid').value.trim();
    await DB.put('settings', s); toast('Client ID saved');
  };
  document.getElementById('btn-gdrive-connect').onclick = ()=> gdriveConnect(()=>navigate('settings'));
  document.getElementById('btn-gdrive-backup').onclick = ()=> gdriveBackup();
  document.getElementById('btn-gdrive-restore').onclick = ()=> gdriveRestoreFlow();

  /* ---- Customization wiring (live preview) ---- */
  const colorKeys = ['primary_color','secondary_color','accent_color','background_color','card_color','text_color'];
  function draftSettings(){
    const draft = {...s};
    draft.business_name = document.getElementById('cz-business').value.trim();
    draft.app_name = document.getElementById('cz-appname').value.trim() || 'Brew Ledger';
    colorKeys.forEach(k=>{ draft[k] = document.getElementById('cz-'+k).value; });
    draft.font_family = document.getElementById('cz-font').value;
    draft.font_size = document.getElementById('cz-fontsize').value;
    return draft;
  }
  function previewNow(){ applyCustomTheme(draftSettings()); }

  colorKeys.forEach(k=>{
    const colorInput = document.getElementById('cz-'+k);
    const hexInput = document.getElementById('cz-'+k+'-hex');
    colorInput.oninput = ()=>{ hexInput.value = colorInput.value; previewNow(); };
    hexInput.oninput = ()=>{ if(/^#[0-9a-fA-F]{6}$/.test(hexInput.value)){ colorInput.value = hexInput.value; previewNow(); } };
  });
  document.getElementById('cz-font').onchange = previewNow;
  document.getElementById('cz-fontsize').onchange = previewNow;
  document.getElementById('cz-business').oninput = ()=>{};
  document.getElementById('cz-appname').oninput = ()=>{};

  document.querySelectorAll('[data-preset]').forEach(sw=>{
    sw.onclick = ()=>{
      const preset = COLOR_PRESETS[sw.dataset.preset];
      colorKeys.forEach(k=>{
        document.getElementById('cz-'+k).value = preset[k];
        document.getElementById('cz-'+k+'-hex').value = preset[k];
      });
      previewNow();
    };
  });
  document.getElementById('cz-reset-colors').onclick = ()=>{
    colorKeys.forEach(k=>{
      document.getElementById('cz-'+k).value = DEFAULT_SETTINGS[k];
      document.getElementById('cz-'+k+'-hex').value = DEFAULT_SETTINGS[k];
    });
    previewNow();
  };

  document.getElementById('cz-logo-upload').onclick = ()=> document.getElementById('cz-logo-input').click();
  document.getElementById('cz-logo-input').onchange = async (e)=>{
    const file = e.target.files[0];
    if(!file) return;
    try{
      const dataUrl = await resizeImageToDataUrl(file, 256);
      document.getElementById('cz-logo-preview').innerHTML = `<img src="${dataUrl}">`;
      document.getElementById('cz-logo-remove').disabled = false;
      s.__pendingLogo = dataUrl; // staged until Save Changes
      toast('Logo ready — click "Save Changes" to apply it');
    }catch(err){ toast('Could not read that image file', 'error'); }
  };
  document.getElementById('cz-logo-remove').onclick = ()=>{
    document.getElementById('cz-logo-preview').innerHTML = '<span style="font-size:22px;">☕</span>';
    s.__pendingLogo = null;
    document.getElementById('cz-logo-remove').disabled = true;
  };

  document.getElementById('cz-save').onclick = async ()=>{
    const draft = draftSettings();
    Object.assign(s, draft);
    if('__pendingLogo' in s){ s.logo = s.__pendingLogo; delete s.__pendingLogo; }
    await DB.put('settings', s);
    applyCustomTheme();
    renderShell();
    document.querySelectorAll('.nav-item').forEach(el=> el.classList.toggle('active', el.dataset.route==='settings'));
    applyDynamicManifest();
    toast('Customization saved');
  };
  document.getElementById('cz-reset-all').onclick = async ()=>{
    const ok = await confirmDialog('Reset business name, app name, logo, colors, and font back to defaults?');
    if(!ok) return;
    ['business_name','app_name','logo','font_family','font_size',...colorKeys].forEach(k=> s[k] = DEFAULT_SETTINGS[k]);
    await DB.put('settings', s);
    applyCustomTheme();
    renderShell();
    applyDynamicManifest();
    navigate('settings');
    toast('Customization reset to defaults');
  };
}

// estimateDbSize() is defined in logic.js (shared with POS).
function applyTheme(){
  document.body.classList.toggle('dark', state.settings.theme==='dark');
}

// Rebuilds the PWA manifest at runtime (as a Blob URL) so a custom app name/icon is picked
// up by "Install App" going forward. Already-installed icons keep their original name/icon
// until reinstalled — that's a platform limitation, not something a web app can override.
function applyDynamicManifest(){
  try{
    const manifest = {
      name: appDisplayName() + (businessName()? ' — '+businessName() : ''),
      short_name: appDisplayName().slice(0,20),
      description: 'Offline-first inventory, recipe costing, purchasing and stock management for a small coffee shop.',
      start_url: './index.html', display: 'standalone',
      background_color: state.settings.background_color || '#f7f1e6',
      theme_color: state.settings.primary_color || '#3b2418',
      icons: state.settings.logo ? [{src: state.settings.logo, sizes:'192x192', type:'image/png', purpose:'any'}] : [
        {src:"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='20' fill='%233b2418'/%3E%3Ctext x='50' y='68' font-size='55' text-anchor='middle'%3E%E2%98%95%3C/text%3E%3C/svg%3E", sizes:'192x192', type:'image/svg+xml', purpose:'any'}
      ],
    };
    const blob = new Blob([JSON.stringify(manifest)], {type:'application/json'});
    const url = URL.createObjectURL(blob);
    let link = document.querySelector('link[rel="manifest"]');
    if(!link){ link = document.createElement('link'); link.rel='manifest'; document.head.appendChild(link); }
    link.href = url;
  }catch(e){ console.warn('Could not update manifest', e); }
}

/* ================= Backup / Restore =================
   buildBackupPayload / downloadFile / fileNameSlug / restoreFromPayloadCore now live in
   logic.js (shared with the POS app, since one backup covers the whole shared database).
   These wrappers just add this app's own UI feedback (toasts, confirm dialog, re-render). */
async function exportDatabase(silent, tag){
  const payload = await buildBackupPayload();
  const stamp = new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
  const filename = `${fileNameSlug()}-backup${tag?'-'+tag:''}-${stamp}.json`;
  const content = JSON.stringify(payload,null,2);
  let wroteToFolder = false;
  try{ wroteToFolder = await writeBackupToFolder(filename, content, state.settings.backup_retain_count); }
  catch(e){ console.warn('Folder backup failed, falling back to download', e); }
  if(!wroteToFolder) downloadFile(filename, content, 'application/json');
  state.settings.lastLocalBackup = new Date().toISOString();
  await DB.put('settings', state.settings);
  if(!silent) toast(wroteToFolder ? `Backup saved to your chosen folder — ${filename}` : 'Database exported — file downloaded');
}
async function handleImportFile(file){
  if(!file) return;
  try{
    const text = await file.text();
    const payload = JSON.parse(text);
    if(!payload.data){ toast('This does not look like a valid backup file for this app','error'); return; }
    const ok = await confirmDialog('Importing will REPLACE all current data (Inventory AND POS) with the contents of this backup. A safety backup of your current data will be downloaded first. Continue?');
    if(!ok) return;
    await exportDatabase(true, 'pre-import-safety'); // safety backup first
    await restoreFromPayload(payload);
    toast('Database imported successfully');
    navigate('dashboard');
  }catch(e){
    console.error(e);
    toast('Could not read this backup file — it may be corrupted or invalid','error');
  }
}
async function restoreFromPayload(payload){
  await restoreFromPayloadCore(payload);
  applyCustomTheme();
  renderShell();
  applyDynamicManifest();
}
function onGDriveRestored(){ navigate('dashboard'); }

/* ================= Auto backup ================= */
async function maybeAutoBackup(){
  const s = state.settings;
  if(!s.autoBackupLocal && !s.autoBackupGDrive) return;
  if(s.autoBackupLocal && isBackupDue(s.lastLocalBackup, s.backupFrequency)){
    try{ await exportDatabase(true, 'auto'); }
    catch(e){ console.warn('Automatic local backup failed', e); toast('Automatic local backup failed — please back up manually from Settings.', 'warn'); }
  }
  if(s.autoBackupGDrive && isBackupDue(s.lastGDriveBackup, s.backupFrequency)){
    if(!navigator.onLine || !s.gdriveConnected){
      toast('Automatic Google Drive backup skipped — offline or not connected. Will retry later.', 'warn');
    } else {
      try{ await gdriveBackup(true); } catch(e){ toast('Automatic Google Drive backup failed — data is safe locally. Will retry later.', 'warn'); }
    }
  }
}
window.addEventListener('online', ()=>{ maybeAutoBackup(); });

/* ================= Google Drive Integration (SHARED — moved to logic.js) =================
   loadGISScript / gdriveConnect / ensureGDriveFolder / gdriveBackup now live in logic.js so
   POS can trigger the exact same Drive backup of the shared database. Only the restore UI
   (which needs each app's own navigate/refresh calls) stays here. */
async function gdriveRestoreFlow(){
  if(!state.settings.gdriveConnected || !gdriveAccessToken){ toast('Connect Google Drive first', 'error'); return; }
  if(!navigator.onLine){ toast('No internet connection', 'error'); return; }
  try{
    const files = await gdriveListBackups();
    if(files.length===0){ toast('No backups found in your Google Drive folder', 'warn'); return; }
    openModal({
      title:'Restore from Google Drive',
      body: `<p style="margin-bottom:10px;">Select a backup to restore. This will replace your current local data (a safety export will be downloaded first).</p>
        <div class="table-wrap"><table><thead><tr><th>File</th><th>Modified</th><th></th></tr></thead><tbody>
        ${files.map(f=>`<tr><td>${f.name}</td><td>${fmtDate(f.modifiedTime)}</td><td><button class="btn btn-sm btn-primary" data-file="${f.id}">Restore</button></td></tr>`).join('')}
        </tbody></table></div>`,
      foot: `<button class="btn btn-outline" data-cancel>Close</button>`,
      onMount:(root)=>{
        root.querySelector('[data-cancel]').onclick = closeModal;
        root.querySelectorAll('[data-file]').forEach(btn=> btn.onclick = async ()=>{
          const ok = await confirmDialog('This will replace all current local data with this Google Drive backup. Continue?');
          if(!ok) return;
          const payload = await gdriveDownloadBackup(btn.dataset.file);
          await exportDatabase(true, 'pre-gdrive-restore-safety');
          await restoreFromPayload(payload);
          closeModal(); toast('Restored from Google Drive'); onGDriveRestored();
        });
      }
    });
  }catch(e){
    console.error(e); toast('Could not list Google Drive backups', 'error');
  }
}

/* ================= PWA ================= */
function maybeRegisterSW(){
  if('serviceWorker' in navigator && location.protocol.startsWith('http')){
    navigator.serviceWorker.register('./sw.js').catch(()=>{});
  }
}

/* ================= Init ================= */
window.addEventListener('DOMContentLoaded', ()=>{ bootstrap().catch(err=>{ console.error(err); alert('Failed to start the app: '+err.message); }); });
