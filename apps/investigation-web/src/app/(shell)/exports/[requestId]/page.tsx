// An export request «طلب تصدير» (UX redesign Phase 12 P12-6b-1; ADR-026; DEC-F21 to DEC-F23, AMB-187, CDF-208): a
// purpose route that reads api.export_request_view (2040) and the reference rows that name what it shows. Whoever may
// see the export (its requester, an approver once it is submitted, the restricted case's authority) reads what it is
// for, what it holds, who it goes to and where it stands; anyone else, and an id that names nothing, gets the same
// 404, and the refusal is recorded (ACCESS_DENIED). The view never gives the content, the file or where it is stored:
// the content opens only in the preview, on a page of its own, because the preview is recorded (EXPORT_PREVIEWED) and
// is what a submission or an approval is bound to. Each form shows only where the view says its command would accept
// the caller now (UX-116), and the command checks again.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import type { ExportRequestPage, ExportRequestView } from "@cdf/contracts";
import { type MessageKey, type Translator } from "@cdf/i18n";
import {
  buttonClass,
  CDFAlert,
  CDFBreadcrumbs,
  CDFCard,
  CDFCommandForm,
  CDFConfiguredValue,
  CDFDescriptionList,
  CDFField,
  CDFIdentifier,
  CDFPageHeader,
  CDFPurposeBanner,
  CDFStatusBadge,
  CDFWorkflowGuide,
  inputClass,
  textareaClass,
} from "@cdf/ui";
import { exportService, requireActor } from "@/server/container";
import { getTranslator } from "@/server/locale";
import { actLabel, confirmation } from "../../confirmations";
import {
  EXPORT_CODES,
  SOURCE,
  currentStep,
  exportSteps,
  itemKind,
  mayOpenPreview,
  personName,
  purposeName,
  ruleName,
  sourceLabel,
  stepState,
  when,
} from "../labels";
import {
  addCaseSummaryAction,
  addExternalRecipientAction,
  cancelExportAction,
  generateExportAction,
} from "./actions";

/** Unique translated title (WCAG 2.4.2, UX-082); never a case number or the export's content. */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("pageTitles.exportRequest") };
}

const UUID = /^[0-9a-f-]{36}$/i;

/** What the page says after a command sent the caller back here: one taken on the preview, generation or cancellation. */
const DONE = [
  "created",
  "submitted",
  "approvedAtSubmit",
  "approved",
  "approvedStage",
  "rejected",
  "consented",
  "refused",
  "sent",
  "generated",
  "cancelled",
] as const;

type Name = (userId: string) => string;

