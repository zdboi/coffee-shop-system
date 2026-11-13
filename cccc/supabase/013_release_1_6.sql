-- =============================================================================
-- Cavite City Coffee Club — 013: release 1.6 ("Money", Wave 4)
-- -----------------------------------------------------------------------------
-- HOW TO RUN: Supabase → SQL Editor → New query → paste this WHOLE file → Run.
-- Run it AFTER 004 … 012 (all already done). It is safe to run more than
-- once. It runs inside one transaction: if anything fails, nothing is changed.
--
-- What it adds, in plain words (details: docs/handoff/contract-1.6.md):
--   B4   PAYMENT METHODS the owner can edit (settings.payment_methods). Starts as
--        Cash, GCash, QR payment, Card, Bank transfer (Maya and Other switched
--        off; old sales keep their method).
--   B5   EXTRA CHARGE PER PAYMENT METHOD: none, a % or a peso amount. On each
--        sale it is either added to the bill or waived. Either way the amount is
--        kept as the sale's "payment fee" (the provider's fee, a cost).
--   B19  SENIOR / PWD DISCOUNT: the shop's % (settings.senior_discount_pct, 20 to
--        start) on the customer's own items, with VAT taken out first when prices
--        include VAT. The name and ID number are required and kept in a table
--        only the owner's report can read. Not combined with another discount
--        or a stamp reward. No manager approval.
--   B20  SMART STOCK COUNT: only ticked items whose stock changed since their
--        last count (or not counted for settings.count_recheck_days days) are
--        due at Close shift. The SERVER decides the list.
--   B1 / B18  ONE MONEY REPORT (accounting_report) for the Accounting overview
--        and the Sales calendar, for any date range, with a row per day.
--
-- LIVE RULE REPLACED: payments.method was a word list ('CASH','GCASH',...).
-- It becomes a format rule (CAPITAL letters, digits, _ ; 2-20 characters), so
-- the owner can add methods. Every word already stored fits the new rule.
-- Every other new value goes into a NEW column or a NEW table.
-- =============================================================================

begin;

-- =============================================================================
-- 0. payments.method: word list -> format rule
-- =============================================================================
do $$
declare r record;
begin
  lock table public.payments in access exclusive mode;
  for r in
    select c.conname from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
    where c.conrelid = 'public.payments'::regclass and c.contype = 'c' and a.attname = 'method'
  loop
    execute format('alter table public.payments drop constraint %I', r.conname);
  end loop;
  -- (none expected) a stored word that would not fit is kept as OTHER
  update public.payments set method = 'OTHER' where method is not null and method !~ '^[A-Z][A-Z0-9_]{1,19}$';
  alter table public.payments add constraint payments_method_check
    check (method is null or method ~ '^[A-Z][A-Z0-9_]{1,19}$');
end $$;

-- =============================================================================
-- 1. NEW COLUMNS
-- =============================================================================
-- B4 / B5: the shop's payment methods, in display order (see contract A).
alter table public.settings add column if not exists payment_methods jsonb not null default
  '[{"id":"CASH","label":"Cash","active":true,"reference":false,"charge_type":"NONE","charge_value":0,"charge_default":"ADD"},
    {"id":"GCASH","label":"GCash","active":true,"reference":true,"charge_type":"NONE","charge_value":0,"charge_default":"ADD"},
    {"id":"QR","label":"QR payment","active":true,"reference":true,"charge_type":"NONE","charge_value":0,"charge_default":"ADD"},
    {"id":"CARD","label":"Card","active":true,"reference":true,"charge_type":"NONE","charge_value":0,"charge_default":"ADD"},
    {"id":"BANK","label":"Bank transfer","active":true,"reference":true,"charge_type":"NONE","charge_value":0,"charge_default":"ADD"},
    {"id":"MAYA","label":"Maya","active":false,"reference":true,"charge_type":"NONE","charge_value":0,"charge_default":"ADD"},
    {"id":"OTHER","label":"Other","active":false,"reference":true,"charge_type":"NONE","charge_value":0,"charge_default":"ADD"}]'::jsonb;
-- B19: the Senior / PWD discount % (0 = not offered).
alter table public.settings add column if not exists senior_discount_pct numeric not null default 20;
-- B20: a ticked item that didn't move is asked again after this many shop days.
alter table public.settings add column if not exists count_recheck_days integer not null default 7;

-- B19 on a sale: who (SENIOR / PWD), the total of that customer's items, the
-- VAT taken out of them, the discount. B5: the charge added to the bill and
-- the fee (= the charge worked out for the method, added or waived).
alter table public.sales add column if not exists senior_kind text;
alter table public.sales add column if not exists senior_items_amount numeric not null default 0;
alter table public.sales add column if not exists vat_exempt_amount numeric not null default 0;
alter table public.sales add column if not exists senior_discount numeric not null default 0;
alter table public.sales add column if not exists payment_charge numeric not null default 0;
alter table public.sales add column if not exists payment_fee numeric not null default 0;
alter table public.sales drop constraint if exists sales_senior_kind_check;
alter table public.sales add constraint sales_senior_kind_check check (senior_kind is null or senior_kind in ('SENIOR', 'PWD'));
-- the part of (VAT taken out + discount) that belongs to this line
alter table public.sale_items add column if not exists senior_discount numeric not null default 0;

-- B20: WHEN THE SERVER GOT a stock line (a counter's own created_at is the
-- counter's clock, and an offline sale arrives later). Old lines: their
-- created_at. Only the server sets it (trigger below).
do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'inventory_transactions' and column_name = 'received_at') then
    alter table public.inventory_transactions add column received_at timestamptz;
    update public.inventory_transactions set received_at = coalesce(created_at, now());
    alter table public.inventory_transactions alter column received_at set default now();
    alter table public.inventory_transactions alter column received_at set not null;
  end if;
end $$;
create index if not exists inventory_transactions_received_idx
  on public.inventory_transactions(business_id, ingredient_id, received_at);
create or replace function public._stamp_stock_received() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then new.received_at := now();
  else new.received_at := old.received_at; end if;
  return new;
end $$;
drop trigger if exists inventory_transactions_received on public.inventory_transactions;
create trigger inventory_transactions_received before insert or update on public.inventory_transactions
  for each row execute function public._stamp_stock_received();

