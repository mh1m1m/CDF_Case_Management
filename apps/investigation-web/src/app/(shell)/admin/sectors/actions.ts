"use server";
// The sectors' forms (UX redesign Phase 12 P12-8b; ADR-063): create a sector, and revoke a delegated referral
// approval. Each goes through the administration service, which validates with the shared schema, pre-checks
// SECTOR_ADMIN and runs the api.* command in the caller's security context; the database decides every input again
// (a code already taken, a delegation no longer active). Appointing to a position waits (F5, F7).
import { revalidatePath } from "next/cache";
import { administrationService, requireActor } from "@/server/container";
import { formObject, toActionState, type ActionState } from "@/server/actions-helpers";

export async function createSectorAction(_: ActionState, form: FormData): Promise<ActionState> {
  const { actor, ctx } = await requireActor();
  const result = await administrationService().createSector(ctx, actor, formObject(form));
  if (result.ok) revalidatePath("/admin/sectors");
  return toActionState(result, form);
}

export async function revokeDelegationAction(_: ActionState, form: FormData): Promise<ActionState> {
  const { actor, ctx } = await requireActor();
  const result = await administrationService().revokeDelegation(ctx, actor, formObject(form));
  if (result.ok) revalidatePath("/admin/sectors");
  return toActionState(result, form);
}
