# Resume here (save point: 2026-10-13, checkpoint 4)

Owner: to continue, open this project and tell C: **"Resume from docs/RESUME.md"**.

## Where we are
- Branch `wip/cccc-online-qr`, commit `4fc56e1`, pushed to GitHub. Nothing is uncommitted.
- **Stage 3 (test + security + fix loop), about 75% done.**
  - QA's first regression found 6 bugs. All 6 are fixed in code:
    - D1: the counter didn't see Back Office refunds;
    - D2: a QR order could be paid twice;
    - D3: a refused pairing left a hidden counter login;
    - D4: the calendar hover label sat over the wrong hour;
    - D5: some error messages showed raw codes;
    - D6: the owner's refunds had no server limit.
  - Your 2026-10-12 decisions are built in:
    - partial refunds pay back what the customer actually paid;
    - refund limits apply to the owner too;
    - a signed-in manager can approve their own actions offline;
    - Senior/PWD discount button: later.
  - **Not done yet:** the re-test of those fixes (QA) and the final security review.
- The database script `cccc/supabase/004_cccc_online_qr.sql` has still **not** been run on the live Supabase. Nothing has changed for your live shop.

## Next steps (in order)
1. **QA re-run.** `qa-test-engineer` updates the tests (lead-approved changes below), then runs `tests/run_all.sh --runs 2`. The material it needs is in `docs/handoff/`.
2. **Security review, run fresh.** The last attempt couldn't deliver its findings. Ask for a defensive-only format: one line per finding with severity | owner file | weakness | effect | fix, plus the decisions 1–7 table. No reproduction steps.
3. **Fix loop** on anything found, then QA once more.
4. **Lead wrap-up:**
   - a beginner setup guide (run 004 in Supabase, turn on anonymous sign-ins, Redirect URLs for `…/cccc/back/`, CAPTCHA/rate limits);
   - the root landing page;
   - checkpoint 5.
5. **Resume the paused prototype walkthrough** (`docs/prototype/NOTES.md`).
6. Open suggestions for the owner: Senior/PWD 20% discount button (decided: later), loyalty stamps rewards.

## Lead-approved test expectation changes (for QA)
- **`tests/sql/30_security_tests.sql`:** apply `docs/handoff/30_patch.diff`. It covers expired-token time, the 6-argument `_use_approval`, `p_cashier`/`p_performer` in the helpers, and the manager's own sale/refund.
- **`tests/e2e/money.e2e.js`:**
  - Refunds and totals:
    - latte refund 200 → **244.00**, Americano refund 110 → **107.36**;
    - refunds total **351.36**, net sales **799.10**, expected cash **2,300.10**;
    - declare **2,300.10** at close.
  - New sales words:
    - X-report row "Gross Sales" → "Item sales (before discounts)";
    - counter "Net Sales" → "Net sales";
    - Back Office calendar sub-text "Sales ₱1,150.46 − refunds ₱351.36".
  - A corrected copy from the counter developer is `docs/handoff/money_new.e2e.js`. It still had 1 Back Office calendar-text mismatch to check.
- **Reset the database between browser suites** (`fo_security` fails if run straight after `fo.e2e` without a reset).

QA can adopt these extra checks from `docs/handoff/`:
- `logic_refund_check.js` (96), `email_link_check.js` (53), `refund_parity_check.js`;
- `fix_checks.sql` (130 database checks) and `conc_checks.sh` (concurrency);
- `ticket_states.js` (QR ticket wording), `hand_refund.js` (offline manager approvals), `import_refunds.js` (old-app refunds).

## Small open decisions (lead can decide; no owner input needed)
- Back Office dashboard card "Sales today" actually shows **net** sales. The developer recommends renaming it to "Net sales today" (QA updates `bo.e2e` part2 and `money.e2e`).
- Database: `qr_cancel_order` could also require `paid_at is null`. It is safe today; this is defence in depth.

## How the team works
Rules and file owners: `CLAUDE.md`. Test commands: `tests/README.md`. Save points: `docs/checkpoints.md`.
- Local test PostgreSQL may need `tests/start_pg.sh` after a restart.
- Each agent has its own database and port: FO `db_fo`/8790, BO `db_bo`/8791, QR `db_qr`/8792, DB `db_sec`, QA `cccc`/8787.
