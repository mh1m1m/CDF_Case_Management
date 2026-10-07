// Threat T05 (storage URL guessing), §24, ADR-006: object storage is private and unreachable by
// application roles; only the database reveals object keys, and only to server code after authorization.
// Runs on the Supabase CLI stack and on plain PostgreSQL (where the compatibility shim provides storage.*).
import { describe, expect, it } from "vitest";
import { admin } from "../support/db";

const APP_ROLES = ["anon", "authenticated", "cdf_bff", "cdf_portal"];

describe("storage policy", () => {
  it("storage.objects and storage.buckets carry no policies for application roles", async () => {
    const rows = await admin<{ tablename: string; policyname: string; roles: string[] }[]>`
      select tablename, policyname, roles::text[] as roles from pg_policies where schemaname = 'storage'`;
    const offending = rows.filter((p) => p.roles.some((r) => APP_ROLES.includes(r) || r === "public"));
    expect(offending).toEqual([]);
  });

  it("application roles hold no table privileges in the storage schema", async () => {
    const rows = await admin<{ grantee: string; table_name: string; privilege_type: string }[]>`
      select grantee, table_name, privilege_type from information_schema.role_table_grants
      where table_schema = 'storage' and grantee = any(${APP_ROLES})`;
    expect(rows).toEqual([]);
  });

  it("no bucket is public, and evidence buckets (when present) are private", async () => {
    const rows = await admin<{ id: string; public: boolean }[]>`select id, public from storage.buckets`;
    expect(rows.filter((b) => b.public)).toEqual([]);
    for (const b of rows.filter((b) => b.id.startsWith("evidence-"))) expect(b.public).toBe(false);
  });

  it("object keys are constrained to the random cases/{case}/evidence/{item}/{version} scheme", async () => {
    const [row] = await admin<{ def: string }[]>`
      select pg_get_constraintdef(c.oid) as def from pg_constraint c
      join pg_class t on t.oid = c.conrelid join pg_namespace n on n.oid = t.relnamespace
      where n.nspname = 'evidence' and t.relname = 'evidence_version' and c.contype = 'c'
        and pg_get_constraintdef(c.oid) like '%object_key%'`;
    expect(row?.def).toContain("cases/");
    expect(row?.def).toContain("/evidence/");
    const unique = await admin<{ n: number }[]>`
      select count(*)::int as n from pg_indexes where schemaname = 'evidence' and tablename = 'evidence_version'
        and indexdef like '%UNIQUE%' and indexdef like '%object_key%'`;
    expect(unique[0]!.n).toBe(1);
  });

  it("only api.open_evidence_version can reveal an object key, and only to authenticated", async () => {
    const fns = await admin<{ fn: string; anon: boolean; auth: boolean }[]>`
      select p.oid::regprocedure::text as fn, has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('api', 'authz') and p.proname like '%evidence%' order by 1`;
    expect(fns.map((f) => f.fn)).toEqual([
      "api.complete_evidence_version(uuid,text,text)",
      "api.open_evidence_version(uuid)",
      "api.register_evidence_version(uuid,uuid,text,text,text,text,date,core.classification_level,text,text,bigint,text)",
      "api.reject_evidence_version(uuid,text,text,text)",
      "authz.can_download_evidence(uuid)",
      "authz.can_upload_evidence(uuid)",
      "authz.can_view_evidence(uuid)",
    ]);
    expect(fns.every((f) => f.auth && !f.anon)).toBe(true);
  });
});
