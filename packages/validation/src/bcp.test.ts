// Continuity workbook schemas (ADR-034 D4, §45). The column rules themselves are checked against the database's
// exchange.bcp_cell_ok and exchange.bcp_normalize in tests/security/bcp-import.spec.ts; here, the command schemas.
import { describe, expect, it } from "vitest";
import { BCP_MAX_ROWS } from "@cdf/contracts";
import {
  bcpRowProblem,
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
