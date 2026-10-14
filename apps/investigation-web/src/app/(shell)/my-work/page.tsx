// My Work «أعمالي» (UX redesign S1; audit §21.4, RC-08; CDF-121). The caller's own work, derived by the
// database from what they can already act on: no row exists for a case, report, form or interview they cannot
// reach, and a row carries ids, codes and dates only. Each row links to the page where the work is done, which
// re-checks access. Views are URLs, so a view survives reload, sign-in and the language switch.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { WORK_AREAS, type WorkItem, type WorkView } from "@cdf/contracts";
import type { MessageKey } from "@cdf/i18n";
import { buttonClass, CDFEmptyState, CDFPageHeader, CDFViewTabs, CDFWorkList } from "@cdf/ui";
import { investigationService, myShellAreas, requireActor } from "@/server/container";
import { getTranslator } from "@/server/locale";
import { overdueKeys } from "@/server/work-routes";
import { WorkItemRow, someOpenLater } from "../work-item-row";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("myWork.title") };
}

const VIEWS = [
  ["needs-action", "NEEDS_ACTION"],
  ["my-cases", "MY_CASES"],
  ["due-soon", "DUE_SOON"],
  ["waiting", "WAITING"],
] as const satisfies readonly (readonly [string, WorkView])[];
type ViewKey = (typeof VIEWS)[number][0];

export default async function MyWorkPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { ctx } = await requireActor();
  const [areas, items] = await Promise.all([myShellAreas(), investigationService().myWorkItems(ctx)]);
  if (!areas.some((a) => a.area === "MY_WORK")) notFound();
  const t = await getTranslator();

  const raw = (await searchParams).view;
  const view: ViewKey = VIEWS.some(([k]) => k === raw) ? (raw as ViewKey) : "needs-action";
  const code = VIEWS.find(([k]) => k === view)![1];
  const rows = items.filter((i) => i.view === code);
  const overdueSet = overdueKeys(rows);
  const hasProvisional = rows.some((i) => i.dueSource === "WORKFLOW_SLA_PROVISIONAL");

  const renderItem = (i: WorkItem) => (
    <WorkItemRow
      key={`${i.category}:${i.targetId}`}
      t={t}
      item={i}
      overdue={overdueSet.has(`${i.category}:${i.targetId}`)}
    />
  );

  // "Needs my action" is grouped by area in the sidebar's order, so a combined role sees each queue separately.
  const groups =
    code === "NEEDS_ACTION"
      ? WORK_AREAS.map((a) => ({ area: a, rows: rows.filter((r) => r.area === a) })).filter(
          (g) => g.rows.length,
        )
      : [{ area: null, rows }];
  const count = (c: WorkView) => items.filter((i) => i.view === c).length;
  // An empty view points to the first other view that has the caller's items, so the landing is never a dead end
  // while work exists elsewhere (UX-004). It names the view, never a number.
  const elsewhere = rows.length === 0 ? VIEWS.find(([k, c]) => k !== view && count(c) > 0) : undefined;

  return (
    <>
      <CDFPageHeader title={t("myWork.title")} intro={t("myWork.intro")} />
      <CDFViewTabs
        label={t("myWork.views")}
        current={view}
        items={VIEWS.map(([key, c]) => ({
          key,
          href: `/my-work?view=${key}`,
          label: t(`myWork.view.${key}` as MessageKey),
          ...(c === "NEEDS_ACTION"
            ? { count: count(c), countLabel: t("shell.countLabel", { count: count(c) }) }
            : {}),
        }))}
      />
      {rows.length === 0 ? (
        <CDFEmptyState
          title={t(`myWork.empty.${view}` as MessageKey)}
          body={t("myWork.emptyBody")}
          testId="my-work-empty"
          action={
            elsewhere ? (
              <a
                href={`/my-work?view=${elsewhere[0]}`}
                className={buttonClass("secondary")}
                data-testid="my-work-elsewhere"
              >
                {t("myWork.openView", { view: t(`myWork.view.${elsewhere[0]}` as MessageKey) })}
              </a>
            ) : undefined
          }
        />
      ) : (
        <div className="grid gap-6" data-testid={`my-work-${view}`}>
          {groups.map((g) => {
            const heading = g.area && groups.length > 1 ? t(`shell.area.${g.area}` as MessageKey) : null;
            return (
              <section key={g.area ?? "all"} aria-labelledby={heading ? `group-${g.area}` : undefined}>
                {heading ? (
                  <h2 id={`group-${g.area}`} className="mb-2 text-cdf-h2 font-semibold">
                    {heading}
                  </h2>
                ) : null}
                <CDFWorkList label={heading ?? t(`myWork.view.${view}` as MessageKey)}>
                  {g.rows.map(renderItem)}
                </CDFWorkList>
              </section>
            );
          })}
        </div>
      )}
      {someOpenLater(rows) ? (
        <p className="mt-4 text-sm text-cdf-text-secondary" data-testid="my-work-page-later">
          {t("myWork.pageLater")}
        </p>
      ) : null}
      {hasProvisional ? (
        <p className="mt-4 text-sm text-cdf-text-secondary">{t("myWork.provisionalNote")}</p>
      ) : null}
    </>
  );
}
