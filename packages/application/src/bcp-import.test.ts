// Continuity workbook service (ADR-034, migration 1960): the upload is refused before anything reads it when the
// caller lacks BCP_IMPORT or the file is the wrong type or size, then scanned (fail closed), read through the port,
// checked against the template and the shared schema; refusals carry codes, never file names or cells. The database
// side (case gate, separate approver, hash binding, dry run) is in tests/security/bcp-import.spec.ts.
import { describe, expect, it } from "vitest";
import {
  BCP_MAX_WORKBOOK_BYTES,
  BCP_TEMPLATE,
  type Actor,
  type BcpWorkbook,
  type BcpWorkbookRow,
  type Permission,
} from "@cdf/contracts";
import type { SecurityEvent } from "@cdf/audit";
import { createBcpImportService, type BcpImportGateway } from "./bcp-import";
import type { ScanResult, WorkbookReadResult } from "./ports";

const CASE = "00000000-0000-4000-8000-000000000001";
const BATCH = "44444444-4444-4444-8444-444444444444";
const ROW = "55555555-5555-4555-8555-555555555555";
const HASH = "a".repeat(64);
const ctx = {
  userId: "a0000000-0000-4000-8000-000000000003",
  requestId: "22222222-2222-4222-8222-222222222222",
};

function actor(permissions: Permission[]): Actor {
  return {
    userId: ctx.userId,
    email: "casemanager@example.test",
    displayName: "Case Manager Delta",
    displayNameAr: "مدير القضايا دلتا",
    roles: ["CASE_MANAGER"],
    permissions,
    clearance: "CONFIDENTIAL",
  };
}
const importer = actor(["BCP_IMPORT"]);
const approver = actor(["BCP_IMPORT_APPROVE"]);

const cells = (values: readonly string[]) =>
  values.map((value, i) => ({ column: i + 1, value, formula: false }));
const CONTROL = [
  "BCP-1",
  "BCP-WB-1",
  CASE.toUpperCase(),
  "CDF-DEMO-2026-0001",
  "2026-10-01T08:00:00Z",
  "",
  "lead@example.test",
];
const subject = (category: string) => [
  "BCP-S1",
  "",
  "2026-10-01T09:30:00Z",
  "lead@example.test",
  "Employee Omega (synthetic)",
  category,
];

function workbook(control = CONTROL, subjects: BcpWorkbookRow[] = []): BcpWorkbook {
  return {
    sheets: BCP_TEMPLATE.map((sheet) => {
      const codes = sheet.columns.map((c) => c.code);
      const rows: BcpWorkbookRow[] = sheet.kind === "README" ? [] : [{ row: 1, cells: cells(codes) }];
      if (sheet.kind === "CONTROL") rows.push({ row: 3, cells: cells(control) });
      if (sheet.code === "05_SUBJECTS") rows.push(...subjects);
      return { name: sheet.code, rows };
    }),
  };
}
const GOOD = workbook(CONTROL, [
  { row: 3, cells: cells(subject("EMPLOYEE")) },
  { row: 4, cells: cells(subject("BOSS")) },
]);

const file = (bytes = new TextEncoder().encode("synthetic workbook bytes"), name = "BCP-1 outage.XLSX") => ({
  name,
  bytes,
});

