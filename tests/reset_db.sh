#!/bin/bash
# Recreate the test database: Supabase stub + user's existing schema + 004 migration
set -e
P="psql -h /tmp -p 54329 -U postgres -v ON_ERROR_STOP=1 -q"
psql -h /tmp -p 54329 -U postgres -q -c "drop database if exists cccc" -c "create database cccc" >/dev/null
for r in anon authenticated service_role authenticator; do psql -h /tmp -p 54329 -U postgres -q -d postgres -c "do \$\$ begin if exists (select 1 from pg_roles where rolname='$r') then execute 'drop owned by $r cascade'; end if; end \$\$" >/dev/null 2>&1 || true; done
$P -d cccc -c "do \$\$ begin if not exists (select 1 from pg_roles where rolname='anon') then null; end if; end \$\$" 
psql -h /tmp -p 54329 -U postgres -q -d cccc -f sql/00_supabase_stub.sql 2>&1 | grep -v "already exists" || true
$P -d cccc -f sql/01_existing_schema.sql
$P -d cccc -f /home/claude/repo/cccc/supabase/004_cccc_online_qr.sql
