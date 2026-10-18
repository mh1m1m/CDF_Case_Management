// What every Administration page shares (UX redesign Phase 12 P12-8a): its title and purpose, the pages this caller's
// permissions open, and the reminder that nothing here is case content (§21). Rendered by each page only after its own
// access check has passed, so a refused page is the same not-found as a page that does not exist: nothing of the
// area shows before that check.
import type { ReactNode } from "react";
import { adminViews } from "@cdf/authorization";
import type { Actor, AdminView } from "@cdf/contracts";
import type { MessageKey, Translator } from "@cdf/i18n";
import { CDFPageHeader, CDFViewTabs } from "@cdf/ui";

export function AdminFrame({
  t,
  actor,
  view,
  intro,
  children,
}: {
  t: Translator;
  actor: Actor;
  view: AdminView;
  intro: string;
  children: ReactNode;
}) {
  const views = adminViews(actor);
  return (
    <>
      <CDFPageHeader title={t(`admin.views.${view}` as MessageKey)} intro={intro} />
      {/* One page needs no list of pages. */}
      {views.length > 1 ? (
        <CDFViewTabs
          label={t("admin.views.label")}
          current={view}
          testId="admin-views"
          itemTestIdPrefix="admin-view-"
          wrap
          items={views.map((v) => ({
            key: v,
            href: `/admin/${v}`,
            label: t(`admin.views.${v}` as MessageKey),
          }))}
        />
      ) : null}
      <p
        className="mb-4 rounded-cdf-md border border-cdf-border bg-cdf-surface-subtle px-3 py-2 text-sm"
        data-testid="no-case-content"
      >
        {t("shell.noCaseContent")}
      </p>
      {children}
    </>
  );
}
