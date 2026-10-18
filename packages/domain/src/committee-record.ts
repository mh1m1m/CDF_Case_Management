/**
 * The official record of a committee continuity workbook (migration 2115, ADR-061; the owner's decision on AMB-201).
 * Pure rules the BFF runs before the database, which re-checks every one of them:
 *   - the signed minutes file: wet-ink signed and scanned (ruled default, SOURCE_REQUIRED), so a PDF or an image whose
 *     content matches its extension, never an editable document; at most 25 MiB;
 *   - which record states the importer may still edit, and what a record waits on.
 * Nothing here reads the file beyond its first bytes, and nothing logs its name or content (§83).
 */
import {
  COMMITTEE_MINUTES_MAX_BYTES,
  type CommitteeMinutesContentType,
  type CommitteeRecordStatus,
} from "@cdf/contracts";
import { detectContentType, extensionOf, sanitizeFileName } from "./evidence";

const MINUTES_TYPE_BY_EXTENSION: Readonly<Record<string, CommitteeMinutesContentType>> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  tif: "image/tiff",
  tiff: "image/tiff",
};

/** detectContentType plus TIFF, which the evidence allow-list does not carry. */
function sniffMinutes(bytes: Uint8Array): string | null {
  if (bytes.length >= 4) {
    const [a, b, c, d] = [bytes[0], bytes[1], bytes[2], bytes[3]];
    if (
      (a === 0x49 && b === 0x49 && c === 0x2a && d === 0x00) ||
      (a === 0x4d && b === 0x4d && c === 0x00 && d === 0x2a)
    )
      return "image/tiff";
  }
  return detectContentType(bytes);
}

export type CommitteeMinutesRejection =
  "NAME_INVALID" | "TYPE_NOT_ALLOWED" | "EMPTY" | "TOO_LARGE" | "CONTENT_MISMATCH";

export type CommitteeMinutesCheck =
  | { ok: true; fileName: string; contentType: CommitteeMinutesContentType }
  | { ok: false; reason: CommitteeMinutesRejection; fileName: string };

/**
 * Validates the scanned signed minutes: sanitised name, PDF or image extension (a Word or other editable document is
 * refused), size bounds, and agreement between the extension and the sniffed content. The browser's type is ignored.
 */
export function checkCommitteeMinutesFile(input: {
  fileName: string;
  size: number;
  bytes: Uint8Array;
}): CommitteeMinutesCheck {
  const fileName = sanitizeFileName(input.fileName);
  const ext = extensionOf(fileName);
  if (!ext) return { ok: false, reason: "NAME_INVALID", fileName };
  const expected = MINUTES_TYPE_BY_EXTENSION[ext];
  if (!expected) return { ok: false, reason: "TYPE_NOT_ALLOWED", fileName };
  if (input.size <= 0 || input.bytes.length === 0) return { ok: false, reason: "EMPTY", fileName };
  if (input.size > COMMITTEE_MINUTES_MAX_BYTES || input.bytes.length > COMMITTEE_MINUTES_MAX_BYTES)
    return { ok: false, reason: "TOO_LARGE", fileName };
  if (sniffMinutes(input.bytes) !== expected) return { ok: false, reason: "CONTENT_MISMATCH", fileName };
  return { ok: true, fileName, contentType: expected };
}

/** The importer declares the roster and uploads or marks the minutes only while the record is a draft or returned. */
export function isCommitteeRecordEditable(status: CommitteeRecordStatus): boolean {
  return status === "DRAFT" || status === "RETURNED";
}

/** No further step changes a record in these states (§15: corrections are new versions, never edits). */
export function isCommitteeRecordFinal(status: CommitteeRecordStatus): boolean {
  return status === "COMMITTED" || status === "REJECTED" || status === "CANCELLED";
}

/** What a record waits on, for the importer's and the members' screens (§13). Neither layer replaces the other. */
export type CommitteeRecordWaitingOn =
  "IMPORTER" | "CHAIR_APPROVAL" | "MEMBER_ATTESTATIONS" | "COMMIT" | "NOTHING";

export function committeeRecordWaitingOn(status: CommitteeRecordStatus): CommitteeRecordWaitingOn {
  switch (status) {
    case "DRAFT":
    case "RETURNED":
      return "IMPORTER";
    case "PENDING_CHAIR_APPROVAL":
      return "CHAIR_APPROVAL";
    case "PLATFORM_ATTESTATION_IN_PROGRESS":
    case "FULLY_ATTESTED":
      return "MEMBER_ATTESTATIONS";
    case "READY_TO_COMMIT":
      return "COMMIT";
    case "COMMITTED":
    case "REJECTED":
    case "CANCELLED":
      return "NOTHING";
  }
}
