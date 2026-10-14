// In-app notification commands (ADR-025, migration 1920; UX redesign S4). The database re-checks both: a
// notification that is not the caller's own answers NOT_FOUND, and a mandatory template cannot be muted.
import { z } from "zod";
import { NOTIFICATION_CHANNELS, NOTIFICATION_TEMPLATES } from "@cdf/contracts";

const uuid = z.uuid({ message: "validation.invalid" });

export const markNotificationReadSchema = z.object({ notificationId: uuid });

export const setNotificationPreferenceSchema = z.object({
  template: z.enum(NOTIFICATION_TEMPLATES, { message: "validation.invalid" }),
  channel: z.enum(NOTIFICATION_CHANNELS, { message: "validation.invalid" }),
  muted: z.boolean({ message: "validation.invalid" }),
});

/** A settings form saves only the choices that changed, at most one per template and channel. */
export const setNotificationPreferencesSchema = z.object({
  changes: z
    .array(setNotificationPreferenceSchema)
    .min(1, { message: "validation.required" })
    .max(NOTIFICATION_TEMPLATES.length * NOTIFICATION_CHANNELS.length, { message: "validation.invalid" })
    .refine((c) => new Set(c.map((x) => `${x.template}:${x.channel}`)).size === c.length, {
      message: "validation.invalid",
    }),
});
