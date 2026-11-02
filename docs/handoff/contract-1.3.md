# Release 1.3 (Wave 1): database contract (`cccc/supabase/009_release_1_3.sql`)
From db-security-engineer's report, 2026-11-02. If the script and this file disagree, the script wins.

## Start fresh (A4): owner's email login (ADMIN) only
- **`start_fresh_preview(p_before timestamptz)`** changes nothing. It returns:
  `{before, open_shifts, can_start_fresh, remove:{sales, sale_items, payments, refunds, shifts, cash_movements, qr_orders, loyalty_redemptions, stock_lines, customers_affected}, keep:{…}, stock_changes:[{ingredient_id, name, base_unit, stock_now, stock_after}]}`
- **`start_fresh(p_before timestamptz, p_confirm text)`**
  - `p_confirm` must be exactly `START FRESH`.
  - Returns `{done:true, before, removed, kept, stock_changes}`; `removed` equals the preview's `remove`.
- **Errors:** `NOT_ALLOWED`, `NOT_A_MEMBER`, `BAD_DATE` (missing or in the future), `CONFIRM_REQUIRED`, `SHIFT_STILL_OPEN` (any ACTIVE shift), `BUSY_TRY_AGAIN`.
- **Removed:** all sales and their items, payments, refunds and rewards used, plus their SALE_USAGE / SALE_REVERSAL stock lines (so that stock comes back). Also cash pay-ins/outs, unreferenced closed shifts, QR orders and old QR number counters.
- **Kept:** everything else, including upload receipts (`sync_operations`).
- **Customers:** stamps, visits, total spent and last order are recalculated.
- **Records:** one audit row, plus a row in `start_fresh_runs` (owner-readable).
- **Review flag `BEFORE_START_FRESH`:** a counter sale dated before the latest Start fresh is still saved, but flagged.

## Shop open / closed (A7)
- **Open** means any shift has `status = 'ACTIVE'` (helper `_shop_is_open`).
- **`get_qr_menu`** returns `is_open`. When closed, `items` is `[]`, but the shop name, look and stamp-card settings still come back.
- **`qr_place_order`** errors, in this order: `TABLE_NOT_FOUND`, `NOT_SIGNED_IN`, `ORDERING_OFF` (manual switch), `SHOP_CLOSED`.

## Sub-category order (A16) and QR colours (A3)
- **`settings.subcategory_order`:** a jsonb array of names, at most 100, each 1–40 characters, no duplicates ignoring case and spaces. A bad value gives `BAD_SUBCATEGORY_ORDER`.
  - Save it with `apply_changes` `update` on `settings`.
  - It is in the `fo_bootstrap` / `bo_bootstrap` settings.
- **`get_qr_menu`** adds `subcategory_colors` and `subcategory_order`; each item gets `recipe_type` and `subcategory`. `category` is unchanged.
- **The "drinks first" rule** is applied by the shared sort helper in the apps.

## Customer sort (A17)
- `fo_customer_list(p_search='', p_limit=30, p_staff_token=null, p_sort='recent')`
- `p_sort` is `'name'` (nickname A–Z), `'recent'` (last visit) or `'frequent'` (visits, then recent). The answer includes `sort`.

## Out of stock (Q6)
- The server never refuses a sale for stock: the money is already taken.
- If a sale (including a paid QR order) takes any ingredient below 0, the sale is saved with review reason **`OUT_OF_STOCK`**.
- The counter blocks out-of-stock items before payment.

## Retry without the reward (P2)
- No server change. A refused op is rolled back completely.
- **To retry,** send the same `sale.id`, a new `op_id`, no `loyalty_reward`, `loyalty_discount` 0, full-price totals and the real payment. If the payment is less than the total, the server flags `PAYMENT_MISMATCH`.
- The same discount approval token can be sent again.

## New review-reason labels for the Back Office
- `OUT_OF_STOCK`: "Sold with not enough stock"
- `BEFORE_START_FRESH`: "Dated before Start fresh"
