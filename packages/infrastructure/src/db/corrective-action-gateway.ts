// CorrectiveActionGateway over PostgreSQL (ADR-033, migration 1940). Every call runs the api.* command, or reads
// through RLS, in the caller's security context: the database decides ownership, the case gate and the authority.
// Phase 12 P12-3b (ADR-058, migration 2096): the case's actions (A1, api.case_corrective_actions) and one action
// (A2, api.corrective_action_view) come from their read models, whose keys the gateway renames, and a frozen action's
// disposition from its command (api.dispose_superseded_corrective_action). P12-6a: A2's policy and history too, and a
// completion with its evidence type (the four-argument command).
import type { CorrectiveActionGateway, UserRequestContext } from "@cdf/application";
import type {
  ActionBlock,
  ActionDisposition,
  ActionEventType,
  ActionOwner,
  ActionOwnerKind,
  ActionSource,
  CaseCorrectiveAction,
  CompletionEvidenceRule,
  CorrectiveAction,
  CorrectiveActionStatus,
  CorrectiveActionType,
  CorrectiveActionView,
  CorrectiveEvidenceType,
} from "@cdf/contracts";
import { account, each, iso, isoOrNull, yes, type RawAccount } from "./committee-proceedings-gateway";
import { withUserContext, type Sql, type Tx } from "./security-context";

type P<K extends keyof CorrectiveActionGateway> = Parameters<CorrectiveActionGateway[K]>[1];

interface ActionRow {
  id: string;
  case_id: string;
  recommendation_item_id: string | null;
  action_type: CorrectiveActionType;
  sequence_no: number;
  title: string;
  description: string;
  owner_id: string;
  due_date: string;
  status: CorrectiveActionStatus;
  percent_complete: number;
}

// ---- The read models' JSON, as the database writes it (snake_case; timestamps as text) -------------------------
interface RawOwner {
  kind: ActionOwnerKind;
  accountable_user_id: string | null;
  sector: { sector_id: string; code: string; name_en: string; name_ar: string } | null;
  pool: { code: string; name: string } | null;
  external_party_label: string | null;
}

interface RawCaseAction {
  action_id: string;
  action_type: CorrectiveActionType;
  sequence_no: number;
  title: string;
  status: CorrectiveActionStatus;
  due_date: string;
  percent_complete: number;
  version_no: number;
  owner: RawOwner & { display_name: string | null; display_name_ar: string | null };
  source: ActionSource;
  recommendation_item_id: string | null;
  preliminary_proposal_id: string | null;
  authority_decision_id: string | null;
  governing_decision_id: string | null;
  decision_block: ActionBlock | null;
  superseded_at: string | null;
  replaced_by_action_id: string | null;
  replaces_action_id: string | null;
  may_dispose: boolean;
}

interface RawView {
  action_id: string;
  action_type: CorrectiveActionType;
  sequence_no: number;
  title: string;
  description: string;
  status: CorrectiveActionStatus;
  due_date: string;
  percent_complete: number;
  created_at: string;
  completion_submitted_at: string | null;
  completed_at: string | null;
  waived_at: string | null;
  updated_at: string;
  version_no: number;
  versions:
    | { version_no: number; title: string; description: string; recorded_by: string; recorded_at: string }[]
    | null;
  owner: RawOwner;
  origin: {
    recommendation_item_id: string | null;
    authority_decision_id: string | null;
    source: ActionSource;
    preliminary_proposal_id: string | null;
    governing_decision_id: string | null;
    decision_block: ActionBlock | null;
    dispositions:
      | {
          disposition_id: string;
          disposition: ActionDisposition;
          superseded_decision_id: string;
          replacement_decision_id: string;
          prior_status: CorrectiveActionStatus;
          source_document_reference: string;
          revised_version_no: number | null;
          replacement_action_id: string | null;
          recorded_by: string;
          recorded_at: string;
        }[]
      | null;
    disposition_options: ActionDisposition[] | null;
    replacement: {
      decision_id: string;
      sources: { position: number; reference: string; is_primary: boolean }[] | null;
      may_name_owner: boolean;
      owner_candidates: RawAccount[] | null;
      default_due_date: string | null;
    } | null;
  } | null;
  case: { case_id: string | null; case_number: string | null };
  policy: {
    completion_evidence: CompletionEvidenceRule | null;
    allowed_evidence_types: CorrectiveEvidenceType[] | null;
  } | null;
  events:
    | {
        event_id: string;
        event_type: ActionEventType;
        actor_id: string;
        note: string | null;
        evidence_reference: string | null;
        evidence_type: CorrectiveEvidenceType | null;
        percent_complete: number | null;
        due_date: string | null;
        created_at: string;
      }[]
    | null;
  capabilities: {
    may_record_progress: boolean;
    may_submit_completion: boolean;
    may_verify: boolean;
    may_reopen: boolean;
    may_waive: boolean;
    may_dispose: boolean;
    may_change_due_date: boolean;
    may_assign_owner: boolean;
    may_set_owner_kind: boolean;
    may_set_shared_owner_kind: boolean;
  };
}

