// The preview of an export «معاينة التصدير» (UX redesign Phase 12 P12-6b-1; ADR-026; DEC-F23, AMB-187): the only page
// that shows what an export holds. Opening it runs api.preview_export, which is recorded (EXPORT_PREVIEWED) and, for a
// draft, stores the hash a submission is bound to; so it is a page of its own, linked without prefetch, and it is run
// once per visit, before the view is read, so the view's may_submit answers for the preview the requester is reading.
// The database renders each item with the same predicates as its own reads: an item the reader may not see now is
// listed without its content. The reader acts here on exactly what they read: the requester submits it, an approver
// decides their stage and the restricted case's authority consents or refuses, each bound to this preview's hash, and
// the command compares it with the export as it stands. Anyone who may not see the export gets the same 404 as an id
// that names nothing, and the refusal is recorded.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ExportPreview, ExportRequestPage, ExportRequestView } from "@cdf/contracts";
import { type MessageKey, type Translator } from "@cdf/i18n";
import {
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
  textareaClass,
} from "@cdf/ui";
import { exportService, requireActor } from "@/server/container";
import { getTranslator } from "@/server/locale";
import { actLabel, confirmation, type ConfirmAct } from "../../../confirmations";
import { ExportItemContent } from "../../content";
import { EXPORT_CODES, SOURCE, purposeName, ruleName, sourceLabel } from "../../labels";
import { authorityDecideExportAction, decideExportAction, submitExportAction } from "./actions";

/** Unique translated title (WCAG 2.4.2, UX-082); never a case number or the export's content. */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("pageTitles.exportPreview") };
}

const UUID = /^[0-9a-f-]{36}$/i;

export default async function ExportPreviewPage({ params }: { params: Promise<{ requestId: string }> }) {
  const { requestId } = await params;
  if (!UUID.test(requestId)) notFound();
  const { actor, ctx } = await requireActor();
  const t = await getTranslator();
  const service = exportService();
  // Anyone the preview refuses, by role or by the database, gets the uniform 404; the service records the refusal.
  const result = await service.preview(ctx, actor, { requestId });
  if (!result.ok) {
    if ("fieldErrors" in result || result.error.kind === "NOT_FOUND" || result.error.kind === "FORBIDDEN")
      notFound();
    return (
      <CDFAlert
        tone="danger"
        title={t(`errors.title.${result.error.kind}` as MessageKey)}
        testId="export-preview-failed"
      >
        <p>
          {t("errors.withReference", {
            message: t(`errors.${result.error.kind}` as MessageKey),
            ref: result.error.correlationId,
          })}
        </p>
      </CDFAlert>
    );
  }
  const page = await service.view(ctx, requestId);
  if (!page) notFound();
  const preview = result.value;
  const v = page.view;
  const back = `/exports/${v.requestId}`;

  return (
    <>
      <CDFBreadcrumbs
        label={t("shell.breadcrumb")}
        items={[
          ...(v.caseId && v.caseNumber
            ? [
                { label: t("shell.area.CASES"), href: "/cases" },
                { label: <CDFIdentifier>{v.caseNumber}</CDFIdentifier>, href: `/cases/${v.caseId}` },
              ]
            : [{ label: t("shell.area.MY_WORK"), href: "/my-work" }]),
          { label: t("exports.breadcrumb"), href: back },
          { label: t("exports.previewBreadcrumb") },
        ]}
      />
      <CDFPageHeader
        title={t("exports.previewTitle")}
        actions={
          <CDFStatusBadge domain="exportRequest" status={v.status} testId="export-status">
            {t(`exports.status.${v.status}` as MessageKey)}
          </CDFStatusBadge>
        }
      />
      <CDFPurposeBanner
        title={t("exports.previewPurposeTitle")}
        purpose={t("exports.previewPurposeBody")}
        notShown={t("exports.previewPurposeNotShown")}
        testId="export-preview-banner"
      />

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="min-w-0">
          <Document t={t} page={page} preview={preview} />
          <Needs t={t} page={page} preview={preview} />
        </div>
        <div className="min-w-0">
          <Submit t={t} v={v} preview={preview} />
          <Decide t={t} v={v} preview={preview} />
          <AuthorityDecide t={t} v={v} preview={preview} />
          <p className="mt-4">
            <Link href={back} className="underline underline-offset-4" data-testid="export-preview-back">
              {t("exports.backToRequest")}
            </Link>
          </p>
        </div>
      </div>
    </>
  );
}

