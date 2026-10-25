# Checkpoints (save points)

A checkpoint is a saved copy of the whole project at a moment when it was in a good state.
If something later goes wrong, we can go back to any of them. Nothing is ever deleted:
GitHub keeps every saved step, so going back is always possible.

New checkpoints are added at the end of every stage.

## Last working version (always kept)
Before any update goes live, the version that is live and working right now is saved here first.
If an update goes wrong, tell C: **"Go back to the last working version."**

| Apps | Live since | Browse | Download |
|---|---|---|---|
| Counter, Back Office, QR page (all apps) | 2026-10-20 (pull request #1) | [a53238e](https://github.com/zdboi/coffee-shop-system/tree/a53238e77f374c38c4f730101b84f5a5898ee00f) | [ZIP](https://github.com/zdboi/coffee-shop-system/archive/a53238e77f374c38c4f730101b84f5a5898ee00f.zip) |

Older working versions stay in the table below, so you can go back further if needed.

| # | Name | When (Manila) | What it contains |
|---|---|---|---|
| 0 | **Original files** | 2026-09-17 | Your files as you uploaded them, before the CCCC rebuild (old Inventory and POS apps). |
| 1 | **Build C chosen** | 2026-10-12 02:13 | Build C picked as the base; Build R kept in `_archive/`; the security rules written down. |
| 2 | **Server security** | 2026-10-12 07:50 | Database script with manager approvals checked by the server, refund limits, hidden customer phone numbers, PIN lockout, sale total checks. |
| 3 | **Back Office built** | 2026-10-12 09:01 | The full Back Office, counter approvals with manager PINs, QR page fixes. |
| 4 | **Fix round 2 (resume point)** | 2026-10-13 | All 6 bugs from testing fixed; your refund and offline-approval decisions built in. Re-testing still to do — see `docs/RESUME.md`. |
| 5 | **Security round done** | 2026-10-19 | All 14 security findings fixed; 6-digit manager PINs; audit log add-only; full customer erasure; 3,054 tests. Setup guide written. |
| 6 | **Ready for go-live** | 2026-10-20 | Optional CAPTCHA built (off); final security verdict "ready"; 3,238 tests pass; old pages archived; pull request #1 open for you. |
| 7 | **Live** | 2026-10-20 | New apps live on your site; database scripts 004–006 run; counter tested and uploading. |

## Look at or download a checkpoint

Each link opens the project exactly as it was at that checkpoint. The ZIP link downloads it.

| # | Browse on GitHub | Download |
|---|---|---|
| 0 | [Original files](https://github.com/zdboi/coffee-shop-system/tree/e417ddead662fc294ae7da6ed884496bc329c719) | [ZIP](https://github.com/zdboi/coffee-shop-system/archive/e417ddead662fc294ae7da6ed884496bc329c719.zip) |
| 1 | [Build C chosen](https://github.com/zdboi/coffee-shop-system/tree/2cd06e1cc17f3cf98c684787200c6e85bc1812f9) | [ZIP](https://github.com/zdboi/coffee-shop-system/archive/2cd06e1cc17f3cf98c684787200c6e85bc1812f9.zip) |
| 2 | [Server security](https://github.com/zdboi/coffee-shop-system/tree/33be67bad511329a23048b545b83644c097ea964) | [ZIP](https://github.com/zdboi/coffee-shop-system/archive/33be67bad511329a23048b545b83644c097ea964.zip) |
| 3 | [Back Office built](https://github.com/zdboi/coffee-shop-system/tree/1944accae41d4d9dd6b4d93db97a876be36a7ebb) | [ZIP](https://github.com/zdboi/coffee-shop-system/archive/1944accae41d4d9dd6b4d93db97a876be36a7ebb.zip) |
| 4 | [Fix round 2](https://github.com/zdboi/coffee-shop-system/tree/4fc56e17bea891ea0dfce8292ded9d75783ca1ac) | [ZIP](https://github.com/zdboi/coffee-shop-system/archive/4fc56e17bea891ea0dfce8292ded9d75783ca1ac.zip) |
| 5 | [Security round done](https://github.com/zdboi/coffee-shop-system/tree/69df9a838dd3fd41752ac02d932a073c58f23569) | [ZIP](https://github.com/zdboi/coffee-shop-system/archive/69df9a838dd3fd41752ac02d932a073c58f23569.zip) |
| 6 | [Ready for go-live](https://github.com/zdboi/coffee-shop-system/tree/9705cb9e6b72b1a6dd2759282ff460d88334b664) | [ZIP](https://github.com/zdboi/coffee-shop-system/archive/9705cb9e6b72b1a6dd2759282ff460d88334b664.zip) |
| 7 | [Live](https://github.com/zdboi/coffee-shop-system/tree/8082d3194798270e42c1c9dde1bee1b01eabbc4a) | [ZIP](https://github.com/zdboi/coffee-shop-system/archive/8082d3194798270e42c1c9dde1bee1b01eabbc4a.zip) |

## Go back to a checkpoint

Tell C: **"Go back to checkpoint 2"** (or whichever number). C restores the files from that
checkpoint as a new saved step, so the newer work stays in the history and you can change
your mind again later.

## Optional: name the checkpoints on GitHub yourself (about 1 minute each)

C's GitHub access can only save to the work branch, so it cannot add named labels ("tags")
on GitHub. If you want them to show under **Releases / Tags** on GitHub:

1. Open https://github.com/zdboi/coffee-shop-system and click **Releases** (right side), then **Draft a new release**.
2. Click **Choose a tag**, type a name such as `cp-03-back-office`, and click **Create new tag**.
3. Click **Target**, then **Recent commits**, and pick the commit whose first 7 letters match the table above (for checkpoint 3: `1944acc`).
4. Give it a title (e.g. "Checkpoint 3: Back Office built") and click **Publish release**.

## Your data is separate from these checkpoints

Checkpoints save the **program**, not your shop's data (sales, stock, customers).
Your data lives in Supabase. Before you run any database script (the `.sql` files):

1. In the Back Office, open **Backup & import** and click **Download a backup**. Keep the file.
2. Then run the script.

Database scripts that have already been run are never edited; changes go into a new
numbered script instead. So going back to an older program checkpoint never needs your
database to be undone.
