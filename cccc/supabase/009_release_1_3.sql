-- =============================================================================
-- Cavite City Coffee Club — 009: release 1.3 ("Opening day")
-- -----------------------------------------------------------------------------
-- HOW TO RUN: Supabase → SQL Editor → New query → paste this WHOLE file → Run.
-- Run it AFTER 004, 005, 006, 007 and 008 (all already done). It is safe to
-- run more than once. It runs inside one transaction: if anything fails,
-- nothing is changed.
--
-- What it adds, in plain words:
--   A. START FRESH (owner only): clear the test sales before opening day.
--      start_fresh_preview(date) shows what would be removed and kept;
--      start_fresh(date, 'START FRESH') does it. Removed (only rows dated
--      BEFORE the chosen moment, only the owner's shop): sales with their
--      items, payments and refunds, shifts, cash pay-ins / pay-outs, QR orders,
--      stamp-card rewards used on those sales, and the stock lines of those
--      sales and refunds. Kept: menu, recipes, ingredients, brands, purchases,
--      production, starting stock / adjustments / waste, staff, counters,
--      settings, floor plan, customers (their visits and stamps go back to
--      what their remaining sales give: 0 when all are removed), the audit
--      trail and the upload receipts (sync_operations). One audit row
--      "Start fresh" records what was removed.
--      NOTE ON STOCK: a sale took stock off, a refund put some back. Removing
--      those lines puts the stock back to what it would be WITHOUT the test
--      sales. This is on purpose; the preview lists every ingredient whose
--      stock changes (now -> after).
--   B. SHOP OPEN = at least one counter has an open shift. The QR page gets
--      is_open; when closed it gets no menu items (the stamp card still
--      works) and qr_place_order answers SHOP_CLOSED.
--   C. Sub-category order (settings.subcategory_order, a list of names) and,
--      for the QR page, the sub-category colours, the order and each item's
--      recipe type, so it can group and colour exactly like the counter.
--   D. Counter customers tab: sort by name, most recent or most frequent.
--   E. Out of stock at payment: a counter sale that takes an ingredient below
--      0 is still saved (the money is already taken) but flagged for the
--      owner's review with the reason OUT_OF_STOCK. A new counter sale dated
--      before the latest Start fresh moment is saved but flagged
--      BEFORE_START_FRESH (old test data from a counter that was offline).
--
-- What it does NOT change: refunds, refund caps, approvals, PIN rules, the
-- stamp rules, prices, error codes of fo_sync. No live CHECK rule is changed.
-- =============================================================================

begin;

-- =============================================================================
-- C. SUB-CATEGORY ORDER (the setting itself; the QR menu part is in section B)
-- =============================================================================
-- The owner's order of sub-categories, e.g. ["Iced coffee", "Hot coffee",
-- "Pastries"]. Names not in the list go after it (the apps' shared sorting
-- helper also keeps drinks above pastries / food). Empty list = A to Z.
alter table public.settings add column if not exists subcategory_order jsonb not null default '[]'::jsonb;

