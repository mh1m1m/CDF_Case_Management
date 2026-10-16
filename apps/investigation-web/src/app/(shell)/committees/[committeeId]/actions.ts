"use server";
// The committee page's commands (UX redesign Phase 12 P12-2b; ADR-055): scheduling a meeting, on the ordinary path or
// the emergency one, and adding a member to a proceeding. Each goes through the committees service, which validates
// with the shared schema and runs the api.* command in the caller's security context: the database decides who may act
// and in which state. The proceeding's id is the one the read model gave the page; a forged id meets the same command
// and its refusal.
import { revalidatePath } from "next/cache";
import { committeesService, requireActor } from "@/server/container";
import { formObject, toActionState, type ActionState } from "@/server/actions-helpers";

/** Refreshes the committee's page and My Committees, whose counts a new meeting changes. */
function refresh(committeeId: string) {
  revalidatePath(`/committees/${committeeId}`);
  revalidatePath("/committees");
}

/** The emergency box picks the command: an emergency meeting needs its reason and skips the minimum notice. */
export async function scheduleMeetingAction(
  committeeId: string,
  committeeProceedingId: string,
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const { ctx } = await requireActor();
  const { emergency, ...fields } = formObject(form, ["emergency"]);
  const raw = { ...fields, committeeProceedingId };
  const result =
    emergency === true
      ? await committeesService().scheduleEmergencyMeeting(ctx, raw)
      : await committeesService().scheduleMeeting(ctx, raw);
  if (result.ok) refresh(committeeId);
  return toActionState(result, form);
}

export async function amendProceedingSnapshotAction(
  committeeId: string,
  committeeProceedingId: string,
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const { ctx } = await requireActor();
  const result = await committeesService().amendProceedingSnapshot(ctx, {
    ...formObject(form),
    committeeProceedingId,
  });
  if (result.ok) refresh(committeeId);
  return toActionState(result, form);
}
