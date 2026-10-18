/**
 * Export builder use cases (ADR-026, migration 1930, Q99). Each command:
 *   1. validates input with the shared Zod schema (§45),
 *   2. pre-checks the role permission with @cdf/authorization (first enforcement point, §19); which items, cases and
 *      recipients are allowed is decided by the database, item by item (N16),
 *   3. runs the api.* command in the caller's security context (second enforcement point, authoritative),
 *   4. maps failures to safe AppErrors and records refusals as COMMAND_DENIED SECURITY events (§30).
 *
 * Generation renders and stores the file inside the database transaction that marks the export GENERATED, so a
 * failed render or write leaves it APPROVED. An EMAIL export is then handed to the mailer; only an accepted delivery
 * is recorded as SENT. Nothing here logs content, addresses or the rendered file (§83).
 *
 * UX redesign P12-6b-1: the export's page reads `api.export_request_view` (2040) with the reference rows that name it;
 * an export the caller may not see is the uniform not-found, recorded as ACCESS_DENIED.
 */
import type {
  Actor,
  ExportPreview,
  ExportPurposeEntry,
  ExportRequestPage,
  ExportStatus,
  GeneratedExport,
  Permission,
} from "@cdf/contracts";
import { can } from "@cdf/authorization";
import type { SecurityEventSink } from "@cdf/audit";
import {
  addExportItemSchema,
  addExportRecipientSchema,
  cancelExportSchema,
  createExportRequestSchema,
  decideExportSchema,
  exportRequestRefSchema,
  submitExportSchema,
} from "@cdf/validation";
import type { z } from "zod";
import { AppError, toAppError } from "./errors";
import type { CommandResult } from "./investigation";
import type { ExportMailer, ExportRenderer, ExportStore, RenderedExport, UserRequestContext } from "./ports";

type In<S extends z.ZodType> = z.output<S>;

/** Port over the api.* export commands (implemented in @cdf/infrastructure). */
export interface ExportGateway {
  /**
   * `api.export_request_view` (2040) and, in the same transaction, the accounts it names, its purpose, the source of
   * each export rule and the approved-domain setting. Never the storage key or the document. NOT_FOUND unless the
   * caller may see the export.
   */
  view(ctx: UserRequestContext, requestId: string): Promise<ExportRequestPage>;
  /** The active purposes of the governed catalogue (DEC-F21), in its order. */
  purposes(ctx: UserRequestContext): Promise<ExportPurposeEntry[]>;
  create(ctx: UserRequestContext, input: In<typeof createExportRequestSchema>): Promise<string>;
  addItem(ctx: UserRequestContext, input: In<typeof addExportItemSchema>): Promise<string>;
  addRecipient(ctx: UserRequestContext, input: In<typeof addExportRecipientSchema>): Promise<string>;
  /** An audited read: the document as the caller may see it, its hash and the approvals it needs now. */
  preview(ctx: UserRequestContext, requestId: string): Promise<ExportPreview>;
  submit(ctx: UserRequestContext, input: In<typeof submitExportSchema>): Promise<ExportStatus>;
  decide(ctx: UserRequestContext, input: In<typeof decideExportSchema>): Promise<ExportStatus>;
  /** The Restricted Case Authority's decision on an export of a restricted case it owns (DEC-61/62 precedent). */
  decideRestricted(ctx: UserRequestContext, input: In<typeof decideExportSchema>): Promise<ExportStatus>;
  /** Runs api.generate_export and `write` in one transaction: if `write` throws, nothing is generated. */
  generate<T>(
    ctx: UserRequestContext,
    requestId: string,
    write: (generated: GeneratedExport) => Promise<T>,
  ): Promise<{ generated: GeneratedExport; written: T }>;
  recordSent(ctx: UserRequestContext, requestId: string): Promise<void>;
  cancel(ctx: UserRequestContext, input: In<typeof cancelExportSchema>): Promise<void>;
}

export interface ExportDeps {
  gateway: ExportGateway;
  renderer: ExportRenderer;
  store: ExportStore;
  mailer: ExportMailer;
  securityEvents: SecurityEventSink;
}

export interface GenerateResult {
  status: "GENERATED" | "SENT";
  storageKey: string;
  hash: string;
  /** EMAIL only: whether the mailer accepted the delivery. A refused delivery leaves the export GENERATED. */
  delivered: boolean;
}

const REQUESTER: readonly Permission[] = ["EXPORT_REQUEST"];
const APPROVER: readonly Permission[] = ["EXPORT_APPROVE", "EXPORT_SECOND_APPROVE"];
const AUTHORITY: readonly Permission[] = ["RESTRICTED_CASE_AUTHORITY"];

