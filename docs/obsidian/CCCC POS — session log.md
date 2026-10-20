---
tags: [cccc, pos, session-log]
project: Cavite City Coffee Club POS
updated: 2026-10-20
checkpoint: 6
repo: zdboi/coffee-shop-system (branch wip/cccc-online-qr)
---

# CCCC POS: session log

The new Cavite City Coffee Club system, built with C (Claude, lead developer) and the agent team.
It has three apps on one Supabase database:
- **Counter:** staff sign in with a PIN; it keeps selling when offline.
- **Back Office:** the owner's email login only.
- **QR order page:** customers order from their phones and pay at the counter.

## Where things stand (Oct 20): ready for go-live 🎉
- **Checkpoint 6.** Everything is saved on GitHub.
- **Pull request #1** is waiting for me: https://github.com/zdboi/coffee-shop-system/pull/1. Merge it **only after** Parts 1–3 of the setup guide.
- 3,238 automatic tests, all passing.
- The final security review says ready for go-live.
- The live shop and live Supabase haven't been touched yet.
- **Next:** I follow `docs/SETUP_GUIDE.md` (about 45 min), with C on standby.

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
