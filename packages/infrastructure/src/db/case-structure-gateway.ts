// CaseStructureGateway over PostgreSQL (ADR-017 to ADR-019, migration 1870; UX redesign Phase 12 P12-1). Reads are
// RLS SELECTs for the case team: proceedings (authz.can_view_proceeding), subjects and allegations
// (authz.can_view_case), findings (also authz.has_case_file_basis), committee proceedings and their snapshot
// (authz.can_view_committee_proceeding), referral approvals (authz.can_view_case), and whether the preliminary review
// referred the case (AMB-018, migration 2030; the case and its preliminary recommendations, authz.can_view_case). The
// committee snapshot leaves as counts per seat and standing, never as people. Writes only call the api.* commands of
// 1870. Every method runs in its own transaction under the caller's security context.
import type {
  AllegationView,
  CaseStructure,
  CaseSubjectView,
  CommitteeOption,
  CommitteeProceedingView,
  CommitteeSeat,
  FindingView,
  ProceedingView,
  ReferralApprovalView,
  StatusCodeDimension,
} from "@cdf/contracts";
import { STATUS_CODES } from "@cdf/contracts";
import type { CaseStructureGateway, UserRequestContext } from "@cdf/application";
import { withUserContext, type Sql, type Tx } from "./security-context";

const iso = (d: Date | string | null): string | null => (d ? new Date(d).toISOString() : null);

type Dated<T, K extends keyof T> = Omit<T, K> & { [P in K]: Date | (null extends T[P] ? null : never) };

export class PostgresCaseStructureGateway implements CaseStructureGateway {
  constructor(private readonly sql: Sql) {}

  private run<T>(ctx: UserRequestContext, fn: (tx: Tx) => Promise<T>) {
    return withUserContext(this.sql, ctx, fn);
  }

