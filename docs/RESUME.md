# Resume here (save point: 2026-10-20, checkpoint 6)

Owner: to continue, open this project and tell C: **"Resume from docs/RESUME.md"**.

## Where we are: ready for go-live
- Branch `wip/cccc-online-qr`, checkpoint 6, pushed to GitHub. **Pull request #1** (→ `main`) is
  open for the owner. It says to merge only after setup guide Parts 1–3.
- Tests: 49 suites, 3,238 checks, all passing (two runs).
- Final security verdict: **ready for go-live**. Every finding is fixed, including the last
  privacy fix: customer erasure now also covers item notes and refund reasons.
- CAPTCHA (Cloudflare Turnstile) is supported in all apps but **off**. Owner decision: go live
  without it; turn it on later only if fake orders appear. Order when the time comes: owner sends the
  site key → C adds it → C confirms → owner switches it on in Supabase.
- The old POS/Inventory/test pages are moved to `_archive/old-apps/`. They come off the live site
  when PR #1 is merged.
- Live Supabase and the live site are still unchanged.

## Next steps
1. **Owner follows `docs/SETUP_GUIDE.md`** (about 45 min); C is on standby:
   - backup;
   - run 004;
   - Supabase settings;
   - merge PR #1;
   - Back Office first setup;
   - test.
2. **After go-live:**
   - a `005` script drops `profiles.pin_hash`;
   - optional copy polish: the Back Office "Could not reach the CAPTCHA check" message says "CAPTCHA"
     (core-sync, `captcha.js`).
3. **Later list:**
   - prototype walkthrough (`docs/prototype/NOTES.md`);
   - Senior/PWD 20% discount button;
   - loyalty stamps rewards.

## Saving to Obsidian
The session note lives at `docs/obsidian/CCCC POS — session log.md` and is updated at every
checkpoint. The owner's local Claude Code copies it into the vault: "Pull the latest from GitHub and
copy docs/obsidian/CCCC POS — session log.md into my vault."

## How the team works
Rules and file owners: `CLAUDE.md`. Tests: `tests/README.md` (`tests/run_all.sh --runs 2`, about 30 min).
Save points: `docs/checkpoints.md`.
- Each agent uses its own database and port: FO `db_fo`/8790, BO `db_bo`/8791, QR `db_qr`/8792,
  DB `db_sec`, QA `cccc`/8787.
- Start PostgreSQL with `tests/start_pg.sh` after a restart.
- Test PINs: cashier 1111, manager 222222, owner 999999.
