import type { NotificationChannel, NotificationSetting, NotificationTemplate } from "@cdf/contracts";

/** The settings checkbox for a template on a channel; ticked means "send me this" (not muted). */
export const receiveField = (template: NotificationTemplate, channel: NotificationChannel) =>
  `receive.${template}.${channel}`;

/**
 * Whether the settings page offers a checkbox for this setting: never for a mandatory notice, and not where the
 * platform-wide rule sends nothing (a ticked box would promise a notice that never comes) unless the caller muted
 * it earlier and may want it back. The save action reads exactly these, so a missing box never reads as "untick".
 */
export const hasChoice = (s: NotificationSetting) => !s.mandatory && (s.ruleDelivers || s.muted);
