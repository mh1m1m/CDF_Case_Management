"use client";
import {
  startTransition,
  useActionState,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
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
import { useHydrated } from "./hydration";
import { useRefusalNotices } from "./refusal-notice";
import { refusalMessage, refusalTitle } from "./refusal-words";

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
 *   hydration) is blocked. Should the browser itself ever post the form (since CDF-255 only a replay of this markup
 *   can), the page that comes back restores the echoed values.
 * - Secrets are never kept or restored: password, secret, token and identity fields are cleared after a refusal.
 * - The same Zod schema validates on the server (§45). After an invalid submit the summary takes focus and links
 *   to each field, and each reported control gets `aria-invalid` plus an inline error (WCAG 3.3.1, 2.4.3).
 * - While the command runs the button stays focusable (`aria-disabled`), so focus does not fall to the page (UX-077).
 * - Every form waits until the page is interactive (CDF-255): the button stays disabled until then, so the browser
 *   never posts the form on its own, which the investigation app would refuse with a bare error page (its posts
 *   carry `Origin: null`). It also fails closed for a form that confirms or sends only changed fields, which the
 *   browser alone would send without the confirmation or with stale values. With JavaScript off the button stays
 *   disabled, and the app's no-script notice says why.
 * - A long form can ask before the user leaves with unsaved changes (`leaveWarning`, AMB-243).
 * - CDF-232: when the page, read again after the submit, no longer offers the form (another user's action moved its
 *   subject on), the form leaves the page with its refusal; the page-level notice shows the refusal's words instead.
 */
export function CDFCommandForm(props: CDFCommandFormProps) {
  const t = createTranslator(props.locale);
  const notices = useRefusalNotices();
  const formId = useId();
  const { action: command, codeSections } = props;
  // The form's server-rendered markup names its command, as before CDF-232: React writes the command into the markup
  // only when this hook holds it unwrapped, so the client handler below never takes its place there. The positive
  // controls of tests/e2e/security-csrf.spec.ts replay this markup; a user never posts it before hydration (CDF-255).
  const [served, serverAction] = useActionState(command, IDLE);
  // CDF-232: the client handler tells the page's refusal notice each answer from outside the form's own state, which
  // is lost when the form leaves the page in the same update. Only the refusal's codes and reference go, never what
  // was entered.
  const answer = useCallback(
    async (previous: CommandFormState, data: FormData): Promise<CommandFormState> => {
      const next = await command(previous, data);
      notices?.answered(
        formId,
        next.status === "error"
          ? {
              kind: next.kind,
              ref: next.ref,
              ...(next.detail ? { detail: next.detail } : {}),
              ...(codeSections ? { codeSections } : {}),
            }
          : null,
      );
      return next;
    },
    [command, codeSections, notices, formId],
  );
  const [answered, clientAction, pending] = useActionState(answer, IDLE);
  // The latest answer: the client handler's once it has run, else the one the browser's own post came back with.
  const state = answered === IDLE ? served : answered;
  const form = useRef<HTMLFormElement>(null);
  const summary = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const initialState = useRef(state);
  const resetting = useRef(false);
  const [problems, setProblems] = useState<FieldProblem[]>([]);
  const [asking, setAsking] = useState<FormData | null>(null);
  const hydrated = useHydrated();
  const { fieldLabels, confirm, changedOnly } = props;

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

  // CDF-232: the form is on the page until it unmounts, and a refusal it shows itself is not shown again at the top.
  useEffect(() => notices?.register(formId), [notices, formId]);
  useEffect(() => {
    if (state.status === "error") notices?.shownByForm(formId);
  }, [state, notices, formId]);

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

  // A post the browser made itself came back as a full page: put the user's values back (never a secret).
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

  const run = (data: FormData) => startTransition(() => clientAction(data));

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

  return (
    <>
      <form ref={form} action={serverAction} onSubmit={onSubmit} data-testid={props.testId} noValidate>
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
          <CDFAlert tone="danger" testId="action-error" title={t(refusalTitle(state.kind))}>
            <p>
              {t("errors.withReference", {
                message: refusalMessage(t, state.kind, state.detail, codeSections),
                ref: state.ref,
              })}
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
          disabled={!hydrated}
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
