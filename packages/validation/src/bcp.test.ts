// Continuity workbook schemas (ADR-034 D4, §45). The column rules themselves are checked against the database's
// exchange.bcp_cell_ok and exchange.bcp_normalize in tests/security/bcp-import.spec.ts; here, the command schemas.
import { describe, expect, it } from "vitest";
import { BCP_MAX_ROWS } from "@cdf/contracts";
import {
  bcpRowProblem,
  bcpTemplateVersion,
  bcpUploadSchema,
  decideBcpImportSchema,
  resolveBcpRowSchema,
  stageBcpImportSchema,
  submitBcpImportSchema,
} from "./bcp";

const CONTROL = {
  TEMPLATE_VERSION: "bcp-1",
  WORKBOOK_ID: "BCP-WB-1",
  CASE_ID: "00000000-0000-4000-8000-000000000001",
  CASE_NUMBER: "CDF-DEMO-2026-0001",
  OFFLINE_FROM: "2026-10-01T08:00:00Z",
  PREPARED_BY: "Lead@Example.test",
};
const SUBJECT = {
  ROW_ID: "BCP-S1",
  ORIGINAL_EVENT_AT: "2026-10-01T09:30:00+03:00",
  RECORDED_OFFLINE_BY: "lead@example.test",
  DISPLAY_LABEL: "Employee Omega (synthetic)",
  SUBJECT_CATEGORY: "EMPLOYEE",
};
const row = (n: number, cells: Record<string, string> = SUBJECT, sheet = "05_SUBJECTS") => ({
  sheet,
  row_number: n,
  cells,
  has_formula: false,
});
const stage = (input: Record<string, unknown>) =>
  stageBcpImportSchema.safeParse({ control: CONTROL, fileSha256: "a".repeat(64), rows: [row(3)], ...input });
const paths = (r: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) =>
  r.success ? [] : r.error!.issues.map((i) => i.path.join("."));

describe("continuity workbook schemas", () => {
  it("accepts a control row the database accepts, normalising as it does", () => {
    expect(stage({}).success).toBe(true);
    expect(paths(stage({ control: { ...CONTROL, OFFLINE_FROM: "2026-10-01" } }))).toEqual([
      "control.OFFLINE_FROM",
    ]);
    expect(paths(stage({ control: { ...CONTROL, CASE_ID: "CDF-DEMO-2026-0001" } }))).toEqual([
      "control.CASE_ID",
    ]);
    expect(paths(stage({ control: { ...CONTROL, TEMPLATE_VERSION: "1" } }))).toEqual([
      "control.TEMPLATE_VERSION",
    ]);
    expect(paths(stage({ control: { ...CONTROL, EXTRA: "x" } }))).toEqual(["control.EXTRA"]);
    const { PREPARED_BY: _, ...missing } = CONTROL;
    expect(paths(stage({ control: missing }))).toEqual(["control.PREPARED_BY"]);
  });

  it("stages a row that breaks a column rule (the database marks it INVALID) but not one with unknown cells", () => {
    const broken = row(3, { ...SUBJECT, SUBJECT_CATEGORY: "BOSS" });
    expect(stage({ rows: [broken] }).success).toBe(true);
    expect(bcpRowProblem(broken.sheet, broken.cells, false)).toBe("SUBJECT_CATEGORY");
    expect(bcpRowProblem("05_SUBJECTS", SUBJECT, false)).toBeNull();
    expect(bcpRowProblem("05_SUBJECTS", SUBJECT, true)).toBe("FORMULA");
    expect(bcpRowProblem("01_CONTROL", CONTROL, false)).toBe("SHEET");
    expect(paths(stage({ rows: [row(3, { ...SUBJECT, NOTES: "x" })] }))).toEqual(["rows.0.cells"]);
    expect(paths(stage({ rows: [row(3, SUBJECT, "01_CONTROL")] }))).toEqual(["rows.0.sheet"]);
    expect(paths(stage({ rows: [row(2)] }))).toEqual(["rows.0.row_number"]);
    expect(paths(stage({ rows: [{ ...row(3), extra: true }] }))).toEqual(["rows.0"]);
  });

  it("bounds the batch: at least one row, at most the staging limit, each sheet row once", () => {
    expect(paths(stage({ rows: [] }))).toEqual(["rows"]);
    expect(stage({ rows: Array.from({ length: BCP_MAX_ROWS }, (_, i) => row(3 + i)) }).success).toBe(true);
    expect(paths(stage({ rows: Array.from({ length: BCP_MAX_ROWS + 1 }, (_, i) => row(3 + i)) }))).toEqual([
      "rows",
    ]);
    expect(paths(stage({ rows: [row(3), row(3)] }))).toEqual(["rows"]);
    expect(stage({ rows: [row(3), row(3, SUBJECT, "02_CASE_MASTER")] }).success).toBe(false);
    expect(paths(stage({ fileSha256: "A".repeat(64) }))).toEqual(["fileSha256"]);
  });

  it("needs reasons, known resolutions and decisions, and hashes on the batch commands", () => {
    const id = "44444444-4444-4444-8444-444444444444";
    const hash = "b".repeat(64);
    expect(bcpUploadSchema.safeParse({ caseId: id }).success).toBe(true);
    expect(bcpUploadSchema.safeParse({ caseId: "CDF-DEMO-2026-0001" }).success).toBe(false);
    expect(resolveBcpRowSchema.safeParse({ rowId: id, resolution: "SKIP", reason: "  ok  " }).success).toBe(
      false,
    );
    expect(
      resolveBcpRowSchema.safeParse({ rowId: id, resolution: "OVERWRITE", reason: "Synthetic." }).success,
    ).toBe(false);
    expect(
      resolveBcpRowSchema.safeParse({ rowId: id, resolution: "KEEP_PLATFORM", reason: "Synthetic." }).success,
    ).toBe(true);
    expect(submitBcpImportSchema.safeParse({ batchId: id, previewHash: hash.slice(1) }).success).toBe(false);
    expect(
      decideBcpImportSchema.safeParse({
        batchId: id,
        decision: "REJECT",
        reason: "Synthetic.",
        previewHash: hash,
      }).success,
    ).toBe(true);
    expect(
      decideBcpImportSchema.safeParse({
        batchId: id,
        decision: "MAYBE",
        reason: "Synthetic.",
        previewHash: hash,
      }).success,
    ).toBe(false);
  });
});

