"use server";
// The business calendar's forms (UX redesign Phase 12 P12-8a and P12-8b; ADR-051's P12-8a amendment, ADR-063;
// DEC-F02). Each goes through the administration service, which validates with the shared schema, pre-checks
// BUSINESS_CALENDAR_ADMIN and runs the api.* command in the caller's security context: the database decides every
// input again, including whether a date is in the past in Riyadh, whether a day or a later week already exists and
// whether a day is already withdrawn. A new week is always recorded as SOURCE_REQUIRED (coordinator ruling F4): the
// form sends no status.
import { revalidatePath } from "next/cache";
import { administrationService, requireActor } from "@/server/container";
import { formObject, toActionState, type ActionState } from "@/server/actions-helpers";

export async function setCalendarDayAction(_: ActionState, form: FormData): Promise<ActionState> {
  const { actor, ctx } = await requireActor();
  const result = await administrationService().setCalendarDay(ctx, actor, formObject(form));
  if (result.ok) revalidatePath("/admin/calendar");
  return toActionState(result, form);
}

export async function setWeekPatternAction(_: ActionState, form: FormData): Promise<ActionState> {
  const { actor, ctx } = await requireActor();
  // Each ticked day arrives as its own value; formObject keeps only the last of a repeated name.
  const result = await administrationService().setWeekPattern(ctx, actor, {
    ...formObject(form),
    nonWorkingDays: form.getAll("nonWorkingDays").filter((v): v is string => typeof v === "string"),
  });
  if (result.ok) revalidatePath("/admin/calendar");
  return toActionState(result, form);
}

export async function withdrawCalendarDayAction(_: ActionState, form: FormData): Promise<ActionState> {
  const { actor, ctx } = await requireActor();
  const result = await administrationService().withdrawCalendarDay(ctx, actor, formObject(form));
  if (result.ok) revalidatePath("/admin/calendar");
  return toActionState(result, form);
}
