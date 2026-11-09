-- =============================================================================
-- Cavite City Coffee Club — 011: release 1.4.1 ("Menu link", owner feedback B10)
-- -----------------------------------------------------------------------------
-- HOW TO RUN: Supabase → SQL Editor → New query → paste this WHOLE file → Run.
-- Run it AFTER 004 … 010 (all already done). It is safe to run more than
-- once. It runs inside one transaction: if anything fails, nothing is changed.
--
-- What it adds, in plain words:
--   1. SETTINGS for the public menu link (the owner fills them in the Back
--      Office, Settings → Menu link):
--        menu_public           on / off switch (starts OFF: nothing is shown
--                              to the public until the owner turns it on)
--        public_code           the shop's short code in the link, e.g. "cccc"
--                              (lower-case letters, digits and "-", 2..30)
--        public_address, public_hours, public_map_url,
--        public_facebook_url, public_instagram_url   the "Visit us" box
--      The database checks every value itself (links must be https, sizes
--      are limited), so no screen can save something broken.
--   2. public_menu(code): the view-only menu for the link. Anyone may call it,
--      without signing in. It returns DISPLAY data only: shop name, logo and
--      colours, sub-category order and colours, the items shown on the QR
--      menu (name, type, sub-category, description, photo, price, sold out)
--      with their option names and option prices, and the "Visit us" fields.
--      Never: ids, ingredients, stock amounts, costs, recipes, staff,
--      customers or orders. A shop that is unknown OR has the link switched
--      off gets the same answer: {"error":"NOT_FOUND"}.
--
-- What it does NOT change: anything the 1.4 apps already use. Every change
-- is ADDED (new columns with safe defaults, a new function, a wider settings
-- check that only looks at the new columns). No live CHECK rule is changed;
-- the new columns have no live rule (they are new).
-- =============================================================================

begin;

-- =============================================================================
-- 1. NEW SETTINGS COLUMNS
-- =============================================================================
-- They live on "settings" (one row per shop), because the owner already
-- saves settings through apply_changes and the Back Office already loads the
-- whole settings row (bo_bootstrap). Everybody of the shop who can read
-- settings today (owner, counters) can read these too: they are public
-- information anyway. The public itself never reads the table (only through
-- public_menu below).
alter table public.settings add column if not exists menu_public boolean not null default false;
alter table public.settings add column if not exists public_code text;
alter table public.settings add column if not exists public_address text;
alter table public.settings add column if not exists public_hours text;
alter table public.settings add column if not exists public_map_url text;
alter table public.settings add column if not exists public_facebook_url text;
alter table public.settings add column if not exists public_instagram_url text;

-- No two shops may have the same code (empty codes are allowed for many shops).
-- This index also makes public_menu's look-up by code instant.
create unique index if not exists settings_public_code_key on public.settings(public_code) where public_code is not null;

-- public_menu lists one shop's menu items; this index finds them directly
-- instead of reading every shop's recipes.
create index if not exists recipes_business_idx on public.recipes(business_id);

-- =============================================================================
-- 2. CHECKING THE NEW SETTINGS (database-side, for every way of saving)
-- =============================================================================
-- A link the public may click: https only, at most 500 characters, no spaces
-- or characters that could break out of a page (quotes, < >, backslash,
-- backtick). p_hosts = the allowed web addresses (e.g. facebook.com); empty =
-- any address made of letters, digits, "." and "-".
-- Returns true when the link is fine (an empty link is fine too).
create or replace function public._valid_public_url(p_url text, p_hosts text[] default null) returns boolean
language sql immutable set search_path = public as $$
  select p_url is null or (
    length(p_url) <= 500
    and p_url ~ '^https://[^[:space:]"''<>\\`]+$'
    and (substring(p_url from '^https://([^/?#]+)') ~ '^[A-Za-z0-9.-]+$')
    and (p_hosts is null or lower(substring(p_url from '^https://([^/?#]+)')) = any(p_hosts))
  )
