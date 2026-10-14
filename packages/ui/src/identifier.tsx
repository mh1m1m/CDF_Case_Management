// Bidi-safe identifiers, dates and metadata lines (UX-013, audit RC-13). Arabic pages scrambled mixed-direction
// data: "10 · 2026/10/Triage Officer Beta، 9:04 م" was one concatenated string. Every part is now isolated, so
// each keeps its own direction and the parts follow the page's direction.
import { formatDate, formatDateTime, formatRecordDateToParts, type Locale } from "@cdf/i18n";
import { Fragment, type ReactNode } from "react";

/**
 * A system identifier (case number, Report ID, evidence number, hash). Always left-to-right, isolated from the
 * surrounding text, with tabular digits. `code` never wraps; `hash` may break anywhere, for long digests.
 */
export function CDFIdentifier({
  children,
  variant = "code",
  testId,
}: {
  children: ReactNode;
  variant?: "code" | "hash";
  testId?: string;
}) {
  return (
    <bdi
      dir="ltr"
      data-testid={testId}
      className={
        variant === "hash" ? "font-mono text-sm break-all tabular-nums" : "whitespace-nowrap tabular-nums"
      }
    >
      {children}
    </bdi>
  );
}

/** A date or date and time, as a machine-readable <time> with an isolated, localised label. */
export function CDFDateTime({
  value,
  locale,
  dateOnly = false,
  testId,
}: {
  value: string | Date;
  locale: Locale;
  dateOnly?: boolean;
  testId?: string;
}) {
  const iso = typeof value === "string" ? value : value.toISOString();
  return (
    <time dateTime={iso} data-testid={testId}>
      <bdi className="whitespace-nowrap">
        {dateOnly ? formatDate(locale, value) : formatDateTime(locale, value)}
      </bdi>
    </time>
  );
}

/**
 * A date on a formal generated record (DEC-51): Gregorian first and Hijri second, "13 October 2026 (2 Jumada I
 * 1448H)", from the platform's Umm al-Qura calendar. The machine value is the stored timestamp. Each date stays on
 * one line and the line may break between them. Operational screens keep CDFDateTime.
 */
export function CDFRecordDate({
  value,
  locale,
  withTime = false,
  testId,
}: {
  value: string | Date;
  locale: Locale;
  withTime?: boolean;
  testId?: string;
}) {
  const iso = typeof value === "string" ? value : value.toISOString();
  return (
    <time dateTime={iso} data-testid={testId}>
      <bdi>
        {formatRecordDateToParts(locale, value, { withTime }).map((p, i) =>
          p.type === "literal" ? (
            <Fragment key={i}>{p.value}</Fragment>
          ) : (
            <span key={i} data-part={p.type} className="whitespace-nowrap">
              {p.value}
            </span>
          ),
        )}
      </bdi>
    </time>
  );
}

export interface CDFMetaPart {
  /** Stable key for the part (for example "actor" or "at"). */
  key: string;
  value: ReactNode;
  /** Optional visible label shown before the value, for example "By". */
  label?: string;
}

/**
 * A metadata line ("who · when · where"). Each part is isolated in its own <bdi>; the separators are decorative
 * and hidden from assistive technology, which reads the parts as a list.
 */
export function CDFMeta({ parts, testId }: { parts: CDFMetaPart[]; testId?: string }) {
  const shown = parts.filter((p) => p.value !== null && p.value !== undefined && p.value !== "");
  return (
    <ul
      data-testid={testId}
      className="m-0 flex list-none flex-wrap items-baseline gap-x-2 p-0 text-sm text-cdf-text-secondary"
    >
      {shown.map((p, i) => (
        <li key={p.key} className="inline-flex items-baseline gap-x-2">
          {i > 0 ? <span aria-hidden="true">·</span> : null}
          <span>
            {p.label ? <span className="font-semibold">{p.label} </span> : null}
            <bdi>{p.value}</bdi>
          </span>
        </li>
      ))}
    </ul>
  );
}
