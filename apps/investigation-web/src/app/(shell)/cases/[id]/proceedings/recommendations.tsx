// The committee's recommendation packages, from the case (UX redesign Phase 12 P12-3a; ADR-057): R2 as the case team
// reads it, every capability false, with each package's legal review and the authority's decision; the packets R2
// names open under the case. The committee works on its packages on its own pages, so nothing here is a form. The one
// act from the case is the restricted case's authority approving a legal review of an adopted package (DEC-62,
// DEC-F20): a link to a page of the case's own, which asks the database first (api.legal_review_choices).
import Link from "next/link";
import type { CaseDetail, CommitteeProceedingView } from "@cdf/contracts";
import { formatDate, type Translator } from "@cdf/i18n";
import { committeeProceedingsService, type RequestScope } from "@/server/container";
import { PackageCard } from "../../../committee-proceedings/[committeeProceedingId]/packages";

const NO_MEETINGS: ReadonlyMap<string, number> = new Map();

export async function CaseRecommendations({
  t,
  ctx,
  c,
  actorId,
  cp,
  committee,
  k,
  number,
}: {
  t: Translator;
  ctx: RequestScope["ctx"];
  c: CaseDetail;
  actorId: string;
  cp: CommitteeProceedingView;
  committee: string;
  /** The proceeding's sequence number on the case, for test ids, and its display number. */
  k: number;
  number: string;
}) {
  const items = await committeeProceedingsService().items(ctx, cp.id);
  const id = `committee-recommendations-${k}`;
  // The restricted case's authority (the case owner, 2030) approves each legal review of an adopted package; the
  // approval page asks the database whether it would accept the approval now, and says why not.
  const approves = c.isRestricted && c.owner?.userId === actorId && c.recordsState === "ACTIVE";
  return (
    <section className="mb-6" aria-labelledby={`${id}-title`} data-testid={id}>
      <h2 id={`${id}-title`} className="mb-1 text-cdf-h2 font-semibold">
        {t("legalReviews.caseTitle", { committee })}
      </h2>
      <p className="mb-1 text-sm">
        {t("caseStructure.now.referred", { date: formatDate(t.locale, cp.referredAt), number })}
      </p>
      <p className="mb-3 text-sm text-cdf-text-secondary">{t("legalReviews.caseIntro")}</p>
      {items === null ? (
        <p className="text-cdf-text-secondary" data-testid={`${id}-not-shown`}>
          {t("legalReviews.caseNotShown")}
        </p>
      ) : items.packages.length === 0 ? (
        <p className="text-cdf-text-secondary" data-testid={`${id}-none`}>
          {t("legalReviews.caseNone")}
        </p>
      ) : (
        items.packages.map((pkg) => {
          const reviewed = pkg.legalReview.requests.some(
            (r) =>
              r.packageRound === pkg.roundNo && (r.status === "ASSIGNED" || r.status === "OPINION_GIVEN"),
          );
          return (
            <PackageCard
              key={pkg.packageId}
              t={t}
              committeeProceedingId={cp.id}
              pkg={pkg}
              scope={null}
              catalogue={[]}
              meetingNo={NO_MEETINGS}
              readOnly
              packetHref={(packetId) => `/cases/${c.id}/proceedings/packets/${packetId}`}
              footer={
                approves && pkg.status === "ADOPTED" && !reviewed ? (
                  <div
                    className="mt-4 border-t border-cdf-border pt-3"
                    data-testid={`package-${pkg.sequenceNo}-approve`}
                  >
                    <p className="mb-2 text-sm">{t("legalReviews.approveNote")}</p>
                    <Link
                      href={`/cases/${c.id}/proceedings/legal-review-approval/${pkg.packageId}`}
                      className="font-semibold underline underline-offset-4"
                      data-testid={`package-${pkg.sequenceNo}-approve-link`}
                    >
                      {t("legalReviews.approveLink", { n: pkg.sequenceNo })}
                    </Link>
                  </div>
                ) : null
              }
            />
          );
        })
      )}
    </section>
  );
}
