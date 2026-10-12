import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { can } from "@cdf/authorization";
import type { IntakeReportItem } from "@cdf/contracts";
import { formatDateTime, type MessageKey } from "@cdf/i18n";
import { CDFAlert, CDFBadge, CDFPageHeader, CDFTable, classificationTone } from "@cdf/ui";
import { investigationService, requireActor } from "@/server/container";
import { getTranslator } from "@/server/locale";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("intake.title") };
}

export default async function IntakePage({
  searchParams,
}: {
  searchParams: Promise<{ handedOver?: string }>;
}) {
  const { handedOver } = await searchParams;
  const { actor, ctx } = await requireActor();
  if (!can(actor, "INTAKE_VIEW")) notFound();
  const t = await getTranslator();
  const reports = await investigationService().listIntakeReports(ctx);
  return (
    <>
      <CDFPageHeader title={t("intake.title")} intro={t("intake.intro")} />
      {handedOver === "1" ? (
        // Carries no case or report data: only that the caller's own restricted creation succeeded (DEC-01).
        <div role="status" className="mb-4">
          <CDFAlert tone="success" testId="restricted-created">
            {t("intake.restrictedCreated")}
          </CDFAlert>
        </div>
      ) : null}
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
