# Release 1.4.1 (menu link, B10): database contract (`cccc/supabase/011_release_1_4_1.sql`)
From db-security-engineer's report, 2026-11-09 (incl. the owner's "highlighted item" addition the same day).
If the script and this file disagree, the script wins; tell the lead.
Everything is additive: the 1.4 apps keep working unchanged.

## 1. Settings (owner writes through `apply_changes`, like other settings)
New columns on `settings` (one row per shop). `bo_bootstrap().settings` includes them automatically.

| Column | Type / default | Rule (checked by the database on every save) | Error |
|---|---|---|---|
| `menu_public` | boolean, default `false` | Can't be `true` without a code | `MENU_CODE_NEEDED` |
| `public_code` | text, null | Trimmed + lower-cased; `^[a-z0-9][a-z0-9-]{0,28}[a-z0-9]$` (2–30, no `-` at the ends); unique across shops | `BAD_PUBLIC_CODE`, `PUBLIC_CODE_TAKEN` |
| `public_address` | text, null | ≤ 200 chars, line breaks OK, no other control chars | `BAD_PUBLIC_ADDRESS` |
| `public_hours` | text, null | ≤ 300 chars, same | `BAD_PUBLIC_HOURS` |
| `public_map_url` | text, null | `https://` only, ≤ 500, no spaces / quotes / `<>` / backslash / backtick, plain host | `BAD_MAP_URL` |
| `public_facebook_url` | text, null | As above + host is `facebook.com`, `www.`/`m.`/`web.facebook.com`, `fb.com`, `www.fb.com` or `fb.me` | `BAD_FACEBOOK_URL` |
| `public_instagram_url` | text, null | As above + host is `instagram.com` or `www.instagram.com` | `BAD_INSTAGRAM_URL` |
| `menu_highlight_recipe_id` | uuid, null (FK → recipes, cleared when the item is deleted) | Must be this shop's item (else `FORBIDDEN_ROW` from apply_changes or `BAD_HIGHLIGHT`); when newly picked it must also be active, on the counter, on QR and priced > 0 | `BAD_HIGHLIGHT` |
| `menu_highlight_label` | text, null | Control chars / line breaks → spaces, trimmed; ≤ 30. Empty = default "Today's pick" | `BAD_HIGHLIGHT_LABEL` |
| `menu_highlight_blurb` | text, null | Same cleaning; ≤ 140 | `BAD_HIGHLIGHT_BLURB` |

- Empty strings are saved as null for all text fields.
- The whole save is refused on an error (`apply_changes` is all-or-nothing); show `friendlyError` text.
- Install: the oldest shop (live: Cavite City Coffee Club) gets `public_code = 'cccc'` when no shop has a code yet. The link stays **off**.
- A highlighted item that is later hidden or deactivated does not block settings saves; the link simply shows no highlight.

## 2. `public_menu(p_shop text) → jsonb`
- Callable by `anon` and `authenticated` (no sign-in needed). Read-only, `STABLE`, `SECURITY DEFINER`, `search_path = public`.
- `p_shop` is the code (case and spaces at the ends are ignored).
- Unknown code, bad input, or the link switched off → exactly `{"error":"NOT_FOUND"}` (same answer for all).
- Success:

```jsonc
{
  "shop":  {"code": "cccc", "name": "Cavite City Coffee Club", "logo_url": "https://…" | null},
  "theme": {"primary_color", "secondary_color", "accent_color", "background_color", "card_color", "text_color", "theme": "CCCC"|"CUSTOM"},
  "visit": {"address": text|null, "hours": text|null, "map_url": url|null, "facebook_url": url|null, "instagram_url": url|null},
  "pricing": {"tax_pct": 0, "service_charge_pct": 10, "tax_inclusive": false},
  "subcategory_order": ["Iced coffee", …],            // owner's order; names not in it go after (shared sorting helper)
  "subcategory_colors": {"Iced coffee": "<colour key>", …},
  "highlight": null | {
      "item_index": 1,                                // position in items[] (0-based)
      "name": "Croissant", "image_url": url|null, "price": 95, "sold_out": false,
      "label": "Today's pick", "blurb": text|null
  },
  "items": [ {
      "name": "Iced Latte",
      "recipe_type": "DRINKS"|"PASTRY"|"FOOD"|"SAUCES_SYRUPS",
      "subcategory": "Iced"|null,                    // the item's own sub-category
      "category": "Iced",                            // sub-category, or the type's label when none (as QR)
      "description": text|null,                      // ≤ 300 chars
      "image_url": url|null,
      "price": 150,                                  // base selling price, from the database
      "sold_out": false,
      "options": [ {"name": "Size", "required": true, "multi": false,
                    "options": [ {"label": "16oz", "price_delta": 20, "kind": "PLAIN"|"EXTRA"|"SWAP"} ]} ]
  } ]
}
```

- **Items** = the QR menu's items (active, on the counter AND on QR, price > 0), in the QR order (item sort order, then name), at most 300. Listed even when no counter has an open shift (no open/closed on this page).
- **`sold_out`** = the opposite of the QR menu's `available`: marked sold out at the counter, or (only when the QR setting "hide items we can't make" is on) not enough stock for one. There is no separate "can't make" flag (the QR menu doesn't expose one either). Note: the server doesn't reset `recipes.sold_out` at midnight; it is whatever the counter marked.
- **Highlight**: null when unset, or when the item isn't one of `items` (hidden, inactive, deleted, beyond 300). A sold-out highlight is still returned with `sold_out: true` (show it greyed).
- **Never in the answer:** ids (no uuid anywhere), ingredients, extras/removes/swaps, stock amounts, costs, recipes, staff, customers, orders, table tokens.
- **Size bounds:** 300 items; 15 option groups per item and 30 options per group (empty groups dropped); names/labels cut to 80/60; photo and logo URLs only when `http(s)://`, ≤ 1000 chars and free of quotes/brackets/spaces (old `data:` pictures are left out → `null`).
- All text is the owner's text: the page must still escape everything (`esc`) and only put `*_url` values into `href`/`src` attributes (never into `style` / `url()` without escaping).

## 3. Abuse / caching choice
No rate limit: a read-only `STABLE` function can't count calls (counting needs writes). Instead each call is cheap and bounded: one look-up of the shop by its (uniquely indexed) code, at most 300 items of that one shop (new index `recipes_business_idx`), and stock sums only when the owner turned on "hide items we can't make" (same helper as QR). Supabase's own time limit for anonymous requests (a few seconds) stops anything slow. The page should not poll; load once per open.

## 4. Apps
- **Menu page (`cccc/menu/`):** call `rpc('public_menu', {p_shop})` with the anon key (no session). Use `highlight.item_index` to link to the item card.
- **Back Office Settings → Menu link:** write the columns above with `Ops.update('settings', {...})`; map the error codes in section 1 to plain words. The highlight picker should list items that are active, on the counter, on QR and priced.
- **Short link** (`/menu/?shop=<code>` → `cccc/menu/?shop=<code>`): codes are `[a-z0-9-]` only, safe in a URL.
