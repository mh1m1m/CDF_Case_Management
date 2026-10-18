/**
 * Continuity workbook import (ADR-034, migration 1960, Q100). Staging an upload:
 *   1. validates the upload form and pre-checks BCP_IMPORT (first enforcement point, §19),
 *   2. checks the file's type and size, then scans it (MalwareScanner; anything but CLEAN refuses it),
 *   3. reads it through the WorkbookReader port (untrusted input, ADR-034 D3) and checks it is the BCP-1 template,
 *   4. validates the control row and rows with the shared schema (§45) and hashes the file,
 *   5. stages it through api.stage_bcp_import, which checks everything again and classifies every row.
 * The other commands validate, pre-check and run their api.* command; the database decides who may act on a batch,
 * the separate approver and the hash binding (second enforcement point, authoritative). Refusals are recorded as
 * COMMAND_DENIED or VALIDATION_REJECTED security events with codes only. The file is not kept, only its SHA-256
 * (PRODUCTION_SUBSTITUTION_REQUIRED: the original kept in the private evidence store). Nothing here logs cell text,
 * file names or file content (§83).
 *
 * UX redesign P12-6b-1: the batch's page reads `api.bcp_import_batch_view` (final 2110), row metadata only; a batch
 * the caller may not see is the uniform not-found, recorded as ACCESS_DENIED.
 */
import {
  BCP_MAX_WORKBOOK_BYTES,
  type Actor,
  type BcpBatchStatus,
  type BcpImportBatch,
  type BcpImportBatchPage,
  type BcpImportCounts,
  type BcpPreview,
  type BcpPreviewRow,
  type BcpSubmitOutcome,
  type Permission,
} from "@cdf/contracts";
import { can } from "@cdf/authorization";
import type { SecurityEventSink } from "@cdf/audit";
import { readBcpWorkbook } from "@cdf/domain";
import {
  applyBcpImportSchema,
  bcpBatchSchema,
  bcpNormalize,
  bcpRowProblem,
  bcpUploadSchema,
  cancelBcpImportSchema,
  decideBcpImportSchema,
  resolveBcpRowSchema,
  stageBcpImportSchema,
  submitBcpImportSchema,
} from "@cdf/validation";
import type { z } from "zod";
import { AppError, toAppError } from "./errors";
import type { CommandResult } from "./investigation";
import type { MalwareScanner, UserRequestContext, WorkbookReader } from "./ports";

type In<S extends z.ZodType> = z.output<S>;

/** Port over the api.* continuity-import commands and the batches RLS lets the caller read. */
export interface BcpImportGateway {
  /**
   * `api.bcp_import_batch_view` (final 2110) and, in the same transaction, the names of the accounts it names. Row
   * metadata only, never the cells, the control block or a row about the reader. NOT_FOUND unless the caller may see
   * the batch.
   */
  view(ctx: UserRequestContext, batchId: string): Promise<BcpImportBatchPage>;
  stage(ctx: UserRequestContext, input: In<typeof stageBcpImportSchema>): Promise<string>;
  resolve(ctx: UserRequestContext, input: In<typeof resolveBcpRowSchema>): Promise<void>;
  preview(ctx: UserRequestContext, input: In<typeof bcpBatchSchema>): Promise<BcpPreview>;
  /** SUBMITTED, or RECONCILIATION_FAILED for a committee record whose declaration does not reconcile (2115). */
  submit(ctx: UserRequestContext, input: In<typeof submitBcpImportSchema>): Promise<BcpSubmitOutcome>;
  decide(ctx: UserRequestContext, input: In<typeof decideBcpImportSchema>): Promise<BcpBatchStatus>;
  apply(ctx: UserRequestContext, input: In<typeof applyBcpImportSchema>): Promise<BcpImportCounts>;
  cancel(ctx: UserRequestContext, input: In<typeof cancelBcpImportSchema>): Promise<void>;
  /** The caller's own batches and the submitted batches they may decide; RLS decides. */
  list(ctx: UserRequestContext, filter: { caseId?: string }): Promise<BcpImportBatch[]>;
  /** A visible batch's rows with their state, resolution and last dry-run outcome; empty when hidden. */
  rows(ctx: UserRequestContext, batchId: string): Promise<BcpPreviewRow[]>;
}

export interface BcpImportDeps {
  gateway: BcpImportGateway;
  reader: WorkbookReader;
  scanner: MalwareScanner;
  securityEvents: SecurityEventSink;
}

export interface BcpWorkbookFile {
  name: string;
  bytes: Uint8Array;
}

export interface StagedBcpImport {
  batchId: string;
  sha256: string;
  rows: number;
  /** Rows the shared column rules already reject; the database stages them as INVALID, to be skipped. */
  invalidRows: number;
}

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const IMPORTER: readonly Permission[] = ["BCP_IMPORT"];

const ROW_FAILED = "CDF_CONFLICT:BCP_ROW_FAILED:";

