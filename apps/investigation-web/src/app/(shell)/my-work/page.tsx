// My Work «أعمالي» (UX redesign S1; audit §21.4, RC-08; CDF-121). The caller's own work, derived by the
// database from what they can already act on: no row exists for a case, report, form or interview they cannot
// reach, and a row carries ids, codes and dates only. Each row links to the page where the work is done, which
// re-checks access. Views are URLs, so a view survives reload, sign-in and the language switch.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { shellAreas } from "@cdf/authorization";
import { WORK_AREAS, type WorkItem, type WorkView } from "@cdf/contracts";
import type { MessageKey, Translator } from "@cdf/i18n";
import {
  CDFDateTime,
  CDFEmptyState,
  CDFIdentifier,
  CDFPageHeader,
  CDFViewTabs,
  CDFWorkItem,
  CDFWorkList,
} from "@cdf/ui";
import { investigationService, requireActor } from "@/server/container";
import { getTranslator } from "@/server/locale";
import { itemHref, overdueKeys } from "@/server/work-routes";

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

function actionLabel(t: Translator, i: WorkItem): string {
  if (i.category.startsWith("TASK_"))
    return t("myWork.task", {
      task: t.code("records.taskTypeName", i.category.slice(5), "records.taskType"),
    });
  return t(`myWork.action.${i.category}` as MessageKey);
}

function dueLabel(t: Translator, i: WorkItem): string {
  if (i.dueSource === "WORKFLOW_SLA_PROVISIONAL") return t("myWork.dueProvisional");
  if (i.dueSource === "SCHEDULE") return t("myWork.scheduled");
  return t("myWork.due");
}

export default async function MyWorkPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { actor, ctx } = await requireActor();
  const service = investigationService();
  const [areas, items] = await Promise.all([service.myAreas(ctx), service.myWorkItems(ctx)]);
  if (!shellAreas(actor, areas).some((a) => a.area === "MY_WORK")) notFound();
  const t = await getTranslator();

  const raw = (await searchParams).view;
  const view: ViewKey = VIEWS.some(([k]) => k === raw) ? (raw as ViewKey) : "needs-action";
  const code = VIEWS.find(([k]) => k === view)![1];
  const rows = items.filter((i) => i.view === code);
  const overdueSet = overdueKeys(rows);
  const hasProvisional = rows.some((i) => i.dueSource === "WORKFLOW_SLA_PROVISIONAL");

  const renderItem = (i: WorkItem) => {
    const overdue = overdueSet.has(`${i.category}:${i.targetId}`);
    return (
      <CDFWorkItem
        key={`${i.category}:${i.targetId}`}
        href={itemHref(i)}
        action={actionLabel(t, i)}
        testId={`work-item-${i.category}`}
        reference={
          i.caseNumber ? (
            <>
              {t("myWork.caseRef")} <CDFIdentifier>{i.caseNumber}</CDFIdentifier>
            </>
          ) : i.targetType === "REPORT" ? (
            t("myWork.reportRef")
          ) : undefined
        }
        overdue={overdue ? t("myWork.overdue") : undefined}
        due={
          i.dueAt ? (
            <>
              {dueLabel(t, i)}{" "}
              <CDFDateTime value={i.dueAt} locale={t.locale} dateOnly={i.dueSource === "TASK"} />
            </>
          ) : undefined
        }
        since={
          i.sinceAt ? (
            <>
              {t("myWork.since")} <CDFDateTime value={i.sinceAt} locale={t.locale} dateOnly />
            </>
          ) : undefined
        }
      />
    );
  };

  // "Needs my action" is grouped by area in the sidebar's order, so a combined role sees each queue separately.
  const groups =
    code === "NEEDS_ACTION"
      ? WORK_AREAS.map((a) => ({ area: a, rows: rows.filter((r) => r.area === a) })).filter(
          (g) => g.rows.length,
        )
      : [{ area: null, rows }];
  const count = (c: WorkView) => items.filter((i) => i.view === c).length;

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
      {hasProvisional ? (
        <p className="mt-4 text-sm text-cdf-text-secondary">{t("myWork.provisionalNote")}</p>
      ) : null}
    </>
  );
}
