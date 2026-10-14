// §18–§21, §87: case-level isolation. Users see exactly the cases their role, clearance,
// assignments, grants and conflict declarations allow, and nothing else.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { Tx } from "@cdf/infrastructure";
import { USERS, caseId, ownerScenario, scenario, type Scenario, type UserKey } from "../support/db";
import { IC_SEATS, committeeIds, openWithPresent, scheduleMeeting, seat } from "../support/committee";

const SEED_CASES = ["0001", "0002", "0003", "0004"];
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
    // Only seed cases: integration tests may have committed further synthetic cases.
    numbers = rows.map((r) => r.case_number.slice(-4)).filter((n) => SEED_CASES.includes(n));
  });
  return numbers;
};

describe("case visibility matrix", () => {
  it.each<[UserKey, string[]]>([
    ["intake", []], // intake sees reports, not cases
    // Own TRIAGE grants, only before hand-over (S3, DEC-03): 0001 was handed over; 0003 is above clearance.
    ["triage", ["0002", "0004"]],
    ["caseManager", ["0001", "0002", "0004"]], // CASE_VIEW_ALL but not restricted cases
    ["investigatorA", ["0001"]], // assigned to A; removed from 0004 by conflict
    ["investigatorB", ["0002", "0004"]], // assigned only
    ["lead", ["0001"]],
    ["committee", []],
    ["committeeChair", []], // a committee role opens no case (S3, DEC-02)
    ["committeeSecretary", []],
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

describe("ambiguity register: cross-case discovery and search (CDF-205)", () => {
  /** Every base table with a case_id column the caller may read; tables closed to the role count as empty. */
  async function caseIdsReachable(s: { tx: Tx }): Promise<Set<string>> {
    const tables = await s.tx<{ t: string }[]>`
      select c.table_schema || '.' || c.table_name as t from information_schema.columns c
      join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
      where c.column_name = 'case_id' and t.table_type = 'BASE TABLE'
        and c.table_schema not in ('pg_catalog', 'information_schema')`;
    const seen = new Set<string>();
    for (const { t } of tables) {
      try {
        await s.tx.savepoint(async (sp) => {
          for (const r of await sp.unsafe<{ case_id: string }[]>(`select distinct case_id from ${t}`))
            seen.add(r.case_id);
        });
      } catch (error) {
        expect((error as Error).message, t).toMatch(/^permission denied/);
      }
    }
    return seen;
  }

  it("T-AMB-015: a seated, present committee member cannot discover the subject's other case", async () => {
    const { ic } = await committeeIds();
    await ownerScenario(async (s) => {
      await s.as("caseManager");
      const [a] = await s.tx<{ id: string }[]>`
        select api.add_case_subject(${caseB}, 'Employee Sigma (synthetic)', 'EMPLOYEE', null) as id`;
      const [p] = await s.tx<
        { person_id: string }[]
      >`select person_id from case_mgmt.case_subject where id = ${a!.id}`;
      // The same person is also a subject of case 0004 (fixture: no command links a person across cases).
      await s.asOwner();
      await s.tx`
        insert into case_mgmt.case_person (case_id, person_id, role, added_by)
        values (${caseConflict}, ${p!.person_id}, 'SUBJECT', ${USERS.caseManager})`;
      await s.tx`
        insert into case_mgmt.case_subject (case_id, person_id, subject_category, added_by)
        values (${caseConflict}, ${p!.person_id}, 'EMPLOYEE', ${USERS.caseManager})`;
      await seat(s, ic, IC_SEATS);
      const f = await scheduleMeeting(s, ic, caseB);
      await openWithPresent(s, f, ["committeeChair", "legal", "legalB", "lead"]);

      for (const member of ["legal", "legalB", "committeeChair", "committeeSecretary"] as const) {
        await s.as(member);
        const [v] = await s.tx<{ d: boolean; dm: boolean }[]>`
          select authz.can_view_case(${caseConflict}) as d, authz.can_view_case_metadata(${caseConflict}) as dm`;
        expect(v, member).toEqual({ d: false, dm: false });
        expect(await s.tx`select id from case_mgmt.person where id = ${p!.person_id}`, member).toEqual([]);
        expect(
          await s.tx`select case_id from case_mgmt.case_subject where person_id = ${p!.person_id}`,
          member,
        ).toEqual([]);
        expect((await caseIdsReachable(s)).has(caseConflict), member).toBe(false);
      }
    });
  });

  it("T-AMB-015: the secretary's extract shows only the subject's prior final sanctions; a restricted source needs its authority", async () => {
    const { ic, gc } = await committeeIds();
    const { priorFinalSanction, requestExtract } = await import("../support/evidence");
    type Extract = { sanctions: Record<string, unknown>[] } & Record<string, unknown>;
    const view = async (s: { tx: Scenario["tx"] }, extract: string) =>
      (await s.tx<{ v: Extract }[]>`select api.sanction_extract_view(${extract}) as v`)[0]!.v;

    await ownerScenario(async (s) => {
      const p = await priorFinalSanction(s, { ic, gc, caseB, requestingCase: caseConflict });
      const extract = await requestExtract(s, p);
      const doc = await view(s, extract);
      // Sanction code and dates only: no case id or number, no allegation, finding, evidence or history.
      expect(doc.sanctions).toEqual([
        {
          position: 1,
          sanction_code: "WARNING",
          catalogue_sanction: true,
          decided_on: expect.any(String),
          effective_from: expect.any(String),
        },
      ]);
      const keys = new Set<string>();
      const walk = (v: unknown) => {
        if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === "object")
          for (const [k, x] of Object.entries(v)) {
            keys.add(k);
            walk(x);
          }
      };
      walk(doc);
      expect(
        [...keys].filter((k) =>
          /case|allegation|finding|evidence|investigation|history|execution|decision_id/i.test(k),
        ),
      ).toEqual([]);
      await s.asOwner();
      const [cb] = await s.tx<
        { n: string }[]
      >`select case_number as n from case_mgmt.case_record where id = ${caseB}`;
      const text = JSON.stringify(doc);
      for (const hidden of [caseB, cb!.n, p.sigma, p.decision, p.execution])
        expect(text).not.toContain(hidden);
      // Seated members of the proceeding read it; anyone else cannot tell it exists.
      for (const member of ["committeeChair", "legal"] as const) {
        await s.as(member);
        expect((await view(s, extract)).sanctions, member).toHaveLength(1);
      }
      for (const u of [
        "legalB",
        "caseManager",
        "investigatorB",
        "grcDirector",
        "employee",
        "platformAdmin",
      ] as const) {
        await s.as(u);
        await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.sanction_extract_view(${extract})`);
      }
    });

    await ownerScenario(async (s) => {
      const p = await priorFinalSanction(s, { ic, gc, caseB, requestingCase: caseConflict }, true);
      const extract = await requestExtract(s, p);
      // Nothing from the restricted case shows until its Restricted Case Authority approves the row, and they are told.
      expect((await view(s, extract)).sanctions).toEqual([]);
      await s.asOwner();
      const [row] = await s.tx<{ id: string }[]>`
        select id from decision.sanction_extract_row where extract_id = ${extract} and status = 'AWAITING_AUTHORITY'`;
      expect(
        await s.tx`select recipient_id, object_type, object_id from notify.outbox
                   where template_code = 'SANCTION_EXTRACT_APPROVAL_REQUESTED' and channel = 'IN_APP'`,
      ).toEqual([
        { recipient_id: USERS.grcDirector, object_type: "SANCTION_EXTRACT_APPROVAL", object_id: row!.id },
      ]);
      await s.as("grcDirector");
      await s.tx`select api.decide_sanction_extract_row(${row!.id}, 'APPROVE', 'Synthetic: relevant to the committee.')`;
      await s.as("committeeSecretary");
      expect((await view(s, extract)).sanctions.map((x) => x.sanction_code)).toEqual(["WARNING"]);
    });
  });

  it("T-AMB-143: searching for a hidden case returns no row, no count and no snippet", async () => {
    await scenario(async (s) => {
      // The restricted SECRET case 0003 is invisible to these users (case visibility matrix above).
      await s.as("grcDirector");
      const [own] = await s.tx<{ n: string; t: string }[]>`
        select case_number as n, title as t from case_mgmt.case_record where id = ${caseExec}`;
      for (const user of ["caseManager", "grcDeputy", "records", "investigatorA", "triage"] as const) {
        await s.as(user);
        expect(
          await s.tx`select * from api.search_records_catalogue(${own!.n}, null, null, 200, 0)`,
          user,
        ).toEqual([]);
        const all = await s.tx<{ case_id: string; total_count: string }[]>`
          select case_id, total_count from api.search_records_catalogue('CDF-DEMO', null, null, 200, 0)`;
        expect(
          all.map((r) => r.case_id),
          user,
        ).not.toContain(caseExec);
        // The total counts only rows the caller sees.
        for (const r of all) expect(Number(r.total_count), user).toBe(all.length);
        expect(
          await s.tx`select id from case_mgmt.case_overview where case_number = ${own!.n}`,
          user,
        ).toEqual([]);
        expect(
          await s.tx`select id from case_mgmt.case_record where title ilike ${"%" + own!.t.slice(0, 12) + "%"} and id = ${caseExec}`,
          user,
        ).toEqual([]);
        const [c] = await s.tx<{ n: number }[]>`
          select count(*)::int as n from case_mgmt.case_record where case_number = ${own!.n}`;
        expect(c!.n, user).toBe(0);
        expect(
          (await s.tx<{ case_id: string | null }[]>`select case_id from api.my_work_items()`).map(
            (i) => i.case_id,
          ),
          user,
        ).not.toContain(caseExec);
      }
    });
  });
});
