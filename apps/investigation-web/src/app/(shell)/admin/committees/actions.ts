"use server";
// The committees' forms (UX redesign Phase 12 P12-8b; ADR-063, ADR-064). The committee rules form: a new version of a
// committee's rules from a later date, with only the options the administrator changed (CDFCommandForm `changedOnly`).
// The administration service validates with the shared schema, pre-checks COMMITTEE_ADMIN and runs
// api.revise_committee_rule_set in the caller's security context; the database checks every value of the new version
// again. A version is always provisional (SOURCE_REQUIRED): the form sends no status. An option that follows a decision
// has no field on the form, and the service refuses a revision that names one, whatever its value (DECIDED_OPTION;
// coordinator ruling of 2026-10-18 23:20). The end of a seat: now, or from a date with the decree or source reference
// that an end dated before now requires (api.end_committee_membership, 2128; the owner's decision F7 = B). Appointing
// to seats waits for the owner's F5 card.
import { revalidatePath } from "next/cache";
import { RULE_SET_REVISION_KEYS } from "@cdf/validation";
import { administrationService, requireActor } from "@/server/container";
import { clearedFields, formObject, toActionState, type ActionState } from "@/server/actions-helpers";

/**
 * Every option's field: one the user emptied comes as null, which clears it or, where it may not be cleared, is refused.
 * A decided option is listed too, so that one sent empty still reaches the service, which refuses it.
 */
const OPTION_FIELDS = Object.keys(RULE_SET_REVISION_KEYS);

export async function reviseCommitteeRuleSetAction(_: ActionState, form: FormData): Promise<ActionState> {
  const { actor, ctx } = await requireActor();
  const result = await administrationService().reviseCommitteeRuleSet(ctx, actor, {
    ...formObject(form),
    ...clearedFields(form, OPTION_FIELDS),
  });
  if (result.ok) revalidatePath("/admin/committees");
  return toActionState(result, form);
}

export async function endCommitteeMembershipAction(_: ActionState, form: FormData): Promise<ActionState> {
  const { actor, ctx } = await requireActor();
  const result = await administrationService().endCommitteeMembership(ctx, actor, formObject(form));
  if (result.ok) revalidatePath("/admin/committees");
  return toActionState(result, form);
}
