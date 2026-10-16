/**
 * My Committees and one committee's page (UX redesign Phase 12 P12-2b; ADR-055, migration 2085). The pages read the
 * purpose read models api.my_committees and api.committee_view, which show the seat basis only, never the case.
 * Each command:
 *   1. validates input with the shared Zod schema (§45),
 *   2. needs no permission code: who may act comes from the caller's seat and the proceeding's state, which only the
 *      database knows (the committee's secretary passing the case gate, an open proceeding, an active case),
 *   3. runs the api.* command in the caller's security context (the authoritative check),
 *   4. maps failures to safe AppErrors and records refusals as COMMAND_DENIED SECURITY events (§30).
 * A committee the database refuses is the uniform not-found, recorded as ACCESS_DENIED: the read models are stable
 * and write nothing themselves. Reasons are committee content: they are never logged.
 */
import type { CommitteeView, MyCommitteeRow } from "@cdf/contracts";
import type { SecurityEventSink } from "@cdf/audit";
import {
  amendProceedingSnapshotSchema,
  scheduleEmergencyMeetingSchema,
  scheduleMeetingSchema,
} from "@cdf/validation";
import type { z } from "zod";
import { toAppError, type AppError } from "./errors";
import type { CommandResult } from "./investigation";
import type { UserRequestContext } from "./ports";

type In<S extends z.ZodType> = z.output<S>;

/** Port over the committee read models and the scheduling and snapshot commands (implemented in @cdf/infrastructure). */
export interface CommitteesGateway {
  myCommittees(ctx: UserRequestContext): Promise<MyCommitteeRow[]>;
  committeeView(ctx: UserRequestContext, committeeId: string): Promise<CommitteeView>;
  /** The new meeting's id. */
  scheduleMeeting(ctx: UserRequestContext, input: In<typeof scheduleMeetingSchema>): Promise<string>;
  scheduleEmergencyMeeting(
    ctx: UserRequestContext,
    input: In<typeof scheduleEmergencyMeetingSchema>,
  ): Promise<string>;
  /** The new snapshot member's id. */
  amendProceedingSnapshot(
    ctx: UserRequestContext,
    input: In<typeof amendProceedingSnapshotSchema>,
  ): Promise<string>;
}

export interface CommitteesDeps {
  gateway: CommitteesGateway;
  securityEvents: SecurityEventSink;
}

export function createCommitteesService(deps: CommitteesDeps) {
  const { gateway, securityEvents } = deps;

  async function recordDenial(
    ctx: UserRequestContext,
    action: "ACCESS_DENIED" | "COMMAND_DENIED",
    objectType: string,
    name: string,
    error: AppError,
    objectId?: string,
  ) {
    if (error.kind !== "FORBIDDEN" && error.kind !== "NOT_FOUND") return;
    try {
      await securityEvents.record(
        {
          action,
          objectType,
          objectId,
          metadata: action === "COMMAND_DENIED" ? { command: name, outcome: error.kind } : { read: name },
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
      await recordDenial(ctx, "COMMAND_DENIED", "command", name, error, objectId(parsed.data));
      return { ok: false, error };
    }
  }

  return {
    /** The committees where the caller holds a seat now; empty for anyone else. */
    myCommittees: async (ctx: UserRequestContext): Promise<MyCommitteeRow[]> => {
      try {
        return await gateway.myCommittees(ctx);
      } catch (cause) {
        throw toAppError(cause, ctx.requestId);
      }
    },
    /** One committee for a current seat holder; null when the database says not found (the page shows the 404). */
    committee: async (ctx: UserRequestContext, committeeId: string): Promise<CommitteeView | null> => {
      try {
        return await gateway.committeeView(ctx, committeeId);
      } catch (cause) {
        const error = toAppError(cause, ctx.requestId);
        if (error.kind !== "NOT_FOUND") throw error;
        await recordDenial(ctx, "ACCESS_DENIED", "committee", "committee_view", error, committeeId);
        return null;
      }
    },

    scheduleMeeting: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "schedule_meeting",
        scheduleMeetingSchema,
        raw,
        (i) => gateway.scheduleMeeting(ctx, i),
        (i) => i.committeeProceedingId,
      ),
    scheduleEmergencyMeeting: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "schedule_emergency_meeting",
        scheduleEmergencyMeetingSchema,
        raw,
        (i) => gateway.scheduleEmergencyMeeting(ctx, i),
        (i) => i.committeeProceedingId,
      ),
    amendProceedingSnapshot: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "amend_proceeding_snapshot",
        amendProceedingSnapshotSchema,
        raw,
        (i) => gateway.amendProceedingSnapshot(ctx, i),
        (i) => i.committeeProceedingId,
      ),
  };
}

export type CommitteesService = ReturnType<typeof createCommitteesService>;
