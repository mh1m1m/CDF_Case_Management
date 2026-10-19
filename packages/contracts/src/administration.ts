/**
 * Administration (UX redesign Phase 12, slices P12-8a and P12-8b; ADR-051's P12-8a amendment, ADR-063): the registers
 * each business administrator reads on their own page, and the controls offered there. Each register is read in the
 * administrator's security context from tables whose row-level security returns exactly the register that
 * administrator keeps (coordinator ruling F2, 2026-10-18), and each page opens only where the database says the caller
 * holds its permission. The registers carry ids, codes, dates and the reasons administrators wrote, never case content
 * or a count derived from cases (§21). Since P12-8b the list of pages comes from the database (`api.my_admin_views`,
 * F3), and each control shows only where the page's capability read (`api.admin_*_capabilities`, migration 2127) says
 * its command would accept the caller now. Types and literal lists only.
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
  /**
   * The decree or source reference of the end (2128): recorded with an end dated before the moment it was recorded
   * (the owner's decision F7 = B), and with any end given one. Never changed once recorded.
   */
  endReference: string | null;
  /** `api.admin_committee_capabilities` (2128): whether `api.end_committee_membership` would accept the caller now. */
  mayEnd: boolean;
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
  /** `api.admin_committee_capabilities` (2127): per committee, whether each rule-set command accepts the caller. */
  ruleControls: AdminRuleSetControls[];
  /** Today in Riyadh by the database's clock: a new version of the rules starts after it. */
  today: string;
  people: AccountName[];
  views: AdminView[];
}

/**
 * A committee's rule-set controls, as `api.admin_committee_capabilities` (2127) answers them: a whole new version
 * (`api.set_committee_rule_set`) and a revision of the version open now (`api.revise_committee_rule_set`, which needs
 * one). The page offers the revision only: each committee has had a version open since 1870, and the revision carries
 * every option. Every option and the start date are inputs the command answers at submit.
 */
export interface AdminRuleSetControls {
  committeeId: string;
  maySetRuleSet: boolean;
  mayReviseRuleSet: boolean;
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
  /** The decree or source reference of the end (2128), as for a seat. */
  endReference: string | null;
  /** `api.admin_sector_capabilities` (2128): whether `api.end_sector_membership` would accept the caller now. */
  mayEnd: boolean;
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
  /** `api.admin_sector_capabilities` (2127): whether `api.revoke_referral_delegation` would accept the caller now. */
  mayRevoke: boolean;
}

export interface AdminSectorsPage {
  sectors: AdminSector[];
  positions: AdminSectorPosition[];
  delegations: AdminSectorDelegation[];
  /** MAX_SECTOR_APPROVAL_DELEGATION_DAYS (2040): SOURCE_REQUIRED until the CDF source sets it. */
  delegationLimit: { status: SettingStatus; value: string | null };
  /** `api.admin_sector_capabilities` (2127): whether `api.create_sector` would accept the caller now. */
  capabilities: { mayCreateSector: boolean };
  people: AccountName[];
  views: AdminView[];
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
  /** `api.admin_notification_rule_capabilities` (2127): whether `api.set_notification_rule` would accept the caller. */
  capabilities: { maySetRule: boolean };
  /** The database's clock: the start of a rule a form schedules is judged against it. */
  today: string;
  people: AccountName[];
  views: AdminView[];
}

/** The layers an administrator sets (`api.set_notification_rule`); the mandatory layer comes from migrations only. */
export const SETTABLE_NOTIFICATION_LAYERS = ["EVENT_RULE", "COMMITTEE_DEFAULT"] as const;
export type SettableNotificationLayer = (typeof SETTABLE_NOTIFICATION_LAYERS)[number];

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
  sortOrder: number;
  /** The version an edit must name (F13, migration 2127): a change made since is refused, never overwritten. */
  rowVersion: number;
  /** `api.admin_export_policy_capabilities` (2127): whether `api.set_export_purpose` would accept the caller for it. */
  maySet: boolean;
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
  /** `api.admin_export_policy_capabilities` (2127): adding a rule and adding a purpose. */
  capabilities: { maySetRule: boolean; mayAddPurpose: boolean };
  today: string;
  people: AccountName[];
  views: AdminView[];
}

/**
 * The actions a new export rule may take on this page (coordinator ruling on F4, 2026-10-18 21:17): every action
 * `api.set_export_rule` accepts but NONE. Rules add up, so a new rule only ever adds a requirement or a refusal; a new
 * version of an existing rule, which could loosen it, waits for the CDF source and dual control (2160).
 */
export const EXPORT_RULE_ADD_ACTIONS = [
  "REQUIRE_SECOND_APPROVAL",
  "REQUIRE_AUTHORITY_APPROVAL",
  "REFUSE",
] as const satisfies readonly ExportRuleAction[];
export type ExportRuleAddAction = (typeof EXPORT_RULE_ADD_ACTIONS)[number];

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
  /** The roles an escalation step may name (`iam.role`, readable by every signed-in user). */
  roles: AdminRole[];
  /** `api.admin_corrective_action_policy_capabilities` (2127): whether `api.set_corrective_action_policy` would. */
  capabilities: { maySetPolicy: boolean };
  today: string;
  people: AccountName[];
  views: AdminView[];
}

export interface AdminRole {
  code: string;
  nameEn: string;
  nameAr: string;
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
  /** `api.admin_calendar_capabilities` (2127): whether `api.withdraw_business_calendar_day` would accept the caller. */
  mayWithdraw: boolean;
}

export interface AdminCalendarPage {
  /** BUSINESS_CALENDAR_SOURCE (DEC-F02): SOURCE_REQUIRED until the CDF calendar is connected. */
  source: SettingStatus;
  patterns: AdminWeekPattern[];
  days: AdminCalendarDay[];
  /** Today in Riyadh by the database's clock: the first date a day may be added for, the day before a week's start. */
  today: string;
  /**
   * `api.admin_calendar_capabilities` (2127): whether `api.set_business_calendar_day` and
   * `api.set_business_week_pattern` would accept the caller now. Every input is answered at submit.
   */
  capabilities: { maySetDay: boolean; maySetWeekPattern: boolean };
  people: AccountName[];
  views: AdminView[];
}
