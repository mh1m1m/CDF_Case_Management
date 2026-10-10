// FormsGateway over PostgreSQL (ADR-003, ADR-011). Reads go through RLS; writes only call api.* commands.
import type {
  FormApprovalOutcome,
  FormData,
  FormDefinitionListItem,
  FormEventInfo,
  FormInstanceCapabilities,
  FormInstanceDetail,
  FormInstanceSummary,
  FormInstanceVersionInfo,
  FormReviewOutcome,
  FormSectionDefinition,
  FormStatus,
} from "@cdf/contracts";
import type { FormsGateway, SavedFormVersion, UserRequestContext } from "@cdf/application";
import { withUserContext, type Sql, type Tx } from "./security-context";

const iso = (v: Date | string | null) => (v === null ? null : new Date(v).toISOString());

type SummaryRow = Omit<FormInstanceSummary, "createdAt" | "updatedAt"> & { createdAt: Date; updatedAt: Date };
type DetailRow = SummaryRow &
  FormInstanceCapabilities & {
    definitionVersionNo: number;
    schemaHash: string;
    sections: FormSectionDefinition[];
    purposeAr: string;
    purposeEn: string;
    reviewRequired: boolean;
    approvalRequired: boolean;
    finalStatus: FormStatus;
    data: FormData | null;
    preparedBy: string | null;
    preparedByName: string | null;
    preparedAt: Date | null;
    preparedVersionNo: number | null;
    reviewedBy: string | null;
    reviewedByName: string | null;
    reviewedAt: Date | null;
    approvedBy: string | null;
    approvedByName: string | null;
    approvedAt: Date | null;
    withdrawnBy: string | null;
    withdrawnByName: string | null;
    withdrawnAt: Date | null;
  };
type VersionRow = Omit<FormInstanceVersionInfo, "savedAt"> & { savedAt: Date };
type EventRow = Omit<FormEventInfo, "occurredAt"> & { occurredAt: Date };

export class PostgresFormsGateway implements FormsGateway {
  constructor(private readonly sql: Sql) {}

  private run<T>(ctx: UserRequestContext, fn: (tx: Tx) => Promise<T>) {
    return withUserContext(this.sql, ctx, fn);
  }

  listDefinitions(ctx: UserRequestContext, caseId: string): Promise<FormDefinitionListItem[]> {
    return this.run(
      ctx,
      (tx) => tx<FormDefinitionListItem[]>`
        select d.code, d.sequence_no as "sequenceNo", d.name_ar as "nameAr", d.name_en as "nameEn",
               d.purpose_ar as "purposeAr", d.purpose_en as "purposeEn", d.owner_role_hint as "ownerRoleHint",
               d.review_required as "reviewRequired", d.approval_required as "approvalRequired", d.is_enabled as "isEnabled",
               v.version_no as "versionNo", authz.can_prepare_form(${caseId}, d.code) as "canStart"
        from forms.form_definition d join forms.form_definition_version v on v.id = d.current_version_id
        order by d.sequence_no`,
    );
  }

  listInstances(ctx: UserRequestContext, caseId: string): Promise<FormInstanceSummary[]> {
    return this.run(ctx, async (tx) => {
      const rows = await tx<SummaryRow[]>`
        select i.id, i.case_id as "caseId", c.case_number as "caseNumber", i.form_code as "formCode", d.name_ar as "formNameAr",
               d.name_en as "formNameEn", i.instance_no as "instanceNo", i.status, i.classification, cv.version_no as "currentVersionNo",
               cv.content_hash as "contentHash", i.created_by as "createdBy", u.display_name as "createdByName",
               i.created_at as "createdAt", i.updated_at as "updatedAt"
        from forms.form_instance i
        join case_mgmt.case_record c on c.id = i.case_id
        join forms.form_definition d on d.code = i.form_code
        left join forms.form_instance_version cv on cv.id = i.current_version_id
        left join iam.user_profile u on u.id = i.created_by
        where i.case_id = ${caseId}
        order by d.sequence_no, i.instance_no`;
      return rows.map((r) => ({ ...r, createdAt: iso(r.createdAt)!, updatedAt: iso(r.updatedAt)! }));
    });
  }

