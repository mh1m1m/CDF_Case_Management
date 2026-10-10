"use client";
import { useActionState } from "react";
import { createTranslator, type Locale } from "@cdf/i18n";
import { CDFAlert, CDFField, buttonClass, inputClass } from "@cdf/ui";
import type { ActionState } from "@/server/actions-helpers";
import { signInAction } from "./actions";

export function LoginForm({ locale }: { locale: Locale }) {
  const t = createTranslator(locale);
  const [state, action, pending] = useActionState(signInAction, { status: "idle" } as ActionState);
  return (
    <form action={action} data-testid="login-form">
      {state.status === "error" ? (
        <CDFAlert tone="danger" testId="login-error">
          {state.kind === "RATE_LIMITED" ? t("errors.RATE_LIMITED") : t("login.invalid")}
          <span className="ms-2 text-xs">
            {t("common.reference")}: {state.ref}
          </span>
        </CDFAlert>
      ) : null}
      <CDFField id="email" label={t("login.email")}>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          required
          dir="ltr"
          className={inputClass}
        />
      </CDFField>
      <CDFField id="password" label={t("login.password")}>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          dir="ltr"
          className={inputClass}
        />
      </CDFField>
      <button type="submit" className={buttonClass("primary")} disabled={pending} data-testid="login-submit">
        {pending ? t("common.working") : t("login.submit")}
      </button>
    </form>
  );
}
