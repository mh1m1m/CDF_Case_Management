// The empty BCP-1 continuity workbook (ADR-034 D1), generated from the template definition in @cdf/contracts. Row 1
// of every sheet holds the column codes the importer matches, row 2 their labels; data starts on row 3.
import { BCP_TEMPLATE, BCP_TEMPLATE_VERSION, type BcpSheet } from "@cdf/contracts";
import { writeWorkbook, type WrittenSheet } from "./workbook-writer";

export interface BcpTemplateText {
  /** The label written under a column code (row 2). */
  label(columnCode: string): string;
  /** The lines of the 00_README sheet. */
  readme: readonly string[];
}

function dataSheet(sheet: BcpSheet, text: BcpTemplateText): WrittenSheet {
  return {
    name: sheet.code,
    rows: [sheet.columns.map((c) => c.code), sheet.columns.map((c) => text.label(c.code))],
    frozenRows: 2,
    boldRows: [1],
  };
}

/** The template's sheets, in template order. */
export function bcpTemplateSheets(text: BcpTemplateText): WrittenSheet[] {
  return BCP_TEMPLATE.map((sheet) =>
    sheet.kind === "README"
      ? {
          name: sheet.code,
          rows: [[`${BCP_TEMPLATE_VERSION}`], ...text.readme.map((line) => [line])],
          columnWidth: 120,
          boldRows: [1],
        }
      : dataSheet(sheet, text),
  );
}

/** The template workbook's bytes. Deterministic: the committed file is checked against this output. */
export function buildBcpTemplate(text: BcpTemplateText): Uint8Array {
  return writeWorkbook(bcpTemplateSheets(text));
}
