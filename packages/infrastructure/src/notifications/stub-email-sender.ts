// Email NotificationSender stub (ADR-025). It sends nothing: it keeps the last deliveries in memory for tests and
// local runs. PRODUCTION_SUBSTITUTION_REQUIRED: the CDF mail relay, with the recipient's address resolved from the
// corporate directory; choosing it is a human decision.
import type { NotificationSender } from "@cdf/application";
import type { OutgoingNotification } from "@cdf/contracts";

export class StubEmailSender implements NotificationSender {
  readonly kind = "stub-email" as const;
  readonly delivered: OutgoingNotification[] = [];

  async send(notification: OutgoingNotification): Promise<boolean> {
    this.delivered.push(notification);
    if (this.delivered.length > 100) this.delivered.shift();
    return true;
  }
}
