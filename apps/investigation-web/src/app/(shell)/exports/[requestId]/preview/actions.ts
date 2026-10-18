"use server";
// The commands taken on what the preview shows (UX redesign Phase 12 P12-6b-1; ADR-026): the requester's submission,
// an approver's decision and the restricted case's authority's consent or refusal. Each is bound to the hash of the
// preview the caller read on this page, and the database compares it with the export as it stands (PREVIEW_CHANGED):
// an approval binds exactly what was submitted. The export service validates with the shared schema, pre-checks the
// role permission and runs the api.* command in the caller's security context, which decides again who may act.
// On success the caller goes back to the export's page, which says what changed; a refusal stays on this page with
// its words, and nothing is read again, so the preview is not run (and recorded) a second time.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ExportStatus } from "@cdf/contracts";
import { submitExportFormSchema } from "@cdf/validation";
import { exportService, requireActor } from "@/server/container";
import { formObject, toActionState, type ActionState } from "@/server/actions-helpers";

/** What the export's page says after the command, by the status the command returned. */
type Done =
  "submitted" | "approvedAtSubmit" | "approved" | "approvedStage" | "rejected" | "consented" | "refused";

function leave(requestId: string, done: Done): never {
  revalidatePath(`/exports/${requestId}`);
  revalidatePath("/my-work");
  redirect(`/exports/${requestId}?done=${done}`);
}

/**
 * The requester confirms the classification the preview shows (F11) and submits the export bound to that preview.
 * The confirmation is the page's own; the command compares the classification with the case's at submission.
 */
export async function submitExportAction(
  requestId: string,
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const parsed = submitExportFormSchema.safeParse({
    ...formObject(form, ["classificationConfirmed"]),
    requestId,
  });
  if (!parsed.success) return toActionState({ ok: false, fieldErrors: parsed.error }, form);
  const { actor, ctx } = await requireActor();
  const { previewHash, classification } = parsed.data;
  const result = await exportService().submit(ctx, actor, { requestId, previewHash, classification });
  if (result.ok) leave(requestId, result.value === "APPROVED" ? "approvedAtSubmit" : "submitted");
  return toActionState(result, form);
}

/** An approval stage's decision: the form's `decision` says which. */
export async function decideExportAction(
  requestId: string,
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const { actor, ctx } = await requireActor();
  const result = await exportService().decide(ctx, actor, { ...formObject(form), requestId });
  if (result.ok) leave(requestId, decided(form, result.value, "approved", "rejected"));
  return toActionState(result, form);
}

/** The restricted case's authority consents to the export or refuses it (DEC-F23). */
export async function authorityDecideExportAction(
  requestId: string,
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const { actor, ctx } = await requireActor();
  const result = await exportService().decideRestricted(ctx, actor, { ...formObject(form), requestId });
  if (result.ok) leave(requestId, decided(form, result.value, "consented", "refused"));
  return toActionState(result, form);
}

/** An approval that leaves the export waiting for another stage says so; a final one says it is approved. */
function decided(form: FormData, status: ExportStatus, approved: Done, rejected: Done): Done {
  if (form.get("decision") === "REJECT") return rejected;
  return approved === "approved" && status === "SUBMITTED" ? "approvedStage" : approved;
}
