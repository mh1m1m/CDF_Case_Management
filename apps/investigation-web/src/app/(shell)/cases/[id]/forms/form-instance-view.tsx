// One form instance (Phase 8; ADR-011): fields, draft saving, prepare / review / approve / withdraw as the
// database allows this user, the immutable version list with hashes and the lifecycle trail. Shared by the case's
// form page and, since S3 (ADR-016 D2, path (a)), the purpose view for a form held without its case: the caller's
// own capabilities decide every action, and nothing here reads the case beyond the number the caller may see.
import { formDisplayNumber } from "@cdf/domain";
import type { FormInstanceDetail } from "@cdf/contracts";
import { formatDateTime, isolate, type MessageKey, type Translator } from "@cdf/i18n";
import {
  CDFAlert,
  CDFBadge,
  CDFBreadcrumbs,
  CDFCard,
  CDFCommandForm,
  CDFDescriptionList,
  CDFField,
  CDFFieldError,
  CDFIdentifier,
  CDFPageHeader,
  CDFPurposeBanner,
  CDFTimeline,
  classificationTone,
  inputClass,
  textareaClass,
} from "@cdf/ui";
import { actLabel, confirmation } from "../../../confirmations";
import {
  approveFormAction,
  prepareFormAction,
  reviewFormAction,
  saveDraftAction,
  withdrawFormAction,
} from "./actions";
import { FormFields, fieldLabels, statusTone } from "./form-fields";