-- True when p is a valid order list: a JSON array of at most 100 texts, each
-- 1..40 characters (spaces at the ends don't count), no name twice (ignoring
-- upper / lower case and spaces at the ends).
create or replace function public._valid_subcategory_order(p jsonb) returns boolean
language sql immutable set search_path = public as $$
  select p is not null and jsonb_typeof(p) = 'array'
     and jsonb_array_length(p) <= 100
     and not exists (select 1 from jsonb_array_elements(p) e
                     where jsonb_typeof(e) <> 'string'
                        or length(btrim(e #>> '{}')) = 0 or length(e #>> '{}') > 40)
     and (select count(distinct lower(btrim(e #>> '{}'))) from jsonb_array_elements(p) e) = jsonb_array_length(p)
$$;

-- Same as 008, plus BAD_SUBCATEGORY_ORDER = the order list is not valid.
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
  return new;
end $$;
-- (the trigger settings_check from 008 already calls this function)

-- =============================================================================
-- B. SHOP OPEN = ANY OPEN SHIFT
-- =============================================================================
-- True when at least one counter of the shop has a shift that is still open.
-- (Shifts are 'ACTIVE' while open and 'CLOSED' after; see shifts_status_check.)
create or replace function public._shop_is_open(p_biz uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.shifts where business_id = p_biz and status = 'ACTIVE')
$$;

-- Public menu for a table QR code: same as 008, plus
--   is_open             true when a counter has an open shift (see above).
--                       When false, items is EMPTY; everything else (shop
--                       name, logo, look, stamp card settings) is still there.
--   subcategory_colors  the counter's tile colours, {name: colour key}
--   subcategory_order   the owner's order of sub-categories, [name, ...]
--   items[].recipe_type DRINKS / PASTRY / FOOD / SAUCES_SYRUPS
--   items[].subcategory the item's own sub-category text (null when empty;
--                       items[].category stays as before: the sub-category, or
--                       the recipe type's label when there is none, which is
--                       the name the counter groups by)
create or replace function public.get_qr_menu(p_token text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_t public.dining_tables; v_s public.settings%rowtype; v_b public.businesses%rowtype; v_open boolean;
begin
  v_t := public._qr_table(p_token);
  if v_t.id is null then return jsonb_build_object('error', 'TABLE_NOT_FOUND'); end if;
  select * into v_b from public.businesses where id = v_t.business_id;
  select * into v_s from public.settings where business_id = v_t.business_id;
  v_open := public._shop_is_open(v_t.business_id);
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
        'available', not coalesce(r.sold_out, false)
                     and (not coalesce(v_s.qr_hide_out_of_stock, false) or public._recipe_makeable(r.id)),
        'modifier_groups', public._public_modifier_groups(r.modifier_groups)
      ) order by r.sort_order, r.name)
      from public.recipes r
      where r.business_id = v_t.business_id and coalesce(r.active, true) and coalesce(r.pos_visible, true)
        and coalesce(r.qr_visible, true) and coalesce(r.selling_price, 0) > 0), '[]'::jsonb) end
  );
end $$;

-- Place an order: same as 004, plus SHOP_CLOSED (no counter has an open shift),
-- checked right after the owner's manual switch (ORDERING_OFF).
-- Prices are calculated HERE from the recipes table — whatever the phone sends
-- as a price is ignored.
-- p_items = [{recipe_id, quantity, notes, modifiers:[{group_id, option_id}]}]
create or replace function public.qr_place_order(p_token text, p_items jsonb, p_note text default null, p_order_type text default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid(); v_t public.dining_tables; v_s public.settings%rowtype;
  v_cid uuid; v_c public.customers%rowtype;
  v_it jsonb; v_r public.recipes%rowtype; v_qty integer; v_groups jsonb; v_g jsonb; v_o jsonb; v_sel jsonb;
  v_unit numeric; v_mods jsonb; v_lines jsonb := '[]'::jsonb; v_subtotal numeric := 0;
  v_tax numeric; v_service numeric; v_total numeric; v_day date; v_no integer; v_type text; v_order public.qr_orders%rowtype;
  v_count integer; v_seen text[];
begin
  v_t := public._qr_table(p_token);
  if v_t.id is null then return jsonb_build_object('error', 'TABLE_NOT_FOUND'); end if;
  if v_uid is null then return jsonb_build_object('error', 'NOT_SIGNED_IN'); end if;
  select * into v_s from public.settings where business_id = v_t.business_id;
  if not coalesce(v_s.qr_ordering_enabled, true) then return jsonb_build_object('error', 'ORDERING_OFF'); end if;
  -- 009: closed when no counter has an open shift
  if not public._shop_is_open(v_t.business_id) then return jsonb_build_object('error', 'SHOP_CLOSED'); end if;
  select customer_id into v_cid from public.customer_devices where auth_user_id = v_uid and business_id = v_t.business_id;
  if v_cid is null then return jsonb_build_object('error', 'REGISTER_FIRST'); end if;
  select * into v_c from public.customers where id = v_cid;

  select count(*) into v_count from public.qr_orders
    where auth_user_id = v_uid and business_id = v_t.business_id and status in ('PENDING','PREPARING','READY') and paid_at is null;
  if v_count >= 3 then return jsonb_build_object('error', 'TOO_MANY_OPEN_ORDERS'); end if;
  select count(*) into v_count from public.qr_orders where auth_user_id = v_uid and created_at > now() - interval '1 hour';
  if v_count >= 10 then return jsonb_build_object('error', 'TOO_MANY_ORDERS'); end if;
  -- Shop-wide limits (section 13a of 004). Orders of one shop are placed one at a time
  -- (advisory lock), so two phones at the same moment can't both slip past a limit.
  perform pg_advisory_xact_lock(hashtext('cccc.qr_order:' || v_t.business_id::text));
  select count(*) into v_count from public.qr_orders where table_id = v_t.id and status = 'PENDING';
  if v_count >= (public._qr_limits()->>'table_open_orders')::int then return jsonb_build_object('error', 'TOO_MANY_ORDERS'); end if;
  select count(*) into v_count from public.qr_orders where business_id = v_t.business_id and created_at > now() - interval '10 minutes';
  if v_count >= (public._qr_limits()->>'shop_orders_10min')::int then return jsonb_build_object('error', 'TOO_MANY_ORDERS'); end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    return jsonb_build_object('error', 'EMPTY_ORDER');
  end if;
  if jsonb_array_length(p_items) > 30 then return jsonb_build_object('error', 'ORDER_TOO_BIG'); end if;

  for v_it in select value from jsonb_array_elements(p_items) loop
    select * into v_r from public.recipes
      where id = nullif(v_it->>'recipe_id', '')::uuid and business_id = v_t.business_id
        and coalesce(active, true) and coalesce(pos_visible, true) and coalesce(qr_visible, true) and coalesce(selling_price, 0) > 0;
    if not found then return jsonb_build_object('error', 'ITEM_UNAVAILABLE'); end if;
    if coalesce(v_r.sold_out, false) or (coalesce(v_s.qr_hide_out_of_stock, false) and not public._recipe_makeable(v_r.id)) then
      return jsonb_build_object('error', 'ITEM_UNAVAILABLE', 'name', v_r.name);
    end if;
    begin v_qty := (v_it->>'quantity')::integer; exception when others then v_qty := 0; end;
    if v_qty is null or v_qty < 1 or v_qty > 20 then return jsonb_build_object('error', 'BAD_QUANTITY', 'name', v_r.name); end if;

    v_groups := case when jsonb_typeof(v_r.modifier_groups) = 'array' then v_r.modifier_groups else '[]'::jsonb end;
    v_unit := v_r.selling_price; v_mods := '[]'::jsonb; v_seen := '{}';
    for v_sel in select value from jsonb_array_elements(case when jsonb_typeof(v_it->'modifiers') = 'array' then v_it->'modifiers' else '[]'::jsonb end) loop
      select g.value into v_g from jsonb_array_elements(v_groups) g where g.value->>'id' = v_sel->>'group_id';
      if v_g is null then return jsonb_build_object('error', 'BAD_OPTION', 'name', v_r.name); end if;
      select o.value into v_o from jsonb_array_elements(coalesce(v_g->'options', '[]'::jsonb)) o where o.value->>'id' = v_sel->>'option_id';
      if v_o is null then return jsonb_build_object('error', 'BAD_OPTION', 'name', v_r.name); end if;
      if (v_sel->>'group_id') || ':' || (v_sel->>'option_id') = any(v_seen) then return jsonb_build_object('error', 'BAD_OPTION', 'name', v_r.name); end if;
      if not coalesce((v_g->>'multi_select')::boolean, false)
         and exists (select 1 from unnest(v_seen) x where split_part(x, ':', 1) = v_sel->>'group_id') then
        return jsonb_build_object('error', 'BAD_OPTION', 'name', v_r.name);
      end if;
      v_seen := v_seen || ((v_sel->>'group_id') || ':' || (v_sel->>'option_id'));
      v_unit := v_unit + coalesce((v_o->>'price_delta')::numeric, 0);
      v_mods := v_mods || jsonb_build_array(jsonb_build_object(
        'group', v_g->>'name', 'label', v_o->>'label', 'price_delta', coalesce((v_o->>'price_delta')::numeric, 0),
        'ingredient_id', nullif(v_o->>'ingredient_id', ''), 'ingredient_qty_delta', coalesce((v_o->>'ingredient_qty_delta')::numeric, 0)));
      v_g := null; v_o := null;
    end loop;
    for v_g in select value from jsonb_array_elements(v_groups) loop
      if coalesce((v_g->>'required')::boolean, false)
         and not exists (select 1 from unnest(v_seen) x where split_part(x, ':', 1) = v_g->>'id') then
        return jsonb_build_object('error', 'OPTION_REQUIRED', 'name', v_r.name, 'group', v_g->>'name');
      end if;
    end loop;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'recipe_id', v_r.id, 'name', v_r.name, 'quantity', v_qty, 'unit_price', v_unit,
      'line_total', v_unit * v_qty, 'modifiers', v_mods, 'notes', left(nullif(btrim(v_it->>'notes'), ''), 140)));
    v_subtotal := v_subtotal + v_unit * v_qty;
  end loop;

  v_tax := case when coalesce(v_s.tax_inclusive, false) then 0 else v_subtotal * coalesce(v_s.tax_pct, 0) / 100 end;
  v_service := v_subtotal * coalesce(v_s.service_charge_pct, 0) / 100;
  v_total := round(v_subtotal + v_tax + v_service, 2);
  v_type := case when v_t.kind = 'TAKEAWAY' then 'TAKEAWAY'
                 when upper(coalesce(p_order_type, '')) = 'TAKEAWAY' then 'TAKEAWAY' else 'DINE_IN' end;
  v_day := (now() at time zone coalesce(nullif(v_s.timezone, ''), 'Asia/Manila'))::date;
  insert into public.qr_order_counters(business_id, day, last_no) values (v_t.business_id, v_day, 1)
    on conflict (business_id, day) do update set last_no = public.qr_order_counters.last_no + 1
    returning last_no into v_no;

  insert into public.qr_orders(business_id, order_number, order_day, table_id, table_label, order_type, customer_id,
      customer_nickname, auth_user_id, status, items, subtotal, tax_amount, service_charge_amount, total, customer_note)
    values (v_t.business_id, 'Q-' || lpad(v_no::text, 3, '0'), v_day, v_t.id, v_t.label, v_type, v_c.id,
      v_c.nickname, v_uid, 'PENDING', v_lines, v_subtotal, round(v_tax, 2), round(v_service, 2), v_total,
      left(nullif(btrim(p_note), ''), 200))
    returning * into v_order;
  update public.customers set last_seen_at = now() where id = v_c.id;
  return jsonb_build_object('order', to_jsonb(v_order));
end $$;

-- =============================================================================
-- D. COUNTER CUSTOMERS TAB: SORT
-- =============================================================================
-- Same as 008 (masked phones, money only with the signed-in manager's LOGIN
-- token, 120 calls per hour per counter, nickname search, 1..50 per page),
-- plus p_sort:
--   'name'     nickname A to Z (upper / lower case ignored)
--   'recent'   last visit first (the default; same order as 008)
--   'frequent' most visits first, then last visit first
--   anything else -> 'recent'
-- Old counters that call it without p_sort keep working (p_sort has a default,
-- and the old 3-argument version is removed so the API never has to choose).
drop function if exists public.fo_customer_list(text, integer, text);
create or replace function public.fo_customer_list(p_search text default '', p_limit integer default 30,
                                                   p_staff_token text default null, p_sort text default 'recent')
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_biz uuid := public.current_business_id();
  v_q text := left(btrim(coalesce(p_search, '')), 30);
  v_pat text;
  v_lim integer := least(greatest(coalesce(p_limit, 30), 1), 50);
  v_sort text := lower(btrim(coalesce(p_sort, '')));
  v_money_chk text; v_money boolean; v_s public.settings%rowtype;
begin
  if v_biz is null then raise exception 'NOT_A_MEMBER'; end if;
  if not public._is_active_counter(v_biz) then raise exception 'NOT_ALLOWED'; end if;
  if not public._customer_view_allowed(auth.uid()) then return jsonb_build_object('error', 'TOO_MANY_ATTEMPTS'); end if;
  if v_sort not in ('name', 'recent', 'frequent') then v_sort := 'recent'; end if;
  v_money_chk := public._money_view_check(v_biz, p_staff_token);
  v_money := coalesce(v_money_chk = 'OK', false);
  select * into v_s from public.settings where business_id = v_biz;
  -- % and _ typed by staff are plain characters, not wildcards
  v_pat := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  return jsonb_build_object(
    'customers', coalesce((
      select jsonb_agg(public._counter_customer_json(c.x, v_money) order by c.rn)
      from (select x, row_number() over (order by
                     case when v_sort = 'name' then lower((x).nickname) end asc,
                     case when v_sort = 'frequent' then (x).visit_count end desc nulls last,
                     coalesce((x).last_order_at, (x).last_seen_at) desc nulls last,
                     lower((x).nickname), (x).id) as rn
            from public.customers x
            where x.business_id = v_biz and x.merged_into is null
              and (v_q = '' or x.nickname ilike v_pat)
            order by rn
            limit v_lim) c), '[]'::jsonb),
    'sort', v_sort,
    'show_money', v_money,
    'money_refused', case when v_money then null else v_money_chk end,
    'loyalty_enabled', coalesce(v_s.loyalty_enabled, false),
    'loyalty_rewards', public._loyalty_config(v_biz));
end $$;

-- =============================================================================
-- E. OUT OF STOCK AT PAYMENT
-- =============================================================================
-- Returns 'OUT_OF_STOCK' when this sale's stock lines (p_inventory, the
-- counter's SALE_USAGE lines) take any ingredient of the shop below 0, else null.
-- Stock = the same sum as v_ingredient_stock, without this sale's own older
-- lines (they are replaced). Below 0 = more than 0.001 of the base unit short.
-- An ingredient that was ALREADY below 0 and is used again is flagged too
-- (the item was still out of stock).
create or replace function public._sale_stock_review(p_biz uuid, p_sale_id uuid, p_inventory jsonb) returns text
language sql stable security definer set search_path = public as $$
  with use as (
    select public._to_uuid(l->>'ingredient_id') as ing,
           sum(abs(coalesce(public._to_num(l->>'quantity'), 0))) as q
    from jsonb_array_elements(case when jsonb_typeof(p_inventory) = 'array' then p_inventory else '[]'::jsonb end) l
    group by 1
  )
  select case when exists (
    select 1 from use u
    where u.ing is not null and u.q > 0
      and coalesce((select sum(case when t.transaction_type = 'ADJUSTMENT' then t.quantity
                                    when t.transaction_type in ('PURCHASE','INITIAL_STOCK','PRODUCTION','SALE_REVERSAL') then abs(t.quantity)
                                    else -abs(t.quantity) end)
                    from public.inventory_transactions t
                    where t.business_id = p_biz and t.ingredient_id = u.ing
                      and not (t.transaction_type = 'SALE_USAGE' and t.reference_id = p_sale_id::text)), 0) - u.q < -0.001)
  then 'OUT_OF_STOCK' end
$$;

-- =============================================================================
-- A. START FRESH (tables + helpers)
-- =============================================================================
-- One row per "Start fresh" a shop did: the moment chosen, when, who and the
-- counts. A counter upload of a NEW sale dated before the latest moment is
-- flagged BEFORE_START_FRESH (see _fo_apply), so test sales that an offline
-- counter still had can't quietly come back.
create table if not exists public.start_fresh_runs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  before_at timestamptz not null,
  ran_at timestamptz not null default now(),
  ran_by uuid,               -- the owner's login (profiles.id)
  ran_by_name text,
  counts jsonb not null default '{}'::jsonb
);
create index if not exists start_fresh_runs_business_idx on public.start_fresh_runs(business_id, ran_at desc);
-- Only the owner reads it; only start_fresh writes it (no write rules at all).
alter table public.start_fresh_runs enable row level security;
do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'start_fresh_runs' loop
    execute format('drop policy %I on public.start_fresh_runs', p.policyname);
  end loop;
