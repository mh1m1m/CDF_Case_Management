// Business architecture rebase phase 10, migration 1960 (ADR-027, ADR-034; owner Q&A Q100; N17): the governed import
// of a business continuity workbook. A workbook is staged for a case its importer can see, every row is validated and
// classified, conflicts and unsupported rows are resolved explicitly, the preview is a rolled-back dry run of the real
// commands, a different person approves, and the importer applies it in one transaction with the offline provenance
// kept. Every step runs through the api.* commands as `authenticated`; the owner connection is used only to read the
// case's clock, the outbox and the audit ledger, and to probe the triggers.
import { beforeAll, describe, expect, it } from "vitest";
import { BCP_TEMPLATE_VERSIONS, BCP_TEMPLATES, type BcpSheet } from "@cdf/contracts";
import { bcpCellOk, bcpNormalize, bcpSheet } from "@cdf/validation";
import {
  USERS,
  admin,
  caseId,
  ownerScenario,
  type OwnerScenario,
  type Scenario,
  type UserKey,
} from "../support/db";
import { REASON, committeeIds } from "../support/committee";
import { caseFacts, draftPackage, voteOnPackage } from "../support/decision";
import { closeAndArchive } from "../support/records";

const SHA = "a".repeat(64);
const WORKBOOK = "BCP-DEMO-0002-WB1";
const WHY = "Synthetic: resolved during the import review.";

let caseA: string, caseB: string, ic: string;
const EMAIL: Record<string, string> = {};
beforeAll(async () => {
  [caseA, caseB] = await Promise.all([caseId("0001"), caseId("0002")]);
  ({ ic } = await committeeIds());
  const users = await admin<{ id: string; email: string }[]>`select id, email from iam.user_profile`;
  for (const [key, id] of Object.entries(USERS)) EMAIL[key] = users.find((u) => u.id === id)!.email;
});

interface Clock {
  number: string;
  created: string;
  now: string;
  dayBefore: string;
  tomorrow: string;
}

