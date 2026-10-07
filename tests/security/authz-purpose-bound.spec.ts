// CDF-73 / ADR-014: purpose-bound, task-scoped and lifecycle-aware access (Fady's option D, §21–§23, §28).
// Every test talks to the database exactly as the BFF does (role authenticated + JWT claims), so these
// prove that RLS and the authz.* / api.* functions enforce the model even if the UI is bypassed.
// Test ids (PBA-Tnn) are traced in compliance/evidence/CDF-73_PURPOSE_BOUND_ACCESS.md.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { Tx } from "@cdf/infrastructure";
import {
  admin,
  caseId,
  ownerScenario,
  scenario,
  USERS,
  type OwnerScenario,
  type Scenario,
} from "../support/db";
import {
  addShortRetentionClass,
  closeAndArchive,
  DECISION,
  giveTask,
  JUSTIFICATION,
  placeHold,
  PURPOSE,
} from "../support/records";

let caseA: string, caseB: string, caseExec: string;
let numberA: string, numberB: string, numberExec: string;
let activeCases: number;

beforeAll(async () => {
  [caseA, caseB, caseExec] = await Promise.all([caseId("0001"), caseId("0002"), caseId("0003")]);
  const rows = await admin<{ id: string; case_number: string }[]>`
    select id, case_number from case_mgmt.case_record where id in (${caseA}, ${caseB}, ${caseExec})`;
  const num = (id: string) => rows.find((r) => r.id === id)!.case_number;
  [numberA, numberB, numberExec] = [num(caseA), num(caseB), num(caseExec)];
  const [n] = await admin<{ n: number }[]>`
    select count(*)::int as n from case_mgmt.case_record where records_state = 'ACTIVE'`;
  activeCases = n!.n;
});

const CATALOGUE_COLUMNS = [
  "archive_status",
  "case_id",
  "case_number",
  "case_type",
  "classification",
  "closed_date",
  "disposition_status",
  "legal_hold_status",
  "record_owner",
  "retention_class",
  "retention_end_date",
  "retention_start_date",
];

/** Every way the caller could learn about cases: rows, counts, search totals, dashboards, case reads. */
async function footprint(tx: Tx) {
  const ids = (rows: { case_id?: string; id?: string }[]) => rows.map((r) => r.case_id ?? r.id).sort();
  const catalogue = ids(await tx`select case_id from records.case_record_catalogue`);
  const listRecords = ids(await tx`select case_id from api.list_records()`);
  const search = await tx<{ case_id: string; total_count: string }[]>`
    select case_id, total_count from api.search_records_catalogue(null, null, null, 200, 0)`;
  const prefix = await tx<{ total_count: string }[]>`
    select total_count from api.search_records_catalogue('CDF-DEMO', null, null, 1, 0)`;
  const overview = ids(await tx`select id from case_mgmt.case_overview`);
  const [counts] = await tx<{ records: number; allegations: number; tasks: number; holds: number }[]>`
    select (select count(*) from case_mgmt.case_record)::int as records,
           (select count(*) from case_mgmt.allegation)::int as allegations,
           (select count(*) from case_mgmt.case_task)::int as tasks,
           (select count(*) from records.legal_hold)::int as holds`;
  return {
    catalogue,
    listRecords,
    search: ids(search),
    searchTotal: Number(search[0]?.total_count ?? 0),
    prefixTotal: Number(prefix[0]?.total_count ?? 0),
    overview,
    ...counts!,
  };
}

const opened = async (tx: Tx, fn: "open_case" | "open_case_metadata", id: string) => {
  const [r] = await tx.unsafe<{ ok: boolean }[]>(`select api.${fn}($1) as ok`, [id]);
  return r!.ok;
};

/** Moves a case to a post-closure records state as the owner (fixture; lifecycle columns only). */
async function setRecordsState(
  s: OwnerScenario,
  id: string,
  state: string,
  extra: { lowerTo?: string } = {},
) {
  await s.asOwner();
  if (extra.lowerTo) {
    await s.tx`update case_mgmt.case_record set classification = ${extra.lowerTo}::core.classification_level where id = ${id}`;
  }
  await s.tx`update case_mgmt.case_record set records_state = ${state}, closed_at = coalesce(closed_at, now()) where id = ${id}`;
}

async function lookup(tx: Tx, reference: string, justification = JUSTIFICATION) {
  const [row] = await tx<
    {
      outcome: string;
      request_id: string | null;
      case_id: string | null;
      case_number: string | null;
      legal_hold_status: string | null;
    }[]
  >`select * from api.request_case_for_legal_hold(${reference}, ${justification})`;
  return row!;
}

