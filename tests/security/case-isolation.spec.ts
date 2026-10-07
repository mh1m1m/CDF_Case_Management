// §18–§21, §87: case-level isolation. Users see exactly the cases their role, clearance,
// assignments, grants and conflict declarations allow, and nothing else.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { caseId, scenario, type UserKey } from "../support/db";

let caseA: string, caseB: string, caseExec: string, caseConflict: string;
beforeAll(async () => {
  [caseA, caseB, caseExec, caseConflict] = await Promise.all([
    caseId("0001"),
    caseId("0002"),
    caseId("0003"),
    caseId("0004"),
  ]);
});

const visible = async (user: UserKey) => {
  let numbers: string[] = [];
  await scenario(async (s) => {
    await s.as(user);
    const rows = await s.tx<
      { case_number: string }[]
    >`select case_number from case_mgmt.case_record order by case_number`;
    numbers = rows.map((r) => r.case_number.slice(-4));
  });
  return numbers;
};

describe("case visibility matrix", () => {
  it.each<[UserKey, string[]]>([
    ["intake", []], // intake sees reports, not cases
    ["triage", ["0001", "0002", "0004"]], // own TRIAGE grants; 0003 is above clearance
    ["caseManager", ["0001", "0002", "0004"]], // CASE_VIEW_ALL but not restricted cases
    ["investigatorA", ["0001"]], // assigned to A; removed from 0004 by conflict
    ["investigatorB", ["0002", "0004"]], // assigned only
    ["lead", ["0001"]],
    ["committee", []],
    ["grcDirector", ["0001", "0002", "0003", "0004"]], // explicit grant on the restricted case
    ["grcDeputy", ["0001", "0002", "0004"]], // CASE_VIEW_ALL does not reach restricted cases
    ["platformAdmin", []], // administration never implies case content (§21)
    ["internalAudit", []],
    ["soc", []],
    ["dpo", []],
    ["revoked", []],
  ])("%s sees %j", async (user, expected) => {
    expect(await visible(user)).toEqual(expected);
  });

  it("applies the same isolation to every case-scoped table and the overview view", async () => {
    await scenario(async (s) => {
      await s.as("investigatorA");
      for (const table of [
        "case_mgmt.case_overview",
        "case_mgmt.allegation",
        "case_mgmt.case_assignment",
        "case_mgmt.case_access_grant",
        "workflow.workflow_instance",
        "workflow.workflow_transition_event",
      ]) {
        const rows = await s.tx.unsafe<{ case_id: string }[]>(
          `select distinct ${table.endsWith("overview") ? "id" : "case_id"} as case_id from ${table}`,
        );
        expect(
          rows.map((r) => r.case_id),
          table,
        ).toEqual([caseA]);
      }
      const people = await s.tx`select * from case_mgmt.person`;
      expect(people).toEqual([]);
    });
  });
});

describe("direct access is denied", () => {
  it("application roles cannot write tables directly", async () => {
    await scenario(async (s) => {
      await s.as("caseManager");
      await s.expectError(
        "permission denied",
        (tx) => tx`update case_mgmt.case_record set title = 'x' where id = ${caseA}`,
      );
      await s.expectError("permission denied", (tx) => tx`delete from case_mgmt.case_assignment`);
      await s.expectError(
        "permission denied",
        (tx) =>
          tx`insert into case_mgmt.case_access_grant (case_id, user_id, scope, reason, granted_by) values (${caseExec}, ${"a0000000-0000-4000-8000-000000000003"}, 'CASE', 'self grant', ${"a0000000-0000-4000-8000-000000000003"})`,
      );
    });
  });

  it("an invisible case and a non-existent case are indistinguishable", async () => {
    await scenario(async (s) => {
      await s.as("investigatorA");
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) =>
          tx`select api.assign_case(${caseB}, ${"a0000000-0000-4000-8000-000000000004"}, 'INVESTIGATOR', 'self assign')`,
      );
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) =>
          tx`select api.assign_case(${randomUUID()}, ${"a0000000-0000-4000-8000-000000000004"}, 'INVESTIGATOR', 'self assign')`,
      );
    });
  });

  it("records a SECURITY event when a user opens a case they cannot view", async () => {
    await scenario(async (s) => {
      await s.as("investigatorA");
      const [granted] = await s.tx<{ ok: boolean }[]>`select api.open_case(${caseA}) as ok`;
      const [denied] = await s.tx<{ ok: boolean }[]>`select api.open_case(${caseB}) as ok`;
      expect(granted!.ok).toBe(true);
      expect(denied!.ok).toBe(false);
      await s.as("soc");
      const events = await s.tx<{ action: string; outcome: string; object_id: string }[]>`
        select action, outcome, object_id from audit.audit_event where action = 'CASE_ACCESS_DENIED' and object_id = ${caseB}`;
      expect(events).toEqual([{ action: "CASE_ACCESS_DENIED", outcome: "DENIED", object_id: caseB }]);
    });
  });

  it("revoked users can do nothing, even with a valid subject claim", async () => {
    await scenario(async (s) => {
      await s.as("revoked");
      await s.expectError("CDF_UNAUTHENTICATED", (tx) => tx`select api.open_case(${caseA})`);
      expect(await s.tx`select * from iam.role`).toEqual([]);
    });
  });

  it("anonymous context sees no case data", async () => {
    await scenario(async (s) => {
      await s.as(null);
      await s.expectError("permission denied", (tx) => tx`select * from case_mgmt.case_record`);
      await s.expectError("permission denied", (tx) => tx`select api.open_case(${caseA})`);
    });
  });
});

