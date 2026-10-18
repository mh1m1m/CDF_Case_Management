// The empty continuity workbooks, generated from the template definitions in @cdf/contracts: BCP-1 for a case
// (ADR-034 D1) and BCP-C1 for a committee proceeding (migration 2110, ADR-047). Row 1 of every sheet holds the column
// codes the importer matches, row 2 their labels; data starts on row 3.
import { BCP_TEMPLATE_VERSION, BCP_TEMPLATES, type BcpSheet, type BcpTemplateVersion } from "@cdf/contracts";
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

/** The template's sheets, in template order (BCP-1 unless another is named). */
export function bcpTemplateSheets(
  text: BcpTemplateText,
  version: BcpTemplateVersion = BCP_TEMPLATE_VERSION,
): WrittenSheet[] {
  return BCP_TEMPLATES[version].map((sheet) =>
    sheet.kind === "README"
      ? {
          name: sheet.code,
          rows: [[`${version}`], ...text.readme.map((line) => [line])],
          columnWidth: 120,
          boldRows: [1],
        }
      : dataSheet(sheet, text),
  );
}

/** The template workbook's bytes. Deterministic: the committed file is checked against this output. */
export function buildBcpTemplate(
  text: BcpTemplateText,
  version: BcpTemplateVersion = BCP_TEMPLATE_VERSION,
): Uint8Array {
  return writeWorkbook(bcpTemplateSheets(text, version));
}