-- =============================================================================
-- 2. B19: THE SENIOR / PWD RECORDS (owner's report only)
-- =============================================================================
-- One row per sale with a Senior / PWD discount. No API access at all: only
-- fo_sync writes it and only senior_report (owner) reads it. Removed with its
-- sale (Start fresh).
create table if not exists public.senior_discount_records (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  sale_id uuid not null unique references public.sales(id) on delete cascade,
  kind text not null check (kind in ('SENIOR', 'PWD')),
  holder_name text not null,
  id_number text not null,
  pct numeric,
  items_amount numeric not null default 0,
  vat_exempt_amount numeric not null default 0,
  discount_amount numeric not null default 0,
  cashier_id uuid,
  cashier_name text,
  created_at timestamptz not null default now()
);
create index if not exists senior_discount_records_business_idx on public.senior_discount_records(business_id, created_at);
alter table public.senior_discount_records enable row level security;
revoke all on public.senior_discount_records from public, anon, authenticated;

-- =============================================================================
-- 3. B4 / B5: PAYMENT METHODS IN THE SETTINGS
-- =============================================================================
-- true when p is a good payment method list (contract A).
create or replace function public._valid_payment_methods(p jsonb) returns boolean
language plpgsql immutable set search_path = public as $$
declare e jsonb; v_ids text[] := '{}'; v_id text; v_type text; v_val numeric; v_cash boolean := false;
begin
  if jsonb_typeof(p) is distinct from 'array' or jsonb_array_length(p) not between 1 and 12 then return false; end if;
  for e in select value from jsonb_array_elements(p) loop
    if jsonb_typeof(e) <> 'object' then return false; end if;
    v_id := e->>'id';
    if jsonb_typeof(e->'id') is distinct from 'string' or v_id !~ '^[A-Z][A-Z0-9_]{1,19}$' or v_id = any(v_ids) then return false; end if;
    v_ids := v_ids || v_id;
    if jsonb_typeof(e->'label') is distinct from 'string' or length(btrim(e->>'label')) not between 1 and 24
       or (e->>'label') ~ '[\x01-\x1F\x7F]' then return false; end if;
    if jsonb_typeof(e->'active') is distinct from 'boolean' then return false; end if;
    if (e ? 'reference') and jsonb_typeof(e->'reference') <> 'boolean' then return false; end if;
    v_type := e->>'charge_type';
    if v_type is null or v_type not in ('NONE', 'PERCENT', 'FIXED') then return false; end if;
    if (e ? 'charge_value') and jsonb_typeof(e->'charge_value') <> 'number' then return false; end if;
    v_val := coalesce((e->>'charge_value')::numeric, 0);
    if v_type = 'PERCENT' and not (v_val > 0 and v_val <= 25) then return false; end if;
    if v_type = 'FIXED' and not (v_val > 0 and v_val <= 1000) then return false; end if;
    if v_type = 'NONE' and v_val <> 0 then return false; end if;
    if (e ? 'charge_default') and coalesce(e->>'charge_default', '') not in ('ADD', 'WAIVE') then return false; end if;
    if v_id = 'CASH' then
      if not (e->>'active')::boolean or v_type <> 'NONE' then return false; end if;
      v_cash := true;
    end if;
  end loop;
  return v_cash;
exception when others then
  return false;
end $$;

-- One method of the shop's list ({} when it isn't there).
create or replace function public._payment_method(p_biz uuid, p_id text) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce((select e from public.settings s, jsonb_array_elements(s.payment_methods) e
                   where s.business_id = p_biz and e->>'id' = upper(coalesce(p_id, '')) limit 1), '{}'::jsonb)
$$;

-- Same as 012, plus the checks of the three new settings (at the end).
create or replace function public._settings_check() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public._valid_subcategory_colors(new.subcategory_colors) then raise exception 'BAD_SUBCATEGORY_COLORS'; end if;
  if not public._valid_subcategory_order(new.subcategory_order) then raise exception 'BAD_SUBCATEGORY_ORDER'; end if;
  if not public._valid_loyalty_rewards(new.loyalty_rewards) then raise exception 'BAD_LOYALTY_REWARDS'; end if;
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
    if not exists (select 1 from public.recipes where id = new.menu_highlight_recipe_id and business_id = new.business_id) then
      raise exception 'BAD_HIGHLIGHT';
    end if;
    if (tg_op = 'INSERT' or old.menu_highlight_recipe_id is distinct from new.menu_highlight_recipe_id)
       and not exists (select 1 from public.recipes where id = new.menu_highlight_recipe_id
                         and coalesce(active, true) and coalesce(pos_visible, true) and coalesce(qr_visible, true)
                         and coalesce(selling_price, 0) > 0) then
      raise exception 'BAD_HIGHLIGHT';
    end if;
  end if;

  -- 012: the barista calibration kit
  if new.barista_kit is null or jsonb_typeof(new.barista_kit) = 'null' then new.barista_kit := '[]'::jsonb; end if;
  if public._barista_kit_problem(new.business_id, new.barista_kit,
                                 tg_op = 'INSERT' or old.barista_kit is distinct from new.barista_kit) is not null then
    raise exception 'BAD_BARISTA_KIT';
  end if;
  new.barista_kit := coalesce((select jsonb_agg(jsonb_build_object('ingredient_id', public._to_uuid(l->>'ingredient_id'),
                                                                   'quantity', public._to_num(l->>'quantity'),
                                                                   'unit', nullif(btrim(l->>'unit'), '')) order by o)
                               from jsonb_array_elements(new.barista_kit) with ordinality x(l, o)), '[]'::jsonb);

  -- 013: payment methods (B4 / B5), the Senior / PWD % (B19), the count re-check days (B20)
  if new.payment_methods is null or jsonb_typeof(new.payment_methods) = 'null' then
    raise exception 'BAD_PAYMENT_METHODS';
  end if;
  if not public._valid_payment_methods(new.payment_methods) then raise exception 'BAD_PAYMENT_METHODS'; end if;
  new.payment_methods := (select jsonb_agg(jsonb_build_object(
                                   'id', e->>'id', 'label', btrim(e->>'label'), 'active', (e->>'active')::boolean,
                                   'reference', coalesce((e->>'reference')::boolean, false),
                                   'charge_type', e->>'charge_type',
                                   'charge_value', case when e->>'charge_type' = 'NONE' then 0 else (e->>'charge_value')::numeric end,
                                   'charge_default', coalesce(e->>'charge_default', 'ADD')) order by o)
                          from jsonb_array_elements(new.payment_methods) with ordinality x(e, o));
  if new.senior_discount_pct is null or new.senior_discount_pct < 0 or new.senior_discount_pct > 100 then
    raise exception 'BAD_SENIOR_PCT';
  end if;
  if new.count_recheck_days is null or new.count_recheck_days not between 1 and 60 then
    raise exception 'BAD_RECHECK_DAYS';
  end if;
  return new;
end $$;

-- =============================================================================
-- 4. SALE TOTALS (contract B)
-- =============================================================================
-- A finished sale must add up, else SALE_TOTALS_MISMATCH (as 008, plus the
-- payment charge and the Senior / PWD amounts). A Senior / PWD discount that
-- doesn't hold together -> BAD_SENIOR.
create or replace function public._check_sale_totals(p_sale jsonb, p_items jsonb) returns void
language plpgsql immutable set search_path = public as $$
declare
  c_tol constant numeric := 0.02;
  v_it jsonb; v_qty numeric; v_unit numeric; v_line numeric; v_sum numeric := 0;
  v_sub numeric; v_disc numeric; v_dtype text; v_dval numeric; v_expect numeric;
  v_tax numeric; v_svc numeric; v_grand numeric; v_bad boolean := false; v_loy numeric;
  v_sen numeric; v_vat numeric; v_a numeric; v_chg numeric; v_fee numeric; v_kind text;
  v_isd numeric; v_sd_sum numeric := 0; v_a_sum numeric := 0; v_sen_lines integer := 0; v_bad_sen boolean := false;