export default async function ExportPage({
  params,
  searchParams,
}: {
  params: Promise<{ requestId: string }>;
  searchParams: Promise<{ done?: string }>;
}) {
  const { requestId } = await params;
  if (!UUID.test(requestId)) notFound();
  const { actor, ctx } = await requireActor();
  const t = await getTranslator();
  const page = await exportService().view(ctx, requestId);
  if (!page) notFound();
  const doneParam = (await searchParams).done;
  const done = DONE.find((d) => d === doneParam) ?? null;
  const v = page.view;
  const me = actor.userId;
  const name: Name = (userId) => personName(t, page.people, userId, me);

  return (
    <>
      <CDFBreadcrumbs
        label={t("shell.breadcrumb")}
        items={
          v.caseId && v.caseNumber
            ? [
                { label: t("shell.area.CASES"), href: "/cases" },
                { label: <CDFIdentifier>{v.caseNumber}</CDFIdentifier>, href: `/cases/${v.caseId}` },
                { label: t("exports.breadcrumb") },
              ]
            : [{ label: t("shell.area.MY_WORK"), href: "/my-work" }, { label: t("exports.breadcrumb") }]
        }
      />
      <CDFPageHeader
        title={t("exports.title")}
        actions={
          <CDFStatusBadge domain="exportRequest" status={v.status} testId="export-status">
            {t(`exports.status.${v.status}` as MessageKey)}
          </CDFStatusBadge>
        }
      />
      {done ? (
        <div className="mb-4">
          <CDFAlert tone="success" testId="export-done">
            {t(`exports.done.${done}` as MessageKey)}
          </CDFAlert>
        </div>
      ) : null}
      <CDFPurposeBanner
        title={t("exports.purposeTitle")}
        purpose={t("exports.purposeBody")}
        notShown={t("exports.purposeNotShown")}
        testId="export-purpose-banner"
      />
      <Notices t={t} v={v} />
      <Guide t={t} v={v} me={me} name={name} preview={mayOpenPreview(actor)} />

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="min-w-0">
          <Summary t={t} page={page} name={name} />
          <Items t={t} v={v} name={name} />
          {v.format === "EMAIL" ? <Recipients t={t} page={page} name={name} /> : null}
          <Approvals t={t} v={v} name={name} />
          <Rules t={t} page={page} />
        </div>
        <div className="min-w-0">
          {v.capabilities.mayPreview && mayOpenPreview(actor) ? <PreviewLink t={t} v={v} /> : null}
          <Generate t={t} v={v} />
          {v.capabilities.mayCancel ? <Cancel t={t} v={v} /> : null}
        </div>
      </div>
    </>
  );
}

/** What holds the export now, in words: none of these is a command, each explains what the database decided. */
function Notices({ t, v }: { t: Translator; v: ExportRequestView }) {
  const open = v.status === "DRAFT" || v.status === "SUBMITTED" || v.status === "APPROVED";
  const c = v.current;
  return (
    <>
      {c.authorityConsentBlocked === "REQUESTER_IS_CASE_AUTHORITY" ? (
        <div className="mb-4">
          <CDFAlert
            tone="warning"
            title={t("exports.notice.authorityBlockedTitle")}
            testId="export-authority-blocked"
          >
            <p>{t("exports.notice.authorityBlocked")}</p>
          </CDFAlert>
        </div>
      ) : null}
      {open && c.refusedByRule ? (
        <div className="mb-4">
          <CDFAlert tone="warning" title={t("exports.notice.refusedTitle")} testId="export-refused-by-rule">
            <p>{t("exports.notice.refused")}</p>
          </CDFAlert>
        </div>
      ) : null}
      {open && c.withheld > 0 ? (
        <div className="mb-4">
          <CDFAlert tone="info" title={t("exports.notice.withheldTitle")} testId="export-withheld">
            <p>{t("exports.notice.withheld", { n: c.withheld })}</p>
          </CDFAlert>
        </div>
      ) : null}
      {v.status === "GENERATED" && v.format === "EMAIL" ? (
        // F7: an email the relay did not accept stays generated; recording a delivery made another way waits.
        <div className="mb-4">
          <CDFAlert tone="info" title={t("exports.notice.undeliveredTitle")} testId="export-undelivered">
            <p>{t("exports.notice.undelivered")}</p>
          </CDFAlert>
        </div>
      ) : null}
    </>
  );
}

/** The stage that waits, its total, and whether the case's authority still has to consent. */
function waiting(v: ExportRequestView) {
  const total = Math.max(v.approvalsRequired ?? 0, v.current.approvalsRequired);
  const authorityPending =
    (v.authorityApprovalRequired || v.current.authorityApprovalRequired) && v.authorityDecision === null;
  return { stage: v.current.nextStage, total, authorityPending };
}