export function createExportService(deps: ExportDeps) {
  const { gateway, renderer, store, mailer, securityEvents } = deps;

  async function recordDenial(ctx: UserRequestContext, command: string, error: AppError, objectId?: string) {
    if (error.kind !== "FORBIDDEN" && error.kind !== "NOT_FOUND") return;
    try {
      await securityEvents.record(
        {
          action: "COMMAND_DENIED",
          objectType: "command",
          objectId,
          metadata: { command, outcome: error.kind },
        },
        ctx,
      );
    } catch {
      // Recording must never mask the original denial.
    }
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

  /** `permissions`: the caller needs at least one of them. */
  async function command<S extends z.ZodType, T>(
    ctx: UserRequestContext,
    actor: Actor,
    name: string,
    schema: S,
    raw: unknown,
    permissions: readonly Permission[],
    run: (input: z.output<S>) => Promise<T>,
    objectId: (input: z.output<S>) => string,
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

  async function generateAndDeliver(ctx: UserRequestContext, requestId: string): Promise<GenerateResult> {
    const { generated, written } = await gateway.generate(
      ctx,
      requestId,
      async (g): Promise<RenderedExport> => {
        const file = await renderer.render(g.document);
        await store.put(g.storageKey, file);
        return file;
      },
    );
    const result: GenerateResult = {
      status: "GENERATED",
      storageKey: generated.storageKey,
      hash: generated.hash,
      delivered: false,
    };
    if (generated.document.format !== "EMAIL") return result;
    try {
      result.delivered = await mailer.send(generated.deliverTo, written);
    } catch {
      result.delivered = false; // the error itself is never logged: it may echo an address
    }
    if (!result.delivered) return result;
    await gateway.recordSent(ctx, requestId);
    return { ...result, status: "SENT" };
  }

  return {
    /** The export's page: null when the caller may not see it, whatever the reason (a forged id included). */
    view: (ctx: UserRequestContext, requestId: string) =>
      read(ctx, "export_request", "export_request_view", requestId, () => gateway.view(ctx, requestId)),

    /** The purposes a new request may name, as the catalogue lists them now. */
    purposes: async (ctx: UserRequestContext) => {
      try {
        return await gateway.purposes(ctx);
      } catch (cause) {
        throw toAppError(cause, ctx.requestId);
      }
    },

    createRequest: (ctx: UserRequestContext, actor: Actor, raw: unknown) =>
      command(
        ctx,
        actor,
        "create_export_request",
        createExportRequestSchema,
        raw,
        REQUESTER,
        (i) => gateway.create(ctx, i),
        (i) => i.caseId,
      ),

    addItem: (ctx: UserRequestContext, actor: Actor, raw: unknown) =>
      command(
        ctx,
        actor,
        "add_export_item",
        addExportItemSchema,
        raw,
        REQUESTER,
        (i) => gateway.addItem(ctx, i),
        (i) => i.requestId,
      ),

    addRecipient: (ctx: UserRequestContext, actor: Actor, raw: unknown) =>
      command(
        ctx,
        actor,
        "add_export_recipient",
        addExportRecipientSchema,
        raw,
        REQUESTER,
        (i) => gateway.addRecipient(ctx, i),
        (i) => i.requestId,
      ),

    preview: (ctx: UserRequestContext, actor: Actor, raw: unknown) =>
      command(
        ctx,
        actor,
        "preview_export",
        exportRequestRefSchema,
        raw,
        [...REQUESTER, ...APPROVER, ...AUTHORITY],
        (i) => gateway.preview(ctx, i.requestId),
        (i) => i.requestId,
      ),

    submit: (ctx: UserRequestContext, actor: Actor, raw: unknown) =>
      command(
        ctx,
        actor,
        "submit_export",
        submitExportSchema,
        raw,
        REQUESTER,
        (i) => gateway.submit(ctx, i),
        (i) => i.requestId,
      ),

    decide: (ctx: UserRequestContext, actor: Actor, raw: unknown) =>
      command(
        ctx,
        actor,
        "decide_export",
        decideExportSchema,
        raw,
        APPROVER,
        (i) => gateway.decide(ctx, i),
        (i) => i.requestId,
      ),

    /** Only the case owner, as its Restricted Case Authority, gets past the database; others answer NOT_FOUND. */
    decideRestricted: (ctx: UserRequestContext, actor: Actor, raw: unknown) =>
      command(
        ctx,
        actor,
        "decide_restricted_export",
        decideExportSchema,
        raw,
        AUTHORITY,
        (i) => gateway.decideRestricted(ctx, i),
        (i) => i.requestId,
      ),

    generate: (ctx: UserRequestContext, actor: Actor, raw: unknown) =>
      command(
        ctx,
        actor,
        "generate_export",
        exportRequestRefSchema,
        raw,
        REQUESTER,
        (i) => generateAndDeliver(ctx, i.requestId),
        (i) => i.requestId,
      ),

    cancel: (ctx: UserRequestContext, actor: Actor, raw: unknown) =>
      command(
        ctx,
        actor,
        "cancel_export",
        cancelExportSchema,
        raw,
        REQUESTER,
        (i) => gateway.cancel(ctx, i),
        (i) => i.requestId,
      ),
  };
}

export type ExportService = ReturnType<typeof createExportService>;