describe("assignment and separation of duties", () => {
  it("investigators cannot assign cases, including to themselves", async () => {
    await scenario(async (s) => {
      await s.as("investigatorA");
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) =>
          tx`select api.assign_case(${caseA}, ${"a0000000-0000-4000-8000-000000000005"}, 'INVESTIGATOR', 'helping out')`,
      );
    });
  });

  it("a lead investigator assigns within their own case only", async () => {
    await scenario(async (s) => {
      await s.as("lead");
      await s.tx`select api.assign_case(${caseA}, ${"a0000000-0000-4000-8000-000000000005"}, 'INVESTIGATOR', 'Synthetic: extra capacity')`;
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) =>
          tx`select api.assign_case(${caseB}, ${"a0000000-0000-4000-8000-000000000005"}, 'INVESTIGATOR', 'Synthetic: extra capacity')`,
      );
    });
  });

  it("cannot assign a user whose clearance is below the case classification", async () => {
    await scenario(async (s) => {
      await s.as("grcDirector");
      await s.expectError(
        "CDF_CONFLICT:ASSIGNEE_CLEARANCE_INSUFFICIENT",
        (tx) =>
          tx`select api.assign_case(${caseExec}, ${"a0000000-0000-4000-8000-000000000004"}, 'INVESTIGATOR', 'Synthetic assignment')`,
      );
    });
  });

  it("cannot assign a user with a declared conflict", async () => {
    await scenario(async (s) => {
      await s.as("caseManager");
      await s.expectError(
        "CDF_CONFLICT:ASSIGNEE_HAS_CONFLICT",
        (tx) =>
          tx`select api.assign_case(${caseConflict}, ${"a0000000-0000-4000-8000-000000000004"}, 'INVESTIGATOR', 'Synthetic reassignment')`,
      );
    });
  });

  it("declaring a conflict removes access immediately", async () => {
    await scenario(async (s) => {
      await s.as("investigatorB");
      await s.tx`select api.declare_conflict(${caseB}, true, 'Synthetic: related to Vendor Tau')`;
      const rows = await s.tx`select id from case_mgmt.case_record where id = ${caseB}`;
      expect(rows).toEqual([]);
    });
  });

  it("a conflict cannot be decided by the person who declared it", async () => {
    await scenario(async (s) => {
      await s.as("caseManager");
      await s.tx`select api.declare_conflict(${caseB}, true, 'Synthetic: possible relationship')`;
      const [k] = await s.tx<
        { id: string }[]
      >`select id from case_mgmt.conflict_check where case_id = ${caseB} and is_current and user_id = ${"a0000000-0000-4000-8000-000000000003"}`;
      // The declarer has lost access to the case, so the decision is impossible for them.
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) => tx`select api.decide_conflict(${k!.id}, 'CONFLICT_CLEARED', 'Synthetic: no conflict really')`,
      );
    });
  });

  it("an assigned investigator cannot approve the investigation of their own case", async () => {
    await scenario(async (s) => {
      // Give investigator B (assigned to case B) the approval permission, then try to approve.
      await s.as("platformAdmin");
      await s.tx`select api.grant_role(${"a0000000-0000-4000-8000-000000000005"}, 'GRC_DIRECTOR', 'Synthetic: SoD test only')`;
      await s.as("caseManager");
      await s.tx`select api.declare_conflict(${caseB}, false, 'Synthetic: no relationship')`;
      await s.tx`select api.transition_case(${caseB}, 'COMPLETE_SCREENING')`;
      await s.tx`select api.transition_case(${caseB}, 'CLEAR_CONFLICT_CHECK')`;
      await s.tx`select api.update_case_details(${caseB}, title, summary, 'MEDIUM', row_version) from case_mgmt.case_record where id = ${caseB}`;
      await s.tx`select api.transition_case(${caseB}, 'COMPLETE_TRIAGE')`;
      await s.tx`select api.transition_case(${caseB}, 'CONFIRM_JURISDICTION', 'Synthetic: within mandate')`;
      await s.as("investigatorB");
      await s.tx`select api.declare_conflict(${caseB}, false, 'Synthetic: no relationship')`;
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.transition_case(${caseB}, 'APPROVE_INVESTIGATION', 'Synthetic: self approval')`,
      );
    });
  });
});
