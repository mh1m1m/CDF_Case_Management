// InboxGateway over PostgreSQL (UX redesign S4; ADR-025, migration 1920). Reads are RLS SELECTs on notify.*: the
// outbox policy returns only the caller's own in-app rows and the preference policy only their own mutes; the
// template catalogue and the rules are readable by any signed-in user and hold no content. Writes only call the
// api.* notification commands. Every method runs in its own transaction under the caller's security context.
import type {
  InboxNotification,
  NotificationChannel,
  NotificationSetting,
  NotificationTemplate,
} from "@cdf/contracts";
import type { InboxGateway, UserRequestContext } from "@cdf/application";
import { withUserContext, type Sql, type Tx } from "./security-context";

export class PostgresInboxGateway implements InboxGateway {
  constructor(private readonly sql: Sql) {}

  private run<T>(ctx: UserRequestContext, fn: (tx: Tx) => Promise<T>) {
    return withUserContext(this.sql, ctx, fn);
  }

  list(ctx: UserRequestContext, limit: number): Promise<InboxNotification[]> {
    return this.run(ctx, async (tx) => {
      const rows = await tx<
        (Omit<InboxNotification, "createdAt" | "readAt"> & { createdAt: Date; readAt: Date | null })[]
      >`
        select id, template_code as template, object_type as "objectType", deep_link as "deepLink",
               created_at as "createdAt", read_at as "readAt"
        from notify.outbox where channel = 'IN_APP'
        order by created_at desc, id limit ${limit}`;
      return rows.map((r) => ({
        ...r,
        createdAt: new Date(r.createdAt).toISOString(),
        readAt: r.readAt ? new Date(r.readAt).toISOString() : null,
      }));
    });
  }

  unreadCount(ctx: UserRequestContext): Promise<number> {
    return this.run(ctx, async (tx) => {
      const [row] = await tx<{ n: number }[]>`
        select count(*)::int as n from notify.outbox where channel = 'IN_APP' and read_at is null`;
      return row!.n;
    });
  }

  settings(ctx: UserRequestContext): Promise<NotificationSetting[]> {
    // The platform-wide layers of notify.delivers: a mandatory rule always delivers, otherwise the event rule in
    // force decides. A committee's own default (COMMITTEE_DEFAULT) can differ for that committee only.
    return this.run(ctx, (tx) =>
      tx<
        {
          template: NotificationTemplate;
          channel: NotificationChannel;
          mandatory: boolean;
          ruleDelivers: boolean;
          muted: boolean;
        }[]
      >`
        with active as (
          select r.template_code, r.channel, r.layer, r.enabled, r.effective_from from notify.rule r
          where r.layer in ('SYSTEM_MANDATORY', 'EVENT_RULE')
            and r.effective_from <= now() and (r.effective_to is null or r.effective_to > now())
        )
        select t.code as template, c.channel, t.is_mandatory as mandatory,
               exists (select 1 from active a where a.template_code = t.code and a.channel = c.channel
                         and a.layer = 'SYSTEM_MANDATORY')
               or coalesce((select a.enabled from active a
                            where a.template_code = t.code and a.channel = c.channel and a.layer = 'EVENT_RULE'
                            order by a.effective_from desc limit 1), false) as "ruleDelivers",
               coalesce((select p.muted from notify.preference p
                         where p.template_code = t.code and p.channel = c.channel), false) as muted
        from notify.template t cross join (values ('IN_APP'), ('EMAIL')) c (channel)
        order by t.code collate "C", c.channel collate "C"`.then((r) => [...r]),
    );
  }

  markRead(ctx: UserRequestContext, notificationId: string): Promise<void> {
    return this.run(ctx, async (tx) => {
      await tx`select api.mark_notification_read(${notificationId})`;
    });
  }

  setPreferences(
    ctx: UserRequestContext,
    changes: { template: NotificationTemplate; channel: NotificationChannel; muted: boolean }[],
  ): Promise<void> {
    return this.run(ctx, async (tx) => {
      for (const c of changes) {
        await tx`select api.set_notification_preference(${c.template}, ${c.channel}, ${c.muted})`;
      }
    });
  }
}
