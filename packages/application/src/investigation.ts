/**
 * Investigation app use cases. Each command:
 *   1. validates input with the shared Zod schema (§45),
 *   2. pre-checks permission with @cdf/authorization (first enforcement point, §19),
 *   3. runs the database command in the caller's security context (second enforcement point),
 *   4. maps failures to safe AppErrors and records denials as SECURITY events (§30).
 */
import type { Actor, Permission } from "@cdf/contracts";
import { can } from "@cdf/authorization";
import type { SecurityEventSink } from "@cdf/audit";
import {
  assignCaseSchema,
  caseDiscoverySchema,
  createCaseSchema,
  declareConflictSchema,
  recordsCatalogueSearchSchema,
  replyToReporterSchema,
  transitionCaseSchema,
  triageReportSchema,
  updateCaseDetailsSchema,
} from "@cdf/validation";
import type { z } from "zod";
import { AppError, toAppError } from "./errors";
import type { InvestigationGateway, UserRequestContext } from "./ports";

export interface InvestigationDeps {
  gateway: InvestigationGateway;
  securityEvents: SecurityEventSink;
}

export type CommandResult<T> =
  { ok: true; value: T } | { ok: false; error: AppError } | { ok: false; fieldErrors: z.ZodError };

export function createInvestigationService(deps: InvestigationDeps) {
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

  async function command<S extends z.ZodType, T>(
    ctx: UserRequestContext,
    actor: Actor,
    name: string,
    schema: S,
    raw: unknown,
    permission: Permission | null,
    run: (input: z.output<S>) => Promise<T>,
    objectId?: (input: z.output<S>) => string,
  ): Promise<CommandResult<T>> {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) return { ok: false, fieldErrors: parsed.error };
    if (permission && !can(actor, permission)) {
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
    loadActor: (ctx: UserRequestContext) => query(ctx, () => gateway.loadActor(ctx)),
    listIntakeReports: (ctx: UserRequestContext) => query(ctx, () => gateway.listIntakeReports(ctx)),
    getReport: (ctx: UserRequestContext, id: string) => query(ctx, () => gateway.getReport(ctx, id)),
    listCases: (ctx: UserRequestContext) => query(ctx, () => gateway.listCases(ctx)),
    getCase: (ctx: UserRequestContext, id: string) => query(ctx, () => gateway.getCase(ctx, id)),
    caseTimeline: (ctx: UserRequestContext, id: string) => query(ctx, () => gateway.caseTimeline(ctx, id)),
    directory: (ctx: UserRequestContext) => query(ctx, () => gateway.directory(ctx)),

    // Records and legal views (ADR-014). The catalogue is not a case browser; dashboards show own work.
    searchRecordsCatalogue: (ctx: UserRequestContext, actor: Actor, raw: unknown) =>
      command(
        ctx,
        actor,
        "search_records_catalogue",
        recordsCatalogueSearchSchema,
        raw,
        null, // catalogue scope, tasks or case relationships decide; the database filters every row
        (i) => gateway.searchRecordsCatalogue(ctx, i),
      ),
    myCaseTasks: (ctx: UserRequestContext) => query(ctx, () => gateway.myCaseTasks(ctx)),
    myWorkSummary: (ctx: UserRequestContext) => query(ctx, () => gateway.myWorkSummary(ctx)),
    requestCaseForLegalHold: (ctx: UserRequestContext, actor: Actor, raw: unknown) =>
      command(
        ctx,
        actor,
        "request_case_for_legal_hold",
        caseDiscoverySchema,
        raw,
        "CASE_DISCOVER",
        async (i) => {
          const result = await gateway.requestCaseForLegalHold(ctx, i);
          if (result.outcome === "RATE_LIMITED") throw new AppError("RATE_LIMITED", ctx.requestId);
          return result;
        },
      ),

    triageReport: (ctx: UserRequestContext, actor: Actor, raw: unknown) =>
      command(
        ctx,
        actor,
        "triage_report",
        triageReportSchema,
        raw,
        "REPORT_TRIAGE",
        (i) => gateway.triageReport(ctx, i),
        (i) => i.reportId,
      ),

    replyToReporter: (ctx: UserRequestContext, actor: Actor, raw: unknown) =>
      command(
        ctx,
        actor,
        "reply_to_reporter",
        replyToReporterSchema,
        raw,
        "REPORT_MESSAGE_REPLY",
        (i) => gateway.replyToReporter(ctx, i),
        (i) => i.reportId,
      ),

    createCase: (ctx: UserRequestContext, actor: Actor, raw: unknown) =>
      command(
        ctx,
        actor,
        "create_case_from_report",
        createCaseSchema,
        raw,
        "CASE_CREATE",
        (i) => gateway.createCaseFromReport(ctx, i),
        (i) => i.reportId,
      ),

    updateCaseDetails: (ctx: UserRequestContext, actor: Actor, raw: unknown) =>
      // Edit rights may come from an assignment, so the database decides.
      command(
        ctx,
        actor,
        "update_case_details",
        updateCaseDetailsSchema,
        raw,
        null,
        (i) => gateway.updateCaseDetails(ctx, i),
        (i) => i.caseId,
      ),

    assignCase: (ctx: UserRequestContext, actor: Actor, raw: unknown) =>
      command(
        ctx,
        actor,
        "assign_case",
        assignCaseSchema,
        raw,
        "CASE_ASSIGN",
        (i) => gateway.assignCase(ctx, i),
        (i) => i.caseId,
      ),

    declareConflict: (ctx: UserRequestContext, actor: Actor, raw: unknown) =>
      command(
        ctx,
        actor,
        "declare_conflict",
        declareConflictSchema,
        raw,
        "CONFLICT_DECLARE",
        (i) => gateway.declareConflict(ctx, i),
        (i) => i.caseId,
      ),

    transitionCase: (ctx: UserRequestContext, actor: Actor, raw: unknown) =>
      // Required permission depends on the transition; the database evaluates it with conditions.
      command(
        ctx,
        actor,
        "transition_case",
        transitionCaseSchema,
        raw,
        null,
        (i) => gateway.transitionCase(ctx, i),
        (i) => i.caseId,
      ),
  };
}
export type InvestigationService = ReturnType<typeof createInvestigationService>;