function toOwner(o: RawOwner): ActionOwner {
  return {
    kind: o.kind,
    accountableUserId: o.accountable_user_id ?? null,
    sector: o.sector
      ? {
          sectorId: o.sector.sector_id,
          code: o.sector.code,
          nameEn: o.sector.name_en,
          nameAr: o.sector.name_ar,
        }
      : null,
    pool: o.pool ? { code: o.pool.code, name: o.pool.name } : null,
    externalPartyLabel: o.external_party_label ?? null,
  };
}

export function toCaseCorrectiveAction(a: RawCaseAction): CaseCorrectiveAction {
  return {
    actionId: a.action_id,
    actionType: a.action_type,
    sequenceNo: a.sequence_no,
    title: a.title,
    status: a.status,
    dueDate: a.due_date,
    percentComplete: a.percent_complete,
    versionNo: a.version_no,
    owner: {
      ...toOwner(a.owner),
      displayName: a.owner.display_name ?? null,
      displayNameAr: a.owner.display_name_ar ?? null,
    },
    source: a.source,
    recommendationItemId: a.recommendation_item_id ?? null,
    preliminaryProposalId: a.preliminary_proposal_id ?? null,
    authorityDecisionId: a.authority_decision_id ?? null,
    governingDecisionId: a.governing_decision_id ?? null,
    decisionBlock: a.decision_block ?? null,
    supersededAt: isoOrNull(a.superseded_at),
    replacedByActionId: a.replaced_by_action_id ?? null,
    replacesActionId: a.replaces_action_id ?? null,
    mayDispose: yes(a.may_dispose),
  };
}

