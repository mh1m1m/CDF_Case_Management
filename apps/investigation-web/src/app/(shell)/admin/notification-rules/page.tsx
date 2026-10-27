// Administration › Notification rules (UX redesign Phase 12 P12-8a and P12-8b; ADR-051's P12-8a amendment, ADR-063;
// ADR-025). The notification administrator's register: for each notice, whether it goes out in the app and by email,
// as notify.delivers decides it now (a mandatory rule always delivers; else a committee's own default, else the event
// rule; else nothing), and every rule recorded, with the changes that start later. Notices never carry case content
// (§39). Read in the administrator's own context after the database confirms NOTIFICATION_ADMIN; anyone else gets the
// uniform not-found, recorded as ACCESS_DENIED. One form, shown only where the database says api.set_notification_rule
// would accept the caller now (api.admin_notification_rule_capabilities, 2127): a notice on or off from a later date,
// platform-wide or as a committee's default. A mandatory notice is shown and never offered: it is always sent.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  NOTIFICATION_CHANNELS,
  SETTABLE_NOTIFICATION_LAYERS,
  type AdminCommittee,
  type AdminNotificationRule,
  type AdminNotificationRulesPage,
  type AdminNotificationTemplate,
  type NotificationChannel,
} from "@cdf/contracts";
import { isolate, type MessageKey, type Translator } from "@cdf/i18n";
import {
  CDFBadge,
  CDFCard,
  CDFCommandForm,
  CDFField,
  CDFFieldError,
  CDFTable,
  inputClass,
  textareaClass,
} from "@cdf/ui";
import { administrationService, requireActor } from "@/server/container";
import { getTranslator } from "@/server/locale";
import { confirmation } from "../../confirmations";
import { AdminFrame } from "../admin-frame";
import { ADMIN_CODES, period, personName, plusDays, stateLabel, stateTone } from "../labels";
import { setNotificationRuleAction } from "./actions";

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

