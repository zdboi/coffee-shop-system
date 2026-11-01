# Release 1.2: what to do

This update takes about 20 minutes. Do it when the shop is quiet (ideally after closing) and every counter has uploaded its sales.
Your current live version (1.1) is saved as the **last working version** (see `docs/checkpoints.md`).
If anything goes wrong, tell C: **"Go back to the last working version."**

## What's new
- **New look in all three apps:** your logo colours, Brunson titles, the Cavite City Coffee Club wordmark, line icons, and bigger buttons on the counter.
- **Counter:**
  - **Sell is now Orders.** "All" groups the menu under sub-category headings, and tiles are coloured per sub-category.
  - **Customers tab:** search by nickname, see visits, the stamp card, favourite orders and recent orders.
    - Only a manager or owner who is signed in sees money (total spent, order totals).
    - Phone numbers stay hidden (0917 ••• 4567).
  - **Stamp rewards at checkout:** tap a ready reward (₱10 off, ₱50 off, or a free drink or food). A fully free order completes with "nothing to pay".
  - **QR orders floor plan:** your tables drawn as in the shop. Terracotta means waiting for payment, butter means being made. Tap a table to see its order.
  - Calmer pop-up messages (at most two at a time).
- **Back Office:**
  - **Floor plan editor** (Tables & QR codes): add square, round and long tables, plus the counter, walls, doors, plants and labels. Drag, resize and turn them, then **Save layout**.
  - **Sub-category colours** (Recipes & menu): pick a colour for each sub-category's counter tiles.
  - **Ingredient brands** (Laciate / Arla, Bunge / Monna Lisa, Bensdorp / JB15…):
    - Each purchase records its brand.
    - The app tracks stock per brand, oldest stock used first, and shows **"In use now"**. Recipe costs follow the brand in use.
    - Stock screens refresh when you open them, and have a Refresh button.
  - **Stamp card settings** (Settings → Loyalty): one card of 15 stamps. Customers get one stamp for a drink and one for food each day (2 a day at most). Rewards: ₱10 off at 5, ₱50 off at 10, and a free drink or food at 15.
  - **Loyalty rewards** appear as their own line in sales reports and shift reports.
  - Theme: "Cavite City Coffee Club" (the new look) or "Custom colours". Dark mode is gone.
- **QR page:** the new look and the 15-stamp card.
- **Safety:**
  - Stamps only come from real paid sales: no ₱0, below-menu, unpaid or back-dated tricks.
  - Rewards are checked by the server and can only be used once.
  - Counters can no longer read the table QR codes.

**Good to know:** visits now count *days* with a paid order, not separate sales. Stamps and visits are recalculated from your past sales when you run the script, so existing customers may show different numbers.

## Steps

### 1. Let every counter finish uploading (1 min)
On each counter, check the upload status says **"all saved"**. Close the shift if you normally do.

### 2. Download a backup (2 min)
Back Office → **Backup & import** → **Download a backup**. Keep the file.

### 3. Run the database script 008 (3 min)
1. On GitHub, open `cccc/supabase/008_release_1_2.sql` on the branch `wip/cccc-online-qr`. Click **Raw**, select everything (Ctrl+A) and copy (Ctrl+C).
2. Go to supabase.com and open your project. Click **SQL Editor** → **New query**, paste it and click **Run**.
3. Wait for **Success. No rows returned**.
   - If you see a red error, don't run it again: copy the message and send it to C.

### 4. Publish the apps (2 min)
**Do this right after step 3.** The old Back Office keeps working with the new database, but publish soon anyway.
1. Open the pull request link C sends you.
2. Click **Merge pull request**, then **Confirm merge**.
3. Wait about 2 minutes for the site to update.

### 5. Load the new version (1 min per device)
On each counter, your computer and your phone, open the app and reload the page twice. You should see the new colours and the wordmark in the side menu.

### 6. Set it up (10 min)
1. **Loyalty:** Back Office → Settings → **Loyalty**. Switch stamps on and check the three rewards.
2. **Floor plan:** Tables & QR codes → **Floor plan**. Add your tables and the counter, arrange them like the shop, then **Save layout**.
3. **Tile colours:** Recipes & menu → **Sub-category colours**. Pick a colour per sub-category.
4. **Brands:** open an ingredient (e.g. coffee milk) → **Brands** → add Laciate and Arla. From now on, pick the brand when you record a purchase.
5. On a counter, open **Orders** and **QR orders → Floor plan** to check everything looks right.
