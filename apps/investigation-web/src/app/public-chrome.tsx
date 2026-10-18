// The chrome for pages outside the signed-in shell: sign-in and unknown addresses. The environment marker, the
// product mark and the language switch; no navigation and no account menu. With JavaScript off, a line says that
// signing in needs it (CDF-255).
import type { ReactNode } from "react";
import type { Translator } from "@cdf/i18n";
import { CDFClassificationBanner, CDFNoScriptNotice, CDFShell } from "@cdf/ui";
import { LanguageSwitch } from "./language-switch";

export function PublicChrome({ t, children }: { t: Translator; children: ReactNode }) {
  return (
    <CDFShell
      skipLabel={t("common.skipToContent")}
      banner={
        <>
          <CDFClassificationBanner
            label={t("common.classificationBanner")}
            detail={t("common.classificationBannerDetail")}
          />
          <CDFNoScriptNotice text={t("common.noScript")} />
        </>
      }
      brand={
        <a href="/" className="flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/cdf-logo.png" alt="" width={40} height={40} />
          <span className="font-semibold">{t("common.appName")}</span>
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
  );
}