  structure(ctx: UserRequestContext, caseId: string): Promise<CaseStructure> {
    return this.run(ctx, async (tx) => {
      const proceedings = await tx<Dated<ProceedingView, "openedAt" | "closedAt">[]>`
        select id, sequence_no as "sequenceNo", proceeding_type as "proceedingType",
               parent_proceeding_id as "parentProceedingId", status, waiting_reason as "waitingReason",
               suspension_reason as "suspensionReason", outcome_code as "outcomeCode",
               opened_at as "openedAt", closed_at as "closedAt"
        from case_mgmt.proceeding where case_id = ${caseId} order by sequence_no`;
      const subjects = await tx<Dated<CaseSubjectView, "addedAt">[]>`
        select s.id, p.display_name as "displayName", s.subject_category as "subjectCategory",
               s.added_at as "addedAt"
        from case_mgmt.case_subject s join case_mgmt.person p on p.id = s.person_id
        where s.case_id = ${caseId} order by s.added_at, s.id`;
      const allegations = await tx<Dated<AllegationView, "createdAt">[]>`
        select id, category, description, status, subject_id as "subjectId",
               policy_reference as "policyReference", law_reference as "lawReference", created_at as "createdAt"
        from case_mgmt.allegation where case_id = ${caseId} order by created_at, id`;
      // Versions recorded in one transaction share recorded_at; version_no keeps them in order.
      const findings = await tx<Dated<FindingView, "recordedAt">[]>`
        select f.id, f.allegation_id as "allegationId", f.subject_id as "subjectId",
               f.proceeding_id as "proceedingId", f.version_no as "versionNo", f.result, f.rationale,
               f.recorded_at as "recordedAt", u.display_name as "recordedByName",
               u.display_name_ar as "recordedByNameAr"
        from case_mgmt.finding f left join iam.user_profile u on u.id = f.recorded_by
        where f.case_id = ${caseId} order by f.recorded_at, f.version_no, f.id`;
      const committeeProceedings = await tx<
        {
          id: string;
          proceedingId: string;
          committeeId: string;
          status: CommitteeProceedingView["status"];
          referredAt: Date;
          rules: Record<string, unknown>;
        }[]
      >`
        select id, proceeding_id as "proceedingId", committee_id as "committeeId", status,
               referred_at as "referredAt", rule_snapshot as rules
        from committee.committee_proceeding where case_id = ${caseId} order by referred_at, id`;
      const seats = await tx<
        {
          committeeProceedingId: string;
          seat: CommitteeSeat;
          count: number;
          voting: number;
          firewall: number;
          notCleared: number;
        }[]
      >`
        select pm.committee_proceeding_id as "committeeProceedingId", pm.seat, count(*)::int as count,
               (count(*) filter (where pm.is_voting))::int as voting,
               (count(*) filter (where pm.firewall_restricted))::int as firewall,
               (count(*) filter (where pm.case_gate_excluded))::int as "notCleared"
        from committee.proceeding_member pm
        join committee.committee_proceeding cp on cp.id = pm.committee_proceeding_id
        where cp.case_id = ${caseId}
        group by pm.committee_proceeding_id, pm.seat`;
      const approvals = await tx<Dated<ReferralApprovalView, "approvedAt" | "usedAt">[]>`
        select a.id, a.committee_id as "committeeId", a.approved_at as "approvedAt",
               u.display_name as "approvedByName", u.display_name_ar as "approvedByNameAr", a.used_at as "usedAt",
               a.committee_proceeding_id as "committeeProceedingId"
        from committee.restricted_referral_approval a left join iam.user_profile u on u.id = a.approved_by
        where a.case_id = ${caseId} order by a.approved_at, a.id`;
      const committees = await tx<CommitteeOption[]>`
        select id, code, kind, is_active as "isActive" from committee.committee order by code collate "C"`;
      const codes = await tx<{ dimension: StatusCodeDimension; code: string }[]>`
        select dimension, code from config.status_code where is_active order by dimension, code collate "C"`;
      const [can] = await tx<{ findingsVisible: boolean; canRecordFindings: boolean }[]>`
        select authz.has_case_file_basis(${caseId}) as "findingsVisible",
               authz.can_record_findings(${caseId}) as "canRecordFindings"`;
      // AMB-018: the same question committee.require_preliminary_referral (2030) asks on referral, over the rows RLS
      // returns to a reader of the case (the case, its proceedings and its preliminary recommendations).
      const [preliminary] = await tx<{ direct: boolean; referred: boolean }[]>`
        select c.source_type in ('DIRECT_REFERRAL', 'DIRECT_GRIEVANCE') as direct,
               coalesce((select r.recommended_outcome
                         from case_mgmt.preliminary_recommendation r
                         join case_mgmt.proceeding p on p.id = r.proceeding_id
                         where r.case_id = c.id and r.status = 'APPROVED'
                         order by r.approved_at desc, p.sequence_no desc, r.version_no desc
                         limit 1), '') = 'REFERRED_TO_COMMITTEE' as referred
        from case_mgmt.case_record c where c.id = ${caseId}`;

      const statusCodes = Object.fromEntries(
        (Object.keys(STATUS_CODES) as StatusCodeDimension[]).map((d) => [
          d,
          codes.filter((c) => c.dimension === d).map((c) => c.code),
        ]),
      ) as Record<StatusCodeDimension, string[]>;
      const seatOrder = (s: CommitteeSeat) =>
        ["CHAIR", "DEPUTY_CHAIR", "SECRETARY", "ALTERNATE_SECRETARY", "MEMBER", "ALTERNATE_MEMBER"].indexOf(
          s,
        );

      return {
        proceedings: proceedings.map((p) => ({
          ...p,
          openedAt: iso(p.openedAt)!,
          closedAt: iso(p.closedAt),
        })),
        subjects: subjects.map((s) => ({ ...s, addedAt: iso(s.addedAt)! })),
        allegations: allegations.map((a) => ({ ...a, createdAt: iso(a.createdAt)! })),
        findings: findings.map((f) => ({ ...f, recordedAt: iso(f.recordedAt)! })),
        findingsVisible: can!.findingsVisible,
        committeeProceedings: committeeProceedings.map((cp) => {
          const mine = seats.filter((s) => s.committeeProceedingId === cp.id);
          const r = cp.rules;
          return {
            id: cp.id,
            proceedingId: cp.proceedingId,
            committeeId: cp.committeeId,
            status: cp.status,
            referredAt: iso(cp.referredAt)!,
            rules: {
              quorumType: r.quorum_type as CommitteeProceedingView["rules"]["quorumType"],
              quorumValue:
                r.quorum_value === null || r.quorum_value === undefined ? null : Number(r.quorum_value),
              castingVoteEnabled: r.casting_vote_enabled === true,
              minutesReviewBusinessDays: Number(r.minutes_review_business_days),
              deemedApprovalEnabled: r.deemed_approval_enabled === true,
              sourceStatus: r.source_status as CommitteeProceedingView["rules"]["sourceStatus"],
            },
            seats: mine
              .map((s) => ({ seat: s.seat, count: s.count }))
              .sort((a, b) => seatOrder(a.seat) - seatOrder(b.seat)),
            voting: mine.reduce((n, s) => n + s.voting, 0),
            firewallRestricted: mine.reduce((n, s) => n + s.firewall, 0),
            notCleared: mine.reduce((n, s) => n + s.notCleared, 0),
          };
        }),
        referralApprovals: approvals.map((a) => ({
          ...a,
          approvedAt: iso(a.approvedAt)!,
          usedAt: iso(a.usedAt),
        })),
        preliminaryReferral: preliminary?.direct
          ? "NOT_REQUIRED"
          : preliminary?.referred
            ? "REFERRED"
            : "AWAITED",
        committees: [...committees],
        statusCodes,
        canRecordFindings: can!.canRecordFindings,
      };
    });
  }

