// A continuity import «استيراد سجل الاستمرارية» (UX redesign Phase 12 P12-6b-1; ADR-034; DEC-F30, DEC-F31, AMB-205,
// AMB-210): a purpose route that reads api.bcp_import_batch_view (final 2110) and the directory names of the accounts it
// names. The batch's importer and, once it is submitted, the approvers who may see its case read the workbook row by
// row and where the import stands; anyone else, and an id that names nothing, gets the same 404, and the refusal is
// recorded (ACCESS_DENIED). The view gives row metadata only: never a cell, the control sheet or a row about the
// reader. Each form shows only where the view says its command would accept the caller now (UX-116) and the caller
// holds the role permission the service pre-checks; the command checks again. A committee workbook (BCP-C1) is shown
// read-only: it goes on only through its official record (ADR-061), whose pages come later.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { can } from "@cdf/authorization";
import {
  BCP_ROW_STATES,
  type BcpImportBatchPage,
  type BcpImportBatchView,
  type BcpImportRowView,
} from "@cdf/contracts";
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
  CDFWorkflowGuide,
  inputClass,
  textareaClass,
} from "@cdf/ui";
import { bcpImportService, requireActor } from "@/server/container";
import { getTranslator } from "@/server/locale";
import { actLabel, confirmation, type ConfirmAct } from "../../../confirmations";
import {
  BCP_CODES,
  BCP_STEPS,
  currentStep,
  detailText,
  outcomeText,
  personName,
  sheetName,
  stepState,
  throughOfficialRecord,
  unresolved,
  when,
} from "../labels";
import {
  applyBcpAction,
  cancelBcpAction,
  decideBcpAction,
  dryRunAction,
  skipRowAction,
  submitBcpAction,
} from "./actions";

/** Unique translated title (WCAG 2.4.2, UX-082); never a case number, a workbook id or a row. */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("pageTitles.continuityImport") };
}

const UUID = /^[0-9a-f-]{36}$/i;

/** What the page says after a command that moved the batch on sent the caller back here. */
const DONE = ["submitted", "approved", "rejected", "imported", "cancelled"] as const;

type Name = (userId: string) => string;

/** What the reader may do on this page now: the view's flag for each command and the role the service pre-checks. */
interface May {
  skip: boolean;
  dryRun: boolean;
  submit: boolean;
  approve: boolean;
  reject: boolean;
  apply: boolean;
  cancel: boolean;
}