function harness(
  opts: {
    scan?: ScanResult | "throws";
    read?: WorkbookReadResult | "throws";
    refusal?: string;
  } = {},
) {
  const calls: string[] = [];
  const events: SecurityEvent[] = [];
  const staged: unknown[] = [];
  const step = async (name: string) => {
    calls.push(name);
    if (opts.refusal) throw new Error(opts.refusal);
  };
  const gateway: BcpImportGateway = {
    view: async () => {
      await step("view");
      return {
        view: {
          batchId: BATCH,
          templateVersion: "BCP-1",
          workbookId: "BCP-WB-1",
          scope: "CASE",
          committeeProceedingId: null,
          fileSha256: HASH,
          offlineFrom: "2026-10-01T08:00:00.000Z",
          offlineTo: null,
          preparedBy: ctx.userId,
          status: "STAGED",
          previewHash: null,
          previewedAt: null,
          previewClean: false,
          submittedHash: null,
          importedBy: ctx.userId,
          decidedBy: null,
          decisionReason: null,
          createdAt: "2026-10-18T09:00:00.000Z",
          submittedAt: null,
          decidedAt: null,
          appliedAt: null,
          cancelledAt: null,
          updatedAt: "2026-10-18T09:00:00.000Z",
          rowVersion: 1,
          currentHash: HASH,
          workbookRevoked: false,
          officialRecordRequired: false,
          counts: { rows: 0, unresolved: 0, ballots: 0, byState: {} },
          rows: [],
          caseId: CASE,
          caseNumber: "CDF-DEMO-2026-0001",
          capabilities: {
            mayResolveRows: false,
            mayPreview: true,
            maySubmit: false,
            mayDecide: false,
            mayApprove: false,
            mayApply: false,
            mayCancel: true,
          },
        },
        people: [],
        stagingRetention: "SOURCE_REQUIRED",
      };
    },
    stage: async (_ctx, input) => (await step("stage"), staged.push(input), BATCH),
    resolve: () => step("resolve"),
    preview: async () => (await step("preview"), { hash: HASH, clean: true, status: "STAGED", rows: [] }),
    submit: async () => (await step("submit"), "SUBMITTED"),
    decide: async () => (await step("decide"), "APPROVED"),
    apply: async () => (await step("apply"), { imported: 1, skipped: 1, kept: 0, already_imported: 0 }),
    cancel: () => step("cancel"),
    list: async () => (calls.push("list"), []),
    rows: async () => (calls.push("rows"), []),
  };
  const service = createBcpImportService({
    gateway,
    reader: {
      name: "stub-reader",
      read: () => {
        calls.push("read");
        if (opts.read === "throws") throw new Error("parser exploded on cell text");
        return opts.read ?? { ok: true, workbook: GOOD };
      },
    },
    scanner: {
      name: "stub-scanner",
      scan: async () => {
        calls.push("scan");
        if (opts.scan === "throws") throw new Error("scanner down");
        return opts.scan ?? { status: "CLEAN", scanner: "stub-scanner" };
      },
    },
    securityEvents: { record: async (e) => void events.push(e) },
  });
  return { service, calls, events, staged };
}

const refusal = (r: unknown) =>
  (r as { ok: boolean; error?: { kind: string; detail?: string } }).ok
    ? "OK"
    : `${(r as { error: { kind: string } }).error.kind}:${(r as { error: { detail?: string } }).error.detail}`;

