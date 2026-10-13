/**
 * Shared data contracts between the database command layer, the application layer and the apps.
 * Types only (plus literal lists); no behaviour.
 */

import type { RelationshipToFund, ReporterMode } from "./intake";
export * from "./intake";
export * from "./bcp";

export const CLASSIFICATION_LEVELS = ["INTERNAL", "RESTRICTED", "CONFIDENTIAL", "SECRET"] as const;
export type Classification = (typeof CLASSIFICATION_LEVELS)[number];

/** Violation types from the Drive whistleblowing requirements report, field 13 (CDF-63). */
export const REPORT_CATEGORIES = [
  "FINANCIAL_CORRUPTION",
  "ADMINISTRATIVE_CORRUPTION",
  "POLICY_BREACH",
  "EHS_BREACH",
  "ABUSE_OF_AUTHORITY",
  "IRREGULAR_TRANSACTIONS",
  "PUBLIC_ORDER_VIOLATION",
  "CONCEALMENT",
  "OTHER",
] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

export const REPORT_STATUSES = [
  "RECEIVED",
  "INFO_REQUESTED",
  "ACCEPTED",
  "CASE_OPENED",
  "REFERRED_OUT",
  "CLOSED_NO_ACTION",
  "DUPLICATE",
] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

/** What the reporter sees (§23). Never internal workflow state. */
export const PUBLIC_REPORT_STATUSES = ["RECEIVED", "IN_PROGRESS", "INFORMATION_REQUESTED", "CLOSED"] as const;
export type PublicReportStatus = (typeof PUBLIC_REPORT_STATUSES)[number];

export const TRIAGE_OUTCOMES = [
  "OPEN_CASE",
  "REQUEST_INFORMATION",
  "REFER_OUT",
  "CLOSE_NO_ACTION",
  "DUPLICATE",
] as const;
export type TriageOutcome = (typeof TRIAGE_OUTCOMES)[number];

export const ASSIGNMENT_ROLES = ["CASE_OWNER", "LEAD_INVESTIGATOR", "INVESTIGATOR", "REVIEWER"] as const;
export type AssignmentRole = (typeof ASSIGNMENT_ROLES)[number];