begin
  begin
    for v_it in select value from jsonb_array_elements(case when jsonb_typeof(p_items) = 'array' then p_items else '[]'::jsonb end) loop
      v_qty  := (v_it->>'quantity')::numeric;
      v_unit := (v_it->>'unit_price')::numeric;
      v_line := (v_it->>'line_total')::numeric;
      if v_qty is null or v_qty <= 0 or v_unit is null or v_unit < 0 or v_line is null
         or abs(v_line - v_unit * v_qty) > c_tol then
        v_bad := true;
      end if;
      v_sum := v_sum + coalesce(v_line, 0);
      v_isd := coalesce((v_it->>'senior_discount')::numeric, 0);
      if v_isd < 0 or v_isd > coalesce(v_line, 0) + c_tol then v_bad_sen := true; end if;
      if v_isd > 0 then
        v_sd_sum := v_sd_sum + v_isd; v_a_sum := v_a_sum + coalesce(v_line, 0); v_sen_lines := v_sen_lines + 1;
      end if;
    end loop;
    v_sub   := coalesce((p_sale->>'subtotal')::numeric, 0);
    v_disc  := coalesce((p_sale->>'discount_amount')::numeric, 0);
    v_dtype := lower(nullif(btrim(p_sale->>'discount_type'), ''));
    v_dval  := coalesce((p_sale->>'discount_value')::numeric, 0);
    v_tax   := coalesce((p_sale->>'tax_amount')::numeric, 0);
    v_svc   := coalesce((p_sale->>'service_charge_amount')::numeric, 0);
    v_grand := (p_sale->>'grand_total')::numeric;
    v_loy   := coalesce((p_sale->>'loyalty_discount')::numeric, 0);
    v_sen   := coalesce((p_sale->>'senior_discount')::numeric, 0);
    v_vat   := coalesce((p_sale->>'vat_exempt_amount')::numeric, 0);
    v_a     := coalesce((p_sale->>'senior_items_amount')::numeric, 0);
    v_chg   := coalesce((p_sale->>'payment_charge')::numeric, 0);
    v_fee   := coalesce((p_sale->>'payment_fee')::numeric, 0);
    v_kind  := nullif(btrim(p_sale->>'senior_kind'), '');
    v_expect := least(case v_dtype when 'percent' then v_sub * v_dval / 100 when 'fixed' then v_dval else 0 end, v_sub);
    if abs(v_sub - v_sum) > c_tol
       or v_disc < 0 or v_disc > v_sub + c_tol or abs(v_disc - v_expect) > c_tol
       or v_loy < 0 or v_loy > v_sub - v_disc + c_tol
       or v_tax < 0 or v_svc < 0
       or v_sen < 0 or v_vat < 0 or v_a < 0 or v_chg < 0 or v_fee < 0
       or (abs(v_chg) > c_tol and abs(v_chg - v_fee) > c_tol)
       or v_grand is null
       or abs(v_grand - (v_sub - v_disc - v_loy - v_vat - v_sen + v_tax + v_svc + v_chg)) > c_tol then
      v_bad := true;
    end if;
    if v_sen + v_vat > 0.005 then
      -- a Senior / PWD sale: never with another discount or a reward; its lines add up
      if v_kind is null or v_kind not in ('SENIOR', 'PWD')
         or v_disc > 0.005 or v_loy > 0.005
         or v_sen_lines = 0 or abs(v_a - v_a_sum) > c_tol
         or abs(v_sd_sum - (v_sen + v_vat)) > c_tol
         or v_sen + v_vat > v_a + c_tol then
        v_bad_sen := true;
      end if;
    elsif v_kind is not null or v_sd_sum > 0.005 or v_a > 0.005 then
      v_bad_sen := true;
    end if;
  exception when data_exception then
    v_bad := true;   -- e.g. a "number" that isn't a number
  end;
  if v_bad then raise exception 'SALE_TOTALS_MISMATCH'; end if;
  if v_bad_sen then raise exception 'BAD_SENIOR'; end if;
end $$;

