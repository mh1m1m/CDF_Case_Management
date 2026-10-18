// ExportGateway over PostgreSQL (ADR-026, migration 1930). Every call runs the api.* export command in the caller's
// security context; the database renders each item with the same predicates as RLS and binds approvals to hashes.
import type { ExportGateway, UserRequestContext } from "@cdf/application";
import type {
  AccountName,
  Classification,
  ExportApprovalOutcome,
  ExportAudience,
  ExportAuthorityBlock,
  ExportDelivery,
  ExportDocument,
  ExportFormat,
  ExportObjectType,
  ExportPreview,
  ExportPurpose,
  ExportPurposeEntry,
  ExportPurposeLegacy,
  ExportRecipientKind,
  ExportRequestPage,
  ExportRequestView,
  ExportRuleAction,
  ExportRuleSourceEntry,
  ExportSourceStatus,
  ExportStatus,
  GeneratedExport,
  SettingStatus,
} from "@cdf/contracts";
import { each, iso, isoOrNull, yes } from "./committee-proceedings-gateway";
import { withUserContext, type Sql, type Tx } from "./security-context";

interface DocumentRow {
  request_id: string;
  case_id: string;
  case_number: string;
  classification: Classification;
  format: ExportFormat;
  audience: ExportAudience;
  purpose: ExportPurpose | ExportPurposeLegacy;
  external_party: string | null;
  items: {
    position: number;
    object_type: ExportObjectType;
    object_id: string;
    included: boolean;
    content: Record<string, unknown> | null;
  }[];
}

type DeliveryRow = { kind: "INTERNAL"; user_id: string } | { kind: "EXTERNAL"; email: string };

const toDelivery = (d: DeliveryRow): ExportDelivery =>
  d.kind === "INTERNAL" ? { kind: "INTERNAL", userId: d.user_id } : { kind: "EXTERNAL", email: d.email };

const toDocument = (d: DocumentRow): ExportDocument => ({
  requestId: d.request_id,
  caseId: d.case_id,
  caseNumber: d.case_number,
  classification: d.classification,
  format: d.format,
  audience: d.audience,
  purpose: d.purpose,
  externalParty: d.external_party,
  items: d.items.map((i) => ({
    position: i.position,
    objectType: i.object_type,
    objectId: i.object_id,
    included: i.included,
    content: i.content,
  })),
});

/** `api.export_request_view` as the database returns it (2040:4860-4994). */
export interface RawExportView {
  export_request_id: string;
  status: ExportStatus;
  format: ExportFormat;
  audience: ExportAudience;
  purpose: string;
  external_party: string | null;
  justification: string | null;
  classification_at_submit: Classification | null;
  approvals_required: number | null;
  authority_approval_required: boolean;
  matched_rules: string[] | null;
  preview_hash: string | null;
  previewed_at: string | null;
  submitted_hash: string | null;
  requested_by: string;
  created_at: string;
  submitted_at: string | null;
  decided_at: string | null;
  generated_at: string | null;
  sent_at: string | null;
  cancelled_at: string | null;
  updated_at: string;
  row_version: number;
  current: {
    hash: string;
    withheld: number;
    refused_by_rule: boolean;
    approvals_required: number;
    authority_approval_required: boolean;
    next_stage: number | null;
    authority_consent_blocked: ExportAuthorityBlock | null;
  };
  items: {
    item_id: string;
    position: number;
    object_type: ExportObjectType;
    object_id: string;
    added_by: string;
    added_at: string;
    included: boolean | null;
  }[];
  recipients: {
    recipient_id: string;
    kind: ExportRecipientKind;
    user_id: string | null;
    email: string | null;
    added_by: string;
    added_at: string;
  }[];
  approvals: {
    approval_id: string;
    stage: number;
    approver_id: string;
    decision: ExportApprovalOutcome;
    reason: string;
    decided_at: string;
  }[];
  authority_decision: {
    decided_by: string;
    decision: ExportApprovalOutcome;
    reason: string;
    decided_at: string;
  } | null;
  case: { case_id: string | null; case_number: string | null };
  capabilities: Record<
    | "may_add_item"
    | "may_add_recipient"
    | "may_preview"
    | "may_submit"
    | "may_approve"
    | "may_reject"
    | "may_authority_approve"
    | "may_authority_reject"
    | "may_generate"
    | "may_record_sent"
    | "may_cancel",
    boolean | null
  >;
}

