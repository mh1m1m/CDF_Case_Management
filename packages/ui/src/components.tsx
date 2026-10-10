/**
 * CDF design-system primitives (protocol §41–§44). Server-component safe: no browser APIs, and no hooks other than
 * `useId`, which React supports in Server Components.
 * Text is always passed in by the caller from @cdf/i18n; components never hard-code copy.
 * Layout uses logical properties (ps/pe/ms/me/start/end) so RTL and LTR both work.
 */
import { useId, type ReactNode } from "react";
import { CDFFieldError } from "./field-errors";
import { CDFScrollRegion } from "./scroll-region";

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");

// ---- Classification banner (synthetic-data notice, §2) -------------------------------------------
export function CDFClassificationBanner({ label, detail }: { label: string; detail: string }) {
  return (
    <div
      role="note"
      data-testid="classification-banner"
      className="bg-cdf-warning-bg text-cdf-warning border-b border-cdf-border px-4 py-1.5 text-center text-sm"
    >
      <strong className="font-semibold">{label}</strong>
      <span className="ms-2">{detail}</span>
    </div>
  );
}

// ---- Shell ---------------------------------------------------------------------------------------
export function CDFShell(props: {
  skipLabel: string;
  banner: ReactNode;
  brand: ReactNode;
  nav?: ReactNode;
  utilities?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-cdf-bg text-cdf-text font-cdf">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:start-2 focus:top-2 focus:z-50 focus:bg-cdf-surface focus:p-2"
      >
        {props.skipLabel}
      </a>
      {/* The banner sits inside <header> so all page content is in a landmark (WCAG 1.3.1). */}
      <header className="bg-cdf-surface border-b border-cdf-border">
        {props.banner}
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-4 py-3">
          <div className="flex items-center gap-3">{props.brand}</div>
          {props.nav ? <div className="flex-1">{props.nav}</div> : <div className="flex-1" />}
          {props.utilities ? <div className="flex items-center gap-3 text-sm">{props.utilities}</div> : null}
        </div>
      </header>
      <main id="main" className="mx-auto max-w-6xl px-4 py-6" tabIndex={-1}>
        {props.children}
      </main>
    </div>
  );
}

export function CDFPageHeader({
  title,
  intro,
  actions,
}: {
  title: string;
  intro?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-cdf-h1 font-semibold">{title}</h1>
        {intro ? <p className="mt-1 text-cdf-text-secondary">{intro}</p> : null}
      </div>
      {actions}
    </div>
  );
}

