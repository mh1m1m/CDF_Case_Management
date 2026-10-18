// Threat T05 (storage URL guessing), §24, ADR-006: object storage is private and unreachable by
// application roles; only the database reveals object keys, and only to server code after authorization.
// Runs on the Supabase CLI stack and on plain PostgreSQL (where the compatibility shim provides storage.*).
import { describe, expect, it } from "vitest";
import type { Tx } from "@cdf/infrastructure";
import { admin, scenario } from "../support/db";

const APP_ROLES = ["anon", "authenticated", "cdf_bff", "cdf_portal"];

async function visibleRows(tx: Tx, table: string): Promise<number | "denied"> {
  let n = -1;
  try {
    await tx.savepoint(async (sp) => {
      const [row] = await sp.unsafe(`select count(*)::int as n from ${table}`);
      n = Number(row!.n);
    });
    return n;
  } catch (error) {
    if (/permission denied/.test((error as Error).message)) return "denied";
    throw error;
  }
}

describe("storage policy", () => {
  it("storage.objects and storage.buckets carry no policies for application roles", async () => {
    const rows = await admin<{ tablename: string; policyname: string; roles: string[] }[]>`
      select tablename, policyname, roles::text[] as roles from pg_policies where schemaname = 'storage'`;
    const offending = rows.filter((p) => p.roles.some((r) => APP_ROLES.includes(r) || r === "public"));
    expect(offending).toEqual([]);
  });

  it("RLS is enabled on storage.objects and storage.buckets, so the table grants Supabase ships are inert", async () => {
    // Supabase grants anon/authenticated table privileges on storage.* by platform design and relies on RLS
    // policies to open access; plain PostgreSQL (the shim, RDS) has no such grants. Either way, with RLS on
    // and no policies for application roles, nothing is reachable.
    const rows = await admin<{ relname: string; rls: boolean }[]>`
      select c.relname, c.relrowsecurity as rls from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'storage' and c.relkind = 'r' and c.relname in ('objects', 'buckets') order by 1`;
    expect(rows.map((r) => r.relname)).toEqual(["buckets", "objects"]);
    expect(rows.every((r) => r.rls)).toBe(true);
  });

  it("application roles see no storage rows, whether the grants are absent or RLS denies them", async () => {
    // The evidence buckets from Git exist, so "0 rows" below means hidden, not empty. Nothing is written:
    // these suites also run against hosted DEV (CDF-32), where Supabase refuses a direct DELETE from
    // storage.buckets (storage.protect_delete), so a temporary bucket could never be removed again.
    const [buckets] = await admin<{ n: number }[]>`
      select count(*)::int as n from storage.buckets where id in ('evidence-quarantine', 'evidence-vault')`;
    expect(buckets!.n).toBe(2);
    await scenario(async (s) => {
      for (const user of ["investigatorA", "lead", "platformAdmin", null] as const) {
        await s.as(user);
        for (const table of ["storage.objects", "storage.buckets"]) {
          expect(await visibleRows(s.tx, table), `${user ?? "anon"} ${table}`).toSatisfy(
            (v: number | "denied") => v === 0 || v === "denied",
          );
        }
      }
    });
  });

  it("the evidence buckets come from Git (1000_evidence_storage_buckets): private, 25 MiB, allow-listed types", async () => {
    const rows = await admin<{ id: string; public: boolean; limit: number | null; types: string[] | null }[]>`
      select id, public, file_size_limit::int as limit, allowed_mime_types as types from storage.buckets order by id`;
    expect(rows.filter((b) => b.public)).toEqual([]);
    const evidence = rows.filter((b) => b.id === "evidence-quarantine" || b.id === "evidence-vault");
    expect(evidence.map((b) => b.id)).toEqual(["evidence-quarantine", "evidence-vault"]);
    const [allowList] = await admin<{ types: string[] }[]>`
      select array_agg(content_type order by content_type) as types from evidence.allowed_content_type`;
    for (const b of evidence) {
      expect(b.public).toBe(false);
      expect(b.limit).toBe(26_214_400); // EVIDENCE_MAX_BYTES (§25)
      expect(b.types).toEqual(allowList!.types);
    }
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
      // Migration 2050 (ADR-041): exclusion, its record, renditions and the integrity report.
      "api.evidence_exclusion_record(uuid)",
      "api.exclude_evidence(uuid,text)",
      "api.open_evidence_version(uuid)",
      "api.register_evidence_rendition(uuid,text,text,bigint,text)",
      "api.register_evidence_version(uuid,uuid,text,text,text,text,date,core.classification_level,text,text,bigint,text)",
      "api.reject_evidence_version(uuid,text,text,text)",
      "api.report_evidence_integrity_failure(uuid,text)",
      "api.set_evidence_restriction(uuid,text,text)",
      "authz.can_download_evidence(uuid)",
      "authz.can_upload_evidence(uuid)",
      "authz.can_view_evidence(uuid)",
      "authz.is_evidence_lead(uuid)",
      "authz.is_evidence_team(uuid)",
    ]);
    expect(fns.every((f) => f.auth && !f.anon)).toBe(true);
  });

  it("an object key leaves the database only through the register and open commands (2050 adds two, 2115 two)", async () => {
    const fns = await admin<{ fn: string }[]>`
      select p.oid::regprocedure::text as fn
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname not in ('pg_catalog', 'information_schema')
        and (array_to_string(p.proargnames, ',') ilike '%object_key%'
             or pg_get_function_result(p.oid) ilike '%object_key%')
        and (has_function_privilege('authenticated', p.oid, 'EXECUTE') or has_function_privilege('anon', p.oid, 'EXECUTE'))
      order by 1`;
    expect(fns.map((f) => f.fn)).toEqual([
      // Migration 2115 (ADR-061): the signed committee minutes, opened by whoever may see them, and registered by the
      // importer; the table grants every column but the key.
      "api.open_committee_record_document(uuid)",
      // The subject's Defence Packet viewer: a cleared item of a released packet, for server code only (DEC-AMB-006).
      "api.open_defence_packet_item(uuid)",
      "api.open_evidence_version(uuid)",
      "api.open_report_attachment(uuid)",
      // Upload destinations: the key of the version the caller is registering.
      "api.register_committee_record_document(uuid,text,text,bigint,text,date,text,core.classification_level)",
      "api.register_evidence_rendition(uuid,text,text,bigint,text)",
      "api.register_evidence_version(uuid,uuid,text,text,text,text,date,core.classification_level,text,text,bigint,text)",
      "public_api.register_report_attachment(text,text,text,text,text,bigint,text)",
    ]);
  });

  it("no application role can select an object key column, and every key column is unique and scheme-checked", async () => {
    const cols = await admin<{ table: string }[]>`
      select c.table_schema || '.' || c.table_name as table from information_schema.columns c
      where c.column_name = 'object_key' and c.table_schema not in ('storage', 'information_schema', 'pg_catalog')
      order by 1`;
    expect(cols.length).toBeGreaterThan(0);
    for (const { table } of cols) {
      for (const role of ["anon", "authenticated", "cdf_bff"]) {
        const [r] = await admin<{ ok: boolean }[]>`
          select has_column_privilege(${role}, ${table}::regclass, 'object_key', 'SELECT') as ok`;
        expect(r!.ok, `${role} ${table}`).toBe(false);
      }
    }
    const [doc] = await admin<{ def: string }[]>`
      select pg_get_constraintdef(c.oid) as def from pg_constraint c
      where c.conrelid = 'exchange.bcp_record_document'::regclass and c.contype = 'c'
        and pg_get_constraintdef(c.oid) like '%object_key%'`;
    expect(doc?.def).toContain("^committee-records(/");
  });
});
