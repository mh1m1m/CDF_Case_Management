-- =============================================================================
-- 0100 Foundation: schemas, shared types, application login roles, default privileges
-- Requirements: §14, §18, §46, §47; ADR-002, ADR-003
-- =============================================================================

-- Application schemas. Nothing application-owned is placed in `public` (not exposed via PostgREST).
create schema if not exists core;               -- shared types
create schema if not exists iam;                -- users, roles, permissions
create schema if not exists authz;              -- central authorization functions
create schema if not exists audit;              -- append-only audit ledger
create schema if not exists case_mgmt;          -- case master and case relationships
create schema if not exists intake;             -- public reports and triage
create schema if not exists protected_identity; -- whistleblower identity vault
create schema if not exists workflow;           -- workflow engine
create schema if not exists config;             -- governed configuration
create schema if not exists api;                -- command/read functions for `authenticated`
create schema if not exists public_api;         -- command functions for `anon` (public portal)

comment on schema protected_identity is
  'Whistleblower identity vault (ADR-004). No grants to application roles. Access only via api.resolve_reporter_identity().';

-- -----------------------------------------------------------------------------
-- Shared types
-- -----------------------------------------------------------------------------
-- Ordered enum: comparison operators express "at least as sensitive as".
create type core.classification_level as enum ('INTERNAL', 'RESTRICTED', 'CONFIDENTIAL', 'SECRET');
comment on type core.classification_level is 'Machine-readable classification (§34). Order matters: INTERNAL < RESTRICTED < CONFIDENTIAL < SECRET.';

create type core.record_status as enum ('ACTIVE', 'SUSPENDED', 'REVOKED');

-- -----------------------------------------------------------------------------
-- Application login roles (ADR-002 / ADR-003)
--   NOINHERIT + no direct privileges: a connection that has not executed
--   SET ROLE can do nothing. Passwords are set out-of-band (scripts/db/reset.mjs
--   locally, operator runbook for hosted environments), never in migrations.
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'cdf_bff') then
    create role cdf_bff login noinherit nocreatedb nocreaterole;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'cdf_portal') then
    create role cdf_portal login noinherit nocreatedb nocreaterole;
  end if;
end
$$;

grant authenticated to cdf_bff;
grant anon to cdf_bff;      -- health checks only; anon can do nothing but public_api
grant anon to cdf_portal;   -- the public portal can never become `authenticated`

-- -----------------------------------------------------------------------------
-- Default privileges: deny by default.
-- PostgreSQL grants EXECUTE on new functions to PUBLIC; remove that for every
-- function created by the migration role. Grants are added explicitly per function.
-- -----------------------------------------------------------------------------
alter default privileges revoke execute on functions from public;

do $$
declare s text;
begin
  foreach s in array array['core','iam','authz','audit','case_mgmt','intake','protected_identity','workflow','config','api','public_api']
  loop
    execute format('revoke all on schema %I from public', s);
    execute format('alter default privileges in schema %I revoke all on tables from public, anon, authenticated', s);
    execute format('alter default privileges in schema %I revoke all on sequences from public, anon, authenticated', s);
    execute format('alter default privileges in schema %I revoke execute on functions from public, anon, authenticated', s);
  end loop;
end
$$;

-- Schema USAGE: authenticated may resolve objects in read/command schemas; RLS and grants still apply.
grant usage on schema core, iam, authz, audit, case_mgmt, intake, workflow, config, api to authenticated;
grant usage on schema core, public_api to anon;
-- protected_identity: no USAGE for anyone but the owner.