export default async function ContinuityImportPage({
  params,
  searchParams,
}: {
  params: Promise<{ batchId: string }>;
  searchParams: Promise<{ done?: string }>;
}) {
  const { batchId } = await params;
  if (!UUID.test(batchId)) notFound();
  const { actor, ctx } = await requireActor();
  const t = await getTranslator();
  const page = await bcpImportService().view(ctx, batchId);
  if (!page) notFound();
  const doneParam = (await searchParams).done;
  const done = DONE.find((d) => d === doneParam) ?? null;
  const v = page.view;
  const me = actor.userId;
  const name: Name = (userId) => personName(t, page.people, userId, me);
  // A committee workbook goes on only through its official record (ADR-061), whose pages come later: read-only here.
  const caseBatch = v.scope === "CASE";
  const importer = caseBatch && can(actor, "BCP_IMPORT");
  const approver = caseBatch && can(actor, "BCP_IMPORT_APPROVE");
  const c = v.capabilities;
  const skippable = v.rows.filter((r) => r.maySkip && r.resolution !== "SKIP");
  const may: May = {
    skip: importer && c.mayResolveRows && skippable.length > 0,
    // The dry run stores the preview a submission needs only while the batch is staged; later it changes nothing.
    dryRun: importer && c.mayPreview && v.status === "STAGED",
    submit: importer && c.maySubmit && v.previewHash !== null,
    approve: approver && c.mayApprove && v.submittedHash !== null,
    reject: approver && c.mayDecide && v.submittedHash !== null,
    apply: importer && c.mayApply && v.submittedHash !== null,
    cancel: importer && c.mayCancel,
  };

  return (
    <>
      <CDFBreadcrumbs
        label={t("shell.breadcrumb")}
        items={
          v.caseId && v.caseNumber
            ? [
                { label: t("shell.area.CASES"), href: "/cases" },
                { label: <CDFIdentifier>{v.caseNumber}</CDFIdentifier>, href: `/cases/${v.caseId}` },
                { label: t("continuityImports.breadcrumb") },
              ]
            : [
                { label: t("shell.area.MY_WORK"), href: "/my-work" },
                { label: t("continuityImports.breadcrumb") },
              ]
        }
      />
      <CDFPageHeader
        title={t("continuityImports.title")}
        actions={
          <CDFStatusBadge domain="bcpImport" status={v.status} testId="bcp-status">
            {t(`continuityImports.status.${v.status}` as MessageKey)}
          </CDFStatusBadge>
        }
      />
      {done ? (
        <div className="mb-4">
          <CDFAlert tone="success" testId="bcp-done">
            {t(`continuityImports.done.${done}` as MessageKey)}
          </CDFAlert>
        </div>
      ) : null}
      <CDFPurposeBanner
        title={t("continuityImports.purposeTitle")}
        purpose={t("continuityImports.purposeBody")}
        notShown={t("continuityImports.purposeNotShown")}
        testId="bcp-purpose-banner"
      />
      <Notices t={t} v={v} />
      <Guide t={t} v={v} me={me} name={name} may={may} approver={approver} />

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="min-w-0">
          <Summary t={t} page={page} name={name} />
          <Counts t={t} v={v} />
        </div>
        {/* The guide's "go to the actions" lands here: every control but skipping a row is in this column. */}
        <div className="min-w-0" id="bcp-act">
          {may.dryRun ? <DryRun t={t} v={v} /> : null}
          {may.submit ? (
            <Submit t={t} v={v} />
          ) : importer && caseBatch && v.status === "STAGED" && c.mayPreview ? (
            <SubmitNeeds t={t} v={v} />
          ) : null}
          {may.approve || may.reject ? <Decide t={t} v={v} may={may} /> : null}
          {may.apply ? <Apply t={t} v={v} /> : null}
          {may.cancel ? <Cancel t={t} v={v} /> : null}
        </div>
      </div>
      <Rows t={t} v={v} name={name} skippable={may.skip ? skippable : []} />
    </>
  );
}

/** What holds the import now, in words: none of these is a command, each explains what the database decided. */
function Notices({ t, v }: { t: Translator; v: BcpImportBatchView }) {
  const open = v.status === "STAGED" || v.status === "SUBMITTED" || v.status === "APPROVED";
  const changed =
    (v.status === "SUBMITTED" || v.status === "APPROVED") &&
    v.submittedHash !== null &&
    v.currentHash !== v.submittedHash;
  return (
    <>
      {open && v.workbookRevoked ? (
        // AMB-205: a workbook reported lost is never approved or imported; rejecting or cancelling remains.
        <div className="mb-4">
          <CDFAlert tone="warning" title={t("continuityImports.notice.revokedTitle")} testId="bcp-revoked">
            <p>{t("continuityImports.notice.revoked")}</p>
          </CDFAlert>
        </div>
      ) : null}
      {v.officialRecordRequired ? (
        // AMB-201 (2110, 3.3; ADR-061): a committee workbook goes on only through its official record, which has no
        // page yet.
        <div className="mb-4">
          <CDFAlert
            tone="info"
            title={t("continuityImports.notice.officialRecordTitle")}
            testId="bcp-official-record"
          >
            <p>{t("continuityImports.notice.officialRecord")}</p>
          </CDFAlert>
        </div>
      ) : null}
      {changed ? (
        <div className="mb-4">
          <CDFAlert tone="warning" title={t("continuityImports.notice.changedTitle")} testId="bcp-changed">
            <p>{t("continuityImports.notice.changed")}</p>
          </CDFAlert>
        </div>
      ) : null}
    </>
  );
}

function nowText(t: Translator, v: BcpImportBatchView): string {
  switch (v.status) {
    case "STAGED":
      return t("continuityImports.now.STAGED", { date: when(t, v.createdAt) });
    case "SUBMITTED":
      return t("continuityImports.now.SUBMITTED", { date: when(t, v.submittedAt ?? v.updatedAt) });
    case "APPROVED":
      return t("continuityImports.now.APPROVED", { date: when(t, v.decidedAt ?? v.updatedAt) });
    case "IMPORTED":
      return t("continuityImports.now.IMPORTED", { date: when(t, v.appliedAt ?? v.updatedAt) });
    case "REJECTED":
      return t("continuityImports.now.REJECTED", { date: when(t, v.decidedAt ?? v.updatedAt) });
    case "CANCELLED":
      return t("continuityImports.now.CANCELLED", { date: when(t, v.cancelledAt ?? v.updatedAt) });
  }
}

