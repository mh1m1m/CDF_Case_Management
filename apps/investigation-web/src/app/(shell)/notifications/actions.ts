"use server";
// In-app notification server actions (UX redesign S4; ADR-025). Each goes through the inbox service, which
// re-validates with the shared schema and lets the api.* command decide: a notification that is not the caller's
// own answers NOT_FOUND, and a mandatory notice cannot be muted. Ids come from the form and are never trusted.
import { revalidatePath } from "next/cache";
import { inboxService, requireActor } from "@/server/container";
import { formObject, toActionState, type ActionState } from "@/server/actions-helpers";
import { hasChoice, receiveField } from "./fields";

export async function markNotificationReadAction(_: ActionState, form: FormData): Promise<ActionState> {
  const { ctx } = await requireActor();
  const result = await inboxService().markRead(ctx, formObject(form));
  if (result.ok) revalidatePath("/notifications");
  return toActionState(result, form);
}

/**
 * Saves the choices that differ from the caller's stored settings, all in one transaction. Only the settings the
 * page offers a checkbox for are read from the form (hasChoice): a mandatory notice has none, and the database
 * refuses to mute it anyway.
 */
export async function saveNotificationSettingsAction(_: ActionState, form: FormData): Promise<ActionState> {
  const { ctx } = await requireActor();
  const current = await inboxService().settings(ctx);
  const changes = current.filter(hasChoice).flatMap((s) => {
    const receive = form.get(receiveField(s.template, s.channel)) === "on";
    return receive === !s.muted ? [] : [{ template: s.template, channel: s.channel, muted: !receive }];
  });
  if (changes.length === 0) return { status: "ok" };
  const result = await inboxService().setPreferences(ctx, { changes });
  if (result.ok) revalidatePath("/settings/notifications");
  return toActionState(result, form);
}
