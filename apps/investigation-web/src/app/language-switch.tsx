"use client";
import { usePathname, useSearchParams } from "next/navigation";
import type { Locale } from "@cdf/i18n";

/** Keeps the page and its view (the query) across the switch; /locale re-validates the target. */
export function LanguageSwitch({ locale, label }: { locale: Locale; label: string }) {
  const pathname = usePathname() || "/";
  const query = useSearchParams()?.toString() ?? "";
  const to: Locale = locale === "ar" ? "en" : "ar";
  const next = query ? `${pathname}?${query}` : pathname;
  return (
    <a
      href={`/locale?to=${to}&next=${encodeURIComponent(next)}`}
      lang={to}
      hrefLang={to}
      className="inline-flex min-h-11 items-center rounded-cdf-md px-2 underline-offset-4 hover:underline"
      data-testid="language-switch"
    >
      {label}
    </a>
  );
}