end $$;
create policy start_fresh_runs_read on public.start_fresh_runs for select to authenticated
  using (business_id = (select public.current_business_id()) and (select public.app_rank()) >= 3);

-- The latest Start fresh moment of a shop (null = never).
create or replace function public._fresh_start_before(p_biz uuid) returns timestamptz
language sql stable security definer set search_path = public as $$
  select max(before_at) from public.start_fresh_runs where business_id = p_biz
$$;

-- WHICH rows Start fresh removes (one definition, used by the preview AND the
-- real thing, so the numbers always match). Only the shop p_biz.
--   sales:    dated (transaction_date, else created_at) before p_before, any status
--   refunds:  the refunds of those sales, plus refunds without a sale dated before
--   stock:    SALE_USAGE lines of those sales, SALE_REVERSAL lines of those
--             refunds, plus sale / refund stock lines dated before whose sale /
--             refund no longer exists. Every other stock line is kept, and so are
--             the stock lines of sales / refunds that are kept.
--   cash:     pay-ins / pay-outs dated (at, else created_at) before p_before
--   shifts:   CLOSED shifts opened before p_before that nothing kept still
--             points at (a kept sale, refund or pay-in keeps its shift)
--   qr:       QR orders placed before p_before, unless a kept sale paid them
create or replace function public._start_fresh_ids(p_biz uuid, p_before timestamptz)
returns table(sale_ids uuid[], refund_ids uuid[], stock_ids uuid[], cash_ids uuid[], shift_ids uuid[], qr_ids uuid[])
language plpgsql stable security definer set search_path = public as $$
declare
  v_s uuid[]; v_r uuid[]; v_st uuid[]; v_c uuid[]; v_sh uuid[]; v_q uuid[];
  v_day date := (p_before at time zone coalesce((select nullif(btrim(timezone), '') from public.settings where business_id = p_biz), 'Asia/Manila'))::date;