function nowText(t: Translator, v: ExportRequestView): string {
  switch (v.status) {
    case "DRAFT":
      return t("exports.now.DRAFT");
    case "SUBMITTED": {
      const w = waiting(v);
      if (w.stage === null) return t("exports.now.SUBMITTED_AUTHORITY");
      const stage = t("exports.now.SUBMITTED", { stage: w.stage, total: Math.max(w.total, w.stage) });
      return w.authorityPending ? `${stage} ${t("exports.now.authorityPending")}` : stage;
    }
    case "APPROVED":
      return t("exports.now.APPROVED", { date: when(t, v.decidedAt ?? v.updatedAt) });
    case "GENERATED":
      return t("exports.now.GENERATED", { date: when(t, v.generatedAt ?? v.updatedAt) });
    case "SENT":
      return t("exports.now.SENT", { date: when(t, v.sentAt ?? v.updatedAt) });
    case "REJECTED":
      return t("exports.now.REJECTED", { date: when(t, v.decidedAt ?? v.updatedAt) });
    case "CANCELLED":
      return t("exports.now.CANCELLED", { date: when(t, v.cancelledAt ?? v.updatedAt) });
  }
}

function nextText(t: Translator, v: ExportRequestView, me: string, name: Name): string {
  switch (v.status) {
    case "DRAFT":
      return v.requestedBy === me
        ? t("exports.next.you")
        : t("exports.next.requester", { name: name(v.requestedBy) });
    case "SUBMITTED": {
      if (v.current.authorityConsentBlocked) return t("exports.next.blocked");
      const w = waiting(v);
      if (w.stage === null) return t("exports.next.authority");
      return w.authorityPending
        ? t("exports.next.approversAndAuthority", { stage: w.stage })
        : t("exports.next.approvers", { stage: w.stage });
    }
    case "APPROVED":
      // F6: a PDF or spreadsheet file is generated from a later phase; the approval stays valid until then.
      return v.format === "EMAIL" ? t("exports.next.generate") : t("exports.next.fileLater");
    case "GENERATED":
      return v.format === "EMAIL" ? t("exports.next.recordSentLater") : t("exports.next.none");
    default:
      return t("exports.next.none");
  }
}

function youText(t: Translator, v: ExportRequestView, me: string): string {
  const c = v.capabilities;
  const stage = v.current.nextStage ?? 1;
  if (c.maySubmit) return t("exports.you.submit");
  if (c.mayAddItem || c.mayAddRecipient) return t("exports.you.prepare");
  if (c.mayApprove) return t("exports.you.approve", { stage });
  if (c.mayReject) return t("exports.you.rejectOnly", { stage });
  if (c.mayAuthorityApprove || c.mayAuthorityReject) return t("exports.you.authority");
  if (c.mayGenerate && v.format === "EMAIL") return t("exports.you.generate");
  if (v.requestedBy === me) return t("exports.you.requester");
  return t("exports.you.reader");
}

/**
 * Where the export stands: prepared, approved, generated and, for an email, sent; who acts next; and what the reader
 * can do now. The acts taken on what the export holds (submitting, deciding, consenting) are taken on the preview,
 * so the guide's button opens it.
 */
function Guide({
  t,
  v,
  me,
  name,
  preview,
}: {
  t: Translator;
  v: ExportRequestView;
  me: string;
  name: Name;
  preview: boolean;
}) {
  const c = v.capabilities;
  const onPreview =
    preview && (c.maySubmit || c.mayApprove || c.mayReject || c.mayAuthorityApprove || c.mayAuthorityReject);
  const canAct =
    onPreview || c.mayAddItem || c.mayAddRecipient || c.mayCancel || (c.mayGenerate && v.format === "EMAIL");
  return (
    <CDFWorkflowGuide
      id="export-guide"
      testId="export-guide"
      title={t("exports.guide.title")}
      trackerLabel={t("exports.guide.tracker")}
      steps={exportSteps(v).map((s) => ({
        code: s,
        label: t(`exports.steps.${s}` as MessageKey),
        state: stepState(v, s),
      }))}
      current={currentStep(v)}
      stateLabels={{
        done: t("cases.stepDone"),
        current: t("cases.stepCurrent"),
        upcoming: t("cases.stepUpcoming"),
        skipped: t("caseWorkspace.stepSkipped"),
      }}
      now={<span data-testid="export-now">{nowText(t, v)}</span>}
      nextActor={<span data-testid="export-next">{nextText(t, v, me, name)}</span>}
      you={youText(t, v, me)}
      canAct={canAct}
      labels={{
        now: t("exports.guide.now"),
        nextActor: t("exports.guide.next"),
        you: t("exports.guide.you"),
      }}
    >
      {onPreview ? (
        <Link
          href={`/exports/${v.requestId}/preview`}
          prefetch={false}
          className={buttonClass("primary")}
          data-testid="export-guide-preview"
        >
          {t("exports.openPreviewToAct")}
        </Link>
      ) : null}
    </CDFWorkflowGuide>
  );
}

