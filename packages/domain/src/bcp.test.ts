import { describe, expect, it } from "vitest";
import {
  BCP_COMMITTEE_TEMPLATE,
  BCP_MAX_ROWS,
  BCP_TEMPLATE,
  type BcpWorkbook,
  type BcpWorkbookRow,
} from "@cdf/contracts";
import { readBcpWorkbook } from "./bcp";

const cells = (values: readonly string[], formula = false) =>
  values.map((value, i) => ({ column: i + 1, value, formula }));

const CONTROL = [
  "BCP-1",
  "BCP-WB-1",
  "00000000-0000-4000-8000-000000000001",
  "CDF-DEMO-2026-0001",
  "2026-10-01T08:00:00Z",
  "",
  "lead@example.test",
];
const SUBJECT = ["BCP-S1", "", "2026-10-01T09:30:00Z", "lead@example.test", "Employee Omega", "EMPLOYEE"];

/** The BCP-1 template with its header rows, a control row and the data rows given per sheet. */
function workbook(data: Record<string, BcpWorkbookRow[]> = {}): BcpWorkbook {
  return {
    sheets: BCP_TEMPLATE.map((sheet) => {
      if (sheet.kind === "README") return { name: sheet.code, rows: [{ row: 1, cells: cells(["BCP-1"]) }] };
      const codes = sheet.columns.map((c) => c.code);
      const rows: BcpWorkbookRow[] = [
        { row: 1, cells: cells(codes) },
        { row: 2, cells: cells(codes.map((c) => `${c} label`)) },
      ];
      if (sheet.kind === "CONTROL") rows.push({ row: 3, cells: cells(CONTROL) });
      return { name: sheet.code, rows: [...rows, ...(data[sheet.code] ?? [])] };
    }),
  };
}

const withSubject = () => workbook({ "05_SUBJECTS": [{ row: 3, cells: cells(SUBJECT) }] });

function edit(wb: BcpWorkbook, sheet: string, fn: (rows: BcpWorkbookRow[]) => BcpWorkbookRow[]): BcpWorkbook {
  return { sheets: wb.sheets.map((s) => (s.name === sheet ? { ...s, rows: fn(s.rows) } : s)) };
}

const code = (wb: BcpWorkbook) => {
  const r = readBcpWorkbook(wb);
  return r.ok ? "OK" : r.code;
};

