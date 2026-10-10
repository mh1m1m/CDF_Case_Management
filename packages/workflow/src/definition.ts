/**
 * CDF_CASE_V1: TypeScript mirror of infrastructure/supabase/migrations/20261007000600_workflow_definition.sql.
 * The database is authoritative; tests/integration/mirrors.spec.ts asserts both are identical.
 * The UI uses this mirror only to label states and explain transitions, never to authorise them.
 */
import type { Permission } from "@cdf/contracts";

export const WORKFLOW_CODE = "CDF_CASE_V1";

export interface WorkflowState {
  code: string;
  nameEn: string;
  nameAr: string;
  sequence: number;
  isInitial: boolean;
  isTerminal: boolean;
  recordsState: "ACTIVE" | "CLOSED" | "ARCHIVED";
}

export interface WorkflowTransition {
  code: string;
  from: string;
  to: string;
  requiredPermission: Permission;
  reasonRequired: boolean;
  approvalRequired: boolean;
  requiredConditions: string[];
  isSystem: boolean;
  isEnabled: boolean;
  enabledInPhase: number;
}

const s = (
  code: string,
  nameEn: string,
  nameAr: string,
  sequence: number,
  recordsState: WorkflowState["recordsState"] = "ACTIVE",
): WorkflowState => ({
  code,
  nameEn,
  nameAr,
  sequence,
  isInitial: code === "REFERRAL",
  isTerminal: code === "ARCHIVE",
  recordsState,
});

export const STATES: readonly WorkflowState[] = [
  s("REFERRAL", "Referral", "الإحالة", 10),
  s("REGISTERED", "Registered", "مسجلة", 20),
  s("SCREENING", "Screening", "الفحص الأولي", 30),
  s("CONFLICT_CHECK", "Conflict check", "فحص تعارض المصالح", 40),
  s("TRIAGE", "Triage", "الفرز", 50),
  s("JURISDICTION", "Jurisdiction", "تحديد الاختصاص", 60),
  s("INVESTIGATION_APPROVAL", "Investigation approval", "اعتماد التحقيق", 70),
  s("INVESTIGATION", "Investigation", "التحقيق", 80),
  s("FINDINGS", "Findings", "النتائج", 90),
  s("GRC_LEGAL_REVIEW", "GRC / legal review", "مراجعة الحوكمة والقانونية", 100),
  s("COMMITTEE", "Committee", "اللجنة", 110),
  s("DECISION", "Decision", "القرار", 120),
  s("CORRECTIVE_ACTION", "Corrective action", "الإجراءات التصحيحية", 130),
  s("CLOSURE", "Closure", "الإغلاق", 140, "CLOSED"),
  s("ARCHIVE", "Archive", "الأرشيف", 150, "ARCHIVED"),
];

const t = (
  code: string,
  from: string,
  to: string,
  requiredPermission: Permission,
  reasonRequired: boolean,
  approvalRequired: boolean,
  requiredConditions: string[],
  isSystem: boolean,
  isEnabled: boolean,
  enabledInPhase: number,
): WorkflowTransition => ({
  code,
  from,
  to,
  requiredPermission,
  reasonRequired,
  approvalRequired,
  requiredConditions,
  isSystem,
  isEnabled,
  enabledInPhase,
});

export const TRANSITIONS: readonly WorkflowTransition[] = [
  t("REGISTER", "REFERRAL", "REGISTERED", "CASE_CREATE", false, false, [], true, true, 4),
  t("START_SCREENING", "REGISTERED", "SCREENING", "WORKFLOW_SCREEN", false, false, [], false, true, 6),
  t(
    "COMPLETE_SCREENING",
    "SCREENING",
    "CONFLICT_CHECK",
    "WORKFLOW_SCREEN",
    false,
    false,
    ["ALLEGATION_RECORDED"],
    false,
    true,
    6,
  ),
  t("SCREEN_OUT", "SCREENING", "CLOSURE", "WORKFLOW_ADVANCE", true, false, [], false, true, 6),
  t(
    "CLEAR_CONFLICT_CHECK",
    "CONFLICT_CHECK",
    "TRIAGE",
    "WORKFLOW_ADVANCE",
    false,
    false,
    ["ACTOR_NO_CONFLICT_DECLARED", "NO_UNRESOLVED_CONFLICTS"],
    false,
    true,
    6,
  ),
  t(
    "COMPLETE_TRIAGE",
    "TRIAGE",
    "JURISDICTION",
    "WORKFLOW_ADVANCE",
    false,
    false,
    ["PRIORITY_SET"],
    false,
    true,
    6,
  ),
  t(
    "CONFIRM_JURISDICTION",
    "JURISDICTION",
    "INVESTIGATION_APPROVAL",
    "WORKFLOW_ADVANCE",
    true,
    false,
    [],
    false,
    true,
    6,
  ),
  t("OUT_OF_JURISDICTION", "JURISDICTION", "CLOSURE", "WORKFLOW_ADVANCE", true, false, [], false, true, 6),
  t(
    "APPROVE_INVESTIGATION",
    "INVESTIGATION_APPROVAL",
    "INVESTIGATION",
    "INVESTIGATION_APPROVE",
    true,
    true,
    ["INVESTIGATOR_ASSIGNED", "ASSIGNEES_CONFLICT_CLEARED", "NO_UNRESOLVED_CONFLICTS"],
    false,
    true,
    6,
  ),
  t(
    "REJECT_INVESTIGATION",
    "INVESTIGATION_APPROVAL",
    "JURISDICTION",
    "INVESTIGATION_APPROVE",
    true,
    false,
    [],
    false,
    true,
    6,
  ),
  t("SUBMIT_FINDINGS", "INVESTIGATION", "FINDINGS", "WORKFLOW_ADVANCE", false, false, [], false, false, 9),
  t(
    "SUBMIT_FOR_REVIEW",
    "FINDINGS",
    "GRC_LEGAL_REVIEW",
    "WORKFLOW_ADVANCE",
    false,
    true,
    [],
    false,
    false,
    9,
  ),
  t(
    "RETURN_TO_INVESTIGATION",
    "GRC_LEGAL_REVIEW",
    "INVESTIGATION",
    "WORKFLOW_ADVANCE",
    true,
    false,
    [],
    false,
    false,
    9,
  ),
  t(
    "REFER_TO_COMMITTEE",
    "GRC_LEGAL_REVIEW",
    "COMMITTEE",
    "WORKFLOW_ADVANCE",
    false,
    true,
    [],
    false,
    false,
    9,
  ),
  t("CONCLUDE_COMMITTEE", "COMMITTEE", "DECISION", "WORKFLOW_ADVANCE", false, true, [], false, false, 9),
  t(
    "REQUIRE_CORRECTIVE_ACTION",
    "DECISION",
    "CORRECTIVE_ACTION",
    "WORKFLOW_ADVANCE",
    false,
    true,
    [],
    false,
    false,
    10,
  ),
  t("CLOSE_AFTER_DECISION", "DECISION", "CLOSURE", "WORKFLOW_ADVANCE", true, true, [], false, false, 10),
  t(
    "COMPLETE_CORRECTIVE_ACTIONS",
    "CORRECTIVE_ACTION",
    "CLOSURE",
    "WORKFLOW_ADVANCE",
    false,
    true,
    [],
    false,
    false,
    10,
  ),
  t("ARCHIVE_CASE", "CLOSURE", "ARCHIVE", "WORKFLOW_ADVANCE", false, false, [], false, false, 11),
  t("REOPEN_CASE", "CLOSURE", "INVESTIGATION", "INVESTIGATION_APPROVE", true, true, [], false, false, 10),
];