begin
  select coalesce(array_agg(id), '{}') into v_s from public.sales
    where business_id = p_biz and coalesce(transaction_date, created_at) < p_before;
  select coalesce(array_agg(id), '{}') into v_r from public.refunds
    where business_id = p_biz
      and (sale_id = any(v_s) or (sale_id is null and coalesce(date, created_at) < p_before));
  select coalesce(array_agg(id), '{}') into v_st from public.inventory_transactions t
    where t.business_id = p_biz
      and ((t.transaction_type = 'SALE_USAGE'
            and (public._to_uuid(t.reference_id) = any(v_s)
                 or (t.transaction_date < v_day
                     and not exists (select 1 from public.sales s where s.id = public._to_uuid(t.reference_id) and s.business_id = p_biz))))
        or (t.transaction_type = 'SALE_REVERSAL'
            and (public._to_uuid(t.reference_id) = any(v_r)
                 or (t.transaction_date < v_day
                     and not exists (select 1 from public.refunds r where r.id = public._to_uuid(t.reference_id) and r.business_id = p_biz)))));
  select coalesce(array_agg(id), '{}') into v_c from public.cash_movements
    where business_id = p_biz and coalesce(at, created_at) < p_before;
  select coalesce(array_agg(sh.id), '{}') into v_sh from public.shifts sh
    where sh.business_id = p_biz and sh.status = 'CLOSED' and coalesce(sh.opened_at, sh.created_at) < p_before
      and not exists (select 1 from public.sales x where x.shift_id = sh.id and not (x.id = any(v_s)))
      and not exists (select 1 from public.refunds x where x.shift_id = sh.id and not (x.id = any(v_r)))
      and not exists (select 1 from public.cash_movements x where x.shift_id = sh.id and not (x.id = any(v_c)));
  select coalesce(array_agg(q.id), '{}') into v_q from public.qr_orders q
    where q.business_id = p_biz and q.created_at < p_before
      and not exists (select 1 from public.sales x where x.id = q.sale_id and not (x.id = any(v_s)));
  return query select v_s, v_r, v_st, v_c, v_sh, v_q;
end $$;

-- The numbers for the screens: what goes, what stays, and the stock changes.
--   {before, open_shifts, can_start_fresh,
--    remove: {sales, sale_items, payments, refunds, shifts, cash_movements, qr_orders,
--             loyalty_redemptions, stock_lines, customers_affected},
--    keep:   {sales, shifts, cash_movements, qr_orders, stock_lines, recipes, ingredients,
--             ingredient_brands, purchases, production_batches, waste, staff, devices,
--             customers, dining_tables, floor_shapes, audit_log, sync_operations},
--    stock_changes: [{ingredient_id, name, base_unit, stock_now, stock_after}]}
--   stock_changes lists only ingredients whose stock changes (sales put back).
create or replace function public._start_fresh_summary(p_biz uuid, p_before timestamptz) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare i record; v_open integer;
begin
  select * into i from public._start_fresh_ids(p_biz, p_before);
  select count(*) into v_open from public.shifts where business_id = p_biz and status = 'ACTIVE';
  return jsonb_build_object(
    'before', p_before,
    'open_shifts', v_open,
    'can_start_fresh', v_open = 0,
    'remove', jsonb_build_object(
      'sales', cardinality(i.sale_ids),
      'sale_items', (select count(*) from public.sale_items where sale_id = any(i.sale_ids)),
      'payments', (select count(*) from public.payments where sale_id = any(i.sale_ids)),
      'refunds', cardinality(i.refund_ids),
      'shifts', cardinality(i.shift_ids),
      'cash_movements', cardinality(i.cash_ids),
      'qr_orders', cardinality(i.qr_ids),
      'loyalty_redemptions', (select count(*) from public.loyalty_redemptions where sale_id = any(i.sale_ids)),
      'stock_lines', cardinality(i.stock_ids),
      'customers_affected', (select count(distinct customer_id) from public.sales where id = any(i.sale_ids) and customer_id is not null)),
    'keep', jsonb_build_object(
      'sales', (select count(*) from public.sales where business_id = p_biz) - cardinality(i.sale_ids),
      'shifts', (select count(*) from public.shifts where business_id = p_biz) - cardinality(i.shift_ids),
      'cash_movements', (select count(*) from public.cash_movements where business_id = p_biz) - cardinality(i.cash_ids),
      'qr_orders', (select count(*) from public.qr_orders where business_id = p_biz) - cardinality(i.qr_ids),
      'stock_lines', (select count(*) from public.inventory_transactions where business_id = p_biz) - cardinality(i.stock_ids),
      'recipes', (select count(*) from public.recipes where business_id = p_biz),
      'ingredients', (select count(*) from public.ingredients where business_id = p_biz),
      'ingredient_brands', (select count(*) from public.ingredient_brands where business_id = p_biz),
      'purchases', (select count(*) from public.purchases where business_id = p_biz),
      'production_batches', (select count(*) from public.production_batches where business_id = p_biz),
      'waste', (select count(*) from public.waste where business_id = p_biz),
      'staff', (select count(*) from public.staff where business_id = p_biz),
      'devices', (select count(*) from public.devices where business_id = p_biz),
      'customers', (select count(*) from public.customers where business_id = p_biz and merged_into is null),
      'dining_tables', (select count(*) from public.dining_tables where business_id = p_biz),
      'floor_shapes', (select count(*) from public.floor_shapes where business_id = p_biz),
      'audit_log', (select count(*) from public.audit_log where business_id = p_biz),
      'sync_operations', (select count(*) from public.sync_operations where business_id = p_biz)),
    'stock_changes', coalesce((
      select jsonb_agg(jsonb_build_object('ingredient_id', g.id, 'name', g.name, 'base_unit', g.base_unit,
                                          'stock_now', round(coalesce(v.stock, 0), 4),
                                          'stock_after', round(coalesce(v.stock, 0) - d.delta, 4)) order by g.name)
      from (select t.ingredient_id,
                   sum(case when t.transaction_type = 'SALE_REVERSAL' then abs(t.quantity) else -abs(t.quantity) end) as delta
            from public.inventory_transactions t where t.id = any(i.stock_ids)
            group by t.ingredient_id) d
      join public.ingredients g on g.id = d.ingredient_id
      left join public.v_ingredient_stock v on v.ingredient_id = d.ingredient_id and v.business_id = p_biz
      where abs(d.delta) > 0.00001), '[]'::jsonb));
end $$;

-- Only the owner's own email login (profile role ADMIN, rank 3) of a shop.
-- A paired counter (DEVICE), a staff PIN or a manager / cashier login -> NOT_ALLOWED.
create or replace function public._require_owner() returns uuid
language plpgsql stable security definer set search_path = public as $$
declare v_biz uuid := public.current_business_id();
begin
  if v_biz is null then raise exception 'NOT_A_MEMBER'; end if;
  if not public.is_owner() or public.app_rank() < 3 then raise exception 'NOT_ALLOWED'; end if;
  return v_biz;
end $$;

