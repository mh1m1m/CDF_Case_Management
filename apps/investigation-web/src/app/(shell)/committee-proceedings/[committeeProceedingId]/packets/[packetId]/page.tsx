// A packet of one of the proceeding's packages (UX redesign Phase 12 P12-3a; ADR-057; DEC-19): what the committee's
// secretary sent to a legal reviewer, or submitted to the authority, as it was then. The page starts from the seat
// basis and R2: only a packet R2 names to the caller opens (a request's packet, or a round as submitted), and only
// through api.open_packet, the audited read (PACKET_VIEWED), which checks again. Anything else is the same 404 as a
// packet that does not exist.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { MessageKey } from "@cdf/i18n";
import { CDFBreadcrumbs, CDFPageHeader, CDFPurposeBanner } from "@cdf/ui";
import { committeeProceedingsService, legalReviewsService, requireActor } from "@/server/container";
import { getTranslator } from "@/server/locale";
import { proceedingLabel } from "../../../../committees/proceeding-label";
import { PacketContent } from "../../../../legal-reviews/packet-view";

/** Unique translated title (WCAG 2.4.2, UX-082); never a case number or committee content. */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("pageTitles.committeePacket") };
}

const UUID = /^[0-9a-f-]{36}$/i;

export default async function CommitteePacketPage({
  params,
}: {
  params: Promise<{ committeeProceedingId: string; packetId: string }>;
}) {
  const { committeeProceedingId, packetId } = await params;
  if (!UUID.test(committeeProceedingId) || !UUID.test(packetId)) notFound();
  const { ctx } = await requireActor();
  const t = await getTranslator();
  const v = await committeeProceedingsService().onSeat(ctx, committeeProceedingId);
  const pkg = v?.items.packages.find(
    (p) =>
      p.legalReview.requests.some((r) => r.packetId === packetId) ||
      p.authority.submissions.some((s) => s.packetId === packetId),
  );
  if (!v || !pkg) notFound();
  const packet = await legalReviewsService().packet(ctx, packetId);
  if (!packet) notFound();

  const committee = t.code("committeeName", v.committee.code, "common.none");
  const label = proceedingLabel(t, v.committee.code, v.proceeding);
  const proceedingHref = `/committee-proceedings/${committeeProceedingId}`;
  return (
    <>
      <CDFBreadcrumbs
        label={t("shell.breadcrumb")}
        items={[
          { label: t("shell.area.COMMITTEE"), href: "/committees" },
          { label: committee, href: `/committees/${v.committee.committeeId}` },
          { label, href: proceedingHref },
          { label: t("legalReviews.packetBreadcrumb") },
        ]}
      />
      <CDFPageHeader
        title={t("legalReviews.packetOf", {
          n: pkg.sequenceNo,
          what: t(`legalReviews.packet.purpose.${packet.purpose}` as MessageKey),
        })}
        actions={
          <Link
            href={proceedingHref}
            className="font-semibold underline underline-offset-4"
            data-testid="packet-back"
          >
            {t("legalReviews.backToProceeding")}
          </Link>
        }
      />
      <CDFPurposeBanner
        title={t("legalReviews.packetViewPurposeTitle")}
        purpose={t("legalReviews.packetViewPurposeBody")}
        notShown={t("legalReviews.packetPurposeNotShown")}
        testId="packet-purpose-banner"
      />
      <PacketContent t={t} packet={packet} />
    </>
  );
}
