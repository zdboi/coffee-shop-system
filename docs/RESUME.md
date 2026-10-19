# Resume here (save point: 2026-10-19, checkpoint 5)

Owner: to continue, open this project and tell C: **"Resume from docs/RESUME.md"**.

## Where we are
- Branch `wip/cccc-online-qr`, checkpoint 5 = commit `69df9a8`, pushed to GitHub.
- **Stage 3 (test + security + fix loop) is done.**
  - Full regression: 46 suites, about 3,050 checks. The last full run's only 2 failures were
    fixed, and the counter suites re-pass.
  - **Security:** all 14 review findings fixed (F1–F14), plus R1–R4 from the second
    review of `apply_changes`:
    - audit log add-only;
    - links stay in the same shop;
    - QR order owner link locked;
    - counter adds outside the shop sign-up limit.
  - **Owner decisions 2026-10-19 (CLAUDE.md decisions 8 and 9):**
    - manager/admin PINs are 6 digits;
    - a short-PIN manager can sell but can't approve;
    - the old POS/Inventory/test pages come off the live site at go-live.
- **Owner setup guide written:** `docs/SETUP_GUIDE.md`.
- The database script `004` has still **not** been run on the live Supabase. Your live shop is unchanged.

## Next steps (in order)
1. **CAPTCHA support** (core + QR page + counter pairing). Turnstile token on anonymous sign-ins,
   with the site key in `config.js`. Until this is done, the owner must NOT switch CAPTCHA on in
   Supabase (the guide says so).
2. **Final security re-check:** a quick look at the short-PIN rule and CAPTCHA.
3. **Go-live prep (lead):**
   - move `POS/`, `Inventory/` and `connection-test.html` into `_archive/` (decision 9);
   - root landing page;
   - open a pull request `wip/cccc-online-qr` → `main` for the owner to merge (setup guide Part 4).
4. **Owner runs the setup guide**; C on standby.
5. **Later:** a `005` script drops `profiles.pin_hash` once the old apps are offline.
6. **Then:**
   - resume the paused prototype walkthrough (`docs/prototype/NOTES.md`);
   - Senior/PWD 20% discount button (owner said "later");
   - loyalty stamps rewards.

## How the team works
Rules and file owners: `CLAUDE.md`. Tests: `tests/README.md` (`tests/run_all.sh --runs 2`, about 25 min).
Save points: `docs/checkpoints.md`.
- Each agent uses its own database and port: FO `db_fo`/8790, BO `db_bo`/8791, QR `db_qr`/8792,
  DB `db_sec`, QA `cccc`/8787.
- Start PostgreSQL with `tests/start_pg.sh` after a restart.
- Test PINs: cashier 1111, manager 222222, owner 999999.
