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
--        menu_highlight_recipe_id, menu_highlight_label, menu_highlight_blurb
--                              ONE highlighted item ("Today's pick") with a
--                              short label and a short line of text
--      The database checks every value itself (links must be https, sizes
--      are limited), so no screen can save something broken.
--   2. public_menu(code): the view-only menu for the link. Anyone may call it,
--      without signing in. It returns DISPLAY data only: shop name, logo and
--      colours, sub-category order and colours, the items shown on the QR
--      menu (name, type, sub-category, description, photo, price, sold out)
--      with their option names and option prices, the highlighted item, and
--      the "Visit us" fields.
--      Never: ids, ingredients, stock amounts, costs, recipes, staff,
--      customers or orders. A shop that is unknown OR has the link switched
--      off gets the same answer: {"error":"NOT_FOUND"}.
--
--   3. FASTER QR MENU: get_qr_menu gives exactly the same answer as before,
--      but with "hide items we can't make" on it adds up the stock once per
--      call instead of once per item (plus two indexes for that).
--   4. TABLE RIGHTS: people who haven't signed in at all ("anon") get no
--      rights on any table (they never had a use for them: Row Level Security
--      already showed them nothing); signed-in logins lose "empty a whole
--      table" and two other rights no app uses.
--
-- What it does NOT change: anything the 1.4 apps already use. Every change
-- is ADDED (new columns with safe defaults, a new function, a wider settings
-- check that only looks at the new columns) or keeps the same answer
-- (get_qr_menu). No live CHECK rule is changed; the new columns have no
-- live rule (they are new).
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

-- The highlighted item on the menu link ("Today's pick"), owner addition
-- 2026-11-09: which menu item, a short label (empty = "Today's pick") and a
-- short line of text under it.
alter table public.settings add column if not exists menu_highlight_recipe_id uuid;
alter table public.settings add column if not exists menu_highlight_label text;
alter table public.settings add column if not exists menu_highlight_blurb text;
-- If the item is deleted, the highlight is simply cleared.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'settings_menu_highlight_fk') then
    alter table public.settings add constraint settings_menu_highlight_fk
      foreign key (menu_highlight_recipe_id) references public.recipes(id) on delete set null;
  end if;
end $$;

-- No two shops may have the same code (empty codes are allowed for many shops).
-- This index also makes public_menu's look-up by code instant.
create unique index if not exists settings_public_code_key on public.settings(public_code) where public_code is not null;

-- public_menu lists one shop's menu items; this index finds them directly
-- instead of reading every shop's recipes.
create index if not exists recipes_business_idx on public.recipes(business_id);