export function FormInstanceView({ f, t, userId }: { f: FormInstanceDetail; t: Translator; userId: string }) {
  const name = t.locale === "ar" ? f.formNameAr : f.formNameEn;
  const labels = fieldLabels(f.definition.sections, t.locale);
  const status = (s: string) => t(`formStatus.${s}` as MessageKey);
  const who = (n: string | null, at: string | null) => (n ? `${n} · ${formatDateTime(t.locale, at!)}` : "—");
  // A draft that was returned says so first, with the reason (UX-086). The return is derived from the events: the
  // latest RETURNED one while the form is a draft again. It came back to whoever prepared the returned version.
  const returned = f.status === "DRAFT" ? f.events.findLast((e) => e.eventType === "RETURNED") : undefined;
  const returnedToMe =
    returned !== undefined && f.events.findLast((e) => e.eventType === "PREPARED")?.actorId === userId;
  const bind = <
    A extends (caseId: string | null, instanceId: string, formCode: string, ...rest: never[]) => unknown,
  >(
    a: A,
  ) => a.bind(null, f.caseId, f.id, f.formCode) as unknown as Parameters<typeof CDFCommandForm>[0]["action"];

  return (
    <>
      {/* No case header here: a form is reached by its own access check, which from S3 can be purpose-bound
          rather than case-wide (ADR-016 D2). The breadcrumbs carry the place: the case where the caller works in
          it, My Work where the form alone is open to them. */}
      <CDFBreadcrumbs
        label={t("shell.breadcrumb")}
        items={
          f.caseId
            ? [
                { label: t("shell.area.CASES"), href: "/cases" },
                { label: <CDFIdentifier>{f.caseNumber}</CDFIdentifier>, href: `/cases/${f.caseId}` },
                { label: t("caseWorkspace.tabs.forms"), href: `/cases/${f.caseId}/forms` },
                { label: <CDFIdentifier>{formDisplayNumber(f.formCode, f.instanceNo)}</CDFIdentifier> },
              ]
            : [
                { label: t("shell.area.MY_WORK"), href: "/my-work" },
                { label: <CDFIdentifier>{formDisplayNumber(f.formCode, f.instanceNo)}</CDFIdentifier> },
              ]
        }
      />
      {/* The form leads, not its codes (UX-123): its name and purpose; the number sits with the status. */}
      <CDFPageHeader
        title={name}
        intro={t.locale === "ar" ? f.definition.purposeAr : f.definition.purposeEn}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <CDFIdentifier testId="form-number">{formDisplayNumber(f.formCode, f.instanceNo)}</CDFIdentifier>
            <CDFBadge tone={statusTone(f.status)} testId="form-status">
              {status(f.status)}
            </CDFBadge>
            <CDFBadge tone={classificationTone(f.classification)}>
              {t(`classification.${f.classification}` as MessageKey)}
            </CDFBadge>
          </div>
        }
      />

      {f.caseId ? null : (
        // The purpose view (S3, ADR-016 D2, path (a)): say plainly what is open, and that the case is not.
        <CDFPurposeBanner
          title={t("forms.purposeView.title")}
          purpose={t("forms.purposeView.body")}
          testId="form-purpose-banner"
        />
      )}

      {returned ? (
        <CDFAlert
          tone="warning"
          title={returnedToMe ? t("forms.tab.returnedToYou") : t("forms.tab.returnedForChanges")}
          testId="form-returned-banner"
        >
          {returned.reason ? (
            <p>
              <q className="break-words">
                <bdi>{returned.reason}</bdi>
              </q>
            </p>
          ) : null}
          <p className="text-sm">
            {t("forms.tab.returnedBy", {
              name: isolate(returned.actorName ?? "—"),
              date: isolate(formatDateTime(t.locale, returned.occurredAt)),
            })}
          </p>
        </CDFAlert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div>
          <CDFCard title={t("forms.fields")} testId="form-fields">
            {f.capabilities.canSave ? (
              <CDFCommandForm
                action={bind(saveDraftAction)}
                locale={t.locale}
                submitLabel={t("forms.saveDraft")}
                testId="draft-form"
                fieldLabels={labels}
                successMessage={t("forms.saved", { message: "{message}" })}
                leaveWarning={t("common.leaveWarning")}
              >
                <FormFields sections={f.definition.sections} data={f.data} editable t={t} />
              </CDFCommandForm>
            ) : (
              <>
                <p className="mb-3 text-sm text-cdf-text-secondary" data-testid="form-read-only">
                  {t("forms.readOnly", { status: status(f.status) })}
                </p>
                <FormFields sections={f.definition.sections} data={f.data} editable={false} t={t} />
              </>
            )}
          </CDFCard>

          <CDFCard title={t("forms.versions")} testId="form-versions">
            {f.versions.length === 0 ? (
              <p className="text-cdf-text-secondary">{t("forms.noVersions")}</p>
            ) : (
              <ol className="list-decimal ps-5 text-sm">
                {f.versions.map((v) => (
                  <li key={v.id} className="mb-2" data-testid={`form-version-${v.versionNo}`}>
                    <span className="font-semibold">
                      {t("forms.version")} {v.versionNo}
                    </span>{" "}
                    · <bdi>{v.savedByName ?? "—"}</bdi> · <bdi>{formatDateTime(t.locale, v.savedAt)}</bdi>
                    {f.preparedVersionNo === v.versionNo ? (
                      <>
                        {" "}
                        <CDFBadge tone="info">{status("PREPARED")}</CDFBadge>
                      </>
                    ) : null}
                  </li>
                ))}
              </ol>
            )}
            {/* Hashes prove what was saved; they are kept, one step away (UX-123). */}
            <details className="mt-3 border-t border-cdf-border pt-3" data-testid="integrity-details">
              <summary className="cursor-pointer font-semibold">{t("forms.integrity")}</summary>
              <p className="mt-2 text-sm text-cdf-text-secondary">{t("forms.integrityHint")}</p>
              <dl className="mt-2 grid gap-2 text-sm">
                <div>
                  <dt className="font-semibold">
                    {t("forms.definitionVersion", { no: f.definition.versionNo })}
                  </dt>
                  <dd>
                    <CDFIdentifier variant="hash">{f.definition.schemaHash}</CDFIdentifier>
                  </dd>
                </div>
                {f.versions.map((v) => (
                  <div key={v.id}>
                    <dt className="font-semibold">
                      {t("forms.version")} {v.versionNo} · {t("forms.hash")}
                    </dt>
                    <dd data-testid={`form-hash-${v.versionNo}`}>
                      <CDFIdentifier variant="hash">{v.contentHash}</CDFIdentifier>
                    </dd>
                  </div>
                ))}
              </dl>
            </details>
          </CDFCard>

          <CDFCard title={t("forms.events")}>
            <CDFTimeline
              testId="form-events"
              empty={t("common.none")}
              items={f.events.map((e, i) => ({
                id: `${i}-${e.id}`,
                title: `${t(`formEvent.${e.eventType}` as MessageKey)}${e.versionNo ? ` · v${e.versionNo}` : ""}`,
                meta: `${formatDateTime(t.locale, e.occurredAt)} · ${e.actorName ?? "—"}`,
                body: e.reason,
              }))}
            />
          </CDFCard>
        </div>

        <div>
          <CDFCard title={t("forms.status")} testId="form-summary">
            <CDFDescriptionList
              items={[
                { term: t("forms.status"), value: status(f.status) },
                { term: t("forms.finalState"), value: status(f.finalStatus) },
                {
                  term: t("forms.version"),
                  value: f.currentVersionNo ? `v${f.currentVersionNo}` : t("forms.notSet"),
                },
                { term: t("forms.preparedBy"), value: who(f.preparedByName, f.preparedAt) },
                ...(f.definition.reviewRequired
                  ? [{ term: t("forms.reviewedBy"), value: who(f.reviewedByName, f.reviewedAt) }]
                  : []),
                ...(f.definition.approvalRequired
                  ? [{ term: t("forms.approvedBy"), value: who(f.approvedByName, f.approvedAt) }]
                  : []),
                ...(f.withdrawnAt
                  ? [{ term: t("forms.withdrawnBy"), value: who(f.withdrawnByName, f.withdrawnAt) }]
                  : []),
              ]}
            />
          </CDFCard>

          {f.capabilities.canPrepare ? (
            <CDFCard title={t("forms.prepareTitle")} testId="prepare-card">
              <p className="mb-3 text-sm text-cdf-text-secondary">{t("forms.prepareHint")}</p>
              <CDFCommandForm
                action={bind(prepareFormAction)}
                locale={t.locale}
                submitLabel={t("forms.prepare")}
                variant="secondary"
                testId="prepare-form"
                fieldLabels={labels}
                successMessage={t("forms.prepared")}
              />
            </CDFCard>
          ) : null}

          {f.capabilities.canReview || f.capabilities.canApprove ? (
            <CDFCard
              title={f.capabilities.canReview ? t("forms.reviewTitle") : t("forms.approveTitle")}
              testId="decision-card"
            >
              <p className="mb-3 text-sm text-cdf-text-secondary">
                {f.capabilities.canReview ? t("forms.reviewHint") : t("forms.approveHint")}
              </p>
              <CDFCommandForm
                action={bind(f.capabilities.canReview ? reviewFormAction : approveFormAction)}
                locale={t.locale}
                submitLabel={t("forms.decide")}
                variant="secondary"
                testId="decision-form"
                fieldLabels={{ outcome: t("forms.decision"), reason: t("forms.reason") }}
                successMessage={t("forms.decided")}
              >
                {/* No default answer (UX-019): the reviewer or approver chooses; an unanswered submit is refused. */}
                <fieldset className="mb-3">
                  <legend className="mb-1 font-semibold">{t("forms.decision")}</legend>
                  <label className="mb-2 flex items-center gap-2">
                    <input
                      id="outcome-accept"
                      type="radio"
                      name="outcome"
                      value={f.capabilities.canReview ? "REVIEWED" : "APPROVED"}
                      required
                      className="size-5"
                      data-testid="outcome-accept"
                    />
                    {f.capabilities.canReview ? t("forms.accept") : t("forms.approve")}
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="outcome"
                      value="RETURNED"
                      required
                      className="size-5"
                      data-testid="outcome-return"
                    />
                    {t("forms.return")}
                  </label>
                  <CDFFieldError id="outcome-accept" />
                </fieldset>
                <CDFField id="decision-reason" label={t("forms.reason")} hint={t("forms.reasonHint")}>
                  <textarea
                    id="decision-reason"
                    name="reason"
                    className={textareaClass}
                    maxLength={2000}
                    aria-describedby="decision-reason-hint"
                  />
                </CDFField>
              </CDFCommandForm>
            </CDFCard>
          ) : null}

          {f.capabilities.canWithdraw ? (
            <CDFCard title={t("forms.withdrawTitle")} testId="withdraw-card">
              <p className="mb-3 text-sm text-cdf-text-secondary">{t("forms.withdrawHint")}</p>
              <CDFCommandForm
                action={bind(withdrawFormAction)}
                locale={t.locale}
                submitLabel={actLabel(t, "withdrawForm")}
                variant="danger"
                testId="withdraw-form"
                fieldLabels={{ reason: t("forms.reason") }}
                successMessage={t("forms.withdrawn")}
                confirm={confirmation(t, "withdrawForm")}
              >
                <CDFField id="withdraw-reason" label={t("forms.reason")}>
                  <input
                    id="withdraw-reason"
                    name="reason"
                    className={inputClass}
                    required
                    minLength={5}
                    maxLength={2000}
                  />
                </CDFField>
              </CDFCommandForm>
            </CDFCard>
          ) : null}
        </div>
      </div>
    </>
  );
}
