// Continuity workbook import (ADR-034, migration 1960). The column rules mirror exchange.bcp_normalize and
// exchange.bcp_cell_ok, so the application classifies a row as the database will (§45); the database re-checks
// everything and decides. Error messages are i18n keys, never prose.
import { z } from "zod";
import {
  BCP_IMPORT_DECISIONS,
  BCP_MAX_CELL_LENGTH,
  BCP_MAX_ROWS,
  BCP_RESOLUTIONS,
  BCP_TEMPLATE,
  type BcpColumn,
  type BcpColumnKind,
  type BcpSheet,
} from "@cdf/contracts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BCP_KEY = /^BCP-[A-Z0-9][A-Z0-9-]{0,59}$/;
const DATETIME =
  /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2})(?::([0-9]{2})(\.[0-9]{1,6})?)?(Z|[+-]([0-9]{2}):([0-9]{2}))$/;
const DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
const EMAIL = /^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,189}$/;
const CODE = /^[A-Z_]{3,40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** Trims a cell; empty becomes null. UUIDs and emails are lower-cased, `BCP-` keys and versions upper-cased. */
export function bcpNormalize(kind: BcpColumnKind, value: string | null | undefined): string | null {
  const v = (value ?? "").trim();
  if (v === "") return null;
  if (kind === "UUID" || kind === "EMAIL") return v.toLowerCase();
  if ((kind === "ROW_KEY" || kind === "REF") && UUID.test(v.toLowerCase())) return v.toLowerCase();
  if ((kind === "ROW_KEY" || kind === "REF" || kind === "VERSION") && v.toUpperCase().startsWith("BCP-")) {
    return v.toUpperCase();
  }
  return v;
}

const daysIn = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

function validDate(year: number, month: number, day: number): boolean {
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysIn(year, month);
}

/** The calendar and clock checks PostgreSQL applies when the text is cast. */
function validDateTime(m: RegExpExecArray): boolean {
  const [year, month, day, hour, minute] = [1, 2, 3, 4, 5].map((i) => Number(m[i]));
  const second = m[6] === undefined ? 0 : Number(m[6]);
  const fraction = m[7] === undefined ? 0 : Number(m[7]);
  if (!validDate(year!, month!, day!) || minute! > 59 || second > 60) return false;
  if (hour! > 24 || (hour === 24 && (minute !== 0 || second !== 0 || fraction !== 0))) return false;
  if (m[8] !== "Z" && (Number(m[9]) > 15 || Number(m[10]) > 59)) return false;
  return true;
}

/** Whether one normalized cell meets its column's rule (exchange.bcp_cell_ok). */
export function bcpCellOk(column: BcpColumn, value: string | null): boolean {
  if (value === null) return !column.required;
  if (value.length > column.maxLength) return false;
  switch (column.kind) {
    case "VERSION":
      return /^BCP-[0-9]{1,3}$/.test(value);
    case "ROW_KEY":
    case "REF":
      return BCP_KEY.test(value) || UUID.test(value);
    case "UUID":
      return UUID.test(value);
    case "DATETIME": {
      const m = DATETIME.exec(value);
      return m !== null && validDateTime(m);
    }
    case "DATE": {
      const m = DATE.exec(value);
      return m !== null && validDate(Number(m[1]), Number(m[2]), Number(m[3]));
    }
    case "EMAIL":
      return EMAIL.test(value);
    case "ENUM":
      return (column.allowed ?? []).includes(value);
    case "CODE":
      return CODE.test(value);
    case "TEXT":
      return value.length >= (column.minLength ?? 0);
  }
}

const SHEETS = new Map(BCP_TEMPLATE.map((s) => [s.code, s]));
const DATA_SHEETS = BCP_TEMPLATE.filter((s) => s.kind === "DATA").map((s) => s.code);

export function bcpSheet(code: string): BcpSheet | undefined {
  return SHEETS.get(code);
}

/** The first column a row breaks, in template order (or FORMULA), as the database will record it; null if none. */
export function bcpRowProblem(
  sheetCode: string,
  cells: Record<string, string>,
  hasFormula: boolean,
): string | null {
  if (hasFormula) return "FORMULA";
  const sheet = SHEETS.get(sheetCode);
  if (!sheet || sheet.kind !== "DATA") return "SHEET";
  for (const column of sheet.columns) {
    if (!bcpCellOk(column, bcpNormalize(column.kind, cells[column.code]))) return column.code;
  }
  return null;
}

const uuid = z.uuid({ message: "validation.invalid" });
const sha256 = z.string().regex(SHA256, { message: "validation.invalid" });
const reason = (max: number) =>
  z.string().trim().min(5, { message: "validation.tooShort" }).max(max, { message: "validation.tooLong" });

const CONTROL = SHEETS.get("01_CONTROL")!;

/** The control sheet: every key a 01_CONTROL column, every value meeting its rule. */
export const bcpControlSchema = z
  .record(z.string(), z.string().max(BCP_MAX_CELL_LENGTH, { message: "validation.tooLong" }))
  .superRefine((control, ctx) => {
    for (const key of Object.keys(control)) {
      if (!CONTROL.columns.some((c) => c.code === key)) {
        ctx.addIssue({ code: "custom", path: [key], message: "validation.invalid" });
      }
    }
    for (const column of CONTROL.columns) {
      if (!bcpCellOk(column, bcpNormalize(column.kind, control[column.code]))) {
        ctx.addIssue({ code: "custom", path: [column.code], message: "validation.invalid" });
      }
    }
  });

/** One staged row as the reader found it. Column rules are not enforced here: a broken row is staged as INVALID. */
export const bcpStagedRowSchema = z
  .object({
    sheet: z.enum(DATA_SHEETS as [string, ...string[]], { message: "validation.invalid" }),
    row_number: z.number().int().min(3).max(1048576),
    cells: z.record(z.string(), z.string().max(BCP_MAX_CELL_LENGTH, { message: "validation.tooLong" })),
    has_formula: z.boolean(),
  })
  .strict()
  .refine((r) => Object.keys(r.cells).every((k) => SHEETS.get(r.sheet)!.columns.some((c) => c.code === k)), {
    message: "validation.invalid",
    path: ["cells"],
  });

export const stageBcpImportSchema = z
  .object({
    control: bcpControlSchema,
    fileSha256: sha256,
    rows: z
      .array(bcpStagedRowSchema)
      .min(1, { message: "validation.required" })
      .max(BCP_MAX_ROWS, { message: "validation.tooLong" }),
  })
  .refine((i) => new Set(i.rows.map((r) => `${r.sheet}:${r.row_number}`)).size === i.rows.length, {
    message: "validation.invalid",
    path: ["rows"],
  });

export const resolveBcpRowSchema = z.object({
  rowId: uuid,
  resolution: z.enum(BCP_RESOLUTIONS, { message: "validation.invalid" }),
  reason: reason(1000),
});

export const bcpBatchSchema = z.object({ batchId: uuid });

export const submitBcpImportSchema = z.object({ batchId: uuid, previewHash: sha256 });

export const decideBcpImportSchema = z.object({
  batchId: uuid,
  decision: z.enum(BCP_IMPORT_DECISIONS, { message: "validation.invalid" }),
  reason: reason(2000),
  previewHash: sha256,
});

export const applyBcpImportSchema = z.object({ batchId: uuid, previewHash: sha256 });

export const cancelBcpImportSchema = z.object({ batchId: uuid, reason: reason(2000) });

/** The upload form: the case page it is made from. The workbook's control row must name the same case. */
export const bcpUploadSchema = z.object({ caseId: uuid });