export const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const PERMISSIONS = [
  "INTAKE_VIEW",
  "REPORT_TRIAGE",
  "REPORT_MESSAGE_REPLY",
  "CASE_CREATE",
  "CASE_VIEW_ALL",
  "CASE_EDIT_ALL",
  "CASE_ASSIGN",
  "WORKFLOW_SCREEN",
  "WORKFLOW_ADVANCE",
  "INVESTIGATION_APPROVE",
  "CONFLICT_DECLARE",
  "CONFLICT_MANAGE",
  "CLASSIFICATION_CHANGE",
  "RESTRICTED_CASE_GRANT",
  "RESTRICTED_CASE_AUTHORITY",
  "REPORTER_IDENTITY_REVEAL",
  "AUDIT_VIEW",
  "SECURITY_EVENT_VIEW",
  "USER_ADMIN",
  "ROLE_ADMIN",
  "EVIDENCE_UPLOAD",
  "EVIDENCE_DOWNLOAD",
  "FORM_VIEW",
  "FORM_PREPARE",
  "FORM_REVIEW",
  "FORM_APPROVE",
  // Records, retention and legal hold (ADR-013 D9)
  "RECORDS_VIEW",
  "RETENTION_CLASS_ASSIGN",
  "LEGAL_HOLD_APPLY",
  "LEGAL_HOLD_RELEASE",
  "DISPOSITION_REQUEST",
  "DISPOSITION_APPROVE",
  // Purpose-bound access (ADR-014, CDF-73). RECORDS_VIEW above is retired: no role holds it.
  "CASE_DISCOVER",
  "CASE_VIEW_METADATA",
  "CASE_VIEW_CONTENT",
  "CASE_TASK_ASSIGN",
  "LEGAL_HOLD_REQUEST",
  "LEGAL_HOLD_REVIEW",
  "RETENTION_TASK_VIEW",
  "RETENTION_TASK_EXECUTE",
  "DISPOSITION_TASK_VIEW",
  "DISPOSITION_TASK_EXECUTE",
  "ARCHIVE_RECORD_VIEW",
  "ARCHIVE_RECORD_ADMINISTER",
  "RECORDS_LIFECYCLE_ADMIN",
  "BREAK_GLASS_REQUEST",
  "BREAK_GLASS_APPROVE",
  // Committee registry (ADR-018, ADR-019): maintains seats and rules, never proceedings or case content.
  "COMMITTEE_ADMIN",
  // Direct referral and preliminary review (migration 1880).
  "SECTOR_ADMIN",
  "REFERRAL_PREPARE",
  "REFERRAL_SECTOR_APPROVE",
  "PRELIMINARY_PREPARE",
  "PRELIMINARY_REVIEW",
  "PRELIMINARY_APPROVE",
  // Legal review of recommendation packages (migration 1900, ADR-022): the assigned reviewer's opinion.
  "LEGAL_OPINION_GIVE",
  // Notification rules (migration 1920, ADR-025): event rules and committee defaults, never recipients or content.
  "NOTIFICATION_ADMIN",
  // Business calendar (migration 2030, DEC-F02): working week and dated holidays, never case content.
  "BUSINESS_CALENDAR_ADMIN",
  // Export builder (migration 1930, ADR-026, Q99). OWNER_DEFAULT, SOURCE_REQUIRED: the Delegation of Authority.
  "EXPORT_REQUEST",
  "EXPORT_APPROVE",
  "EXPORT_SECOND_APPROVE",
  "EXPORT_POLICY_ADMIN",
  // Corrective actions (migration 1940, ADR-033): OWNER_DEFAULT, SOURCE_REQUIRED (Delegation of Authority).
  "CORRECTIVE_ACTION_MANAGE",
  "CORRECTIVE_ACTION_OWN",
  "CORRECTIVE_ACTION_WAIVE",
  "CORRECTIVE_ACTION_POLICY_ADMIN",
  // Continuity workbook import (migration 1960, ADR-034): OWNER_DEFAULT, SOURCE_REQUIRED ("authorized continuity users").
  "BCP_IMPORT",
  "BCP_IMPORT_APPROVE",
  // Migration 2040 (DEC-F30): authorizes continuity-workbook operators (the registry); no import or case content.
  "BCP_CONTINUITY_ADMIN",
  // Reporter conversation (ADR-016 D4, DEC-06)
  "REPORTER_CONVERSATION_HOLD",
  "REPORTER_CONVERSATION_OVERSEE",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

// ---- Purpose-bound case tasks (ADR-014) -----------------------------------------------------------
/** Records lifecycle states of a case (case_mgmt.case_record.records_state). */
export const RECORDS_STATES = [
  "ACTIVE",
  "CLOSED",
  "RETENTION",
  "ARCHIVED",
  "DISPOSITION_ELIGIBLE",
  "DISPOSITION_PENDING",
  "DISPOSED",
] as const;
export type RecordsState = (typeof RECORDS_STATES)[number];

export const CASE_TASK_STATUSES = ["OPEN", "IN_PROGRESS", "COMPLETED", "CANCELLED", "EXPIRED"] as const;
export type CaseTaskStatus = (typeof CASE_TASK_STATUSES)[number];

export interface CaseTaskTypeDefinition {
  code: string;
  category: "LEGAL" | "RECORDS";
  allowedCapabilities: readonly Permission[];
  eligibleRoles: readonly string[];
  /** Records tasks exist only once the case has left ACTIVE. */
  requiresClosed: boolean;
}

/** Mirror of case_mgmt.case_task_type (tests/integration/mirrors.spec.ts). No type grants case content. */
export const CASE_TASK_TYPES = [
  {
    code: "ARCHIVE_TRANSFER",
    category: "RECORDS",
    allowedCapabilities: ["CASE_VIEW_METADATA", "RETENTION_TASK_VIEW", "ARCHIVE_RECORD_ADMINISTER"],
    eligibleRoles: ["RECORDS_OFFICER"],
    requiresClosed: true,
  },
  {
    code: "DISPOSITION_APPROVAL",
    category: "RECORDS",
    allowedCapabilities: ["CASE_VIEW_METADATA", "DISPOSITION_TASK_VIEW"],
    eligibleRoles: ["GRC_DIRECTOR"],
    requiresClosed: true,
  },
  {
    code: "DISPOSITION_EXECUTION",
    category: "RECORDS",
    allowedCapabilities: ["CASE_VIEW_METADATA", "DISPOSITION_TASK_VIEW", "DISPOSITION_TASK_EXECUTE"],
    eligibleRoles: ["RECORDS_OFFICER"],
    requiresClosed: true,
  },
  {
    code: "DISPOSITION_REVIEW",
    category: "RECORDS",
    allowedCapabilities: ["CASE_VIEW_METADATA", "DISPOSITION_TASK_VIEW", "DISPOSITION_TASK_EXECUTE"],
    eligibleRoles: ["RECORDS_OFFICER"],
    requiresClosed: true,
  },
  {
    code: "LEGAL_HOLD_APPLICATION",
    category: "LEGAL",
    allowedCapabilities: ["CASE_VIEW_METADATA", "LEGAL_HOLD_APPLY"],
    eligibleRoles: ["LEGAL_REVIEWER", "RECORDS_OFFICER", "GRC_DIRECTOR"],
    requiresClosed: false,
  },
  {
    code: "LEGAL_HOLD_ASSESSMENT",
    category: "LEGAL",
    allowedCapabilities: ["CASE_VIEW_METADATA", "LEGAL_HOLD_REVIEW", "LEGAL_HOLD_APPLY"],
    eligibleRoles: ["LEGAL_REVIEWER", "GRC_DIRECTOR"],
    requiresClosed: false,
  },
  {
    code: "LEGAL_HOLD_RELEASE",
    category: "LEGAL",
    allowedCapabilities: ["CASE_VIEW_METADATA", "LEGAL_HOLD_RELEASE"],
    eligibleRoles: ["LEGAL_REVIEWER", "GRC_DIRECTOR"],
    requiresClosed: false,
  },
  {
    code: "LEGAL_REVIEW",
    category: "LEGAL",
    allowedCapabilities: ["CASE_VIEW_METADATA", "LEGAL_HOLD_REQUEST"],
    eligibleRoles: ["LEGAL_REVIEWER"],
    requiresClosed: false,
  },
  {
    code: "RETENTION_REVIEW",
    category: "RECORDS",
    allowedCapabilities: ["CASE_VIEW_METADATA", "RETENTION_TASK_VIEW", "RETENTION_TASK_EXECUTE"],
    eligibleRoles: ["RECORDS_OFFICER"],
    requiresClosed: true,
  },
] as const satisfies readonly CaseTaskTypeDefinition[];
export type CaseTaskType = (typeof CASE_TASK_TYPES)[number]["code"];

/** One row of records.case_record_catalogue: lifecycle metadata only, never case content. */
export interface RecordsCatalogueEntry {
  caseId: string;
  caseNumber: string;
  caseType: string;
  classification: Classification;
  closedDate: string | null;
  retentionClass: string;
  retentionStartDate: string | null;
  retentionEndDate: string | null;
  legalHoldStatus: "NONE" | "ACTIVE";
  archiveStatus: RecordsState;
  dispositionStatus: string;
  recordOwner: string | null;
}

export interface MyCaseTask {
  taskId: string;
  caseId: string;
  caseNumber: string | null;
  taskType: CaseTaskType;
  category: "LEGAL" | "RECORDS";
  purpose: string;
  scope: Permission[];
  status: CaseTaskStatus;
  dueDate: string | null;
  expiresAt: string;
  legalHoldStatus: string | null;
  archiveStatus: string | null;
}

/** Result of the controlled exact-match lookup (§6): identifies the target, nothing more. */
export interface CaseDiscoveryResult {
  outcome: "MATCHED" | "NO_MATCH" | "RATE_LIMITED";
  /** The hold request filed on a match. Nothing else about the case is returned (CDF-79). */
  requestId: string | null;
}

/** Records and legal dashboards: counts of the caller's own work only (§18), never all cases. */
export interface MyWorkSummary {
  myRetentionTasks: number;
  myDispositionTasks: number;
  pendingArchiveTransfers: number;
  assignedLegalHolds: number;
  myLegalReviews: number;
  myLegalHoldRequests: number;
}

// ---- Records screens (CDF-71, ADR-013) -----------------------------------------------------------
export const LEGAL_HOLD_REASON_CODES = [
  "LITIGATION",
  "REGULATORY_INQUIRY",
  "INTERNAL_INVESTIGATION",
  "AUDIT",
  "OTHER",
] as const;
export type LegalHoldReasonCode = (typeof LEGAL_HOLD_REASON_CODES)[number];

/** A retention class the records officer may assign; values stay SOURCE_REQUIRED until the policy arrives. */
export interface RetentionClassOption {
  code: string;
  nameEn: string;
  nameAr: string;
  status: "SOURCE_REQUIRED" | "CONFIGURED";
}

export interface LegalHoldInfo {
  id: string;
  holdNumber: string;
  scopeType: "CASE" | "EVIDENCE_ITEM";
  reasonCode: LegalHoldReasonCode;
  status: "ACTIVE" | "RELEASE_PENDING" | "RELEASED";
  placedAt: string;
  releasedAt: string | null;
  /** The pending release request on this hold, if any. Dual control: its requester cannot decide it. */
  pendingRelease: { id: string; requestedByMe: boolean; requestedAt: string } | null;
}

export const LEGAL_HOLD_REQUEST_STATUSES = ["SUBMITTED", "ASSIGNED", "APPLIED", "REJECTED"] as const;
export type LegalHoldRequestStatus = (typeof LEGAL_HOLD_REQUEST_STATUSES)[number];

export interface LegalHoldRequestInfo {
  id: string;
  /** Null when the caller may not see the case (a controlled lookup before assignment, CDF-79). */
  caseId: string | null;
  caseNumber: string | null;
  origin: "CASE_TEAM" | "CONTROLLED_LOOKUP";
  reasonCode: LegalHoldReasonCode;
  status: LegalHoldRequestStatus;
  requestedByMe: boolean;
  assignedToMe: boolean;
  requestedAt: string;
  reviewedAt: string | null;
}

/** What the database would allow the caller to do on this record now (authz.* predicates, §19). */
export interface RecordCapabilities {
  manageRetention: boolean;
  manageDisposition: boolean;
  approveDisposition: boolean;
  applyLegalHold: boolean;
  releaseLegalHold: boolean;
  requestLegalHold: boolean;
  /** The shared Records pool cannot take this archived case and nobody holds a usable retention task on it. */
  routeRetention: boolean;
}

export interface DispositionRequestInfo {
  id: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "BLOCKED_BY_HOLD" | "EXECUTED";
  requestedByMe: boolean;
  requestedAt: string;
  decidedAt: string | null;
}

/**
 * One case as the records screens see it: lifecycle metadata only (ADR-014 catalogue fields), never title,
 * summary, people, allegations or evidence descriptions.
 */
export interface RecordDetail {
  caseId: string;
  caseNumber: string;
  caseType: string;
  classification: Classification;
  recordsState: RecordsState;
  retentionClass: string;
  retentionClassStatus: "SOURCE_REQUIRED" | "CONFIGURED";
  legalHoldStatus: "NONE" | "ACTIVE";
  closedAt: string | null;
  retainUntil: string | null;
  certificateId: string | null;
  capabilities: RecordCapabilities;
  dispositionRequests: DispositionRequestInfo[];
  holds: LegalHoldInfo[];
  holdRequests: LegalHoldRequestInfo[];
}

export interface DispositionCertificateView {
  id: string;
  certificateNumber: string;
  caseNumber: string;
  retentionClass: string;
  triggerEvent: string;
  triggerAt: string;
  retainUntil: string;
  requestedAt: string;
  approvedAt: string;
  issuedAt: string;
  dispositionAction: string;
  executionMode: "LOGICAL_ONLY";
  activeHoldsFound: number;
  evidenceVersions: number;
  certificateHash: string;
  /** Recomputed by the database on every view (api.verify_disposition_certificate). */
  verified: boolean;
}

// ---- Evidence (§24–§27, ADR-006) ---------------------------------------------------------------
export const EVIDENCE_TYPES = [
  "DOCUMENT",
  "IMAGE",
  "AUDIO",
  "VIDEO",
  "EMAIL",
  "DATA_EXPORT",
  "OTHER",
] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

export const EVIDENCE_STATUSES = ["PENDING", "AVAILABLE", "REJECTED"] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

/** Who on the case team sees an item (DEC-09): the team, or only the case manager, owner and lead investigator. */
export const EVIDENCE_RESTRICTIONS = ["TEAM", "LEADS"] as const;
export type EvidenceRestriction = (typeof EVIDENCE_RESTRICTIONS)[number];

export const EVIDENCE_VERSION_STATUSES = ["QUARANTINED", "AVAILABLE", "REJECTED"] as const;
export type EvidenceVersionStatus = (typeof EVIDENCE_VERSION_STATUSES)[number];

export const SCAN_STATUSES = ["PENDING", "CLEAN", "INFECTED", "UNSCANNED"] as const;
export type ScanStatus = (typeof SCAN_STATUSES)[number];

export const EVIDENCE_REJECTION_CODES = ["MALWARE_DETECTED", "SCAN_UNAVAILABLE", "STORAGE_FAILURE"] as const;
export type EvidenceRejectionCode = (typeof EVIDENCE_REJECTION_CODES)[number];

export const CUSTODY_EVENT_TYPES = ["RECEIVED", "STORED", "REJECTED", "DOWNLOADED"] as const;
export type CustodyEventType = (typeof CUSTODY_EVENT_TYPES)[number];

/** Upper bound for one evidence file (25 MiB), enforced by the browser hint, the server and the database. */
export const EVIDENCE_MAX_BYTES = 26_214_400;

export interface EvidenceVersionInfo {
  id: string;
  versionNo: number;
  originalFileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  status: EvidenceVersionStatus;
  scanStatus: ScanStatus;
  scanner: string | null;
  rejectionCode: EvidenceRejectionCode | null;
  uploadedBy: string;
  uploadedByName: string | null;
  uploadedAt: string;
  storedAt: string | null;
}

export interface CustodyEventInfo {
  id: string;
  versionId: string | null;
  eventType: CustodyEventType;
  actorId: string;
  actorName: string | null;
  occurredAt: string;
}

export interface EvidenceItem {
  id: string;
  caseId: string;
  sequenceNo: number;
  title: string;
  description: string | null;
  evidenceType: EvidenceType;
  sourceDescription: string | null;
  collectedAt: string | null;
  classification: Classification;
  status: EvidenceStatus;
  restriction: EvidenceRestriction;
  createdBy: string;
  createdByName: string | null;
  createdAt: string;
  currentVersion: EvidenceVersionInfo | null;
  versions: EvidenceVersionInfo[];
  custody: CustodyEventInfo[];
}

export const ROLES = [
  "INTAKE_OFFICER",
  "TRIAGE_OFFICER",
  "CASE_MANAGER",
  "INVESTIGATOR",
  "LEAD_INVESTIGATOR",
  "COMMITTEE_SECRETARY",
  "COMMITTEE_CHAIR",
  "COMMITTEE_MEMBER",
  "GRC_DIRECTOR",
  "COMPLIANCE",
  "LEGAL_REVIEWER",
  "HR_REVIEWER",
  "PRIVACY_DPO",
  "RECORDS_OFFICER",
  "INTERNAL_AUDIT",
  "SOC_ANALYST",
  "PLATFORM_ADMIN",
  "DB_ADMIN",
  "DECISION_AUTHORITY",
  "IMPLEMENTATION_OWNER",
  "REFERRER",
  "SECTOR_HEAD",
  "COMPLIANCE_SECTION_MANAGER",
  "GRC_SECTOR_HEAD",
] as const;
export type Role = (typeof ROLES)[number];

/** The verified, server-side view of the signed-in user. Built from the database, never from the client. */
export interface Actor {
  userId: string;
  email: string;
  displayName: string;
  displayNameAr: string;
  roles: Role[];
  permissions: Permission[];
  clearance: Classification;
}

export interface IntakeReportItem {
  id: string;
  reportRef: string;
  category: ReportCategory;
  reporterMode: ReporterMode;
  status: ReportStatus;
  classification: Classification;
  receivedAt: string;
  caseId: string | null;
}

export interface ReportDetail extends IntakeReportItem {
  subjectDescription: string | null;
  description: string;
  incidentDate: string | null;
  /** HH:MM; null for reports received before CDF-63. */
  incidentTime: string | null;
  location: string | null;
  relationshipToFund: RelationshipToFund | null;
  relationshipOther: string | null;
  categoryOther: string | null;
  willingToCooperate: boolean | null;
  language: "ar" | "en";
  /** Empty unless the caller may read the conversation (DEC-06: once a case exists it belongs to the case). */
  messages: ReportMessage[];
  conversation: ConversationAccess;
  /** Whether the caller may see the reporter's files (DEC-09: once a case exists, its investigation team). */
  filesVisible: boolean;
}

/** A person who may be named as a restricted case's accountable authority (DEC-01). Names only. */
export interface RestrictedCaseAuthority {
  userId: string;
  displayName: string;
  displayNameAr: string;
}

export interface ReportMessage {
  direction: "FROM_REPORTER" | "TO_REPORTER";
  body: string;
  createdAt: string;
}

export interface CaseListItem {
  id: string;
  caseNumber: string;
  title: string;
  classification: Classification;
  isRestricted: boolean;
  priority: Priority | null;
  currentState: string | null;
  stateNameEn: string | null;
  stateNameAr: string | null;
  stateDueAt: string | null;
  assignedInvestigatorId: string | null;
  updatedAt: string;
}

export interface CaseDetail extends CaseListItem {
  summary: string;
  source: string;
  sourceReportId: string | null;
  reporterWbId: string | null;
  recordsState: string;
  createdAt: string;
  openedAt: string | null;
  rowVersion: number;
  /** When the case entered its current state (`workflow_instance.entered_state_at`). */
  enteredStateAt: string | null;
  owner: { userId: string; displayName: string; displayNameAr: string | null } | null;
  /** Status only (ADR-016 D5, DEC-10): who asked for a hold and why stay with legal, records and GRC. */
  legalHoldStatus: "NONE" | "ACTIVE";
  /** The case's own route through the workflow, oldest first (`workflow_transition_event`), for path-aware progress. */
  path: CasePathStep[];
  allegations: { id: string; category: string; description: string; status: string }[];
  assignments: CaseAssignment[];
  transitions: TransitionOption[];
  myConflictStatus: string | null;
  /** The caller's part in the reporter conversation, from the database (DEC-06): it decides the Reporter tab. */
  reporterConversation: ConversationAccess;
  /** The caller's evidence need-to-know, from the database (DEC-09): it decides the Evidence tab. */
  evidenceAccess: EvidenceAccess;
  /** What the caller may do on this case, from the database's own rules (UX-116). Commands check again. */
  can: CaseCapabilities;
}

/**
 * Case capabilities read from `authz.*` (UX-116), so no page re-implements a rule. `edit`: details and allegations
 * (`can_edit_case`); `assign`: the team, grants and delegations (`can_assign_case`); `uploadEvidence`
 * (`can_upload_evidence`); the three interview rules (`can_conduct/review/approve_interviews`); `classifications`:
 * the levels a new item on this case may carry, from the case's level up to the caller's clearance.
 */
export interface CaseCapabilities {
  edit: boolean;
  assign: boolean;
  uploadEvidence: boolean;
  conductInterviews: boolean;
  reviewInterviews: boolean;
  approveInterviews: boolean;
  classifications: Classification[];
}

/**
 * LEADS: the register, LEADS items and the restriction control (case manager, owner, lead investigator);
 * TEAM: the register; REPORTER_FILES: the reporter's files only (triage while its grant lasts); NONE: no tab.
 */
export type EvidenceAccess = "LEADS" | "TEAM" | "REPORTER_FILES" | "NONE";

/** NONE: no thread; READ: read only (oversight); SEND: may also write to the reporter. */
export type ConversationAccess = "NONE" | "READ" | "SEND";

/** The Reporter tab (ADR-016 D4, DEC-06): the conversation of each report behind the case, and who may write. */
export interface CaseReporterView {
  conversations: { reportId: string; canSend: boolean; messages: ReportMessage[] }[];
  /** Active REPORTER_COMMUNICATE delegations: all of them for those who manage the team, else only the caller's. */
  delegations: ReporterDelegation[];
  /** The caller manages the team (authz.can_assign_case) and so may delegate and end delegations. */
  canDelegate: boolean;
}

export interface ReporterDelegation {
  id: string;
  userId: string;
  displayName: string;
  displayNameAr: string | null;
  delegatedAt: string;
}

export interface CasePathStep {
  transitionCode: string;
  fromState: string;
  toState: string;
  occurredAt: string;
}

export interface CaseAssignment {
  id: string;
  userId: string;
  displayName: string;
  displayNameAr?: string | null;
  assignmentRole: AssignmentRole;
  assignedAt: string;
}

export interface TransitionOption {
  code: string;
  toState: string;
  nameEn: string;
  nameAr: string;
  reasonRequired: boolean;
  /** False for steps of a later phase: shown as "later in this case", never hidden (UX-006). */
  enabled: boolean;
  allowed: boolean;
  blockingReasons: string[];
  /** Roles that may take this step, never people (audit §22.4.4). Reference data, readable by every user. */
  eligibleRoles: string[];
}

/**
 * One event of a case's history, read through api.case_history (ADR-016 D5, DEC-08/DEC-10). The database decides
 * which events reach the caller and blanks the actor, subject or reason where the audience may not know them.
 */
export interface AuditTimelineEntry {
  seq: number;
  occurredAt: string;
  action: string;
  actorId: string | null;
  actorName: string | null;
  actorNameAr: string | null;
  /** The person a team, access or conflict event is about. */
  subjectName: string | null;
  subjectNameAr: string | null;
  reason: string | null;
  detail: CaseHistoryDetail | null;
}

/** The fixed keys api.case_history returns per action; never the event's raw metadata. */
export interface CaseHistoryDetail {
  transition?: string;
  /** A workflow state, or a classification level within the caller's clearance (otherwise null). */
  from?: string | null;
  to?: string | null;
  role?: string;
  scope?: string;
  fields?: string[];
  restricted?: boolean;
  /** EVIDENCE_RESTRICTION_CHANGED (DEC-09): the item's number within the case and its new restriction. */
  item?: number;
  restriction?: EvidenceRestriction;
}

export const ROSTER_STATUSES = ["ACTIVE", "SCHEDULED", "EXPIRED", "ENDED", "REVOKED"] as const;
export type RosterStatus = (typeof ROSTER_STATUSES)[number];

/** One row of a case's access roster (api.case_access_roster; DEC-08). Never oversight grants or break-glass. */
export interface CaseAccessRosterEntry {
  userId: string;
  displayName: string;
  displayNameAr: string | null;
  /** FORM_ACCESS: one form kept from a reconciled COMMITTEE or REVIEW grant (S3, ADR-016 D2), never the case. */
  relationship: "ASSIGNMENT" | "GRANT" | "FORM_ACCESS";
  /**
   * The assignment role, the grant's purpose (TRIAGE, CASE, COMMITTEE, REVIEW), or for FORM_ACCESS
   * `<form code>:<instance no>` (read with `parseFormAccessCode` from `@cdf/domain`).
   */
  code: string;
  sinceAt: string;
  untilAt: string | null;
  endedAt: string | null;
  status: RosterStatus;
  isSelf: boolean;
}

export interface UserDirectoryEntry {
  id: string;
  displayName: string;
  displayNameAr: string;
  department: string | null;
}

/** Safe error codes surfaced to the UI (§82). Mapped to i18n keys; never raw database text. */
export const APP_ERROR_KINDS = [
  "UNAUTHENTICATED",
  "NOT_FOUND",
  "FORBIDDEN",
  "INVALID",
  "CONFLICT",
  "RATE_LIMITED",
  "UNAVAILABLE",
] as const;
export type AppErrorKind = (typeof APP_ERROR_KINDS)[number];

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: { kind: AppErrorKind; detail?: string; correlationId: string } };