describe("continuity workbook template check (ADR-034 D1, D4)", () => {
  it("turns the control row and the non-empty data rows into what staging takes", () => {
    const wb = workbook({
      "05_SUBJECTS": [
        { row: 3, cells: cells(SUBJECT) },
        { row: 4, cells: cells(["", "", " "]) },
      ],
      "02_CASE_MASTER": [{ row: 7, cells: [{ column: 6, value: "45000", formula: true }] }],
    });
    const r = readBcpWorkbook({ sheets: [...wb.sheets].reverse() });
    expect(r).toEqual({
      ok: true,
      control: {
        TEMPLATE_VERSION: "BCP-1",
        WORKBOOK_ID: "BCP-WB-1",
        CASE_ID: "00000000-0000-4000-8000-000000000001",
        CASE_NUMBER: "CDF-DEMO-2026-0001",
        OFFLINE_FROM: "2026-10-01T08:00:00Z",
        PREPARED_BY: "lead@example.test",
      },
      rows: [
        // Template order, whatever order the sheets came in; blank rows are dropped, a formula row is kept and flagged.
        { sheet: "02_CASE_MASTER", row_number: 7, cells: { DETAILS: "45000" }, has_formula: true },
        {
          sheet: "05_SUBJECTS",
          row_number: 3,
          cells: {
            ROW_ID: "BCP-S1",
            ORIGINAL_EVENT_AT: "2026-10-01T09:30:00Z",
            RECORDED_OFFLINE_BY: "lead@example.test",
            DISPLAY_LABEL: "Employee Omega",
            SUBJECT_CATEGORY: "EMPLOYEE",
          },
          has_formula: false,
        },
      ],
    });
  });

  it("keeps cell text as found: no trimming, no type conversion", () => {
    const wb = workbook({
      "05_SUBJECTS": [
        { row: 3, cells: cells([" bcp-s1 ", "", "45000.5", "x", "  Omega\nline  ", "EMPLOYEE"]) },
      ],
    });
    const r = readBcpWorkbook(wb);
    expect(r.ok && r.rows[0]!.cells).toEqual({
      ROW_ID: " bcp-s1 ",
      ORIGINAL_EVENT_AT: "45000.5",
      RECORDED_OFFLINE_BY: "x",
      DISPLAY_LABEL: "  Omega\nline  ",
      SUBJECT_CATEGORY: "EMPLOYEE",
    });
  });

  it("requires exactly the template's sheets", () => {
    expect(code(withSubject())).toBe("OK");
    expect(code({ sheets: [...withSubject().sheets, { name: "Sheet1", rows: [] }] })).toBe(
      "UNEXPECTED_SHEET",
    );
    expect(code({ sheets: withSubject().sheets.filter((s) => s.name !== "17_AUTHORITY_DECISION") })).toBe(
      "MISSING_SHEET:17_AUTHORITY_DECISION",
    );
    expect(code({ sheets: withSubject().sheets.filter((s) => s.name !== "26_IMPORT_AUDIT") })).toBe(
      "MISSING_SHEET:26_IMPORT_AUDIT",
    );
    // The README and the platform's own log are never read, whatever they hold.
    const noisy = edit(
      edit(withSubject(), "00_README", () => []),
      "26_IMPORT_AUDIT",
      () => [{ row: 9, cells: cells(["anything"], true) }],
    );
    expect(code(noisy)).toBe("OK");
  });

  it("requires row 1 to hold the column codes, from column A, typed not computed", () => {
    const header = (fn: (row: BcpWorkbookRow) => BcpWorkbookRow) =>
      code(edit(withSubject(), "05_SUBJECTS", (rows) => [fn(rows[0]!), ...rows.slice(1)]));
    expect(header((r) => r)).toBe("OK");
    expect(header((r) => ({ ...r, cells: r.cells.map((c) => ({ ...c, value: ` ${c.value} ` })) }))).toBe(
      "OK",
    );
    expect(header((r) => ({ ...r, cells: r.cells.slice(0, -1) }))).toBe("HEADER:05_SUBJECTS");
    expect(
      header((r) => ({ ...r, cells: [...r.cells, { column: 7, value: "EXTRA", formula: false }] })),
    ).toBe("HEADER:05_SUBJECTS");
    expect(header((r) => ({ ...r, cells: r.cells.map((c) => ({ ...c, column: c.column + 1 })) }))).toBe(
      "HEADER:05_SUBJECTS",
    );
    expect(header((r) => ({ ...r, cells: [...r.cells].reverse() }))).toBe("HEADER:05_SUBJECTS");
    expect(header((r) => ({ ...r, cells: r.cells.map((c, i) => ({ ...c, formula: i === 2 })) }))).toBe(
      "HEADER:05_SUBJECTS",
    );
    expect(
      header((r) => ({ ...r, cells: r.cells.map((c) => ({ ...c, value: c.value.toLowerCase() })) })),
    ).toBe("HEADER:05_SUBJECTS");
    expect(header((r) => ({ ...r, row: 2 }))).toBe("HEADER:05_SUBJECTS");
    expect(code(edit(withSubject(), "01_CONTROL", (rows) => rows.slice(1)))).toBe("HEADER:01_CONTROL");
  });

  it("requires one typed control row on row 3, naming template BCP-1", () => {
    const control = (fn: (rows: BcpWorkbookRow[]) => BcpWorkbookRow[]) =>
      code(edit(withSubject(), "01_CONTROL", fn));
    expect(control((rows) => rows.slice(0, 2))).toBe("CONTROL_ROW");
    expect(control((rows) => [...rows, { row: 4, cells: cells(CONTROL) }])).toBe("CONTROL_ROW");
    expect(control((rows) => [...rows.slice(0, 2), { ...rows[2]!, row: 4 }])).toBe("CONTROL_ROW");
    expect(control((rows) => [...rows.slice(0, 2), { row: 3, cells: cells(CONTROL, true) }])).toBe(
      "CONTROL_FORMULA",
    );
    expect(control((rows) => [...rows.slice(0, 2), { row: 3, cells: cells([...CONTROL, "x"]) }])).toBe(
      "EXTRA_CELLS:01_CONTROL",
    );
    expect(
      control((rows) => [...rows.slice(0, 2), { row: 3, cells: cells(["bcp-1", ...CONTROL.slice(1)]) }]),
    ).toBe("OK");
    expect(
      control((rows) => [...rows.slice(0, 2), { row: 3, cells: cells(["BCP-2", ...CONTROL.slice(1)]) }]),
    ).toBe("TEMPLATE_VERSION");
    expect(
      control((rows) => [...rows.slice(0, 2), { row: 3, cells: cells(["", ...CONTROL.slice(1)]) }]),
    ).toBe("TEMPLATE_VERSION");
  });

  it("refuses cells beyond a sheet's columns, an empty workbook and more rows than staging takes", () => {
    expect(
      code(
        workbook({
          "05_SUBJECTS": [{ row: 3, cells: [...cells(SUBJECT), { column: 7, value: "x", formula: false }] }],
        }),
      ),
    ).toBe("EXTRA_CELLS:05_SUBJECTS");
    // A stray empty cell past the last column still counts: the template has nothing there.
    expect(
      code(
        workbook({
          "05_SUBJECTS": [{ row: 3, cells: [...cells(SUBJECT), { column: 9, value: "", formula: false }] }],
        }),
      ),
    ).toBe("EXTRA_CELLS:05_SUBJECTS");
    expect(code(workbook())).toBe("NO_ROWS");
    expect(code(workbook({ "05_SUBJECTS": [{ row: 3, cells: cells(["", " "]) }] }))).toBe("NO_ROWS");
    const many = (n: number) =>
      workbook({
        "05_SUBJECTS": Array.from({ length: n }, (_, i) => ({ row: 3 + i, cells: cells(SUBJECT) })),
      });
    expect(code(many(BCP_MAX_ROWS))).toBe("OK");
    expect(code(many(BCP_MAX_ROWS + 1))).toBe("TOO_MANY_ROWS");
  });
});

