// ADR-034 D1 and ADR-047: each committed continuity template (BCP-1 for a case, BCP-C1 for a committee proceeding) is
// exactly what the generator writes, and it reads back as its template.
// Regenerate with: CDF_WRITE_BCP_TEMPLATE=1 pnpm vitest run --project unit apps/investigation-web/src/server/bcp-template.test.ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BCP_TEMPLATE_VERSIONS, BCP_TEMPLATES } from "@cdf/contracts";
import { readWorkbook } from "@cdf/infrastructure";
import { bcpTemplateBytes, bcpTemplateText } from "./bcp-template";

describe.each(BCP_TEMPLATE_VERSIONS)("%s template (ADR-034 D1, ADR-047)", (version) => {
  const committed = fileURLToPath(
    new URL(`../../../../infrastructure/bcp/${version}_template.xlsx`, import.meta.url),
  );
  const template = BCP_TEMPLATES[version];

  it("is deterministic and equals the committed file", () => {
    const bytes = bcpTemplateBytes(version);
    expect(Buffer.from(bcpTemplateBytes(version)).equals(Buffer.from(bytes))).toBe(true);
    if (process.env.CDF_WRITE_BCP_TEMPLATE === "1") writeFileSync(committed, bytes);
    expect(existsSync(committed)).toBe(true);
    expect(Buffer.from(readFileSync(committed)).equals(Buffer.from(bytes))).toBe(true);
  });

  it("reads back with every sheet, column code and bilingual label in template order", () => {
    const read = readWorkbook(bcpTemplateBytes(version));
    if (!read.ok) throw new Error(read.code);
    expect(read.workbook.sheets.map((s) => s.name)).toEqual(template.map((s) => s.code));
    const text = bcpTemplateText(version);
    for (const sheet of template) {
      const rows = read.workbook.sheets.find((s) => s.name === sheet.code)!.rows;
      if (sheet.kind === "README") {
        expect(rows[0]!.cells[0]!.value).toBe(version);
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
    const text = bcpTemplateText(version);
    for (const code of new Set(template.flatMap((s) => s.columns.map((c) => c.code)))) {
      expect(text.label(code).split(" / "), code).toHaveLength(2);
    }
  });
});

it("the committee template's README is its own, not the case workbook's", () => {
  expect(bcpTemplateText("BCP-C1").readme[0]).toContain("BCP-C1");
  expect(bcpTemplateText("BCP-1").readme[0]).toContain("BCP-1");
});
