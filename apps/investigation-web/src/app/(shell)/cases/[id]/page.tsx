// Case overview «نظرة عامة» (UX redesign S2; audit §22.3; CDF-125). Answers where the case is, what comes next,
// who can do it and by when, on first paint: the stage panel, the viewer's own items here, key facts, the team
// and the latest business events. Everything shown is what the database returned for this viewer; every step
// is re-checked by api.transition_case.
import type { Metadata } from "next";
import { PRIORITIES, type TransitionOption } from "@cdf/contracts";
import type { MessageKey } from "@cdf/i18n";
import {
  CDFBadge,
  CDFCard,
  CDFCommandForm,
  CDFDateTime,
  CDFDescriptionList,
  CDFField,
  CDFIdentifier,
  CDFProgressTracker,
  CDFStagePanel,
  CDFTimeline,
  CDFWorkList,
  inputClass,
  textareaClass,
} from "@cdf/ui";
import { isHandOver, lastReturn, progressSteps, stateByCode } from "@cdf/workflow";
import { investigationService } from "@/server/container";
import { getTranslator } from "@/server/locale";
import { overdueKeys } from "@/server/work-routes";
import { confirmation, transitionAct } from "../../confirmations";
import { WorkItemRow, someOpenLater } from "../../work-item-row";
import { transitionAction, updateDetailsAction } from "./actions";
import {
  CaseWorkspace,
  type CaseTab,
  contentOpen,
  historyItems,
  loadCase,
  personName,
  stateLabel as stateLabelOf,
  stateName,
  stepVerb,
  tabHref,
} from "./workspace";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("pageTitles.caseDetail") };
}

// Steps the workflow does not take yet whose work already happens in a tab (Phase 12 P12-1): say where.
const LATER_IN: Readonly<Record<string, CaseTab>> = {
  REFER_TO_COMMITTEE: "proceedings",
  SUBMIT_FINDINGS: "allegations",
};

