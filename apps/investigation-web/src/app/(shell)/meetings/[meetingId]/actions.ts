"use server";
// The meeting page's commands (UX redesign Phase 12 P12-2a; ADR-054). Each one goes through the meetings service,
// which validates with the shared schema and runs the api.* command in the caller's security context: the database
// decides who may act and in which state. The ids are the ones the read model gave the page; a forged id meets the
// same command and its refusal.
import { revalidatePath } from "next/cache";
import type { CommandResult } from "@cdf/application";
import { meetingsService, requireActor, type RequestScope } from "@/server/container";
import { formObject, toActionState, type ActionState } from "@/server/actions-helpers";

type Run = (
  service: ReturnType<typeof meetingsService>,
  ctx: RequestScope["ctx"],
  raw: Record<string, unknown>,
) => Promise<CommandResult<unknown>>;

/** Runs one command with the form's fields and the page's ids (the ids win), then refreshes the meeting. */
async function onMeeting(
  meetingId: string,
  form: FormData,
  ids: Record<string, string>,
  run: Run,
  booleans: string[] = [],
): Promise<ActionState> {
  const { ctx } = await requireActor();
  const result = await run(meetingsService(), ctx, { ...formObject(form, booleans), ...ids });
  if (result.ok) revalidatePath(`/meetings/${meetingId}`);
  return toActionState(result, form);
}

// ---- The meeting --------------------------------------------------------------------------------------------------
export async function openMeetingAction(meetingId: string, _: ActionState, form: FormData) {
  return onMeeting(meetingId, form, { meetingId }, (s, ctx, raw) => s.openMeeting(ctx, raw));
}
export async function closeMeetingAction(meetingId: string, _: ActionState, form: FormData) {
  return onMeeting(meetingId, form, { meetingId }, (s, ctx, raw) => s.closeMeeting(ctx, raw));
}
export async function cancelMeetingAction(meetingId: string, _: ActionState, form: FormData) {
  return onMeeting(meetingId, form, { meetingId }, (s, ctx, raw) => s.cancelMeeting(ctx, raw));
}

// ---- Participants -------------------------------------------------------------------------------------------------
export async function recordAttendanceAction(
  meetingId: string,
  participantId: string,
  _: ActionState,
  form: FormData,
) {
  return onMeeting(meetingId, form, { participantId }, (s, ctx, raw) => s.recordAttendance(ctx, raw));
}
export async function recordExcusedAbsenceAction(
  meetingId: string,
  participantId: string,
  _: ActionState,
  form: FormData,
) {
  return onMeeting(meetingId, form, { participantId }, (s, ctx, raw) => s.recordExcusedAbsence(ctx, raw));
}
export async function declareConflictAction(
  meetingId: string,
  participantId: string,
  _: ActionState,
  form: FormData,
) {
  return onMeeting(meetingId, form, { participantId }, (s, ctx, raw) => s.declareConflict(ctx, raw));
}
export async function acknowledgeConfidentialityAction(
  meetingId: string,
  participantId: string,
  _: ActionState,
  form: FormData,
) {
  return onMeeting(meetingId, form, { participantId }, (s, ctx, raw) =>
    s.acknowledgeConfidentiality(ctx, raw),
  );
}
/** About one roster row (the runner), or, with no row bound, about the participant the member chose. */
export async function raiseConcernAction(
  meetingId: string,
  participantId: string | null,
  _: ActionState,
  form: FormData,
) {
  return onMeeting(meetingId, form, participantId ? { participantId } : {}, (s, ctx, raw) =>
    s.raiseConcern(ctx, raw),
  );
}

// ---- Raised conflicts ---------------------------------------------------------------------------------------------
export async function decideConcernAction(
  meetingId: string,
  concernId: string,
  _: ActionState,
  form: FormData,
) {
  return onMeeting(meetingId, form, { concernId }, (s, ctx, raw) => s.decideConcern(ctx, raw));
}
export async function reverseConcernAction(
  meetingId: string,
  concernId: string,
  _: ActionState,
  form: FormData,
) {
  return onMeeting(meetingId, form, { concernId }, (s, ctx, raw) => s.reverseConcern(ctx, raw));
}

// ---- Votes --------------------------------------------------------------------------------------------------------
export async function openVoteItemAction(meetingId: string, _: ActionState, form: FormData) {
  return onMeeting(meetingId, form, { meetingId }, (s, ctx, raw) => s.openVoteItem(ctx, raw));
}
export async function castVoteAction(meetingId: string, voteItemId: string, _: ActionState, form: FormData) {
  return onMeeting(meetingId, form, { voteItemId }, (s, ctx, raw) => s.castVote(ctx, raw));
}
export async function reviseVoteAction(
  meetingId: string,
  voteItemId: string,
  _: ActionState,
  form: FormData,
) {
  return onMeeting(meetingId, form, { voteItemId }, (s, ctx, raw) => s.reviseVote(ctx, raw));
}
export async function recuseForConflictAction(
  meetingId: string,
  voteItemId: string,
  _: ActionState,
  form: FormData,
) {
  return onMeeting(meetingId, form, { voteItemId }, (s, ctx, raw) => s.recuseForConflict(ctx, raw));
}
export async function recordVoteNoteAction(
  meetingId: string,
  voteItemId: string,
  _: ActionState,
  form: FormData,
) {
  return onMeeting(meetingId, form, { voteItemId }, (s, ctx, raw) => s.recordVoteNote(ctx, raw), [
    "annexToMinutes",
  ]);
}
export async function recordVoteForMemberAction(
  meetingId: string,
  voteItemId: string,
  _: ActionState,
  form: FormData,
) {
  return onMeeting(meetingId, form, { voteItemId }, (s, ctx, raw) => s.recordVoteForMember(ctx, raw));
}
export async function closeVoteItemAction(
  meetingId: string,
  voteItemId: string,
  _: ActionState,
  form: FormData,
) {
  return onMeeting(meetingId, form, { voteItemId }, (s, ctx, raw) => s.closeVoteItem(ctx, raw), [
    "customQuorumAttested",
  ]);
}
export async function castCastingVoteAction(
  meetingId: string,
  voteItemId: string,
  _: ActionState,
  form: FormData,
) {
  return onMeeting(meetingId, form, { voteItemId }, (s, ctx, raw) => s.castCastingVote(ctx, raw));
}

// ---- Minutes ------------------------------------------------------------------------------------------------------
export async function generateMinutesAction(meetingId: string, _: ActionState, form: FormData) {
  return onMeeting(meetingId, form, { meetingId }, (s, ctx, raw) => s.generateMinutes(ctx, raw));
}
