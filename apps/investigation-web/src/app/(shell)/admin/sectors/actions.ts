"use server";
// The sectors' forms (UX redesign Phase 12 P12-8b; ADR-063, ADR-064): create a sector, end a position (now, or from
// a date with the decree or source reference that an end dated before now requires; 2128, the owner's decision
// F7 = B), and revoke a delegated referral approval. Each goes through the administration service, which validates
// with the shared schema, pre-checks SECTOR_ADMIN and runs the api.* command in the caller's security context; the
// database decides every input again (a code already taken, a position already ended, a past end without its
// reference, a delegation no longer active). Appointing to a position waits for the owner's F5 card.
import { revalidatePath } from "next/cache";
import { administrationService, requireActor } from "@/server/container";
import { formObject, toActionState, type ActionState } from "@/server/actions-helpers";

export async function createSectorAction(_: ActionState, form: FormData): Promise<ActionState> {
  const { actor, ctx } = await requireActor();
  const result = await administrationService().createSector(ctx, actor, formObject(form));
  if (result.ok) revalidatePath("/admin/sectors");
  return toActionState(result, form);
}

export async function endSectorMembershipAction(_: ActionState, form: FormData): Promise<ActionState> {
  const { actor, ctx } = await requireActor();
  const result = await administrationService().endSectorMembership(ctx, actor, formObject(form));
  if (result.ok) revalidatePath("/admin/sectors");
  return toActionState(result, form);
}

export async function revokeDelegationAction(_: ActionState, form: FormData): Promise<ActionState> {
  const { actor, ctx } = await requireActor();
  const result = await administrationService().revokeDelegation(ctx, actor, formObject(form));
  if (result.ok) revalidatePath("/admin/sectors");
  return toActionState(result, form);
}
