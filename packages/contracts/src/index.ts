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
] as const;
export type Permission = (typeof PERMISSIONS)[number];

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
