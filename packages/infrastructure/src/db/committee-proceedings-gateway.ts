// CommitteeProceedingsGateway over PostgreSQL (UX redesign Phase 12 P12-2c and P12-3a; ADR-056 and ADR-057,
// migrations 2060, 2086 and 2095). Reads call only the purpose read models api.committee_items_view (R2, with 2095's
// legal review and authority half) and api.committee_scope_choices (R1), the item flags
// (api.recommendation_item_flags) and the sanction catalogue's reference view (decision.sanction_catalogue_entry); the
// gateway renames their keys and reads no case table. Writes only call the package commands. Every method runs in its
// own transaction under the caller's security context.
import type {
  AccountName,
  AllegationChoice,
  AuthorityDecisionView,
  AuthoritySubmissionView,
  CommitteeItemsView,
  CommitteeLabelMode,
  CommitteeScopeChoices,
  FindingChoice,
  FindingVoteView,
  OpinionRevision,
  PackageAuthorityRule,
  PackageItemView,
  PackageLegalReviewRequest,
  RecommendationItemFlag,
  RecommendationPackageView,
  SanctionCatalogueChoice,
  SubjectRef,
  TaintResolution,
} from "@cdf/contracts";
import type { CommitteeProceedingsGateway, UserRequestContext } from "@cdf/application";
import { withUserContext, type Sql, type Tx } from "./security-context";

// ---- The read models' JSON, as the database writes it (snake_case; timestamps as text) -------------------------
export interface RawSubject {
  subject_id: string;
  position: number | string;
  subject_category: SubjectRef["subjectCategory"];
  label: string | null;
}

interface RawItem {
  item_id: string;
  item_type: PackageItemView["itemType"];
  sanction_code: string | null;
  proposed_sanction_text: string | null;
  verification_status: PackageItemView["verificationStatus"];
  description: string;
  case_wide: boolean | null;
  committee_result: PackageItemView["committeeResult"];
  requires_legal_justification: boolean | null;
  exclusivity_group: string | null;
  depends_on: string[] | null;
  subjects: RawSubject[] | null;
  allegations: { allegation_id: string; category: string }[] | null;
  capabilities?: { may_withdraw?: boolean | null } | null;
  taint_resolutions?: TaintResolution[] | null;
}

export interface RawAccount {
  user_id: string;
  display_name: string | null;
  display_name_ar: string | null;
}

export interface RawRevision {
  revision_id: string;
  revision_no: number;
  opinion: OpinionRevision["opinion"];
  opinion_text: string | null;
  given_at: string;
}

interface RawLegalReviewRequest {
  request_id: string;
  package_round: number;
  status: PackageLegalReviewRequest["status"];
  basis: PackageLegalReviewRequest["basis"];
  reason: string;
  requested_at: string;
  reviewer: RawAccount;
  opinion: PackageLegalReviewRequest["opinion"];
  opinion_text: string | null;
  opinion_at: string | null;
  packet_id: string | null;
  revisions: RawRevision[] | null;
  cancellation: { reason: string; cancelled_at: string } | null;
  capabilities?: { may_cancel?: boolean | null } | null;
}

interface RawAuthorityRule {
  item_type: PackageAuthorityRule["itemType"];
  rule_id: string | null;
  authority_types: PackageAuthorityRule["authorityTypes"] | null;
  source_status: PackageAuthorityRule["sourceStatus"];
  coverage: PackageAuthorityRule["coverage"];
  setting_disagreement: boolean | null;
}

interface RawSubmission {
  submission_id: string;
  package_round: number;
  packet_id: string | null;
  basis: AuthoritySubmissionView["basis"];
  submitted_at: string;
  requirements:
    | {
        item_id: string;
        authority_type: AuthoritySubmissionView["requirements"][number]["authorityType"];
        rule_source_status: AuthoritySubmissionView["requirements"][number]["ruleSourceStatus"];
      }[]
    | null;
}

interface RawDecision {
  decision_id: string;
  package_round: number;
  authority_type: AuthorityDecisionView["authorityType"];
  outcome: AuthorityDecisionView["outcome"];
  decided_at: string;
  decided_by_label: string;
  recorded_at: string;
  reason: string | null;
  delegation_reference: string | null;
  source_signature: AuthorityDecisionView["sourceSignature"];
  unsigned_attestation: string | null;
  sources: { position: number; reference: string; is_primary: boolean | null }[] | null;
  scope:
    | {
        item_id: string;
        item_outcome: AuthorityDecisionView["scope"][number]["itemOutcome"];
        modification: string | null;
      }[]
    | null;
  conditions:
    | {
        position: number;
        kind: AuthorityDecisionView["conditions"][number]["kind"];
        item_id: string | null;
        text: string;
        due_date: string | null;
      }[]
    | null;
  superseded: { superseded_by: string; superseded_at: string } | null;
}

