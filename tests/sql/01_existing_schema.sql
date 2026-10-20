-- Reconstruction of the user's CURRENT Supabase schema (001 + 002), built from the
-- information_schema / pg_policies output they pasted. Column lists are exact; keys,
-- foreign keys and CHECK constraints are educated guesses that deliberately include
-- the kinds of constraints the 004 migration has to cope with. TEST ONLY.

create table public.businesses (id uuid primary key default gen_random_uuid(), name text not null, created_at timestamptz default now());
create table public.stores (id uuid primary key default gen_random_uuid(), business_id uuid not null references public.businesses(id) on delete cascade, name text not null, address text, contact text, created_at timestamptz default now());
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  store_id uuid references public.stores(id),
  name text not null,
  role text not null default 'CASHIER' check (role in ('ADMIN','MANAGER','CASHIER')),
  pin_hash text, active boolean default true,
  created_at timestamptz default now(), updated_at timestamptz default now()
);
create table public.devices (id uuid primary key default gen_random_uuid(), business_id uuid not null references public.businesses(id) on delete cascade, store_id uuid references public.stores(id), device_tag text, device_name text, device_type text, last_seen_at timestamptz, created_at timestamptz default now());
create table public.settings (
  business_id uuid primary key references public.businesses(id) on delete cascade,
  currency text default 'PHP', costing_method text default 'weighted_average', low_stock_default_threshold numeric default 10, food_cost_warning_pct numeric default 35,
  business_name text default '', app_name text default 'Brew Ledger', logo_url text,
  primary_color text default '#241209', secondary_color text default '#33513f', accent_color text default '#c17a3d', background_color text default '#f7f1e6', card_color text default '#fffdf9', text_color text default '#2c1e14',
  font_family text default 'default', font_size text default 'medium',
  business_address text default '', business_contact text default '', tax_pct numeric default 0, service_charge_pct numeric default 0, tax_inclusive boolean default false,
  receipt_footer text default 'Thank you! Please come again.', backup_retain_count integer default 10, updated_at timestamptz default now()
);
create table public.categories (id uuid primary key default gen_random_uuid(), local_id text, business_id uuid not null references public.businesses(id) on delete cascade, name text not null, created_at timestamptz default now());
create table public.suppliers (id uuid primary key default gen_random_uuid(), local_id text, business_id uuid not null references public.businesses(id) on delete cascade, name text not null, contact text, phone text, email text, address text, notes text, created_at timestamptz default now());
create table public.ingredients (
  id uuid primary key default gen_random_uuid(), local_id text, business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null, category_id uuid references public.categories(id), supplier_id uuid references public.suppliers(id),
  base_unit text not null, reorder_level numeric default 0, notes text, is_produced_item boolean default false, source_recipe_id uuid,
  shelf_life_days integer, storage_notes text, active boolean default true, created_at timestamptz default now(), updated_at timestamptz default now()
);
create table public.recipes (
  id uuid primary key default gen_random_uuid(), local_id text, business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null, recipe_type text default 'DRINKS' check (recipe_type in ('DRINKS','SAUCES_SYRUPS','PASTRY','FOOD')), category text, selling_price numeric default 0, notes text,
  is_production_recipe boolean default false, expected_yield numeric, yield_unit text, production_instructions text,
  produced_ingredient_id uuid references public.ingredients(id), pos_visible boolean default true, modifier_groups jsonb default '[]'::jsonb,
  active boolean default true, created_at timestamptz default now(), updated_at timestamptz default now()
);
alter table public.ingredients add constraint ingredients_source_recipe_fk foreign key (source_recipe_id) references public.recipes(id);
create table public.recipe_ingredients (id uuid primary key default gen_random_uuid(), local_id text, business_id uuid not null references public.businesses(id) on delete cascade, recipe_id uuid not null references public.recipes(id) on delete cascade, ingredient_id uuid not null references public.ingredients(id), quantity numeric not null, unit text);
create table public.purchases (
  id uuid primary key default gen_random_uuid(), local_id text, business_id uuid not null references public.businesses(id) on delete cascade,
  ingredient_id uuid not null references public.ingredients(id), supplier_id uuid references public.suppliers(id), purchase_date date not null, invoice_number text,
  quantity numeric, purchase_unit text, base_quantity numeric, total_price numeric, price_per_base_unit numeric, notes text, created_at timestamptz default now()
);
create table public.inventory_transactions (
  id uuid primary key default gen_random_uuid(), local_id text, business_id uuid not null references public.businesses(id) on delete cascade,
  ingredient_id uuid not null references public.ingredients(id), transaction_type text not null check (transaction_type in ('PURCHASE','INITIAL_STOCK','USAGE','WASTE','ADJUSTMENT','PRODUCTION','PRODUCTION_USE','SALE_USAGE','SALE_REVERSAL')),
  quantity numeric not null, reference_id text, transaction_date date not null, notes text, created_at timestamptz default now()
);
create table public.waste (id uuid primary key default gen_random_uuid(), local_id text, business_id uuid not null references public.businesses(id) on delete cascade, ingredient_id uuid not null references public.ingredients(id), quantity numeric, unit text, reason text, date date, notes text);
create table public.production_batches (
  id uuid primary key default gen_random_uuid(), local_id text, business_id uuid not null references public.businesses(id) on delete cascade,
  recipe_id uuid references public.recipes(id), produced_ingredient_id uuid references public.ingredients(id), batch_number text, production_date date,
  expected_yield numeric, actual_yield numeric, yield_unit text, raw_cost_total numeric, actual_cost_per_unit numeric, waste_reason text, notes text, created_at timestamptz default now()
);
create table public.shifts (
  id uuid primary key default gen_random_uuid(), local_id text, business_id uuid not null references public.businesses(id) on delete cascade,
  store_id uuid references public.stores(id), device_id uuid references public.devices(id), cashier_id uuid references public.profiles(id), cashier_name text, shift_number text,
  opened_at timestamptz, closed_at timestamptz, status text default 'ACTIVE' check (status in ('ACTIVE','CLOSED')),
  opening_cash numeric, declared_cash numeric, expected_cash numeric, cash_variance numeric, gross_sales numeric, net_sales numeric, cash_sales numeric, card_sales numeric, other_sales numeric,
  refunds_total numeric, voids_total numeric, transaction_count integer, notes text, created_at timestamptz default now(), updated_at timestamptz default now()
);
create table public.sales (
  id uuid primary key default gen_random_uuid(), local_id text, business_id uuid not null references public.businesses(id) on delete cascade,
  store_id uuid references public.stores(id), device_id uuid references public.devices(id), shift_id uuid references public.shifts(id),
  transaction_number text, transaction_date timestamptz, status text check (status in ('HELD','COMPLETED','VOIDED','REFUNDED','PARTIALLY_REFUNDED')),
  cashier_id uuid references public.profiles(id), cashier_name text, subtotal numeric, discount_type text, discount_value numeric, discount_amount numeric,
  tax_amount numeric, service_charge_amount numeric, grand_total numeric, notes text, created_at timestamptz default now(), updated_at timestamptz default now()
);
create table public.sale_items (id uuid primary key default gen_random_uuid(), local_id text, business_id uuid not null references public.businesses(id) on delete cascade, sale_id uuid not null references public.sales(id) on delete cascade, recipe_id uuid references public.recipes(id), name text, quantity numeric, unit_price numeric, modifiers jsonb default '[]'::jsonb, line_total numeric, created_at timestamptz default now());
create table public.payments (id uuid primary key default gen_random_uuid(), local_id text, business_id uuid not null references public.businesses(id) on delete cascade, sale_id uuid not null references public.sales(id) on delete cascade, method text check (method in ('CASH','GCASH','CARD','OTHER')), amount numeric, tendered numeric, change numeric, reference text, status text, created_at timestamptz default now());
create table public.refunds (id uuid primary key default gen_random_uuid(), local_id text, business_id uuid not null references public.businesses(id) on delete cascade, sale_id uuid references public.sales(id), shift_id uuid references public.shifts(id), type text check (type in ('VOID','FULL_REFUND','PARTIAL_REFUND')), amount numeric, reason text, items jsonb, approved_by uuid references public.profiles(id), approved_by_name text, date timestamptz, notes text, created_at timestamptz default now());
create table public.cash_movements (id uuid primary key default gen_random_uuid(), local_id text, business_id uuid not null references public.businesses(id) on delete cascade, shift_id uuid references public.shifts(id), type text check (type in ('PAY_IN','PAY_OUT')), amount numeric, reason text, performed_by uuid references public.profiles(id), performed_by_name text, at timestamptz, created_at timestamptz default now());
create table public.audit_log (id uuid primary key default gen_random_uuid(), local_id text, business_id uuid not null references public.businesses(id) on delete cascade, action text, actor_id uuid references public.profiles(id), actor_name text, details text, reference_id text, at timestamptz default now());
create table public.sync_operations (operation_id uuid primary key, business_id uuid not null references public.businesses(id) on delete cascade, device_id uuid references public.devices(id), entity_type text, entity_id uuid, operation_type text, processed_at timestamptz default now(), result_summary text);
create table public.reconciliation_issues (id uuid primary key default gen_random_uuid(), business_id uuid not null references public.businesses(id) on delete cascade, ingredient_id uuid references public.ingredients(id), issue_type text, expected_stock numeric, actual_stock numeric, discrepancy numeric, related_transaction_ids jsonb, originating_devices jsonb, status text, detected_at timestamptz default now(), resolved_at timestamptz, resolved_by uuid references public.profiles(id), resolution_notes text);

