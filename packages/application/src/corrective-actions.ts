/**
 * Corrective-action use cases (ADR-033, migration 1940, Q72). Each command:
 *   1. validates input with the shared Zod schema (§45),
 *   2. pre-checks the role permission with @cdf/authorization (first enforcement point, §19); ownership, the case
 *      gate, separation of duties and the Restricted Case Authority are decided by the database,
 *   3. runs the api.* command in the caller's security context (second enforcement point, authoritative),
 *   4. maps failures to safe AppErrors and records refusals as COMMAND_DENIED SECURITY events (§30).
 * Nothing here logs titles, descriptions, notes or references (§83).
 *
 * Phase 12 P12-3b (ADR-058, migration 2096): the case's actions (A1) and one action (A2) are read from their read
 * models; an action or case the caller may not read is the uniform not-found, recorded as ACCESS_DENIED. A frozen
 * action's disposition (DEC-AMB-014) is a command like the others.
 */
import type {
  Actor,
  CaseCorrectiveAction,
  CorrectiveAction,
  CorrectiveActionStatus,
  CorrectiveActionView,
  Permission,
} from "@cdf/contracts";
import { can } from "@cdf/authorization";
import type { SecurityEventSink } from "@cdf/audit";
import {
  assignCorrectiveActionOwnerSchema,
  changeCorrectiveActionDueDateSchema,
  disposeSupersededCorrectiveActionSchema,
  openCorrectiveActionSchema,
  recordCorrectiveActionProgressSchema,
  reopenCorrectiveActionSchema,
  setCorrectiveActionPolicySchema,
  submitCorrectiveActionCompletionSchema,
  verifyCorrectiveActionSchema,
  waiveCorrectiveActionSchema,
} from "@cdf/validation";
import type { z } from "zod";
import { AppError, toAppError } from "./errors";
import type { CommandResult } from "./investigation";
import type { UserRequestContext } from "./ports";

type In<S extends z.ZodType> = z.output<S>;

/** Port over the api.* corrective-action commands (implemented in @cdf/infrastructure). */
export interface CorrectiveActionGateway {
  setPolicy(ctx: UserRequestContext, input: In<typeof setCorrectiveActionPolicySchema>): Promise<string>;
  open(ctx: UserRequestContext, input: In<typeof openCorrectiveActionSchema>): Promise<string>;
  assignOwner(ctx: UserRequestContext, input: In<typeof assignCorrectiveActionOwnerSchema>): Promise<void>;
  changeDueDate(
    ctx: UserRequestContext,
    input: In<typeof changeCorrectiveActionDueDateSchema>,
  ): Promise<void>;
  recordProgress(
    ctx: UserRequestContext,
    input: In<typeof recordCorrectiveActionProgressSchema>,
  ): Promise<void>;
  submitCompletion(
    ctx: UserRequestContext,
    input: In<typeof submitCorrectiveActionCompletionSchema>,
  ): Promise<void>;
  verify(
    ctx: UserRequestContext,
    input: In<typeof verifyCorrectiveActionSchema>,
  ): Promise<CorrectiveActionStatus>;
  reopen(ctx: UserRequestContext, input: In<typeof reopenCorrectiveActionSchema>): Promise<void>;
  waive(ctx: UserRequestContext, input: In<typeof waiveCorrectiveActionSchema>): Promise<void>;
  /** The actions the caller may see (their own as owner, or a case they can see); RLS decides. */
  list(ctx: UserRequestContext, filter: { caseId?: string; mine?: boolean }): Promise<CorrectiveAction[]>;
  /** A1 (api.case_corrective_actions): the case's actions, for whoever may see the case. */
  caseActions(ctx: UserRequestContext, caseId: string): Promise<CaseCorrectiveAction[]>;
  /** A2 (api.corrective_action_view): one action; its origin for the case team only. */
  view(ctx: UserRequestContext, actionId: string): Promise<CorrectiveActionView>;
  /** The disposition's id (api.dispose_superseded_corrective_action). */
  dispose(
    ctx: UserRequestContext,
    input: In<typeof disposeSupersededCorrectiveActionSchema>,
  ): Promise<string>;
}

export interface CorrectiveActionDeps {
  gateway: CorrectiveActionGateway;
  securityEvents: SecurityEventSink;
}

const MANAGER: readonly Permission[] = ["CORRECTIVE_ACTION_MANAGE"];
const OWNER: readonly Permission[] = ["CORRECTIVE_ACTION_OWN"];

