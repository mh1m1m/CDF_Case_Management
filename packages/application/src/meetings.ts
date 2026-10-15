/**
 * The committee's meeting and minutes screens (UX redesign Phase 12 P12-2a; ADR-054, migrations 1890 to 2065). The
 * pages read the purpose read models (api.meeting_view, api.minutes_view, api.vote_item_status), never the case.
 * Each command:
 *   1. validates input with the shared Zod schema (§45),
 *   2. needs no permission code: who may act comes from the caller's seat, their part in the meeting and its state,
 *      which only the database knows (authz.can_manage_meeting, the member's own row, DEC-F04's decider),
 *   3. runs the api.* command in the caller's security context (the authoritative check),
 *   4. maps failures to safe AppErrors and records refusals as COMMAND_DENIED SECURITY events (§30).
 * A read the database refuses is the uniform not-found, recorded as ACCESS_DENIED: the read models are stable and
 * write nothing themselves. Reasons, notes, narratives and comments are committee content: they are never logged.
 */
import type { MeetingView, MinutesView, VoteItemProgress } from "@cdf/contracts";
import type { SecurityEventSink } from "@cdf/audit";
import {
  acknowledgeMeetingConfidentialitySchema,
  applyMinutesDeemedApprovalSchema,
  cancelMeetingSchema,
  castCastingVoteSchema,
  castVoteSchema,
  closeMeetingSchema,
  closeVoteItemSchema,
  declareMeetingConflictSchema,
  decideMeetingConflictSchema,
  generateMinutesSchema,
  openMeetingSchema,
  openVoteItemSchema,
  overruleMinutesObjectionSchema,
  raiseMeetingConflictSchema,
  recordAttendanceSchema,
  recordExcusedAbsenceSchema,
  recordMinutesReminderSchema,
  recordVoteForMemberSchema,
  recordVoteNoteSchema,
  recuseForConflictSchema,
  reverseMeetingConflictSchema,
  reviewMinutesSchema,
  reviseVoteSchema,
} from "@cdf/validation";
import type { z } from "zod";
import { toAppError, type AppError } from "./errors";
import type { CommandResult } from "./investigation";
import type { UserRequestContext } from "./ports";

type In<S extends z.ZodType> = z.output<S>;

/** Port over the meeting and minutes read models and commands (implemented in @cdf/infrastructure). */
export interface MeetingsGateway {
  meetingView(ctx: UserRequestContext, meetingId: string): Promise<MeetingView>;
  minutesView(ctx: UserRequestContext, minutesId: string): Promise<MinutesView>;
  voteItemStatus(ctx: UserRequestContext, voteItemId: string): Promise<VoteItemProgress>;
  openMeeting(ctx: UserRequestContext, input: In<typeof openMeetingSchema>): Promise<void>;
  closeMeeting(ctx: UserRequestContext, input: In<typeof closeMeetingSchema>): Promise<void>;
  cancelMeeting(ctx: UserRequestContext, input: In<typeof cancelMeetingSchema>): Promise<void>;
  recordAttendance(ctx: UserRequestContext, input: In<typeof recordAttendanceSchema>): Promise<void>;
  recordExcusedAbsence(
    ctx: UserRequestContext,
    input: In<typeof recordExcusedAbsenceSchema>,
  ): Promise<string>;
  declareConflict(ctx: UserRequestContext, input: In<typeof declareMeetingConflictSchema>): Promise<void>;
  acknowledgeConfidentiality(
    ctx: UserRequestContext,
    input: In<typeof acknowledgeMeetingConfidentialitySchema>,
  ): Promise<string>;
  raiseConcern(ctx: UserRequestContext, input: In<typeof raiseMeetingConflictSchema>): Promise<string>;
  decideConcern(ctx: UserRequestContext, input: In<typeof decideMeetingConflictSchema>): Promise<void>;
  reverseConcern(ctx: UserRequestContext, input: In<typeof reverseMeetingConflictSchema>): Promise<string>;
  openVoteItem(ctx: UserRequestContext, input: In<typeof openVoteItemSchema>): Promise<string>;
  castVote(ctx: UserRequestContext, input: In<typeof castVoteSchema>): Promise<void>;
  reviseVote(ctx: UserRequestContext, input: In<typeof reviseVoteSchema>): Promise<void>;
  recuseForConflict(ctx: UserRequestContext, input: In<typeof recuseForConflictSchema>): Promise<void>;
  recordVoteNote(ctx: UserRequestContext, input: In<typeof recordVoteNoteSchema>): Promise<string>;
  recordVoteForMember(ctx: UserRequestContext, input: In<typeof recordVoteForMemberSchema>): Promise<void>;
  /** The item's result (or AWAITING_CASTING_VOTE on a tie the casting voter may break). */
  closeVoteItem(ctx: UserRequestContext, input: In<typeof closeVoteItemSchema>): Promise<string>;
  castCastingVote(ctx: UserRequestContext, input: In<typeof castCastingVoteSchema>): Promise<string>;
  generateMinutes(ctx: UserRequestContext, input: In<typeof generateMinutesSchema>): Promise<string>;
  /** The minutes' status after the review. */
  reviewMinutes(ctx: UserRequestContext, input: In<typeof reviewMinutesSchema>): Promise<string>;
  recordMinutesReminder(
    ctx: UserRequestContext,
    input: In<typeof recordMinutesReminderSchema>,
  ): Promise<void>;
  applyMinutesDeemedApproval(
    ctx: UserRequestContext,
    input: In<typeof applyMinutesDeemedApprovalSchema>,
  ): Promise<string>;
  overruleMinutesObjection(
    ctx: UserRequestContext,
    input: In<typeof overruleMinutesObjectionSchema>,
  ): Promise<void>;
}

