export { STATES, TRANSITIONS, WORKFLOW_CODE } from "./definition";
export type { WorkflowState, WorkflowTransition } from "./definition";
import { STATES, TRANSITIONS } from "./definition";

export function stateByCode(code: string) {
  return STATES.find((s) => s.code === code);
}

/** User-invocable transitions out of a state (system transitions excluded). */
export function transitionsFrom(state: string) {
  return TRANSITIONS.filter((t) => t.from === state && !t.isSystem);
}

/** Position of a state on the case progress tracker (0-based), or -1. */
export function progressIndex(state: string): number {
  return STATES.findIndex((s) => s.code === state);
}

export type ProgressState = "done" | "current" | "upcoming" | "skipped";

export interface ProgressStep {
  /** The state code, or `skipped:<first code>` for a run of states the case never entered. */
  code: string;
  state: ProgressState;
  /** For a skipped run: the states in it, in order. */
  skipped?: string[];
}

/**
 * Path-aware case progress (UX redesign S2; audit §22.4.2, UX-032). A state counts as done only if the case's own
 * transition history went through it, never because it comes earlier in the sequence. Consecutive earlier states
 * the case never entered (a case closed at screening) form one "skipped" run. Every state after the current one
 * is upcoming, including one the case was returned from. Presentation only: the database owns the workflow.
 */
export function progressSteps(
  current: string | null,
  path: readonly { fromState: string; toState: string }[],
): ProgressStep[] {
  const now = current ? stateByCode(current) : undefined;
  if (!now) return STATES.map((s) => ({ code: s.code, state: "upcoming" }));
  const visited = new Set(path.flatMap((p) => [p.fromState, p.toState]));
  // A case with no recorded path (none exists today) keeps the positional reading rather than claiming skips.
  const entered = (code: string) => path.length === 0 || visited.has(code);
  const steps: ProgressStep[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length) steps.push({ code: `skipped:${run[0]}`, state: "skipped", skipped: run });
    run = [];
  };
  for (const s of STATES) {
    if (s.sequence < now.sequence) {
      if (entered(s.code)) {
        flush();
        steps.push({ code: s.code, state: "done" });
      } else run.push(s.code);
    } else {
      flush();
      steps.push({ code: s.code, state: s.code === now.code ? "current" : "upcoming" });
    }
  }
  return steps;
}

/** The most recent move, when it went back to an earlier, still-active state (for example a rejected approval). */
export function lastReturn<T extends { fromState: string; toState: string }>(
  path: readonly T[],
): T | undefined {
  const last = path.at(-1);
  if (!last) return undefined;
  const from = stateByCode(last.fromState);
  const to = stateByCode(last.toState);
  return from && to && to.sequence < from.sequence && to.recordsState === "ACTIVE" ? last : undefined;
}
