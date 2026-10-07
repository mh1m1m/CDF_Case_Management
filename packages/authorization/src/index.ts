/**
 * Application-layer authorization pre-checks (§19, first of two enforcement points).
 *
 * These decide what the UI offers and let the BFF refuse early with a clear message.
 * They are NOT the security boundary: every command is re-checked by the database (authz.* and RLS).
 * ROLE_PERMISSIONS mirrors iam.role_permission; tests/integration/mirrors.spec.ts asserts equality.
 */
import type { Actor, Classification, Permission, Role } from "@cdf/contracts";
import { CLASSIFICATION_LEVELS } from "@cdf/contracts";

export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  INTAKE_OFFICER: ["INTAKE_VIEW", "REPORT_MESSAGE_REPLY"],
  TRIAGE_OFFICER: [
    "INTAKE_VIEW",
    "REPORT_MESSAGE_REPLY",
    "REPORT_TRIAGE",
    "CASE_CREATE",
    "WORKFLOW_SCREEN",
    "CONFLICT_DECLARE",
  ],
  CASE_MANAGER: [
    "CASE_VIEW_ALL",
    "CASE_EDIT_ALL",
    "CASE_CREATE",
    "CASE_ASSIGN",
    "WORKFLOW_SCREEN",
    "WORKFLOW_ADVANCE",
    "INVESTIGATION_APPROVE",
    "CONFLICT_MANAGE",
    "CONFLICT_DECLARE",
    "CLASSIFICATION_CHANGE",
    "EVIDENCE_UPLOAD",
    "EVIDENCE_DOWNLOAD",
    "CASE_TASK_ASSIGN",
    "LEGAL_HOLD_REQUEST",
  ],
  LEAD_INVESTIGATOR: [
    "CASE_ASSIGN",
    "WORKFLOW_ADVANCE",
    "CONFLICT_DECLARE",
    "EVIDENCE_UPLOAD",
    "EVIDENCE_DOWNLOAD",
    "LEGAL_HOLD_REQUEST",
  ],
  INVESTIGATOR: ["CONFLICT_DECLARE", "EVIDENCE_UPLOAD", "EVIDENCE_DOWNLOAD"],
  COMMITTEE_SECRETARY: ["CONFLICT_DECLARE"],
  COMMITTEE_CHAIR: ["CONFLICT_DECLARE", "EVIDENCE_DOWNLOAD"],
  COMMITTEE_MEMBER: ["CONFLICT_DECLARE", "EVIDENCE_DOWNLOAD"],
  // ADR-014: no role-wide case discovery; cases are reached through tasks, grants or the controlled lookup.
  LEGAL_REVIEWER: [
    "CONFLICT_DECLARE",
    "EVIDENCE_DOWNLOAD",
    "LEGAL_HOLD_APPLY",
    "LEGAL_HOLD_RELEASE",
    "LEGAL_HOLD_REQUEST",
    "LEGAL_HOLD_REVIEW",
    "CASE_DISCOVER",
    "BREAK_GLASS_REQUEST",
  ],
  HR_REVIEWER: ["CONFLICT_DECLARE", "EVIDENCE_DOWNLOAD"],
  GRC_DIRECTOR: [
    "CASE_VIEW_ALL",
    "CASE_ASSIGN",
    "INVESTIGATION_APPROVE",
    "CLASSIFICATION_CHANGE",
    "RESTRICTED_CASE_GRANT",
    "REPORTER_IDENTITY_REVEAL",
    "CONFLICT_MANAGE",
    "CONFLICT_DECLARE",
    "EVIDENCE_UPLOAD",
    "EVIDENCE_DOWNLOAD",
    "LEGAL_HOLD_APPLY",
    "LEGAL_HOLD_RELEASE",
    "DISPOSITION_APPROVE",
    "ARCHIVE_RECORD_VIEW",
    "CASE_TASK_ASSIGN",
    "LEGAL_HOLD_REQUEST",
    "LEGAL_HOLD_REVIEW",
    "DISPOSITION_TASK_VIEW",
    "BREAK_GLASS_APPROVE",
  ],
  PRIVACY_DPO: ["AUDIT_VIEW", "SECURITY_EVENT_VIEW"],
  INTERNAL_AUDIT: ["AUDIT_VIEW", "ARCHIVE_RECORD_VIEW"],
  SOC_ANALYST: ["SECURITY_EVENT_VIEW"],
  PLATFORM_ADMIN: ["USER_ADMIN", "ROLE_ADMIN"],
  // Records authority is SOURCE_REQUIRED (Delegation of Authority); this is the prototype default (ADR-013 D9).
  // ADR-014: catalogue scope (post-closure, non-restricted) and tasks, never active-case discovery by role.
  RECORDS_OFFICER: [
    "RETENTION_CLASS_ASSIGN",
    "LEGAL_HOLD_APPLY",
    "DISPOSITION_REQUEST",
    "ARCHIVE_RECORD_VIEW",
    "ARCHIVE_RECORD_ADMINISTER",
    "RECORDS_LIFECYCLE_ADMIN",
    "RETENTION_TASK_VIEW",
    "RETENTION_TASK_EXECUTE",
    "DISPOSITION_TASK_VIEW",
    "DISPOSITION_TASK_EXECUTE",
    "LEGAL_HOLD_REQUEST",
    "CASE_DISCOVER",
  ],
  // Defined in later phases; DB_ADMIN never receives application permissions (§21).
  COMPLIANCE: [],
  DECISION_AUTHORITY: [],
  IMPLEMENTATION_OWNER: [],
  REFERRER: [],
  DB_ADMIN: [],
};

export function permissionsForRoles(roles: readonly Role[]): Permission[] {
  return [...new Set(roles.flatMap((r) => ROLE_PERMISSIONS[r] ?? []))].sort();
}

export function can(actor: Pick<Actor, "permissions"> | null | undefined, permission: Permission): boolean {
  return !!actor && actor.permissions.includes(permission);
}

export function withinClearance(actor: Pick<Actor, "clearance">, classification: Classification): boolean {
  return CLASSIFICATION_LEVELS.indexOf(actor.clearance) >= CLASSIFICATION_LEVELS.indexOf(classification);
}

/** Navigation areas the investigation app shows for an actor. Hidden ≠ forbidden: the server still checks. */
export function navigationFor(actor: Pick<Actor, "permissions">) {
  return {
    intake: can(actor, "INTAKE_VIEW"),
    cases: actor.permissions.some((p) =>
      ["CASE_VIEW_ALL", "CASE_CREATE", "CONFLICT_DECLARE", "CASE_ASSIGN", "INVESTIGATION_APPROVE"].includes(
        p,
      ),
    ),
    audit: can(actor, "AUDIT_VIEW") || can(actor, "SECURITY_EVENT_VIEW"),
    // "My work" (tasks, hold requests) and the records catalogue; never a list of all investigations (§18).
    myWork: actor.permissions.some((p) =>
      ["RETENTION_TASK_VIEW", "DISPOSITION_TASK_VIEW", "LEGAL_HOLD_REVIEW", "LEGAL_HOLD_REQUEST"].includes(p),
    ),
    recordsCatalogue: can(actor, "ARCHIVE_RECORD_VIEW"),
    administration: can(actor, "ROLE_ADMIN") || can(actor, "USER_ADMIN"),
  };
}

export * from "./purpose";
