"use server";
// The requester's commands on an export's page (UX redesign Phase 12 P12-6b-1; ADR-026). Each goes through the export
// service, which validates with the shared schema, pre-checks the role permission and runs the api.* command in the
// caller's security context: the database decides that the caller asked for this export, that it is still a draft
// (or, for generation, approved and unchanged since it was submitted), and every limit. The export's id is the one
// the view gave the page, and the case summary's id is the case the view names; a forged id meets the same command
// and its refusal. Nothing here returns the storage key, the document or an address to the browser.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { CommandResult } from "@cdf/application";
import { exportService, requireActor } from "@/server/container";
import { formObject, toActionState, type ActionState } from "@/server/actions-helpers";

/** After the command: the export's page and My Work are read again, then the form gets its answer. */
function answer<T>(requestId: string, form: FormData, result: CommandResult<T>): ActionState {
  if (result.ok) {
    revalidatePath(`/exports/${requestId}`);
    revalidatePath("/my-work");
  }
  return toActionState(result, form);
}

/** After a command that ends what the page offered (generation, cancellation): the page says what changed. */
function leave(requestId: string, done: "sent" | "generated" | "cancelled"): never {
  revalidatePath(`/exports/${requestId}`);
  revalidatePath("/my-work");
  redirect(`/exports/${requestId}?done=${done}`);
}

/** Adds the case summary of the export's own case: the only item this page offers (the other kinds wait, F9). */
export async function addCaseSummaryAction(
  requestId: string,
  caseId: string,
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const { actor, ctx } = await requireActor();
  const result = await exportService().addItem(ctx, actor, {
    requestId,
    objectType: "CASE_SUMMARY",
    objectId: caseId,
  });
  return answer(requestId, form, result);
}

/** An external address, typed twice (AMB-187); internal recipients wait for their candidate read (F9). */
export async function addExternalRecipientAction(
  requestId: string,
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const { actor, ctx } = await requireActor();
  const result = await exportService().addRecipient(ctx, actor, {
    ...formObject(form),
    requestId,
    kind: "EXTERNAL",
  });
  return answer(requestId, form, result);
}

/** Generates an approved email export and hands it to the mail relay; an accepted delivery is recorded as sent. */
export async function generateExportAction(
  requestId: string,
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const { actor, ctx } = await requireActor();
  const result = await exportService().generate(ctx, actor, { requestId });
  if (result.ok) leave(requestId, result.value.status === "SENT" ? "sent" : "generated");
  return toActionState(result, form);
}

export async function cancelExportAction(
  requestId: string,
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const { actor, ctx } = await requireActor();
  const result = await exportService().cancel(ctx, actor, { ...formObject(form), requestId });
  if (result.ok) leave(requestId, "cancelled");
  return toActionState(result, form);
}
