# CCCC design (release 1.2)

- **Colours and sizes:** `cccc/shared/brand/tokens.css`. Every app loads it first, and screens use its variables, never raw colour codes.
- **Mock:** `mock-1.2.html` (screenshots in `shots/`). It shows four screens: counter Orders, the QR orders floor plan, counter Customers, and the customer's phone.
- **Logo:** web-size images in `cccc/shared/brand/`, made from the 2026-10-29 logo prototype. The prototype's SVGs are not used, because they contain the font files.
- **Brunson font:** used for headings only, through one `@font-face` in `tokens.css`.
  - The font says "© The Branded Quotes 2025. All Rights Reserved" (thebrandedquotes.sellfy.store), and no licence file came with it. The owner must confirm the purchase allows website use.
  - To stop using it, delete `brunson.woff` and its `@font-face` block. Headings then fall back to Arial Narrow / Impact.
  - It has no ₱ sign; the body font fills that in.
- **Body text:** each device's own system font (Segoe UI, Roboto, San Francisco). Nothing to download, so it's fast on mobile data and works offline.
- **Rules:**
  - every text colour pair is at least 4.5:1;
  - olive-gold `#9E8B57` is for decoration only;
  - counter tap targets are at least 48 px;
  - line icons are inline SVG, never emoji;
  - focus rings stay visible;
  - motion is off when "reduce motion" is set.
- **Sub-category tile colours:** the database stores a key (`terracotta`, `deep_terracotta`, `olive`, `gold`, `butter`, `ink`, `sage`, `clay`, `cocoa`, `sky`), and `tokens.css` maps each key to a background and text pair that passes contrast.
