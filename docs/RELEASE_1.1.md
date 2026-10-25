# Release 1.1 (batch 1): what to do

This update takes about 15 minutes. You can do it any time the shop is quiet.
Your current live version is saved as the **last working version** (see `docs/checkpoints.md`).
If anything goes wrong, tell C: **"Go back to the last working version."**

## What's new
- **Counter:** the Back Office button is at the bottom of the side menu. The failed-uploads list uses plain words. On narrow screens, your name and the Lock button fit.
- **Units everywhere:** recipes, add-on extras, waste, stock adjustments and counts, starting stock and production accept g/kg or mL/L. Everything converts automatically. A number you type keeps its value when you change the unit, and a "saved as …" line shows exactly what will be saved.
- **Category manager:** Ingredients → **Manage categories**, where you can add, rename and remove categories, plus a one-click **Add "Raw materials"**.
- **Excel:** Recipes & menu → **Import from Excel** / **Export to Excel**.
  - Nothing is saved until you press Import in the preview.
  - Imported menu items start **hidden** from the counter and QR menu until you switch them on.
- **Remove several recipes:** tick them on Recipes & menu, then press **Remove selected**. Recipes with sales history are hidden instead of deleted.
- **Fixes:** a ₱0 pay-in or pay-out is refused by the server too, and the old-backup import skips ₱0 cash lines instead of stopping.

## Steps

### 1. Download a backup (2 min)
Back Office → **Backup & import** → **Download a backup**. Keep the file.

### 2. Quick check for old broken cash lines (2 min, changes nothing)
1. Go to supabase.com and open your project.
2. In the left menu, click **SQL Editor** → **New query**.
3. Paste this and click **Run**:
   ```sql
   select id, shift_id, amount from cash_movements where amount is null or amount = 'NaN';
   ```
4. Tell C what it says. "Success. No rows returned" is the good answer.

### 3. Run the database script 007 (3 min)
1. On GitHub, open `cccc/supabase/007_batch1.sql` on the branch `wip/cccc-online-qr`. Click **Raw**, select everything (Ctrl+A) and copy (Ctrl+C).
2. In Supabase, click **SQL Editor** → **New query**, paste it and click **Run**.
3. Wait for **Success. No rows returned**.
   - If you see a red error, don't run it again: copy the message and send it to C.

### 4. Publish the apps (2 min)
1. Open the pull request link C sends you.
2. Click **Merge pull request**, then **Confirm merge**.
3. Wait about 2 minutes for the site to update.

### 5. Load the new version (1 min per device)
On each counter and on your computer, open the app and reload the page twice. First let any waiting sales upload: the sync pill must say "all saved". After the reload, the Back Office button should sit at the bottom of the counter menu.

### 6. Try it
1. Ingredients → **Manage categories** → **Add "Raw materials"**.
2. Recipes & menu → **Import from Excel**: pick your costing files and look at the preview.
   - Check each sheet's type (menu item, batch, house-made, skip).
   - Check the units of new ingredients (g / mL / pcs).
   - Check the flagged prices, e.g. "sprite" is a 12-can pack in one sheet and 2000 mL in another.
   - Then press **Import**.
3. Open an imported recipe and set its price if needed. Then tick **Show on the counter** / **Show on the QR menu**.
