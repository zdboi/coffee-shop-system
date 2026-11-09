-- Helper for tests/sql/41_release_1_4_1_tests.sql (included with \ir): get_qr_menu as it was before 011 (test.old_get_qr_menu),
-- so 41 can compare old and new answers. From db-security-engineer's old_qr.sql, 2026-11-09. Not a suite on its own.
create or replace function test.old_get_qr_menu(p_token text) returns jsonb
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
