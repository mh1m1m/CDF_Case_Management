// A corrective action «إجراء تصحيحي» (UX redesign Phase 12 P12-3b and P12-6a; ADR-058; DEC-AMB-014): a purpose route
// that reads api.corrective_action_view (A2). Whoever may see the action reads its card (the wording it carries now and
// every earlier one, its status, owner and due date) and its history, and nothing of the case. The case team also
// reads where it comes from and why it may not move, and their own list of the case's actions (A1) names its owner.
// Each form shows only where A2 says its command would accept the caller now (UX-116), and the command checks again:
// - whoever acts for the action records its progress and submits it as complete, naming the evidence the policy in
//   force asks for (P12-6a);
// - a corrective-action manager of the case, never its owner or anyone who submitted a completion, verifies the
//   completion or returns it to the owner with what is missing, and reopens a completed action while the case is
//   active (P12-6a);
// - while the decision it carries out is superseded, a manager records what the replacement decision decides of it:
//   one form for each disposition the command would accept now (A2's disposition_options and may_dispose), each
//   citing one of the replacement decision's own source documents (P12-3b).
// Anyone else, and an id that names nothing, gets the same 404, and the refusal is recorded (ACCESS_DENIED). A
// disposition's reason is never shown back (R3). The history shows each entry's note as A2 gives it: A2 leaves out the
// note a disposition wrote before 2090 for anyone outside the case team (CDF-227).
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  REWORDING_DISPOSITIONS,
  type ActionBlock,
  type ActionDisposition,
  type ActionOrigin,
  type ActionReplacement,
  type CaseCorrectiveAction,
  type CorrectiveActionView,
} from "@cdf/contracts";
import { formatDate, formatDateTime, isolate, type MessageKey, type Translator } from "@cdf/i18n";
import {
  CDFAlert,
  CDFBreadcrumbs,
  CDFCard,
  CDFCommandForm,
  CDFDescriptionList,
  CDFField,
  CDFIdentifier,
  CDFPageHeader,
  CDFPurposeBanner,
  CDFStatusBadge,
  inputClass,
  textareaClass,
} from "@cdf/ui";
import { correctiveActionService, requireActor } from "@/server/container";
import { getTranslator } from "@/server/locale";
import { actLabel, confirmation } from "../../confirmations";
import { accountName } from "../../legal-reviews/labels";
import {
  ACTION_CODES,
  DISPOSE_ACT,
  calendarDate,
  completionNeeds,
  earlierVersions,
  eventText,
  eventWhen,
  evidenceText,
  governingKind,
  hasSubmitted,
  latestFirst,
  latestSubmission,
  nameOf,
  ownerText,
} from "../labels";
import {
  disposeAction,
  recordProgressAction,
  reopenAction,
  submitCompletionAction,
  verifyAction,
} from "./actions";

/** Unique translated title (WCAG 2.4.2, UX-082); never the action's wording or a case number. */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("pageTitles.correctiveAction") };
}

const UUID = /^[0-9a-f-]{36}$/i;

/** Blocks that still hold the action, which a reader should act on; the other two are final and only explain. */
const HOLDING: readonly ActionBlock[] = [
  "TAINTED_BY_CONFLICT",
  "CONFLICT_REMEDIATION_OPEN",
  "FROZEN_BY_SUPERSEDED_DECISION",
];

