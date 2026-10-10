// §29, §21, CDF-67: audit.audit_event has one permissive SELECT policy, audit_event_read, whose USING is the
// OR of the three former policies (business/admin with AUDIT_VIEW, security with SECURITY_EVENT_VIEW, case
// team on business events of a visible case). Each branch is tested on its own, with synthetic fixture
// events of every category on a case one investigator can see and on no case, so a branch that widens
// (a category, a missing permission, a null case) fails here even when the seed has no such row.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { admin, caseId, ownerScenario, type UserKey } from "../support/db";

type Category = "BUSINESS" | "ADMIN" | "SECURITY";
type Scope = "case" | "none";
const CATEGORIES: Category[] = ["BUSINESS", "ADMIN", "SECURITY"];

// What each actor must see of the fixtures on seed case 0001 ("case") and with no case ("none").
// investigatorA is on the 0001 team and holds neither audit permission; investigatorB cannot see 0001.
const EXPECTED: Record<string, string[]> = {
  investigatorA: ["BUSINESS/case"],
  investigatorB: [],
  internalAudit: ["ADMIN/case", "ADMIN/none", "BUSINESS/case", "BUSINESS/none"],
  soc: ["SECURITY/case", "SECURITY/none"],
  dpo: ["ADMIN/case", "ADMIN/none", "BUSINESS/case", "BUSINESS/none", "SECURITY/case", "SECURITY/none"],
  platformAdmin: [],
  revoked: [],
};

describe("audit.audit_event read policy (CDF-67)", () => {
  it("has exactly one permissive SELECT policy for authenticated and no write policy", async () => {
    const policies = await admin<{ policyname: string; cmd: string; roles: string[]; permissive: string }[]>`
      select policyname, cmd, roles::text[] as roles, permissive
        from pg_policies where schemaname = 'audit' and tablename = 'audit_event'`;
    expect(policies).toEqual([
      { policyname: "audit_event_read", cmd: "SELECT", roles: ["authenticated"], permissive: "PERMISSIVE" },
    ]);
    const grants = await admin<{ grantee: string; privilege_type: string }[]>`
      select grantee, privilege_type from information_schema.role_table_grants
       where table_schema = 'audit' and table_name = 'audit_event' and grantee in ('anon', 'authenticated')
       order by 1, 2`;
    expect(grants).toEqual([{ grantee: "authenticated", privilege_type: "SELECT" }]);
  });

  it.each(Object.keys(EXPECTED))("%s sees exactly its branches of the fixture events", async (actor) => {
    const visibleCase = await caseId("0001");
    const marker = randomUUID();
    await ownerScenario(async (s) => {
      for (const category of CATEGORIES)
        for (const target of [visibleCase, null])
          await s.tx`select audit.record_event('ADMIN_ACTION', ${category}, 'SUCCESS', ${target}, 'synthetic',
            ${marker}, 'Synthetic CDF-67 fixture', '{}'::jsonb, 'SYSTEM')`;
      await s.as(actor as UserKey);
      const rows = await s.tx<{ category: Category; scoped: boolean }[]>`
        select category, case_id is not null as scoped from audit.audit_event where object_id = ${marker}`;
      const seen = rows.map((r) => `${r.category}/${(r.scoped ? "case" : "none") satisfies Scope}`).sort();
      expect(seen).toEqual(EXPECTED[actor]);
    });
  });

  it("the case-team branch admits only BUSINESS events of a case the member can see", async () => {
    const teamCase = await caseId("0001");
    const otherCase = await caseId("0003");
    const marker = randomUUID();
    await ownerScenario(async (s) => {
      for (const [category, target] of [
        ["BUSINESS", otherCase],
        ["ADMIN", teamCase],
        ["SECURITY", teamCase],
        ["BUSINESS", null],
      ] as const)
        await s.tx`select audit.record_event('ADMIN_ACTION', ${category}, 'SUCCESS', ${target}, 'synthetic',
          ${marker}, 'Synthetic CDF-67 fixture', '{}'::jsonb, 'SYSTEM')`;
      await s.as("investigatorA");
      expect(await s.tx`select seq from audit.audit_event where object_id = ${marker}`).toEqual([]);
    });
  });
});