export function toCorrectiveActionView(v: RawView): CorrectiveActionView {
  const o = v.origin;
  const c = v.capabilities;
  return {
    actionId: v.action_id,
    actionType: v.action_type,
    sequenceNo: v.sequence_no,
    title: v.title,
    description: v.description,
    status: v.status,
    dueDate: v.due_date,
    percentComplete: v.percent_complete,
    createdAt: iso(v.created_at),
    completionSubmittedAt: isoOrNull(v.completion_submitted_at),
    completedAt: isoOrNull(v.completed_at),
    waivedAt: isoOrNull(v.waived_at),
    updatedAt: iso(v.updated_at),
    versionNo: v.version_no,
    versions: each(v.versions, (x) => ({
      versionNo: x.version_no,
      title: x.title,
      description: x.description,
      recordedBy: x.recorded_by,
      recordedAt: iso(x.recorded_at),
    })),
    owner: toOwner(v.owner),
    origin: o
      ? {
          recommendationItemId: o.recommendation_item_id ?? null,
          authorityDecisionId: o.authority_decision_id ?? null,
          source: o.source,
          preliminaryProposalId: o.preliminary_proposal_id ?? null,
          governingDecisionId: o.governing_decision_id ?? null,
          decisionBlock: o.decision_block ?? null,
          dispositions: each(o.dispositions, (d) => ({
            dispositionId: d.disposition_id,
            disposition: d.disposition,
            supersededDecisionId: d.superseded_decision_id,
            replacementDecisionId: d.replacement_decision_id,
            priorStatus: d.prior_status,
            sourceDocumentReference: d.source_document_reference,
            revisedVersionNo: d.revised_version_no ?? null,
            replacementActionId: d.replacement_action_id ?? null,
            recordedBy: d.recorded_by,
            recordedAt: iso(d.recorded_at),
          })),
          dispositionOptions: o.disposition_options ?? [],
          replacement: o.replacement
            ? {
                decisionId: o.replacement.decision_id,
                sources: each(o.replacement.sources, (s) => ({
                  position: s.position,
                  reference: s.reference,
                  isPrimary: yes(s.is_primary),
                })),
                mayNameOwner: yes(o.replacement.may_name_owner),
                ownerCandidates: each(o.replacement.owner_candidates, account),
                defaultDueDate: o.replacement.default_due_date ?? null,
              }
            : null,
        }
      : null,
    case: { caseId: v.case.case_id ?? null, caseNumber: v.case.case_number ?? null },
    // With no policy in force the command asks for a reference (anything but NOTE_ONLY does), so the page asks too.
    policy: {
      completionEvidence: v.policy?.completion_evidence === "NOTE_ONLY" ? "NOTE_ONLY" : "REFERENCE_REQUIRED",
      allowedEvidenceTypes: v.policy?.allowed_evidence_types ?? null,
    },
    // The view's history, without the person OPENED and OWNER_CHANGED name or a waiver's document (not shown).
    events: each(v.events, (e) => ({
      eventId: e.event_id,
      eventType: e.event_type,
      actorId: e.actor_id,
      note: e.note ?? null,
      evidenceReference: e.evidence_reference ?? null,
      evidenceType: e.evidence_type ?? null,
      percentComplete: e.percent_complete ?? null,
      dueDate: e.due_date ?? null,
      createdAt: iso(e.created_at),
    })),
    capabilities: {
      mayRecordProgress: yes(c.may_record_progress),
      maySubmitCompletion: yes(c.may_submit_completion),
      mayVerify: yes(c.may_verify),
      mayReopen: yes(c.may_reopen),
      mayWaive: yes(c.may_waive),
      mayDispose: yes(c.may_dispose),
      mayChangeDueDate: yes(c.may_change_due_date),
      mayAssignOwner: yes(c.may_assign_owner),
      maySetOwnerKind: yes(c.may_set_owner_kind),
      maySetSharedOwnerKind: yes(c.may_set_shared_owner_kind),
    },
  };
}

// ---- Gateway --------------------------------------------------------------------------------------------------
export class PostgresCorrectiveActionGateway implements CorrectiveActionGateway {
  constructor(private readonly sql: Sql) {}

  private run<T>(ctx: UserRequestContext, fn: (tx: Tx) => Promise<T>) {
    return withUserContext(this.sql, ctx, fn);
  }

  /** One value from a one-row select written `... as v`, in the caller's security context. */
  private value<T>(ctx: UserRequestContext, query: (tx: Tx) => Promise<readonly { v: T }[]>): Promise<T> {
    return this.run(ctx, async (tx) => {
      const [row] = await query(tx);
      return row!.v;
    });
  }

  async caseActions(ctx: UserRequestContext, caseId: string): Promise<CaseCorrectiveAction[]> {
    const rows = await this.value<RawCaseAction[] | null>(
      ctx,
      (tx) => tx`select api.case_corrective_actions(${caseId}) as v`,
    );
    return each(rows, toCaseCorrectiveAction);
  }

  async view(ctx: UserRequestContext, actionId: string): Promise<CorrectiveActionView> {
    return toCorrectiveActionView(
      await this.value<RawView>(ctx, (tx) => tx`select api.corrective_action_view(${actionId}) as v`),
    );
  }

  dispose(ctx: UserRequestContext, i: P<"dispose">): Promise<string> {
    return this.run(ctx, async (tx) => {
      const [r] = await tx<{ id: string }[]>`
        select api.dispose_superseded_corrective_action(${i.actionId}, ${i.disposition},
          ${i.sourceDocumentReference}, ${i.reason}, ${i.title ?? null}, ${i.description ?? null},
          ${i.ownerId ?? null}::uuid, ${i.dueDate ?? null}::date) as id`;
      return r!.id;
    });
  }

