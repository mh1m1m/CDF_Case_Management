// One form instance (Phase 8; ADR-011): fields, draft saving, prepare / review / approve / withdraw as the
// database allows this user, the immutable version list with hashes and the lifecycle trail.
// api.open_form_instance audits FORM_VIEWED or a SECURITY denial; invisible and missing instances are alike.
import Link from "next/link";
import { notFound } from "next/navigation";
import { formDisplayNumber } from "@cdf/domain";
import { formatDateTime, type MessageKey } from "@cdf/i18n";
import {
  CDFBadge,
  CDFCard,
  CDFDescriptionList,
  CDFField,
  CDFPageHeader,
  CDFTimeline,
  classificationTone,
  inputClass,
  textareaClass,
} from "@cdf/ui";
import { formsService, requireActor } from "@/server/container";
import { getTranslator } from "@/server/locale";
import { ActionForm } from "../../../../action-form";
import { AppNav } from "../../../../app-nav";
import {
  approveFormAction,
  prepareFormAction,
  reviewFormAction,
  saveDraftAction,
  withdrawFormAction,
} from "../actions";
import { FormFields, fieldLabels, statusTone } from "../form-fields";

const UUID = /^[0-9a-f-]{36}$/i;

export default async function FormInstancePage({
  params,
}: {
  params: Promise<{ id: string; instanceId: string }>;
}) {
  const { id, instanceId } = await params;
  if (!UUID.test(id) || !UUID.test(instanceId)) notFound();
  const { actor, ctx } = await requireActor();
  const t = await getTranslator();
  const f = await formsService().getInstance(ctx, instanceId);
  if (!f || f.caseId !== id) notFound();
  const name = t.locale === "ar" ? f.formNameAr : f.formNameEn;
  const labels = fieldLabels(f.definition.sections, t.locale);
  const status = (s: string) => t(`formStatus.${s}` as MessageKey);
  const who = (n: string | null, at: string | null) => (n ? `${n} · ${formatDateTime(t.locale, at!)}` : "—");
  const bind = <
    A extends (caseId: string, instanceId: string, formCode: string, ...rest: never[]) => unknown,
  >(
    a: A,
  ) => a.bind(null, f.caseId, f.id, f.formCode) as unknown as Parameters<typeof ActionForm>[0]["action"];

  return (
    <>
      <AppNav actor={actor} t={t} current="cases" />
      <CDFPageHeader
        title={`${f.caseNumber} · ${formDisplayNumber(f.formCode, f.instanceNo)}`}
        intro={`${name} — ${t.locale === "ar" ? f.definition.purposeAr : f.definition.purposeEn}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <CDFBadge tone={statusTone(f.status)} testId="form-status">
              {status(f.status)}
            </CDFBadge>
            <CDFBadge tone={classificationTone(f.classification)}>
              {t(`classification.${f.classification}` as MessageKey)}
            </CDFBadge>
            <Link
              href={`/cases/${f.caseId}/forms`}
              className="font-semibold underline underline-offset-4"
              data-testid="back-to-forms"
            >
              {t("forms.backToForms")}
            </Link>
            <Link href={`/cases/${f.caseId}`} className="font-semibold underline underline-offset-4">
              {t("forms.backToCase")}
            </Link>
          </div>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div>
          <CDFCard title={t("forms.fields")} testId="form-fields">
            {f.capabilities.canSave ? (
              <ActionForm
                action={bind(saveDraftAction)}
                locale={t.locale}
                submitLabel={t("forms.saveDraft")}
                testId="draft-form"
                fieldLabels={labels}
                successMessage={t("forms.saved", { message: "{message}" })}
              >
                <FormFields sections={f.definition.sections} data={f.data} editable t={t} />
              </ActionForm>
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
                    · {v.savedByName ?? "—"} · {formatDateTime(t.locale, v.savedAt)}
                    {f.preparedVersionNo === v.versionNo ? (
                      <>
                        {" "}
                        <CDFBadge tone="info">{status("PREPARED")}</CDFBadge>
                      </>
                    ) : null}
                    <br />
                    <code className="break-all text-xs" dir="ltr">
                      {t("forms.hash")}: {v.contentHash}
                    </code>
                  </li>
                ))}
              </ol>
            )}
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
                  term: t("forms.definitionVersion", { no: f.definition.versionNo }),
                  value: (
                    <code className="break-all text-xs" dir="ltr">
                      {f.definition.schemaHash}
                    </code>
                  ),
                },
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
              <ActionForm
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
              <ActionForm
                action={bind(f.capabilities.canReview ? reviewFormAction : approveFormAction)}
                locale={t.locale}
                submitLabel={t("forms.decide")}
                variant="secondary"
                testId="decision-form"
                fieldLabels={{ outcome: t("forms.decision"), reason: t("forms.reason") }}
                successMessage={t("forms.decided")}
              >
                <fieldset className="mb-3">
                  <legend className="mb-1 font-semibold">{t("forms.decision")}</legend>
                  <label className="mb-2 flex items-center gap-2">
                    <input
                      type="radio"
                      name="outcome"
                      value={f.capabilities.canReview ? "REVIEWED" : "APPROVED"}
                      defaultChecked
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
                      className="size-5"
                      data-testid="outcome-return"
                    />
                    {t("forms.return")}
                  </label>
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
              </ActionForm>
            </CDFCard>
          ) : null}

          {f.capabilities.canWithdraw ? (
            <CDFCard title={t("forms.withdrawTitle")} testId="withdraw-card">
              <p className="mb-3 text-sm text-cdf-text-secondary">{t("forms.withdrawHint")}</p>
              <ActionForm
                action={bind(withdrawFormAction)}
                locale={t.locale}
                submitLabel={t("forms.withdraw")}
                variant="danger"
                testId="withdraw-form"
                fieldLabels={{ reason: t("forms.reason") }}
                successMessage={t("forms.withdrawn")}
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
              </ActionForm>
            </CDFCard>
          ) : null}
        </div>
      </div>
    </>
  );
}
