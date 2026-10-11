import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { CaseListItem } from "@cdf/contracts";
import { formatDateTime, type MessageKey } from "@cdf/i18n";
import { CDFBadge, CDFPageHeader, CDFTable, classificationTone } from "@cdf/ui";
import { investigationService, myShellAreas, requireActor } from "@/server/container";
import { getTranslator } from "@/server/locale";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("cases.title") };
}

export default async function CasesPage() {
  const { ctx } = await requireActor();
  // No Cases area (no case relationship and no case-wide permission): the same 404 as an unknown page.
  if (!(await myShellAreas()).some((a) => a.area === "CASES")) notFound();
  const t = await getTranslator();
  // RLS decides what is listed; there is no client-side filtering of a broader result (§40).
  const cases = await investigationService().listCases(ctx);
  return (
    <>
      <CDFPageHeader title={t("cases.title")} intro={t("cases.intro")} />
      <CDFTable<CaseListItem>
        caption={t("cases.title")}
        testId="cases-table"
        rows={cases}
        rowKey={(c) => c.id}
        empty={t("cases.empty")}
        columns={[
          {
            header: t("cases.caseNumber"),
            cell: (c) => (
              <Link
                href={`/cases/${c.id}`}
                className="font-semibold underline underline-offset-4"
                dir="ltr"
                data-testid={`case-${c.caseNumber}`}
              >
                {c.caseNumber}
              </Link>
            ),
          },
          { header: t("cases.caseTitle"), cell: (c) => c.title },
          {
            header: t("cases.state"),
            cell: (c) => (t.locale === "ar" ? c.stateNameAr : c.stateNameEn) ?? "—",
          },
          {
            header: t("cases.priority"),
            cell: (c) => (c.priority ? t(`priority.${c.priority}` as MessageKey) : "—"),
          },
          {
            header: t("cases.classification"),
            cell: (c) => (
              <span className="flex flex-wrap gap-1">
                <CDFBadge tone={classificationTone(c.classification)}>
                  {t(`classification.${c.classification}` as MessageKey)}
                </CDFBadge>
                {c.isRestricted ? (
                  <CDFBadge tone="danger">{t("classification.restrictedCase")}</CDFBadge>
                ) : null}
              </span>
            ),
          },
          { header: t("cases.updatedAt"), cell: (c) => formatDateTime(t.locale, c.updatedAt) },
        ]}
      />
    </>
  );
}