/** What the export is for and who asked for it, with the governed purpose and where it comes from (DEC-F21). */
function Summary({ t, page, name }: { t: Translator; page: ExportRequestPage; name: Name }) {
  const v = page.view;
  const p = page.purpose;
  const terms: { term: string; value: ReactNode }[] = [
    {
      term: t("exports.formatLabel"),
      value: <span data-testid="export-format">{t(`exports.format.${v.format}` as MessageKey)}</span>,
    },
    {
      term: t("exports.audienceLabel"),
      value: <span data-testid="export-audience">{t(`exports.audience.${v.audience}` as MessageKey)}</span>,
    },
    {
      term: t("exports.purposeLabel"),
      value: p ? (
        <span className="grid gap-1">
          <CDFConfiguredValue
            value={
              <bdi dir="auto" data-testid="export-purpose">
                {purposeName(t, p, v.purpose)}
              </bdi>
            }
            source={SOURCE[p.sourceStatus]}
            sourceLabel={sourceLabel(t, p.sourceStatus)}
            testId="export-purpose-source"
          />
          {p.isLegacy ? (
            <span className="text-sm text-cdf-text-secondary" data-testid="export-purpose-legacy">
              {t("exports.legacyPurpose")}
            </span>
          ) : null}
        </span>
      ) : (
        <CDFIdentifier testId="export-purpose">{v.purpose}</CDFIdentifier>
      ),
    },
  ];
  if (v.externalParty)
    terms.push({
      term: t("exports.externalPartyLabel"),
      value: (
        <bdi dir="auto" data-testid="export-external-party">
          {v.externalParty}
        </bdi>
      ),
    });
  terms.push({
    term: t("exports.justificationLabel"),
    value: v.justification ? (
      <bdi dir="auto" className="whitespace-pre-wrap break-words" data-testid="export-justification">
        {v.justification}
      </bdi>
    ) : (
      t("exports.noJustification")
    ),
  });
  if (v.caseId && v.caseNumber)
    terms.push({
      term: t("exports.caseLabel"),
      value: (
        <Link href={`/cases/${v.caseId}`} className="underline underline-offset-4" data-testid="export-case">
          <CDFIdentifier>{v.caseNumber}</CDFIdentifier>
        </Link>
      ),
    });
  terms.push(
    {
      term: t("exports.requestedByLabel"),
      value: <bdi data-testid="export-requested-by">{name(v.requestedBy)}</bdi>,
    },
    { term: t("exports.createdLabel"), value: when(t, v.createdAt) },
  );
  if (v.submittedAt) terms.push({ term: t("exports.submittedLabel"), value: when(t, v.submittedAt) });
  if (v.classificationAtSubmit)
    terms.push({
      term: t("exports.classificationLabel"),
      value: (
        <span data-testid="export-classification">
          {t(`classification.${v.classificationAtSubmit}` as MessageKey)}
        </span>
      ),
    });
  if (v.approvalsRequired !== null)
    terms.push({
      term: t("exports.approvalsRequiredLabel"),
      value: <span data-testid="export-approvals-required">{approvalsText(t, v)}</span>,
    });
  if (v.decidedAt) terms.push({ term: t("exports.decidedLabel"), value: when(t, v.decidedAt) });
  if (v.generatedAt) terms.push({ term: t("exports.generatedLabel"), value: when(t, v.generatedAt) });
  if (v.sentAt) terms.push({ term: t("exports.sentLabel"), value: when(t, v.sentAt) });
  if (v.cancelledAt) terms.push({ term: t("exports.cancelledLabel"), value: when(t, v.cancelledAt) });
  return (
    <CDFCard title={t("exports.requestTitle")} testId="export-request">
      <CDFDescriptionList items={terms} />
    </CDFCard>
  );
}

