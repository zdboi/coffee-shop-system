-- =============================================================================
-- Cavite City Coffee Club — 007: batch 1 (clear answer for a pay-in / pay-out of ₱0)
-- -----------------------------------------------------------------------------
-- HOW TO RUN: Supabase → SQL Editor → New query → paste this WHOLE file → Run.
-- Run it AFTER 004, 005 and 006 (all already done on 2026-10-20). It is safe to
-- run more than once. It runs inside one transaction: if anything fails,
-- nothing is changed.
--
-- What it changes, in plain words:
--   When a counter uploads a pay-in or pay-out ("cash_movement") whose amount
--   is missing, not a number, ₱0 or less, the server used to fail with a
--   database error (the live rule "amount > 0"), which the counter only saw as
--   SERVER_ERROR ("Something went wrong"). Now that upload comes back as an
--   error with the clear code AMOUNT_NOT_POSITIVE ("The amount must be more
--   than ₱0."). Nothing is saved for it, exactly as before.
--
--   To do that, two server functions are re-created with ONLY these changes:
--     * _fo_apply      (applies one counter upload): one added check in the
--                      pay-in / pay-out part. Everything else in it (sales,
--                      refunds, approvals, sign-in tokens, stock lines...) is
--                      word-for-word the same as in 004.
--     * _fo_error_code (which error codes a counter may see): AMOUNT_NOT_POSITIVE
--                      added to the list.
--   fo_sync itself (the function the counter calls) is not changed.
--
-- What it does NOT change: no tables, no data, no CHECK rules, no permissions
-- (both functions stay internal: no app or customer can call them directly).
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Error codes a counter may see
-- -----------------------------------------------------------------------------
-- An upload that fails answers with one of these KNOWN codes; any other error
-- (a database text that could reveal how the database is built) becomes
-- SERVER_ERROR, and the real text goes to the server log only.
-- Same as 004, plus AMOUNT_NOT_POSITIVE (007).
create or replace function public._fo_error_code(p_msg text) returns text
language sql immutable as $$
  select case when c = any(array['DEVICE_MISMATCH','SHIFT_NOT_FOUND','UNKNOWN_STAFF','ROLE_TOO_LOW','APPROVAL_REQUIRED',
      'APPROVAL_INVALID','BAD_SALE','BAD_SALE_STATUS','QR_ORDER_ALREADY_PAID','SALE_TOTALS_MISMATCH','UNKNOWN_RECIPE',
      'UNKNOWN_INGREDIENT','FORBIDDEN_ROW','BAD_REFUND','SALE_NOT_FOUND','SALE_NOT_REFUNDABLE','BAD_REFUND_TYPE','BAD_AMOUNT',
      'REFUND_TOO_LARGE','RETURN_TOO_LARGE','SALE_LOCKED','UNKNOWN_OP','BAD_OP','PIN_UPDATE_NEEDED',
      'AMOUNT_NOT_POSITIVE'])
    then c else 'SERVER_ERROR' end
  from (select substring(coalesce(p_msg, '') from '^[A-Z][A-Z_]+') as c) x
$$;

-- -----------------------------------------------------------------------------
-- 2. Apply ONE counter upload (called by fo_sync for each upload)
-- -----------------------------------------------------------------------------
-- Same as 004, with one addition in the 'cash_movement' part (marked "007"):
-- the amount must be a number above 0, else AMOUNT_NOT_POSITIVE.
-- The check comes AFTER the "who did it" check, so a pay-in by an unknown
-- staff member still answers as before (UNKNOWN_STAFF / SERVER_ERROR).
-- Any error undoes everything this upload did (fo_sync runs each upload in its
-- own savepoint), so a refused pay-in / pay-out saves nothing.
create or replace function public._fo_apply(p_biz uuid, p_dev public.devices, p_type text, p_d jsonb) returns text
language plpgsql volatile security definer set search_path = public as $$
declare
  v_sale jsonb; v_id uuid; v_old text; v_r jsonb; v_cust uuid; v_qr uuid; v_amount numeric;
  v_shift public.shifts%rowtype; v_ref jsonb; v_status text;
  v_appr public.staff; v_sale_row public.sales%rowtype; v_prev numeric; v_type text; v_new_status text;
  v_closer_name text; v_reason text; v_qo public.qr_orders%rowtype; v_performer uuid; v_performer_name text;
  v_signed uuid := public._signed_in_staff(p_dev.auth_user_id);   -- who signed in online on this counter (F8)
  v_limit numeric;
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
    if not found then raise exception 'SHIFT_NOT_FOUND'; end if;
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
    -- A finished sale must add up (else SALE_TOTALS_MISMATCH). It is FLAGGED for
    -- review (not refused) when: sold below the menu (PRICE_BELOW_MENU /
    -- NOT_ON_MENU), tax / service charge differ from the settings (TAX_MISMATCH),
    -- the payment doesn't cover it (PAYMENT_MISMATCH), or its cashier is not the
    -- person the server knows signed in on this counter (STAFF_MISMATCH).
    -- Only the server sets the review flag and signed_in_staff_id.
    if v_status = 'COMPLETED' then
      perform public._check_sale_totals(v_sale, p_d->'items');
      v_reason := nullif(concat_ws(', ',
        public._sale_review_reason(p_biz, p_d->'items'),
        public._sale_money_review(p_biz, v_sale, p_d->'payment'),
        case when v_signed is null or v_signed is distinct from nullif(v_sale->>'cashier_id', '')::uuid
             then 'STAFF_MISMATCH' end), '');
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
    if not found then raise exception 'SALE_NOT_FOUND'; end if;
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

-- -----------------------------------------------------------------------------
-- 3. Who may call these
-- -----------------------------------------------------------------------------
-- Re-creating a function keeps its permissions, but to be sure: both are
-- internal helpers, only other server functions use them.
revoke all on function public._fo_error_code(text) from public, anon, authenticated;
revoke all on function public._fo_apply(uuid, public.devices, text, jsonb) from public, anon, authenticated;

commit;

-- Tell the API to refresh (harmless if nothing it knows about changed).
notify pgrst, 'reload schema';
