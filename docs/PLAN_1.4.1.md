# Release 1.4.1: public menu link (B10)

Owner: "build it" (2026-11-09 19:19). Decisions: `docs/owner-feedback.md` B10. Live = 1.4 (651e706). DB script: `011_release_1_4_1.sql`.

## What
- A **view-only menu page** anyone can open from a link: no ordering, no sign-in, no customer data.
  - It shows prices (with option prices), photos, sub-categories in the shop's order, and sold-out items greyed as "Sold out today".
  - It also shows a **Visit us** box: address, hours, map link, Facebook and Instagram.
  - It follows the live menu: Back Office edits and sold-out marks.
- **Design:** the owner-approved mock in `docs/design/menu-link-mock.dc.html` (phone layout).
- **Link preview image:** `cccc/shared/brand/menu-link-preview.png` (1200×630), the owner's version: name + "Ano ang kape mo today?".

## Highlighted product (owner, 19:23)
One item the owner picks, with an optional label (default "Today's pick") and blurb, shown as a large card at the top of the menu page. If it is sold out, it is shown greyed.

## Pieces
1. **DB (db-security-engineer), `011`:**
   - `public_menu(p_shop text)`, callable by `anon`. It returns display data only: shop name and logo; menu items shown on QR (name, photo URL, price, sub-category, type, sold out); option groups with labels and price deltas, without stock data, ingredient ids, costs or recipes; the sub-category order and colours; and the public "Visit us" fields.
   - New settings: `menu_public` (on/off, default off), `public_address`, `public_hours`, `public_map_url`, `public_facebook_url`, `public_instagram_url`, and a short public shop code (slug).
   - Nothing is returned for a shop with the menu switched off.
   - Light caching or rate-limiting if needed.
2. **Menu page (customer-qr-dev):**
   - `cccc/menu/` (index.html, menu.js, menu.css), using the shared `cloud.js` / `ui.js` / tokens and the Brunson font.
   - Fast on mobile data; all text escaped; works with no photos.
   - Refreshes when reopened.
3. **Back Office (back-office-dev):** Settings → **Menu link**: the on/off switch, the shop code, the public fields, a **Copy link** button, an **Open** button and a preview of the link card.
4. **Short link + social preview (lead):**
   - `/menu/index.html` at the site root holds the Open Graph tags (title, description, `menu-link-preview.png`) and sends visitors on to `cccc/menu/?shop=<code>`.
   - Social sites read those tags without running scripts.
5. **QA:** a new suite plus the full regression. **Security:** review of the anon RPC and the page.