interface PurposeRow {
  code: string;
  name_en: string;
  name_ar: string;
  requires_justification: boolean;
  is_active: boolean;
  is_legacy: boolean;
  source_status: ExportSourceStatus;
}

const toPurpose = (p: PurposeRow): ExportPurposeEntry => ({
  code: p.code,
  nameEn: p.name_en,
  nameAr: p.name_ar,
  requiresJustification: p.requires_justification,
  isActive: p.is_active,
  isLegacy: p.is_legacy,
  sourceStatus: p.source_status,
});

/**
 * The view, renamed. A flag the database left out or null reads as false and a list it left out is empty (fail
 * closed); timestamps become ISO instants.
 */
export function toExportRequestView(v: RawExportView): ExportRequestView {
  const k = v.capabilities ?? ({} as RawExportView["capabilities"]);
  return {
    requestId: v.export_request_id,
    status: v.status,
    format: v.format,
    audience: v.audience,
    purpose: v.purpose,
    externalParty: v.external_party ?? null,
    justification: v.justification ?? null,
    classificationAtSubmit: v.classification_at_submit ?? null,
    approvalsRequired: v.approvals_required ?? null,
    authorityApprovalRequired: yes(v.authority_approval_required),
    matchedRules: each(v.matched_rules, (c) => c),
    previewHash: v.preview_hash ?? null,
    previewedAt: isoOrNull(v.previewed_at),
    submittedHash: v.submitted_hash ?? null,
    requestedBy: v.requested_by,
    createdAt: iso(v.created_at),
    submittedAt: isoOrNull(v.submitted_at),
    decidedAt: isoOrNull(v.decided_at),
    generatedAt: isoOrNull(v.generated_at),
    sentAt: isoOrNull(v.sent_at),
    cancelledAt: isoOrNull(v.cancelled_at),
    updatedAt: iso(v.updated_at),
    rowVersion: v.row_version,
    current: {
      hash: v.current.hash,
      withheld: v.current.withheld,
      refusedByRule: yes(v.current.refused_by_rule),
      approvalsRequired: v.current.approvals_required,
      authorityApprovalRequired: yes(v.current.authority_approval_required),
      nextStage: v.current.next_stage ?? null,
      authorityConsentBlocked: v.current.authority_consent_blocked ?? null,
    },
    items: each(v.items, (i) => ({
      itemId: i.item_id,
      position: i.position,
      objectType: i.object_type,
      objectId: i.object_id,
      addedBy: i.added_by,
      addedAt: iso(i.added_at),
      included: yes(i.included),
    })),
    recipients: each(v.recipients, (r) => ({
      recipientId: r.recipient_id,
      kind: r.kind,
      userId: r.user_id ?? null,
      email: r.email ?? null,
      addedBy: r.added_by,
      addedAt: iso(r.added_at),
    })),
    approvals: each(v.approvals, (a) => ({
      approvalId: a.approval_id,
      stage: a.stage,
      approverId: a.approver_id,
      decision: a.decision,
      reason: a.reason,
      decidedAt: iso(a.decided_at),
    })),
    authorityDecision: v.authority_decision
      ? {
          decidedBy: v.authority_decision.decided_by,
          decision: v.authority_decision.decision,
          reason: v.authority_decision.reason,
          decidedAt: iso(v.authority_decision.decided_at),
        }
      : null,
    caseId: v.case?.case_id ?? null,
    caseNumber: v.case?.case_number ?? null,
    capabilities: {
      mayAddItem: yes(k.may_add_item),
      mayAddRecipient: yes(k.may_add_recipient),
      mayPreview: yes(k.may_preview),
      maySubmit: yes(k.may_submit),
      mayApprove: yes(k.may_approve),
      mayReject: yes(k.may_reject),
      mayAuthorityApprove: yes(k.may_authority_approve),
      mayAuthorityReject: yes(k.may_authority_reject),
      mayGenerate: yes(k.may_generate),
      mayRecordSent: yes(k.may_record_sent),
      mayCancel: yes(k.may_cancel),
    },
  };
}