function nextText(t: Translator, v: BcpImportBatchView, me: string, name: Name): string {
  const mine = v.importedBy === me;
  if (throughOfficialRecord(v)) return t("continuityImports.next.officialRecord");
  switch (v.status) {
    case "STAGED":
      if (v.workbookRevoked)
        return mine
          ? t("continuityImports.next.youCancel")
          : t("continuityImports.next.importerCancel", { name: name(v.importedBy) });
      return mine
        ? t("continuityImports.next.youPrepare")
        : t("continuityImports.next.importer", { name: name(v.importedBy) });
    case "SUBMITTED":
      return t(
        v.workbookRevoked ? "continuityImports.next.approverReject" : "continuityImports.next.approver",
      );
    case "APPROVED":
      if (v.workbookRevoked)
        return mine
          ? t("continuityImports.next.youCancel")
          : t("continuityImports.next.importerCancel", { name: name(v.importedBy) });
      return mine
        ? t("continuityImports.next.youImport")
        : t("continuityImports.next.importer", { name: name(v.importedBy) });
    default:
      return t("continuityImports.next.none");
  }
}

function youText(t: Translator, v: BcpImportBatchView, me: string, may: May, approver: boolean): string {
  if (may.submit) return t("continuityImports.you.submit");
  if (may.skip || may.dryRun) return t("continuityImports.you.prepare");
  if (may.approve) return t("continuityImports.you.decide");
  if (may.reject) return t("continuityImports.you.rejectOnly");
  if (may.apply) return t("continuityImports.you.apply");
  if (may.cancel) return t("continuityImports.you.cancelOnly");
  // An approver the database keeps out of this batch, which has not changed since it was submitted: its preparer, or
  // anyone who recorded one of its rows (its importer reads the next line).
  if (approver && v.status === "SUBMITTED" && v.importedBy !== me && v.currentHash === v.submittedHash)
    return t("continuityImports.you.excluded");
  if (v.importedBy === me)
    return t(
      throughOfficialRecord(v) ? "continuityImports.you.officialRecord" : "continuityImports.you.importer",
    );
  return t("continuityImports.you.reader");
}

/** Where the import stands: prepared and submitted, approved, imported; who acts next; what the reader can do now. */
function Guide({
  t,
  v,
  me,
  name,
  may,
  approver,
}: {
  t: Translator;
  v: BcpImportBatchView;
  me: string;
  name: Name;
  may: May;
  approver: boolean;
}) {
  const canAct = Object.values(may).some(Boolean);
  return (
    <CDFWorkflowGuide
      id="bcp-guide"
      testId="bcp-guide"
      title={t("continuityImports.guide.title")}
      trackerLabel={t("continuityImports.guide.tracker")}
      steps={BCP_STEPS.map((s) => ({
        code: s,
        label: t(`continuityImports.steps.${s}` as MessageKey),
        state: stepState(v, s),
      }))}
      current={currentStep(v)}
      stateLabels={{
        done: t("cases.stepDone"),
        current: t("cases.stepCurrent"),
        upcoming: t("cases.stepUpcoming"),
        skipped: t("caseWorkspace.stepSkipped"),
      }}
      now={<span data-testid="bcp-now">{nowText(t, v)}</span>}
      nextActor={<span data-testid="bcp-next">{nextText(t, v, me, name)}</span>}
      you={youText(t, v, me, may, approver)}
      canAct={canAct}
      labels={{
        now: t("continuityImports.guide.now"),
        nextActor: t("continuityImports.guide.next"),
        you: t("continuityImports.guide.you"),
      }}
    >
      {canAct ? (
        <a href="#bcp-act" className="font-semibold underline underline-offset-4" data-testid="bcp-guide-act">
          {t("continuityImports.guide.goToActions")}
        </a>
      ) : null}
    </CDFWorkflowGuide>
  );
}

