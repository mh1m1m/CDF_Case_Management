// BcpImportGateway over PostgreSQL (ADR-034, migration 1960). Every call runs the api.* command, or reads through
// RLS, in the caller's security context: the database decides the case gate, who may act on a batch, the separate
// approver and the hash binding.
import type { BcpImportGateway, UserRequestContext } from "@cdf/application";
import type {
  BcpBatchScope,
  BcpBatchStatus,
  BcpImportBatch,
  BcpImportBatchPage,
  BcpImportBatchView,
  BcpImportCounts,
  BcpPreview,
  BcpPreviewRow,
  BcpResolution,
  BcpRowState,
  BcpSubmitOutcome,
  SettingStatus,
} from "@cdf/contracts";
import { each, iso, isoOrNull, yes } from "./committee-proceedings-gateway";
import { accountNames } from "./export-gateway";
import { withUserContext, type Sql, type Tx } from "./security-context";

type P<K extends keyof BcpImportGateway> = Parameters<BcpImportGateway[K]>[1];

interface BatchRow {
  id: string;
  case_id: string;
  scope: BcpBatchScope;
  committee_proceeding_id: string | null;
  workbook_id: string;
  template_version: string;
  status: BcpBatchStatus;
  imported_by: string;
  preview_hash: string | null;
  preview_clean: boolean;
  submitted_hash: string | null;
  created_at: string;
  submitted_at: string | null;
  decided_at: string | null;
}

/** `api.bcp_import_batch_view` as the database returns it (final 2110:1546-1654): row metadata, never the cells. */
export interface RawBcpBatchView {
  batch_id: string;
  template_version: string;
  workbook_id: string;
  scope: BcpBatchScope;
  committee_proceeding_id: string | null;
  file_sha256: string;
  offline_from: string;
  offline_to: string | null;
  prepared_by: string;
  status: BcpBatchStatus;
  preview_hash: string | null;
  previewed_at: string | null;
  preview_clean: boolean | null;
  submitted_hash: string | null;
  imported_by: string;
  decided_by: string | null;
  decision_reason: string | null;
  created_at: string;
  submitted_at: string | null;
  decided_at: string | null;
  applied_at: string | null;
  cancelled_at: string | null;
  updated_at: string;
  row_version: number;
  current_hash: string;
  workbook_revoked: boolean | null;
  official_record_required: boolean | null;
  counts: { rows: number; unresolved: number; by_state: Partial<Record<BcpRowState, number>> | null } | null;
  rows:
    | {
        row_id: string;
        sheet_code: string;
        row_number: number;
        row_key: string | null;
        state: BcpRowState;
        detail: string | null;
        resolution: BcpResolution | null;
        resolution_reason: string | null;
        resolved_by: string | null;
        resolved_at: string | null;
        outcome: string | null;
        original_event_at: string | null;
        recorded_offline_by: string | null;
        purged_at: string | null;
        may_resolve: boolean | null;
      }[]
    | null;
  case: { case_id: string | null; case_number: string | null } | null;
  capabilities: Partial<
    Record<
      | "may_resolve_rows"
      | "may_preview"
      | "may_submit"
      | "may_decide"
      | "may_approve"
      | "may_apply"
      | "may_cancel",
      boolean | null
    >
  > | null;
}

/**
 * The view, renamed. A flag the database left out or null reads as false and a list it left out is empty (fail
 * closed); timestamps become ISO instants.
 */
