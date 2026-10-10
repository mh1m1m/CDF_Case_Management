"use server";
// Records, retention and legal hold server actions (CDF-71). Each goes through the records service, which
// pre-checks the permission, re-validates with the shared schema and lets the api.* command decide; ids come
// from the route or the form and are never trusted for authorization.
import { revalidatePath } from "next/cache";
import type { CommandResult } from "@cdf/application";
import { investigationService, recordsService, requireActor } from "@/server/container";
import { formObject, toActionState, type ActionState } from "@/server/actions-helpers";

type RecordCommand =
  | "assignRetentionClass"
  | "placeLegalHold"
  | "requestHoldRelease"
  | "decideHoldRelease"
  | "requestLegalHold"
  | "assignHoldRequest"
  | "reviewHoldRequest"
  | "requestDisposition"
  | "decideDisposition"
  | "executeDisposition";

async function onRecord(
  name: RecordCommand,
  caseId: string | null,
  fields: Record<string, unknown>,
  form: FormData,
): Promise<ActionState> {
  const { actor, ctx } = await requireActor();
  const result: CommandResult<unknown> = await recordsService()[name](ctx, actor, {
    ...formObject(form, ["confirm"]),
    ...fields,
  });
  if (result.ok) {
    if (caseId) revalidatePath(`/records/${caseId}`);
    revalidatePath("/records/legal-holds");
  }
  return toActionState(result);
}

export async function assignRetentionClassAction(caseId: string, _: ActionState, form: FormData) {
  return onRecord("assignRetentionClass", caseId, { caseId }, form);
}
export async function placeLegalHoldAction(caseId: string, _: ActionState, form: FormData) {
  return onRecord("placeLegalHold", caseId, { caseId }, form);
}
export async function requestHoldReleaseAction(
  caseId: string,
  holdId: string,
  _: ActionState,
  form: FormData,
) {
  return onRecord("requestHoldRelease", caseId, { holdId }, form);
}
export async function decideHoldReleaseAction(
  caseId: string,
  releaseId: string,
  _: ActionState,
  form: FormData,
) {
  return onRecord("decideHoldRelease", caseId, { releaseId }, form);
}
export async function requestLegalHoldAction(caseId: string, _: ActionState, form: FormData) {
  return onRecord("requestLegalHold", caseId, { caseId }, form);
}
export async function assignHoldRequestAction(
  caseId: string | null,
  requestId: string,
  _: ActionState,
  form: FormData,
) {
  return onRecord("assignHoldRequest", caseId, { requestId }, form);
}
export async function reviewHoldRequestAction(
  caseId: string | null,
  requestId: string,
  _: ActionState,
  form: FormData,
) {
  return onRecord("reviewHoldRequest", caseId, { requestId }, form);
}
export async function requestDispositionAction(caseId: string, _: ActionState, form: FormData) {
  return onRecord("requestDisposition", caseId, { caseId }, form);
}
export async function decideDispositionAction(
  caseId: string,
  requestId: string,
  _: ActionState,
  form: FormData,
) {
  return onRecord("decideDisposition", caseId, { requestId }, form);
}
export async function executeDispositionAction(
  caseId: string,
  requestId: string,
  _: ActionState,
  form: FormData,
) {
  return onRecord("executeDisposition", caseId, { requestId }, form);
}

export async function refreshEligibilityAction(): Promise<ActionState> {
  const { actor, ctx } = await requireActor();
  const result = await recordsService().refreshEligibility(ctx, actor);
  if (result.ok) revalidatePath("/records");
  return toActionState(result);
}

/**
 * Controlled exact-match lookup (ADR-014 §6). A miss is reported like any unavailable item, so the
 * answer never confirms that a case number exists outside the caller's reach.
 */
export async function caseLookupAction(_: ActionState, form: FormData): Promise<ActionState> {
  const { actor, ctx } = await requireActor();
  const result = await investigationService().requestCaseForLegalHold(ctx, actor, formObject(form));
  if (result.ok && result.value.outcome === "NO_MATCH") {
    return { status: "error", kind: "NOT_FOUND", ref: ctx.requestId };
  }
  if (result.ok) revalidatePath("/records/legal-holds");
  return toActionState(result);
}