-- What makes a finished sale "needs review" on the money side (as 008), with
--   TAX_MISMATCH        no tax is expected on Senior / PWD items
--   SENIOR_MISMATCH     the VAT taken out / the discount are not what the shop's
--                       settings give (or the shop's % is 0)
--   CHARGE_MISMATCH     the payment fee is not the method's charge in the settings
--   PAYMENT_METHOD_OFF  the method isn't in the shop's list or is switched off
create or replace function public._sale_money_review(p_biz uuid, p_sale jsonb, p_payment jsonb) returns text
language plpgsql stable security definer set search_path = public as $$
declare
  c_tol constant numeric := 0.02;
  v_s public.settings%rowtype; v_reasons text[] := '{}';
  v_after numeric; v_tax numeric; v_svc numeric; v_grand numeric;
  v_amt numeric; v_tend numeric; v_change numeric; v_method text;
  v_a numeric; v_vat numeric; v_sen numeric; v_ev numeric; v_ed numeric; v_t numeric;
  v_fee numeric; v_pre numeric; v_m jsonb; v_ef numeric := 0;
begin
  select * into v_s from public.settings where business_id = p_biz;
  v_a   := coalesce(public._to_num(p_sale->>'senior_items_amount'), 0);
  v_vat := coalesce(public._to_num(p_sale->>'vat_exempt_amount'), 0);
  v_sen := coalesce(public._to_num(p_sale->>'senior_discount'), 0);
  v_fee := coalesce(public._to_num(p_sale->>'payment_fee'), 0);
  v_t   := coalesce(v_s.tax_pct, 0) / 100;
  v_after := coalesce(public._to_num(p_sale->>'subtotal'), 0) - coalesce(public._to_num(p_sale->>'discount_amount'), 0)
             - coalesce(public._to_num(p_sale->>'loyalty_discount'), 0) - v_vat - v_sen;
  v_tax := case when coalesce(v_s.tax_inclusive, false) then 0 else greatest(v_after - greatest(v_a - v_vat - v_sen, 0), 0) * v_t end;
  v_svc := v_after * coalesce(v_s.service_charge_pct, 0) / 100;
  if abs(coalesce(public._to_num(p_sale->>'tax_amount'), 0) - v_tax) > c_tol
     or abs(coalesce(public._to_num(p_sale->>'service_charge_amount'), 0) - v_svc) > c_tol then
    v_reasons := v_reasons || 'TAX_MISMATCH'::text;
  end if;
  if v_vat + v_sen > 0.005 then
    v_ev := case when coalesce(v_s.tax_inclusive, false) and v_t > 0 then round(v_a - v_a / (1 + v_t), 2) else 0 end;
    v_ed := round((v_a - v_ev) * coalesce(v_s.senior_discount_pct, 0) / 100, 2);
    if coalesce(v_s.senior_discount_pct, 0) <= 0 or abs(v_vat - v_ev) > c_tol or abs(v_sen - v_ed) > c_tol then
      v_reasons := v_reasons || 'SENIOR_MISMATCH'::text;
    end if;
  end if;
  v_grand := round(coalesce(public._to_num(p_sale->>'grand_total'), 0), 2);
  if jsonb_typeof(p_payment) is distinct from 'object' then
    if v_grand > c_tol then v_reasons := v_reasons || 'PAYMENT_MISMATCH'::text; end if;
    if v_fee > c_tol then v_reasons := v_reasons || 'CHARGE_MISMATCH'::text; end if;
  else
    v_amt := public._to_num(p_payment->>'amount');
    v_tend := public._to_num(p_payment->>'tendered');
    v_change := public._to_num(p_payment->>'change');
    v_method := upper(coalesce(p_payment->>'method', ''));
    if v_amt is null or v_amt < v_grand - c_tol
       or (v_method <> 'CASH' and v_amt > v_grand + c_tol)
       or (v_method = 'CASH' and v_tend is not null and v_tend < v_grand - c_tol)
       or (v_method = 'CASH' and coalesce(v_change, 0) > greatest(coalesce(v_tend, v_amt, 0), v_amt) - v_grand + c_tol) then
      v_reasons := v_reasons || 'PAYMENT_MISMATCH'::text;
    end if;
    -- the method and its charge (a ₱0 sale has no real payment: not checked)
    if v_grand > c_tol or v_fee > c_tol then
      v_m := public._payment_method(p_biz, v_method);
      if not coalesce((v_m->>'active')::boolean, false) then
        v_reasons := v_reasons || 'PAYMENT_METHOD_OFF'::text;
      else
        v_pre := v_after + coalesce(public._to_num(p_sale->>'tax_amount'), 0) + coalesce(public._to_num(p_sale->>'service_charge_amount'), 0);
        v_ef := case when v_pre <= 0 then 0
                     when v_m->>'charge_type' = 'PERCENT' then round(v_pre * coalesce(public._to_num(v_m->>'charge_value'), 0) / 100, 2)
                     when v_m->>'charge_type' = 'FIXED' then coalesce(public._to_num(v_m->>'charge_value'), 0)
                     else 0 end;
      end if;
      if abs(v_fee - v_ef) > c_tol then v_reasons := v_reasons || 'CHARGE_MISMATCH'::text; end if;
    end if;
  end if;
  return nullif(array_to_string(v_reasons, ', '), '');
end $$;

-- Same as 008, plus the new money columns: none can change on a finished sale.
create or replace function public._lock_finished_sale() returns trigger
language plpgsql set search_path = public as $$
begin
  if old.status in ('COMPLETED', 'VOIDED', 'REFUNDED', 'PARTIALLY_REFUNDED')
     and (new.subtotal is distinct from old.subtotal
          or new.discount_type is distinct from old.discount_type
          or new.discount_value is distinct from old.discount_value
          or new.discount_amount is distinct from old.discount_amount
          or new.loyalty_discount is distinct from old.loyalty_discount
          or new.received_at is distinct from old.received_at
          or new.tax_amount is distinct from old.tax_amount
          or new.service_charge_amount is distinct from old.service_charge_amount
          or new.grand_total is distinct from old.grand_total
          or new.senior_kind is distinct from old.senior_kind
          or new.senior_items_amount is distinct from old.senior_items_amount
          or new.vat_exempt_amount is distinct from old.vat_exempt_amount
          or new.senior_discount is distinct from old.senior_discount
          or new.payment_charge is distinct from old.payment_charge
          or new.payment_fee is distinct from old.payment_fee
          or new.status is null or new.status = 'HELD') then
    raise exception 'SALE_LOCKED';
  end if;
  return new;
end $$;

-- The most a partial refund of these items may give back (as 004): what the
-- customer paid for them. A Senior / PWD line counts at its price minus its
-- own discount; the rest of the sale is shared in proportion, as before.
create or replace function public._refund_items_cap(p_sale public.sales, p_refund_id uuid, p_items jsonb, p_left numeric)
returns numeric language plpgsql stable security definer set search_path = public as $$
declare
  v_l numeric := 0; v_all boolean := true; r record;
  v_s numeric := round(coalesce(p_sale.subtotal, 0) - coalesce(p_sale.vat_exempt_amount, 0) - coalesce(p_sale.senior_discount, 0), 2);
  v_g numeric := greatest(round(coalesce(p_sale.grand_total, 0), 2), 0);
begin
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then return null; end if;
  for r in
    select greatest(coalesce(si.quantity, 0), 0) as sold,
           greatest(coalesce(si.unit_price, si.line_total / nullif(si.quantity, 0), 0), 0) as unit,
           greatest(coalesce(si.senior_discount, 0), 0) as sd,
           -- returned by the sale's other refunds
           coalesce((select sum(greatest(coalesce(public._to_num(it->>'quantity'), 0), 0))
                     from public.refunds o,
                          jsonb_array_elements(case when jsonb_typeof(o.items) = 'array' then o.items else '[]'::jsonb end) it
                     where o.sale_id = p_sale.id and o.id <> p_refund_id and it->>'sale_item_id' = si.id::text), 0) as before,
           -- returned now
           coalesce((select sum(greatest(coalesce(public._to_num(it->>'quantity'), 0), 0))
                     from jsonb_array_elements(p_items) it
                     where it->>'sale_item_id' = si.id::text), 0) as now
    from public.sale_items si
    where si.sale_id = p_sale.id and si.business_id = p_sale.business_id
  loop
    v_l := v_l + greatest(r.unit - case when r.sold > 0 then r.sd / r.sold else 0 end, 0)
                 * least(r.now, greatest(r.sold - r.before, 0));
    if r.before + r.now < r.sold - 0.0001 then v_all := false; end if;
  end loop;
  if v_all then return p_left; end if;
  if v_s <= 0 then return 0; end if;
  return least(p_left, round(v_l * v_g / v_s, 2));
end $$;

-- =============================================================================
-- 5. B20: SMART STOCK COUNT
-- =============================================================================
-- The ticked items that are DUE for a count, and why:
--   NEVER    never counted
--   MOVED    a stock line reached the server after its last count did
--            (lines made by a count itself don't count)
--   RECHECK  its last count is settings.count_recheck_days or more shop days old
-- p_shift: counts of THAT shift are ignored (so "is this shift's count
-- complete?" has one answer before and after the count arrives).
create or replace function public._count_due(p_biz uuid, p_shift uuid default null)
returns table(ingredient_id uuid, last_counted_at timestamptz, why text)
language sql stable security definer set search_path = public as $$
  with cfg as (
    select coalesce((select count_recheck_days from public.settings where business_id = p_biz), 7) as days
  ),
  i as (
    select x.id,
           (select max(sc.received_at) from public.stock_count_lines scl
              join public.stock_counts sc on sc.id = scl.count_id
             where scl.ingredient_id = x.id and sc.business_id = p_biz
               and (p_shift is null or sc.shift_id is distinct from p_shift)) as last_at
    from unnest(public._count_items(p_biz)) x(id)
  )
  select i.id, i.last_at,
         case when i.last_at is null then 'NEVER'
              when exists (select 1 from public.inventory_transactions t
                           where t.business_id = p_biz and t.ingredient_id = i.id and t.received_at > i.last_at
                             and not exists (select 1 from public.stock_line_owners o
                                             where o.txn_id = t.id and o.owner_kind = 'COUNT')) then 'MOVED'
              when public._shop_day(p_biz, now()) - public._shop_day(p_biz, i.last_at) >= (select days from cfg) then 'RECHECK'
         end
  from i
$$;

-- For a paired counter: which ticked items to ask at Close shift. Ids only
-- (the count stays blind: no amounts, no reasons).
create or replace function public.fo_count_due(p_shift_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_biz uuid := public.current_business_id();
begin
  if v_biz is null then raise exception 'NOT_A_MEMBER'; end if;
  if not public._is_active_counter(v_biz) then raise exception 'NOT_ALLOWED'; end if;
  return jsonb_build_object(
    'server_time', now(),
    'recheck_days', coalesce((select count_recheck_days from public.settings where business_id = v_biz), 7),
    'items', coalesce((select jsonb_agg(d.ingredient_id) from public._count_due(v_biz, p_shift_id) d where d.why is not null), '[]'::jsonb));
end $$;

-- For the owner: every ticked item, when it was last counted, whether it is due.
create or replace function public.bo_count_status() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_biz uuid := public._require_owner();
begin
  return coalesce((select jsonb_agg(jsonb_build_object('ingredient_id', d.ingredient_id, 'name', i.name,
                                                       'last_counted_at', d.last_counted_at, 'due', d.why is not null, 'why', d.why)
                                    order by i.name)
                   from public._count_due(v_biz, null) d join public.ingredients i on i.id = d.ingredient_id), '[]'::jsonb);
end $$;

-- =============================================================================
-- 6. COUNTER UPLOADS
-- =============================================================================
-- Error codes a counter may see: same as 012, plus (013)
--   BAD_SENIOR  a Senior / PWD discount that doesn't hold together, or without
--               the name and ID number
create or replace function public._fo_error_code(p_msg text) returns text
language sql immutable as $$
  select case when c = any(array['DEVICE_MISMATCH','SHIFT_NOT_FOUND','UNKNOWN_STAFF','ROLE_TOO_LOW','APPROVAL_REQUIRED',
      'APPROVAL_INVALID','BAD_SALE','BAD_SALE_STATUS','QR_ORDER_ALREADY_PAID','SALE_TOTALS_MISMATCH','UNKNOWN_RECIPE',
      'UNKNOWN_INGREDIENT','FORBIDDEN_ROW','BAD_REFUND','SALE_NOT_FOUND','SALE_NOT_REFUNDABLE','BAD_REFUND_TYPE','BAD_AMOUNT',
      'REFUND_TOO_LARGE','RETURN_TOO_LARGE','SALE_LOCKED','UNKNOWN_OP','BAD_OP','PIN_UPDATE_NEEDED',
      'AMOUNT_NOT_POSITIVE','REWARD_NOT_AVAILABLE','REWARD_AMOUNT_MISMATCH',
      'BAD_WASTE','BAD_WASTE_REASON','NOTE_REQUIRED','BAD_QUANTITY','BAD_UNIT',
      'COUNT_REQUIRED','BAD_COUNT','CARD_NOT_ISSUED','BAD_SENIOR'])
    then c else 'SERVER_ERROR' end
  from (select substring(coalesce(p_msg, '') from '^[A-Z][A-Z_]+') as c) x
$$;

-- Applies ONE counter upload (013). As _fo_apply_15 (012), except:
--   sale         with a Senior / PWD discount: data.senior = {kind, holder_name,
--                id_number} is required (BAD_SENIOR) and is saved in
--                senior_discount_records when the sale is saved.
--   stock_count  COUNT_INCOMPLETE now means: an item that is DUE (_count_due)
--                has no line in any count of this shift.
--   shift_close  COUNT_REQUIRED only when items are due and this shift has no
--                count at all. A shift whose counts miss due items closes, and
--                its latest count is flagged COUNT_INCOMPLETE.
create or replace function public._fo_apply_16(p_biz uuid, p_dev public.devices, p_type text, p_d jsonb) returns text
language plpgsql volatile security definer set search_path = public as $$
declare
  v_shift public.shifts%rowtype; v_cid uuid; v_staff uuid; v_staff_name text; v_at timestamptz; v_day date;
  v_fresh timestamptz; v_signed uuid; l jsonb; v_ing public.ingredients%rowtype; v_typed numeric; v_q numeric; v_exp numeric;
  v_seen uuid[] := '{}'; v_ticked uuid[]; v_reason text; v_extra boolean := false; v_orig_unit text;
  v_sale jsonb; v_sn jsonb; v_has_sen boolean := false; v_name text; v_idno text; v_due uuid[];   -- 013
begin
  if p_dev.auth_user_id is distinct from auth.uid() then raise exception 'DEVICE_MISMATCH'; end if;
  if p_type = 'shift_close' then
    select * into v_shift from public.shifts where id = public._to_uuid(p_d->>'id') and business_id = p_biz;
    if found and v_shift.status <> 'CLOSED' then
      -- 013 (B20): only DUE items need a count. No count at all -> refused.
      -- A count that misses due items: the shift closes, the count is flagged.
      v_due := array(select d.ingredient_id from public._count_due(p_biz, v_shift.id) d where d.why is not null);
      if cardinality(v_due) > 0 then
        if not exists (select 1 from public.stock_counts sc where sc.business_id = p_biz and sc.shift_id = v_shift.id) then
          raise exception 'COUNT_REQUIRED';
        end if;
        if exists (select 1 from unnest(v_due) t(id)
                   where not exists (select 1 from public.stock_count_lines scl
                                     join public.stock_counts sc on sc.id = scl.count_id
                                     where sc.business_id = p_biz and sc.shift_id = v_shift.id and scl.ingredient_id = t.id)) then
          update public.stock_counts
             set needs_review = true, review_reason = concat_ws(', ', review_reason, 'COUNT_INCOMPLETE')
           where id = (select sc.id from public.stock_counts sc
                        where sc.business_id = p_biz and sc.shift_id = v_shift.id
                        order by sc.received_at desc, sc.id limit 1)
             and coalesce(review_reason, '') !~ 'COUNT_INCOMPLETE';
        end if;
      end if;
    end if;
    return public._fo_apply(p_biz, p_dev, p_type, p_d);
  elsif p_type = 'waste' then
    v_cid := public._to_uuid(p_d->>'id');
    -- a counter waste may not reuse a stock count's id (M1) ...
    if exists (select 1 from public.stock_counts where id = v_cid) then raise exception 'FORBIDDEN_ROW'; end if;
    -- ... nor (B17) the id of a Back Office waste row, nor an id that stock
    -- lines already carry as their reference. (The same entry sent again is
    -- fine: it is skipped by _fo_apply, as before.)
    if v_cid is not null and not exists (select 1 from public.waste_logs where id = v_cid)
       and (exists (select 1 from public.waste where id = v_cid)
            or exists (select 1 from public.inventory_transactions where reference_id = v_cid::text)) then
      raise exception 'FORBIDDEN_ROW';
    end if;
    v_reason := public._fo_apply(p_biz, p_dev, p_type, p_d);
    -- B17: note which stock lines this entry made (so an edit / delete by the
    -- owner later removes exactly those)
    if v_reason = 'ok' and v_cid is not null then perform public._adopt_waste_lines(p_biz, v_cid, 'WASTE'); end if;
    return v_reason;
  elsif p_type = 'sale' then
    -- 013 (B19): a finished sale with a Senior / PWD discount needs the name and ID number
    v_sale := p_d->'sale';
    if jsonb_typeof(v_sale) = 'object' and v_sale->>'status' = 'COMPLETED'
       and coalesce(public._to_num(v_sale->>'senior_discount'), 0) + coalesce(public._to_num(v_sale->>'vat_exempt_amount'), 0) > 0.005 then
      v_has_sen := true;
      v_sn := p_d->'senior';
      v_name := btrim(regexp_replace(coalesce(v_sn->>'holder_name', ''), '[\x01-\x1F\x7F]', ' ', 'g'));
      v_idno := btrim(regexp_replace(coalesce(v_sn->>'id_number', ''), '[\x01-\x1F\x7F]', ' ', 'g'));
      if jsonb_typeof(v_sn) is distinct from 'object' or coalesce(v_sn->>'kind', '') not in ('SENIOR', 'PWD')
         or v_sn->>'kind' is distinct from v_sale->>'senior_kind'
         or length(v_name) not between 2 and 80 or length(v_idno) not between 3 and 40
         or coalesce(public._to_num(v_sale->>'discount_amount'), 0) > 0.005
         or coalesce(public._to_num(v_sale->>'loyalty_discount'), 0) > 0.005 then
        raise exception 'BAD_SENIOR';
      end if;
    end if;
    v_reason := public._fo_apply(p_biz, p_dev, p_type, p_d);
    if v_reason = 'ok' and v_has_sen then
      insert into public.senior_discount_records(business_id, sale_id, kind, holder_name, id_number, pct,
                                                 items_amount, vat_exempt_amount, discount_amount, cashier_id, cashier_name)
        select p_biz, x.id, x.senior_kind, v_name, v_idno,
               case when x.senior_items_amount - x.vat_exempt_amount > 0
                    then round(x.senior_discount / (x.senior_items_amount - x.vat_exempt_amount) * 100, 2) end,
               x.senior_items_amount, x.vat_exempt_amount, x.senior_discount, x.cashier_id, x.cashier_name
        from public.sales x where x.id = public._to_uuid(v_sale->>'id') and x.business_id = p_biz
        on conflict (sale_id) do nothing;
    end if;
    return v_reason;
  elsif p_type is distinct from 'stock_count' then
    return public._fo_apply(p_biz, p_dev, p_type, p_d);
  end if;

  -- ---- stock_count ----
  v_cid := public._to_uuid(p_d->>'id');
  if v_cid is null then raise exception 'BAD_COUNT'; end if;
  if exists (select 1 from public.stock_counts where id = v_cid and business_id = p_biz) then return 'skipped'; end if;
  if exists (select 1 from public.stock_counts where id = v_cid) then raise exception 'FORBIDDEN_ROW'; end if;
  -- the id of a waste entry or the reference of any stock line: refused (M1)
  if public._stock_ref_taken(v_cid) then raise exception 'FORBIDDEN_ROW'; end if;
  v_fresh := public._fresh_start_before(p_biz);
  v_at := coalesce(public._to_ts(p_d->>'counted_at'), now());
  select * into v_shift from public.shifts where id = public._to_uuid(p_d->>'shift_id') and business_id = p_biz;
  if not found then
    if v_fresh is not null and v_at < v_fresh then return 'skipped'; end if;   -- removed by Start fresh
    raise exception 'SHIFT_NOT_FOUND';
  end if;
  v_staff := public._to_uuid(p_d->>'staff_id');
  perform public._require_staff(p_biz, v_staff, 1);
  select name into v_staff_name from public.staff where id = v_staff;
  if jsonb_typeof(p_d->'lines') is distinct from 'array' or jsonb_array_length(p_d->'lines') not between 1 and 300 then
    raise exception 'BAD_COUNT';
  end if;
  v_ticked := public._count_items(p_biz);
  if cardinality(v_ticked) = 0 then raise exception 'BAD_COUNT'; end if;      -- nothing to count (L4)
  v_day := public._shop_day(p_biz, v_at);
  v_signed := public._signed_in_staff(p_dev.auth_user_id);
  insert into public.stock_counts(id, business_id, shift_id, device_id, staff_id, staff_name, signed_in_staff_id,
                                  counted_at, count_date, note)
    values (v_cid, p_biz, v_shift.id, p_dev.id, v_staff, v_staff_name, v_signed, v_at, v_day,
            left(nullif(btrim(p_d->>'note'), ''), 200));
  for l in select value from jsonb_array_elements(p_d->'lines') loop
    if jsonb_typeof(l) <> 'object' then raise exception 'BAD_COUNT'; end if;
    v_ing := public._ingredient_final(p_biz, public._to_uuid(l->>'ingredient_id'));
    if v_ing.id is null then raise exception 'UNKNOWN_INGREDIENT'; end if;
    if v_ing.id = any(v_seen) or public._is_expense_item(p_biz, v_ing.id) then raise exception 'BAD_COUNT'; end if;
    if not (v_ing.id = any(v_ticked)) then raise exception 'BAD_COUNT'; end if;   -- only ticked items (L4)
    v_seen := v_seen || v_ing.id;
    v_typed := public._to_num(l->>'quantity');
    if v_typed is null or v_typed < 0 or v_typed > 10000000 then raise exception 'BAD_QUANTITY'; end if;
    -- no unit typed = the stock unit of the item the counter named (an old
    -- counter may still name an ingredient that was merged since)
    select base_unit into v_orig_unit from public.ingredients where id = public._to_uuid(l->>'ingredient_id');
    v_q := public._to_base_qty(v_typed, coalesce(nullif(btrim(l->>'unit'), ''), v_orig_unit), v_ing.base_unit, v_ing.weight_g_per_ml);
    if v_q is null then raise exception 'BAD_UNIT'; end if;
    v_exp := round(public._stock_of(p_biz, v_ing.id), 6);
    if v_q - v_exp > 0.000001 then v_extra := true; end if;
    insert into public.stock_count_lines(business_id, count_id, ingredient_id, name, unit, entered_quantity, entered_unit,
                                         counted, expected, difference)
      values (p_biz, v_cid, v_ing.id, v_ing.name, v_ing.base_unit, v_typed, nullif(btrim(l->>'unit'), ''),
              v_q, v_exp, round(v_q - v_exp, 6));
  end loop;
  v_reason := nullif(concat_ws(', ',
    case when v_extra then 'COUNT_EXTRA' end,
    case when exists (select 1 from public._count_due(p_biz, v_shift.id) d
                      where d.why is not null
                        and not exists (select 1 from public.stock_count_lines scl
                                        join public.stock_counts sc on sc.id = scl.count_id
                                        where sc.business_id = p_biz and sc.shift_id = v_shift.id
                                          and scl.ingredient_id = d.ingredient_id)) then 'COUNT_INCOMPLETE' end,
    case when v_signed is null or v_signed is distinct from v_staff then 'STAFF_MISMATCH' end,
    case when v_at > now() + interval '1 hour' then 'FUTURE_DATE' end,
    case when v_at < now() - interval '7 days' then 'OLD_DATE' end,
    case when v_fresh is not null and v_at < v_fresh then 'BEFORE_START_FRESH' end,
    case when v_shift.status = 'CLOSED' then 'SHIFT_CLOSED' end), '');
  update public.stock_counts set needs_review = v_reason is not null, review_reason = v_reason where id = v_cid;
  perform public._apply_count_effects(v_cid);
  -- a large amount missing (more than the shop's pay-out review limit, ₱1000
  -- by default) is flagged too, so a big write-off never goes unnoticed:
  -- this count alone, or all counts of this shift together (so splitting a
  -- write-off into several small counts doesn't hide it)
  update public.stock_counts
     set needs_review = true, review_reason = concat_ws(', ', review_reason, 'LARGE_SHORTAGE')
   where id = v_cid
     and greatest(shortage_cost,
                  (select coalesce(sum(x.shortage_cost), 0) from public.stock_counts x
                    where x.business_id = p_biz and x.shift_id is not distinct from v_shift.id))
         > coalesce((select payout_review_limit from public.settings where business_id = p_biz), 1000);
  return 'ok';
end $$;

-- fo_sync: exactly as 012, but each upload goes through _fo_apply_16.
create or replace function public.fo_sync(p_device_key text, p_ops jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_biz uuid := public.current_business_id();
  v_role text; v_dev public.devices%rowtype;
  v_op jsonb; v_d jsonb; v_opid uuid; v_type text; v_status text; v_entity uuid; v_code text;
  v_out jsonb := '[]'::jsonb;
begin
  if v_uid is null or v_biz is null then raise exception 'NOT_A_MEMBER'; end if;
  select role into v_role from public.profiles where id = v_uid;
  if v_role is distinct from 'DEVICE' then raise exception 'NOT_ALLOWED'; end if;
  select * into v_dev from public.devices where device_key = p_device_key and business_id = v_biz;
  if not found or not v_dev.active then raise exception 'DEVICE_NOT_REGISTERED'; end if;
  if v_dev.auth_user_id is distinct from v_uid then raise exception 'DEVICE_MISMATCH'; end if;
  update public.devices set last_seen_at = now() where id = v_dev.id;

  if jsonb_typeof(p_ops) is distinct from 'array' then p_ops := '[]'::jsonb; end if;
  for v_op in select value from jsonb_array_elements(p_ops) loop
    v_opid := public._to_uuid(v_op->>'op_id');
    if v_opid is null then
      v_out := v_out || jsonb_build_array(jsonb_build_object('op_id', v_op->'op_id', 'status', 'error', 'message', 'BAD_OP'));
      continue;
    end if;
    v_type := v_op->>'type';
    v_d := case when jsonb_typeof(v_op->'data') = 'object' then v_op->'data' else '{}'::jsonb end;
    if exists (select 1 from public.sync_operations where operation_id = v_opid) then
      v_out := v_out || jsonb_build_array(jsonb_build_object('op_id', v_opid, 'status', 'duplicate'));
      continue;
    end if;
    begin
      v_status := public._fo_apply_16(v_biz, v_dev, v_type, v_d);
      v_entity := public._to_uuid(coalesce(nullif(v_d->>'id', ''), nullif(v_d->'sale'->>'id', ''), nullif(v_d->'refund'->>'id', ''), nullif(v_d->>'recipe_id', '')));
      insert into public.sync_operations(operation_id, business_id, device_id, entity_type, entity_id, operation_type, processed_at, result_summary)
        values (v_opid, v_biz, v_dev.id, v_type, v_entity, v_type, now(), v_status);
      v_out := v_out || jsonb_build_array(jsonb_build_object('op_id', v_opid, 'status', v_status));
    exception when others then
      v_code := public._fo_error_code(sqlerrm);
      if v_code = 'SERVER_ERROR' then
        raise log 'fo_sync op % (%) failed: % [%]', v_opid, v_type, sqlerrm, sqlstate;
      end if;
      v_out := v_out || jsonb_build_array(jsonb_build_object('op_id', v_opid, 'status', 'error', 'message', v_code));
    end;
  end loop;
  return v_out;
end $$;

-- =============================================================================
-- 7. REPORTS
-- =============================================================================
-- B1 / B18: the money of a range of shop days, with one row per day
-- (contract D). Owner only.
create or replace function public.accounting_report(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_biz uuid := public._require_owner();
  v_tz text; v_from_ts timestamptz; v_to_ts timestamptz;
  v_days jsonb; v_tot jsonb; v_by jsonb; v_reasons jsonb; v_methods jsonb; v_waived jsonb;
  v_var numeric; v_shifts integer;
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then raise exception 'BAD_RANGE'; end if;
  select coalesce(nullif(btrim(timezone), ''), 'Asia/Manila') into v_tz from public.settings where business_id = v_biz;
  v_tz := coalesce(v_tz, 'Asia/Manila');
  v_from_ts := p_from::timestamp at time zone v_tz;
  v_to_ts := (p_to + 1)::timestamp at time zone v_tz;

  with s as (
    select x.*, (coalesce(x.transaction_date, x.created_at) at time zone v_tz)::date as day
    from public.sales x
    where x.business_id = v_biz and x.status in ('COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED')
      and coalesce(x.transaction_date, x.created_at) >= v_from_ts and coalesce(x.transaction_date, x.created_at) < v_to_ts
  ),
  sd as (
    select day, count(*) as n, sum(coalesce(subtotal, 0)) as item_sales, sum(coalesce(discount_amount, 0)) as discounts,
           sum(coalesce(loyalty_discount, 0)) as loyalty, sum(coalesce(senior_discount, 0)) as senior,
           sum(coalesce(vat_exempt_amount, 0)) as vat_exempt, sum(coalesce(tax_amount, 0)) as tax,
           sum(coalesce(service_charge_amount, 0)) as svc, sum(coalesce(payment_charge, 0)) as charges,
           sum(coalesce(payment_fee, 0)) as fees, sum(coalesce(grand_total, 0)) as sales
    from s group by day
  ),
  rd as (
    select (coalesce(r.date, r.created_at) at time zone v_tz)::date as day,
           sum(case when r.type <> 'VOID' and x.status in ('COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED') then coalesce(r.amount, 0) else 0 end) as refunds,
           sum(case when r.type <> 'VOID' and x.status in ('COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED') and coalesce(x.grand_total, 0) > 0
                    then coalesce(r.amount, 0) * coalesce(x.tax_amount, 0) / x.grand_total else 0 end) as ref_tax,
           count(*) filter (where r.type = 'VOID') as void_count,
           sum(case when r.type = 'VOID' then coalesce(r.amount, 0) else 0 end) as voids
    from public.refunds r join public.sales x on x.id = r.sale_id
    where r.business_id = v_biz
      and coalesce(r.date, r.created_at) >= v_from_ts and coalesce(r.date, r.created_at) < v_to_ts
    group by 1
  ),
  inv as (
    select t.transaction_date as day, t.ingredient_id, t.transaction_type, sum(abs(t.quantity)) as q
    from public.inventory_transactions t
    where t.business_id = v_biz and t.transaction_date between p_from and p_to
      and t.transaction_type in ('SALE_USAGE', 'SALE_REVERSAL', 'WASTE')
    group by 1, 2, 3
  ),
  uc as (
    select x.ingredient_id, public._ingredient_unit_cost(v_biz, x.ingredient_id, p_to) as unit_cost
    from (select distinct ingredient_id from inv) x
  ),
  cd as (
    select inv.day,
           sum(case when inv.transaction_type = 'SALE_USAGE' then inv.q * uc.unit_cost
                    when inv.transaction_type = 'SALE_REVERSAL' then -inv.q * uc.unit_cost else 0 end) as sold,
           sum(case when inv.transaction_type = 'WASTE' then inv.q * uc.unit_cost else 0 end) as wasted
    from inv join uc using (ingredient_id) group by inv.day
  ),
  ed as (
    select expense_date as day, sum(amount) as expenses from public.expenses
    where business_id = v_biz and expense_date between p_from and p_to group by 1
  ),
  itd as (
    select s.day,
           -- a recipe without a type is a drink (same rule as the apps: recipeTypeOf)
           sum(case when r.id is not null and coalesce(r.recipe_type, 'DRINKS') = 'DRINKS' then coalesce(si.quantity, 0) else 0 end) as drinks,
           sum(case when r.recipe_type in ('PASTRY', 'FOOD') then coalesce(si.quantity, 0) else 0 end) as food,
           sum(case when r.id is null or r.recipe_type not in ('DRINKS', 'PASTRY', 'FOOD') then coalesce(si.quantity, 0) else 0 end) as other
    from s join public.sale_items si on si.sale_id = s.id and si.business_id = v_biz
    left join public.recipes r on r.id = si.recipe_id and r.business_id = v_biz
    group by s.day
  ),
  d as (
    select g.day::date as day,
           coalesce(sd.n, 0) as n, round(coalesce(sd.item_sales, 0), 2) as item_sales, round(coalesce(sd.discounts, 0), 2) as discounts,
           round(coalesce(sd.loyalty, 0), 2) as loyalty, round(coalesce(sd.senior, 0), 2) as senior,
           round(coalesce(sd.vat_exempt, 0), 2) as vat_exempt, round(coalesce(sd.tax, 0), 2) as tax, round(coalesce(sd.svc, 0), 2) as svc,
           round(coalesce(sd.charges, 0), 2) as charges, round(coalesce(sd.fees, 0), 2) as fees, round(coalesce(sd.sales, 0), 2) as sales,
           round(coalesce(rd.refunds, 0), 2) as refunds, round(coalesce(sd.tax, 0) - coalesce(rd.ref_tax, 0), 2) as tax_owed,
           coalesce(rd.void_count, 0) as void_count, round(coalesce(rd.voids, 0), 2) as voids,
           round(coalesce(cd.sold, 0), 2) as sold, round(coalesce(cd.wasted, 0), 2) as wasted,
           round(coalesce(ed.expenses, 0), 2) as expenses,
           coalesce(itd.drinks, 0) as drinks, coalesce(itd.food, 0) as food, coalesce(itd.other, 0) as other
    from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') g(day)
    left join sd on sd.day = g.day::date
    left join rd on rd.day = g.day::date
    left join cd on cd.day = g.day::date
    left join ed on ed.day = g.day::date
    left join itd on itd.day = g.day::date
  ),
  dn as (
    select d.*, d.sales - d.refunds as net_sales,
           d.sales - d.refunds - d.tax_owed - d.fees - d.sold - d.wasted - d.expenses as net_income
    from d
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'day', dn.day, 'sale_count', dn.n, 'sales', dn.sales, 'refunds', dn.refunds, 'net_sales', dn.net_sales,
           'void_count', dn.void_count, 'voids', dn.voids, 'waste', dn.wasted, 'ingredients_sold', dn.sold,
           'expenses', dn.expenses, 'payment_fees', dn.fees, 'tax_owed', dn.tax_owed, 'net_income', dn.net_income,
           'drinks', dn.drinks, 'food', dn.food, 'other', dn.other) order by dn.day), '[]'::jsonb),
         jsonb_build_object(
           'sale_count', coalesce(sum(dn.n), 0), 'item_sales', coalesce(sum(dn.item_sales), 0),
           'discounts', coalesce(sum(dn.discounts), 0), 'loyalty_rewards', coalesce(sum(dn.loyalty), 0),
           'senior_discounts', coalesce(sum(dn.senior), 0), 'vat_exempt', coalesce(sum(dn.vat_exempt), 0),
           'tax', coalesce(sum(dn.tax), 0), 'service_charge', coalesce(sum(dn.svc), 0),
           'payment_charges', coalesce(sum(dn.charges), 0), 'sales', coalesce(sum(dn.sales), 0),
           'refunds', coalesce(sum(dn.refunds), 0), 'net_sales', coalesce(sum(dn.net_sales), 0),
           'void_count', coalesce(sum(dn.void_count), 0), 'voids', coalesce(sum(dn.voids), 0),
           'tax_owed', coalesce(sum(dn.tax_owed), 0), 'payment_fees', coalesce(sum(dn.fees), 0),
           'charges_waived', coalesce(sum(dn.fees), 0) - coalesce(sum(dn.charges), 0),
           'ingredients_sold', coalesce(sum(dn.sold), 0), 'ingredients_wasted', coalesce(sum(dn.wasted), 0),
           'expenses', coalesce(sum(dn.expenses), 0), 'net_income', coalesce(sum(dn.net_income), 0),
           'items', jsonb_build_object('drinks', coalesce(sum(dn.drinks), 0), 'food', coalesce(sum(dn.food), 0),
                                       'other', coalesce(sum(dn.other), 0)))
    into v_days, v_tot from dn;

  -- expenses by category
  select coalesce(jsonb_object_agg(category, round(t, 2)), '{}'::jsonb) into v_by
    from (select category, sum(amount) as t from public.expenses
          where business_id = v_biz and expense_date between p_from and p_to group by category) x;

  -- waste by reason (costs as of p_to, like the totals; for information)
  select coalesce(jsonb_object_agg(reason, round(c, 2)), '{}'::jsonb) into v_reasons
    from (select coalesce(wl.reason, case when sc.id is not null then 'COUNT_SHORTAGE' end, 'OTHER') as reason,
                 sum(abs(t.quantity) * public._ingredient_unit_cost(v_biz, t.ingredient_id, p_to)) as c
          from public.inventory_transactions t
          left join public.waste_logs wl on wl.business_id = v_biz and wl.id::text = t.reference_id
          left join public.stock_counts sc on sc.business_id = v_biz and sc.id::text = t.reference_id
          where t.business_id = v_biz and t.transaction_date between p_from and p_to and t.transaction_type = 'WASTE'
          group by 1) x;

  -- payment methods of the counted sales
  select coalesce(jsonb_agg(jsonb_build_object('method', m.method, 'label', m.label, 'count', m.n, 'total', round(m.total, 2),
                                               'charges', round(m.charges, 2), 'fees', round(m.fees, 2),
                                               'waived', round(m.fees - m.charges, 2)) order by m.total desc, m.method), '[]'::jsonb)
    into v_methods
    from (select coalesce(p.method, '-') as method,
                 coalesce(nullif(public._payment_method(v_biz, p.method)->>'label', ''), initcap(lower(replace(coalesce(p.method, 'Not recorded'), '_', ' ')))) as label,
                 count(*) as n, sum(coalesce(x.grand_total, 0)) as total,
                 sum(coalesce(x.payment_charge, 0)) as charges, sum(coalesce(x.payment_fee, 0)) as fees
          from public.sales x
          left join lateral (select pp.method from public.payments pp where pp.sale_id = x.id order by pp.created_at limit 1) p on true
          where x.business_id = v_biz and x.status in ('COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED')
            and coalesce(x.transaction_date, x.created_at) >= v_from_ts and coalesce(x.transaction_date, x.created_at) < v_to_ts
          group by 1, 2) m;

  -- charges the shop waived (latest 200)
  select coalesce(jsonb_agg(to_jsonb(w) order by w.date desc), '[]'::jsonb) into v_waived
    from (select coalesce(x.transaction_date, x.created_at) as date, x.transaction_number,
                 (select pp.method from public.payments pp where pp.sale_id = x.id order by pp.created_at limit 1) as method,
                 round(coalesce(x.payment_fee, 0) - coalesce(x.payment_charge, 0), 2) as amount, x.cashier_name
          from public.sales x
          where x.business_id = v_biz and x.status in ('COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED')
            and coalesce(x.transaction_date, x.created_at) >= v_from_ts and coalesce(x.transaction_date, x.created_at) < v_to_ts
            and coalesce(x.payment_fee, 0) - coalesce(x.payment_charge, 0) > 0.005
          order by 1 desc limit 200) w;

  -- cash over / short of the shifts closed in the range
  select coalesce(sum(coalesce(cash_variance, 0)), 0), count(*) into v_var, v_shifts
    from public.shifts
    where business_id = v_biz and status = 'CLOSED' and closed_at >= v_from_ts and closed_at < v_to_ts;

  return jsonb_build_object(
    'from', p_from, 'to', p_to,
    'totals', v_tot || jsonb_build_object('expenses_by_category', v_by, 'waste_by_reason', v_reasons,
                                          'cash_over_short', round(v_var, 2), 'shifts_closed', v_shifts),
    'days', v_days, 'payment_methods', v_methods, 'waived_list', v_waived);
end $$;

-- B19: the Senior / PWD sales of a range of shop days (owner only; the only
-- place the full ID numbers can be read).
create or replace function public.senior_report(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_biz uuid := public._require_owner(); v_tz text; v_from_ts timestamptz; v_to_ts timestamptz;
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then raise exception 'BAD_RANGE'; end if;
  select coalesce(nullif(btrim(timezone), ''), 'Asia/Manila') into v_tz from public.settings where business_id = v_biz;
  v_tz := coalesce(v_tz, 'Asia/Manila');
  v_from_ts := p_from::timestamp at time zone v_tz;
  v_to_ts := (p_to + 1)::timestamp at time zone v_tz;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'date', coalesce(x.transaction_date, x.created_at), 'transaction_number', x.transaction_number, 'sale_id', x.id,
             'status', x.status, 'kind', r.kind, 'holder_name', r.holder_name, 'id_number', r.id_number,
             'items_amount', round(r.items_amount, 2), 'vat_exempt', round(r.vat_exempt_amount, 2),
             'discount', round(r.discount_amount, 2), 'pct', r.pct, 'grand_total', round(coalesce(x.grand_total, 0), 2),
             'cashier_name', coalesce(r.cashier_name, x.cashier_name))
           order by coalesce(x.transaction_date, x.created_at), x.transaction_number)
    from public.senior_discount_records r join public.sales x on x.id = r.sale_id
    where r.business_id = v_biz and x.business_id = v_biz and x.status <> 'VOIDED'
      and coalesce(x.transaction_date, x.created_at) >= v_from_ts and coalesce(x.transaction_date, x.created_at) < v_to_ts), '[]'::jsonb);
end $$;

-- =============================================================================
-- 8. WHO MAY CALL WHAT
-- =============================================================================
do $$
declare f record;
  -- (functions that existed before and are only re-made here keep the rights they had)
  mine text[] := array['_stamp_stock_received','_valid_payment_methods','_payment_method','_settings_check',
    '_count_due','fo_count_due','bo_count_status',
    '_fo_error_code','_fo_apply_16','fo_sync','accounting_report','senior_report'];
  member_fns text[] := array['fo_sync','fo_count_due','bo_count_status','accounting_report','senior_report'];
begin
  for f in
    select p.oid::regprocedure as sig, p.proname from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname = any(mine)
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    if f.proname = any(member_fns) then
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
  end loop;
end $$;

commit;

-- Tell the API about the new columns / functions right away.
notify pgrst, 'reload schema';