/** The workbook, its offline window and the people it names; the decision and its reason once given. */
function Summary({ t, page, name }: { t: Translator; page: BcpImportBatchPage; name: Name }) {
  const v = page.view;
  const configured = page.stagingRetention === "CONFIGURED";
  const terms: { term: string; value: ReactNode }[] = [
    {
      term: t("continuityImports.workbookLabel"),
      // A workbook id runs to 64 characters (BCP-…) or is a UUID: it wraps anywhere, so a phone never scrolls sideways.
      value: (
        <CDFIdentifier variant="hash" testId="bcp-workbook">
          {v.workbookId}
        </CDFIdentifier>
      ),
    },
    {
      term: t("continuityImports.templateLabel"),
      value: (
        <span data-testid="bcp-template">
          {t(`continuityImports.template.${v.scope}` as MessageKey)} (
          <CDFIdentifier>{v.templateVersion}</CDFIdentifier>)
        </span>
      ),
    },
  ];
  if (v.caseId && v.caseNumber)
    terms.push({
      term: t("continuityImports.caseLabel"),
      value: (
        <Link href={`/cases/${v.caseId}`} className="underline underline-offset-4" data-testid="bcp-case">
          <CDFIdentifier>{v.caseNumber}</CDFIdentifier>
        </Link>
      ),
    });
  terms.push(
    {
      term: t("continuityImports.offlineLabel"),
      value: (
        <span data-testid="bcp-offline">
          {v.offlineTo
            ? t("continuityImports.offlineWindow", { from: when(t, v.offlineFrom), to: when(t, v.offlineTo) })
            : t("continuityImports.offlineOpen", { from: when(t, v.offlineFrom) })}
        </span>
      ),
    },
    {
      term: t("continuityImports.preparedByLabel"),
      value: <bdi data-testid="bcp-prepared-by">{name(v.preparedBy)}</bdi>,
    },
    {
      term: t("continuityImports.importedByLabel"),
      value: <bdi data-testid="bcp-imported-by">{name(v.importedBy)}</bdi>,
    },
    { term: t("continuityImports.stagedLabel"), value: when(t, v.createdAt) },
  );
  if (v.status === "STAGED")
    terms.push({
      term: t("continuityImports.dryRunLabel"),
      value: (
        <span data-testid="bcp-dry-run-state">
          {v.previewedAt === null || v.previewHash !== v.currentHash
            ? t("continuityImports.dryRunNotCurrent")
            : t(v.previewClean ? "continuityImports.dryRunClean" : "continuityImports.dryRunRefused", {
                date: when(t, v.previewedAt),
              })}
        </span>
      ),
    });
  if (v.submittedAt)
    terms.push({ term: t("continuityImports.submittedLabel"), value: when(t, v.submittedAt) });
  if (v.decidedAt && v.decidedBy)
    terms.push({
      term: t("continuityImports.decisionLabel"),
      value: (
        <span className="grid gap-1" data-testid="bcp-decision">
          <span>
            {t(
              v.status === "REJECTED"
                ? "continuityImports.decidedRejected"
                : "continuityImports.decidedApproved",
              {
                name: name(v.decidedBy),
                date: when(t, v.decidedAt),
              },
            )}
          </span>
          {v.decisionReason ? (
            <bdi dir="auto" className="whitespace-pre-wrap break-words">
              {v.decisionReason}
            </bdi>
          ) : null}
        </span>
      ),
    });
  if (v.appliedAt) terms.push({ term: t("continuityImports.importedLabel"), value: when(t, v.appliedAt) });
  if (v.cancelledAt)
    terms.push({ term: t("continuityImports.cancelledLabel"), value: when(t, v.cancelledAt) });
  if (v.submittedHash)
    terms.push({
      term: t("continuityImports.boundToLabel"),
      value: (
        <CDFIdentifier variant="hash" testId="bcp-submitted-hash">
          {v.submittedHash}
        </CDFIdentifier>
      ),
    });
  terms.push(
    {
      term: t("continuityImports.fileLabel"),
      value: (
        <CDFIdentifier variant="hash" testId="bcp-file-sha256">
          {v.fileSha256}
        </CDFIdentifier>
      ),
    },
    {
      term: t("continuityImports.retentionLabel"),
      value: (
        // DEC-F31: no staging retention is invented; nothing staged is cleared until CDF sets it.
        <CDFConfiguredValue
          value={t(
            configured ? "continuityImports.retentionConfigured" : "continuityImports.retentionNotConfigured",
          )}
          source={configured ? "CONFIGURED" : "SOURCE_REQUIRED"}
          sourceLabel={t(
            configured ? "caseStructure.ruleSource.APPROVED" : "caseStructure.ruleSource.SOURCE_REQUIRED",
          )}
          testId="bcp-retention"
        />
      ),
    },
  );
  return (
    <CDFCard title={t("continuityImports.summaryTitle")} testId="bcp-summary">
      <CDFDescriptionList items={terms} />
    </CDFCard>
  );
}

