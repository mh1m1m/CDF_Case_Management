"use server";
// Forms module server actions (Phase 8; ADR-011). Field data travels only server-side; every command is
// validated by the shared schema, the domain rules and the database, which also writes the audit events.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { formsService, requireActor } from "@/server/container";
import { getTranslator } from "@/server/locale";
import { formObject, toActionState, type ActionState } from "@/server/actions-helpers";

const FIELD = /^[a-z][a-z0-9_]{1,63}$/;

function refresh(caseId: string, instanceId?: string) {
  revalidatePath(`/cases/${caseId}/forms`);
  if (instanceId) revalidatePath(`/cases/${caseId}/forms/${instanceId}`);
}

export async function startFormAction(
  caseId: string,
  formCode: string,
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const { actor, ctx } = await requireActor();
  const result = await formsService().start(ctx, actor, { ...formObject(form), caseId, formCode });
  if (result.ok) {
    refresh(caseId);
    redirect(`/cases/${caseId}/forms/${result.value.instanceId}`);
  }
  return toActionState(result);
}

export async function saveDraftAction(
  caseId: string,
  instanceId: string,
  formCode: string,
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const { actor, ctx } = await requireActor();
  const t = await getTranslator();
  const result = await formsService().saveDraft(ctx, actor, { instanceId, formCode, data: formObject(form) });
  if (result.ok) {
    refresh(caseId, instanceId);
    return {
      status: "ok",
      message: t("forms.savedDetail", { no: result.value.versionNo, hash: result.value.contentHash }),
    };
  }
  const state = toActionState(result);
  // Domain field issues arrive under data.<field>; show them against the field itself.
  if (state.status === "invalid") {
    state.fieldErrors = Object.fromEntries(
      Object.entries(state.fieldErrors).map(([k, v]) => [k.replace(/^data\./, ""), v]),
    );
  }
  return state;
}

export async function prepareFormAction(
  caseId: string,
  instanceId: string,
  formCode: string,
  _: ActionState,
): Promise<ActionState> {
  const { actor, ctx } = await requireActor();
  const result = await formsService().prepare(ctx, actor, { instanceId, formCode });
  if (result.ok) refresh(caseId, instanceId);
  const state = toActionState(result);
  // Strict validation names the first missing required field (data already passed the lenient checks).
  if (state.status === "error" && state.kind === "INVALID" && state.detail && FIELD.test(state.detail)) {
    return { status: "invalid", fieldErrors: { [state.detail]: "validation.required" } };
  }
  return state;
}

export async function reviewFormAction(
  caseId: string,
  instanceId: string,
  formCode: string,
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const { actor, ctx } = await requireActor();
  const result = await formsService().review(ctx, actor, { ...formObject(form), instanceId, formCode });
  if (result.ok) refresh(caseId, instanceId);
  return toActionState(result);
}

export async function approveFormAction(
  caseId: string,
  instanceId: string,
  formCode: string,
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const { actor, ctx } = await requireActor();
  const result = await formsService().approve(ctx, actor, { ...formObject(form), instanceId, formCode });
  if (result.ok) refresh(caseId, instanceId);
  return toActionState(result);
}

export async function withdrawFormAction(
  caseId: string,
  instanceId: string,
  formCode: string,
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const { actor, ctx } = await requireActor();
  const result = await formsService().withdraw(ctx, actor, { ...formObject(form), instanceId, formCode });
  if (result.ok) refresh(caseId, instanceId);
  return toActionState(result);
}
