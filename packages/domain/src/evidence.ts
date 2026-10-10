/**
 * Evidence file rules (§25; ADR-006; threat T10). Pure functions: the application layer runs them
 * before anything touches storage or the database, and the database re-checks the facts it stores.
 */
import { EVIDENCE_MAX_BYTES, type EvidenceType } from "@cdf/contracts";

export { EVIDENCE_MAX_BYTES };

export interface AllowedContentType {
  contentType: string;
  extensions: readonly string[];
  evidenceType: Exclude<EvidenceType, "OTHER">;
}

/** Mirror of evidence.allowed_content_type (asserted equal by tests/integration/mirrors.spec.ts). */
export const ALLOWED_CONTENT_TYPES: readonly AllowedContentType[] = [
  { contentType: "application/pdf", extensions: ["pdf"], evidenceType: "DOCUMENT" },
  {
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    extensions: ["docx"],
    evidenceType: "DOCUMENT",
  },
  {
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    extensions: ["xlsx"],
    evidenceType: "DATA_EXPORT",
  },
  {
    contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    extensions: ["pptx"],
    evidenceType: "DOCUMENT",
  },
  { contentType: "text/plain", extensions: ["txt"], evidenceType: "DOCUMENT" },
  { contentType: "text/csv", extensions: ["csv"], evidenceType: "DATA_EXPORT" },
  { contentType: "application/json", extensions: ["json"], evidenceType: "DATA_EXPORT" },
  { contentType: "message/rfc822", extensions: ["eml"], evidenceType: "EMAIL" },
  { contentType: "image/png", extensions: ["png"], evidenceType: "IMAGE" },
  { contentType: "image/jpeg", extensions: ["jpg", "jpeg"], evidenceType: "IMAGE" },
  { contentType: "image/gif", extensions: ["gif"], evidenceType: "IMAGE" },
  { contentType: "image/webp", extensions: ["webp"], evidenceType: "IMAGE" },
  { contentType: "audio/mpeg", extensions: ["mp3"], evidenceType: "AUDIO" },
  { contentType: "audio/mp4", extensions: ["m4a"], evidenceType: "AUDIO" },
  { contentType: "audio/wav", extensions: ["wav"], evidenceType: "AUDIO" },
  { contentType: "video/mp4", extensions: ["mp4"], evidenceType: "VIDEO" },
];

const TEXT_TYPES = new Set(["text/plain", "text/csv", "application/json", "message/rfc822"]);
const OOXML_TYPES = new Set(
  ALLOWED_CONTENT_TYPES.filter((t) => t.contentType.startsWith("application/vnd.openxmlformats")).map(
    (t) => t.contentType,
  ),
);

export function extensionOf(fileName: string): string | null {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(fileName);
  return m ? m[1]!.toLowerCase() : null;
}

export function allowedTypeForExtension(ext: string | null): AllowedContentType | null {
  if (!ext) return null;
  return ALLOWED_CONTENT_TYPES.find((t) => t.extensions.includes(ext)) ?? null;
}

/**
 * Keeps a safe display name: no path components, no control characters, bounded length, and never
 * only dots. The name is informational; storage uses random object keys (T05).
 */
export function sanitizeFileName(input: string): string {
  const base = input.split(/[\\/]/).pop() ?? "";
  let name = base
    .replace(/\p{Cc}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  if (name === "" || /^\.+$/.test(name)) name = "evidence";
  if (name.length > 255) {
    const ext = extensionOf(name);
    name = ext ? `${name.slice(0, 254 - ext.length)}.${ext}` : name.slice(0, 255);
  }
  return name;
}

const ascii = (bytes: Uint8Array, start: number, end: number) =>
  String.fromCharCode(...bytes.subarray(start, Math.min(end, bytes.length)));

/**
 * Content sniffing from magic numbers. Returns a specific type, "application/zip" for OOXML
 * containers, "text/*" for plausible text, or null when the content is unrecognised.
 */
export function detectContentType(bytes: Uint8Array): string | null {
  if (bytes.length === 0) return null;
  const head = ascii(bytes, 0, 12);
  if (head.startsWith("%PDF-")) return "application/pdf";
  if (bytes[0] === 0x89 && head.slice(1, 4) === "PNG") return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) return "image/gif";
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") return "image/webp";
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WAVE") return "audio/wav";
  if (head.startsWith("ID3") || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe6) === 0xe2)) return "audio/mpeg";
  if (head.slice(4, 8) === "ftyp") {
    const brand = head.slice(8, 12);
    return brand.startsWith("M4A") || brand.startsWith("M4B") ? "audio/mp4" : "video/mp4";
  }
  if (head.startsWith("PK\u0003\u0004")) return "application/zip";
  if (looksLikeText(bytes)) return "text/*";
  return null;
}