/** The case's number and creation time and the transaction's time, as ISO strings the workbook would hold. */
async function clock(s: OwnerScenario, caseIdValue: string): Promise<Clock> {
  await s.asOwner();
  const iso = (expr: string) => `to_char((${expr}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
  const [r] = await s.tx.unsafe<Clock[]>(
    `select case_number as number, ${iso("created_at")} as created, ${iso("now()")} as now,
            ${iso("created_at - interval '1 day'")} as "dayBefore", ${iso("now() + interval '1 day'")} as tomorrow
     from case_mgmt.case_record where id = $1`,
    [caseIdValue],
  );
  return r!;
}

function control(t: Clock, caseIdValue: string, extra: Record<string, string | undefined> = {}) {
  const c: Record<string, string | undefined> = {
    TEMPLATE_VERSION: "BCP-1",
    WORKBOOK_ID: WORKBOOK,
    CASE_ID: caseIdValue,
    CASE_NUMBER: t.number,
    OFFLINE_FROM: t.created,
    PREPARED_BY: EMAIL.investigatorB!,
    ...extra,
  };
  return Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined));
}

interface RowInput {
  sheet: string;
  row_number: number;
  cells: Record<string, string>;
  has_formula?: boolean;
}

/** A data row recorded offline by `by` at `at`. */
function row(
  sheet: string,
  n: number,
  key: string,
  at: string,
  cells: Record<string, string>,
  by: UserKey = "investigatorB",
) {
  return {
    sheet,
    row_number: n,
    cells: { ROW_ID: key, ORIGINAL_EVENT_AT: at, RECORDED_OFFLINE_BY: EMAIL[by]!, ...cells },
    has_formula: false,
  };
}

const subjectRow = (n: number, key: string, at: string, label = "Employee Omega (synthetic)") =>
  row("05_SUBJECTS", n, key, at, { DISPLAY_LABEL: label, SUBJECT_CATEGORY: "EMPLOYEE" });
const allegationRow = (n: number, key: string, at: string, subjectRef: string) =>
  row("06_ALLEGATIONS", n, key, at, {
    CATEGORY: "MISCONDUCT",
    DESCRIPTION: "Synthetic: allegation recorded during the outage.",
    SUBJECT_REF: subjectRef,
  });

async function stage(
  s: Scenario,
  actor: UserKey,
  ctl: Record<string, unknown>,
  rows: RowInput[] | unknown,
): Promise<string> {
  await s.as(actor);
  const [r] = await s.tx<{ id: string }[]>`
    select api.stage_bcp_import(${s.tx.json(ctl as never)}::jsonb, ${SHA}, ${s.tx.json(rows as never)}::jsonb) as id`;
  return r!.id;
}

interface StagedRow {
  id: string;
  sheet_code: string;
  row_key: string | null;
  state: string;
  detail: string | null;
  resolution: string | null;
  outcome: string | null;
}

async function rows(s: Scenario, batch: string): Promise<Record<string, StagedRow>> {
  const list = await s.tx<StagedRow[]>`
    select id, sheet_code, row_key, state, detail, resolution, outcome from exchange.bcp_import_row
    where batch_id = ${batch} order by sheet_code, row_number`;
  return Object.fromEntries(list.map((r) => [r.row_key ?? `${r.sheet_code}:${r.id}`, r]));
}

interface Preview {
  hash: string;
  clean: boolean;
  rows: { id: string; row_key: string | null; outcome: string | null; state: string }[];
}

async function preview(s: Scenario, batch: string): Promise<Preview> {
  const [r] = await s.tx<{ p: Preview }[]>`select api.preview_bcp_import(${batch}) as p`;
  return r!.p;
}

async function resolve(s: Scenario, rowId: string, resolution: string) {
  await s.tx`select api.resolve_bcp_row(${rowId}, ${resolution}, ${WHY})`;
}

async function submit(s: Scenario, batch: string): Promise<string> {
  const p = await preview(s, batch);
  const [r] = await s.tx<{ status: string }[]>`select api.submit_bcp_import(${batch}, ${p.hash}) as status`;
  return r!.status;
}

async function submittedHash(s: Scenario, batch: string): Promise<string> {
  const [r] = await s.tx<
    { h: string }[]
  >`select submitted_hash as h from exchange.bcp_import_batch where id = ${batch}`;
  return r!.h;
}

async function decide(s: Scenario, actor: UserKey, batch: string, decision = "APPROVE"): Promise<string> {
  await s.as(actor);
  const hash = await submittedHash(s, batch);
  const [r] = await s.tx<{ status: string }[]>`
    select api.decide_bcp_import(${batch}, ${decision}, ${REASON}, ${hash}) as status`;
  return r!.status;
}

async function apply(s: Scenario, actor: UserKey, batch: string): Promise<Record<string, number>> {
  await s.as(actor);
  const [h] = await s.tx<
    { h: string }[]
  >`select submitted_hash as h from exchange.bcp_import_batch where id = ${batch}`;
  const [r] = await s.tx<
    { c: Record<string, number> }[]
  >`select api.apply_bcp_import(${batch}, ${h!.h}) as c`;
  return r!.c;
}

/** Stage → preview → submit as the case manager, approve as the GRC Director, apply. */
async function importAll(s: Scenario, ctl: Record<string, unknown>, input: RowInput[]): Promise<string> {
  const batch = await stage(s, "caseManager", ctl, input);
  expect(await submit(s, batch)).toBe("SUBMITTED");
  expect(await decide(s, "grcDirector", batch)).toBe("APPROVED");
  await apply(s, "caseManager", batch);
  return batch;
}

const BY_ID = Object.fromEntries(Object.entries(USERS).map(([k, v]) => [v, k])) as Record<string, UserKey>;

async function notified(s: OwnerScenario, template: string, batch: string): Promise<UserKey[]> {
  await s.asOwner();
  const list = await s.tx<{ recipient_id: string }[]>`
    select distinct recipient_id from notify.outbox where template_code = ${template} and object_id = ${batch}`;
  return list.map((r) => BY_ID[r.recipient_id]!).sort();
}

/** Every import notification goes to someone who can open the batch (N18, AGENT-09 review of 1920). */
async function recipientsSeeBatches(s: OwnerScenario) {
  await s.asOwner();
  const list = await s.tx<{ recipient_id: string; template_code: string; object_id: string }[]>`
    select recipient_id, template_code, object_id from notify.outbox where object_type = 'BCP_IMPORT'`;
  expect(list.length).toBeGreaterThan(0);
  for (const r of list) {
    await s.as(BY_ID[r.recipient_id]!);
    const seen = await s.tx`select id from exchange.bcp_import_batch where id = ${r.object_id}`;
    expect(seen, `${BY_ID[r.recipient_id]} ${r.template_code}`).toHaveLength(1);
  }
  await s.asOwner();
}

/** Test fixture: `user` declares a conflict on case 0002, which hides the case from them (§19). */
async function conflicted(s: OwnerScenario, user: UserKey) {
  await s.asOwner();
  await s.tx`insert into case_mgmt.conflict_check (case_id, user_id, status, declaration)
             values (${caseB}, ${USERS[user]}, 'CONFLICT_DECLARED', 'Synthetic declared conflict')`;
}

async function audited(s: OwnerScenario, batch: string): Promise<string[]> {
  await s.asOwner();
  const list = await s.tx<{ action: string }[]>`
    select action from audit.audit_event
    where object_id = ${batch} or metadata ->> 'batch_id' = ${batch} order by seq`;
  return list.map((r) => r.action);
}

async function subjectCount(s: OwnerScenario, caseIdValue: string): Promise<number> {
  await s.asOwner();
  const [r] = await s.tx<{ n: number }[]>`
    select count(*)::int as n from case_mgmt.case_subject where case_id = ${caseIdValue}`;
  return r!.n;
}

describe("BCP import: stage, dry run, separate approval, transactional import (Q100)", () => {
  it("imports subjects, allegations and a paper defence response with their offline provenance", async () => {
    await ownerScenario(async (s) => {
      const t = await clock(s, caseB);
      const facts = await caseFacts(s, caseB);
      await s.as("caseManager");
      const [notice] = await s.tx<{ id: string }[]>`
        select api.issue_defence_notice(${facts.subject}, 'Synthetic: you are invited to respond.',
          ${[facts.allegation]}::uuid[], now() + interval '14 days') as id`;
      const before = await subjectCount(s, caseB);
      const [auditBefore] = await s.tx<{ n: number }[]>`select count(*)::int as n from audit.audit_event`;

      const batch = await stage(s, "caseManager", control(t, caseB), [
        subjectRow(3, "bcp-s1", t.created),
        allegationRow(3, "BCP-A1", t.now, "BCP-S1"),
        allegationRow(4, "BCP-A2", t.now, facts.subject),
        allegationRow(5, "BCP-A3", t.dayBefore, "BCP-S1"),
        row("18_EMPLOYEE_NOTICE", 3, "BCP-D1", t.now, {
          NOTICE_ID: notice!.id,
          CHANNEL: "PHYSICAL_SUBMISSION",
          ORIGINAL_SUBMISSION_DATE: t.now,
          RESPONSE_TEXT: "Synthetic: written defence handed to the secretary.",
          ORIGINAL_DOCUMENT_REFERENCE: "PAPER-DEMO-0001",
        }),
        row("02_CASE_MASTER", 3, "BCP-C1", t.now, {
          DETAILS: "Synthetic: classification discussed offline.",
        }),
      ]);
      let staged = await rows(s, batch);
      expect(
        Object.fromEntries(Object.entries(staged).map(([k, r]) => [k, [r.state, r.detail, r.resolution]])),
      ).toEqual({
        "BCP-S1": ["NEW", null, "IMPORT"],
        "BCP-A1": ["NEW", null, "IMPORT"],
        "BCP-A2": ["NEW", null, "IMPORT"],
        "BCP-A3": ["INVALID", "ORIGINAL_EVENT_AT", null],
        "BCP-D1": ["NEW", null, "IMPORT"],
        "BCP-C1": ["UNSUPPORTED", null, null],
      });

      // The dry run runs every command and leaves nothing behind.
      let p = await preview(s, batch);
      expect(p.clean).toBe(false);
      expect(p.rows.filter((r) => r.outcome !== null).map((r) => [r.row_key, r.outcome])).toEqual([
        ["BCP-S1", "OK"],
        ["BCP-A1", "OK"],
        ["BCP-A2", "OK"],
        ["BCP-D1", "OK"],
      ]);
      expect(await subjectCount(s, caseB)).toBe(before);
      const [left] = await s.tx<{ n: number; notice: string }[]>`
        select (select count(*)::int from grievance.defence_response where notice_id = ${notice!.id}) as n,
               (select status from grievance.defence_notice where id = ${notice!.id}) as notice`;
      expect(left).toEqual({ n: 0, notice: "ISSUED" });
      const [auditAfter] = await s.tx<{ n: number }[]>`select count(*)::int as n from audit.audit_event`;
      expect(auditAfter!.n - auditBefore!.n).toBe(2); // BCP_IMPORT_STAGED and BCP_IMPORT_PREVIEWED only

      await s.as("caseManager");
      await s.expectError(
        "CDF_CONFLICT:ROWS_UNRESOLVED",
        (tx) => tx`select api.submit_bcp_import(${batch}, ${p.hash})`,
      );
      await resolve(s, staged["BCP-A3"]!.id, "SKIP");
      await resolve(s, staged["BCP-C1"]!.id, "SKIP");
      // A resolution clears the preview, and only the importer's own preview submits: not even the batch's current
      // hash, computed elsewhere.
      await s.asOwner();
      const [cleared] = await s.tx<
        { preview_hash: string | null; preview_clean: boolean; current: string }[]
      >`
        select preview_hash, preview_clean, exchange.bcp_batch_hash(id) as current
        from exchange.bcp_import_batch where id = ${batch}`;
      expect([cleared!.preview_hash, cleared!.preview_clean]).toEqual([null, false]);
      await s.as("caseManager");
      await s.expectError(
        "CDF_CONFLICT:PREVIEW_CHANGED",
        (tx) => tx`select api.submit_bcp_import(${batch}, ${cleared!.current})`,
      );
      await s.expectError(
        "CDF_CONFLICT:PREVIEW_CHANGED",
        (tx) => tx`select api.submit_bcp_import(${batch}, ${p.hash})`,
      );
      p = await preview(s, batch);
      expect(p.clean).toBe(true);
      await s.expectError(
        "CDF_CONFLICT:PREVIEW_CHANGED",
        (tx) => tx`select api.submit_bcp_import(${batch}, ${"b".repeat(64)})`,
      );
      expect(await submit(s, batch)).toBe("SUBMITTED");
      // From submission rows are fixed, and nothing is applied before an approval.
      await s.expectError(
        "CDF_CONFLICT:NOT_STAGED",
        (tx) => tx`select api.resolve_bcp_row(${staged["BCP-S1"]!.id}, 'SKIP', ${WHY})`,
      );
      await s.expectError(
        "CDF_CONFLICT:NOT_APPROVED",
        (tx) => tx`select api.apply_bcp_import(${batch}, ${p.hash})`,
      );
      expect(await notified(s, "BCP_IMPORT_APPROVAL_REQUESTED", batch)).toEqual(["grcDeputy", "grcDirector"]);

      // A different person approves; the importer never does, and only the importer applies.
      await s.as("caseManager");
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.decide_bcp_import(${batch}, 'APPROVE', ${REASON}, ${p.hash})`,
      );
      await s.as("grcDirector");
      await s.expectError(
        "CDF_CONFLICT:PREVIEW_CHANGED",
        (tx) => tx`select api.decide_bcp_import(${batch}, 'APPROVE', ${REASON}, ${"c".repeat(64)})`,
      );
      await s.expectError(
        "CDF_INVALID:decision",
        (tx) => tx`select api.decide_bcp_import(${batch}, 'MAYBE', ${REASON}, ${p.hash})`,
      );
      await s.expectError(
        "CDF_INVALID:reason",
        (tx) => tx`select api.decide_bcp_import(${batch}, 'APPROVE', 'ok', ${p.hash})`,
      );
      expect(await decide(s, "grcDirector", batch)).toBe("APPROVED");
      // A decision is made once: another eligible approver cannot overturn it.
      await s.as("grcDeputy");
      await s.expectError(
        "CDF_CONFLICT:NOT_SUBMITTED",
        (tx) => tx`select api.decide_bcp_import(${batch}, 'REJECT', ${REASON}, ${p.hash})`,
      );
      expect(await notified(s, "BCP_IMPORT_DECIDED", batch)).toEqual(["caseManager"]);
      await recipientsSeeBatches(s);
      await s.as("grcDirector");
      await s.expectError("CDF_FORBIDDEN", (tx) => tx`select api.apply_bcp_import(${batch}, ${p.hash})`);
      await s.as("caseManager");
      await s.expectError(
        "CDF_CONFLICT:PREVIEW_CHANGED",
        (tx) => tx`select api.apply_bcp_import(${batch}, ${"d".repeat(64)})`,
      );
      expect(await apply(s, "caseManager", batch)).toEqual({
        imported: 4,
        skipped: 2,
        kept: 0,
        already_imported: 0,
      });
      await s.expectError(
        "CDF_CONFLICT:NOT_APPROVED",
        (tx) => tx`select api.apply_bcp_import(${batch}, ${p.hash})`,
      );
      await s.expectError(
        "CDF_CONFLICT:NOT_OPEN",
        (tx) => tx`select api.cancel_bcp_import(${batch}, ${REASON})`,
      );

      // The objects exist, made by the importer through the commands; the allegation names the workbook's subject.
      expect(await subjectCount(s, caseB)).toBe(before + 1);
      const prov = await s.tx<
        {
          row_key: string;
          object_type: string;
          object_id: string;
          original_event_at: string;
          recorded_offline_by: string;
          imported_by: string;
          markers: string[];
          workbook_id: string;
        }[]
      >`
        select row_key, object_type, object_id, original_event_at::text, recorded_offline_by, imported_by, markers,
               workbook_id
        from exchange.bcp_provenance where batch_id = ${batch} order by sheet_code, row_key`;
      expect(prov.map((r) => [r.row_key, r.object_type])).toEqual([
        ["BCP-S1", "case_subject"],
        ["BCP-A1", "allegation"],
        ["BCP-A2", "allegation"],
        ["BCP-D1", "defence_response"],
      ]);
      for (const r of prov) {
        expect(r.recorded_offline_by).toBe(USERS.investigatorB);
        expect(r.imported_by).toBe(USERS.caseManager);
        expect(r.markers).toEqual(["RECORDED_OFFLINE", "IMPORTED_LATER"]);
        expect(r.workbook_id).toBe(WORKBOOK);
      }
      // The original event time survives the import (ADR-034 D8).
      const [original] = await s.tx<{ same: boolean }[]>`
        select original_event_at = ${t.created}::text::timestamptz as same
        from exchange.bcp_provenance where batch_id = ${batch} and row_key = 'BCP-S1'`;
      expect(original!.same).toBe(true);
      const byKey = Object.fromEntries(prov.map((r) => [r.row_key, r.object_id]));
      const [a1] = await s.tx<{ subject_id: string; created_by: string }[]>`
        select subject_id, created_by from case_mgmt.allegation where id = ${byKey["BCP-A1"]!}`;
      expect(a1).toEqual({ subject_id: byKey["BCP-S1"], created_by: USERS.caseManager });
      const [a2] = await s.tx<
        { subject_id: string }[]
      >`select subject_id from case_mgmt.allegation where id = ${byKey["BCP-A2"]!}`;
      expect(a2!.subject_id).toBe(facts.subject);
      // The original submission date is the workbook's, not the import's.
      const [d] = await s.tx<{ channel: string; same: boolean; recorded_by: string; notice: string }[]>`
        select r.channel, r.original_submission_date = ${t.now}::text::timestamptz as same, r.recorded_by,
               (select status from grievance.defence_notice where id = r.notice_id) as notice
        from grievance.defence_response r where r.id = ${byKey["BCP-D1"]!}`;
      expect(d).toEqual({
        channel: "PHYSICAL_SUBMISSION",
        same: true,
        recorded_by: USERS.caseManager,
        notice: "RESPONDED",
      });

      expect(await audited(s, batch)).toEqual([
        "BCP_IMPORT_STAGED",
        "BCP_IMPORT_PREVIEWED",
        "BCP_IMPORT_ROW_RESOLVED",
        "BCP_IMPORT_ROW_RESOLVED",
        "BCP_IMPORT_PREVIEWED",
        "BCP_IMPORT_PREVIEWED",
        "BCP_IMPORT_SUBMITTED",
        "BCP_IMPORT_APPROVED",
        "BCP_ROW_IMPORTED",
        "BCP_ROW_IMPORTED",
        "BCP_ROW_IMPORTED",
        "BCP_ROW_IMPORTED",
        "BCP_IMPORT_COMPLETED",
      ]);
      const [imported] = await s.tx<{ meta: Record<string, unknown>; actor: string }[]>`
        select metadata as meta, actor_id as actor from audit.audit_event
        where action = 'BCP_ROW_IMPORTED' and object_id = ${byKey["BCP-D1"]!}`;
      expect(imported!.actor).toBe(USERS.caseManager);
      expect(imported!.meta).toMatchObject({
        sheet: "18_EMPLOYEE_NOTICE",
        recorded_offline_by: USERS.investigatorB,
        markers: ["RECORDED_OFFLINE", "IMPORTED_LATER"],
      });
      // Audit metadata carries ids, codes and counts, never what the workbook says.
      const [leak] = await s.tx<{ n: number }[]>`
        select count(*)::int as n from audit.audit_event
        where action like 'BCP_%' and (metadata::text like '%Synthetic: allegation%' or metadata::text like '%written defence%'
                                       or metadata::text like '%Omega%')`;
      expect(leak!.n).toBe(0);
      staged = await rows(s, batch);
      expect(staged["BCP-S1"]!.outcome).toBe("OK");
    });
  });

  it("re-imports idempotently and surfaces every change as a conflict, never an overwrite", async () => {
    await ownerScenario(async (s) => {
      const t = await clock(s, caseB);
      const first = await importAll(s, control(t, caseB), [subjectRow(3, "BCP-S1", t.now)]);
      const before = await subjectCount(s, caseB);
      const [prov] = await s.tx<{ object_id: string }[]>`
        select object_id from exchange.bcp_provenance where batch_id = ${first} and row_key = 'BCP-S1'`;

      const second = await stage(s, "caseManager", control(t, caseB), [
        subjectRow(3, "BCP-S1", t.now),
        subjectRow(4, "BCP-S2", t.now, "Employee Tau (synthetic)"),
        {
          ...subjectRow(5, "BCP-S3", t.now),
          cells: { ...subjectRow(5, "BCP-S3", t.now).cells, OBJECT_ID: prov!.object_id },
        },
        allegationRow(3, "BCP-A1", t.now, "BCP-S1"),
      ]);
      // One open batch per case and workbook.
      await s.expectError(
        "CDF_CONFLICT:BATCH_OPEN",
        (tx) =>
          tx`select api.stage_bcp_import(${tx.json(control(t, caseB) as never)}::jsonb, ${SHA},
             ${tx.json([subjectRow(3, "BCP-S9", t.now)] as never)}::jsonb)`,
      );
      const staged = await rows(s, second);
      expect([staged["BCP-S1"]!.state, staged["BCP-S1"]!.resolution]).toEqual(["ALREADY_IMPORTED", null]);
      expect([staged["BCP-S3"]!.state, staged["BCP-S3"]!.detail]).toEqual(["CONFLICT", "EXISTING_OBJECT"]);
      await s.expectError(
        "CDF_CONFLICT:NOTHING_TO_RESOLVE",
        (tx) => tx`select api.resolve_bcp_row(${staged["BCP-S1"]!.id}, 'SKIP', ${WHY})`,
      );
      for (const r of ["USE_OFFLINE", "MERGE", "NEW_VERSION"]) {
        await s.expectError(
          "CDF_CONFLICT:RESOLUTION_NOT_SUPPORTED",
          (tx) => tx`select api.resolve_bcp_row(${staged["BCP-S3"]!.id}, ${r}, ${WHY})`,
        );
      }
      await s.expectError(
        "CDF_CONFLICT:RESOLUTION_NOT_ALLOWED",
        (tx) => tx`select api.resolve_bcp_row(${staged["BCP-S3"]!.id}, 'IMPORT', ${WHY})`,
      );
      await s.expectError(
        "CDF_CONFLICT:RESOLUTION_NOT_ALLOWED",
        (tx) => tx`select api.resolve_bcp_row(${staged["BCP-S2"]!.id}, 'KEEP_PLATFORM', ${WHY})`,
      );
      await s.expectError(
        "CDF_INVALID:resolution",
        (tx) => tx`select api.resolve_bcp_row(${staged["BCP-S2"]!.id}, 'OVERWRITE', ${WHY})`,
      );
      await s.expectError(
        "CDF_INVALID:reason",
        (tx) => tx`select api.resolve_bcp_row(${staged["BCP-S2"]!.id}, 'SKIP', 'no')`,
      );
      await s.expectError(
        "CDF_CONFLICT:ROWS_UNRESOLVED",
        (tx) => tx`select api.submit_bcp_import(${second}, ${"a".repeat(64)})`,
      );
      await resolve(s, staged["BCP-S3"]!.id, "KEEP_PLATFORM");
      await resolve(s, staged["BCP-S2"]!.id, "SKIP");
      expect(await submit(s, second)).toBe("SUBMITTED");
      expect(await decide(s, "grcDirector", second)).toBe("APPROVED");
      expect(await apply(s, "caseManager", second)).toEqual({
        imported: 1,
        skipped: 1,
        kept: 1,
        already_imported: 1,
      });
      // Nothing was created again; the allegation refers to the subject the first import created.
      expect(await subjectCount(s, caseB)).toBe(before);
      const [a] = await s.tx<{ subject_id: string }[]>`
        select a.subject_id from case_mgmt.allegation a
        join exchange.bcp_provenance p on p.object_id = a.id where p.batch_id = ${second}`;
      expect(a!.subject_id).toBe(prov!.object_id);

      // A row changed in the workbook after it was imported is a conflict.
      const third = await stage(s, "caseManager", control(t, caseB), [
        subjectRow(3, "BCP-S1", t.now, "Employee Omega (renamed offline)"),
      ]);
      const changed = await rows(s, third);
      expect([changed["BCP-S1"]!.state, changed["BCP-S1"]!.detail]).toEqual([
        "CONFLICT",
        "CHANGED_SINCE_IMPORT",
      ]);
    });
  });

  it("applies all or nothing: a row that fails after approval aborts the whole import", async () => {
    await ownerScenario(async (s) => {
      const t = await clock(s, caseB);
      const facts = await caseFacts(s, caseB);
      await s.as("caseManager");
      const [notice] = await s.tx<{ id: string }[]>`
        select api.issue_defence_notice(${facts.subject}, 'Synthetic: you are invited to respond.',
          ${[facts.allegation]}::uuid[], now() + interval '14 days') as id`;
      const before = await subjectCount(s, caseB);
      const batch = await stage(s, "caseManager", control(t, caseB), [
        subjectRow(3, "BCP-S1", t.now),
        row("18_EMPLOYEE_NOTICE", 3, "BCP-D1", t.now, {
          NOTICE_ID: notice!.id,
          CHANNEL: "EMAIL",
          ORIGINAL_SUBMISSION_DATE: t.now,
          RESPONSE_TEXT: "Synthetic: defence sent by email during the outage.",
          ORIGINAL_DOCUMENT_REFERENCE: "MAIL-DEMO-0001",
        }),
      ]);
      expect(await submit(s, batch)).toBe("SUBMITTED");
      expect(await decide(s, "grcDirector", batch)).toBe("APPROVED");
      // Meanwhile the response is recorded online.
      await s.as("caseManager");
      await s.tx`select api.record_defence_response(${notice!.id}, 'SECRETARY_ENTRY', now(),
        'Synthetic: response entered online.', 'ONLINE-DEMO-0001')`;
      const hash = await submittedHash(s, batch);
      await s.expectError(
        "CDF_CONFLICT:BCP_ROW_FAILED:BCP-D1:CDF_CONFLICT:NOTICE_NOT_OPEN",
        (tx) => tx`select api.apply_bcp_import(${batch}, ${hash})`,
      );
      expect(await subjectCount(s, caseB)).toBe(before);
      const [left] = await s.tx<{ status: string; n: number }[]>`
        select status, (select count(*)::int from exchange.bcp_provenance where batch_id = ${batch}) as n
        from exchange.bcp_import_batch where id = ${batch}`;
      expect(left).toEqual({ status: "APPROVED", n: 0 });
      await s.as("caseManager");
      await s.expectError("CDF_INVALID:reason", (tx) => tx`select api.cancel_bcp_import(${batch}, 'no')`);
      await s.tx`select api.cancel_bcp_import(${batch}, ${REASON})`;
      expect((await audited(s, batch)).at(-1)).toBe("BCP_IMPORT_CANCELLED");
      // A rejected workbook is final too.
      await s.as("caseManager");
      const again = await stage(s, "caseManager", control(t, caseB), [subjectRow(3, "BCP-S1", t.now)]);
      expect(await submit(s, again)).toBe("SUBMITTED");
      expect(await decide(s, "grcDirector", again, "REJECT")).toBe("REJECTED");
      expect(await notified(s, "BCP_IMPORT_DECIDED", again)).toEqual(["caseManager"]);
      await s.as("caseManager");
      await s.expectError(
        "CDF_CONFLICT:NOT_APPROVED",
        (tx) => tx`select api.apply_bcp_import(${again}, ${hash})`,
      );
    });
  });

  it("stages an event time before the offline window as INVALID, even after the case was created", async () => {
    await ownerScenario(async (s) => {
      const t = await clock(s, caseB);
      const batch = await stage(s, "caseManager", control(t, caseB, { OFFLINE_FROM: t.now }), [
        subjectRow(3, "BCP-S1", t.created),
        subjectRow(4, "BCP-S2", t.now),
      ]);
      const staged = await rows(s, batch);
      expect([staged["BCP-S1"]!.state, staged["BCP-S1"]!.detail]).toEqual(["INVALID", "ORIGINAL_EVENT_AT"]);
      expect([staged["BCP-S2"]!.state, staged["BCP-S2"]!.detail]).toEqual(["NEW", null]);
    });
  });

  it("resolves row references within one workbook only, and only to subjects", async () => {
    await ownerScenario(async (s) => {
      const t = await clock(s, caseB);
      await importAll(s, control(t, caseB), [subjectRow(3, "BCP-S1", t.now)]);
      const plain = (n: number, key: string) =>
        row("06_ALLEGATIONS", n, key, t.now, {
          CATEGORY: "MISCONDUCT",
          DESCRIPTION: "Synthetic: allegation recorded during the outage.",
        });
      const batch = await stage(s, "caseManager", control(t, caseB, { WORKBOOK_ID: "BCP-DEMO-0002-WB2" }), [
        plain(3, "BCP-A3"),
        // BCP-S1 belongs to another workbook of the same case; BCP-A3 is not a subject.
        allegationRow(4, "BCP-A1", t.now, "BCP-S1"),
        allegationRow(5, "BCP-A2", t.now, "BCP-A3"),
      ]);
      const p = await preview(s, batch);
      expect(Object.fromEntries(p.rows.map((r) => [r.row_key, r.outcome]))).toEqual({
        "BCP-A3": "OK",
        "BCP-A1": "CDF_INVALID:SUBJECT_REF",
        "BCP-A2": "CDF_INVALID:SUBJECT_REF",
      });
    });
  });
});

