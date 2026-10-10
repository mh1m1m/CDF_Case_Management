import Link from "next/link";
import { CDFAlert, CDFCard, buttonClass } from "@cdf/ui";
import { getTranslator } from "@/server/locale";

export default async function HomePage() {
  const t = await getTranslator();
  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-cdf-display font-semibold">{t("portal.homeTitle")}</h1>
      <p className="mt-3 text-lg text-cdf-text-secondary">{t("portal.homeIntro")}</p>
      <div className="mt-6">
        <CDFAlert tone="warning">{t("portal.notAChannel")}</CDFAlert>
      </div>
      <CDFCard>
        <div className="flex flex-wrap gap-3">
          <Link href="/report" className={buttonClass("primary")} data-testid="cta-submit">
            {t("portal.submitCta")}
          </Link>
          <Link href="/follow-up" className={buttonClass("secondary")} data-testid="cta-follow-up">
            {t("portal.followUpCta")}
          </Link>
        </div>
      </CDFCard>
    </div>
  );
}
