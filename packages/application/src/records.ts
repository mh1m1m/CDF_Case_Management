/**
 * Records, retention and legal hold use cases (CDF-71; ADR-013, ADR-014). Each command:
 *   1. validates input with the shared Zod schema (§45),
 *   2. pre-checks the role permission with @cdf/authorization (first enforcement point, §19); the case-level
 *      purpose (catalogue scope, task, case relationship) is decided by the database,
 *   3. runs the api.* command in the caller's security context (second enforcement point, authoritative),
 *   4. maps failures to safe AppErrors and records refusals as COMMAND_DENIED SECURITY events (§30, REC-T44).
 *
 * There is no delete, purge or physical-destruction command here (ADR-013 D7): disposition is logical only.
 */
import type {
  Actor,
  DispositionCertificateView,
  LegalHoldRequestInfo,
  Permission,
  RecordDetail,
  RetentionClassOption,
} from "@cdf/contracts";
import { can } from "@cdf/authorization";
import type { SecurityEventSink } from "@cdf/audit";
import {
  assignHoldRequestSchema,
  assignRetentionClassSchema,
  decideDispositionSchema,
  decideHoldReleaseSchema,
  executeDispositionSchema,
  placeLegalHoldSchema,
  requestDispositionSchema,
  requestHoldReleaseSchema,
  requestLegalHoldSchema,
  reviewHoldRequestSchema,
} from "@cdf/validation";
import { z } from "zod";
import { AppError, toAppError } from "./errors";
import type { CommandResult } from "./investigation";
import type { UserRequestContext } from "./ports";

type In<S extends z.ZodType> = z.output<S>;

const noInput = z.object({});

/** Port over the records command functions and RLS-filtered reads (implemented in @cdf/infrastructure). */
export interface RecordsGateway {
  /** Records RECORDS_CASE_METADATA_VIEWED (or a SECURITY denial) and returns null when missing or not visible. */
  getRecord(ctx: UserRequestContext, caseId: string): Promise<RecordDetail | null>;
  listRetentionClasses(ctx: UserRequestContext): Promise<RetentionClassOption[]>;
  /** Hold requests the caller filed, is assigned to review, or may route (RLS decides). */
  listHoldRequests(ctx: UserRequestContext): Promise<LegalHoldRequestInfo[]>;
  /** Returns null when missing or not visible; `verified` is recomputed by the database. */
  getCertificate(ctx: UserRequestContext, certificateId: string): Promise<DispositionCertificateView | null>;
  assignRetentionClass(ctx: UserRequestContext, input: In<typeof assignRetentionClassSchema>): Promise<void>;
  placeLegalHold(ctx: UserRequestContext, input: In<typeof placeLegalHoldSchema>): Promise<string>;
  requestHoldRelease(ctx: UserRequestContext, input: In<typeof requestHoldReleaseSchema>): Promise<string>;
  decideHoldRelease(ctx: UserRequestContext, input: In<typeof decideHoldReleaseSchema>): Promise<void>;
  requestLegalHold(ctx: UserRequestContext, input: In<typeof requestLegalHoldSchema>): Promise<string>;
  assignHoldRequest(ctx: UserRequestContext, input: In<typeof assignHoldRequestSchema>): Promise<string>;
  reviewHoldRequest(ctx: UserRequestContext, input: In<typeof reviewHoldRequestSchema>): Promise<void>;
  refreshEligibility(ctx: UserRequestContext): Promise<number>;
  requestDisposition(ctx: UserRequestContext, input: In<typeof requestDispositionSchema>): Promise<string>;
  decideDisposition(ctx: UserRequestContext, input: In<typeof decideDispositionSchema>): Promise<void>;
  executeDisposition(ctx: UserRequestContext, input: In<typeof executeDispositionSchema>): Promise<string>;
}

export interface RecordsDeps {
  gateway: RecordsGateway;
  securityEvents: SecurityEventSink;
}

