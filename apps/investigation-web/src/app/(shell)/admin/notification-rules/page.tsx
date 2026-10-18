// Administration › Notification rules (UX redesign Phase 12 P12-8a; ADR-051's P12-8a amendment; ADR-025). The
// notification administrator's register: for each notice, whether it goes out in the app and by email, as
// notify.delivers decides it now (a mandatory rule always delivers; else a committee's own default, else the event
// rule; else nothing), and every rule recorded, with the changes that start later. Notices never carry case content
// (§39). Read in the administrator's own context after the database confirms NOTIFICATION_ADMIN; anyone else gets the
// uniform not-found, recorded as ACCESS_DENIED. Read only: changing a rule is a later slice (coordinator ruling F8).
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  NOTIFICATION_CHANNELS,
  type AdminNotificationRule,
  type AdminNotificationRulesPage,
  type AdminNotificationTemplate,
  type NotificationChannel,
} from "@cdf/contracts";
import { isolate, type MessageKey, type Translator } from "@cdf/i18n";
import { CDFBadge, CDFCard, CDFTable } from "@cdf/ui";
import { administrationService, requireActor } from "@/server/container";
import { getTranslator } from "@/server/locale";
import { AdminFrame } from "../admin-frame";
import { period, personName, stateLabel, stateTone } from "../labels";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("admin.views.notification-rules") };
}

/** The notice's short name, else its code. */
function noticeName(t: Translator, code: string): string {
  const key = `notificationKind.${code}`;
  const name = t(key as MessageKey);
  return name === key ? code : name;
}

/** What the platform rules do for a notice on a channel now, before anyone's own mute: notify.delivers' order. */
function inForce(
  rules: readonly AdminNotificationRule[],
  template: AdminNotificationTemplate,
  channel: NotificationChannel,
): "ALWAYS" | "ON" | "OFF" | "NO_RULE" {
  const now = rules.filter(
    (r) =>
      r.template === template.code &&
      r.channel === channel &&
      r.state === "IN_FORCE" &&
      r.committeeId === null,
  );
  if (now.some((r) => r.layer === "SYSTEM_MANDATORY")) return "ALWAYS";
  const event = now.find((r) => r.layer === "EVENT_RULE");
  if (!event) return "NO_RULE";
  return event.enabled ? "ON" : "OFF";
}