export default async function CorrectiveActionPage({ params }: { params: Promise<{ actionId: string }> }) {
  const { actionId } = await params;
  if (!UUID.test(actionId)) notFound();
  const { actor, ctx } = await requireActor();
  const t = await getTranslator();
  const service = correctiveActionService();
  const v = await service.view(ctx, actionId);
  if (!v) notFound();
  const o = v.origin;
  // The case team reads the case; their list of its actions names the owner and says when the decision was
  // superseded. Anyone else reads the card alone, and sees their own name where the action is theirs.
  const caseId = o ? v.case.caseId : null;
  const row: CaseCorrectiveAction | null = caseId
    ? ((await service.caseActions(ctx, caseId))?.find((r) => r.actionId === v.actionId) ?? null)
    : null;
  const ownerName = row
    ? nameOf(t, row.owner)
    : v.owner.accountableUserId === actor.userId
      ? nameOf(t, { displayName: actor.displayName, displayNameAr: actor.displayNameAr ?? null })
      : null;

  return (
    <>
      <CDFBreadcrumbs
        label={t("shell.breadcrumb")}
        items={
          caseId && v.case.caseNumber
            ? [
                { label: t("shell.area.CASES"), href: "/cases" },
                { label: <CDFIdentifier>{v.case.caseNumber}</CDFIdentifier>, href: `/cases/${caseId}` },
                { label: t("caseWorkspace.tabs.proceedings"), href: `/cases/${caseId}/proceedings` },
                { label: t("correctiveActions.breadcrumb") },
              ]
            : [
                { label: t("shell.area.MY_WORK"), href: "/my-work" },
                { label: t("correctiveActions.breadcrumb") },
              ]
        }
      />
      <CDFPageHeader
        title={t("pageTitles.correctiveAction")}
        actions={
          <CDFStatusBadge domain="correctiveAction" status={v.status} testId="action-status">
            {t(`correctiveActions.status.${v.status}` as MessageKey)}
          </CDFStatusBadge>
        }
      />
      {o ? (
        <CDFPurposeBanner
          title={t("correctiveActions.purposeTitle")}
          purpose={t("correctiveActions.purposeBody")}
          notShown={t("correctiveActions.purposeNotShown")}
          testId="action-purpose-banner"
        />
      ) : (
        <CDFPurposeBanner
          title={t("correctiveActions.cardPurposeTitle")}
          purpose={t("correctiveActions.cardPurposeBody")}
          notShown={t("correctiveActions.cardPurposeNotShown")}
          testId="action-purpose-banner"
        />
      )}
      {o?.decisionBlock ? <BlockNotice t={t} block={o.decisionBlock} row={row} /> : null}

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="min-w-0">
          <ActionCard t={t} v={v} ownerName={ownerName} />
          {o ? <Origin t={t} o={o} row={row} /> : null}
          {o && o.dispositions.length > 0 ? <Dispositions t={t} o={o} /> : null}
          <History t={t} v={v} me={actor.userId} ownerName={ownerName} />
        </div>
        {/* My Work and the case's action list link to the step the reader takes here: #report for whoever acts for the
            action, #verify for its verifier and #dispose for a manager who may record the disposition. */}
        <div className="min-w-0">
          <div id="report" className="scroll-mt-4">
            <Report t={t} v={v} caseId={caseId} me={actor.userId} />
          </div>
          <div id="verify" className="scroll-mt-4">
            {v.capabilities.mayVerify ? <Verify t={t} v={v} caseId={caseId} /> : null}
          </div>
          <div id="reopen" className="scroll-mt-4">
            {v.capabilities.mayReopen ? <Reopen t={t} v={v} caseId={caseId} /> : null}
          </div>
          <div id="dispose" className="scroll-mt-4">
            {o ? <Dispose t={t} v={v} o={o} caseId={caseId} /> : null}
          </div>
        </div>
      </div>
    </>
  );
}

/** Why the action may not move, to the case team only: what holds it, or how the replacement decision ended it. */
function BlockNotice({
  t,
  block,
  row,
}: {
  t: Translator;
  block: ActionBlock;
  row: CaseCorrectiveAction | null;
}) {
  return (
    <div data-testid="action-block" data-block={block}>
      <CDFAlert
        tone={HOLDING.includes(block) ? "warning" : "info"}
        title={t(`correctiveActions.block.${block}` as MessageKey)}
      >
        <p>{t(`correctiveActions.blockBody.${block}` as MessageKey)}</p>
        {block === "FROZEN_BY_SUPERSEDED_DECISION" && row?.supersededAt ? (
          <p className="mt-1" data-testid="action-superseded-on">
            {t("correctiveActions.supersededOn", { date: isolate(formatDate(t.locale, row.supersededAt)) })}
          </p>
        ) : null}
      </CDFAlert>
    </div>
  );
}

