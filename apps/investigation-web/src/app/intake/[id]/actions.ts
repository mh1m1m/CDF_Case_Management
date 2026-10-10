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
  const result = await investigationService().createCase(ctx, actor, {
    ...formObject(form, ["isRestricted"]),
    reportId,
  });
  if (result.ok) redirect(`/cases/${result.value}`);
  return toActionState(result);
}
