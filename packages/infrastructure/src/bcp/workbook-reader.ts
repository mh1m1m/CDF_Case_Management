// WorkbookReader over the SpreadsheetML subset the BCP-1 template uses (ADR-034 D3), on node:zlib only. The upload
// is untrusted: the container is checked before anything is inflated (zip.ts), the XML parts refuse DTDs and
// entities (xml.ts), and only the workbook, its relationships, the shared strings and the worksheets those name are
// read. Macros, embedded objects and external links refuse the file. Every cell comes back as a string, formulas
// flagged; the staging row decides what a value means.
// PRODUCTION_SUBSTITUTION_REQUIRED: a vetted workbook reader in the CDF runtime, behind the same port. This reader
// covers what Excel and LibreOffice write for BCP-1 (shared and inline strings, plain values, formula flags); rich
// features (pivot tables, charts, encryption, the Strict OOXML variant) are refused or ignored, never interpreted.
import type { WorkbookReader, WorkbookReadResult } from "@cdf/application";
import {
  BCP_MAX_WORKBOOK_BYTES,
  type BcpWorkbook,
  type BcpWorkbookCell,
  type BcpWorkbookRow,
  type BcpWorkbookSheet,
} from "@cdf/contracts";
import { ZipArchive, ZipRejected, type ZipLimits } from "./zip";
import { tokenize, XmlRejected } from "./xml";

export interface WorkbookLimits extends ZipLimits {
  maxSheets: number;
  /** Rows holding at least one cell, per sheet. */
  maxRowsPerSheet: number;
  maxCellsPerSheet: number;
  maxColumns: number;
  maxCellLength: number;
  maxSharedStrings: number;
}

/** Defaults sized for BCP-1: 27 sheets, at most 2000 data rows per import, cells up to 20000 characters. */
export const BCP_WORKBOOK_LIMITS: WorkbookLimits = {
  maxArchiveBytes: BCP_MAX_WORKBOOK_BYTES,
  maxEntries: 200,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
  maxRatio: 500,
  maxSheets: 40,
  maxRowsPerSheet: 2100,
  maxCellsPerSheet: 2100 * 32,
  maxColumns: 32,
  maxCellLength: 20000,
  maxSharedStrings: 2100 * 32 * 4,
};

class WorkbookRejected extends Error {
  constructor(readonly code: string) {
    super(`WORKBOOK_REJECTED:${code}`);
  }
}

function reject(code: string): never {
  throw new WorkbookRejected(code);
}

const OFFICE_DOCUMENT = "/officeDocument";
const WORKSHEET = "/worksheet";
const SHARED_STRINGS = "/sharedStrings";
const MACROS = /(^|\/)vbaProject\.bin$|(^|\/)vbaProjectSignature\.bin$/i;
const EMBEDDED = /^xl\/(embeddings|activeX|externalLinks)\//i;

interface Relationship {
  type: string;
  target: string;
}

function decode(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return reject("MALFORMED");
  }
}

/** Resolves a relationship target against the part that names it; the result must stay inside the archive. */
function resolve(fromPart: string, target: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) reject("EXTERNAL_LINK");
  const base = target.startsWith("/") ? [] : fromPart.split("/").slice(0, -1);
  const out = [...base];
  for (const segment of target.replace(/^\/+/, "").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) reject("UNSAFE_PATH");
      out.pop();
    } else {
      out.push(segment);
    }
  }
  return out.join("/");
}

/** The relationships part of `part` (e.g. xl/_rels/workbook.xml.rels), by id. */
function relationships(zip: ZipArchive, part: string): Map<string, Relationship> {
  const dir = part.split("/").slice(0, -1);
  const file = part.split("/").pop()!;
  const relsPart = [...dir, "_rels", `${file}.rels`].filter(Boolean).join("/");
  const rels = new Map<string, Relationship>();
  if (!zip.entries.has(relsPart)) return rels;
  for (const e of tokenize(decode(zip.read(relsPart)))) {
    if (e.type !== "open" || e.name !== "Relationship") continue;
    const { Id: id, Type: type, Target: target, TargetMode: mode } = e.attrs;
    if (!id || !type || target === undefined) reject("NOT_A_WORKBOOK");
    if (mode !== undefined && mode !== "Internal") reject("EXTERNAL_LINK");
    rels.set(id, { type, target: resolve(part, target) });
  }
  return rels;
}

