"use client";
import { useActionState, type ReactNode } from "react";
import { createTranslator, type Locale, type MessageKey } from "@cdf/i18n";
import { CDFAlert, buttonClass } from "@cdf/ui";
import type { ActionState } from "@/server/actions-helpers";

/**
 * Server-action form for interview commands. Same contract as the shared ActionForm, but resolves
 * interview-specific conflict and validation codes (interviews.codes.*, interviews.validation.*) first.
 */
export function InterviewForm(props: {
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
  const errorMessage = (kind: string, detail?: string) => {
    const generic = `errors.${kind}` as MessageKey;
    if (!detail) return t(generic);
    const specific = t.code("interviews.codes", detail, "common.none");
    return specific !== t("common.none") ? specific : t.code("codes", detail, generic);
  };
  return (
    <form action={formAction} data-testid={props.testId} noValidate>
      {state.status === "invalid" ? (
        <CDFAlert tone="danger" title={t("errors.INVALID")}>
          <ul className="list-disc ps-5">
            {Object.entries(state.fieldErrors).map(([field, key]) => (
              <li key={field}>
                {props.fieldLabels?.[field] ?? field}: {t(key as MessageKey)}
              </li>
            ))}
          </ul>
        </CDFAlert>
      ) : null}
      {state.status === "error" ? (
        <CDFAlert tone="danger" testId="action-error">
          {t("errors.withReference", { message: errorMessage(state.kind, state.detail), ref: state.ref })}
        </CDFAlert>
      ) : null}
      {state.status === "ok" && props.successMessage ? (
        <CDFAlert tone="success">{props.successMessage.replace("{message}", state.message ?? "")}</CDFAlert>
      ) : null}
      {props.children}
      <button type="submit" className={buttonClass(props.variant ?? "secondary")} disabled={pending}>
        {pending ? t("common.working") : props.submitLabel}
      </button>
    </form>
  );
}
