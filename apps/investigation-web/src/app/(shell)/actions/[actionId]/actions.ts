"use server";
// The commands on a corrective action's page (UX redesign Phase 12; ADR-058). Each goes through the corrective-action
// service, which validates with the shared schema, pre-checks the role permission and runs the api.* command in the
// caller's security context, so the database decides again on submit. The action's id is the one A2 gave the page; a
// forged id meets the same command.
//
// - P12-3b (DEC-AMB-014): the replacement decision's disposition of a frozen action
//   (api.dispose_superseded_corrective_action). The database decides that the caller manages the case's actions and
//   may open the case, that the case is active, that the action is frozen and not yet disposed of, which dispositions
//   the replacement decision allows, the source document, the new owner and the due date.
// - P12-6a: the owner's progress and completion (api.record_corrective_action_progress and the four-argument
//   api.submit_corrective_action_completion). The database decides that the caller acts for the action, that it is
//   open and may move, and what evidence the policy in force asks for.
// - P12-6a: the verifier's decision (api.verify_corrective_action) and a manager's reopening
//   (api.reopen_corrective_action). The database decides that the caller manages the case's actions and may open the
//   case, that neither the owner nor anyone who submitted a completion verifies it, and that only a completed action of
//   an active case reopens.
import { revalidatePath } from "next/cache";
import type { CommandResult } from "@cdf/application";
import { correctiveActionService, requireActor } from "@/server/container";
import { formObject, toActionState, type ActionState } from "@/server/actions-helpers";
import { withoutBlock } from "../labels";

/**
 * After the command: every page that shows where the action stands is read again, then the form gets its answer,
 * which never names the block that held the action (the case team reads it on the page; no one else does).
 */
function answer<T>(
  actionId: string,
  caseId: string | null,
  form: FormData,
  result: CommandResult<T>,
): ActionState {
  if (result.ok) {
    revalidatePath(`/actions/${actionId}`);
    // The case's action list and its closure step. Only the case team has a case here: the page gives no case to
    // anyone else.
    if (caseId) {
      revalidatePath(`/cases/${caseId}/proceedings`);
      revalidatePath(`/cases/${caseId}`);
    }
    revalidatePath("/my-work");
  }
  return withoutBlock(toActionState(result, form));
}

export async function disposeAction(
  actionId: string,
  caseId: string | null,
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const { actor, ctx } = await requireActor();
  const result = await correctiveActionService().dispose(ctx, actor, { ...formObject(form), actionId });
  return answer(actionId, caseId, form, result);
}

export async function recordProgressAction(
  actionId: string,
  caseId: string | null,
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const { actor, ctx } = await requireActor();
  const result = await correctiveActionService().recordProgress(ctx, actor, {
    ...formObject(form),
    actionId,
  });
  return answer(actionId, caseId, form, result);
}

export async function submitCompletionAction(
  actionId: string,
  caseId: string | null,
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const { actor, ctx } = await requireActor();
  const result = await correctiveActionService().submitCompletion(ctx, actor, {
    ...formObject(form),
    actionId,
  });
  return answer(actionId, caseId, form, result);
}

/** Verifies the completion or returns it to the owner: the form's `decision` says which. */
export async function verifyAction(
  actionId: string,
  caseId: string | null,
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const { actor, ctx } = await requireActor();
  const result = await correctiveActionService().verify(ctx, actor, { ...formObject(form), actionId });
  return answer(actionId, caseId, form, result);
}

export async function reopenAction(
  actionId: string,
  caseId: string | null,
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const { actor, ctx } = await requireActor();
  const result = await correctiveActionService().reopen(ctx, actor, { ...formObject(form), actionId });
  return answer(actionId, caseId, form, result);
}