describe("continuity workbook service: staging an upload", () => {
  it("scans, reads, checks and stages the workbook, hashing the file and counting rows the rules reject", async () => {
    const { service, calls, staged, events } = harness();
    const bytes = new TextEncoder().encode("abc");
    const r = await service.stage(ctx, importer, { caseId: CASE }, file(bytes));
    expect(r).toEqual({
      ok: true,
      value: {
        batchId: BATCH,
        sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        rows: 2,
        invalidRows: 1,
      },
    });
    expect(calls).toEqual(["scan", "read", "stage"]);
    expect(staged).toEqual([
      {
        control: {
          TEMPLATE_VERSION: "BCP-1",
          WORKBOOK_ID: "BCP-WB-1",
          CASE_ID: CASE.toUpperCase(),
          CASE_NUMBER: "CDF-DEMO-2026-0001",
          OFFLINE_FROM: "2026-10-01T08:00:00Z",
          PREPARED_BY: "lead@example.test",
        },
        fileSha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        rows: [
          expect.objectContaining({ sheet: "05_SUBJECTS", row_number: 3, has_formula: false }),
          expect.objectContaining({ sheet: "05_SUBJECTS", row_number: 4, has_formula: false }),
        ],
      },
    ]);
    expect(events).toEqual([]);
  });

  it("pre-checks the form and the permission before touching the file", async () => {
    const bad = harness();
    const r = await bad.service.stage(ctx, importer, { caseId: "CDF-DEMO-2026-0001" }, file());
    expect(r.ok === false && "fieldErrors" in r).toBe(true);
    const denied = harness();
    expect(refusal(await denied.service.stage(ctx, approver, { caseId: CASE }, file()))).toBe(
      "FORBIDDEN:undefined",
    );
    expect(denied.events.map((e) => [e.action, e.objectId, e.metadata])).toEqual([
      ["COMMAND_DENIED", CASE, { command: "stage_bcp_import", outcome: "FORBIDDEN" }],
    ]);
    expect([...bad.calls, ...denied.calls]).toEqual([]);
  });

  it("refuses the wrong type or size before scanning or reading", async () => {
    const { service, calls, events } = harness();
    const stage = (f: { name: string; bytes: Uint8Array }) =>
      service.stage(ctx, importer, { caseId: CASE }, f).then(refusal);
    expect(await stage(file(undefined, "outage.xlsm"))).toBe("INVALID:WORKBOOK_FILE_TYPE");
    expect(await stage(file(undefined, "outage.xls"))).toBe("INVALID:WORKBOOK_FILE_TYPE");
    expect(await stage(file(undefined, "outage.xlsx.exe"))).toBe("INVALID:WORKBOOK_FILE_TYPE");
    expect(await stage(file(new Uint8Array(), "outage.xlsx"))).toBe("INVALID:WORKBOOK_FILE_EMPTY");
    expect(await stage(file(new Uint8Array(BCP_MAX_WORKBOOK_BYTES + 1), "outage.xlsx"))).toBe(
      "INVALID:WORKBOOK_FILE_TOO_LARGE",
    );
    expect(calls).toEqual([]);
    // The events name the reason, never the file.
    expect(events.map((e) => [e.action, e.metadata!.reason])).toEqual([
      ["VALIDATION_REJECTED", "FILE_TYPE"],
      ["VALIDATION_REJECTED", "FILE_TYPE"],
      ["VALIDATION_REJECTED", "FILE_TYPE"],
      ["VALIDATION_REJECTED", "FILE_EMPTY"],
      ["VALIDATION_REJECTED", "FILE_TOO_LARGE"],
    ]);
    expect(JSON.stringify(events)).not.toContain("outage");
  });

  it("fails closed on the scan: an infected, unscanned or unscannable file is never read", async () => {
    for (const [scan, expected] of [
      [{ status: "INFECTED", scanner: "stub" }, "CONFLICT:MALWARE_DETECTED"],
      [{ status: "UNSCANNED", scanner: "stub" }, "CONFLICT:SCAN_UNAVAILABLE"],
      ["throws", "CONFLICT:SCAN_UNAVAILABLE"],
    ] as const) {
      const { service, calls } = harness({ scan });
      expect(refusal(await service.stage(ctx, importer, { caseId: CASE }, file()))).toBe(expected);
      expect(calls).toEqual(["scan"]);
    }
  });

  it("refuses what the reader or the template check refuses, with their codes and nothing of the content", async () => {
    const cases: [Parameters<typeof harness>[0], string][] = [
      [{ read: { ok: false, code: "DTD" } }, "INVALID:WORKBOOK_DTD"],
      [{ read: { ok: false, code: "RATIO_TOO_HIGH" } }, "INVALID:WORKBOOK_RATIO_TOO_HIGH"],
      [{ read: "throws" }, "INVALID:WORKBOOK_UNREADABLE"],
      [
        { read: { ok: true, workbook: { sheets: [...GOOD.sheets, { name: "Sheet1", rows: [] }] } } },
        "INVALID:WORKBOOK_UNEXPECTED_SHEET",
      ],
      [{ read: { ok: true, workbook: { sheets: [] } } }, "INVALID:WORKBOOK_MISSING_SHEET:00_README"],
      [{ read: { ok: true, workbook: workbook(CONTROL, []) } }, "INVALID:WORKBOOK_NO_ROWS"],
      [
        {
          read: {
            ok: true,
            workbook: workbook(
              [CONTROL[0]!, CONTROL[1]!, BATCH, ...CONTROL.slice(3)],
              [{ row: 3, cells: cells(subject("EMPLOYEE")) }],
            ),
          },
        },
        "INVALID:WORKBOOK_CASE_MISMATCH",
      ],
    ];
    for (const [opts, expected] of cases) {
      const { service, calls, events } = harness(opts);
      expect(refusal(await service.stage(ctx, importer, { caseId: CASE }, file())), expected).toBe(expected);
      expect(calls).toEqual(["scan", "read"]);
      expect(events.map((e) => e.metadata)).toEqual([
        { command: "stage_bcp_import", reason: expected.replace("INVALID:WORKBOOK_", "") },
      ]);
      expect(JSON.stringify(events)).not.toMatch(/exploded|Omega/);
    }
  });

  it("validates the control row with the shared schema before staging", async () => {
    const { service, calls } = harness({
      read: {
        ok: true,
        workbook: workbook(
          [...CONTROL.slice(0, 4), "1 October 2026", "", "lead@example.test"],
          [{ row: 3, cells: cells(subject("EMPLOYEE")) }],
        ),
      },
    });
    const r = await service.stage(ctx, importer, { caseId: CASE }, file());
    expect(r.ok === false && "fieldErrors" in r && r.fieldErrors.issues.map((i) => i.path.join("."))).toEqual(
      ["control.OFFLINE_FROM"],
    );
    expect(calls).toEqual(["scan", "read"]);
  });

  it("records the database's NOT_FOUND as a refusal and maps it to a safe error", async () => {
    const { service, events } = harness({ refusal: "CDF_NOT_FOUND" });
    expect(refusal(await service.stage(ctx, importer, { caseId: CASE }, file()))).toBe("NOT_FOUND:undefined");
    expect(events.map((e) => e.metadata)).toEqual([{ command: "stage_bcp_import", outcome: "NOT_FOUND" }]);
  });
});

