"use client";
import { usePathname } from "next/navigation";
import type { Locale } from "@cdf/i18n";

export function LanguageSwitch({ locale, label }: { locale: Locale; label: string }) {
  const pathname = usePathname() || "/";
  const to: Locale = locale === "ar" ? "en" : "ar";
  return (
    <a
      href={`/locale?to=${to}&next=${encodeURIComponent(pathname)}`}
      lang={to}
      hrefLang={to}
      className="underline-offset-4 hover:underline"
      data-testid="language-switch"
    >
      {label}
    </a>
  );
}
