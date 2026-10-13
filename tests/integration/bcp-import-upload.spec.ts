// Continuity workbook upload (ADR-034, migration 1960) through the real service, scanner, workbook reader, gateway,
// database, RLS and audit: a workbook file written from the BCP-1 template is staged, resolved, previewed, submitted,
// approved by a different person and imported, and hostile or wrong files never reach the database. Each test runs in
// one owner-connection transaction that is rolled back; the gateway runs its security context in a savepoint of it.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createBcpImportService, createInvestigationService, type BcpImportService } from "@cdf/application";
import type { Actor } from "@cdf/contracts";
import {
  EICAR_TEST_SIGNATURE,
  MockMalwareScanner,
  PostgresBcpImportGateway,
  PostgresInvestigationGateway,
  PostgresSecurityEventSink,
  SpreadsheetMlSubsetReader,
  bcpTemplateSheets,
  writeWorkbook,
  type Sql,
} from "@cdf/infrastructure";
import { USERS, admin, bff, caseId, ownerScenario, type OwnerScenario, type UserKey } from "../support/db";

const investigation = createInvestigationService({
  gateway: new PostgresInvestigationGateway(bff),
  securityEvents: new PostgresSecurityEventSink(bff),
});
const actors = new Map<UserKey, Actor>();
async function actor(user: UserKey): Promise<Actor> {
  if (!actors.has(user)) {
    const a = await investigation.loadActor({ userId: USERS[user], requestId: randomUUID() });
    if (!a) throw new Error(`no actor for ${user}`);
    actors.set(user, a);
  }
  return actors.get(user)!;
}
const ctxFor = (user: UserKey, requestId = randomUUID()) => ({ userId: USERS[user], requestId });
const REASON = "Synthetic: checked against the paper file.";

function bcpIn(s: OwnerScenario): BcpImportService {
  const sql = {
    begin: (fn: (tx: unknown) => Promise<unknown>) => s.tx.savepoint(fn as never),
  } as unknown as Sql;
  return createBcpImportService({
    gateway: new PostgresBcpImportGateway(sql),
    reader: new SpreadsheetMlSubsetReader(),
    scanner: new MockMalwareScanner(),
    securityEvents: new PostgresSecurityEventSink(sql),
  });
}

function value<T>(r: { ok: true; value: T } | { ok: false }): T {
  if (!r.ok) throw new Error(`refused: ${JSON.stringify(r)}`);
  return r.value;
}

function outcome(r: { ok: boolean }): string {
  if (r.ok) return "ok";
  if ("error" in r) {
    const e = (r as { error: { kind: string; detail?: string } }).error;
    return e.detail ? `${e.kind}:${e.detail}` : e.kind;
  }
  return "fieldErrors";
}

const TEXT = { label: (code: string) => `${code} (label)`, readme: ["Synthetic continuity workbook."] };

/** The BCP-1 template with the control row and the data rows given (by sheet, from row 3), as file bytes. */
function workbookFile(control: Record<string, string>, data: Record<string, Record<string, string>[]>) {
  const sheets = bcpTemplateSheets(TEXT).map((sheet) => {
    if (sheet.name === "00_README") return sheet;
    const codes = sheet.rows[0]!;
    const rows = sheet.name === "01_CONTROL" ? [control] : (data[sheet.name] ?? []);
    return { ...sheet, rows: [...sheet.rows, ...rows.map((r) => codes.map((c) => r[c] ?? ""))] };
  });
  return writeWorkbook(sheets);
}

let caseB: string;
let caseNumber: string;
const EMAIL: Record<string, string> = {};
beforeAll(async () => {
  caseB = await caseId("0002");
  const [c] = await admin<
    { n: string }[]
  >`select case_number as n from case_mgmt.case_record where id = ${caseB}`;
  caseNumber = c!.n;
  const users = await admin<{ id: string; email: string }[]>`select id, email from iam.user_profile`;
  for (const [key, id] of Object.entries(USERS)) EMAIL[key] = users.find((u) => u.id === id)!.email;
});

/** The case's creation time and the transaction's time, as the workbook would hold them. */
async function window(s: OwnerScenario): Promise<{ from: string; at: string }> {
  await s.asOwner();
  const [r] = await s.tx<{ from: string; at: string }[]>`
    select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as from,
           to_char((created_at + (now() - created_at) / 2) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as at
    from case_mgmt.case_record where id = ${caseB}`;
  return r!;
}

