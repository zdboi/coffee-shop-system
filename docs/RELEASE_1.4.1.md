# Release 1.4.1: what to do

A small update that adds a **shareable menu link**. It takes about 15 minutes. Any quiet time is fine; counters don't need to stop selling.

Your current live version (1.4) is saved as the **last working version** (`docs/checkpoints.md`). If anything goes wrong, tell C: **"Go back to the last working version."**

## What's new
- **A menu link for social media:** `https://zdboi.github.io/coffee-shop-system/menu/`.
  - Anyone can open it on their phone. There is no sign-in and no ordering.
  - It shows your live menu, using your sub-category order: photos, prices and option prices.
  - Sold-out items show greyed with "Sold out today".
  - A **Visit us** box shows your address, hours, map, Facebook and Instagram.
  - When you paste the link in Messenger or Facebook, it shows your preview card: the shop name and "Ano ang kape mo today?".
- **Highlighted item:** pick one item, such as a new drink or a seasonal special. It appears as a big "Today's pick" card at the top of the menu link.
- **Back Office → Settings → Menu link:** the on/off switch, your link with **Copy link** and **Open**, the Visit us details, and the highlighted item.
- **Faster QR order page:** the menu loads quicker once you have a long sales history.
- **Extra safety lock:** the public key the apps use can no longer read your tables directly. The apps never needed this access.

## Steps

### 1. Download a backup (2 min)
Back Office → **Backup & import** → **Download a backup**. Keep the file.

### 2. Run the database script 011 (3 min)
1. On GitHub, open `cccc/supabase/011_release_1_4_1.sql` on the branch `wip/cccc-online-qr`.
2. Click **Raw**, select everything (Ctrl+A) and copy it (Ctrl+C).
3. On supabase.com, open your project and go to **SQL Editor** → **New query**.
4. Paste the script and click **Run**.
5. Wait for **Success. No rows returned**.
   - If you see a red error, don't run it again. Copy the message and send it to C.

### 3. Publish the apps (2 min)
**Do this right after step 2.**
1. Open the pull request link C sends you.
2. Click **Merge pull request**, then **Confirm merge**.
3. Wait about 2 minutes for the site to update.

### 4. Reload (1 min per device)
On each counter, your computer and your phone, open the app and reload the page twice.

### 5. Set up your menu link (5 min)
1. Back Office → **Settings** → **Menu link**.
2. Fill in **Visit us**:
   - **Address:** tap **Use my receipt address**, or type it.
   - **Opening hours:** for example "Mon–Sat 7 AM – 9 PM".
   - **Google Maps link:** open your shop in Google Maps, tap **Share**, then **Copy link**, and paste it here.
   - **Facebook and Instagram links:** paste the link to your page.
3. **Highlighted item** (optional): search for an item and pick it. You can change the label (for example "New!" or "Bestseller") and add one short line.
4. Turn on **Share my menu with a public link**.
5. Click **Save menu link**.
6. Click **Open** to check the page on your phone. Then **Copy link** and paste it wherever customers ask.

### 6. Quick check (2 min)
1. Paste the link into a Messenger chat with yourself. You should see the preview card.
2. On the counter, mark one item as sold out. Reload the menu link: that item now shows "Sold out today".
3. Mark the item available again.

## Good to know
- **"Sold out today" comes from the counter's sold-out switch.** It doesn't clear by itself overnight. Switch items back on when they're available again, the same as for the QR page.
- **To hide the menu link,** switch it off in Settings → Menu link and save. The link then shows "This menu isn't available right now."
- **Your shop code** is `cccc`. Only change it if you must, because old links stop working.

## If something goes wrong
Tell C what you see (a photo of the screen helps). To undo the apps, tell C: **"Go back to the last working version."**
