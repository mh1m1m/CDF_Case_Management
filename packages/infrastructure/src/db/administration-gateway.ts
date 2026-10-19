// AdministrationGateway over PostgreSQL (UX redesign Phase 12, slices P12-8a and P12-8b; ADR-051's P12-8a amendment,
// ADR-063). Each page read runs in the caller's security context and first runs the page's capability read
// (`api.admin_*_capabilities`, migration 2127), which refuses `CDF_FORBIDDEN` exactly where the page's commands refuse
// the caller: a caller without the page's permission never gets an empty register. The register then comes from
// tables whose row-level security returns exactly what that administrator keeps (coordinator ruling F2, 2026-10-18);
// nothing is read past RLS. Lists carry ids, codes, dates and the reasons administrators wrote, never case content or
// a count derived from cases (§21). Whether a row is in force is judged by the database's clock. Each command runs as
// the caller and records whatever it records itself; a date a form sends starts at the beginning of that day in Riyadh,
// and every version a form records is provisional (SOURCE_REQUIRED).
import type {
  AdministrationGateway,
  CompletionRule,
  RuleSetSafeguards,
  UserRequestContext,
} from "@cdf/application";
import { ADMIN_VIEWS } from "@cdf/contracts";
import type {
  AdminCalendarPage,
  AdminCommitteesPage,
  AdminCorrectiveActionPolicyPage,
  AdminExportPolicyPage,
  AdminExportRule,
  AdminNotificationRulesPage,
  AdminPeriodState,
  AdminSectorsPage,
  AdminSourceStatus,
  AdminView,
  BusinessCalendarDayType,
  Classification,
  CommitteeKind,
  CommitteeSeat,
  CompletionEvidenceRule,
  CorrectiveActionType,
  EscalationRecipientKind,
  ExportObjectType,
  ExportRuleAction,
  ExportRuleAudience,
  NotificationChannel,
  NotificationRuleLayer,
  NotificationTemplate,
  PackageAuthorityRule,
  SectorPosition,
  SeatCorrectionKind,
  SettingStatus,
} from "@cdf/contracts";
import { iso, isoOrNull } from "./committee-proceedings-gateway";
import { accountNames } from "./export-gateway";
import { withUserContext, type Sql, type Tx } from "./security-context";

type P<K extends keyof AdministrationGateway> = Parameters<AdministrationGateway[K]>[1];

/**
 * Whether an effective-dated row is in force at `now`, starts later or has ended (`[from, to)`, as every
 * `effective_to` in these registers is exclusive). `now` is the database's clock, read in the same transaction.
 */
export function periodState(from: string, to: string | null, now: string): AdminPeriodState {
  const at = Date.parse(now);
  if (Date.parse(from) > at) return "SCHEDULED";
  if (to !== null && Date.parse(to) <= at) return "ENDED";
  return "IN_FORCE";
}

/** The start of a calendar date in Riyadh (UTC+3 all year), as the week pattern's `effective_from`. */
export function riyadhMidnight(date: string): string {
  return `${date}T00:00:00+03:00`;
}

const unique = (ids: readonly (string | null | undefined)[]): string[] =>
  [...new Set(ids.filter((id): id is string => !!id))].sort();

interface Clock {
  now: string;
  today: string;
}

async function clock(tx: Tx): Promise<Clock> {
  const [c] = await tx<Clock[]>`
    select now()::text as now, (now() at time zone 'Asia/Riyadh')::date::text as today`;
  return { now: iso(c!.now), today: c!.today };
}

/** `api.my_admin_views` (2127, F3): the Administration pages the database opens to the caller, in its order. */
async function viewsOf(tx: Tx): Promise<AdminView[]> {
  const rows = await tx<{ view_code: string }[]>`select v.view_code from api.my_admin_views() v`;
  return rows
    .map((r) => r.view_code)
    .filter((v): v is AdminView => (ADMIN_VIEWS as readonly string[]).includes(v));
}

/** One capability read's answer (2127): booleans, never null; a missing flag reads as no. */
const yes = (v: unknown): boolean => v === true;

async function setting(tx: Tx, key: string): Promise<{ status: SettingStatus; value: string | null }> {
  const [s] = await tx<{ status: SettingStatus; value: string | null }[]>`
    select s.status, s.value from config.setting s where s.key = ${key}`;
  // A setting the migrations never created has no source either.
  return s
    ? { status: s.status, value: s.status === "CONFIGURED" ? s.value : null }
    : { status: "SOURCE_REQUIRED", value: null };
}

interface CommitteeRow {
  id: string;
  code: string;
  kind: CommitteeKind;
  is_active: boolean;
}

const committeesOf = (tx: Tx) => tx<CommitteeRow[]>`
  select c.id, c.code, c.kind, c.is_active from committee.committee c order by c.code collate "C", c.id`;

const toCommittee = (c: CommitteeRow) => ({
  committeeId: c.id,
  code: c.code,
  kind: c.kind,
  isActive: c.is_active,
});

export class PostgresAdministrationGateway implements AdministrationGateway {
  constructor(private readonly sql: Sql) {}

  private run<T>(ctx: UserRequestContext, fn: (tx: Tx) => Promise<T>) {
    return withUserContext(this.sql, ctx, fn);
  }

