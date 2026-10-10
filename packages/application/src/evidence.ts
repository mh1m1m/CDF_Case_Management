/**
 * Evidence use cases (§24–§27; ADR-006). The upload pipeline is
 *   validate metadata → pre-check permission → check the file (name, extension, size, sniffed type)
 *   → SHA-256 → register the version (QUARANTINED) → put in quarantine → scan
 *   → promote to the vault and complete (AVAILABLE), or reject (REJECTED).
 * Every database step is a command that writes its own custody and audit records; the file content
 * never reaches the database, the audit ledger or any log.
 */
import type { Actor } from "@cdf/contracts";
import { can } from "@cdf/authorization";
import type { SecurityEventSink } from "@cdf/audit";
import { checkEvidenceFile } from "@cdf/domain";
import { uploadEvidenceSchema } from "@cdf/validation";
import { AppError, toAppError } from "./errors";
import type { CommandResult } from "./investigation";
import type { EvidenceGateway, EvidenceStorage, MalwareScanner, UserRequestContext } from "./ports";

export interface EvidenceDeps {
  gateway: EvidenceGateway;
  storage: EvidenceStorage;
  scanner: MalwareScanner;
  securityEvents: SecurityEventSink;
}

export interface EvidenceFile {
  name: string;
  bytes: Uint8Array;
}

export interface UploadedEvidence {
  evidenceId: string;
  versionId: string;
  versionNo: number;
  sha256: string;
}