$$;

-- Plain text shown to the public (address, hours): at most p_max characters,
-- no invisible control characters (line breaks are allowed).
create or replace function public._valid_public_text(p_text text, p_max integer) returns boolean
language sql immutable set search_path = public as $$
  select p_text is null or (length(p_text) <= p_max and p_text !~ '[\x01-\x09\x0B-\x1F\x7F]')
$$;

-- The settings check: same as 009, plus the menu link fields (section 1).
-- Before checking, empty values become "not set" (null), spaces at the ends
-- are trimmed and the code is made lower-case ("CCCC " -> "cccc").
-- Error codes (shown by the Back Office in plain words):
--   BAD_PUBLIC_CODE      code isn't 2..30 of a-z, 0-9, "-" (no "-" at the ends)
--   PUBLIC_CODE_TAKEN    another shop already uses that code
--   MENU_CODE_NEEDED     the link can't be switched on without a code
--   BAD_PUBLIC_ADDRESS   address longer than 200 characters (or odd characters)
--   BAD_PUBLIC_HOURS     hours longer than 300 characters (or odd characters)
--   BAD_MAP_URL          map link isn't an https link
--   BAD_FACEBOOK_URL     not an https link to facebook.com / fb.com / fb.me
--   BAD_INSTAGRAM_URL    not an https link to instagram.com
create or replace function public._settings_check() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public._valid_subcategory_colors(new.subcategory_colors) then raise exception 'BAD_SUBCATEGORY_COLORS'; end if;
  if not public._valid_subcategory_order(new.subcategory_order) then raise exception 'BAD_SUBCATEGORY_ORDER'; end if;
  if not public._valid_loyalty_rewards(new.loyalty_rewards) then raise exception 'BAD_LOYALTY_REWARDS'; end if;
  -- An older Back Office still sends theme 'light' / 'dark' (dark mode is
  -- dropped in 1.2): keep the shop's current look instead of refusing the
  -- whole settings save. Any other unknown word is refused by settings_theme_check.
  if new.theme is null or new.theme in ('light', 'dark') then
    new.theme := case when tg_op = 'UPDATE' and old.theme in ('CCCC', 'CUSTOM') then old.theme else 'CCCC' end;
  end if;

  -- 011: the menu link fields
  new.menu_public := coalesce(new.menu_public, false);
  new.public_code := nullif(lower(btrim(new.public_code)), '');
  new.public_address := nullif(btrim(new.public_address), '');
  new.public_hours := nullif(btrim(new.public_hours), '');
  new.public_map_url := nullif(btrim(new.public_map_url), '');
  new.public_facebook_url := nullif(btrim(new.public_facebook_url), '');
  new.public_instagram_url := nullif(btrim(new.public_instagram_url), '');
  if new.public_code is not null and new.public_code !~ '^[a-z0-9][a-z0-9-]{0,28}[a-z0-9]$' then
    raise exception 'BAD_PUBLIC_CODE';
  end if;
  if new.public_code is not null and exists (select 1 from public.settings
       where public_code = new.public_code and business_id <> new.business_id) then
    raise exception 'PUBLIC_CODE_TAKEN';
  end if;
  if new.menu_public and new.public_code is null then raise exception 'MENU_CODE_NEEDED'; end if;
  if not public._valid_public_text(new.public_address, 200) then raise exception 'BAD_PUBLIC_ADDRESS'; end if;
  if not public._valid_public_text(new.public_hours, 300) then raise exception 'BAD_PUBLIC_HOURS'; end if;
  if not public._valid_public_url(new.public_map_url) then raise exception 'BAD_MAP_URL'; end if;
  if not public._valid_public_url(new.public_facebook_url,
       array['facebook.com','www.facebook.com','m.facebook.com','web.facebook.com','fb.com','www.fb.com','fb.me']) then
    raise exception 'BAD_FACEBOOK_URL';
  end if;
  if not public._valid_public_url(new.public_instagram_url, array['instagram.com','www.instagram.com']) then
    raise exception 'BAD_INSTAGRAM_URL';
  end if;
  return new;
