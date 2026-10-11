// UX redesign S1 (CDF-117, CDF-121, CDF-172; migration 1820; ADR-016 D0) · §18, §19, §21, §40: the sidebar,
// My Work and "My access" are read models over what the caller can already reach. An area needs a permission
// AND a live relationship; a work item exists only where the caller passes the command's own authz check;
// counts equal rows; administrators and oversight roles gain nothing from cases.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { Tx } from "@cdf/infrastructure";
import { USERS, caseId, ownerScenario, reportId, scenario, type Scenario, type UserKey } from "../support/db";

const REASON = "Synthetic: my-work read-model test.";
let caseA: string, caseSecret: string;
beforeAll(async () => {
  [caseA, caseSecret] = await Promise.all([caseId("0001"), caseId("0003")]);
});

interface Item {
  area: string;
  view: string;
  category: string;
  target_type: string;
  target_id: string;
  case_id: string | null;
  case_number: string | null;
}
interface Area {
  area_code: string;
  actionable_count: number;
  default_view: string;
}

const items = (tx: Tx) => tx<Item[]>`select * from api.my_work_items()`;
const areas = (tx: Tx) => tx<Area[]>`select * from api.my_areas()`;
async function areasOf(s: Scenario, user: UserKey) {
  await s.as(user);
  return (await areas(s.tx)).map((a) => a.area_code);
}
async function itemsOf(s: Scenario, user: UserKey) {
  await s.as(user);
  return items(s.tx);
}

describe("sidebar areas: permission AND live relationship, never a role name (G7)", () => {
  it("gives each seed user exactly the expected areas", async () => {
    const expected: Partial<Record<UserKey, string[]>> = {
      intake: ["MY_WORK", "INTAKE"],
      triage: ["MY_WORK", "INTAKE", "CASES"], // TRIAGE grants on cases before hand-over (display only)
      caseManager: ["MY_WORK", "CASES"], // Records only while a hold request waits for routing
      investigatorA: ["MY_WORK", "CASES"],
      lead: ["MY_WORK", "CASES"], // LEGAL_HOLD_REQUEST alone never gives Records
      committee: ["MY_WORK"], // CONFLICT_DECLARE alone never gives Cases
      // A COMMITTEE grant shows Cases until the Committee area exists (S5): the case is reachable today.
      committeeSecretary: ["MY_WORK", "CASES"],
      committeeChair: ["MY_WORK", "CASES"],
      legal: ["MY_WORK", "RECORDS"], // no Cases from CONFLICT_DECLARE or CASE_DISCOVER
      grcDirector: ["MY_WORK", "CASES", "RECORDS"],
      records: ["MY_WORK", "RECORDS"],
      internalAudit: ["OVERSIGHT"], // ARCHIVE_RECORD_VIEW with no catalogue row today: no Records
      soc: ["OVERSIGHT"],
      dpo: ["OVERSIGHT"],
      platformAdmin: ["ADMINISTRATION"], // never My Work, never a case area (§21)
      revoked: [],
    };
    await scenario(async (s) => {
      const wrong: string[] = [];
      for (const [user, want] of Object.entries(expected)) {
        const got = await areasOf(s, user as UserKey);
        if (JSON.stringify(got) !== JSON.stringify(want)) wrong.push(`${user}: ${got.join(",")}`);
      }
      expect(wrong).toEqual([]);
    });
  });

  it("counts equal the caller's own 'needs my action' rows; Oversight and Administration never count", async () => {
    await scenario(async (s) => {
      for (const user of Object.keys(USERS) as UserKey[]) {
        await s.as(user);
        const rows = (await items(s.tx)).filter((i) => i.view === "NEEDS_ACTION");
        for (const a of await areas(s.tx)) {
          const want =
            a.area_code === "OVERSIGHT" || a.area_code === "ADMINISTRATION"
              ? 0
              : a.area_code === "MY_WORK"
                ? rows.length
                : rows.filter((r) => r.area === a.area_code).length;
          expect(a.actionable_count, `${user} ${a.area_code}`).toBe(want);
        }
      }
    });
  });

  it("drops the triage officer's Cases item when the TRIAGE grants end", async () => {
    await ownerScenario(async (s) => {
      expect(await areasOf(s, "triage")).toContain("CASES");
      await s.asOwner();
      const grants = await s.tx<{ id: string; is_restricted: boolean }[]>`
        select g.id, c.is_restricted from case_mgmt.case_access_grant g
          join case_mgmt.case_record c on c.id = g.case_id
         where g.user_id = ${USERS.triage} and g.status = 'ACTIVE'`;
      expect(grants.length).toBeGreaterThan(0);
      // The case manager revokes on the cases it can see; the restricted case's named authority on that one.
      for (const g of grants) {
        await s.as(g.is_restricted ? "grcDirector" : "caseManager");
        await s.tx`select api.revoke_case_access(${g.id}, ${REASON})`;
      }
      expect(await areasOf(s, "triage")).not.toContain("CASES");
      await s.as("triage");
      const access = await s.tx<{ basis: string }[]>`select basis from api.my_access()`;
      expect(access.map((a) => a.basis)).not.toContain("GRANT");
    });
  });
});