interface RawPackage {
  package_id: string;
  sequence_no: number;
  status: RecommendationPackageView["status"];
  round_no: number;
  vote_granularity: RecommendationPackageView["voteGranularity"];
  items: RawItem[] | null;
  capabilities?: Partial<
    Record<
      | "may_add_item"
      | "may_submit_for_vote"
      | "may_record_adoption"
      | "may_return_to_committee"
      | "may_request_legal_review"
      | "may_submit_to_authority"
      | "may_record_authority_decision",
      boolean | null
    >
  > | null;
  open_vote_in?: string[] | null;
  // 2095 (ADR-057).
  request_legal_review_block?: string | null;
  submit_block?: string | null;
  record_block?: string | null;
  record_outcomes?: RecommendationPackageView["recordOutcomes"] | null;
  record_supersedes?: { decisions: number | string; corrective_actions: number | string } | null;
  adopted_at?: string | null;
  decided_at?: string | null;
  legal_review?: { required?: boolean | null; requests?: RawLegalReviewRequest[] | null } | null;
  authority?: {
    rules?: RawAuthorityRule[] | null;
    submissions?: RawSubmission[] | null;
    decisions?: RawDecision[] | null;
    to_decide?:
      | {
          authority_type: AuthorityDecisionView["authorityType"];
          item_ids: string[] | null;
          completes_round: boolean | null;
        }[]
      | null;
  } | null;
}

interface RawFindingVote {
  vote_item_id: string;
  meeting_id: string;
  sequence_no: number;
  status: FindingVoteView["status"];
  finding: {
    finding_id: string;
    version_no: number;
    is_current_version: boolean | null;
    result: FindingVoteView["finding"]["result"];
    proceeding_role: FindingVoteView["finding"]["proceedingRole"];
    allegation: { allegation_id: string; category: string };
    subject: RawSubject | null;
  };
}

interface RawItemsView {
  committee_proceeding_id: string;
  label_mode: CommitteeLabelMode;
  capabilities?: { may_create_package?: boolean | null } | null;
  packages: RawPackage[] | null;
  finding_votes: RawFindingVote[] | null;
}

interface RawScopeChoices {
  committee_proceeding_id: string;
  label_mode: CommitteeLabelMode;
  subjects: RawSubject[] | null;
  allegations:
    | {
        allegation_id: string;
        position: number | string;
        category: string;
        status: AllegationChoice["status"];
        subject_id: string | null;
      }[]
    | null;
  findings:
    | {
        finding_id: string;
        allegation_id: string;
        subject_id: string | null;
        proceeding_role: FindingChoice["proceedingRole"];
        version_no: number;
        result: FindingChoice["result"];
        recorded_at: string;
      }[]
    | null;
}

// ---- Mapping --------------------------------------------------------------------------------------------------
/** A capability or flag the database left out or null reads as false (fail closed). */
export const yes = (v: boolean | null | undefined): boolean => v === true;
export const each = <R, T>(v: readonly R[] | null | undefined, map: (r: R) => T): T[] => (v ?? []).map(map);
/** A timestamp as an ISO instant; the database writes timestamptz as text in its own format. */
export const iso = (v: string): string => new Date(v).toISOString();
export const isoOrNull = (v: string | null | undefined): string | null => (v ? iso(v) : null);

export function account(a: RawAccount): AccountName {
  return { userId: a.user_id, displayName: a.display_name ?? null, displayNameAr: a.display_name_ar ?? null };
}

export function revision(r: RawRevision): OpinionRevision {
  return {
    revisionId: r.revision_id,
    revisionNo: r.revision_no,
    opinion: r.opinion,
    opinionText: r.opinion_text ?? null,
    givenAt: iso(r.given_at),
  };
}

export function subject(s: RawSubject): SubjectRef {
  return {
    subjectId: s.subject_id,
    position: Number(s.position),
    subjectCategory: s.subject_category,
    label: s.label ?? null,
  };
}

