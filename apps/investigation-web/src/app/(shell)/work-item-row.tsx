// One My Work row, shared by My Work and a case's "Your items on this case" (audit §22.3 block 2: one model).
import type { WorkItem } from "@cdf/contracts";
import { formatList, type MessageKey, type Translator } from "@cdf/i18n";
import { CDFDateTime, CDFIdentifier, CDFWorkItem } from "@cdf/ui";
import { itemHref } from "@/server/work-routes";

export function workActionLabel(t: Translator, i: WorkItem): string {
  if (i.category.startsWith("TASK_"))
    return t("myWork.task", {
      task: t.code("records.taskTypeName", i.category.slice(5), "records.taskType"),
    });
  // A restricted case's authority approval says which one it is (migration 2045: its code).
  if (i.category === "RESTRICTED_APPROVAL")
    return t.code("myWork.restrictedApproval", i.code ?? "", "myWork.action.RESTRICTED_APPROVAL");
  return t(`myWork.action.${i.category}` as MessageKey);
}

function dueLabel(t: Translator, i: WorkItem): string {
  if (i.dueSource === "WORKFLOW_SLA_PROVISIONAL") return t("myWork.dueProvisional");
  if (i.dueSource === "SCHEDULE") return t("myWork.scheduled");
  if (i.dueSource === "NOTICE") return t("myWork.respondBy");
  if (i.dueSource === "MINUTES_REVIEW") return t("myWork.reviewBy");
  return t("myWork.due");
}

/**
 * The row's second line besides the case (DEC-22, AMB-250): the reasons returned work came back with, a form's
 * code, a notice's kind, an action's type, or a defence period that is suspended. Codes only, translated.
 */
function workDetail(t: Translator, i: WorkItem) {
  if (i.reasonCodes?.length)
    return t("myWork.returnedFor", {
      reasons: formatList(
        t.locale,
        i.reasonCodes.map((r) => t.code("returnReason", r, "returnReason.OTHER")),
      ),
    });
  if (i.targetType === "FORM_INSTANCE" && i.code)
    return (
      <>
        {t("myWork.formRef")} <CDFIdentifier>{i.code}</CDFIdentifier>
      </>
    );
  if (i.category === "DEFENCE_DUE" && i.code === "SUSPENDED") return t("myWork.defenceSuspended");
  if (i.category === "NOTICE_TO_ACKNOWLEDGE" && i.code)
    return t.code("myWork.noticeKind", i.code, "myWork.noticeKind.OTHER");
  if (i.targetType === "CORRECTIVE_ACTION" && i.code)
    return t.code("myWork.actionType", i.code, "myWork.actionType.OTHER");
  return undefined;
}

/** Whether any of these rows names work whose page has not shipped yet (it then opens nothing). */
export function someOpenLater(items: readonly WorkItem[]): boolean {
  return items.some((i) => itemHref(i) === null);
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
      detail={workDetail(t, i)}
      overdue={overdue ? t("myWork.overdue") : undefined}
      due={
        i.dueAt ? (
          <>
            {dueLabel(t, i)}{" "}
            <CDFDateTime
              value={i.dueAt}
              locale={t.locale}
              dateOnly={i.dueSource === "TASK" || i.dueSource === "ACTION"}
            />
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
