-- Fixture for unit/partner_parity_check.js and unit/count_parity_check.js (release 1.5): stock items in kg / mL / L / pcs,
-- two production recipes, purchases on several days, a typed cost, a merged ingredient, a partner branch (TCO).
-- Loaded into the seeded shop (tests/e2e_reset.sh <db>) by those scripts.
select business_id as biz from public.profiles where id = '00000000-0000-0000-0000-0000000000a1' \gset
insert into categories(id,business_id,name,kind) values ('c0000000-0000-0000-0000-0000000000a1',:'biz','P15 stock','STOCK'),('c0000000-0000-0000-0000-0000000000a2',:'biz','P15 supplies','EXPENSE');
insert into ingredients(id,business_id,name,category_id,base_unit,active) values
 ('a0000000-0000-0000-0000-000000000001',:'biz','P15 Sugar','c0000000-0000-0000-0000-0000000000a1','kg',true),
 ('a0000000-0000-0000-0000-000000000002',:'biz','P15 Milk','c0000000-0000-0000-0000-0000000000a1','ml',true),
 ('a0000000-0000-0000-0000-000000000003',:'biz','P15 Arla','c0000000-0000-0000-0000-0000000000a1','L',true),
 ('a0000000-0000-0000-0000-000000000004',:'biz','P15 Napkin','c0000000-0000-0000-0000-0000000000a2','pcs',true),
 ('a0000000-0000-0000-0000-000000000005',:'biz','P15 Vanilla','c0000000-0000-0000-0000-0000000000a1','ml',true),
 ('a0000000-0000-0000-0000-000000000006',:'biz','P15 Syrup','c0000000-0000-0000-0000-0000000000a1','L',true),
 ('a0000000-0000-0000-0000-000000000007',:'biz','P15 Cake','c0000000-0000-0000-0000-0000000000a1','pcs',true);
update ingredients set is_produced_item=true where id in ('a0000000-0000-0000-0000-000000000006','a0000000-0000-0000-0000-000000000007');
insert into recipes(id,business_id,name,recipe_type,is_production_recipe,expected_yield,yield_unit,produced_ingredient_id,active) values
 ('b0000000-0000-0000-0000-000000000001',:'biz','P15 Syrup','SAUCES_SYRUPS',true,1.5,'L','a0000000-0000-0000-0000-000000000006',true),
 ('b0000000-0000-0000-0000-000000000002',:'biz','P15 Cake','PASTRY',true,12,'pcs','a0000000-0000-0000-0000-000000000007',true);
update ingredients set source_recipe_id='b0000000-0000-0000-0000-000000000001' where id='a0000000-0000-0000-0000-000000000006';
update ingredients set source_recipe_id='b0000000-0000-0000-0000-000000000002' where id='a0000000-0000-0000-0000-000000000007';
insert into recipe_ingredients(business_id,recipe_id,ingredient_id,quantity) values
 (:'biz','b0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000001',0.7),
 (:'biz','b0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002',333),
 (:'biz','b0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000003',0.25),
 (:'biz','b0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000004',3),
 (:'biz','b0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000005',7.5),
 (:'biz','b0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-000000000006',0.3),
 (:'biz','b0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-000000000001',1.1),
 (:'biz','b0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-000000000002',777);
insert into purchases(business_id,ingredient_id,purchase_date,quantity,purchase_unit,base_quantity,total_price,price_per_base_unit,created_at) values
 (:'biz','a0000000-0000-0000-0000-000000000001','2026-11-01',3,'kg',3,199,66.333333,'2026-11-01 10:00+08'),
 (:'biz','a0000000-0000-0000-0000-000000000001','2026-11-07',7,'kg',7,505.5,72.214286,'2026-11-07 10:00+08'),
 (:'biz','a0000000-0000-0000-0000-000000000002','2026-11-02',1000,'ml',1000,97.35,0.09735,'2026-11-02 10:00+08'),
 (:'biz','a0000000-0000-0000-0000-000000000002','2026-11-12',1000,'ml',1000,120,0.12,'2026-11-12 10:00+08'),
 (:'biz','a0000000-0000-0000-0000-000000000003','2026-11-03',1,'L',1,110,110,'2026-11-03 10:00+08');
insert into ingredient_costs(business_id,ingredient_id,standard_cost) values (:'biz','a0000000-0000-0000-0000-000000000005',0.85);
-- merge Arla (L) into Milk (mL) the way the merge does it
update ingredients set merged_into='a0000000-0000-0000-0000-000000000002', merged_at=now(), active=false where id='a0000000-0000-0000-0000-000000000003';
insert into suppliers(id,business_id,name,is_partner_branch) values ('d0000000-0000-0000-0000-000000000001',:'biz','TCO',true);
