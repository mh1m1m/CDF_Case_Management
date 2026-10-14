"use client";
import {
  startTransition,
  useActionState,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
} from "react";
import type { CommandFormState } from "@cdf/contracts";
import { createTranslator, type Locale, type MessageKey } from "@cdf/i18n";
import {
  clearSecretControls,
  isUnchanged,
  pruneUnchanged,
  restoreEcho,
  type CommandFormControl,
} from "./command-form-fields";
import { CDFAlert, buttonClass } from "./components";
import { CDFConfirmDialog, type CDFConfirmation } from "./confirm-dialog";
import { CDFFieldErrorsProvider } from "./field-errors";

type FieldProblem = { name: string; id: string; label: string; message: string };
type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

const IDLE: CommandFormState = { status: "idle" };

const isControl = (e: unknown): e is Control =>
  e instanceof HTMLInputElement || e instanceof HTMLSelectElement || e instanceof HTMLTextAreaElement;

const controlsOf = (form: HTMLFormElement): CommandFormControl[] =>
  Array.from(form.elements).filter(isControl);

function controlsNamed(form: HTMLFormElement, name: string): CommandFormControl[] {
  const found = form.elements.namedItem(name);
  if (found instanceof RadioNodeList) return Array.from(found).filter(isControl);
  return isControl(found) ? [found] : [];
}

/** Finds the control a server field error belongs to, and the text of its visible label. */
function locate(form: HTMLFormElement, name: string): { id: string; label: string | null } {
  const found = form.elements.namedItem(name);
  const control = found instanceof RadioNodeList ? found[0] : found;
  const id = control instanceof HTMLElement ? control.id : "";
  const label = id ? form.querySelector(`label[for="${CSS.escape(id)}"]`)?.firstChild?.textContent : null;
  return { id, label: label?.trim() || null };
}

// False on the server and during hydration, true once the page is interactive.
const noSubscription = () => () => undefined;
const useHydrated = () =>
  useSyncExternalStore(
    noSubscription,
    () => true,
    () => false,
  );

export interface CDFCommandFormProps {
  action: (state: CommandFormState, form: FormData) => Promise<CommandFormState>;
  locale: Locale;
  submitLabel: string;
  /** Accessible name when several forms share one visible label; must start with the visible label (WCAG 2.5.3). */
  submitName?: string;
  fieldLabels?: Record<string, string>;
  variant?: "primary" | "secondary" | "danger";
  testId?: string;
  successMessage?: string;
  /** i18n sections tried in order for an error code (default `codes`; interviews put `interviews.codes` first). */
  codeSections?: readonly string[];
  /** Fields sent only when the user changed them (UX-030): the command keeps the stored value for the rest. */
  changedOnly?: readonly string[];
  /** Asks before the command runs (UX-031). With `when`, only when that field holds that value. */
  confirm?: CDFConfirmation & { when?: { field: string; equals: string } };
  /**
   * Asks before the user leaves the page with unsaved changes (AMB-243): the browser's own prompt on reload or
   * close, and this text on a link inside the app. Nothing is kept in the browser; drafts live on the server.
   */
  leaveWarning?: string;
  children?: ReactNode;
}

/**
 * The one command-form contract (RC-01): a server-action form that never loses what the user entered.
 *
 * - UX-001: a refused command (invalid, forbidden, conflict, not found, unavailable) keeps every typed value and
 *   every choice. The client handler submits through `startTransition`, so React does not reset the form; the
 *   form resets itself only after a success. A reset React schedules on its own (a submit replayed after
 *   hydration) is blocked, and a submit the browser made before hydration is restored from the echoed values.
 * - Secrets are never kept or restored: password, secret, token and identity fields are cleared after a refusal.
 * - The same Zod schema validates on the server (§45). After an invalid submit the summary takes focus and links
 *   to each field, and each reported control gets `aria-invalid` plus an inline error (WCAG 3.3.1, 2.4.3).
 * - While the command runs the button stays focusable (`aria-disabled`), so focus does not fall to the page (UX-077).
 * - Forms that confirm or send only changed fields wait for hydration (fail closed): without the client handler
 *   the browser would skip the confirmation or send stale values.
 * - A long form can ask before the user leaves with unsaved changes (`leaveWarning`, AMB-243).
 */