async function actions(s: Scenario, caseFilter: string | null, like: string): Promise<string[]> {
  await s.as("soc"); // SECURITY events
  const sec = await s.tx<{ action: string }[]>`
    select action from audit.audit_event where category = 'SECURITY' and action like ${like}
      and (${caseFilter}::uuid is null or case_id = ${caseFilter}::uuid) order by seq`;
  await s.as("internalAudit"); // BUSINESS events
  const biz = await s.tx<{ action: string }[]>`
    select action from audit.audit_event where category = 'BUSINESS' and action like ${like}
      and (${caseFilter}::uuid is null or case_id = ${caseFilter}::uuid) order by seq`;
  return [...sec, ...biz].map((r) => r.action);
}

// =====================================================================================================
describe("§28.1, §28.2, §22: unassigned records and legal staff cannot enumerate active investigations", () => {
  it("PBA-T01: no rows, no counts, no search totals, no case reads for an unrelated active case", async () => {
    await scenario(async (s) => {
      for (const user of ["records", "legal"] as const) {
        await s.as(user);
        const f = await footprint(s.tx);
        expect(f).toEqual({
          catalogue: [],
          listRecords: [],
          search: [],
          searchTotal: 0,
          prefixTotal: 0,
          overview: [],
          records: 0,
          allegations: 0,
          tasks: 0,
          holds: 0,
        });
        const [work] = await s.tx`select * from api.my_work_summary()`;
        expect(Object.values(work!)).toEqual([0, 0, 0, 0, 0, 0]);
      }
    });
  });

  it("PBA-T02: opening an active case by UUID behaves exactly like a missing UUID, and is audited", async () => {
    await scenario(async (s) => {
      for (const user of ["records", "legal"] as const) {
        await s.as(user);
        for (const target of [caseA, randomUUID()]) {
          expect(await opened(s.tx, "open_case", target)).toBe(false);
          expect(await opened(s.tx, "open_case_metadata", target)).toBe(false);
          expect(
            await s.tx`select 1 from records.case_record_catalogue where case_id = ${target}`,
          ).toHaveLength(0);
          expect(await s.tx`select 1 from api.list_records(null, ${target})`).toHaveLength(0);
          await s.expectError("CDF_NOT_FOUND", (tx) => placeHold(tx, target));
          await s.expectError(
            "CDF_NOT_FOUND",
            (tx) => tx`select api.request_legal_hold(${target}, 'LITIGATION', ${JUSTIFICATION})`,
          );
          await s.expectError(
            "CDF_NOT_FOUND",
            (tx) =>
              tx`select api.create_case_task(${target}, 'LEGAL_HOLD_APPLICATION', ${USERS[user]}, ${PURPOSE})`,
          );
          await s.expectError(
            "CDF_NOT_FOUND",
            (tx) => tx`select api.request_break_glass(${target}, ${JUSTIFICATION}, 60)`,
          );
        }
      }
      // The denials are SECURITY events (visible to the SOC, not to the actor).
      const denied = await actions(s, null, "CASE_ACCESS_DENIED");
      expect(denied.length).toBeGreaterThanOrEqual(8);
    });
  });

  it("PBA-T03: the authz predicates agree with the commands (direct RPC)", async () => {
    await scenario(async (s) => {
      for (const user of ["records", "legal"] as const) {
        await s.as(user);
        const [p] = await s.tx`
          select authz.can_view_case(${caseA}) as content, authz.can_view_case_metadata(${caseA}) as metadata,
                 authz.can_view_records_catalogue(${caseA}) as catalogue, authz.can_apply_legal_hold(${caseA}) as apply,
                 authz.can_request_legal_hold(${caseA}) as request, authz.can_manage_retention(${caseA}) as retention`;
        expect(Object.values(p!)).toEqual([false, false, false, false, false, false]);
      }
    });
  });

  it("PBA-T04: GRC and the case team keep their access (regression)", async () => {
    await scenario(async (s) => {
      await s.as("grcDirector");
      const seen = (await s.tx<{ id: string }[]>`select id from case_mgmt.case_overview`).map((r) => r.id);
      expect(seen).toEqual(expect.arrayContaining([caseA, caseB, caseExec])); // CASE_VIEW_ALL + owner of the restricted case
      expect(seen.length).toBeGreaterThanOrEqual(activeCases);
      await s.as("investigatorA");
      expect(await opened(s.tx, "open_case", caseA)).toBe(true);
      expect(await opened(s.tx, "open_case_metadata", caseA)).toBe(true);
      await s.as("caseManager");
      expect(await opened(s.tx, "open_case", caseExec)).toBe(false); // restricted rule unchanged
    });
  });
});