  addSubject(ctx: UserRequestContext, i: { caseId: string; displayLabel: string; subjectCategory: string }) {
    return this.run(ctx, async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        select api.add_case_subject(${i.caseId}, ${i.displayLabel}, ${i.subjectCategory}, null) as id`;
      return row!.id;
    });
  }

  addAllegation(
    ctx: UserRequestContext,
    i: {
      caseId: string;
      category: string;
      description: string;
      subjectId?: string;
      policyReference?: string;
      lawReference?: string;
    },
  ) {
    return this.run(ctx, async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        select api.add_allegation(${i.caseId}, ${i.category}, ${i.description}, ${i.subjectId ?? null},
          ${i.policyReference ?? null}, ${i.lawReference ?? null}) as id`;
      return row!.id;
    });
  }

  async linkAllegationSubject(
    ctx: UserRequestContext,
    i: { allegationId: string; subjectId: string; policyReference?: string; lawReference?: string },
  ) {
    await this.run(
      ctx,
      (tx) => tx`
        select api.link_allegation_subject(${i.allegationId}, ${i.subjectId}, ${i.policyReference ?? null},
          ${i.lawReference ?? null})`,
    );
  }

  recordFinding(
    ctx: UserRequestContext,
    i: { allegationId: string; subjectId?: string; proceedingId: string; result: string; rationale: string },
  ) {
    return this.run(ctx, async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        select api.record_finding(${i.allegationId}, ${i.subjectId ?? null}, ${i.proceedingId}, ${i.result},
          ${i.rationale}) as id`;
      return row!.id;
    });
  }

  openProceeding(
    ctx: UserRequestContext,
    i: { caseId: string; proceedingType: string; parentProceedingId?: string; reason: string },
  ) {
    return this.run(ctx, async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        select api.open_proceeding(${i.caseId}, ${i.proceedingType}, ${i.parentProceedingId ?? null}, ${i.reason}) as id`;
      return row!.id;
    });
  }

  async updateProceedingState(
    ctx: UserRequestContext,
    i: {
      proceedingId: string;
      status: string;
      waitingReason?: string;
      suspensionReason?: string;
      reason: string;
    },
  ) {
    await this.run(
      ctx,
      (tx) => tx`
        select api.update_proceeding_state(${i.proceedingId}, ${i.status}, ${i.waitingReason ?? null},
          ${i.suspensionReason ?? null}, ${i.reason})`,
    );
  }

  async closeProceeding(
    ctx: UserRequestContext,
    i: { proceedingId: string; status: string; outcomeCode?: string; reason: string },
  ) {
    await this.run(
      ctx,
      (tx) => tx`
        select api.close_proceeding(${i.proceedingId}, ${i.status}, ${i.outcomeCode ?? null}, ${i.reason})`,
    );
  }

  referToCommittee(
    ctx: UserRequestContext,
    i: { caseId: string; committeeId: string; parentProceedingId?: string; reason: string },
  ) {
    return this.run(ctx, async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        select api.refer_case_to_committee(${i.caseId}, ${i.committeeId}, ${i.parentProceedingId ?? null},
          ${i.reason}) as id`;
      return row!.id;
    });
  }

  approveRestrictedReferral(
    ctx: UserRequestContext,
    i: { caseId: string; committeeId: string; reason: string },
  ) {
    return this.run(ctx, async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        select api.approve_restricted_committee_referral(${i.caseId}, ${i.committeeId}, ${i.reason}) as id`;
      return row!.id;
    });
  }
}
