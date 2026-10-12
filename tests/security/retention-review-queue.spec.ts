// ADR-016 D8 (DEC-37, decided 2026-10-12), migration 1860: archiving a case creates an obligation for Records
// review in a shared queue, never a named assignee. The queue is derived from the case's state (ARCHIVED, class
// not yet confirmed); a legal hold does not stop classification, only disposition; classifying ends it. The queue
// grants nothing: records officers keep lifecycle metadata only.
import { beforeAll, describe, expect, it } from "vitest";
import {
  admin,
  caseId,
  ownerScenario,
  scenario,
  USERS,
  type OwnerScenario,
  type Scenario,
  type UserKey,
} from "../support/db";
import {
  addShortRetentionClass,
  closeAndArchive,
  giveTask,
  legalHoldTasks,
  placeHold,
  recordsState,
  releaseHold,
  requestDisposition,
} from "../support/records";

let caseB: string, caseExec: string, numberB: string, numberExec: string;
beforeAll(async () => {
  [caseB, caseExec] = await Promise.all([caseId("0002"), caseId("0003")]);
  const numbers = await admin<{ id: string; case_number: string }[]>`
    select id, case_number from case_mgmt.case_record where id in (${caseB}, ${caseExec})`;
  numberB = numbers.find((r) => r.id === caseB)!.case_number;
  numberExec = numbers.find((r) => r.id === caseExec)!.case_number;
});

interface QueueRow {
  case_id: string;
  case_number: string;
  classification: string;
  archived_at: Date | null;
  retention_class: string;
  legal_hold_status: string;
}

async function queue(s: Scenario, user: UserKey, id: string = caseB): Promise<QueueRow[]> {
  await s.as(user);
  return s.tx<QueueRow[]>`select * from api.retention_review_queue() where case_id = ${id}`;
}

/** The caller's retention work on one case: the shared queue item and their own retention task, if any. */
async function retentionWork(s: Scenario, user: UserKey, id: string = caseB) {
  await s.as(user);
  return s.tx<
    {
      area: string;
      view: string;
      category: string;
      target_type: string;
      target_id: string;
      case_id: string | null;
      case_number: string | null;
      since_at: Date | null;
    }[]
  >`
    select area, view, category, target_type, target_id, case_id, case_number, since_at
    from api.my_work_items()
    where category in ('RETENTION_CLASSIFICATION', 'TASK_RETENTION_REVIEW') and target_id in (
      ${id}, (select t.id from case_mgmt.case_task t where t.case_id = ${id} and t.assigned_user_id = ${USERS[user]}
              order by t.created_at desc limit 1))`;
}

const queueItems = async (s: Scenario, user: UserKey) => {
  await s.as(user);
  return s.tx<
    { target_id: string }[]
  >`select target_id from api.my_work_items() where category = 'RETENTION_CLASSIFICATION'`;
};

const recordsCount = async (s: Scenario, user: UserKey) => {
  await s.as(user);
  const [row] = await s.tx<{ n: number }[]>`
    select coalesce((select actionable_count from api.my_areas() where area_code = 'RECORDS'), 0)::int as n`;
  return row!.n;
};

/** Everyone who is not a records officer: case staff (the archiver included), legal, oversight and admins. */
const NOT_RECORDS: UserKey[] = [
  "intake",
  "triage",
  "caseManager",
  "investigatorA",
  "investigatorB",
  "lead",
  "committee",
  "committeeSecretary",
  "committeeChair",
  "grcDirector",
  "grcDeputy",
  "platformAdmin",
  "internalAudit",
  "soc",
  "dpo",
  "legal",
  "legalB",
  "revoked",
];
const EVERYONE: UserKey[] = [...NOT_RECORDS, "records", "recordsB"];

/** The caller's "route this retention review" item on one case. */
async function routeWork(s: Scenario, user: UserKey, id: string) {
  await s.as(user);
  return s.tx<
    {
      area: string;
      view: string;
      category: string;
      target_type: string;
      case_id: string | null;
      case_number: string | null;
    }[]
  >`
    select area, view, category, target_type, case_id, case_number from api.my_work_items()
    where category = 'RETENTION_TO_ROUTE' and target_id = ${id}`;
}

async function canRoute(s: Scenario, user: UserKey, id: string): Promise<boolean> {
  await s.as(user);
  const [row] = await s.tx<{ ok: boolean }[]>`select authz.can_route_retention_review(${id}) as ok`;
  return row!.ok;
}

