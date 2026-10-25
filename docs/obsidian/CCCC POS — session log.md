---
tags: [cccc, pos, session-log]
project: Cavite City Coffee Club POS
updated: 2026-10-26
checkpoint: 8
repo: zdboi/coffee-shop-system (branch wip/cccc-online-qr)
---

# CCCC POS: session log

The new Cavite City Coffee Club system, built with C (Claude, lead developer) and the agent team.
It has three apps on one Supabase database:
- **Counter:** staff sign in with a PIN; it keeps selling when offline.
- **Back Office:** the owner's email login only.
- **QR order page:** customers order from their phones and pay at the counter.

## Where things stand (Oct 26): release 1.1 ready for me
- **Batch 1 is built, tested (3,716 checks) and security-reviewed.** To publish it, I follow `docs/RELEASE_1.1.md` (about 15 min):
  1. download a backup;
  2. run a quick read-only check;
  3. run database script 007;
  4. merge the pull request;
  5. reload the counters.
- **What's in it:**
  - Back Office button at the bottom of the counter menu;
  - g/kg and mL/L work everywhere and convert automatically;
  - **Manage categories** (plus Raw materials);
  - **Import from / Export to Excel** for recipes (imported items start hidden);
  - tick-and-remove recipes;
  - ₱0 pay-in/out refused.
- My live version from Oct 20 is saved as the **last working version**. If 1.1 goes wrong: "Go back to the last working version".

## Earlier (Oct 20): LIVE 🎉
- **Checkpoint 7.** The new apps are live at https://zdboi.github.io/coffee-shop-system/
- I ran database scripts 004, 005 and 006 in Supabase.
  - 005 fixed counter pairing.
  - 006 fixed counter uploads. Both were rules left over from the old Lovable database.
- I signed in to the Back Office and set my shop details and 6-digit PIN.
- I paired my PC as a test counter, and test sales uploaded.
- **My to-dos:**
  - add the menu and shop data;
  - void the test sales;
  - remove the test PC when the real tablet is paired;
  - try one QR order with my phone.

## My decisions
| Date | Decision |
|---|---|
| Oct 12 | Build C chosen; Build R archived |
| Oct 12 | Partial refund = what the customer actually paid for those items |
| Oct 12 | Refund limits apply to everyone, including my own Back Office login |
| Oct 12 | A signed-in manager can approve their **own** actions offline |
| Oct 12 | Senior/PWD 20% discount button: **later** |
| Oct 19 | Manager and owner PINs are **6 digits** (cashiers 4–6) |
| Oct 19 | A manager with an old short PIN can still sell but **can't approve** until changed |
| Oct 19 | Old POS / Inventory / test pages come **off the live site** at go-live |
| Oct 19 | Test the apps first, prototype walkthrough later |
| Oct 19 | CAPTCHA: built in, but **go live with it off**; turn it on later only if fake orders appear |
| Oct 25 | C must check whether a request already exists and ask me before building a repeat |
| Oct 25 | Developer changelog: **Obsidian only**, never on GitHub; it's also C's feature list |
| Oct 25 | Always save the last working version before an update; use savepoints for debugging/A-B only when necessary |
| Oct 25 | Units: use any unit, the system converts; category manager yes; Excel import/export buttons yes; tick-and-remove recipes yes |
| Oct 26 | (C) Imported recipes start hidden until I switch them on; a typed number keeps its value when I change the unit |

## What got built and fixed
- **Counter:**
  - pairing code only;
  - manager approvals checked by the server;
  - offline selling with upload later;
  - pro-rated refunds;
  - customer consent tick;
  - offline PIN lockout;
  - stops a QR order being paid twice;
  - uploads waiting work before a new person signs in;
  - short-PIN managers can't approve.
- **Back Office:**
  - all the old inventory screens, plus a sales calendar, reports and transactions with "Needs review";
  - customers, with a full delete on request;
  - tables and QR printing, staff and PINs (6-digit banner), devices (lockout alerts);
  - settings;
  - backup and importer for the old apps' data.
- **QR page:** nickname sign-in with "Welcome back", reconnect by phone, clear ticket wording, limits against floods.
- **Server security:**
  - refund limits;
  - finished sales locked;
  - an audit log nobody can edit or delete;
  - shops kept apart;
  - hidden customer phone numbers;
  - customer erasure in one step;
  - every review finding fixed.
- **Optional CAPTCHA** (Cloudflare) is ready but switched off.

## After go-live
- A small cleanup script (005) once the old apps are fully retired.
- Later: prototype walkthrough, Senior/PWD button, loyalty stamps rewards.

## To continue
Open the project in Claude and say **"Resume from docs/RESUME.md"**.