/** The card every viewer of the action reads: its wording now and before, where it stands, who answers for it. */
function ActionCard({
  t,
  v,
  ownerName,
}: {
  t: Translator;
  v: CorrectiveActionView;
  ownerName: string | null;
}) {
  const earlier = earlierVersions(v);
  const terms = [
    {
      term: t("correctiveActions.descriptionLabel"),
      value: (
        <bdi dir="auto" data-testid="action-description">
          {v.description}
        </bdi>
      ),
    },
    {
      term: t("correctiveActions.typeLabel"),
      value: t(`correctiveActions.type.${v.actionType}` as MessageKey),
    },
    {
      term: t("correctiveActions.ownerLabel"),
      value: <span data-testid="action-owner">{ownerText(t, v.owner, ownerName)}</span>,
    },
    {
      term: t("correctiveActions.dueLabel"),
      value: <span data-testid="action-due">{calendarDate(t, v.dueDate)}</span>,
    },
    {
      term: t("correctiveActions.progressLabel"),
      value: t("correctiveActions.progress", { percent: v.percentComplete }),
    },
    { term: t("correctiveActions.createdLabel"), value: isolate(formatDate(t.locale, v.createdAt)) },
  ];
  // The day it reached where it stands now, where that is a submission, a verification or a waiver.
  const reached =
    v.status === "PENDING_VERIFICATION"
      ? { at: v.completionSubmittedAt, key: "correctiveActions.submittedLabel" as const }
      : v.status === "COMPLETED"
        ? { at: v.completedAt, key: "correctiveActions.completedLabel" as const }
        : v.status === "WAIVED"
          ? { at: v.waivedAt, key: "correctiveActions.waivedLabel" as const }
          : null;
  if (reached?.at)
    terms.push({
      term: t(reached.key),
      value: <span data-testid="action-reached">{isolate(formatDate(t.locale, reached.at))}</span>,
    });
  if (v.versionNo > 1)
    terms.push({
      term: t("correctiveActions.versionLabel"),
      value: <span data-testid="action-version">{t("correctiveActions.version", { n: v.versionNo })}</span>,
    });
  return (
    <CDFCard title={t("correctiveActions.cardTitle")} testId="action-card">
      <p className="mb-3 text-lg font-semibold">
        <bdi dir="auto" data-testid="action-title">
          {v.title}
        </bdi>
      </p>
      <CDFDescriptionList items={terms} />
      {earlier.length > 0 ? (
        <section className="mt-4 border-t border-cdf-border pt-3" aria-labelledby="action-earlier-title">
          <h3 id="action-earlier-title" className="mb-2 font-semibold">
            {t("correctiveActions.earlierTitle")}
          </h3>
          <ol className="grid gap-3" data-testid="action-earlier">
            {earlier.map((x) => (
              <li key={x.versionNo} data-testid={`action-version-${x.versionNo}`}>
                <p className="text-sm text-cdf-text-secondary">
                  {t("correctiveActions.versionRecorded", {
                    n: x.versionNo,
                    date: isolate(formatDateTime(t.locale, x.recordedAt)),
                  })}
                </p>
                <p className="font-semibold">
                  <bdi dir="auto">{x.title}</bdi>
                </p>
                <p className="whitespace-pre-wrap break-words">
                  <bdi dir="auto">{x.description}</bdi>
                </p>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </CDFCard>
  );
}

/** Where the action comes from and the decision it carries out now, with the actions it replaced or that replaced it. */
function Origin({ t, o, row }: { t: Translator; o: ActionOrigin; row: CaseCorrectiveAction | null }) {
  const links: { href: string; label: string; testId: string }[] = [];
  if (row?.replacesActionId)
    links.push({
      href: `/actions/${row.replacesActionId}`,
      label: t("correctiveActions.replacesLink"),
      testId: "action-replaces",
    });
  if (row?.replacedByActionId)
    links.push({
      href: `/actions/${row.replacedByActionId}`,
      label: t("correctiveActions.replacedByLink"),
      testId: "action-replaced-by",
    });
  return (
    <CDFCard title={t("correctiveActions.originTitle")} testId="action-origin">
      <CDFDescriptionList
        items={[
          {
            term: t("correctiveActions.sourceLabel"),
            value: t(`correctiveActions.source.${o.source}` as MessageKey),
          },
          {
            term: t("correctiveActions.governingLabel"),
            value: (
              <span data-testid="action-governing">
                {t(`correctiveActions.governing.${governingKind(o)}` as MessageKey)}
              </span>
            ),
          },
        ]}
      />
      {links.length > 0 ? (
        <ul className="mt-3 grid gap-1">
          {links.map((l) => (
            <li key={l.testId}>
              <Link href={l.href} className="underline underline-offset-4" data-testid={l.testId}>
                {l.label}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </CDFCard>
  );
}

/** What each replacement decision decided of the action, as recorded; never the reason given (R3). */
function Dispositions({ t, o }: { t: Translator; o: ActionOrigin }) {
  return (
    <CDFCard title={t("correctiveActions.dispositionsTitle")} testId="action-dispositions">
      <ol className="grid gap-4">
        {o.dispositions.map((d, k) => {
          const terms = [
            {
              term: t("correctiveActions.citedLabel"),
              value: <bdi dir="auto">{d.sourceDocumentReference}</bdi>,
            },
            {
              term: t("correctiveActions.priorStatusLabel"),
              value: t(`correctiveActions.status.${d.priorStatus}` as MessageKey),
            },
          ];
          if (d.revisedVersionNo !== null)
            terms.push({
              term: t("correctiveActions.versionLabel"),
              value: t("correctiveActions.revisedVersion", { n: d.revisedVersionNo }),
            });
          return (
            <li
              key={d.dispositionId}
              className="border-b border-cdf-border pb-4 last:border-0 last:pb-0"
              data-testid={`action-disposition-${k + 1}`}
              data-disposition={d.disposition}
            >
              <h3 className="mb-2 font-semibold">
                {t("correctiveActions.dispositionName", {
                  disposition: t(`correctiveActions.disposition.${d.disposition}` as MessageKey),
                  date: isolate(formatDateTime(t.locale, d.recordedAt)),
                })}
              </h3>
              <CDFDescriptionList items={terms} />
              {d.replacementActionId ? (
                <p className="mt-2">
                  <Link
                    href={`/actions/${d.replacementActionId}`}
                    className="font-semibold underline underline-offset-4"
                    data-testid={`action-disposition-${k + 1}-new-action`}
                  >
                    {t("correctiveActions.newActionLink")}
                  </Link>
                </p>
              ) : null}
            </li>
          );
        })}
      </ol>
    </CDFCard>
  );
}

/**
 * What happened to the action, latest first, as A2 gives it: each entry in words, when, and who only where that is the
 * reader or the owner the page can name. A note is shown as written, and a completion with the evidence it named.
 */
function History({
  t,
  v,
  me,
  ownerName,
}: {
  t: Translator;
  v: CorrectiveActionView;
  me: string;
  ownerName: string | null;
}) {
  if (v.events.length === 0) return null;
  const owner = { userId: v.owner.accountableUserId, name: ownerName };
  return (
    <CDFCard title={t("correctiveActions.historyTitle")} testId="action-history">
      <ol className="grid gap-4">
        {latestFirst(v.events).map((e, k) => {
          const evidence = evidenceText(t, e);
          return (
            <li
              key={e.eventId}
              className="border-b border-cdf-border pb-4 last:border-0 last:pb-0"
              data-testid={`action-event-${k + 1}`}
              data-event={e.eventType}
            >
              <h3 className="font-semibold">{eventText(t, e)}</h3>
              <p className="text-sm text-cdf-text-secondary">{eventWhen(t, e, me, owner)}</p>
              {e.note ? (
                <p
                  className="mt-1 whitespace-pre-wrap break-words"
                  data-testid={`action-event-${k + 1}-note`}
                >
                  <bdi dir="auto">{e.note}</bdi>
                </p>
              ) : null}
              {evidence ? (
                <p className="mt-1 break-words" data-testid={`action-event-${k + 1}-evidence`}>
                  {evidence}
                </p>
              ) : null}
            </li>
          );
        })}
      </ol>
    </CDFCard>
  );
}

/**
 * The owner's report, for whoever acts for the action while it is open and may move (A2's may_record_progress and
 * may_submit_completion). Otherwise a line for the one who reports: a completion waits for someone else to verify it
 * (api.verify_corrective_action leaves the owner and anyone who submitted a completion out), or, outside the case
 * team, reporting is paused. Only the case team reads why an action may not move.
 */
function Report({
  t,
  v,
  caseId,
  me,
}: {
  t: Translator;
  v: CorrectiveActionView;
  caseId: string | null;
  me: string;
}) {
  const c = v.capabilities;
  if (c.mayRecordProgress || c.maySubmitCompletion)
    return (
      <CDFCard title={t("correctiveActions.reportTitle")} testId="action-report">
        <p className="mb-3 text-sm text-cdf-text-secondary">{t("correctiveActions.reportIntro")}</p>
        {c.mayRecordProgress ? <ProgressForm t={t} v={v} caseId={caseId} /> : null}
        {c.maySubmitCompletion ? <CompleteForm t={t} v={v} caseId={caseId} /> : null}
      </CDFCard>
    );
  if (
    v.status === "PENDING_VERIFICATION" &&
    !c.mayVerify &&
    (v.owner.accountableUserId === me || hasSubmitted(v.events, me))
  )
    return (
      <CDFAlert tone="info" testId="action-awaiting-verification">
        <p>{t("correctiveActions.awaitingVerification")}</p>
      </CDFAlert>
    );
  // Outside the case team, only whoever acts for the action reads it (authz.can_view_corrective_action), so an open
  // action they may not report on is one that may not move.
  if (!v.origin && (v.status === "OPEN" || v.status === "IN_PROGRESS"))
    return (
      <CDFAlert tone="info" testId="action-report-paused">
        <p>{t("correctiveActions.reportPaused")}</p>
      </CDFAlert>
    );
  return null;
}

function ProgressForm({ t, v, caseId }: { t: Translator; v: CorrectiveActionView; caseId: string | null }) {
  return (
    <section aria-labelledby="action-progress-title" className="border-t border-cdf-border pt-3 pb-3">
      <h3 id="action-progress-title" className="mb-2 font-semibold">
        {t("correctiveActions.progressTitle")}
      </h3>
      <CDFCommandForm
        action={recordProgressAction.bind(null, v.actionId, caseId)}
        locale={t.locale}
        submitLabel={t("correctiveActions.recordProgress")}
        variant="secondary"
        testId="action-progress-form"
        successMessage={t("correctiveActions.progressRecorded")}
        codeSections={ACTION_CODES}
        fieldLabels={{
          percentComplete: t("correctiveActions.percentLabel"),
          note: t("correctiveActions.progressNoteLabel"),
        }}
      >
        <CDFField
          id="action-progress-percent"
          label={t("correctiveActions.percentLabel")}
          hint={t("correctiveActions.percentHint", { percent: v.percentComplete })}
          requiredLabel={t("common.required")}
        >
          <input
            id="action-progress-percent"
            name="percentComplete"
            type="number"
            inputMode="numeric"
            min={0}
            max={100}
            step={1}
            dir="ltr"
            className={inputClass}
            required
            defaultValue={v.percentComplete}
            aria-describedby="action-progress-percent-hint"
            data-testid="action-progress-percent"
          />
        </CDFField>
        <CDFField
          id="action-progress-note"
          label={t("correctiveActions.progressNoteLabel")}
          hint={t("correctiveActions.noteHistoryHint")}
          requiredLabel={t("common.required")}
        >
          <textarea
            id="action-progress-note"
            name="note"
            className={textareaClass}
            required
            minLength={5}
            maxLength={4000}
            aria-describedby="action-progress-note-hint"
            data-testid="action-progress-note"
          />
        </CDFField>
      </CDFCommandForm>
    </section>
  );
}

/**
 * The completion, with the evidence the policy in force asks for (DEC-F27): a reference unless it accepts a note alone,
 * and with a reference a kind of evidence, needed and limited to the kinds it lists where it lists any.
 */
function CompleteForm({ t, v, caseId }: { t: Translator; v: CorrectiveActionView; caseId: string | null }) {
  const needs = completionNeeds(v.policy);
  const typeRequired = needs.type && needs.reference;
  return (
    <section aria-labelledby="action-complete-title" className="border-t border-cdf-border pt-3">
      <h3 id="action-complete-title" className="mb-2 font-semibold">
        {t("correctiveActions.completeTitle")}
      </h3>
      <p className="mb-3 text-sm text-cdf-text-secondary">{t("correctiveActions.completeIntro")}</p>
      <CDFCommandForm
        action={submitCompletionAction.bind(null, v.actionId, caseId)}
        locale={t.locale}
        submitLabel={actLabel(t, "submitActionCompletion")}
        testId="action-complete-form"
        successMessage={t("correctiveActions.completionSubmitted")}
        codeSections={ACTION_CODES}
        fieldLabels={{
          note: t("correctiveActions.completionNoteLabel"),
          evidenceReference: t("correctiveActions.referenceLabel"),
          evidenceType: t("correctiveActions.evidenceTypeLabel"),
        }}
        confirm={confirmation(t, "submitActionCompletion")}
      >
        <CDFField
          id="action-complete-note"
          label={t("correctiveActions.completionNoteLabel")}
          hint={t("correctiveActions.noteHistoryHint")}
          requiredLabel={t("common.required")}
        >
          <textarea
            id="action-complete-note"
            name="note"
            className={textareaClass}
            required
            minLength={5}
            maxLength={4000}
            aria-describedby="action-complete-note-hint"
            data-testid="action-complete-note"
          />
        </CDFField>
        <CDFField
          id="action-complete-reference"
          label={t("correctiveActions.referenceLabel")}
          hint={t(
            needs.reference
              ? "correctiveActions.referenceRequiredHint"
              : "correctiveActions.referenceOptionalHint",
          )}
          {...(needs.reference
            ? { requiredLabel: t("common.required") }
            : { optionalLabel: t("common.optional") })}
        >
          <input
            id="action-complete-reference"
            name="evidenceReference"
            dir="auto"
            className={inputClass}
            required={needs.reference}
            minLength={3}
            maxLength={300}
            aria-describedby="action-complete-reference-hint"
            data-testid="action-complete-reference"
          />
        </CDFField>
        <CDFField
          id="action-complete-type"
          label={t("correctiveActions.evidenceTypeLabel")}
          hint={t(
            needs.type
              ? "correctiveActions.evidenceTypeRequiredHint"
              : "correctiveActions.evidenceTypeOptionalHint",
          )}
          {...(typeRequired
            ? { requiredLabel: t("common.required") }
            : { optionalLabel: t("common.optional") })}
        >
          <select
            id="action-complete-type"
            name="evidenceType"
            className={inputClass}
            required={typeRequired}
            defaultValue=""
            aria-describedby="action-complete-type-hint"
            data-testid="action-complete-type"
          >
            {typeRequired ? (
              <option value="" disabled>
                {t("common.choose")}
              </option>
            ) : (
              <option value="">{t("correctiveActions.evidenceTypeNone")}</option>
            )}
            {needs.types.map((x) => (
              <option key={x} value={x}>
                {t(`correctiveActions.evidenceType.${x}` as MessageKey)}
              </option>
            ))}
          </select>
        </CDFField>
      </CDFCommandForm>
    </section>
  );
}

/**
 * The verifier's decision, for a corrective-action manager of the case who is neither the owner nor anyone who
 * submitted a completion (A2's may_verify): the latest completion as submitted, then verify it, or return it to the
 * owner saying what is missing.
 */
function Verify({ t, v, caseId }: { t: Translator; v: CorrectiveActionView; caseId: string | null }) {
  const s = latestSubmission(v.events);
  const evidence = s ? evidenceText(t, s) : null;
  return (
    <CDFCard title={t("correctiveActions.verifyTitle")} testId="action-verify">
      <p className="mb-3 text-sm text-cdf-text-secondary">{t("correctiveActions.verifyIntro")}</p>
      {s ? (
        <section
          aria-labelledby="action-submission-title"
          className="mb-4 border-t border-cdf-border pt-3"
          data-testid="action-submission"
        >
          <h3 id="action-submission-title" className="font-semibold">
            {t("correctiveActions.submissionTitle")}
          </h3>
          <p className="mb-2 text-sm text-cdf-text-secondary">
            {t("correctiveActions.submissionAt", { date: isolate(formatDateTime(t.locale, s.createdAt)) })}
          </p>
          <CDFDescriptionList
            stacked
            items={[
              {
                term: t("correctiveActions.submissionNoteLabel"),
                value: (
                  <bdi dir="auto" data-testid="action-submission-note">
                    {s.note ?? "—"}
                  </bdi>
                ),
              },
              {
                term: t("correctiveActions.submissionEvidenceLabel"),
                value: (
                  <span data-testid="action-submission-evidence">
                    {evidence ?? t("correctiveActions.noEvidence")}
                  </span>
                ),
              },
            ]}
          />
        </section>
      ) : null}
      <CDFCommandForm
        action={verifyAction.bind(null, v.actionId, caseId)}
        locale={t.locale}
        submitLabel={actLabel(t, "verifyActionCompletion")}
        testId="action-verify-form"
        successMessage={t("correctiveActions.verified")}
        codeSections={ACTION_CODES}
        fieldLabels={{
          decision: t("correctiveActions.verifyTitle"),
          note: t("correctiveActions.verifyNoteLabel"),
        }}
        confirm={confirmation(t, "verifyActionCompletion")}
      >
        <input type="hidden" name="decision" value="VERIFIED" />
        <CDFField
          id="action-verify-note"
          label={t("correctiveActions.verifyNoteLabel")}
          hint={t("correctiveActions.verifyNoteHint")}
          optionalLabel={t("common.optional")}
        >
          <textarea
            id="action-verify-note"
            name="note"
            className={textareaClass}
            minLength={5}
            maxLength={4000}
            aria-describedby="action-verify-note-hint"
            data-testid="action-verify-note"
          />
        </CDFField>
      </CDFCommandForm>
      <section aria-labelledby="action-return-title" className="mt-4 border-t border-cdf-border pt-3">
        <h3 id="action-return-title" className="mb-2 font-semibold">
          {t("correctiveActions.returnTitle")}
        </h3>
        <CDFCommandForm
          action={verifyAction.bind(null, v.actionId, caseId)}
          locale={t.locale}
          submitLabel={actLabel(t, "returnActionCompletion")}
          variant="danger"
          testId="action-return-form"
          successMessage={t("correctiveActions.returned")}
          codeSections={ACTION_CODES}
          fieldLabels={{
            decision: t("correctiveActions.returnTitle"),
            note: t("correctiveActions.returnNoteLabel"),
          }}
          confirm={confirmation(t, "returnActionCompletion")}
        >
          <input type="hidden" name="decision" value="RETURNED" />
          <CDFField
            id="action-return-note"
            label={t("correctiveActions.returnNoteLabel")}
            hint={t("correctiveActions.returnNoteHint")}
            requiredLabel={t("common.required")}
          >
            <textarea
              id="action-return-note"
              name="note"
              className={textareaClass}
              required
              minLength={5}
              maxLength={4000}
              aria-describedby="action-return-note-hint"
              data-testid="action-return-note"
            />
          </CDFField>
        </CDFCommandForm>
      </section>
    </CDFCard>
  );
}

/** Reopening a completed action that did not achieve its effect, for a manager while the case is active (may_reopen). */
function Reopen({ t, v, caseId }: { t: Translator; v: CorrectiveActionView; caseId: string | null }) {
  return (
    <CDFCard title={t("correctiveActions.reopenTitle")} testId="action-reopen">
      <p className="mb-3 text-sm text-cdf-text-secondary">{t("correctiveActions.reopenIntro")}</p>
      <CDFCommandForm
        action={reopenAction.bind(null, v.actionId, caseId)}
        locale={t.locale}
        submitLabel={actLabel(t, "reopenAction")}
        variant="danger"
        testId="action-reopen-form"
        successMessage={t("correctiveActions.reopened")}
        codeSections={ACTION_CODES}
        fieldLabels={{ reason: t("correctiveActions.reopenReasonLabel") }}
        confirm={confirmation(t, "reopenAction")}
      >
        <CDFField
          id="action-reopen-reason"
          label={t("correctiveActions.reopenReasonLabel")}
          hint={t("correctiveActions.reopenReasonHint")}
          requiredLabel={t("common.required")}
        >
          <textarea
            id="action-reopen-reason"
            name="reason"
            className={textareaClass}
            required
            minLength={5}
            maxLength={2000}
            aria-describedby="action-reopen-reason-hint"
            data-testid="action-reopen-reason"
          />
        </CDFField>
      </CDFCommandForm>
    </CDFCard>
  );
}

/**
 * The replacement decision's disposition, for a corrective-action manager of the case while the action is frozen: one
 * form for each disposition A2 offers (the command's own checks, in its order). A replacement needs an owner the
 * caller may name: on a restricted case only its authority names one, so for anyone else the option says why it
 * cannot be taken from their account instead of offering a form the command would refuse.
 */
function Dispose({
  t,
  v,
  o,
  caseId,
}: {
  t: Translator;
  v: CorrectiveActionView;
  o: ActionOrigin;
  caseId: string | null;
}) {
  const r = o.replacement;
  if (!v.capabilities.mayDispose || !r || o.dispositionOptions.length === 0)
    return o.decisionBlock === "FROZEN_BY_SUPERSEDED_DECISION" ? (
      <CDFAlert tone="info" title={t("correctiveActions.disposeTitle")} testId="action-dispose-not-yours">
        <p>{t("correctiveActions.managerOnly")}</p>
      </CDFAlert>
    ) : null;
  const options = o.dispositionOptions;
  return (
    <CDFCard title={t("correctiveActions.disposeTitle")} testId="action-dispose">
      <p className="mb-3 text-sm text-cdf-text-secondary">{t("correctiveActions.disposeIntro")}</p>
      {options.length === 1 && options[0] === "WAIVE" ? (
        <p className="mb-3 text-sm" data-testid="action-dispose-only-waive">
          {t("correctiveActions.onlyWaive")}
        </p>
      ) : null}
      {options.map((d) => (
        <details
          key={d}
          className="border-t border-cdf-border pt-3 pb-3"
          data-testid={`dispose-${d}`}
          open={options.length === 1}
        >
          <summary className="cursor-pointer font-semibold">
            {t(`correctiveActions.disposition.${d}` as MessageKey)}
          </summary>
          <p className="mt-2 mb-3 text-sm text-cdf-text-secondary">
            {t(`correctiveActions.dispositionHint.${d}` as MessageKey)}
          </p>
          {d === "REPLACE_WITH_NEW_ACTION" && !r.mayNameOwner ? (
            <p className="text-sm" data-testid="dispose-replace-authority">
              {t("correctiveActions.replaceNeedsAuthority")}
            </p>
          ) : d === "REPLACE_WITH_NEW_ACTION" && r.ownerCandidates.length === 0 ? (
            <p className="text-sm" data-testid="dispose-replace-no-owners">
              {t("correctiveActions.noOwners")}
            </p>
          ) : (
            <DisposeForm t={t} v={v} r={r} d={d} caseId={caseId} />
          )}
        </details>
      ))}
    </CDFCard>
  );
}

function DisposeForm({
  t,
  v,
  r,
  d,
  caseId,
}: {
  t: Translator;
  v: CorrectiveActionView;
  r: ActionReplacement;
  d: ActionDisposition;
  caseId: string | null;
}) {
  const id = `dispose-${d}`;
  const act = DISPOSE_ACT[d];
  const rewords = REWORDING_DISPOSITIONS.includes(d);
  const replaces = d === "REPLACE_WITH_NEW_ACTION";
  // MODIFY keeps the action's own due date without one; a replacement takes the policy's default, or needs one.
  const dueHint = replaces
    ? r.defaultDueDate
      ? t("correctiveActions.replaceDueHint", { date: calendarDate(t, r.defaultDueDate) })
      : t("correctiveActions.replaceDueRequired")
    : t("correctiveActions.modifyDueHint", { date: calendarDate(t, v.dueDate) });
  const dueRequired = replaces && !r.defaultDueDate;
  return (
    <CDFCommandForm
      action={disposeAction.bind(null, v.actionId, caseId)}
      locale={t.locale}
      submitLabel={actLabel(t, act)}
      variant={d === "WAIVE" || replaces ? "danger" : "primary"}
      testId={`${id}-form`}
      successMessage={t("correctiveActions.disposed")}
      codeSections={ACTION_CODES}
      fieldLabels={{
        disposition: t("correctiveActions.disposeTitle"),
        sourceDocumentReference: t("correctiveActions.documentLabel"),
        reason: t("correctiveActions.reasonLabel"),
        title: t("correctiveActions.newTitleLabel"),
        description: t("correctiveActions.newDescriptionLabel"),
        ownerId: t("correctiveActions.newOwnerLabel"),
        dueDate: t("correctiveActions.dueDateLabel"),
      }}
      confirm={confirmation(t, act)}
    >
      <input type="hidden" name="disposition" value={d} />
      <CDFField
        id={`${id}-document`}
        label={t("correctiveActions.documentLabel")}
        hint={t("correctiveActions.documentHint")}
        requiredLabel={t("common.required")}
      >
        <select
          id={`${id}-document`}
          name="sourceDocumentReference"
          className={inputClass}
          required
          defaultValue={r.sources.length === 1 ? r.sources[0]!.reference : ""}
          aria-describedby={`${id}-document-hint`}
          data-testid={`${id}-document`}
        >
          <option value="" disabled>
            {t("common.choose")}
          </option>
          {r.sources.map((s) => (
            <option key={s.position} value={s.reference}>
              {s.isPrimary ? t("correctiveActions.primaryDocument", { reference: s.reference }) : s.reference}
            </option>
          ))}
        </select>
      </CDFField>
      {rewords ? (
        <>
          <CDFField
            id={`${id}-title`}
            label={t("correctiveActions.newTitleLabel")}
            hint={t("correctiveActions.newTitleHint")}
            requiredLabel={t("common.required")}
          >
            <input
              id={`${id}-title`}
              name="title"
              className={inputClass}
              required
              minLength={5}
              maxLength={200}
              defaultValue={d === "MODIFY" ? v.title : undefined}
              aria-describedby={`${id}-title-hint`}
              data-testid={`${id}-title`}
            />
          </CDFField>
          <CDFField
            id={`${id}-description`}
            label={t("correctiveActions.newDescriptionLabel")}
            hint={t("correctiveActions.newDescriptionHint")}
            requiredLabel={t("common.required")}
          >
            <textarea
              id={`${id}-description`}
              name="description"
              className={textareaClass}
              required
              minLength={10}
              maxLength={4000}
              defaultValue={d === "MODIFY" ? v.description : undefined}
              aria-describedby={`${id}-description-hint`}
              data-testid={`${id}-description`}
            />
          </CDFField>
        </>
      ) : null}
      {replaces ? (
        <CDFField
          id={`${id}-owner`}
          label={t("correctiveActions.newOwnerLabel")}
          hint={t("correctiveActions.newOwnerHint")}
          requiredLabel={t("common.required")}
        >
          <select
            id={`${id}-owner`}
            name="ownerId"
            className={inputClass}
            required
            defaultValue=""
            aria-describedby={`${id}-owner-hint`}
            data-testid={`${id}-owner`}
          >
            <option value="" disabled>
              {t("common.choose")}
            </option>
            {r.ownerCandidates.map((c) => (
              <option key={c.userId} value={c.userId}>
                {accountName(t, c)}
              </option>
            ))}
          </select>
        </CDFField>
      ) : null}
      {rewords ? (
        <CDFField
          id={`${id}-due`}
          label={t("correctiveActions.dueDateLabel")}
          hint={dueHint}
          {...(dueRequired
            ? { requiredLabel: t("common.required") }
            : { optionalLabel: t("common.optional") })}
        >
          <input
            id={`${id}-due`}
            name="dueDate"
            type="date"
            className={inputClass}
            dir="ltr"
            required={dueRequired}
            aria-describedby={`${id}-due-hint`}
            data-testid={`${id}-due`}
          />
        </CDFField>
      ) : null}
      <CDFField
        id={`${id}-reason`}
        label={t("correctiveActions.reasonLabel")}
        hint={t("correctiveActions.reasonHint")}
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