export default async function CaseOverviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const editing = (await searchParams).edit === "details";
  const { actor, ctx, t, c } = await loadCase(id);
  const service = investigationService();
  const [timeline, work] = await Promise.all([service.caseTimeline(ctx, id, 5), service.myWorkItems(ctx)]);
  const open = contentOpen(c);
  const mine = work.filter((i) => i.caseId === c.id);
  const overdue = overdueKeys(mine);
  const stateLabel = (code: string) => stateLabelOf(t, code);
  const list = (xs: string[]) => xs.join(t.locale === "ar" ? "، " : ", ");

  const steps = progressSteps(c.currentState, c.path).map((s) => ({
    code: s.code,
    state: s.state,
    label: s.skipped ? t("caseWorkspace.skippedSteps", { count: s.skipped.length }) : stateLabel(s.code),
  }));
  const back = lastReturn(c.path);
  const last = c.path.at(-1);
  const ended = last && stateByCode(last.toState)?.recordsState !== "ACTIVE" ? last : undefined;

  const enabled = c.transitions.filter((tr) => tr.enabled);
  const canDo = enabled.filter((tr) => tr.allowed);
  const blocked = enabled.filter((tr) => !tr.allowed);
  const later = c.transitions.filter((tr) => !tr.enabled);
  // Forward steps first, controlled acts (close, return, archive) after them.
  const ordered = [...canDo].sort(
    (a, b) => Number(!!transitionAct(a.code, a.toState)) - Number(!!transitionAct(b.code, b.toState)),
  );
  const stepName = (tr: TransitionOption) => (t.locale === "ar" ? tr.nameAr : tr.nameEn);

  return (
    <CaseWorkspace c={c} actor={actor} t={t} tab="overview">
      {/* min-w-0: grid items default to min-width:auto, so a wide table would widen the page (WCAG 1.4.10). */}
      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="min-w-0">
          <CDFStagePanel
            title={t("caseWorkspace.stageTitle")}
            tracker={
              <CDFProgressTracker
                label={t("cases.progress")}
                current={c.currentState}
                testId="case-progress"
                stateLabels={{
                  done: t("cases.stepDone"),
                  current: t("cases.stepCurrent"),
                  upcoming: t("cases.stepUpcoming"),
                  skipped: t("caseWorkspace.stepSkipped"),
                }}
                steps={steps}
              />
            }
            now={
              <p data-testid="stage-now">
                <span className="font-semibold">{t("caseWorkspace.now")}:</span> {stateName(t, c)}
                {c.enteredStateAt ? (
                  <>
                    {" · "}
                    {t("caseWorkspace.since")}{" "}
                    <CDFDateTime value={c.enteredStateAt} locale={t.locale} dateOnly />
                  </>
                ) : null}
                {" · "}
                {c.stateDueAt ? (
                  <>
                    {t("caseWorkspace.target")}{" "}
                    <CDFDateTime value={c.stateDueAt} locale={t.locale} dateOnly />{" "}
                    {t("caseWorkspace.targetProvisional")}
                  </>
                ) : (
                  t("caseWorkspace.noTarget")
                )}
              </p>
            }
            notes={
              back ? (
                <p data-testid="stage-returned">
                  {t("caseWorkspace.returnedTo", { state: stateLabel(back.toState) })} ·{" "}
                  <CDFDateTime value={back.occurredAt} locale={t.locale} dateOnly />
                </p>
              ) : ended ? (
                <p data-testid="stage-ended">
                  {t.code("caseWorkspace.ended", ended.transitionCode, "caseWorkspace.endedOther")} ·{" "}
                  <CDFDateTime value={ended.occurredAt} locale={t.locale} dateOnly />
                </p>
              ) : null
            }
          >
            {ordered.length === 0 && blocked.length === 0 && later.length === 0 ? (
              <p className="text-cdf-text-secondary" data-testid="no-next-steps">
                {t("caseWorkspace.nothingForYou")}
              </p>
            ) : null}
            {ordered.length > 0 ? (
              <>
                <h3 className="mb-2 font-semibold">{t("caseWorkspace.youCan")}</h3>
                <ul data-testid="transitions-card">
                  {ordered.map((tr) => {
                    // UX-031: closing, archiving and returning a case are verb-labelled and confirmed first.
                    const act = transitionAct(tr.code, tr.toState);
                    return (
                      <li
                        key={tr.code}
                        className="mb-4 border-b border-cdf-border pb-4 last:border-0"
                        data-testid={`transition-${tr.code}`}
                      >
                        {/* A hand-over (ADR-016 D3) ends triage access in the same step: say so before it. */}
                        {c.currentState && isHandOver(c.currentState, tr.toState) ? (
                          <p
                            className="mb-2 text-sm text-cdf-text-secondary"
                            data-testid={`handover-note-${tr.code}`}
                          >
                            {t("caseWorkspace.handOverNote")}
                          </p>
                        ) : null}
                        <CDFCommandForm
                          action={transitionAction.bind(null, c.id, tr.code)}
                          locale={t.locale}
                          submitLabel={stepVerb(t, tr)}
                          variant={act ? "danger" : tr === ordered[0] ? "primary" : "secondary"}
                          fieldLabels={{ reason: t("cases.transitionReason") }}
                          confirm={act ? confirmation(t, act) : undefined}
                        >
                          {tr.reasonRequired ? (
                            <CDFField
                              id={`reason-${tr.code}`}
                              label={t("cases.transitionReason")}
                              hint={t("intake.reasonHint")}
                              requiredLabel={t("common.required")}
                            >
                              <textarea
                                id={`reason-${tr.code}`}
                                name="reason"
                                aria-describedby={`reason-${tr.code}-hint`}
                                className={textareaClass}
                                required
                                minLength={10}
                              />
                            </CDFField>
                          ) : null}
                        </CDFCommandForm>
                      </li>
                    );
                  })}
                </ul>
              </>
            ) : null}
            {blocked.length > 0 ? (
              <>
                <h3 className="mb-2 font-semibold">{t("caseWorkspace.waitingOn")}</h3>
                <ul className="mb-4 grid gap-3">
                  {blocked.map((tr) => (
                    <li key={tr.code} data-testid={`transition-${tr.code}`}>
                      <p className="font-semibold">
                        {stepName(tr)} <CDFBadge tone="neutral">{t("cases.blocked")}</CDFBadge>
                      </p>
                      <ul
                        className="mt-1 list-disc ps-5 text-sm text-cdf-text-secondary"
                        data-testid={`blocked-${tr.code}`}
                      >
                        {tr.blockingReasons.map((r) => (
                          <li key={r}>{t.code("codes", r, "errors.CONFLICT")}</li>
                        ))}
                      </ul>
                      {tr.blockingReasons.includes("MISSING_PERMISSION") && tr.eligibleRoles.length > 0 ? (
                        <p className="mt-1 text-sm" data-testid={`who-can-${tr.code}`}>
                          {t("caseWorkspace.whoCan", {
                            roles: list(tr.eligibleRoles.map((r) => t.code("role", r))),
                          })}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            {later.length > 0 ? (
              <>
                <h3 className="mb-2 font-semibold">{t("caseWorkspace.later")}</h3>
                <ul className="list-disc ps-5 text-sm text-cdf-text-secondary">
                  {later.map((tr) => (
                    <li key={tr.code} data-testid={`later-${tr.code}`}>
                      {stepName(tr)}:{" "}
                      {LATER_IN[tr.code] ? (
                        <a
                          href={tabHref(c.id, LATER_IN[tr.code]!)}
                          className="underline underline-offset-4"
                          data-testid={`later-${tr.code}-where`}
                        >
                          {t(`caseStructure.laterIn.${tr.code}` as MessageKey)}
                        </a>
                      ) : (
                        t("caseWorkspace.laterNote")
                      )}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </CDFStagePanel>

          <section id="case-details" tabIndex={-1}>
            <CDFCard title={t("caseWorkspace.keyFacts")} testId="key-facts">
              <CDFDescriptionList
                items={[
                  { term: t("cases.summary"), value: <bdi dir="auto">{c.summary}</bdi> },
                  { term: t("cases.source"), value: t.code("caseWorkspace.source", c.source, "common.none") },
                  {
                    term: t("cases.reporterRef"),
                    value: c.reporterWbId ? (
                      <>
                        <CDFIdentifier>{c.reporterWbId}</CDFIdentifier>
                        <span className="block text-sm text-cdf-text-secondary">
                          {t("cases.reporterRefHint")}
                        </span>
                      </>
                    ) : (
                      "—"
                    ),
                  },
                  ...(c.openedAt
                    ? [
                        {
                          term: t("cases.openedAt"),
                          value: <CDFDateTime value={c.openedAt} locale={t.locale} />,
                        },
                      ]
                    : []),
                ]}
              />
              {c.can.edit && open ? (
                <details className="mt-4" open={editing}>
                  <summary className="cursor-pointer font-semibold">{t("cases.editDetails")}</summary>
                  <div className="mt-3">
                    <CDFCommandForm
                      // UX-030: the version and values this page rendered travel with the form; only changed
                      // fields are sent, so an untouched field can never write an older value back.
                      action={updateDetailsAction.bind(null, c.id, {
                        rowVersion: c.rowVersion,
                        title: c.title,
                        summary: c.summary,
                        priority: c.priority,
                      })}
                      locale={t.locale}
                      submitLabel={t("common.save")}
                      variant="secondary"
                      testId="details-form"
                      successMessage={t("common.saved")}
                      changedOnly={["title", "summary", "priority"]}
                    >
                      {/* Keyed by version: after a save every field starts again from the stored values. */}
                      <div key={c.rowVersion}>
                        <CDFField
                          id="title"
                          label={t("intake.caseTitle")}
                          requiredLabel={t("common.required")}
                        >
                          <input
                            id="title"
                            name="title"
                            defaultValue={c.title}
                            className={inputClass}
                            required
                          />
                        </CDFField>
                        <CDFField
                          id="summary"
                          label={t("intake.caseSummary")}
                          requiredLabel={t("common.required")}
                        >
                          <textarea
                            id="summary"
                            name="summary"
                            defaultValue={c.summary}
                            className={textareaClass}
                            required
                          />
                        </CDFField>
                        <CDFField id="priority" label={t("cases.priority")}>
                          <select
                            id="priority"
                            name="priority"
                            defaultValue={c.priority ?? ""}
                            className={inputClass}
                          >
                            <option value="">—</option>
                            {PRIORITIES.map((p) => (
                              <option key={p} value={p}>
                                {t(`priority.${p}` as MessageKey)}
                              </option>
                            ))}
                          </select>
                        </CDFField>
                      </div>
                    </CDFCommandForm>
                  </div>
                </details>
              ) : null}
            </CDFCard>
          </section>

          <CDFCard
            title={t("caseWorkspace.recentHistory")}
            testId="recent-history"
            actions={
              <a
                href={tabHref(c.id, "history")}
                className="text-sm font-semibold underline underline-offset-4"
              >
                {t("caseWorkspace.allHistory")}
              </a>
            }
          >
            <CDFTimeline empty={t("cases.noTimeline")} items={historyItems(t, timeline)} />
          </CDFCard>
        </div>

        <div className="min-w-0">
          <CDFCard title={t("caseWorkspace.yourItems")} testId="your-items">
            {mine.length === 0 ? (
              <p className="text-cdf-text-secondary">{t("caseWorkspace.noYourItems")}</p>
            ) : (
              <CDFWorkList label={t("caseWorkspace.yourItems")}>
                {mine.map((i) => (
                  <WorkItemRow
                    key={`${i.category}:${i.targetId}`}
                    t={t}
                    item={i}
                    overdue={overdue.has(`${i.category}:${i.targetId}`)}
                    showCase={false}
                  />
                ))}
              </CDFWorkList>
            )}
            {someOpenLater(mine) ? (
              <p className="mt-3 text-sm text-cdf-text-secondary" data-testid="your-items-page-later">
                {t("myWork.pageLater")}
              </p>
            ) : null}
          </CDFCard>

          <CDFCard
            title={t("caseWorkspace.teamTitle")}
            testId="team-summary"
            actions={
              <a
                href={tabHref(c.id, "people")}
                className="text-sm font-semibold underline underline-offset-4"
              >
                {t("caseWorkspace.tabs.people")}
              </a>
            }
          >
            {c.assignments.length === 0 ? (
              <p className="text-cdf-text-secondary">{t("cases.noTeam")}</p>
            ) : (
              <ul>
                {c.assignments.map((a) => (
                  <li key={a.id} className="mb-1">
                    <bdi className="font-semibold">{personName(t, a)}</bdi> ·{" "}
                    {t(`assignmentRole.${a.assignmentRole}` as MessageKey)}
                  </li>
                ))}
              </ul>
            )}
          </CDFCard>
        </div>
      </div>
    </CaseWorkspace>
  );
}