/**
 * Serializable result of a server-action command form (UX-001). Never contains database text (§82): `kind`
 * is an AppErrorKind, `detail` a safe code mapped to an i18n key, `fieldErrors` maps a field name to a
 * `validation.*` message key, and `ref` is the correlation id shown to the user.
 *
 * `values` echoes what the user submitted, so a refused submit made before the page hydrated can be shown
 * again. It never holds a password, follow-up secret, token or identity field (see @cdf/ui `echoValues`).
 */
export type CommandFormState =
  | { status: "idle" }
  | { status: "ok"; message?: string }
  | { status: "invalid"; fieldErrors: Record<string, string>; values?: Record<string, string | string[]> }
  | {
      status: "error";
      kind: string;
      detail?: string;
      ref: string;
      values?: Record<string, string | string[]>;
    };

export * from "./forms";
// ---- Interviews (EPIC 09, CDF-60) ----------------------------------------------------------------
export * from "./interviews";

// ---- Shell, My Work and My access (UX redesign S1; migration 1820; ADR-016 D0) --------------------------
/** Sidebar areas in their fixed order (audit §20.5). Committee arrives at S5 and Reporting at S6. */
export const WORK_AREAS = [
  "MY_WORK",
  "INTAKE",
  "CASES",
  "COMMITTEE",
  "RECORDS",
  "OVERSIGHT",
  "ADMINISTRATION",
  "REPORTING",
] as const;
export type WorkArea = (typeof WORK_AREAS)[number];

