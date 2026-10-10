// §18, §86: every application table has RLS enabled, and application roles hold no write privileges.
// This suite fails when a migration adds a table or function without the required controls.
import { describe, expect, it } from "vitest";
import { admin } from "../support/db";

const APP_SCHEMAS = [
  "core",
  "iam",
  "authz",
  "audit",
  "case_mgmt",
  "intake",
  "protected_identity",
  "workflow",
  "evidence",
  "config",
  "api",
  "public_api",
];
const APP_ROLES = ["anon", "authenticated", "cdf_bff", "cdf_portal"];

describe("RLS coverage", () => {
  it("enables RLS on every table in application schemas", async () => {
    const rows = await admin<{ table: string }[]>`
      select n.nspname || '.' || c.relname as table
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p') and n.nspname = any(${APP_SCHEMAS}) and not c.relrowsecurity`;
    expect(rows.map((r) => r.table)).toEqual([]);
  });

  it("grants no INSERT/UPDATE/DELETE/TRUNCATE on any table to application roles", async () => {
    const rows = await admin<{ grantee: string; table: string; privilege: string }[]>`
      select grantee, table_schema || '.' || table_name as table, privilege_type as privilege
      from information_schema.role_table_grants
      where grantee = any(${APP_ROLES}) and table_schema = any(${APP_SCHEMAS})
        and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')`;
    expect(rows).toEqual([]);
  });

  it("grants anon no table or column access at all", async () => {
    const rows = await admin<{ table: string }[]>`
      select distinct table_schema || '.' || table_name as table from information_schema.column_privileges
      where grantee in ('anon', 'cdf_portal') and table_schema = any(${APP_SCHEMAS})`;
    expect(rows).toEqual([]);
  });

  it("every table readable by authenticated has at least one SELECT policy", async () => {
    const rows = await admin<{ table: string }[]>`
      select distinct g.table_schema || '.' || g.table_name as table
      from information_schema.column_privileges g
      where g.grantee = 'authenticated' and g.privilege_type = 'SELECT' and g.table_schema = any(${APP_SCHEMAS})
        and not exists (select 1 from pg_policies p
                        where p.schemaname = g.table_schema and p.tablename = g.table_name
                          and p.cmd in ('SELECT', 'ALL') and 'authenticated' = any(p.roles))
        and not exists (select 1 from pg_views v where v.schemaname = g.table_schema and v.viewname = g.table_name)`;
    expect(rows).toEqual([]);
  });

  it("views run with the caller’s privileges (security_invoker)", async () => {
    const rows = await admin<{ view: string }[]>`
      select n.nspname || '.' || c.relname as view
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'v' and n.nspname = any(${APP_SCHEMAS})
        and not coalesce('security_invoker=true' = any(c.reloptions), false)`;
    expect(rows).toEqual([]);
  });

  it("the identity vault grants nothing to application roles", async () => {
    const rows = await admin<{ n: number }[]>`
      select count(*)::int as n from information_schema.role_table_grants
      where table_schema = 'protected_identity' and grantee = any(${APP_ROLES})`;
    expect(rows[0]!.n).toBe(0);
    const usage = await admin<{ role: string; usage: boolean }[]>`
      select r as role, has_schema_privilege(r, 'protected_identity', 'USAGE') as usage from unnest(${APP_ROLES}::text[]) r`;
    expect(usage.filter((u) => u.usage)).toEqual([]);
  });

  it("every SECURITY DEFINER function pins search_path to empty", async () => {
    const rows = await admin<{ fn: string }[]>`
      select p.oid::regprocedure::text as fn
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = any(${APP_SCHEMAS}) and p.prosecdef
        and not coalesce('search_path=""' = any(p.proconfig), false)`;
    expect(rows.map((r) => r.fn)).toEqual([]);
  });

  it("no application function is executable by PUBLIC", async () => {
    const rows = await admin<{ fn: string }[]>`
      select p.oid::regprocedure::text as fn
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = any(${APP_SCHEMAS})
        and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')`;
    expect(rows.map((r) => r.fn)).toEqual([]);
  });

  it("anon can execute exactly the four public portal functions", async () => {
    const rows = await admin<{ fn: string }[]>`
      select p.oid::regprocedure::text as fn
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = any(${APP_SCHEMAS}) and has_function_privilege('anon', p.oid, 'EXECUTE')
      order by 1`;
    expect(rows.map((r) => r.fn)).toEqual([
      "public_api.consume_rate_limit(text,integer,integer)",
      "public_api.get_report_status(text,text)",
      "public_api.post_reporter_message(text,text,text)",
      "public_api.submit_report(text,text,text,text,text,date,text,text,jsonb)",
    ]);
  });

  it("login roles are NOINHERIT and can only become their intended roles", async () => {
    const rows = await admin<{ login: string; inherit: boolean; member_of: string[] }[]>`
      select r.rolname as login, r.rolinherit as inherit,
             coalesce(array_agg(g.rolname order by g.rolname) filter (where g.rolname is not null), '{}') as member_of
      from pg_roles r
      left join pg_auth_members m on m.member = r.oid
      left join pg_roles g on g.oid = m.roleid
      where r.rolname in ('cdf_bff', 'cdf_portal')
      group by r.rolname, r.rolinherit order by 1`;
    expect(rows).toEqual([
      { login: "cdf_bff", inherit: false, member_of: ["anon", "authenticated"] },
      { login: "cdf_portal", inherit: false, member_of: ["anon"] },
    ]);
  });

  it("no application role bypasses RLS", async () => {
    const rows = await admin<{ rolname: string }[]>`
      select rolname from pg_roles where rolname = any(${APP_ROLES}) and (rolbypassrls or rolsuper)`;
    expect(rows).toEqual([]);
  });
});
