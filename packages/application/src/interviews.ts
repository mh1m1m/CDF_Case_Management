/**
 * Interview use cases (EPIC 09, CDF-60, ADR-012). Each command:
 *   1. validates input with the shared Zod schema (§45),
 *   2. pre-checks the lifecycle and separation-of-duties rules from @cdf/domain where the facts are at hand
 *      (first enforcement point; interview rights come from case relationships, not a permission code),
 *   3. runs the database command in the caller's security context (second enforcement point, authoritative),
 *   4. maps failures to safe AppErrors and records denials as SECURITY events (§30).
 * Statement text never leaves the gateway except to the caller who may read it; it is never logged.
 */
import type { Actor, InterviewDetail, InterviewListItem } from "@cdf/contracts";
import type { SecurityEventSink } from "@cdf/audit";
import { transitionBlockers } from "@cdf/domain";
import {
  acknowledgeInterviewStatementSchema,
  addInterviewParticipantSchema,
  issueInterviewNoticeSchema,
  linkInterviewRecordingSchema,
  planInterviewSchema,
  recordInterviewConductedSchema,
  recordInterviewRightsSchema,
  recordInterviewStatementSchema,
  scheduleInterviewSchema,
  transitionInterviewSchema,
} from "@cdf/validation";
import type { z } from "zod";
import { AppError, toAppError } from "./errors";
import type { CommandResult } from "./investigation";
import type { UserRequestContext } from "./ports";

export interface RecordedStatement {
  versionId: string;
  versionNo: number;
  sha256: string;
}

/** Port over the interview command functions and RLS-filtered reads (implemented in @cdf/infrastructure). */
export interface InterviewGateway {
  listInterviews(ctx: UserRequestContext, caseId: string): Promise<InterviewListItem[]>;
  /** Records INTERVIEW_VIEWED (or a SECURITY denial) and returns null when missing or not visible. */
  getInterview(ctx: UserRequestContext, interviewId: string): Promise<InterviewDetail | null>;
  planInterview(ctx: UserRequestContext, input: z.output<typeof planInterviewSchema>): Promise<string>;
  addParticipant(
    ctx: UserRequestContext,
    input: z.output<typeof addInterviewParticipantSchema>,
  ): Promise<string>;
  schedule(ctx: UserRequestContext, input: z.output<typeof scheduleInterviewSchema>): Promise<void>;
  issueNotice(ctx: UserRequestContext, input: z.output<typeof issueInterviewNoticeSchema>): Promise<string>;
  recordRights(ctx: UserRequestContext, input: z.output<typeof recordInterviewRightsSchema>): Promise<void>;
  recordConducted(
    ctx: UserRequestContext,
    input: z.output<typeof recordInterviewConductedSchema>,
  ): Promise<void>;
  recordStatement(
    ctx: UserRequestContext,
    input: z.output<typeof recordInterviewStatementSchema>,
  ): Promise<RecordedStatement>;
  acknowledgeStatement(
    ctx: UserRequestContext,
    input: z.output<typeof acknowledgeInterviewStatementSchema>,
  ): Promise<string>;
  linkRecording(
    ctx: UserRequestContext,
    input: z.output<typeof linkInterviewRecordingSchema>,
  ): Promise<string>;
  transition(ctx: UserRequestContext, input: z.output<typeof transitionInterviewSchema>): Promise<string>;
}

export interface InterviewDeps {
  gateway: InterviewGateway;
  securityEvents: SecurityEventSink;
}

export function createInterviewService(deps: InterviewDeps) {
  const { gateway, securityEvents } = deps;

  async function recordDenial(ctx: UserRequestContext, command: string, error: AppError, objectId?: string) {
    if (error.kind !== "FORBIDDEN" && error.kind !== "NOT_FOUND") return;
    try {
      await securityEvents.record(
        {
          action: "COMMAND_DENIED",
          objectType: "interview",
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
    name: string,
    schema: S,
    raw: unknown,
    run: (input: z.output<S>) => Promise<T>,
    objectId: (input: z.output<S>) => string,
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

  async function query<T>(ctx: UserRequestContext, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (cause) {
      throw toAppError(cause, ctx.requestId);
    }
  }

  return {
    listInterviews: (ctx: UserRequestContext, caseId: string) =>
      query(ctx, () => gateway.listInterviews(ctx, caseId)),
    getInterview: (ctx: UserRequestContext, interviewId: string) =>
      query(ctx, () => gateway.getInterview(ctx, interviewId)),

    plan: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "plan_interview",
        planInterviewSchema,
        raw,
        (i) => gateway.planInterview(ctx, i),
        (i) => i.caseId,
      ),

    addParticipant: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "add_interview_participant",
        addInterviewParticipantSchema,
        raw,
        (i) => gateway.addParticipant(ctx, i),
        (i) => i.interviewId,
      ),

    schedule: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "schedule_interview",
        scheduleInterviewSchema,
        raw,
        (i) => gateway.schedule(ctx, i),
        (i) => i.interviewId,
      ),

    issueNotice: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "issue_interview_notice",
        issueInterviewNoticeSchema,
        raw,
        (i) => gateway.issueNotice(ctx, i),
        (i) => i.interviewId,
      ),

    recordRights: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "record_interview_rights",
        recordInterviewRightsSchema,
        raw,
        (i) => gateway.recordRights(ctx, i),
        (i) => i.interviewId,
      ),

    recordConducted: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "record_interview_conducted",
        recordInterviewConductedSchema,
        raw,
        (i) => gateway.recordConducted(ctx, i),
        (i) => i.interviewId,
      ),

    recordStatement: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "record_interview_statement",
        recordInterviewStatementSchema,
        raw,
        (i) => gateway.recordStatement(ctx, i),
        (i) => i.interviewId,
      ),

    acknowledgeStatement: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "acknowledge_interview_statement",
        acknowledgeInterviewStatementSchema,
        raw,
        (i) => gateway.acknowledgeStatement(ctx, i),
        (i) => i.versionId,
      ),

    linkRecording: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "link_interview_recording",
        linkInterviewRecordingSchema,
        raw,
        (i) => gateway.linkRecording(ctx, i),
        (i) => i.interviewId,
      ),

    /**
     * Lifecycle transition. When the caller already holds the interview detail (the page does), the domain
     * rules refuse an impossible step before the database is asked; the database re-checks regardless.
     */
    async transition(
      ctx: UserRequestContext,
      actor: Actor,
      raw: unknown,
      known?: InterviewDetail,
    ): Promise<CommandResult<string>> {
      const parsed = transitionInterviewSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, fieldErrors: parsed.error };
      if (known && known.id === parsed.data.interviewId) {
        const [blocker] = transitionBlockers(known, parsed.data.action, actor.userId);
        if (blocker) return { ok: false, error: new AppError("CONFLICT", ctx.requestId, blocker) };
      }
      return command(
        ctx,
        "transition_interview",
        transitionInterviewSchema,
        parsed.data,
        (i) => gateway.transition(ctx, i),
        (i) => i.interviewId,
      );
    },
  };
}
export type InterviewService = ReturnType<typeof createInterviewService>;
