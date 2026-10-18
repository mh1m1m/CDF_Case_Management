/**
 * Application-layer authorization pre-checks (§19, first of two enforcement points).
 *
 * These decide what the UI offers and let the BFF refuse early with a clear message.
 * They are NOT the security boundary: every command is re-checked by the database (authz.* and RLS).
 * ROLE_PERMISSIONS mirrors iam.role_permission; tests/integration/mirrors.spec.ts asserts equality.
 */
import type { Actor, Classification, MyArea, Permission, Role, WorkArea } from "@cdf/contracts";
import { CLASSIFICATION_LEVELS, WORK_AREAS } from "@cdf/contracts";

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
    "CASE_TASK_ASSIGN",
    "LEGAL_HOLD_REQUEST",
    "FORM_VIEW",
    "FORM_PREPARE",
    "FORM_REVIEW",
    "EXPORT_REQUEST",
    "EXPORT_APPROVE",
    // Corrective actions (migration 1940, ADR-033): OWNER_DEFAULT, SOURCE_REQUIRED (Delegation of Authority).
    "CORRECTIVE_ACTION_MANAGE",
    // Continuity workbook import (migration 1960, ADR-034): OWNER_DEFAULT, SOURCE_REQUIRED.
    "BCP_IMPORT",
    "BCP_IMPORT_APPROVE",
    "REPORTER_CONVERSATION_HOLD",
  ],
  LEAD_INVESTIGATOR: [
    "CASE_ASSIGN",
    "WORKFLOW_ADVANCE",
    "CONFLICT_DECLARE",
    "EVIDENCE_UPLOAD",
    "EVIDENCE_DOWNLOAD",
    "LEGAL_HOLD_REQUEST",
    "FORM_VIEW",
    "FORM_PREPARE",
    "FORM_REVIEW",
    "PRELIMINARY_PREPARE",
    "EXPORT_REQUEST",
    "BCP_IMPORT",
  ],
  INVESTIGATOR: [
    "CONFLICT_DECLARE",
    "EVIDENCE_UPLOAD",
    "EVIDENCE_DOWNLOAD",
    "FORM_VIEW",
    "FORM_PREPARE",
    "PRELIMINARY_PREPARE",
  ],
  COMMITTEE_SECRETARY: ["CONFLICT_DECLARE", "FORM_VIEW", "FORM_PREPARE"],
  COMMITTEE_CHAIR: ["CONFLICT_DECLARE", "EVIDENCE_DOWNLOAD", "FORM_VIEW", "FORM_REVIEW", "FORM_APPROVE"],
  COMMITTEE_MEMBER: ["CONFLICT_DECLARE", "EVIDENCE_DOWNLOAD", "FORM_VIEW"],
  // ADR-014: no role-wide case discovery; cases are reached through tasks, grants or the controlled lookup.
  LEGAL_REVIEWER: [
    "CONFLICT_DECLARE",
    "EVIDENCE_DOWNLOAD",
    "FORM_VIEW",
    "LEGAL_HOLD_APPLY",
    "LEGAL_HOLD_RELEASE",
    "LEGAL_HOLD_REQUEST",
    "LEGAL_HOLD_REVIEW",
    "CASE_DISCOVER",
    "BREAK_GLASS_REQUEST",
    "LEGAL_OPINION_GIVE",
  ],
  HR_REVIEWER: ["CONFLICT_DECLARE", "EVIDENCE_DOWNLOAD", "FORM_VIEW"],
  GRC_DIRECTOR: [
    "CASE_VIEW_ALL",
    "CASE_ASSIGN",
    "INVESTIGATION_APPROVE",
    "CLASSIFICATION_CHANGE",
    "RESTRICTED_CASE_GRANT",
    "RESTRICTED_CASE_AUTHORITY",
    "REPORTER_IDENTITY_REVEAL",
    "CONFLICT_MANAGE",
    "CONFLICT_DECLARE",
    "EVIDENCE_UPLOAD",
    "EVIDENCE_DOWNLOAD",
    "FORM_VIEW",
    "FORM_REVIEW",
    "FORM_APPROVE",
    "LEGAL_HOLD_APPLY",
    "LEGAL_HOLD_RELEASE",
    "DISPOSITION_APPROVE",
    "ARCHIVE_RECORD_VIEW",
    "CASE_TASK_ASSIGN",
    "LEGAL_HOLD_REQUEST",
    "LEGAL_HOLD_REVIEW",
    "DISPOSITION_TASK_VIEW",
    "BREAK_GLASS_APPROVE",
    "COMMITTEE_ADMIN",
    "PRELIMINARY_PREPARE",
    "PRELIMINARY_REVIEW",
    // Export builder (migration 1930, ADR-026): OWNER_DEFAULT, SOURCE_REQUIRED (Delegation of Authority).
    "EXPORT_REQUEST",
    "EXPORT_APPROVE",
    "EXPORT_SECOND_APPROVE",
    "EXPORT_POLICY_ADMIN",
    // Corrective actions (migration 1940, ADR-033): OWNER_DEFAULT. CORRECTIVE_ACTION_WAIVE is held by no role.
    "CORRECTIVE_ACTION_MANAGE",
    "CORRECTIVE_ACTION_POLICY_ADMIN",
    // Continuity workbook import (migration 1960, ADR-034): OWNER_DEFAULT, SOURCE_REQUIRED.
    "BCP_IMPORT",
    "BCP_IMPORT_APPROVE",
    "REPORTER_CONVERSATION_OVERSEE",
  ],
  PRIVACY_DPO: ["AUDIT_VIEW", "SECURITY_EVENT_VIEW"],
  INTERNAL_AUDIT: ["AUDIT_VIEW", "ARCHIVE_RECORD_VIEW"],
  SOC_ANALYST: ["SECURITY_EVENT_VIEW"],
  // COMMITTEE_ADMIN maintains committee seats and rules only (ADR-019, Q28); it opens no proceeding or case.
  // SECTOR_ADMIN maintains sectors and positions only; it shows no referral or case (migration 1880).
  // NOTIFICATION_ADMIN maintains notification rules only; notifications carry no content (migration 1920).
  // BUSINESS_CALENDAR_ADMIN maintains the working week and holidays only (migration 2030, DEC-F02).
  // EXPORT_POLICY_ADMIN maintains export rules, purposes and approver pools only (migration 2040, DEC-F24); a holder
  // of an export approval permission cannot use it (GRC_DIRECTOR keeps the 1930 grant, inert: see canAdministerExportPolicy).
  PLATFORM_ADMIN: [
    "USER_ADMIN",
    "ROLE_ADMIN",
    "COMMITTEE_ADMIN",
    "SECTOR_ADMIN",
    "NOTIFICATION_ADMIN",
    "BUSINESS_CALENDAR_ADMIN",
    "EXPORT_POLICY_ADMIN",
    // Authorizes continuity-workbook operators only (migration 2040, DEC-F30); no import or case content.
    "BCP_CONTINUITY_ADMIN",
  ],
  // Form entitlements (ADR-011) give these roles their first permissions; the rest come in later phases.
  // DB_ADMIN never receives application permissions (§21).
  COMPLIANCE: ["FORM_VIEW", "FORM_PREPARE", "FORM_REVIEW"],
  DECISION_AUTHORITY: ["FORM_VIEW", "FORM_APPROVE"],
  // CORRECTIVE_ACTION_OWN reaches the owner's own actions only, never the case (migration 1940, ADR-033).
  IMPLEMENTATION_OWNER: ["FORM_VIEW", "FORM_PREPARE", "CORRECTIVE_ACTION_OWN"],
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
  // Direct referral (Q1–Q4): preparing needs a current sector position; approving needs the head position or an
  // active delegation. Preliminary review (Q11–Q20): the GRC Sector Head has no case access, only a purpose-bound
  // view of recommendations awaiting their approval (ADR-031).
  REFERRER: ["REFERRAL_PREPARE"],
  SECTOR_HEAD: ["REFERRAL_PREPARE", "REFERRAL_SECTOR_APPROVE"],
  COMPLIANCE_SECTION_MANAGER: ["PRELIMINARY_PREPARE", "COMMITTEE_ADMIN"],
  GRC_SECTOR_HEAD: ["PRELIMINARY_APPROVE"],
  // AMB-022 (migration 2100): an expert acts through an EXTERNAL_EXPERT task only.
  EXTERNAL_EXPERT: [],
  DB_ADMIN: [],
};

