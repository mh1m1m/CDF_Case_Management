// Approving a legal review of a restricted case's package «اعتماد المراجعة القانونية» (UX redesign Phase 12 P12-3a;
// ADR-057; DEC-62, DEC-F20): a page of the case's own for its Restricted Case Authority, the case owner. The package
// must be one of this case's (R2 as the case team reads it); then api.legal_review_choices (L2) answers for the
// approval, recorded with counts. L2 admits only the case owner of a restricted case: anyone else gets the same 404 as
// a package that does not exist, and the command's own refusal (an approval already waiting, a review open) is said in
// words. The command checks everything again.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CDFAlert, CDFPurposeBanner } from "@cdf/ui";
import { caseStructureService, legalReviewsService } from "@/server/container";
import { getTranslator } from "@/server/locale";
import { itemLabeller } from "../../../../../committee-proceedings/labels";
import { LEGAL_CODES, codeText } from "../../../../../legal-reviews/labels";
import { ReviewChoicesForm } from "../../../../../legal-reviews/review-choices";
import { CaseWorkspace, loadCase } from "../../../workspace";
import { findCasePackage } from "../../case-packages";
import { approveLegalReviewAction } from "./actions";

/** Unique translated title (WCAG 2.4.2, UX-082); never a case number or committee content. */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("pageTitles.legalReviewApproval") };
}

const UUID = /^[0-9a-f-]{36}$/i;

export default async function LegalReviewApprovalPage({
  params,
}: {
  params: Promise<{ id: string; packageId: string }>;
}) {
  const { id, packageId } = await params;
  if (!UUID.test(packageId)) notFound();
  const { actor, ctx, t, c } = await loadCase(id);
  const s = await caseStructureService().structure(ctx, id);
  const found = await findCasePackage(ctx, s, (p) => p.packageId === packageId);
  if (!found) notFound();
  const answer = await legalReviewsService().choices(ctx, packageId, "APPROVE");
  if (!answer) notFound();
  const n = found.pkg.sequenceNo;

  return (
    <CaseWorkspace c={c} actor={actor} t={t} tab="proceedings" item={t("legalReviews.approveBreadcrumb")}>
      <h2 className="mb-3 text-cdf-h2 font-semibold">{t("legalReviews.approveTitle", { n })}</h2>
      <CDFPurposeBanner
        title={t("legalReviews.approvePurposeTitle")}
        purpose={t("legalReviews.approvePurposeBody")}
        notShown={t("legalReviews.approvePurposeNotShown")}
        testId="approve-purpose-banner"
      />
      {answer.ok ? (
        <ReviewChoicesForm
          t={t}
          id="approve"
          choices={answer.choices}
          itemLabel={itemLabeller(t, found.pkg)}
          action={approveLegalReviewAction.bind(null, c.id, packageId)}
          act="approveRestrictedLegalReview"
          reviewerField="reviewerId"
          reviewerHint={t("legalReviews.approveReviewerHint")}
          reasonHint={t("legalReviews.approveReasonHint")}
          successMessage={t("legalReviews.approved")}
        />
      ) : answer.code === "APPROVAL_ALREADY_PENDING" ? (
        // After an approval the page says where the round stands, not that something failed.
        <CDFAlert tone="info" testId="approve-pending">
          <p>{codeText(t, LEGAL_CODES, answer.code)}</p>
        </CDFAlert>
      ) : (
        <CDFAlert tone="info" title={t("legalReviews.refusedTitle")} testId="approve-refused">
          <p>{codeText(t, LEGAL_CODES, answer.code)}</p>
        </CDFAlert>
      )}
      <p className="mt-4">
        <Link
          href={`/cases/${c.id}/proceedings`}
          className="underline underline-offset-4"
          data-testid="approve-back"
        >
          {t("legalReviews.backToProceedings")}
        </Link>
      </p>
    </CaseWorkspace>
  );
}
