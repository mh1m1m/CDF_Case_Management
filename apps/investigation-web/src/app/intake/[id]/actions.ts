"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { investigationService, requireActor } from "@/server/container";
import { formObject, toActionState, type ActionState } from "@/server/actions-helpers";

export async function triageAction(reportId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const { actor, ctx } = await requireActor();
  const result = await investigationService().triageReport(ctx, actor, { ...formObject(form), reportId });
  if (result.ok) revalidatePath(`/intake/${reportId}`);
  return toActionState(result);
}

export async function replyAction(reportId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const { actor, ctx } = await requireActor();
  const result = await investigationService().replyToReporter(ctx, actor, { ...formObject(form), reportId });
  if (result.ok) revalidatePath(`/intake/${reportId}`);
  return toActionState(result);
}

export async function createCaseAction(
  reportId: string,
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const { actor, ctx } = await requireActor();
  const input: Record<string, unknown> = { ...formObject(form, ["isRestricted"]), reportId };
  const result = await investigationService().createCase(ctx, actor, input);
  // A restricted case is handed to its authority at creation (DEC-01): the initiator can no longer open the case
  // or its report, so they return to the queue with a notice instead of being sent to a page they cannot see.
  if (result.ok) redirect(input.isRestricted === true ? "/intake?handedOver=1" : `/cases/${result.value}`);
  return toActionState(result);
}