  getInstance(ctx: UserRequestContext, instanceId: string): Promise<FormInstanceDetail | null> {
    return this.run(ctx, async (tx) => {
      // Records FORM_VIEWED, or a SECURITY denial when the instance is missing or invisible (alike, §40).
      const [gate] = await tx<{ ok: boolean }[]>`select api.open_form_instance(${instanceId}) as ok`;
      if (!gate?.ok) return null;
      const [r] = await tx<DetailRow[]>`
        select i.id, i.case_id as "caseId", c.case_number as "caseNumber", i.form_code as "formCode", d.name_ar as "formNameAr",
               d.name_en as "formNameEn", d.purpose_ar as "purposeAr", d.purpose_en as "purposeEn", d.review_required as "reviewRequired",
               d.approval_required as "approvalRequired", forms.terminal_status(d.review_required, d.approval_required) as "finalStatus",
               i.instance_no as "instanceNo", i.status, i.classification,
               dv.version_no as "definitionVersionNo", dv.schema_hash as "schemaHash", dv.schema as "sections",
               cv.version_no as "currentVersionNo", cv.content_hash as "contentHash", cv.data,
               pv.version_no as "preparedVersionNo",
               i.created_by as "createdBy", uc.display_name as "createdByName", i.created_at as "createdAt", i.updated_at as "updatedAt",
               i.prepared_by as "preparedBy", up.display_name as "preparedByName", i.prepared_at as "preparedAt",
               i.reviewed_by as "reviewedBy", ur.display_name as "reviewedByName", i.reviewed_at as "reviewedAt",
               i.approved_by as "approvedBy", ua.display_name as "approvedByName", i.approved_at as "approvedAt",
               i.withdrawn_by as "withdrawnBy", uw.display_name as "withdrawnByName", i.withdrawn_at as "withdrawnAt",
               -- What the database would allow now (mirrors the command guards; the commands re-check).
               (authz.can_prepare_form(i.case_id, i.form_code) and i.status = 'DRAFT') as "canSave",
               (authz.can_prepare_form(i.case_id, i.form_code) and i.status = 'DRAFT' and i.current_version_id is not null) as "canPrepare",
               (authz.can_review_form(i.id) and i.status = 'PREPARED' and i.prepared_by is distinct from authz.current_user_id()) as "canReview",
               (authz.can_approve_form(i.id) and i.status = 'REVIEWED'
                  and authz.current_user_id() is distinct from i.prepared_by and authz.current_user_id() is distinct from i.reviewed_by) as "canApprove",
               (authz.can_prepare_form(i.case_id, i.form_code) and i.status <> 'WITHDRAWN'
                  and i.status <> forms.terminal_status(d.review_required, d.approval_required)) as "canWithdraw"
        from forms.form_instance i
        join case_mgmt.case_record c on c.id = i.case_id
        join forms.form_definition d on d.code = i.form_code
        join forms.form_definition_version dv on dv.id = i.definition_version_id
        left join forms.form_instance_version cv on cv.id = i.current_version_id
        left join forms.form_instance_version pv on pv.id = i.prepared_version_id
        left join iam.user_profile uc on uc.id = i.created_by
        left join iam.user_profile up on up.id = i.prepared_by
        left join iam.user_profile ur on ur.id = i.reviewed_by
        left join iam.user_profile ua on ua.id = i.approved_by
        left join iam.user_profile uw on uw.id = i.withdrawn_by
        where i.id = ${instanceId}`;
      if (!r) return null;
      const versions = await tx<VersionRow[]>`
        select v.id, v.version_no as "versionNo", v.content_hash as "contentHash", v.saved_by as "savedBy",
               u.display_name as "savedByName", v.saved_at as "savedAt"
        from forms.form_instance_version v left join iam.user_profile u on u.id = v.saved_by
        where v.instance_id = ${instanceId} order by v.version_no`;
      const events = await tx<EventRow[]>`
        select e.id, e.event_type as "eventType", e.from_status as "fromStatus", e.to_status as "toStatus",
               v.version_no as "versionNo", e.actor_id as "actorId", u.display_name as "actorName", e.occurred_at as "occurredAt", e.reason
        from forms.form_event e
        left join forms.form_instance_version v on v.id = e.version_id
        left join iam.user_profile u on u.id = e.actor_id
        where e.instance_id = ${instanceId} order by e.seq`;
      return {
        id: r.id,
        caseId: r.caseId,
        caseNumber: r.caseNumber,
        formCode: r.formCode,
        formNameAr: r.formNameAr,
        formNameEn: r.formNameEn,
        instanceNo: r.instanceNo,
        status: r.status,
        classification: r.classification,
        currentVersionNo: r.currentVersionNo,
        contentHash: r.contentHash,
        createdBy: r.createdBy,
        createdByName: r.createdByName,
        createdAt: iso(r.createdAt)!,
        updatedAt: iso(r.updatedAt)!,
        definition: {
          code: r.formCode,
          nameAr: r.formNameAr,
          nameEn: r.formNameEn,
          purposeAr: r.purposeAr,
          purposeEn: r.purposeEn,
          reviewRequired: r.reviewRequired,
          approvalRequired: r.approvalRequired,
          versionNo: r.definitionVersionNo,
          schemaHash: r.schemaHash,
          sections: r.sections,
        },
        data: r.data ?? {},
        finalStatus: r.finalStatus,
        preparedBy: r.preparedBy,
        preparedByName: r.preparedByName,
        preparedAt: iso(r.preparedAt),
        preparedVersionNo: r.preparedVersionNo,
        reviewedBy: r.reviewedBy,
        reviewedByName: r.reviewedByName,
        reviewedAt: iso(r.reviewedAt),
        approvedBy: r.approvedBy,
        approvedByName: r.approvedByName,
        approvedAt: iso(r.approvedAt),
        withdrawnBy: r.withdrawnBy,
        withdrawnByName: r.withdrawnByName,
        withdrawnAt: iso(r.withdrawnAt),
        versions: versions.map((v) => ({ ...v, savedAt: iso(v.savedAt)! })),
        events: events.map((e) => ({ ...e, occurredAt: iso(e.occurredAt)! })),
        capabilities: {
          canSave: r.canSave,
          canPrepare: r.canPrepare,
          canReview: r.canReview,
          canApprove: r.canApprove,
          canWithdraw: r.canWithdraw,
        },
      };
    });
  }

