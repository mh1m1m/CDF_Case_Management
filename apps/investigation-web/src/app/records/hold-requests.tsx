// Legal hold requests (ADR-014 §5): what the caller filed, what they may route, and what is assigned to them.
// Forms appear only for the step the database would accept: routing a SUBMITTED request (CASE_TASK_ASSIGN)
// and reviewing an ASSIGNED request as its assigned reviewer (LEGAL_HOLD_REVIEW).
import type { LegalHoldRequestInfo, UserDirectoryEntry } from "@cdf/contracts";
import { formatDateTime, type MessageKey, type Translator } from "@cdf/i18n";
import { CDFBadge, CDFDescriptionList, CDFField, inputClass } from "@cdf/ui";
import { ActionForm } from "../action-form";
import { assignHoldRequestAction, reviewHoldRequestAction } from "./actions";
import { DecisionFields } from "./fields";

export function HoldRequestList({
  requests,
  t,
  caseId,
  canAssign,
  canReview,
  directory,
  testId,
}: {
  requests: LegalHoldRequestInfo[];
  t: Translator;
  caseId: string | null;
  canAssign: boolean;
  canReview: boolean;
  directory: UserDirectoryEntry[];
  testId: string;
}) {
  if (requests.length === 0) return <p className="text-cdf-text-secondary">{t("records.requestsEmpty")}</p>;
  const person = (u: UserDirectoryEntry) =>
    t.locale === "ar" && u.displayNameAr ? u.displayNameAr : u.displayName;
  return (
    <ul data-testid={testId}>
      {requests.map((r, n) => (
        <li
          key={r.id}
          className="mb-4 border-b border-cdf-border pb-4 last:border-0"
          data-testid={`hold-request-${n}`}
        >
          <CDFDescriptionList
            items={[
              {
                term: t("records.requestCase"),
                value: r.caseNumber ? <span dir="ltr">{r.caseNumber}</span> : t("records.caseHidden"),
              },
              { term: t("records.holdReason"), value: t(`records.reasonCode.${r.reasonCode}` as MessageKey) },
              { term: t("records.requestOrigin"), value: t(`records.origin.${r.origin}` as MessageKey) },
              {
                term: t("records.requestStatus"),
                value: (
                  <CDFBadge tone="info" testId={`hold-request-status-${n}`}>
                    {t(`records.requestStatusName.${r.status}` as MessageKey)}
                  </CDFBadge>
                ),
              },
              { term: t("records.requestedAt"), value: formatDateTime(t.locale, r.requestedAt) },
            ]}
          />
          {canAssign && r.status === "SUBMITTED" && r.caseId ? (
            <div className="mt-3">
              <h3 className="mb-2 font-semibold">{t("records.assignTitle")}</h3>
              <ActionForm
                action={assignHoldRequestAction.bind(null, caseId, r.id)}
                locale={t.locale}
                submitLabel={t("records.assign")}
                variant="secondary"
                testId={`assign-request-${n}`}
                successMessage={t("records.assigned")}
              >
                <CDFField
                  id={`reviewer-${r.id}`}
                  label={t("records.reviewerLabel")}
                  requiredLabel={t("common.required")}
                >
                  <select
                    id={`reviewer-${r.id}`}
                    name="reviewerId"
                    className={inputClass}
                    required
                    defaultValue=""
                  >
                    <option value="" disabled>
                      —
                    </option>
                    {directory.map((u) => (
                      <option key={u.id} value={u.id}>
                        {person(u)}
                      </option>
                    ))}
                  </select>
                </CDFField>
              </ActionForm>
            </div>
          ) : null}
          {canReview && r.assignedToMe && r.status === "ASSIGNED" ? (
            <div className="mt-3">
              <h3 className="mb-2 font-semibold">{t("records.reviewTitle")}</h3>
              <ActionForm
                action={reviewHoldRequestAction.bind(null, caseId, r.id)}
                locale={t.locale}
                submitLabel={t("records.review")}
                testId={`review-request-${n}`}
                successMessage={t("records.reviewed")}
                fieldLabels={{ reason: t("records.decisionReasonLabel"), apply: t("records.decisionLabel") }}
              >
                <DecisionFields
                  id={`review-${r.id}`}
                  t={t}
                  name="apply"
                  yes={{ value: "APPLY", label: t("records.applyHold") }}
                  no={{ value: "REJECT", label: t("records.rejectRequest") }}
                />
              </ActionForm>
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
