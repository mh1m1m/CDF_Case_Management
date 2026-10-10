// One case's record (CDF-71; ADR-013, ADR-014): lifecycle metadata, retention, legal holds and disposition.
// api.open_case_metadata audits the view and refuses callers without catalogue scope, a task or a case
// relationship; a refused and a missing case look the same. Each form is offered only when the authz.*
// predicate behind its command is true for the caller, so the page never offers a write the database refuses.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { can, navigationFor } from "@cdf/authorization";
import { formatDate, formatDateTime, type MessageKey } from "@cdf/i18n";
import {
  CDFAlert,
  CDFBadge,
  CDFCard,
  CDFDescriptionList,
  CDFField,
  CDFPageHeader,
  classificationTone,
  inputClass,
  textareaClass,
} from "@cdf/ui";
import { investigationService, recordsService, requireActor } from "@/server/container";
import { getTranslator } from "@/server/locale";
import { ActionForm } from "../../action-form";
import { AppNav } from "../../app-nav";
import {
  assignRetentionClassAction,
  decideDispositionAction,
  decideHoldReleaseAction,
  executeDispositionAction,
  placeLegalHoldAction,
  requestDispositionAction,
  requestHoldReleaseAction,
  requestLegalHoldAction,
} from "../actions";
import { LegalHoldBadge, RecordsStateBadge } from "../badges";
import { DecisionFields, HoldReasonFields } from "../fields";
import { HoldRequestList } from "../hold-requests";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("pageTitles.recordDetail") };
}

const UUID = /^[0-9a-f-]{36}$/i;

