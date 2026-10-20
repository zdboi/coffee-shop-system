# Owner feedback from testing the live product

Collected while the owner browses and tests. **Not started.** C turns these into one batch of work only
when the owner says so.

| # | Date | App | Feedback | Owner file |
|---|---|---|---|---|
| 1 | 2026-10-20 | Counter (Front Office) | Move the **Back Office** button to the bottom of the side menu. Right under "Shift & Cash" it's easy to click by accident. | front-office-dev (`cccc/front/front.js`, nav) |

## Team fixes queued for the same batch (found by QA, not from the owner)
| # | Date | Fix | Owner file |
|---|---|---|---|
| T1 | 2026-10-20 | Old-backup import stops on live if a cash pay-in/out is ₱0 or less (live rule `cash_movements.amount > 0`). Skip such lines and count them as "broken line skipped"; keep the test fixture as is (lead decision). | back-office-dev (`cccc/back/bo-import.js` ~272) |
| T2 | 2026-10-20 | `fo_sync` `cash_movement` should refuse amount ≤ 0 with a clear code instead of a raw constraint error (007). | db-security-engineer |