  /** COMMITTEE_ADMIN: the committee registry (1870, 2030, 2090, 2100) and the authority-rule coverage (2030). */
  committees(ctx: UserRequestContext): Promise<AdminCommitteesPage> {
    return this.run(ctx, async (tx) => {
      // Refuses CDF_FORBIDDEN where the rule-set commands refuse the caller. Each committee also lists its seats with
      // may_end (2128); may_appoint is not read while the appointment forms wait for the owner's F5 card.
      const [cap] = await tx<
        {
          v: {
            committees: {
              committee_id: string;
              may_set_rule_set: boolean;
              may_revise_rule_set: boolean;
              seats?: { membership_id: string; may_end: boolean }[];
            }[];
          };
        }[]
      >`select api.admin_committee_capabilities() as v`;
      const endable = new Map(
        (cap?.v.committees ?? []).flatMap((c) =>
          (c.seats ?? []).map((m) => [m.membership_id, m.may_end] as const),
        ),
      );
      const { now, today } = await clock(tx);
      const committees = await committeesOf(tx);
      const seats = await tx<
        {
          id: string;
          committee_id: string;
          user_id: string;
          seat: CommitteeSeat;
          effective_from: string;
          effective_to: string | null;
          appointment_reference: string;
          appointed_by: string;
          appointed_at: string;
          ended_by: string | null;
          ended_at: string | null;
          end_reason: string | null;
          end_reference: string | null;
        }[]
      >`
        select m.id, m.committee_id, m.user_id, m.seat, m.effective_from::text as effective_from,
               m.effective_to::text as effective_to, m.appointment_reference, m.appointed_by,
               m.appointed_at::text as appointed_at, m.ended_by, m.ended_at::text as ended_at, m.end_reason,
               m.end_reference
          from committee.membership m
         order by m.committee_id, m.effective_from, m.id`;
      const corrections = await tx<
        {
          id: string;
          membership_id: string;
          committee_id: string;
          kind: SeatCorrectionKind;
          reason: string;
          corrected_by: string;
          corrected_at: string;
        }[]
      >`
        select x.id, x.membership_id, x.committee_id, x.kind, x.reason, x.corrected_by, x.corrected_at::text as corrected_at
          from committee.membership_correction x
         order by x.corrected_at, x.id`;
      const ruleSets = await tx<
        {
          id: string;
          committee_id: string;
          effective_from: string;
          effective_to: string | null;
          quorum_type: AdminCommitteesPage["ruleSets"][number]["quorumType"];
          quorum_value: string | null;
          casting_vote_enabled: boolean;
          acting_chair_casting_vote: boolean;
          ballot_secrecy: AdminCommitteesPage["ruleSets"][number]["ballotSecrecy"];
          vote_revision_allowed: boolean;
          dissent_note_allowed: boolean;
          minutes_review_business_days: number;
          deemed_approval_enabled: boolean;
          minutes_objection_blocks_deemed: boolean;
          minimum_notice_days: number | null;
          conflict_decider: AdminCommitteesPage["ruleSets"][number]["conflictDecider"];
          no_substantive_vote_outcome: AdminCommitteesPage["ruleSets"][number]["noSubstantiveVoteOutcome"];
          sanction_requires_defence_notice: boolean;
          grievance_window_days: number | null;
          grievance_window_start_basis: AdminCommitteesPage["ruleSets"][number]["grievanceWindowStartBasis"];
          admissibility_decider: AdminCommitteesPage["ruleSets"][number]["admissibilityDecider"];
          non_admission_decider: AdminCommitteesPage["ruleSets"][number]["nonAdmissionDecider"];
          grievance_completion_days: number | null;
          source_status: AdminCommitteesPage["ruleSets"][number]["sourceStatus"];
          reason: string | null;
          created_by: string | null;
          created_at: string;
        }[]
      >`
        select r.id, r.committee_id, r.effective_from::text as effective_from, r.effective_to::text as effective_to,
               r.quorum_type, r.quorum_value::text as quorum_value, r.casting_vote_enabled,
               r.acting_chair_casting_vote, r.ballot_secrecy, r.vote_revision_allowed, r.dissent_note_allowed,
               r.minutes_review_business_days, r.deemed_approval_enabled, r.minutes_objection_blocks_deemed,
               r.minimum_notice_days, r.conflict_decider, r.no_substantive_vote_outcome,
               r.sanction_requires_defence_notice, r.grievance_window_days, r.grievance_window_start_basis,
               r.admissibility_decider, r.non_admission_decider, r.grievance_completion_days, r.source_status,
               r.reason, r.created_by, r.created_at::text as created_at
          from committee.rule_set r
         order by r.committee_id, r.effective_from, r.id`;
      const authorities = await tx<
        {
          id: string;
          committee_id: string;
          user_id: string;
          effective_from: string;
          effective_to: string | null;
          appointment_reference: string;
          source_status: "SOURCE_REQUIRED" | "APPROVED";
          appointed_by: string;
          appointed_at: string;
          ended_at: string | null;
        }[]
      >`
        select a.id, a.committee_id, a.user_id, a.effective_from::text as effective_from,
               a.effective_to::text as effective_to, a.appointment_reference, a.source_status, a.appointed_by,
               a.appointed_at::text as appointed_at, a.ended_at::text as ended_at
          from committee.conflict_authority a
         order by a.committee_id, a.effective_from, a.id`;
      const statusChanges = await tx<
        {
          id: string;
          committee_id: string;
          is_active: boolean;
          decision_reference: string;
          reason: string;
          changed_by: string;
          changed_at: string;
        }[]
      >`
        select s.id, s.committee_id, s.is_active, s.decision_reference, s.reason, s.changed_by,
               s.changed_at::text as changed_at
          from committee.committee_status_change s
         order by s.changed_at, s.id`;
      const coverage = await tx<
        {
          item_type: PackageAuthorityRule["itemType"];
          rule_id: string | null;
          authority_types: PackageAuthorityRule["authorityTypes"] | null;
          source_status: PackageAuthorityRule["sourceStatus"];
          coverage: PackageAuthorityRule["coverage"];
          setting_disagreement: boolean | null;
        }[]
      >`
        select c.item_type, c.rule_id, to_jsonb(c.authority_types) as authority_types, c.source_status, c.coverage,
               c.setting_disagreement
          from api.authority_rule_coverage() c`;
      const people = await accountNames(
        tx,
        unique([
          ...seats.flatMap((s) => [s.user_id, s.appointed_by, s.ended_by]),
          ...corrections.map((c) => c.corrected_by),
          ...ruleSets.map((r) => r.created_by),
          ...authorities.flatMap((a) => [a.user_id, a.appointed_by]),
          ...statusChanges.map((s) => s.changed_by),
        ]),
      );
      const views = await viewsOf(tx);
      return {
        committees: committees.map(toCommittee),
        seats: seats.map((s) => ({
          membershipId: s.id,
          committeeId: s.committee_id,
          userId: s.user_id,
          seat: s.seat,
          effectiveFrom: iso(s.effective_from),
          effectiveTo: isoOrNull(s.effective_to),
          state: periodState(s.effective_from, s.effective_to, now),
          appointmentReference: s.appointment_reference,
          appointedBy: s.appointed_by,
          appointedAt: iso(s.appointed_at),
          endedBy: s.ended_by,
          endedAt: isoOrNull(s.ended_at),
          endReason: s.end_reason,
          endReference: s.end_reference,
          mayEnd: yes(endable.get(s.id)),
        })),
        corrections: corrections.map((c) => ({
          correctionId: c.id,
          membershipId: c.membership_id,
          committeeId: c.committee_id,
          kind: c.kind,
          reason: c.reason,
          correctedBy: c.corrected_by,
          correctedAt: iso(c.corrected_at),
        })),
        ruleSets: ruleSets.map((r) => ({
          ruleSetId: r.id,
          committeeId: r.committee_id,
          effectiveFrom: iso(r.effective_from),
          effectiveTo: isoOrNull(r.effective_to),
          state: periodState(r.effective_from, r.effective_to, now),
          quorumType: r.quorum_type,
          quorumValue: r.quorum_value === null ? null : Number(r.quorum_value),
          castingVoteEnabled: r.casting_vote_enabled,
          actingChairCastingVote: r.acting_chair_casting_vote,
          ballotSecrecy: r.ballot_secrecy,
          voteRevisionAllowed: r.vote_revision_allowed,
          dissentNoteAllowed: r.dissent_note_allowed,
          minutesReviewBusinessDays: r.minutes_review_business_days,
          deemedApprovalEnabled: r.deemed_approval_enabled,
          minutesObjectionBlocksDeemed: r.minutes_objection_blocks_deemed,
          minimumNoticeDays: r.minimum_notice_days,
          conflictDecider: r.conflict_decider,
          noSubstantiveVoteOutcome: r.no_substantive_vote_outcome,
          sanctionRequiresDefenceNotice: r.sanction_requires_defence_notice,
          grievanceWindowDays: r.grievance_window_days,
          grievanceWindowStartBasis: r.grievance_window_start_basis,
          admissibilityDecider: r.admissibility_decider,
          nonAdmissionDecider: r.non_admission_decider,
          grievanceCompletionDays: r.grievance_completion_days,
          sourceStatus: r.source_status,
          reason: r.reason,
          createdBy: r.created_by,
          createdAt: iso(r.created_at),
        })),
        authorities: authorities.map((a) => ({
          authorityId: a.id,
          committeeId: a.committee_id,
          userId: a.user_id,
          effectiveFrom: iso(a.effective_from),
          effectiveTo: isoOrNull(a.effective_to),
          state: periodState(a.effective_from, a.effective_to, now),
          appointmentReference: a.appointment_reference,
          sourceStatus: a.source_status,
          appointedBy: a.appointed_by,
          appointedAt: iso(a.appointed_at),
          endedAt: isoOrNull(a.ended_at),
        })),
        statusChanges: statusChanges.map((s) => ({
          changeId: s.id,
          committeeId: s.committee_id,
          isActive: s.is_active,
          decisionReference: s.decision_reference,
          reason: s.reason,
          changedBy: s.changed_by,
          changedAt: iso(s.changed_at),
        })),
        coverage: coverage.map((c) => ({
          itemType: c.item_type,
          ruleId: c.rule_id,
          authorityTypes: [...(c.authority_types ?? [])],
          sourceStatus: c.source_status,
          coverage: c.coverage,
          settingDisagreement: c.setting_disagreement === true,
        })),
        ruleControls: (cap?.v.committees ?? []).map((c) => ({
          committeeId: c.committee_id,
          maySetRuleSet: yes(c.may_set_rule_set),
          mayReviseRuleSet: yes(c.may_revise_rule_set),
        })),
        today,
        people,
        views,
      };
    });
  }

