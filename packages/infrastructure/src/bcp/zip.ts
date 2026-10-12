// A ZIP container reader for untrusted uploads (ADR-034 D3), on node:zlib only. It reads the central directory,
// checks every limit before inflating anything and inflates only the entries asked for, each with a hard output cap.
// PRODUCTION_SUBSTITUTION_REQUIRED: a vetted workbook reader in the CDF runtime, behind the same WorkbookReader port.
import { inflateRawSync } from "node:zlib";

export interface ZipLimits {
  /** Largest archive accepted, in bytes. */
  maxArchiveBytes: number;
  /** Most entries in the central directory. */
  maxEntries: number;
  /** Largest declared uncompressed size of any one entry. */
  maxEntryBytes: number;
  /** Largest sum of declared uncompressed sizes over all entries. */
  maxTotalBytes: number;
  /** Highest uncompressed-to-compressed ratio of any entry (a zip-bomb signal). */
  maxRatio: number;
}

/** Why an archive is refused. Stable codes; never file content. */
export type ZipRejection =
  | "TOO_LARGE"
  | "NOT_A_ZIP"
  | "MULTI_DISK"
  | "ZIP64"
  | "TOO_MANY_ENTRIES"
  | "ENTRY_TOO_LARGE"
  | "TOTAL_TOO_LARGE"
  | "RATIO_TOO_HIGH"
  | "ENCRYPTED"
  | "UNSUPPORTED_METHOD"
  | "UNSAFE_PATH"
  | "DUPLICATE_ENTRY"
  | "CORRUPT";

export class ZipRejected extends Error {
  override name = "ZipRejected";
  constructor(readonly code: ZipRejection) {
    super(`ZIP_REJECTED:${code}`);
  }
}

