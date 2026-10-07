"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { evidenceService, investigationService, requireActor } from "@/server/container";
import { formObject, toActionState, type ActionState } from "@/server/actions-helpers";

export async function updateDetailsAction(
  caseId: string,
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const { actor, ctx } = await requireActor();
  const result = await investigationService().updateCaseDetails(ctx, actor, { ...formObject(form), caseId });
  if (result.ok) revalidatePath(`/cases/${caseId}`);
  return toActionState(result);
}

export async function assignAction(caseId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const { actor, ctx } = await requireActor();
  const result = await investigationService().assignCase(ctx, actor, { ...formObject(form), caseId });
  if (result.ok) revalidatePath(`/cases/${caseId}`);
  return toActionState(result);
}

export async function declareConflictAction(
  caseId: string,
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const { actor, ctx } = await requireActor();
  const hasConflict = form.get("hasConflict") === "true";
  const result = await investigationService().declareConflict(ctx, actor, {
    ...formObject(form),
    hasConflict,
    caseId,
  });
  // A declared conflict removes access immediately, so leave the case.
  if (result.ok && hasConflict) redirect("/cases");
  if (result.ok) revalidatePath(`/cases/${caseId}`);
  return toActionState(result);
}

export async function transitionAction(
  caseId: string,
  transitionCode: string,
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const { actor, ctx } = await requireActor();
  const result = await investigationService().transitionCase(ctx, actor, {
    ...formObject(form),
    caseId,
    transitionCode,
  });
  if (result.ok) revalidatePath(`/cases/${caseId}`);
  return toActionState(result);
}

/**
 * Evidence upload (§24–§27). The file travels only server-side: bytes → checks → quarantine → scan → vault.
 * `evidenceId` is set when adding a version to an existing item.
 */
export async function uploadEvidenceAction(
  caseId: string,
  evidenceId: string | null,
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const { actor, ctx } = await requireActor();
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { status: "invalid", fieldErrors: { file: "validation.required" } };
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const metadata = { ...formObject(form), caseId, ...(evidenceId ? { evidenceId } : {}) };
  delete (metadata as Record<string, unknown>).file;
  const result = await evidenceService().upload(ctx, actor, metadata, { name: file.name, bytes });
  if (result.ok) {
    revalidatePath(`/cases/${caseId}`);
    return { status: "ok", message: result.value.sha256 };
  }
  return toActionState(result);
}