function control(from: string): Record<string, string> {
  return {
    TEMPLATE_VERSION: "BCP-1",
    WORKBOOK_ID: "BCP-DEMO-UPLOAD-1",
    CASE_ID: caseB,
    CASE_NUMBER: caseNumber,
    OFFLINE_FROM: from,
    PREPARED_BY: EMAIL.investigatorB!,
  };
}

async function audited(s: OwnerScenario, requestId: string): Promise<string[]> {
  await s.asOwner();
  const rows = await s.tx<{ action: string; reason: string | null }[]>`
    select action, metadata ->> 'reason' as reason from audit.audit_event
    where request_id = ${requestId} order by seq`;
  return rows.map((r) => (r.reason ? `${r.action}:${r.reason}` : r.action));
}

async function batchCount(s: OwnerScenario): Promise<number> {
  await s.asOwner();
  const [r] = await s.tx<{ n: number }[]>`select count(*)::int as n from exchange.bcp_import_batch`;
  return r!.n;
}

describe("continuity workbook upload, end to end (ADR-034)", () => {
  it("imports a workbook file written from the template, after a different person approves it", async () => {
    await ownerScenario(async (s) => {
      const { from, at } = await window(s);
      const by = { ORIGINAL_EVENT_AT: at, RECORDED_OFFLINE_BY: EMAIL.investigatorB! };
      const bytes = workbookFile(control(from), {
        "05_SUBJECTS": [
          {
            ROW_ID: "BCP-UP-S1",
            ...by,
            DISPLAY_LABEL: "الموظف أوميغا (تجريبي)",
            SUBJECT_CATEGORY: "EMPLOYEE",
          },
        ],
        "06_ALLEGATIONS": [
          {
            ROW_ID: "BCP-UP-A1",
            ...by,
            CATEGORY: "MISCONDUCT",
            DESCRIPTION: "Synthetic: allegation recorded during the outage & typed later.\nSecond line.",
            SUBJECT_REF: "bcp-up-s1",
          },
        ],
        "09_MEETINGS": [{ ROW_ID: "BCP-UP-M1", ...by, DETAILS: "Synthetic: a meeting held on paper." }],
      });
      const manager = bcpIn(s);
      const cm = await actor("caseManager");
      const staged = value(
        await manager.stage(ctxFor("caseManager"), cm, { caseId: caseB }, { name: "outage.xlsx", bytes }),
      );
      expect(staged).toMatchObject({ rows: 3, invalidRows: 0 });
      expect(staged.sha256).toMatch(/^[0-9a-f]{64}$/);

      const rows = await manager.batchRows(ctxFor("caseManager"), staged.batchId);
      expect(rows.map((r) => [r.sheet, r.row_key, r.state])).toEqual([
        ["05_SUBJECTS", "BCP-UP-S1", "NEW"],
        ["06_ALLEGATIONS", "BCP-UP-A1", "NEW"],
        ["09_MEETINGS", "BCP-UP-M1", "UNSUPPORTED"],
      ]);
      // The approver cannot see the batch before it is submitted.
      expect(await manager.batches(ctxFor("grcDirector"), caseB)).toEqual([]);

      const meeting = rows.find((r) => r.sheet === "09_MEETINGS")!;
      expect(
        outcome(
          await manager.resolve(ctxFor("caseManager"), cm, {
            rowId: meeting.id,
            resolution: "SKIP",
            reason: "Synthetic: the meeting is entered online.",
          }),
        ),
      ).toBe("ok");
      const preview = value(await manager.preview(ctxFor("caseManager"), cm, { batchId: staged.batchId }));
      expect(preview).toMatchObject({ clean: true, status: "STAGED" });
      expect(preview.rows.map((r) => r.outcome)).toEqual(["OK", "OK", null]);
      expect(
        value(
          await manager.submit(ctxFor("caseManager"), cm, {
            batchId: staged.batchId,
            previewHash: preview.hash,
          }),
        ),
      ).toBe("SUBMITTED");

      const director = await actor("grcDirector");
      const [batch] = await manager.batches(ctxFor("grcDirector"), caseB);
      expect(batch).toMatchObject({ id: staged.batchId, status: "SUBMITTED", submittedHash: preview.hash });
      // The importer cannot approve their own import, whatever permissions they hold.
      expect(
        outcome(
          await manager.decide(ctxFor("caseManager"), cm, {
            batchId: staged.batchId,
            decision: "APPROVE",
            reason: REASON,
            previewHash: preview.hash,
          }),
        ),
      ).toBe("FORBIDDEN");
      expect(
        value(
          await manager.decide(ctxFor("grcDirector"), director, {
            batchId: staged.batchId,
            decision: "APPROVE",
            reason: REASON,
            previewHash: batch!.submittedHash!,
          }),
        ),
      ).toBe("APPROVED");
      expect(
        value(
          await manager.apply(ctxFor("caseManager"), cm, {
            batchId: staged.batchId,
            previewHash: preview.hash,
          }),
        ),
      ).toEqual({ imported: 2, skipped: 1, kept: 0, already_imported: 0 });

      await s.asOwner();
      const [subject] = await s.tx<{ label: string }[]>`
        select pe.display_name as label from exchange.bcp_provenance p
        join case_mgmt.case_subject s on s.id = p.object_id
        join case_mgmt.person pe on pe.id = s.person_id
        where p.case_id = ${caseB} and p.row_key = 'BCP-UP-S1'`;
      expect(subject!.label).toBe("الموظف أوميغا (تجريبي)");
      const [allegation] = await s.tx<{ description: string; subject_matches: boolean }[]>`
        select a.description,
               a.subject_id = (select object_id from exchange.bcp_provenance
                               where case_id = ${caseB} and row_key = 'BCP-UP-S1') as subject_matches
        from exchange.bcp_provenance p join case_mgmt.allegation a on a.id = p.object_id
        where p.case_id = ${caseB} and p.row_key = 'BCP-UP-A1'`;
      expect(allegation).toEqual({
        description: "Synthetic: allegation recorded during the outage & typed later.\nSecond line.",
        subject_matches: true,
      });
      const [stored] = await s.tx<{ sha: string }[]>`
        select file_sha256 as sha from exchange.bcp_import_batch where id = ${staged.batchId}`;
      expect(stored!.sha).toBe(staged.sha256);
    });
  });

  it("refuses hostile or wrong files before anything reaches the database, recording only a reason", async () => {
    await ownerScenario(async (s) => {
      const { from, at } = await window(s);
      const cm = await actor("caseManager");
      const before = await batchCount(s);
      const good = workbookFile(control(from), {
        "05_SUBJECTS": [
          {
            ROW_ID: "BCP-UP-S2",
            ORIGINAL_EVENT_AT: at,
            RECORDED_OFFLINE_BY: EMAIL.investigatorB!,
            DISPLAY_LABEL: "Employee Psi (synthetic)",
            SUBJECT_CATEGORY: "EMPLOYEE",
          },
        ],
      });
      const infected = new Uint8Array([...new TextEncoder().encode(EICAR_TEST_SIGNATURE), ...good]);
      const cases: [string, Uint8Array, string, string][] = [
        [
          "outage.xlsx",
          new TextEncoder().encode("not a workbook"),
          "INVALID:WORKBOOK_NOT_A_ZIP",
          "NOT_A_ZIP",
        ],
        ["outage.xlsx", infected, "CONFLICT:MALWARE_DETECTED", "MALWARE_DETECTED"],
        ["outage.xlsm", good, "INVALID:WORKBOOK_FILE_TYPE", "FILE_TYPE"],
      ];
      for (const [name, bytes, expected, reason] of cases) {
        const requestId = randomUUID();
        const r = await bcpIn(s).stage(
          ctxFor("caseManager", requestId),
          cm,
          { caseId: caseB },
          { name, bytes },
        );
        expect(outcome(r), name).toBe(expected);
        expect(await audited(s, requestId)).toEqual([`VALIDATION_REJECTED:${reason}`]);
      }
      // A workbook naming another case than the page it is uploaded from.
      const caseA = await caseId("0001");
      const requestId = randomUUID();
      expect(
        outcome(
          await bcpIn(s).stage(
            ctxFor("caseManager", requestId),
            cm,
            { caseId: caseA },
            {
              name: "outage.xlsx",
              bytes: good,
            },
          ),
        ),
      ).toBe("INVALID:WORKBOOK_CASE_MISMATCH");
      expect(await audited(s, requestId)).toEqual(["VALIDATION_REJECTED:CASE_MISMATCH"]);
      // Someone without BCP_IMPORT is refused before the file is scanned or read.
      const outsider = randomUUID();
      expect(
        outcome(
          await bcpIn(s).stage(
            ctxFor("investigatorA", outsider),
            await actor("investigatorA"),
            { caseId: caseB },
            { name: "outage.xlsx", bytes: good },
          ),
        ),
      ).toBe("FORBIDDEN");
      expect(await audited(s, outsider)).toEqual(["COMMAND_DENIED"]);
      expect(await batchCount(s)).toBe(before);
    });
  });
});
