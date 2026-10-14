// One row of My Work (UX redesign S1; audit RC-08, §21.4). The row names what to do, on which case, and by
// when, with where the date comes from. It carries no title, name or narrative: the database returns ids, codes
// and dates only (DEC-22). The whole row is one link to the place the work is done; while that page has not
// shipped (Phase 12 purpose kinds, migration 2045) the row is the same text and opens nothing.
import type { ReactNode } from "react";

export function CDFWorkList({
  label,
  children,
  testId,
}: {
  label: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <ul aria-label={label} data-testid={testId} className="grid gap-2">
      {children}
    </ul>
  );
}

export function CDFWorkItem({
  href,
  action,
  reference,
  detail,
  due,
  since,
  overdue,
  testId,
}: {
  /** Where the work is done; null while its page has not shipped, and the row then opens nothing. */
  href: string | null;
  /** What to do, for example "Review form". */
  action: string;
  /** The case or report identifier, already wrapped in CDFIdentifier. */
  reference?: ReactNode;
  /** A non-sensitive code or type, or the reasons returned work came back with, already translated. */
  detail?: ReactNode;
  /** "Due 14 Oct 2026 (provisional)", already formatted. */
  due?: ReactNode;
  /** "Since 10 Oct 2026", already formatted. */
  since?: ReactNode;
  /** Visible text, so the state is not carried by colour alone (WCAG 1.4.1). */
  overdue?: string | undefined;
  testId?: string;
}) {
  const box =
    "grid min-h-11 gap-1 rounded-cdf-md border border-cdf-border bg-cdf-surface p-3 sm:grid-cols-[1fr_auto] sm:items-center sm:gap-4";
  const content = (
    <>
      <span className="grid gap-0.5">
        <span className={href ? "font-semibold underline-offset-4 group-hover:underline" : "font-semibold"}>
          {action}
        </span>
        {reference ? <span className="text-sm text-cdf-text-secondary">{reference}</span> : null}
        {detail ? <span className="text-sm text-cdf-text-secondary">{detail}</span> : null}
      </span>
      <span className="grid gap-0.5 text-sm sm:text-end">
        {overdue ? <span className="font-semibold text-cdf-warning">{overdue}</span> : null}
        {due ? <span>{due}</span> : null}
        {since ? <span className="text-cdf-text-secondary">{since}</span> : null}
      </span>
    </>
  );
  return (
    <li data-testid={testId}>
      {href ? (
        <a href={href} className={`group ${box} hover:bg-cdf-hover focus-visible:outline-2`}>
          {content}
        </a>
      ) : (
        <div className={box} data-opens="later">
          {content}
        </div>
      )}
    </li>
  );
}
