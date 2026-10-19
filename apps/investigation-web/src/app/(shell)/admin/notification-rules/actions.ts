"use server";
// The notification rule form (UX redesign Phase 12 P12-8b; ADR-063): a notice on or off from a later date,
// platform-wide or as a committee's default. The administration service validates with the shared schema,
// pre-checks NOTIFICATION_ADMIN, refuses a mandatory notice (always sent: no rule changes it) and runs
// api.set_notification_rule in the caller's security context; the database decides every input again, including a
// later rule of the same notice and channel (LATER_RULE_EXISTS, F8).
import { revalidatePath } from "next/cache";
import { administrationService, requireActor } from "@/server/container";
import { formObject, toActionState, type ActionState } from "@/server/actions-helpers";

export async function setNotificationRuleAction(_: ActionState, form: FormData): Promise<ActionState> {
  const { actor, ctx } = await requireActor();
  const result = await administrationService().setNotificationRule(ctx, actor, formObject(form));
  if (result.ok) revalidatePath("/admin/notification-rules");
  return toActionState(result, form);
}
