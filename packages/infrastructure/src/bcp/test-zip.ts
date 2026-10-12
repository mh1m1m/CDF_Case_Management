// Test helper: builds ZIP archives with chosen header values, including dishonest ones, to probe the reader.
import { deflateRawSync } from "node:zlib";
import { crc32 } from "./zip";

export interface RawEntry {
  name: string;
  data: Uint8Array | string;
  /** 0 stored (default), 8 deflate, or any other method code. */
  method?: number;
  flags?: number;
  /** Overrides for what the headers declare. */
  declaredSize?: number;
  declaredCrc?: number;
  /** A different name in the local header. */
  localName?: string;
}

const bytes = (d: Uint8Array | string) => (typeof d === "string" ? new TextEncoder().encode(d) : d);

export function rawZip(
  entries: readonly RawEntry[],
  options: { comment?: string; totalOverride?: number } = {},
) {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = bytes(e.data);
    const method = e.method ?? 0;
    const body = method === 8 ? deflateRawSync(data) : data;
    const name = new TextEncoder().encode(e.name);
    const localName = new TextEncoder().encode(e.localName ?? e.name);
    const crc = e.declaredCrc ?? crc32(data);
    const size = e.declaredSize ?? data.length;
    const flags = e.flags ?? 0x0800;
    const local = new Uint8Array(30 + localName.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, flags, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, localName.length, true);
    local.set(localName, 30);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, flags, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local, body);
    centrals.push(central);
    offset += local.length + body.length;
  }
  const comment = new TextEncoder().encode(options.comment ?? "");
  const size = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22 + comment.length);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, options.totalOverride ?? entries.length, true);
  ev.setUint16(10, options.totalOverride ?? entries.length, true);
  ev.setUint32(12, size, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, comment.length, true);
  end.set(comment, 22);
  const out = new Uint8Array(offset + size + end.length);
  let at = 0;
  for (const p of [...locals, ...centrals, end]) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The parts of a minimal workbook with one sheet holding `sheetXml`, plus any extra entries. */
export function minimalWorkbook(
  sheetXml: string,
  extra: readonly RawEntry[] = [],
  options: { sharedStrings?: string; workbookRels?: string; workbook?: string } = {},
): Uint8Array {
  const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  const rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const pkg = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"';
  return rawZip([
    {
      name: "_rels/.rels",
      data: `<?xml version="1.0"?><Relationships ${pkg}><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: "xl/workbook.xml",
      data:
        options.workbook ??
        `<?xml version="1.0"?><workbook ${ns} xmlns:r="${rel}"><sheets><sheet name="05_SUBJECTS" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data:
        options.workbookRels ??
        `<?xml version="1.0"?><Relationships ${pkg}><Relationship Id="rId1" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/>` +
          (options.sharedStrings !== undefined
            ? `<Relationship Id="rId2" Type="${rel}/sharedStrings" Target="sharedStrings.xml"/>`
            : "") +
          `</Relationships>`,
    },
    { name: "xl/worksheets/sheet1.xml", data: sheetXml, method: 8 },
    ...(options.sharedStrings !== undefined
      ? [{ name: "xl/sharedStrings.xml", data: options.sharedStrings, method: 8 }]
      : []),
    ...extra,
  ]);
}

export const SHEET = (rows: string) =>
  `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
