/**
 * The two-person lift of a case's restricted status (migration 2130, ADR-049; DEC-AMB-012 → C): the case's Restricted
 * Case Authority previews what lifting would open and requests it; an independent second approver (the configured
 * role, cleared, not on the case's team, no conflict) approves that same preview; the authority lifts it. A changed
 * preview, a lapsed window or a pending restricted-only approval refuses the step (fail closed).
 *
 * Each command:
 *   1. validates input with the shared Zod schema (§45); no schema takes a user id (T-AMB-142),
 *   2. needs no permission code: who may act comes from the caller's relationship to the case and the request (the
 *      case's authority, the requester, an eligible approver), which only the database knows,
 *   3. runs the api.* command in the caller's security context (the authoritative check),
 *   4. maps failures to safe AppErrors and records refusals as COMMAND_DENIED SECURITY events (§30).
 * Reasons are case content: they are never logged (§83). The preview is counts and role codes only.
 */
import type {
  RestrictionLiftApproval,
  RestrictionLiftPreviewResult,
  RestrictionLiftStatusView,
} from "@cdf/contracts";
import type { SecurityEventSink } from "@cdf/audit";
import {
  decideRestrictionLiftSchema,
  requestRestrictionLiftSchema,
  restrictionLiftCaseSchema,
  restrictionLiftRequestSchema,
} from "@cdf/validation";
import type { z } from "zod";
import { toAppError, type AppError } from "./errors";
import type { CommandResult } from "./investigation";
import type { UserRequestContext } from "./ports";

type In<S extends z.ZodType> = z.output<S>;

/** Port over the 2130 api.* commands and read models (implemented in @cdf/infrastructure). */
export interface RestrictionLiftGateway {
  /** `api.restriction_lift_status`: the case's authority only (NOT_FOUND or FORBIDDEN otherwise). */
  status(ctx: UserRequestContext, caseId: string): Promise<RestrictionLiftStatusView>;
  /** `api.my_restriction_lift_approvals`: the open requests the caller could decide or expire. */
  myApprovals(ctx: UserRequestContext): Promise<RestrictionLiftApproval[]>;
  /** `api.preview_restriction_lift` (audited). */
  preview(
    ctx: UserRequestContext,
    input: In<typeof restrictionLiftCaseSchema>,
  ): Promise<RestrictionLiftPreviewResult>;
  request(ctx: UserRequestContext, input: In<typeof requestRestrictionLiftSchema>): Promise<string>;
  decide(
    ctx: UserRequestContext,
    input: In<typeof decideRestrictionLiftSchema>,
  ): Promise<"APPROVED" | "REJECTED">;
  lift(ctx: UserRequestContext, input: In<typeof restrictionLiftRequestSchema>): Promise<void>;
  expire(ctx: UserRequestContext, input: In<typeof restrictionLiftRequestSchema>): Promise<void>;
  withdraw(ctx: UserRequestContext, input: In<typeof restrictionLiftRequestSchema>): Promise<void>;
}

export interface RestrictionLiftDeps {
  gateway: RestrictionLiftGateway;
  securityEvents: SecurityEventSink;
}

export function createRestrictionLiftService(deps: RestrictionLiftDeps) {
  const { gateway, securityEvents } = deps;

  async function recordDenial(ctx: UserRequestContext, name: string, error: AppError, objectId?: string) {
    if (error.kind !== "FORBIDDEN" && error.kind !== "NOT_FOUND") return;
    try {
      await securityEvents.record(
        {
          action: "COMMAND_DENIED",
          objectType: "command",
          objectId,
          metadata: { command: name, outcome: error.kind },
        },
        ctx,
      );
    } catch {
      // Recording must never mask the original denial.
    }
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

  const byCase = (i: { caseId: string }) => i.caseId;
  const byRequest = (i: { requestId: string }) => i.requestId;

  return {
    /**
     * The lift panel for the case's authority; null for anyone else, a hidden case and a malformed id alike (a read,
     * so a refusal is not a denied command: the page shows no panel).
     */
    status: async (ctx: UserRequestContext, caseId: string): Promise<RestrictionLiftStatusView | null> => {
      const parsed = restrictionLiftCaseSchema.safeParse({ caseId });
      if (!parsed.success) return null;
      try {
        return await gateway.status(ctx, parsed.data.caseId);
      } catch (cause) {
        const error = toAppError(cause, ctx.requestId);
        if (error.kind === "FORBIDDEN" || error.kind === "NOT_FOUND") return null;
        throw error;
      }
    },

    /** The caller's approval queue: empty unless they could give the second approval. */
    myApprovals: async (ctx: UserRequestContext): Promise<RestrictionLiftApproval[]> => {
      try {
        return await gateway.myApprovals(ctx);
      } catch (cause) {
        throw toAppError(cause, ctx.requestId);
      }
    },

    preview: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "preview_restriction_lift",
        restrictionLiftCaseSchema,
        raw,
        (i) => gateway.preview(ctx, i),
        byCase,
      ),

    request: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "request_restriction_lift",
        requestRestrictionLiftSchema,
        raw,
        (i) => gateway.request(ctx, i),
        byCase,
      ),

    decide: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "decide_restriction_lift",
        decideRestrictionLiftSchema,
        raw,
        (i) => gateway.decide(ctx, i),
        byRequest,
      ),

    lift: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "lift_case_restriction",
        restrictionLiftRequestSchema,
        raw,
        (i) => gateway.lift(ctx, i),
        byRequest,
      ),

    expire: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "expire_restriction_lift",
        restrictionLiftRequestSchema,
        raw,
        (i) => gateway.expire(ctx, i),
        byRequest,
      ),

    withdraw: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "withdraw_restriction_lift",
        restrictionLiftRequestSchema,
        raw,
        (i) => gateway.withdraw(ctx, i),
        byRequest,
      ),
  };
}

export type RestrictionLiftService = ReturnType<typeof createRestrictionLiftService>;