/** A committee's name where the platform has one, else its code. */
function committeeName(t: Translator, c: AdminCommittee): string {
  const key = `committeeName.${c.code}`;
  const name = t(key as MessageKey);
  return name === key ? c.code : name;
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
    <AdminFrame t={t} views={page.views} view="notification-rules" intro={t("admin.notifications.intro")}>
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

      {page.capabilities.maySetRule ? <RuleForm t={t} page={page} templates={templates} /> : null}
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
    return c ? committeeName(t, c) : null;
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

/**
 * Record a rule from a later date: a notice that is not mandatory, sent or not sent on one channel, platform-wide or
 * as one committee's default. The rule of the same kind for that notice and channel ends where it starts; a rule of
 * that kind that starts on or after that date refuses it (LATER_RULE_EXISTS, F8).
 */
function RuleForm({
  t,
  page,
  templates,
}: {
  t: Translator;
  page: AdminNotificationRulesPage;
  templates: readonly AdminNotificationTemplate[];
}) {
  const id = "admin-notice-form";
  const radio = (name: string, value: string, label: string, checked = false) => (
    <div key={value} className="flex items-center gap-2">
      <input
        id={`${id}-${name}-${value}`}
        type="radio"
        name={name}
        value={value}
        defaultChecked={checked}
        className="size-5 shrink-0"
        data-testid={`${id}-${name}-${value}`}
      />
      <label htmlFor={`${id}-${name}-${value}`}>{label}</label>
    </div>
  );
  return (
    <CDFCard title={t("admin.notifications.formTitle")} testId="admin-notice-change">
      <p className="mb-3 text-sm text-cdf-text-secondary">{t("admin.notifications.formIntro")}</p>
      <CDFCommandForm
        action={setNotificationRuleAction}
        locale={t.locale}
        submitLabel={t("admin.notifications.record")}
        variant="primary"
        testId={id}
        successMessage={t("admin.notifications.recorded")}
        leaveWarning={t("common.leaveWarning")}
        codeSections={ADMIN_CODES}
        fieldLabels={{
          layer: t("admin.notifications.layerLabel"),
          templateCode: t("admin.notifications.notice"),
          committeeId: t("admin.notifications.committeeLabel"),
          channel: t("admin.notifications.channelLabel"),
          enabled: t("admin.notifications.setting"),
          effectiveFrom: t("admin.notifications.from"),
          reason: t("admin.calendar.reason"),
        }}
        confirm={confirmation(t, "setNotificationRule")}
      >
        <fieldset className="mb-4">
          <legend className="mb-1 font-semibold">
            {t("admin.notifications.layerLabel")}
            <span className="ms-2 text-sm font-normal text-cdf-text-secondary">({t("common.required")})</span>
          </legend>
          <div className="grid gap-2">
            {SETTABLE_NOTIFICATION_LAYERS.map((layer) =>
              radio(
                "layer",
                layer,
                t(`admin.notifications.layer.${layer}` as MessageKey),
                layer === "EVENT_RULE",
              ),
            )}
          </div>
          <CDFFieldError id={`${id}-layer-EVENT_RULE`} />
        </fieldset>
        <CDFField
          id={`${id}-template`}
          label={t("admin.notifications.notice")}
          hint={t("admin.notifications.noticeHint")}
          requiredLabel={t("common.required")}
        >
          <select
            id={`${id}-template`}
            name="templateCode"
            className={inputClass}
            defaultValue=""
            aria-describedby={`${id}-template-hint`}
            required
          >
            <option value="" disabled>
              {t("common.choose")}
            </option>
            {templates
              .filter((x) => !x.isMandatory)
              .map((x) => (
                <option key={x.code} value={x.code}>
                  {noticeName(t, x.code)}
                </option>
              ))}
          </select>
        </CDFField>
        <CDFField
          id={`${id}-committee`}
          label={t("admin.notifications.committeeLabel")}
          hint={t("admin.notifications.committeeHint")}
          optionalLabel={t("common.optional")}
        >
          <select
            id={`${id}-committee`}
            name="committeeId"
            className={inputClass}
            defaultValue=""
            aria-describedby={`${id}-committee-hint`}
          >
            <option value="">{t("admin.notifications.noCommittee")}</option>
            {page.committees.map((c) => (
              <option key={c.committeeId} value={c.committeeId}>
                {committeeName(t, c)}
              </option>
            ))}
          </select>
        </CDFField>
        <fieldset className="mb-4">
          <legend className="mb-1 font-semibold">
            {t("admin.notifications.channelLabel")}
            <span className="ms-2 text-sm font-normal text-cdf-text-secondary">({t("common.required")})</span>
          </legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {NOTIFICATION_CHANNELS.map((channel) =>
              radio("channel", channel, t(`admin.notifications.channel.${channel}` as MessageKey)),
            )}
          </div>
          <CDFFieldError id={`${id}-channel-${NOTIFICATION_CHANNELS[0]}`} />
        </fieldset>
        <fieldset className="mb-4">
          <legend className="mb-1 font-semibold">
            {t("admin.notifications.setting")}
            <span className="ms-2 text-sm font-normal text-cdf-text-secondary">({t("common.required")})</span>
          </legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {radio("enabled", "on", t("admin.notifications.value.ON"))}
            {radio("enabled", "off", t("admin.notifications.value.OFF"))}
          </div>
          <CDFFieldError id={`${id}-enabled-on`} />
        </fieldset>
        <CDFField
          id={`${id}-from`}
          label={t("admin.notifications.from")}
          hint={t("admin.notifications.fromHint")}
          requiredLabel={t("common.required")}
        >
          <input
            id={`${id}-from`}
            name="effectiveFrom"
            type="date"
            className={inputClass}
            min={plusDays(page.today, 1)}
            aria-describedby={`${id}-from-hint`}
            required
          />
        </CDFField>
        <CDFField
          id={`${id}-reason`}
          label={t("admin.calendar.reason")}
          hint={t("admin.calendar.reasonHint")}
          requiredLabel={t("common.required")}
        >
          <textarea
            id={`${id}-reason`}
            name="reason"
            className={textareaClass}
            aria-describedby={`${id}-reason-hint`}
            minLength={5}
            maxLength={2000}
            required
          />
        </CDFField>
      </CDFCommandForm>
    </CDFCard>
  );
}
