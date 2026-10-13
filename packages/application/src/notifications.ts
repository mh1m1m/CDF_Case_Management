/**
 * Notification delivery (ADR-025). Notifications are queued by the database with their domain event; this service
 * only moves pending email rows through the NotificationSender and composes their text from fixed template wording
 * and a link. Nothing here ever reads case content (§39, N18).
 */
import type { NotificationTemplate, OutgoingNotification } from "@cdf/contracts";
import type { NotificationOutbox, NotificationSender } from "./ports";

export interface NotificationDeps {
  outbox: NotificationOutbox;
  sender: NotificationSender;
}

export interface DispatchResult {
  sent: number;
  failed: number;
  retrying: number;
}

export interface NotificationService {
  dispatchEmail(limit?: number): Promise<DispatchResult>;
  emitDueReminders(): Promise<number>;
}

export function createNotificationService(deps: NotificationDeps): NotificationService {
  return {
    async dispatchEmail(limit = 50) {
      const result: DispatchResult = { sent: 0, failed: 0, retrying: 0 };
      for (const n of await deps.outbox.claimEmailBatch(limit)) {
        let delivered = false;
        try {
          delivered = await deps.sender.send(n);
        } catch {
          delivered = false; // the error itself is never logged: it may echo the address
        }
        const status = await deps.outbox.recordEmailDelivery(n.id, delivered);
        if (status === "SENT") result.sent += 1;
        else if (status === "FAILED") result.failed += 1;
        else result.retrying += 1;
      }
      return result;
    },
    emitDueReminders: () => deps.outbox.emitDueReminders(),
  };
}

const DEEP_LINK = /^(\/[a-z0-9-]+)+$/;

/**
 * The email text: the template's fixed wording and an absolute link, nothing else. `wording` comes from
 * packages/i18n (`notificationTemplate`); `baseUrl` is the investigations app's origin.
 */
export function composeNotificationEmail(
  notification: Pick<OutgoingNotification, "template" | "deepLink">,
  wording: Record<NotificationTemplate, string>,
  baseUrl: string,
): { subject: string; body: string } {
  if (!DEEP_LINK.test(notification.deepLink)) throw new Error("invalid notification link");
  const origin = new URL(baseUrl).origin;
  const subject = wording[notification.template];
  return { subject, body: `${subject}\n\n${origin}${notification.deepLink}` };
}