  /** SECTOR_ADMIN: sectors, every position and every delegation (1880), and the delegation limit (2040). */
  sectors(ctx: UserRequestContext): Promise<AdminSectorsPage> {
    return this.run(ctx, async (tx) => {
      // Refuses CDF_FORBIDDEN where the sector commands refuse the caller. Each sector also lists its positions with
      // may_end (2128); may_appoint is not read while the appointment forms wait for the owner's F5 card.
      const [cap] = await tx<
        {
          v: {
            may_create_sector: boolean;
            delegations: { delegation_id: string; may_revoke: boolean }[];
            sectors?: { sector_id: string; positions: { membership_id: string; may_end: boolean }[] }[];
          };
        }[]
      >`select api.admin_sector_capabilities() as v`;
      const revocable = new Map((cap?.v.delegations ?? []).map((d) => [d.delegation_id, d.may_revoke]));
      const endable = new Map(
        (cap?.v.sectors ?? []).flatMap((x) =>
          (x.positions ?? []).map((m) => [m.membership_id, m.may_end] as const),
        ),
      );
      const { now } = await clock(tx);
      const sectors = await tx<
        { id: string; code: string; name_en: string; name_ar: string; is_active: boolean }[]
      >`
        select s.id, s.code, s.name_en, s.name_ar, s.is_active from iam.sector s order by s.code collate "C", s.id`;
      const positions = await tx<
        {
          id: string;
          sector_id: string;
          user_id: string;
          position: SectorPosition;
          effective_from: string;
          effective_to: string | null;
          appointment_reference: string;
          appointed_by: string | null;
          ended_at: string | null;
          end_reason: string | null;
          end_reference: string | null;
        }[]
      >`
        select m.id, m.sector_id, m.user_id, m.position, m.effective_from::text as effective_from,
               m.effective_to::text as effective_to, m.appointment_reference, m.appointed_by,
               m.ended_at::text as ended_at, m.end_reason, m.end_reference
          from iam.sector_membership m
         order by m.sector_id, m.effective_from, m.id`;
      const delegations = await tx<
        {
          id: string;
          sector_id: string;
          delegator_id: string;
          delegate_id: string;
          effective_from: string;
          effective_to: string;
          evidence_reference: string;
          revoked_at: string | null;
        }[]
      >`
        select d.id, d.sector_id, d.delegator_id, d.delegate_id, d.effective_from::text as effective_from,
               d.effective_to::text as effective_to, d.evidence_reference, d.revoked_at::text as revoked_at
          from iam.sector_delegation d
         order by d.sector_id, d.effective_from, d.id`;
      const delegationLimit = await setting(tx, "MAX_SECTOR_APPROVAL_DELEGATION_DAYS");
      const people = await accountNames(
        tx,
        unique([
          ...positions.flatMap((p) => [p.user_id, p.appointed_by]),
          ...delegations.flatMap((d) => [d.delegator_id, d.delegate_id]),
        ]),
      );
      const views = await viewsOf(tx);
      return {
        sectors: sectors.map((s) => ({
          sectorId: s.id,
          code: s.code,
          nameEn: s.name_en,
          nameAr: s.name_ar,
          isActive: s.is_active,
        })),
        positions: positions.map((p) => ({
          membershipId: p.id,
          sectorId: p.sector_id,
          userId: p.user_id,
          position: p.position,
          effectiveFrom: iso(p.effective_from),
          effectiveTo: isoOrNull(p.effective_to),
          state: periodState(p.effective_from, p.effective_to, now),
          appointmentReference: p.appointment_reference,
          appointedBy: p.appointed_by,
          endedAt: isoOrNull(p.ended_at),
          endReason: p.end_reason,
          endReference: p.end_reference,
          mayEnd: yes(endable.get(p.id)),
        })),
        delegations: delegations.map((d) => ({
          delegationId: d.id,
          sectorId: d.sector_id,
          delegatorId: d.delegator_id,
          delegateId: d.delegate_id,
          effectiveFrom: iso(d.effective_from),
          effectiveTo: iso(d.effective_to),
          // A revoked delegation has ended, whatever its dates said.
          state: d.revoked_at !== null ? "ENDED" : periodState(d.effective_from, d.effective_to, now),
          evidenceReference: d.evidence_reference,
          revokedAt: isoOrNull(d.revoked_at),
          mayRevoke: yes(revocable.get(d.id)),
        })),
        delegationLimit,
        capabilities: { mayCreateSector: yes(cap?.v.may_create_sector) },
        people,
        views,
      };
    });
  }