describe("the committee workbook BCP-C1 (migration 2110, ADR-047)", () => {
  const C_CONTROL = {
    TEMPLATE_VERSION: "bcp-c1",
    WORKBOOK_ID: "BCP-WB-C1",
    COMMITTEE_PROCEEDING_ID: "00000000-0000-4000-8000-0000000000C1",
    COMMITTEE_CODE: "IC",
    OFFLINE_FROM: "2026-10-01T08:00:00Z",
    OFFLINE_TO: "2026-10-02T08:00:00Z",
    PREPARED_BY: "secretary@example.test",
  };
  const MEETING = {
    ROW_ID: "BCP-M1",
    ORIGINAL_EVENT_AT: "2026-10-01T10:00:00Z",
    RECORDED_OFFLINE_BY: "secretary@example.test",
    PURPOSE: "DELIBERATION",
    MODE: "IN_PERSON",
    LOCATION: "Room 1 (synthetic)",
    HELD_START: "2026-10-01T10:00:00Z",
    HELD_END: "2026-10-01T11:00:00Z",
    PAPER_MINUTES_REFERENCE: "PAPER-MIN-1",
    REASON: "Synthetic: held during the outage.",
  };
  const cStage = (input: Record<string, unknown>) =>
    stageBcpImportSchema.safeParse({
      control: C_CONTROL,
      fileSha256: "a".repeat(64),
      rows: [row(3, MEETING, "09_MEETINGS")],
      ...input,
    });

  it("checks the control row and the rows against the template the control row names", () => {
    expect(bcpTemplateVersion(" bcp-c1 ")).toBe("BCP-C1");
    expect(bcpTemplateVersion("BCP-C2")).toBeNull();
    expect(cStage({}).success).toBe(true);
    // OFFLINE_TO is required for a committee workbook: the window is closed.
    const { OFFLINE_TO: _, ...open } = C_CONTROL;
    expect(paths(cStage({ control: open }))).toEqual(["control.OFFLINE_TO"]);
    // A case column in a committee control row, and the reverse, are unknown keys.
    expect(paths(cStage({ control: { ...C_CONTROL, CASE_ID: CONTROL.CASE_ID } }))).toEqual([
      "control.CASE_ID",
    ]);
    expect(paths(stage({ control: { ...CONTROL, COMMITTEE_CODE: "IC" } }))).toEqual([
      "control.COMMITTEE_CODE",
    ]);
    expect(paths(cStage({ control: { ...C_CONTROL, TEMPLATE_VERSION: "BCP-C2" } }))).toEqual([
      "control.TEMPLATE_VERSION",
    ]);
    // A case sheet in a committee workbook, and a committee sheet's cells in a case workbook, are refused.
    expect(paths(cStage({ rows: [row(3)] }))).toEqual(["rows.0.sheet"]);
    expect(paths(stage({ rows: [row(3, MEETING, "09_MEETINGS")] }))).toEqual(["rows.0.cells"]);
  });

  it("classifies a committee row as the database will", () => {
    expect(bcpRowProblem("09_MEETINGS", MEETING, false, "BCP-C1")).toBeNull();
    expect(bcpRowProblem("09_MEETINGS", { ...MEETING, MODE: "PHONE" }, false, "BCP-C1")).toBe("MODE");
    expect(bcpRowProblem("09_MEETINGS", { ...MEETING, PAPER_MINUTES_REFERENCE: "x" }, false, "BCP-C1")).toBe(
      "PAPER_MINUTES_REFERENCE",
    );
    expect(
      bcpRowProblem(
        "11_CONFLICTS",
        {
          ROW_ID: "BCP-K1",
          ORIGINAL_EVENT_AT: "2026-10-01T10:30:00Z",
          RECORDED_OFFLINE_BY: "secretary@example.test",
          MEETING_REF: "BCP-M1",
          PARTICIPANT: "member@example.test",
          REASON: "Synthetic: noted on paper.",
        },
        false,
        "BCP-C1",
      ),
    ).toBeNull();
    expect(bcpRowProblem("05_SUBJECTS", SUBJECT, false, "BCP-C1")).toBe("SHEET");
    // The same sheet code reads by its own template's columns.
    expect(bcpRowProblem("09_MEETINGS", MEETING, false)).toBe("DETAILS");
  });
});
