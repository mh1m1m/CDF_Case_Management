import Link from "next/link";
import { navigationFor } from "@cdf/authorization";
import type { Actor } from "@cdf/contracts";
import type { Translator } from "@cdf/i18n";
import { buttonClass } from "@cdf/ui";
import { signOutAction } from "./login/actions";

/** Navigation reflects permissions for usability only; every page enforces access on the server. */
export function AppNav({ actor, t, current }: { actor: Actor; t: Translator; current?: "intake" | "cases" }) {
  const nav = navigationFor(actor);
  const items = [
    nav.intake ? { key: "intake", href: "/intake", label: t("nav.intake") } : null,
    nav.cases ? { key: "cases", href: "/cases", label: t("nav.cases") } : null,
  ].filter((x): x is { key: string; href: string; label: string } => x !== null);
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3 border-b border-cdf-border pb-3">
      <nav aria-label={t("common.mainNavigation")}>
        <ul className="flex gap-4">
          {items.map((i) => (
            <li key={i.key}>
              <Link
                href={i.href}
                aria-current={i.key === current ? "page" : undefined}
                className="font-semibold underline-offset-4 hover:underline aria-[current=page]:underline"
                data-testid={`nav-${i.key}`}
              >
                {i.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <div className="flex items-center gap-3 text-sm">
        <span data-testid="signed-in-as">
          {t("common.signedInAs", { name: t.locale === "ar" ? actor.displayNameAr : actor.displayName })}
        </span>
        <form action={signOutAction}>
          <button type="submit" className={buttonClass("ghost")} data-testid="sign-out">
            {t("common.signOut")}
          </button>
        </form>
      </div>
    </div>
  );
}
