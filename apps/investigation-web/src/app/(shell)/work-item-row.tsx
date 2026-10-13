// One My Work row, shared by My Work and a case's "Your items on this case" (audit §22.3 block 2: one model).
import type { WorkItem } from "@cdf/contracts";
import type { MessageKey, Translator } from "@cdf/i18n";
import { CDFDateTime, CDFIdentifier, CDFWorkItem } from "@cdf/ui";
import { itemHref } from "@/server/work-routes";

export function workActionLabel(t: Translator, i: WorkItem): string {
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

export function WorkItemRow({
  t,
  item: i,
  overdue,
  showCase = true,
}: {
  t: Translator;
  item: WorkItem;
  overdue: boolean;
  /** Off inside a case, where the case number is already in the header. */
  showCase?: boolean;
}) {
  return (
    <CDFWorkItem
      href={itemHref(i)}
      action={workActionLabel(t, i)}
      testId={`work-item-${i.category}`}
      reference={
        i.caseNumber && showCase ? (
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
            {/* With the time, so items of the same kind received the same day can be told apart. */}
            {t("myWork.since")} <CDFDateTime value={i.sinceAt} locale={t.locale} />
          </>
        ) : undefined
      }
    />
  );
}
