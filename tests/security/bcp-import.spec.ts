// Business architecture rebase phase 10, migration 1960 (ADR-027, ADR-034; owner Q&A Q100; N17): the governed import
// of a business continuity workbook. A workbook is staged for a case its importer can see, every row is validated and
// classified, conflicts and unsupported rows are resolved explicitly, the preview is a rolled-back dry run of the real
// commands, a different person approves, and the importer applies it in one transaction with the offline provenance
// kept. Every step runs through the api.* commands as `authenticated`; the owner connection is used only to read the
// case's clock, the outbox and the audit ledger, and to probe the triggers.
import { beforeAll, describe, expect, it } from "vitest";
import { BCP_TEMPLATE } from "@cdf/contracts";
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
    PREPARED_BY: EMAIL.lead!,
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
  by: UserKey = "lead",
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
        expect(r.recorded_offline_by).toBe(USERS.lead);
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
        recorded_offline_by: USERS.lead,
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
      await s.tx`select api.record_authority_decision(${f.pkg}, 'CEO', 'APPROVE_AS_RECOMMENDED', now() - interval '1 hour',
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
          RECORDED_OFFLINE_BY: EMAIL.lead!.toUpperCase(),
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
        RECORDED_OFFLINE_BY: EMAIL.lead,
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
      ...["BCP-1", "bcp-1", " BCP-2 ", "BCP-1000", "BCP-", "BCP-X", ""].map((v): [string, string, string] => [
        "01_CONTROL",
        "TEMPLATE_VERSION",
        v,
      ]),
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
  it("keeps the template equal to @cdf/contracts", async () => {
    const sheets = await admin<{ sheet_code: string; sheet_kind: string; command: string | null }[]>`
      select sheet_code, sheet_kind, command from exchange.bcp_template_sheet where template_version = 'BCP-1'
      order by position`;
    expect(sheets.map((x) => [x.sheet_code, x.sheet_kind, x.command])).toEqual(
      BCP_TEMPLATE.map((x) => [x.code, x.kind, x.command ?? null]),
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
      where template_version = 'BCP-1' order by sheet_code, position`;
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
      [...BCP_TEMPLATE]
        .sort((a, b) => a.code.localeCompare(b.code))
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
  });

  it("gives no application role a write path, and the owner cannot rewrite history", async () => {
    const grants = await admin<{ table_name: string; privilege_type: string }[]>`
      select table_name, privilege_type from information_schema.role_table_grants
      where table_schema = 'exchange' and table_name like 'bcp_%' and grantee in ('anon', 'authenticated', 'cdf_bff', 'public')
      order by table_name, privilege_type`;
    expect(grants.every((g) => g.privilege_type === "SELECT")).toBe(true);
    expect(grants.map((g) => g.table_name)).toEqual([
      "bcp_import_batch",
      "bcp_import_row",
      "bcp_provenance",
      "bcp_template_column",
      "bcp_template_sheet",
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