/** The document as the database rendered it for the reader: what it is, then each item in its place. */
function Document({ t, page, preview }: { t: Translator; page: ExportRequestPage; preview: ExportPreview }) {
  const d = preview.document;
  const items = [...d.items].sort((a, b) => a.position - b.position);
  const terms = [
    {
      term: t("exports.caseLabel"),
      value: <CDFIdentifier testId="export-document-case">{d.caseNumber}</CDFIdentifier>,
    },
    {
      term: t("exports.caseClassificationLabel"),
      value: (
        <span data-testid="export-document-classification">
          {t(`classification.${d.classification}` as MessageKey)}
        </span>
      ),
    },
    { term: t("exports.formatLabel"), value: t(`exports.format.${d.format}` as MessageKey) },
    { term: t("exports.audienceLabel"), value: t(`exports.audience.${d.audience}` as MessageKey) },
    {
      term: t("exports.purposeLabel"),
      value: <bdi dir="auto">{purposeName(t, page.purpose, d.purpose)}</bdi>,
    },
  ];
  if (d.externalParty)
    terms.push({ term: t("exports.externalPartyLabel"), value: <bdi dir="auto">{d.externalParty}</bdi> });
  return (
    <CDFCard title={t("exports.documentTitle")} testId="export-document">
      <div className="mb-4">
        <CDFDescriptionList items={terms} />
      </div>
      {items.length > 0 ? (
        <ol className="grid gap-4">
          {items.map((i) => (
            <ExportItemContent key={i.position} t={t} item={i} />
          ))}
        </ol>
      ) : (
        <p data-testid="export-document-empty">{t("exports.noItems")}</p>
      )}
    </CDFCard>
  );
}

