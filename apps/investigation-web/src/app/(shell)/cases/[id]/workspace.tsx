// The case workspace (UX redesign S2; audit §22, RC-15; CDF-119). Every tab of a case renders inside the same
// header, breadcrumbs and tabs, so the case number, its stage, its owner and the viewer's own relationship stay
// on screen. Each tab page calls loadCase itself, rather than a shared layout doing it once: api.open_case
// audits CASE_VIEWED, and a layout would also run when a link to the case is prefetched. Every tab page still
// enforces its own access and answers the uniform 404 (G2).
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { can, navigationFor } from "@cdf/authorization";
import type { Actor, AuditTimelineEntry, CaseDetail, MyAccessEntry, TransitionOption } from "@cdf/contracts";
import { formatDateTime, type MessageKey, type Translator } from "@cdf/i18n";
import {
  buttonClass,
  CDFAlert,
  CDFBadge,
  CDFBreadcrumbs,
  CDFCaseHeader,
  CDFClassificationBadge,
  CDFDateTime,
  CDFIdentifier,
  CDFLegalHoldIndicator,
  CDFNamedAccessFlag,
  CDFOverflowMenu,
  CDFViewTabs,
} from "@cdf/ui";
import { stateByCode } from "@cdf/workflow";
import { investigationService, requireActor } from "@/server/container";
import { getTranslator } from "@/server/locale";
import { isPast } from "@/server/work-routes";
import { transitionAct } from "../../confirmations";

export const CASE_TABS = [
  "overview",
  "allegations",
  "evidence",
  "interviews",
  "forms",
  "reporter",
  "people",
  "history",
] as const;
export type CaseTab = (typeof CASE_TABS)[number];

const UUID = /^[0-9a-f-]{36}$/i;

/** Opens the case for this request (audited by api.open_case); a missing and a hidden case are both 404. */
export async function loadCase(id: string) {
  if (!UUID.test(id)) notFound();
  const { actor, ctx } = await requireActor();
  const t = await getTranslator();
  const c = await investigationService().getCase(ctx, id);
  if (!c) notFound();
  return { actor, ctx, t, c };
}

export const tabHref = (caseId: string, tab: CaseTab) =>
  tab === "overview" ? `/cases/${caseId}` : `/cases/${caseId}/${tab}`;

/** Case content can still change (ADR-013 D5, CDF-74): from ARCHIVED on, the database refuses it. */
export const contentOpen = (c: CaseDetail) => c.recordsState === "ACTIVE" || c.recordsState === "CLOSED";

export const personName = (t: Translator, n: { displayName: string; displayNameAr?: string | null }) =>
  t.locale === "ar" && n.displayNameAr ? n.displayNameAr : n.displayName;

export const stateName = (t: Translator, c: Pick<CaseDetail, "stateNameEn" | "stateNameAr">) =>
  (t.locale === "ar" ? c.stateNameAr : c.stateNameEn) ?? "—";

/** A workflow state's name in the viewer's language; the code itself if the state is unknown. */
export function stateLabel(t: Translator, code: string): string {
  const s = stateByCode(code);
  return s ? (t.locale === "ar" ? s.nameAr : s.nameEn) : code;
}

/** An action's label: the case-level catalogue first, then the interview catalogue (ADR-012). */
function actionLabel(t: Translator, action: string): string {
  const other = t("caseWorkspace.history.other");
  const top = t.code("auditAction", action, "caseWorkspace.history.other");
  return top !== other ? top : t.code("interviews.auditAction", action, "caseWorkspace.history.other");
}

/** One history event in business words. Names appear only where api.case_history returned them (DEC-08). */
function historyTitle(t: Translator, e: AuditTimelineEntry): string {
  const d = e.detail ?? {};
  const name = e.subjectName
    ? personName(t, { displayName: e.subjectName, displayNameAr: e.subjectNameAr })
    : null;
  const role = d.role ? t.code("assignmentRole", d.role, "caseWorkspace.history.other") : null;
  const purpose = d.scope ? t.code("myAccess.grantScope", d.scope, "caseWorkspace.history.other") : null;
  switch (e.action) {
    case "WORKFLOW_TRANSITION":
      if (d.from && d.to)
        return t("caseWorkspace.history.moved", { from: stateLabel(t, d.from), to: stateLabel(t, d.to) });
      break;
    case "CASE_ASSIGNED":
    case "CASE_REASSIGNED":
    case "CASE_UNASSIGNED":
      if (name && role) {
        const key = {
          CASE_ASSIGNED: "assigned",
          CASE_REASSIGNED: "reassigned",
          CASE_UNASSIGNED: "unassigned",
        }[e.action];
        return t(`caseWorkspace.history.${key}` as MessageKey, { name, role });
      }
      break;
    case "CASE_HANDED_OVER":
      if (name) return t("caseWorkspace.history.handedOver", { name });
      break;
    case "CASE_ACCESS_GRANTED":
      if (name && purpose) return t("caseWorkspace.history.accessGranted", { name, purpose });
      break;
    case "CASE_ACCESS_REVOKED":
      if (name && purpose) return t("caseWorkspace.history.accessRevoked", { name, purpose });
      break;
    case "CONFLICT_DECLARED":
      if (name) return t("caseWorkspace.history.conflictDeclared", { name });
      break;
    case "CONFLICT_DECIDED":
      if (name) return t("caseWorkspace.history.conflictDecided", { name });
      break;
    case "REPORTER_COMMUNICATION_DELEGATED":
      if (name) return t("caseWorkspace.history.reporterDelegated", { name });
      break;
    case "REPORTER_COMMUNICATION_ENDED":
      if (name) return t("caseWorkspace.history.reporterDelegationEnded", { name });
      break;
    case "CLASSIFICATION_CHANGED":
      // The database names a level only when it is within the viewer's clearance.
      if (d.to) return t("caseWorkspace.history.classifiedAs", { level: t.code("classification", d.to) });
      break;
  }
  return actionLabel(t, e.action);
}

