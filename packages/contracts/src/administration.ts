/**
 * Administration (UX redesign Phase 12, slice P12-8a; ADR-051's P12-8a amendment): the registers each business
 * administrator reads on their own page. Each register is read in the administrator's security context from tables
 * whose row-level security returns exactly the register that administrator keeps (coordinator ruling F2, 2026-10-18),
 * and each page opens only where the database says the caller holds its permission. The registers carry ids, codes,
 * dates and the reasons administrators wrote, never case content or a count derived from cases (§21). Types and
 * literal lists only.
 */
import type {
  BallotSecrecy,
  BusinessCalendarDayType,
  Classification,
  CommitteeKind,
  CommitteeSeat,
  CompletionEvidenceRule,
  ConflictDecider,
  CorrectiveActionType,
  ExportObjectType,
  ExportRuleAction,
  NotificationChannel,
  NotificationRuleLayer,
  NotificationTemplate,
  QuorumType,
  SectorPosition,
} from "./index";
import type { RuleSourceStatus } from "./committees";
import type { SettingStatus } from "./export-requests";
import type { AccountName, PackageAuthorityRule } from "./legal-reviews";

/**
 * The pages of Administration, in the order `api.my_areas` picks the area's default view (2045). Each opens to the
 * holders of its own permission: users and roles, committees, sectors, notification rules, export policy (never to
 * whoever holds an export approval permission, DEC-F24), corrective-action policy and the business calendar.
 */
export const ADMIN_VIEWS = [
  "users",
  "committees",
  "sectors",
  "notification-rules",
  "export-policy",
  "corrective-action-policy",
  "calendar",
] as const;
export type AdminView = (typeof ADMIN_VIEWS)[number];

/** Whether an effective-dated row is in force now, starts later or has ended, by the database's clock. */
export const ADMIN_PERIOD_STATES = ["IN_FORCE", "SCHEDULED", "ENDED"] as const;
export type AdminPeriodState = (typeof ADMIN_PERIOD_STATES)[number];

/** A seat correction's kind (AMB-045, migration 2090: committee.membership_correction). */
export const SEAT_CORRECTION_KINDS = [
  "WRONG_HOLDER",
  "WRONG_SEAT",
  "WRONG_DATES",
  "WRONG_REFERENCE",
  "OTHER",
] as const;
export type SeatCorrectionKind = (typeof SEAT_CORRECTION_KINDS)[number];

/** Who decides a grievance's admissibility or a non-admission (DEC-F17, migration 2030). */
export const GRIEVANCE_DECIDERS = ["SECRETARY", "CHAIR", "COMMITTEE", "EXTERNAL"] as const;
export type GrievanceDecider = (typeof GRIEVANCE_DECIDERS)[number];

/** What starts a decision notice's grievance window (DEC-F15, migration 2030). */
export const GRIEVANCE_WINDOW_BASES = ["ISSUE", "DELIVERY", "ACKNOWLEDGEMENT"] as const;
export type GrievanceWindowBasis = (typeof GRIEVANCE_WINDOW_BASES)[number];

/** An item nobody votes APPROVE or REJECT on (AGENT-09 V5): its label, never the chair's decision alone. */
export const NO_SUBSTANTIVE_VOTE_OUTCOMES = ["NO_DECISION", "TIED"] as const;
export type NoSubstantiveVoteOutcome = (typeof NO_SUBSTANTIVE_VOTE_OUTCOMES)[number];

/** Who an export rule applies to (exchange.approval_rule.audience): ANY covers both. */
export const EXPORT_RULE_AUDIENCES = ["INTERNAL", "EXTERNAL", "ANY"] as const;
export type ExportRuleAudience = (typeof EXPORT_RULE_AUDIENCES)[number];

/** Who an overdue corrective action escalates to (DEC-F26, decision.corrective_action_escalation_step). */
export const ESCALATION_RECIPIENT_KINDS = ["OWNER", "CASE_MANAGERS", "ROLE"] as const;
export type EscalationRecipientKind = (typeof ESCALATION_RECIPIENT_KINDS)[number];

// ---- /admin/committees (COMMITTEE_ADMIN) -------------------------------------------------------------------------

export interface AdminCommittee {
  committeeId: string;
  code: string;
  kind: CommitteeKind;
  isActive: boolean;
}

/** A seat as the registry holds it: in office, starting later or ended, with who appointed and who ended it. */
export interface AdminCommitteeSeat {
  membershipId: string;
  committeeId: string;
  userId: string;
  seat: CommitteeSeat;
  effectiveFrom: string;
  effectiveTo: string | null;
  state: AdminPeriodState;
  appointmentReference: string;
  appointedBy: string;
  appointedAt: string;
  endedBy: string | null;
  endedAt: string | null;
  endReason: string | null;
}

/** A correction recorded against a seat (AMB-045): the seat stands as appointed; the correction is read beside it. */
export interface AdminSeatCorrection {
  correctionId: string;
  membershipId: string;
  committeeId: string;
  kind: SeatCorrectionKind;
  reason: string;
  correctedBy: string;
  correctedAt: string;
}

