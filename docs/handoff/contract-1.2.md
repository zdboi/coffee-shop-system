# Release 1.2: database contract (script `cccc/supabase/008_release_1_2.sql`)

From db-security-engineer's report, 2026-10-29. If the script and this file disagree, the script wins; tell the lead.

## A. Floor plan
- **`dining_tables`, new columns:**
  - `shape`: SQUARE (default), ROUND or RECT.
  - `pos_x`, `pos_y`: numeric, 0 to 1000. **Empty means "not placed yet".**
  - `width`, `height`: default 80, from 10 to 1000.
  - `rotation`: int, 0 to 359.
  - `seats`: empty or 1 to 99.
  - The plan is a 1000 × 1000 grid.
- **New table `floor_shapes`:**
  - Columns: `id`, `business_id`, `kind`, `label` (at most 40 characters), `shape` (RECT or ROUND), `pos_x`, `pos_y`, `width`, `height` (1 to 1000), `rotation`, `sort_order`, `created_at`, `updated_at`.
  - `kind` is COUNTER, WALL, DOOR, PLANT, LABEL or OTHER.
  - Everyone in the shop can read it; only the owner writes it, through `apply_changes`.
- **`fo_floor_plan()`** returns `{tables:[dining_tables rows WITHOUT qr_token], shapes:[floor_shapes rows]}`.
- **`fo_bootstrap`:** `tables` no longer has `qr_token`, and there is a new `floor_shapes` list.
- **Counters can't read `qr_token` at all** (lead decision).
- **`bo_bootstrap`** adds `floor_shapes`.

## B. Sub-category tile colours
- `settings.subcategory_colors` jsonb, default `{}`, shaped like `{"Iced":"terracotta"}`.
- Values must be one of: `terracotta, deep_terracotta, olive, gold, butter, ink, sage, clay, cocoa, sky`. At most 100 entries; keys 1 to 40 characters. Anything else gives `BAD_SUBCATEGORY_COLORS`.
- Helpers in logic.js: `TILE_COLORS`, `tileColorKeyFor(name)`, `tileStyleVars(key)`.
- The full settings save (`SERVER_SETTING_KEYS`) does NOT send this column. Save it with an `apply_changes` `update` on settings.

## C. Ingredient brands (FIFO)
- **New table `ingredient_brands`:** `id`, `business_id`, `ingredient_id`, `name` (1 to 60 characters, unique per ingredient ignoring case), `active`, `sort_order`, `notes`, `created_at`, `updated_at`.
  - Owner only.
  - A brand that has been used can't be deleted (`BRAND_IN_USE`); switch it off with `active=false` instead.
- **`purchases.brand_id`:** the brand of a purchase.
- **`inventory_transactions.brand_id`:** only on `INITIAL_STOCK` or an `ADJUSTMENT` above 0 (`BRAND_NOT_ALLOWED`); it must be the same ingredient's brand (`BRAND_MISMATCH`). Sales and refunds are unchanged.
- **FIFO:** lots are purchases, starting stock, production and positive adjustments, ordered by date, then created time. The ingredient's total stock is assigned to the newest lots first. Any extra shows as brand "Not set".
- **`ingredient_brand_stock(p_ingredient_id default null)`** (owner only) returns:
  `[{ingredient_id, stock, in_use:{brand_id, brand_name, lot_id, lot_date, remaining, price_per_base_unit}|null, brands:[{brand_id|null, brand_name, remaining}], lots:[{lot_id, purchase_id, source, lot_date, brand_id, quantity, remaining, price_per_base_unit}] (oldest first)}]`
  - `bo_bootstrap` adds `ingredient_brands` and `brand_stock` in the same shape.
  - The price comes only from purchases.

## D. Stamp card + rewards
- **Earning:** per customer per Manila day, +1 for a paid drink line and +1 for a paid PASTRY or FOOD line, so at most 2 a day.
  - Voided and fully refunded sales earn nothing. A partial refund removes a day's stamp only if all of that day's drinks (or food) were given back.
  - `visit_count` is now the number of days with a paid sale.
  - Everything is worked out by the server; the copies on `customers` are refreshed by triggers.
- **`settings.loyalty_rewards`** default: `{"card_size":15,"rewards":[{"stamp":5,"type":"AMOUNT_OFF","amount":10,"label":"₱10 off"},{"stamp":10,"type":"AMOUNT_OFF","amount":50,"label":"₱50 off"},{"stamp":15,"type":"FREE_ITEM","label":"One free drink or food"}]}`. A bad value gives `BAD_LOYALTY_REWARDS`. `stamps_per_reward` is no longer used.
- **Card maths** (S = card size, T = total stamps):
  - `card_no = greatest(ceil(T/S), 1)`
  - `stamps_on_card = T - (card_no-1)*S`, from 0 to S
  - Reward m on card c is reached when `T >= (c-1)*S + m`.
  - Unused rewards from earlier cards stay available, with no expiry.
