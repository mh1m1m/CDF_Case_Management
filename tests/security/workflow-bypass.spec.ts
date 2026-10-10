// CDF-62 · §31–§33, ADR-007: the case workflow can only move through api.transition_case, one defined step
// at a time, with the permission, reason, separation-of-duties and condition guards of that step. Nothing
// else (direct writes, internal helpers, unknown or out-of-state codes, disabled steps) moves a case.
import { beforeAll, describe, expect, it } from "vitest";
import { admin, caseId, scenario, type Scenario, type UserKey } from "../support/db";

let caseA: string, caseB: string, caseConflict: string;
beforeAll(async () => {
  [caseA, caseB, caseConflict] = await Promise.all([caseId("0001"), caseId("0002"), caseId("0004")]);
});

const REASON = "Synthetic: workflow regression probe reason.";
const state = async (s: Scenario, id: string) => {
  const [row] = await s.tx<{ current_state: string }[]>`
    select current_state from workflow.workflow_instance where case_id = ${id}`;
  return row?.current_state;
};
const transitionCount = async (id: string) => {
  const [row] = await admin<{ n: number }[]>`
    select count(*)::int as n from workflow.workflow_transition_event where case_id = ${id}`;
  return row!.n;
};

describe("no path around api.transition_case", () => {
  it.each<UserKey>(["grcDirector", "caseManager", "lead", "platformAdmin"])(
    "%s cannot call the internal transition and condition helpers",
    async (user) => {
      await scenario(async (s) => {
        await s.as(user);
        await s.expectError(
          "permission denied",
          (tx) => tx`select workflow.apply_transition(${caseB}, 'SCREEN_OUT', ${null}, ${REASON})`,
        );
        await s.expectError(
          "permission denied",
          (tx) => tx`select workflow.evaluate_condition('PRIORITY_SET', ${caseB}, ${null})`,
        );
        await s.expectError("permission denied", (tx) => tx`select case_mgmt.next_case_number('CDF-DEMO')`);
      });
    },
  );

  it.each<UserKey>(["grcDirector", "caseManager", "lead"])(
    "%s cannot move a case or enable a step by writing workflow tables",
    async (user) => {
      await scenario(async (s) => {
        await s.as(user);
        await s.expectError(
          "permission denied",
          (tx) =>
            tx`update workflow.workflow_instance set current_state = 'CLOSURE' where case_id = ${caseA}`,
        );
        await s.expectError(
          "permission denied",
          (tx) =>
            tx`update workflow.workflow_transition_definition set is_enabled = true, required_conditions = '{}'`,
        );
        await s.expectError(
          "permission denied",
          (tx) =>
            tx`insert into workflow.workflow_transition_event (instance_id, case_id, transition_code, from_state, to_state, actor_id)
               select id, case_id, 'SUBMIT_FINDINGS', 'INVESTIGATION', 'FINDINGS', ${null}::uuid from workflow.workflow_instance where case_id = ${caseA}`,
        );
        await s.expectError(
          "permission denied",
          (tx) => tx`update case_mgmt.case_record set records_state = 'CLOSED' where id = ${caseA}`,
        );
      });
    },
  );
});

