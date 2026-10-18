"use client";
// CDF-232: the page-level refusal notice for every signed-in page. A command form that leaves the page with its
// command's refusal hands it here; the notice clears when the page's address changes (navigation).
import type { ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import type { Locale } from "@cdf/i18n";
import { CDFRefusalNoticeProvider } from "@cdf/ui";

export function RefusalNotices({ locale, children }: { locale: Locale; children: ReactNode }) {
  const pathname = usePathname() || "/";
  const query = useSearchParams()?.toString() ?? "";
  return (
    <CDFRefusalNoticeProvider locale={locale} navigationKey={query ? `${pathname}?${query}` : pathname}>
      {children}
    </CDFRefusalNoticeProvider>
  );
}