function part(zip: ZipArchive, name: string): string {
  if (!zip.entries.has(name)) reject("NOT_A_WORKBOOK");
  return decode(zip.read(name));
}

function sharedStrings(xml: string, limits: WorkbookLimits): string[] {
  const out: string[] = [];
  let current: string[] | null = null;
  let phonetic = 0;
  let inText = false;
  for (const e of tokenize(xml)) {
    if (e.type === "open") {
      if (e.name === "si") current = [];
      else if (e.name === "rPh") phonetic++;
      else if (e.name === "t" && current && phonetic === 0) inText = true;
    } else if (e.type === "close") {
      if (e.name === "si" && current) {
        const value = current.join("");
        if (value.length > limits.maxCellLength) reject("CELL_TOO_LONG");
        out.push(value);
        if (out.length > limits.maxSharedStrings) reject("TOO_MANY_CELLS");
        current = null;
      } else if (e.name === "rPh") phonetic--;
      else if (e.name === "t") inText = false;
    } else if (inText && current) {
      current.push(e.value);
    }
  }
  return out;
}

/** "AB12" → 28 (1-based column); the row part is checked against the row being read. */
function columnOf(ref: string, row: number): number {
  const m = /^([A-Z]{1,3})([0-9]{1,7})$/.exec(ref);
  if (!m || Number(m[2]) !== row) reject("MALFORMED");
  let n = 0;
  for (const ch of m[1]!) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function worksheet(xml: string, strings: string[], limits: WorkbookLimits): BcpWorkbookRow[] {
  const rows: BcpWorkbookRow[] = [];
  let cells = 0;
  let row: BcpWorkbookRow | null = null;
  let lastRow = 0;
  let lastColumn = 0;
  let cell: { column: number; type: string; value: string[]; inline: string[]; formula: boolean } | null =
    null;
  let inData = false;
  let capture: "v" | "t" | null = null;
  let inInline = false;
  let phonetic = 0;

  const finishCell = () => {
    if (!cell || !row) return;
    const raw = cell.value.join("");
    let value: string;
    switch (cell.type) {
      case "s": {
        if (!/^[0-9]{1,9}$/.test(raw) || Number(raw) >= strings.length) reject("MALFORMED");
        value = strings[Number(raw)]!;
        break;
      }
      case "inlineStr":
        value = cell.inline.join("");
        break;
      case "str":
      case "n":
      case "b":
      case "e":
      case "d":
        value = raw;
        break;
      default:
        return reject("UNSUPPORTED_CELL");
    }
    if (value.length > limits.maxCellLength) reject("CELL_TOO_LONG");
    if (value !== "" || cell.formula) {
      const out: BcpWorkbookCell = { column: cell.column, value, formula: cell.formula };
      row.cells.push(out);
      if (++cells > limits.maxCellsPerSheet) reject("TOO_MANY_CELLS");
    }
    cell = null;
  };

  for (const e of tokenize(xml)) {
    if (e.type === "open") {
      if (e.name === "sheetData") inData = true;
      else if (!inData) continue;
      else if (e.name === "row") {
        const r = e.attrs.r === undefined ? lastRow + 1 : Number(e.attrs.r);
        if (!Number.isInteger(r) || r <= lastRow || r > 1048576) reject("MALFORMED");
        row = { row: r, cells: [] };
        lastRow = r;
        lastColumn = 0;
      } else if (e.name === "c") {
        if (!row) reject("MALFORMED");
        const column = e.attrs.r === undefined ? lastColumn + 1 : columnOf(e.attrs.r, row.row);
        if (column <= lastColumn) reject("MALFORMED");
        if (column > limits.maxColumns) reject("TOO_MANY_COLUMNS");
        lastColumn = column;
        cell = { column, type: e.attrs.t ?? "n", value: [], inline: [], formula: false };
      } else if (cell && e.name === "f") cell.formula = true;
      else if (cell && e.name === "v") capture = "v";
      else if (cell && e.name === "is") inInline = true;
      else if (cell && inInline && e.name === "rPh") phonetic++;
      else if (cell && inInline && e.name === "t" && phonetic === 0) capture = "t";
    } else if (e.type === "close") {
      if (e.name === "sheetData") inData = false;
      else if (e.name === "v" || e.name === "t") capture = null;
      else if (e.name === "rPh") phonetic--;
      else if (e.name === "is") inInline = false;
      else if (e.name === "c") finishCell();
      else if (e.name === "row" && row) {
        if (row.cells.length > 0) {
          rows.push(row);
          if (rows.length > limits.maxRowsPerSheet) reject("TOO_MANY_ROWS");
        }
        row = null;
      }
    } else if (cell && capture === "v") {
      cell.value.push(e.value);
    } else if (cell && capture === "t") {
      cell.inline.push(e.value);
    }
  }
  return rows;
}

/** Reads a workbook; throws WorkbookRejected (or a container/XML rejection) with a stable code. */
function readOrThrow(bytes: Uint8Array, limits: WorkbookLimits): BcpWorkbook {
  const zip = ZipArchive.open(bytes, limits);
  for (const name of zip.entries.keys()) {
    if (MACROS.test(name)) reject("MACROS");
    if (EMBEDDED.test(name)) reject("EMBEDDED_CONTENT");
  }
  const root = [...relationships(zip, "").values()].find((r) => r.type.endsWith(OFFICE_DOCUMENT));
  if (!root || !root.target.endsWith(".xml")) reject("NOT_A_WORKBOOK");
  const workbookPart = root.target;
  const rels = relationships(zip, workbookPart);
  const sst = [...rels.values()].find((r) => r.type.endsWith(SHARED_STRINGS));
  const strings = sst ? sharedStrings(part(zip, sst.target), limits) : [];

  const sheets: BcpWorkbookSheet[] = [];
  const names = new Set<string>();
  for (const e of tokenize(part(zip, workbookPart))) {
    if (e.type !== "open" || e.name !== "sheet") continue;
    const name = e.attrs.name;
    const rel = e.attrs.id ? rels.get(e.attrs.id) : undefined;
    if (!name || !rel) reject("NOT_A_WORKBOOK");
    if (!rel.type.endsWith(WORKSHEET)) reject("UNSUPPORTED_SHEET");
    if (names.has(name)) reject("MALFORMED");
    names.add(name);
    if (names.size > limits.maxSheets) reject("TOO_MANY_SHEETS");
    sheets.push({ name, rows: worksheet(part(zip, rel.target), strings, limits) });
  }
  if (sheets.length === 0) reject("NOT_A_WORKBOOK");
  return { sheets };
}

export function readWorkbook(
  bytes: Uint8Array,
  limits: WorkbookLimits = BCP_WORKBOOK_LIMITS,
): WorkbookReadResult {
  try {
    return { ok: true, workbook: readOrThrow(bytes, limits) };
  } catch (error) {
    if (error instanceof WorkbookRejected || error instanceof ZipRejected || error instanceof XmlRejected) {
      return { ok: false, code: error.code };
    }
    return { ok: false, code: "MALFORMED" };
  }
}

/** The WorkbookReader port over this module (PRODUCTION_SUBSTITUTION_REQUIRED). */
export class SpreadsheetMlSubsetReader implements WorkbookReader {
  readonly name = "spreadsheetml-subset-v1";
  constructor(private readonly limits: WorkbookLimits = BCP_WORKBOOK_LIMITS) {}
  read(bytes: Uint8Array): WorkbookReadResult {
    return readWorkbook(bytes, this.limits);
  }
}
