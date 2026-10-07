"use client";
import { useActionState, useEffect, useRef, useState, type ReactNode } from "react";
import { createTranslator, type Locale, type MessageKey } from "@cdf/i18n";
import { CDFAlert, CDFFieldErrorsProvider, buttonClass } from "@cdf/ui";
import type { ActionState } from "@/server/actions-helpers";

type FieldProblem = { name: string; id: string; label: string; message: string };

/** Finds the control a server field error belongs to, and the text of its visible label. */
function locate(form: HTMLFormElement, name: string): { id: string; label: string | null } {
  const found = form.elements.namedItem(name);
  const control = found instanceof RadioNodeList ? found[0] : found;
  const id = control instanceof HTMLElement ? control.id : "";
  const label = id ? form.querySelector(`label[for="${CSS.escape(id)}"]`)?.firstChild?.textContent : null;
  return { id, label: label?.trim() || null };
}

/**
 * Server-action form with an accessible error summary. Fields are plain inputs rendered by the caller;
 * the same Zod schema validates on the server (§45). After an invalid submit the summary takes focus and
 * links to each field, and every reported control gets `aria-invalid` plus an inline error (WCAG 3.3.1).
 */
export function ActionForm(props: {
  action: (state: ActionState, form: FormData) => Promise<ActionState>;
  locale: Locale;
  submitLabel: string;
  fieldLabels?: Record<string, string>;
  variant?: "primary" | "secondary" | "danger";
  testId?: string;
  successMessage?: string;
  children?: ReactNode;
}) {
  const t = createTranslator(props.locale);
  const [state, formAction, pending] = useActionState(props.action, { status: "idle" } as ActionState);
  const form = useRef<HTMLFormElement>(null);
  const summary = useRef<HTMLDivElement>(null);
  const [problems, setProblems] = useState<FieldProblem[]>([]);
  const { fieldLabels } = props;

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

  return (
    <form ref={form} action={formAction} data-testid={props.testId} noValidate>
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
        <CDFAlert tone="danger" testId="action-error">
          {t("errors.withReference", {
            message: state.detail
              ? t.code("codes", state.detail, `errors.${state.kind}` as MessageKey)
              : t(`errors.${state.kind}` as MessageKey),
            ref: state.ref,
          })}
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
      <button type="submit" className={buttonClass(props.variant ?? "primary")} disabled={pending}>
        {pending ? t("common.working") : props.submitLabel}
      </button>
    </form>
  );
}