function looksLikeText(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 8192);
  for (const b of sample) if (b === 0) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample.subarray(0, Math.max(0, sample.length - 4)));
    return true;
  } catch {
    return false;
  }
}

export type EvidenceFileRejection =
  "NAME_INVALID" | "EXTENSION_NOT_ALLOWED" | "EMPTY" | "TOO_LARGE" | "CONTENT_MISMATCH";

export type EvidenceFileCheck =
  | { ok: true; fileName: string; contentType: string; evidenceType: AllowedContentType["evidenceType"] }
  | { ok: false; reason: EvidenceFileRejection; fileName: string };

/**
 * Validates a candidate file: sanitised name, extension allow-list, size bounds and agreement between
 * the extension and the sniffed content. The browser-declared type is deliberately ignored.
 */
export function checkEvidenceFile(input: {
  fileName: string;
  size: number;
  bytes: Uint8Array;
}): EvidenceFileCheck {
  const fileName = sanitizeFileName(input.fileName);
  if (fileName === "evidence" && !extensionOf(fileName))
    return { ok: false, reason: "NAME_INVALID", fileName };
  const allowed = allowedTypeForExtension(extensionOf(fileName));
  if (!allowed) return { ok: false, reason: "EXTENSION_NOT_ALLOWED", fileName };
  if (input.size <= 0 || input.bytes.length === 0) return { ok: false, reason: "EMPTY", fileName };
  if (input.size > EVIDENCE_MAX_BYTES || input.bytes.length > EVIDENCE_MAX_BYTES)
    return { ok: false, reason: "TOO_LARGE", fileName };
  const sniffed = detectContentType(input.bytes);
  const expected = allowed.contentType;
  const consistent = OOXML_TYPES.has(expected)
    ? sniffed === "application/zip"
    : TEXT_TYPES.has(expected)
      ? sniffed === "text/*"
      : sniffed === expected;
  if (!consistent) return { ok: false, reason: "CONTENT_MISMATCH", fileName };
  return { ok: true, fileName, contentType: expected, evidenceType: allowed.evidenceType };
}

/** Display number within a case: EV-001. The UUID remains the identifier (§87). */
export function evidenceDisplayNumber(sequenceNo: number): string {
  return `EV-${String(sequenceNo).padStart(3, "0")}`;
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

// ---- Reporter attachments (CDF-72; ADR-015) -------------------------------------------------------
/**
 * Unicode format characters (Cf) include the bidirectional controls (U+202A–U+202E, U+2066–U+2069,
 * U+200E/U+200F, U+061C) that can disguise an extension ("invoice‮fdp.exe"). They are removed
 * before the extension is read (CDF-68).
 */
export function stripFormatCharacters(input: string): string {
  return input.replace(/\p{Cf}/gu, "");
}

export type ReporterAttachmentCheck =
  { ok: true; extension: string; contentType: string } | { ok: false; reason: EvidenceFileRejection };

/**
 * Validates a reporter's file with the evidence rules and the smaller per-file limit. Only the
 * extension survives; the file name itself is never stored or logged (it may carry identity).
 */
export function checkReporterAttachment(
  input: { fileName: string; size: number; bytes: Uint8Array },
  maxBytes: number,
): ReporterAttachmentCheck {
  if (input.size > maxBytes || input.bytes.length > maxBytes) return { ok: false, reason: "TOO_LARGE" };
  const check = checkEvidenceFile({ ...input, fileName: stripFormatCharacters(input.fileName) });
  if (!check.ok) return { ok: false, reason: check.reason };
  return { ok: true, extension: extensionOf(check.fileName)!, contentType: check.contentType };
}
