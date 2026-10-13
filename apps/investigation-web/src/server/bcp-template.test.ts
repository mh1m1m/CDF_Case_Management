// ADR-034 D1: the committed BCP-1 template is exactly what the generator writes, and it reads back as the template.
// Regenerate with: CDF_WRITE_BCP_TEMPLATE=1 pnpm vitest run --project unit apps/investigation-web/src/server/bcp-template.test.ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BCP_TEMPLATE, BCP_TEMPLATE_VERSION } from "@cdf/contracts";
import { readWorkbook } from "@cdf/infrastructure";
import { bcpTemplateBytes, bcpTemplateText } from "./bcp-template";

const COMMITTED = fileURLToPath(
  new URL("../../../../infrastructure/bcp/BCP-1_template.xlsx", import.meta.url),
);

describe("BCP-1 template (ADR-034 D1)", () => {
  it("is deterministic and equals the committed file", () => {
    const bytes = bcpTemplateBytes();
    expect(Buffer.from(bcpTemplateBytes()).equals(Buffer.from(bytes))).toBe(true);
    if (process.env.CDF_WRITE_BCP_TEMPLATE === "1") writeFileSync(COMMITTED, bytes);
    expect(existsSync(COMMITTED)).toBe(true);
    expect(Buffer.from(readFileSync(COMMITTED)).equals(Buffer.from(bytes))).toBe(true);
  });

  it("reads back with every sheet, column code and bilingual label in template order", () => {
    const read = readWorkbook(bcpTemplateBytes());
    if (!read.ok) throw new Error(read.code);
    expect(read.workbook.sheets.map((s) => s.name)).toEqual(BCP_TEMPLATE.map((s) => s.code));
    const text = bcpTemplateText();
    for (const sheet of BCP_TEMPLATE) {
      const rows = read.workbook.sheets.find((s) => s.name === sheet.code)!.rows;
      if (sheet.kind === "README") {
        expect(rows[0]!.cells[0]!.value).toBe(BCP_TEMPLATE_VERSION);
        expect(rows.length).toBeGreaterThan(8);
        continue;
      }
      expect(rows.map((r) => r.row)).toEqual([1, 2]);
      expect(rows[0]!.cells.map((c) => c.value)).toEqual(sheet.columns.map((c) => c.code));
      expect(rows[1]!.cells.map((c) => c.value)).toEqual(sheet.columns.map((c) => text.label(c.code)));
      expect(rows.flatMap((r) => r.cells).some((c) => c.formula)).toBe(false);
    }
  });

  it("labels every column in both languages", () => {
    const text = bcpTemplateText();
    for (const code of new Set(BCP_TEMPLATE.flatMap((s) => s.columns.map((c) => c.code)))) {
      expect(text.label(code).split(" / "), code).toHaveLength(2);
    }
  });
});
