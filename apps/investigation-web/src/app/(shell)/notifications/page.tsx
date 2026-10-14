// Notifications «الإشعارات» (UX redesign S4; ADR-025, migration 1920; audit RC-06). The caller's own in-app notices,
// newest first. RLS returns only rows addressed to the caller; each row is a template code, ids and a link (N18), so
// the list names the kind of event and never any case content. A notice links to its page once that page has
// shipped; the page re-checks access in the database.
import type { Metadata } from "next";
import type { InboxNotification } from "@cdf/contracts";
import type { MessageKey } from "@cdf/i18n";
import {
  CDFCommandForm,
  CDFDateTime,
  CDFEmptyState,
  CDFPageHeader,
  CDFStatusBadge,
  CDFViewTabs,
  CDFWorkList,
  buttonClass,
} from "@cdf/ui";
import { INBOX_PAGE } from "@cdf/application";
import { inboxService, requireActor } from "@/server/container";
import { getTranslator } from "@/server/locale";
import { notificationHref } from "@/server/work-routes";
import { markNotificationReadAction } from "./actions";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("notifications.title") };
}

const VIEWS = ["all", "unread"] as const;
type View = (typeof VIEWS)[number];

export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { ctx } = await requireActor();
  const [t, all] = await Promise.all([getTranslator(), inboxService().list(ctx)]);
  const raw = (await searchParams).view;
  const view: View = VIEWS.includes(raw as View) ? (raw as View) : "all";
  const unread = all.filter((n) => n.readAt === null);
  const rows = view === "unread" ? unread : all;

  const row = (n: InboxNotification) => {
    const what = t(`notificationTemplate.${n.template}` as MessageKey);
    const href = notificationHref(n);
    return (
      <li
        key={n.id}
        data-testid={`notification-${n.id}`}
        data-read={n.readAt ? "true" : "false"}
        className="grid gap-2 rounded-cdf-md border border-cdf-border bg-cdf-surface p-3 sm:grid-cols-[1fr_auto] sm:items-start sm:gap-4"
      >
        <div className="grid gap-1">
          <p className={n.readAt ? "" : "font-semibold"}>{what}</p>
          <p className="flex flex-wrap items-center gap-2 text-sm text-cdf-text-secondary">
            <span>{t(`notificationKind.${n.template}` as MessageKey)}</span>
            <span aria-hidden="true">·</span>
            <CDFDateTime value={n.createdAt} locale={t.locale} />
            {n.readAt ? null : (
              <CDFStatusBadge domain="notification" status="UNREAD" testId={`notification-unread-${n.id}`}>
                {t("notifications.unread")}
              </CDFStatusBadge>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-start gap-2">
          {href ? (
            <a
              href={href}
              className={buttonClass("secondary")}
              aria-label={t("notifications.openName", { what })}
              data-testid={`notification-open-${n.id}`}
            >
              {t("notifications.open")}
            </a>
          ) : null}
          {n.readAt ? null : (
            <CDFCommandForm
              action={markNotificationReadAction}
              locale={t.locale}
              submitLabel={t("notifications.markRead")}
              submitName={t("notifications.markReadName", { what })}
              variant="secondary"
              testId={`notification-mark-read-${n.id}`}
            >
              <input type="hidden" name="notificationId" value={n.id} />
            </CDFCommandForm>
          )}
        </div>
      </li>
    );
  };

  return (
    <>
      <CDFPageHeader
        title={t("notifications.title")}
        intro={t("notifications.intro")}
        actions={
          <a
            href="/settings/notifications"
            className={buttonClass("secondary")}
            data-testid="notifications-settings"
          >
            {t("notifications.settingsLink")}
          </a>
        }
      />
      <CDFViewTabs
        label={t("notifications.views")}
        current={view}
        items={VIEWS.map((key) => ({
          key,
          href: key === "all" ? "/notifications" : `/notifications?view=${key}`,
          label: t(`notifications.view.${key}` as MessageKey),
          ...(key === "unread"
            ? { count: unread.length, countLabel: t("notifications.bellUnread", { count: unread.length }) }
            : {}),
        }))}
      />
      {rows.some((n) => notificationHref(n) === null) ? (
        <p className="mb-3 text-sm text-cdf-text-secondary" data-testid="notifications-page-later">
          {t("notifications.pageLater")}
        </p>
      ) : null}
      {rows.length === 0 ? (
        <CDFEmptyState
          title={t(`notifications.empty.${view}` as MessageKey)}
          body={t("notifications.emptyBody")}
          testId="notifications-empty"
        />
      ) : (
        <CDFWorkList label={t("notifications.listLabel")} testId={`notifications-${view}`}>
          {rows.map(row)}
        </CDFWorkList>
      )}
      {all.length >= INBOX_PAGE ? (
        <p className="mt-4 text-sm text-cdf-text-secondary">
          {t("notifications.showing", { count: INBOX_PAGE })}
        </p>
      ) : null}
    </>
  );
}
