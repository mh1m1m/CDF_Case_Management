// Where each shell area and each My Work item leads (UX redesign S1; audit §20.5–§20.6, RC-07, RC-08). Pure
// functions: the database decides which areas and items exist; this only maps them to routes. Every route
// re-checks access in the database and answers the uniform not-found when the caller may not see it.
import type { MyArea, WorkArea, WorkItem } from "@cdf/contracts";

const AREA_HOME: Record<WorkArea, string> = {
  MY_WORK: "/my-work",
  INTAKE: "/intake",
  CASES: "/cases",
  COMMITTEE: "/my-work", // S5
  RECORDS: "/records",
  OVERSIGHT: "/oversight",
  ADMINISTRATION: "/admin/users",
  REPORTING: "/my-work", // S6
};

/** The area's link in the sidebar, opened on the area's default view for this caller. */
export function areaHref(a: Pick<MyArea, "area" | "defaultView">): string {
  if (a.area === "RECORDS" && a.defaultView === "legal-holds") return "/records/legal-holds";
  if (a.area === "OVERSIGHT")
    return `/oversight?view=${a.defaultView === "security-events" ? "security-events" : "ledger"}`;
  return AREA_HOME[a.area];
}

/** Which sidebar area a path belongs to, for `aria-current`. */
export function areaOfPath(pathname: string): WorkArea | undefined {
  const first = pathname.split("/")[1] ?? "";
  switch (first) {
    case "my-work":
      return "MY_WORK";
    case "intake":
      return "INTAKE";
    case "cases":
      return "CASES";
    case "records":
      return "RECORDS";
    case "oversight":
      return "OVERSIGHT";
    case "admin":
      return "ADMINISTRATION";
    default:
      return undefined;
  }
}

/** The page where the item's work is done. */
export function itemHref(i: WorkItem): string {
  const onCase = i.caseId ? `/cases/${i.caseId}` : null;
  switch (i.targetType) {
    case "REPORT":
      // A reply on a report that already has a case is answered on the case's Reporter tab (DEC-06).
      return i.category === "REPORTER_REPLIED" && onCase ? `${onCase}/reporter` : `/intake/${i.targetId}`;
    case "CASE":
      return i.category === "DECLARE_CONFLICT"
        ? `/cases/${i.targetId}/people#conflict`
        : `/cases/${i.targetId}`;
    case "CONFLICT":
      return onCase ? `${onCase}/people#conflict-decisions` : "/my-work";
    case "FORM_INSTANCE":
      return onCase ? `${onCase}/forms/${i.targetId}` : "/my-work";
    case "INTERVIEW":
      return onCase ? `${onCase}/interviews/${i.targetId}` : "/my-work";
    case "CASE_TASK":
    case "HOLD_RELEASE":
      return i.caseId ? `/records/${i.caseId}` : "/records";
    case "HOLD_REQUEST":
      return "/records/legal-holds";
    case "RECORD":
      // The shared retention queue (ADR-016 D8): the record's retention form, which re-checks the purpose.
      return `/records/${i.targetId}#retention`;
    default:
      return "/my-work";
  }
}

/**
 * The landing for a signed-in user (audit §20.6): by where their work is, never by role name.
 *   1. No area: /no-workspace.
 *   2. Records work only (a records-function area and no intake or case area): Records, where the queues live.
 *   3. My Work for everyone else who has it.
 *   4. Otherwise the first area in the fixed order (Oversight, Administration).
 */
export function landingFor(areas: readonly Pick<MyArea, "area" | "defaultView">[]): string {
  if (areas.length === 0) return "/no-workspace";
  const has = (code: WorkArea) => areas.some((a) => a.area === code);
  const records = areas.find((a) => a.area === "RECORDS");
  if (records && records.defaultView === "my-tasks" && !has("INTAKE") && !has("CASES"))
    return areaHref(records);
  if (has("MY_WORK")) return "/my-work";
  return areaHref(areas[0]!);
}

/** Items whose due date has passed, by `category:targetId` (shown as text, never by colour alone). */
export function overdueKeys(items: readonly WorkItem[], now: number = Date.now()): Set<string> {
  return new Set(
    items
      .filter((i) => i.dueAt !== null && Date.parse(i.dueAt) < now)
      .map((i) => `${i.category}:${i.targetId}`),
  );
}

/** Whole days since a moment (an item's age in a queue); 0 for less than a day. */
export function daysSince(iso: string, now: number = Date.now()): number {
  return Math.max(0, Math.floor((now - Date.parse(iso)) / 86_400_000));
}

/** Whether a due date has passed (a case's stage target, for example). */
export function isPast(iso: string | null, now: number = Date.now()): boolean {
  return iso !== null && Date.parse(iso) < now;
}