/** An import that stopped at a row, as one stable code: the row's key and its command's code stay on the server. */
function rowFailed(cause: unknown, correlationId: string): AppError | null {
  return cause instanceof Error && cause.message.startsWith(ROW_FAILED)
    ? new AppError("CONFLICT", correlationId, "BCP_ROW_FAILED", { cause })
    : null;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function createBcpImportService(deps: BcpImportDeps) {
  const { gateway, reader, scanner, securityEvents } = deps;

  async function securityEvent(
    ctx: UserRequestContext,
    action: "COMMAND_DENIED" | "VALIDATION_REJECTED",
    objectId: string | undefined,
    metadata: Record<string, string>,
  ) {
    try {
      await securityEvents.record({ action, objectType: "command", objectId, metadata }, ctx);
    } catch {
      // Recording must never mask the original outcome.
    }
  }

  async function recordDenial(ctx: UserRequestContext, command: string, error: AppError, objectId?: string) {
    if (error.kind !== "FORBIDDEN" && error.kind !== "NOT_FOUND") return;
    await securityEvent(ctx, "COMMAND_DENIED", objectId, { command, outcome: error.kind });
  }

  /** A refused upload: the event names the reason code only, never the file or its cells. */
  async function refuseFile(
    ctx: UserRequestContext,
    caseId: string,
    reason: string,
  ): Promise<CommandResult<never>> {
    await securityEvent(ctx, "VALIDATION_REJECTED", caseId, { command: "stage_bcp_import", reason });
    return { ok: false, error: new AppError("INVALID", ctx.requestId, `WORKBOOK_${reason}`) };
  }

  /** A read the caller may not make is the uniform not-found (null), recorded as ACCESS_DENIED. */
  async function read<T>(
    ctx: UserRequestContext,
    objectType: string,
    name: string,
    objectId: string,
    run: () => Promise<T>,
  ): Promise<T | null> {
    try {
      return await run();
    } catch (cause) {
      const error = toAppError(cause, ctx.requestId);
      if (error.kind !== "NOT_FOUND" && error.kind !== "FORBIDDEN") throw error;
      try {
        await securityEvents.record(
          { action: "ACCESS_DENIED", objectType, objectId, metadata: { read: name } },
          ctx,
        );
      } catch {
        // Recording must never mask the original denial.
      }
      return null;
    }
  }

  async function command<S extends z.ZodType, T>(
    ctx: UserRequestContext,
    actor: Actor,
    name: string,
    schema: S,
    raw: unknown,
    permissions: readonly Permission[],
    run: (input: z.output<S>) => Promise<T>,
    objectId: (input: z.output<S>) => string | undefined,
  ): Promise<CommandResult<T>> {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) return { ok: false, fieldErrors: parsed.error };
    if (!permissions.some((p) => can(actor, p))) {
      const error = new AppError("FORBIDDEN", ctx.requestId);
      await recordDenial(ctx, name, error, objectId(parsed.data));
      return { ok: false, error };
    }
    try {
      return { ok: true, value: await run(parsed.data) };
    } catch (cause) {
      const error = toAppError(cause, ctx.requestId);
      await recordDenial(ctx, name, error, objectId(parsed.data));
      return { ok: false, error };
    }
  }

  const byBatch = (i: { batchId: string }) => i.batchId;

  return {
    /** The batch's page: null when the caller may not see it, whatever the reason (a forged id included). */
    view: (ctx: UserRequestContext, batchId: string) =>
      read(ctx, "bcp_import_batch", "bcp_import_batch_view", batchId, () => gateway.view(ctx, batchId)),

    async stage(
      ctx: UserRequestContext,
      actor: Actor,
      rawUpload: unknown,
      file: BcpWorkbookFile,
    ): Promise<CommandResult<StagedBcpImport>> {
      const upload = bcpUploadSchema.safeParse(rawUpload);
      if (!upload.success) return { ok: false, fieldErrors: upload.error };
      const { caseId } = upload.data;
      if (!can(actor, "BCP_IMPORT")) {
        const error = new AppError("FORBIDDEN", ctx.requestId);
        await recordDenial(ctx, "stage_bcp_import", error, caseId);
        return { ok: false, error };
      }

      if (!/\.xlsx$/i.test(file.name.trim())) return refuseFile(ctx, caseId, "FILE_TYPE");
      if (file.bytes.byteLength === 0) return refuseFile(ctx, caseId, "FILE_EMPTY");
      if (file.bytes.byteLength > BCP_MAX_WORKBOOK_BYTES) return refuseFile(ctx, caseId, "FILE_TOO_LARGE");

      let scan;
      try {
        scan = await scanner.scan(file.bytes, {
          contentType: XLSX,
          objectKey: `bcp-import/${ctx.requestId}`,
        });
      } catch {
        scan = { status: "UNSCANNED" as const, scanner: scanner.name };
      }
      if (scan.status === "INFECTED") {
        await securityEvent(ctx, "VALIDATION_REJECTED", caseId, {
          command: "stage_bcp_import",
          reason: "MALWARE_DETECTED",
        });
        return { ok: false, error: new AppError("CONFLICT", ctx.requestId, "MALWARE_DETECTED") };
      }
      if (scan.status !== "CLEAN") {
        return { ok: false, error: new AppError("CONFLICT", ctx.requestId, "SCAN_UNAVAILABLE") };
      }

      let read;
      try {
        read = reader.read(file.bytes);
      } catch {
        // A reader must refuse with a code; anything it throws is treated as a refusal, never shown.
        read = { ok: false as const, code: "UNREADABLE" };
      }
      if (!read.ok) return refuseFile(ctx, caseId, read.code);
      const content = readBcpWorkbook(read.workbook);
      if (!content.ok) return refuseFile(ctx, caseId, content.code);
      if (bcpNormalize("UUID", content.control.CASE_ID) !== caseId.toLowerCase()) {
        return refuseFile(ctx, caseId, "CASE_MISMATCH");
      }

      const sha256 = await sha256Hex(file.bytes);
      const parsed = stageBcpImportSchema.safeParse({
        control: content.control,
        fileSha256: sha256,
        rows: content.rows,
      });
      if (!parsed.success) return { ok: false, fieldErrors: parsed.error };
      try {
        const batchId = await gateway.stage(ctx, parsed.data);
        return {
          ok: true,
          value: {
            batchId,
            sha256,
            rows: parsed.data.rows.length,
            invalidRows: parsed.data.rows.filter(
              (r) => bcpRowProblem(r.sheet, r.cells, r.has_formula) !== null,
            ).length,
          },
        };
      } catch (cause) {
        const error = toAppError(cause, ctx.requestId);
        await recordDenial(ctx, "stage_bcp_import", error, caseId);
        return { ok: false, error };
      }
    },

    /** UNSUPPORTED and INVALID rows can only be skipped; a conflict is kept or skipped, never overwritten (§79). */
    resolve: (ctx: UserRequestContext, actor: Actor, raw: unknown) =>
      command(
        ctx,
        actor,
        "resolve_bcp_row",
        resolveBcpRowSchema,
        raw,
        IMPORTER,
        (i) => gateway.resolve(ctx, i),
        (i) => i.rowId,
      ),

    /** The importer's dry run of the real commands, always rolled back. */
    preview: (ctx: UserRequestContext, actor: Actor, raw: unknown) =>
      command(
        ctx,
        actor,
        "preview_bcp_import",
        bcpBatchSchema,
        raw,
        IMPORTER,
        (i) => gateway.preview(ctx, i),
        byBatch,
      ),

    submit: (ctx: UserRequestContext, actor: Actor, raw: unknown) =>
      command(
        ctx,
        actor,
        "submit_bcp_import",
        submitBcpImportSchema,
        raw,
        IMPORTER,
        (i) => gateway.submit(ctx, i),
        byBatch,
      ),

    /** The database refuses the importer and anyone who recorded a row offline, whatever their permissions. */
    decide: (ctx: UserRequestContext, actor: Actor, raw: unknown) =>
      command(
        ctx,
        actor,
        "decide_bcp_import",
        decideBcpImportSchema,
        raw,
        ["BCP_IMPORT_APPROVE"],
        (i) => gateway.decide(ctx, i),
        byBatch,
      ),

    /**
     * The approved rows are imported in one transaction, or none is. A row that fails names itself and its command's
     * code (CONFLICT:BCP_ROW_FAILED:<row key>:<code>), which can be longer than an error detail may be; the reader is
     * told that a row failed and nothing was imported, never more.
     */
    apply: (ctx: UserRequestContext, actor: Actor, raw: unknown) =>
      command(
        ctx,
        actor,
        "apply_bcp_import",
        applyBcpImportSchema,
        raw,
        IMPORTER,
        (i) =>
          gateway.apply(ctx, i).catch((cause: unknown) => {
            throw rowFailed(cause, ctx.requestId) ?? cause;
          }),
        byBatch,
      ),

    cancel: (ctx: UserRequestContext, actor: Actor, raw: unknown) =>
      command(
        ctx,
        actor,
        "cancel_bcp_import",
        cancelBcpImportSchema,
        raw,
        IMPORTER,
        (i) => gateway.cancel(ctx, i),
        byBatch,
      ),

    batches: async (ctx: UserRequestContext, caseId?: string) => {
      try {
        return await gateway.list(ctx, { caseId });
      } catch (cause) {
        throw toAppError(cause, ctx.requestId);
      }
    },

    batchRows: async (ctx: UserRequestContext, batchId: string) => {
      try {
        return await gateway.rows(ctx, batchId);
      } catch (cause) {
        throw toAppError(cause, ctx.requestId);
      }
    },
  };
}

export type BcpImportService = ReturnType<typeof createBcpImportService>;
