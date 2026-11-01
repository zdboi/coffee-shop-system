# Resume here (save point: 2026-11-02, checkpoint 10, release 1.2 ready)

Owner: to continue, open this project and tell C: **"Resume from docs/RESUME.md"**.

## Where we are
- **Live:** release 1.1, commit 0741e1b (PR #2; 007 run on 2026-10-29). This is the **last working version** (`docs/checkpoints.md`).
- **Release 1.2 is built, tested and security-reviewed** on `wip/cccc-online-qr`. It waits for the owner to follow `docs/RELEASE_1.2.md`:
  1. counters uploaded;
  2. backup;
  3. run `008_release_1_2.sql`;
  4. merge the pull request;
  5. reload devices;
  6. set up loyalty, floor plan, colours and brands.
- **Contents of 1.2:**
  - full redesign (tokens in `cccc/shared/brand/tokens.css`, Brunson display font, wordmark images; `docs/design/`);
  - counter: Orders grouped by sub-category, tile colours, Customers tab, stamp rewards at checkout, floor plan on QR orders;
  - Back Office: floor plan editor, sub-category colours, ingredient brands with FIFO stock and "in use" cost, loyalty settings, loyalty rewards in reports;
  - QR page: restyle and the 15-stamp card.
  - Database contract: `docs/handoff/contract-1.2.md`.
- **QA:** `tests/run_all.sh --runs 2` passes 69/71 suites (4,295 checks). The 2 failures were one counter defect (D1), since fixed and re-tested. The money, stock, cash and brand-FIFO reconciliation (`tests/e2e/money12.e2e.js`) matches to the centavo.
- **Security:** 008 passed two review rounds (all findings fixed). The 1.2 screens review found 4 low items, all fixed.

## After the owner releases 1.2
- Mark 008 as run and frozen in CLAUDE.md; the next script is 009.
- Add checkpoint 11 "Release 1.2 live" as the new last working version.
- Update the changelog (1.2 = live) and send the Obsidian note.

## Next batch: release 1.3 (planned, see `docs/owner-feedback.md`)
- **QR ordering security (Q1–Q7):** guest vs registered sign-in, unique coffee-themed usernames, max 4 open tickets per table, 1 guest per table, account-switch warning that removes unpaid orders, and a stock check at payment where out-of-stock items must be removed (also for counter sales).
- **Thermal printing (P1):** the owner's counters are iPad, Android, Windows and Mac; printers are Bluetooth and LAN. Plan: a network printer with a built-in web print service (Epson ePOS / Star WebPRNT), with the print dialog as fallback. Ask the printer brand and model first.
- **P2:** manager-only "Retry without the reward" for refused reward sales.
- **Later, plan first:** RPG-style loyalty (levels, perks, promo stamps).
- **Older items:** T3 cash amount rules (needs the owner's check), T4 large pay-in flag, drop `profiles.pin_hash`, Senior/PWD discount.

## How the team works
Rules and file owners: `CLAUDE.md`. Tests: `tests/README.md`. Save points: `docs/checkpoints.md`.
- **Databases and ports:** FO `db_fo`/8790, BO `db_bo`/8791, QR `db_qr`/8792, DB `db_sec`, core `db_core`/8795, review `db_rev`, QA `cccc`/8787.
- Start PostgreSQL with `tests/start_pg.sh` after a restart.
- **Test PINs:** cashier 1111, manager 222222, owner 999999.
- Brand source files (logo prototype zip, Brunson font) came from the owner's Downloads; the shipped copies are in `cccc/shared/brand/`.