/**
 * How many rows there are and how many still need a decision, by state. Counted over the rows the page lists, so the
 * totals never tell the reader about a row the view leaves out (R4: never a row about the reader).
 */
function Counts({ t, v }: { t: Translator; v: BcpImportBatchView }) {
  const states = BCP_ROW_STATES.map((s) => [s, v.rows.filter((r) => r.state === s).length] as const).filter(
    ([, n]) => n > 0,
  );
  const open = v.rows.filter(unresolved).length;
  return (
    <CDFCard title={t("continuityImports.countsTitle")} testId="bcp-counts">
      <CDFDescriptionList
        items={[
          {
            term: t("continuityImports.countRows"),
            value: <span data-testid="bcp-count-rows">{v.rows.length}</span>,
          },
          {
            term: t("continuityImports.countUnresolved"),
            value: <span data-testid="bcp-count-unresolved">{open}</span>,
          },
          ...states.map(([s, n]) => ({
            term: t(`continuityImports.state.${s}` as MessageKey),
            value: <span data-testid={`bcp-count-${s}`}>{n}</span>,
          })),
        ]}
      />
    </CDFCard>
  );
}

/** The importer's dry run: audited, and while staged it stores the preview a submission is bound to. */
function DryRun({ t, v }: { t: Translator; v: BcpImportBatchView }) {
  return (
    <CDFCard title={t("continuityImports.dryRunTitle")} testId="bcp-dry-run">
      <p className="mb-3 text-sm text-cdf-text-secondary">{t("continuityImports.dryRunIntro")}</p>
      <CDFCommandForm
        action={dryRunAction.bind(null, v.batchId)}
        locale={t.locale}
        submitLabel={t("continuityImports.runDryRun")}
        variant="secondary"
        testId="bcp-dry-run-form"
        successMessage={t("continuityImports.dryRunDone")}
        codeSections={BCP_CODES}
      />
    </CDFCard>
  );
}

/** Submitting, bound to the last clean dry run's hash: the approvers are then asked to decide. */
function Submit({ t, v }: { t: Translator; v: BcpImportBatchView }) {
  return (
    <CDFCard title={t("continuityImports.submitTitle")} testId="bcp-submit">
      <p className="mb-3 text-sm text-cdf-text-secondary">{t("continuityImports.submitIntro")}</p>
      <CDFCommandForm
        action={submitBcpAction.bind(null, v.batchId)}
        locale={t.locale}
        submitLabel={actLabel(t, "submitBcpImport")}
        variant="primary"
        testId="bcp-submit-form"
        codeSections={BCP_CODES}
        confirm={confirmation(t, "submitBcpImport")}
      >
        <input type="hidden" name="previewHash" value={v.previewHash ?? ""} />
      </CDFCommandForm>
    </CDFCard>
  );
}

/** Why the importer cannot submit yet, from the view: rows to decide, a dry run to run, refusals to skip. */
function SubmitNeeds({ t, v }: { t: Translator; v: BcpImportBatchView }) {
  const open = v.rows.filter(unresolved).length;
  const current = v.previewedAt !== null && v.previewHash === v.currentHash;
  const needs: MessageKey[] = [];
  if (v.workbookRevoked) needs.push("continuityImports.needs.revoked");
  else {
    if (open > 0) needs.push("continuityImports.needs.rows");
    if (!current) needs.push("continuityImports.needs.dryRun");
    else if (!v.previewClean) needs.push("continuityImports.needs.refused");
    if (needs.length === 0) needs.push("continuityImports.needs.other");
  }
  return (
    <CDFCard title={t("continuityImports.submitTitle")} testId="bcp-submit-needs">
      <p className="mb-2 text-sm text-cdf-text-secondary">{t("continuityImports.needsIntro")}</p>
      <ul className="grid list-disc gap-1 ps-5">
        {needs.map((k) => (
          <li key={k} data-testid={`bcp-needs-${k.split(".").pop()}`}>
            {t(k, { n: open })}
          </li>
        ))}
      </ul>
    </CDFCard>
  );
}

