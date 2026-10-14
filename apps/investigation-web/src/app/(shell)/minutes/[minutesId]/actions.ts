"use server";
// The minutes page's commands (UX redesign Phase 12 P12-2a; ADR-054). Each one goes through the meetings service,
// which validates with the shared schema and runs the api.* command in the caller's security context: the database
// decides who may review, remind, count the minutes as approved or overrule an objection, and when.
import { revalidatePath } from "next/cache";
import type { CommandResult } from "@cdf/application";
import { meetingsService, requireActor, type RequestScope } from "@/server/container";
import { formObject, toActionState, type ActionState } from "@/server/actions-helpers";

type Run = (
  service: ReturnType<typeof meetingsService>,
  ctx: RequestScope["ctx"],
  raw: Record<string, unknown>,
) => Promise<CommandResult<unknown>>;

/** Runs one command on this version, then refreshes the minutes and their meeting. */
async function onMinutes(
  minutesId: string,
  meetingId: string,
  form: FormData,
  run: Run,
): Promise<ActionState> {
  const { ctx } = await requireActor();
  const result = await run(meetingsService(), ctx, { ...formObject(form), minutesId });
  if (result.ok) {
    revalidatePath(`/minutes/${minutesId}`);
    revalidatePath(`/meetings/${meetingId}`);
  }
  return toActionState(result, form);
}

export async function reviewMinutesAction(
  minutesId: string,
  meetingId: string,
  _: ActionState,
  form: FormData,
) {
  return onMinutes(minutesId, meetingId, form, (s, ctx, raw) => s.reviewMinutes(ctx, raw));
}
export async function remindReviewersAction(
  minutesId: string,
  meetingId: string,
  _: ActionState,
  form: FormData,
) {
  return onMinutes(minutesId, meetingId, form, (s, ctx, raw) => s.recordMinutesReminder(ctx, raw));
}
export async function applyDeemedApprovalAction(
  minutesId: string,
  meetingId: string,
  _: ActionState,
  form: FormData,
) {
  return onMinutes(minutesId, meetingId, form, (s, ctx, raw) => s.applyMinutesDeemedApproval(ctx, raw));
}
export async function overruleObjectionAction(
  minutesId: string,
  meetingId: string,
  _: ActionState,
  form: FormData,
) {
  return onMinutes(minutesId, meetingId, form, (s, ctx, raw) => s.overruleMinutesObjection(ctx, raw));
}
