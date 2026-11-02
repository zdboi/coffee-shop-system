# Release 1.4 (Wave 2): database contract (`cccc/supabase/010_release_1_4.sql`)
From db-security-engineer's report, 2026-11-03 (net income tax change the same day). If the script and this file disagree, the script wins; tell the lead.
"Owner only" = the owner's email login (profile ADMIN, rank 3); anything else gets `NOT_ALLOWED` (`NOT_A_MEMBER` without a shop).

## 0. Units (shared rule, logic.js must match)
- Families: `g`/`kg` (weight), `ml`/`L` (volume, case ignored), anything else is a count unit that only matches itself.
- `_to_base_qty(qty, unit, base_unit, g_per_ml)`: same unit → unchanged; same family → ×1000 / ÷1000;
  g ↔ mL only when the item has `weight_g_per_ml` (mL = g ÷ w; g = mL × w); otherwise impossible (`BAD_UNIT`).
  Rounded to 6 decimals (as `_unitRound`).

## A10. "Weighs" (house-made items only)
- **`ingredients.weight_g_per_ml`** numeric, empty or > 0 and ≤ 10 (1 L caramel = 1,250 g → `1.25`).
  - Only on `is_produced_item = true` items counted in g/kg/mL/L: else `WEIGHS_PRODUCED_ONLY` / `WEIGHS_BAD_UNIT`.
- **Recipe lines:** new `recipe_ingredients.entered_quantity`. Send `entered_quantity` + `unit` (as typed, e.g. 25 + `g`);
  the database sets `quantity` (stock unit) itself, and recomputes it whenever the item's `weight_g_per_ml` or `base_unit` changes.
  Without `entered_quantity` (1.3 apps) `quantity` is stored as sent (stock unit), as today.
- **Option extras** may also be typed: `extras:[{ingredient_id, entered_quantity, unit}]` (see A9); converted the same way.
- **Stock and cost stay in the item's own unit.** Cost per typed gram = cost per stock unit × converted amount.
- Unconvertible unit on a line → `BAD_UNIT` (whole `apply_changes` call refused).

