// CommitteeRecordGateway over PostgreSQL (migration 2115, ADR-061). Every call runs the api.* command in the caller's
// security context: the database decides who sees the record, who may act on it, in which state and on which revision.
import type { CommitteeRecordGateway, UserRequestContext } from "@cdf/application";
import type {
  CommitteeMinutesContentType,
  CommitteeMinutesOpened,
  CommitteeRecordStatus,
} from "@cdf/contracts";
import { withUserContext, type Sql, type Tx } from "./security-context";

type P<K extends keyof CommitteeRecordGateway> = Parameters<CommitteeRecordGateway[K]>[1];

export class PostgresCommitteeRecordGateway implements CommitteeRecordGateway {
  constructor(private readonly sql: Sql) {}

  private run<T>(ctx: UserRequestContext, fn: (tx: Tx) => Promise<T>) {
    return withUserContext(this.sql, ctx, fn);
  }

  open(ctx: UserRequestContext, i: P<"open">): Promise<string> {
    return this.run(ctx, async (tx) => {
      const [r] = await tx<{ id: string }[]>`select api.open_committee_record(${i.batchId}::uuid) as id`;
      return r!.id;
    });
  }

  async declareRoster(ctx: UserRequestContext, i: P<"declareRoster">): Promise<void> {
    const lines = i.lines.map((l) => ({
      roster_id: l.rosterId,
      attendance: l.attendance,
      joined_late: l.joinedLate,
      left_early: l.leftEarly,
      signature_visible: l.signatureVisible,
      signed_as_chair: l.signedAsChair,
    }));
    await this.run(
      ctx,
      (tx) =>
        tx`select api.declare_committee_record_roster(${i.recordId}::uuid, ${tx.json(lines as never)}::jsonb)`,
    );
  }

  registerDocument(ctx: UserRequestContext, i: P<"registerDocument">) {
    return this.run(ctx, async (tx) => {
      const [r] = await tx<{ document_id: string; version_no: number; object_key: string }[]>`
        select o_document_id as document_id, o_version_no as version_no, o_object_key as object_key
        from api.register_committee_record_document(${i.recordId}::uuid, ${i.fileName}, ${i.contentType},
          ${i.sizeBytes}, ${i.sha256}, ${i.meetingDate}::date, ${i.templateReference},
          ${i.classification}::core.classification_level)`;
      return { documentId: r!.document_id, versionNo: r!.version_no, objectKey: r!.object_key };
    });
  }

  async completeDocument(ctx: UserRequestContext, documentId: string, scanner: string): Promise<void> {
    await this.run(
      ctx,
      (tx) => tx`select api.complete_committee_record_document(${documentId}::uuid, 'CLEAN', ${scanner})`,
    );
  }

  async markSigned(ctx: UserRequestContext, i: P<"markSigned">): Promise<void> {
    await this.run(ctx, (tx) => tx`select api.mark_committee_minutes_signed(${i.documentId}::uuid)`);
  }

  openDocument(ctx: UserRequestContext, documentId: string): Promise<CommitteeMinutesOpened> {
    return this.run(ctx, async (tx) => {
      const [r] = await tx<
        {
          object_key: string;
          content_type: CommitteeMinutesContentType;
          file_name: string;
          size_bytes: string | number;
          sha256: string;
        }[]
      >`
        select o_object_key as object_key, o_content_type as content_type, o_original_file_name as file_name,
               o_size_bytes as size_bytes, o_sha256 as sha256
        from api.open_committee_record_document(${documentId}::uuid)`;
      return {
        objectKey: r!.object_key,
        contentType: r!.content_type,
        fileName: r!.file_name,
        sizeBytes: Number(r!.size_bytes),
        sha256: r!.sha256,
      };
    });
  }

  activateActingChair(ctx: UserRequestContext, i: P<"activateActingChair">): Promise<string> {
    return this.run(ctx, async (tx) => {
      const [r] = await tx<{ id: string }[]>`
        select api.activate_record_acting_chair(${i.recordId}::uuid, ${i.basis}, ${i.reason},
          ${i.effectiveTo}::timestamptz) as id`;
      return r!.id;
    });
  }

  async endActingChair(ctx: UserRequestContext, i: P<"endActingChair">): Promise<void> {
    await this.run(ctx, (tx) => tx`select api.end_record_acting_chair(${i.activationId}::uuid, ${i.reason})`);
  }

  decide(ctx: UserRequestContext, i: P<"decide">): Promise<CommitteeRecordStatus> {
    return this.run(ctx, async (tx) => {
      const [r] = await tx<{ status: CommitteeRecordStatus }[]>`
        select api.decide_committee_record(${i.recordId}::uuid, ${i.revision}, ${i.decision}, ${i.reason ?? null})
          as status`;
      return r!.status;
    });
  }

  async returnRecord(ctx: UserRequestContext, i: P<"returnRecord">): Promise<void> {
    await this.run(ctx, (tx) => tx`select api.return_committee_record(${i.recordId}::uuid, ${i.reason})`);
  }

  attest(ctx: UserRequestContext, i: P<"attest">): Promise<"ATTESTED" | "DECLINED_WITH_REASON"> {
    return this.run(ctx, async (tx) => {
      const [r] = await tx<{ outcome: "ATTESTED" | "DECLINED_WITH_REASON" }[]>`
        select api.attest_committee_record(${i.recordId}::uuid, ${i.revision}, ${i.action},
          ${i.discrepancyCode ?? null}, ${i.reason ?? null}) as outcome`;
      return r!.outcome;
    });
  }
}
