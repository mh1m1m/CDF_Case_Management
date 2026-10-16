"use server";
// The replacement decision's disposition of a frozen corrective action (UX redesign Phase 12 P12-3b; ADR-058;
// DEC-AMB-014). It goes through the corrective-action service, which checks CORRECTIVE_ACTION_MANAGE, validates with
// the shared schema and runs api.dispose_superseded_corrective_action in the caller's security context: the database
// decides that the caller manages the case's actions and may open the case, that the case is active, that the action
// is frozen and not yet disposed of, which dispositions the replacement decision allows, the source document, the new
// owner and the due date. The action's id is the one A2 gave the page; a forged id meets the same command.
import { revalidatePath } from "next/cache";
import { correctiveActionService, requireActor } from "@/server/container";
import { formObject, toActionState, type ActionState } from "@/server/actions-helpers";

export async function disposeAction(
  actionId: string,
  caseId: string | null,
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const { actor, ctx } = await requireActor();
  const result = await correctiveActionService().dispose(ctx, actor, { ...formObject(form), actionId });
  if (result.ok) {
    revalidatePath(`/actions/${actionId}`);
    // The case's action list and its closure step show the disposition.
    if (caseId) {
      revalidatePath(`/cases/${caseId}/proceedings`);
      revalidatePath(`/cases/${caseId}`);
    }
    revalidatePath("/my-work");
  }
  return toActionState(result, form);
}
