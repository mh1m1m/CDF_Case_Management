"use server";
// The corrective-action policy form (UX redesign Phase 12 P12-8b; ADR-063; DEC-F25 to DEC-F27): a new version of an
// action type's policy from a later date, with all twelve of the command's values (G8). The administration service
// validates with the shared schema, pre-checks CORRECTIVE_ACTION_POLICY_ADMIN, refuses a completion rule looser than a
// version in force or scheduled (coordinator ruling on F4, 2026-10-18 21:17) and runs
// api.set_corrective_action_policy in the caller's security context; the database decides every input again. A version
// is always provisional (SOURCE_REQUIRED): the form sends no status.
import { revalidatePath } from "next/cache";
import { administrationService, requireActor } from "@/server/container";
import { formObject, formRows, formValues, toActionState, type ActionState } from "@/server/actions-helpers";

export async function setCorrectiveActionPolicyAction(_: ActionState, form: FormData): Promise<ActionState> {
  const { actor, ctx } = await requireActor();
  const single = Object.fromEntries(
    Object.entries(formObject(form)).filter(([k]) => !k.startsWith("escalationSteps.")),
  );
  const result = await administrationService().setCorrectiveActionPolicy(ctx, actor, {
    ...single,
    allowedEvidenceTypes: formValues(form, "allowedEvidenceTypes"),
    escalationSteps: formRows(form, "escalationSteps"),
  });
  if (result.ok) revalidatePath("/admin/corrective-action-policy");
  return toActionState(result, form);
}