function item(i: RawItem, flags: ReadonlyMap<string, RecommendationItemFlag[]>): PackageItemView {
  return {
    itemId: i.item_id,
    itemType: i.item_type,
    sanctionCode: i.sanction_code ?? null,
    proposedSanctionText: i.proposed_sanction_text ?? null,
    verificationStatus: i.verification_status,
    description: i.description,
    caseWide: yes(i.case_wide),
    committeeResult: i.committee_result ?? null,
    requiresLegalJustification: yes(i.requires_legal_justification),
    exclusivityGroup: i.exclusivity_group ?? null,
    dependsOn: [...(i.depends_on ?? [])],
    subjects: each(i.subjects, subject),
    allegations: each(i.allegations, (a) => ({ allegationId: a.allegation_id, category: a.category })),
    flags: flags.get(i.item_id) ?? [],
    taintResolutions: [...(i.taint_resolutions ?? [])],
    capabilities: { mayWithdraw: yes(i.capabilities?.may_withdraw) },
  };
}

function legalRequest(r: RawLegalReviewRequest): PackageLegalReviewRequest {
  return {
    requestId: r.request_id,
    packageRound: r.package_round,
    status: r.status,
    basis: r.basis,
    reason: r.reason,
    requestedAt: iso(r.requested_at),
    reviewer: account(r.reviewer),
    opinion: r.opinion ?? null,
    opinionText: r.opinion_text ?? null,
    opinionAt: isoOrNull(r.opinion_at),
    packetId: r.packet_id ?? null,
    revisions: each(r.revisions, revision),
    cancellation: r.cancellation
      ? { reason: r.cancellation.reason, cancelledAt: iso(r.cancellation.cancelled_at) }
      : null,
    capabilities: { mayCancel: yes(r.capabilities?.may_cancel) },
  };
}

function decision(d: RawDecision): AuthorityDecisionView {
  return {
    decisionId: d.decision_id,
    packageRound: d.package_round,
    authorityType: d.authority_type,
    outcome: d.outcome,
    decidedAt: iso(d.decided_at),
    decidedByLabel: d.decided_by_label,
    recordedAt: iso(d.recorded_at),
    reason: d.reason ?? null,
    delegationReference: d.delegation_reference ?? null,
    sourceSignature: d.source_signature ?? null,
    unsignedAttestation: d.unsigned_attestation ?? null,
    sources: each(d.sources, (x) => ({
      position: x.position,
      reference: x.reference,
      isPrimary: yes(x.is_primary),
    })),
    scope: each(d.scope, (x) => ({
      itemId: x.item_id,
      itemOutcome: x.item_outcome,
      modification: x.modification ?? null,
    })),
    conditions: each(d.conditions, (x) => ({
      position: x.position,
      kind: x.kind,
      itemId: x.item_id ?? null,
      text: x.text,
      dueDate: x.due_date ?? null,
    })),
    superseded: d.superseded
      ? { supersededBy: d.superseded.superseded_by, supersededAt: iso(d.superseded.superseded_at) }
      : null,
  };
}