/** What it needs now, from the same computation as the commands: approvals, the authority, the rules in force. */
function Needs({ t, page, preview }: { t: Translator; page: ExportRequestPage; preview: ExportPreview }) {
  const approvals =
    preview.approvalsRequired === 0
      ? t("exports.noApprovalNeeded")
      : t("exports.approvalsCount", { n: preview.approvalsRequired });
  return (
    <CDFCard title={t("exports.needsTitle")} testId="export-preview-needs">
      <CDFDescriptionList
        items={[
          {
            term: t("exports.approvalsRequiredLabel"),
            value: (
              <span data-testid="export-preview-approvals">
                {preview.authorityApprovalRequired ? `${approvals} ${t("exports.andAuthority")}` : approvals}
              </span>
            ),
          },
          {
            term: t("exports.withheldLabel"),
            value: <span data-testid="export-preview-withheld">{String(preview.withheld)}</span>,
          },
          {
            term: t("exports.hashLabel"),
            value: (
              <CDFIdentifier variant="hash" testId="export-preview-hash">
                {preview.hash}
              </CDFIdentifier>
            ),
          },
        ]}
      />
      <h3 className="mt-4 mb-2 font-semibold">{t("exports.rulesNowTitle")}</h3>
      {preview.matchedRules.length > 0 ? (
        <ul className="grid gap-2">
          {preview.matchedRules.map((m) => {
            const rule = page.rules.find((r) => r.code === m.code);
            const text = `${ruleName(t, m.code)}: ${t(`exports.ruleAction.${m.action}` as MessageKey)}`;
            return (
              <li key={m.code} data-testid={`export-preview-rule-${m.code}`}>
                {rule ? (
                  <CDFConfiguredValue
                    value={text}
                    source={SOURCE[rule.sourceStatus]}
                    sourceLabel={sourceLabel(t, rule.sourceStatus)}
                  />
                ) : (
                  text
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p data-testid="export-preview-no-rules">{t("exports.noRulesNow")}</p>
      )}
    </CDFCard>
  );
}

/**
 * The requester's submission, bound to this preview, with the case's classification as the preview shows it, which
 * they confirm (F11). Where the draft cannot be submitted yet, what it still needs, in words.
 */
function Submit({ t, v, preview }: { t: Translator; v: ExportRequestView; preview: ExportPreview }) {
  if (v.status !== "DRAFT") return null;
  if (!v.capabilities.maySubmit) {
    if (!v.capabilities.mayAddItem && !v.capabilities.mayAddRecipient && !v.capabilities.mayCancel)
      return null;
    const needs: MessageKey[] = [];
    if (v.items.length === 0) needs.push("exports.needs.items");
    if (v.format === "EMAIL" && v.recipients.length === 0) needs.push("exports.needs.recipients");
    if (preview.withheld > 0) needs.push("exports.needs.withheld");
    if (preview.matchedRules.some((m) => m.action === "REFUSE")) needs.push("exports.needs.refused");
    if (needs.length === 0) needs.push("exports.needs.other");
    return (
      <CDFAlert tone="info" title={t("exports.notYetTitle")} testId="export-submit-needs">
        <ul className="list-disc ps-5">
          {needs.map((k) => (
            <li key={k}>{t(k)}</li>
          ))}
        </ul>
      </CDFAlert>
    );
  }
  const level = t(`classification.${preview.document.classification}` as MessageKey);
  const consequence =
    preview.approvalsRequired === 0 && !preview.authorityApprovalRequired
      ? t("exports.submitApprovedAtOnce")
      : t("exports.submitToApprovers");
  return (
    <CDFCard title={t("exports.submitTitle")} testId="export-submit">
      <p className="mb-3 text-sm text-cdf-text-secondary" data-testid="export-submit-consequence">
        {consequence}
      </p>
      <CDFCommandForm
        action={submitExportAction.bind(null, v.requestId)}
        locale={t.locale}
        submitLabel={actLabel(t, "submitExport")}
        variant="primary"
        testId="export-submit-form"
        codeSections={EXPORT_CODES}
        fieldLabels={{ classificationConfirmed: t("exports.classificationConfirmLabel") }}
        confirm={confirmation(t, "submitExport")}
      >
        <input type="hidden" name="previewHash" value={preview.hash} />
        <input type="hidden" name="classification" value={preview.document.classification} />
        <div className="mb-4 flex items-start gap-2">
          <input
            id="export-submit-confirm"
            type="checkbox"
            name="classificationConfirmed"
            className="mt-1 size-5 shrink-0"
            required
            aria-describedby="export-submit-confirm-hint"
            data-testid="export-submit-confirm"
          />
          <div>
            <label htmlFor="export-submit-confirm">{t("exports.classificationConfirm", { level })}</label>
            <p id="export-submit-confirm-hint" className="text-sm text-cdf-text-secondary">
              {t("exports.classificationConfirmHint")}
            </p>
          </div>
        </div>
      </CDFCommandForm>
    </CDFCard>
  );
}

/** Why an approver may reject but not approve now: the same order as the command's checks. */
function approveClosed(v: ExportRequestView, preview: ExportPreview): MessageKey {
  if (preview.withheld > 0) return "exports.approveClosed.withheld";
  if (v.submittedHash !== null && preview.hash !== v.submittedHash) return "exports.approveClosed.changed";
  if (preview.matchedRules.some((m) => m.action === "REFUSE")) return "exports.approveClosed.refused";
  return "exports.approveClosed.other";
}

/** An approver's decision on their stage (the view's may_approve and may_reject), on exactly what this page shows. */
function Decide({ t, v, preview }: { t: Translator; v: ExportRequestView; preview: ExportPreview }) {
  const c = v.capabilities;
  if (!c.mayApprove && !c.mayReject) return null;
  const stage = v.current.nextStage ?? 1;
  return (
    <CDFCard title={t("exports.decideTitle", { stage })} testId="export-decide">
      <p className="mb-3 text-sm text-cdf-text-secondary">{t("exports.decideIntro")}</p>
      {c.mayApprove ? (
        <DecisionForm
          t={t}
          id="export-approve"
          act="approveExport"
          decision="APPROVE"
          action={decideExportAction.bind(null, v.requestId)}
          hash={preview.hash}
          variant="primary"
        />
      ) : (
        <p className="mb-3 text-sm" data-testid="export-approve-closed">
          {t(approveClosed(v, preview))}
        </p>
      )}
      {c.mayReject ? (
        <section aria-labelledby="export-reject-title" className="mt-4 border-t border-cdf-border pt-3">
          <h3 id="export-reject-title" className="mb-2 font-semibold">
            {t("exports.rejectTitle")}
          </h3>
          <DecisionForm
            t={t}
            id="export-reject"
            act="rejectExport"
            decision="REJECT"
            action={decideExportAction.bind(null, v.requestId)}
            hash={preview.hash}
            variant="danger"
          />
        </section>
      ) : null}
    </CDFCard>
  );
}

/** The restricted case's authority's consent or refusal (DEC-F23), apart from the approval stages. */
function AuthorityDecide({ t, v, preview }: { t: Translator; v: ExportRequestView; preview: ExportPreview }) {
  const c = v.capabilities;
  if (!c.mayAuthorityApprove && !c.mayAuthorityReject) return null;
  return (
    <CDFCard title={t("exports.authorityDecideTitle")} testId="export-authority-decide">
      <p className="mb-3 text-sm text-cdf-text-secondary">{t("exports.authorityDecideIntro")}</p>
      {c.mayAuthorityApprove ? (
        <DecisionForm
          t={t}
          id="export-consent"
          act="consentToExport"
          decision="APPROVE"
          action={authorityDecideExportAction.bind(null, v.requestId)}
          hash={preview.hash}
          variant="primary"
        />
      ) : (
        <p className="mb-3 text-sm" data-testid="export-consent-closed">
          {t(approveClosed(v, preview))}
        </p>
      )}
      {c.mayAuthorityReject ? (
        <section aria-labelledby="export-refuse-title" className="mt-4 border-t border-cdf-border pt-3">
          <h3 id="export-refuse-title" className="mb-2 font-semibold">
            {t("exports.refuseTitle")}
          </h3>
          <DecisionForm
            t={t}
            id="export-refuse"
            act="refuseExport"
            decision="REJECT"
            action={authorityDecideExportAction.bind(null, v.requestId)}
            hash={preview.hash}
            variant="danger"
          />
        </section>
      ) : null}
    </CDFCard>
  );
}

function DecisionForm({
  t,
  id,
  act,
  decision,
  action,
  hash,
  variant,
}: {
  t: Translator;
  id: string;
  act: ConfirmAct;
  decision: "APPROVE" | "REJECT";
  action: Parameters<typeof CDFCommandForm>[0]["action"];
  hash: string;
  variant: "primary" | "danger";
}) {
  return (
    <CDFCommandForm
      action={action}
      locale={t.locale}
      submitLabel={actLabel(t, act)}
      variant={variant}
      testId={`${id}-form`}
      codeSections={EXPORT_CODES}
      fieldLabels={{ reason: t("exports.decisionReasonLabel") }}
      confirm={confirmation(t, act)}
    >
      <input type="hidden" name="decision" value={decision} />
      <input type="hidden" name="previewHash" value={hash} />
      <CDFField
        id={`${id}-reason`}
        label={t("exports.decisionReasonLabel")}
        hint={t("exports.decisionReasonHint")}
        requiredLabel={t("common.required")}
      >
        <textarea
          id={`${id}-reason`}
          name="reason"
          className={textareaClass}
          required
          minLength={5}
          maxLength={2000}
          aria-describedby={`${id}-reason-hint`}
          data-testid={`${id}-reason`}
        />
      </CDFField>
    </CDFCommandForm>
  );
}