export default async function AdminNotificationRulesRegister() {
  const { actor, ctx } = await requireActor();
  const page = await administrationService().notificationRules(ctx, actor);
  if (!page) notFound();
  const t = await getTranslator();
  // Mandatory notices first, then by name in the reader's language.
  const templates = [...page.templates].sort(
    (a, b) =>
      Number(b.isMandatory) - Number(a.isMandatory) ||
      noticeName(t, a.code).localeCompare(noticeName(t, b.code), t.locale),
  );
  const later = page.rules.filter((r) => r.state === "SCHEDULED");
  const committeeDefaults = page.rules.filter((r) => r.layer === "COMMITTEE_DEFAULT" && r.state !== "ENDED");
  const ended = page.rules.filter((r) => r.state === "ENDED");
  return (
    <AdminFrame t={t} actor={actor} view="notification-rules" intro={t("admin.notifications.intro")}>
      <CDFCard title={t("admin.notifications.nowTitle")} testId="admin-notices">
        <p className="mb-3 text-sm text-cdf-text-secondary">{t("admin.notifications.nowIntro")}</p>
        <CDFTable
          caption={t("admin.notifications.nowTitle")}
          testId="admin-notice-list"
          rows={templates}
          rowKey={(x) => x.code}
          empty={t("admin.notifications.noTemplates")}
          columns={[
            {
              header: t("admin.notifications.notice"),
              cell: (x) => (
                <span data-testid={`admin-notice-${x.code}`}>
                  {noticeName(t, x.code)}
                  {x.isMandatory ? (
                    <>
                      {" "}
                      <CDFBadge tone="info">{t("admin.notifications.mandatory")}</CDFBadge>
                    </>
                  ) : null}
                </span>
              ),
            },
            ...NOTIFICATION_CHANNELS.map((channel) => ({
              header: t(`admin.notifications.channel.${channel}` as MessageKey),
              cell: (x: AdminNotificationTemplate) => {
                const value = inForce(page.rules, x, channel);
                return (
                  <span data-testid={`admin-notice-${x.code}-${channel}`} data-value={value}>
                    {t(`admin.notifications.value.${value}` as MessageKey)}
                  </span>
                );
              },
            })),
          ]}
        />
      </CDFCard>

      <CDFCard title={t("admin.notifications.laterTitle")} testId="admin-notice-changes">
        <RuleList
          t={t}
          page={page}
          rules={later}
          caption={t("admin.notifications.laterTitle")}
          empty={t("admin.notifications.noChanges")}
          me={actor.userId}
        />
      </CDFCard>

      <CDFCard title={t("admin.notifications.committeeTitle")} testId="admin-notice-committee-defaults">
        <p className="mb-3 text-sm text-cdf-text-secondary">{t("admin.notifications.committeeIntro")}</p>
        <RuleList
          t={t}
          page={page}
          rules={committeeDefaults}
          caption={t("admin.notifications.committeeTitle")}
          empty={t("admin.notifications.noCommitteeDefaults")}
          me={actor.userId}
        />
      </CDFCard>

      {ended.length > 0 ? (
        <details className="mb-6" data-testid="admin-notice-ended">
          <summary className="cursor-pointer font-semibold">
            {t("admin.notifications.endedRules", { count: ended.length })}
          </summary>
          <div className="mt-3">
            <RuleList
              t={t}
              page={page}
              rules={ended}
              caption={t("admin.notifications.endedCaption")}
              empty=""
              me={actor.userId}
            />
          </div>
        </details>
      ) : null}

      <p className="text-sm text-cdf-text-secondary" data-testid="admin-notifications-later">
        {t("admin.notifications.later")}
      </p>
    </AdminFrame>
  );
}

/** Recorded rules as a table: which notice, channel, layer, on or off, when, and who set it. */
function RuleList({
  t,
  page,
  rules,
  caption,
  empty,
  me,
}: {
  t: Translator;
  page: AdminNotificationRulesPage;
  rules: AdminNotificationRule[];
  caption: string;
  empty: string;
  me: string;
}) {
  const committee = (id: string | null) => {
    const c = page.committees.find((x) => x.committeeId === id);
    if (!c) return null;
    const key = `committeeName.${c.code}`;
    const name = t(key as MessageKey);
    return name === key ? c.code : name;
  };
  return (
    <CDFTable
      caption={caption}
      rows={rules}
      rowKey={(r) => r.ruleId}
      empty={empty}
      columns={[
        {
          header: t("admin.notifications.notice"),
          cell: (r) => (
            <>
              {noticeName(t, r.template)}
              {r.committeeId ? (
                <p className="text-sm text-cdf-text-secondary">
                  <bdi>{committee(r.committeeId) ?? t("admin.notifications.aCommittee")}</bdi>
                </p>
              ) : null}
            </>
          ),
        },
        {
          header: t("admin.notifications.channelLabel"),
          cell: (r) => t(`admin.notifications.channel.${r.channel}` as MessageKey),
        },
        {
          header: t("admin.notifications.layerLabel"),
          cell: (r) => t(`admin.notifications.layer.${r.layer}` as MessageKey),
        },
        {
          header: t("admin.notifications.setting"),
          cell: (r) => t(r.enabled ? "admin.notifications.value.ON" : "admin.notifications.value.OFF"),
        },
        { header: t("admin.columns.period"), cell: (r) => period(t, r.effectiveFrom, r.effectiveTo) },
        {
          header: t("admin.columns.state"),
          cell: (r) => <CDFBadge tone={stateTone(r.state)}>{stateLabel(t, r.state)}</CDFBadge>,
        },
        {
          header: t("admin.columns.recorded"),
          cell: (r) =>
            r.createdBy
              ? t("admin.recordedByOnly", { name: isolate(personName(t, page.people, r.createdBy, me)) })
              : t("admin.notifications.fromMigrations"),
        },
      ]}
    />
  );
}
