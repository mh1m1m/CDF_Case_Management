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

let caseB: string, caseExec: string, numberB: string;
beforeAll(async () => {
  [caseB, caseExec] = await Promise.all([caseId("0002"), caseId("0003")]);
  const [row] = await admin<{ case_number: string }[]>`
    select case_number from case_mgmt.case_record where id = ${caseB}`;
  numberB = row!.case_number;
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
});

/** Moves a case to ARCHIVED at a given classification as the owner (fixture; no workflow event). */
async function setArchived(s: OwnerScenario, id: string, classification: string): Promise<void> {
  await s.asOwner();
  await s.tx`update case_mgmt.case_record set classification = ${classification}::core.classification_level
             where id = ${id}`;
  await s.tx`update case_mgmt.case_record set records_state = 'ARCHIVED', closed_at = coalesce(closed_at, now())
             where id = ${id}`;
}