-- =============================================================================
-- 2. CHECKING THE NEW SETTINGS (database-side, for every way of saving)
-- =============================================================================
-- A link the public may click: https only, at most 500 characters, plain
-- printable English-keyboard characters only (no spaces, no accented or
-- look-alike letters), and none that could break out of a page (quotes,
-- < >, backslash, backtick). p_hosts = the allowed web addresses (e.g. facebook.com); empty =
-- any address made of letters, digits, "." and "-".
-- Returns true when the link is fine (an empty link is fine too).
create or replace function public._valid_public_url(p_url text, p_hosts text[] default null) returns boolean
language sql immutable set search_path = public as $$
  select p_url is null or (
    length(p_url) <= 500
    and p_url ~ '^https://[\x21-\x7E]+$'
    and p_url !~ '["''<>\\`]'
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
--   BAD_HIGHLIGHT        the highlighted item isn't one of this shop's items,
--                        or (when it is newly picked) isn't active and shown on QR
--   BAD_HIGHLIGHT_LABEL  label longer than 30 characters
--   BAD_HIGHLIGHT_BLURB  text longer than 140 characters
-- (In the highlight label / text, invisible control characters and line
-- breaks are turned into spaces first. In the address / hours, Windows line
-- breaks are turned into plain ones first.)
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
  new.public_address := nullif(btrim(replace(replace(new.public_address, E'\r\n', E'\n'), E'\r', E'\n')), '');
  new.public_hours := nullif(btrim(replace(replace(new.public_hours, E'\r\n', E'\n'), E'\r', E'\n')), '');
  new.public_map_url := nullif(btrim(new.public_map_url), '');
  new.public_facebook_url := nullif(btrim(new.public_facebook_url), '');
  new.public_instagram_url := nullif(btrim(new.public_instagram_url), '');
  if new.public_code is not null and new.public_code !~ '^[a-z0-9][a-z0-9-]{0,28}[a-z0-9]$' then
    raise exception 'BAD_PUBLIC_CODE';
  end if;
  -- Two shops saving the same new code at the same moment: the second one
  -- waits here for the first to finish, then sees its code and gets
  -- PUBLIC_CODE_TAKEN (instead of a raw "duplicate key" error).
  if new.public_code is not null and (tg_op = 'INSERT' or old.public_code is distinct from new.public_code) then
    perform pg_advisory_xact_lock(hashtext('cccc.public_code:' || new.public_code));
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

  -- 011: the highlighted item
  new.menu_highlight_label := nullif(btrim(regexp_replace(new.menu_highlight_label, '[\x01-\x1F\x7F]', ' ', 'g')), '');
  new.menu_highlight_blurb := nullif(btrim(regexp_replace(new.menu_highlight_blurb, '[\x01-\x1F\x7F]', ' ', 'g')), '');
  if length(new.menu_highlight_label) > 30 then raise exception 'BAD_HIGHLIGHT_LABEL'; end if;
  if length(new.menu_highlight_blurb) > 140 then raise exception 'BAD_HIGHLIGHT_BLURB'; end if;
  if new.menu_highlight_recipe_id is not null then
    -- always: the item must be this shop's
    if not exists (select 1 from public.recipes where id = new.menu_highlight_recipe_id and business_id = new.business_id) then
      raise exception 'BAD_HIGHLIGHT';
    end if;
    -- only when the owner picks it (so a later settings save still works after
    -- the item was hidden; the menu link then simply shows no highlight)
    if (tg_op = 'INSERT' or old.menu_highlight_recipe_id is distinct from new.menu_highlight_recipe_id)
       and not exists (select 1 from public.recipes where id = new.menu_highlight_recipe_id
                         and coalesce(active, true) and coalesce(pos_visible, true) and coalesce(qr_visible, true)
                         and coalesce(selling_price, 0) > 0) then
      raise exception 'BAD_HIGHLIGHT';
    end if;
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
-- Indexes so the stock check below reads only what it needs:
--   recipe_ingredients by recipe (the lines of the listed items), and
--   stock lines by shop + ingredient (the sums for those lines' ingredients).
create index if not exists recipe_ingredients_recipe_idx on public.recipe_ingredients(recipe_id);
create index if not exists inventory_tx_business_ingredient_idx on public.inventory_transactions(business_id, ingredient_id);

-- Which of the given menu items can NOT be made from stock right now: an item
-- with at least one recipe line needing more than what is in stock. Same rule
-- as _recipe_makeable (004) and the same stock sum as v_ingredient_stock, but
-- the stock of each needed ingredient is added up ONCE for the whole list
-- instead of once per item (security review 1.4.1, HIGH 1).
create or replace function public._unmakeable_recipes(p_recipes uuid[]) returns uuid[]
language sql stable security definer set search_path = public as $$
  with need as (
    select ri.recipe_id, ri.business_id, ri.ingredient_id, ri.quantity
    from public.recipe_ingredients ri
    where ri.recipe_id = any(p_recipes) and ri.quantity > 0
  ), st as (
    select t.business_id, t.ingredient_id,
      sum(case
            when t.transaction_type = 'ADJUSTMENT' then t.quantity
            when t.transaction_type in ('PURCHASE','INITIAL_STOCK','PRODUCTION','SALE_REVERSAL') then abs(t.quantity)
            else -abs(t.quantity)
          end) as stock
    from public.inventory_transactions t
    where (t.business_id, t.ingredient_id) in (select distinct n.business_id, n.ingredient_id from need n)
    group by t.business_id, t.ingredient_id
  )
  select coalesce(array_agg(distinct n.recipe_id), '{}'::uuid[])
  from need n
  left join st on st.business_id = n.business_id and st.ingredient_id = n.ingredient_id
  where coalesce(st.stock, 0) < n.quantity
$$;

-- A colour for the public: only "#RRGGBB", anything else -> null.
create or replace function public._public_color(p text) returns text
language sql immutable set search_path = public as $$
  select case when p ~ '^#[0-9a-fA-F]{6}$' then p end
$$;

-- A link the page may show as a picture (photo, logo): http(s) only, at most
-- 1000 printable English-keyboard characters, none that could break out of a
-- page. Anything else (e.g. a very long "data:" picture from the old app) is
-- left out, so the answer stays small. (http is allowed for the local test
-- set-up; on the live project photos are https links to Supabase storage.)
create or replace function public._public_image_url(p_url text) returns text
language sql immutable set search_path = public as $$
  select case when length(p_url) <= 1000 and p_url ~ '^https?://[\x21-\x7E]+$' and p_url !~ '["''<>\\`()]'
              then p_url end
$$;

-- An item's options for the public: only what a customer reads on a menu.
--   [{name, required, multi, options:[{label, price_delta, kind}]}]
-- At most 10 groups per item and 20 options per group (groups with no
-- options are left out). Only those first entries are looked at, so a huge
-- options list costs no more than a small one. Never ids, ingredients,
-- extras, removes or swaps.
create or replace function public._public_menu_options(p_groups jsonb) returns jsonb
language sql immutable set search_path = public as $$
  select coalesce(jsonb_agg(x.grp order by x.gi), '[]'::jsonb)
  from (
    select gi, jsonb_build_object(
        'name', left(coalesce(g->>'name', ''), 60),
        'required', coalesce(lower(g->>'required') = 'true', false),
        'multi', coalesce(lower(g->>'multi_select') = 'true', false),
        'options', (select jsonb_agg(jsonb_build_object(
                        'label', left(coalesce(o->>'label', ''), 60),
                        'price_delta', round(coalesce(public._to_num(o->>'price_delta'), 0), 2),
                        'kind', case when o->>'kind' in ('PLAIN', 'EXTRA', 'SWAP') then o->>'kind' else 'PLAIN' end)
                      order by oi)
                    from generate_series(0, least(case when jsonb_typeof(g->'options') = 'array'
                                                       then jsonb_array_length(g->'options') else 0 end, 20) - 1) oi
                    cross join lateral (select g->'options'->oi as o) z
                    where jsonb_typeof(o) = 'object')) as grp
    from generate_series(0, least(case when jsonb_typeof(p_groups) = 'array' then jsonb_array_length(p_groups) else 0 end, 10) - 1) gi
    cross join lateral (select p_groups->gi as g) a
    where jsonb_typeof(g) = 'object'
  ) x
  where jsonb_typeof(x.grp->'options') = 'array'
$$;

-- public_menu(code) -> the shop's view-only menu, or {"error":"NOT_FOUND"}.
-- Who may call it: anyone (no sign-in needed). See docs/handoff/contract-1.4.1.md
-- for the exact answer.
-- Which items: the same as the QR menu (active, shown on the counter AND on
-- QR, price above 0), in the same order (the item's sort order, then name).
-- Unlike the QR menu, items are listed even when no counter has an open shift
-- (the owner doesn't want open / closed on this page).
-- Size limits (security review MEDIUM 2): at most 300 items, 2,000 options
-- and about 500 KB in total; items past a limit are left off and
-- "truncated" is true.
-- "sold_out" = exactly the opposite of the QR menu's "available": marked sold
-- out at the counter, or (only when the owner turned on "hide items we can't
-- make" for QR) not enough stock to make one.
-- Why no rate limit: the function only reads (it can't count calls). Each
-- call is cheap and bounded instead: the shop is found by an indexed code,
-- at most 300 items of that one shop are read, and the stock (only when that
-- QR option is on) is added up once per call. Supabase also stops any
-- anonymous request that runs longer than a few seconds.
create or replace function public.public_menu(p_shop text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_code text; v_s public.settings%rowtype; v_name text;
  v_ids uuid[]; v_unmake uuid[] := '{}'; v_trunc boolean := false;
  r public.recipes%rowtype; v_opts jsonb; v_item jsonb; v_list jsonb[] := '{}';
  v_nopts integer := 0; v_bytes integer := 0; v_cnt integer; v_len integer; v_hl jsonb;
begin
  -- 1. find the shop; a bad, unknown or switched-off code all get the same answer
  v_code := lower(btrim(coalesce(left(p_shop, 64), '')));
  if v_code !~ '^[a-z0-9][a-z0-9-]{0,28}[a-z0-9]$' then return jsonb_build_object('error', 'NOT_FOUND'); end if;
  select * into v_s from public.settings where public_code = v_code and menu_public;
  if not found then return jsonb_build_object('error', 'NOT_FOUND'); end if;
  select coalesce(nullif(btrim(v_s.business_name), ''), b.name) into v_name from public.businesses b where b.id = v_s.business_id;

  -- 2. which items, in menu order (one more than the limit, to know if
  --    some were left off)
  v_ids := array(select r0.id from public.recipes r0
                 where r0.business_id = v_s.business_id and coalesce(r0.active, true) and coalesce(r0.pos_visible, true)
                   and coalesce(r0.qr_visible, true) and coalesce(r0.selling_price, 0) > 0
                 order by r0.sort_order nulls last, r0.name, r0.id
                 limit 301);
  if cardinality(v_ids) > 300 then v_trunc := true; v_ids := v_ids[1:300]; end if;
  -- stock check once for all of them, only when the QR option is on
  if coalesce(v_s.qr_hide_out_of_stock, false) and cardinality(v_ids) > 0 then
    v_unmake := public._unmakeable_recipes(v_ids);
  end if;

  -- 3. build the items one by one until a size limit is reached
  for r in select r0.* from unnest(v_ids) with ordinality u(id, n) join public.recipes r0 on r0.id = u.id order by u.n loop
    v_opts := public._public_menu_options(r.modifier_groups);
    select count(*) into v_cnt from jsonb_array_elements(v_opts) g, jsonb_array_elements(g->'options') o;
    v_item := jsonb_build_object(
      'name', left(r.name, 80),
      'recipe_type', coalesce(r.recipe_type, 'DRINKS'),
      'subcategory', left(nullif(btrim(r.category), ''), 40),
      'category', left(coalesce(nullif(btrim(r.category), ''), public._type_label(r.recipe_type)), 40),
      'description', left(nullif(btrim(r.description), ''), 300),
      'image_url', public._public_image_url(r.image_url),
      'price', round(r.selling_price, 2),
      'sold_out', coalesce(r.sold_out, false) or r.id = any(v_unmake),
      'options', v_opts);
    v_len := octet_length(v_item::text);
    if v_nopts + v_cnt > 2000 or v_bytes + v_len > 500000 then v_trunc := true; exit; end if;
    v_nopts := v_nopts + v_cnt; v_bytes := v_bytes + v_len;
    -- the highlighted item: only when it is one of the listed items (so a
    -- hidden / inactive / deleted item is never shown); a sold-out one is
    -- still returned, with sold_out = true. item_index = its place in items (0 = first).
    if r.id = v_s.menu_highlight_recipe_id then
      v_hl := jsonb_build_object('item_index', cardinality(v_list), 'name', v_item->'name', 'image_url', v_item->'image_url',
                'price', v_item->'price', 'sold_out', v_item->'sold_out',
                'label', coalesce(v_s.menu_highlight_label, 'Today''s pick'), 'blurb', v_s.menu_highlight_blurb);
    end if;
    v_list := v_list || v_item;
  end loop;

  -- 4. the answer (display data only)
  return jsonb_build_object(
    'shop', jsonb_build_object('code', v_s.public_code, 'name', left(v_name, 80),
                               'logo_url', public._public_image_url(v_s.logo_url)),
    'theme', jsonb_build_object('primary_color', public._public_color(v_s.primary_color),
      'secondary_color', public._public_color(v_s.secondary_color), 'accent_color', public._public_color(v_s.accent_color),
      'background_color', public._public_color(v_s.background_color), 'card_color', public._public_color(v_s.card_color),
      'text_color', public._public_color(v_s.text_color),
      'theme', case when v_s.theme in ('CCCC', 'CUSTOM') then v_s.theme else 'CCCC' end),
    'visit', jsonb_build_object('address', v_s.public_address, 'hours', v_s.public_hours,
      'map_url', v_s.public_map_url, 'facebook_url', v_s.public_facebook_url,
      'instagram_url', v_s.public_instagram_url),
    'pricing', jsonb_build_object('tax_pct', coalesce(v_s.tax_pct, 0),
      'service_charge_pct', coalesce(v_s.service_charge_pct, 0), 'tax_inclusive', coalesce(v_s.tax_inclusive, false)),
    'subcategory_order', coalesce(v_s.subcategory_order, '[]'::jsonb),
    'subcategory_colors', coalesce(v_s.subcategory_colors, '{}'::jsonb),
    'highlight', coalesce(v_hl, 'null'::jsonb),
    'truncated', v_trunc,
    'items', to_jsonb(v_list)
  );
end $$;

-- =============================================================================
-- 4. QR MENU: same answer as 009, faster stock check
-- =============================================================================
-- Exactly the 009 get_qr_menu (same fields, same items, same order), except
-- that with "hide items we can't make" on, the stock is added up once per
-- call (_unmakeable_recipes) instead of once per item (security review
-- 1.4.1, HIGH 1: a table QR code is public too).
create or replace function public.get_qr_menu(p_token text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_t public.dining_tables; v_s public.settings%rowtype; v_b public.businesses%rowtype; v_open boolean;
  v_unmake uuid[] := '{}';
begin
  v_t := public._qr_table(p_token);
  if v_t.id is null then return jsonb_build_object('error', 'TABLE_NOT_FOUND'); end if;
  select * into v_b from public.businesses where id = v_t.business_id;
  select * into v_s from public.settings where business_id = v_t.business_id;
  v_open := public._shop_is_open(v_t.business_id);
  if v_open and coalesce(v_s.qr_hide_out_of_stock, false) then
    v_unmake := public._unmakeable_recipes(array(
      select r.id from public.recipes r
      where r.business_id = v_t.business_id and coalesce(r.active, true) and coalesce(r.pos_visible, true)
        and coalesce(r.qr_visible, true) and coalesce(r.selling_price, 0) > 0));
  end if;
  return jsonb_build_object(
    'business', jsonb_build_object('name', coalesce(nullif(v_s.business_name, ''), v_b.name), 'logo_url', v_s.logo_url),
    'theme', jsonb_build_object('primary_color', v_s.primary_color, 'secondary_color', v_s.secondary_color,
      'accent_color', v_s.accent_color, 'background_color', v_s.background_color, 'card_color', v_s.card_color,
      'text_color', v_s.text_color, 'theme', coalesce(v_s.theme, 'CCCC')),
    'table', jsonb_build_object('label', v_t.label, 'kind', v_t.kind),
    'is_open', v_open,
    'ordering_enabled', coalesce(v_s.qr_ordering_enabled, true),
    'welcome_message', v_s.qr_welcome_message,
    'payment_note', v_s.qr_payment_note,
    'tax_pct', coalesce(v_s.tax_pct, 0), 'service_charge_pct', coalesce(v_s.service_charge_pct, 0),
    'tax_inclusive', coalesce(v_s.tax_inclusive, false),
    'loyalty_enabled', coalesce(v_s.loyalty_enabled, false), 'stamps_per_reward', v_s.stamps_per_reward,
    'loyalty_rewards', public._loyalty_config(v_t.business_id),
    'subcategory_colors', coalesce(v_s.subcategory_colors, '{}'::jsonb),
    'subcategory_order', coalesce(v_s.subcategory_order, '[]'::jsonb),
    'items', case when not v_open then '[]'::jsonb else coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id, 'name', r.name,
        'category', coalesce(nullif(btrim(r.category), ''), public._type_label(r.recipe_type)),
        'subcategory', nullif(btrim(r.category), ''),
        'recipe_type', coalesce(r.recipe_type, 'DRINKS'),
        'description', r.description, 'image_url', r.image_url, 'price', r.selling_price,
        'available', not coalesce(r.sold_out, false) and not (r.id = any(v_unmake)),
        'modifier_groups', public._public_modifier_groups(r.modifier_groups)
      ) order by r.sort_order, r.name)
      from public.recipes r
      where r.business_id = v_t.business_id and coalesce(r.active, true) and coalesce(r.pos_visible, true)
        and coalesce(r.qr_visible, true) and coalesce(r.selling_price, 0) > 0), '[]'::jsonb) end
  );
end $$;

-- =============================================================================
-- 5. TABLE RIGHTS (security review 1.4.1, MEDIUM 3, lead-approved)
-- =============================================================================
-- "anon" = somebody using the app's public key WITHOUT any sign-in. None of
-- our apps reads a table that way (the QR page, the counter and the Back
-- Office all sign in first; the menu link uses public_menu only), so anon
-- gets no table rights at all, now and for tables made later. Row Level
-- Security already showed them nothing; this also closes the rights that
-- Row Level Security doesn't cover (e.g. emptying a whole table).
-- Signed-in logins ("authenticated") keep read / add / change / delete
-- (still limited by Row Level Security) but lose "empty a whole table"
-- (TRUNCATE), REFERENCES and TRIGGER, which no app needs.
-- (File storage, storage.*, is not touched.)
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;
revoke truncate, references, trigger on all tables in schema public from authenticated;
alter default privileges in schema public revoke truncate, references, trigger on tables from authenticated;

-- =============================================================================
-- Who may call the new / re-made functions
-- =============================================================================
-- Every function this script makes is first locked, then opened only where meant:
--   anyone (signed in or not): public_menu, get_qr_menu (as in 004)
--   everything else here is internal (no API access).
do $$
declare f record;
  mine text[] := array['_valid_public_url','_valid_public_text','_settings_check','_public_image_url',
    '_public_menu_options','public_menu','_unmakeable_recipes','_public_color','get_qr_menu'];
  public_fns text[] := array['public_menu','get_qr_menu'];
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