describe("the committee workbook BCP-C1 (migration 2110, ADR-047)", () => {
  const C_CONTROL = [
    "BCP-C1",
    "BCP-WB-C1",
    "00000000-0000-4000-8000-0000000000c1",
    "IC",
    "2026-10-01T08:00:00Z",
    "2026-10-02T08:00:00Z",
    "secretary@example.test",
  ];
  const MEETING = [
    "BCP-M1",
    "",
    "2026-10-01T10:00:00Z",
    "secretary@example.test",
    "DELIBERATION",
    "IN_PERSON",
    "Room 1 (synthetic)",
    "",
    "2026-10-01T10:00:00Z",
    "2026-10-01T11:00:00Z",
    "PAPER-MIN-1",
    "Synthetic: held during the outage.",
  ];

  function committeeWorkbook(control = C_CONTROL, data: Record<string, BcpWorkbookRow[]> = {}): BcpWorkbook {
    return {
      sheets: BCP_COMMITTEE_TEMPLATE.map((sheet) => {
        if (sheet.kind === "README")
          return { name: sheet.code, rows: [{ row: 1, cells: cells(["BCP-C1"]) }] };
        const codes = sheet.columns.map((c) => c.code);
        const rows: BcpWorkbookRow[] = [
          { row: 1, cells: cells(codes) },
          { row: 2, cells: cells(codes.map((c) => `${c} label`)) },
        ];
        if (sheet.kind === "CONTROL") rows.push({ row: 3, cells: cells(control) });
        return { name: sheet.code, rows: [...rows, ...(data[sheet.code] ?? [])] };
      }),
    };
  }

  it("reads only when the committee template is the one expected", () => {
    const wb = committeeWorkbook(C_CONTROL, { "09_MEETINGS": [{ row: 3, cells: cells(MEETING) }] });
    const r = readBcpWorkbook(wb, "BCP-C1");
    expect(r.ok && r.control).toEqual({
      TEMPLATE_VERSION: "BCP-C1",
      WORKBOOK_ID: "BCP-WB-C1",
      COMMITTEE_PROCEEDING_ID: "00000000-0000-4000-8000-0000000000c1",
      COMMITTEE_CODE: "IC",
      OFFLINE_FROM: "2026-10-01T08:00:00Z",
      OFFLINE_TO: "2026-10-02T08:00:00Z",
      PREPARED_BY: "secretary@example.test",
    });
    expect(r.ok && r.rows.map((x) => [x.sheet, x.row_number])).toEqual([["09_MEETINGS", 3]]);
    // The case upload reads BCP-1 only: a committee workbook is refused there (its control row has other columns),
    // and the reverse.
    expect(code(wb)).toBe("HEADER:01_CONTROL");
    expect(readBcpWorkbook(withSubject(), "BCP-C1")).toEqual({ ok: false, code: "UNEXPECTED_SHEET" });
  });

  it("refuses a committee workbook whose control row names another template", () => {
    const wb = committeeWorkbook(["BCP-1", ...C_CONTROL.slice(1)], {
      "09_MEETINGS": [{ row: 3, cells: cells(MEETING) }],
    });
    expect(readBcpWorkbook(wb, "BCP-C1")).toEqual({ ok: false, code: "TEMPLATE_VERSION" });
  });
});
