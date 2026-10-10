-- Schema fingerprint for drift checks (CDF-32, CEOM §11 Supabase rule). Read-only.
-- Run the same query on the local reference database (pnpm db:reset) and on the hosted project,
-- then compare the rows: equal fingerprints per (kind, schema) mean no drift in that bucket.
-- Covers function bodies and privileges, relations and columns, RLS flags, constraints, indexes,
-- triggers, policies, table/column/schema grants to application roles.
with
schemas as (
  select unnest(array['core','iam','authz','audit','intake','case_mgmt','workflow','config',
                      'protected_identity','api','public_api','evidence','forms']) as s
),
objs as (
  select 'function' as kind, n.nspname as schema,
         n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as name,
         md5(p.prosrc) || '|secdef=' || p.prosecdef || '|' || coalesce(array_to_string(p.proconfig, ','), '')
           || '|' || p.provolatile::text || '|' || pg_get_function_result(p.oid)
           || '|anon=' || has_function_privilege('anon', p.oid, 'EXECUTE')
           || '|auth=' || has_function_privilege('authenticated', p.oid, 'EXECUTE') as sig
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in (select s from schemas)
  union all
  select 'relation', n.nspname, n.nspname || '.' || c.relname,
         c.relkind::text || '|rls=' || c.relrowsecurity || '|force=' || c.relforcerowsecurity || '|' ||
         coalesce((select string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
                                     || case when a.attnotnull then ' not null' else '' end, ', ' order by a.attnum)
                   from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped), '')
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'v', 'S') and n.nspname in (select s from schemas)
  union all
  select 'constraint', n.nspname, n.nspname || '.' || c.relname || '.' || k.conname, pg_get_constraintdef(k.oid)
  from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in (select s from schemas)
  union all
  select 'index', i.schemaname, i.schemaname || '.' || i.indexname, i.indexdef
  from pg_indexes i where i.schemaname in (select s from schemas)
  union all
  select 'trigger', n.nspname, n.nspname || '.' || c.relname || '.' || t.tgname, pg_get_triggerdef(t.oid)
  from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
  where not t.tgisinternal and n.nspname in (select s from schemas)
  union all
  select 'policy', p.schemaname, p.schemaname || '.' || p.tablename || '.' || p.policyname,
         p.cmd || '|' || p.permissive || '|' || array_to_string(p.roles, ',') || '|' || coalesce(p.qual, '') || '|' || coalesce(p.with_check, '')
  from pg_policies p where p.schemaname in (select s from schemas)
  union all
  select 'table_grant', g.table_schema, g.table_schema || '.' || g.table_name || '->' || g.grantee,
         string_agg(g.privilege_type, ',' order by g.privilege_type)
  from information_schema.role_table_grants g
  where g.table_schema in (select s from schemas)
    and g.grantee in ('anon', 'authenticated', 'service_role', 'cdf_bff', 'cdf_portal', 'PUBLIC')
  group by 1, 2, 3
  union all
  select 'column_grant', g.table_schema, g.table_schema || '.' || g.table_name || '->' || g.grantee,
         string_agg(g.column_name || ':' || g.privilege_type, ',' order by g.column_name, g.privilege_type)
  from information_schema.column_privileges g
  where g.table_schema in (select s from schemas)
    and g.grantee in ('anon', 'authenticated', 'service_role', 'cdf_bff', 'cdf_portal', 'PUBLIC')
  group by 1, 2, 3
  union all
  select 'schema_grant', x.s, x.s || '->' || x.r, string_agg(x.priv, ',' order by x.priv)
  from (
    select s.s, r, p as priv
    from schemas s
    cross join unnest(array['anon', 'authenticated', 'service_role', 'cdf_bff', 'cdf_portal', 'public']) as r
    cross join unnest(array['USAGE', 'CREATE']) as p
    where exists (select 1 from pg_namespace where nspname = s.s) and has_schema_privilege(r, s.s, p)
  ) x
  group by 1, 2, 3
)
select kind, schema, count(*) as n, md5(string_agg(name || '=' || sig, E'\n' order by name collate "C")) as fingerprint
from objs
group by 1, 2
order by 1, 2;
