// Disposition certificate (CDF-71; ADR-013 D7). Readable by whoever may see the record's metadata (RLS on
// records.disposition_certificate); the hash is recomputed by api.verify_disposition_certificate on every view.
// PRODUCTION_SUBSTITUTION_REQUIRED: the hash is unsigned here; production signs it with an HSM key (CDF-38).
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { navigationFor } from "@cdf/authorization";
import { formatDateTime, type MessageKey } from "@cdf/i18n";
import { CDFAlert, CDFBadge, CDFCard, CDFDescriptionList, CDFPageHeader } from "@cdf/ui";
import { recordsService, requireActor } from "@/server/container";
import { getTranslator } from "@/server/locale";
import { AppNav } from "../../../app-nav";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("pageTitles.certificate") };
}

const UUID = /^[0-9a-f-]{36}$/i;

export default async function CertificatePage({ params }: { params: Promise<{ certificateId: string }> }) {
  const { certificateId } = await params;
  if (!UUID.test(certificateId)) notFound();
  const { actor, ctx } = await requireActor();
  const nav = navigationFor(actor);
  if (!nav.recordsCatalogue && !nav.myWork) notFound();
  const t = await getTranslator();
  const c = await recordsService().getCertificate(ctx, certificateId);
  if (!c) notFound();
  const at = (v: string) => formatDateTime(t.locale, v);

  return (
    <>
      <AppNav actor={actor} t={t} current="records" />
      <CDFPageHeader
        title={`${c.certificateNumber} · ${t("records.certificateTitle")}`}
        intro={t("records.certificateIntro")}
        actions={
          <Link
            href="/records"
            className="font-semibold underline underline-offset-4"
            data-testid="back-to-records"
          >
            {t("records.backToRecords")}
          </Link>
        }
      />
      <CDFCard title={t("records.certificateTitle")} testId="certificate-card">
        <CDFDescriptionList
          items={[
            { term: t("records.certificate.number"), value: <span dir="ltr">{c.certificateNumber}</span> },
            { term: t("records.certificate.caseNumber"), value: <span dir="ltr">{c.caseNumber}</span> },
            {
              term: t("records.certificate.retentionClass"),
              value: <span dir="ltr">{c.retentionClass}</span>,
            },
            {
              term: t("records.certificate.triggerEvent"),
              value: t.code("records.triggerEvent", c.triggerEvent, "common.none"),
            },
            { term: t("records.certificate.triggerAt"), value: at(c.triggerAt) },
            { term: t("records.certificate.retainUntil"), value: at(c.retainUntil) },
            { term: t("records.certificate.requestedAt"), value: at(c.requestedAt) },
            { term: t("records.certificate.approvedAt"), value: at(c.approvedAt) },
            { term: t("records.certificate.issuedAt"), value: at(c.issuedAt) },
            {
              term: t("records.certificate.action"),
              value: t.code("records.dispositionAction", c.dispositionAction, "common.none"),
            },
            {
              term: t("records.certificate.mode"),
              value: t(`records.executionMode.${c.executionMode}` as MessageKey),
            },
            { term: t("records.certificate.holdsFound"), value: String(c.activeHoldsFound) },
            { term: t("records.certificate.evidenceVersions"), value: String(c.evidenceVersions) },
            {
              term: t("records.certificate.hash"),
              value: (
                <code dir="ltr" className="break-all" data-testid="certificate-hash">
                  {c.certificateHash}
                </code>
              ),
            },
            {
              term: t("records.certificate.integrity"),
              value: (
                <CDFBadge tone={c.verified ? "success" : "danger"} testId="certificate-verified">
                  {t(c.verified ? "records.verified" : "records.notVerified")}
                </CDFBadge>
              ),
            },
          ]}
        />
        <div className="mt-4">
          <CDFAlert tone="info">{t("records.unsignedNote")}</CDFAlert>
        </div>
      </CDFCard>
    </>
  );
}
