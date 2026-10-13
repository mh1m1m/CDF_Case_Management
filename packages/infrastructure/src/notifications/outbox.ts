// NotificationOutbox over PostgreSQL (migration 1920). These functions are granted to the BFF login role only, so
// the calls run on the pool connection without assuming `authenticated` (ADR-025).
// PRODUCTION_SUBSTITUTION_REQUIRED: production runs delivery and reminders from a CDF-approved job service.
import type { NotificationOutbox } from "@cdf/application";
import type { NotificationTemplate, OutgoingNotification } from "@cdf/contracts";
import type { Sql } from "../db/security-context";

export class PostgresNotificationOutbox implements NotificationOutbox {
  constructor(private readonly sql: Sql) {}

  async claimEmailBatch(limit: number): Promise<OutgoingNotification[]> {
    const rows = await this.sql<
      { id: string; recipient_id: string; template_code: string; deep_link: string; attempts: number }[]
    >`select * from notify.claim_email_batch(${limit})`;
    return rows.map((r) => ({
      id: r.id,
      recipientId: r.recipient_id,
      template: r.template_code as NotificationTemplate,
      deepLink: r.deep_link,
      attempts: r.attempts,
    }));
  }

  async recordEmailDelivery(id: string, delivered: boolean): Promise<"SENT" | "FAILED" | "PENDING"> {
    const [r] = await this.sql<{ status: "SENT" | "FAILED" | "PENDING" }[]>`
      select notify.record_email_delivery(${id}, ${delivered}) as status`;
    return r!.status;
  }

  async emitDueReminders(): Promise<number> {
    const [r] = await this.sql<{ n: number }[]>`select notify.emit_due_reminders() as n`;
    return r!.n;
  }
}