-- 001 helper functions (exact bodies from the user's pg_proc output)
create or replace function public.current_business_id() returns uuid language sql stable security definer as $function$
  select business_id from profiles where id = auth.uid()
$function$;
create or replace function public.current_role_rank() returns integer language sql stable security definer as $function$
  select case (select role from profiles where id = auth.uid())
    when 'ADMIN' then 3 when 'MANAGER' then 2 when 'CASHIER' then 1 else 0 end
$function$;

-- 001 policies (exact, from pg_policies)
do $$ declare t text; begin
  foreach t in array array['audit_log','cash_movements','categories','devices','ingredients','inventory_transactions','payments','production_batches','purchases','recipe_ingredients','recipes','reconciliation_issues','sale_items','sales','settings','stores','suppliers','sync_operations','waste'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy business_isolation on public.%I using (business_id = current_business_id())', t);
  end loop;
end $$;
alter table public.businesses enable row level security;
create policy business_isolation on public.businesses using (id = current_business_id());
alter table public.profiles enable row level security;
create policy profiles_admin_insert on public.profiles for insert with check ((business_id = current_business_id()) and (current_role_rank() >= 3));
create policy profiles_select on public.profiles for select using (business_id = current_business_id());
create policy profiles_self_update on public.profiles for update using ((business_id = current_business_id()) and ((id = auth.uid()) or (current_role_rank() >= 3)));
alter table public.refunds enable row level security;
create policy refunds_insert on public.refunds for insert with check ((business_id = current_business_id()) and (current_role_rank() >= 2));
create policy refunds_select on public.refunds for select using (business_id = current_business_id());
alter table public.shifts enable row level security;
create policy shifts_insert on public.shifts for insert with check ((business_id = current_business_id()) and (cashier_id = auth.uid()));
create policy shifts_select on public.shifts for select using (business_id = current_business_id());
create policy shifts_update on public.shifts for update using ((business_id = current_business_id()) and ((cashier_id = auth.uid()) or (current_role_rank() >= 2)));

-- 002 signup trigger (exact body)
create or replace function public.handle_new_user_signup() returns trigger language plpgsql security definer set search_path to '' as $function$
declare
  new_business_id uuid;
  provided_business_name text;
  provided_admin_name text;
begin
  provided_business_name := coalesce(new.raw_user_meta_data->>'business_name', 'My Coffee Shop');
  provided_admin_name := coalesce(new.raw_user_meta_data->>'admin_name', new.email);
  insert into public.businesses (name) values (provided_business_name) returning id into new_business_id;
  insert into public.stores (business_id, name) values (new_business_id, 'Main Store');
  insert into public.settings (business_id) values (new_business_id);
  insert into public.profiles (id, business_id, name, role)
    values (new.id, new_business_id, provided_admin_name, 'ADMIN');
  return new;
end;
$function$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user_signup();

-- 003: the user's existing owner account ("Zedie Coffee" test signup)
insert into auth.users (id, email, raw_user_meta_data) values ('00000000-0000-0000-0000-0000000000a1', 'owner@example.com', '{"business_name":"Zedie Coffee","admin_name":"Zed"}');
