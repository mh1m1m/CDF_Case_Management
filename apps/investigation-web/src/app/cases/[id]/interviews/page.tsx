// Interview list and planning for one case (CDF-60). Lists what RLS returned; offers planning to users the
// database would allow (hidden ≠ forbidden: api.plan_interview re-checks). Entry link from the case page is
// added by the accessibility thread, which owns that page.
import Link from "next/link";
import { notFound } from "next/navigation";
import { can } from "@cdf/authorization";
import { CLASSIFICATION_LEVELS, INTERVIEWEE_KINDS, type InterviewListItem } from "@cdf/contracts";
import { interviewDisplayNumber } from "@cdf/domain";
import { formatDateTime, type MessageKey } from "@cdf/i18n";
import {
  CDFBadge,
  CDFCard,
  CDFField,
  CDFPageHeader,
  CDFTable,
  classificationTone,
  inputClass,
  textareaClass,
} from "@cdf/ui";
import { interviewService, investigationService, requireActor } from "@/server/container";
import { getTranslator } from "@/server/locale";
import { AppNav } from "../../../app-nav";
import { planInterviewAction } from "./actions";
import { InterviewForm } from "./interview-form";
import { interviewStatusTone } from "./status-tone";

const UUID = /^[0-9a-f-]{36}$/i;

