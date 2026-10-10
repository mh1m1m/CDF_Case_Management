// Legal hold requests (CDF-71; ADR-014 §5, §6). Legal staff file a hold request by exact case number without
// browsing cases; case authorities route requests to a reviewer; reviewers decide the requests assigned to
// them. The lists are what RLS returns for the caller; nothing here enumerates cases.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { can, canDiscoverCase, navigationFor } from "@cdf/authorization";
import { LEGAL_HOLD_REASON_CODES } from "@cdf/contracts";
import type { MessageKey } from "@cdf/i18n";
import { CDFCard, CDFField, CDFPageHeader, inputClass, textareaClass } from "@cdf/ui";
import { investigationService, recordsService, requireActor } from "@/server/container";
import { getTranslator } from "@/server/locale";
import { ActionForm } from "../../action-form";
import { AppNav } from "../../app-nav";
import { caseLookupAction } from "../actions";
import { HoldRequestList } from "../hold-requests";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("pageTitles.legalHolds") };
}

export default async function LegalHoldsPage() {
  const { actor, ctx } = await requireActor();
  const nav = navigationFor(actor);
  if (!nav.recordsCatalogue && !nav.myWork) notFound();
  const t = await getTranslator();
  const canAssign = can(actor, "CASE_TASK_ASSIGN");
  const canReview = can(actor, "LEGAL_HOLD_REVIEW");
  const requests = await recordsService().listHoldRequests(ctx);
  const mine = requests.filter((r) => r.requestedByMe);
  const assignedToMe = requests.filter((r) => r.assignedToMe && !r.requestedByMe);
  const toRoute = canAssign
    ? requests.filter((r) => r.status === "SUBMITTED" && r.caseId && !r.requestedByMe && !r.assignedToMe)
    : [];
  const directory =
    toRoute.length > 0 || mine.some((r) => r.status === "SUBMITTED" && r.caseId)
      ? await investigationService().directory(ctx)
      : [];
  const lists = { t, canAssign, canReview, directory, caseId: null };

  return (
    <>
      <AppNav actor={actor} t={t} current="records" />
      <CDFPageHeader
        title={t("records.legalHoldsTitle")}
        intro={t("records.legalHoldsIntro")}
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

      {canDiscoverCase(actor) && can(actor, "LEGAL_HOLD_REQUEST") ? (
        <CDFCard title={t("records.lookupTitle")} testId="lookup-card">
          <p className="mb-3 text-sm text-cdf-text-secondary">{t("records.lookupIntro")}</p>
          <ActionForm
            action={caseLookupAction}
            locale={t.locale}
            submitLabel={t("records.lookup")}
            testId="lookup-form"
            successMessage={t("records.lookupOutcome.MATCHED")}
            fieldLabels={{
              caseReference: t("records.caseReferenceLabel"),
              justification: t("records.justificationLabel"),
              reasonCode: t("records.reasonLabel"),
            }}
          >
            <CDFField
              id="caseReference"
              label={t("records.caseReferenceLabel")}
              hint={t("records.caseReferenceHint")}
              requiredLabel={t("common.required")}
            >
              <input
                id="caseReference"
                name="caseReference"
                dir="ltr"
                className={inputClass}
                aria-describedby="caseReference-hint"
                autoComplete="off"
                required
                maxLength={30}
              />
            </CDFField>
            <CDFField
              id="lookup-reason"
              label={t("records.reasonLabel")}
              requiredLabel={t("common.required")}
            >
              <select
                id="lookup-reason"
                name="reasonCode"
                className={inputClass}
                defaultValue="LITIGATION"
                required
              >
                {LEGAL_HOLD_REASON_CODES.map((r) => (
                  <option key={r} value={r}>
                    {t(`records.reasonCode.${r}` as MessageKey)}
                  </option>
                ))}
              </select>
            </CDFField>
            <CDFField
              id="lookup-justification"
              label={t("records.justificationLabel")}
              hint={t("records.justificationHint")}
              requiredLabel={t("common.required")}
            >
              <textarea
                id="lookup-justification"
                name="justification"
                className={textareaClass}
                aria-describedby="lookup-justification-hint"
                required
                minLength={20}
                maxLength={2000}
              />
            </CDFField>
          </ActionForm>
        </CDFCard>
      ) : null}

      {canReview || assignedToMe.length > 0 ? (
        <CDFCard title={t("records.assignedToMeTitle")} testId="assigned-to-me-card">
          <HoldRequestList requests={assignedToMe} testId="assigned-to-me" {...lists} />
        </CDFCard>
      ) : null}

      {canAssign ? (
        <CDFCard title={t("records.toAssignTitle")} testId="to-route-card">
          <HoldRequestList requests={toRoute} testId="to-route" {...lists} />
        </CDFCard>
      ) : null}

      <CDFCard title={t("records.myRequestsTitle")} testId="my-requests-card">
        <HoldRequestList requests={mine} testId="my-requests" {...lists} />
      </CDFCard>
    </>
  );
}
