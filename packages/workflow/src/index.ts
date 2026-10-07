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
