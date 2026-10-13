// Notification settings «إعدادات الإشعارات» (UX redesign S4; ADR-025, migration 1920). The caller's own choices:
// mandatory notices are listed as always sent and have no control; each optional notice can be muted per channel.
// The rule shown is the platform-wide one; a committee's own default can differ for that committee, and the
// caller's choice still applies there. Email is a stub in the prototype (PRODUCTION_SUBSTITUTION_REQUIRED, ADR-025).
import type { Metadata } from "next";
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_TEMPLATES,
  type NotificationChannel,
  type NotificationSetting,
  type NotificationTemplate,
} from "@cdf/contracts";
import type { MessageKey, Translator } from "@cdf/i18n";
import { CDFCommandForm, CDFPageHeader, CDFTable } from "@cdf/ui";
import { inboxService, requireActor } from "@/server/container";
import { getTranslator } from "@/server/locale";
import { saveNotificationSettingsAction } from "../../notifications/actions";
import { hasChoice, receiveField } from "../../notifications/fields";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("notificationSettings.title") };
}

interface Row {
  template: NotificationTemplate;
  mandatory: boolean;
  byChannel: Partial<Record<NotificationChannel, NotificationSetting>>;
}

/** One row per template in the catalogue's order (grouped by domain), with its two channels. */
function rowsOf(settings: NotificationSetting[]): Row[] {
  const rows = new Map<NotificationTemplate, Row>();
  for (const s of settings) {
    const row = rows.get(s.template) ?? { template: s.template, mandatory: s.mandatory, byChannel: {} };
    row.byChannel[s.channel] = s;
    rows.set(s.template, row);
  }
  const order = (code: NotificationTemplate) => NOTIFICATION_TEMPLATES.indexOf(code);
  return [...rows.values()]
    .filter((r) => order(r.template) >= 0)
    .sort((a, b) => order(a.template) - order(b.template));
}

const kind = (t: Translator, template: NotificationTemplate) =>
  t(`notificationKind.${template}` as MessageKey);

/** A ticked box means "send me this"; where the page offers no box (hasChoice), the rule sends nothing. */
function ChannelChoice({ t, setting }: { t: Translator; setting: NotificationSetting | undefined }) {
  if (!setting) return null;
  if (!hasChoice(setting))
    return (
      <span
        className="text-sm text-cdf-text-secondary"
        data-testid={`off-${setting.template}-${setting.channel}`}
      >
        {t("notificationSettings.offByRule")}
      </span>
    );
  const id = receiveField(setting.template, setting.channel);
  return (
    <span className="flex items-center">
      <input
        type="checkbox"
        id={id}
        name={id}
        defaultChecked={!setting.muted}
        className="size-5"
        data-testid={`receive-${setting.template}-${setting.channel}`}
      />
      <label htmlFor={id} className="sr-only">
        {t("notificationSettings.receiveName", {
          what: kind(t, setting.template),
          channel: t(`notificationSettings.channel.${setting.channel}` as MessageKey),
        })}
      </label>
    </span>
  );
}

export default async function NotificationSettingsPage() {
  const { ctx } = await requireActor();
  const [t, settings] = await Promise.all([getTranslator(), inboxService().settings(ctx)]);
  const rows = rowsOf(settings);
  const mandatory = rows.filter((r) => r.mandatory);
  const optional = rows.filter((r) => !r.mandatory);
  const channelHeader = (c: NotificationChannel) =>
    t(c === "IN_APP" ? "notificationSettings.columns.inApp" : "notificationSettings.columns.email");

  return (
    <>
      <CDFPageHeader title={t("notificationSettings.title")} intro={t("notificationSettings.intro")} />
      <div className="grid gap-8">
        <section aria-labelledby="notifications-optional">
          <h2 id="notifications-optional" className="text-cdf-h2 font-semibold">
            {t("notificationSettings.optionalTitle")}
          </h2>
          <p className="mb-3 text-cdf-text-secondary">{t("notificationSettings.optionalIntro")}</p>
          <CDFCommandForm
            action={saveNotificationSettingsAction}
            locale={t.locale}
            submitLabel={t("notificationSettings.save")}
            successMessage={t("notificationSettings.saved")}
            testId="notification-settings-form"
          >
            <CDFTable
              caption={t("notificationSettings.tableLabel.optional")}
              testId="notification-settings-optional"
              rows={optional}
              rowKey={(r) => r.template}
              empty={t("notificationSettings.optionalIntro")}
              columns={[
                { header: t("notificationSettings.columns.kind"), cell: (r) => kind(t, r.template) },
                ...NOTIFICATION_CHANNELS.map((c) => ({
                  header: channelHeader(c),
                  cell: (r: Row) => <ChannelChoice t={t} setting={r.byChannel[c]} />,
                })),
              ]}
            />
            <p className="text-sm text-cdf-text-secondary">{t("notificationSettings.ruleNote")}</p>
          </CDFCommandForm>
        </section>
        <section aria-labelledby="notifications-mandatory">
          <h2 id="notifications-mandatory" className="text-cdf-h2 font-semibold">
            {t("notificationSettings.mandatoryTitle")}
          </h2>
          <p className="mb-3 text-cdf-text-secondary">{t("notificationSettings.mandatoryIntro")}</p>
          <ul
            aria-label={t("notificationSettings.tableLabel.mandatory")}
            data-testid="notification-settings-mandatory"
            className="grid list-disc gap-x-8 gap-y-1 ps-6 sm:grid-cols-2"
          >
            {mandatory.map((r) => (
              <li key={r.template}>{kind(t, r.template)}</li>
            ))}
          </ul>
        </section>
        <p className="text-sm text-cdf-text-secondary" data-testid="email-stub-note">
          {t("notificationSettings.emailNote")}
        </p>
      </div>
    </>
  );
}