/**
 * An approver's decision, on the batch as submitted (F13: the approver decides on what each row is and what will
 * happen to it; the rows' content stays in the workbook and the case). APPROVE closes once the workbook is reported
 * lost (AMB-205); REJECT stays open.
 */
function Decide({ t, v, may }: { t: Translator; v: BcpImportBatchView; may: May }) {
  const hash = v.submittedHash ?? "";
  return (
    <CDFCard title={t("continuityImports.decideTitle")} testId="bcp-decide">
      <p className="mb-3 text-sm text-cdf-text-secondary">{t("continuityImports.decideIntro")}</p>
      {may.approve ? (
        <DecisionForm
          t={t}
          id="bcp-approve"
          act="approveBcpImport"
          decision="APPROVE"
          batchId={v.batchId}
          hash={hash}
          variant="primary"
        />
      ) : (
        <p className="mb-3 text-sm" data-testid="bcp-approve-closed">
          {t("continuityImports.approveClosed")}
        </p>
      )}
      {may.reject ? (
        <section aria-labelledby="bcp-reject-title" className="mt-4 border-t border-cdf-border pt-3">
          <h3 id="bcp-reject-title" className="mb-2 font-semibold">
            {t("continuityImports.rejectTitle")}
          </h3>
          <DecisionForm
            t={t}
            id="bcp-reject"
            act="rejectBcpImport"
            decision="REJECT"
            batchId={v.batchId}
            hash={hash}
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
  batchId,
  hash,
  variant,
}: {
  t: Translator;
  id: string;
  act: ConfirmAct;
  decision: "APPROVE" | "REJECT";
  batchId: string;
  hash: string;
  variant: "primary" | "danger";
}) {
  return (
    <CDFCommandForm
      action={decideBcpAction.bind(null, batchId)}
      locale={t.locale}
      submitLabel={actLabel(t, act)}
      variant={variant}
      testId={`${id}-form`}
      codeSections={BCP_CODES}
      fieldLabels={{ reason: t("continuityImports.decisionReasonLabel") }}
      confirm={confirmation(t, act)}
    >
      <input type="hidden" name="decision" value={decision} />
      <input type="hidden" name="previewHash" value={hash} />
      <CDFField
        id={`${id}-reason`}
        label={t("continuityImports.decisionReasonLabel")}
        hint={t("continuityImports.decisionReasonHint")}
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

/** The import itself: every approved row in one transaction, or none; restore notices only (AMB-210). */
function Apply({ t, v }: { t: Translator; v: BcpImportBatchView }) {
  return (
    <CDFCard title={t("continuityImports.applyTitle")} testId="bcp-apply">
      <p className="mb-3 text-sm text-cdf-text-secondary">{t("continuityImports.applyIntro")}</p>
      <CDFCommandForm
        action={applyBcpAction.bind(null, v.batchId)}
        locale={t.locale}
        submitLabel={actLabel(t, "applyBcpImport")}
        variant="primary"
        testId="bcp-apply-form"
        codeSections={BCP_CODES}
        confirm={confirmation(t, "applyBcpImport")}
      >
        <input type="hidden" name="previewHash" value={v.submittedHash ?? ""} />
      </CDFCommandForm>
    </CDFCard>
  );
}

function Cancel({ t, v }: { t: Translator; v: BcpImportBatchView }) {
  return (
    <CDFCard title={t("continuityImports.cancelTitle")} testId="bcp-cancel">
      <p className="mb-3 text-sm text-cdf-text-secondary">{t("continuityImports.cancelIntro")}</p>
      <CDFCommandForm
        action={cancelBcpAction.bind(null, v.batchId)}
        locale={t.locale}
        submitLabel={actLabel(t, "cancelBcpImport")}
        variant="danger"
        testId="bcp-cancel-form"
        codeSections={BCP_CODES}
        fieldLabels={{ reason: t("continuityImports.cancelReasonLabel") }}
        confirm={confirmation(t, "cancelBcpImport")}
      >
        <CDFField
          id="bcp-cancel-reason"
          label={t("continuityImports.cancelReasonLabel")}
          hint={t("continuityImports.cancelReasonHint")}
          requiredLabel={t("common.required")}
        >
          <textarea
            id="bcp-cancel-reason"
            name="reason"
            className={textareaClass}
            required
            minLength={5}
            maxLength={2000}
            aria-describedby="bcp-cancel-reason-hint"
            data-testid="bcp-cancel-reason"
          />
        </CDFField>
      </CDFCommandForm>
    </CDFCard>
  );
}

/** A row as the reader picks it: its sheet, its number and its row id. */
const rowLabel = (t: Translator, r: BcpImportRowView): string =>
  t(r.rowKey ? "continuityImports.rowOptionKey" : "continuityImports.rowOption", {
    sheet: r.sheetCode,
    n: r.rowNumber,
    key: r.rowKey ?? "",
  });

/**
 * The workbook's rows, sheet by sheet, as the view gives them: metadata only. The importer skips a row here while the
 * batch is staged (the view's per-row flag); the other resolutions wait for their options read (F4).
 */
function Rows({
  t,
  v,
  name,
  skippable,
}: {
  t: Translator;
  v: BcpImportBatchView;
  name: Name;
  skippable: readonly BcpImportRowView[];
}) {
  const sheets: { code: string; rows: BcpImportRowView[] }[] = [];
  for (const r of v.rows) {
    const last = sheets[sheets.length - 1];
    if (last && last.code === r.sheetCode) last.rows.push(r);
    else sheets.push({ code: r.sheetCode, rows: [r] });
  }
  return (
    <CDFCard title={t("continuityImports.rowsTitle")} testId="bcp-rows">
      <p className="mb-3 text-sm text-cdf-text-secondary">{t("continuityImports.rowsIntro")}</p>
      {skippable.length > 0 ? <Skip t={t} v={v} rows={skippable} /> : null}
      {sheets.length === 0 ? <p data-testid="bcp-no-rows">{t("continuityImports.noRows")}</p> : null}
      {sheets.map((s, k) => (
        <section
          key={s.code}
          aria-labelledby={`bcp-sheet-${s.code}`}
          className={k === 0 ? undefined : "mt-4 border-t border-cdf-border pt-3"}
          data-testid={`bcp-sheet-${s.code}`}
        >
          <h3 id={`bcp-sheet-${s.code}`} className="mb-2 font-semibold">
            <CDFIdentifier>{s.code}</CDFIdentifier> {sheetName(t, s.code)}
          </h3>
          <ol className="grid gap-3">
            {s.rows.map((r) => (
              <Row key={r.rowId} t={t} r={r} name={name} />
            ))}
          </ol>
        </section>
      ))}
    </CDFCard>
  );
}

function Row({ t, r, name }: { t: Translator; r: BcpImportRowView; name: Name }) {
  const id = `bcp-row-${r.sheetCode}-${r.rowNumber}`;
  const open = unresolved(r);
  return (
    <li
      className="border-b border-cdf-border pb-3 last:border-0 last:pb-0"
      data-testid={id}
      data-state={r.state}
      data-resolution={r.resolution ?? "NONE"}
    >
      <p className="font-semibold">
        {t("continuityImports.rowHeading", { n: r.rowNumber })}
        {r.rowKey ? (
          <>
            {" "}
            {/* A row id runs to 64 characters: it wraps anywhere. */}
            <CDFIdentifier variant="hash">{r.rowKey}</CDFIdentifier>
          </>
        ) : null}
      </p>
      <p className="text-sm">
        <span data-testid={`${id}-state`}>{t(`continuityImports.state.${r.state}` as MessageKey)}</span>
        {r.detail ? <span>{`: ${detailText(t, r.detail)}`}</span> : null}
      </p>
      <p className="text-sm" data-testid={`${id}-resolution`}>
        {open
          ? t("continuityImports.needsDecision")
          : r.resolution
            ? t(`continuityImports.resolution.${r.resolution}` as MessageKey)
            : t("continuityImports.nothingToDo")}
      </p>
      {r.resolvedBy && r.resolvedAt ? (
        <p className="text-sm text-cdf-text-secondary">
          {t("continuityImports.resolvedBy", { name: name(r.resolvedBy), date: when(t, r.resolvedAt) })}
          {r.resolutionReason ? (
            <>
              {" "}
              <bdi dir="auto" className="break-words">
                {r.resolutionReason}
              </bdi>
            </>
          ) : null}
        </p>
      ) : null}
      {r.outcome ? (
        <p
          className="text-sm"
          data-testid={`${id}-outcome`}
          data-outcome={r.outcome === "OK" ? "OK" : "REFUSED"}
        >
          {outcomeText(t, r.outcome)}
        </p>
      ) : null}
      {r.originalEventAt || r.recordedOfflineBy ? (
        <p className="text-sm text-cdf-text-secondary">
          {r.originalEventAt && r.recordedOfflineBy
            ? t("continuityImports.recorded", {
                date: when(t, r.originalEventAt),
                name: name(r.recordedOfflineBy),
              })
            : r.originalEventAt
              ? t("continuityImports.happened", { date: when(t, r.originalEventAt) })
              : t("continuityImports.recordedBy", { name: name(r.recordedOfflineBy!) })}
        </p>
      ) : null}
      {r.purgedAt ? (
        <p className="text-sm text-cdf-text-secondary">
          {t("continuityImports.purged", { date: when(t, r.purgedAt) })}
        </p>
      ) : null}
    </li>
  );
}

/** Skipping a row, with a reason: rows that need a decision first, then the rows that would be imported. */
function Skip({ t, v, rows }: { t: Translator; v: BcpImportBatchView; rows: readonly BcpImportRowView[] }) {
  const open = rows.filter(unresolved);
  const others = rows.filter((r) => !unresolved(r));
  return (
    <section
      aria-labelledby="bcp-skip-title"
      className="mb-4 rounded-cdf border border-cdf-border p-3"
      data-testid="bcp-skip"
    >
      <h3 id="bcp-skip-title" className="mb-2 font-semibold">
        {t("continuityImports.skipTitle")}
      </h3>
      <p className="mb-3 text-sm text-cdf-text-secondary">{t("continuityImports.skipIntro")}</p>
      <CDFCommandForm
        action={skipRowAction.bind(null, v.batchId)}
        locale={t.locale}
        submitLabel={t("continuityImports.skipRow")}
        variant="secondary"
        testId="bcp-skip-form"
        successMessage={t("continuityImports.skipped")}
        codeSections={BCP_CODES}
        fieldLabels={{
          rowId: t("continuityImports.skipRowLabel"),
          reason: t("continuityImports.skipReasonLabel"),
        }}
      >
        <CDFField
          id="bcp-skip-row"
          label={t("continuityImports.skipRowLabel")}
          requiredLabel={t("common.required")}
        >
          <select
            id="bcp-skip-row"
            name="rowId"
            className={inputClass}
            required
            defaultValue=""
            data-testid="bcp-skip-row"
          >
            <option value="" disabled>
              {t("common.choose")}
            </option>
            {open.length > 0 ? (
              <optgroup label={t("continuityImports.skipGroupOpen")}>
                {open.map((r) => (
                  <option key={r.rowId} value={r.rowId}>
                    {rowLabel(t, r)}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {others.length > 0 ? (
              <optgroup label={t("continuityImports.skipGroupOther")}>
                {others.map((r) => (
                  <option key={r.rowId} value={r.rowId}>
                    {rowLabel(t, r)}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
        </CDFField>
        <CDFField
          id="bcp-skip-reason"
          label={t("continuityImports.skipReasonLabel")}
          hint={t("continuityImports.skipReasonHint")}
          requiredLabel={t("common.required")}
        >
          <textarea
            id="bcp-skip-reason"
            name="reason"
            className={textareaClass}
            required
            minLength={5}
            maxLength={1000}
            aria-describedby="bcp-skip-reason-hint"
            data-testid="bcp-skip-reason"
          />
        </CDFField>
      </CDFCommandForm>
    </section>
  );
}