- **Summary** (counter and QR page): `{visits, last_visit_at, total_stamps, drink_stamps_earned, food_stamps_earned, card:{card_size, card_no, stamps_on_card, milestones:[{stamp, type, amount, label, status: locked|ready|redeemed}]}, ready_rewards:[{card_no, stamp, type, amount, label}]}`
- **Redemption on the fo_sync `sale` op:** `data.sale.loyalty_reward = {customer_id, card_no, milestone, recipe_id (FREE_ITEM only)}` plus `data.sale.loyalty_discount = amount`.
  - **The server checks:**
    - loyalty is on;
    - the customer is the sale's customer;
    - the reward was reached BEFORE this sale and is not already used;
    - for FREE_ITEM, the recipe is a drink or food line in this sale.
  - **Amount:** ₱10 or ₱50. For a free item, one unit at the server price (recipe plus options), capped at that line's unit price. Never more than subtotal minus discount. Rounded to centavos.
  - **Errors:**
    - `REWARD_NOT_AVAILABLE`: anything wrong with the reward.
    - `REWARD_AMOUNT_MISMATCH`: the counter's amount is more than 2 centavos off.
    - Either error refuses the **whole sale op**, which then waits in failed uploads for a manager.
  - **Release:** a void or full refund releases the reward (`released_at`).
- **Totals formula (`computeSaleTotals` must match):**
  - S = subtotal; D = the manager discount (as today).
  - R = min(reward, S − D); `base = S − D − R`.
  - tax = inclusive ? 0 : base × tax%; service = base × svc%; grand = base + tax + service.
  - Partial refunds keep using grand/subtotal, so the reward is shared across items automatically.
  - New column `sales.loyalty_discount`, locked on finished sales.
- **New table `loyalty_redemptions`:** `id`, `business_id`, `customer_id`, `card_no`, `milestone`, `reward_type`, `recipe_id`, `sale_id`, `amount`, `released_at`, `merged_from`, `created_at`.
  - Owner reads it.
  - Merging customers moves the rows; erasing a customer deletes them.
- **QR page customer data** (`qr_session`, `qr_register`, `qr_relink`, `qr_set_phone`): keeps the old fields and adds `total_stamps, drink_stamps_earned, food_stamps_earned, card, ready_rewards, loyalty_rewards`.
- **`get_qr_menu`** adds `loyalty_rewards` and `theme.theme`.

## E. Counter Customers tab
Both functions are for paired counters only and are rate-limited to 600 calls per hour per counter (`TOO_MANY_ATTEMPTS`).
- **`fo_customer_list(p_search='', p_limit=30, p_staff_token=null)`** returns:
  `{customers:[{id, nickname, phone (masked), phone_masked, visits, last_visit_at, first_seen_at, total_stamps, drink_stamps_earned, food_stamps_earned, card, ready_rewards, total_spent*}], show_money, money_refused, loyalty_enabled, loyalty_rewards}`
  - Search is by nickname only, at most 50 results.
- **`fo_customer_detail(p_customer_id, p_staff_token=null)`** returns `{customer, favourites:[{recipe_id, name, count}] (top 5), recent_orders:[{sale_id, order_number, qr_order_number, transaction_date, status, source, reward, items:[{name, quantity, refunded_quantity}], grand_total*, loyalty_discount*, refunded*}] (last 20), show_money, money_refused, loyalty_enabled, loyalty_rewards}`.
- **Fields marked \*** appear only with a valid MANAGER/ADMIN LOGIN token (or an unused OVERRIDE) from this counter, at most 24 hours old. Viewing never uses up the token.
  - `money_refused` says why not: `APPROVAL_INVALID`, `ROLE_TOO_LOW` or `PIN_UPDATE_NEEDED`.

## F. Theme
- `settings.theme` is `'CCCC'` (default) or `'CUSTOM'`. Existing live rows become CCCC. Dark mode is dropped in 1.2.
- Until the new Back Office is live, an old Back Office sending `'light'` or `'dark'` keeps the current theme.

## Backup / import
Add `ingredient_brands`, `floor_shapes` and `loyalty_redemptions` to `BACKUP_TABLES` and the import order:
- brands after ingredients, before purchases and stock lines;
- redemptions after customers and sales.
