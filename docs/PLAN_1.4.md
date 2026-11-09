# Release 1.4 plan: Wave 2 "Menu & inventory"

Owner go-ahead: 2026-11-02 23:04 ("009 is live… proceed with the next wave").
- Item details: `docs/owner-feedback.md` (A8–A12, A15).
- 1.4 decisions: the section "Release 1.4 (Wave 2) decisions" in the same file.
- Live = 1.3 (abcff5b, checkpoint 13). Next database script: `cccc/supabase/010_release_1_4.sql`.

## Items
| Item | What | Decided |
|---|---|---|
| A12 | **Merge ingredients**: pick ingredients, name the general one, and each becomes a brand that keeps its purchases and stock. Recipes, option extras and production lines are repointed. Preview first; all-or-nothing. | Owner's groups: Full Cream Milk, Non-dairy Milk, Non-Coffee Milk, Cocoa Powder, Coffee Beans, Butter, Cream. Non-dairy milk is ONE ingredient; whichever brand is in stock is used (FIFO). |
| A10 | **"Weighs" for house-made sauces**: e.g. 1 L caramel = 1,250 g, so recipe lines and option extras can use g or mL. Stock stays in its own unit; cost and stock convert. | **Produced items only.** |
| A9 | **Option library**: shared option groups (Hot/Iced, take-away cup, extra shot, non-dairy swap). Each is applied to a type or sub-category by default, with per-item untick. Editing a library group updates every item that uses it; items can still have their own groups. New option kind **swap**: takes off one ingredient and puts on another in the amount the item's recipe uses. | Swap price: **one extra price for all** (set in the library). **Cups and lids are counted stock**, deducted by the take-away choice. Hot/Iced can be a required choice. |
| A8 | **Supplied items**: one form to buy and resell food and pastries. Name, sub-category, supplier, price paid per piece, selling price, photo, show on counter/QR. Stock is in pieces; one piece per sale; the margin is shown. House-made costing stays. | — |
| A15 | **Counter waste log**: menu items (with options) or single ingredients; quantity and reason (Calibration / barista drink, Spillage, Complimentary, Expired / spoiled, Other + note). Stock is deducted the same way a sale does. Works offline. The Back Office has a waste report per day and per reason. Stamp freebies stay on the reward path. | **Only Complimentary needs a manager's PIN** (checked by the server, like discounts). |
| A11 | **Expenses**: an "Operating supplies" category whose purchases are recorded as an expense, not stock. An Expenses log (supplies, rent, utilities, internet, wages, repairs, other; amount, note, optional photo). A monthly report: sales − ingredients used − operating expenses = net income. Owner only. | — |

## Build order
1. **Database + contract** (`db-security-engineer`): write `010_release_1_4.sql` and `docs/handoff/contract-1.4.md`, then the `security-reviewer` gate.
   - **A12:** merge preview and merge.
   - **A10:** the "weighs" value.
   - **A9:**
     - the option library;
     - the swap kind in the server's price and stock checks (`_menu_unit_price`, `fo_sync` sale stock lines, `get_qr_menu`, `qr_place_order`);
     - cups as stock.
   - **A8:** supplied items (probably a recipe linked to one ingredient in pieces, created together).
   - **A15:** a `waste` op in `fo_sync`, with the Complimentary approval token.
   - **A11:** expenses tables and the monthly report.
2. **Shared core** (`core-sync-engineer`): unit conversion through "weighs"; `inventoryLinesForSaleLine` and `computeSaleTotals` with swaps and library groups; waste stock lines; the outbox op `waste`.
3. **Screens, in parallel:**
   - **Back Office:** Merge tool, weighs field, option library, supplied-item form, expenses and net income report, waste report.
   - **Counter:** library options and swap in the cart, the waste log.
   - **QR page:** library options and the swap price shown (prices still from the database).
4. **QA:** full regression and new suites, including a money/stock/cash reconciliation with swaps, waste and merges. Then a security review of the screens. Then the release package.