export interface ZipEntry {
  name: string;
  method: 0 | 8;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX_COMMENT = 0xffff;

function fail(code: ZipRejection): never {
  throw new ZipRejected(code);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (IEEE), as stored in ZIP headers. */
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** An entry name is a relative path of plain segments: no root, drive, backslash, `.`/`..` segment or control
 *  character. */
export function isSafeEntryName(name: string): boolean {
  if (name.length === 0 || name.length > 255) return false;
  for (const ch of name) {
    const c = ch.charCodeAt(0);
    if (c < 0x20 || c === 0x7f || ch === "\\" || ch === ":") return false;
  }
  if (name.startsWith("/")) return false;
  return name.split("/").every((segment, i, all) => {
    if (segment === "") return i === all.length - 1; // a trailing slash marks a directory entry
    return segment !== "." && segment !== "..";
  });
}

export class ZipArchive {
  private readonly view: DataView;
  readonly entries: ReadonlyMap<string, ZipEntry>;

  private constructor(
    private readonly bytes: Uint8Array,
    private readonly limits: ZipLimits,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.entries = this.readDirectory();
  }

  /** Parses the central directory and checks every limit; inflates nothing. */
  static open(bytes: Uint8Array, limits: ZipLimits): ZipArchive {
    if (bytes.byteLength > limits.maxArchiveBytes) fail("TOO_LARGE");
    if (bytes.byteLength < 22) fail("NOT_A_ZIP");
    return new ZipArchive(bytes, limits);
  }

  private u16(at: number): number {
    if (at < 0 || at + 2 > this.bytes.byteLength) fail("CORRUPT");
    return this.view.getUint16(at, true);
  }

  private u32(at: number): number {
    if (at < 0 || at + 4 > this.bytes.byteLength) fail("CORRUPT");
    return this.view.getUint32(at, true);
  }

  private findEndOfDirectory(): number {
    const last = this.bytes.byteLength - 22;
    const first = Math.max(0, last - MAX_COMMENT);
    for (let at = last; at >= first; at--) {
      if (
        this.view.getUint32(at, true) === EOCD &&
        at + 22 + this.view.getUint16(at + 20, true) === this.bytes.byteLength
      ) {
        return at;
      }
    }
    return fail("NOT_A_ZIP");
  }

  private readDirectory(): Map<string, ZipEntry> {
    const eocd = this.findEndOfDirectory();
    if (this.u16(eocd + 4) !== 0 || this.u16(eocd + 6) !== 0) fail("MULTI_DISK");
    const onDisk = this.u16(eocd + 8);
    const total = this.u16(eocd + 10);
    const size = this.u32(eocd + 12);
    const offset = this.u32(eocd + 16);
    if (total === 0xffff || size === 0xffffffff || offset === 0xffffffff) fail("ZIP64");
    if (onDisk !== total) fail("MULTI_DISK");
    if (total > this.limits.maxEntries) fail("TOO_MANY_ENTRIES");
    if (offset + size > eocd) fail("CORRUPT");

    const entries = new Map<string, ZipEntry>();
    const seen = new Set<string>();
    let sum = 0;
    let at = offset;
    for (let n = 0; n < total; n++) {
      if (this.u32(at) !== CENTRAL) fail("CORRUPT");
      const flags = this.u16(at + 8);
      const method = this.u16(at + 10);
      const crc = this.u32(at + 16);
      const compressedSize = this.u32(at + 20);
      const uncompressedSize = this.u32(at + 24);
      const nameLength = this.u16(at + 28);
      const extraLength = this.u16(at + 30);
      const commentLength = this.u16(at + 32);
      const disk = this.u16(at + 34);
      const localHeaderOffset = this.u32(at + 42);
      const nameEnd = at + 46 + nameLength;
      if (nameEnd > eocd) fail("CORRUPT");
      const name = new TextDecoder("utf-8", { fatal: false }).decode(this.bytes.subarray(at + 46, nameEnd));
      at = nameEnd + extraLength + commentLength;
      if (at > eocd) fail("CORRUPT");

      if (flags & 0x0001 || flags & 0x0040) fail("ENCRYPTED");
      if (
        compressedSize === 0xffffffff ||
        uncompressedSize === 0xffffffff ||
        localHeaderOffset === 0xffffffff
      ) {
        fail("ZIP64");
      }
      if (disk !== 0) fail("MULTI_DISK");
      if (method !== 0 && method !== 8) fail("UNSUPPORTED_METHOD");
      if (!isSafeEntryName(name)) fail("UNSAFE_PATH");
      const key = name.toLowerCase();
      if (seen.has(key)) fail("DUPLICATE_ENTRY");
      seen.add(key);
      if (uncompressedSize > this.limits.maxEntryBytes) fail("ENTRY_TOO_LARGE");
      sum += uncompressedSize;
      if (sum > this.limits.maxTotalBytes) fail("TOTAL_TOO_LARGE");
      if (method === 0 && compressedSize !== uncompressedSize) fail("CORRUPT");
      if (uncompressedSize > 1024 && uncompressedSize > compressedSize * this.limits.maxRatio)
        fail("RATIO_TOO_HIGH");
      if (localHeaderOffset + 30 > offset) fail("CORRUPT");
      if (!name.endsWith("/")) {
        entries.set(name, { name, method, crc32: crc, compressedSize, uncompressedSize, localHeaderOffset });
      }
    }
    return entries;
  }

  /** Inflates one entry, never past its declared size, and checks its length and CRC. */
  read(name: string): Uint8Array {
    const entry = this.entries.get(name);
    if (!entry) fail("CORRUPT");
    const at = entry.localHeaderOffset;
    if (this.u32(at) !== LOCAL) fail("CORRUPT");
    const flags = this.u16(at + 6);
    if (flags & 0x0001 || flags & 0x0040) fail("ENCRYPTED");
    if (this.u16(at + 8) !== entry.method) fail("CORRUPT");
    const nameLength = this.u16(at + 26);
    const extraLength = this.u16(at + 28);
    const localName = new TextDecoder("utf-8", { fatal: false }).decode(
      this.bytes.subarray(at + 30, at + 30 + nameLength),
    );
    if (localName !== entry.name) fail("CORRUPT");
    const start = at + 30 + nameLength + extraLength;
    const end = start + entry.compressedSize;
    if (end > this.bytes.byteLength) fail("CORRUPT");
    const raw = this.bytes.subarray(start, end);
    let out: Uint8Array;
    if (entry.method === 0) {
      out = raw;
    } else {
      try {
        // maxOutputLength stops inflation at the declared size; a stream that would grow past it is refused.
        out = inflateRawSync(raw, { maxOutputLength: Math.max(entry.uncompressedSize, 1) });
      } catch {
        return fail("CORRUPT");
      }
    }
    if (out.byteLength !== entry.uncompressedSize || crc32(out) !== entry.crc32) fail("CORRUPT");
    return out;
  }
}
