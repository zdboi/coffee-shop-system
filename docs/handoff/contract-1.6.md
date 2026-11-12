# Contract for release 1.6 (Wave 4 "Money"), database script 013

Plan: `docs/PLAN_1.6.md`. Decisions: `docs/owner-feedback.md`. Everything here is in `cccc/supabase/013_release_1_6.sql`
unless marked "screens".

## A. New columns, tables, rules

| Where | New | Notes |
|---|---|---|
| `settings.payment_methods` jsonb | list of methods | Checked by `_valid_payment_methods` in `_settings_check` (else `BAD_PAYMENT_METHODS`). Goes to counters with the settings (`fo_bootstrap`). |
| `settings.senior_discount_pct` numeric, default 20 | 0..100 | 0 = the Senior/PWD button is hidden. `BAD_SENIOR_PCT` outside 0..100. |
| `settings.count_recheck_days` int, default 7 | 1..60 | Unmoved ticked items are due again after this many shop days. `BAD_RECHECK_DAYS`. |
| `sales.senior_kind` text | null, `SENIOR`, `PWD` | |
| `sales.senior_items_amount`, `vat_exempt_amount`, `senior_discount`, `payment_charge`, `payment_fee` numeric, default 0 | | All locked on a finished sale (`_lock_finished_sale`). |
| `sale_items.senior_discount` numeric, default 0 | VAT taken out + discount of that line | A Senior/PWD line is entirely the customer's (the counter splits lines). |
| `senior_discount_records` (new table) | one row per Senior/PWD sale: kind, holder_name, id_number, pct, amounts, cashier | RLS on, no API access at all (`revoke all`). Written only by `fo_sync`; read only through `senior_report` (owner). Deleted with its sale (FK cascade: Start fresh). |
| `payments.method` rule | word list → format rule `^[A-Z][A-Z0-9_]{1,19}$` | Live rule replaced (owner can add methods). Every stored word already fits. |

### `settings.payment_methods`
Array, 1..12 items, in display order:
```json
{"id":"GCASH","label":"GCash","active":true,"reference":true,
 "charge_type":"NONE|PERCENT|FIXED","charge_value":0,"charge_default":"ADD|WAIVE"}
```
- `id`: `^[A-Z][A-Z0-9_]{1,19}$`, each once. `label`: 1..24 characters, no control characters.
- `CASH` must be there, active, `charge_type` `NONE`.
- `PERCENT`: above 0, at most 25. `FIXED`: above 0, at most 1000. `NONE`: value 0.
- 013 sets every shop's list to: CASH Cash, GCASH GCash, QR "QR payment", CARD Card, BANK "Bank transfer" (active), MAYA Maya, OTHER Other (off). A ₱0 sale ("nothing to pay") still saves as method `OTHER`.

## B. Sale totals (shared `computeSaleTotals` = server `_check_sale_totals`)
`S` subtotal, `D` manager discount, `R` stamp reward, `A` Senior/PWD items total (`senior_items_amount`),
`V` `vat_exempt_amount`, `Ds` `senior_discount`, `t` tax %, `s` service %, `p` `senior_discount_pct`.

```
V    = prices include tax and t > 0 ?  round2(A − A / (1 + t))  : 0
Ds   = round2((A − V) × p)
base = S − D − R − V − Ds
tax  = prices include tax ? 0 : (base − (A − V − Ds)) × t          (no tax on Senior/PWD items)
svc  = base × s
pre  = base + tax + svc
fee  = method charge: PERCENT round2(pre × c) | FIXED c | NONE 0   (0 when pre is 0)     -> sales.payment_fee
chg  = waived ? 0 : fee                                                                    -> sales.payment_charge
grand_total = round2(pre + chg)
sale_items.senior_discount: (V + Ds) shared over the Senior/PWD lines by line total (last line takes the rest)
```

**Refused** (`fo_sync` answers `error`):
- `SALE_TOTALS_MISMATCH`: as before, plus: `grand_total` ≠ `S − D − R − V − Ds + tax + svc + chg` (2 centavos); a negative new amount; `chg` neither 0 nor `fee`.
- `BAD_SENIOR` (new): `V + Ds > 0` and any of: `D > 0` or `R > 0` (not combined); `senior_kind` not SENIOR/PWD; `data.senior` missing or its `holder_name` (2..80) / `id_number` (3..40) empty; no Senior/PWD line; `A` ≠ the Senior/PWD lines' total; lines' `senior_discount` don't add up to `V + Ds`, or one is above its line total. Also: a Senior/PWD line or kind on a sale with `V + Ds = 0`.
- Senior/PWD needs **no** approval token. A manager discount still does.