/** Every account the view names, once. */
function namedAccounts(v: ExportRequestView): string[] {
  const ids = new Set<string>([v.requestedBy]);
  for (const i of v.items) ids.add(i.addedBy);
  for (const r of v.recipients) {
    ids.add(r.addedBy);
    if (r.userId) ids.add(r.userId);
  }
  for (const a of v.approvals) ids.add(a.approverId);
  if (v.authorityDecision) ids.add(v.authorityDecision.decidedBy);
  return [...ids];
}

/** The directory names of `ids`, read through RLS in the caller's context (an external account sees only its own). */
export async function accountNames(tx: Tx, ids: string[]): Promise<AccountName[]> {
  if (ids.length === 0) return [];
  const rows = await tx<{ id: string; display_name: string | null; display_name_ar: string | null }[]>`
    select u.id, u.display_name, u.display_name_ar from iam.user_profile u where u.id = any(${ids}::uuid[])
    order by u.id`;
  return rows.map((r) => ({ userId: r.id, displayName: r.display_name, displayNameAr: r.display_name_ar }));
}

export class PostgresExportGateway implements ExportGateway {
  constructor(private readonly sql: Sql) {}

  private run<T>(ctx: UserRequestContext, fn: (tx: Tx) => Promise<T>) {
    return withUserContext(this.sql, ctx, fn);
  }

  /**
   * The export's purpose read (2040) and, in the same transaction, the reference rows that name what it shows: the
   * accounts it names, its purpose, where each export rule comes from, and the approved-domain setting (DEC-F22).
   * Never the storage key or the document.
   */
  view(ctx: UserRequestContext, requestId: string): Promise<ExportRequestPage> {
    return this.run(ctx, async (tx) => {
      const [r] = await tx<{ v: RawExportView }[]>`select api.export_request_view(${requestId}) as v`;
      const view = toExportRequestView(r!.v);
      const people = await accountNames(tx, namedAccounts(view));
      const [purpose] = await tx<PurposeRow[]>`
        select p.code, p.name_en, p.name_ar, p.requires_justification, p.is_active, p.is_legacy, p.source_status
        from exchange.export_purpose p where p.code = ${view.purpose}`;
      // The latest version of each rule code: whichever the request matched at submission or the preview matches now.
      const rules = await tx<{ code: string; action: ExportRuleAction; source_status: ExportSourceStatus }[]>`
        select distinct on (r.code) r.code, r.action, r.source_status
        from exchange.approval_rule r where r.effective_from <= now()
        order by r.code, r.effective_from desc`;
      const [domains] = await tx<{ status: SettingStatus }[]>`
        select s.status from config.setting s where s.key = 'APPROVED_EXTERNAL_DOMAINS'`;
      return {
        view,
        people,
        purpose: purpose ? toPurpose(purpose) : null,
        rules: rules.map((x): ExportRuleSourceEntry => ({
          code: x.code,
          action: x.action,
          sourceStatus: x.source_status,
        })),
        // No row reads as not configured: the page never claims a list that is not there.
        approvedDomains: domains?.status ?? "SOURCE_REQUIRED",
      };
    });
  }

  /** The active purposes of the governed catalogue, in its order (DEC-F21). */
  purposes(ctx: UserRequestContext): Promise<ExportPurposeEntry[]> {
    return this.run(ctx, async (tx) => {
      const rows = await tx<PurposeRow[]>`
        select p.code, p.name_en, p.name_ar, p.requires_justification, p.is_active, p.is_legacy, p.source_status
        from exchange.export_purpose p where p.is_active
        order by p.sort_order, p.code`;
      return rows.map(toPurpose);
    });
  }

  create(ctx: UserRequestContext, i: Parameters<ExportGateway["create"]>[1]): Promise<string> {
    return this.run(ctx, async (tx) => {
      const [r] = await tx<{ id: string }[]>`
        select api.create_export_request(${i.caseId}, ${i.format}, ${i.audience}, ${i.purpose},
          ${i.externalParty ?? null}, ${i.justification ?? null}) as id`;
      return r!.id;
    });
  }