/** An area the caller has now: a permission AND a live relationship (`api.my_areas()`). */
export interface MyArea {
  area: WorkArea;
  /** The caller's own items that need their action in this area; always 0 for Oversight and Administration. */
  actionableCount: number;
  defaultView: string;
}

export const WORK_VIEWS = ["NEEDS_ACTION", "MY_CASES", "DUE_SOON", "WAITING"] as const;
export type WorkView = (typeof WORK_VIEWS)[number];

/** Item types `api.my_work_items()` returns; open tasks arrive as `TASK_<task type>`. */
export const WORK_CATEGORIES = [
  "NEW_REPORT",
  "CASE_TO_OPEN",
  "REPORTER_REPLIED",
  "MY_CASE",
  "DECLARE_CONFLICT",
  "CONFLICT_TO_DECIDE",
  "UNASSIGNED_CASE",
  "CASE_STAGE_DUE",
  "FORM_TO_REVIEW",
  "FORM_TO_APPROVE",
  "FORM_RETURNED",
  /** S3 (ADR-016 D2, path (a)): a draft kept for the caller by form-scoped access, to complete without the case. */
  "FORM_TO_COMPLETE",
  "INTERVIEW_TO_REVIEW",
  "INTERVIEW_TO_APPROVE",
  "INTERVIEW_SOON",
  "HOLD_REQUEST_TO_ROUTE",
  "HOLD_RELEASE_TO_DECIDE",
  "MY_HOLD_REQUEST",
  "MY_HOLD_RELEASE_REQUEST",
  "RETENTION_CLASSIFICATION",
  "RETENTION_TO_ROUTE",
  ...CASE_TASK_TYPES.map((t) => `TASK_${t.code}` as const),
] as const;
export type WorkCategory = (typeof WORK_CATEGORIES)[number];

export type WorkTargetType =
  | "REPORT"
  | "CASE"
  | "CONFLICT"
  | "FORM_INSTANCE"
  | "INTERVIEW"
  | "CASE_TASK"
  | "HOLD_REQUEST"
  | "HOLD_RELEASE"
  /** A case's records page (lifecycle metadata only). */
  | "RECORD";

/**
 * One item of the caller's work. Ids, codes and dates only: never a title, name or narrative (DEC-22 decides
 * any further field). The case number is present only where the caller may see the case's metadata.
 */
export interface WorkItem {
  area: WorkArea;
  view: WorkView;
  category: WorkCategory;
  targetType: WorkTargetType;
  targetId: string;
  caseId: string | null;
  caseNumber: string | null;
  dueAt: string | null;
  /** TASK, SCHEDULE, or WORKFLOW_SLA_PROVISIONAL until an approved SLA source exists (DEC-43). */
  dueSource: "TASK" | "SCHEDULE" | "WORKFLOW_SLA_PROVISIONAL" | null;
  sinceAt: string | null;
}

/**
 * One archived case waiting for its retention class in the shared Records queue (`api.retention_review_queue()`;
 * ADR-016 D8, DEC-37). Lifecycle metadata only, and only for cases the caller may classify; never a named assignee.
 */
export interface RetentionQueueEntry {
  caseId: string;
  caseNumber: string;
  classification: Classification;
  archivedAt: string | null;
  retentionClass: string;
  legalHoldStatus: "NONE" | "ACTIVE";
}

/** A records officer a case's retention review may be routed to (eligible role, cleared, no conflict). Names only. */
export interface RetentionReviewer {
  userId: string;
  displayName: string;
  displayNameAr: string;
}

export const ACCESS_BASES = [
  "CLEARANCE",
  "ROLE",
  "ASSIGNMENT",
  "GRANT",
  "FORM_ACCESS",
  "TASK",
  "BREAK_GLASS",
] as const;
export type AccessBasis = (typeof ACCESS_BASES)[number];

/** One line of the caller's own access basis (`api.my_access()`); nobody else's. */
export interface MyAccessEntry {
  basis: AccessBasis;
  /** For FORM_ACCESS (S3, ADR-016 D2): `<form code>:<instance no>` (read with `parseFormAccessCode` from `@cdf/domain`). */
  code: string;
  caseId: string | null;
  caseNumber: string | null;
  sinceAt: string | null;
  untilAt: string | null;
  /** For FORM_ACCESS: the kept form's id, so the row leads to that form; null on every other row. */
  targetId: string | null;
}

/** One audit-ledger row for Oversight: metadata only. Reasons and details wait for DEC-11 (audit G13). */
export interface LedgerEntry {
  seq: number;
  occurredAt: string;
  action: string;
  category: "BUSINESS" | "ADMIN" | "SECURITY";
  actorType: string;
  actorRoles: string[];
  objectType: string | null;
  outcome: string;
}
export type OversightView = "ledger" | "security-events";

/** The read-only user register for Administration: directory columns and active roles. No case data. */
export interface UserRegisterEntry {
  id: string;
  displayName: string;
  displayNameAr: string;
  email: string;
  department: string | null;
  status: "ACTIVE" | "SUSPENDED" | "REVOKED";
  roles: Role[];
}

/** A declared conflict waiting for a decision, as a conflict manager on the case sees it (RLS conflict_check_read). */
export interface PendingConflict {
  id: string;
  userId: string;
  displayName: string;
  displayNameAr: string;
  declaration: string | null;
  declaredAt: string;
}

// ---- Business architecture rebase: case structure and committees (ADR-017 to ADR-019) ----------------
/** Intake path of a case (case_mgmt.case_record.source_type). */
export const CASE_SOURCE_TYPES = [
  "WHISTLEBLOWING",
  "DIRECT_REFERRAL",
  "DIRECT_GRIEVANCE",
  "OTHER_AUTHORIZED_SOURCE",
] as const;
export type CaseSourceType = (typeof CASE_SOURCE_TYPES)[number];

export const PROCEEDING_TYPES = [
  "PRELIMINARY_REVIEW",
  "INVESTIGATION",
  "COMMITTEE_INVESTIGATION",
  "LEGAL_REVIEW",
  "AUTHORITY_DECISION",
  "CORRECTIVE_ACTION",
  "GRIEVANCE",
  "REINVESTIGATION",
] as const;
export type ProceedingType = (typeof PROCEEDING_TYPES)[number];