async function reviewers(s: Scenario, user: UserKey, id: string) {
  await s.as(user);
  return s.tx<{ user_id: string; display_name: string; display_name_ar: string }[]>`
    select * from api.list_retention_reviewers(${id})`;
}

const routeTo = (s: Scenario, by: UserKey, id: string, officer: UserKey) =>
  giveTask(s, id, officer, "RETENTION_REVIEW", { by });

describe("retention review queue at archive (ADR-016 D8, DEC-37)", () => {
  it("RRQ-01: archiving creates exactly one queue item, the same for every records officer and assigned to nobody", async () => {
    await ownerScenario(async (s) => {
      expect(await queue(s, "records")).toHaveLength(0); // an active case is not records work
      const before = await recordsCount(s, "records");
      await s.as("caseManager");
      await s.tx`select api.transition_case(${caseB}, 'SCREEN_OUT', 'Synthetic: screened out for the queue suite.')`;
      expect(await queue(s, "records")).toHaveLength(0); // closed is not archived
      await s.as("caseManager");
      await s.tx`select api.transition_case(${caseB}, 'ARCHIVE_CASE')`;

      await s.asOwner();
      const [archive] = await s.tx<{ occurred_at: Date }[]>`
        select occurred_at from workflow.workflow_transition_event where case_id = ${caseB} and to_state = 'ARCHIVE'`;
      for (const user of ["records", "recordsB"] as const) {
        const rows = await queue(s, user);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          case_number: numberB,
          retention_class: "UNASSIGNED",
          legal_hold_status: "NONE",
        });
        expect(rows[0]!.archived_at).toEqual(archive!.occurred_at);
        expect(await retentionWork(s, user)).toEqual([
          {
            area: "RECORDS",
            view: "NEEDS_ACTION",
            category: "RETENTION_CLASSIFICATION",
            target_type: "RECORD",
            target_id: caseB,
            case_id: caseB,
            case_number: numberB,
            since_at: archive!.occurred_at,
          },
        ]);
      }
      expect(await recordsCount(s, "records")).toBe(before + 1);

      // An obligation, not an assignment: archiving created no task, assignment or grant for anyone.
      await s.asOwner();
      const [made] = await s.tx<{ tasks: number; assignments: number; grants: number }[]>`
        select (select count(*) from case_mgmt.case_task where case_id = ${caseB})::int as tasks,
               (select count(*) from case_mgmt.case_assignment
                 where case_id = ${caseB} and user_id in (${USERS.records}, ${USERS.recordsB}))::int as assignments,
               (select count(*) from case_mgmt.case_access_grant
                 where case_id = ${caseB} and user_id in (${USERS.records}, ${USERS.recordsB}))::int as grants`;
      expect(made).toEqual({ tasks: 0, assignments: 0, grants: 0 });
    });
  });

  it("RRQ-02: archiving again, or a retried request, adds no second item", async () => {
    await scenario(async (s) => {
      await closeAndArchive(s, caseB);
      await s.as("caseManager");
      await s.expectError(
        "CDF_CONFLICT:TRANSITION_NOT_AVAILABLE_FROM_STATE",
        (tx) => tx`select api.transition_case(${caseB}, 'ARCHIVE_CASE')`,
      );
      expect(await queue(s, "records")).toHaveLength(1);
      expect(await retentionWork(s, "records")).toHaveLength(1);
      expect((await queueItems(s, "records")).filter((i) => i.target_id === caseB)).toHaveLength(1);
    });
  });

  it("RRQ-03: nobody but a records officer gets the item, the archiver included", async () => {
    await scenario(async (s) => {
      await closeAndArchive(s, caseB);
      for (const user of NOT_RECORDS) {
        expect(await queue(s, user), user).toHaveLength(0);
        expect(await queueItems(s, user), user).toEqual([]);
      }
    });
  });

  it("RRQ-04: the queue never passes clearance, a restricted case or another officer's task", async () => {
    // Above the officers' clearance: archived, but in nobody's queue.
    await ownerScenario(async (s) => {
      await setArchived(s, caseB, "SECRET");
      for (const user of ["records", "recordsB"] as const) {
        expect(await queue(s, user), user).toHaveLength(0);
        expect(await queueItems(s, user), user).toEqual([]);
      }
    });
    // Restricted: never in the shared queue; a RETENTION_REVIEW task brings it to one officer as that task.
    await ownerScenario(async (s) => {
      await setArchived(s, caseExec, "CONFIDENTIAL");
      for (const user of ["records", "recordsB"] as const) {
        expect(await queue(s, user, caseExec), user).toHaveLength(0);
      }
      const taskId = await giveTask(s, caseExec, "records", "RETENTION_REVIEW", { by: "grcDirector" });
      const work = await retentionWork(s, "records", caseExec);
      expect(work.map((w) => [w.category, w.target_id])).toEqual([["TASK_RETENTION_REVIEW", taskId]]);
      expect(await queue(s, "records", caseExec)).toHaveLength(0);
      expect(await queue(s, "recordsB", caseExec)).toHaveLength(0);
      expect(await queueItems(s, "recordsB")).toEqual([]);
    });
  });

  it("RRQ-05: an officer's own retention task stands for the queue item; the other officers keep the queue item", async () => {
    await scenario(async (s) => {
      await closeAndArchive(s, caseB);
      const taskId = await giveTask(s, caseB, "records", "RETENTION_REVIEW");
      expect((await retentionWork(s, "records")).map((w) => [w.category, w.target_id])).toEqual([
        ["TASK_RETENTION_REVIEW", taskId],
      ]);
      expect((await retentionWork(s, "recordsB")).map((w) => w.category)).toEqual([
        "RETENTION_CLASSIFICATION",
      ]);
      // The task holder classifies: their task completes and the queue item ends, for both officers.
      await s.as("records");
      await s.tx`select api.assign_retention_class(${caseB}, 'WB_CASE_NOT_INVESTIGATED')`;
      expect(await retentionWork(s, "records")).toEqual([]);
      expect(await retentionWork(s, "recordsB")).toEqual([]);
    });
  });

  it("RRQ-06: records receives lifecycle metadata only; the queue opens no case content", async () => {
    await scenario(async (s) => {
      await closeAndArchive(s, caseB);
      const [row] = await queue(s, "records");
      expect(Object.keys(row!).sort()).toEqual([
        "archived_at",
        "case_id",
        "case_number",
        "classification",
        "legal_hold_status",
        "retention_class",
      ]);
      await s.as("records");
      const [content] = await s.tx<
        {
          opened: boolean;
          records: number;
          overview: number;
          allegations: number;
          evidence: number;
          interviews: number;
        }[]
      >`
        select api.open_case(${caseB}) as opened,
               (select count(*) from case_mgmt.case_record where id = ${caseB})::int as records,
               (select count(*) from case_mgmt.case_overview where id = ${caseB})::int as overview,
               (select count(*) from case_mgmt.allegation where case_id = ${caseB})::int as allegations,
               (select count(*) from evidence.evidence where case_id = ${caseB})::int as evidence,
               (select count(*) from case_mgmt.interview where case_id = ${caseB})::int as interviews`;
      expect(content).toEqual({
        opened: false,
        records: 0,
        overview: 0,
        allegations: 0,
        evidence: 0,
        interviews: 0,
      });
      const [access] = await s.tx<{ n: number }[]>`
        select count(*)::int as n from api.my_access() where case_id = ${caseB}`;
      expect(access!.n).toBe(0); // no assignment, grant or task came with the item
    });
  });

  it("RRQ-07: a legal hold keeps the item, and the case can still be classified while held", async () => {
    await scenario(async (s) => {
      await legalHoldTasks(s, caseB);
      await closeAndArchive(s, caseB);
      await s.as("legal");
      await placeHold(s.tx, caseB);
      for (const user of ["records", "recordsB"] as const) {
        const rows = await queue(s, user);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.legal_hold_status).toBe("ACTIVE");
        expect((await retentionWork(s, user)).map((w) => w.category)).toEqual(["RETENTION_CLASSIFICATION"]);
      }
      await s.as("records");
      await s.tx`select api.assign_retention_class(${caseB}, 'WB_CASE_NOT_INVESTIGATED')`;
      expect(await recordsState(s.tx, caseB)).toEqual({
        records_state: "RETENTION",
        legal_hold_status: "ACTIVE",
      });
    });
  });

  it("RRQ-08: disposition stays blocked while the hold is active, and only the hold blocks it", async () => {
    await ownerScenario(async (s) => {
      await addShortRetentionClass(s);
      await legalHoldTasks(s, caseB);
      await closeAndArchive(s, caseB);
      await s.as("legal");
      const holdId = await placeHold(s.tx, caseB);
      await s.as("records");
      await s.tx`select api.assign_retention_class(${caseB}, 'TEST_SHORT_RETENTION')`;
      await s.tx`select api.refresh_disposition_eligibility()`;
      expect((await recordsState(s.tx, caseB)).records_state).toBe("RETENTION");
      await s.expectError("CDF_CONFLICT:LEGAL_HOLD_ACTIVE", (tx) => requestDisposition(tx, caseB));

      await releaseHold(s, holdId);
      await s.as("records");
      await s.tx`select api.refresh_disposition_eligibility()`;
      expect((await recordsState(s.tx, caseB)).records_state).toBe("DISPOSITION_ELIGIBLE");
    });
  });

  it("RRQ-09: classifying records the class, closes the item for every officer and is audited", async () => {
    await scenario(async (s) => {
      await closeAndArchive(s, caseB);
      await s.as("recordsB");
      await s.tx`select api.assign_retention_class(${caseB}, 'WB_CASE_NOT_INVESTIGATED')`;
      const [catalogue] = await s.tx<{ retention_class: string; archive_status: string }[]>`
        select retention_class, archive_status from records.case_record_catalogue where case_id = ${caseB}`;
      expect(catalogue).toEqual({ retention_class: "WB_CASE_NOT_INVESTIGATED", archive_status: "RETENTION" });
      for (const user of ["records", "recordsB"] as const) {
        expect(await queue(s, user), user).toHaveLength(0);
        expect(await retentionWork(s, user), user).toEqual([]);
      }
      await s.as("internalAudit");
      const audit = await s.tx<{ actor_id: string; metadata: Record<string, unknown> }[]>`
        select actor_id, metadata from audit.audit_event
        where action = 'RETENTION_CLASS_ASSIGNED' and case_id = ${caseB}`;
      expect(audit).toEqual([
        { actor_id: USERS.recordsB, metadata: { from: "UNASSIGNED", to: "WB_CASE_NOT_INVESTIGATED" } },
      ]);
    });
  });

  // AGENT-09's follow-up to D8: an archived case the shared pool cannot take is never left without a prompt.
  it("RRQ-10: a restricted archived case goes to its case authority, who routes it to one eligible officer", async () => {
    await ownerScenario(async (s) => {
      await setArchived(s, caseExec, "CONFIDENTIAL");
      expect(await routeWork(s, "grcDirector", caseExec)).toEqual([
        {
          area: "CASES",
          view: "NEEDS_ACTION",
          category: "RETENTION_TO_ROUTE",
          target_type: "RECORD",
          case_id: caseExec,
          case_number: numberExec,
        },
      ]);
      expect(await canRoute(s, "grcDirector", caseExec)).toBe(true);
      for (const user of EVERYONE.filter((u) => u !== "grcDirector")) {
        expect(await routeWork(s, user, caseExec), user).toEqual([]);
        expect(await canRoute(s, user, caseExec), user).toBe(false);
      }

      // The officers the task command would accept: names only.
      const list = await reviewers(s, "grcDirector", caseExec);
      expect(list.map((r) => r.user_id).sort()).toEqual([USERS.records, USERS.recordsB].sort());
      expect(Object.keys(list[0]!).sort()).toEqual(["display_name", "display_name_ar", "user_id"]);

      // A person chooses the officer; the task then stands for the obligation.
      const taskId = await routeTo(s, "grcDirector", caseExec, "recordsB");
      expect(await routeWork(s, "grcDirector", caseExec)).toEqual([]);
      expect(await canRoute(s, "grcDirector", caseExec)).toBe(false);
      expect((await retentionWork(s, "recordsB", caseExec)).map((w) => [w.category, w.target_id])).toEqual([
        ["TASK_RETENTION_REVIEW", taskId],
      ]);
      expect(await retentionWork(s, "records", caseExec)).toEqual([]);
      expect((await reviewers(s, "grcDirector", caseExec)).map((r) => r.user_id)).toEqual([USERS.records]);

      await s.as("internalAudit");
      const audit = await s.tx<{ actor_id: string; metadata: Record<string, unknown> }[]>`
        select actor_id, metadata from audit.audit_event
        where action = 'CASE_TASK_ASSIGNED' and case_id = ${caseExec} and object_id = ${taskId}`;
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        actor_id: USERS.grcDirector,
        metadata: { task_type: "RETENTION_REVIEW", assigned_user_id: USERS.recordsB },
      });

      // The task is for classification only: it never opens the case, and classifying ends the work.
      await s.as("recordsB");
      const [opened] = await s.tx<{ ok: boolean }[]>`select api.open_case(${caseExec}) as ok`;
      expect(opened!.ok).toBe(false);
      await s.tx`select api.assign_retention_class(${caseExec}, 'WB_CASE_NOT_INVESTIGATED')`;
      await s.as("grcDirector");
      expect((await recordsState(s.tx, caseExec)).records_state).toBe("RETENTION");
      expect(await routeWork(s, "grcDirector", caseExec)).toEqual([]);
      // Classifying completes the officer's task: it leaves their work, and the task's access ends with it.
      expect(await retentionWork(s, "recordsB", caseExec)).toEqual([]);
      await s.asOwner();
      const [task] = await s.tx<{ status: string; closed_by: string; closure_reason: string }[]>`
        select status, closed_by, closure_reason from case_mgmt.case_task where id = ${taskId}`;
      expect(task).toEqual({
        status: "COMPLETED",
        closed_by: USERS.recordsB,
        closure_reason: "RETENTION_CLASS_ASSIGNED",
      });
      await s.as("recordsB");
      const [after] = await s.tx<{ ok: boolean }[]>`select authz.can_view_case_metadata(${caseExec}) as ok`;
      expect(after!.ok).toBe(false);
      await s.as("internalAudit");
      const completed = await s.tx<{ actor_id: string }[]>`
        select actor_id from audit.audit_event
        where action = 'CASE_TASK_COMPLETED' and case_id = ${caseExec} and object_id = ${taskId}`;
      expect(completed).toEqual([{ actor_id: USERS.recordsB }]);
    });
  });

  it("RRQ-11: a case the shared pool can take is never routed: the pool is its route", async () => {
    await scenario(async (s) => {
      await closeAndArchive(s, caseB);
      for (const user of EVERYONE) {
        expect(await routeWork(s, user, caseB), user).toEqual([]);
        expect(await canRoute(s, user, caseB), user).toBe(false);
      }
    });
  });

  it("RRQ-12: above every officer's clearance, the case authorities are told no officer is eligible", async () => {
    await ownerScenario(async (s) => {
      await setArchived(s, caseB, "SECRET");
      for (const user of ["grcDirector", "grcDeputy"] as const) {
        expect(
          (await routeWork(s, user, caseB)).map((w) => w.category),
          user,
        ).toEqual(["RETENTION_TO_ROUTE"]);
        expect(await reviewers(s, user, caseB), user).toEqual([]);
      }
      for (const user of EVERYONE.filter((u) => u !== "grcDirector" && u !== "grcDeputy")) {
        expect(await routeWork(s, user, caseB), user).toEqual([]);
      }
      await s.as("grcDirector");
      await s.expectError(
        "CDF_INVALID:assigned_user_id",
        (tx) => tx`select api.create_case_task(${caseB}, 'RETENTION_REVIEW', ${USERS.records},
                                                'Synthetic: retention review purpose.')`,
      );
    });
  });

  it("RRQ-13: the reviewer list refuses everyone else; a cancelled or lapsed task brings the item back", async () => {
    await ownerScenario(async (s) => {
      await setArchived(s, caseExec, "CONFIDENTIAL");
      for (const user of ["records", "recordsB", "caseManager", "legal", "investigatorA"] as const) {
        await s.as(user);
        await s.expectError(
          "CDF_NOT_FOUND",
          (tx) => tx`select * from api.list_retention_reviewers(${caseExec})`,
        );
      }
      const taskId = await routeTo(s, "grcDirector", caseExec, "records");
      expect(await routeWork(s, "grcDirector", caseExec)).toEqual([]);
      // The task holder sees the case's metadata but may not route records tasks on a restricted case.
      await s.as("records");
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select * from api.list_retention_reviewers(${caseExec})`,
      );

      await s.as("grcDirector");
      await s.tx`select api.cancel_case_task(${taskId}, 'Synthetic: officer unavailable.')`;
      expect((await routeWork(s, "grcDirector", caseExec)).map((w) => w.category)).toEqual([
        "RETENTION_TO_ROUTE",
      ]);

      // A task whose window has lapsed does not stand for the obligation (fixture: the command refuses to create
      // one, and now() is fixed for the whole transaction).
      await s.asOwner();
      await s.tx`
        insert into case_mgmt.case_task (case_id, task_type, assigned_user_id, assigned_role, purpose, scope, created_by,
                                         access_granted_at, expires_at)
        values (${caseExec}, 'RETENTION_REVIEW', ${USERS.recordsB}, 'RECORDS_OFFICER', 'Synthetic: lapsed retention task.',
                '{CASE_VIEW_METADATA,RETENTION_TASK_VIEW,RETENTION_TASK_EXECUTE}', ${USERS.grcDirector},
                now() - interval '2 days', now() - interval '1 day')`;
      expect((await routeWork(s, "grcDirector", caseExec)).map((w) => w.category)).toEqual([
        "RETENTION_TO_ROUTE",
      ]);
      expect(await retentionWork(s, "recordsB", caseExec)).toEqual([]);
    });
  });

  // AGENT-09's review of the routing delta: completion is the classifier's own, never another officer's.
  it("RRQ-14: classifying completes only the classifier's own task; another officer's task stays open", async () => {
    await ownerScenario(async (s) => {
      await closeAndArchive(s, caseB);
      const mine = await giveTask(s, caseB, "records", "RETENTION_REVIEW");
      const theirs = await giveTask(s, caseB, "recordsB", "RETENTION_REVIEW");
      await s.as("records");
      await s.tx`select api.assign_retention_class(${caseB}, 'WB_CASE_NOT_INVESTIGATED')`;

      await s.asOwner();
      const tasks = await s.tx<{ id: string; status: string; closed_by: string | null }[]>`
        select id, status, closed_by from case_mgmt.case_task where id in (${mine}, ${theirs})`;
      expect(tasks.find((t) => t.id === mine)).toMatchObject({
        status: "COMPLETED",
        closed_by: USERS.records,
      });
      expect(tasks.find((t) => t.id === theirs)).toMatchObject({ status: "OPEN", closed_by: null });
      expect((await retentionWork(s, "recordsB")).map((w) => [w.category, w.target_id])).toEqual([
        ["TASK_RETENTION_REVIEW", theirs],
      ]);
      await s.as("internalAudit");
      const completed = await s.tx<{ object_id: string }[]>`
        select object_id from audit.audit_event where action = 'CASE_TASK_COMPLETED' and case_id = ${caseB}`;
      expect(completed).toEqual([{ object_id: mine }]);
    });
  });

  // A task stands for the obligation only while its holder can still act on it.
  it("RRQ-15: a task whose holder lost the role or the clearance no longer hides the obligation", async () => {
    for (const lose of ["role", "clearance"] as const) {
      await ownerScenario(async (s) => {
        await setArchived(s, caseExec, "CONFIDENTIAL");
        const taskId = await routeTo(s, "grcDirector", caseExec, "recordsB");
        expect(await routeWork(s, "grcDirector", caseExec), lose).toEqual([]);

        await s.asOwner();
        if (lose === "role") {
          await s.tx`update iam.user_role_assignment set status = 'REVOKED', revoked_at = now(),
                       revocation_reason = 'Synthetic: left records.'
                     where user_id = ${USERS.recordsB} and role_code = 'RECORDS_OFFICER'`;
        } else {
          await s.tx`update iam.user_profile set clearance = 'RESTRICTED' where id = ${USERS.recordsB}`;
        }
        const [task] = await s.tx<{ status: string }[]>`
          select status from case_mgmt.case_task where id = ${taskId}`;
        expect(task!.status, lose).toBe("OPEN"); // still open, but its holder can no longer classify

        expect(
          (await routeWork(s, "grcDirector", caseExec)).map((w) => w.category),
          lose,
        ).toEqual(["RETENTION_TO_ROUTE"]);
        expect(await canRoute(s, "grcDirector", caseExec), lose).toBe(true);
        expect(
          (await reviewers(s, "grcDirector", caseExec)).map((r) => r.user_id),
          lose,
        ).toEqual([USERS.records]);
        // The holder keeps no case reference: without the role the item is gone; without the clearance it is masked.
        const left = await retentionWork(s, "recordsB", caseExec);
        expect(
          left.map((w) => [w.case_id, w.case_number]),
          lose,
        ).toEqual(lose === "role" ? [] : [[null, null]]);
      });
    }
  });
});

/** Moves a case to ARCHIVED at a given classification as the owner (fixture; no workflow event). */
async function setArchived(s: OwnerScenario, id: string, classification: string): Promise<void> {
  await s.asOwner();
  await s.tx`update case_mgmt.case_record set classification = ${classification}::core.classification_level
             where id = ${id}`;
  await s.tx`update case_mgmt.case_record set records_state = 'ARCHIVED', closed_at = coalesce(closed_at, now())
             where id = ${id}`;
}