describe("BCP import: who may stage, see, approve and apply", () => {
  it("identifies the case only for an importer who can see it, and keeps a staged workbook to its importer", async () => {
    await ownerScenario(async (s) => {
      const t = await clock(s, caseB);
      const input = [subjectRow(3, "BCP-S1", t.now, "Employee Omega (synthetic)")];
      for (const outsider of [
        "investigatorA",
        "committee",
        "committeeSecretary",
        "intake",
        "platformAdmin",
        "internalAudit",
        "dpo",
        "employeeB",
      ] as UserKey[]) {
        await s.as(outsider);
        await s.expectError(
          "CDF_NOT_FOUND",
          (tx) =>
            tx`select api.stage_bcp_import(${tx.json(control(t, caseB) as never)}::jsonb, ${SHA}, ${tx.json(input as never)}::jsonb)`,
        );
      }
      // The id and the number must name the same case.
      const t1 = await clock(s, caseA);
      await s.as("caseManager");
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) =>
          tx`select api.stage_bcp_import(${tx.json(control(t, caseB, { CASE_NUMBER: t1.number }) as never)}::jsonb, ${SHA},
             ${tx.json(input as never)}::jsonb)`,
      );
      // Seeing the case is not enough without BCP_IMPORT.
      await s.as("investigatorB");
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) =>
          tx`select api.stage_bcp_import(${tx.json(control(t, caseB) as never)}::jsonb, ${SHA}, ${tx.json(input as never)}::jsonb)`,
      );

      const batch = await stage(s, "caseManager", control(t, caseB), [
        ...input,
        // Recorded offline by grcDeputy, who holds BCP_IMPORT_APPROVE.
        row(
          "05_SUBJECTS",
          4,
          "BCP-S2",
          t.now,
          { DISPLAY_LABEL: "Employee Tau (synthetic)", SUBJECT_CATEGORY: "CONTRACTOR" },
          "grcDeputy",
        ),
      ]);
      const staged = await rows(s, batch);
      // Before submission an approver sees nothing of it.
      for (const viewer of ["grcDirector", "lead", "investigatorB", "investigatorA"] as UserKey[]) {
        await s.as(viewer);
        expect(await s.tx`select id from exchange.bcp_import_batch where id = ${batch}`).toHaveLength(0);
        expect(await s.tx`select id from exchange.bcp_import_row where batch_id = ${batch}`).toHaveLength(0);
        await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.preview_bcp_import(${batch})`);
        await s.expectError(
          "CDF_NOT_FOUND",
          (tx) => tx`select api.resolve_bcp_row(${staged["BCP-S1"]!.id}, 'SKIP', ${WHY})`,
        );
        await s.expectError(
          "CDF_NOT_FOUND",
          (tx) => tx`select api.decide_bcp_import(${batch}, 'APPROVE', ${REASON}, ${SHA})`,
        );
        await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.cancel_bcp_import(${batch}, ${REASON})`);
      }
      await s.as("caseManager");
      expect(await submit(s, batch)).toBe("SUBMITTED");
      // The recorder of a row is neither asked nor allowed to approve it.
      expect(await notified(s, "BCP_IMPORT_APPROVAL_REQUESTED", batch)).toEqual(["grcDirector"]);
      await s.as("grcDeputy");
      expect(await s.tx`select id from exchange.bcp_import_batch where id = ${batch}`).toHaveLength(1);
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.decide_bcp_import(${batch}, 'APPROVE', ${REASON}, ${SHA})`,
      );
      // An approver sees the submitted batch and its rows, and none of the importer's commands.
      await s.as("grcDirector");
      expect(await s.tx`select id from exchange.bcp_import_row where batch_id = ${batch}`).toHaveLength(2);
      await s.expectError("CDF_FORBIDDEN", (tx) => tx`select api.preview_bcp_import(${batch})`);
      await s.expectError("CDF_FORBIDDEN", (tx) => tx`select api.cancel_bcp_import(${batch}, ${REASON})`);
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.resolve_bcp_row(${staged["BCP-S1"]!.id}, 'SKIP', ${WHY})`,
      );
      // Someone who sees the case but may not approve still sees nothing of it.
      for (const viewer of ["lead", "investigatorB", "investigatorA", "platformAdmin"] as UserKey[]) {
        await s.as(viewer);
        expect(await s.tx`select id from exchange.bcp_import_batch where id = ${batch}`).toHaveLength(0);
        expect(await s.tx`select id from exchange.bcp_import_row where batch_id = ${batch}`).toHaveLength(0);
        await s.expectError(
          "CDF_NOT_FOUND",
          (tx) => tx`select api.decide_bcp_import(${batch}, 'APPROVE', ${REASON}, ${SHA})`,
        );
        await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.apply_bcp_import(${batch}, ${SHA})`);
      }
      expect(await decide(s, "grcDirector", batch)).toBe("APPROVED");
      await apply(s, "caseManager", batch);
      // Provenance follows the case: its team sees it, outsiders do not.
      await s.as("investigatorB");
      expect(await s.tx`select id from exchange.bcp_provenance where batch_id = ${batch}`).toHaveLength(2);
      for (const outsider of ["investigatorA", "committee", "platformAdmin", "employeeB"] as UserKey[]) {
        await s.as(outsider);
        expect(await s.tx`select id from exchange.bcp_provenance where batch_id = ${batch}`).toHaveLength(0);
      }
    });
  });

  it("names only active users who see the case as preparer or offline recorder; the preparer never approves", async () => {
    // AGENT-09 R2 (provenance integrity) and R3 (separation of duties) on the 1960 early look.
    await ownerScenario(async (s) => {
      const t = await clock(s, caseB);
      await s.tx`update iam.user_profile set status = 'SUSPENDED' where id = ${USERS.triage}`;
      const input = [subjectRow(3, "BCP-S1", t.now)];
      // dpo and investigatorA cannot see the case; triage could, but is suspended.
      const outsiders = ["dpo", "investigatorA", "triage"] as UserKey[];
      await s.as("caseManager");
      for (const outsider of outsiders) {
        await s.expectError(
          "CDF_INVALID:PREPARED_BY",
          (tx) =>
            tx`select api.stage_bcp_import(${tx.json(control(t, caseB, { PREPARED_BY: EMAIL[outsider] }) as never)}::jsonb,
               ${SHA}, ${tx.json(input as never)}::jsonb)`,
        );
      }
      const subject = { DISPLAY_LABEL: "Employee Tau (synthetic)", SUBJECT_CATEGORY: "EMPLOYEE" };
      const batch = await stage(s, "caseManager", control(t, caseB, { PREPARED_BY: EMAIL.grcDirector! }), [
        ...input,
        ...outsiders.map((by, i) => row("05_SUBJECTS", 4 + i, `BCP-R${i}`, t.now, subject, by)),
      ]);
      const staged = await rows(s, batch);
      expect(Object.fromEntries(Object.entries(staged).map(([k, r]) => [k, [r.state, r.detail]]))).toEqual({
        "BCP-S1": ["NEW", null],
        "BCP-R0": ["INVALID", "RECORDED_OFFLINE_BY"],
        "BCP-R1": ["INVALID", "RECORDED_OFFLINE_BY"],
        "BCP-R2": ["INVALID", "RECORDED_OFFLINE_BY"],
      });
      for (const key of ["BCP-R0", "BCP-R1", "BCP-R2"]) await resolve(s, staged[key]!.id, "SKIP");
      expect(await submit(s, batch)).toBe("SUBMITTED");
      // The preparer holds BCP_IMPORT_APPROVE and sees the case, yet is neither asked nor allowed to decide.
      expect(await notified(s, "BCP_IMPORT_APPROVAL_REQUESTED", batch)).toEqual(["grcDeputy"]);
      await s.as("grcDirector");
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.decide_bcp_import(${batch}, 'APPROVE', ${REASON}, ${SHA})`,
      );
      expect(await decide(s, "grcDeputy", batch)).toBe("APPROVED");
      expect(await apply(s, "caseManager", batch)).toMatchObject({ imported: 1, skipped: 3 });
      await s.asOwner();
      const [p] = await s.tx<{ recorder: string }[]>`
        select recorded_offline_by as recorder from exchange.bcp_provenance where batch_id = ${batch}`;
      expect(p!.recorder).toBe(USERS.investigatorB);
    });
  });

  it("imports a corrective action only through its command, and shows its provenance to the action's owner", async () => {
    await ownerScenario(async (s) => {
      const t = await clock(s, caseB);
      await s.as("platformAdmin");
      await s.tx`select api.grant_role(${USERS.employeeB}, 'IMPLEMENTATION_OWNER', 'Synthetic: implementation owner')`;
      const f = await draftPackage(s, ic, caseB);
      await s.as("committeeSecretary");
      await s.tx`select api.withdraw_recommendation_item(${f.sanction}, ${REASON})`;
      await voteOnPackage(s, f);
      await s.as("committeeSecretary");
      await s.tx`select api.submit_to_authority(${f.pkg})`;
      await s.tx`select api.record_authority_decision(${f.pkg}, 'CEO', 'APPROVE_AS_RECOMMENDED', now(),
        'Chief Executive (synthetic)', 'MEMO-DEMO-0101', null, ${REASON})`;
      // An item that is not this case's answers NOT_FOUND in the dry run, an unknown owner INVALID.
      const action = (n: number, key: string, item: string, owner: string) =>
        row("21_CORRECTIVE_ACTIONS", n, key, t.now, {
          RECOMMENDATION_ITEM_ID: item,
          TITLE: "Synthetic: second approver on payments",
          DESCRIPTION: "Synthetic: agreed with the owner during the outage.",
          OWNER: owner,
          DUE_DATE: t.tomorrow.slice(0, 10),
        });
      const batch = await stage(s, "caseManager", control(t, caseB), [
        action(3, "BCP-K1", f.corrective, EMAIL.employeeB!.toUpperCase()),
        action(4, "BCP-K2", f.corrective, "nobody@example.test"),
        action(5, "BCP-K3", "00000000-0000-4000-8000-000000000001", EMAIL.employeeB!),
      ]);
      const p = await preview(s, batch);
      expect(Object.fromEntries(p.rows.map((r) => [r.row_key, r.outcome]))).toEqual({
        "BCP-K1": "OK",
        "BCP-K2": "CDF_INVALID:OWNER",
        "BCP-K3": "CDF_NOT_FOUND",
      });
      expect(p.clean).toBe(false);
      await s.expectError(
        "CDF_CONFLICT:DRY_RUN_FAILED",
        (tx) => tx`select api.submit_bcp_import(${batch}, ${p.hash})`,
      );
      const staged = await rows(s, batch);
      await resolve(s, staged["BCP-K2"]!.id, "SKIP");
      await resolve(s, staged["BCP-K3"]!.id, "SKIP");
      expect(await submit(s, batch)).toBe("SUBMITTED");
      expect(await decide(s, "grcDirector", batch)).toBe("APPROVED");
      expect(await apply(s, "caseManager", batch)).toEqual({
        imported: 1,
        skipped: 2,
        kept: 0,
        already_imported: 0,
      });
      const [a] = await s.tx<{ id: string; owner_id: string; created_by: string }[]>`
        select a.id, a.owner_id, a.created_by from decision.corrective_action a
        join exchange.bcp_provenance p on p.object_id = a.id where p.batch_id = ${batch}`;
      expect([a!.owner_id, a!.created_by]).toEqual([USERS.employeeB, USERS.caseManager]);
      // The owner sees the action's provenance, never the batch or its rows.
      await s.as("employeeB");
      expect(await s.tx`select id from exchange.bcp_provenance where object_id = ${a!.id}`).toHaveLength(1);
      expect(await s.tx`select id from exchange.bcp_import_batch where id = ${batch}`).toHaveLength(0);
      expect(await s.tx`select id from exchange.bcp_import_row where batch_id = ${batch}`).toHaveLength(0);
      expect(
        await s.tx`select id from exchange.bcp_provenance where batch_id = ${batch} and object_type <> 'corrective_action'`,
      ).toHaveLength(0);
      // Nobody else outside the case does.
      for (const outsider of ["investigatorA", "committee", "platformAdmin", "employee"] as UserKey[]) {
        await s.as(outsider);
        expect(
          await s.tx`select id from exchange.bcp_provenance where object_id = ${a!.id}`,
          outsider,
        ).toHaveLength(0);
      }

      // Probe of the internal row runner (owner connection with the importer's claims): an item or notice the
      // importer can see must still belong to the batch's own case. Here the batch claims to be case 0001's.
      await s.as("caseManager");
      const [notice] = await s.tx<{ id: string }[]>`
        select api.issue_defence_notice(${f.subject}, 'Synthetic: you are invited to respond.',
          ${[f.allegation]}::uuid[], now() + interval '14 days') as id`;
      await s.asOwner();
      await s.tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: USERS.caseManager, role: "authenticated" })}, true)`;
      const elsewhere = (sheet: string, cells: Record<string, string>) => (tx: typeof s.tx) =>
        tx`select exchange.bcp_execute_row(
             jsonb_populate_record(b, jsonb_build_object('case_id', ${caseA}::uuid)),
             jsonb_populate_record(r, jsonb_build_object('sheet_code', ${sheet}::text, 'cells', ${tx.json(cells)}::jsonb)),
             '{}'::jsonb)
           from exchange.bcp_import_batch b join exchange.bcp_import_row r on r.batch_id = b.id
           where b.id = ${batch} limit 1`;
      await s.expectError(
        "CDF_NOT_FOUND",
        elsewhere("21_CORRECTIVE_ACTIONS", {
          RECOMMENDATION_ITEM_ID: f.corrective,
          TITLE: "Synthetic: second approver on payments",
          DESCRIPTION: "Synthetic: agreed with the owner during the outage.",
          OWNER: EMAIL.employeeB!,
          DUE_DATE: t.tomorrow.slice(0, 10),
        }),
      );
      await s.expectError(
        "CDF_NOT_FOUND",
        elsewhere("18_EMPLOYEE_NOTICE", {
          NOTICE_ID: notice!.id,
          CHANNEL: "PHYSICAL_SUBMISSION",
          ORIGINAL_SUBMISSION_DATE: t.now,
          RESPONSE_TEXT: "Synthetic: written defence handed to the secretary.",
          ORIGINAL_DOCUMENT_REFERENCE: "PAPER-DEMO-0002",
        }),
      );
    });
  });

  it("loses a batch with the case or the permission: a conflicted importer or approver sees and does nothing (§19)", async () => {
    await ownerScenario(async (s) => {
      const t = await clock(s, caseB);
      const batch = await stage(s, "caseManager", control(t, caseB), [subjectRow(3, "BCP-S1", t.now)]);
      const staged = await rows(s, batch);
      // Test fixture only: the importer's role loses BCP_IMPORT; their batch stays visible, every command is refused.
      await s.asOwner();
      await s.tx`delete from iam.role_permission where role_code = 'CASE_MANAGER' and permission_code = 'BCP_IMPORT'`;
      await s.as("caseManager");
      expect(await s.tx`select id from exchange.bcp_import_batch where id = ${batch}`).toHaveLength(1);
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.resolve_bcp_row(${staged["BCP-S1"]!.id}, 'SKIP', ${WHY})`,
      );
      await s.expectError("CDF_FORBIDDEN", (tx) => tx`select api.preview_bcp_import(${batch})`);
      await s.expectError("CDF_FORBIDDEN", (tx) => tx`select api.submit_bcp_import(${batch}, ${SHA})`);
      await s.expectError("CDF_FORBIDDEN", (tx) => tx`select api.apply_bcp_import(${batch}, ${SHA})`);
      await s.expectError("CDF_FORBIDDEN", (tx) => tx`select api.cancel_bcp_import(${batch}, ${REASON})`);
      await s.asOwner();
      await s.tx`insert into iam.role_permission (role_code, permission_code) values ('CASE_MANAGER', 'BCP_IMPORT')`;
      // An approver who declares a conflict is not asked, loses the batch and cannot decide it.
      await conflicted(s, "grcDirector");
      await s.as("caseManager");
      expect(await submit(s, batch)).toBe("SUBMITTED");
      expect(await notified(s, "BCP_IMPORT_APPROVAL_REQUESTED", batch)).toEqual(["grcDeputy"]);
      await s.as("grcDirector");
      expect(await s.tx`select id from exchange.bcp_import_batch where id = ${batch}`).toHaveLength(0);
      expect(await s.tx`select id from exchange.bcp_import_row where batch_id = ${batch}`).toHaveLength(0);
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) => tx`select api.decide_bcp_import(${batch}, 'APPROVE', ${REASON}, ${SHA})`,
      );
      // So does the importer.
      await conflicted(s, "caseManager");
      await s.as("caseManager");
      expect(await s.tx`select id from exchange.bcp_import_batch where id = ${batch}`).toHaveLength(0);
      expect(await s.tx`select id from exchange.bcp_import_row where batch_id = ${batch}`).toHaveLength(0);
      await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.cancel_bcp_import(${batch}, ${REASON})`);
    });
  });

  it("stages nothing on a closed or archived case", async () => {
    await ownerScenario(async (s) => {
      const t = await clock(s, caseB);
      await closeAndArchive(s, caseB);
      await s.as("caseManager");
      await s.expectError(
        "CDF_CONFLICT:CASE_NOT_ACTIVE",
        (tx) =>
          tx`select api.stage_bcp_import(${tx.json(control(t, caseB) as never)}::jsonb, ${SHA},
             ${tx.json([subjectRow(3, "BCP-S1", t.now)] as never)}::jsonb)`,
      );
    });
  });
});

describe("BCP import: validation of the control sheet and every cell (§45)", () => {
  it("refuses a malformed call whole", async () => {
    await ownerScenario(async (s) => {
      const t = await clock(s, caseB);
      const good = [subjectRow(3, "BCP-S1", t.now)];
      const cases: [string, Record<string, unknown>, unknown, string?][] = [
        ["CDF_CONFLICT:TEMPLATE_VERSION", control(t, caseB, { TEMPLATE_VERSION: "BCP-9" }), good],
        ["CDF_CONFLICT:TEMPLATE_VERSION", control(t, caseB, { TEMPLATE_VERSION: undefined }), good],
        ["CDF_INVALID:WORKBOOK_ID", control(t, caseB, { WORKBOOK_ID: undefined }), good],
        ["CDF_INVALID:WORKBOOK_ID", control(t, caseB, { WORKBOOK_ID: "workbook one" }), good],
        ["CDF_INVALID:control", { ...control(t, caseB), EXTRA: "x" }, good],
        ["CDF_INVALID:control", { ...control(t, caseB), CASE_NUMBER: 2 }, good],
        ["CDF_INVALID:OFFLINE_FROM", control(t, caseB, { OFFLINE_FROM: "2026-10-01" }), good],
        ["CDF_INVALID:OFFLINE_FROM", control(t, caseB, { OFFLINE_FROM: t.tomorrow }), good],
        ["CDF_INVALID:OFFLINE_TO", control(t, caseB, { OFFLINE_TO: t.dayBefore }), good],
        ["CDF_INVALID:OFFLINE_TO", control(t, caseB, { OFFLINE_TO: t.tomorrow }), good],
        ["CDF_INVALID:PREPARED_BY", control(t, caseB, { PREPARED_BY: "nobody@example.test" }), good],
        ["CDF_INVALID:rows", control(t, caseB), []],
        ["CDF_INVALID:rows", control(t, caseB), { sheet: "05_SUBJECTS" }],
        ["CDF_INVALID:rows", control(t, caseB), [{ ...good[0], sheet: "99_UNKNOWN" }]],
        ["CDF_INVALID:rows", control(t, caseB), [{ ...good[0], sheet: "01_CONTROL" }]],
        ["CDF_INVALID:rows", control(t, caseB), [{ ...good[0], sheet: "26_IMPORT_AUDIT" }]],
        ["CDF_INVALID:rows", control(t, caseB), [{ ...good[0], row_number: 2 }]],
        ["CDF_INVALID:rows", control(t, caseB), [{ ...good[0], row_number: "3" }]],
        ["CDF_INVALID:rows", control(t, caseB), [{ ...good[0], extra: true }]],
        ["CDF_INVALID:rows", control(t, caseB), [{ ...good[0], cells: { ...good[0]!.cells, UNKNOWN: "x" } }]],
        [
          "CDF_INVALID:rows",
          control(t, caseB),
          [{ ...good[0], cells: { ...good[0]!.cells, DISPLAY_LABEL: 7 } }],
        ],
        [
          "CDF_INVALID:rows",
          control(t, caseB),
          [{ ...good[0], cells: { ...good[0]!.cells, DISPLAY_LABEL: "x".repeat(20001) } }],
        ],
        [
          "CDF_INVALID:rows",
          control(t, caseB),
          [good[0], { ...good[0], cells: { ...good[0]!.cells, ROW_ID: "BCP-S2" } }],
        ],
        [
          "CDF_INVALID:rows",
          control(t, caseB),
          Array.from({ length: 2001 }, (_, i) => subjectRow(3 + i, `BCP-S${i}`, t.now)),
        ],
      ];
      await s.as("caseManager");
      for (const [error, ctl, input] of cases) {
        await s.expectError(
          error,
          (tx) =>
            tx`select api.stage_bcp_import(${tx.json(ctl as never)}::jsonb, ${SHA}, ${tx.json(input as never)}::jsonb)`,
        );
      }
      await s.expectError(
        "CDF_INVALID:file_sha256",
        (tx) =>
          tx`select api.stage_bcp_import(${tx.json(control(t, caseB) as never)}::jsonb, 'abc', ${tx.json(good as never)}::jsonb)`,
      );
    });
  });

  it("stages a row that breaks a column rule as INVALID, naming the column, and normalizes the rest", async () => {
    await ownerScenario(async (s) => {
      const t = await clock(s, caseB);
      const base = (n: number, key: string, cells: Record<string, string> = {}, at = t.now) => ({
        ...subjectRow(n, key, at),
        cells: { ...subjectRow(n, key, at).cells, ...cells },
      });
      const batch = await stage(s, "caseManager", control(t, caseB, { OFFLINE_FROM: t.dayBefore }), [
        base(3, "bcp-ok1", {
          RECORDED_OFFLINE_BY: EMAIL.investigatorB!.toUpperCase(),
          SUBJECT_CATEGORY: "CONTRACTOR",
        }),
        { ...base(4, "BCP-F1"), has_formula: true },
        base(5, "BCP-L1", { DISPLAY_LABEL: " " }),
        base(6, "BCP-E1", { SUBJECT_CATEGORY: "VISITOR" }),
        base(7, "BCP-OK1"),
        base(8, "BCP-T1", {}, t.dayBefore),
        base(9, "BCP-T2", {}, t.tomorrow),
        base(10, "BCP-T3", {}, "2026-10-12T10:00:00"),
        base(11, "BCP-T4", {}, "2026-02-30T10:00:00Z"),
        base(12, "BCP-R1", { RECORDED_OFFLINE_BY: "nobody@example.test" }),
        base(13, "row one"),
        base(14, "BCP-O1", { OBJECT_ID: "not-a-uuid" }),
        base(15, "BCP-O2", { OBJECT_ID: "00000000-0000-4000-8000-0000000000AA" }),
        row("22_DOCUMENT_INDEX", 3, "BCP-X1", t.now, {
          DETAILS: "Synthetic: paper file reference.",
          OBJECT_ID: "00000000-0000-4000-8000-000000000001",
        }),
        row("22_DOCUMENT_INDEX", 4, "BCP-X2", t.now, { DETAILS: "no" }),
      ]);
      const list = await s.tx<
        {
          row_number: number;
          row_key: string | null;
          state: string;
          detail: string | null;
          cells: Record<string, string>;
        }[]
      >`
        select row_number, row_key, state, detail, cells from exchange.bcp_import_row where batch_id = ${batch}
        order by sheet_code, row_number`;
      expect(list.map((r) => [r.row_number, r.row_key, r.state, r.detail])).toEqual([
        [3, "BCP-OK1", "NEW", null],
        [4, "BCP-F1", "INVALID", "FORMULA"],
        [5, "BCP-L1", "INVALID", "DISPLAY_LABEL"],
        [6, "BCP-E1", "INVALID", "SUBJECT_CATEGORY"],
        [7, "BCP-OK1", "INVALID", "DUPLICATE_ROW_ID"],
        [8, "BCP-T1", "INVALID", "ORIGINAL_EVENT_AT"], // before the case was created
        [9, "BCP-T2", "INVALID", "ORIGINAL_EVENT_AT"], // in the future
        [10, "BCP-T3", "INVALID", "ORIGINAL_EVENT_AT"], // no offset
        [11, "BCP-T4", "INVALID", "ORIGINAL_EVENT_AT"], // no such date
        [12, "BCP-R1", "INVALID", "RECORDED_OFFLINE_BY"],
        [13, null, "INVALID", "ROW_ID"],
        [14, "BCP-O1", "INVALID", "OBJECT_ID"],
        [15, "BCP-O2", "CONFLICT", "EXISTING_OBJECT"],
        [3, "BCP-X1", "UNSUPPORTED", null],
        [4, "BCP-X2", "INVALID", "DETAILS"],
      ]);
      expect(list[0]!.cells).toMatchObject({
        ROW_ID: "BCP-OK1",
        RECORDED_OFFLINE_BY: EMAIL.investigatorB,
        SUBJECT_CATEGORY: "CONTRACTOR",
      });
      expect(list[2]!.cells).not.toHaveProperty("DISPLAY_LABEL");
      expect(list[12]!.cells.OBJECT_ID).toBe("00000000-0000-4000-8000-0000000000aa");
      // An event after the declared end of the outage is refused too.
      await s.as("caseManager");
      await s.tx`select api.cancel_bcp_import(${batch}, ${REASON})`;
      const closed = await stage(s, "caseManager", control(t, caseB, { OFFLINE_TO: t.created }), [
        base(3, "BCP-W1"),
      ]);
      const [w] = await s.tx<{ state: string; detail: string }[]>`
        select state, detail from exchange.bcp_import_row where batch_id = ${closed}`;
      expect(w).toEqual({ state: "INVALID", detail: "ORIGINAL_EVENT_AT" });
    });
  });
});

describe("BCP import: the application applies the database's column rules (§45)", () => {
  it("normalizes and judges every kind of cell exactly as exchange.bcp_cell_ok does", async () => {
    const U = "6F9619FF-8B86-4011-B42D-00CF4FC964FF";
    const samples: [string, string, string][] = [
      // Since 2110 a VERSION cell may also name a committee template (BCP-C<n>).
      ...[
        "BCP-1",
        "bcp-1",
        " BCP-2 ",
        "BCP-1000",
        "BCP-",
        "BCP-X",
        "",
        "BCP-C1",
        "bcp-c1",
        "BCP-C",
        "BCP-CC1",
        "BCP-C1000",
      ].map((v): [string, string, string] => ["01_CONTROL", "TEMPLATE_VERSION", v]),
      ...[
        "BCP-S1",
        "bcp-s1",
        "BCP--",
        `BCP-${"A".repeat(60)}`,
        `BCP-${"A".repeat(61)}`,
        U,
        "S1",
        "BCP-S_1",
        "",
      ].map((v): [string, string, string] => ["05_SUBJECTS", "ROW_ID", v]),
      ...["", "BCP-S9", U.toLowerCase(), "{" + U + "}", "subject"].map((v): [string, string, string] => [
        "06_ALLEGATIONS",
        "SUBJECT_REF",
        v,
      ]),
      ...["", U, "not-a-uuid", `${U}0`].map((v): [string, string, string] => ["05_SUBJECTS", "OBJECT_ID", v]),
      ...[
        "2026-10-01T09:30:00Z",
        "2026-10-01T09:30Z",
        "2026-10-01T09:30:00.123456Z",
        "2026-10-01T09:30:00.1234567Z",
        "2026-02-29T00:00:00Z",
        "2024-02-29T00:00:00Z",
        "2026-02-30T00:00:00Z",
        "2026-04-31T00:00:00Z",
        "2026-13-01T00:00:00Z",
        "2026-00-10T00:00:00Z",
        "2026-01-01T24:00:00Z",
        "2026-01-01T24:00:01Z",
        "2026-01-01T23:60:00Z",
        "2026-01-01T23:59:60Z",
        "2026-01-01T23:59:61Z",
        "2026-01-01T10:00:00+03:00",
        "2026-01-01T10:00:00-15:00",
        "2026-01-01T10:00:00+16:00",
        "2026-01-01T10:00:00",
        "2026-01-01 10:00:00Z",
        "0000-01-01T00:00:00Z",
        "45000",
        "",
      ].map((v): [string, string, string] => ["05_SUBJECTS", "ORIGINAL_EVENT_AT", v]),
      ...["2026-12-31", "2026-02-30", "2026-1-1", "31/12/2026", "0000-01-01", ""].map(
        (v): [string, string, string] => ["21_CORRECTIVE_ACTIONS", "DUE_DATE", v],
      ),
      ...[
        "lead@example.test",
        "LEAD@EXAMPLE.TEST",
        "lead",
        "a b@example.test",
        "lead@",
        "",
        " lead@example.test ",
      ].map((v): [string, string, string] => ["05_SUBJECTS", "RECORDED_OFFLINE_BY", v]),
      ...["EMPLOYEE", "employee", "OTHER", ""].map((v): [string, string, string] => [
        "05_SUBJECTS",
        "SUBJECT_CATEGORY",
        v,
      ]),
      ...["MISCONDUCT", "misconduct", "AB", "MIS-CONDUCT", ""].map((v): [string, string, string] => [
        "06_ALLEGATIONS",
        "CATEGORY",
        v,
      ]),
      ...["A", "AB", " A ", "x".repeat(200), "x".repeat(201), ""].map((v): [string, string, string] => [
        "05_SUBJECTS",
        "DISPLAY_LABEL",
        v,
      ]),
      ...["", "A", "Policy 7"].map((v): [string, string, string] => [
        "06_ALLEGATIONS",
        "POLICY_REFERENCE",
        v,
      ]),
    ];
    const db = await admin<{ i: number; ok: boolean; v: string | null }[]>`
      select s.i::int as i, exchange.bcp_cell_ok(c, exchange.bcp_normalize(c.kind, s.raw)) as ok,
             exchange.bcp_normalize(c.kind, s.raw) as v
      from unnest(${samples.map((x) => x[0])}::text[], ${samples.map((x) => x[1])}::text[],
                  ${samples.map((x) => x[2])}::text[]) with ordinality as s(sheet, col, raw, i)
      join exchange.bcp_template_column c
        on c.template_version = 'BCP-1' and c.sheet_code = s.sheet and c.column_code = s.col
      order by s.i`;
    expect(db).toHaveLength(samples.length);
    const differences = samples.flatMap(([sheet, col, raw], k) => {
      const column = bcpSheet(sheet)!.columns.find((c) => c.code === col)!;
      const v = bcpNormalize(column.kind, raw);
      const ok = bcpCellOk(column, v);
      return ok === db[k]!.ok && v === db[k]!.v
        ? []
        : [`${sheet}.${col} ${JSON.stringify(raw)}: app ${ok}/${v} db ${db[k]!.ok}/${db[k]!.v}`];
    });
    expect(differences).toEqual([]);
  });
});

describe("BCP import: integrity", () => {
  // BCP-1 (1960) and the committee workbook BCP-C1 (migration 2110, ADR-047), and no other template.
  it("keeps the templates equal to @cdf/contracts", async () => {
    const versions = await admin<{ v: string }[]>`
      select distinct template_version as v from exchange.bcp_template_sheet order by 1`;
    expect(versions.map((x) => x.v)).toEqual([...BCP_TEMPLATE_VERSIONS].sort());
    for (const version of BCP_TEMPLATE_VERSIONS) await templateEqual(version, BCP_TEMPLATES[version]);
  });

  async function templateEqual(version: string, template: readonly BcpSheet[]) {
    const sheets = await admin<{ sheet_code: string; sheet_kind: string; command: string | null }[]>`
      select sheet_code, sheet_kind, command from exchange.bcp_template_sheet where template_version = ${version}
      order by position`;
    expect(sheets.map((x) => [x.sheet_code, x.sheet_kind, x.command])).toEqual(
      template.map((x) => [x.code, x.kind, x.command ?? null]),
    );
    const columns = await admin<
      {
        sheet_code: string;
        column_code: string;
        kind: string;
        required: boolean;
        min_length: number | null;
        max_length: number;
        allowed: string[] | null;
      }[]
    >`
      select sheet_code, column_code, kind, required, min_length, max_length, allowed from exchange.bcp_template_column
      where template_version = ${version} order by sheet_code collate "C", position`;
    expect(
      columns.map((c) => [
        c.sheet_code,
        c.column_code,
        c.kind,
        c.required,
        c.min_length,
        c.max_length,
        c.allowed,
      ]),
    ).toEqual(
      [...template]
        .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
        .flatMap((sh) =>
          sh.columns.map((c) => [
            sh.code,
            c.code,
            c.kind,
            c.required,
            c.minLength ?? null,
            c.maxLength,
            c.allowed ?? null,
          ]),
        ),
    );
  }

  it("gives no application role a write path, and the owner cannot rewrite history", async () => {
    const grants = await admin<{ table_name: string; privilege_type: string }[]>`
      select table_name, privilege_type from information_schema.role_table_grants
      where table_schema = 'exchange' and table_name like 'bcp_%' and grantee in ('anon', 'authenticated', 'cdf_bff', 'public')
      order by table_name, privilege_type`;
    expect(grants.every((g) => g.privilege_type === "SELECT")).toBe(true);
    expect(grants.map((g) => g.table_name)).toEqual([
      "bcp_continuity_operator", // migration 2040 (DEC-F30): the operator registry, read-only too
      "bcp_import_batch",
      "bcp_import_row",
      "bcp_provenance",
      "bcp_template_column",
      "bcp_template_sheet",
      "bcp_workbook_revocation", // migration 2100 (AMB-205): the revocations, read-only too
    ]);
    await ownerScenario(async (s) => {
      const t = await clock(s, caseB);
      const batch = await importAll(s, control(t, caseB), [subjectRow(3, "BCP-S1", t.now)]);
      await s.asOwner();
      await s.expectError(
        "",
        (tx) => tx`update exchange.bcp_provenance set original_event_at = now() where batch_id = ${batch}`,
      );
      await s.expectError("", (tx) => tx`delete from exchange.bcp_provenance where batch_id = ${batch}`);
      await s.expectError(
        "",
        (tx) => tx`update exchange.bcp_import_batch set status = 'APPROVED' where id = ${batch}`,
      );
      await s.expectError(
        "",
        (tx) =>
          tx`update exchange.bcp_import_batch set decision_reason = 'Synthetic: rewritten reason.' where id = ${batch}`,
      );
      await s.expectError(
        "",
        (tx) => tx`update exchange.bcp_import_row set resolution = 'SKIP' where batch_id = ${batch}`,
      );
      await s.expectError("", (tx) => tx`delete from exchange.bcp_import_row where batch_id = ${batch}`);
      await s.expectError("", (tx) => tx`update exchange.bcp_template_column set max_length = 1`);
      // Staged rows keep their cells even while the batch is open.
      const open = await stage(s, "caseManager", control(t, caseB, { WORKBOOK_ID: "BCP-DEMO-0002-WB2" }), [
        subjectRow(3, "BCP-S1", t.now),
      ]);
      await s.asOwner();
      await s.expectError(
        "",
        (tx) => tx`update exchange.bcp_import_row set cells = '{}' where batch_id = ${open}`,
      );
      await s.expectError(
        "",
        (tx) => tx`update exchange.bcp_import_batch set case_id = ${caseA} where id = ${open}`,
      );
      // A submitted batch keeps the hash its approval will be bound to.
      await s.as("caseManager");
      expect(await submit(s, open)).toBe("SUBMITTED");
      await s.asOwner();
      await s.expectError(
        "",
        (tx) =>
          tx`update exchange.bcp_import_batch set submitted_hash = ${"e".repeat(64)} where id = ${open}`,
      );
    });
  });

  it("reports a command's own error codes only, never database text (§82)", async () => {
    const [codes] = await admin<{ raw: string; found: string; conflict: string }[]>`
      select exchange.bcp_error_code('duplicate key value violates unique constraint "case_subject_pkey"') as raw,
             exchange.bcp_error_code('CDF_NOT_FOUND') as found,
             exchange.bcp_error_code('CDF_CONFLICT:BATCH_OPEN') as conflict`;
    expect(codes).toEqual({ raw: "CDF_ERROR", found: "CDF_NOT_FOUND", conflict: "CDF_CONFLICT:BATCH_OPEN" });
  });
});

describe("owner decisions DEC-F30 and DEC-F31 (migration 2040)", () => {
  it("T-AMB-116 (DEC-F30): a role holder without the continuity-operator authorization cannot stage or work an import", async () => {
    await ownerScenario(async (s) => {
      // Case 0001, which the lead works; prepared and recorded offline by investigatorA, who works it too.
      const t = await clock(s, caseA);
      const ctl = control(t, caseA, { PREPARED_BY: EMAIL.investigatorA! });
      const input = [
        row(
          "05_SUBJECTS",
          3,
          "BCP-S1",
          t.now,
          { DISPLAY_LABEL: "Employee Omega (synthetic)", SUBJECT_CATEGORY: "EMPLOYEE" },
          "investigatorA",
        ),
      ];
      const stageAs = (tx: Scenario["tx"]) =>
        tx`select api.stage_bcp_import(${tx.json(ctl as never)}::jsonb, ${SHA}, ${tx.json(input as never)}::jsonb)`;
      // The lead holds BCP_IMPORT and sees the case, but is not an authorized continuity operator.
      await s.as("lead");
      await s.expectError("CDF_FORBIDDEN", (tx) => stageAs(tx));
      // The registry guard is on the table, whatever path stages a workbook.
      await s.asOwner();
      await s.expectError(
        "CDF_FORBIDDEN",
        (
          tx,
        ) => tx`insert into exchange.bcp_import_batch (case_id, template_version, workbook_id, file_sha256, control,
                                                         offline_from, prepared_by, imported_by)
                   values (${caseA}, 'BCP-1', 'BCP-DEMO-OWNER', ${SHA}, '{}'::jsonb, now(), ${USERS.investigatorA},
                           ${USERS.lead})`,
      );
      const authorize = (user: UserKey, reference = "BCP-AUTH-DEMO-0002") =>
        s.tx<{ id: string }[]>`
          select api.authorize_continuity_operator(${USERS[user]}, ${reference}, ${REASON}) as id`;
      // Only the continuity administrator authorizes: never themselves, only holders of BCP_IMPORT, once.
      for (const actor of ["caseManager", "grcDirector", "lead"] as const) {
        await s.as(actor);
        await s.expectError("CDF_FORBIDDEN", () => authorize("lead"));
      }
      await s.as("platformAdmin");
      await s.expectError(
        "CDF_INVALID:user_id",
        (tx) =>
          tx`select api.authorize_continuity_operator(gen_random_uuid(), 'BCP-AUTH-DEMO-0002', ${REASON})`,
      );
      await s.expectError("CDF_FORBIDDEN", () => authorize("platformAdmin"));
      await s.expectError("CDF_CONFLICT:OPERATOR_LACKS_PERMISSION", () => authorize("investigatorB"));
      await s.expectError("CDF_INVALID:authorization_reference", () => authorize("lead", "x"));
      await s.expectError("CDF_CONFLICT:ALREADY_AUTHORIZED", () => authorize("caseManager")); // the demo seed
      const [op] = await authorize("lead");
      const batch = await stage(s, "lead", ctl, input);
      // An operator sees their own authorization; the administrator sees the registry; others see nothing of it.
      await s.as("lead");
      expect(await s.tx`select user_id from exchange.bcp_continuity_operator`).toEqual([
        { user_id: USERS.lead },
      ]);
      await s.as("investigatorB");
      expect(await s.tx`select user_id from exchange.bcp_continuity_operator`).toEqual([]);
      await s.as("platformAdmin");
      expect(await s.tx`select user_id from exchange.bcp_continuity_operator`).toHaveLength(2);
      // Revocation is the administrator's, once, and stops the importer's own steps at once.
      await s.as("caseManager");
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.revoke_continuity_operator(${op!.id}, ${REASON})`,
      );
      await s.as("platformAdmin");
      await s.tx`select api.revoke_continuity_operator(${op!.id}, ${REASON})`;
      await s.expectError(
        "CDF_CONFLICT:ALREADY_REVOKED",
        (tx) => tx`select api.revoke_continuity_operator(${op!.id}, ${REASON})`,
      );
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) => tx`select api.revoke_continuity_operator(gen_random_uuid(), ${REASON})`,
      );
      await s.as("lead");
      await s.expectError("CDF_FORBIDDEN", (tx) => tx`select api.preview_bcp_import(${batch})`);
      await s.expectError("CDF_FORBIDDEN", (tx) => tx`select api.cancel_bcp_import(${batch}, ${REASON})`);
      const other = { ...ctl, WORKBOOK_ID: "BCP-DEMO-0001-WB2" };
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) =>
          tx`select api.stage_bcp_import(${tx.json(other as never)}::jsonb, ${SHA}, ${tx.json(input as never)}::jsonb)`,
      );
      // Audited with ids only; the history is append-only.
      await s.asOwner();
      const events = await s.tx<{ action: string; keys: string[] }[]>`
        select action, array(select jsonb_object_keys(metadata)) as keys from audit.audit_event
        where object_id = ${op!.id} order by seq`;
      expect(events).toEqual([
        { action: "BCP_OPERATOR_AUTHORIZED", keys: ["user_id"] },
        { action: "BCP_OPERATOR_REVOKED", keys: ["user_id"] },
      ]);
      await s.expectError(
        "continuity operator",
        (tx) => tx`update exchange.bcp_continuity_operator set authorization_reference = 'BCP-CHANGED'`,
      );
    });
  });

  it("DEC-F31: nothing is purged while the staging retention is SOURCE_REQUIRED; once configured, a finished workbook loses its cells and keeps its trail", async () => {
    await ownerScenario(async (s) => {
      const t = await clock(s, caseB);
      const done = await importAll(s, control(t, caseB), [subjectRow(3, "BCP-S1", t.now)]);
      const open = await stage(s, "caseManager", control(t, caseB, { WORKBOOK_ID: "BCP-DEMO-0002-WB2" }), [
        subjectRow(3, "BCP-S9", t.now),
      ]);
      const purge = async () => {
        await s.asOwner();
        const [r] = await s.tx<{ n: number }[]>`select exchange.purge_expired_bcp_staging() as n`;
        return r!.n;
      };
      await s.asOwner();
      expect(
        await s.tx`select value, status from config.setting where key = 'BCP_STAGING_RETENTION_DAYS'`,
      ).toEqual([{ value: null, status: "SOURCE_REQUIRED" }]);
      expect(await purge()).toBe(0);
      // The server's scheduled job runs it (cdf_bff), never an application user.
      for (const actor of ["platformAdmin", "caseManager"] as const) {
        await s.as(actor);
        await s.expectError("permission denied", (tx) => tx`select exchange.purge_expired_bcp_staging()`);
      }
      // Configured (a synthetic value for the test only): the finished workbook's staged cells are cleared.
      await s.asOwner();
      await s.tx`update config.setting set value = '0', status = 'CONFIGURED', source_reference = 'SYNTHETIC-TEST'
                 where key = 'BCP_STAGING_RETENTION_DAYS'`;
      expect(await purge()).toBe(1);
      expect(await purge()).toBe(0);
      const rows = await s.tx<{ batch_id: string; cells: object; purged: boolean; kept: boolean }[]>`
        select batch_id, cells, purged_at is not null as purged,
               row_key is not null and payload_hash is not null and state is not null
               and recorded_offline_by is not null as kept
        from exchange.bcp_import_row where batch_id in (${done}, ${open})`;
      expect(rows.find((r) => r.batch_id === done)).toEqual({
        batch_id: done,
        cells: {},
        purged: true,
        kept: true,
      });
      expect(rows.find((r) => r.batch_id === open)).toMatchObject({ purged: false, kept: true });
      expect(Object.keys(rows.find((r) => r.batch_id === open)!.cells).length).toBeGreaterThan(0);
      expect(await s.tx`select id from exchange.bcp_provenance where batch_id = ${done}`).toHaveLength(1);
      const [event] = await s.tx<{ actor_type: string; metadata: Record<string, number> }[]>`
        select actor_type, metadata from audit.audit_event where action = 'BCP_STAGING_PURGED'`;
      expect(event).toEqual({ actor_type: "SYSTEM", metadata: { rows: 1, batches: 1, retention_days: 0 } });
      // The purge is the only change a finished row allows, and only once.
      await s.expectError(
        "staged continuity row",
        (tx) =>
          tx`update exchange.bcp_import_row set cells = '{"DISPLAY_LABEL": "x"}'::jsonb where batch_id = ${done}`,
      );
    });
  });
});

