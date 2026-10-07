/**
 * Forms engine use cases (Phase 8, CDF-50; ADR-011). Each command:
 *   1. validates the envelope with the shared Zod schema and the field data with @cdf/domain (§45),
 *   2. pre-checks permission and form entitlement with @cdf/authorization and the registry (first enforcement),
 *   3. runs the database command in the caller's security context (second enforcement: authz.* and RLS),
 *   4. maps failures to safe AppErrors and records denials as SECURITY events (§30).
 * Form content never reaches the audit ledger or a security event: only codes, numbers and hashes do (§83).
 */
import type {
  Actor,
  FormDefinitionListItem,
  FormEntitlementAction,
  FormInstanceDetail,
  FormInstanceSummary,
  Permission,
} from "@cdf/contracts";
import { can } from "@cdf/authorization";
import type { SecurityEventSink } from "@cdf/audit";
import { getFormDefinition, isFormEntitled, validateFormData, type FormDataIssue } from "@cdf/domain";
import {
  approveFormSchema,
  prepareFormSchema,
  reviewFormSchema,
  saveFormDraftSchema,
  startFormSchema,
  withdrawFormSchema,
} from "@cdf/validation";
import { ZodError, type z } from "zod";
import { AppError, toAppError } from "./errors";
import type { CommandResult } from "./investigation";
import type { FormsGateway, UserRequestContext } from "./ports";

export interface FormsDeps {
  gateway: FormsGateway;
  securityEvents: SecurityEventSink;
}

export interface SavedFormDraft {
  versionNo: number;
  contentHash: string;
}

const ISSUE_MESSAGE: Record<FormDataIssue["code"], string> = {
  unknownField: "validation.invalid",
  required: "validation.required",
  tooLong: "validation.tooLong",
  invalid: "validation.invalid",
};

/** Domain field issues in the same shape as schema issues, so forms render them identically. */
function issuesToZodError(issues: FormDataIssue[]): ZodError {
  return new ZodError(
    issues.map((i) => ({
      code: "custom" as const,
      path: ["data", i.field],
      message: ISSUE_MESSAGE[i.code],
      input: undefined,
    })),
  );
}