export const PROCEEDING_STATUSES = [
  "OPEN",
  "IN_PROGRESS",
  "AWAITING_REVIEW",
  "AWAITING_APPROVAL",
  "RETURNED",
  "SUSPENDED",
  "CONCLUDED",
  "CANCELLED",
] as const;
export type ProceedingStatus = (typeof PROCEEDING_STATUSES)[number];

export const SUBJECT_CATEGORIES = ["EMPLOYEE", "CONTRACTOR", "OTHER_AUTHORIZED"] as const;
export type SubjectCategory = (typeof SUBJECT_CATEGORIES)[number];

export const FINDING_RESULTS = [
  "SUBSTANTIATED",
  "PARTIALLY_SUBSTANTIATED",
  "NOT_SUBSTANTIATED",
  "INCONCLUSIVE",
] as const;
export type FindingResult = (typeof FINDING_RESULTS)[number];

export const COMMITTEE_KINDS = ["INVESTIGATION", "GRIEVANCE"] as const;
export type CommitteeKind = (typeof COMMITTEE_KINDS)[number];

export const COMMITTEE_SEATS = [
  "CHAIR",
  "DEPUTY_CHAIR",
  "SECRETARY",
  "ALTERNATE_SECRETARY",
  "MEMBER",
  "ALTERNATE_MEMBER",
] as const;
export type CommitteeSeat = (typeof COMMITTEE_SEATS)[number];

export const QUORUM_TYPES = ["MAJORITY_ELIGIBLE", "FIXED_NUMBER", "PERCENTAGE", "CUSTOM"] as const;
export type QuorumType = (typeof QUORUM_TYPES)[number];

export const ADMISSIBILITY_DECIDERS = ["SECRETARY", "CHAIR", "COMMITTEE"] as const;
export type AdmissibilityDecider = (typeof ADMISSIBILITY_DECIDERS)[number];

/** Mirror of config.status_code (ADR-029), asserted by tests/integration/mirrors.spec.ts. Labels live in i18n. */
export const STATUS_CODES = {
  WAITING_REASON: [
    "ALTERNATE_INVESTIGATOR",
    "AUTHORITY_DECISION",
    "BUDGET_APPROVAL",
    "BUSINESS_EXECUTION",
    "COI_REVIEW",
    "CONFIDENTIALITY_CLASSIFICATION",
    "DIGITAL_FORENSICS",
    "DOCUMENTS",
    "DUPLICATION_CHECK",
    "EMPLOYEE_DEFENCE",
    "EMPLOYEE_NOTIFICATION",
    "EXPERT_OPINION",
    "EXTERNAL_INFO",
    "GRIEVANCE_COMPLETION",
    "HEARING",
    "INFO_FROM_SOURCE",
    "INVESTIGATOR_ASSIGNMENT",
    "LEGAL_OPINION",
    "NON_COOPERATION",
    "PARTY_ATTENDANCE",
    "PARTY_DOCUMENTS",
    "QUORUM",
    "REGULATOR_REPORT",
    "SCOPE_DEFINITION",
    "STAKEHOLDER_NOTIFICATION",
    "SUBJECT_STATEMENT",
    "TIE_BREAK",
    "WITNESS",
  ],
  SUSPENSION_REASON: [
    "CONFLICT_OF_INTEREST",
    "FULL",
    "GENERAL",
    "INVESTIGATOR_CHANGE",
    "LAWYER_REQUEST",
    "LEAVE_OR_ILLNESS",
    "NON_COOPERATION",
    "RESOURCE_SHORTAGE",
    "SOVEREIGN_AUTHORITY",
    "SYSTEM_MANDATED",
  ],
  OUTCOME_CODE: [
    "ADMINISTRATIVE_TRACK",
    "CHANNEL_ABUSE",
    "CORRECTIVE_ACTION",
    "DECISION_RECORDED",
    "DUPLICATE",
    "EMERGENCY_CLOSURE",
    "INCONCLUSIVE",
    "INCIDENT_LOGGED",
    "INVESTIGATION_WARRANTED",
    "NON_PROCESSABLE",
    "NOT_FEASIBLE",
    "NOT_SERIOUS",
    "NOT_SUBSTANTIATED",
    "NO_ACTION",
    "NO_PERSONAL_JURISDICTION",
    "OUT_OF_SCOPE",
    "PARTIALLY_SUBSTANTIATED",
    "RECOMMENDATION_ADOPTED",
    "REFERRED_TO_COMMITTEE",
    "REGULATORY_ACTION",
    "SUBSTANTIATED",
    "TRANSFERRED",
    "WITHDRAWN",
  ],
  RETURN_REASON: [
    "APPROVAL_MISSING",
    "INSUFFICIENT_EVIDENCE",
    "MISSING_DOCUMENTS",
    "MISSING_INFORMATION",
    "OTHER",
    "OUT_OF_SCOPE",
    "RECOMMENDATION_INCOMPLETE",
    "SUBJECT_NOT_IDENTIFIED",
    "UNCLEAR_ALLEGATION",
    "WRONG_CHANNEL",
  ],
} as const satisfies Record<string, readonly string[]>;
export type StatusCodeDimension = keyof typeof STATUS_CODES;

/** Proceeding types the case team opens directly; committee and grievance proceedings come from a referral. */
export const OPENABLE_PROCEEDING_TYPES = [
  "PRELIMINARY_REVIEW",
  "INVESTIGATION",
  "LEGAL_REVIEW",
  "AUTHORITY_DECISION",
  "CORRECTIVE_ACTION",
  "REINVESTIGATION",
] as const satisfies readonly ProceedingType[];
export type OpenableProceedingType = (typeof OPENABLE_PROCEEDING_TYPES)[number];

/** States an open proceeding can be moved to (api.update_proceeding_state); closing is api.close_proceeding. */
export const OPEN_PROCEEDING_STATUSES = [
  "OPEN",
  "IN_PROGRESS",
  "AWAITING_REVIEW",
  "AWAITING_APPROVAL",
  "RETURNED",
  "SUSPENDED",
] as const satisfies readonly ProceedingStatus[];
export const CLOSED_PROCEEDING_STATUSES = [
  "CONCLUDED",
  "CANCELLED",
] as const satisfies readonly ProceedingStatus[];

/**
 * Outcome codes not offered to users (DEC-F10): their authority and definitions are not confirmed, so they stay in
 * the catalogue without being exposed. A proceeding already closed with one still shows it.
 */
export const OUTCOME_CODES_NOT_OFFERED = ["NOT_FEASIBLE", "NO_PERSONAL_JURISDICTION"] as const;

/**
 * Where the preliminary review leaves a referral to the Investigation Committee (AMB-018, migration 2030):
 * NOT_REQUIRED for a direct referral or grievance; REFERRED once the case's latest approved preliminary
 * recommendation refers it to the committee; AWAITED otherwise. The database decides again on every referral.
 */
export const PRELIMINARY_REFERRAL_STATES = ["NOT_REQUIRED", "AWAITED", "REFERRED"] as const;
export type PreliminaryReferralState = (typeof PRELIMINARY_REFERRAL_STATES)[number];

/**
 * The case structure for the case team (ADR-017; UX redesign Phase 12 P12-1). Every list is what RLS returns to the
 * caller; findings need the whole case file (`findingsVisible`, authz.has_case_file_basis). Committee seats come as
 * counts per seat and standing only, never as people.
 */
export interface CaseStructure {
  proceedings: ProceedingView[];
  subjects: CaseSubjectView[];
  allegations: AllegationView[];
  findings: FindingView[];
  findingsVisible: boolean;
  committeeProceedings: CommitteeProceedingView[];
  referralApprovals: ReferralApprovalView[];
  /** What the preliminary review leaves for a referral to the Investigation Committee (AMB-018). */
  preliminaryReferral: PreliminaryReferralState;
  committees: CommitteeOption[];
  /** Active codes from config.status_code, by dimension, in code order. */
  statusCodes: Record<StatusCodeDimension, string[]>;
  /** authz.can_record_findings: case editors and assigned investigators, on an active case. */
  canRecordFindings: boolean;
}

export interface ProceedingView {
  id: string;
  sequenceNo: number;
  proceedingType: ProceedingType;
  parentProceedingId: string | null;
  status: ProceedingStatus;
  waitingReason: string | null;
  suspensionReason: string | null;
  outcomeCode: string | null;
  openedAt: string;
  closedAt: string | null;
}

export interface CaseSubjectView {
  id: string;
  displayName: string;
  subjectCategory: SubjectCategory;
  addedAt: string;
}

export interface AllegationView {
  id: string;
  category: string;
  description: string;
  status: string;
  subjectId: string | null;
  policyReference: string | null;
  lawReference: string | null;
  createdAt: string;
}

export interface FindingView {
  id: string;
  allegationId: string;
  subjectId: string | null;
  proceedingId: string;
  versionNo: number;
  result: FindingResult;
  rationale: string;
  recordedAt: string;
  recordedByName: string | null;
  recordedByNameAr: string | null;
}

export interface CommitteeOption {
  id: string;
  code: string;
  kind: CommitteeKind;
  isActive: boolean;
}

