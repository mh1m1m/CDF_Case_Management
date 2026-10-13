// Guided-by-design building blocks (ADR-030; UX redesign Phase 12). Each one explains what the database already
// decided; none of them decides anything. All text comes from the caller (@cdf/i18n); layout uses logical
// properties, so Arabic mirrors.
import type { ReactNode } from "react";
import {
  CDFAlert,
  CDFBadge,
  CDFDescriptionList,
  CDFProgressTracker,
  type CDFProgressState,
} from "./components";

export interface CDFWorkflowStep {
  code: string;
  label: string;
  state?: CDFProgressState;
}

/**
 * Where a proceeding stands (ADR-030 §2): its path, the current step, who acts next, and whether the viewer can act
 * and why. `canAct` and `you` come from the same database predicate as the command the viewer would run, so the
 * guide never offers an act the database would refuse. The viewer's command, when they have one, is the child.
 */
export function CDFWorkflowGuide({
  title,
  trackerLabel,
  steps,
  current,
  stateLabels,
  now,
  nextActor,
  you,
  canAct,
  labels,
  children,
  testId = "workflow-guide",
  id = "workflow-guide",
}: {
  title: string;
  trackerLabel: string;
  steps: CDFWorkflowStep[];
  current: string | null;
  stateLabels: { done: string; current: string; upcoming: string; skipped?: string };
  /** The current step in words, with its date or target. */
  now: ReactNode;
  /** Who acts next, by role or seat, never by name unless the viewer may see it. */
  nextActor: ReactNode;
  /** Why the viewer can or cannot act now, for example "You can record the attendance as the secretary". */
  you: ReactNode;
  canAct: boolean;
  labels: { now: string; nextActor: string; you: string };
  children?: ReactNode;
  testId?: string;
  id?: string;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      data-testid={testId}
      data-can-act={canAct ? "true" : "false"}
      className="mb-6 rounded-cdf-lg border border-cdf-border bg-cdf-surface p-4 shadow-cdf"
    >
      <h2 id={`${id}-title`} className="mb-3 text-cdf-h2 font-semibold">
        {title}
      </h2>
      <CDFProgressTracker
        label={trackerLabel}
        steps={steps}
        current={current}
        stateLabels={stateLabels}
        testId={`${testId}-path`}
      />
      <div className="mb-3">
        <CDFDescriptionList
          items={[
            { term: labels.now, value: now },
            { term: labels.nextActor, value: nextActor },
            { term: labels.you, value: <span data-testid={`${testId}-you`}>{you}</span> },
          ]}
        />
      </div>
      {canAct && children ? <div className="flex flex-wrap gap-3">{children}</div> : null}
    </section>
  );
}

/**
 * The banner of a purpose view (ADR-016 D2, DEC-02): what is open to the viewer and for which purpose, and what is
 * not shown (usually the case). The view's own reads enforce the purpose; the banner only says it.
 */
export function CDFPurposeBanner({
  title,
  purpose,
  notShown,
  testId = "purpose-banner",
}: {
  title: string;
  purpose: string;
  notShown?: string;
  testId?: string;
}) {
  return (
    <CDFAlert tone="info" title={title} testId={testId}>
      <p>{purpose}</p>
      {notShown ? <p className="mt-1">{notShown}</p> : null}
    </CDFAlert>
  );
}

/** Where a rule value comes from (configurable rules, values SOURCE_REQUIRED: DEC-F02, F08, F14, F18, F25). */
export type CDFValueSource = "SOURCE_REQUIRED" | "CONFIGURED" | "UNSET";

/**
 * A rule value with where it comes from, so a provisional default never reads as CDF policy: "30 days ·
 * Provisional: awaiting the CDF source". The source is said in text, not by colour alone (WCAG 1.4.1).
 */
export function CDFConfiguredValue({
  value,
  source,
  sourceLabel,
  testId,
}: {
  /** The value in force, already formatted; for UNSET, the words for "not set". */
  value: ReactNode;
  source: CDFValueSource;
  /** The words for the source, for example "Provisional: awaiting the CDF source". */
  sourceLabel: string;
  testId?: string;
}) {
  return (
    <span className="inline-flex flex-wrap items-center gap-2" data-testid={testId} data-source={source}>
      <span>{value}</span>
      <CDFBadge tone={source === "CONFIGURED" ? "neutral" : "warning"}>{sourceLabel}</CDFBadge>
    </span>
  );
}
