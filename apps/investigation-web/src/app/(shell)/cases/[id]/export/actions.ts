"use server";
// Asking for an export of the case (UX redesign Phase 12 P12-6b-1; ADR-026; DEC-F21, F1 of the P12-6b map). The form's
// schema narrows the command's (an email export goes outside the platform only, while internal recipients wait for
// their candidate read); the export service validates again with the command's schema, pre-checks EXPORT_REQUEST and
// runs api.create_export_request in the caller's security context, which decides that the caller may see the case and
// that the purpose is an active one of the governed catalogue. The case's id is the route's; a forged id meets the
// same command. The new request opens on its own page.
import { redirect } from "next/navigation";
import { requestExportFormSchema } from "@cdf/validation";
import { exportService, requireActor } from "@/server/container";
import { formObject, toActionState, type ActionState } from "@/server/actions-helpers";

export async function requestExportAction(
  caseId: string,
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const { actor, ctx } = await requireActor();
  const parsed = requestExportFormSchema.safeParse({ ...formObject(form), caseId });
  if (!parsed.success) return toActionState({ ok: false, fieldErrors: parsed.error }, form);
  const result = await exportService().createRequest(ctx, actor, parsed.data);
  if (result.ok) redirect(`/exports/${result.value}?done=created`);
  return toActionState(result, form);
}