export function toBcpImportBatchView(v: RawBcpBatchView): BcpImportBatchView {
  const k = v.capabilities ?? {};
  return {
    batchId: v.batch_id,
    templateVersion: v.template_version,
    workbookId: v.workbook_id,
    scope: v.scope,
    committeeProceedingId: v.committee_proceeding_id ?? null,
    fileSha256: v.file_sha256,
    offlineFrom: iso(v.offline_from),
    offlineTo: isoOrNull(v.offline_to),
    preparedBy: v.prepared_by,
    status: v.status,
    previewHash: v.preview_hash ?? null,
    previewedAt: isoOrNull(v.previewed_at),
    previewClean: yes(v.preview_clean),
    submittedHash: v.submitted_hash ?? null,
    importedBy: v.imported_by,
    decidedBy: v.decided_by ?? null,
    decisionReason: v.decision_reason ?? null,
    createdAt: iso(v.created_at),
    submittedAt: isoOrNull(v.submitted_at),
    decidedAt: isoOrNull(v.decided_at),
    appliedAt: isoOrNull(v.applied_at),
    cancelledAt: isoOrNull(v.cancelled_at),
    updatedAt: iso(v.updated_at),
    rowVersion: v.row_version,
    currentHash: v.current_hash,
    workbookRevoked: yes(v.workbook_revoked),
    officialRecordRequired: yes(v.official_record_required),
    counts: {
      rows: Number(v.counts?.rows ?? 0),
      unresolved: Number(v.counts?.unresolved ?? 0),
      byState: { ...(v.counts?.by_state ?? {}) },
    },
    rows: each(v.rows, (r) => ({
      rowId: r.row_id,
      sheetCode: r.sheet_code,
      rowNumber: r.row_number,
      rowKey: r.row_key ?? null,
      state: r.state,
      detail: r.detail ?? null,
      resolution: r.resolution ?? null,
      resolutionReason: r.resolution_reason ?? null,
      resolvedBy: r.resolved_by ?? null,
      resolvedAt: isoOrNull(r.resolved_at),
      outcome: r.outcome ?? null,
      originalEventAt: isoOrNull(r.original_event_at),
      recordedOfflineBy: r.recorded_offline_by ?? null,
      purgedAt: isoOrNull(r.purged_at),
      maySkip: yes(r.may_resolve),
    })),
    caseId: v.case?.case_id ?? null,
    caseNumber: v.case?.case_number ?? null,
    capabilities: {
      mayResolveRows: yes(k.may_resolve_rows),
      mayPreview: yes(k.may_preview),
      maySubmit: yes(k.may_submit),
      mayDecide: yes(k.may_decide),
      mayApprove: yes(k.may_approve),
      mayApply: yes(k.may_apply),
      mayCancel: yes(k.may_cancel),
    },
  };
}

/** Every account the view names, once. */
function namedAccounts(v: BcpImportBatchView): string[] {
  const ids = new Set<string>([v.importedBy, v.preparedBy]);
  if (v.decidedBy) ids.add(v.decidedBy);
  for (const r of v.rows) {
    if (r.resolvedBy) ids.add(r.resolvedBy);
    if (r.recordedOfflineBy) ids.add(r.recordedOfflineBy);
  }
  return [...ids];
}

export class PostgresBcpImportGateway implements BcpImportGateway {
  constructor(private readonly sql: Sql) {}

  private run<T>(ctx: UserRequestContext, fn: (tx: Tx) => Promise<T>) {
    return withUserContext(this.sql, ctx, fn);
  }

  /** The batch's purpose read (final 2110) and, in the same transaction, the names of the accounts it names. */
  view(ctx: UserRequestContext, batchId: string): Promise<BcpImportBatchPage> {
    return this.run(ctx, async (tx) => {
      const [r] = await tx<{ v: RawBcpBatchView }[]>`select api.bcp_import_batch_view(${batchId}) as v`;
      const view = toBcpImportBatchView(r!.v);
      const people = await accountNames(tx, namedAccounts(view));
      const [retention] = await tx<{ status: SettingStatus }[]>`
        select s.status from config.setting s where s.key = 'BCP_STAGING_RETENTION_DAYS'`;
      // No row reads as not configured: the page never claims a period that is not there (DEC-F31).
      return { view, people, stagingRetention: retention?.status ?? "SOURCE_REQUIRED" };
    });
  }

