// CommitteeProceedingsGateway over PostgreSQL (UX redesign Phase 12 P12-2c; ADR-056, migrations 2060 and 2086). Reads
// call only the purpose read models api.committee_items_view (R2) and api.committee_scope_choices (R1), the item flags
// (api.recommendation_item_flags) and the sanction catalogue's reference view (decision.sanction_catalogue_entry); the
// gateway renames their keys and reads no case table. Writes only call the package commands. Every method runs in its
// own transaction under the caller's security context.
import type {
  AllegationChoice,
  CommitteeItemsView,
  CommitteeLabelMode,
  CommitteeScopeChoices,
  FindingChoice,
  FindingVoteView,
  PackageItemView,
  RecommendationItemFlag,
  RecommendationPackageView,
  SanctionCatalogueChoice,
  SubjectRef,
  TaintResolution,
} from "@cdf/contracts";
import type { CommitteeProceedingsGateway, UserRequestContext } from "@cdf/application";
import { withUserContext, type Sql, type Tx } from "./security-context";

// ---- The read models' JSON, as the database writes it (snake_case; timestamps as text) -------------------------
interface RawSubject {
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

interface RawPackage {
  package_id: string;
  sequence_no: number;
  status: RecommendationPackageView["status"];
  round_no: number;
  vote_granularity: RecommendationPackageView["voteGranularity"];
  items: RawItem[] | null;
  capabilities?: Partial<
    Record<
      "may_add_item" | "may_submit_for_vote" | "may_record_adoption" | "may_return_to_committee",
      boolean | null
    >
  > | null;
  open_vote_in?: string[] | null;
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
const yes = (v: boolean | null | undefined): boolean => v === true;
const each = <R, T>(v: readonly R[] | null | undefined, map: (r: R) => T): T[] => (v ?? []).map(map);

function subject(s: RawSubject): SubjectRef {
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
