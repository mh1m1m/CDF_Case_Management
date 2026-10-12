/**
 * Shared data contracts between the database command layer, the application layer and the apps.
 * Types only (plus literal lists); no behaviour.
 */

import type { RelationshipToFund, ReporterMode } from "./intake";
export * from "./intake";

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
  relationship: "ASSIGNMENT" | "GRANT";
  /** The assignment role, or the grant's purpose (TRIAGE, CASE, COMMITTEE, REVIEW). */
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
  "INTERVIEW_TO_REVIEW",
  "INTERVIEW_TO_APPROVE",
  "INTERVIEW_SOON",
  "HOLD_REQUEST_TO_ROUTE",
  "HOLD_RELEASE_TO_DECIDE",
  "MY_HOLD_REQUEST",
  "MY_HOLD_RELEASE_REQUEST",
  "RETENTION_CLASSIFICATION",
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

export const ACCESS_BASES = ["CLEARANCE", "ROLE", "ASSIGNMENT", "GRANT", "TASK", "BREAK_GLASS"] as const;
export type AccessBasis = (typeof ACCESS_BASES)[number];

/** One line of the caller's own access basis (`api.my_access()`); nobody else's. */
export interface MyAccessEntry {
  basis: AccessBasis;
  code: string;
  caseId: string | null;
  caseNumber: string | null;
  sinceAt: string | null;
  untilAt: string | null;
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