end $$;
-- (the trigger settings_check from 008 already calls this function)

-- The first shop (the oldest one: Cavite City Coffee Club on the live
-- project) gets the code "cccc", but only when NO shop has a code yet, so
-- running this script again never changes a code the owner picked. The link
-- stays OFF until the owner switches it on.
update public.settings s set public_code = 'cccc'
where s.business_id = (select b.id from public.businesses b
                       join public.settings x on x.business_id = b.id
                       order by b.created_at nulls last, b.id limit 1)
  and not exists (select 1 from public.settings where public_code is not null);

-- =============================================================================
-- 3. THE PUBLIC MENU
-- =============================================================================
-- A link the page may show as a picture (photo, logo): http(s) only, at most
-- 1000 characters, no characters that could break out of a page. Anything
-- else (e.g. a very long "data:" picture from the old app) is left out, so
-- the answer stays small. (http is allowed for the local test set-up; on the
-- live project photos are https links to Supabase storage.)
create or replace function public._public_image_url(p_url text) returns text
language sql immutable set search_path = public as $$
  select case when length(p_url) <= 1000 and p_url ~ '^https?://[^[:space:]"''<>\\`()]+$' then p_url end
$$;

-- An item's options for the public: only what a customer reads on a menu.
--   [{name, required, multi, options:[{label, price_delta, kind}]}]
-- At most 15 groups per item and 30 options per group; groups with no
-- options are left out. Never ids, ingredients, extras, removes or swaps.
create or replace function public._public_menu_options(p_groups jsonb) returns jsonb
language sql immutable set search_path = public as $$
  select coalesce(jsonb_agg(x.grp order by x.gi), '[]'::jsonb)
  from (
    select g.gi, jsonb_build_object(
        'name', left(coalesce(g.v->>'name', ''), 60),
        'required', coalesce((g.v->>'required')::boolean, false),
        'multi', coalesce((g.v->>'multi_select')::boolean, false),
        'options', (select jsonb_agg(jsonb_build_object(
                        'label', left(coalesce(o.v->>'label', ''), 60),
                        'price_delta', round(coalesce(public._to_num(o.v->>'price_delta'), 0), 2),
                        'kind', case when o.v->>'kind' in ('PLAIN', 'EXTRA', 'SWAP') then o.v->>'kind' else 'PLAIN' end)
                      order by o.oi)
                    from jsonb_array_elements(case when jsonb_typeof(g.v->'options') = 'array' then g.v->'options' else '[]'::jsonb end)
                         with ordinality o(v, oi)
                    where o.oi <= 30 and jsonb_typeof(o.v) = 'object')) as grp
    from jsonb_array_elements(case when jsonb_typeof(p_groups) = 'array' then p_groups else '[]'::jsonb end)
         with ordinality g(v, gi)
    where g.gi <= 15 and jsonb_typeof(g.v) = 'object'
  ) x
  where jsonb_typeof(x.grp->'options') = 'array'
$$;