export function createRecordsService(deps: RecordsDeps) {
  const { gateway, securityEvents } = deps;

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

  /** `permissions`: the caller needs at least one of them (null: the database alone decides). */
  async function command<S extends z.ZodType, T>(
    ctx: UserRequestContext,
    actor: Actor,
    name: string,
    schema: S,
    raw: unknown,
    permissions: readonly Permission[] | null,
    run: (input: z.output<S>) => Promise<T>,
    objectId?: (input: z.output<S>) => string,
  ): Promise<CommandResult<T>> {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) return { ok: false, fieldErrors: parsed.error };
    if (permissions && !permissions.some((p) => can(actor, p))) {
      const error = new AppError("FORBIDDEN", ctx.requestId);
      await recordDenial(ctx, name, error, objectId?.(parsed.data));
      return { ok: false, error };
    }
    try {
      return { ok: true, value: await run(parsed.data) };
    } catch (cause) {
      const error = toAppError(cause, ctx.requestId);
      await recordDenial(ctx, name, error, objectId?.(parsed.data));
      return { ok: false, error };
    }
  }

  async function query<T>(ctx: UserRequestContext, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (cause) {
      throw toAppError(cause, ctx.requestId);
    }
  }

  return {
    getRecord: (ctx: UserRequestContext, caseId: string) => query(ctx, () => gateway.getRecord(ctx, caseId)),
    listRetentionClasses: (ctx: UserRequestContext) => query(ctx, () => gateway.listRetentionClasses(ctx)),
    listHoldRequests: (ctx: UserRequestContext) => query(ctx, () => gateway.listHoldRequests(ctx)),
    getCertificate: (ctx: UserRequestContext, certificateId: string) =>
      query(ctx, () => gateway.getCertificate(ctx, certificateId)),

    assignRetentionClass: (ctx: UserRequestContext, actor: Actor, raw: unknown) =>
      command(
        ctx,
        actor,
        "assign_retention_class",
        assignRetentionClassSchema,
        raw,
        ["RETENTION_CLASS_ASSIGN"],
        (i) => gateway.assignRetentionClass(ctx, i),
        (i) => i.caseId,
      ),

    placeLegalHold: (ctx: UserRequestContext, actor: Actor, raw: unknown) =>
      command(
        ctx,
        actor,
        "place_legal_hold",
        placeLegalHoldSchema,
        raw,
        ["LEGAL_HOLD_APPLY"],
        (i) => gateway.placeLegalHold(ctx, i),
        (i) => i.caseId,
      ),

    requestHoldRelease: (ctx: UserRequestContext, actor: Actor, raw: unknown) =>
      command(
        ctx,
        actor,
        "request_legal_hold_release",
        requestHoldReleaseSchema,
        raw,
        ["LEGAL_HOLD_RELEASE"],
        (i) => gateway.requestHoldRelease(ctx, i),
        (i) => i.holdId,
      ),

    decideHoldRelease: (ctx: UserRequestContext, actor: Actor, raw: unknown) =>
      command(
        ctx,
        actor,
        "decide_legal_hold_release",
        decideHoldReleaseSchema,
        raw,
        ["LEGAL_HOLD_RELEASE"],
        (i) => gateway.decideHoldRelease(ctx, i),
        (i) => i.releaseId,
      ),

    requestLegalHold: (ctx: UserRequestContext, actor: Actor, raw: unknown) =>
      command(
        ctx,
        actor,
        "request_legal_hold",
        requestLegalHoldSchema,
        raw,
        ["LEGAL_HOLD_REQUEST"],
        (i) => gateway.requestLegalHold(ctx, i),
        (i) => i.caseId,
      ),

    assignHoldRequest: (ctx: UserRequestContext, actor: Actor, raw: unknown) =>
      command(
        ctx,
        actor,
        "assign_legal_hold_request",
        assignHoldRequestSchema,
        raw,
        ["CASE_TASK_ASSIGN"],
        (i) => gateway.assignHoldRequest(ctx, i),
        (i) => i.requestId,
      ),

    reviewHoldRequest: (ctx: UserRequestContext, actor: Actor, raw: unknown) =>
      command(
        ctx,
        actor,
        "review_legal_hold_request",
        reviewHoldRequestSchema,
        raw,
        ["LEGAL_HOLD_REVIEW"],
        (i) => gateway.reviewHoldRequest(ctx, i),
        (i) => i.requestId,
      ),

    refreshEligibility: (ctx: UserRequestContext, actor: Actor) =>
      command(ctx, actor, "refresh_disposition_eligibility", noInput, {}, ["DISPOSITION_REQUEST"], () =>
        gateway.refreshEligibility(ctx),
      ),

    requestDisposition: (ctx: UserRequestContext, actor: Actor, raw: unknown) =>
      command(
        ctx,
        actor,
        "request_disposition",
        requestDispositionSchema,
        raw,
        ["DISPOSITION_REQUEST"],
        (i) => gateway.requestDisposition(ctx, i),
        (i) => i.caseId,
      ),

    decideDisposition: (ctx: UserRequestContext, actor: Actor, raw: unknown) =>
      command(
        ctx,
        actor,
        "decide_disposition",
        decideDispositionSchema,
        raw,
        ["DISPOSITION_APPROVE"],
        (i) => gateway.decideDisposition(ctx, i),
        (i) => i.requestId,
      ),

    executeDisposition: (ctx: UserRequestContext, actor: Actor, raw: unknown) =>
      // The requester or the approver may execute (api.execute_disposition); either permission passes here.
      command(
        ctx,
        actor,
        "execute_disposition",
        executeDispositionSchema,
        raw,
        ["DISPOSITION_REQUEST", "DISPOSITION_APPROVE"],
        (i) => gateway.executeDisposition(ctx, i),
        (i) => i.requestId,
      ),
  };
}

export type RecordsService = ReturnType<typeof createRecordsService>;
