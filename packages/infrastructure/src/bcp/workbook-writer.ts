// A deterministic SpreadsheetML writer for the BCP-1 template (ADR-034 D1). Entries are stored (not deflated) with a
// fixed timestamp, so the same input always gives the same bytes and the committed template can be checked against
// the generator. Every cell is an inline string in a text-formatted column, so what users type stays text.
import { crc32 } from "./zip";

export interface WrittenSheet {
  name: string;
  /** Row 1 first; every cell is text. */
  rows: readonly (readonly string[])[];
  /** Rows above this one stay visible when scrolling (the header rows). */
  frozenRows?: number;
  /** Width of every column, in characters. */
  columnWidth?: number;
  /** Rows written in bold (1-based). */
  boldRows?: readonly number[];
}

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const CT = "application/vnd.openxmlformats-officedocument.spreadsheetml";

/** XML 1.0 allows tab, line feed and carriage return among the control characters; the rest are dropped. */
function xmlChars(value: string): string {
  let out = "";
  for (const ch of value) {
    const c = ch.codePointAt(0)!;
    if (c >= 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) out += ch;
  }
  return out;
}

function escapeXml(value: string): string {
  return xmlChars(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 1 → A, 27 → AA. */
export function columnName(n: number): string {
  let s = "";
  for (let k = n; k > 0; k = Math.floor((k - 1) / 26)) s = String.fromCharCode(65 + ((k - 1) % 26)) + s;
  return s;
}

function sheetXml(sheet: WrittenSheet): string {
  const width = Math.max(1, ...sheet.rows.map((r) => r.length));
  const frozen = sheet.frozenRows ?? 0;
  const bold = new Set(sheet.boldRows ?? []);
  const view =
    frozen > 0
      ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${frozen}" topLeftCell="A${frozen + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
      : `<sheetViews><sheetView workbookViewId="0"/></sheetViews>`;
  const rows = sheet.rows
    .map((cells, i) => {
      const r = i + 1;
      const style = bold.has(r) ? 2 : 1;
      const body = cells
        .map((value, c) => {
          const ref = `${columnName(c + 1)}${r}`;
          return value === ""
            ? `<c r="${ref}" s="${style}"/>`
            : `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
        })
        .join("");
      return `<row r="${r}">${body}</row>`;
    })
    .join("");
  return (
    XML_DECLARATION +
    `<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">${view}<sheetFormatPr defaultRowHeight="15"/>` +
    `<cols><col min="1" max="${width}" width="${sheet.columnWidth ?? 28}" style="1" customWidth="1"/></cols>` +
    `<sheetData>${rows}</sheetData></worksheet>`
  );
}

const STYLES =
  XML_DECLARATION +
  `<styleSheet xmlns="${NS_MAIN}">` +
  `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>` +
  `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
  `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
  `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
  // 0 default, 1 text (numFmt 49 "@"), 2 bold text.
  `<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
  `<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  `<xf numFmtId="49" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/></cellXfs>` +
  `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
  `</styleSheet>`;

/** The package parts of a workbook holding `sheets`, in a fixed order. */
export function workbookParts(sheets: readonly WrittenSheet[]): [string, string][] {
  const contentTypes =
    XML_DECLARATION +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="${CT}.sheet.main+xml"/>` +
    `<Override PartName="/xl/styles.xml" ContentType="${CT}.styles+xml"/>` +
    sheets
      .map(
        (_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="${CT}.worksheet+xml"/>`,
      )
      .join("") +
    `</Types>`;
  const rootRels =
    XML_DECLARATION +
    `<Relationships xmlns="${NS_PKG_REL}">` +
    `<Relationship Id="rId1" Type="${TYPE}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const workbook =
    XML_DECLARATION +
    `<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><bookViews><workbookView/></bookViews><sheets>` +
    sheets
      .map((s, i) => `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join("") +
    `</sheets></workbook>`;
  const workbookRels =
    XML_DECLARATION +
    `<Relationships xmlns="${NS_PKG_REL}">` +
    sheets
      .map(
        (_, i) =>
          `<Relationship Id="rId${i + 1}" Type="${TYPE}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join("") +
    `<Relationship Id="rId${sheets.length + 1}" Type="${TYPE}/styles" Target="styles.xml"/></Relationships>`;
  return [
    ["[Content_Types].xml", contentTypes],
    ["_rels/.rels", rootRels],
    ["xl/workbook.xml", workbook],
    ["xl/_rels/workbook.xml.rels", workbookRels],
    ["xl/styles.xml", STYLES],
    ...sheets.map((s, i): [string, string] => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)]),
  ];
}

/** A stored (uncompressed) ZIP of the given entries, with a fixed 1980-01-01 timestamp. */
export function storedZip(entries: readonly (readonly [string, Uint8Array])[]): Uint8Array {
  const DOS_TIME = 0;
  const DOS_DATE = (0 << 9) | (1 << 5) | 1;
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBytes = new TextEncoder().encode(name);
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(8, 0, true);
    lv.setUint16(10, DOS_TIME, true);
    lv.setUint16(12, DOS_DATE, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, DOS_TIME, true);
    cv.setUint16(14, DOS_DATE, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    locals.push(local, data);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const directorySize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, directorySize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + directorySize + end.length);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Writes a workbook of text cells. Deterministic: the same sheets give the same bytes. */
export function writeWorkbook(sheets: readonly WrittenSheet[]): Uint8Array {
  const encoder = new TextEncoder();
  return storedZip(workbookParts(sheets).map(([name, xml]) => [name, encoder.encode(xml)] as const));
}