export interface CommitteeProceedingView {
  id: string;
  proceedingId: string;
  committeeId: string;
  status: "OPEN" | "CONCLUDED" | "CANCELLED";
  referredAt: string;
  /** The rule set copied at referral (later rule changes never reach the proceeding). */
  rules: {
    quorumType: QuorumType;
    quorumValue: number | null;
    castingVoteEnabled: boolean;
    minutesReviewBusinessDays: number;
    deemedApprovalEnabled: boolean;
    sourceStatus: "OWNER_DEFAULT" | "SOURCE_REQUIRED" | "APPROVED";
  };
  /** The snapshot as counts: per seat, and by standing (voting, non-voting, grievance firewall, not cleared). */
  seats: { seat: CommitteeSeat; count: number }[];
  voting: number;
  firewallRestricted: number;
  notCleared: number;
}

/** DEC-61: the Restricted Case Authority's approval to refer this restricted case to one committee, used once. */
export interface ReferralApprovalView {
  id: string;
  committeeId: string;
  approvedAt: string;
  approvedByName: string | null;
  approvedByNameAr: string | null;
  usedAt: string | null;
  committeeProceedingId: string | null;
}

// ---- Direct referral and preliminary review (migration 1880; Q1–Q20) ------------------------------
/** Status of a direct referral (intake.referral.status). */
export const REFERRAL_STATUSES = [
  "DRAFT",
  "SUBMITTED_TO_HEAD",
  "SUBMITTED_TO_SECRETARY",
  "RETURNED_FOR_COMPLETION",
  "REJECTED",
  "OBJECTED",
  "ACCEPTED",
  "WITHDRAWN",
  // Migration 2040 (DEC-F09): escalated after a repeated rejection, awaiting the escalation target.
  "ESCALATED",
] as const;
export type ReferralStatus = (typeof REFERRAL_STATUSES)[number];

/** History rows of a referral (intake.referral_event.event_type). */
export const REFERRAL_EVENT_TYPES = [
  "CREATED",
  "UPDATED",
  "SUBMITTED",
  "SECTOR_APPROVED",
  "SECTOR_RETURNED",
  "ACCEPTED",
  "RETURNED_FOR_COMPLETION",
  "REJECTED",
  "RESUBMITTED",
  "OBJECTED",
  "WITHDRAWN",
  "COMMENTED",
  // Migration 2040 (DEC-F09).
  "ESCALATED",
  "ESCALATION_DECIDED",
] as const;
export type ReferralEventType = (typeof REFERRAL_EVENT_TYPES)[number];

/** Next actions api.referral_available_actions can offer the caller. */
export const REFERRAL_ACTIONS = [
  "UPDATE",
  "SUBMIT",
  "SECTOR_APPROVE",
  "SECTOR_RETURN",
  "ACCEPT",
  "RETURN_FOR_COMPLETION",
  "REJECT",
  "RESUBMIT",
  "OBJECT",
  // Migration 2040 (DEC-F09): the sector's approver after a repeated rejection; the escalation target's decision.
  "ESCALATE",
  "ACCEPT_ESCALATION",
  "UPHOLD_REJECTION",
  "WITHDRAW",
  "COMMENT",
] as const;
export type ReferralAction = (typeof REFERRAL_ACTIONS)[number];

export const SECTOR_POSITIONS = ["HEAD", "MEMBER"] as const;
export type SectorPosition = (typeof SECTOR_POSITIONS)[number];

/** Outcomes a preliminary review may recommend; each is also an OUTCOME_CODE (closures from migration 1980, ADR-036). */
export const PRELIMINARY_OUTCOMES = [
  "NO_ACTION",
  "OUT_OF_SCOPE",
  "DUPLICATE",
  "TRANSFERRED",
  "NON_PROCESSABLE",
  "INVESTIGATION_WARRANTED",
  "REFERRED_TO_COMMITTEE",
  "NOT_SERIOUS",
  "NOT_SUBSTANTIATED",
  "CHANNEL_ABUSE",
  "NOT_FEASIBLE",
  "NO_PERSONAL_JURISDICTION",
] as const;
export type PreliminaryOutcome = (typeof PRELIMINARY_OUTCOMES)[number];

/** Outcomes kept for existing records but not enabled for a new recommendation until their authority and definitions
 *  are confirmed (DEC-F10, migration 2040; the PRELIMINARY_OUTCOME catalogue value is INACTIVE). Never offer them. */
export const PRELIMINARY_OUTCOMES_NOT_ENABLED: readonly PreliminaryOutcome[] = [
  "NOT_FEASIBLE",
  "NO_PERSONAL_JURISDICTION",
];

export const PRELIMINARY_RECOMMENDATION_STATUSES = [
  "AWAITING_REVIEW",
  "AWAITING_APPROVAL",
  "RETURNED",
  "APPROVED",
] as const;
export type PreliminaryRecommendationStatus = (typeof PRELIMINARY_RECOMMENDATION_STATUSES)[number];

export const PRELIMINARY_PREPARER_ROLES = [
  "INVESTIGATOR",
  "LEAD_INVESTIGATOR",
  "COMPLIANCE_SECTION_MANAGER",
  "GRC_DIRECTOR",
] as const;

// ---- Committee meetings, voting and minutes (migration 1890, ADR-020) -----------------------------------
export const MEETING_PURPOSES = ["DELIBERATION", "HEARING"] as const;
export type MeetingPurpose = (typeof MEETING_PURPOSES)[number];
/** TEAMS links come from the manual provider for now (PRODUCTION_SUBSTITUTION_REQUIRED: M365 Teams provider). */
export const MEETING_MODES = ["IN_PERSON", "TEAMS", "HYBRID"] as const;
export type MeetingMode = (typeof MEETING_MODES)[number];
export const MEETING_STATUSES = ["SCHEDULED", "OPEN", "CLOSED", "CANCELLED"] as const;
export type MeetingStatus = (typeof MEETING_STATUSES)[number];
export const MEETING_INVITEE_ROLES = [
  "WITNESS",
  "EXPERT",
  "LEGAL",
  "INFORMATION_PROVIDER",
  "SUBJECT",
  // Migration 2030 (AMB-156): disabled until enabled in committee.invitee_type_rule.
  "INTERPRETER",
] as const;
export type MeetingInviteeRole = (typeof MEETING_INVITEE_ROLES)[number];
/** What a grievance-firewalled member may be invited as (Q46). */
export const FIREWALL_INVITEE_ROLES: readonly MeetingInviteeRole[] = [
  "WITNESS",
  "EXPERT",
  "INFORMATION_PROVIDER",
];
export const COI_STATUSES = ["PENDING", "NO_CONFLICT", "CONFLICT_DECLARED", "NOT_REQUIRED"] as const;
export type CoiStatus = (typeof COI_STATUSES)[number];
/** EXCUSED (a justified absence with a reason) since migration 2000; only PRESENT counts for quorum and votes. */
export const ATTENDANCE_STATUSES = [
  "NOT_RECORDED",
  "PRESENT",
  "ABSENT",
  "EXCUSED_CONFLICT",
  "EXCUSED",
] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];
/** A conflict raised about a meeting participant by another member or the secretary (migration 2000, ADR-038). */
export const MEETING_CONFLICT_CONCERN_STATUSES = ["OPEN", "UPHELD", "DISMISSED"] as const;
export type MeetingConflictConcernStatus = (typeof MEETING_CONFLICT_CONCERN_STATUSES)[number];
/** Who decides a raised conflict, per rule set (DEC-30; SOURCE_REQUIRED, CHAIR by default). */
export const CONFLICT_DECIDERS = ["CHAIR", "SECRETARY"] as const;
export type ConflictDecider = (typeof CONFLICT_DECIDERS)[number];
/** The seat a raised conflict was decided as (DEC-F04, migration 2030: chair, deputy chair, independent authority). */
export const CONFLICT_DECIDED_AS = ["CHAIR", "DEPUTY_CHAIR", "SECRETARY", "CONFLICT_AUTHORITY"] as const;
export type ConflictDecidedAs = (typeof CONFLICT_DECIDED_AS)[number];
/** Formal activations for one meeting (DEC-F03, AMB-041, AMB-042; migration 2030). */
export const MEETING_ACTING_ROLES = ["ACTING_CHAIR", "ACTING_SECRETARY", "ALTERNATE_MEMBER"] as const;
export type MeetingActingRole = (typeof MEETING_ACTING_ROLES)[number];
export const MEETING_ACTING_BASES = ["ABSENT", "CONFLICTED", "INELIGIBLE", "VACANT", "HANDOVER"] as const;
export type MeetingActingBasis = (typeof MEETING_ACTING_BASES)[number];
/** Who sees individual choices after close (AMB-083): never the subject, the grievant or the case team. */
export const BALLOT_SECRECY = ["COMMITTEE_AFTER_CLOSE", "SECRET_BALLOT"] as const;
export type BallotSecrecy = (typeof BALLOT_SECRECY)[number];
/** Dated exceptions to the working week (DEC-F02, migration 2030). */
export const BUSINESS_CALENDAR_DAY_TYPES = ["HOLIDAY", "NON_WORKING_DAY", "WORKING_DAY"] as const;
export type BusinessCalendarDayType = (typeof BUSINESS_CALENDAR_DAY_TYPES)[number];
export const VOTE_TARGET_TYPES = [
  "FINDING",
  "RECOMMENDATION_ITEM",
  "SANCTION",
  "CORRECTIVE_ACTION",
  "PACKAGE",
  "FINAL_PACKAGE",
  "OTHER",
] as const;
export type VoteTargetType = (typeof VOTE_TARGET_TYPES)[number];
export const VOTE_CHOICES = ["APPROVE", "REJECT", "ABSTAIN", "RECUSED", "ABSENT", "UNABLE_TO_VOTE"] as const;
export type VoteChoice = (typeof VOTE_CHOICES)[number];
/** A member's own choices; the secretary records only the non-substantive ones (Q60, N6). */
export const SELF_VOTE_CHOICES: readonly VoteChoice[] = ["APPROVE", "REJECT", "ABSTAIN", "RECUSED"];
export const SECRETARY_RECORDABLE_CHOICES: readonly VoteChoice[] = ["ABSENT", "UNABLE_TO_VOTE", "RECUSED"];
export const VOTE_ITEM_STATUSES = ["OPEN", "AWAITING_CASTING_VOTE", "CLOSED"] as const;
export type VoteItemStatus = (typeof VOTE_ITEM_STATUSES)[number];
export const VOTE_RESULTS = ["APPROVED", "REJECTED", "TIED", "NO_DECISION", "NO_QUORUM"] as const;
export type VoteResult = (typeof VOTE_RESULTS)[number];
export const MINUTES_STATUSES = [
  "IN_REVIEW",
  "CHANGES_REQUESTED",
  "APPROVED",
  "DEEMED_APPROVED",
  "SUPERSEDED",
] as const;
export type MinutesStatus = (typeof MINUTES_STATUSES)[number];