export default async function RecordPage({ params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params;
  if (!UUID.test(caseId)) notFound();
  const { actor, ctx } = await requireActor();
  const nav = navigationFor(actor);
  if (!nav.recordsCatalogue && !nav.myWork) notFound();
  const t = await getTranslator();
  const r = await recordsService().getRecord(ctx, caseId);
  if (!r) notFound();
  const cap = r.capabilities;
  const canAssignRequests = can(actor, "CASE_TASK_ASSIGN");
  const [classes, directory] = await Promise.all([
    cap.manageRetention ? recordsService().listRetentionClasses(ctx) : Promise.resolve([]),
    canAssignRequests && r.holdRequests.some((q) => q.status === "SUBMITTED")
      ? investigationService().directory(ctx)
      : Promise.resolve([]),
  ]);
  const disposed = r.recordsState === "DISPOSED";
  const retentionOpen = r.recordsState === "ARCHIVED" || r.recordsState === "RETENTION";
  const openRequest = r.dispositionRequests.find((d) => d.status === "PENDING" || d.status === "APPROVED");
  const className = (code: string) => {
    const k = classes.find((c) => c.code === code);
    if (!k) return code;
    const label = t.locale === "ar" ? k.nameAr : k.nameEn;
    return k.status === "SOURCE_REQUIRED" ? t("records.sourceRequired", { name: label }) : label;
  };

  return (
    <>
      <AppNav actor={actor} t={t} current="records" />
      <CDFPageHeader
        title={`${r.caseNumber} · ${t("records.metadataTitle")}`}
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

      <CDFCard title={t("records.metadataTitle")} testId="record-card">
        <p className="mb-3 text-sm text-cdf-text-secondary">{t("records.metadataNote")}</p>
        <div className="mb-3 flex flex-wrap gap-2">
          <RecordsStateBadge state={r.recordsState} t={t} testId="record-state" />
          <LegalHoldBadge status={r.legalHoldStatus} t={t} testId="record-hold" />
          <CDFBadge tone={classificationTone(r.classification)}>
            {t(`classification.${r.classification}` as MessageKey)}
          </CDFBadge>
        </div>
        <CDFDescriptionList
          items={[
            { term: t("records.caseNumber"), value: <span dir="ltr">{r.caseNumber}</span> },
            { term: t("records.retentionClass"), value: <span dir="ltr">{r.retentionClass}</span> },
            {
              term: t("records.closed"),
              value: r.closedAt ? formatDateTime(t.locale, r.closedAt) : t("records.notSet"),
            },
            {
              term: t("records.retainUntil"),
              value: r.retainUntil ? formatDate(t.locale, r.retainUntil) : t("records.notSet"),
            },
          ]}
        />
        {disposed ? (
          <div className="mt-3">
            <CDFAlert tone="info" testId="record-disposed">
              {t("records.disposedNotice")}
            </CDFAlert>
          </div>
        ) : r.recordsState !== "ACTIVE" ? (
          <div className="mt-3">
            <CDFAlert tone="info" testId="record-read-only">
              {t("records.readOnlyNotice")}
            </CDFAlert>
          </div>
        ) : null}
        {r.certificateId ? (
          <p className="mt-3">
            <Link
              href={`/records/certificates/${r.certificateId}`}
              className="font-semibold underline underline-offset-4"
              data-testid="certificate-link"
            >
              {t("records.certificateLink")}
            </Link>
          </p>
        ) : null}
      </CDFCard>

      {cap.manageRetention && retentionOpen ? (
        <CDFCard title={t("records.retentionTitle")} testId="retention-card">
          <ActionForm
            action={assignRetentionClassAction.bind(null, r.caseId)}
            locale={t.locale}
            submitLabel={t("records.assignClass")}
            variant="secondary"
            testId="retention-form"
            successMessage={t("records.classAssigned")}
          >
            <CDFField
              id="retentionClass"
              label={t("records.retentionClassLabel")}
              hint={t("records.retentionClassHint")}
              requiredLabel={t("common.required")}
            >
              <select
                id="retentionClass"
                name="retentionClass"
                className={inputClass}
                defaultValue={r.retentionClass === "UNASSIGNED" ? "" : r.retentionClass}
                aria-describedby="retentionClass-hint"
                required
              >
                <option value="" disabled>
                  —
                </option>
                {classes.map((k) => (
                  <option key={k.code} value={k.code}>
                    {className(k.code)}
                  </option>
                ))}
              </select>
            </CDFField>
          </ActionForm>
        </CDFCard>
      ) : null}

      <CDFCard title={t("records.holdsTitle")} testId="holds-card">
        {r.holds.length === 0 ? (
          <p className="text-cdf-text-secondary">{t("records.holdsEmpty")}</p>
        ) : (
          <ul data-testid="holds-list">
            {r.holds.map((h) => (
              <li
                key={h.id}
                className="mb-4 border-b border-cdf-border pb-4 last:border-0"
                data-testid={`hold-${h.holdNumber}`}
              >
                <CDFDescriptionList
                  items={[
                    { term: t("records.holdNumber"), value: <span dir="ltr">{h.holdNumber}</span> },
                    {
                      term: t("records.holdReason"),
                      value: t(`records.reasonCode.${h.reasonCode}` as MessageKey),
                    },
                    {
                      term: t("records.holdState"),
                      value: (
                        <CDFBadge
                          tone={h.status === "RELEASED" ? "neutral" : "danger"}
                          testId={`hold-status-${h.holdNumber}`}
                        >
                          {t(`records.holdStateName.${h.status}` as MessageKey)}
                        </CDFBadge>
                      ),
                    },
                    { term: t("records.placedAt"), value: formatDateTime(t.locale, h.placedAt) },
                  ]}
                />
                {cap.releaseLegalHold && h.status === "ACTIVE" ? (
                  <div className="mt-3">
                    <ActionForm
                      action={requestHoldReleaseAction.bind(null, r.caseId, h.id)}
                      locale={t.locale}
                      submitLabel={t("records.requestRelease")}
                      variant="secondary"
                      testId={`request-release-${h.holdNumber}`}
                      successMessage={t("records.releaseRequested")}
                    >
                      <CDFField
                        id={`release-${h.id}`}
                        label={t("records.releaseJustificationLabel")}
                        hint={t("records.justificationHint")}
                        requiredLabel={t("common.required")}
                      >
                        <textarea
                          id={`release-${h.id}`}
                          name="justification"
                          className={textareaClass}
                          aria-describedby={`release-${h.id}-hint`}
                          required
                          minLength={20}
                          maxLength={2000}
                        />
                      </CDFField>
                    </ActionForm>
                  </div>
                ) : null}
                {cap.releaseLegalHold && h.pendingRelease ? (
                  h.pendingRelease.requestedByMe ? (
                    <p
                      className="mt-3 text-sm text-cdf-text-secondary"
                      data-testid={`own-release-${h.holdNumber}`}
                    >
                      {t("records.ownReleaseNote")}
                    </p>
                  ) : (
                    <div className="mt-3">
                      <h3 className="mb-2 font-semibold">
                        {t("records.decideReleaseTitle", { number: h.holdNumber })}
                      </h3>
                      <ActionForm
                        action={decideHoldReleaseAction.bind(null, r.caseId, h.pendingRelease.id)}
                        locale={t.locale}
                        submitLabel={t("records.decide")}
                        testId={`decide-release-${h.holdNumber}`}
                        successMessage={t("records.decided")}
                      >
                        <DecisionFields
                          id={`release-decision-${h.id}`}
                          t={t}
                          name="approve"
                          yes={{ value: "APPROVE", label: t("records.approve") }}
                          no={{ value: "REJECT", label: t("records.reject") }}
                        />
                      </ActionForm>
                    </div>
                  )
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {cap.applyLegalHold ? (
          <div className="mt-4 border-t border-cdf-border pt-4">
            <h3 className="mb-1 font-semibold">{t("records.placeTitle")}</h3>
            <p className="mb-3 text-sm text-cdf-text-secondary">{t("records.placeIntro")}</p>
            <ActionForm
              action={placeLegalHoldAction.bind(null, r.caseId)}
              locale={t.locale}
              submitLabel={t("records.place")}
              testId="place-hold-form"
              successMessage={t("records.placed")}
            >
              <HoldReasonFields id="place" t={t} authority />
            </ActionForm>
          </div>
        ) : cap.requestLegalHold ? (
          <div className="mt-4 border-t border-cdf-border pt-4">
            <h3 className="mb-1 font-semibold">{t("records.requestTitle")}</h3>
            <p className="mb-3 text-sm text-cdf-text-secondary">{t("records.requestIntro")}</p>
            <ActionForm
              action={requestLegalHoldAction.bind(null, r.caseId)}
              locale={t.locale}
              submitLabel={t("records.request")}
              variant="secondary"
              testId="request-hold-form"
              successMessage={t("records.requested")}
            >
              <HoldReasonFields id="request" t={t} />
            </ActionForm>
          </div>
        ) : null}
      </CDFCard>

      {r.holdRequests.length > 0 ? (
        <CDFCard title={t("records.requestsTitle")} testId="hold-requests-card">
          <HoldRequestList
            requests={r.holdRequests}
            t={t}
            caseId={r.caseId}
            canAssign={canAssignRequests}
            canReview={can(actor, "LEGAL_HOLD_REVIEW")}
            directory={directory}
            testId="hold-requests"
          />
        </CDFCard>
      ) : null}

      {r.recordsState !== "ACTIVE" && r.recordsState !== "CLOSED" ? (
        <CDFCard title={t("records.dispositionTitle")} testId="disposition-card">
          <p className="mb-3 text-sm text-cdf-text-secondary">{t("records.dispositionIntro")}</p>
          {r.dispositionRequests.length > 0 ? (
            <ul className="mb-3">
              {r.dispositionRequests.map((d) => (
                <li key={d.id} className="mb-2" data-testid="disposition-request">
                  <CDFBadge tone="info" testId={`disposition-status-${d.status}`}>
                    {t(`records.dispositionStatusName.${d.status}` as MessageKey)}
                  </CDFBadge>{" "}
                  <span className="text-sm text-cdf-text-secondary">
                    {formatDateTime(t.locale, d.requestedAt)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          {cap.manageDisposition && !openRequest && !disposed ? (
            r.recordsState === "DISPOSITION_ELIGIBLE" ? (
              <ActionForm
                action={requestDispositionAction.bind(null, r.caseId)}
                locale={t.locale}
                submitLabel={t("records.requestDisposition")}
                variant="secondary"
                testId="request-disposition-form"
                successMessage={t("records.dispositionRequested")}
              />
            ) : (
              <p className="text-sm text-cdf-text-secondary" data-testid="not-eligible">
                {t("records.notEligible")}
              </p>
            )
          ) : null}

          {openRequest?.status === "PENDING" && cap.approveDisposition ? (
            openRequest.requestedByMe ? (
              <p className="text-sm text-cdf-text-secondary" data-testid="own-disposition">
                {t("records.ownDispositionNote")}
              </p>
            ) : (
              <div className="mt-3">
                <h3 className="mb-2 font-semibold">{t("records.decideDispositionTitle")}</h3>
                <ActionForm
                  action={decideDispositionAction.bind(null, r.caseId, openRequest.id)}
                  locale={t.locale}
                  submitLabel={t("records.decide")}
                  testId="decide-disposition-form"
                  successMessage={t("records.decided")}
                >
                  <DecisionFields
                    id="disposition-decision"
                    t={t}
                    name="approve"
                    yes={{ value: "APPROVE", label: t("records.approve") }}
                    no={{ value: "REJECT", label: t("records.reject") }}
                  />
                </ActionForm>
              </div>
            )
          ) : null}

          {openRequest?.status === "APPROVED" && (cap.manageDisposition || cap.approveDisposition) ? (
            <div className="mt-3">
              <h3 className="mb-2 font-semibold">{t("records.executeTitle")}</h3>
              <ActionForm
                action={executeDispositionAction.bind(null, r.caseId, openRequest.id)}
                locale={t.locale}
                submitLabel={t("records.execute")}
                variant="danger"
                testId="execute-disposition-form"
                successMessage={t("records.executed")}
                fieldLabels={{ confirm: t("records.confirmLabel") }}
              >
                <label className="mb-3 flex items-center gap-2" htmlFor="confirm-disposition">
                  <input
                    id="confirm-disposition"
                    type="checkbox"
                    name="confirm"
                    className="size-5"
                    required
                  />{" "}
                  {t("records.confirmLabel")}
                </label>
              </ActionForm>
            </div>
          ) : null}
        </CDFCard>
      ) : null}
    </>
  );
}
