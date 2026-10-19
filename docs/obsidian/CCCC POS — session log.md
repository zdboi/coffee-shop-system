---
tags: [cccc, pos, session-log]
project: Cavite City Coffee Club POS
dates: 2026-10-12 → 2026-10-19
checkpoint: 5
repo: zdboi/coffee-shop-system (branch wip/cccc-online-qr)
---

# CCCC POS: session log (Oct 12–19, 2026)

Work done with C (Claude, lead developer) and the agent team on the new Cavite City Coffee Club
system. It has three apps on one Supabase database:
- **Counter (Front Office):** staff sign in with a PIN; it keeps selling when offline.
- **Back Office:** the owner's email login only.
- **QR order page:** customers order from their phones and pay at the counter.

## Where things stand
- **Checkpoint 5**, commit `69df9a8`. Everything is saved on GitHub.
- Stage 3 (testing, security, fixes) is **done**. The full test suite has 46 groups and about 3,050 checks, all passing after the last fix.
- The database script `004` has **not** been run on the live Supabase yet, so the live shop is unchanged.
- Go-live guide: `docs/SETUP_GUIDE.md`. Resume note: `docs/RESUME.md`. Save points: `docs/checkpoints.md`.

## My decisions
| Date | Decision |
|---|---|
| Oct 12 | Build C chosen; Build R archived |
| Oct 12 | Partial refund = what the customer actually paid for those items (their share after discount, plus tax and service) |
| Oct 12 | Refund limits apply to everyone, including my own Back Office login |
| Oct 12 | A manager signed in at the counter can approve their **own** actions offline |
| Oct 12 | Senior/PWD 20% discount button: **later** |
| Oct 19 | Manager and owner PINs are **6 digits** (cashiers 4–6) |
| Oct 19 | A manager with an old short PIN can still sell but **can't approve** until changed |
| Oct 19 | Old POS / Inventory / test pages come **off the live site** at go-live |
| Oct 19 | Test the apps first, prototype walkthrough later |

## What got built and fixed
- **Counter:**
  - pairing code only;
  - manager approvals checked by the server;
  - offline selling with upload later;
  - a cashier sees my Back Office refunds before closing the shift;
  - pro-rated refunds;
  - customer consent tick;
  - offline PIN lockout;
  - stops a QR order being paid twice;
  - uploads waiting work before a new person signs in.
- **Back Office:**
  - all the old inventory screens, plus a sales calendar (day, week, month and shift views);
  - transactions with a "Needs review" list;
  - customers, with a full delete on request;
  - tables and QR printing, staff and PINs (6-digit banner), devices (with PIN lockout alerts);
  - settings, reports;
  - backup and importer for the old apps' data.
- **QR page:**
  - nickname sign-in with "Welcome back";
  - reconnect by phone number;
  - clear ticket wording;
  - limits against floods.
- **Server security:**
  - refund limits;
  - finished sales locked;
  - an audit log nobody can edit or delete;
  - shops kept apart;
  - hidden customer phone numbers on counters;
  - 14 review findings fixed, plus 4 more from a second review.

## Still to do
1. CAPTCHA support in the apps. **Don't turn CAPTCHA on in Supabase until C says so.**
2. A last quick security check.
3. Go-live prep: archive the old pages, landing page, a pull request for me to merge.
4. I follow `docs/SETUP_GUIDE.md` (about 45 min).
5. Later:
   - drop the old `profiles.pin_hash` (script 005);
   - prototype walkthrough;
   - Senior/PWD button;
   - loyalty stamps rewards.

## To continue
Open the project in Claude and say **"Resume from docs/RESUME.md"**.

Related: [[CCCC Old Apps (archived 2026-10-19)/00 Start here|Old POS & Inventory apps archive]]
