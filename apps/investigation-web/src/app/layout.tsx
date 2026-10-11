import type { Metadata } from "next";
import type { ReactNode } from "react";
import { CDFLocaleProvider } from "@cdf/ui";
import { directionOf } from "@cdf/i18n";
import { getTranslator } from "@/server/locale";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  const appName = t("common.appName");
  // Each page sets its own title; the template keeps the app name after it (WCAG 2.4.2).
  return {
    title: { default: appName, template: `%s · ${appName}` },
    robots: { index: false, follow: false },
    referrer: "no-referrer",
  };
}

// The chrome lives in the route groups: (public) for sign-in, (shell) for everything signed in (UX redesign S1).
export default async function RootLayout({ children }: { children: ReactNode }) {
  const t = await getTranslator();
  return (
    <html lang={t.locale} dir={directionOf(t.locale)} data-theme="light">
      <body>
        {/* Error boundaries are client components: they read the locale from here (UX-080). */}
        <CDFLocaleProvider locale={t.locale}>{children}</CDFLocaleProvider>
      </body>
    </html>
  );
}