export default async function InterviewsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const { actor, ctx } = await requireActor();
  const t = await getTranslator();
  const c = await investigationService().getCase(ctx, id);
  if (!c) notFound();
  const interviews = await interviewService().listInterviews(ctx, id);

  // Mirrors authz.can_conduct_interviews for the UI only; the database decides (§19).
  const canPlan =
    c.recordsState === "ACTIVE" &&
    (can(actor, "CASE_EDIT_ALL") ||
      c.assignments.some(
        (a) =>
          a.userId === actor.userId &&
          ["CASE_OWNER", "LEAD_INVESTIGATOR", "INVESTIGATOR"].includes(a.assignmentRole),
      ));
  const levels = CLASSIFICATION_LEVELS.filter(
    (l) =>
      CLASSIFICATION_LEVELS.indexOf(l) >= CLASSIFICATION_LEVELS.indexOf(c.classification) &&
      CLASSIFICATION_LEVELS.indexOf(l) <= CLASSIFICATION_LEVELS.indexOf(actor.clearance),
  );
  const kinds = INTERVIEWEE_KINDS.filter((k) => k !== "REPORTER" || c.reporterWbId);
  const interviewee = (i: InterviewListItem) =>
    i.intervieweeKind === "REPORTER" ? t("interviews.reporterProtected") : (i.intervieweeLabel ?? "—");

  return (
    <>
      <AppNav actor={actor} t={t} current="cases" />
      <CDFPageHeader
        title={`${c.caseNumber} · ${t("interviews.title")}`}
        actions={
          <Link
            href={`/cases/${c.id}`}
            className="font-semibold underline underline-offset-4"
            data-testid="back-to-case"
          >
            {t("interviews.backToCase")}
          </Link>
        }
      />
      <CDFCard title={t("interviews.title")} testId="interviews-card">
        <p className="mb-3 text-sm text-cdf-text-secondary">{t("interviews.intro")}</p>
        <CDFTable<InterviewListItem>
          caption={t("interviews.title")}
          testId="interviews-table"
          rows={interviews}
          rowKey={(i) => i.id}
          empty={t("interviews.empty")}
          columns={[
            {
              header: t("interviews.number"),
              cell: (i) => (
                <Link
                  href={`/cases/${c.id}/interviews/${i.id}`}
                  dir="ltr"
                  className="font-semibold underline underline-offset-4"
                  data-testid={`interview-${i.sequenceNo}`}
                  aria-label={t("interviews.openInterview", { number: interviewDisplayNumber(i.sequenceNo) })}
                >
                  {interviewDisplayNumber(i.sequenceNo)}
                </Link>
              ),
            },
            {
              header: t("interviews.itemTitle"),
              cell: (i) => <span className="font-semibold">{i.title}</span>,
            },
            {
              header: t("interviews.interviewee"),
              cell: (i) => (
                <>
                  {interviewee(i)}
                  <br />
                  <span className="text-cdf-text-secondary">
                    {t(`interviews.kind.${i.intervieweeKind}` as MessageKey)}
                  </span>
                </>
              ),
            },
            {
              header: t("interviews.status"),
              cell: (i) => (
                <CDFBadge tone={interviewStatusTone(i.status)} testId={`interview-status-${i.sequenceNo}`}>
                  {t(`interviews.statusName.${i.status}` as MessageKey)}
                </CDFBadge>
              ),
            },
            {
              header: t("interviews.scheduled"),
              cell: (i) =>
                i.scheduledStart ? formatDateTime(t.locale, i.scheduledStart) : t("interviews.notScheduled"),
            },
            {
              header: t("interviews.classification"),
              cell: (i) => (
                <CDFBadge tone={classificationTone(i.classification)}>
                  {t(`classification.${i.classification}` as MessageKey)}
                </CDFBadge>
              ),
            },
          ]}
        />
      </CDFCard>

      {canPlan ? (
        <CDFCard title={t("interviews.planTitle")} testId="plan-interview-card">
          <p className="mb-3 text-sm text-cdf-text-secondary">{t("interviews.planIntro")}</p>
          <InterviewForm
            action={planInterviewAction.bind(null, c.id)}
            locale={t.locale}
            submitLabel={t("interviews.plan")}
            variant="primary"
            testId="plan-interview-form"
            fieldLabels={{
              title: t("interviews.titleLabel"),
              purpose: t("interviews.purposeLabel"),
              intervieweeKind: t("interviews.kindLabel"),
              intervieweeLabel: t("interviews.labelLabel"),
              classification: t("interviews.classificationLabel"),
            }}
          >
            <CDFField id="interviewTitle" label={t("interviews.titleLabel")}>
              <input
                id="interviewTitle"
                name="title"
                className={inputClass}
                required
                minLength={3}
                maxLength={200}
              />
            </CDFField>
            <CDFField id="intervieweeKind" label={t("interviews.kindLabel")}>
              <select
                id="intervieweeKind"
                name="intervieweeKind"
                className={inputClass}
                defaultValue="WITNESS"
              >
                {kinds.map((k) => (
                  <option key={k} value={k}>
                    {t(`interviews.kind.${k}` as MessageKey)}
                  </option>
                ))}
              </select>
            </CDFField>
            <CDFField
              id="intervieweeLabel"
              label={t("interviews.labelLabel")}
              hint={t("interviews.labelHint")}
            >
              <input
                id="intervieweeLabel"
                name="intervieweeLabel"
                className={inputClass}
                maxLength={200}
                aria-describedby="intervieweeLabel-hint"
              />
            </CDFField>
            {c.reporterWbId ? (
              <p className="mb-4 text-sm text-cdf-text-secondary" data-testid="reporter-hint">
                {t("interviews.reporterHint")}
              </p>
            ) : null}
            <CDFField
              id="interviewClassification"
              label={t("interviews.classificationLabel")}
              hint={t("interviews.classificationHint")}
            >
              <select
                id="interviewClassification"
                name="classification"
                className={inputClass}
                defaultValue={c.classification}
                aria-describedby="interviewClassification-hint"
              >
                {levels.map((l) => (
                  <option key={l} value={l}>
                    {t(`classification.${l}` as MessageKey)}
                  </option>
                ))}
              </select>
            </CDFField>
            <CDFField
              id="interviewPurpose"
              label={t("interviews.purposeLabel")}
              optionalLabel={t("common.optional")}
            >
              <textarea id="interviewPurpose" name="purpose" className={textareaClass} maxLength={2000} />
            </CDFField>
          </InterviewForm>
        </CDFCard>
      ) : null}
    </>
  );
}
