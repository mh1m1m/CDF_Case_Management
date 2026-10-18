/**
 * The official record of a committee continuity workbook (migration 2115, ADR-061; the owner's decision on AMB-201):
 * Layer 1, the final signed CDF minutes, and Layer 2, the chair's (or a formally activated acting chair's) approval and
 * each attending eligible member's own attestation. Neither replaces the other; the workbook commits only when both
 * are present and reconciled (api.apply_bcp_import, through BcpImportService).
 *
 * Each command:
 *   1. validates input with the shared Zod schema (§45),
 *   2. needs no permission code: who may act comes from the caller's seat, their line on the record and the record's
 *      state, which only the database knows (no role, platform or technical administrator acts by role, §11),
 *   3. runs the api.* command in the caller's security context (the authoritative check),
 *   4. maps failures to safe AppErrors and records refusals as COMMAND_DENIED SECURITY events (§30).
 * The signed minutes are uploaded through the evidence pattern (R7): checked (PDF or image, content matching its
 * extension), hashed, registered QUARANTINED, put in quarantine, scanned, promoted and completed; a version that fails
 * a step stays QUARANTINED and is never the record (PRODUCTION_SUBSTITUTION_REQUIRED: the CDF scanning service and
 * OSS). A version is served only while its content still matches its SHA-256. Reasons, file names and file content are
 * committee content: they are never logged (§83).
 */
import type { CommitteeMinutesOpened, CommitteeRecordStatus } from "@cdf/contracts";
import { COMMITTEE_MINUTES_MAX_BYTES } from "@cdf/contracts";
import type { SecurityEventSink } from "@cdf/audit";
import { checkCommitteeMinutesFile } from "@cdf/domain";
import {
  activateRecordActingChairSchema,
  attestCommitteeRecordSchema,
  committeeMinutesDocumentSchema,
  committeeRecordBatchSchema,
  decideCommitteeRecordSchema,
  declareCommitteeRecordRosterSchema,
  endRecordActingChairSchema,
  returnCommitteeRecordSchema,
  uploadCommitteeMinutesSchema,
} from "@cdf/validation";
import type { z } from "zod";
import { AppError, toAppError } from "./errors";
import type { CommandResult } from "./investigation";
import type { EvidenceStorage, MalwareScanner, UserRequestContext } from "./ports";

type In<S extends z.ZodType> = z.output<S>;

export interface RegisterCommitteeMinutes {
  recordId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  meetingDate: string;
  templateReference: string;
  classification: In<typeof uploadCommitteeMinutesSchema>["classification"];
}

/** Port over the committee record's api.* commands (implemented in @cdf/infrastructure). The role-shaped read
 *  models ship with the Section 13 screens. */
export interface CommitteeRecordGateway {
  open(ctx: UserRequestContext, input: In<typeof committeeRecordBatchSchema>): Promise<string>;
  declareRoster(ctx: UserRequestContext, input: In<typeof declareCommitteeRecordRosterSchema>): Promise<void>;
  registerDocument(
    ctx: UserRequestContext,
    input: RegisterCommitteeMinutes,
  ): Promise<{ documentId: string; versionNo: number; objectKey: string }>;
  completeDocument(ctx: UserRequestContext, documentId: string, scanner: string): Promise<void>;
  markSigned(ctx: UserRequestContext, input: In<typeof committeeMinutesDocumentSchema>): Promise<void>;
  /** The key and metadata of a stored version the caller may see; NOT_FOUND otherwise (the database decides). */
  openDocument(ctx: UserRequestContext, documentId: string): Promise<CommitteeMinutesOpened>;
  activateActingChair(
    ctx: UserRequestContext,
    input: In<typeof activateRecordActingChairSchema>,
  ): Promise<string>;
  endActingChair(ctx: UserRequestContext, input: In<typeof endRecordActingChairSchema>): Promise<void>;
  decide(
    ctx: UserRequestContext,
    input: In<typeof decideCommitteeRecordSchema>,
  ): Promise<CommitteeRecordStatus>;
  returnRecord(ctx: UserRequestContext, input: In<typeof returnCommitteeRecordSchema>): Promise<void>;
  attest(
    ctx: UserRequestContext,
    input: In<typeof attestCommitteeRecordSchema>,
  ): Promise<"ATTESTED" | "DECLINED_WITH_REASON">;
}

