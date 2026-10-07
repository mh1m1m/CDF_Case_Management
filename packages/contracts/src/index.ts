/**
 * Shared data contracts between the database command layer, the application layer and the apps.
 * Types only (plus literal lists); no behaviour.
 */

export const CLASSIFICATION_LEVELS = ["INTERNAL", "RESTRICTED", "CONFIDENTIAL", "SECRET"] as const;
export type Classification = (typeof CLASSIFICATION_LEVELS)[number];

export const REPORT_CATEGORIES = [
  "FINANCIAL_MISCONDUCT",
  "FRAUD",
  "CONFLICT_OF_INTEREST",
  "PROCUREMENT",
  "BEHAVIOURAL_MISCONDUCT",
  "ADMINISTRATIVE_VIOLATION",
  "PRIVACY_DATA",
  "CYBERSECURITY",
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
  "REPORTER_IDENTITY_REVEAL",
  "AUDIT_VIEW",
  "SECURITY_EVENT_VIEW",
  "USER_ADMIN",
  "ROLE_ADMIN",
  "EVIDENCE_UPLOAD",
  "EVIDENCE_DOWNLOAD",
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
  reporterMode: "ANONYMOUS" | "IDENTIFIED";
  status: ReportStatus;
  classification: Classification;
  receivedAt: string;
  caseId: string | null;
}

export interface ReportDetail extends IntakeReportItem {
  subjectDescription: string | null;
  description: string;
  incidentDate: string | null;
  location: string | null;
  language: "ar" | "en";
  messages: ReportMessage[];
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
  allegations: { id: string; category: string; description: string; status: string }[];
  assignments: CaseAssignment[];
  transitions: TransitionOption[];
  myConflictStatus: string | null;
}

export interface CaseAssignment {
  id: string;
  userId: string;
  displayName: string;
  assignmentRole: AssignmentRole;
  assignedAt: string;
}

export interface TransitionOption {
  code: string;
  toState: string;
  nameEn: string;
  nameAr: string;
  reasonRequired: boolean;
  allowed: boolean;
  blockingReasons: string[];
}

export interface AuditTimelineEntry {
  seq: number;
  occurredAt: string;
  action: string;
  actorId: string | null;
  actorName: string | null;
  reason: string | null;
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