export function permissionsForRoles(roles: readonly Role[]): Permission[] {
  return [...new Set(roles.flatMap((r) => ROLE_PERMISSIONS[r] ?? []))].sort();
}

export function can(actor: Pick<Actor, "permissions"> | null | undefined, permission: Permission): boolean {
  return !!actor && actor.permissions.includes(permission);
}

/** DEC-F24 (migration 2040, authz.is_export_policy_admin): export policy administration is separate from export
 *  approval; whoever holds an approval permission cannot administer export policy. */
export function canAdministerExportPolicy(actor: Pick<Actor, "permissions"> | null | undefined): boolean {
  return (
    can(actor, "EXPORT_POLICY_ADMIN") && !can(actor, "EXPORT_APPROVE") && !can(actor, "EXPORT_SECOND_APPROVE")
  );
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

/**
 * The permission floor of each shell area (audit §20.4). This is the application pre-check that the sidebar
 * intersects with `api.my_areas()`, which adds the live relationship (assignment, grant, task or item). Cases and
 * My Work have no floor because an assignment alone opens them, and My Committees none because a current seat alone
 * does (AMB-047: work follows the seat, never a role; Phase 12 P12-2b, ADR-055). Reporting (S6) does not exist yet.
 * Every route still re-checks in the database: hiding an area is not enforcement.
 */
const AREA_FLOOR: Readonly<Record<WorkArea, readonly Permission[] | "ANY" | "NONE">> = {
  MY_WORK: "ANY",
  INTAKE: ["INTAKE_VIEW"],
  CASES: "ANY",
  COMMITTEE: "ANY",
  RECORDS: [
    "RETENTION_TASK_VIEW",
    "DISPOSITION_TASK_VIEW",
    "LEGAL_HOLD_REVIEW",
    "LEGAL_HOLD_RELEASE",
    "DISPOSITION_APPROVE",
    "ARCHIVE_RECORD_ADMINISTER",
    "ARCHIVE_RECORD_VIEW",
    "CASE_TASK_ASSIGN", // routing a hold request is a Records item
  ],
  OVERSIGHT: ["AUDIT_VIEW", "SECURITY_EVENT_VIEW"],
  ADMINISTRATION: ["USER_ADMIN", "ROLE_ADMIN"],
  REPORTING: "NONE",
};

export function areaPermitted(actor: Pick<Actor, "permissions">, area: WorkArea): boolean {
  const floor = AREA_FLOOR[area];
  if (floor === "ANY") return true;
  if (floor === "NONE") return false;
  return floor.some((p) => can(actor, p));
}

/** The sidebar: the database's areas that pass the floor, in the fixed order, at most one entry per area. */
export function shellAreas(actor: Pick<Actor, "permissions">, areas: readonly MyArea[]): MyArea[] {
  return WORK_AREAS.flatMap((code) => {
    const a = areas.find((x) => x.area === code);
    return a && areaPermitted(actor, code) ? [a] : [];
  });
}

export * from "./purpose";