## A9. Option library
### Tables (owner writes through `apply_changes`; every shop login reads)
- **`option_groups`**: `id, business_id, name (1–40), required, multi_select, options jsonb, applies_to jsonb, sort_order, active, created_at, updated_at`.
  - `applies_to = {"recipe_types":["DRINKS",...], "subcategories":["Iced coffee",...]}` (type OR sub-category matches; sub-category ignores case/spaces).
  - `options` (1–30): `{id (1–64, unique), label (1–40, unique ignoring case), price_delta, kind, ...}`
    - `kind:'PLAIN'` (default): price only.
    - `kind:'EXTRA'`: `extras:[{ingredient_id, quantity}]` (stock unit) or `[{ingredient_id, entered_quantity, unit}]`, at most 5 per option.
      **Cups and lids**: one option, e.g. "Iced cup" with extras cup ×1 + lid ×1 (stock items in pcs; low-stock warnings as usual).
    - `kind:'SWAP'`: `swap_from_ingredient_id`, `swap_to_ingredient_id` (different, this shop's), `price_delta ≥ 0` = the one swap price for all items.
  - Bad group → `BAD_OPTION_GROUP: <reason>`.
- **`option_group_recipes`**: `id, business_id, group_id, recipe_id, mode ('EXCLUDE' = untick on this item | 'INCLUDE' = tick on for an item outside applies_to), created_at`. One row per group+recipe.
- `bo_bootstrap` adds `option_groups` and `option_group_recipes`.

### How items get them (database does it; no app copying)
- On every recipe save, and whenever a library group, a tick, or a recipe's lines change, the database rebuilds
  `recipes.modifier_groups` = **library groups that apply (library order) + the recipe's own groups**.
- Production recipes never get library groups unless ticked on (`INCLUDE`).
- A library group inside `modifier_groups` looks like:
  `{id:'lib_<group uuid>', library_group_id, name, required, multi_select, options:[{id, label, price_delta, kind, ingredient_id, ingredient_qty_delta, extras:[{ingredient_id, quantity}], removes:[{ingredient_id, quantity}], swap_from_ingredient_id?, swap_to_ingredient_id?}]}`
  - `extras` / `removes` are **per one item, in stock units, already worked out for THIS recipe**.
  - SWAP: `removes` = everything this recipe uses of the "from" ingredient (all its lines); `extras` = the same amount of "to" (converted). A recipe that doesn't use "from" doesn't get the swap option; a group left empty is left out.
  - `ingredient_id`/`ingredient_qty_delta` = the first extra (for 1.3 counters); `null`/0 on a SWAP.
- **The Back Office must not edit library groups inside a recipe**: groups with `id` starting `lib_` or with `library_group_id` sent back on a recipe save are thrown away and rebuilt from the library (so an old Back Office re-saving a recipe can't duplicate or change them). Own groups are kept as sent; an own option may use `extras` too.
- The recipe's `updated_at` changes when its options change, so counters pick it up on refresh.

### Pricing and stock (new shared rule; `inventoryLinesForSaleLine` and `computeSaleTotals` must match)
- **Price:** unchanged formula: `selling_price + Σ chosen options' price_delta` (`_menu_unit_price` finds options by group name + label, so library groups and swaps are covered with no change). A swap sold without its price → `PRICE_BELOW_MENU`.
- **Stock per sale line** (qty Q): recipe lines × Q + Σ chosen options' `extras` × Q − Σ chosen options' `removes` × Q, summed per ingredient, keep amounts > 0. Options without `extras` use the old `ingredient_id × ingredient_qty_delta`.
  Server version: `_recipe_stock_lines` (used for waste; sales still trust the counter's stock lines as before).
- **Required groups** (e.g. Hot/Iced): `required:true` on the library group; enforced by `qr_place_order` (`OPTION_REQUIRED`, `group` = name) and must be enforced by the counter.
- **QR page:** `get_qr_menu` options add `kind` (PLAIN/EXTRA/SWAP); never stock amounts. `qr_place_order` takes `{group_id, option_id}` as before (group ids `lib_…`); each saved modifier also carries `kind`, `extras`, `removes`, so paying the order at the counter deducts the swap correctly.

## A8. Supplied items (owner only)
- **`save_supplied_item(p_item jsonb)`** creates/edits, all-or-nothing:
  a recipe (`recipe_type` PASTRY default or FOOD, `supplied_ingredient_id` set) + a stock item in **pcs** + one recipe line "1 pcs" (+ optional restock purchase + PURCHASE stock line).
  - `p_item = {recipe_id?, ingredient_id? (both or neither), name, recipe_type, subcategory, supplier_id, category_id, cost_per_piece, selling_price, image_url, description, pos_visible, qr_visible, active, sort_order, reorder_level, restock?:{quantity, cost_per_piece | total_price, purchase_date, invoice_number, notes, brand_id}}`
  - Returns `{recipe_id, ingredient_id, purchase_id|null, cost_per_piece, selling_price, margin, margin_pct}`; cost = latest purchase price per piece, else the typed cost (`ingredients.standard_cost`).
  - Errors: `BAD_NAME`, `BAD_TYPE`, `BAD_PRICE`, `BAD_QUANTITY`, `NOT_A_SUPPLIED_ITEM`, `FORBIDDEN_ROW`.
- New columns: `recipes.supplied_ingredient_id`, `ingredients.standard_cost`. The stock item can't leave pcs (`SUPPLIED_NEEDS_PCS`).
- Sales, waste, counts, sold-out work as for any recipe (1 pc per sale; no stock = can't be sold, Q6 rule).
- Later restocks can also be ordinary purchases of the stock item.

## A15. Counter waste log (`fo_sync` op `waste`)
- `{op_id, type:'waste', data:{id (uuid, made on the counter), reason, note, staff_id, shift_id, logged_at, items:[...], approved_by, approval_token}}`
  - `reason`: `CALIBRATION` | `SPILLAGE` | `COMPLIMENTARY` | `EXPIRED` | `OTHER` (`OTHER` needs `note`, ≤ 200 chars).
  - `items` (1–30): `{recipe_id, quantity (≤100), modifiers:[{group,label}|{group_id,option_id}]}` or `{ingredient_id, quantity, unit}` (any convertible unit).
  - **The server works out the stock** (`_recipe_stock_lines`, same rule as a sale incl. extras/swaps) and the cost; the counter sends no stock lines.
  - **COMPLIMENTARY** needs approval exactly like a discount: `approved_by` + `approval_token` = manager/admin OVERRIDE (one-time), or the manager's own LOGIN token when that manager is `staff_id` (offline-safe). Other reasons: no approval.
  - **Idempotent:** same `op_id` → `duplicate`; same `data.id` with a new op_id → `skipped` (checked before approval, so a retry never needs a second PIN).
  - `staff_id` ≠ the server's signed-in staff → saved with `needs_review`, `review_reason='STAFF_MISMATCH'`.
- Writes `waste_logs` (+ `waste_log_items`) and `inventory_transactions` type `WASTE`, `reference_id = data.id`.
- New error codes: `BAD_WASTE`, `BAD_WASTE_REASON`, `NOTE_REQUIRED`, `BAD_QUANTITY`, `BAD_UNIT` (+ existing `UNKNOWN_RECIPE`, `UNKNOWN_INGREDIENT`, `UNKNOWN_STAFF`, approval codes).
- Stamp freebies stay on the reward path; there is no "stamp freebie" waste reason (lead decision 2026-11-03).
- **Back Office:** `waste_report(p_from date, p_to date)` (owner only, ≤ 400 days, else `BAD_DATE`) →
  `{from, to, total_cost, by_reason:[{reason, entries, cost}], by_day:[{day, reason, source, entries, cost}], entries:[{id, source:'COUNTER'|'OFFICE', day, reason, note, staff_name, approved_by_name, needs_review, cost, items:[{name, quantity, unit, recipe_id, ingredient_id, modifiers, cost}]}]}` (newest 500).
  Back Office waste (the `waste` table) is included as `OFFICE`.
- Counters read neither table; the owner reads both directly too.

## A11. Operating supplies, expenses, net income (owner only)
- **`categories.kind`**: `'STOCK'` (default) | `'EXPENSE'`. Every shop gets a category **"Operating supplies"** (EXPENSE). The category manager may set `kind`.
  - Items in an EXPENSE category are not stock: a purchase, starting stock or positive adjustment → `EXPENSE_ITEM_NOT_STOCK` (taking old stock off is allowed). Counter sale/refund lines for them are dropped silently.
  - The Back Office records buying them as an **expense** (category SUPPLIES, optional `ingredient_id`, `quantity`, `unit`, `supplier_id`), and should hide them from stock counts, low-stock, inventory value and recipe pickers.
- **`expenses`** (owner reads/writes via `apply_changes`): `id, business_id, expense_date, category ('SUPPLIES','RENT','UTILITIES','INTERNET','WAGES','REPAIRS','OTHER'), amount (> 0), note (≤ 500), photo_path, ingredient_id, supplier_id, quantity, unit, created_by, created_at, updated_at`.
  - Receipt photos: **private** bucket `expense-photos`, path `<business_id>/<file>`, owner only (read with an authenticated storage request, not a public URL).
- **`net_income_report(p_month date)`** → `{month:'YYYY-MM', from, to, sales:{gross, refunds, net, tax, service_charge, count}, ingredients:{sold, wasted, used}, expenses:{total, by_category:{RENT:…}}, net_income}`
  - gross = finished (not voided) sales of the month; refunds = full/partial refunds dated in the month.
  - tax = tax on those sales minus the refunds' tax share (refund × sale tax ÷ sale grand total). **Tax is owed, not income** (lead decision 2026-11-03), so it is shown as its own line and taken out.
  - net = gross − refunds − tax. Service charge stays income (shown as `service_charge` for information).
  - sold = cost of SALE_USAGE − SALE_REVERSAL stock lines of the month; wasted = cost of WASTE lines; costs per unit = `_ingredient_unit_cost`, following the shop's costing method (lead-approved 2026-11-03): weighted average over purchases up to month end, or the latest purchase price when the method is `latest` (not the brand in use); house-made = production recipe ÷ yield, else batches; supplied without purchases = `standard_cost`).
  - net_income = net − used − expenses.

## A12. Merge ingredients (owner only)
- **`merge_ingredients_preview(p_ids uuid[], p_name text, p_into uuid default null, p_base_unit text default null, p_brand_names jsonb default '{}')`** (changes nothing) and
  **`merge_ingredients(...same...)`** (all-or-nothing; returns the plan + `{done:true, ingredient_id}`).
  - `p_into` empty → a new general ingredient named `p_name` (stock unit `p_base_unit` or the first picked one's); else merge into that existing ingredient (`p_name` empty = keep its name).
  - `p_brand_names = {"<picked id>":"Arla"}`: name of the brand each picked ingredient becomes (default its own name; "(2)" added when taken).
  - Plan: `{general:{id, is_new, name, base_unit, category_id, stock_now, stock_after}, sources:[{id, name, base_unit, factor, stock, stock_in_general_unit, purchases, stock_lines, becomes_brand, brands:[{id, name, new_name}], reorder_level, category_id, supplier_id}], recipes:[{recipe_id, name, is_production_recipe, lines, lines_combined}], option_recipes:[{recipe_id, name}], library_groups:[{id, name}], open_qr_orders, waste_records}`
- What merge does: picked ingredients' brands move to G; each picked ingredient becomes a brand of G for its unbranded purchases/starting stock (FIFO brand stock keeps working); every purchase, stock line, waste record, waste log, expense, recipe line (menu + production), option extra/swap (recipes + library), sale item option and QR order item is repointed and converted (×factor); two lines of one recipe on G are combined; picked ingredients stay with `active=false`, `merged_into=G`, `merged_at`. One audit row "Merge ingredients".
- **Old offline counters** that still name a merged ingredient upload fine: the server moves those lines to G (converted).
- Errors: `MERGE_TOO_FEW`, `MERGE_TOO_MANY` (> 30), `MERGE_UNKNOWN_INGREDIENT`, `MERGE_ALREADY_MERGED`, `MERGE_PRODUCED_NOT_ALLOWED` (house-made), `MERGE_SUPPLIED_NOT_ALLOWED`, `MERGE_UNIT_MISMATCH`, `BAD_NAME`, `NAME_TAKEN`, `BUSY_TRY_AGAIN`.
- Apps: hide `merged_into` ingredients from pickers (they are inactive).

## Old apps (1.3) against 010
Everything is additive; no rename, no removed column or function. Known limits until the 1.4 apps are live:
- A 1.3 counter deducts only the first extra of a multi-extra option (cup, not the lid), and for a swap deducts the recipe's normal milk and nothing of the swap ingredient. Prices are right.
- A 1.3 Back Office shows library groups inside recipes; edits to them are ignored (rebuilt from the library).

## Back Office writable tables / backup
`apply_changes` adds `option_groups`, `option_group_recipes`, `expenses`, `waste_logs`, `waste_log_items`. Backup/import order: option groups after recipes, ticks after both; expenses after ingredients/suppliers; waste logs after shifts, items after logs.

## Live rule changed
`sync_operations.operation_type` allowed words gain `'waste'` (re-made as in 006, keeping every stored word). Stock line type `WASTE` is already allowed live.

## New labels for the apps
- Waste reasons: CALIBRATION "Calibration / barista drink", SPILLAGE "Spillage", COMPLIMENTARY "Complimentary", EXPIRED "Expired / spoiled", OTHER "Other".
- Expense categories: SUPPLIES "Operating supplies", RENT "Rent", UTILITIES "Utilities (power, water)", INTERNET "Internet", WAGES "Wages", REPAIRS "Repairs", OTHER "Other".
- Every new error code above needs a plain-language text (counter: the five fo_sync codes; Back Office: merge, supplied item, weighs, option group, expense codes).