  stage(ctx: UserRequestContext, i: P<"stage">): Promise<string> {
    return this.run(ctx, async (tx) => {
      const [r] = await tx<{ id: string }[]>`
        select api.stage_bcp_import(${tx.json(i.control)}::jsonb, ${i.fileSha256}, ${tx.json(i.rows as never)}::jsonb) as id`;
      return r!.id;
    });
  }

  async resolve(ctx: UserRequestContext, i: P<"resolve">): Promise<void> {
    await this.run(ctx, (tx) => tx`select api.resolve_bcp_row(${i.rowId}, ${i.resolution}, ${i.reason})`);
  }

  preview(ctx: UserRequestContext, i: P<"preview">): Promise<BcpPreview> {
    return this.run(ctx, async (tx) => {
      const [r] = await tx<{ preview: BcpPreview }[]>`select api.preview_bcp_import(${i.batchId}) as preview`;
      return r!.preview;
    });
  }

  submit(ctx: UserRequestContext, i: P<"submit">): Promise<BcpSubmitOutcome> {
    return this.run(ctx, async (tx) => {
      const [r] = await tx<{ status: BcpSubmitOutcome }[]>`
        select api.submit_bcp_import(${i.batchId}, ${i.previewHash}) as status`;
      return r!.status;
    });
  }

  decide(ctx: UserRequestContext, i: P<"decide">): Promise<BcpBatchStatus> {
    return this.run(ctx, async (tx) => {
      const [r] = await tx<{ status: BcpBatchStatus }[]>`
        select api.decide_bcp_import(${i.batchId}, ${i.decision}, ${i.reason}, ${i.previewHash}) as status`;
      return r!.status;
    });
  }

  apply(ctx: UserRequestContext, i: P<"apply">): Promise<BcpImportCounts> {
    return this.run(ctx, async (tx) => {
      const [r] = await tx<{ counts: BcpImportCounts }[]>`
        select api.apply_bcp_import(${i.batchId}, ${i.previewHash}) as counts`;
      return r!.counts;
    });
  }

  async cancel(ctx: UserRequestContext, i: P<"cancel">): Promise<void> {
    await this.run(ctx, (tx) => tx`select api.cancel_bcp_import(${i.batchId}, ${i.reason})`);
  }

  list(ctx: UserRequestContext, filter: P<"list">): Promise<BcpImportBatch[]> {
    return this.run(ctx, async (tx) => {
      const rows = await tx<BatchRow[]>`
        select b.id, b.case_id, b.scope, b.committee_proceeding_id, b.workbook_id, b.template_version, b.status,
               b.imported_by, b.preview_hash, b.preview_clean, b.submitted_hash, b.created_at::text as created_at,
               b.submitted_at::text as submitted_at, b.decided_at::text as decided_at
        from exchange.bcp_import_batch b
        where (${filter.caseId ?? null}::uuid is null or b.case_id = ${filter.caseId ?? null}::uuid)
        order by b.created_at desc, b.id
        limit 200`;
      return rows.map((r) => ({
        id: r.id,
        caseId: r.case_id,
        scope: r.scope,
        committeeProceedingId: r.committee_proceeding_id,
        workbookId: r.workbook_id,
        templateVersion: r.template_version,
        status: r.status,
        importedBy: r.imported_by,
        previewHash: r.preview_hash,
        previewClean: r.preview_clean,
        submittedHash: r.submitted_hash,
        createdAt: r.created_at,
        submittedAt: r.submitted_at,
        decidedAt: r.decided_at,
      }));
    });
  }

  rows(ctx: UserRequestContext, batchId: string): Promise<BcpPreviewRow[]> {
    return this.run(ctx, (tx) =>
      tx<BcpPreviewRow[]>`
        select r.id, r.sheet_code as sheet, r.row_number, r.row_key, r.state, r.detail, r.resolution, r.outcome
        from exchange.bcp_import_row r
        join exchange.bcp_template_sheet s on s.template_version = r.template_version and s.sheet_code = r.sheet_code
        where r.batch_id = ${batchId}::uuid
        order by s.position, r.row_number`.then((rows) => [...rows]),
    );
  }
}