/** History rows for CDFTimeline, newest first, as the database filtered them (api.case_history). */
export function historyItems(t: Translator, entries: AuditTimelineEntry[]) {
  return entries.map((e) => {
    const actor = e.actorName
      ? personName(t, { displayName: e.actorName, displayNameAr: e.actorNameAr })
      : null;
    // Hold status without who or why (DEC-10): say where those details are kept.
    const holdNote =
      !actor && (e.action === "LEGAL_HOLD_PLACED" || e.action === "LEGAL_HOLD_RELEASED")
        ? t("caseWorkspace.history.holdNote")
        : null;
    return {
      id: String(e.seq),
      title: historyTitle(t, e),
      meta: actor
        ? `${formatDateTime(t.locale, e.occurredAt)} · ${actor}`
        : formatDateTime(t.locale, e.occurredAt),
      body: holdNote ?? e.reason,
      testId: `history-${e.action}`,
    };
  });
}

/** The verb on a step's button: closing, archiving and returning use the confirmation's own verb (UX-031). */
export function stepVerb(t: Translator, tr: TransitionOption): string {
  const act = transitionAct(tr.code, tr.toState);
  if (act) return t(`confirm.acts.${act}.action` as MessageKey);
  return t.code("caseWorkspace.verb", tr.code, "cases.perform");
}

/** The viewer's own basis on this case, from api.my_access() (DEC-10: everyone sees their own). */
function youLine(t: Translator, rows: MyAccessEntry[], caseId: string, actor: Actor): ReactNode {
  const mine = rows.filter((r) => r.caseId === caseId);
  if (mine.length === 0) {
    const roles = actor.roles.map((r) => t.code("role", r)).join(t.locale === "ar" ? "، " : ", ");
    return t("caseWorkspace.youThroughRole", { roles });
  }
  return mine.map((r, i) => {
    const what =
      r.basis === "ASSIGNMENT"
        ? t.code("assignmentRole", r.code)
        : r.basis === "GRANT"
          ? `${t("myAccess.basis.GRANT")}: ${t.code("myAccess.grantScope", r.code)}`
          : r.basis === "TASK"
            ? t.code("records.taskTypeName", r.code, "records.taskType")
            : t(`myAccess.basis.${r.basis}` as MessageKey);
    return (
      <span key={`${r.basis}:${r.code}`}>
        {i > 0 ? "; " : null}
        {what} (
        {r.untilAt ? (
          <>
            {t("caseWorkspace.youUntil")} <CDFDateTime value={r.untilAt} locale={t.locale} dateOnly />
          </>
        ) : (
          t("caseWorkspace.youNoEnd")
        )}
        )
      </span>
    );
  });
}