export function createCorrectiveActionService(deps: CorrectiveActionDeps) {
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

  /** A read the database may refuse: null for NOT_FOUND or FORBIDDEN, recorded as ACCESS_DENIED; anything else thrown. */
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

  const byAction = (i: { actionId: string }) => i.actionId;

  return {
    setPolicy: (ctx: UserRequestContext, actor: Actor, raw: unknown) =>
      command(
        ctx,
        actor,
        "set_corrective_action_policy",
        setCorrectiveActionPolicySchema,
        raw,
        ["CORRECTIVE_ACTION_POLICY_ADMIN"],
        (i) => gateway.setPolicy(ctx, i),
        () => undefined,
      ),

    open: (ctx: UserRequestContext, actor: Actor, raw: unknown) =>
      command(
        ctx,
        actor,
        "open_corrective_action",
        openCorrectiveActionSchema,
        raw,
        MANAGER,
        (i) => gateway.open(ctx, i),
        (i) => i.itemId,
      ),

    assignOwner: (ctx: UserRequestContext, actor: Actor, raw: unknown) =>
      command(
        ctx,
        actor,
        "assign_corrective_action_owner",
        assignCorrectiveActionOwnerSchema,
        raw,
        MANAGER,
        (i) => gateway.assignOwner(ctx, i),
        byAction,
      ),

    changeDueDate: (ctx: UserRequestContext, actor: Actor, raw: unknown) =>
      command(
        ctx,
        actor,
        "change_corrective_action_due_date",
        changeCorrectiveActionDueDateSchema,
        raw,
        MANAGER,
        (i) => gateway.changeDueDate(ctx, i),
        byAction,
      ),

    recordProgress: (ctx: UserRequestContext, actor: Actor, raw: unknown) =>
      command(
        ctx,
        actor,
        "record_corrective_action_progress",
        recordCorrectiveActionProgressSchema,
        raw,
        OWNER,
        (i) => gateway.recordProgress(ctx, i),
        byAction,
      ),

    submitCompletion: (ctx: UserRequestContext, actor: Actor, raw: unknown) =>
      command(
        ctx,
        actor,
        "submit_corrective_action_completion",
        submitCorrectiveActionCompletionSchema,
        raw,
        OWNER,
        (i) => gateway.submitCompletion(ctx, i),
        byAction,
      ),

    /** The database refuses the owner and anyone who submitted it, whatever their permissions. */
    verify: (ctx: UserRequestContext, actor: Actor, raw: unknown) =>
      command(
        ctx,
        actor,
        "verify_corrective_action",
        verifyCorrectiveActionSchema,
        raw,
        MANAGER,
        (i) => gateway.verify(ctx, i),
        byAction,
      ),

    reopen: (ctx: UserRequestContext, actor: Actor, raw: unknown) =>
      command(
        ctx,
        actor,
        "reopen_corrective_action",
        reopenCorrectiveActionSchema,
        raw,
        MANAGER,
        (i) => gateway.reopen(ctx, i),
        byAction,
      ),

    /** CORRECTIVE_ACTION_WAIVE is held by no role until the Delegation of Authority names one (SOURCE_REQUIRED). */
    waive: (ctx: UserRequestContext, actor: Actor, raw: unknown) =>
      command(
        ctx,
        actor,
        "waive_corrective_action",
        waiveCorrectiveActionSchema,
        raw,
        ["CORRECTIVE_ACTION_WAIVE"],
        (i) => gateway.waive(ctx, i),
        byAction,
      ),

    /**
     * The replacement decision's disposition of a frozen action (DEC-AMB-014): a corrective-action manager of the case;
     * the database decides the case, the freeze, the source document, the owner and the date.
     */
    dispose: (ctx: UserRequestContext, actor: Actor, raw: unknown) =>
      command(
        ctx,
        actor,
        "dispose_superseded_corrective_action",
        disposeSupersededCorrectiveActionSchema,
        raw,
        MANAGER,
        (i) => gateway.dispose(ctx, i),
        byAction,
      ),

    /** An owner's own actions; nothing of the case behind them (CDF-73 option D). */
    myActions: (ctx: UserRequestContext) => gateway.list(ctx, { mine: true }),
    /** A1: the case's actions with why each may not move, or null (the uniform 404) for whoever may not see the case. */
    caseActions: (ctx: UserRequestContext, caseId: string): Promise<CaseCorrectiveAction[] | null> =>
      read(ctx, "case", "case_corrective_actions", caseId, () => gateway.caseActions(ctx, caseId)),
    /** A2: one action, or null (the uniform 404) for whoever may not see it. */
    view: (ctx: UserRequestContext, actionId: string): Promise<CorrectiveActionView | null> =>
      read(ctx, "corrective_action", "corrective_action_view", actionId, () => gateway.view(ctx, actionId)),
  };
}

export type CorrectiveActionService = ReturnType<typeof createCorrectiveActionService>;