/** One version of a committee's rule set, with every option and where it comes from. Null options are not set. */
export interface AdminRuleSet {
  ruleSetId: string;
  committeeId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  state: AdminPeriodState;
  quorumType: QuorumType;
  quorumValue: number | null;
  castingVoteEnabled: boolean;
  actingChairCastingVote: boolean;
  ballotSecrecy: BallotSecrecy;
  voteRevisionAllowed: boolean;
  dissentNoteAllowed: boolean;
  minutesReviewBusinessDays: number;
  deemedApprovalEnabled: boolean;
  minutesObjectionBlocksDeemed: boolean;
  minimumNoticeDays: number | null;
  conflictDecider: ConflictDecider;
  noSubstantiveVoteOutcome: NoSubstantiveVoteOutcome;
  sanctionRequiresDefenceNotice: boolean;
  grievanceWindowDays: number | null;
  grievanceWindowStartBasis: GrievanceWindowBasis | null;
  admissibilityDecider: GrievanceDecider | null;
  nonAdmissionDecider: GrievanceDecider | null;
  grievanceCompletionDays: number | null;
  sourceStatus: RuleSourceStatus;
  reason: string | null;
  createdBy: string | null;
  createdAt: string;
}

/** An independent conflict authority's appointment (DEC-F04). Read only until dual control (2160). */
export interface AdminConflictAuthority {
  authorityId: string;
  committeeId: string;
  userId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  state: AdminPeriodState;
  appointmentReference: string;
  sourceStatus: "SOURCE_REQUIRED" | "APPROVED";
  appointedBy: string;
  appointedAt: string;
  endedAt: string | null;
}

/** A committee's deactivation or reactivation (AMB-044), as decided. */
export interface AdminCommitteeStatusChange {
  changeId: string;
  committeeId: string;
  isActive: boolean;
  decisionReference: string;
  reason: string;
  changedBy: string;
  changedAt: string;
}

export interface AdminCommitteesPage {
  committees: AdminCommittee[];
  seats: AdminCommitteeSeat[];
  corrections: AdminSeatCorrection[];
  ruleSets: AdminRuleSet[];
  authorities: AdminConflictAuthority[];
  statusChanges: AdminCommitteeStatusChange[];
  /** `api.authority_rule_coverage` (2030): who decides each kind of recommendation, and where no rule is in force. */
  coverage: PackageAuthorityRule[];
  people: AccountName[];
}

// ---- /admin/sectors (SECTOR_ADMIN) -------------------------------------------------------------------------------

export interface AdminSector {
  sectorId: string;
  code: string;
  nameEn: string;
  nameAr: string;
  isActive: boolean;
}

export interface AdminSectorPosition {
  membershipId: string;
  sectorId: string;
  userId: string;
  position: SectorPosition;
  effectiveFrom: string;
  effectiveTo: string | null;
  state: AdminPeriodState;
  appointmentReference: string;
  appointedBy: string | null;
  endedAt: string | null;
  endReason: string | null;
}

/** A sector head's delegation of referral approval (Q1–Q4), as recorded; revoked ones stay. */
export interface AdminSectorDelegation {
  delegationId: string;
  sectorId: string;
  delegatorId: string;
  delegateId: string;
  effectiveFrom: string;
  effectiveTo: string;
  state: AdminPeriodState;
  evidenceReference: string;
  revokedAt: string | null;
}

export interface AdminSectorsPage {
  sectors: AdminSector[];
  positions: AdminSectorPosition[];
  delegations: AdminSectorDelegation[];
  /** MAX_SECTOR_APPROVAL_DELEGATION_DAYS (2040): SOURCE_REQUIRED until the CDF source sets it. */
  delegationLimit: { status: SettingStatus; value: string | null };
  people: AccountName[];
}

// ---- /admin/notification-rules (NOTIFICATION_ADMIN) --------------------------------------------------------------

export interface AdminNotificationTemplate {
  code: NotificationTemplate;
  objectType: string;
  isMandatory: boolean;
}

/** A rule as recorded, in force, starting later or ended. A mandatory rule comes from migrations only. */
export interface AdminNotificationRule {
  ruleId: string;
  layer: NotificationRuleLayer;
  template: NotificationTemplate;
  committeeId: string | null;
  channel: NotificationChannel;
  enabled: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  state: AdminPeriodState;
  createdBy: string | null;
}

export interface AdminNotificationRulesPage {
  templates: AdminNotificationTemplate[];
  rules: AdminNotificationRule[];
  committees: AdminCommittee[];
  people: AccountName[];
}

// ---- /admin/export-policy (authz.is_export_policy_admin) ---------------------------------------------------------

