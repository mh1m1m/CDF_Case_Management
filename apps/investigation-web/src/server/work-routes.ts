// Where each shell area and each My Work item leads (UX redesign S1; audit §20.5–§20.6, RC-07, RC-08). Pure
// functions: the database decides which areas and items exist; this only maps them to routes. Every route
// re-checks access in the database and answers the uniform not-found when the caller may not see it.
import type { InboxNotification, MyArea, WorkArea, WorkItem, WorkTargetType } from "@cdf/contracts";

const AREA_HOME: Record<WorkArea, string> = {
  MY_WORK: "/my-work",
  INTAKE: "/intake",
  CASES: "/cases",
  COMMITTEE: "/committees", // My Committees (Phase 12 P12-2b, ADR-055)
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
    // My Committees (P12-2b), a proceeding before the committee (P12-2c), and a meeting and its minutes, which are
    // the committee's work (P12-2a).
    case "committees":
    case "committee-proceedings":
    case "meetings":
    case "minutes":
      return "COMMITTEE";
    // A legal review assigned to the caller is their own work (P12-3a): it comes to them from My Work. So does a
    // corrective action, to the manager who disposes of it (P12-3b) and to its owner and verifier (P12-6); the case
    // team also reaches it from the case's Proceedings tab, and its breadcrumbs lead back there.
    case "legal-reviews":
    case "actions":
      return "MY_WORK";
    default:
      return undefined;
  }
}

/**
 * Purpose roots whose pages exist in this app (UX redesign S4). The database writes a notification's link (N18) and
 * a My Work row's target (2045); the inbox and My Work link to them only once the page has shipped, so nobody lands
 * on a missing page. The purpose routes of Phase 12 join this list as each one ships, under the root
 * notify.deep_link writes, and that page re-checks access in the database: meetings and minutes since P12-2a
 * (ADR-054), committees since P12-2b (ADR-055), legal reviews since P12-3a (ADR-057), and a corrective action
 * since P12-6a (ADR-058), when its page came to serve its owner and verifier as well as the case team's disposition
 * of a frozen action (P12-3b); my defence, grievances, exports, continuity imports, referrals and preliminary reviews
 * to come.
 */
export const LIVE_PURPOSE_ROOTS: readonly string[] = [
  "/committees",
  "/meetings",
  "/minutes",
  "/legal-reviews",
  "/actions",
];

/**
 * The purpose page of each Phase 12 target (plan §3 routes; P12-2 to P12-6), by the root `notify.deep_link` writes.
 * A restricted case's approval of a legal review is given from the case (P12-3a, below), not from a purpose root.
 */
const PURPOSE_ROOT: Partial<Record<WorkTargetType, string>> = {
  REFERRAL: "/referrals",
  PRELIMINARY_REVIEW: "/preliminary-reviews",
  MEETING: "/meetings",
  MINUTES: "/minutes",
  LEGAL_REVIEW: "/legal-reviews",
  DEFENCE_NOTICE: "/my-defence",
  GRIEVANCE: "/grievances",
  EXPORT: "/exports",
  CORRECTIVE_ACTION: "/actions",
  BCP_IMPORT: "/continuity/imports",
};

/** Where on the action's page each of its My Work rows lands (2045's categories; P12-6a). */
const ACTION_STEP: Readonly<Record<string, string>> = {
  ACTION_ASSIGNED: "#report",
  ACTION_RETURNED: "#report",
  ACTION_TO_VERIFY: "#verify",
};

/**
 * The page where the item's work is done, or null while that page has not shipped (migration 2045's purpose kinds):
 * the row then names the work and opens nothing, as a notification does.
 */
export function itemHref(i: WorkItem, live: readonly string[] = LIVE_PURPOSE_ROOTS): string | null {
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
      // A form on a case the caller works in opens there; one held by form-scoped access alone (S3, ADR-016 D2)
      // opens in the purpose view, which never shows the case.
      return i.area === "CASES" && onCase ? `${onCase}/forms/${i.targetId}` : `/my-work/forms/${i.targetId}`;
    case "INTERVIEW":
      return onCase ? `${onCase}/interviews/${i.targetId}` : "/my-work";
    case "CASE_TASK":
    case "HOLD_RELEASE":
      return i.caseId ? `/records/${i.caseId}` : "/records";
    case "HOLD_REQUEST":
      return "/records/legal-holds";
    case "RECORD":
      // ADR-016 D8: the record's retention form for the shared queue, or its routing form for a case the queue
      // cannot take. Both re-check the purpose in the database.
      return i.category === "RETENTION_TO_ROUTE"
        ? `/records/${i.targetId}#route-retention`
        : `/records/${i.targetId}#retention`;
    case "RECOMMENDATION_PACKAGE":
      // P12-3a (ADR-057): the case owner, as the restricted case's authority, approves a legal review of the package
      // from the case's Proceedings tab, which re-checks the approval in the database (api.legal_review_choices).
      return i.code === "LEGAL_REVIEW" && onCase
        ? `${onCase}/proceedings/legal-review-approval/${i.targetId}`
        : null;
    case "CORRECTIVE_ACTION":
      // The action's page (ADR-058), at the step the row asks for: a frozen action's disposition for the case team
      // (P12-3b), whatever roots are live, and the owner's report or the verifier's decision (P12-6a) once /actions is.
      // The page shows each form only where A2 says its command would accept the reader now.
      if (i.category === "ACTION_TO_DISPOSE") return `/actions/${i.targetId}#dispose`;
      if (!live.includes("/actions")) return null;
      return `/actions/${i.targetId}${ACTION_STEP[i.category] ?? ""}`;
    default: {
      const root = PURPOSE_ROOT[i.targetType];
      return root && live.includes(root) ? `${root}/${i.targetId}` : null;
    }
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

const NOTIFICATION_LINK = /^(\/[a-z0-9-]+)+$/;

/** Where a notification leads, or null while its page has not shipped. Never anything but an id-only path. */
export function notificationHref(
  n: Pick<InboxNotification, "deepLink">,
  live: readonly string[] = LIVE_PURPOSE_ROOTS,
): string | null {
  if (!NOTIFICATION_LINK.test(n.deepLink)) return null;
  return live.some((root) => n.deepLink.startsWith(`${root}/`)) ? n.deepLink : null;
}