function approvalsText(t: Translator, v: ExportRequestView): string {
  const n = v.approvalsRequired ?? 0;
  const approvals = n === 0 ? t("exports.noApprovalNeeded") : t("exports.approvalsCount", { n });
  return v.authorityApprovalRequired ? `${approvals} ${t("exports.andAuthority")}` : approvals;
}

/**
 * What it holds: each item's kind, its place and who added it, never its content (the preview shows that). The
 * requester adds the case summary here while the export is a draft; the other kinds wait for their candidate read (F9).
 */
function Items({ t, v, name }: { t: Translator; v: ExportRequestView; name: Name }) {
  const items = [...v.items].sort((a, b) => a.position - b.position);
  const canAddSummary =
    v.capabilities.mayAddItem && v.caseId !== null && !items.some((i) => i.objectType === "CASE_SUMMARY");
  return (
    <CDFCard title={t("exports.itemsTitle")} testId="export-items">
      <p className="mb-3 text-sm text-cdf-text-secondary">{t("exports.itemsIntro")}</p>
      {items.length > 0 ? (
        <ol className="grid gap-3">
          {items.map((i) => (
            <li
              key={i.itemId}
              className="border-b border-cdf-border pb-3 last:border-0 last:pb-0"
              data-testid={`export-item-${i.position}`}
              data-included={i.included ? "true" : "false"}
            >
              <h3 className="font-semibold">
                {t("exports.itemHeading", { n: i.position, kind: itemKind(t, i) })}
              </h3>
              <p className="text-sm text-cdf-text-secondary">
                {t("exports.addedBy", { name: name(i.addedBy), date: when(t, i.addedAt) })}
              </p>
              {i.included ? null : (
                <p className="text-sm" data-testid={`export-item-${i.position}-withheld`}>
                  {t("exports.itemWithheld")}
                </p>
              )}
            </li>
          ))}
        </ol>
      ) : (
        <p data-testid="export-no-items">{t("exports.noItems")}</p>
      )}
      {canAddSummary && v.caseId ? (
        <section aria-labelledby="export-add-summary-title" className="mt-4 border-t border-cdf-border pt-3">
          <h3 id="export-add-summary-title" className="mb-2 font-semibold">
            {t("exports.addSummaryTitle")}
          </h3>
          <p className="mb-3 text-sm text-cdf-text-secondary">{t("exports.addSummaryIntro")}</p>
          <CDFCommandForm
            action={addCaseSummaryAction.bind(null, v.requestId, v.caseId)}
            locale={t.locale}
            submitLabel={t("exports.addSummary")}
            variant="secondary"
            testId="export-add-summary"
            successMessage={t("exports.summaryAdded")}
            codeSections={EXPORT_CODES}
          />
        </section>
      ) : null}
      {v.capabilities.mayAddItem ? (
        <p className="mt-3 text-sm text-cdf-text-secondary" data-testid="export-other-items-later">
          {t("exports.otherItemsLater")}
        </p>
      ) : null}
    </CDFCard>
  );
}

/**
 * Who an email export goes to, each address exactly as it will be used (AMB-187). The requester adds an external
 * address, typed twice, while the export is a draft; internal recipients wait for their candidate read (F9).
 */
