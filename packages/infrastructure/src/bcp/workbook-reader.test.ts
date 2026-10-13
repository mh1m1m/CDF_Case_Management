// ADR-034 D3: the workbook reader returns every cell as a string from the parts the workbook names, and refuses
// macros, embedded content, external links and anything outside the SpreadsheetML subset it covers.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BCP_WORKBOOK_LIMITS, SpreadsheetMlSubsetReader, readWorkbook } from "./workbook-reader";
import { writeWorkbook } from "./workbook-writer";
import { SHEET, minimalWorkbook } from "./test-zip";

const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url));

function read(bytes: Uint8Array) {
  const r = readWorkbook(bytes);
  if (!r.ok) throw new Error(`rejected: ${r.code}`);
  return r.workbook;
}

function code(bytes: Uint8Array, limits = BCP_WORKBOOK_LIMITS): string {
  const r = readWorkbook(bytes, limits);
  return r.ok ? "ACCEPTED" : r.code;
}

const SST = (items: string) =>
  `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${items}</sst>`;

describe("workbook reader", () => {
  it("round-trips the template writer: inline strings, Arabic, markup characters and blank cells", () => {
    const wb = read(
      writeWorkbook([
        {
          name: "05_SUBJECTS",
          rows: [
            ["ROW_ID", "DISPLAY_LABEL"],
            ["", "الموظف أوميغا"],
            ["BCP-S1", 'A & <B> "c"'],
          ],
        },
        { name: "00_README", rows: [["BCP-1"]] },
      ]),
    );
    expect(wb.sheets.map((s) => s.name)).toEqual(["05_SUBJECTS", "00_README"]);
    expect(wb.sheets[0]!.rows).toEqual([
      {
        row: 1,
        cells: [
          { column: 1, value: "ROW_ID", formula: false },
          { column: 2, value: "DISPLAY_LABEL", formula: false },
        ],
      },
      { row: 2, cells: [{ column: 2, value: "الموظف أوميغا", formula: false }] },
      {
        row: 3,
        cells: [
          { column: 1, value: "BCP-S1", formula: false },
          { column: 2, value: 'A & <B> "c"', formula: false },
        ],
      },
    ]);
  });

  it("reads shared strings (with rich text runs, without phonetic text), plain values and formula flags", () => {
    const wb = read(
      minimalWorkbook(
        SHEET(
          `<row r="3"><c r="A3" t="s"><v>0</v></c><c r="C3" t="s"><v>1</v></c><c r="D3"><v>45000</v></c>` +
            `<c r="E3" t="b"><v>1</v></c><c r="F3" t="str"><f>A3&amp;"x"</f><v>BCP-S1x</v></c><c r="G3"><f>TODAY()</f></c>` +
            `<c r="H3" t="inlineStr"><is><r><t>in</t></r><r><t xml:space="preserve">line </t></r><rPh><t>skip</t></rPh></is></c>` +
            `<c r="I3" t="e"><v>#N/A</v></c><c r="J3" s="1"/></row><row r="9"><c r="B9" t="s"><v>0</v></c></row>`,
        ),
        [],
        {
          sharedStrings: SST(
            `<si><t>BCP-S1</t></si><si><r><t>Rich </t></r><r><rPr><b/></rPr><t>text</t></r><rPh sb="0" eb="1"><t>ルビ</t></rPh></si>`,
          ),
        },
      ),
    );
    const rows = wb.sheets[0]!.rows;
    expect(rows.map((r) => r.row)).toEqual([3, 9]);
    expect(Object.fromEntries(rows[0]!.cells.map((c) => [c.column, [c.value, c.formula]]))).toEqual({
      1: ["BCP-S1", false],
      3: ["Rich text", false],
      4: ["45000", false],
      5: ["1", false],
      6: ["BCP-S1x", true],
      7: ["", true],
      8: ["inline ", false],
      9: ["#N/A", false],
    });
    expect(rows[1]!.cells).toEqual([{ column: 2, value: "BCP-S1", formula: false }]);
  });

  it("reads rows and cells without references in order", () => {
    const wb = read(
      minimalWorkbook(
        SHEET(
          `<row><c t="inlineStr"><is><t>a</t></is></c><c t="inlineStr"><is><t>b</t></is></c></row><row><c><v>2</v></c></row>`,
        ),
      ),
    );
    expect(wb.sheets[0]!.rows).toEqual([
      {
        row: 1,
        cells: [
          { column: 1, value: "a", formula: false },
          { column: 2, value: "b", formula: false },
        ],
      },
      { row: 2, cells: [{ column: 1, value: "2", formula: false }] },
    ]);
  });

  it("reads the BCP-1 template as saved by openpyxl and by LibreOffice Calc", () => {
    for (const name of ["openpyxl-save.xlsx", "libreoffice-save.xlsx"]) {
      const wb = read(fixture(name));
      expect(wb.sheets, name).toHaveLength(27);
      const subjects = wb.sheets.find((s) => s.name === "05_SUBJECTS")!;
      expect(
        subjects.rows[0]!.cells.map((c) => c.value),
        name,
      ).toEqual([
        "ROW_ID",
        "OBJECT_ID",
        "ORIGINAL_EVENT_AT",
        "RECORDED_OFFLINE_BY",
        "DISPLAY_LABEL",
        "SUBJECT_CATEGORY",
      ]);
      expect(
        subjects.rows.find((r) => r.row === 3)!.cells.map((c) => c.value),
        name,
      ).toEqual([
        "BCP-S1",
        "2026-10-01T09:30:00Z",
        "lead@example.test",
        "الموظف أوميغا (تجريبي)",
        "EMPLOYEE",
      ]);
      expect(subjects.rows.find((r) => r.row === 4)!.cells[3]!.value, name).toBe(
        "Employee Psi & <Co> (synthetic)",
      );
      const allegation = wb.sheets.find((s) => s.name === "06_ALLEGATIONS")!.rows.find((r) => r.row === 3)!;
      expect(allegation.cells.find((c) => c.column === 6)!.value, name).toBe(
        "Synthetic: allegation recorded during the outage.\nSecond line.",
      );
      // A formula stays flagged, whatever value the application cached; a number stays its text.
      const master = wb.sheets.find((s) => s.name === "02_CASE_MASTER")!.rows.find((r) => r.row === 3)!;
      expect(master.cells.find((c) => c.column === 3)!.formula, name).toBe(true);
      expect(master.cells.find((c) => c.column === 6)!.value, name).toBe("42");
    }
  });

  it("refuses macros, embedded content and external links", () => {
    const sheet = SHEET("");
    expect(code(minimalWorkbook(sheet, [{ name: "xl/vbaProject.bin", data: "x" }]))).toBe("MACROS");
    expect(code(minimalWorkbook(sheet, [{ name: "xl/embeddings/oleObject1.bin", data: "x" }]))).toBe(
      "EMBEDDED_CONTENT",
    );
    expect(code(minimalWorkbook(sheet, [{ name: "xl/externalLinks/externalLink1.xml", data: "<a/>" }]))).toBe(
      "EMBEDDED_CONTENT",
    );
    const rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    const rels = (target: string, mode = "") =>
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/worksheet" Target="${target}"${mode}/></Relationships>`;
    expect(
      code(
        minimalWorkbook(sheet, [], {
          workbookRels: rels("http://example.test/x.xml", ' TargetMode="External"'),
        }),
      ),
    ).toBe("EXTERNAL_LINK");
    expect(code(minimalWorkbook(sheet, [], { workbookRels: rels("file:///etc/passwd") }))).toBe(
      "EXTERNAL_LINK",
    );
    expect(code(minimalWorkbook(sheet, [], { workbookRels: rels("../../../etc/passwd") }))).toBe(
      "UNSAFE_PATH",
    );
    expect(code(minimalWorkbook(sheet, [], { workbookRels: rels("worksheets/missing.xml") }))).toBe(
      "NOT_A_WORKBOOK",
    );
  });

  it("refuses DTDs and entities in any part it reads", () => {
    const xxe = `<?xml version="1.0"?><!DOCTYPE w [<!ENTITY x SYSTEM "file:///etc/passwd">]><worksheet><sheetData/></worksheet>`;
    expect(code(minimalWorkbook(xxe))).toBe("DTD");
    expect(
      code(
        minimalWorkbook(SHEET(`<row r="1"><c r="A1" t="s"><v>0</v></c></row>`), [], {
          sharedStrings: `<!DOCTYPE s><sst/>`,
        }),
      ),
    ).toBe("DTD");
    expect(
      code(minimalWorkbook(SHEET(`<row r="1"><c r="A1" t="inlineStr"><is><t>&ext;</t></is></c></row>`))),
    ).toBe("ENTITY");
  });

  it("refuses what it does not cover: chart sheets, unknown cell types, bad references", () => {
    const rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    const chart = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/chartsheet" Target="worksheets/sheet1.xml"/></Relationships>`;
    expect(code(minimalWorkbook(SHEET(""), [], { workbookRels: chart }))).toBe("UNSUPPORTED_SHEET");
    expect(code(minimalWorkbook(SHEET(`<row r="1"><c r="A1" t="x"><v>1</v></c></row>`)))).toBe(
      "UNSUPPORTED_CELL",
    );
    expect(
      code(
        minimalWorkbook(SHEET(`<row r="1"><c r="A1" t="s"><v>5</v></c></row>`), [], {
          sharedStrings: SST(""),
        }),
      ),
    ).toBe("MALFORMED");
    expect(code(minimalWorkbook(SHEET(`<row r="2"><c r="A1"><v>1</v></c></row>`)))).toBe("MALFORMED");
    expect(code(minimalWorkbook(SHEET(`<row r="2"/><row r="1"/>`)))).toBe("MALFORMED");
    expect(
      code(minimalWorkbook(SHEET(`<row r="1"><c r="B1"><v>1</v></c><c r="A1"><v>1</v></c></row>`))),
    ).toBe("MALFORMED");
    expect(code(new TextEncoder().encode("not a workbook"))).toBe("NOT_A_ZIP");
  });

  it("reads each part once: a sheet naming a part already read is refused (AGENT-09 R1)", () => {
    const rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    const pkg = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"';
    const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
    /** `targets.length` sheets, the i-th naming targets[i]; shared strings are related as rId0. */
    const sheets = (targets: string[]) => ({
      workbookRels:
        `<Relationships ${pkg}><Relationship Id="rId0" Type="${rel}/sharedStrings" Target="sharedStrings.xml"/>` +
        targets
          .map((t, i) => `<Relationship Id="rId${i + 1}" Type="${rel}/worksheet" Target="${t}"/>`)
          .join("") +
        `</Relationships>`,
      workbook:
        `<workbook ${ns} xmlns:r="${rel}"><sheets>` +
        targets.map((_, i) => `<sheet name="S${i}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
        `</sheets></workbook>`,
      sharedStrings: SST(""),
    });
    const ROW = `<row r="1"><c r="A1" t="inlineStr"><is><t>Synthetic</t></is></c></row>`;
    const other = { name: "xl/worksheets/sheet2.xml", data: SHEET(ROW), method: 8 as const };
    expect(
      code(minimalWorkbook(SHEET(ROW), [other], sheets(["worksheets/sheet1.xml", "worksheets/sheet2.xml"]))),
    ).toBe("ACCEPTED");
    expect(
      code(minimalWorkbook(SHEET(ROW), [], sheets(["worksheets/sheet1.xml", "worksheets/sheet1.xml"]))),
    ).toBe("SHARED_PART");
    expect(
      code(minimalWorkbook(SHEET(ROW), [], sheets(["worksheets/sheet1.xml", "/xl/worksheets/sheet1.xml"]))),
    ).toBe("SHARED_PART");
    expect(code(minimalWorkbook(SHEET(ROW), [], sheets(["worksheets/sheet1.xml", "workbook.xml"])))).toBe(
      "SHARED_PART",
    );
    expect(code(minimalWorkbook(SHEET(ROW), [], sheets(["sharedStrings.xml"])))).toBe("SHARED_PART");
    // The crafted file, scaled down: one large worksheet (a comment of incompressible-ish text) named by 40 sheets is
    // refused at the second sheet, after one inflation, instead of being inflated and tokenized 40 times.
    let x = 12345;
    const pad = Array.from({ length: 2 * 1024 * 1024 }, () => {
      x = (x * 1103515245 + 12345) >>> 0;
      return (x >>> 16) & 1 ? "a" : "b";
    }).join("");
    const big = SHEET(ROW).replace("<sheetData>", `<!--${pad}--><sheetData>`);
    const started = performance.now();
    expect(code(minimalWorkbook(big, [], sheets(Array(40).fill("worksheets/sheet1.xml"))))).toBe(
      "SHARED_PART",
    );
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("enforces row, cell, column and length limits", () => {
    const tight = {
      ...BCP_WORKBOOK_LIMITS,
      maxRowsPerSheet: 2,
      maxCellsPerSheet: 3,
      maxColumns: 4,
      maxCellLength: 5,
    };
    const row = (r: number, n = 1) =>
      `<row r="${r}">${Array.from({ length: n }, (_, i) => `<c r="${String.fromCharCode(65 + i)}${r}"><v>1</v></c>`).join("")}</row>`;
    expect(code(minimalWorkbook(SHEET(row(1) + row(2) + row(3))), tight)).toBe("TOO_MANY_ROWS");
    expect(code(minimalWorkbook(SHEET(row(1, 2) + row(2, 2))), tight)).toBe("TOO_MANY_CELLS");
    expect(code(minimalWorkbook(SHEET(`<row r="1"><c r="E1"><v>1</v></c></row>`)), tight)).toBe(
      "TOO_MANY_COLUMNS",
    );
    expect(
      code(
        minimalWorkbook(SHEET(`<row r="1"><c r="A1" t="inlineStr"><is><t>123456</t></is></c></row>`)),
        tight,
      ),
    ).toBe("CELL_TOO_LONG");
    expect(code(minimalWorkbook(SHEET(row(1) + row(2))), tight)).toBe("ACCEPTED");
  });

  it("is the WorkbookReader port, marked as a prototype substitution", () => {
    const reader = new SpreadsheetMlSubsetReader();
    expect(reader.name).toBe("spreadsheetml-subset-v1");
    expect(reader.read(new Uint8Array(10))).toEqual({ ok: false, code: "NOT_A_ZIP" });
  });
});
