"use client";
import { useActionState, type ReactNode } from "react";
import { createTranslator, type Locale, type MessageKey } from "@cdf/i18n";
import { CDFAlert, buttonClass } from "@cdf/ui";
import type { ActionState } from "@/server/actions-helpers";

/**
 * Server-action form with an accessible error summary. Fields are plain inputs rendered by the caller;
 * the same Zod schema validates on the server (§45).
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
      {props.children}
      <button type="submit" className={buttonClass(props.variant ?? "primary")} disabled={pending}>
        {pending ? t("common.working") : props.submitLabel}
      </button>
    </form>
  );
}