// ---- Recommendations, legal review and authority decisions (migration 1900; ADR-021 to ADR-023) ------------
export const RECOMMENDATION_ITEM_TYPES = [
  "FINDING",
  "DISCIPLINARY_SANCTION",
  "CORRECTIVE_ACTION",
  "GOVERNANCE_REMEDIATION",
  "EXTERNAL_REFERRAL",
  "NO_VIOLATION",
  "CLOSE_WITHOUT_SANCTION",
  "LEGAL_ACTION",
  "OTHER",
] as const;
export type RecommendationItemType = (typeof RECOMMENDATION_ITEM_TYPES)[number];
export const RECOMMENDATION_PACKAGE_STATUSES = [
  "DRAFT",
  "VOTING",
  "ADOPTED",
  "IN_LEGAL_REVIEW",
  "RETURNED_BY_LEGAL",
  "AWAITING_AUTHORITY",
  "RETURNED_BY_AUTHORITY",
  "DECIDED",
] as const;
export type RecommendationPackageStatus = (typeof RECOMMENDATION_PACKAGE_STATUSES)[number];
/** Q87: a free-text sanction is flagged in every view and export. */
export const SANCTION_VERIFICATION_STATUSES = ["CATALOGUE", "PROPOSED_UNVERIFIED", "NOT_APPLICABLE"] as const;
export type SanctionVerificationStatus = (typeof SANCTION_VERIFICATION_STATUSES)[number];
export const LEGAL_OPINIONS = ["CONCURS", "CONCURS_WITH_COMMENTS", "CONFLICTS"] as const;
export type LegalOpinion = (typeof LEGAL_OPINIONS)[number];
export const AUTHORITY_TYPES = ["CEO", "BOARD", "DELEGATED_EXECUTIVE", "OTHER"] as const;
export type AuthorityType = (typeof AUTHORITY_TYPES)[number];
export const AUTHORITY_OUTCOMES = [
  "APPROVE_AS_RECOMMENDED",
  "MODIFY",
  "REJECT",
  "RETURN_TO_COMMITTEE",
  "APPROVE_PARTIALLY",
  "OTHER",
] as const;
export type AuthorityOutcome = (typeof AUTHORITY_OUTCOMES)[number];
export const PACKET_PURPOSES = ["LEGAL_REVIEW", "AUTHORITY_DECISION"] as const;
export type PacketPurpose = (typeof PACKET_PURPOSES)[number];

// ---- Employee defence and grievances (ADR-024, migration 1910) -------------------------------------------
export const SUBMISSION_CHANNELS = [
  "EMPLOYEE_PORTAL",
  "EMAIL",
  "PHYSICAL_SUBMISSION",
  "SECRETARY_ENTRY",
  "BCP_IMPORT",
  "OTHER_AUTHORIZED_CHANNEL",
] as const;
export type SubmissionChannel = (typeof SUBMISSION_CHANNELS)[number];
export const DEFENCE_NOTICE_STATUSES = ["ISSUED", "ACKNOWLEDGED", "RESPONDED", "WITHDRAWN"] as const;
export type DefenceNoticeStatus = (typeof DEFENCE_NOTICE_STATUSES)[number];
// Kinds of employee notice (migration 1990, ADR-037): only a DEFENCE notice has a due date and takes a response; a
// DECISION notice starts the grievance window (Q94).
export const EMPLOYEE_NOTICE_KINDS = ["RIGHTS", "DEFENCE", "DECISION"] as const;
export type EmployeeNoticeKind = (typeof EMPLOYEE_NOTICE_KINDS)[number];
export const GRIEVANCE_KINDS = ["LINKED", "STANDALONE"] as const;
export type GrievanceKind = (typeof GRIEVANCE_KINDS)[number];
export const GRIEVANCE_STATUSES = [
  "RECEIVED",
  "AWAITING_ADMISSIBILITY_DECISION",
  "ADMITTED",
  "INADMISSIBLE",
  "DECIDED",
  "WITHDRAWN",
] as const;
export type GrievanceStatus = (typeof GRIEVANCE_STATUSES)[number];
export const GRIEVANCE_OUTCOMES = [
  "UPHOLD",
  "MODIFY",
  "CANCEL",
  "RETURN_FOR_REINVESTIGATION",
  "REQUEST_COMPLETION",
  "INADMISSIBLE",
  "REJECT_ON_MERITS",
  "PARTIALLY_ACCEPT",
  "CORRECTIVE_ACTION",
  "DISCIPLINARY_ACTION",
  "OTHER_AUTHORIZED_OUTCOME",
] as const;
export type GrievanceOutcome = (typeof GRIEVANCE_OUTCOMES)[number];
export const REINVESTIGATION_PATHS = [
  "SAME_INVESTIGATION_COMMITTEE",
  "NEW_INTERNAL_TEAM",
  "NEW_INVESTIGATOR",
  "EXTERNAL_INVESTIGATOR",
  "TECHNICAL_INVESTIGATION",
  "GRIEVANCE_COMMITTEE_FACT_FINDING",
  "OTHER",
] as const;
export type ReinvestigationPath = (typeof REINVESTIGATION_PATHS)[number];

// ---- Notifications (ADR-025, migration 1920) -------------------------------------------------------------
export const NOTIFICATION_TEMPLATES = [
  "COMMITTEE_SEAT_ASSIGNED",
  "COMMITTEE_SEAT_ENDED",
  "MEETING_INVITATION",
  "MEETING_CANCELLED",
  "MINUTES_REVIEW_REQUESTED",
  "MINUTES_REVIEW_REMINDER",
  "LEGAL_REVIEW_ASSIGNED",
  "DEFENCE_NOTICE_ISSUED",
  "DEFENCE_DUE_REMINDER",
  "GRIEVANCE_RECEIVED",
  "GRIEVANCE_ADMISSIBILITY_DECIDED",
  "GRIEVANCE_OUTCOME_RECORDED",
  "GRIEVANCE_AUTHORITY_APPROVAL_NEEDED",
  "GRIEVANCE_HANDLING_APPROVED",
  // Export builder (migration 1930, ADR-026)
  "EXPORT_APPROVAL_REQUESTED",
  "EXPORT_AUTHORITY_APPROVAL_REQUESTED",
  "EXPORT_DECIDED",
  // Corrective actions (migration 1940, ADR-033)
  "CORRECTIVE_ACTION_ASSIGNED",
  "CORRECTIVE_ACTION_RETURNED",
  "CORRECTIVE_ACTION_CHANGED",
  "CORRECTIVE_ACTION_SUBMITTED",
  "CORRECTIVE_ACTION_DUE",
  "CORRECTIVE_ACTION_OVERDUE",
  // Continuity workbook import (migration 1960, ADR-034)
  "BCP_IMPORT_APPROVAL_REQUESTED",
  "BCP_IMPORT_DECIDED",
  // Kinds of employee notice (migration 1990, ADR-037)
  "RIGHTS_NOTICE_ISSUED",
  "DECISION_NOTICE_ISSUED",
  // Meeting conflicts and votes (migration 2030 section 4, DEC-F04, DEC-F01)
  "MEETING_CONFLICT_DECISION_REQUESTED",
  "MEETING_VOTE_OPENED",
  // The admissibility decider, referral and preliminary review steps (migration 2040 item 13, DEC-F17, DEC-F09)
  "GRIEVANCE_ADMISSIBILITY_DECISION_REQUESTED",
  "REFERRAL_SUBMITTED_TO_HEAD",
  "REFERRAL_RETURNED",
  "REFERRAL_SUBMITTED_TO_SECRETARY",
  "REFERRAL_ESCALATED",
  "PRELIMINARY_REVIEW_REQUESTED",
  "PRELIMINARY_APPROVAL_REQUESTED",
  "PRELIMINARY_RETURNED",
] as const;
export type NotificationTemplate = (typeof NOTIFICATION_TEMPLATES)[number];
export const NOTIFICATION_CHANNELS = ["IN_APP", "EMAIL"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];
export const NOTIFICATION_RULE_LAYERS = ["SYSTEM_MANDATORY", "COMMITTEE_DEFAULT", "EVENT_RULE"] as const;
export type NotificationRuleLayer = (typeof NOTIFICATION_RULE_LAYERS)[number];
/** What a notification points at (notify.outbox.object_type after migration 2040). */
export const NOTIFICATION_OBJECT_TYPES = [
  "COMMITTEE",
  "MEETING",
  "MINUTES",
  "LEGAL_REVIEW",
  "DEFENCE_NOTICE",
  "GRIEVANCE",
  "EXPORT",
  "CORRECTIVE_ACTION",
  "BCP_IMPORT",
  "REFERRAL",
  "PRELIMINARY_REVIEW",
] as const;
export type NotificationObjectType = (typeof NOTIFICATION_OBJECT_TYPES)[number];

