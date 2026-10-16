// A packet of one of the case's recommendation packages, from the case (UX redesign Phase 12 P12-3a; ADR-057; DEC-19):
// what the committee's secretary sent to a legal reviewer, or submitted to the authority, as it was then. Only a packet
// R2 names to the case team opens (a request's packet, or a round as submitted), and only through api.open_packet,
// the audited read (PACKET_VIEWED), which checks again. Anything else is the same 404 as a packet that does not exist.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { MessageKey } from "@cdf/i18n";
import { CDFPurposeBanner } from "@cdf/ui";
import { caseStructureService, legalReviewsService } from "@/server/container";
import { getTranslator } from "@/server/locale";
import { PacketContent } from "../../../../../legal-reviews/packet-view";
import { CaseWorkspace, loadCase } from "../../../workspace";
import { findCasePackage } from "../../case-packages";

/** Unique translated title (WCAG 2.4.2, UX-082); never a case number or committee content. */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("pageTitles.casePacket") };
}

const UUID = /^[0-9a-f-]{36}$/i;

export default async function CasePacketPage({
  params,
}: {
  params: Promise<{ id: string; packetId: string }>;
}) {
  const { id, packetId } = await params;
  if (!UUID.test(packetId)) notFound();
  const { actor, ctx, t, c } = await loadCase(id);
  const s = await caseStructureService().structure(ctx, id);
  const found = await findCasePackage(
    ctx,
    s,
    (p) =>
      p.legalReview.requests.some((r) => r.packetId === packetId) ||
      p.authority.submissions.some((x) => x.packetId === packetId),
  );
  if (!found) notFound();
  const packet = await legalReviewsService().packet(ctx, packetId);
  if (!packet) notFound();

  return (
    <CaseWorkspace c={c} actor={actor} t={t} tab="proceedings" item={t("legalReviews.packetBreadcrumb")}>
      <h2 className="mb-3 text-cdf-h2 font-semibold">
        {t("legalReviews.packetOf", {
          n: found.pkg.sequenceNo,
          what: t(`legalReviews.packet.purpose.${packet.purpose}` as MessageKey),
        })}
      </h2>
      <CDFPurposeBanner
        title={t("legalReviews.packetViewPurposeTitle")}
        purpose={t("legalReviews.packetViewPurposeBody")}
        notShown={t("legalReviews.packetPurposeNotShown")}
        testId="packet-purpose-banner"
      />
      <PacketContent t={t} packet={packet} />
      <p>
        <Link
          href={`/cases/${c.id}/proceedings`}
          className="underline underline-offset-4"
          data-testid="packet-back"
        >
          {t("legalReviews.backToProceedings")}
        </Link>
      </p>
    </CaseWorkspace>
  );
}
