"use server";
// The export policy's forms (UX redesign Phase 12 P12-8b; ADR-063; coordinator ruling on F4, 2026-10-18 21:17): a rule
// for a new code, a new purpose, and a change to a purpose at the version read (F13). The administration service
// validates with the shared schema, pre-checks the export policy administrator (DEC-F24) and runs the api.* command in
// the caller's security context; the database decides every input again. No form sends a source status: a rule is
// always provisional (SOURCE_REQUIRED), and a purpose is recorded as the administrator's own catalogue entry.
import { revalidatePath } from "next/cache";
import { administrationService, requireActor } from "@/server/container";
import { formObject, toActionState, type ActionState } from "@/server/actions-helpers";

export async function addExportRuleAction(_: ActionState, form: FormData): Promise<ActionState> {
  const { actor, ctx } = await requireActor();
  const result = await administrationService().addExportRule(
    ctx,
    actor,
    formObject(form, ["restrictedOnly"]),
  );
  if (result.ok) revalidatePath("/admin/export-policy");
  return toActionState(result, form);
}

const PURPOSE_FLAGS = ["requiresJustification", "isActive"];

export async function addExportPurposeAction(_: ActionState, form: FormData): Promise<ActionState> {
  const { actor, ctx } = await requireActor();
  const result = await administrationService().addExportPurpose(ctx, actor, formObject(form, PURPOSE_FLAGS));
  if (result.ok) revalidatePath("/admin/export-policy");
  return toActionState(result, form);
}

export async function editExportPurposeAction(_: ActionState, form: FormData): Promise<ActionState> {
  const { actor, ctx } = await requireActor();
  const result = await administrationService().editExportPurpose(ctx, actor, formObject(form, PURPOSE_FLAGS));
  if (result.ok) revalidatePath("/admin/export-policy");
  return toActionState(result, form);
}
