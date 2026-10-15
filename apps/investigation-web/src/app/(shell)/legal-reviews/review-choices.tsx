// What a legal review may be asked for, or approved with (L2, api.legal_review_choices; UX redesign Phase 12 P12-3a,
// ADR-057), as one form for the committee's secretary asking and for the restricted case's authority approving: the
// reviewer, the findings and approved minutes the packet carries besides the adopted items, and the reason. The
// reviewers are every active holder of the legal opinion permission but the caller (the seat basis, not filtered by
// the case gate, ruling 1): the command refuses someone not cleared for the case. A finding names its allegation by
// number and category and its person concerned by position and category, a name only in DISPLAY_NAME mode (DEC-02),
// never the finding's reasons. The command checks every choice again.
import type { LegalReviewChoices, LegalReviewFindingChoice } from "@cdf/contracts";
import { isolate, type MessageKey, type Translator } from "@cdf/i18n";
import {
  CDFCard,
  CDFCommandForm,
  CDFField,
  CDFFieldError,
  textareaClass,
  type CDFCommandFormProps,
} from "@cdf/ui";
import { actLabel, confirmation } from "../confirmations";
import { Checks } from "../committee-proceedings/[committeeProceedingId]/packages";
import { allegationName, sanctionName, subjectName } from "../committee-proceedings/labels";
import { LEGAL_CODES, accountName } from "./labels";

/** "Substantiated · Allegation 2 · Fraud · Person 1 · Employee · version 3 · …": what the packet would carry, never why. */
function findingLabel(t: Translator, f: LegalReviewFindingChoice): string {
  return t("committeeProceedings.findingOption", {
    result: t.code("findingResult", f.result, "common.none"),
    allegation: allegationName(t, f.allegation),
    subject: f.subject ? isolate(subjectName(t, f.subject)) : t("caseStructure.wholeAllegation"),
    version: f.versionNo,
    where: t(`committeeProceedings.findingRole.${f.proceedingRole}` as MessageKey),
  });
}

export function ReviewChoicesForm({
  t,
  id,
  choices,
  itemLabel,
  action,
  act,
  reviewerField,
  reviewerHint,
  reasonHint,
  successMessage,
}: {
  t: Translator;
  id: string;
  choices: LegalReviewChoices;
  /** "Item n · type" as the package's card numbers it. */
  itemLabel: (itemId: string) => string;
  action: CDFCommandFormProps["action"];
  act: "requestLegalReview" | "approveRestrictedLegalReview";
  /** The command's field for the reviewer: `assignedTo` to ask, `reviewerId` to approve. */
  reviewerField: "assignedTo" | "reviewerId";
  reviewerHint: string;
  reasonHint: string;
  successMessage: string;
}) {
  return (
    <>
      <CDFCard title={t("legalReviews.packetCarries")} testId={`${id}-carries`}>
        <ul className="grid gap-1">
          {choices.items.map((i) => (
            <li key={i.itemId}>
              {itemLabel(i.itemId)}
              {i.sanctionCode ? ` · ${sanctionName(t, i.sanctionCode)}` : null}
            </li>
          ))}
        </ul>
      </CDFCard>

      <CDFCard testId={id}>
        {choices.reviewers.length === 0 ? (
          <p className="text-cdf-text-secondary" data-testid={`${id}-no-reviewers`}>
            {t("legalReviews.noReviewers")}
          </p>
        ) : (
          <CDFCommandForm
            action={action}
            locale={t.locale}
            submitLabel={actLabel(t, act)}
            variant="primary"
            testId={`${id}-form`}
            successMessage={successMessage}
            codeSections={LEGAL_CODES}
            fieldLabels={{
              [reviewerField]: t("legalReviews.reviewerChoice"),
              findingIds: t("legalReviews.findingsLabel"),
              minutesIds: t("legalReviews.minutesLabel"),
              reason: t("meetings.reasonLabel"),
            }}
            confirm={confirmation(t, act)}
          >
            <fieldset className="mb-4" aria-describedby={`${id}-reviewer-hint`}>
              <legend className="mb-1 font-semibold">{t("legalReviews.reviewerChoice")}</legend>
              <p id={`${id}-reviewer-hint`} className="mb-2 text-sm text-cdf-text-secondary">
                {reviewerHint}
              </p>
              {choices.reviewers.map((r, k) => (
                <div key={r.userId} className="mb-1 flex items-start gap-2">
                  <input
                    id={`${id}-reviewer-${k}`}
                    type="radio"
                    name={reviewerField}
                    value={r.userId}
                    className="mt-1 size-5"
                    required
                    data-testid={`${id}-reviewer-${k}`}
                  />
                  <label htmlFor={`${id}-reviewer-${k}`}>
                    <bdi>{accountName(t, r)}</bdi>
                  </label>
                </div>
              ))}
              <CDFFieldError id={`${id}-reviewer-0`} />
            </fieldset>
            <Checks
              id={`${id}-finding`}
              name="findingIds"
              legend={t("legalReviews.findingsLabel")}
              hint={t("legalReviews.findingsHint")}
              empty={t("legalReviews.noFindings")}
              options={choices.findings.map((f) => ({ value: f.findingId, label: findingLabel(t, f) }))}
            />
            <Checks
              id={`${id}-minutes`}
              name="minutesIds"
              legend={t("legalReviews.minutesLabel")}
              empty={t("legalReviews.noMinutes")}
              options={choices.minutes.map((m) => ({
                value: m.minutesId,
                label: t("legalReviews.minutesOption", {
                  n: m.meetingSequenceNo,
                  version: m.versionNo,
                  status: t.code("legalReviews.minutesStatus", m.status, "common.none"),
                }),
              }))}
            />
            <CDFField id={`${id}-reason`} label={t("meetings.reasonLabel")} hint={reasonHint}>
              <textarea
                id={`${id}-reason`}
                name="reason"
                className={textareaClass}
                aria-describedby={`${id}-reason-hint`}
                minLength={5}
                maxLength={2000}
                required
                data-testid={`${id}-reason`}
              />
            </CDFField>
          </CDFCommandForm>
        )}
      </CDFCard>
    </>
  );
}