describe("transition guards", () => {
  it("a case cannot skip states: every code not defined from the current state is refused", async () => {
    const codes = await admin<{ code: string }[]>`
      select code from workflow.workflow_transition_definition where from_state <> 'SCREENING' order by code`;
    expect(codes.length).toBeGreaterThan(10);
    const before = await transitionCount(caseB);
    await scenario(async (s) => {
      // The GRC director holds every workflow permission and can view the case.
      await s.as("grcDirector");
      expect(await state(s, caseB)).toBe("SCREENING");
      for (const { code } of codes) {
        await s.expectError(
          "CDF_CONFLICT:TRANSITION_NOT_AVAILABLE_FROM_STATE",
          (tx) => tx`select api.transition_case(${caseB}, ${code}, ${REASON})`,
        );
      }
      for (const code of ["NOPE", "", "complete_screening", "COMPLETE_SCREENING' --", "SCREEN_OUT;CLOSE"]) {
        await s.expectError(
          "CDF_CONFLICT:TRANSITION_NOT_AVAILABLE_FROM_STATE",
          (tx) => tx`select api.transition_case(${caseB}, ${code}, ${REASON})`,
        );
      }
      expect(await state(s, caseB)).toBe("SCREENING");
    });
    expect(await transitionCount(caseB)).toBe(before);
  });

  it("system and disabled steps cannot be taken by anyone", async () => {
    await scenario(async (s) => {
      await s.as("grcDirector");
      // REGISTER is a system step; SUBMIT_FINDINGS is defined from INVESTIGATION but ships disabled.
      await s.expectError(
        "CDF_CONFLICT:TRANSITION_NOT_AVAILABLE_FROM_STATE",
        (tx) => tx`select api.transition_case(${caseA}, 'REGISTER', ${REASON})`,
      );
      for (const user of ["caseManager", "grcDirector", "lead"] as UserKey[]) {
        await s.as(user);
        await s.expectError(
          "CDF_CONFLICT:TRANSITION_NOT_YET_AVAILABLE",
          (tx) => tx`select api.transition_case(${caseA}, 'SUBMIT_FINDINGS', ${REASON})`,
        );
      }
      expect(await state(s, caseA)).toBe("INVESTIGATION");
    });
  });

  it("a visible case still needs the step's permission", async () => {
    await scenario(async (s) => {
      // Investigator B is assigned to case B but holds neither WORKFLOW_SCREEN nor WORKFLOW_ADVANCE.
      await s.as("investigatorB");
      for (const code of ["COMPLETE_SCREENING", "SCREEN_OUT"]) {
        await s.expectError(
          "CDF_FORBIDDEN",
          (tx) => tx`select api.transition_case(${caseB}, ${code}, ${REASON})`,
        );
      }
      // Triage holds WORKFLOW_SCREEN but not WORKFLOW_ADVANCE.
      await s.as("triage");
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.transition_case(${caseB}, 'SCREEN_OUT', ${REASON})`,
      );
    });
  });

  it("a step that requires a reason refuses a missing, short or oversized one", async () => {
    await scenario(async (s) => {
      await s.as("caseManager");
      for (const reason of [null, "", "   ", "too short", "x".repeat(2001)]) {
        await s.expectError(
          "CDF_INVALID:reason",
          (tx) => tx`select api.transition_case(${caseB}, 'SCREEN_OUT', ${reason})`,
        );
      }
      expect(await state(s, caseB)).toBe("SCREENING");
    });
  });

  it("conditions block until satisfied, step by step", async () => {
    await scenario(async (s) => {
      await s.as("caseManager");
      await s.tx`select api.transition_case(${caseB}, 'COMPLETE_SCREENING', null)`;
      expect(await state(s, caseB)).toBe("CONFLICT_CHECK");
      // The actor has not declared on this case.
      await s.expectError(
        "CDF_CONFLICT:ACTOR_CONFLICT_DECLARATION_MISSING",
        (tx) => tx`select api.transition_case(${caseB}, 'CLEAR_CONFLICT_CHECK', null)`,
      );
      await s.tx`select api.declare_conflict(${caseB}, false, 'Synthetic: no relationship with the parties.')`;
      // An unresolved declaration by someone else on the case still blocks.
      await s.as("investigatorB");
      const [k] = await s.tx<
        { id: string }[]
      >`select api.declare_conflict(${caseB}, true, 'Synthetic: probe declaration.') as id`;
      await s.as("caseManager");
      await s.expectError(
        "CDF_CONFLICT:UNRESOLVED_CONFLICT_DECLARATION",
        (tx) => tx`select api.transition_case(${caseB}, 'CLEAR_CONFLICT_CHECK', null)`,
      );
      await s.tx`select api.decide_conflict(${k!.id}, 'CONFLICT_CLEARED', 'Synthetic: cleared after review.')`;
      await s.tx`select api.transition_case(${caseB}, 'CLEAR_CONFLICT_CHECK', null)`;
      // Priority is not set on case B.
      await s.expectError(
        "CDF_CONFLICT:PRIORITY_NOT_SET",
        (tx) => tx`select api.transition_case(${caseB}, 'COMPLETE_TRIAGE', null)`,
      );
      expect(await state(s, caseB)).toBe("TRIAGE");
    });
  });

  it("a step cannot be replayed: the same code a second time is refused", async () => {
    await scenario(async (s) => {
      await s.as("caseManager");
      await s.tx`select api.transition_case(${caseConflict}, 'START_SCREENING', null)`;
      await s.expectError(
        "CDF_CONFLICT:TRANSITION_NOT_AVAILABLE_FROM_STATE",
        (tx) => tx`select api.transition_case(${caseConflict}, 'START_SCREENING', null)`,
      );
    });
  });
});

describe("the UI's list of steps never promises more than the database allows", () => {
  const ACTORS: UserKey[] = [
    "triage",
    "caseManager",
    "investigatorA",
    "investigatorB",
    "lead",
    "grcDirector",
    "grcDeputy",
    "committee",
  ];

  it.each(ACTORS)("available_transitions agrees with transition_case for %s", async (user) => {
    const cases = await admin<{ id: string }[]>`
      select id from case_mgmt.case_record where case_number ~ '^CDF-DEMO-[0-9]{4}-000[1-4]$'`;
    await scenario(async (s) => {
      await s.as(user);
      const disagreements: string[] = [];
      for (const { id } of cases) {
        const offered = await s.tx<{ code: string; allowed: boolean }[]>`
          select code, allowed from api.available_transitions(${id})`;
        for (const t of offered) {
          // Each attempt runs in a savepoint that is always rolled back, so attempts do not affect each other.
          let ok = false;
          try {
            await s.tx.savepoint(async (sp) => {
              await sp`select api.transition_case(${id}, ${t.code}, ${REASON})`;
              ok = true;
              throw new Error("undo");
            });
          } catch {
            // undo or refusal
          }
          if (ok !== t.allowed) disagreements.push(`${t.code} on ${id}: offered=${t.allowed} actual=${ok}`);
        }
      }
      expect(disagreements).toEqual([]);
    });
  });
});