export interface MeetingsDeps {
  gateway: MeetingsGateway;
  securityEvents: SecurityEventSink;
}

export function createMeetingsService(deps: MeetingsDeps) {
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

  /** A read model: null when the database says not found (the page shows the uniform 404). */
  async function read<T>(
    ctx: UserRequestContext,
    name: string,
    objectType: string,
    id: string,
    run: () => Promise<T>,
  ): Promise<T | null> {
    try {
      return await run();
    } catch (cause) {
      const error = toAppError(cause, ctx.requestId);
      if (error.kind !== "NOT_FOUND") throw error;
      await recordDenial(ctx, "ACCESS_DENIED", objectType, name, error, id);
      return null;
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
    meeting: (ctx: UserRequestContext, meetingId: string) =>
      read(ctx, "meeting_view", "meeting", meetingId, () => gateway.meetingView(ctx, meetingId)),
    minutes: (ctx: UserRequestContext, minutesId: string) =>
      read(ctx, "minutes_view", "minutes", minutesId, () => gateway.minutesView(ctx, minutesId)),
    /** Who has voted on one item so far (deliberation readers); null when the database refuses. */
    voteItemProgress: (ctx: UserRequestContext, voteItemId: string) =>
      read(ctx, "vote_item_status", "vote_item", voteItemId, () => gateway.voteItemStatus(ctx, voteItemId)),

    openMeeting: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "open_meeting",
        openMeetingSchema,
        raw,
        (i) => gateway.openMeeting(ctx, i),
        (i) => i.meetingId,
      ),
    closeMeeting: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "close_meeting",
        closeMeetingSchema,
        raw,
        (i) => gateway.closeMeeting(ctx, i),
        (i) => i.meetingId,
      ),
    cancelMeeting: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "cancel_meeting",
        cancelMeetingSchema,
        raw,
        (i) => gateway.cancelMeeting(ctx, i),
        (i) => i.meetingId,
      ),
    recordAttendance: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "record_attendance",
        recordAttendanceSchema,
        raw,
        (i) => gateway.recordAttendance(ctx, i),
        (i) => i.participantId,
      ),
    recordExcusedAbsence: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "record_excused_absence",
        recordExcusedAbsenceSchema,
        raw,
        (i) => gateway.recordExcusedAbsence(ctx, i),
        (i) => i.participantId,
      ),
    declareConflict: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "declare_meeting_conflict",
        declareMeetingConflictSchema,
        raw,
        (i) => gateway.declareConflict(ctx, i),
        (i) => i.participantId,
      ),
    acknowledgeConfidentiality: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "acknowledge_meeting_confidentiality",
        acknowledgeMeetingConfidentialitySchema,
        raw,
        (i) => gateway.acknowledgeConfidentiality(ctx, i),
        (i) => i.participantId,
      ),
    raiseConcern: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "raise_meeting_conflict",
        raiseMeetingConflictSchema,
        raw,
        (i) => gateway.raiseConcern(ctx, i),
        (i) => i.participantId,
      ),
    decideConcern: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "decide_meeting_conflict",
        decideMeetingConflictSchema,
        raw,
        (i) => gateway.decideConcern(ctx, i),
        (i) => i.concernId,
      ),
    reverseConcern: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "reverse_meeting_conflict_determination",
        reverseMeetingConflictSchema,
        raw,
        (i) => gateway.reverseConcern(ctx, i),
        (i) => i.concernId,
      ),
    openVoteItem: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "open_vote_item",
        openVoteItemSchema,
        raw,
        (i) => gateway.openVoteItem(ctx, i),
        (i) => i.meetingId,
      ),
    castVote: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "cast_vote",
        castVoteSchema,
        raw,
        (i) => gateway.castVote(ctx, i),
        (i) => i.voteItemId,
      ),
    reviseVote: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "revise_vote",
        reviseVoteSchema,
        raw,
        (i) => gateway.reviseVote(ctx, i),
        (i) => i.voteItemId,
      ),
    recuseForConflict: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "recuse_for_conflict",
        recuseForConflictSchema,
        raw,
        (i) => gateway.recuseForConflict(ctx, i),
        (i) => i.voteItemId,
      ),
    recordVoteNote: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "record_vote_note",
        recordVoteNoteSchema,
        raw,
        (i) => gateway.recordVoteNote(ctx, i),
        (i) => i.voteItemId,
      ),
    recordVoteForMember: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "record_vote_for_member",
        recordVoteForMemberSchema,
        raw,
        (i) => gateway.recordVoteForMember(ctx, i),
        (i) => i.voteItemId,
      ),
    closeVoteItem: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "close_vote_item",
        closeVoteItemSchema,
        raw,
        (i) => gateway.closeVoteItem(ctx, i),
        (i) => i.voteItemId,
      ),
    castCastingVote: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "cast_casting_vote",
        castCastingVoteSchema,
        raw,
        (i) => gateway.castCastingVote(ctx, i),
        (i) => i.voteItemId,
      ),
    generateMinutes: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "generate_minutes",
        generateMinutesSchema,
        raw,
        (i) => gateway.generateMinutes(ctx, i),
        (i) => i.meetingId,
      ),
    reviewMinutes: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "review_minutes",
        reviewMinutesSchema,
        raw,
        (i) => gateway.reviewMinutes(ctx, i),
        (i) => i.minutesId,
      ),
    recordMinutesReminder: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "record_minutes_reminder",
        recordMinutesReminderSchema,
        raw,
        (i) => gateway.recordMinutesReminder(ctx, i),
        (i) => i.minutesId,
      ),
    applyMinutesDeemedApproval: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "apply_minutes_deemed_approval",
        applyMinutesDeemedApprovalSchema,
        raw,
        (i) => gateway.applyMinutesDeemedApproval(ctx, i),
        (i) => i.minutesId,
      ),
    overruleMinutesObjection: (ctx: UserRequestContext, raw: unknown) =>
      command(
        ctx,
        "overrule_minutes_objection",
        overruleMinutesObjectionSchema,
        raw,
        (i) => gateway.overruleMinutesObjection(ctx, i),
        (i) => i.minutesId,
      ),
  };
}

export type MeetingsService = ReturnType<typeof createMeetingsService>;