  /** NOTIFICATION_ADMIN: the templates and every rule of every layer (1920), with the committees defaults name. */
  notificationRules(ctx: UserRequestContext): Promise<AdminNotificationRulesPage> {
    return this.run(ctx, async (tx) => {
      // Refuses CDF_FORBIDDEN where api.set_notification_rule refuses the caller.
      const [cap] = await tx<{ v: { may_set_rule: boolean } }[]>`
        select api.admin_notification_rule_capabilities() as v`;
      const { now, today } = await clock(tx);
      const templates = await tx<
        { code: NotificationTemplate; object_type: string; is_mandatory: boolean }[]
      >`
        select t.code, t.object_type, t.is_mandatory from notify.template t order by t.code collate "C"`;
      const rules = await tx<
        {
          id: string;
          layer: NotificationRuleLayer;
          template_code: NotificationTemplate;
          committee_id: string | null;
          channel: NotificationChannel;
          enabled: boolean;
          effective_from: string;
          effective_to: string | null;
          created_by: string | null;
        }[]
      >`
        select r.id, r.layer, r.template_code, r.committee_id, r.channel, r.enabled,
               r.effective_from::text as effective_from, r.effective_to::text as effective_to, r.created_by
          from notify.rule r
         order by r.template_code collate "C", r.layer collate "C", r.channel collate "C", r.effective_from, r.id`;
      const committees = await committeesOf(tx);
      const people = await accountNames(tx, unique(rules.map((r) => r.created_by)));
      const views = await viewsOf(tx);
      return {
        templates: templates.map((t) => ({
          code: t.code,
          objectType: t.object_type,
          isMandatory: t.is_mandatory,
        })),
        rules: rules.map((r) => ({
          ruleId: r.id,
          layer: r.layer,
          template: r.template_code,
          committeeId: r.committee_id,
          channel: r.channel,
          enabled: r.enabled,
          effectiveFrom: iso(r.effective_from),
          effectiveTo: isoOrNull(r.effective_to),
          state: periodState(r.effective_from, r.effective_to, now),
          createdBy: r.created_by,
        })),
        committees: committees.map(toCommittee),
        capabilities: { maySetRule: yes(cap?.v.may_set_rule) },
        today,
        people,
        views,
      };
    });
  }

