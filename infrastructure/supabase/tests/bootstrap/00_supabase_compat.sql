-- Supabase compatibility shim for plain PostgreSQL (ADR-008).
--
-- Hosted/CLI Supabase already provides these objects; on plain PostgreSQL 16 (local sandboxes,
-- fast CI, and as evidence of portability to Alibaba RDS PostgreSQL) this file creates the
-- minimum the migrations rely on. It is NEVER applied to a Supabase database.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

-- Supabase Storage stand-in (used from Phase 7). Mirrors the columns our policy tests inspect.
create schema if not exists storage;
create table if not exists storage.buckets (
  id text primary key,
  name text not null unique,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text,
  owner uuid,
  created_at timestamptz default now()
);
alter table storage.objects enable row level security;
alter table storage.buckets enable row level security;