**Flagged for review** (saved, `needs_review`):
- `TAX_MISMATCH` now expects no tax on Senior/PWD items.
- `SENIOR_MISMATCH` (new): `V` or `Ds` differ from the settings' numbers (e.g. a counter with old settings), or `p` is 0.
- `CHARGE_MISMATCH` (new): `payment_fee` differs from the method's charge in the settings.
- `PAYMENT_METHOD_OFF` (new): the method is not in the list or is switched off (not for a ₱0 sale).

`sale` op data: as before + `data.senior = {kind, holder_name, id_number}` (only with a Senior/PWD discount).
The server saves it in `senior_discount_records` (pct = what the sale used: `Ds / (A − V)`), and never sends it back to a counter.

**Partial refund share** (`refundAmountForItems` = `_refund_items_cap`): returned value = Σ (unit price − line `senior_discount` / line quantity) × quantity returned;
share = returned value × `grand_total` / (`S − V − Ds`). Same as before for sales without Senior/PWD.

## C. Smart stock count (B20)
- `_count_due(biz, shift)`: ticked items (`_count_items`) that are due, ignoring counts of `shift`:
  never counted before; or a stock line arrived (server `created_at`) after the item's last count was received (count-made lines don't count); or its last count day is `count_recheck_days` or more shop days ago.
- `fo_count_due(p_shift_id)` (paired counter): `{server_time, recheck_days, items: [ingredient_id]}`. Ids only (blind).
- `bo_count_status()` (owner): `[{ingredient_id, name, last_counted_at, due, why: NEVER|MOVED|RECHECK|null}]`.
- `stock_count` op: lines may be any ticked items (not only due ones). Flag `COUNT_INCOMPLETE` = a due item has no line in any count of this shift.
- `shift_close`: `COUNT_REQUIRED` only when items are due and the shift has no count at all. Otherwise it closes; if due items are still uncounted, the shift's latest count is flagged `COUNT_INCOMPLETE`.
- Counter (screens): online → asks `fo_count_due` at Close shift; offline → last list it got + ticked items it moved itself since (sales, waste). Nothing due → no count step.

## D. Reports
- `accounting_report(p_from date, p_to date)` (owner; range 1..400 days, else `BAD_RANGE`):
  - `totals`: `sale_count, item_sales, discounts, loyalty_rewards, senior_discounts, vat_exempt, tax, service_charge, payment_charges, sales, refunds, net_sales, void_count, voids, tax_owed, payment_fees, charges_waived, ingredients_sold, ingredients_wasted, waste_by_reason{}, expenses, expenses_by_category{}, net_income, cash_over_short, shifts_closed, items{drinks, food, other}`.
  - `days`: one row per shop day with `day, sale_count, sales, refunds, net_sales, void_count, voids, waste, expenses, net_income, drinks, food, other`.
  - `payment_methods`: `[{method, label, count, total, charges, fees, waived}]`. `waived_list` (latest 200): `[{date, transaction_number, method, amount, cashier_name}]`.
  - Rules: counted sales = COMPLETED / PARTIALLY_REFUNDED / REFUNDED by sale day; refunds and voids by the day they were made; `net_sales = sales − refunds`; `tax_owed` = tax minus the refunded share; `net_income = net_sales − tax_owed − payment_fees − ingredients_sold − ingredients_wasted − expenses`. Costs as of `p_to` (same as `net_income_report`, so a calendar month gives the same net income apart from payment fees, which are new).
  - Day rows add up to the totals to the centavo (the last day takes rounding rest only through unrounded sums: all sums are rounded once, at the end; tests allow 1 centavo per column).
- `senior_report(p_from date, p_to date)` (owner): `[{date, transaction_number, status, kind, holder_name, id_number, items_amount, vat_exempt, discount, pct, grand_total, cashier_name}]`, voided sales left out.

## E. Rights
| Function | Who |
|---|---|
| `fo_sync`, `fo_count_due` | paired counter (DEVICE login) |
| `accounting_report`, `senior_report`, `bo_count_status` | owner (profile ADMIN) |
| everything starting with `_` | nobody through the API |

## F. Lead decisions to note for Z
1. Close shift is no longer refused for a count that misses items (only for no count at all while items are due). Reason: with a server-decided, moving list, an offline counter can't know another counter's sales, and a refused close can't be repaired by staff. Missed items are flagged and stay due.
2. Senior/PWD needs no manager approval (owner decision). The ID record + report + review flags are the control.
3. ID numbers: write-only for counters. Full numbers only in `senior_report` (owner).