  /**
   * The export policy administrator (`authz.is_export_policy_admin()`, DEC-F24): approval rules (1930), the purpose
   * catalogue and the approver pools (2040), the approved-domain setting, and `api.export_approval_config_warnings`.
   */
  exportPolicy(ctx: UserRequestContext): Promise<AdminExportPolicyPage> {
    return this.run(ctx, async (tx) => {
      // Refuses CDF_FORBIDDEN where the export policy commands refuse the caller (DEC-F24).
      const [cap] = await tx<
        {
          v: {
            may_set_rule: boolean;
            may_add_purpose: boolean;
            purposes: { code: string; may_set: boolean }[];
          };
        }[]
      >`select api.admin_export_policy_capabilities() as v`;
      const settable = new Map((cap?.v.purposes ?? []).map((p) => [p.code, p.may_set]));
      const { now, today } = await clock(tx);
      const rules = await tx<
        {
          id: string;
          code: string;
          audience: ExportRuleAudience;
          min_classification: Classification | null;
          object_type: ExportObjectType | null;
          restricted_only: boolean;
          action: ExportRuleAction;
          source_status: AdminSourceStatus;
          effective_from: string;
          effective_to: string | null;
        }[]
      >`
        select r.id, r.code, r.audience, r.min_classification::text as min_classification, r.object_type,
               r.restricted_only, r.action, r.source_status, r.effective_from::text as effective_from,
               r.effective_to::text as effective_to
          from exchange.approval_rule r
         order by r.code collate "C", r.effective_from, r.id`;
      const purposes = await tx<
        {
          code: string;
          name_en: string;
          name_ar: string;
          requires_justification: boolean;
          is_active: boolean;
          is_legacy: boolean;
          source_status: AdminSourceStatus;
          sort_order: number;
          row_version: number;
        }[]
      >`
        select p.code, p.name_en, p.name_ar, p.requires_justification, p.is_active, p.is_legacy, p.source_status,
               p.sort_order, p.row_version
          from exchange.export_purpose p
         order by p.is_legacy, p.sort_order, p.code collate "C"`;
      const domains = await tx<{ domain: string }[]>`
        select d.domain from exchange.approved_external_domain d order by d.domain collate "C"`;
      const domainSetting = await setting(tx, "APPROVED_EXTERNAL_DOMAINS");
      const pool = await tx<
        {
          id: string;
          stage: number;
          user_id: string;
          added_by: string;
          added_at: string;
          revoked_at: string | null;
        }[]
      >`
        select p.id, p.stage, p.user_id, p.added_by, p.added_at::text as added_at, p.revoked_at::text as revoked_at
          from exchange.export_approver_pool p
         order by p.stage, p.added_at, p.id`;
      const [w] = await tx<
        {
          v: {
            pools: { stage: number; in_use: boolean; active_members: number }[] | null;
            warnings:
              | {
                  warning_id: string;
                  request_id: string;
                  stage: number;
                  raised_at: string;
                  still_blocked: boolean;
                }[]
              | null;
          };
        }[]
      >`select api.export_approval_config_warnings() as v`;
      const people = await accountNames(tx, unique(pool.flatMap((p) => [p.user_id, p.added_by])));
      const views = await viewsOf(tx);
      return {
        rules: rules.map((r): AdminExportRule => ({
          ruleId: r.id,
          code: r.code,
          audience: r.audience,
          minClassification: r.min_classification,
          objectType: r.object_type,
          restrictedOnly: r.restricted_only,
          action: r.action,
          sourceStatus: r.source_status,
          effectiveFrom: iso(r.effective_from),
          effectiveTo: isoOrNull(r.effective_to),
          state: periodState(r.effective_from, r.effective_to, now),
        })),
        purposes: purposes.map((p) => ({
          code: p.code,
          nameEn: p.name_en,
          nameAr: p.name_ar,
          requiresJustification: p.requires_justification,
          isActive: p.is_active,
          isLegacy: p.is_legacy,
          sourceStatus: p.source_status,
          sortOrder: p.sort_order,
          rowVersion: p.row_version,
          maySet: yes(settable.get(p.code)),
        })),
        approvedDomains: { status: domainSetting.status, domains: domains.map((d) => d.domain) },
        pool: pool.map((p) => ({
          memberId: p.id,
          stage: p.stage,
          userId: p.user_id,
          addedBy: p.added_by,
          addedAt: iso(p.added_at),
          revokedAt: isoOrNull(p.revoked_at),
        })),
        warnings: {
          pools: (w?.v.pools ?? []).map((p) => ({
            stage: p.stage,
            inUse: p.in_use === true,
            activeMembers: Number(p.active_members),
          })),
          warnings: (w?.v.warnings ?? []).map((x) => ({
            warningId: x.warning_id,
            requestId: x.request_id,
            stage: x.stage,
            raisedAt: iso(x.raised_at),
            stillBlocked: x.still_blocked === true,
          })),
        },
        capabilities: { maySetRule: yes(cap?.v.may_set_rule), mayAddPurpose: yes(cap?.v.may_add_purpose) },
        today,
        people,
        views,
      };
    });
  }

