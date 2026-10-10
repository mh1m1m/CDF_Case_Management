// EvidenceGateway over PostgreSQL. Reads go through RLS; writes only call api.* commands (ADR-003, ADR-006).
import {
  attachmentDisplayName,
  type CustodyEventInfo,
  type EvidenceItem,
  type EvidenceRejectionCode,
  type EvidenceVersionInfo,
  type ReportAttachmentItem,
} from "@cdf/contracts";
import type {
  EvidenceDownloadRecord,
  EvidenceGateway,
  ReportAttachmentDownloadRecord,
  RegisteredEvidenceVersion,
  UserRequestContext,
} from "@cdf/application";
import { withUserContext, type Sql, type Tx } from "./security-context";

const iso = (v: Date | string | null) => (v === null ? null : new Date(v).toISOString());

type VersionRow = Omit<EvidenceVersionInfo, "uploadedAt" | "storedAt" | "sizeBytes"> & {
  evidenceId: string;
  sizeBytes: string | number;
  uploadedAt: Date;
  storedAt: Date | null;
};
type CustodyRow = Omit<CustodyEventInfo, "occurredAt"> & { evidenceId: string; occurredAt: Date };
type EvidenceRow = Omit<
  EvidenceItem,
  "createdAt" | "collectedAt" | "currentVersion" | "versions" | "custody"
> & {
  currentVersionId: string | null;
  collectedAt: string | null;
  createdAt: Date;
};

export class PostgresEvidenceGateway implements EvidenceGateway {
  constructor(private readonly sql: Sql) {}

  private run<T>(ctx: UserRequestContext, fn: (tx: Tx) => Promise<T>) {
    return withUserContext(this.sql, ctx, fn);
  }

  listEvidence(ctx: UserRequestContext, caseId: string): Promise<EvidenceItem[]> {
    return this.run(ctx, async (tx) => {
      const items = await tx<EvidenceRow[]>`
        select e.id, e.case_id as "caseId", e.sequence_no as "sequenceNo", e.title, e.description,
               e.evidence_type as "evidenceType", e.source_description as "sourceDescription",
               e.collected_at::text as "collectedAt", e.classification, e.status, e.created_by as "createdBy",
               u.display_name as "createdByName", e.created_at as "createdAt", e.current_version_id as "currentVersionId"
        from evidence.evidence e left join iam.user_profile u on u.id = e.created_by
        where e.case_id = ${caseId} order by e.sequence_no`;
      if (items.length === 0) return [];
      const ids = items.map((i) => i.id);
      // object_key and request_id are not selectable by application roles and are never listed.
      const versions = await tx<VersionRow[]>`
        select v.id, v.evidence_id as "evidenceId", v.version_no as "versionNo", v.original_file_name as "originalFileName",
               v.content_type as "contentType", v.size_bytes as "sizeBytes", v.sha256, v.status, v.scan_status as "scanStatus",
               v.scanner, v.rejection_code as "rejectionCode", v.uploaded_by as "uploadedBy", u.display_name as "uploadedByName",
               v.uploaded_at as "uploadedAt", v.stored_at as "storedAt"
        from evidence.evidence_version v left join iam.user_profile u on u.id = v.uploaded_by
        where v.evidence_id = any(${ids}) order by v.version_no`;
      const custody = await tx<CustodyRow[]>`
        select c.id, c.evidence_id as "evidenceId", c.version_id as "versionId", c.event_type as "eventType",
               c.actor_id as "actorId", u.display_name as "actorName", c.occurred_at as "occurredAt"
        from evidence.custody_event c left join iam.user_profile u on u.id = c.actor_id
        where c.evidence_id = any(${ids}) order by c.seq`;
      const toVersion = (v: VersionRow): EvidenceVersionInfo => ({
        id: v.id,
        versionNo: v.versionNo,
        originalFileName: v.originalFileName,
        contentType: v.contentType,
        sizeBytes: Number(v.sizeBytes),
        sha256: v.sha256,
        status: v.status,
        scanStatus: v.scanStatus,
        scanner: v.scanner,
        rejectionCode: v.rejectionCode,
        uploadedBy: v.uploadedBy,
        uploadedByName: v.uploadedByName,
        uploadedAt: iso(v.uploadedAt)!,
        storedAt: iso(v.storedAt),
      });
      return items.map((e) => {
        const mine = versions.filter((v) => v.evidenceId === e.id).map(toVersion);
        return {
          id: e.id,
          caseId: e.caseId,
          sequenceNo: e.sequenceNo,
          title: e.title,
          description: e.description,
          evidenceType: e.evidenceType,
          sourceDescription: e.sourceDescription,
          collectedAt: e.collectedAt,
          classification: e.classification,
          status: e.status,
          createdBy: e.createdBy,
          createdByName: e.createdByName,
          createdAt: iso(e.createdAt)!,
          currentVersion: mine.find((v) => v.id === e.currentVersionId) ?? null,
          versions: mine,
          custody: custody
            .filter((c) => c.evidenceId === e.id)
            .map((c) => ({
              id: c.id,
              versionId: c.versionId,
              eventType: c.eventType,
              actorId: c.actorId,
              actorName: c.actorName,
              occurredAt: iso(c.occurredAt)!,
            })),
        };
      });
    });
  }