export async function CaseWorkspace({
  c,
  actor,
  t,
  tab,
  item,
  children,
}: {
  c: CaseDetail;
  actor: Actor;
  t: Translator;
  tab: CaseTab;
  /** An item page inside a tab (for example one form): its label ends the breadcrumbs. */
  item?: ReactNode;
  children: ReactNode;
}) {
  const { ctx } = await requireActor();
  const service = investigationService();
  const [access, pendingConflicts] = await Promise.all([
    service.myAccess(ctx),
    service.pendingConflicts(ctx, actor, c.id),
  ]);
  const open = contentOpen(c);
  const nav = navigationFor(actor);
  const tabLabel = (k: CaseTab) => t(`caseWorkspace.tabs.${k}` as MessageKey);

  // The one next step this viewer can take now, as a verb (audit §22.5.1). Closing and returning steps are
  // controlled acts, never the primary; they stay in the stage panel behind their confirmation.
  const primary = c.transitions.find((tr) => tr.enabled && tr.allowed && !transitionAct(tr.code, tr.toState));

  const overflow = [
    ...(can(actor, "CASE_EDIT_ALL") && open
      ? [
          {
            key: "editDetails",
            href: `/cases/${c.id}?edit=details#case-details`,
            label: t("caseWorkspace.overflow.editDetails"),
          },
        ]
      : []),
    ...(can(actor, "CASE_ASSIGN") && open
      ? [
          {
            key: "manageTeam",
            href: `/cases/${c.id}/people#team`,
            label: t("caseWorkspace.overflow.manageTeam"),
          },
        ]
      : []),
    ...(can(actor, "CONFLICT_DECLARE")
      ? [
          {
            key: "myDeclaration",
            href: `/cases/${c.id}/people#conflict`,
            label: t("caseWorkspace.overflow.myDeclaration"),
          },
        ]
      : []),
    ...(nav.recordsCatalogue || nav.myWork
      ? [{ key: "openRecord", href: `/records/${c.id}`, label: t("caseWorkspace.overflow.openRecord") }]
      : []),
  ];

  // One banner at a time, by priority (audit §22.9.1): a conflict to decide, then read-only.
  const banner =
    pendingConflicts.length > 0 ? (
      <CDFAlert tone="warning" testId="case-banner-conflict">
        <a
          href={`/cases/${c.id}/people#conflict-decisions`}
          className="font-semibold underline underline-offset-4"
        >
          {t("cases.conflictDecisionsTitle")}
        </a>
      </CDFAlert>
    ) : !open ? (
      <CDFAlert tone="info" testId="case-read-only">
        {t("records.readOnlyNotice")}
      </CDFAlert>
    ) : null;

  return (
    <>
      <CDFBreadcrumbs
        label={t("shell.breadcrumb")}
        items={[
          { label: t("shell.area.CASES"), href: "/cases" },
          tab === "overview" && !item
            ? { label: <CDFIdentifier>{c.caseNumber}</CDFIdentifier> }
            : { label: <CDFIdentifier>{c.caseNumber}</CDFIdentifier>, href: tabHref(c.id, "overview") },
          ...(tab !== "overview"
            ? [{ label: tabLabel(tab), href: item ? tabHref(c.id, tab) : undefined }]
            : []),
          ...(item ? [{ label: item }] : []),
        ]}
      />
      <CDFCaseHeader
        number={c.caseNumber}
        title={c.title}
        actions={
          <>
            {primary ? (
              <a
                href={`${tabHref(c.id, "overview")}#next-steps`}
                className={buttonClass("primary")}
                data-testid="case-primary-action"
              >
                {stepVerb(t, primary)}
              </a>
            ) : null}
            <CDFOverflowMenu label={t("caseWorkspace.moreActions")} items={overflow} />
          </>
        }
        status={
          <>
            <span className="inline-flex flex-wrap items-center gap-2">
              <CDFBadge tone="info" testId="case-state">
                {stateName(t, c)}
              </CDFBadge>
              {c.enteredStateAt ? (
                <span data-testid="case-since">
                  {t("caseWorkspace.since")}{" "}
                  <CDFDateTime value={c.enteredStateAt} locale={t.locale} dateOnly />
                </span>
              ) : null}
            </span>
            <span data-testid="case-target">
              {c.stateDueAt ? (
                <>
                  {isPast(c.stateDueAt) ? (
                    <strong className="me-1 text-cdf-warning">{t("caseWorkspace.overdue")}</strong>
                  ) : null}
                  {t("caseWorkspace.target")} <CDFDateTime value={c.stateDueAt} locale={t.locale} dateOnly />{" "}
                  {t("caseWorkspace.targetProvisional")}
                </>
              ) : (
                t("caseWorkspace.noTarget")
              )}
            </span>
            <span data-testid="case-priority">
              {c.priority
                ? t("caseWorkspace.priority", { priority: t(`priority.${c.priority}` as MessageKey) })
                : t("caseWorkspace.noPriority")}
            </span>
            <CDFClassificationBadge
              level={c.classification}
              label={t(`classification.${c.classification}` as MessageKey)}
              testId="case-classification"
            />
            {c.isRestricted ? (
              <CDFNamedAccessFlag label={t("classification.restrictedCase")} testId="case-restricted" />
            ) : null}
            {c.recordsState !== "ACTIVE" ? (
              <CDFBadge tone="neutral" testId="case-records-state">
                {t.code("records.state", c.recordsState)}
              </CDFBadge>
            ) : null}
            {c.legalHoldStatus === "ACTIVE" ? (
              <CDFLegalHoldIndicator label={t("records.holdStatus.ACTIVE")} testId="case-legal-hold" />
            ) : null}
          </>
        }
        people={
          <>
            <span data-testid="case-owner">
              <span className="font-semibold">{t("caseWorkspace.owner")}:</span>{" "}
              {c.owner ? <bdi>{personName(t, c.owner)}</bdi> : t("caseWorkspace.noOwner")}
            </span>
            <span data-testid="case-you">
              <span className="font-semibold">{t("caseWorkspace.you")}:</span>{" "}
              {youLine(t, access, c.id, actor)}
            </span>
          </>
        }
        banner={banner}
      />
      <CDFViewTabs
        label={t("caseWorkspace.tabsLabel")}
        testId="case-tabs"
        itemTestIdPrefix="case-tab-"
        wrap
        current={tab}
        items={CASE_TABS.filter((k) => k !== "reporter" || c.reporterConversation !== "NONE").map((k) => ({
          key: k,
          href: tabHref(c.id, k),
          label: tabLabel(k),
        }))}
      />
      {children}
    </>
  );
}
