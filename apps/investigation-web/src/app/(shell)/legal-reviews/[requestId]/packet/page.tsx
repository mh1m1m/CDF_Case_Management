// The packet of a legal review assigned to the caller (UX redesign Phase 12 P12-3a; ADR-057; DEC-19): L1 first, then
// the packet it names, through api.open_packet, the audited read (PACKET_VIEWED). Only the request's reviewer, while
// the packet is theirs to read, gets it: anyone else, a cancelled request and an id that names nothing get the same 404
// as the request's page, and the refusal is recorded (ACCESS_DENIED).
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CDFBreadcrumbs, CDFPageHeader, CDFPurposeBanner } from "@cdf/ui";
import { legalReviewsService, requireActor } from "@/server/container";
import { getTranslator } from "@/server/locale";
import { PacketContent } from "../../packet-view";

/** Unique translated title (WCAG 2.4.2, UX-082); never a case number or committee content. */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("pageTitles.legalReviewPacket") };
}

const UUID = /^[0-9a-f-]{36}$/i;

export default async function LegalReviewPacketPage({ params }: { params: Promise<{ requestId: string }> }) {
  const { requestId } = await params;
  if (!UUID.test(requestId)) notFound();
  const { ctx } = await requireActor();
  const t = await getTranslator();
  const found = await legalReviewsService().reviewPacket(ctx, requestId);
  if (!found) notFound();
  const reviewHref = `/legal-reviews/${requestId}`;

  return (
    <>
      <CDFBreadcrumbs
        label={t("shell.breadcrumb")}
        items={[
          { label: t("shell.area.MY_WORK"), href: "/my-work" },
          { label: t("legalReviews.breadcrumb"), href: reviewHref },
          { label: t("legalReviews.packetBreadcrumb") },
        ]}
      />
      <CDFPageHeader
        title={t("legalReviews.packetTitle")}
        actions={
          <Link
            href={reviewHref}
            className="font-semibold underline underline-offset-4"
            data-testid="packet-back"
          >
            {t("legalReviews.backToReview")}
          </Link>
        }
      />
      <CDFPurposeBanner
        title={t("legalReviews.packetPurposeTitle")}
        purpose={t("legalReviews.packetPurposeBody")}
        notShown={t("legalReviews.packetPurposeNotShown")}
        testId="packet-purpose-banner"
      />
      <PacketContent t={t} packet={found.packet} />
    </>
  );
}
