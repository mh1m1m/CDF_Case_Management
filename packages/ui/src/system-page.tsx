"use client";
// Route boundaries shared by both apps (UX-080, RC-05): the active locale for client boundaries, and the error
// page. Every word comes from @cdf/i18n. The error page shows a generic message and the framework's error
// reference (the digest Next.js logs on the server), never the message, a stack trace or SQL (§82).
import { createContext, useContext, type ReactNode } from "react";
import { DEFAULT_LOCALE, createTranslator, type Locale } from "@cdf/i18n";
import { CDFSystemMessage, buttonClass } from "./components";

const LocaleContext = createContext<Locale>(DEFAULT_LOCALE);

/** Gives client components below the root layout (error boundaries) the locale the server chose. */
export function CDFLocaleProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export function useCDFLocale(): Locale {
  return useContext(LocaleContext);
}

/** Body of an `error.tsx` boundary. `error` is read only for its digest; its message is never shown. */
export function CDFRouteError({
  error,
  reset,
  home,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  home: { href: string; label: "system.backHome" | "system.backToCases" };
}) {
  const t = createTranslator(useCDFLocale());
  return (
    <CDFSystemMessage testId="route-error" title={t("system.errorTitle")} body={t("system.errorBody")}>
      {error.digest ? (
        <p className="basis-full text-sm" data-testid="error-reference">
          {t("system.errorReference", { ref: error.digest })}
        </p>
      ) : null}
      <button type="button" className={buttonClass("primary")} onClick={reset} data-testid="error-retry">
        {t("system.retry")}
      </button>
      <a href={home.href} className={buttonClass("secondary")}>
        {t(home.label)}
      </a>
    </CDFSystemMessage>
  );
}
