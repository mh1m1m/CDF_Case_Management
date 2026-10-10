// CDF-62 · §22, ADR-004, threats T08/T21: reporter identity never reaches anything an application role can
// read. Every table and view readable by `authenticated` is scanned, as every synthetic user, for the identity
// values held in the vault, before and after a full dual-controlled reveal; so are the read APIs and the
// portal's own answers. A new table or column that copies identity fails this file without any change here.
import { beforeAll, describe, expect, it } from "vitest";
import type { Tx } from "@cdf/infrastructure";
import {
  USERS,
  admin,
  caseId,
  newReportRef,
  newSecret,
  portalScenario,
  scenario,
  secretHmac,
  type Scenario,
  type UserKey,
} from "../support/db";

let caseB: string;
let needles: string[] = [];
let readable: { table: string; columns: string[] }[] = [];

beforeAll(async () => {
  caseB = await caseId("0002");
  const vault = await admin<
    { wb_id: string; full_name: string | null; email: string | null; phone: string | null }[]
  >`
    select wb_id, full_name, email, phone from protected_identity.reporter_identity`;
  needles = vault
    .flatMap((v) => [v.full_name, v.email, v.phone])
    .filter((v): v is string => !!v && v.length >= 6)
    .map((v) => v.toLowerCase());
  // Every relation in an application schema with at least one column `authenticated` may select.
  const cols = await admin<{ table: string; column: string }[]>`
    select format('%I.%I', c.table_schema, c.table_name) as table, c.column_name as column
    from information_schema.columns c
    where c.table_schema in ('core', 'iam', 'authz', 'audit', 'intake', 'case_mgmt', 'workflow', 'evidence', 'protected_identity', 'public_api', 'api')
      and has_column_privilege('authenticated', format('%I.%I', c.table_schema, c.table_name), c.column_name, 'SELECT')
    order by 1, c.ordinal_position`;
  const byTable = new Map<string, string[]>();
  for (const c of cols) byTable.set(c.table, [...(byTable.get(c.table) ?? []), c.column]);
  readable = [...byTable].map(([table, columns]) => ({ table, columns }));
});

const ROLES: UserKey[] = (Object.keys(USERS) as UserKey[]).filter((u) => u !== "revoked");

/** Every readable row of every readable relation, as the current actor, as lower-case JSON text. */
async function readableText(tx: Tx): Promise<{ table: string; text: string }[]> {
  const out: { table: string; text: string }[] = [];
  for (const r of readable) {
    const list = r.columns.map((c) => `"${c.replaceAll('"', '""')}"`).join(", ");
    const rows = await tx.unsafe<{ j: string }[]>(
      `select row_to_json(t)::text as j from (select ${list} from ${r.table}) t`,
    );
    for (const row of rows) out.push({ table: r.table, text: row.j.toLowerCase() });
  }
  return out;
}

const hits = (rows: { table: string; text: string }[]) =>
  rows.flatMap((r) => needles.filter((n) => r.text.includes(n)).map((n) => `${r.table}: ${n}`));

async function revealOnCaseB(s: Scenario) {
  const justification = "Synthetic: need to contact the reporter about tender documents.";
  await s.as("grcDirector");
  const [req] = await s.tx<
    { id: string }[]
  >`select api.request_identity_reveal(${caseB}, ${justification}) as id`;
  await s.as("grcDeputy");
  await s.tx`select api.decide_identity_reveal(${req!.id}, true, 'Synthetic: approved for contact.')`;
  await s.as("grcDirector");
  return s.tx<
    { full_name: string; email: string }[]
  >`select * from api.resolve_reporter_identity(${caseB}, ${justification})`;
}

describe("identity never leaves the vault", () => {
  it("the seed holds identified reporters to look for", () => {
    expect(needles).toContain("reporter.gamma@example.test");
    expect(readable.length).toBeGreaterThan(10);
    expect(readable.some((r) => r.table.startsWith("protected_identity."))).toBe(false);
  });

  it.each(ROLES)("no relation readable by %s contains a vault value", async (user) => {
    await scenario(async (s) => {
      await s.as(user);
      expect(hits(await readableText(s.tx))).toEqual([]);
    });
  });

  it("after a full approved reveal, only the resolver received identity, and nothing readable holds it", async () => {
    await scenario(async (s) => {
      const resolved = await revealOnCaseB(s);
      expect(resolved.map((r) => r.email)).toEqual(["reporter.gamma@example.test"]);
      const leaks: string[] = [];
      for (const user of ROLES) {
        await s.as(user);
        leaks.push(...hits(await readableText(s.tx)).map((h) => `${user} → ${h}`));
        const lists = await s.tx<{ j: string }[]>`
          select coalesce(json_agg(r)::text, '') as j from api.list_identity_reveal_requests(${caseB}) r`;
        const steps = await s.tx<{ j: string }[]>`
          select coalesce(json_agg(r)::text, '') as j from api.available_transitions(${caseB}) r`;
        for (const t of [lists[0]!.j, steps[0]!.j])
          leaks.push(...needles.filter((n) => t.toLowerCase().includes(n)).map((n) => `${user} → api: ${n}`));
      }
      expect(leaks).toEqual([]);
    });
  });

  it("the case team never learns that a reveal happened", async () => {
    await scenario(async (s) => {
      await revealOnCaseB(s);
      for (const user of ["investigatorB", "caseManager", "triage"] as UserKey[]) {
        await s.as(user);
        const seen = await s.tx<{ action: string }[]>`
          select action from audit.audit_event where action like 'IDENTITY%' or action like '%REVEAL%'`;
        expect(seen, user).toEqual([]);
        expect(await s.tx`select * from api.list_identity_reveal_requests(${caseB})`, user).toEqual([]);
      }
    });
  });
});

describe("the portal's answers carry no identity and no internal data", () => {
  it("status and message answers for an identified report contain neither identity nor case internals", async () => {
    await portalScenario(async (tx) => {
      const ref = newReportRef();
      const secret = newSecret();
      const identity = {
        full_name: "Reporter Lambda (synthetic)",
        email: "reporter.lambda@example.test",
        phone: "+966500000099",
      };
      await tx`select * from public_api.submit_report(${ref}, ${secretHmac(secret)}, 'FRAUD', null,
        'SYNTHETIC: Vendor Omega allegedly invoiced twice for the same delivery.', null, null, 'en', ${tx.json(identity)})`;
      await tx`select public_api.post_reporter_message(${ref}, ${secretHmac(secret)}, 'Synthetic follow-up from the reporter.')`;
      const [row] = await tx<{ s: Record<string, unknown> }[]>`
        select public_api.get_report_status(${ref}, ${secretHmac(secret)}) as s`;
      const text = JSON.stringify(row!.s).toLowerCase();
      for (const v of Object.values(identity)) expect(text).not.toContain(v.toLowerCase());
      // Coarse public facts only: no workflow state, case number, WB-ID, staff identity or secret material.
      expect(text).not.toMatch(/wbid-|cdf-demo-|@example\.test|secret_hmac|a0000000-/);
      expect(Object.keys(row!.s).sort()).toEqual(
        expect.not.arrayContaining([
          "case_id",
          "case_number",
          "current_state",
          "assignee",
          "reporter_wb_id",
          "identity",
        ]),
      );
    });
  });
});
