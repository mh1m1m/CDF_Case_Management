// BcpImportGateway over PostgreSQL (ADR-034, migration 1960). Every call runs the api.* command, or reads through
// RLS, in the caller's security context: the database decides the case gate, who may act on a batch, the separate
// approver and the hash binding.
import type { BcpImportGateway, UserRequestContext } from "@cdf/application";
import type {
  BcpBatchScope,
  BcpBatchStatus,
  BcpImportBatch,
  BcpImportCounts,
  BcpPreview,
  BcpPreviewRow,
  BcpSubmitOutcome,
} from "@cdf/contracts";
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

export class PostgresBcpImportGateway implements BcpImportGateway {
  constructor(private readonly sql: Sql) {}

  private run<T>(ctx: UserRequestContext, fn: (tx: Tx) => Promise<T>) {
    return withUserContext(this.sql, ctx, fn);
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