describe("work items exist only where the caller passes the command's own check", () => {
  it("administrators and oversight roles get no work and no case-derived count", async () => {
    await scenario(async (s) => {
      for (const user of ["platformAdmin", "internalAudit", "soc", "dpo", "revoked"] as UserKey[])
        expect(await itemsOf(s, user), user).toEqual([]);
    });
  });

  it("never carries a title, name or narrative, only ids, codes and dates", async () => {
    await scenario(async (s) => {
      await s.as("investigatorB");
      const [row] = await s.tx<Record<string, unknown>[]>`select * from api.my_work_items() limit 1`;
      expect(Object.keys(row!).sort()).toEqual(
        [
          "area",
          "view",
          "category",
          "target_type",
          "target_id",
          "case_id",
          "case_number",
          "due_at",
          "due_source",
          "since_at",
        ].sort(),
      );
    });
  });

  it("routes a form to its reviewer, never back to its preparer (separation of duties)", async () => {
    await scenario(async (s) => {
      await s.as("investigatorA");
      const [{ id }] = (await s.tx`select api.start_form(${caseA}, 'WB-FRM-11', 'CONFIDENTIAL') as id`) as [
        { id: string },
      ];
      await s.tx`select * from api.save_form_draft(${id}, ${s.tx.json({
        evidence_count: "3",
        evidence_scope: "Synthetic evidence register scope",
        chain_of_custody_status: "مكتملة",
        storage_confirmation: "true",
      } as never)})`;
      await s.tx`select api.prepare_form(${id})`;
      const forUser = async (u: UserKey) => (await itemsOf(s, u)).filter((i) => i.target_id === id);
      expect((await forUser("lead")).map((i) => i.category)).toEqual(["FORM_TO_REVIEW"]);
      expect(await forUser("investigatorA")).toEqual([]); // the preparer
      expect(await forUser("committeeChair")).toEqual([]); // FORM_REVIEW, but not entitled to WB-FRM-11
      expect(await forUser("investigatorB")).toEqual([]); // no relationship to case A

      // Returned to the preparer, and gone from the reviewer's list.
      await s.as("lead");
      await s.tx`select api.review_form(${id}, 'RETURNED', ${REASON})`;
      expect((await forUser("investigatorA")).map((i) => i.category)).toEqual(["FORM_RETURNED"]);
      expect(await forUser("lead")).toEqual([]);
    });
  });

  it("shows a hold request to its requester as waiting, and to a router until it is routed", async () => {
    await scenario(async (s) => {
      await s.as("lead");
      const [{ id }] =
        (await s.tx`select api.request_legal_hold(${caseA}, 'LITIGATION', ${REASON + " Hold."}) as id`) as [
          { id: string },
        ];
      const of = async (u: UserKey) => (await itemsOf(s, u)).filter((i) => i.target_id === id);
      expect((await of("lead")).map((i) => `${i.view}/${i.category}`)).toEqual(["WAITING/MY_HOLD_REQUEST"]);
      expect((await of("caseManager")).map((i) => `${i.view}/${i.category}`)).toEqual([
        "NEEDS_ACTION/HOLD_REQUEST_TO_ROUTE",
      ]);
      expect(await areasOf(s, "caseManager")).toContain("RECORDS"); // a live Records item
      for (const u of ["investigatorA", "investigatorB", "legal", "records", "platformAdmin"] as UserKey[])
        expect(await of(u), u).toEqual([]);

      await s.as("caseManager");
      const [{ task }] =
        (await s.tx`select api.assign_legal_hold_request(${id}, ${USERS.legal}) as task`) as [
          { task: string },
        ];
      expect(await of("caseManager")).toEqual([]);
      expect(await areasOf(s, "caseManager")).not.toContain("RECORDS");
      await s.as("legal");
      expect((await items(s.tx)).filter((i) => i.target_id === task).map((i) => i.category)).toEqual([
        "TASK_LEGAL_HOLD_ASSESSMENT",
      ]);
      await s.as("legalB");
      expect((await items(s.tx)).filter((i) => i.target_id === task)).toEqual([]);
    });
  });

  it("keeps restricted and over-clearance cases out of a conflict manager's list", async () => {
    await scenario(async (s) => {
      const of = async (u: UserKey) =>
        (await itemsOf(s, u)).filter((i) => i.case_id === caseSecret).map((i) => i.category);
      // The SECRET demo case is restricted: GRC Deputy Mu has the clearance and CASE_VIEW_ALL but no named access.
      expect(await of("grcDeputy")).toEqual([]);
      // Its authority, GRC Director Zeta, lifts the restriction (still SECRET) and then declares a conflict.
      await s.as("grcDirector");
      await s.tx`select api.change_case_classification(${caseSecret}, 'SECRET', false, ${REASON})`;
      await s.tx`select api.declare_conflict(${caseSecret}, true, ${REASON})`;
      expect(await of("grcDeputy")).toContain("CONFLICT_TO_DECIDE"); // SECRET clearance, CONFLICT_MANAGE
      expect(await of("caseManager")).toEqual([]); // CONFLICT_MANAGE and CASE_VIEW_ALL, but CONFIDENTIAL clearance
      expect(await of("grcDirector")).toEqual([]); // the declarer: the conflict now hides the case from them
    });
  });

  it("keeps a restricted case to its named authority (DEC-01)", async () => {
    await scenario(async (s) => {
      const report = await reportId("WB-SEED00000005");
      await s.as("triage");
      await s.tx`select api.triage_report(${report}, 'OPEN_CASE', ${REASON}, null, null)`;
      expect((await items(s.tx)).filter((i) => i.target_id === report).map((i) => i.category)).toEqual([
        "CASE_TO_OPEN",
      ]);
      const [{ id }] = (await s.tx`
        select api.create_case_from_report(${report}, 'Restricted read-model probe', 'Synthetic restricted probe summary.',
          'CONFIDENTIAL'::core.classification_level, true, ${USERS.grcDirector}::uuid) as id`) as [
        { id: string },
      ];
      expect(
        (await itemsOf(s, "grcDirector"))
          .filter((i) => i.case_id === id)
          .map((i) => i.category)
          .sort(),
      ).toEqual(["CASE_STAGE_DUE", "DECLARE_CONFLICT", "MY_CASE", "UNASSIGNED_CASE"].sort());
      const leaks: string[] = [];
      for (const u of Object.keys(USERS) as UserKey[]) {
        if (u === "grcDirector") continue;
        const rows = (await itemsOf(s, u)).filter(
          (i) => i.case_id === id || i.target_id === id || i.target_id === report,
        );
        if (rows.length) leaks.push(`${u}: ${rows.map((r) => r.category).join(",")}`);
      }
      expect(leaks).toEqual([]);
    });
  });
});