export interface EvidenceDownload {
  stream: ReadableStream<Uint8Array>;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function createEvidenceService(deps: EvidenceDeps) {
  const { gateway, storage, scanner, securityEvents } = deps;

  async function securityEvent(
    ctx: UserRequestContext,
    action: "COMMAND_DENIED" | "VALIDATION_REJECTED",
    objectId: string | undefined,
    metadata: Record<string, string | boolean>,
  ) {
    try {
      await securityEvents.record({ action, objectType: "evidence", objectId, metadata }, ctx);
    } catch {
      // Recording must never mask the original outcome.
    }
  }

  /** Marks the version rejected; a failure here must not hide the original problem. */
  async function rejectQuietly(
    ctx: UserRequestContext,
    versionId: string,
    reasonCode: "MALWARE_DETECTED" | "SCAN_UNAVAILABLE" | "STORAGE_FAILURE",
    scan?: { status: "INFECTED" | "UNSCANNED"; scanner: string },
  ) {
    try {
      await gateway.rejectVersion(ctx, versionId, reasonCode, scan);
    } catch {
      // The version stays QUARANTINED and is visible as such; operators can see the audit trail.
    }
  }

  return {
    listEvidence: async (ctx: UserRequestContext, caseId: string) => {
      try {
        return await gateway.listEvidence(ctx, caseId);
      } catch (cause) {
        throw toAppError(cause, ctx.requestId);
      }
    },

    async upload(
      ctx: UserRequestContext,
      actor: Actor,
      rawMetadata: unknown,
      file: EvidenceFile,
    ): Promise<CommandResult<UploadedEvidence>> {
      const parsed = uploadEvidenceSchema.safeParse(rawMetadata);
      if (!parsed.success) return { ok: false, fieldErrors: parsed.error };
      const meta = parsed.data;

      if (!can(actor, "EVIDENCE_UPLOAD")) {
        const error = new AppError("FORBIDDEN", ctx.requestId);
        await securityEvent(ctx, "COMMAND_DENIED", meta.caseId, {
          command: "upload_evidence",
          outcome: "FORBIDDEN",
        });
        return { ok: false, error };
      }

      const check = checkEvidenceFile({ fileName: file.name, size: file.bytes.length, bytes: file.bytes });
      if (!check.ok) {
        // A rejected file is security-relevant (T10); the event carries the reason, never the content.
        await securityEvent(ctx, "VALIDATION_REJECTED", meta.caseId, {
          command: "upload_evidence",
          reason: check.reason,
          extension: /\.([A-Za-z0-9]{1,10})$/.exec(check.fileName)?.[1]?.toLowerCase() ?? "",
        });
        return { ok: false, error: new AppError("INVALID", ctx.requestId, `FILE_${check.reason}`) };
      }

      const sha256 = await sha256Hex(file.bytes);
      let registered;
      try {
        registered = await gateway.registerVersion(ctx, {
          caseId: meta.caseId,
          evidenceId: meta.evidenceId,
          title: meta.title,
          description: meta.description,
          evidenceType: meta.evidenceType,
          sourceDescription: meta.sourceDescription,
          collectedAt: meta.collectedAt,
          classification: meta.classification,
          fileName: check.fileName,
          contentType: check.contentType,
          sizeBytes: file.bytes.length,
          sha256,
        });
      } catch (cause) {
        const error = toAppError(cause, ctx.requestId);
        if (error.kind === "FORBIDDEN" || error.kind === "NOT_FOUND")
          await securityEvent(ctx, "COMMAND_DENIED", meta.caseId, {
            command: "upload_evidence",
            outcome: error.kind,
          });
        return { ok: false, error };
      }

      try {
        await storage.putQuarantine(registered.objectKey, file.bytes, check.contentType);
      } catch (cause) {
        await rejectQuietly(ctx, registered.versionId, "STORAGE_FAILURE");
        return { ok: false, error: new AppError("UNAVAILABLE", ctx.requestId, "STORAGE_FAILURE", { cause }) };
      }

      let scan;
      try {
        scan = await scanner.scan(file.bytes, {
          contentType: check.contentType,
          objectKey: registered.objectKey,
        });
      } catch {
        scan = { status: "UNSCANNED" as const, scanner: scanner.name };
      }
      if (scan.status === "INFECTED") {
        await rejectQuietly(ctx, registered.versionId, "MALWARE_DETECTED", {
          status: "INFECTED",
          scanner: scan.scanner,
        });
        return { ok: false, error: new AppError("CONFLICT", ctx.requestId, "MALWARE_DETECTED") };
      }
      if (scan.status === "UNSCANNED") {
        await rejectQuietly(ctx, registered.versionId, "SCAN_UNAVAILABLE", {
          status: "UNSCANNED",
          scanner: scan.scanner,
        });
        return { ok: false, error: new AppError("CONFLICT", ctx.requestId, "SCAN_UNAVAILABLE") };
      }

      try {
        await storage.promoteToVault(registered.objectKey);
      } catch (cause) {
        await rejectQuietly(ctx, registered.versionId, "STORAGE_FAILURE");
        return { ok: false, error: new AppError("UNAVAILABLE", ctx.requestId, "STORAGE_FAILURE", { cause }) };
      }
      try {
        await gateway.completeVersion(ctx, registered.versionId, scan.scanner);
      } catch (cause) {
        return { ok: false, error: toAppError(cause, ctx.requestId) };
      }
      return {
        ok: true,
        value: {
          evidenceId: registered.evidenceId,
          versionId: registered.versionId,
          versionNo: registered.versionNo,
          sha256,
        },
      };
    },

    /** Reporter attachments on a report the caller can view (CDF-72); RLS decides visibility. */
    listReportAttachments: async (ctx: UserRequestContext, reportId: string) => {
      try {
        return await gateway.listReportAttachments(ctx, reportId);
      } catch (cause) {
        throw toAppError(cause, ctx.requestId);
      }
    },

    /**
     * Streams a reporter attachment after the database gate (clean scan, report visibility, download
     * right). Null when missing, hidden, quarantined or rejected (all alike, §40).
     */
    async openReportAttachment(
      ctx: UserRequestContext,
      attachmentId: string,
    ): Promise<EvidenceDownload | null> {
      let record;
      try {
        record = await gateway.openReportAttachment(ctx, attachmentId);
      } catch (cause) {
        throw toAppError(cause, ctx.requestId);
      }
      if (!record) return null;
      try {
        const stream = await storage.openReadStream(record.objectKey);
        return {
          stream,
          fileName: record.displayName,
          contentType: record.contentType,
          sizeBytes: record.sizeBytes,
          sha256: record.sha256,
        };
      } catch (cause) {
        throw new AppError("UNAVAILABLE", ctx.requestId, "STORAGE_FAILURE", { cause });
      }
    },

    /** Null when the version is missing, not visible, not downloadable or not yet available (all alike). */
    async openDownload(ctx: UserRequestContext, versionId: string): Promise<EvidenceDownload | null> {
      let record;
      try {
        record = await gateway.openVersion(ctx, versionId);
      } catch (cause) {
        throw toAppError(cause, ctx.requestId);
      }
      if (!record) return null;
      try {
        const stream = await storage.openReadStream(record.objectKey);
        return {
          stream,
          fileName: record.fileName,
          contentType: record.contentType,
          sizeBytes: record.sizeBytes,
          sha256: record.sha256,
        };
      } catch (cause) {
        throw new AppError("UNAVAILABLE", ctx.requestId, "STORAGE_FAILURE", { cause });
      }
    },
  };
}
export type EvidenceService = ReturnType<typeof createEvidenceService>;