/** One of the caller's own in-app notifications (UX redesign S4): a template code, a link and times, never content. */
export interface InboxNotification {
  id: string;
  template: NotificationTemplate;
  objectType: NotificationObjectType;
  /** A path with ids only (N18), written by the database. */
  deepLink: string;
  createdAt: string;
  readAt: string | null;
}

/**
 * The caller's setting for one template on one channel. A notification reaches them when the rule in force delivers
 * it and they have not muted it; a mandatory template always delivers and cannot be muted (ADR-025).
 */
export interface NotificationSetting {
  template: NotificationTemplate;
  channel: NotificationChannel;
  mandatory: boolean;
  /** Whether the platform-wide rule (mandatory or event rule) delivers it today. A committee's own default may differ. */
  ruleDelivers: boolean;
  muted: boolean;
}

// ---- Export builder (ADR-026, migration 1930, Q99) ----------------------------------------------------------
export const EXPORT_FORMATS = ["PDF", "XLSX", "EMAIL"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
export const EXPORT_AUDIENCES = ["INTERNAL", "EXTERNAL"] as const;
export type ExportAudience = (typeof EXPORT_AUDIENCES)[number];
/** The active export purposes of the governed catalogue exchange.export_purpose (owner decision DEC-F21, migration
 *  2040): administrable reference data, mirrored here (mirrors.spec). OTHER requires a justification. */
export const EXPORT_PURPOSES = [
  "COMMITTEE_PROCEEDING",
  "LEGAL_REVIEW",
  "COMPETENT_AUTHORITY_DECISION",
  "INTERNAL_MANAGEMENT_REVIEW",
  "RECORDS_REQUIREMENT",
  "REGULATORY_OR_EXTERNAL_AUTHORITY",
  "AUTHORIZED_BUSINESS_NEED",
  "OTHER",
] as const;
export type ExportPurpose = (typeof EXPORT_PURPOSES)[number];
/** Export purposes that require a justification whatever the audience (DEC-F21). */
export const EXPORT_PURPOSES_REQUIRING_JUSTIFICATION: readonly ExportPurpose[] = ["OTHER"];
/** The 1930 purposes, kept inactive in the catalogue for the history of the requests that carry them; never offered
 *  for a new export. */
export const EXPORT_PURPOSES_LEGACY = [
  "AUTHORITY_SUBMISSION",
  "REGULATOR_REQUEST",
  "LEGAL_COUNSEL",
  "INTERNAL_REPORTING",
  "AUDIT",
] as const;
export type ExportPurposeLegacy = (typeof EXPORT_PURPOSES_LEGACY)[number];
/** Exportable content. Evidence is not exportable until UX S2 merges; protected identity never is (N19). */
export const EXPORT_OBJECT_TYPES = [
  "CASE_SUMMARY",
  "FINDING",
  "RECOMMENDATION_PACKAGE",
  "AUTHORITY_DECISION",
  "MINUTES",
] as const;
export type ExportObjectType = (typeof EXPORT_OBJECT_TYPES)[number];
export const EXPORT_STATUSES = [
  "DRAFT",
  "SUBMITTED",
  "APPROVED",
  "GENERATED",
  "SENT",
  "REJECTED",
  "CANCELLED",
] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];

/** One item as the viewer may see it; `content` is null when the item is withheld (N16). */
export interface ExportDocumentItem {
  position: number;
  objectType: ExportObjectType;
  objectId: string;
  included: boolean;
  content: Record<string, unknown> | null;
}

/** The rendered export: what a preview shows, what approvers approve and what generation renders. */
export interface ExportDocument {
  requestId: string;
  caseId: string;
  caseNumber: string;
  classification: Classification;
  format: ExportFormat;
  audience: ExportAudience;
  /** A request created before migration 2040 may carry a legacy purpose. */
  purpose: ExportPurpose | ExportPurposeLegacy;
  externalParty: string | null;
  items: ExportDocumentItem[];
}

/** What a rule in force does to a matching export (SOURCE_REQUIRED rules; NONE switches a code off). */
export const EXPORT_RULE_ACTIONS = [
  "REQUIRE_SECOND_APPROVAL",
  "REQUIRE_AUTHORITY_APPROVAL",
  "REFUSE",
  "NONE",
] as const;
export type ExportRuleAction = (typeof EXPORT_RULE_ACTIONS)[number];

export interface ExportPreview {
  document: ExportDocument;
  hash: string;
  withheld: number;
  approvalsRequired: number;
  /** A restricted case's export also needs its Restricted Case Authority's decision (DEC-61/62 precedent). */
  authorityApprovalRequired: boolean;
  matchedRules: { code: string; action: Exclude<ExportRuleAction, "NONE"> }[];
}

/** Who an EMAIL export goes to: internal users by id (the mail adapter resolves the address), external addresses. */
export type ExportDelivery = { kind: "INTERNAL"; userId: string } | { kind: "EXTERNAL"; email: string };

/** What generation hands to rendering and delivery: the document, its hash, the private key and the recipients. */
export interface GeneratedExport {
  storageKey: string;
  hash: string;
  document: ExportDocument;
  deliverTo: ExportDelivery[];
}

/** What the NotificationSender receives: recipient, template and link. Never case content (§39, N18). */
export interface OutgoingNotification {
  id: string;
  recipientId: string;
  template: NotificationTemplate;
  deepLink: string;
  attempts: number;
}

// ---- Corrective actions (ADR-033, migration 1940, Q72) -----------------------------------------------------
export const CORRECTIVE_ACTION_TYPES = ["CORRECTIVE_ACTION", "GOVERNANCE_REMEDIATION"] as const;
export type CorrectiveActionType = (typeof CORRECTIVE_ACTION_TYPES)[number];
export const CORRECTIVE_ACTION_STATUSES = [
  "OPEN",
  "IN_PROGRESS",
  "PENDING_VERIFICATION",
  "COMPLETED",
  "WAIVED",
] as const;
export type CorrectiveActionStatus = (typeof CORRECTIVE_ACTION_STATUSES)[number];
export const VERIFICATION_DECISIONS = ["VERIFIED", "RETURNED"] as const;
export type VerificationDecision = (typeof VERIFICATION_DECISIONS)[number];
/** What completion must carry; SOURCE_REQUIRED, seeded REFERENCE_REQUIRED (the strictest). */
export const COMPLETION_EVIDENCE_RULES = ["REFERENCE_REQUIRED", "NOTE_ONLY"] as const;
export type CompletionEvidenceRule = (typeof COMPLETION_EVIDENCE_RULES)[number];
export const CORRECTIVE_ACTION_POLICY_SOURCES = ["SOURCE_REQUIRED", "APPROVED"] as const;
export type CorrectiveActionPolicySource = (typeof CORRECTIVE_ACTION_POLICY_SOURCES)[number];
/** The case's execution state, derived from its approved items and their actions; never stored. */
export const EXECUTION_STATES = [
  "NOT_STARTED",
  "IN_PROGRESS",
  "FOLLOW_UP",
  "PARTIALLY_EXECUTED",
  "EXECUTED",
  "OVERDUE",
] as const;
export type ExecutionState = (typeof EXECUTION_STATES)[number];

/** An action as its owner or the case team reads it. The owner never reaches the case behind `caseId`. */
export interface CorrectiveAction {
  id: string;
  caseId: string;
  recommendationItemId: string;
  actionType: CorrectiveActionType;
  sequenceNo: number;
  title: string;
  description: string;
  ownerId: string;
  /** Calendar date in Riyadh, YYYY-MM-DD. */
  dueDate: string;
  status: CorrectiveActionStatus;
  percentComplete: number;
}