// =====================================================================================================
describe("§4, §10, §12, §22: task-scoped access", () => {
  it("PBA-T05: a legal-hold task shows that one case's minimum metadata and lets the reviewer apply the hold", async () => {
    await scenario(async (s) => {
      const taskId = await giveTask(s, caseA, "legal", "LEGAL_HOLD_ASSESSMENT");
      await s.as("legal");
      const rows = await s.tx<Record<string, unknown>[]>`select * from records.case_record_catalogue`;
      expect(rows.map((r) => r.case_id)).toEqual([caseA]); // case A only, never B, C, D
      expect(Object.keys(rows[0]!).sort()).toEqual(CATALOGUE_COLUMNS);
      expect(rows[0]).toMatchObject({
        case_number: numberA,
        archive_status: "ACTIVE",
        legal_hold_status: "NONE",
      });
      const f = await footprint(s.tx);
      expect(f.searchTotal).toBe(1);
      expect(f.overview).toEqual([]);
      expect(f.allegations).toBe(0);
      const [opening] = await s.tx<{ ok: boolean }[]>`select api.open_case_task(${taskId}) as ok`;
      expect(opening!.ok).toBe(true);
      await placeHold(s.tx, caseA);
      const [mine] = await s.tx<
        { task_type: string; case_number: string }[]
      >`select * from api.my_case_tasks()`;
      expect(mine).toMatchObject({ task_type: "LEGAL_HOLD_ASSESSMENT", case_number: numberA });
      const [work] = await s.tx<{ assigned_legal_holds: number }[]>`select * from api.my_work_summary()`;
      expect(work!.assigned_legal_holds).toBe(1);
    });
  });

  it("PBA-T06: a task never confers content, evidence download, identity or interview access", async () => {
    await ownerScenario(async (s) => {
      await s.as("investigatorA");
      const [ev] = await s.tx<{ versionId: string }[]>`
        select o_version_id as "versionId" from api.register_evidence_version(${caseA}, null, 'Synthetic extract', null,
          'DOCUMENT', 'Synthetic source', null, 'CONFIDENTIAL'::core.classification_level, 'extract.pdf', 'application/pdf',
          2048, ${"7".repeat(64)})`;
      await s.tx`select api.complete_evidence_version(${ev!.versionId}, 'CLEAN', 'test-scanner')`;
      for (const type of ["LEGAL_REVIEW", "LEGAL_HOLD_ASSESSMENT", "LEGAL_HOLD_RELEASE"]) {
        await giveTask(s, caseA, "legal", type);
      }
      await giveTask(s, caseA, "records", "LEGAL_HOLD_APPLICATION");
      for (const user of ["legal", "records"] as const) {
        await s.as(user);
        expect(await opened(s.tx, "open_case", caseA)).toBe(false);
        expect(await s.tx`select * from api.open_evidence_version(${ev!.versionId})`).toHaveLength(0);
        expect(await s.tx`select 1 from evidence.evidence where case_id = ${caseA}`).toHaveLength(0);
        expect(await s.tx`select 1 from case_mgmt.case_person where case_id = ${caseA}`).toHaveLength(0);
        expect(await s.tx`select 1 from intake.report where case_id = ${caseA}`).toHaveLength(0);
        await s.expectError(
          "CDF_NOT_FOUND",
          (tx) => tx`select * from api.resolve_reporter_identity(${caseA}, ${JUSTIFICATION})`,
        );
        const [p] = await s.tx`
          select authz.can_view_case_content(${caseA}) as content, authz.can_view_case_metadata(${caseA}) as metadata`;
        expect(p).toEqual({ content: false, metadata: true });
      }
    });
  });

  it("PBA-T07: completion, cancellation and expiry end task-derived access automatically", async () => {
    await ownerScenario(async (s) => {
      const visible = async () => (await s.tx`select 1 from records.case_record_catalogue`).length;
      // Completion by the assignee.
      const done = await giveTask(s, caseA, "legal", "LEGAL_REVIEW");
      await s.as("legal");
      expect(await visible()).toBe(1);
      await s.tx`select api.complete_case_task(${done}, 'Synthetic: review complete.')`;
      expect(await visible()).toBe(0);
      // Cancellation by the creator.
      const cancelled = await giveTask(s, caseA, "legal", "LEGAL_REVIEW");
      await s.as("legal");
      expect(await visible()).toBe(1);
      await s.as("caseManager");
      await s.tx`select api.cancel_case_task(${cancelled}, 'Synthetic: no longer needed')`;
      await s.as("legal");
      expect(await visible()).toBe(0);
      // Expiry: access stops at expires_at, before any housekeeping runs.
      await s.asOwner();
      const [lapsed] = await s.tx<{ id: string }[]>`
        insert into case_mgmt.case_task (case_id, task_type, assigned_user_id, assigned_role, purpose, scope, created_by,
                                         access_granted_at, expires_at)
        values (${caseA}, 'LEGAL_REVIEW', ${USERS.legal}, 'LEGAL_REVIEWER', ${PURPOSE}, '{CASE_VIEW_METADATA}',
                ${USERS.caseManager}, now() - interval '2 days', now() - interval '1 day') returning id`;
      await s.as("legal");
      expect(await visible()).toBe(0);
      const [openLapsed] = await s.tx<{ ok: boolean }[]>`select api.open_case_task(${lapsed!.id}) as ok`;
      expect(openLapsed!.ok).toBe(false);
      await s.as("records");
      const [n] = await s.tx<{ n: number }[]>`select api.expire_case_tasks() as n`;
      expect(n!.n).toBe(1);
      await s.asOwner();
      const statuses = await s.tx<{ status: string }[]>`
        select status from case_mgmt.case_task where case_id = ${caseA} order by created_at, status`;
      expect(statuses.map((r) => r.status).sort()).toEqual(["CANCELLED", "COMPLETED", "EXPIRED"]);
      // Terminal tasks cannot be revived, by anyone.
      await s.expectError(
        "case task",
        (tx) => tx`update case_mgmt.case_task set status = 'OPEN' where id = ${done}`,
      );
      await s.expectError(
        "case_mgmt.case_task is a protected record",
        (tx) => tx`delete from case_mgmt.case_task`,
      );
      // Revoking the role also ends access, task or not.
      const live = await giveTask(s, caseA, "legal", "LEGAL_REVIEW");
      expect(live).toBeTruthy();
      await s.asOwner();
      await s.tx`update iam.user_role_assignment set status = 'REVOKED', revoked_at = now(), revocation_reason = 'Synthetic'
                 where user_id = ${USERS.legal}`;
      await s.as("legal");
      expect(await visible()).toBe(0);
    });
  });

  it("PBA-T08: a task grants only its scope, and RBAC still applies on top of it", async () => {
    await scenario(async (s) => {
      await giveTask(s, caseA, "legal", "LEGAL_HOLD_ASSESSMENT", { scope: ["CASE_VIEW_METADATA"] });
      await s.as("legal");
      await s.expectError("CDF_FORBIDDEN", (tx) => placeHold(tx, caseA)); // apply not in scope
      await s.as("caseManager");
      await s.expectError(
        "CDF_INVALID:scope",
        (tx) =>
          tx`select api.create_case_task(${caseA}, 'LEGAL_REVIEW', ${USERS.legalB}, ${PURPOSE}, '{CASE_VIEW_METADATA,CASE_VIEW_CONTENT}')`,
      );
      await s.expectError(
        "CDF_INVALID:scope",
        (tx) =>
          tx`select api.create_case_task(${caseA}, 'LEGAL_REVIEW', ${USERS.legalB}, ${PURPOSE}, '{CASE_VIEW_METADATA,EVIDENCE_DOWNLOAD}')`,
      );
      // Ineligible assignee (investigator for a legal task), out-of-range expiry, records task on an active case.
      await s.expectError(
        "CDF_INVALID:assigned_user_id",
        (tx) => tx`select api.create_case_task(${caseA}, 'LEGAL_REVIEW', ${USERS.investigatorB}, ${PURPOSE})`,
      );
      await s.expectError(
        "CDF_INVALID:expires_at",
        (tx) =>
          tx`select api.create_case_task(${caseA}, 'LEGAL_REVIEW', ${USERS.legalB}, ${PURPOSE}, null, null, now() + interval '1 year')`,
      );
      await s.expectError(
        "CDF_CONFLICT:CASE_NOT_CLOSED",
        (tx) => tx`select api.create_case_task(${caseA}, 'RETENTION_REVIEW', ${USERS.records}, ${PURPOSE})`,
      );
      // A records officer with a legal-hold task still cannot review requests (no LEGAL_HOLD_REVIEW role permission).
      await giveTask(s, caseA, "records", "LEGAL_HOLD_APPLICATION");
      await s.as("records");
      const [p] = await s.tx`select authz.can_review_legal_hold(${caseA}) as review`;
      expect(p!.review).toBe(false);
    });
  });

  it("PBA-T09: records and legal staff cannot grant themselves tasks on cases they cannot see", async () => {
    await scenario(async (s) => {
      await s.as("legal");
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) =>
          tx`select api.create_case_task(${caseA}, 'LEGAL_HOLD_ASSESSMENT', ${USERS.legal}, ${PURPOSE})`,
      );
      await giveTask(s, caseA, "legal", "LEGAL_REVIEW");
      await s.as("legal"); // seeing the metadata is not authority to create tasks
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) =>
          tx`select api.create_case_task(${caseA}, 'LEGAL_HOLD_ASSESSMENT', ${USERS.legal}, ${PURPOSE})`,
      );
      await s.as("investigatorA"); // case access without CASE_TASK_ASSIGN
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.create_case_task(${caseA}, 'LEGAL_REVIEW', ${USERS.legalB}, ${PURPOSE})`,
      );
    });
  });
});

// =====================================================================================================
describe("§7, §8, §14, §28.3, §28.4: archived cases and the records catalogue", () => {
  it("PBA-T10: legal cannot browse unrelated archived cases; records see catalogue metadata only", async () => {
    await scenario(async (s) => {
      await closeAndArchive(s, caseB);
      await s.as("legal");
      const legalView = await footprint(s.tx);
      expect(legalView.catalogue).toEqual([]);
      expect(legalView.searchTotal).toBe(0);
      expect(await opened(s.tx, "open_case_metadata", caseB)).toBe(false);
      await s.expectError("CDF_NOT_FOUND", (tx) => placeHold(tx, caseB));

      await s.as("records");
      const rows = await s.tx<Record<string, unknown>[]>`select * from records.case_record_catalogue`;
      expect(rows.map((r) => r.case_id)).toEqual([caseB]);
      expect(rows[0]).toMatchObject({ case_number: numberB, archive_status: "ARCHIVED" });
      expect(Object.keys(rows[0]!).sort()).toEqual(CATALOGUE_COLUMNS);
      expect(JSON.stringify(rows)).not.toMatch(/Tender|tender|Vendor|Synthetic case/);
      const f = await footprint(s.tx);
      expect(f.searchTotal).toBe(1);
      expect(f.prefixTotal).toBe(1); // a broad prefix counts only authorised rows
      expect(f.overview).toEqual([]);
      expect(f.allegations).toBe(0);
      expect(await opened(s.tx, "open_case", caseB)).toBe(false);
      expect(await opened(s.tx, "open_case_metadata", caseB)).toBe(true);
    });
  });

  it("PBA-T11: records can administer the lifecycle in the catalogue scope without content access", async () => {
    await ownerScenario(async (s) => {
      await closeAndArchive(s, caseB);
      await s.as("records");
      await s.tx`select api.assign_retention_class(${caseB}, 'WB_CASE_NOT_INVESTIGATED')`;
      await placeHold(s.tx, caseB); // legal preservation is a records purpose too
      const [row] = await s.tx`select archive_status, legal_hold_status from records.case_record_catalogue`;
      expect(row).toEqual({ archive_status: "RETENTION", legal_hold_status: "ACTIVE" });
      expect(await s.tx`select 1 from case_mgmt.allegation where case_id = ${caseB}`).toHaveLength(0);
    });
  });

  it("PBA-T12: archive state never removes need-to-know for legal; a task restores exactly one case", async () => {
    await scenario(async (s) => {
      await closeAndArchive(s, caseB);
      await giveTask(s, caseB, "legal", "LEGAL_HOLD_ASSESSMENT");
      await s.as("legal");
      expect((await footprint(s.tx)).catalogue).toEqual([caseB]);
    });
  });
});

// =====================================================================================================
describe("§9, §28.6: restricted cases stay protected at every lifecycle state", () => {
  it("PBA-T13: records and legal never discover a restricted case because it is closed or archived", async () => {
    for (const state of ["CLOSED", "ARCHIVED", "RETENTION", "DISPOSITION_ELIGIBLE"]) {
      await ownerScenario(async (s) => {
        await setRecordsState(s, caseExec, state, { lowerTo: "CONFIDENTIAL" });
        for (const user of ["records", "legal", "internalAudit"] as const) {
          await s.as(user);
          const f = await footprint(s.tx);
          expect(f.catalogue).not.toContain(caseExec);
          expect(f.listRecords).not.toContain(caseExec);
          expect(f.search).not.toContain(caseExec);
          expect(await opened(s.tx, "open_case_metadata", caseExec)).toBe(false);
        }
        await s.as("legal");
        expect((await lookup(s.tx, numberExec)).outcome).toBe("NO_MATCH");
        await s.as("records");
        await s.expectError(
          "CDF_NOT_FOUND",
          (tx) => tx`select api.assign_retention_class(${caseExec}, 'WB_CASE_INVESTIGATED')`,
        );
      });
    }
  });

  it("PBA-T14: an approved records-lifecycle task gives the minimum metadata of a restricted case; clearance still wins", async () => {
    await ownerScenario(async (s) => {
      await setRecordsState(s, caseExec, "ARCHIVED");
      // SECRET case, CONFIDENTIAL records officer: not even GRC can task them onto it.
      await s.as("grcDirector");
      await s.expectError(
        "CDF_INVALID:assigned_user_id",
        (tx) =>
          tx`select api.create_case_task(${caseExec}, 'RETENTION_REVIEW', ${USERS.records}, ${PURPOSE})`,
      );
    });
    await ownerScenario(async (s) => {
      await setRecordsState(s, caseExec, "ARCHIVED", { lowerTo: "CONFIDENTIAL" });
      await s.as("records"); // the catalogue scope does not reach restricted cases, so no self-tasking
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) =>
          tx`select api.create_case_task(${caseExec}, 'RETENTION_REVIEW', ${USERS.records}, ${PURPOSE})`,
      );
      const taskId = await giveTask(s, caseExec, "records", "RETENTION_REVIEW", { by: "grcDirector" });
      await s.as("records");
      expect((await footprint(s.tx)).catalogue).toEqual([caseExec]);
      const [o] = await s.tx<{ ok: boolean }[]>`select api.open_case_task(${taskId}) as ok`;
      expect(o!.ok).toBe(true);
      await s.tx`select api.assign_retention_class(${caseExec}, 'WB_CASE_INVESTIGATED')`;
      expect(await opened(s.tx, "open_case", caseExec)).toBe(false);
      await s.as("recordsB"); // another records officer still sees nothing
      expect((await footprint(s.tx)).catalogue).toEqual([]);
      const audit = await actions(s, caseExec, "RE%");
      expect(audit).toEqual(expect.arrayContaining(["RECORDS_TASK_OPENED", "RETENTION_REVIEW_STARTED"]));
    });
  });

  it("PBA-T15: a disposition can run end to end on a restricted case through tasks only", async () => {
    await ownerScenario(async (s) => {
      await addShortRetentionClass(s);
      await setRecordsState(s, caseExec, "ARCHIVED", { lowerTo: "CONFIDENTIAL" });
      await giveTask(s, caseExec, "records", "RETENTION_REVIEW", { by: "grcDirector" });
      await giveTask(s, caseExec, "records", "DISPOSITION_REVIEW", { by: "grcDirector" });
      await s.as("records");
      await s.tx`select api.assign_retention_class(${caseExec}, 'TEST_SHORT_RETENTION')`;
      await s.tx`select api.refresh_disposition_eligibility()`;
      const [req] = await s.tx<{ id: string }[]>`select api.request_disposition(${caseExec}) as id`;
      await s.as("grcDirector"); // owner of the restricted case
      await s.tx`select api.decide_disposition(${req!.id}, true, ${DECISION})`;
      await s.as("records");
      await s.tx`select api.execute_disposition(${req!.id})`;
      const [row] = await s.tx`select archive_status, disposition_status from records.case_record_catalogue`;
      expect(row).toEqual({ archive_status: "DISPOSED", disposition_status: "DISPOSED" });
    });
  });
});

// =====================================================================================================
describe("§5, §6, §28.5: legal hold through a controlled, purpose-bound process", () => {
  it("PBA-T16: the lookup accepts only an exact case number with a justification, and returns the minimum", async () => {
    await scenario(async (s) => {
      await s.as("legal");
      for (const bad of [
        "CDF-DEMO-%",
        "CDF-DEMO-2026-*",
        "%",
        "",
        numberA.slice(0, -1) + "_",
        "0001",
        `${numberA} OR 1=1`,
      ]) {
        await s.expectError("CDF_INVALID:case_reference", (tx) => lookup(tx, bad));
      }
      await s.expectError("CDF_INVALID:justification", (tx) => lookup(tx, numberA, "too short"));
      const hit = await lookup(s.tx, numberA);
      expect(Object.keys(hit).sort()).toEqual([
        "case_id",
        "case_number",
        "legal_hold_status",
        "outcome",
        "request_id",
      ]);
      expect(hit).toMatchObject({
        outcome: "MATCHED",
        case_id: caseA,
        case_number: numberA,
        legal_hold_status: "NONE",
      });
      // Missing, restricted and conflicted all look the same.
      expect(await lookup(s.tx, "CDF-DEMO-2026-9999")).toMatchObject({ outcome: "NO_MATCH", case_id: null });
      expect(await lookup(s.tx, numberExec)).toMatchObject({ outcome: "NO_MATCH", case_id: null });
    });
  });

  it("PBA-T17: discovery opens no content, task or grant; it only files a request", async () => {
    await scenario(async (s) => {
      await s.as("legal");
      const hit = await lookup(s.tx, numberA);
      const f = await footprint(s.tx);
      expect(f.catalogue).toEqual([]);
      expect(f.overview).toEqual([]);
      expect(f.tasks).toBe(0);
      await s.expectError("CDF_NOT_FOUND", (tx) => placeHold(tx, caseA));
      const [req] =
        await s.tx`select status, origin, requested_by from records.legal_hold_request where id = ${hit.request_id}`;
      expect(req).toEqual({ status: "SUBMITTED", origin: "CONTROLLED_LOOKUP", requested_by: USERS.legal });
      const [work] = await s.tx<{ my_legal_hold_requests: number }[]>`select * from api.my_work_summary()`;
      expect(work!.my_legal_hold_requests).toBe(1);
    });
  });

  it("PBA-T18: the lookup is rate limited, needs CASE_DISCOVER, and every attempt is audited", async () => {
    await scenario(async (s) => {
      await s.as("investigatorA");
      await s.expectError("CDF_FORBIDDEN", (tx) => lookup(tx, numberA));
      await s.as("legal");
      const outcomes: string[] = [];
      for (let i = 0; i < 6; i++)
        outcomes.push((await lookup(s.tx, i % 2 ? numberA : "CDF-DEMO-2026-9999")).outcome);
      expect(outcomes).toEqual(["NO_MATCH", "MATCHED", "NO_MATCH", "MATCHED", "NO_MATCH", "RATE_LIMITED"]);
      await s.as("soc");
      const events = await s.tx<
        { case_id: string | null; metadata: Record<string, string>; outcome: string; actor_id: string }[]
      >`
        select case_id, metadata, outcome, actor_id from audit.audit_event
        where action = 'CASE_DISCOVERY_REQUESTED' and actor_id = ${USERS.legal} order by seq`;
      expect(events.map((e) => e.metadata.outcome)).toEqual(outcomes);
      expect(events.every((e) => e.actor_id === USERS.legal && e.metadata.purpose === "LEGAL_HOLD")).toBe(
        true,
      );
      expect(events.map((e) => e.case_id)).toEqual([null, caseA, null, caseA, null, null]);
      expect(events[5]!.outcome).toBe("DENIED");
      expect(JSON.stringify(events)).not.toMatch(/Synthetic/); // justification never in the audit
    });
  });

  it("PBA-T19: lookup → request → assigned assessment task → hold applied → task closed → access gone", async () => {
    await scenario(async (s) => {
      await s.as("legal");
      const hit = await lookup(s.tx, numberA);
      await s.as("caseManager"); // the case authority sees the request and routes it
      const [visible] =
        await s.tx`select status from records.legal_hold_request where id = ${hit.request_id}`;
      expect(visible).toEqual({ status: "SUBMITTED" });
      const [t] = await s.tx<{ id: string }[]>`
        select api.assign_legal_hold_request(${hit.request_id}, ${USERS.legal}) as id`;
      await s.as("legal");
      expect((await footprint(s.tx)).catalogue).toEqual([caseA]);
      const [o] = await s.tx<{ ok: boolean }[]>`select api.open_case_task(${t!.id}) as ok`;
      expect(o!.ok).toBe(true);
      const [h] = await s.tx<{ id: string }[]>`
        select api.review_legal_hold_request(${hit.request_id}, true, 'Synthetic: preservation is required.') as id`;
      await s.as("grcDirector");
      const [hold] = await s.tx`select status, placed_by from records.legal_hold where id = ${h!.id}`;
      expect(hold).toEqual({ status: "ACTIVE", placed_by: USERS.legal });
      const [req] =
        await s.tx`select status, legal_hold_id from records.legal_hold_request where id = ${hit.request_id}`;
      expect(req).toEqual({ status: "APPLIED", legal_hold_id: h!.id });
      await s.as("legal"); // the task is complete: the case is gone again
      expect((await footprint(s.tx)).catalogue).toEqual([]);
      const audit = await actions(s, caseA, "%");
      expect(audit).toEqual(
        expect.arrayContaining([
          "CASE_DISCOVERY_REQUESTED",
          "LEGAL_HOLD_CASE_DISCOVERED",
          "LEGAL_HOLD_REQUESTED",
          "CASE_TASK_ASSIGNED",
          "RECORDS_TASK_OPENED",
          "LEGAL_HOLD_PLACED",
          "LEGAL_HOLD_REVIEWED",
          "CASE_TASK_COMPLETED",
        ]),
      );
    });
  });

  it("PBA-T20: a case-team request can be routed and rejected; only the assigned reviewer may decide", async () => {
    await scenario(async (s) => {
      await s.as("lead"); // an authorised business user on case A
      const [r] = await s.tx<{ id: string }[]>`
        select api.request_legal_hold(${caseA}, 'REGULATORY_INQUIRY', ${JUSTIFICATION}) as id`;
      await s.as("grcDirector");
      await s.tx`select api.assign_legal_hold_request(${r!.id}, ${USERS.legalB})`;
      await s.as("legal"); // not the assigned reviewer
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) =>
          tx`select api.review_legal_hold_request(${r!.id}, true, 'Synthetic: preservation is required.')`,
      );
      await s.as("legalB");
      await s.tx`select api.review_legal_hold_request(${r!.id}, false, 'Synthetic: no preservation duty.')`;
      await s.as("grcDirector");
      const [req] =
        await s.tx`select status, reviewed_by from records.legal_hold_request where id = ${r!.id}`;
      expect(req).toEqual({ status: "REJECTED", reviewed_by: USERS.legalB });
      expect(await s.tx`select 1 from records.legal_hold where case_id = ${caseA}`).toHaveLength(0);
      await s.as("investigatorB"); // no access to case A: cannot request a hold on it
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) => tx`select api.request_legal_hold(${caseA}, 'LITIGATION', ${JUSTIFICATION})`,
      );
    });
  });
});

// =====================================================================================================
describe("§20: break-glass is exceptional, approved by someone else, time-bound and reviewed", () => {
  it("PBA-T21: request → approval → content for the duration → end → post-event review, all audited", async () => {
    await scenario(async (s) => {
      await giveTask(s, caseA, "legal", "LEGAL_REVIEW");
      await s.as("legal");
      const [bg] = await s.tx<
        { id: string }[]
      >`select api.request_break_glass(${caseA}, ${JUSTIFICATION}, 60) as id`;
      expect(await opened(s.tx, "open_case", caseA)).toBe(false); // not before approval
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) => tx`select api.decide_break_glass(${bg!.id}, true, 'Synthetic: approve.')`,
      );
      await s.as("grcDirector");
      await s.tx`select api.decide_break_glass(${bg!.id}, true, 'Synthetic: urgent preservation check.')`;
      await s.as("legal");
      expect(await opened(s.tx, "open_case", caseA)).toBe(true);
      expect(await opened(s.tx, "open_case", caseB)).toBe(false); // one case only
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.review_break_glass(${bg!.id}, 'APPROPRIATE', 'Synthetic self review.')`,
      );
      await s.tx`select api.end_break_glass(${bg!.id})`;
      expect(await opened(s.tx, "open_case", caseA)).toBe(false);
      await s.as("grcDirector");
      await s.tx`select api.review_break_glass(${bg!.id}, 'APPROPRIATE', 'Synthetic: access matched the reason.')`;
      const audit = await actions(s, caseA, "BREAK_GLASS_%");
      expect(audit).toEqual([
        "BREAK_GLASS_REQUESTED",
        "BREAK_GLASS_APPROVED",
        "BREAK_GLASS_ENDED",
        "BREAK_GLASS_REVIEWED",
      ]);
    });
  });

  it("PBA-T22: break-glass never reaches restricted, unknown or archived cases and is not routine", async () => {
    await ownerScenario(async (s) => {
      await setRecordsState(s, caseExec, "CLOSED", { lowerTo: "CONFIDENTIAL" });
      await giveTask(s, caseExec, "legal", "LEGAL_REVIEW", { by: "grcDirector" });
      await s.as("legal");
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) => tx`select api.request_break_glass(${caseExec}, ${JUSTIFICATION}, 60)`,
      );
      await giveTask(s, caseA, "legal", "LEGAL_REVIEW");
      await s.as("legal");
      await s.expectError(
        "CDF_INVALID:duration",
        (tx) => tx`select api.request_break_glass(${caseA}, ${JUSTIFICATION}, 10000)`,
      );
      await s.as("records"); // records officers hold no break-glass permission
      await closeAndArchive(s, caseB);
      await s.as("records");
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.request_break_glass(${caseB}, ${JUSTIFICATION}, 60)`,
      );
    });
  });
});

// =====================================================================================================
describe("§15, §28.7, §28.9: RLS and audit coverage of the new tables", () => {
  it("PBA-T23: no application role writes tasks, requests or break-glass rows directly", async () => {
    await scenario(async (s) => {
      for (const user of ["legal", "records", "caseManager", "grcDirector"] as const) {
        await s.as(user);
        await s.expectError(
          "permission denied",
          (
            tx,
          ) => tx`insert into case_mgmt.case_task (case_id, task_type, assigned_user_id, assigned_role, purpose, scope,
                     created_by, expires_at) values (${caseA}, 'LEGAL_REVIEW', ${USERS[user]}, 'LEGAL_REVIEWER', ${PURPOSE},
                     '{CASE_VIEW_METADATA}', ${USERS[user]}, now() + interval '1 day')`,
        );
        await s.expectError(
          "permission denied",
          (tx) => tx`update records.legal_hold_request set status = 'APPLIED'`,
        );
        await s.expectError(
          "permission denied",
          (tx) => tx`update case_mgmt.break_glass_access set status = 'ACTIVE'`,
        );
      }
    });
  });

  it("PBA-T24: other users' tasks, requests and break-glass rows are invisible", async () => {
    await scenario(async (s) => {
      await giveTask(s, caseA, "legal", "LEGAL_REVIEW");
      await s.as("legal");
      const [bg] = await s.tx<
        { id: string }[]
      >`select api.request_break_glass(${caseA}, ${JUSTIFICATION}, 60) as id`;
      await s.tx`select api.request_legal_hold(${caseA}, 'LITIGATION', ${JUSTIFICATION})`;
      for (const user of ["legalB", "records", "investigatorB"] as const) {
        await s.as(user);
        expect(await s.tx`select 1 from case_mgmt.case_task`).toHaveLength(0);
        expect(await s.tx`select 1 from records.legal_hold_request`).toHaveLength(0);
        expect(await s.tx`select 1 from case_mgmt.break_glass_access where id = ${bg!.id}`).toHaveLength(0);
        expect(await s.tx`select * from api.my_case_tasks()`).toHaveLength(0);
      }
    });
  });
});
