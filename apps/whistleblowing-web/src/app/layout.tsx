import type { Metadata } from "next";
import type { ReactNode } from "react";
import { CDFClassificationBanner, CDFShell } from "@cdf/ui";
import { directionOf } from "@cdf/i18n";
import { getTranslator } from "@/server/locale";
import { LanguageSwitch } from "./language-switch";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("common.portalName"), robots: { index: false, follow: false }, referrer: "no-referrer" };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const t = await getTranslator();
  return (
    <html lang={t.locale} dir={directionOf(t.locale)} data-theme="light">
      <body>
        <CDFShell
          skipLabel={t("common.skipToContent")}
          banner={
            <CDFClassificationBanner
              label={t("common.classificationBanner")}
              detail={t("common.classificationBannerDetail")}
            />
          }
          brand={
            <a href="/" className="flex items-center gap-3">
              {/* Plain img: the logo is a static, same-origin asset. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/cdf-logo.png" alt="" width={40} height={40} />
              <span className="font-semibold">{t("common.portalName")}</span>
            </a>
          }
          utilities={
            <LanguageSwitch
              locale={t.locale}
              label={t.locale === "ar" ? t("common.switchToEnglish") : t("common.switchToArabic")}
            />
          }
        >
          {children}
        </CDFShell>
      </body>
    </html>
  );
}
