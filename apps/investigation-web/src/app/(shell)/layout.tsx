// The signed-in shell (UX redesign S1; audit §20.1–§20.5, RC-06, RC-07; CDF-117). The sidebar lists at most the
// areas api.my_areas() returns for this caller, which the database derives from permission AND a live
// relationship, never from a role name; the application floor (shellAreas) can only remove one. Counts are the
// caller's own actionable items, never case counts; the header bell counts the caller's own unread notices (S4).
// The shell explains access; every page still enforces it. A command's refusal whose form left the page shows at the
// top of the content (CDF-232).
import type { ReactNode } from "react";
import type { MessageKey } from "@cdf/i18n";
import { CDFAppShell, CDFEnvironmentStrip, CDFNotificationBell, CDFUserMenu, buttonClass } from "@cdf/ui";
import { myShellAreas, myUnreadCount, requireActor } from "@/server/container";
import { env } from "@/server/env";
import { getTranslator } from "@/server/locale";
import { areaHref } from "@/server/work-routes";
import { LanguageSwitch } from "../language-switch";
import { signOutAction } from "../session/actions";
import { SessionTimeout } from "../session/session-timeout";
import { RefusalNotices } from "./refusal-notices";
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
  const { actor } = await requireActor();
  const [t, areas, unread] = await Promise.all([getTranslator(), myShellAreas(), myUnreadCount()]);
  const name = t.locale === "ar" ? actor.displayNameAr : actor.displayName;
  const items = areas.map((a) => ({
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
        <a href="/" className="flex min-w-0 items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/cdf-logo.png" alt="" width={32} height={32} className="shrink-0" />
          <span className="truncate font-semibold">{t("common.appName")}</span>
        </a>
      }
      utilities={
        <>
          {/* S4: the caller's own unread notices; the count is never a case count. */}
          <CDFNotificationBell
            href="/notifications"
            count={unread}
            label={unread > 0 ? t("notifications.bellUnread", { count: unread }) : t("notifications.bell")}
          />
          <LanguageSwitch
            locale={t.locale}
            label={t.locale === "ar" ? t("common.switchToEnglish") : t("common.switchToArabic")}
          />
        </>
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
          <a
            href="/settings/notifications"
            className="underline-offset-4 hover:underline"
            data-testid="notification-settings-link"
          >
            {t("notifications.settingsLink")}
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
      {/* CDF-232: a refusal whose form left the page shows at the top of the page's content. */}
      <RefusalNotices locale={t.locale}>{children}</RefusalNotices>
    </CDFAppShell>
  );
}