export interface CommitteeRecordDeps {
  gateway: CommitteeRecordGateway;
  storage: EvidenceStorage;
  scanner: MalwareScanner;
  securityEvents: SecurityEventSink;
}

export interface CommitteeMinutesFile {
  name: string;
  bytes: Uint8Array;
}

export interface UploadedCommitteeMinutes {
  documentId: string;
  versionNo: number;
  sha256: string;
}

export interface CommitteeMinutesDownload {
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

/** Reads a stored object into memory, stopping once past the size limit (a larger object cannot be intact). */
async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total <= COMMITTEE_MINUTES_MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return bytes;
}

export function createCommitteeRecordService(deps: CommitteeRecordDeps) {
  const { gateway, storage, scanner, securityEvents } = deps;

  async function securityEvent(
    ctx: UserRequestContext,
    action: "ACCESS_DENIED" | "COMMAND_DENIED" | "VALIDATION_REJECTED",
    objectType: string,
    objectId: string | undefined,
    metadata: Record<string, string>,
  ) {
    try {
      await securityEvents.record({ action, objectType, objectId, metadata }, ctx);
    } catch {
      // Recording must never mask the original outcome.
    }
  }

  async function recordDenial(ctx: UserRequestContext, name: string, error: AppError, objectId?: string) {
    if (error.kind !== "FORBIDDEN" && error.kind !== "NOT_FOUND") return;
    await securityEvent(ctx, "COMMAND_DENIED", "command", objectId, { command: name, outcome: error.kind });
  }

  async function command<S extends z.ZodType, T>(
    ctx: UserRequestContext,
    name: string,
    schema: S,
    raw: unknown,
    run: (input: In<S>) => Promise<T>,
    objectId: (input: In<S>) => string,
  ): Promise<CommandResult<T>> {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) return { ok: false, fieldErrors: parsed.error };
    try {
      return { ok: true, value: await run(parsed.data) };
    } catch (cause) {
      const error = toAppError(cause, ctx.requestId);
      await recordDenial(ctx, name, error, objectId(parsed.data));
      return { ok: false, error };
    }
  }

  const byRecord = (i: { recordId: string }) => i.recordId;

  return {
    open: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "open_committee_record",
        committeeRecordBatchSchema,
        raw,
        (i) => gateway.open(ctx, i),
        (i) => i.batchId,
      ),

    declareRoster: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "declare_committee_record_roster",
        declareCommitteeRecordRosterSchema,
        raw,
        (i) => gateway.declareRoster(ctx, i),
        byRecord,
      ),

    /**
     * One new version of the signed minutes (§15: never overwritten). The importer then marks it as the signed
     * official record (markSigned); a version that fails any step stays QUARANTINED and can never be marked.
     */
    async uploadMinutes(
      ctx: UserRequestContext,
      rawMetadata: unknown,
      file: CommitteeMinutesFile,
    ): Promise<CommandResult<UploadedCommitteeMinutes>> {
      const parsed = uploadCommitteeMinutesSchema.safeParse(rawMetadata);
      if (!parsed.success) return { ok: false, fieldErrors: parsed.error };
      const meta = parsed.data;

      const check = checkCommitteeMinutesFile({
        fileName: file.name,
        size: file.bytes.length,
        bytes: file.bytes,
      });
      if (!check.ok) {
        // A refused file is security-relevant (T10); the event carries the reason code, never the name or content.
        await securityEvent(ctx, "VALIDATION_REJECTED", "bcp_committee_record", meta.recordId, {
          command: "register_committee_record_document",
          reason: check.reason,
        });
        return { ok: false, error: new AppError("INVALID", ctx.requestId, `FILE_${check.reason}`) };
      }

      const sha256 = await sha256Hex(file.bytes);
      let registered;
      try {
        registered = await gateway.registerDocument(ctx, {
          recordId: meta.recordId,
          fileName: check.fileName,
          contentType: check.contentType,
          sizeBytes: file.bytes.length,
          sha256,
          meetingDate: meta.meetingDate,
          templateReference: meta.templateReference,
          classification: meta.classification,
        });
      } catch (cause) {
        const error = toAppError(cause, ctx.requestId);
        await recordDenial(ctx, "register_committee_record_document", error, meta.recordId);
        return { ok: false, error };
      }

      try {
        await storage.putQuarantine(registered.objectKey, file.bytes, check.contentType);
      } catch (cause) {
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
        await securityEvent(ctx, "VALIDATION_REJECTED", "bcp_record_document", registered.documentId, {
          command: "complete_committee_record_document",
          reason: "MALWARE_DETECTED",
        });
        return { ok: false, error: new AppError("CONFLICT", ctx.requestId, "MALWARE_DETECTED") };
      }
      if (scan.status !== "CLEAN") {
        return { ok: false, error: new AppError("CONFLICT", ctx.requestId, "SCAN_UNAVAILABLE") };
      }
      try {
        await storage.promoteToVault(registered.objectKey);
      } catch (cause) {
        return { ok: false, error: new AppError("UNAVAILABLE", ctx.requestId, "STORAGE_FAILURE", { cause }) };
      }
      try {
        await gateway.completeDocument(ctx, registered.documentId, scan.scanner);
      } catch (cause) {
        const error = toAppError(cause, ctx.requestId);
        await recordDenial(ctx, "complete_committee_record_document", error, registered.documentId);
        return { ok: false, error };
      }
      return {
        ok: true,
        value: { documentId: registered.documentId, versionNo: registered.versionNo, sha256 },
      };
    },

    markSigned: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "mark_committee_minutes_signed",
        committeeMinutesDocumentSchema,
        raw,
        (i) => gateway.markSigned(ctx, i),
        (i) => i.documentId,
      ),

    /**
     * Streams a stored version to whoever may see it (the chair reviews the signed minutes against the workbook, §13).
     * Null when missing, hidden or not stored (all alike, §40). Content that no longer matches its SHA-256 is never
     * served: the reader gets a generic error and a SECURITY event records the mismatch (no name, no content).
     */
    async openMinutes(ctx: UserRequestContext, documentId: string): Promise<CommitteeMinutesDownload | null> {
      const parsed = committeeMinutesDocumentSchema.safeParse({ documentId });
      if (!parsed.success) return null;
      let record: CommitteeMinutesOpened;
      try {
        record = await gateway.openDocument(ctx, parsed.data.documentId);
      } catch (cause) {
        const error = toAppError(cause, ctx.requestId);
        if (error.kind === "NOT_FOUND") {
          await securityEvent(ctx, "ACCESS_DENIED", "bcp_record_document", parsed.data.documentId, {
            read: "open_committee_record_document",
          });
          return null;
        }
        if (error.kind === "CONFLICT") return null;
        throw error;
      }
      let bytes: Uint8Array;
      try {
        bytes = await readAll(await storage.openReadStream(record.objectKey));
      } catch (cause) {
        throw new AppError("UNAVAILABLE", ctx.requestId, "STORAGE_FAILURE", { cause });
      }
      if ((await sha256Hex(bytes)) !== record.sha256) {
        await securityEvent(ctx, "VALIDATION_REJECTED", "bcp_record_document", parsed.data.documentId, {
          command: "open_committee_record_document",
          reason: "INTEGRITY_FAILED",
        });
        throw new AppError("UNAVAILABLE", ctx.requestId, "MINUTES_INTEGRITY_FAILED");
      }
      return {
        stream: new Blob([bytes as Uint8Array<ArrayBuffer>]).stream() as ReadableStream<Uint8Array>,
        fileName: record.fileName,
        contentType: record.contentType,
        sizeBytes: bytes.byteLength,
        sha256: record.sha256,
      };
    },

    activateActingChair: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "activate_record_acting_chair",
        activateRecordActingChairSchema,
        raw,
        (i) => gateway.activateActingChair(ctx, i),
        byRecord,
      ),

    endActingChair: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "end_record_acting_chair",
        endRecordActingChairSchema,
        raw,
        (i) => gateway.endActingChair(ctx, i),
        (i) => i.activationId,
      ),

    /** The chair's (or the acting chair's) decision on the revision they reviewed. */
    decide: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "decide_committee_record",
        decideCommitteeRecordSchema,
        raw,
        (i) => gateway.decide(ctx, i),
        byRecord,
      ),

    returnRecord: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "return_committee_record",
        returnCommitteeRecordSchema,
        raw,
        (i) => gateway.returnRecord(ctx, i),
        byRecord,
      ),

    /** The caller's own attestation or decline; the input names no user (nobody attests for another, §7). */
    attest: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "attest_committee_record",
        attestCommitteeRecordSchema,
        raw,
        (i) => gateway.attest(ctx, i),
        byRecord,
      ),
  };
}

export type CommitteeRecordService = ReturnType<typeof createCommitteeRecordService>;