export function createFormsService(deps: FormsDeps) {
  const { gateway, securityEvents } = deps;

  async function recordDenial(
    ctx: UserRequestContext,
    command: string,
    error: AppError,
    formCode: string,
    objectId?: string,
  ) {
    if (error.kind !== "FORBIDDEN" && error.kind !== "NOT_FOUND") return;
    try {
      await securityEvents.record(
        {
          action: "COMMAND_DENIED",
          objectType: "form_instance",
          objectId,
          metadata: { command, outcome: error.kind, form_code: formCode },
        },
        ctx,
      );
    } catch {
      // Recording must never mask the original denial.
    }
  }

  /** Permission + registry entitlement; the database re-checks both plus case access and state. */
  function allowed(
    actor: Actor,
    permission: Permission,
    formCode: string,
    action: FormEntitlementAction,
  ): boolean {
    return can(actor, permission) && isFormEntitled(actor.roles, formCode, action);
  }

  async function command<S extends z.ZodType, T>(
    ctx: UserRequestContext,
    actor: Actor,
    name: string,
    schema: S,
    raw: unknown,
    gate: { permission: Permission; action: FormEntitlementAction },
    run: (input: z.output<S>) => Promise<T>,
    objectId: (input: z.output<S>) => string | undefined,
  ): Promise<CommandResult<T>> {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) return { ok: false, fieldErrors: parsed.error };
    const input = parsed.data as z.output<S> & { formCode: string };
    if (!allowed(actor, gate.permission, input.formCode, gate.action)) {
      const error = new AppError("FORBIDDEN", ctx.requestId);
      await recordDenial(ctx, name, error, input.formCode, objectId(input));
      return { ok: false, error };
    }
    try {
      return { ok: true, value: await run(input) };
    } catch (cause) {
      const error = toAppError(cause, ctx.requestId);
      await recordDenial(ctx, name, error, input.formCode, objectId(input));
      return { ok: false, error };
    }
  }

  return {
    listDefinitions(ctx: UserRequestContext, caseId: string): Promise<FormDefinitionListItem[]> {
      return gateway.listDefinitions(ctx, caseId).catch((cause) => {
        throw toAppError(cause, ctx.requestId);
      });
    },
    listInstances(ctx: UserRequestContext, caseId: string): Promise<FormInstanceSummary[]> {
      return gateway.listInstances(ctx, caseId).catch((cause) => {
        throw toAppError(cause, ctx.requestId);
      });
    },
    /** Null when missing or not visible (alike, §40). Records FORM_VIEWED or a SECURITY denial. */
    getInstance(ctx: UserRequestContext, instanceId: string): Promise<FormInstanceDetail | null> {
      return gateway.getInstance(ctx, instanceId).catch((cause) => {
        throw toAppError(cause, ctx.requestId);
      });
    },

    start(
      ctx: UserRequestContext,
      actor: Actor,
      raw: unknown,
    ): Promise<CommandResult<{ instanceId: string }>> {
      return command(
        ctx,
        actor,
        "start_form",
        startFormSchema,
        raw,
        { permission: "FORM_PREPARE", action: "PREPARE" },
        async (i) => ({ instanceId: await gateway.startForm(ctx, i) }),
        (i) => i.caseId,
      );
    },

    saveDraft(ctx: UserRequestContext, actor: Actor, raw: unknown): Promise<CommandResult<SavedFormDraft>> {
      return command(
        ctx,
        actor,
        "save_form_draft",
        saveFormDraftSchema,
        raw,
        { permission: "FORM_PREPARE", action: "PREPARE" },
        async (i) => {
          const definition = getFormDefinition(i.formCode);
          if (!definition) throw new AppError("INVALID", ctx.requestId, "form_code");
          const check = validateFormData(definition.sections, i.data, false);
          if (!check.ok) throw issuesToZodError(check.issues);
          const saved = await gateway.saveDraft(ctx, i.instanceId, check.data);
          return { versionNo: saved.versionNo, contentHash: saved.contentHash };
        },
        (i) => i.instanceId,
      ).then((result) => {
        // Field-level issues from the domain check surface like schema issues.
        if (!result.ok && "error" in result && result.error.cause instanceof ZodError)
          return { ok: false as const, fieldErrors: result.error.cause };
        return result;
      });
    },

    prepare(ctx: UserRequestContext, actor: Actor, raw: unknown): Promise<CommandResult<void>> {
      return command(
        ctx,
        actor,
        "prepare_form",
        prepareFormSchema,
        raw,
        { permission: "FORM_PREPARE", action: "PREPARE" },
        (i) => gateway.prepare(ctx, i.instanceId),
        (i) => i.instanceId,
      );
    },

    review(ctx: UserRequestContext, actor: Actor, raw: unknown): Promise<CommandResult<void>> {
      return command(
        ctx,
        actor,
        "review_form",
        reviewFormSchema,
        raw,
        { permission: "FORM_REVIEW", action: "REVIEW" },
        (i) => gateway.review(ctx, i.instanceId, i.outcome, i.reason),
        (i) => i.instanceId,
      );
    },

    approve(ctx: UserRequestContext, actor: Actor, raw: unknown): Promise<CommandResult<void>> {
      return command(
        ctx,
        actor,
        "approve_form",
        approveFormSchema,
        raw,
        { permission: "FORM_APPROVE", action: "APPROVE" },
        (i) => gateway.approve(ctx, i.instanceId, i.outcome, i.reason),
        (i) => i.instanceId,
      );
    },

    withdraw(ctx: UserRequestContext, actor: Actor, raw: unknown): Promise<CommandResult<void>> {
      return command(
        ctx,
        actor,
        "withdraw_form",
        withdrawFormSchema,
        raw,
        { permission: "FORM_PREPARE", action: "PREPARE" },
        (i) => gateway.withdraw(ctx, i.instanceId, i.reason),
        (i) => i.instanceId,
      );
    },
  };
}
export type FormsService = ReturnType<typeof createFormsService>;
