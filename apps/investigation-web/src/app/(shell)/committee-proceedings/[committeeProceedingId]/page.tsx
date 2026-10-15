// The proceeding before the committee (UX redesign Phase 12 P12-2c; ADR-056; DEC-02, DEC-22, UX-116): a purpose route
// that reads the seat basis (api.my_committees and api.committee_view), the packages and finding votes (R2) and, for
// whoever builds packages now, the choices (R1) and the sanction catalogue. It never reads the case. Without a current
// seat that gives the proceeding it is the same 404 as an id that names nothing, and the refusal is recorded
// (ACCESS_DENIED): the case team, who see a proceeding through the case, a platform administrator and a committee role
// without a seat all get it. A subject is a position and a category, never a name in ORDINAL mode (the DEC-02 label
// card). Each form shows only where its command would accept the caller now (2086), and every command checks again.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { formatDate, isolate, type MessageKey } from "@cdf/i18n";
import { CDFAlert, CDFBreadcrumbs, CDFCard, CDFPageHeader, CDFPurposeBanner, CDFStatusBadge } from "@cdf/ui";
import { committeeProceedingsService, requireActor } from "@/server/container";
import { getTranslator } from "@/server/locale";
import { proceedingLabel } from "../../committees/proceeding-label";
import { FindingVotes } from "./finding-votes";
import { CreatePackageForm, PackageCard } from "./packages";

/** Unique translated title (WCAG 2.4.2, UX-082); never a case number or committee content. */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("pageTitles.committeeProceeding") };
}

const UUID = /^[0-9a-f-]{36}$/i;

export default async function CommitteeProceedingPage({
  params,
}: {
  params: Promise<{ committeeProceedingId: string }>;
}) {
  const { committeeProceedingId } = await params;
  if (!UUID.test(committeeProceedingId)) notFound();
  const { ctx } = await requireActor();
  const t = await getTranslator();
  const v = await committeeProceedingsService().proceeding(ctx, committeeProceedingId);
  if (!v) notFound();

  const p = v.proceeding;
  const committee = t.code("committeeName", v.committee.code, "common.none");
  const label = proceedingLabel(t, v.committee.code, p);
  const items = v.items;
  const meetingNo = new Map(p.meetings.map((m) => [m.meetingId, m.sequenceNo] as const));
  const date = (iso: string) => isolate(formatDate(t.locale, iso));

  return (
    <>
      <CDFBreadcrumbs
        label={t("shell.breadcrumb")}
        items={[
          { label: t("shell.area.COMMITTEE"), href: "/committees" },
          { label: committee, href: `/committees/${v.committee.committeeId}` },
          { label },
        ]}
      />
      <CDFPageHeader
        title={label}
        actions={
          <CDFStatusBadge domain="proceeding" status={p.status} testId="proceeding-status">
            {t(`proceedingStatus.${p.status}` as MessageKey)}
          </CDFStatusBadge>
        }
      />
      <CDFPurposeBanner
        title={t("committeeProceedings.purposeTitle")}
        purpose={t("committeeProceedings.purposeBody", { committee })}
        notShown={
          p.case.caseNumber
            ? t("committeeProceedings.purposeNotShown")
            : `${t("committees.refNote")} ${t("committeeProceedings.purposeNotShown")}`
        }
        testId="proceeding-purpose-banner"
      />
      <p className="mb-4 text-sm" data-testid="proceeding-dates">
        {t("committees.referredOn", { date: date(p.referredAt) })}
        {p.closedAt ? ` ${t("committees.closedOn", { date: date(p.closedAt) })}` : null}
      </p>

      {items === null ? (
        // R2 shows no package to a seat holder who declared a conflict in one of the proceeding's meetings, nor to
        // anyone once the proceeding is closed (2060); the page says so without saying why.
        <CDFAlert
          tone="info"
          title={t("committeeProceedings.notShownTitle")}
          testId="proceeding-items-hidden"
        >
          <p>{t("committeeProceedings.notShownBody")}</p>
        </CDFAlert>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
          <section className="min-w-0" aria-labelledby="proceeding-packages-heading">
            <h2 id="proceeding-packages-heading" className="mb-3 text-lg font-semibold">
              {t("committeeProceedings.packagesTitle")}
            </h2>
            {items.labelMode === "ORDINAL" ? (
              <p className="mb-3 text-sm text-cdf-text-secondary" data-testid="proceeding-ordinal-note">
                {t("committeeProceedings.ordinalNote")}
              </p>
            ) : null}
            {items.packages.length === 0 ? (
              <p className="mb-3 text-cdf-text-secondary" data-testid="proceeding-no-packages">
                {t("committeeProceedings.noPackages")}
              </p>
            ) : null}
            {items.packages.map((pkg) => (
              <PackageCard
                key={pkg.packageId}
                t={t}
                committeeProceedingId={p.committeeProceedingId}
                pkg={pkg}
                scope={v.scope}
                catalogue={v.catalogue}
                meetingNo={meetingNo}
                packetHref={(packetId) =>
                  `/committee-proceedings/${p.committeeProceedingId}/packets/${packetId}`
                }
              />
            ))}
            {items.capabilities.mayCreatePackage ? (
              <CreatePackageForm t={t} committeeProceedingId={p.committeeProceedingId} label={label} />
            ) : null}
          </section>
          <div className="min-w-0">
            <FindingVotes t={t} votes={items.findingVotes} meetingNo={meetingNo} />
            <CDFCard title={t("committeeProceedings.nextTitle")} testId="proceeding-next">
              <p className="text-sm">{t("committeeProceedings.nextBody")}</p>
            </CDFCard>
          </div>
        </div>
      )}
    </>
  );
}