// ---- Buttons and form controls ---------------------------------------------------------------------
type Variant = "primary" | "secondary" | "danger" | "ghost";
const buttonVariants: Record<Variant, string> = {
  primary: "bg-cdf-primary text-cdf-primary-text hover:opacity-90",
  secondary: "bg-cdf-surface text-cdf-text border border-cdf-border hover:bg-cdf-surface-subtle",
  danger: "bg-cdf-danger text-cdf-primary-text hover:opacity-90",
  ghost: "text-cdf-text underline-offset-4 hover:underline",
};
export function buttonClass(variant: Variant = "primary") {
  return cx(
    "inline-flex min-h-11 items-center justify-center gap-2 rounded-cdf-md px-4 py-2 text-sm font-semibold",
    "disabled:cursor-not-allowed disabled:opacity-50 transition-opacity",
    buttonVariants[variant],
  );
}
export function CDFButton({
  variant = "primary",
  className,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return <button type="button" className={cx(buttonClass(variant), className)} {...rest} />;
}

export const inputClass =
  "block w-full min-h-11 rounded-cdf-md border border-cdf-border bg-cdf-surface px-3 py-2 text-cdf-text aria-[invalid=true]:border-cdf-danger";
export const textareaClass = cx(inputClass, "min-h-28");

export function fieldIds(id: string, opts: { hint?: string | undefined; error?: string | undefined }) {
  const describedBy = [opts.hint ? `${id}-hint` : null, opts.error ? `${id}-error` : null]
    .filter(Boolean)
    .join(" ");
  return {
    id,
    "aria-invalid": opts.error ? (true as const) : undefined,
    "aria-describedby": describedBy || undefined,
  };
}

export function CDFField(props: {
  id: string;
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
  optionalLabel?: string | undefined;
  /** Visible "(Required)" marker (WCAG 3.3.2); the control itself carries `required` for assistive technology. */
  requiredLabel?: string | undefined;
  children: ReactNode;
}) {
  const marker = props.requiredLabel ?? props.optionalLabel;
  return (
    <div className="mb-4">
      <label htmlFor={props.id} className="mb-1 block font-semibold">
        {props.label}
        {marker ? <span className="ms-2 text-sm font-normal text-cdf-text-secondary">({marker})</span> : null}
      </label>
      {props.hint ? (
        <p id={`${props.id}-hint`} className="mb-1 text-sm text-cdf-text-secondary">
          {props.hint}
        </p>
      ) : null}
      {props.children}
      {props.error ? (
        <p id={`${props.id}-error`} className="mt-1 text-sm font-semibold text-cdf-danger">
          {props.error}
        </p>
      ) : (
        // Errors a server action reports for this control (see CDFFieldErrorsProvider).
        <CDFFieldError id={props.id} />
      )}
    </div>
  );
}

// ---- Feedback ----------------------------------------------------------------------------------------
type Tone = "info" | "success" | "warning" | "danger" | "neutral";
const toneClasses: Record<Tone, string> = {
  info: "bg-cdf-info-bg text-cdf-info",
  success: "bg-cdf-success-bg text-cdf-success",
  warning: "bg-cdf-warning-bg text-cdf-warning",
  danger: "bg-cdf-danger-bg text-cdf-danger",
  neutral: "bg-cdf-surface-subtle text-cdf-text",
};

export function CDFAlert({
  tone = "info",
  title,
  children,
  testId,
}: {
  tone?: Tone;
  title?: string;
  children?: ReactNode;
  testId?: string;
}) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      data-testid={testId}
      className={cx("mb-4 rounded-cdf-md border border-cdf-border p-3", toneClasses[tone])}
    >
      {title ? <p className="font-semibold">{title}</p> : null}
      {children ? <div className={title ? "mt-1" : undefined}>{children}</div> : null}
    </div>
  );
}

export function CDFBadge({
  tone = "neutral",
  children,
  testId,
}: {
  tone?: Tone;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <span
      data-testid={testId}
      className={cx(
        "inline-flex items-center rounded-cdf-sm px-2 py-0.5 text-xs font-semibold",
        toneClasses[tone],
      )}
    >
      {children}
    </span>
  );
}

export function classificationTone(level: string): Tone {
  return level === "SECRET"
    ? "danger"
    : level === "CONFIDENTIAL"
      ? "warning"
      : level === "RESTRICTED"
        ? "info"
        : "neutral";
}