/** R2 as the page reads it, with the flags of each package's items (`item_id` → flags). */
export function toCommitteeItemsView(
  v: RawItemsView,
  flags: ReadonlyMap<string, RecommendationItemFlag[]> = new Map(),
): CommitteeItemsView {
  return {
    committeeProceedingId: v.committee_proceeding_id,
    labelMode: v.label_mode,
    capabilities: { mayCreatePackage: yes(v.capabilities?.may_create_package) },
    packages: each(v.packages, (p) => ({
      packageId: p.package_id,
      sequenceNo: p.sequence_no,
      status: p.status,
      roundNo: p.round_no,
      voteGranularity: p.vote_granularity,
      items: each(p.items, (i) => item(i, flags)),
      openVoteIn: [...(p.open_vote_in ?? [])],
      capabilities: {
        mayAddItem: yes(p.capabilities?.may_add_item),
        maySubmitForVote: yes(p.capabilities?.may_submit_for_vote),
        mayRecordAdoption: yes(p.capabilities?.may_record_adoption),
        mayReturnToCommittee: yes(p.capabilities?.may_return_to_committee),
        mayRequestLegalReview: yes(p.capabilities?.may_request_legal_review),
        maySubmitToAuthority: yes(p.capabilities?.may_submit_to_authority),
        mayRecordAuthorityDecision: yes(p.capabilities?.may_record_authority_decision),
      },
      requestLegalReviewBlock: p.request_legal_review_block ?? null,
      submitBlock: p.submit_block ?? null,
      recordBlock: p.record_block ?? null,
      recordOutcomes: [...(p.record_outcomes ?? [])],
      recordSupersedes: p.record_supersedes
        ? {
            decisions: Number(p.record_supersedes.decisions),
            correctiveActions: Number(p.record_supersedes.corrective_actions),
          }
        : null,
      adoptedAt: isoOrNull(p.adopted_at),
      decidedAt: isoOrNull(p.decided_at),
      legalReview: {
        required: yes(p.legal_review?.required),
        requests: each(p.legal_review?.requests, legalRequest),
      },
      authority: {
        rules: each(p.authority?.rules, (r) => ({
          itemType: r.item_type,
          ruleId: r.rule_id ?? null,
          authorityTypes: [...(r.authority_types ?? [])],
          sourceStatus: r.source_status ?? null,
          coverage: r.coverage,
          settingDisagreement: yes(r.setting_disagreement),
        })),
        submissions: each(p.authority?.submissions, (x) => ({
          submissionId: x.submission_id,
          packageRound: x.package_round,
          packetId: x.packet_id ?? null,
          basis: x.basis,
          submittedAt: iso(x.submitted_at),
          requirements: each(x.requirements, (q) => ({
            itemId: q.item_id,
            authorityType: q.authority_type,
            ruleSourceStatus: q.rule_source_status,
          })),
        })),
        decisions: each(p.authority?.decisions, decision),
        toDecide: each(p.authority?.to_decide, (x) => ({
          authorityType: x.authority_type,
          itemIds: [...(x.item_ids ?? [])],
          completesRound: yes(x.completes_round),
        })),
      },
    })),
    findingVotes: each(v.finding_votes, (f) => ({
      voteItemId: f.vote_item_id,
      meetingId: f.meeting_id,
      sequenceNo: f.sequence_no,
      status: f.status,
      finding: {
        findingId: f.finding.finding_id,
        versionNo: f.finding.version_no,
        isCurrentVersion: yes(f.finding.is_current_version),
        result: f.finding.result,
        proceedingRole: f.finding.proceeding_role,
        allegation: {
          allegationId: f.finding.allegation.allegation_id,
          category: f.finding.allegation.category,
        },
        subject: f.finding.subject ? subject(f.finding.subject) : null,
      },
    })),
  };
}

export function toCommitteeScopeChoices(v: RawScopeChoices): CommitteeScopeChoices {
  return {
    committeeProceedingId: v.committee_proceeding_id,
    labelMode: v.label_mode,
    subjects: each(v.subjects, subject),
    allegations: each(v.allegations, (a) => ({
      allegationId: a.allegation_id,
      position: Number(a.position),
      category: a.category,
      status: a.status,
      subjectId: a.subject_id ?? null,
    })),
    findings: each(v.findings, (f) => ({
      findingId: f.finding_id,
      allegationId: f.allegation_id,
      subjectId: f.subject_id ?? null,
      proceedingRole: f.proceeding_role,
      versionNo: f.version_no,
      result: f.result,
      recordedAt: new Date(f.recorded_at).toISOString(),
    })),
  };
}

// ---- Gateway --------------------------------------------------------------------------------------------------
export class PostgresCommitteeProceedingsGateway implements CommitteeProceedingsGateway {
  constructor(private readonly sql: Sql) {}

  /** One value from a one-row select written `... as v`, in the caller's security context. */
  private value<T>(ctx: UserRequestContext, query: (tx: Tx) => Promise<readonly { v: T }[]>): Promise<T> {
    return withUserContext(this.sql, ctx, async (tx) => {
      const [row] = await query(tx);
      return row!.v;
    });
  }

  /** R2, then each package's item flags, in one transaction. */
  async itemsView(ctx: UserRequestContext, committeeProceedingId: string): Promise<CommitteeItemsView> {
    return withUserContext(this.sql, ctx, async (tx) => {
      const [row] = await tx<{ v: RawItemsView }[]>`
        select api.committee_items_view(${committeeProceedingId}) as v`;
      const view = row!.v;
      const flags = new Map<string, RecommendationItemFlag[]>();
      for (const p of view.packages ?? []) {
        const rows = await tx<{ itemId: string; flag: RecommendationItemFlag }[]>`
          select item_id as "itemId", flag from api.recommendation_item_flags(${p.package_id})`;
        for (const r of rows) flags.set(r.itemId, [...(flags.get(r.itemId) ?? []), r.flag]);
      }
      return toCommitteeItemsView(view, flags);
    });
  }

