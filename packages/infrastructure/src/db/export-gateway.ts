// ExportGateway over PostgreSQL (ADR-026, migration 1930). Every call runs the api.* export command in the caller's
// security context; the database renders each item with the same predicates as RLS and binds approvals to hashes.
import type { ExportGateway, UserRequestContext } from "@cdf/application";
import type {
  Classification,
  ExportAudience,
  ExportDocument,
  ExportFormat,
  ExportObjectType,
  ExportPreview,
  ExportPurpose,
  ExportStatus,
  GeneratedExport,
} from "@cdf/contracts";
import { withUserContext, type Sql, type Tx } from "./security-context";

interface DocumentRow {
  request_id: string;
  case_id: string;
  case_number: string;
  classification: Classification;
  format: ExportFormat;
  audience: ExportAudience;
  purpose: ExportPurpose;
  external_party: string | null;
  items: {
    position: number;
    object_type: ExportObjectType;
    object_id: string;
    included: boolean;
    content: Record<string, unknown> | null;
  }[];
}

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

export class PostgresExportGateway implements ExportGateway {
  constructor(private readonly sql: Sql) {}

  private run<T>(ctx: UserRequestContext, fn: (tx: Tx) => Promise<T>) {
    return withUserContext(this.sql, ctx, fn);
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

  generate<T>(
    ctx: UserRequestContext,
    requestId: string,
    write: (generated: GeneratedExport) => Promise<T>,
  ): Promise<{ generated: GeneratedExport; written: T }> {
    return this.run(ctx, async (tx) => {
      const [r] = await tx<
        { g: { storage_key: string; hash: string; document: DocumentRow; deliver_to: string[] } }[]
      >`select api.generate_export(${requestId}) as g`;
      const generated: GeneratedExport = {
        storageKey: r!.g.storage_key,
        hash: r!.g.hash,
        document: toDocument(r!.g.document),
        deliverTo: r!.g.deliver_to,
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