-- public_menu(code) -> the shop's view-only menu, or {"error":"NOT_FOUND"}.
-- Who may call it: anyone (no sign-in needed). See docs/handoff/contract-1.4.1.md
-- for the exact answer.
-- Which items: the same as the QR menu (active, shown on the counter AND on
-- QR, price above 0), in the same order (the item's sort order, then name),
-- at most 300. Unlike the QR menu, items are listed even when no counter has
-- an open shift (the owner doesn't want open / closed on this page).
-- "sold_out" = exactly the opposite of the QR menu's "available": marked sold
-- out at the counter, or (only when the owner turned on "hide items we can't
-- make" for QR) not enough stock to make one.
-- Why no rate limit: the function only reads (it can't count calls), it finds
-- the shop by an indexed code, reads at most 300 items of that one shop and
-- does no stock maths unless the owner turned that QR option on. Supabase also
-- stops any anonymous request that runs longer than a few seconds.
create or replace function public.public_menu(p_shop text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_code text; v_s public.settings%rowtype; v_name text; v_hide boolean;
begin
  -- 1. find the shop; a bad, unknown or switched-off code all get the same answer
  v_code := lower(btrim(coalesce(left(p_shop, 64), '')));
  if v_code !~ '^[a-z0-9][a-z0-9-]{0,28}[a-z0-9]$' then return jsonb_build_object('error', 'NOT_FOUND'); end if;
  select * into v_s from public.settings where public_code = v_code and menu_public;
  if not found then return jsonb_build_object('error', 'NOT_FOUND'); end if;
  select coalesce(nullif(btrim(v_s.business_name), ''), b.name) into v_name from public.businesses b where b.id = v_s.business_id;
  v_hide := coalesce(v_s.qr_hide_out_of_stock, false);

  -- 2. the answer (display data only)
  return jsonb_build_object(
    'shop', jsonb_build_object('code', v_s.public_code, 'name', left(v_name, 80),
                               'logo_url', public._public_image_url(v_s.logo_url)),
    'theme', jsonb_build_object('primary_color', v_s.primary_color, 'secondary_color', v_s.secondary_color,
      'accent_color', v_s.accent_color, 'background_color', v_s.background_color, 'card_color', v_s.card_color,
      'text_color', v_s.text_color, 'theme', coalesce(v_s.theme, 'CCCC')),
    'visit', jsonb_build_object('address', v_s.public_address, 'hours', v_s.public_hours,
      'map_url', v_s.public_map_url, 'facebook_url', v_s.public_facebook_url,
      'instagram_url', v_s.public_instagram_url),
    'pricing', jsonb_build_object('tax_pct', coalesce(v_s.tax_pct, 0),
      'service_charge_pct', coalesce(v_s.service_charge_pct, 0), 'tax_inclusive', coalesce(v_s.tax_inclusive, false)),
    'subcategory_order', coalesce(v_s.subcategory_order, '[]'::jsonb),
    'subcategory_colors', coalesce(v_s.subcategory_colors, '{}'::jsonb),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
          'name', left(r.name, 80),
          'recipe_type', coalesce(r.recipe_type, 'DRINKS'),
          'subcategory', left(nullif(btrim(r.category), ''), 40),
          'category', left(coalesce(nullif(btrim(r.category), ''), public._type_label(r.recipe_type)), 40),
          'description', left(nullif(btrim(r.description), ''), 300),
          'image_url', public._public_image_url(r.image_url),
          'price', round(r.selling_price, 2),
          'sold_out', coalesce(r.sold_out, false) or (v_hide and not public._recipe_makeable(r.id)),
          'options', public._public_menu_options(r.modifier_groups)
        ) order by r.sort_order nulls last, r.name)
      from (select * from public.recipes r0
            where r0.business_id = v_s.business_id and coalesce(r0.active, true) and coalesce(r0.pos_visible, true)
              and coalesce(r0.qr_visible, true) and coalesce(r0.selling_price, 0) > 0
            order by r0.sort_order nulls last, r0.name
            limit 300) r), '[]'::jsonb)
  );
end $$;

-- =============================================================================
-- Who may call the new / re-made functions
-- =============================================================================
-- Every function this script makes is first locked, then opened only where meant:
--   anyone (signed in or not): public_menu
--   everything else here is internal (no API access).
do $$
declare f record;
  mine text[] := array['_valid_public_url','_valid_public_text','_settings_check','_public_image_url',
    '_public_menu_options','public_menu'];
  public_fns text[] := array['public_menu'];
begin
  for f in
    select p.oid::regprocedure as sig, p.proname from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname = any(mine)
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    if f.proname = any(public_fns) then
      execute format('grant execute on function %s to anon, authenticated', f.sig);
    end if;
  end loop;
end $$;

commit;

-- Tell the API about the new columns / function right away.
notify pgrst, 'reload schema';