  async scopeChoices(ctx: UserRequestContext, committeeProceedingId: string): Promise<CommitteeScopeChoices> {
    return toCommitteeScopeChoices(
      await this.value<RawScopeChoices>(
        ctx,
        (tx) => tx`select api.committee_scope_choices(${committeeProceedingId}) as v`,
      ),
    );
  }

  /** Reference data: each active code with the version in force (DEC-F11); a basis is never read here. */
  async sanctionCatalogue(ctx: UserRequestContext): Promise<SanctionCatalogueChoice[]> {
    return withUserContext(this.sql, ctx, async (tx) => {
      const rows = await tx<
        {
          code: string;
          versionNo: number | null;
          sourceStatus: SanctionCatalogueChoice["sourceStatus"];
          subjectCategories: SanctionCatalogueChoice["subjectCategories"] | null;
        }[]
      >`
        select code, version_no as "versionNo", source_status as "sourceStatus",
               subject_categories as "subjectCategories"
        from decision.sanction_catalogue_entry
        where is_active
        order by code collate "C"`;
      return rows.map((r) => ({
        code: r.code,
        versionNo: r.versionNo ?? null,
        sourceStatus: r.sourceStatus === "APPROVED" ? "APPROVED" : "SOURCE_REQUIRED",
        subjectCategories: [...(r.subjectCategories ?? [])],
      }));
    });
  }

  createPackage(ctx: UserRequestContext, i: { committeeProceedingId: string; voteGranularity: string }) {
    return this.value<string>(
      ctx,
      (tx) => tx`
        select api.create_recommendation_package(${i.committeeProceedingId}, ${i.voteGranularity}) as v`,
    );
  }

  addItem(
    ctx: UserRequestContext,
    i: {
      packageId: string;
      itemType: string;
      sanctionCode?: string | undefined;
      proposedSanctionText?: string | undefined;
      description: string;
      subjectIds: string[];
      allegationIds: string[];
      requiresLegalJustification: boolean;
      dependsOnItemIds: string[];
      exclusivityGroup?: string | undefined;
    },
  ) {
    return this.value<string>(
      ctx,
      (tx) => tx`
        select api.add_recommendation_item(${i.packageId}, ${i.itemType}, ${i.sanctionCode ?? null},
          ${i.proposedSanctionText ?? null}, ${i.description}, ${i.subjectIds}::uuid[], ${i.allegationIds}::uuid[],
          ${i.requiresLegalJustification}, ${i.dependsOnItemIds}::uuid[], ${i.exclusivityGroup ?? null}) as v`,
    );
  }

  async withdrawItem(ctx: UserRequestContext, i: { itemId: string; reason: string }) {
    await withUserContext(this.sql, ctx, async (tx) => {
      await tx`select api.withdraw_recommendation_item(${i.itemId}, ${i.reason})`;
    });
  }

  submitForVote(ctx: UserRequestContext, i: { packageId: string }) {
    return this.value<number>(ctx, (tx) => tx`select api.submit_package_for_vote(${i.packageId}) as v`);
  }

  openPackageVote(ctx: UserRequestContext, i: { meetingId: string; packageId: string }) {
    return this.value<number>(
      ctx,
      (tx) => tx`select api.open_package_vote(${i.meetingId}, ${i.packageId}) as v`,
    );
  }

  recordAdoption(ctx: UserRequestContext, i: { packageId: string }) {
    return this.value<string>(ctx, (tx) => tx`select api.record_package_adoption(${i.packageId}) as v`);
  }

  returnToCommittee(ctx: UserRequestContext, i: { packageId: string; reason: string }) {
    return this.value<string>(
      ctx,
      (tx) => tx`select api.return_package_to_committee(${i.packageId}, ${i.reason}) as v`,
    );
  }

  resolveTaint(ctx: UserRequestContext, i: { itemId: string; resolution: string; reason: string }) {
    return this.value<string>(
      ctx,
      (tx) => tx`select api.resolve_conflict_taint(${i.itemId}, ${i.resolution}, ${i.reason}) as v`,
    );
  }
}
