"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { evidenceService, investigationService, requireActor } from "@/server/container";
import type { Priority } from "@cdf/contracts";
import { formObject, toActionState, withEcho, type ActionState } from "@/server/actions-helpers";

/** The case details exactly as the page rendered them, bound to the details form (UX-030). */
export interface RenderedCaseDetails {
  rowVersion: number;
  title: string;
  summary: string;
  priority: Priority | null;
}

/**
 * UX-030: the form sends only the fields the user changed (CDFCommandForm `changedOnly`); every other field keeps
 * the value the page rendered, and the version check uses the version the page rendered. So a stale control can
 * never write an old value back past the check, and a concurrent edit is refused as a conflict, not overwritten.
 * The database command (api.update_case_details) is unchanged and still decides.
 */
export async function updateDetailsAction(
  caseId: string,
  rendered: RenderedCaseDetails,
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const { actor, ctx } = await requireActor();
  const sent = formObject(form);
  // Bound arguments come back from the browser: anything malformed simply fails the shared schema.
  const r: Partial<RenderedCaseDetails> = rendered && typeof rendered === "object" ? rendered : {};
  const result = await investigationService().updateCaseDetails(ctx, actor, {
    caseId,
    title: form.has("title") ? sent.title : r.title,
    summary: form.has("summary") ? sent.summary : r.summary,
    // An emptied select clears the priority, as before; an untouched one keeps the rendered value.
    priority: form.has("priority") ? sent.priority : (r.priority ?? undefined),
    expectedVersion: r.rowVersion,
  });
  if (result.ok) revalidatePath(`/cases/${caseId}`);
  return toActionState(result, form);
}

export async function assignAction(caseId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const { actor, ctx } = await requireActor();
  const result = await investigationService().assignCase(ctx, actor, { ...formObject(form), caseId });
  if (result.ok) revalidatePath(`/cases/${caseId}`);
  return toActionState(result, form);
}

export async function declareConflictAction(
  caseId: string,
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const { actor, ctx } = await requireActor();
  // No default answer (UX-019): an unanswered declaration is refused by the shared schema, never read as "no".
  const answer = form.get("hasConflict");
  const hasConflict = answer === "true" ? true : answer === "false" ? false : undefined;
  const result = await investigationService().declareConflict(ctx, actor, {
    ...formObject(form),
    hasConflict,
    caseId,
  });
  // A declared conflict removes access immediately, so leave the case.
  if (result.ok && hasConflict) redirect("/cases");
  if (result.ok) revalidatePath(`/cases/${caseId}`);
  return toActionState(result, form);
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
  return toActionState(result, form);
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
    return withEcho({ status: "invalid", fieldErrors: { file: "validation.required" } }, form);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const metadata = { ...formObject(form), caseId, ...(evidenceId ? { evidenceId } : {}) };
  delete (metadata as Record<string, unknown>).file;
  const result = await evidenceService().upload(ctx, actor, metadata, { name: file.name, bytes });
  if (result.ok) {
    revalidatePath(`/cases/${caseId}`);
    return { status: "ok", message: result.value.sha256 };
  }
  return toActionState(result, form);
}
