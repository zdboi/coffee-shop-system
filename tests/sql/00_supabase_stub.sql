-- Minimal stand-in for the parts of Supabase our SQL relies on (TEST ONLY — never run on Supabase).
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create role authenticator login password 'test' noinherit;
grant anon, authenticated, service_role to authenticator;

create schema if not exists auth;
create schema if not exists extensions;
create schema if not exists storage;
create extension if not exists pgcrypto with schema extensions;

create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  encrypted_password text,
  is_anonymous boolean not null default false,
  raw_user_meta_data jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

create function auth.uid() returns uuid language sql stable as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::json->>'sub', '')::uuid
$$;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::json->>'role', 'anon')
$$;

grant usage on schema public, extensions, auth, storage to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;
grant execute on all functions in schema extensions to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

create table storage.buckets (id text primary key, name text, public boolean default false);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql immutable as $$
  select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'),1)-1]
$$;
grant all on storage.objects, storage.buckets to anon, authenticated, service_role;