  addItem(ctx: UserRequestContext, i: Parameters<ExportGateway["addItem"]>[1]): Promise<string> {
    return this.run(ctx, async (tx) => {
      const [r] = await tx<{ id: string }[]>`
        select api.add_export_item(${i.requestId}, ${i.objectType}, ${i.objectId}) as id`;
      return r!.id;
    });
  }

  addRecipient(ctx: UserRequestContext, i: Parameters<ExportGateway["addRecipient"]>[1]): Promise<string> {
    return this.run(ctx, async (tx) => {
      const [r] = await tx<{ id: string }[]>`
        select api.add_export_recipient(${i.requestId}, ${i.kind}, ${i.kind === "INTERNAL" ? i.userId : null},
          ${i.kind === "EXTERNAL" ? i.email : null}) as id`;
      return r!.id;
    });
  }

  preview(ctx: UserRequestContext, requestId: string): Promise<ExportPreview> {
    return this.run(ctx, async (tx) => {
      const [r] = await tx<
        {
          p: {
            document: DocumentRow;
            hash: string;
            withheld: number;
            approvals_required: number;
            authority_approval_required: boolean;
            matched_rules: ExportPreview["matchedRules"];
          };
        }[]
      >`select api.preview_export(${requestId}) as p`;
      const p = r!.p;
      return {
        document: toDocument(p.document),
        hash: p.hash,
        withheld: p.withheld,
        approvalsRequired: p.approvals_required,
        authorityApprovalRequired: p.authority_approval_required,
        matchedRules: p.matched_rules,
      };
    });
  }

  submit(ctx: UserRequestContext, i: Parameters<ExportGateway["submit"]>[1]): Promise<ExportStatus> {
    return this.run(ctx, async (tx) => {
      const [r] = await tx<{ status: ExportStatus }[]>`
        select api.submit_export(${i.requestId}, ${i.previewHash}, ${i.classification}::core.classification_level) as status`;
      return r!.status;
    });
  }

  decide(ctx: UserRequestContext, i: Parameters<ExportGateway["decide"]>[1]): Promise<ExportStatus> {
    return this.run(ctx, async (tx) => {
      const [r] = await tx<{ status: ExportStatus }[]>`
        select api.decide_export(${i.requestId}, ${i.decision}, ${i.reason}, ${i.previewHash}) as status`;
      return r!.status;
    });
  }

  decideRestricted(
    ctx: UserRequestContext,
    i: Parameters<ExportGateway["decide"]>[1],
  ): Promise<ExportStatus> {
    return this.run(ctx, async (tx) => {
      const [r] = await tx<{ status: ExportStatus }[]>`
        select api.decide_restricted_export(${i.requestId}, ${i.decision}, ${i.reason}, ${i.previewHash}) as status`;
      return r!.status;
    });
  }

  generate<T>(
    ctx: UserRequestContext,
    requestId: string,
    write: (generated: GeneratedExport) => Promise<T>,
  ): Promise<{ generated: GeneratedExport; written: T }> {
    return this.run(ctx, async (tx) => {
      const [r] = await tx<
        { g: { storage_key: string; hash: string; document: DocumentRow; deliver_to: DeliveryRow[] } }[]
      >`select api.generate_export(${requestId}) as g`;
      const generated: GeneratedExport = {
        storageKey: r!.g.storage_key,
        hash: r!.g.hash,
        document: toDocument(r!.g.document),
        deliverTo: r!.g.deliver_to.map(toDelivery),
      };
      // Inside the transaction: a failed render or write rolls the generation back.
      return { generated, written: await write(generated) };
    });
  }

  recordSent(ctx: UserRequestContext, requestId: string): Promise<void> {
    return this.run(ctx, async (tx) => {
      await tx`select api.record_export_sent(${requestId})`;
    });
  }

  cancel(ctx: UserRequestContext, i: Parameters<ExportGateway["cancel"]>[1]): Promise<void> {
    return this.run(ctx, async (tx) => {
      await tx`select api.cancel_export(${i.requestId}, ${i.reason})`;
    });
  }
}