  registerVersion(
    ctx: UserRequestContext,
    i: Parameters<EvidenceGateway["registerVersion"]>[1],
  ): Promise<RegisteredEvidenceVersion> {
    return this.run(ctx, async (tx) => {
      const [row] = await tx<
        { evidenceId: string; versionId: string; versionNo: number; objectKey: string }[]
      >`
        select o_evidence_id as "evidenceId", o_version_id as "versionId", o_version_no as "versionNo", o_object_key as "objectKey"
        from api.register_evidence_version(
          ${i.caseId}, ${i.evidenceId ?? null}, ${i.title ?? null}, ${i.description ?? null}, ${i.evidenceType ?? null},
          ${i.sourceDescription ?? null}, ${i.collectedAt ?? null}, ${i.classification ?? null}::core.classification_level,
          ${i.fileName}, ${i.contentType}, ${i.sizeBytes}, ${i.sha256})`;
      return row!;
    });
  }

  completeVersion(ctx: UserRequestContext, versionId: string, scanner: string): Promise<void> {
    return this.run(ctx, async (tx) => {
      await tx`select api.complete_evidence_version(${versionId}, 'CLEAN', ${scanner})`;
    });
  }

  rejectVersion(
    ctx: UserRequestContext,
    versionId: string,
    reasonCode: EvidenceRejectionCode,
    scan?: { status: "INFECTED" | "UNSCANNED"; scanner: string },
  ): Promise<void> {
    return this.run(ctx, async (tx) => {
      await tx`select api.reject_evidence_version(${versionId}, ${reasonCode}, ${scan?.status ?? null}, ${scan?.scanner ?? null})`;
    });
  }

  openVersion(ctx: UserRequestContext, versionId: string): Promise<EvidenceDownloadRecord | null> {
    return this.run(ctx, async (tx) => {
      const [row] = await tx<(Omit<EvidenceDownloadRecord, "sizeBytes"> & { sizeBytes: string | number })[]>`
        select o_object_key as "objectKey", o_file_name as "fileName", o_content_type as "contentType",
               o_size_bytes as "sizeBytes", o_sha256 as "sha256", o_evidence_id as "evidenceId", o_case_id as "caseId"
        from api.open_evidence_version(${versionId})`;
      return row ? { ...row, sizeBytes: Number(row.sizeBytes) } : null;
    });
  }

  listReportAttachments(ctx: UserRequestContext, reportId: string): Promise<ReportAttachmentItem[]> {
    return this.run(ctx, async (tx) => {
      // RLS (authz.can_view_report) filters; object_key and request_id are not selectable.
      const rows = await tx<
        (Omit<ReportAttachmentItem, "displayName" | "sizeBytes" | "receivedAt"> & {
          fileExtension: string;
          sizeBytes: string | number;
          receivedAt: Date;
        })[]
      >`
        select a.id, a.sequence_no as "sequenceNo", a.source, a.file_extension as "fileExtension",
               a.content_type as "contentType", a.size_bytes as "sizeBytes", a.sha256, a.status,
               a.received_at as "receivedAt"
        from intake.report_attachment a where a.report_id = ${reportId} order by a.sequence_no`;
      return rows.map(({ fileExtension, ...r }) => ({
        ...r,
        displayName: attachmentDisplayName(r.sequenceNo, fileExtension),
        sizeBytes: Number(r.sizeBytes),
        receivedAt: new Date(r.receivedAt).toISOString(),
      }));
    });
  }

  openReportAttachment(
    ctx: UserRequestContext,
    attachmentId: string,
  ): Promise<ReportAttachmentDownloadRecord | null> {
    return this.run(ctx, async (tx) => {
      const [row] = await tx<
        (Omit<ReportAttachmentDownloadRecord, "sizeBytes"> & { sizeBytes: string | number })[]
      >`
        select o_object_key as "objectKey", o_display_name as "displayName", o_content_type as "contentType",
               o_size_bytes as "sizeBytes", o_sha256 as "sha256", o_report_id as "reportId"
        from api.open_report_attachment(${attachmentId})`;
      return row ? { ...row, sizeBytes: Number(row.sizeBytes) } : null;
    });
  }
}