describe("ambiguity register: what never happens offline (CDF-205, ADR-034)", () => {
  it("T-AMB-118: a 12_VOTES row stages UNSUPPORTED, can only be skipped, and the import creates no vote", async () => {
    await ownerScenario(async (s) => {
      const t = await clock(s, caseB);
      await s.asOwner();
      const [before] = await s.tx<{ v: number; i: number }[]>`
        select (select count(*) from committee.vote)::int as v, (select count(*) from committee.vote_item)::int as i`;
      const batch = await stage(s, "caseManager", control(t, caseB), [
        subjectRow(3, "BCP-S1", t.now),
        row("12_VOTES", 3, "BCP-V1", t.now, {
          DETAILS: "Synthetic: Member Alpha voted APPROVE on the package during the outage.",
        }),
      ]);
      const staged = await rows(s, batch);
      expect([staged["BCP-V1"]!.state, staged["BCP-V1"]!.resolution]).toEqual(["UNSUPPORTED", null]);
      await s.expectError("CDF_CONFLICT:RESOLUTION_NOT_ALLOWED", () =>
        resolve(s, staged["BCP-V1"]!.id, "IMPORT"),
      );
      await s.expectError("CDF_CONFLICT:RESOLUTION_NOT_ALLOWED", () =>
        resolve(s, staged["BCP-V1"]!.id, "USE_OFFLINE"),
      );
      await resolve(s, staged["BCP-V1"]!.id, "SKIP");
      expect(await submit(s, batch)).toBe("SUBMITTED");
      expect(await decide(s, "grcDirector", batch)).toBe("APPROVED");
      await apply(s, "caseManager", batch);
      await s.asOwner();
      const [after] = await s.tx<{ v: number; i: number }[]>`
        select (select count(*) from committee.vote)::int as v, (select count(*) from committee.vote_item)::int as i`;
      expect(after).toEqual(before);
      expect(await subjectCount(s, caseB)).toBeGreaterThan(0); // the importable row did go through
    });
  });

  it("T-AMB-120: no template sheet maps to identity, legal hold, disposition, export or restricted-approval commands", async () => {
    const sheets = await admin<{ template_version: string; sheet_code: string; command: string | null }[]>`
      select template_version, sheet_code, command from exchange.bcp_template_sheet where command is not null
      order by template_version collate "C", position`;
    expect(sheets.map((x) => [x.template_version, x.sheet_code, x.command])).toEqual([
      ["BCP-1", "05_SUBJECTS", "add_case_subject"],
      ["BCP-1", "06_ALLEGATIONS", "add_allegation"],
      ["BCP-1", "18_EMPLOYEE_NOTICE", "record_defence_response"],
      ["BCP-1", "21_CORRECTIVE_ACTIONS", "open_corrective_action"],
      // Migration 2110 (ADR-047): the committee workbook records a meeting already held and raises a paper-noted
      // conflict; attendance, votes and documents stay recorded only (F3).
      ["BCP-C1", "09_MEETINGS", "record_offline_meeting"],
      ["BCP-C1", "11_CONFLICTS", "raise_meeting_conflict"],
    ]);
    const FORBIDDEN =
      /(identity|reveal|legal_hold|disposition|destroy|export|approve_restricted|restricted_.*approval|grant_case_access|break_glass)/i;
    expect(sheets.filter((x) => FORBIDDEN.test(x.command!))).toEqual([]);
    // The executor calls exactly those commands (a held meeting through its own helper,
    // exchange.bcp_record_offline_meeting, never api.schedule_meeting) and refuses every other sheet.
    const [body] = await admin<{ src: string }[]>`
      select pg_get_functiondef('exchange.bcp_execute_row'::regproc) as src`;
    const called = [...body!.src.matchAll(/api\.([a-z_]+)\(/g)]
      .map((m) => m[1])
      .filter((f) => !f!.startsWith("_"));
    expect([...new Set(called)].sort()).toEqual([
      "add_allegation",
      "add_case_subject",
      "open_corrective_action",
      "raise_meeting_conflict",
      "record_defence_response",
    ]);
    expect(body!.src).toContain("SHEET_NOT_IMPORTABLE");
  });

  it("T-AMB-121: the distributed template's README sheet carries the handling notice in both languages", async () => {
    const { readFileSync } = await import("node:fs");
    const { readWorkbook } = await import("@cdf/infrastructure");
    const { messagesFor } = await import("@cdf/i18n");
    const read = readWorkbook(new Uint8Array(readFileSync("infrastructure/bcp/BCP-1_template.xlsx")));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const readme = read.workbook.sheets.find((x) => x.name === "00_README")!;
    expect(read.workbook.sheets[0]!.name).toBe("00_README");
    const lines = readme.rows.flatMap((r) => r.cells.map((c) => c.value));
    for (const lang of ["en", "ar"] as const) {
      const notice = messagesFor(lang).bcpTemplate.readme;
      // Synthetic data only; outage use only, one case; second-person approval on return.
      for (const line of [notice.line1, notice.line2, notice.line7]) expect(lines, lang).toContain(line);
    }
  });

  it("T-AMB-124: on a restricted case an importer who is not cleared gets NOT_FOUND, staging or later", async () => {
    await ownerScenario(async (s) => {
      const caseExec = await caseId("0003"); // restricted, SECRET; the GRC Director owns it
      const t = await clock(s, caseExec);
      const ctl = control(t, caseExec, { PREPARED_BY: EMAIL.grcDirector });
      const input = [
        row(
          "05_SUBJECTS",
          3,
          "BCP-S1",
          t.now,
          { DISPLAY_LABEL: "Employee Omega (synthetic)", SUBJECT_CATEGORY: "EMPLOYEE" },
          "grcDirector",
        ),
      ];
      const stageAs = (tx: Scenario["tx"]) =>
        tx`select api.stage_bcp_import(${tx.json(ctl as never)}::jsonb, ${SHA}, ${tx.json(input as never)}::jsonb)`;
      // Only an authorized continuity operator stages (DEC-F30, migration 2040); the seed authorizes the Case Manager.
      await s.as("platformAdmin");
      await s.tx`select api.authorize_continuity_operator(${USERS.grcDirector}, 'BCP-AUTH-DEMO-0124', ${REASON})`;
      // A Case Manager granted the case while cleared, whose clearance is then lowered below SECRET.
      await s.asOwner();
      await s.tx`update iam.user_profile set clearance = 'SECRET' where id = ${USERS.caseManager}`;
      await s.as("grcDirector");
      await s.tx`select api.grant_case_access(${caseExec}, ${USERS.caseManager}, 'CASE', ${REASON})`;
      await s.asOwner();
      await s.tx`update iam.user_profile set clearance = 'CONFIDENTIAL' where id = ${USERS.caseManager}`;
      await s.as("caseManager");
      await s.expectError("CDF_NOT_FOUND", stageAs);
      // The owner stages, then loses clearance: the batch disappears and every command answers NOT_FOUND.
      const batch = await stage(s, "grcDirector", ctl, input);
      await s.asOwner();
      await s.tx`update iam.user_profile set clearance = 'CONFIDENTIAL' where id = ${USERS.grcDirector}`;
      await s.as("grcDirector");
      expect(await s.tx`select id from exchange.bcp_import_batch where id = ${batch}`).toEqual([]);
      expect(await s.tx`select id from exchange.bcp_import_row where batch_id = ${batch}`).toEqual([]);
      await s.expectError("CDF_NOT_FOUND", stageAs);
      await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.preview_bcp_import(${batch})`);
      await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.apply_bcp_import(${batch}, ${SHA})`);
      await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.cancel_bcp_import(${batch}, ${REASON})`);
    });
  });
});

describe("a lost workbook is revoked (AMB-205, migration 2100)", () => {
  const INCIDENT = "INC-DEMO-2100-0001";
  const revoke = (s: Scenario, workbook: string, caseIdValue = caseB) =>
    s.tx<
      { id: string }[]
    >`select api.revoke_bcp_workbook(${caseIdValue}, ${workbook}, ${INCIDENT}, ${REASON}) as id`;
  const view = async (s: Scenario, batch: string) => {
    const [r] = await s.tx<
      { v: { workbook_revoked: boolean; capabilities: Record<string, boolean> } }[]
    >`select api.bcp_import_batch_view(${batch}) as v`;
    return r!.v;
  };

  it("T-AMB-122: a revoked workbook is never staged again, and a batch of it already staged, submitted or approved goes no further; it is only rejected or cancelled", async () => {
    await ownerScenario(async (s) => {
      const t = await clock(s, caseB);
      const [wb1, wb2, wb3] = ["BCP-DEMO-0002-LOST1", "BCP-DEMO-0002-LOST2", "BCP-DEMO-0002-LOST3"];
      // Before the loss is reported: one batch submitted, one approved, one staged.
      const submitted = await stage(s, "caseManager", control(t, caseB, { WORKBOOK_ID: wb1 }), [
        subjectRow(3, "BCP-L1", t.now),
      ]);
      expect(await submit(s, submitted)).toBe("SUBMITTED");
      const approved = await stage(s, "caseManager", control(t, caseB, { WORKBOOK_ID: wb2 }), [
        subjectRow(3, "BCP-L2", t.now, "Employee Tau (synthetic)"),
      ]);
      expect(await submit(s, approved)).toBe("SUBMITTED");
      expect(await decide(s, "grcDirector", approved)).toBe("APPROVED");
      const staged = await stage(s, "caseManager", control(t, caseB, { WORKBOOK_ID: wb3 }), [
        subjectRow(3, "BCP-L3", t.now, "Employee Upsilon (synthetic)"),
      ]);
      const before = await subjectCount(s, caseB);

      // Who revokes: the case team members who import or approve workbooks, citing the incident.
      await s.as("employee");
      await s.expectError("CDF_NOT_FOUND", () => revoke(s, wb1));
      await s.as("investigatorB");
      await s.expectError("CDF_FORBIDDEN", () => revoke(s, wb1));
      await s.as("caseManager");
      await s.expectError("CDF_INVALID:workbook_id", () => revoke(s, "lost workbook"));
      await s.expectError(
        "CDF_INVALID:incident_reference",
        (tx) => tx`select api.revoke_bcp_workbook(${caseB}, ${wb1}, null, ${REASON})`,
      );
      const [r1] = await revoke(s, wb1);
      await s.expectError("CDF_CONFLICT:WORKBOOK_REVOKED", () => revoke(s, wb1));
      await s.as("grcDirector");
      await revoke(s, wb2);
      await revoke(s, wb3);
      // A workbook never staged on the case can be revoked too.
      await revoke(s, "BCP-DEMO-0002-NEVER");

      // T-AMB-122: never staged again, through the command or at the table.
      await s.expectError("CDF_CONFLICT:WORKBOOK_REVOKED", () =>
        stage(s, "caseManager", control(t, caseB, { WORKBOOK_ID: "BCP-DEMO-0002-NEVER" }), [
          subjectRow(3, "BCP-L4", t.now),
        ]),
      );
      // A batch already staged is not submitted, even at the table; it is cancelled.
      await s.as("caseManager");
      expect(await view(s, staged)).toMatchObject({
        workbook_revoked: true,
        capabilities: { may_submit: false },
      });
      await s.expectError("CDF_CONFLICT:WORKBOOK_REVOKED", () => submit(s, staged));
      await s.asOwner();
      await s.expectError(
        "CDF_CONFLICT:WORKBOOK_REVOKED",
        (tx) =>
          tx`update exchange.bcp_import_batch set status = 'SUBMITTED', submitted_hash = ${"b".repeat(64)}
             where id = ${staged}`,
      );
      await s.as("caseManager");
      await s.tx`select api.cancel_bcp_import(${staged}, ${REASON})`;
      await s.expectError("CDF_CONFLICT:WORKBOOK_REVOKED", () =>
        stage(s, "caseManager", control(t, caseB, { WORKBOOK_ID: wb3 }), [subjectRow(3, "BCP-L3", t.now)]),
      );
      await s.asOwner();
      await s.expectError(
        "CDF_CONFLICT:WORKBOOK_REVOKED",
        (tx) =>
          tx`insert into exchange.bcp_import_batch (case_id, template_version, workbook_id, file_sha256, control,
               offline_from, prepared_by, imported_by)
             select case_id, template_version, workbook_id, file_sha256, control, offline_from, prepared_by, imported_by
             from exchange.bcp_import_batch where id = ${staged}`,
      );

      // The submitted batch is not approved (rejecting stays open); the approved one is not applied (cancelling
      // stays open). The view says so, and its capabilities follow the commands.
      await s.as("grcDirector");
      expect(await view(s, submitted)).toMatchObject({
        workbook_revoked: true,
        capabilities: { may_decide: true, may_approve: false },
      });
      await s.expectError("CDF_CONFLICT:WORKBOOK_REVOKED", () => decide(s, "grcDirector", submitted));
      expect(await decide(s, "grcDirector", submitted, "REJECT")).toBe("REJECTED");
      await s.as("caseManager");
      expect(await view(s, approved)).toMatchObject({
        workbook_revoked: true,
        capabilities: { may_apply: false, may_cancel: true },
      });
      await s.expectError("CDF_CONFLICT:WORKBOOK_REVOKED", () => apply(s, "caseManager", approved));
      await s.tx`select api.cancel_bcp_import(${approved}, ${REASON})`;
      expect(await subjectCount(s, caseB)).toBe(before);

      // A business event for the case trail and a security event for the incident, ids and counts only; the
      // revocation is read by the case team members who import or approve.
      expect(
        await s.tx`select action, category, case_id, reason, metadata from audit.audit_event
                   where object_id = ${r1!.id} order by seq`,
      ).toEqual([
        {
          action: "BCP_WORKBOOK_REVOCATION_RECORDED",
          category: "BUSINESS",
          case_id: caseB,
          reason: null,
          metadata: { open_batches: 1 },
        },
        {
          action: "BCP_WORKBOOK_REVOKED",
          category: "SECURITY",
          case_id: caseB,
          reason: null,
          metadata: { open_batches: 1 },
        },
      ]);
      await s.as("investigatorB");
      expect(await s.tx`select id from exchange.bcp_workbook_revocation`).toEqual([]);
      await s.as("caseManager");
      expect(
        (
          await s.tx<
            { workbook_id: string }[]
          >`select workbook_id from exchange.bcp_workbook_revocation order by workbook_id`
        ).map((x) => x.workbook_id),
      ).toEqual([wb1, wb2, wb3, "BCP-DEMO-0002-NEVER"].sort());
      await s.asOwner();
      await s.expectError(
        "exchange.bcp_workbook_revocation is append-only",
        (tx) => tx`delete from exchange.bcp_workbook_revocation`,
      );
    });
  });
});

describe("restore notices (AMB-210, migration 2110)", () => {
  interface Sent {
    recipient_id: string;
    template_code: string;
    channel: string;
    restored_row_id: string | null;
    original_event_at: Date | null;
  }
  const sent = (s: Scenario, object: string) =>
    s.tx<
      Sent[]
    >`select recipient_id, template_code, channel, restored_row_id, original_event_at from notify.outbox
                 where object_id = ${object} order by template_code, channel`;

  it("T-AMB-210: an import's mandatory notices go out now and name the row and the original time; optional ones are skipped; the marker is believed only from the transaction applying the importer's own approved row (R3)", async () => {
    await ownerScenario(async (s) => {
      const t = await clock(s, caseB);
      await s.as("platformAdmin");
      await s.tx`select api.grant_role(${USERS.employeeB}, 'IMPLEMENTATION_OWNER', 'Synthetic: implementation owner')`;
      const f = await draftPackage(s, ic, caseB);
      await s.as("committeeSecretary");
      await s.tx`select api.withdraw_recommendation_item(${f.sanction}, ${REASON})`;
      await voteOnPackage(s, f);
      await s.as("committeeSecretary");
      await s.tx`select api.submit_to_authority(${f.pkg})`;
      await s.tx`select api.record_authority_decision(${f.pkg}, 'CEO', 'APPROVE_AS_RECOMMENDED', now(),
        'Chief Executive (synthetic)', 'MEMO-DEMO-0101', null, ${REASON})`;
      const action = (n: number, key: string) =>
        row("21_CORRECTIVE_ACTIONS", n, key, t.created, {
          RECOMMENDATION_ITEM_ID: f.corrective,
          TITLE: `Synthetic: second approver on payments (${key})`,
          DESCRIPTION: "Synthetic: agreed with the owner during the outage.",
          OWNER: EMAIL.employeeB!,
          DUE_DATE: t.tomorrow.slice(0, 10),
        });
      const batch = await importAll(s, control(t, caseB), [action(3, "BCP-N1")]);
      await s.asOwner();
      const [imported] = await s.tx<{ row_id: string; object_id: string }[]>`
        select row_id, object_id from exchange.bcp_provenance where batch_id = ${batch}`;
      // CORRECTIVE_ACTION_ASSIGNED is mandatory: sent now, naming the row and the offline time.
      const assigned = await sent(s, imported!.object_id);
      expect(assigned.map((n) => [n.template_code, n.channel])).toEqual([
        ["CORRECTIVE_ACTION_ASSIGNED", "EMAIL"],
        ["CORRECTIVE_ACTION_ASSIGNED", "IN_APP"],
      ]);
      for (const n of assigned) {
        expect(n.recipient_id).toBe(USERS.employeeB);
        expect(n.restored_row_id).toBe(imported!.row_id);
        expect(n.original_event_at!.toISOString()).toBe(new Date(t.created).toISOString());
      }
      const [a] = await s.tx<{ m: Record<string, unknown> }[]>`
        select metadata as m from audit.audit_event where action = 'BCP_ROW_IMPORTED' and metadata ->> 'batch_id' = ${batch}`;
      expect(a!.m.restore_notices).toBe(2);
      // The batch's own notices are live ones.
      const own = await s.tx<{ n: number }[]>`
        select count(*)::int as n from notify.outbox where object_id = ${batch} and restored_row_id is not null`;
      expect(own[0]!.n).toBe(0);
      expect(await notified(s, "BCP_IMPORT_DECIDED", batch)).toEqual(["caseManager"]);
      // The recipient reads the reference on their own in-app row.
      await s.as("employeeB");
      const [mine] = await s.tx<{ restored_row_id: string; original_event_at: Date }[]>`
        select restored_row_id, original_event_at from notify.outbox where object_id = ${imported!.object_id}`;
      expect(mine!.restored_row_id).toBe(imported!.row_id);
      // Both are facts of the notice.
      await s.asOwner();
      await s.expectError(
        "notify.outbox facts are immutable",
        (tx) =>
          tx`update notify.outbox set original_event_at = now() where object_id = ${imported!.object_id}`,
      );

      // R3 (AGENT-09): the real importer names their own APPROVED row of a second batch, not yet applied, and then
      // runs ordinary commands. The row carries no stamp from this transaction, so the notices are live ones: the
      // optional one is sent and neither names a row.
      await s.as("platformAdmin");
      await s.tx`select api.grant_role(${USERS.employee}, 'IMPLEMENTATION_OWNER', 'Synthetic: implementation owner')`;
      const second = await stage(s, "caseManager", control(t, caseB, { WORKBOOK_ID: "BCP-DEMO-0002-WB9" }), [
        action(3, "BCP-N2"),
      ]);
      expect(await submit(s, second)).toBe("SUBMITTED");
      expect(await decide(s, "grcDirector", second)).toBe("APPROVED");
      await s.asOwner();
      const [r2] = await s.tx<{ id: string; applying_xact: string | null }[]>`
        select id, applying_xact::text from exchange.bcp_import_row where batch_id = ${second}`;
      expect(r2!.applying_xact).toBeNull();
      const marked = async (actor: UserKey, marker: string, run: () => Promise<unknown>) => {
        await s.as(actor);
        await s.tx`select set_config('cdf.bcp_restore_row', ${marker}, true)`;
        await run();
        await s.tx`select set_config('cdf.bcp_restore_row', '', true)`;
        await s.asOwner();
      };
      await marked(
        "caseManager",
        r2!.id,
        () =>
          s.tx`select api.change_corrective_action_due_date(${imported!.object_id}, ${t.tomorrow.slice(0, 10)}::date + 7, ${WHY})`,
      );
      await marked(
        "caseManager",
        r2!.id,
        () =>
          s.tx`select api.assign_corrective_action_owner(${imported!.object_id}, ${USERS.employee}, ${WHY})`,
      );
      const live = await s.tx<
        { template_code: string; recipient_id: string; restored_row_id: string | null }[]
      >`
        select template_code, recipient_id, restored_row_id from notify.outbox
        where object_id = ${imported!.object_id} and channel = 'IN_APP'
          and template_code in ('CORRECTIVE_ACTION_CHANGED', 'CORRECTIVE_ACTION_ASSIGNED') and restored_row_id is null
        order by template_code`;
      expect(live).toEqual([
        { template_code: "CORRECTIVE_ACTION_ASSIGNED", recipient_id: USERS.employee, restored_row_id: null },
        { template_code: "CORRECTIVE_ACTION_CHANGED", recipient_id: USERS.employeeB, restored_row_id: null },
      ]);

      // Probe of notify.enqueue (owner connection with a caller's claims): only the stamp of this transaction makes
      // the named row a restore context, and only for its importer while the batch is approved.
      const probe = async (actor: UserKey, marker: string, template: string, key: string) => {
        await s.tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: USERS[actor], role: "authenticated" })}, true),
                          set_config('cdf.bcp_restore_row', ${marker}, true)`;
        await s.tx`select notify.enqueue(${template}, ${USERS.employeeB}, ${imported!.object_id}, null, ${key})`;
        await s.tx`select set_config('cdf.bcp_restore_row', '', true), set_config('request.jwt.claims', '', true)`;
        return s.tx<{ restored_row_id: string | null }[]>`
          select restored_row_id from notify.outbox where dedupe_key like ${key + ":%"} and channel = 'IN_APP'`;
      };
      // Unstamped, or stamped by another transaction: ignored.
      expect(await probe("caseManager", r2!.id, "CORRECTIVE_ACTION_RETURNED", "probe-1")).toEqual([
        { restored_row_id: null },
      ]);
      await s.tx`alter table exchange.bcp_import_row disable trigger bcp_import_row_protect`;
      await s.tx`update exchange.bcp_import_row set applying_xact = '1'::xid8 where id = ${r2!.id}`;
      await s.tx`alter table exchange.bcp_import_row enable trigger bcp_import_row_protect`;
      expect(await probe("caseManager", r2!.id, "CORRECTIVE_ACTION_RETURNED", "probe-2")).toEqual([
        { restored_row_id: null },
      ]);
      // The stamp is written once, only by the applying transaction while the batch is approved.
      await s.expectError(
        "staged continuity row",
        (tx) =>
          tx`update exchange.bcp_import_row set applying_xact = pg_current_xact_id() where id = ${r2!.id}`,
      );
      await s.expectError(
        "staged continuity row",
        (tx) =>
          tx`update exchange.bcp_import_row set applying_xact = pg_current_xact_id() where id = ${imported!.row_id}`,
      );
      await s.tx`alter table exchange.bcp_import_row disable trigger bcp_import_row_protect`;
      await s.tx`update exchange.bcp_import_row set applying_xact = null where id = ${r2!.id}`;
      await s.tx`alter table exchange.bcp_import_row enable trigger bcp_import_row_protect`;
      // Stamped by this transaction (as exchange.bcp_run does): the importer's optional notice is skipped and the
      // mandatory one names the row.
      await s.tx`update exchange.bcp_import_row set applying_xact = pg_current_xact_id() where id = ${r2!.id}`;
      expect(await probe("caseManager", r2!.id, "CORRECTIVE_ACTION_CHANGED", "probe-3")).toEqual([]);
      expect(await probe("caseManager", r2!.id, "CORRECTIVE_ACTION_RETURNED", "probe-4")).toEqual([
        { restored_row_id: r2!.id },
      ]);
      // Anyone else, a row of an imported batch, or a name that is not a uuid: ignored.
      expect(await probe("grcDirector", r2!.id, "CORRECTIVE_ACTION_CHANGED", "probe-5")).toEqual([
        { restored_row_id: null },
      ]);
      expect(await probe("caseManager", imported!.row_id, "CORRECTIVE_ACTION_CHANGED", "probe-6")).toEqual([
        { restored_row_id: null },
      ]);
      expect(await probe("caseManager", "not-a-row", "CORRECTIVE_ACTION_CHANGED", "probe-7")).toEqual([
        { restored_row_id: null },
      ]);
      // The applied row keeps the stamp of the transaction that applied it.
      const [stamp] = await s.tx<{ same: boolean }[]>`
        select applying_xact = pg_current_xact_id() as same from exchange.bcp_import_row where id = ${imported!.row_id}`;
      expect(stamp!.same).toBe(true);
      // The setting has one value.
      await s.expectError(
        'new row for relation "setting" violates check constraint',
        (tx) => tx`update config.setting set value = 'ALL' where key = 'BCP_RESTORE_NOTIFY'`,
      );
    });
  });
});
