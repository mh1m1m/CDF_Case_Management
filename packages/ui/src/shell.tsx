// The authenticated app shell (UX redesign S1; audit §20.1–§20.2, RC-06). One header with the environment
// marker, the product mark, the language switch and the user menu; one sidebar of at most five areas, which the
// server derives from permission AND a live relationship; one main region. Everything works without JavaScript:
// the user menu is a disclosure, and on a phone the sidebar becomes a single row of links under the header.
// Text comes from the caller (@cdf/i18n); layout uses logical properties, so Arabic mirrors.
import type { ReactNode } from "react";

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");

export interface CDFNavItem {
  key: string;
  href: string;
  label: string;
  /** The caller's own items that need their action here. Never a case count. */
  count?: number;
  /** Screen-reader text for the count, for example "3 items need your action". */
  countLabel?: string;
}

/** Digits up to 9, then "9+" (audit §20.5). */
export function countText(count: number): string {
  return count > 9 ? "9+" : String(count);
}

/**
 * The badge is positioned so that its visually hidden label (absolutely positioned) stays inside the scrolling
 * list instead of widening the page on a phone (WCAG 1.4.10).
 */
export function CDFCountBadge({ count, label }: { count: number; label: string }) {
  if (count <= 0) return null;
  return (
    <span className="relative ms-auto inline-flex min-w-6 items-center justify-center rounded-full bg-cdf-primary px-1.5 text-xs font-semibold text-cdf-primary-text tabular-nums">
      <span aria-hidden="true">{countText(count)}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

/**
 * The header link to the caller's own notifications (UX redesign S4), with their unread count. A plain link, so it
 * works without JavaScript; the accessible name carries the count ("Notifications, 3 unread").
 */
export function CDFNotificationBell({
  href,
  label,
  count,
  current,
}: {
  href: string;
  /** The accessible name, for example "Notifications" or "Notifications, 3 unread". */
  label: string;
  count: number;
  /** The page shown is the notifications list. */
  current?: boolean;
}) {
  return (
    <a
      href={href}
      aria-current={current ? "page" : undefined}
      data-testid="notification-bell"
      data-unread={count}
      className="relative inline-flex size-11 shrink-0 items-center justify-center rounded-cdf-md hover:bg-cdf-hover aria-[current=page]:bg-cdf-selected"
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="size-5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
        <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
      </svg>
      <span className="sr-only">{label}</span>
      {count > 0 ? (
        <span
          aria-hidden="true"
          className="absolute end-0.5 top-0.5 inline-flex min-w-5 items-center justify-center rounded-full bg-cdf-primary px-1 text-xs font-semibold text-cdf-primary-text tabular-nums"
        >
          {countText(count)}
        </span>
      ) : null}
    </a>
  );
}

/** The area links. `current` is the key of the area the page belongs to (the app derives it from the path). */
export function CDFSideNav({
  label,
  items,
  current,
}: {
  label: string;
  items: CDFNavItem[];
  current?: string | undefined;
}) {
  if (items.length === 0) return null;
  return (
    <nav aria-label={label} data-testid="app-sidebar" className="md:w-60 md:shrink-0">
      <ul className="relative flex gap-1 overflow-x-auto px-4 py-2 md:sticky md:top-0 md:flex-col md:overflow-visible md:px-3 md:py-4">
        {items.map((i) => (
          <li key={i.key} className="shrink-0">
            <a
              href={i.href}
              aria-current={i.key === current ? "page" : undefined}
              data-testid={`nav-${i.key}`}
              className="flex min-h-11 items-center gap-2 rounded-cdf-md px-3 py-2 font-semibold whitespace-nowrap border-s-4 border-transparent hover:bg-cdf-hover aria-[current=page]:border-cdf-primary aria-[current=page]:bg-cdf-selected"
            >
              <span>{i.label}</span>
              {i.count ? <CDFCountBadge count={i.count} label={i.countLabel ?? ""} /> : null}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** The user menu: name, roles and clearance, then links such as My access, then sign-out. */
export function CDFUserMenu({
  name,
  summaryLabel,
  details,
  children,
}: {
  name: string;
  /** Accessible name of the toggle, for example "Account menu for Investigator Alpha". */
  summaryLabel: string;
  /** Roles and clearance, as definition-list rows. */
  details: { term: string; value: ReactNode }[];
  /** Links and the sign-out form. */
  children: ReactNode;
}) {
  return (
    <details className="relative" data-testid="user-menu">
      <summary
        aria-label={summaryLabel}
        data-testid="signed-in-as"
        className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-cdf-md px-2 hover:bg-cdf-hover [&::-webkit-details-marker]:hidden"
      >
        <span
          aria-hidden="true"
          className="inline-flex size-8 items-center justify-center rounded-full bg-cdf-selected font-semibold"
        >
          {name.trim().charAt(0)}
        </span>
        <span className="hidden max-w-48 truncate sm:inline">{name}</span>
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
      <div className="absolute end-0 z-40 mt-2 w-72 max-w-[calc(100vw-2rem)] rounded-cdf-md border border-cdf-border bg-cdf-surface-elevated p-4 shadow-lg">
        <p className="mb-2 font-semibold">{name}</p>
        <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          {details.map((d) => (
            <div key={d.term} className="contents">
              <dt className="text-cdf-text-secondary">{d.term}</dt>
              <dd>{d.value}</dd>
            </div>
          ))}
        </dl>
        <div className="grid gap-2 border-t border-cdf-border pt-3">{children}</div>
      </div>
    </details>
  );
}

export function CDFAppShell(props: {
  skipLabel: string;
  /** The one-line environment marker (CLAUDE.md §0): always visible, never dismissible. */
  environment: ReactNode;
  brand: ReactNode;
  utilities?: ReactNode;
  userMenu?: ReactNode;
  nav?: ReactNode;
  /** Mounted once for the whole shell, for example the idle-session dialog. */
  session?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-cdf-bg font-cdf text-cdf-text">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:start-2 focus:top-2 focus:z-50 focus:bg-cdf-surface focus:p-2"
      >
        {props.skipLabel}
      </a>
      <header className="border-b border-cdf-border bg-cdf-surface">
        {props.environment}
        <div className="mx-auto flex min-h-14 w-full max-w-[90rem] items-center gap-3 px-4">
          <div className="flex min-w-0 items-center gap-3">{props.brand}</div>
          <div className="flex-1" />
          {props.utilities ? <div className="flex items-center gap-3 text-sm">{props.utilities}</div> : null}
          {props.userMenu}
        </div>
      </header>
      <div className="mx-auto flex w-full max-w-[90rem] flex-1 flex-col md:flex-row">
        {props.nav ? (
          <div className="border-b border-cdf-border bg-cdf-surface md:border-e md:border-b-0">
            {props.nav}
          </div>
        ) : null}
        <main id="main" tabIndex={-1} className="min-w-0 flex-1 px-4 py-6 md:px-8">
          {props.children}
        </main>
      </div>
      {props.session}
    </div>
  );
}

/**
 * One line on every screen size; the detail is dropped on a phone but stays available to screen readers. The strip
 * is positioned so that the visually hidden detail (absolutely positioned) is clipped with it rather than widening
 * the page at 320 px (WCAG 1.4.10).
 */
export function CDFEnvironmentStrip({ label, detail }: { label: string; detail: string }) {
  return (
    <div
      role="note"
      data-testid="classification-banner"
      className="relative truncate border-b border-cdf-border bg-cdf-warning-bg px-4 py-1 text-center text-sm text-cdf-warning"
    >
      <strong className="font-semibold">{label}</strong>
      <span className="ms-2 max-sm:sr-only">{detail}</span>
    </div>
  );
}

export interface CDFCrumb {
  label: ReactNode;
  href?: string;
}

/** Area › object › item (audit §20.8). The last crumb is the current page and is not a link. */
export function CDFBreadcrumbs({ label, items }: { label: string; items: CDFCrumb[] }) {
  if (items.length === 0) return null;
  return (
    <nav aria-label={label} className="mb-3 text-sm" data-testid="breadcrumbs">
      <ol className="flex flex-wrap items-center gap-1 text-cdf-text-secondary">
        {items.map((c, i) => {
          const last = i === items.length - 1;
          return (
            <li key={i} className="flex items-center gap-1">
              {c.href && !last ? (
                <a href={c.href} className="underline underline-offset-4 hover:text-cdf-text">
                  {c.label}
                </a>
              ) : (
                <span aria-current={last ? "page" : undefined} className={last ? "text-cdf-text" : undefined}>
                  {c.label}
                </span>
              )}
              {last ? null : (
                <svg
                  aria-hidden="true"
                  viewBox="0 0 16 16"
                  className="size-3 rtl:-scale-x-100"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <path d="m6 4 4 4-4 4" />
                </svg>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export interface CDFViewTab {
  key: string;
  href: string;
  label: string;
  count?: number;
  countLabel?: string;
}

/**
 * Views of one list, or the sections of one object, as links (each is a URL, so it survives reload and language
 * switch). `wrap` lets the links flow onto a second row instead of scrolling sideways (UX-109).
 */
export function CDFViewTabs({
  label,
  items,
  current,
  testId = "view-tabs",
  itemTestIdPrefix = "view-",
  wrap = false,
}: {
  label: string;
  items: CDFViewTab[];
  current: string;
  testId?: string;
  itemTestIdPrefix?: string;
  wrap?: boolean;
}) {
  return (
    <nav aria-label={label} className="mb-4 border-b border-cdf-border" data-testid={testId}>
      <ul className={cx("relative -mb-px flex gap-1", wrap ? "flex-wrap" : "overflow-x-auto")}>
        {items.map((v) => (
          <li key={v.key} className="shrink-0">
            <a
              href={v.href}
              aria-current={v.key === current ? "page" : undefined}
              data-testid={`${itemTestIdPrefix}${v.key}`}
              className="flex min-h-11 items-center gap-2 border-b-4 border-transparent px-3 py-2 font-semibold whitespace-nowrap hover:bg-cdf-hover aria-[current=page]:border-cdf-primary"
            >
              {v.label}
              {v.count ? <CDFCountBadge count={v.count} label={v.countLabel ?? ""} /> : null}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** An empty list says what this place is for and what to do next; never just "nothing here". */
export function CDFEmptyState({
  title,
  body,
  action,
  testId,
}: {
  title: string;
  body?: ReactNode;
  action?: ReactNode;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className="rounded-cdf-md border border-dashed border-cdf-border bg-cdf-surface px-6 py-8 text-center"
    >
      <p className="font-semibold">{title}</p>
      {body ? <div className="mt-1 text-cdf-text-secondary">{body}</div> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