function Recipients({ t, page, name }: { t: Translator; page: ExportRequestPage; name: Name }) {
  const v = page.view;
  const configured = page.approvedDomains === "CONFIGURED";
  return (
    <CDFCard title={t("exports.recipientsTitle")} testId="export-recipients">
      {v.recipients.length > 0 ? (
        <ol className="mb-3 grid gap-3">
          {v.recipients.map((r, k) => (
            <li
              key={r.recipientId}
              className="border-b border-cdf-border pb-3 last:border-0 last:pb-0"
              data-testid={`export-recipient-${k + 1}`}
              data-kind={r.kind}
            >
              <p className="font-semibold">
                {r.kind === "EXTERNAL" && r.email ? (
                  <bdi dir="ltr" className="break-all" data-testid={`export-recipient-${k + 1}-address`}>
                    {r.email}
                  </bdi>
                ) : (
                  <bdi>{r.userId ? name(r.userId) : t("exports.anAccount")}</bdi>
                )}
              </p>
              <p className="text-sm text-cdf-text-secondary">
                {t(r.kind === "EXTERNAL" ? "exports.recipientExternal" : "exports.recipientInternal")} ·{" "}
                {t("exports.addedBy", { name: name(r.addedBy), date: when(t, r.addedAt) })}
              </p>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mb-3" data-testid="export-no-recipients">
          {t("exports.noRecipients")}
        </p>
      )}
      <CDFDescriptionList
        items={[
          {
            term: t("exports.domainsLabel"),
            value: (
              <CDFConfiguredValue
                value={t(configured ? "exports.domainsConfigured" : "exports.domainsNotConfigured")}
                source={configured ? "CONFIGURED" : "SOURCE_REQUIRED"}
                sourceLabel={t(
                  configured
                    ? "caseStructure.ruleSource.APPROVED"
                    : "caseStructure.ruleSource.SOURCE_REQUIRED",
                )}
                testId="export-domains"
              />
            ),
          },
        ]}
      />
      {v.capabilities.mayAddRecipient && v.audience === "EXTERNAL" ? (
        <AddRecipient t={t} v={v} />
      ) : v.capabilities.mayAddRecipient ? (
        <p className="mt-3 text-sm" data-testid="export-internal-recipients-later">
          {t("exports.internalRecipientsLater")}
        </p>
      ) : null}
    </CDFCard>
  );
}

function AddRecipient({ t, v }: { t: Translator; v: ExportRequestView }) {
  return (
    <section aria-labelledby="export-add-recipient-title" className="mt-4 border-t border-cdf-border pt-3">
      <h3 id="export-add-recipient-title" className="mb-2 font-semibold">
        {t("exports.addRecipientTitle")}
      </h3>
      <p className="mb-3 text-sm text-cdf-text-secondary">{t("exports.addRecipientIntro")}</p>
      <CDFCommandForm
        action={addExternalRecipientAction.bind(null, v.requestId)}
        locale={t.locale}
        submitLabel={actLabel(t, "addExternalRecipient")}
        variant="secondary"
        testId="export-add-recipient"
        successMessage={t("exports.recipientAdded")}
        codeSections={EXPORT_CODES}
        fieldLabels={{
          email: t("exports.emailLabel"),
          emailConfirmation: t("exports.emailConfirmationLabel"),
        }}
        confirm={confirmation(t, "addExternalRecipient")}
      >
        <CDFField
          id="export-recipient-email"
          label={t("exports.emailLabel")}
          hint={t("exports.emailHint")}
          requiredLabel={t("common.required")}
        >
          <input
            id="export-recipient-email"
            name="email"
            type="email"
            dir="ltr"
            autoComplete="off"
            spellCheck={false}
            className={inputClass}
            required
            maxLength={254}
            aria-describedby="export-recipient-email-hint"
            data-testid="export-recipient-email"
          />
        </CDFField>
        <CDFField
          id="export-recipient-email-confirmation"
          label={t("exports.emailConfirmationLabel")}
          hint={t("exports.emailConfirmationHint")}
          requiredLabel={t("common.required")}
        >
          <input
            id="export-recipient-email-confirmation"
            name="emailConfirmation"
            type="email"
            dir="ltr"
            autoComplete="off"
            spellCheck={false}
            className={inputClass}
            required
            maxLength={254}
            aria-describedby="export-recipient-email-confirmation-hint"
            data-testid="export-recipient-email-confirmation"
          />
        </CDFField>
      </CDFCommandForm>
    </section>
  );
}

/** Each approval stage as decided, then the restricted case's authority's decision, kept apart (DEC-F23). */
function Approvals({ t, v, name }: { t: Translator; v: ExportRequestView; name: Name }) {
  const total = Math.max(v.approvalsRequired ?? 0, v.approvals.length);
  const authority = v.authorityApprovalRequired || v.authorityDecision !== null;
  return (
    <CDFCard title={t("exports.approvalsTitle")} testId="export-approvals">
      {v.approvalsRequired === null ? (
        <p data-testid="export-approvals-at-submit">{t("exports.approvalsAtSubmit")}</p>
      ) : total === 0 ? (
        <p data-testid="export-no-approval">{t("exports.noApprovalNeededLong")}</p>
      ) : (
        <ol className="grid gap-3">
          {Array.from({ length: total }, (_, k) => k + 1).map((stage) => {
            const a = v.approvals.find((x) => x.stage === stage);
            return (
              <li
                key={stage}
                className="border-b border-cdf-border pb-3 last:border-0 last:pb-0"
                data-testid={`export-stage-${stage}`}
                data-decision={a?.decision ?? "NONE"}
              >
                <h3 className="font-semibold">{t("exports.stageTitle", { stage })}</h3>
                {a ? (
                  <>
                    <p className="text-sm text-cdf-text-secondary">
                      {t(`exports.stageDecided.${a.decision}` as MessageKey, {
                        name: name(a.approverId),
                        date: when(t, a.decidedAt),
                      })}
                    </p>
                    <p className="mt-1 whitespace-pre-wrap break-words">
                      <bdi dir="auto">{a.reason}</bdi>
                    </p>
                  </>
                ) : (
                  <p className="text-sm">
                    {t(v.status === "SUBMITTED" ? "exports.stageWaiting" : "exports.stageNotGiven")}
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {authority ? (
        <section
          aria-labelledby="export-authority-title"
          className="mt-4 border-t border-cdf-border pt-3"
          data-testid="export-authority-decision"
          data-decision={v.authorityDecision?.decision ?? "NONE"}
        >
          <h3 id="export-authority-title" className="font-semibold">
            {t("exports.authorityTitle")}
          </h3>
          {v.authorityDecision ? (
            <>
              <p className="text-sm text-cdf-text-secondary">
                {t(`exports.authorityDecided.${v.authorityDecision.decision}` as MessageKey, {
                  name: name(v.authorityDecision.decidedBy),
                  date: when(t, v.authorityDecision.decidedAt),
                })}
              </p>
              <p className="mt-1 whitespace-pre-wrap break-words">
                <bdi dir="auto">{v.authorityDecision.reason}</bdi>
              </p>
            </>
          ) : (
            <p className="text-sm">
              {t(v.status === "SUBMITTED" ? "exports.authorityWaiting" : "exports.authorityNotGiven")}
            </p>
          )}
        </section>
      ) : null}
    </CDFCard>
  );
}

/** The rules that applied at submission, each with what it does and where it comes from (all SOURCE_REQUIRED now). */
function Rules({ t, page }: { t: Translator; page: ExportRequestPage }) {
  const v = page.view;
  if (v.status === "DRAFT")
    return (
      <CDFCard title={t("exports.rulesTitle")} testId="export-rules">
        <p>{t("exports.rulesInPreview")}</p>
      </CDFCard>
    );
  return (
    <CDFCard title={t("exports.rulesTitle")} testId="export-rules">
      {v.matchedRules.length > 0 ? (
        <ul className="grid gap-2">
          {v.matchedRules.map((code) => {
            const rule = page.rules.find((r) => r.code === code);
            return (
              <li key={code} data-testid={`export-rule-${code}`}>
                {rule ? (
                  <CDFConfiguredValue
                    value={`${ruleName(t, code)}: ${t(`exports.ruleAction.${rule.action}` as MessageKey)}`}
                    source={SOURCE[rule.sourceStatus]}
                    sourceLabel={sourceLabel(t, rule.sourceStatus)}
                  />
                ) : (
                  ruleName(t, code)
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p data-testid="export-no-rules">{t("exports.noRules")}</p>
      )}
    </CDFCard>
  );
}

/** The preview, on a page of its own: opening it is recorded, so it is never prefetched. */
function PreviewLink({ t, v }: { t: Translator; v: ExportRequestView }) {
  return (
    <CDFCard title={t("exports.previewCardTitle")} testId="export-preview">
      <p className="mb-3 text-sm text-cdf-text-secondary">{t("exports.previewIntro")}</p>
      <Link
        href={`/exports/${v.requestId}/preview`}
        prefetch={false}
        className="font-semibold underline underline-offset-4"
        data-testid="export-preview-link"
      >
        {t("exports.openPreview")}
      </Link>
    </CDFCard>
  );
}

/**
 * Generation, for the requester once every approval is given (the view's may_generate). An email export is generated
 * and handed to the mail relay here; a PDF or spreadsheet file waits for its renderer (F6), and the page says so.
 */
function Generate({ t, v }: { t: Translator; v: ExportRequestView }) {
  if (!v.capabilities.mayGenerate) return null;
  if (v.format !== "EMAIL")
    return (
      <CDFAlert tone="info" title={t("exports.generateTitle")} testId="export-generate-later">
        <p>{t("exports.generateLater")}</p>
      </CDFAlert>
    );
  return (
    <CDFCard title={t("exports.generateTitle")} testId="export-generate">
      <p className="mb-3 text-sm text-cdf-text-secondary">{t("exports.generateIntro")}</p>
      <CDFCommandForm
        action={generateExportAction.bind(null, v.requestId)}
        locale={t.locale}
        submitLabel={actLabel(t, "generateExport")}
        variant="primary"
        testId="export-generate-form"
        codeSections={EXPORT_CODES}
        confirm={confirmation(t, "generateExport")}
      />
    </CDFCard>
  );
}

function Cancel({ t, v }: { t: Translator; v: ExportRequestView }) {
  return (
    <CDFCard title={t("exports.cancelTitle")} testId="export-cancel">
      <p className="mb-3 text-sm text-cdf-text-secondary">{t("exports.cancelIntro")}</p>
      <CDFCommandForm
        action={cancelExportAction.bind(null, v.requestId)}
        locale={t.locale}
        submitLabel={actLabel(t, "cancelExport")}
        variant="danger"
        testId="export-cancel-form"
        codeSections={EXPORT_CODES}
        fieldLabels={{ reason: t("exports.cancelReasonLabel") }}
        confirm={confirmation(t, "cancelExport")}
      >
        <CDFField
          id="export-cancel-reason"
          label={t("exports.cancelReasonLabel")}
          hint={t("exports.reasonHint")}
          requiredLabel={t("common.required")}
        >
          <textarea
            id="export-cancel-reason"
            name="reason"
            className={textareaClass}
            required
            minLength={5}
            maxLength={2000}
            aria-describedby="export-cancel-reason-hint"
            data-testid="export-cancel-reason"
          />
        </CDFField>
      </CDFCommandForm>
    </CDFCard>
  );
}
