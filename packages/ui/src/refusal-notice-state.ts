/**
 * CDF-232: when the page-level refusal notice shows a command's refusal (pure; the React glue is refusal-notice.tsx).
 *
 * A command form shows its own refusal where the form is (UX-001). After a submit the page is read again, and when
 * another user's action has moved the form's subject on, the page no longer offers the form: it leaves the page and
 * takes its refusal with it. The notice then shows that refusal at the top of the page instead.
 *
 * The notice holds the refusal's codes and reference only (kind, detail, ref), never text, so it can carry nothing
 * about the form's subject or another user's action: its words come from packages/i18n, as the form's own do. It
 * lives in memory only, is never persisted, and clears on navigation and on the next command's answer.
 */

/** A command's refusal as the form received it: its class, the command's code and the request's reference. */
export interface Refusal {
  readonly kind: string;
  readonly detail?: string;
  readonly ref: string;
  /** The i18n sections the form tries in order for the code (`codes` when absent). */
  readonly codeSections?: readonly string[];
}

export interface RefusalNoticeState {
  /** A refusal whose form is still on the page: the form shows it, unless it leaves first. */
  readonly pending: { readonly formId: string; readonly refusal: Refusal } | null;
  /** The refusal shown at the top of the page. */
  readonly shown: Refusal | null;
}

export type RefusalNoticeEvent =
  /** A form's command answered: its refusal, or null for anything else. `mounted`: the form is on the page now. */
  | {
      readonly type: "answered";
      readonly formId: string;
      readonly refusal: Refusal | null;
      readonly mounted: boolean;
    }
  /** The form shows its refusal itself. */
  | { readonly type: "shownByForm"; readonly formId: string }
  /** The form left the page. */
  | { readonly type: "formLeft"; readonly formId: string }
  | { readonly type: "navigated" };

export const NO_REFUSAL_NOTICE: RefusalNoticeState = { pending: null, shown: null };

export function refusalNotice(state: RefusalNoticeState, event: RefusalNoticeEvent): RefusalNoticeState {
  switch (event.type) {
    case "answered":
      // The latest answer replaces whatever an earlier one left on the page.
      if (!event.refusal) return NO_REFUSAL_NOTICE;
      return event.mounted
        ? { pending: { formId: event.formId, refusal: event.refusal }, shown: null }
        : { pending: null, shown: event.refusal };
    case "shownByForm":
      return state.pending?.formId === event.formId ? { ...state, pending: null } : state;
    case "formLeft":
      return state.pending?.formId === event.formId ? { pending: null, shown: state.pending.refusal } : state;
    case "navigated":
      return state.pending || state.shown ? NO_REFUSAL_NOTICE : state;
  }
}
