import Link from "next/link";
import { notFound } from "next/navigation";
import { can } from "@cdf/authorization";
import type { IntakeReportItem } from "@cdf/contracts";
import { formatDateTime, type MessageKey } from "@cdf/i18n";
import { CDFBadge, CDFPageHeader, CDFTable, classificationTone } from "@cdf/ui";
import { investigationService, requireActor } from "@/server/container";
import { getTranslator } from "@/server/locale";
import { AppNav } from "../app-nav";

export default async function IntakePage() {
  const { actor, ctx } = await requireActor();
  if (!can(actor, "INTAKE_VIEW")) notFound();
  const t = await getTranslator();
  const reports = await investigationService().listIntakeReports(ctx);
  return (
    <>
      <AppNav actor={actor} t={t} current="intake" />
      <CDFPageHeader title={t("intake.title")} intro={t("intake.intro")} />
      <CDFTable<IntakeReportItem>
        caption={t("intake.title")}
        testId="intake-table"
        rows={reports}
        rowKey={(r) => r.id}
        empty={t("intake.empty")}
        columns={[
          {
            header: t("intake.reportRef"),
            cell: (r) => (
              <Link
                href={`/intake/${r.id}`}
                className="font-semibold underline underline-offset-4"
                dir="ltr"
                data-testid={`report-${r.reportRef}`}
              >
                {r.reportRef}
              </Link>
            ),
          },
          { header: t("intake.category"), cell: (r) => t(`category.${r.category}` as MessageKey) },
          {
            header: t("intake.reporterMode"),
            cell: (r) => t(`reporterMode.${r.reporterMode}` as MessageKey),
          },
          {
            header: t("intake.status"),
            cell: (r) => <CDFBadge tone="info">{t(`reportStatus.${r.status}` as MessageKey)}</CDFBadge>,
          },
          {
            header: t("intake.classification"),
            cell: (r) => (
              <CDFBadge tone={classificationTone(r.classification)}>
                {t(`classification.${r.classification}` as MessageKey)}
              </CDFBadge>
            ),
          },
          { header: t("intake.receivedAt"), cell: (r) => formatDateTime(t.locale, r.receivedAt) },
        ]}
      />
    </>
  );
}