  /** CORRECTIVE_ACTION_POLICY_ADMIN: policy versions with their steps, evidence types and pools (1940, 2040). */
  correctiveActionPolicy(ctx: UserRequestContext): Promise<AdminCorrectiveActionPolicyPage> {
    return this.run(ctx, async (tx) => {
      // Refuses CDF_FORBIDDEN where api.set_corrective_action_policy refuses the caller.
      const [cap] = await tx<{ v: { may_set_policy: boolean } }[]>`
        select api.admin_corrective_action_policy_capabilities() as v`;
      const { now, today } = await clock(tx);
      const policies = await tx<
        {
          id: string;
          action_type: CorrectiveActionType;
          default_due_days: number | null;
          reminder_days_before: number | null;
          reminder_repeat_days: number | null;
          escalate_after_days: number | null;
          overdue_after_days: number | null;
          completion_evidence: CompletionEvidenceRule;
          allowed_evidence_types: string[] | null;
          source_status: AdminSourceStatus;
          effective_from: string;
          effective_to: string | null;
        }[]
      >`
        select p.id, p.action_type, p.default_due_days, p.reminder_days_before, p.reminder_repeat_days,
               p.escalate_after_days, p.overdue_after_days, p.completion_evidence,
               to_jsonb(p.allowed_evidence_types) as allowed_evidence_types, p.source_status,
               p.effective_from::text as effective_from, p.effective_to::text as effective_to
          from decision.corrective_action_policy p
         order by p.action_type collate "C", p.effective_from, p.id`;
      const steps = await tx<
        {
          policy_id: string;
          step_no: number;
          after_days_overdue: number;
          recipient_kind: EscalationRecipientKind;
          role_code: string | null;
        }[]
      >`
        select s.policy_id, s.step_no, s.after_days_overdue, s.recipient_kind, s.role_code
          from decision.corrective_action_escalation_step s
         order by s.policy_id, s.step_no`;
      const evidenceTypes = await tx<
        { code: string; name_en: string; name_ar: string; is_active: boolean }[]
      >`
        select e.code, e.name_en, e.name_ar, e.is_active from decision.corrective_evidence_type e
         order by e.code collate "C"`;
      const pools = await tx<
        {
          id: string;
          code: string;
          name: string;
          is_active: boolean;
          created_by: string;
          created_at: string;
        }[]
      >`
        select p.id, p.code, p.name, p.is_active, p.created_by, p.created_at::text as created_at
          from decision.corrective_action_pool p
         order by p.code collate "C", p.id`;
      const members = await tx<
        { id: string; pool_id: string; user_id: string; added_at: string; removed_at: string | null }[]
      >`
        select m.id, m.pool_id, m.user_id, m.added_at::text as added_at, m.removed_at::text as removed_at
          from decision.corrective_action_pool_member m
         order by m.pool_id, m.added_at, m.id`;
      // The roles an escalation step may name; a technical role never sees a case (§21), so it is not offered.
      const roles = await tx<{ code: string; name_en: string; name_ar: string }[]>`
        select r.code, r.name_en, r.name_ar from iam.role r where not r.is_technical order by r.code collate "C"`;
      const people = await accountNames(
        tx,
        unique([...pools.map((p) => p.created_by), ...members.map((m) => m.user_id)]),
      );
      const views = await viewsOf(tx);
      return {
        policies: policies.map((p) => ({
          policyId: p.id,
          actionType: p.action_type,
          defaultDueDays: p.default_due_days,
          reminderDaysBefore: p.reminder_days_before,
          reminderRepeatDays: p.reminder_repeat_days,
          escalateAfterDays: p.escalate_after_days,
          overdueAfterDays: p.overdue_after_days,
          completionEvidence: p.completion_evidence,
          allowedEvidenceTypes: p.allowed_evidence_types === null ? null : [...p.allowed_evidence_types],
          steps: steps
            .filter((s) => s.policy_id === p.id)
            .map((s) => ({
              stepNo: s.step_no,
              afterDaysOverdue: s.after_days_overdue,
              recipientKind: s.recipient_kind,
              roleCode: s.role_code,
            })),
          sourceStatus: p.source_status,
          effectiveFrom: iso(p.effective_from),
          effectiveTo: isoOrNull(p.effective_to),
          state: periodState(p.effective_from, p.effective_to, now),
        })),
        evidenceTypes: evidenceTypes.map((e) => ({
          code: e.code,
          nameEn: e.name_en,
          nameAr: e.name_ar,
          isActive: e.is_active,
        })),
        pools: pools.map((p) => ({
          poolId: p.id,
          code: p.code,
          name: p.name,
          isActive: p.is_active,
          createdBy: p.created_by,
          createdAt: iso(p.created_at),
          members: members
            .filter((m) => m.pool_id === p.id)
            .map((m) => ({
              memberId: m.id,
              userId: m.user_id,
              addedAt: iso(m.added_at),
              removedAt: isoOrNull(m.removed_at),
            })),
        })),
        roles: roles.map((r) => ({ code: r.code, nameEn: r.name_en, nameAr: r.name_ar })),
        capabilities: { maySetPolicy: yes(cap?.v.may_set_policy) },
        today,
        people,
        views,
      };
    });
  }

  /**
   * BUSINESS_CALENDAR_ADMIN (DEC-F02, 2030): the calendar's source, every week pattern and every dated exception
   * (withdrawn ones too), today in Riyadh, and the forms' gates from `api.admin_calendar_capabilities` (2127): the
   * two page-level forms, and withdrawing each day.
   */
  calendar(ctx: UserRequestContext): Promise<AdminCalendarPage> {
    return this.run(ctx, async (tx) => {
      // Refuses CDF_FORBIDDEN where the calendar commands refuse the caller.
      const [cap] = await tx<
        {
          v: {
            may_set_day: boolean;
            may_set_week_pattern: boolean;
            days: { day_id: string; may_withdraw: boolean }[];
          };
        }[]
      >`select api.admin_calendar_capabilities() as v`;
      const withdrawable = new Map((cap?.v.days ?? []).map((d) => [d.day_id, d.may_withdraw]));
      const { now, today } = await clock(tx);
      const source = await setting(tx, "BUSINESS_CALENDAR_SOURCE");
      const patterns = await tx<
        {
          id: string;
          non_working_isodow: number[];
          effective_from: string;
          effective_to: string | null;
          source_status: AdminSourceStatus;
          reason: string | null;
          created_by: string | null;
        }[]
      >`
        select w.id, to_jsonb(w.non_working_isodow) as non_working_isodow, w.effective_from::text as effective_from,
               w.effective_to::text as effective_to, w.source_status, w.reason, w.created_by
          from config.business_week_pattern w
         order by w.effective_from, w.id`;
      const days = await tx<
        {
          id: string;
          calendar_date: string;
          day_type: BusinessCalendarDayType;
          source_reference: string | null;
          reason: string;
          recorded_by: string;
          recorded_at: string;
          withdrawn_by: string | null;
          withdrawn_at: string | null;
          withdraw_reason: string | null;
        }[]
      >`
        select d.id, d.calendar_date::text as calendar_date, d.day_type, d.source_reference, d.reason, d.recorded_by,
               d.recorded_at::text as recorded_at, d.withdrawn_by, d.withdrawn_at::text as withdrawn_at,
               d.withdraw_reason
          from config.business_calendar_day d
         order by d.calendar_date, d.recorded_at, d.id`;
      const people = await accountNames(
        tx,
        unique([
          ...patterns.map((w) => w.created_by),
          ...days.flatMap((d) => [d.recorded_by, d.withdrawn_by]),
        ]),
      );
      const views = await viewsOf(tx);
      return {
        source: source.status,
        patterns: patterns.map((w) => ({
          patternId: w.id,
          nonWorkingIsoDays: [...w.non_working_isodow],
          effectiveFrom: iso(w.effective_from),
          effectiveTo: isoOrNull(w.effective_to),
          state: periodState(w.effective_from, w.effective_to, now),
          sourceStatus: w.source_status,
          reason: w.reason,
          createdBy: w.created_by,
        })),
        days: days.map((d) => ({
          dayId: d.id,
          calendarDate: d.calendar_date,
          dayType: d.day_type,
          sourceReference: d.source_reference,
          reason: d.reason,
          recordedBy: d.recorded_by,
          recordedAt: iso(d.recorded_at),
          withdrawnBy: d.withdrawn_by,
          withdrawnAt: isoOrNull(d.withdrawn_at),
          withdrawReason: d.withdraw_reason,
          mayWithdraw: yes(withdrawable.get(d.id)),
        })),
        today,
        capabilities: {
          maySetDay: yes(cap?.v.may_set_day),
          maySetWeekPattern: yes(cap?.v.may_set_week_pattern),
        },
        people,
        views,
      };
    });
  }

