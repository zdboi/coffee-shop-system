# Release 1.6.1: profit split

A small update: it takes about 5 minutes. You can do it any time, the counters aren't affected.

Your current live version (1.6) is saved as the **last working version** (`docs/checkpoints.md`). If anything goes wrong, tell C: **"Go back to the last working version."**

> Status: **ready** (Z: PASS on 2026-11-13, 6,875 checks, none failing).

## What's new
Back Office → **Money → Investors & start-up** → **Profit split** (replaces "Share of net income"):
- Net income for any dates, shared the way you set: **investors 30%** (by the amounts each one invested), **managers 20%** (equally among the managers you name), **the shop 50%**.
- A table per person: their part as investor, as manager, and the total. Jake and you get both parts.
- **Change the split**: the three percentages (must add up to 100%) and the managers' names. Saved in the audit log.
- For information only: nothing is paid out by this page.

Back Office → **Sales calendar**: the month calendar is full width at the top, with bigger day boxes so the amounts fit. The cards and the day-by-day table are below it.

## Steps
1. In Supabase (business account): **SQL Editor → New query**, paste the whole of `014_release_1_6_1.sql`, **Run**, wait for **Success**.
2. Merge the pull request C sends you. Wait about 2 minutes, then reload the Back Office.
3. Back Office → **Money → Investors & start-up** → **Change the split**. Under Managers type **Jake** and **your name, spelled exactly as in the investor list** (for example "Zed"), one per line. Check 30 / 20 / 50 and save.