export function CDFCommandForm(props: CDFCommandFormProps) {
  const t = createTranslator(props.locale);
  const [state, formAction, pending] = useActionState(props.action, IDLE);
  const form = useRef<HTMLFormElement>(null);
  const summary = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const initialState = useRef(state);
  const resetting = useRef(false);
  const [problems, setProblems] = useState<FieldProblem[]>([]);
  const [asking, setAsking] = useState<FormData | null>(null);
  const hydrated = useHydrated();
  const { fieldLabels, confirm, changedOnly } = props;
  const needsClient = Boolean(confirm || changedOnly?.length);

  // Block every reset this component did not ask for (React resets a form after an action it dispatched itself).
  useEffect(() => {
    const el = form.current;
    if (!el) return;
    const guard = (event: Event) => {
      if (!resetting.current) event.preventDefault();
    };
    el.addEventListener("reset", guard);
    return () => el.removeEventListener("reset", guard);
  }, []);

  // AMB-243: unsaved changes are not lost by accident. Dirty means any control differs from what the page rendered,
  // so a saved draft (the form resets to the new values) or an untouched form never asks.
  const { leaveWarning } = props;
  useEffect(() => {
    const el = form.current;
    if (!el || !leaveWarning) return;
    const dirty = () => controlsOf(el).some((c) => !isUnchanged(c));
    // Set once the user agreed to leave through a link, so a full page load does not ask a second time.
    let agreed = false;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (agreed || !dirty()) return;
      event.preventDefault();
      event.returnValue = ""; // older browsers need it set to show their prompt
    };
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey)
        return;
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(link instanceof HTMLAnchorElement) || link.target === "_blank" || el.contains(link)) return;
      const to = new URL(link.href, window.location.href);
      if (to.pathname === window.location.pathname && to.search === window.location.search) return;
      if (!dirty()) return;
      if (window.confirm(leaveWarning)) {
        agreed = true;
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    };
    // A page brought back with the browser's Back button asks again.
    const onPageShow = () => {
      agreed = false;
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("pageshow", onPageShow);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("pageshow", onPageShow);
      document.removeEventListener("click", onClick, true);
    };
  }, [leaveWarning]);

  // A submit made before hydration came back as a full page: put the user's values back (never a secret).
  useEffect(() => {
    const first = initialState.current;
    const el = form.current;
    if (el && (first.status === "invalid" || first.status === "error") && first.values) {
      restoreEcho(controlsOf(el), first.values);
      clearSecretControls(controlsOf(el));
    }
  }, []);

  useEffect(() => {
    const el = form.current;
    if (!el) return;
    if (state.status === "ok") {
      // Success behaves as before: the form starts again from what the page now shows.
      resetting.current = true;
      el.reset();
      resetting.current = false;
    } else if (state.status !== "idle") {
      clearSecretControls(controlsOf(el));
    }
  }, [state]);

  useEffect(() => {
    const el = form.current;
    if (!el || state.status !== "invalid") {
      setProblems([]);
      return;
    }
    const found = Object.entries(state.fieldErrors).map(([name, key]) => {
      const { id, label } = locate(el, name);
      return { name, id, label: fieldLabels?.[name] ?? label ?? name, message: t(key as MessageKey) };
    });
    setProblems(found);
    // Tie each control to its inline error; undone when the next result arrives.
    const marked: [HTMLElement, string | null][] = [];
    for (const p of found) {
      const control = p.id ? document.getElementById(p.id) : null;
      if (!control) continue;
      const describedBy = control.getAttribute("aria-describedby");
      marked.push([control, describedBy]);
      control.setAttribute("aria-invalid", "true");
      control.setAttribute("aria-describedby", [describedBy, `${p.id}-error`].filter(Boolean).join(" "));
    }
    return () => {
      for (const [control, describedBy] of marked) {
        control.removeAttribute("aria-invalid");
        if (describedBy) control.setAttribute("aria-describedby", describedBy);
        else control.removeAttribute("aria-describedby");
      }
    };
    // Runs once per action result. `t` and `fieldLabels` are rebuilt on every render, and re-running for
    // them would re-mark the controls and pull focus back to the summary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // Move focus to the summary once it lists the problems, so it is read in full (WCAG 3.3.1, 2.4.3).
  useEffect(() => {
    if (problems.length > 0) summary.current?.focus();
  }, [problems]);

  const run = (data: FormData) => startTransition(() => formAction(data));

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    // Submitting here, not through React's form action, is what keeps the values: React resets a form only
    // after an action it dispatches itself.
    event.preventDefault();
    if (pending) return;
    const el = event.currentTarget;
    const data = new FormData(el, (event.nativeEvent as SubmitEvent).submitter);
    if (changedOnly?.length) pruneUnchanged(data, changedOnly, (name) => controlsNamed(el, name));
    if (confirm && (!confirm.when || data.get(confirm.when.field) === confirm.when.equals)) {
      setAsking(data);
      return;
    }
    run(data);
  }

  const errorMessage = (kind: string, detail?: string) => {
    const generic = `errors.${kind}` as MessageKey;
    if (!detail) return t(generic);
    for (const section of props.codeSections ?? ["codes"]) {
      const key = `${section}.${detail}` as MessageKey;
      const message = t(key);
      if (message !== key) return message;
    }
    return t(generic);
  };

  return (
    <>
      <form ref={form} action={formAction} onSubmit={onSubmit} data-testid={props.testId} noValidate>
        {state.status === "invalid" ? (
          <div ref={summary} tabIndex={-1} data-testid="error-summary">
            <CDFAlert tone="danger" title={t("errors.INVALID")}>
              <ul className="list-disc ps-5">
                {problems.map((p) => (
                  <li key={p.name}>
                    {p.id ? (
                      <a href={`#${p.id}`} className="underline">
                        {p.label}: {p.message}
                      </a>
                    ) : (
                      `${p.label}: ${p.message}`
                    )}
                  </li>
                ))}
              </ul>
            </CDFAlert>
          </div>
        ) : null}
        {state.status === "error" ? (
          // UX-078: the class of refusal as a title, what happened with its reference, and that nothing was lost.
          <CDFAlert tone="danger" testId="action-error" title={t(errorTitle(state.kind))}>
            <p>
              {t("errors.withReference", { message: errorMessage(state.kind, state.detail), ref: state.ref })}
            </p>
            {state.kind === "UNAUTHENTICATED" ? null : <p className="mt-1">{t("errors.entriesKept")}</p>}
          </CDFAlert>
        ) : null}
        {state.status === "ok" && props.successMessage ? (
          // "{message}" in the success text is replaced by the action's result (e.g. a file hash).
          <CDFAlert tone="success">{props.successMessage.replace("{message}", state.message ?? "")}</CDFAlert>
        ) : null}
        <CDFFieldErrorsProvider
          errors={Object.fromEntries(problems.filter((p) => p.id).map((p) => [p.id, p.message]))}
        >
          {props.children}
        </CDFFieldErrorsProvider>
        <button
          ref={trigger}
          type="submit"
          className={buttonClass(props.variant ?? "primary")}
          disabled={needsClient && !hydrated}
          aria-disabled={pending ? true : undefined}
          aria-label={pending ? undefined : props.submitName}
        >
          {pending ? t("common.working") : props.submitLabel}
        </button>
      </form>
      {confirm ? (
        <CDFConfirmDialog
          open={asking !== null}
          confirmation={confirm}
          onConfirm={() => {
            const data = asking;
            setAsking(null);
            if (data) run(data);
          }}
          onDismiss={() => setAsking(null)}
          onClosed={() => trigger.current?.focus()}
        />
      ) : null}
    </>
  );
}

const ERROR_TITLES: Record<string, MessageKey> = {
  UNAUTHENTICATED: "errors.title.UNAUTHENTICATED",
  NOT_FOUND: "errors.title.NOT_FOUND",
  FORBIDDEN: "errors.title.FORBIDDEN",
  INVALID: "errors.title.INVALID",
  CONFLICT: "errors.title.CONFLICT",
  RATE_LIMITED: "errors.title.RATE_LIMITED",
  UNAVAILABLE: "errors.title.UNAVAILABLE",
};
const errorTitle = (kind: string): MessageKey => ERROR_TITLES[kind] ?? "errors.title.UNAVAILABLE";