  setCalendarDay(ctx: UserRequestContext, input: P<"setCalendarDay">): Promise<string> {
    return this.run(ctx, async (tx) => {
      const [r] = await tx<{ id: string }[]>`
        select api.set_business_calendar_day(${input.calendarDate}::date, ${input.dayType},
                                             ${input.sourceReference ?? null}, ${input.reason}) as id`;
      return r!.id;
    });
  }

  /** Always SOURCE_REQUIRED (coordinator ruling F4, 2026-10-18): the form records no source of its own. */
  setWeekPattern(ctx: UserRequestContext, input: P<"setWeekPattern">): Promise<string> {
    return this.run(ctx, async (tx) => {
      const [r] = await tx<{ id: string }[]>`
        select api.set_business_week_pattern(${input.nonWorkingDays}::int[],
                                             ${riyadhMidnight(input.effectiveFrom)}::timestamptz,
                                             'SOURCE_REQUIRED', ${input.reason}) as id`;
      return r!.id;
    });
  }

  withdrawCalendarDay(ctx: UserRequestContext, input: P<"withdrawCalendarDay">): Promise<void> {
    return this.run(ctx, async (tx) => {
      await tx`select api.withdraw_business_calendar_day(${input.dayId}::uuid, ${input.reason})`;
    });
  }

  createSector(ctx: UserRequestContext, input: P<"createSector">): Promise<string> {
    return this.run(ctx, async (tx) => {
      const [r] = await tx<{ id: string }[]>`
        select api.create_sector(${input.code}, ${input.nameEn}, ${input.nameAr}) as id`;
      return r!.id;
    });
  }

  revokeDelegation(ctx: UserRequestContext, input: P<"revokeDelegation">): Promise<void> {
    return this.run(ctx, async (tx) => {
      await tx`select api.revoke_referral_delegation(${input.delegationId}::uuid, ${input.reason})`;
    });
  }

  /**
   * An end now, or from the start of the date in Riyadh (2128). The committee's command takes no empty end, so an end
   * now is now() itself, in the command's own transaction: never before now(), so it needs no reference.
   */
  endCommitteeMembership(ctx: UserRequestContext, input: P<"endCommitteeMembership">): Promise<void> {
    const to = input.effectiveTo === undefined ? null : riyadhMidnight(input.effectiveTo);
    return this.run(ctx, async (tx) => {
      await tx`
        select api.end_committee_membership(${input.membershipId}::uuid, coalesce(${to}::timestamptz, now()),
                                            ${input.reason}, ${input.endReference ?? null})`;
    });
  }

  /** An end now (the command's own default for no date), or from the start of the date in Riyadh (2128). */
  endSectorMembership(ctx: UserRequestContext, input: P<"endSectorMembership">): Promise<void> {
    const to = input.effectiveTo === undefined ? null : riyadhMidnight(input.effectiveTo);
    return this.run(ctx, async (tx) => {
      await tx`
        select api.end_sector_membership(${input.membershipId}::uuid, ${to}::timestamptz, ${input.reason},
                                         ${input.endReference ?? null})`;
    });
  }

  setNotificationRule(ctx: UserRequestContext, input: P<"setNotificationRule">): Promise<string> {
    return this.run(ctx, async (tx) => {
      const [r] = await tx<{ id: string }[]>`
        select api.set_notification_rule(${input.layer}, ${input.templateCode}, ${input.committeeId ?? null}::uuid,
                                         ${input.channel}, ${input.enabled},
                                         ${riyadhMidnight(input.effectiveFrom)}::timestamptz, ${input.reason}) as id`;
      return r!.id;
    });
  }