describe("my access: the caller's own basis only", () => {
  it("lists the caller's roles, clearance and assignments, and nobody else's", async () => {
    await scenario(async (s) => {
      await s.as("investigatorA");
      const rows = await s.tx<{ basis: string; code: string; case_id: string | null }[]>`
        select basis, code, case_id from api.my_access()`;
      expect(rows).toEqual([
        { basis: "CLEARANCE", code: "CONFIDENTIAL", case_id: null },
        { basis: "ROLE", code: "INVESTIGATOR", case_id: null },
        { basis: "ASSIGNMENT", code: "INVESTIGATOR", case_id: caseA },
      ]);
      await s.as("platformAdmin");
      expect(
        (await s.tx<{ basis: string }[]>`select basis from api.my_access()`).map((r) => r.basis),
      ).toEqual(["CLEARANCE", "ROLE"]);
    });
  });

  it("returns nothing to an unauthenticated or inactive caller", async () => {
    await scenario(async (s) => {
      await s.as("revoked");
      expect(await s.tx`select * from api.my_access()`).toEqual([]);
      expect(await s.tx`select * from api.my_areas()`).toEqual([]);
      await s.as(null);
      await s.expectError("permission denied", (tx) => tx`select * from api.my_work_items()`);
    });
  });

  it("a random user id in the claims sees nothing", async () => {
    await scenario(async (s) => {
      await s.tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: randomUUID(), role: "authenticated" })}, true)`;
      await s.tx.unsafe("set local role authenticated");
      expect(await s.tx`select * from api.my_work_items()`).toEqual([]);
      expect(await s.tx`select * from api.my_areas()`).toEqual([]);
      expect(await s.tx`select * from api.my_access()`).toEqual([]);
    });
  });
});