-- Back Office: what Start fresh WOULD do for the moment p_before (nothing is
-- changed). Returns the summary above. Errors: NOT_A_MEMBER, NOT_ALLOWED,
-- BAD_DATE (missing, or in the future: Start fresh only clears the past, so
-- real sales made after it can never be caught by it).
create or replace function public.start_fresh_preview(p_before timestamptz) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_biz uuid := public._require_owner();
begin
  if p_before is null or not isfinite(p_before) or p_before > now() then raise exception 'BAD_DATE'; end if;
  return public._start_fresh_summary(v_biz, p_before);
end $$;

-- Back Office: Start fresh. p_confirm must be exactly 'START FRESH'.
-- Errors (nothing is changed): NOT_A_MEMBER, NOT_ALLOWED, BAD_DATE,
--   CONFIRM_REQUIRED (the typed words are not exactly START FRESH),
--   SHIFT_STILL_OPEN (a counter still has an open shift: close it first),
--   BUSY_TRY_AGAIN (counters were uploading at that moment: try again).
-- Returns {done: true, before, removed: {...same keys as the preview's remove},
--          kept: {...same keys as the preview's keep, counted afterwards},
--          stock_changes: [...as in the preview]}.
-- Writes ONE audit row (action 'Start fresh') and one start_fresh_runs row.
create or replace function public.start_fresh(p_before timestamptz, p_confirm text) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_biz uuid := public._require_owner();
  v_plan jsonb; v_after jsonb; i record; v_custs uuid[]; c uuid;
  v_actor public.staff%rowtype; v_name text;
begin
  if p_before is null or not isfinite(p_before) or p_before > now() then raise exception 'BAD_DATE'; end if;
  if p_confirm is distinct from 'START FRESH' then raise exception 'CONFIRM_REQUIRED'; end if;
  -- Hold the sales tables still while we work, so no counter upload or QR
  -- order slips in between "check" and "remove". Waits at most 15 seconds.
  perform set_config('lock_timeout', '15s', true);
  begin
    lock table public.shifts, public.sales, public.refunds, public.cash_movements,
               public.inventory_transactions, public.qr_orders in share row exclusive mode;
  exception when lock_not_available then
    raise exception 'BUSY_TRY_AGAIN';
  end;
  perform set_config('lock_timeout', '0', true);
  if exists (select 1 from public.shifts where business_id = v_biz and status = 'ACTIVE') then
    raise exception 'SHIFT_STILL_OPEN';
  end if;

  v_plan := public._start_fresh_summary(v_biz, p_before);
  select * into i from public._start_fresh_ids(v_biz, p_before);
  select coalesce(array_agg(distinct customer_id), '{}') into v_custs
    from public.sales where id = any(i.sale_ids) and customer_id is not null;

  -- Remove, children first. (Nothing here needs the finished-sale lock to be
  -- switched off: that lock only stops CHANGING a finished sale's money; the
  -- refund / stock caps re-check only sales that still exist.)
  delete from public.loyalty_redemptions where business_id = v_biz and sale_id = any(i.sale_ids);
  delete from public.inventory_transactions where business_id = v_biz and id = any(i.stock_ids);
  delete from public.refunds where business_id = v_biz and id = any(i.refund_ids);
  delete from public.payments where sale_id = any(i.sale_ids);
  delete from public.sale_items where sale_id = any(i.sale_ids);
  delete from public.sales where business_id = v_biz and id = any(i.sale_ids);
  delete from public.cash_movements where business_id = v_biz and id = any(i.cash_ids);
  delete from public.shifts where business_id = v_biz and id = any(i.shift_ids);
  delete from public.qr_orders where business_id = v_biz and id = any(i.qr_ids);
  -- QR order numbers start again at Q-001 on days that have no orders left.
  delete from public.qr_order_counters k
    where k.business_id = v_biz
      and not exists (select 1 from public.qr_orders q where q.business_id = v_biz and q.order_day = k.day);

  -- Customers keep their record; their numbers follow the sales that are left.
  foreach c in array v_custs loop
    perform public._refresh_customer_loyalty(c);
    update public.customers x
       set total_spent = coalesce((
             select round(sum(greatest(coalesce(s.grand_total, 0)
                    - coalesce((select sum(greatest(r.amount, 0)) from public.refunds r where r.sale_id = s.id), 0), 0)), 2)
             from public.sales s
             where s.business_id = v_biz and s.customer_id = x.id
               and s.status in ('COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED')), 0),
           last_order_at = (select max(coalesce(s.transaction_date, s.created_at)) from public.sales s
                            where s.business_id = v_biz and s.customer_id = x.id
                              and s.status in ('COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED')),
           updated_at = now()
     where x.id = c and x.business_id = v_biz;
  end loop;

  v_after := public._start_fresh_summary(v_biz, p_before);
  select * into v_actor from public.staff where business_id = v_biz and profile_id = auth.uid() limit 1;
  v_name := coalesce(v_actor.name, (select name from public.profiles where id = auth.uid()));
  insert into public.start_fresh_runs(business_id, before_at, ran_by, ran_by_name, counts)
    values (v_biz, p_before, auth.uid(), v_name, v_plan->'remove');
  insert into public.audit_log(business_id, action, actor_id, actor_name, details, at)
    values (v_biz, 'Start fresh', v_actor.id, v_name,
            'Removed everything dated before ' || to_char(p_before at time zone 'Asia/Manila', 'YYYY-MM-DD HH24:MI') || ' (Manila): '
            || (v_plan->'remove')::text, now());
  return jsonb_build_object('done', true, 'before', p_before,
                            'removed', v_plan->'remove', 'kept', v_after->'keep',
                            'stock_changes', v_plan->'stock_changes');
end $$;

-- =============================================================================
-- E + A. Apply ONE counter upload: same as 008, with (marked "009"):
--   * sale: review flags OUT_OF_STOCK (section E) and BEFORE_START_FRESH (a
--     new sale dated before the shop's latest Start fresh moment: saved, but
--     flagged so the owner can check whether it is old test data);
--   * shift_close of a shift / refund of a sale that Start fresh removed, dated
--     before that moment: 'skipped' instead of an error (nothing to apply).
--     Shifts, pay-ins and sales are never dropped: one could be real work
--     from a counter whose clock is wrong.
-- Everything else is word-for-word the same as in 008.
-- =============================================================================
create or replace function public._fo_apply(p_biz uuid, p_dev public.devices, p_type text, p_d jsonb) returns text
language plpgsql volatile security definer set search_path = public as $$
declare
  v_sale jsonb; v_id uuid; v_old text; v_r jsonb; v_cust uuid; v_qr uuid; v_amount numeric;
  v_shift public.shifts%rowtype; v_ref jsonb; v_status text;
  v_appr public.staff; v_sale_row public.sales%rowtype; v_prev numeric; v_type text; v_new_status text;
  v_closer_name text; v_reason text; v_qo public.qr_orders%rowtype; v_performer uuid; v_performer_name text;
  v_signed uuid := public._signed_in_staff(p_dev.auth_user_id);   -- who signed in online on this counter (F8)
  v_limit numeric;
  v_rw jsonb; v_loy numeric := 0;   -- 008: loyalty reward on a sale
  v_fresh timestamptz := public._fresh_start_before(p_biz);   -- 009: latest Start fresh moment (or null)
begin
  -- fo_sync only lets a paired counter call us with its own device row
  if p_dev.auth_user_id is distinct from auth.uid() then raise exception 'DEVICE_MISMATCH'; end if;
  -- Refund caps (section 8b) are checked right after each row here, so a counter
  -- action that breaks one fails on its own (the next actions still run).
  set constraints public.refunds_cap_check_ins, public.refunds_cap_check_upd, public.stock_cap_check_ins,
    public.stock_cap_check_upd, public.stock_cap_check_del, public.sales_cap_check_upd immediate;
  case p_type
  when 'shift_open' then
    perform public._require_staff(p_biz, (p_d->>'cashier_id')::uuid, 1);
    perform public._write_row('shifts', p_d || jsonb_build_object('business_id', p_biz, 'device_id', p_dev.id,
      'store_id', p_dev.store_id, 'status', 'ACTIVE'), 'id', 'nothing', p_biz);
    return 'ok';

  when 'shift_close' then
    -- data = {id, closed_by, closed_at, declared_cash, ..., approval_token (only when
    --         closing SOMEONE ELSE's shift)}
    select * into v_shift from public.shifts where id = (p_d->>'id')::uuid and business_id = p_biz for update;
    if not found then
      -- 009: removed by Start fresh
      if v_fresh is not null and public._to_ts(p_d->>'closed_at') < v_fresh then return 'skipped'; end if;
      raise exception 'SHIFT_NOT_FOUND';
    end if;
    if v_shift.status = 'CLOSED' then return 'skipped'; end if;
    if nullif(p_d->>'closed_by', '')::uuid is distinct from v_shift.cashier_id then
      -- Closing another cashier's shift needs a manager approval, checked like refunds.
      -- The manager closing it is the one doing it (so their own sign-in token works).
      v_appr := public._use_approval(p_biz, p_dev.auth_user_id, nullif(p_d->>'closed_by', '')::uuid,
                                     p_d->>'approval_token', 'shift_close:' || v_shift.id,
                                     nullif(p_d->>'closed_by', '')::uuid);
      v_closer_name := v_appr.name;
    else
      -- Closing your own shift: no approval needed.
      perform public._require_staff(p_biz, v_shift.cashier_id, 1);
      select name into v_closer_name from public.staff where id = v_shift.cashier_id;
    end if;
    perform public._update_row('shifts', (p_d - 'cashier_id' - 'device_id' - 'opened_at' - 'opening_cash' - 'approval_token')
      || jsonb_build_object('status', 'CLOSED', 'closed_by_name', coalesce(v_closer_name, p_d->>'closed_by_name')), 'id', p_biz);
    return 'ok';

  when 'cash_movement' then
    perform public._require_staff(p_biz, (p_d->>'performed_by')::uuid, 1);
    -- 007: a pay-in / pay-out must be a real amount above ₱0. Missing, not a
    -- number, 0 or less -> AMOUNT_NOT_POSITIVE (before, the live rule
    -- "amount > 0" refused it with a database error, shown as SERVER_ERROR).
    if coalesce(public._to_num(p_d->>'amount'), 0) <= 0 then raise exception 'AMOUNT_NOT_POSITIVE'; end if;
    -- A pay-out above the shop's limit (settings.payout_review_limit, ₱1000 by
    -- default) is flagged for the owner to check (needs_review). Only the server sets it.
    select coalesce(payout_review_limit, 1000) into v_limit from public.settings where business_id = p_biz;
    perform public._write_row('cash_movements', p_d || jsonb_build_object('business_id', p_biz,
      'needs_review', upper(coalesce(p_d->>'type', '')) = 'PAY_OUT'
                      and coalesce(public._to_num(p_d->>'amount'), 0) > coalesce(v_limit, 1000)), 'id', 'nothing', p_biz);
    return 'ok';

  when 'sale' then
    -- data = {sale:{...}, items:[...], payment:{...}, inventory:[...],
    --         discount_approval_token: '...' (when the sale has a discount)}
    v_sale := p_d->'sale';
    if jsonb_typeof(v_sale) is distinct from 'object' then raise exception 'BAD_SALE'; end if;
    v_id := (v_sale->>'id')::uuid;
    if v_id is null then raise exception 'BAD_SALE'; end if;
    v_status := v_sale->>'status';
    if v_status is null or v_status not in ('HELD','COMPLETED') then raise exception 'BAD_SALE_STATUS'; end if;
    select status into v_old from public.sales where id = v_id and business_id = p_biz for update;
    -- the same sale sent again (e.g. a retry after a lost answer): nothing to do
    if v_old in ('COMPLETED','VOIDED','REFUNDED','PARTIALLY_REFUNDED') then return 'skipped'; end if;
    perform public._require_staff(p_biz, (v_sale->>'cashier_id')::uuid, 1);
    -- A QR order is paid ONCE. If it is already linked to ANOTHER sale (paid at a
    -- second counter, or twice offline), this sale is refused: QR_ORDER_ALREADY_PAID.
    -- (Paying it again is fine only if that earlier sale was voided.)
    -- "for update" makes two counters paying the same order at once wait for each other.
    -- A QR order of another shop (or one that doesn't exist) is simply not linked.
    v_qr := nullif(v_sale->>'qr_order_id', '')::uuid;
    if v_qr is not null then
      select * into v_qo from public.qr_orders where id = v_qr and business_id = p_biz for update;
      if not found then
        v_sale := v_sale || jsonb_build_object('qr_order_id', null);
        v_qr := null;
      elsif v_status = 'COMPLETED' and v_qo.sale_id is not null and v_qo.sale_id <> v_id
            and exists (select 1 from public.sales where id = v_qo.sale_id and status <> 'VOIDED') then
        raise exception 'QR_ORDER_ALREADY_PAID';
      end if;
    end if;
    -- A finished sale with a discount needs a manager approval that the server checks.
    if v_status = 'COMPLETED' and coalesce((v_sale->>'discount_amount')::numeric, 0) > 0 then
      -- The one doing it = the sale's cashier: a manager's own sign-in token approves
      -- only a sale rung up by that manager; for anyone else's sale, the manager's PIN.
      v_appr := public._use_approval(p_biz, p_dev.auth_user_id, nullif(v_sale->>'discount_approved_by', '')::uuid,
                                     p_d->>'discount_approval_token', 'discount:' || v_id,
                                     nullif(v_sale->>'cashier_id', '')::uuid);
      v_sale := v_sale || jsonb_build_object('discount_approved_by', v_appr.id, 'discount_approved_by_name', v_appr.name);
    end if;
    -- 008: a stamp-card reward used on this sale (data.sale.loyalty_reward =
    -- {customer_id, card_no, milestone, recipe_id}). Only a FINISHED sale uses
    -- one; the server checks it and works out its amount (_loyalty_reward_amount,
    -- else REWARD_NOT_AVAILABLE). The counter's sale.loyalty_discount must be that
    -- amount (else REWARD_AMOUNT_MISMATCH). Without a reward, loyalty_discount = 0.
    v_rw := v_sale->'loyalty_reward';
    v_sale := v_sale - 'loyalty_reward';
    if v_status = 'COMPLETED' and jsonb_typeof(v_rw) = 'object' then
      v_loy := public._loyalty_reward_amount(p_biz, v_id, v_sale, p_d->'items', v_rw);
      if public._to_num(v_sale->>'loyalty_discount') is null
         or abs(public._to_num(v_sale->>'loyalty_discount') - v_loy) > 0.02 then
        raise exception 'REWARD_AMOUNT_MISMATCH';
      end if;
    else
      v_rw := null;
    end if;
    v_sale := v_sale || jsonb_build_object('loyalty_discount', v_loy);
    -- 008 (M1): the server notes when it received a finished sale; the counter
    -- can't set it. A HELD sale gets none yet.
    v_sale := (v_sale - 'received_at') || case when v_status = 'COMPLETED'
                                                then jsonb_build_object('received_at', now()) else '{}'::jsonb end;
    -- A finished sale must add up (else SALE_TOTALS_MISMATCH). It is FLAGGED for
    -- review (not refused) when: sold below the menu (PRICE_BELOW_MENU /
    -- NOT_ON_MENU), tax / service charge differ from the settings (TAX_MISMATCH),
    -- the payment doesn't cover it (PAYMENT_MISMATCH), its cashier is not the
    -- person the server knows signed in on this counter (STAFF_MISMATCH), or
    -- (009) it takes an ingredient's stock below 0 (OUT_OF_STOCK: the money is
    -- already taken, so the sale is never refused for stock).
    -- Only the server sets the review flag and signed_in_staff_id.
    if v_status = 'COMPLETED' then
      perform public._check_sale_totals(v_sale, p_d->'items');
      v_reason := nullif(concat_ws(', ',
        public._sale_review_reason(p_biz, p_d->'items'),
        public._sale_money_review(p_biz, v_sale, p_d->'payment'),
        -- 008 (M1): a sale dated more than 1 hour in the future is flagged
        case when public._to_ts(v_sale->>'transaction_date') > now() + interval '1 hour' then 'FUTURE_DATE' end,
        case when v_signed is null or v_signed is distinct from nullif(v_sale->>'cashier_id', '')::uuid
             then 'STAFF_MISMATCH' end,
        -- 009: stock below 0 because of this sale
        public._sale_stock_review(p_biz, v_id, p_d->'inventory'),
        -- 009: a NEW sale dated before the shop's latest Start fresh moment (a
        -- counter that was offline, or whose clock is wrong). Saved, never
        -- dropped (it may be a real sale), but the owner checks it.
        case when v_old is null and v_fresh is not null
                  and public._to_ts(v_sale->>'transaction_date') < v_fresh then 'BEFORE_START_FRESH' end), '');
    end if;
    v_sale := v_sale || jsonb_build_object('needs_review', v_reason is not null, 'review_reason', v_reason,
                                           'signed_in_staff_id', v_signed);
    -- A customer link must point at one of THIS shop's customers (else it is dropped).
    v_cust := nullif(v_sale->>'customer_id', '')::uuid;
    if v_cust is not null and not exists (select 1 from public.customers where id = v_cust and business_id = p_biz) then
      v_sale := v_sale || jsonb_build_object('customer_id', null);
    end if;
    perform public._write_row('sales', v_sale || jsonb_build_object('business_id', p_biz, 'device_id', p_dev.id,
      'store_id', p_dev.store_id), 'id', 'update', p_biz);
    -- Replace THIS sale's own child rows. New child rows are only ever INSERTED:
    -- an id that already exists anywhere (another sale, a refund...) makes the
    -- whole action fail with FORBIDDEN_ROW, so nothing else can be overwritten.
    delete from public.sale_items where sale_id = v_id;
    for v_r in select value from jsonb_array_elements(coalesce(p_d->'items', '[]'::jsonb)) loop
      perform public._write_row('sale_items', v_r || jsonb_build_object('business_id', p_biz, 'sale_id', v_id), 'id', 'error', p_biz);
    end loop;
    delete from public.payments where sale_id = v_id;
    if jsonb_typeof(p_d->'payment') = 'object' then
      perform public._write_row('payments', (p_d->'payment') || jsonb_build_object('business_id', p_biz, 'sale_id', v_id), 'id', 'error', p_biz);
    end if;
    delete from public.inventory_transactions
      where business_id = p_biz and reference_id = v_id::text and transaction_type = 'SALE_USAGE';
    if v_status = 'COMPLETED' then
      for v_r in select value from jsonb_array_elements(coalesce(p_d->'inventory', '[]'::jsonb)) loop
        perform public._require_ingredient(p_biz, v_r);
        perform public._write_row('inventory_transactions', v_r || jsonb_build_object('business_id', p_biz,
          'reference_id', v_id::text, 'transaction_type', 'SALE_USAGE'), 'id', 'error', p_biz);
      end loop;
      -- 008: remember the reward as used (once per reward: a second sale using
      -- the same one -> REWARD_NOT_AVAILABLE)
      if v_rw is not null then
        begin
          insert into public.loyalty_redemptions(business_id, customer_id, card_no, milestone, reward_type, recipe_id, sale_id, amount)
            values (p_biz, public._to_uuid(v_rw->>'customer_id'), (v_rw->>'card_no')::int, (v_rw->>'milestone')::int,
                    (select r->>'type' from jsonb_array_elements(public._loyalty_config(p_biz)->'rewards') r
                      where (r->>'stamp')::int = (v_rw->>'milestone')::int limit 1),
                    case when public._to_uuid(v_rw->>'recipe_id') is not null
                          and exists (select 1 from jsonb_array_elements(public._loyalty_config(p_biz)->'rewards') r
                                      where (r->>'stamp')::int = (v_rw->>'milestone')::int and r->>'type' = 'FREE_ITEM')
                          and exists (select 1 from public.recipes where id = public._to_uuid(v_rw->>'recipe_id') and business_id = p_biz)
                         then public._to_uuid(v_rw->>'recipe_id') end,
                    v_id, v_loy);
        exception when unique_violation then
          raise exception 'REWARD_NOT_AVAILABLE';
        end;
      end if;
      if v_qr is not null then
        update public.qr_orders
          set sale_id = v_id, paid_at = case when sale_id = v_id then coalesce(paid_at, now()) else now() end,
              status = case when status = 'PENDING' then 'PREPARING' else status end,
              accepted_at = coalesce(accepted_at, now())
          where id = v_qr and business_id = p_biz;
      end if;
      v_cust := nullif(v_sale->>'customer_id', '')::uuid;
      if v_cust is not null then
        update public.customers
          set visit_count = visit_count + 1,
              total_spent = total_spent + coalesce((v_sale->>'grand_total')::numeric, 0),
              last_order_at = greatest(coalesce(last_order_at, '-infinity'::timestamptz), coalesce((v_sale->>'transaction_date')::timestamptz, now())),
              updated_at = now()
          where id = v_cust and business_id = p_biz;
      end if;
    end if;
    return 'ok';

  when 'held_delete' then
    v_id := (p_d->>'id')::uuid;
    if exists (select 1 from public.sales where id = v_id and business_id = p_biz and status = 'HELD') then
      delete from public.sale_items where sale_id = v_id;
      delete from public.sales where id = v_id;
      return 'ok';
    end if;
    return 'skipped';

  when 'refund' then
    -- data = {refund:{id, sale_id, type, amount, items, approved_by, performed_by, ...},
    --         inventory:[...], approval_token: '...'}
    --   performed_by = the staff member signed in on the counter who does the refund.
    --   (sale_status is worked out here, not taken from the counter)
    v_ref := p_d->'refund';
    if jsonb_typeof(v_ref) is distinct from 'object' then raise exception 'BAD_REFUND'; end if;
    -- Only the owner's Back Office may mark a refund as imported old-app history.
    v_ref := v_ref - 'imported_at' - 'performed_by_name';
    v_id := (v_ref->>'id')::uuid;
    if v_id is null then raise exception 'BAD_REFUND'; end if;
    if exists (select 1 from public.refunds where id = v_id) then return 'skipped'; end if;
    -- Lock the sale: two refunds of the same sale are then checked one after the other.
    select * into v_sale_row from public.sales where id = (v_ref->>'sale_id')::uuid and business_id = p_biz for update;
    if not found then
      -- 009: the sale was removed by Start fresh
      if v_fresh is not null and public._to_ts(v_ref->>'date') < v_fresh then return 'skipped'; end if;
      raise exception 'SALE_NOT_FOUND';
    end if;
    if v_sale_row.status = 'VOIDED' then return 'skipped'; end if;
    if v_sale_row.status not in ('COMPLETED','PARTIALLY_REFUNDED') then raise exception 'SALE_NOT_REFUNDABLE'; end if;
    v_cust := v_sale_row.customer_id;
    v_type := v_ref->>'type';
    if v_type is null or v_type not in ('VOID','FULL_REFUND','PARTIAL_REFUND') then raise exception 'BAD_REFUND_TYPE'; end if;
    -- Who does it (optional with a typed manager PIN; needed with a sign-in token).
    v_performer := nullif(v_ref->>'performed_by', '')::uuid;
    if v_performer is not null then
      perform public._require_staff(p_biz, v_performer, 1);
      select name into v_performer_name from public.staff where id = v_performer;
    end if;
    -- Manager approval, checked by the server (and used up if it is a one-time token).
    -- A manager's own sign-in token works only when that manager does the refund.
    v_appr := public._use_approval(p_biz, p_dev.auth_user_id, nullif(v_ref->>'approved_by', '')::uuid,
                                   p_d->>'approval_token', 'refund:' || v_id, v_performer);
    -- Money cap: no more than what is left of the sale (1 centavo rounding allowed).
    v_amount := (v_ref->>'amount')::numeric;
    if v_amount is null or v_amount < 0 then raise exception 'BAD_AMOUNT'; end if;
    select round(coalesce(sum(greatest(amount, 0)), 0), 2) into v_prev from public.refunds where sale_id = v_sale_row.id;
    if v_amount > round(greatest(coalesce(v_sale_row.grand_total, 0) - v_prev, 0), 2) + 0.01 then raise exception 'REFUND_TOO_LARGE'; end if;
    -- Flag (not refuse) a refund whose performed_by is not the person the server
    -- knows signed in on this counter: STAFF_MISMATCH.
    v_reason := case when v_signed is null or v_signed is distinct from v_performer then 'STAFF_MISMATCH' end;
    perform public._write_row('refunds', v_ref || jsonb_build_object('business_id', p_biz, 'sale_id', v_sale_row.id,
      'amount', v_amount, 'approved_by', v_appr.id, 'approved_by_name', v_appr.name,
      'performed_by', v_performer, 'performed_by_name', v_performer_name,
      'signed_in_staff_id', v_signed, 'needs_review', v_reason is not null, 'review_reason', v_reason), 'id', 'error', p_biz);
    -- A refund that lists items gives back at most what the customer paid for
    -- them (after the discount, with tax / service charge): REFUND_TOO_LARGE.
    -- Same rule as the Back Office (section 8b). VOID / FULL_REFUND of everything
    -- = the whole amount left; a refund without items is capped only by that.
    perform public._check_refund(v_id);
    -- Stock put back: inserted only (never overwrites another row) ...
    for v_r in select value from jsonb_array_elements(coalesce(p_d->'inventory', '[]'::jsonb)) loop
      perform public._require_ingredient(p_biz, v_r);
      perform public._write_row('inventory_transactions', v_r || jsonb_build_object('business_id', p_biz,
        'reference_id', v_id::text, 'transaction_type', 'SALE_REVERSAL'), 'id', 'error', p_biz);
    end loop;
    -- ... and, per ingredient, all refunds of this sale together can't put back
    -- more than this sale took out (RETURN_TOO_LARGE).
    perform public._check_sale_returns(v_sale_row.id);
    -- New status of the sale, from ALL its refunds: VOID -> VOIDED; refunded in
    -- full -> REFUNDED; otherwise PARTIALLY_REFUNDED.
    v_new_status := case when v_type = 'VOID' then 'VOIDED'
                         when v_prev + v_amount >= coalesce(v_sale_row.grand_total, 0) - 0.01 then 'REFUNDED'
                         else 'PARTIALLY_REFUNDED' end;
    update public.sales set status = v_new_status, updated_at = now() where id = v_sale_row.id;
    if v_cust is not null then
      update public.customers
        set total_spent = greatest(0, total_spent - v_amount),
            visit_count = case when v_type in ('VOID','FULL_REFUND') then greatest(0, visit_count - 1) else visit_count end,
            updated_at = now()
        where id = v_cust and business_id = p_biz;
    end if;
    return 'ok';

  when 'audit' then
    perform public._write_row('audit_log', p_d || jsonb_build_object('business_id', p_biz, 'signed_in_staff_id', v_signed), 'id', 'nothing', p_biz);
    return 'ok';

  when 'sold_out' then
    update public.recipes set sold_out = coalesce((p_d->>'sold_out')::boolean, false), updated_at = now()
      where id = (p_d->>'recipe_id')::uuid and business_id = p_biz;
    return 'ok';

  else
    raise exception 'UNKNOWN_OP: %', p_type;
  end case;
end $$;

-- =============================================================================
-- Who may call the new / re-made functions
-- =============================================================================
-- Every function this script makes is first locked, then opened only where meant:
--   logged-in users (each checks the caller's shop / role itself):
--     start_fresh_preview, start_fresh (owner only, checked inside),
--     fo_customer_list (paired counters only, checked inside)
--   anyone with a table QR code: get_qr_menu, qr_place_order (as in 004)
--   everything else here is internal (no API access).
do $$
declare f record;
  mine text[] := array['_valid_subcategory_order','_settings_check','_shop_is_open','get_qr_menu','qr_place_order',
    'fo_customer_list','_sale_stock_review','_fresh_start_before','_start_fresh_ids','_start_fresh_summary',
    '_require_owner','start_fresh_preview','start_fresh','_fo_apply'];
  member_fns text[] := array['start_fresh_preview','start_fresh','fo_customer_list'];
  public_fns text[] := array['get_qr_menu','qr_place_order'];
begin
  for f in
    select p.oid::regprocedure as sig, p.proname from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname = any(mine)
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    if f.proname = any(public_fns) then
      execute format('grant execute on function %s to anon, authenticated', f.sig);
    elsif f.proname = any(member_fns) then
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
  end loop;
end $$;

-- The new table: nobody writes it through the API (only start_fresh does).
revoke all on public.start_fresh_runs from anon;
revoke insert, update, delete, truncate on public.start_fresh_runs from authenticated;

commit;

-- Tell the API about the new column / functions right away.
notify pgrst, 'reload schema';
