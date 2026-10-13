/**
 * Corrective-action rules (ADR-033, migration 1940). Pure functions: the UI uses them to offer the next steps and to
 * show the case's execution state; the application layer uses them to refuse early. The api.* commands are the
 * authority and re-check every transition.
 */
import type { CorrectiveActionStatus, ExecutionState } from "@cdf/contracts";

/** What an action needs for these rules: its status and its due date (a calendar date in Riyadh, YYYY-MM-DD). */
export interface ActionProgress {
  status: CorrectiveActionStatus;
  dueDate: string;
}

export type CorrectiveActionCommand =
  "assignOwner" | "changeDueDate" | "recordProgress" | "submitCompletion" | "verify" | "reopen" | "waive";

const COMMANDS: Readonly<Record<CorrectiveActionStatus, readonly CorrectiveActionCommand[]>> = {
  OPEN: ["assignOwner", "changeDueDate", "recordProgress", "submitCompletion", "waive"],
  IN_PROGRESS: ["assignOwner", "changeDueDate", "recordProgress", "submitCompletion", "waive"],
  PENDING_VERIFICATION: ["changeDueDate", "verify", "waive"],
  COMPLETED: ["reopen"],
  WAIVED: [],
};

/** The commands an action's status allows. Who may run each is decided by permission and, for reporting, ownership. */
export function allowedActionCommands(status: CorrectiveActionStatus): readonly CorrectiveActionCommand[] {
  return COMMANDS[status];
}

/** Completed or waived: nothing more is expected of the owner. */
export function isActionClosed(status: CorrectiveActionStatus): boolean {
  return status === "COMPLETED" || status === "WAIVED";
}

/** Still with its owner after the due date. A submitted action waits on its verifier, so it is not overdue. */
export function isOverdue(action: ActionProgress, today: string): boolean {
  return (action.status === "OPEN" || action.status === "IN_PROGRESS") && action.dueDate < today;
}

/** The calendar date in Riyadh (UTC+3, no daylight saving) at an instant; due dates are dates there. */
export function riyadhDate(at: Date): string {
  return new Date(at.getTime() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * The case's execution state (CRM statuses S013–S020, S036, S037, S049, rationalized as a derived value): one entry
 * per actionable item the authority approved, holding the actions opened for it. Null when nothing is to be executed.
 * An item is executed when it has actions and every one is completed or waived.
 */
export function executionState(
  items: readonly (readonly ActionProgress[])[],
  today: string,
): ExecutionState | null {
  if (items.length === 0) return null;
  const actions = items.flat();
  if (actions.some((a) => isOverdue(a, today))) return "OVERDUE";
  const executed = items.filter(
    (item) => item.length > 0 && item.every((a) => isActionClosed(a.status)),
  ).length;
  if (executed === items.length) return "EXECUTED";
  if (executed > 0) return "PARTIALLY_EXECUTED";
  if (actions.some((a) => a.status === "PENDING_VERIFICATION")) return "FOLLOW_UP";
  if (actions.some((a) => a.status !== "OPEN")) return "IN_PROGRESS";
  return "NOT_STARTED";
}
