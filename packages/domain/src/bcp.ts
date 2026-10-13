// Continuity workbook (ADR-034 D1, D4): checks that a workbook the reader returned is the BCP-1 template, and turns
// its control row and data rows into what api.stage_bcp_import takes. Pure: no I/O, no column rules (the database
// stages a row that breaks one as INVALID, naming the column).
import {
  BCP_FIRST_DATA_ROW,
  BCP_MAX_ROWS,
  BCP_TEMPLATE,
  BCP_TEMPLATE_VERSION,
  type BcpStagedRowInput,
  type BcpWorkbook,
  type BcpWorkbookRow,
} from "@cdf/contracts";

export type BcpWorkbookContent =
  { ok: true; control: Record<string, string>; rows: BcpStagedRowInput[] } | { ok: false; code: string };

const fail = (code: string): BcpWorkbookContent => ({ ok: false, code });

/** Row 1 holds exactly the sheet's column codes, from column A, and nothing computed. */
function headerMatches(header: BcpWorkbookRow | undefined, codes: readonly string[]): boolean {
  if (!header || header.row !== 1 || header.cells.length !== codes.length) return false;
  return header.cells.every((c, i) => c.column === i + 1 && !c.formula && c.value.trim() === codes[i]);
}

/** A data row as cells keyed by column code; null when a cell sits outside the sheet's columns. */
function cellsOf(row: BcpWorkbookRow, codes: readonly string[]): Record<string, string> | null {
  const cells: Record<string, string> = {};
  for (const cell of row.cells) {
    const code = codes[cell.column - 1];
    if (code === undefined) return null;
    if (cell.value.trim() !== "") cells[code] = cell.value;
  }
  return cells;
}

export function readBcpWorkbook(workbook: BcpWorkbook): BcpWorkbookContent {
  const byName = new Map(workbook.sheets.map((s) => [s.name, s]));
  for (const sheet of workbook.sheets) {
    if (!BCP_TEMPLATE.some((t) => t.code === sheet.name)) return fail("UNEXPECTED_SHEET");
  }
  const control: Record<string, string> = {};
  const rows: BcpStagedRowInput[] = [];
  for (const template of BCP_TEMPLATE) {
    const sheet = byName.get(template.code);
    if (!sheet) return fail(`MISSING_SHEET:${template.code}`);
    if (template.kind === "README" || template.kind === "PLATFORM_LOG") continue;
    const codes = template.columns.map((c) => c.code);
    if (!headerMatches(sheet.rows[0], codes)) return fail(`HEADER:${template.code}`);
    const data = sheet.rows.filter((r) => r.row >= BCP_FIRST_DATA_ROW);
    if (template.kind === "CONTROL") {
      if (data.length !== 1 || data[0]!.row !== BCP_FIRST_DATA_ROW) return fail("CONTROL_ROW");
      if (data[0]!.cells.some((c) => c.formula)) return fail("CONTROL_FORMULA");
      const cells = cellsOf(data[0]!, codes);
      if (!cells) return fail(`EXTRA_CELLS:${template.code}`);
      Object.assign(control, cells);
      continue;
    }
    for (const row of data) {
      const cells = cellsOf(row, codes);
      if (!cells) return fail(`EXTRA_CELLS:${template.code}`);
      if (Object.keys(cells).length === 0 && !row.cells.some((c) => c.formula)) continue;
      rows.push({
        sheet: template.code,
        row_number: row.row,
        cells,
        has_formula: row.cells.some((c) => c.formula),
      });
      if (rows.length > BCP_MAX_ROWS) return fail("TOO_MANY_ROWS");
    }
  }
  if (control.TEMPLATE_VERSION?.trim().toUpperCase() !== BCP_TEMPLATE_VERSION)
    return fail("TEMPLATE_VERSION");
  if (rows.length === 0) return fail("NO_ROWS");
  return { ok: true, control, rows };
}