export interface AdminExportRule {
  ruleId: string;
  code: string;
  audience: ExportRuleAudience;
  minClassification: Classification | null;
  objectType: ExportObjectType | null;
  restrictedOnly: boolean;
  action: ExportRuleAction;
  sourceStatus: AdminSourceStatus;
  effectiveFrom: string;
  effectiveTo: string | null;
  state: AdminPeriodState;
}

export interface AdminExportPurpose {
  code: string;
  nameEn: string;
  nameAr: string;
  requiresJustification: boolean;
  isActive: boolean;
  isLegacy: boolean;
  sourceStatus: AdminSourceStatus;
}

/** A member of a stage's approver pool (DEC-F24). Read only until dual control (2160). */
export interface AdminApproverPoolMember {
  memberId: string;
  stage: number;
  userId: string;
  addedBy: string;
  addedAt: string;
  revokedAt: string | null;
}

/** `api.export_approval_config_warnings` (2040): ids, stages and counts only. */
export interface AdminExportWarnings {
  pools: { stage: number; inUse: boolean; activeMembers: number }[];
  warnings: {
    warningId: string;
    requestId: string;
    stage: number;
    raisedAt: string;
    stillBlocked: boolean;
  }[];
}

export interface AdminExportPolicyPage {
  rules: AdminExportRule[];
  purposes: AdminExportPurpose[];
  /** APPROVED_EXTERNAL_DOMAINS (DEC-F22): SOURCE_REQUIRED, and no command keeps the list yet. */
  approvedDomains: { status: SettingStatus; domains: string[] };
  pool: AdminApproverPoolMember[];
  warnings: AdminExportWarnings;
  people: AccountName[];
}

/** Where a governed value comes from (exchange.*, decision.* and config.* source_status). */
export type AdminSourceStatus = "OWNER_DEFAULT" | "SOURCE_REQUIRED" | "APPROVED";

// ---- /admin/corrective-action-policy (CORRECTIVE_ACTION_POLICY_ADMIN) --------------------------------------------

export interface AdminEscalationStep {
  stepNo: number;
  afterDaysOverdue: number;
  recipientKind: EscalationRecipientKind;
  roleCode: string | null;
}

/** One version of an action type's policy (DEC-F25 to DEC-F27). Null periods are not set. */
export interface AdminCorrectiveActionPolicy {
  policyId: string;
  actionType: CorrectiveActionType;
  defaultDueDays: number | null;
  reminderDaysBefore: number | null;
  reminderRepeatDays: number | null;
  escalateAfterDays: number | null;
  overdueAfterDays: number | null;
  completionEvidence: CompletionEvidenceRule;
  allowedEvidenceTypes: string[] | null;
  steps: AdminEscalationStep[];
  sourceStatus: AdminSourceStatus;
  effectiveFrom: string;
  effectiveTo: string | null;
  state: AdminPeriodState;
}

export interface AdminEvidenceType {
  code: string;
  nameEn: string;
  nameAr: string;
  isActive: boolean;
}

export interface AdminActionPool {
  poolId: string;
  code: string;
  name: string;
  isActive: boolean;
  createdBy: string;
  createdAt: string;
  members: { memberId: string; userId: string; addedAt: string; removedAt: string | null }[];
}

export interface AdminCorrectiveActionPolicyPage {
  policies: AdminCorrectiveActionPolicy[];
  evidenceTypes: AdminEvidenceType[];
  pools: AdminActionPool[];
  people: AccountName[];
}

// ---- /admin/calendar (BUSINESS_CALENDAR_ADMIN; DEC-F02) ----------------------------------------------------------

/** A working week from a date: the ISO days (1 Monday … 7 Sunday) that are not working days. */
export interface AdminWeekPattern {
  patternId: string;
  nonWorkingIsoDays: number[];
  effectiveFrom: string;
  effectiveTo: string | null;
  state: AdminPeriodState;
  sourceStatus: AdminSourceStatus;
  reason: string | null;
  createdBy: string | null;
}

/** A dated exception to the working week; a withdrawn one stays, with who withdrew it. */
export interface AdminCalendarDay {
  dayId: string;
  calendarDate: string;
  dayType: BusinessCalendarDayType;
  sourceReference: string | null;
  reason: string;
  recordedBy: string;
  recordedAt: string;
  withdrawnBy: string | null;
  withdrawnAt: string | null;
  withdrawReason: string | null;
}

export interface AdminCalendarPage {
  /** BUSINESS_CALENDAR_SOURCE (DEC-F02): SOURCE_REQUIRED until the CDF calendar is connected. */
  source: SettingStatus;
  patterns: AdminWeekPattern[];
  days: AdminCalendarDay[];
  /** Today in Riyadh by the database's clock: the first date a day may be added for, the day before a week's start. */
  today: string;
  /**
   * The page-level forms' gates (coordinator ruling F1, 2026-10-18): each command's exact caller check,
   * `authz.has_permission('BUSINESS_CALENDAR_ADMIN')`, asked of the database. Every other check is answered at submit.
   */
  capabilities: { maySetDay: boolean; maySetWeekPattern: boolean };
  people: AccountName[];
}
