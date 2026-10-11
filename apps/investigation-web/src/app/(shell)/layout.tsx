// The signed-in shell (UX redesign S1; audit §20.1–§20.5, RC-06, RC-07; CDF-117). The sidebar lists at most the
// areas api.my_areas() returns for this caller, which the database derives from permission AND a live
// relationship, never from a role name; the application floor (shellAreas) can only remove one. Counts are the
// caller's own actionable items, never case counts. The shell explains access; every page still enforces it.
import type { ReactNode } from "react";
import { shellAreas } from "@cdf/authorization";
import type { MessageKey } from "@cdf/i18n";
import { CDFAppShell, CDFEnvironmentStrip, CDFUserMenu, buttonClass } from "@cdf/ui";
import { investigationService, requireActor } from "@/server/container";
import { env } from "@/server/env";
import { getTranslator } from "@/server/locale";
import { areaHref } from "@/server/work-routes";
import { LanguageSwitch } from "../language-switch";
import { signOutAction } from "../session/actions";
import { SessionTimeout } from "../session/session-timeout";
import { ShellNav } from "./shell-nav";

/** Sidebar keys double as e2e test ids (nav-intake, nav-cases, nav-records, …). */
const NAV_KEY = {
  MY_WORK: "my-work",
  INTAKE: "intake",
  CASES: "cases",
  COMMITTEE: "committee",
  RECORDS: "records",
  OVERSIGHT: "oversight",
  ADMINISTRATION: "admin",
  REPORTING: "reporting",
} as const;

export default async function ShellLayout({ children }: { children: ReactNode }) {
  const { actor, ctx } = await requireActor();
  const [t, areas] = await Promise.all([getTranslator(), investigationService().myAreas(ctx)]);
  const name = t.locale === "ar" ? actor.displayNameAr : actor.displayName;
  const items = shellAreas(actor, areas).map((a) => ({
    key: NAV_KEY[a.area],
    area: a.area,
    href: areaHref(a),
    label: t(`shell.area.${a.area}` as MessageKey),
    ...(a.actionableCount > 0
      ? { count: a.actionableCount, countLabel: t("shell.countLabel", { count: a.actionableCount }) }
      : {}),
  }));
  return (
    <CDFAppShell
      skipLabel={t("common.skipToContent")}
      environment={
        <CDFEnvironmentStrip
          label={t("common.classificationBanner")}
          detail={t("common.classificationBannerDetail")}
        />
      }
      brand={
        <a href="/" className="flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/cdf-logo.png" alt="" width={32} height={32} />
          <span className="truncate font-semibold">{t("common.appName")}</span>
        </a>
      }
      utilities={
        <LanguageSwitch
          locale={t.locale}
          label={t.locale === "ar" ? t("common.switchToEnglish") : t("common.switchToArabic")}
        />
      }
      userMenu={
        <CDFUserMenu
          name={name}
          summaryLabel={t("shell.accountMenu", { name })}
          details={[
            {
              term: t("shell.roles"),
              value: actor.roles.map((r) => t.code("role", r)).join(t.locale === "ar" ? "، " : ", "),
            },
            { term: t("shell.clearance"), value: t.code("classification", actor.clearance) },
          ]}
        >
          <a
            href="/settings/access"
            className="underline-offset-4 hover:underline"
            data-testid="my-access-link"
          >
            {t("shell.myAccess")}
          </a>
          <form action={signOutAction}>
            <button type="submit" className={buttonClass("ghost")} data-testid="sign-out">
              {t("common.signOut")}
            </button>
          </form>
        </CDFUserMenu>
      }
      nav={<ShellNav label={t("common.mainNavigation")} items={items} />}
      session={<SessionTimeout idleSeconds={env().CDF_SESSION_IDLE_SECONDS} locale={t.locale} />}
    >
      {children}
    </CDFAppShell>
  );
}