  setPolicy(ctx: UserRequestContext, i: P<"setPolicy">): Promise<string> {
    return this.run(ctx, async (tx) => {
      const [r] = await tx<{ id: string }[]>`
        select api.set_corrective_action_policy(${i.actionType}, ${i.defaultDueDays ?? null}::int,
          ${i.reminderDaysBefore ?? null}::int, ${i.escalateAfterDays ?? null}::int, ${i.completionEvidence},
          ${i.effectiveFrom}::timestamptz, ${i.sourceStatus}, ${i.reason}) as id`;
      return r!.id;
    });
  }

  open(ctx: UserRequestContext, i: P<"open">): Promise<string> {
    return this.run(ctx, async (tx) => {
      const [r] = await tx<{ id: string }[]>`
        select api.open_corrective_action(${i.itemId}, ${i.title}, ${i.description}, ${i.ownerId},
          ${i.dueDate ?? null}::date) as id`;
      return r!.id;
    });
  }

  async assignOwner(ctx: UserRequestContext, i: P<"assignOwner">): Promise<void> {
    await this.run(
      ctx,
      (tx) => tx`select api.assign_corrective_action_owner(${i.actionId}, ${i.ownerId}, ${i.reason})`,
    );
  }

  async changeDueDate(ctx: UserRequestContext, i: P<"changeDueDate">): Promise<void> {
    await this.run(
      ctx,
      (tx) =>
        tx`select api.change_corrective_action_due_date(${i.actionId}, ${i.dueDate}::date, ${i.reason})`,
    );
  }

  async recordProgress(ctx: UserRequestContext, i: P<"recordProgress">): Promise<void> {
    await this.run(
      ctx,
      (tx) =>
        tx`select api.record_corrective_action_progress(${i.actionId}, ${i.percentComplete}, ${i.note})`,
    );
  }

  /** The four-argument command (DEC-F27, migration 2040): the evidence type, where the policy lists types. */
  async submitCompletion(ctx: UserRequestContext, i: P<"submitCompletion">): Promise<void> {
    await this.run(
      ctx,
      (tx) =>
        tx`select api.submit_corrective_action_completion(${i.actionId}, ${i.note}, ${i.evidenceReference ?? null},
          ${i.evidenceType ?? null}::text)`,
    );
  }

  verify(ctx: UserRequestContext, i: P<"verify">): Promise<CorrectiveActionStatus> {
    return this.run(ctx, async (tx) => {
      const [r] = await tx<{ status: CorrectiveActionStatus }[]>`
        select api.verify_corrective_action(${i.actionId}, ${i.decision}, ${i.note ?? null}) as status`;
      return r!.status;
    });
  }

  async reopen(ctx: UserRequestContext, i: P<"reopen">): Promise<void> {
    await this.run(ctx, (tx) => tx`select api.reopen_corrective_action(${i.actionId}, ${i.reason})`);
  }

  async waive(ctx: UserRequestContext, i: P<"waive">): Promise<void> {
    await this.run(
      ctx,
      (tx) =>
        tx`select api.waive_corrective_action(${i.actionId}, ${i.sourceDocumentReference}, ${i.reason})`,
    );
  }

  list(ctx: UserRequestContext, filter: P<"list">): Promise<CorrectiveAction[]> {
    return this.run(ctx, async (tx) => {
      const rows = await tx<ActionRow[]>`
        select a.id, a.case_id, a.recommendation_item_id, a.action_type, a.sequence_no, a.title, a.description,
               a.owner_id, a.due_date::text as due_date, a.status, a.percent_complete
        from decision.corrective_action a
        where (${filter.caseId ?? null}::uuid is null or a.case_id = ${filter.caseId ?? null}::uuid)
          and (not ${filter.mine ?? false} or a.owner_id = authz.current_user_id())
        order by a.due_date, a.sequence_no
        limit 500`;
      return rows.map((r) => ({
        id: r.id,
        caseId: r.case_id,
        recommendationItemId: r.recommendation_item_id,
        actionType: r.action_type,
        sequenceNo: r.sequence_no,
        title: r.title,
        description: r.description,
        ownerId: r.owner_id,
        dueDate: r.due_date,
        status: r.status,
        percentComplete: r.percent_complete,
      }));
    });
  }
}
