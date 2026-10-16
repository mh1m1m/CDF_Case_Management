// Asking for a legal review of an adopted package (UX redesign Phase 12 P12-3a; ADR-057; DEC-F12, DEC-62, DEC-F20): a
// page of the proceeding's own for the committee's secretary, so that the proceeding's page never reads the choices.
// It reads the seat basis and R2, and only when R2 says the caller may ask now, api.legal_review_choices (L2), which
// the database records with counts. On a restricted case the request follows the authority's approval of the round:
// L2 offers only the approval's reviewer, findings and minutes, and never its reason (ruling 2). Anyone else gets the
// same 404 as a package that does not exist; the command checks everything again.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CDFAlert, CDFBreadcrumbs, CDFPageHeader, CDFPurposeBanner } from "@cdf/ui";
import { committeeProceedingsService, legalReviewsService, requireActor } from "@/server/container";
import { getTranslator } from "@/server/locale";
import { proceedingLabel } from "../../../../../committees/proceeding-label";
import { LEGAL_CODES, codeText } from "../../../../../legal-reviews/labels";
import { ReviewChoicesForm } from "../../../../../legal-reviews/review-choices";
import { itemLabeller } from "../../../../labels";
import { requestLegalReviewAction } from "../../../legal-actions";

/** Unique translated title (WCAG 2.4.2, UX-082); never a case number or committee content. */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("pageTitles.legalReviewRequest") };
}

const UUID = /^[0-9a-f-]{36}$/i;

export default async function AskLegalReviewPage({
  params,
}: {
  params: Promise<{ committeeProceedingId: string; packageId: string }>;
}) {
  const { committeeProceedingId, packageId } = await params;
  if (!UUID.test(committeeProceedingId) || !UUID.test(packageId)) notFound();
  const { ctx } = await requireActor();
  const t = await getTranslator();
  const v = await committeeProceedingsService().onSeat(ctx, committeeProceedingId);
  const pkg = v?.items.packages.find((p) => p.packageId === packageId);
  if (!v || !pkg?.capabilities.mayRequestLegalReview) notFound();
  const answer = await legalReviewsService().choices(ctx, packageId, "REQUEST");
  if (!answer) notFound();

  const committee = t.code("committeeName", v.committee.code, "common.none");
  const label = proceedingLabel(t, v.committee.code, v.proceeding);
  const proceedingHref = `/committee-proceedings/${committeeProceedingId}`;
  const n = pkg.sequenceNo;
  return (
    <>
      <CDFBreadcrumbs
        label={t("shell.breadcrumb")}
        items={[
          { label: t("shell.area.COMMITTEE"), href: "/committees" },
          { label: committee, href: `/committees/${v.committee.committeeId}` },
          { label, href: proceedingHref },
          { label: t("legalReviews.askBreadcrumb") },
        ]}
      />
      <CDFPageHeader title={t("legalReviews.askTitle", { n })} />
      <CDFPurposeBanner
        title={t("legalReviews.askPurposeTitle")}
        purpose={t("legalReviews.askPurposeBody")}
        notShown={t("legalReviews.askPurposeNotShown")}
        testId="ask-purpose-banner"
      />
      {answer.ok ? (
        <>
          {answer.choices.restricted ? (
            <CDFAlert tone="info" testId="ask-restricted">
              <p>{t("legalReviews.restrictedNote")}</p>
            </CDFAlert>
          ) : null}
          <ReviewChoicesForm
            t={t}
            id="ask"
            choices={answer.choices}
            itemLabel={itemLabeller(t, pkg)}
            action={requestLegalReviewAction.bind(null, committeeProceedingId, packageId)}
            act="requestLegalReview"
            reviewerField="assignedTo"
            reviewerHint={t("legalReviews.reviewerHint")}
            reasonHint={t("legalReviews.askReasonHint")}
            successMessage={t("legalReviews.requested")}
          />
        </>
      ) : (
        <CDFAlert tone="info" title={t("legalReviews.refusedTitle")} testId="ask-refused">
          <p>{codeText(t, LEGAL_CODES, answer.code)}</p>
        </CDFAlert>
      )}
      <p className="mt-4">
        <Link href={proceedingHref} className="underline underline-offset-4" data-testid="ask-back">
          {t("legalReviews.backToProceeding")}
        </Link>
      </p>
    </>
  );
}
