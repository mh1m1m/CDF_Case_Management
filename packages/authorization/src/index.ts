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
  INTAKE_OFFICER: ["INTAKE_VIEW", "REPORT_MESSAGE_REPLY", "FORM_VIEW", "FORM_PREPARE"],
  TRIAGE_OFFICER: [
    "INTAKE_VIEW",
    "REPORT_MESSAGE_REPLY",
    "REPORT_TRIAGE",
    "CASE_CREATE",
    "WORKFLOW_SCREEN",
    "CONFLICT_DECLARE",
    "FORM_VIEW",
    "FORM_PREPARE",
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
    "FORM_VIEW",
    "FORM_PREPARE",
    "FORM_REVIEW",
  ],
  LEAD_INVESTIGATOR: [
    "CASE_ASSIGN",
    "WORKFLOW_ADVANCE",
    "CONFLICT_DECLARE",
    "EVIDENCE_UPLOAD",
    "EVIDENCE_DOWNLOAD",
    "FORM_VIEW",
    "FORM_PREPARE",
    "FORM_REVIEW",
  ],
  INVESTIGATOR: ["CONFLICT_DECLARE", "EVIDENCE_UPLOAD", "EVIDENCE_DOWNLOAD", "FORM_VIEW", "FORM_PREPARE"],
  COMMITTEE_SECRETARY: ["CONFLICT_DECLARE", "FORM_VIEW", "FORM_PREPARE"],
  COMMITTEE_CHAIR: ["CONFLICT_DECLARE", "EVIDENCE_DOWNLOAD", "FORM_VIEW", "FORM_REVIEW", "FORM_APPROVE"],
  COMMITTEE_MEMBER: ["CONFLICT_DECLARE", "EVIDENCE_DOWNLOAD", "FORM_VIEW"],
  LEGAL_REVIEWER: ["CONFLICT_DECLARE", "EVIDENCE_DOWNLOAD", "FORM_VIEW"],
  HR_REVIEWER: ["CONFLICT_DECLARE", "EVIDENCE_DOWNLOAD", "FORM_VIEW"],
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
    "FORM_VIEW",
    "FORM_REVIEW",
    "FORM_APPROVE",
  ],
  PRIVACY_DPO: ["AUDIT_VIEW", "SECURITY_EVENT_VIEW"],
  INTERNAL_AUDIT: ["AUDIT_VIEW"],
  SOC_ANALYST: ["SECURITY_EVENT_VIEW"],
  PLATFORM_ADMIN: ["USER_ADMIN", "ROLE_ADMIN"],
  // Form entitlements (ADR-011) give these roles their first permissions; the rest come in later phases.
  // DB_ADMIN never receives application permissions (§21).
  COMPLIANCE: ["FORM_VIEW", "FORM_PREPARE", "FORM_REVIEW"],
  DECISION_AUTHORITY: ["FORM_VIEW", "FORM_APPROVE"],
  IMPLEMENTATION_OWNER: ["FORM_VIEW", "FORM_PREPARE"],
  RECORDS_OFFICER: [],
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
    administration: can(actor, "ROLE_ADMIN") || can(actor, "USER_ADMIN"),
  };
}
