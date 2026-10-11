// The case workspace frame (UX redesign S2; audit §22.1–§22.5, RC-15). One header on every tab of a case, so
// the case number, its stage, its owner and the viewer's own relationship never leave the screen, and one
// stage panel that answers where the case is, what comes next and who can do it. Presentation only: the
// server decides every fact and every action shown here, and each tab route re-checks access in the database.
// Text comes from the caller (@cdf/i18n); layout uses logical properties, so Arabic mirrors.
import type { ReactNode } from "react";
import { CDFIdentifier } from "./identifier";

/**
 * The case header (audit §22.2). L1: number and title, with the viewer's next step and the overflow menu.
 * L2: stage, dates and the case's properties. L3: owner and the viewer's relationship. L4: at most one banner.
 * It never carries the reporter reference, source, summary, names of subjects or witnesses, allegations or hold
 * reasons.
 */
export function CDFCaseHeader({
  number,
  title,
  actions,
  status,
  people,
  banner,
}: {
  number: string;
  /** User text: isolated with dir="auto", so an Arabic title in an English page (and the reverse) reads right. */
  title: string;
  /** The primary next step and the overflow menu. */
  actions?: ReactNode;
  /** Line 2: stage, since, target, priority, classification, named access, records state, legal hold. */
  status: ReactNode;
  /** Line 3: owner and "You". */
  people?: ReactNode;
  /** Line 4: one banner at a time (audit §22.9.1). */
  banner?: ReactNode;
}) {
  return (
    <header className="mb-4" data-testid="case-header">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h1 className="min-w-0 text-cdf-h1 font-semibold break-words">
          {/* Real spaces around the dot are where a long title may wrap. Without them the number, the dot
              and the first word are one unbreakable run that a phone splits mid-word. */}
          <CDFIdentifier testId="case-number">{number}</CDFIdentifier>{" "}
          <span aria-hidden="true" className="mx-1 text-cdf-text-secondary">
            ·
          </span>{" "}
          <bdi dir="auto" data-testid="case-title">
            {title}
          </bdi>
        </h1>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      <div
        className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm"
        data-testid="case-status-line"
      >
        {status}
      </div>
      {people ? (
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm" data-testid="case-people-line">
          {people}
        </div>
      ) : null}
      {banner ? <div className="mt-3">{banner}</div> : null}
    </header>
  );
}

/** "More actions" «إجراءات أخرى»: a disclosure of links, so it works without JavaScript (audit §22.5.3). */
export function CDFOverflowMenu({
  label,
  items,
  testId = "case-overflow",
}: {
  label: string;
  items: { key: string; href: string; label: string }[];
  testId?: string;
}) {
  if (items.length === 0) return null;
  return (
    <details className="relative" data-testid={testId}>
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-cdf-md border border-cdf-border bg-cdf-surface px-4 text-sm font-semibold hover:bg-cdf-hover [&::-webkit-details-marker]:hidden">
        {label}
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          className="size-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path d="m4 6 4 4 4-4" />
        </svg>
      </summary>
      <ul className="absolute end-0 z-30 mt-2 grid w-64 max-w-[calc(100vw-2rem)] gap-1 rounded-cdf-md border border-cdf-border bg-cdf-surface-elevated p-2 shadow-lg">
        {items.map((i) => (
          <li key={i.key}>
            <a
              href={i.href}
              data-testid={`${testId}-${i.key}`}
              className="flex min-h-11 items-center rounded-cdf-sm px-3 hover:bg-cdf-hover"
            >
              {i.label}
            </a>
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * Where this case is «أين وصلت القضية» (audit §22.3 block 1, §22.4). The tracker, the current state with its
 * dates, and the next steps: what the viewer can do, what blocks it and who can, and what comes later.
 */
export function CDFStagePanel({
  title,
  tracker,
  now,
  notes,
  children,
  id = "next-steps",
}: {
  title: string;
  tracker: ReactNode;
  /** "Now: Investigation · since 3 Oct 2026 · No target set". */
  now: ReactNode;
  /** A return or closing note, for example "Returned to Jurisdiction on 9 Oct 2026". */
  notes?: ReactNode;
  children: ReactNode;
  id?: string;
}) {
  return (
    <section
      id={id}
      tabIndex={-1}
      aria-labelledby={`${id}-title`}
      data-testid="stage-panel"
      className="mb-6 rounded-cdf-lg border border-cdf-border bg-cdf-surface p-4 shadow-cdf"
    >
      <h2 id={`${id}-title`} className="mb-3 text-cdf-h2 font-semibold">
        {title}
      </h2>
      {tracker}
      <div className="mb-3 grid gap-1">
        {now}
        {notes}
      </div>
      {children}
    </section>
  );
}