  startForm(
    ctx: UserRequestContext,
    i: { caseId: string; formCode: string; classification: string },
  ): Promise<string> {
    return this.run(ctx, async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        select api.start_form(${i.caseId}, ${i.formCode}, ${i.classification}::core.classification_level) as id`;
      return row!.id;
    });
  }

  saveDraft(ctx: UserRequestContext, instanceId: string, data: FormData): Promise<SavedFormVersion> {
    return this.run(ctx, async (tx) => {
      const [row] = await tx<SavedFormVersion[]>`
        select o_version_id as "versionId", o_version_no as "versionNo", o_content_hash as "contentHash"
        from api.save_form_draft(${instanceId}, ${tx.json(data)})`;
      return row!;
    });
  }

  prepare(ctx: UserRequestContext, instanceId: string): Promise<void> {
    return this.run(ctx, async (tx) => {
      await tx`select api.prepare_form(${instanceId})`;
    });
  }

  review(
    ctx: UserRequestContext,
    instanceId: string,
    outcome: FormReviewOutcome,
    reason?: string,
  ): Promise<void> {
    return this.run(ctx, async (tx) => {
      await tx`select api.review_form(${instanceId}, ${outcome}, ${reason ?? null})`;
    });
  }

  approve(
    ctx: UserRequestContext,
    instanceId: string,
    outcome: FormApprovalOutcome,
    reason?: string,
  ): Promise<void> {
    return this.run(ctx, async (tx) => {
      await tx`select api.approve_form(${instanceId}, ${outcome}, ${reason ?? null})`;
    });
  }

  withdraw(ctx: UserRequestContext, instanceId: string, reason: string): Promise<void> {
    return this.run(ctx, async (tx) => {
      await tx`select api.withdraw_form(${instanceId}, ${reason})`;
    });
  }
}