  /**
   * A rule for a code with none yet (coordinator ruling on F4, 2026-10-18 21:17), always SOURCE_REQUIRED. The code's
   * lock is the command's own (`exchange.approval_rule:<code>`, 2040), taken first so the check and the command see
   * the same register.
   */
  addExportRule(ctx: UserRequestContext, input: P<"addExportRule">): Promise<string> {
    return this.run(ctx, async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext('exchange.approval_rule:' || ${input.code}::text))`;
      const [taken] = await tx<{ taken: boolean }[]>`
        select exists (select 1 from exchange.approval_rule r where r.code = ${input.code}) as taken`;
      if (taken?.taken) throw new Error("CDF_CONFLICT:RULE_CODE_EXISTS");
      const [r] = await tx<{ id: string }[]>`
        select api.set_export_rule(${input.code}, ${input.audience},
                                   ${input.minClassification ?? null}::core.classification_level,
                                   ${input.objectType ?? null}, ${input.restrictedOnly}, ${input.action},
                                   ${riyadhMidnight(input.effectiveFrom)}::timestamptz, 'SOURCE_REQUIRED',
                                   ${input.reason}) as id`;
      return r!.id;
    });
  }

  /** No version for a new code; the version read for a code in the catalogue (F13, 2127). */
  setExportPurpose(ctx: UserRequestContext, input: P<"setExportPurpose">): Promise<void> {
    const expectedVersion = "expectedVersion" in input ? input.expectedVersion : null;
    return this.run(ctx, async (tx) => {
      await tx`
        select api.set_export_purpose(${input.code}, ${input.nameEn}, ${input.nameAr}, ${input.requiresJustification},
                                      ${input.isActive}, ${input.sortOrder}::int, ${input.reason},
                                      ${expectedVersion}::int)`;
    });
  }

  /**
   * The guard reads the action type's versions in force or scheduled under the command's own lock
   * (`decision.corrective_action_policy:<type>`, 2040), so no version can start between the check and the command.
   */
  setCorrectiveActionPolicy(
    ctx: UserRequestContext,
    input: P<"setCorrectiveActionPolicy">,
    guard: (versions: CompletionRule[]) => string | null,
  ): Promise<string> {
    return this.run(ctx, async (tx) => {
      await tx`
        select pg_advisory_xact_lock(hashtext('decision.corrective_action_policy:' || ${input.actionType}::text))`;
      const versions = await tx<
        { completion_evidence: CompletionEvidenceRule; allowed_evidence_types: string[] | null }[]
      >`
        select p.completion_evidence, to_jsonb(p.allowed_evidence_types) as allowed_evidence_types
          from decision.corrective_action_policy p
         where p.action_type = ${input.actionType} and (p.effective_to is null or p.effective_to > now())`;
      const refusal = guard(
        versions.map((v) => ({
          completionEvidence: v.completion_evidence,
          allowedEvidenceTypes: v.allowed_evidence_types === null ? null : [...v.allowed_evidence_types],
        })),
      );
      if (refusal) throw new Error(`CDF_CONFLICT:${refusal}`);
      const steps = input.escalationSteps.map((s) => ({
        after_days_overdue: s.afterDaysOverdue,
        recipient_kind: s.recipientKind,
        role_code: s.roleCode,
      }));
      const [r] = await tx<{ id: string }[]>`
        select api.set_corrective_action_policy(
                 ${input.actionType}, ${input.defaultDueDays ?? null}::int, ${input.reminderDaysBefore ?? null}::int,
                 ${input.escalateAfterDays ?? null}::int, ${input.completionEvidence},
                 ${riyadhMidnight(input.effectiveFrom)}::timestamptz, 'SOURCE_REQUIRED', ${input.reason},
                 ${input.reminderRepeatDays ?? null}::int, ${input.overdueAfterDays ?? null}::int,
                 ${input.allowedEvidenceTypes}::text[], ${tx.json(steps as never)}::jsonb) as id`;
      return r!.id;
    });
  }

  /**
   * The guard reads the committee's versions in force or scheduled, the open one marked, under a lock on the
   * committee's page revisions (`committee.rule_set_revision:<committee>`): the command's own lock is a row lock an
   * application role cannot take first, so this lock is what keeps two revisions from the page from each passing the
   * check against the version the other replaces. A caller who cannot see the committee reads no version, and the
   * command then refuses the caller itself.
   */
  reviseCommitteeRuleSet(
    ctx: UserRequestContext,
    input: P<"reviseCommitteeRuleSet">,
    guard: (versions: RuleSetSafeguards[]) => string | null,
  ): Promise<string> {
    return this.run(ctx, async (tx) => {
      await tx`
        select pg_advisory_xact_lock(hashtext('committee.rule_set_revision:' || ${input.committeeId}::text))`;
      const versions = await tx<
        {
          open: boolean;
          minimum_notice_days: number | null;
          ballot_secrecy: RuleSetSafeguards["ballotSecrecy"];
          dissent_note_allowed: boolean;
          minutes_objection_blocks_deemed: boolean;
          sanction_requires_defence_notice: boolean;
        }[]
      >`
        select r.effective_to is null as open, r.minimum_notice_days, r.ballot_secrecy, r.dissent_note_allowed,
               r.minutes_objection_blocks_deemed, r.sanction_requires_defence_notice
          from committee.rule_set r
         where r.committee_id = ${input.committeeId}::uuid and (r.effective_to is null or r.effective_to > now())`;
      const refusal = guard(
        versions.map((v) => ({
          open: v.open,
          minimumNoticeDays: v.minimum_notice_days,
          ballotSecrecy: v.ballot_secrecy,
          dissentNoteAllowed: v.dissent_note_allowed,
          minutesObjectionBlocksDeemed: v.minutes_objection_blocks_deemed,
          sanctionRequiresDefenceNotice: v.sanction_requires_defence_notice,
        })),
      );
      if (refusal) throw new Error(`CDF_CONFLICT:${refusal}`);
      const [r] = await tx<{ id: string }[]>`
        select api.revise_committee_rule_set(${input.committeeId}::uuid,
                                             ${riyadhMidnight(input.effectiveFrom)}::timestamptz,
                                             ${tx.json(input.changes as never)}::jsonb, 'SOURCE_REQUIRED',
                                             ${input.reason}) as id`;
      return r!.id;
    });
  }

  views(ctx: UserRequestContext): Promise<AdminView[]> {
    return this.run(ctx, viewsOf);
  }
}
