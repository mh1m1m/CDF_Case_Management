import Link from "next/link";
import { notFound } from "next/navigation";
import { can } from "@cdf/authorization";
import { CLASSIFICATION_LEVELS, TRIAGE_OUTCOMES } from "@cdf/contracts";
import { formatDate, formatDateTime, type MessageKey } from "@cdf/i18n";
import {
  CDFBadge,
  CDFCard,
  CDFDescriptionList,
  CDFField,
  CDFPageHeader,
  CDFTimeline,
  buttonClass,
  classificationTone,
  inputClass,
  textareaClass,
} from "@cdf/ui";
import { investigationService, requireActor } from "@/server/container";
import { getTranslator } from "@/server/locale";
import { ActionForm } from "../../action-form";
import { AppNav } from "../../app-nav";
import { createCaseAction, replyAction, triageAction } from "./actions";

const UUID = /^[0-9a-f-]{36}$/i;

export default async function ReportDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const { actor, ctx } = await requireActor();
  const t = await getTranslator();
  // Opening a report is itself an audited event; a hidden report and a missing one look the same (§40).
  const report = await investigationService().getReport(ctx, id);
  if (!report) notFound();

  const canTriage =
    can(actor, "REPORT_TRIAGE") && ["RECEIVED", "INFO_REQUESTED"].includes(report.status) && !report.caseId;
  const canCreate = can(actor, "CASE_CREATE") && report.status === "ACCEPTED" && !report.caseId;
  const canReply = can(actor, "REPORT_MESSAGE_REPLY");

  return (
    <>
      <AppNav actor={actor} t={t} current="intake" />
      <CDFPageHeader
        title={t("intake.detailTitle", { ref: report.reportRef })}
        actions={
          <div className="flex gap-2">
            <CDFBadge tone="info" testId="report-status">
              {t(`reportStatus.${report.status}` as MessageKey)}
            </CDFBadge>
            <CDFBadge tone={classificationTone(report.classification)}>
              {t(`classification.${report.classification}` as MessageKey)}
            </CDFBadge>
          </div>
        }
      />
      {report.caseId ? (
        <p className="mb-4">
          <Link href={`/cases/${report.caseId}`} className={buttonClass("secondary")}>
            {t("intake.viewCase")}
          </Link>
        </p>
      ) : null}
      <CDFCard>
        <CDFDescriptionList
          items={[
            { term: t("intake.category"), value: t(`category.${report.category}` as MessageKey) },
            { term: t("intake.reporterMode"), value: t(`reporterMode.${report.reporterMode}` as MessageKey) },
            { term: t("intake.receivedAt"), value: formatDateTime(t.locale, report.receivedAt) },
            { term: t("intake.subjectDescription"), value: report.subjectDescription ?? t("common.none") },
            {
              term: t("intake.incidentDate"),
              value: report.incidentDate ? formatDate(t.locale, report.incidentDate) : t("common.none"),
            },
            { term: t("intake.location"), value: report.location ?? t("common.none") },
            {
              term: t("intake.description"),
              value: <span lang={report.language}>{report.description}</span>,
            },
          ]}
        />
      </CDFCard>

      {canTriage ? (
        <CDFCard title={t("intake.triageTitle")} testId="triage-card">
          <ActionForm
            action={triageAction.bind(null, report.id)}
            locale={t.locale}
            submitLabel={t("intake.recordDecision")}
            fieldLabels={{
              outcome: t("intake.outcome"),
              reason: t("intake.reason"),
              referredTo: t("intake.referredTo"),
              duplicateOf: t("intake.duplicateOf"),
            }}
            testId="triage-form"
          >
            <CDFField id="outcome" label={t("intake.outcome")} requiredLabel={t("common.required")}>
              <select id="outcome" name="outcome" className={inputClass} required>
                {TRIAGE_OUTCOMES.map((o) => (
                  <option key={o} value={o}>
                    {t(`triageOutcome.${o}` as MessageKey)}
                  </option>
                ))}
              </select>
            </CDFField>
            <CDFField
              id="reason"
              label={t("intake.reason")}
              hint={t("intake.reasonHint")}
              requiredLabel={t("common.required")}
            >
              <textarea
                id="reason"
                name="reason"
                aria-describedby="reason-hint"
                className={textareaClass}
                required
                minLength={10}
                maxLength={4000}
              />
            </CDFField>
            <div className="grid gap-4 sm:grid-cols-2">
              <CDFField id="referredTo" label={t("intake.referredTo")} optionalLabel={t("common.optional")}>
                <input id="referredTo" name="referredTo" className={inputClass} maxLength={200} />
              </CDFField>
              <CDFField id="duplicateOf" label={t("intake.duplicateOf")} optionalLabel={t("common.optional")}>
                <input id="duplicateOf" name="duplicateOf" className={inputClass} dir="ltr" />
              </CDFField>
            </div>
          </ActionForm>
        </CDFCard>
      ) : null}

      {canCreate ? (
        <CDFCard title={t("intake.createCaseTitle")} testId="create-case-card">
          <ActionForm
            action={createCaseAction.bind(null, report.id)}
            locale={t.locale}
            submitLabel={t("intake.createCase")}
            fieldLabels={{
              title: t("intake.caseTitle"),
              summary: t("intake.caseSummary"),
              classification: t("intake.caseClassification"),
            }}
            testId="create-case-form"
          >
            <CDFField id="title" label={t("intake.caseTitle")} requiredLabel={t("common.required")}>
              <input id="title" name="title" className={inputClass} required minLength={3} maxLength={200} />
            </CDFField>
            <CDFField id="summary" label={t("intake.caseSummary")} requiredLabel={t("common.required")}>
              <textarea
                id="summary"
                name="summary"
                className={textareaClass}
                required
                minLength={10}
                maxLength={4000}
              />
            </CDFField>
            <CDFField id="classification" label={t("intake.caseClassification")}>
              <select
                id="classification"
                name="classification"
                className={inputClass}
                defaultValue={report.classification}
              >
                {CLASSIFICATION_LEVELS.filter(
                  (c) =>
                    CLASSIFICATION_LEVELS.indexOf(c) >= CLASSIFICATION_LEVELS.indexOf(report.classification),
                ).map((c) => (
                  <option key={c} value={c}>
                    {t(`classification.${c}` as MessageKey)}
                  </option>
                ))}
              </select>
            </CDFField>
            <label className="mb-4 flex items-start gap-3">
              <input type="checkbox" name="isRestricted" className="mt-1 size-5" />
              <span>{t("intake.restricted")}</span>
            </label>
          </ActionForm>
        </CDFCard>
      ) : null}

      <CDFCard title={t("intake.messages")}>
        <CDFTimeline
          testId="report-messages"
          empty={t("intake.noMessages")}
          items={report.messages.map((m, i) => ({
            id: String(i),
            title: m.direction === "FROM_REPORTER" ? t("intake.fromReporter") : t("intake.toReporter"),
            meta: formatDateTime(t.locale, m.createdAt),
            body: m.body,
          }))}
        />
        {canReply ? (
          <div className="mt-4 border-t border-cdf-border pt-4">
            <ActionForm
              action={replyAction.bind(null, report.id)}
              locale={t.locale}
              submitLabel={t("intake.sendReply")}
              variant="secondary"
              fieldLabels={{ body: t("intake.reply") }}
              testId="reply-form"
            >
              <CDFField
                id="body"
                label={t("intake.reply")}
                hint={t("intake.replyHint")}
                requiredLabel={t("common.required")}
              >
                <textarea
                  id="body"
                  name="body"
                  aria-describedby="body-hint"
                  className={textareaClass}
                  required
                  maxLength={4000}
                />
              </CDFField>
            </ActionForm>
          </div>
        ) : null}
      </CDFCard>
    </>
  );
}