describe("continuity workbook service: the batch's page (P12-6b-1)", () => {
  it("reads the batch, and a refused read is the uniform not-found recorded as ACCESS_DENIED", async () => {
    const ok = harness();
    expect((await ok.service.view(ctx, BATCH))?.view.batchId).toBe(BATCH);
    expect(ok.events).toEqual([]);
    for (const refusal of ["CDF_NOT_FOUND", "CDF_FORBIDDEN"]) {
      const { service, events } = harness({ refusal });
      expect(await service.view(ctx, BATCH)).toBeNull();
      expect(events).toEqual([
        {
          action: "ACCESS_DENIED",
          objectType: "bcp_import_batch",
          objectId: BATCH,
          metadata: { read: "bcp_import_batch_view" },
        },
      ]);
    }
    const down = harness({ refusal: "connection reset" });
    await expect(down.service.view(ctx, BATCH)).rejects.toMatchObject({ kind: "UNAVAILABLE" });
    expect(down.events).toEqual([]);
  });
});

describe("continuity workbook service: the batch commands", () => {
  it("validates before the gateway: reasons, resolutions and hashes", async () => {
    const { service, calls } = harness();
    expect((await service.resolve(ctx, importer, { rowId: ROW, resolution: "SKIP", reason: "no" })).ok).toBe(
      false,
    );
    expect(
      (await service.resolve(ctx, importer, { rowId: ROW, resolution: "OVERWRITE", reason: "Synthetic." }))
        .ok,
    ).toBe(false);
    expect((await service.submit(ctx, importer, { batchId: BATCH, previewHash: "abc" })).ok).toBe(false);
    expect(
      (
        await service.decide(ctx, approver, {
          batchId: BATCH,
          decision: "MAYBE",
          reason: "Synthetic.",
          previewHash: HASH,
        })
      ).ok,
    ).toBe(false);
    expect((await service.cancel(ctx, importer, { batchId: BATCH, reason: "" })).ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("lets the importer run the import and an approver decide it, and nobody the other's step", async () => {
    const { service, calls, events } = harness();
    expect(
      (
        await service.decide(ctx, importer, {
          batchId: BATCH,
          decision: "APPROVE",
          reason: "Synthetic: matches the paper file.",
          previewHash: HASH,
        })
      ).ok,
    ).toBe(false);
    expect((await service.apply(ctx, approver, { batchId: BATCH, previewHash: HASH })).ok).toBe(false);
    expect((await service.preview(ctx, approver, { batchId: BATCH })).ok).toBe(false);
    expect(events.map((e) => [e.objectId, e.metadata])).toEqual([
      [BATCH, { command: "decide_bcp_import", outcome: "FORBIDDEN" }],
      [BATCH, { command: "apply_bcp_import", outcome: "FORBIDDEN" }],
      [BATCH, { command: "preview_bcp_import", outcome: "FORBIDDEN" }],
    ]);
    expect(calls).toEqual([]);
    expect(
      await service.resolve(ctx, importer, {
        rowId: ROW,
        resolution: "SKIP",
        reason: "Synthetic: re-entered.",
      }),
    ).toEqual({ ok: true, value: undefined });
    expect((await service.preview(ctx, importer, { batchId: BATCH })).ok).toBe(true);
    expect(await service.submit(ctx, importer, { batchId: BATCH, previewHash: HASH })).toEqual({
      ok: true,
      value: "SUBMITTED",
    });
    expect(
      await service.decide(ctx, approver, {
        batchId: BATCH,
        decision: "APPROVE",
        reason: "Synthetic: matches the paper file.",
        previewHash: HASH,
      }),
    ).toEqual({ ok: true, value: "APPROVED" });
    expect(await service.apply(ctx, importer, { batchId: BATCH, previewHash: HASH })).toEqual({
      ok: true,
      value: { imported: 1, skipped: 1, kept: 0, already_imported: 0 },
    });
    expect(calls).toEqual(["resolve", "preview", "submit", "decide", "apply"]);
  });

  it("maps the database's answers to safe errors and records only refusals", async () => {
    const forbidden = harness({ refusal: "CDF_FORBIDDEN" });
    expect(
      refusal(
        await forbidden.service.decide(ctx, approver, {
          batchId: BATCH,
          decision: "APPROVE",
          reason: "Synthetic: I recorded a row myself.",
          previewHash: HASH,
        }),
      ),
    ).toBe("FORBIDDEN:undefined");
    expect(forbidden.events.map((e) => e.metadata)).toEqual([
      { command: "decide_bcp_import", outcome: "FORBIDDEN" },
    ]);
    const changed = harness({ refusal: "CDF_CONFLICT:PREVIEW_CHANGED" });
    expect(refusal(await changed.service.apply(ctx, importer, { batchId: BATCH, previewHash: HASH }))).toBe(
      "CONFLICT:PREVIEW_CHANGED",
    );
    expect(changed.events).toEqual([]);
    const broken = harness({ refusal: 'relation "exchange.bcp_import_row" does not exist' });
    expect(
      refusal(
        await broken.service.cancel(ctx, importer, { batchId: BATCH, reason: "Synthetic: wrong file." }),
      ),
    ).toBe("UNAVAILABLE:undefined");
  });

  it("says a row stopped the import with one code, however long its key and its command's code (P12-6b-1)", async () => {
    for (const message of [
      "CDF_CONFLICT:BCP_ROW_FAILED:BCP-D1:CDF_CONFLICT:NOTICE_NOT_OPEN",
      // Longer than an error's detail may be: it would otherwise read as the service being unavailable.
      `CDF_CONFLICT:BCP_ROW_FAILED:BCP-${"A".repeat(60)}:CDF_INVALID:${"x".repeat(90)}`,
    ]) {
      const failed = harness({ refusal: message });
      const result = await failed.service.apply(ctx, importer, { batchId: BATCH, previewHash: HASH });
      expect(refusal(result)).toBe("CONFLICT:BCP_ROW_FAILED");
      // Neither the row's key nor its command's code reaches the page; a conflict is not recorded as a denial.
      expect(JSON.stringify(result)).not.toContain("BCP-D1");
      expect(failed.events).toEqual([]);
    }
    // Only the import's own row failure is renamed; every other refusal keeps its code.
    const other = harness({ refusal: "CDF_CONFLICT:NOT_APPROVED" });
    expect(refusal(await other.service.apply(ctx, importer, { batchId: BATCH, previewHash: HASH }))).toBe(
      "CONFLICT:NOT_APPROVED",
    );
  });
});
