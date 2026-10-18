/**
 * The official record of a committee continuity workbook (migration 2115, ADR-061; the owner's decision on AMB-201):
 * Layer 1, the final signed CDF minutes, uploaded as immutable versions; Layer 2, the chair's (or a formally activated
 * acting chair's) approval and each attending eligible member's own attestation, reconciled before the workbook
 * commits. The database defines every value here; a database test keeps the lists equal.
 */

export const COMMITTEE_RECORD_STATUSES = [
  "DRAFT",
  "PENDING_CHAIR_APPROVAL",
  "PLATFORM_ATTESTATION_IN_PROGRESS",
  "FULLY_ATTESTED",
  "READY_TO_COMMIT",
  "COMMITTED",
  "RETURNED",
  "REJECTED",
  "CANCELLED",
] as const;
export type CommitteeRecordStatus = (typeof COMMITTEE_RECORD_STATUSES)[number];

/** What the secretary declares from the signed minutes, line by line. */
export const COMMITTEE_RECORD_ATTENDANCE = ["ATTENDED", "ATTENDED_PART", "ABSENT", "RECUSED"] as const;
export type CommitteeRecordAttendance = (typeof COMMITTEE_RECORD_ATTENDANCE)[number];

/** A line's state (owner decision §5), derived by the database. There is no DEEMED_ATTESTED. */
export const COMMITTEE_RECORD_LINE_STATES = [
  "PENDING",
  "ATTESTED",
  "DECLINED_WITH_REASON",
  "RECUSED",
  "ABSENT",
  "INELIGIBLE",
  "NOT_REQUIRED",
] as const;
export type CommitteeRecordLineState = (typeof COMMITTEE_RECORD_LINE_STATES)[number];

/** Reconciliation (owner decision §8). */
export const COMMITTEE_RECORD_DISCREPANCIES = [
  "SIGNATURE_MISMATCH",
  "MISSING_PLATFORM_ATTESTATION",
  "MISSING_OFFICIAL_SIGNATURE",
  "ATTENDANCE_MISMATCH",
  "CONFLICT_SCOPE_MISMATCH",
  "DOCUMENT_VERSION_MISMATCH",
  // 2120 (ADR-048): a paper ballot whose holder's roster line is not attending; the platform's own, never declined.
  "BALLOT_WITHOUT_ATTENDANCE",
] as const;
export type CommitteeRecordDiscrepancy = (typeof COMMITTEE_RECORD_DISCREPANCIES)[number];
/** The codes a member may raise when declining; MISSING_PLATFORM_ATTESTATION is the platform's own. */
export const COMMITTEE_RECORD_DECLINE_CODES = [
  "ATTENDANCE_MISMATCH",
  "SIGNATURE_MISMATCH",
  "MISSING_OFFICIAL_SIGNATURE",
  "CONFLICT_SCOPE_MISMATCH",
  "DOCUMENT_VERSION_MISMATCH",
] as const satisfies readonly CommitteeRecordDiscrepancy[];
export type CommitteeRecordDeclineCode = (typeof COMMITTEE_RECORD_DECLINE_CODES)[number];

export const COMMITTEE_RECORD_DECISIONS = ["APPROVE", "RETURN", "REJECT"] as const;
export type CommitteeRecordDecision = (typeof COMMITTEE_RECORD_DECISIONS)[number];
export const COMMITTEE_RECORD_ATTESTATION_ACTIONS = ["ATTEST", "DECLINE"] as const;
export type CommitteeRecordAttestationAction = (typeof COMMITTEE_RECORD_ATTESTATION_ACTIONS)[number];
export const COMMITTEE_RECORD_ATTESTATION_SCOPES = ["FULL", "PARTIAL", "OWN_PARTICIPATION"] as const;
export type CommitteeRecordAttestationScope = (typeof COMMITTEE_RECORD_ATTESTATION_SCOPES)[number];
/** Why a deputy chair acts as chair for one record (owner decision §4). UNAVAILABLE is stated, never derived. */
export const ACTING_CHAIR_BASES = ["ABSENT", "UNAVAILABLE", "CONFLICTED", "INELIGIBLE", "VACANT"] as const;
export type ActingChairBasis = (typeof ACTING_CHAIR_BASES)[number];

export const COMMITTEE_MINUTES_STATUSES = ["QUARANTINED", "STORED", "SIGNED_OFFICIAL_RECORD"] as const;
export type CommitteeMinutesStatus = (typeof COMMITTEE_MINUTES_STATUSES)[number];
/** Wet-ink signed and scanned (ruled default, SOURCE_REQUIRED): PDF or an image, never an editable document. */
export const COMMITTEE_MINUTES_CONTENT_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/tiff",
] as const;
export type CommitteeMinutesContentType = (typeof COMMITTEE_MINUTES_CONTENT_TYPES)[number];
/** 25 MiB, as the database's check. */
export const COMMITTEE_MINUTES_MAX_BYTES = 26_214_400;

/** api.submit_bcp_import since 2115: a committee record whose declaration does not reconcile is refused with its codes
 *  recorded (SIGNATURE_RECONCILIATION_FAILED); a case workbook is always SUBMITTED or refused. */
export const BCP_SUBMIT_OUTCOMES = ["SUBMITTED", "RECONCILIATION_FAILED"] as const;
export type BcpSubmitOutcome = (typeof BCP_SUBMIT_OUTCOMES)[number];

/** One version of the signed minutes as api.open_committee_record_document returns it: for server code only. */
export interface CommitteeMinutesOpened {
  objectKey: string;
  contentType: CommitteeMinutesContentType;
  fileName: string;
  sizeBytes: number;
  sha256: string;
}

/** One roster line as the secretary declares it. */
export interface CommitteeRecordLineDeclaration {
  roster_id: string;
  attendance: CommitteeRecordAttendance;
  joined_late: boolean;
  left_early: boolean;
  signature_visible: boolean;
  signed_as_chair: boolean;
}