// ---- Containers ------------------------------------------------------------------------------------------
export function CDFCard({
  title,
  children,
  actions,
  testId,
}: {
  title?: string;
  children: ReactNode;
  actions?: ReactNode;
  testId?: string;
}) {
  // useId, not the title: deriving ids from text dropped every Arabic letter, so all cards shared "card--".
  const id = useId();
  const headingId = title ? `card-${id}` : undefined;
  return (
    <section
      aria-labelledby={headingId}
      data-testid={testId}
      className="mb-6 rounded-cdf-lg border border-cdf-border bg-cdf-surface p-4 shadow-cdf"
    >
      {title || actions ? (
        <div className="mb-3 flex items-center justify-between gap-2">
          {title ? (
            <h2 id={headingId} className="text-cdf-h2 font-semibold">
              {title}
            </h2>
          ) : null}
          {actions}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function CDFDescriptionList({ items }: { items: { term: string; value: ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-[max-content_1fr]">
      {items.map((i) => (
        <div key={i.term} className="contents">
          <dt className="font-semibold text-cdf-text-secondary">{i.term}</dt>
          <dd className="whitespace-pre-wrap break-words">{i.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function CDFTable<T>(props: {
  caption: string;
  columns: { header: string; cell: (row: T) => ReactNode }[];
  rows: T[];
  rowKey: (row: T) => string;
  empty: string;
  testId?: string;
}) {
  if (props.rows.length === 0) return <p className="text-cdf-text-secondary">{props.empty}</p>;
  return (
    // Focusable and labelled only while it actually scrolls (WCAG 2.1.1, 2.4.3).
    <CDFScrollRegion
      label={props.caption}
      className="overflow-x-auto rounded-cdf-lg border border-cdf-border bg-cdf-surface"
    >
      <table className="w-full text-start text-sm" data-testid={props.testId}>
        <caption className="sr-only">{props.caption}</caption>
        <thead className="bg-cdf-surface-subtle">
          <tr>
            {props.columns.map((c) => (
              <th key={c.header} scope="col" className="px-3 py-2 text-start font-semibold">
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.map((r) => (
            <tr key={props.rowKey(r)} className="border-t border-cdf-border">
              {props.columns.map((c) => (
                <td key={c.header} className="px-3 py-2 align-top">
                  {c.cell(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </CDFScrollRegion>
  );
}

// ---- Workflow progress and timeline ----------------------------------------------------------------------
export function CDFProgressTracker({
  label,
  steps,
  current,
  stateLabels,
}: {
  label: string;
  steps: { code: string; label: string }[];
  current: string | null;
  /** Visually hidden state for each step, so progress is not conveyed by colour alone (WCAG 1.4.1, 1.3.1). */
  stateLabels: { done: string; current: string; upcoming: string };
}) {
  const currentIndex = steps.findIndex((s) => s.code === current);
  return (
    // One labelled region (not navigation). Scrollable on narrow screens, so keyboard focusable (WCAG 2.1.1).
    <div role="region" aria-label={label} tabIndex={0} className="relative mb-6 overflow-x-auto">
      <ol className="flex min-w-max gap-1 text-xs">
        {steps.map((s, i) => {
          const state = i < currentIndex ? "done" : i === currentIndex ? "current" : "upcoming";
          return (
            <li
              key={s.code}
              data-state={state}
              aria-current={state === "current" ? "step" : undefined}
              className={cx(
                "inline-flex items-center gap-1 rounded-cdf-sm border px-2 py-1",
                state === "done" && "border-cdf-success bg-cdf-success-bg text-cdf-success",
                state === "current" &&
                  "border-cdf-primary bg-cdf-primary text-cdf-primary-text font-semibold",
                state === "upcoming" && "border-dashed border-cdf-border text-cdf-text-secondary",
              )}
            >
              {state === "done" ? (
                <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3 shrink-0" fill="none">
                  <path d="M3 8.5l3 3 7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              ) : null}
              {s.label}
              <span className="sr-only"> ({stateLabels[state]})</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export function CDFTimeline({
  items,
  empty,
  testId,
}: {
  items: { id: string; title: string; meta: string; body?: string | null }[];
  empty: string;
  testId?: string;
}) {
  if (items.length === 0) return <p className="text-cdf-text-secondary">{empty}</p>;
  return (
    <ol className="border-s-2 border-cdf-border ps-4" data-testid={testId}>
      {items.map((i) => (
        <li key={i.id} className="mb-3">
          <p className="font-semibold">{i.title}</p>
          <p className="text-xs text-cdf-text-secondary">{i.meta}</p>
          {i.body ? <p className="mt-1 text-sm whitespace-pre-wrap break-words">{i.body}</p> : null}
        </li>
      ))}
    </ol>
  );
}
