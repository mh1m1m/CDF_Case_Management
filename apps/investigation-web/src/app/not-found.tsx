// Translated 404 for unknown addresses (UX-080), in the public chrome: the root layout has none.
import type { Metadata } from "next";
import Link from "next/link";
import { CDFSystemMessage, buttonClass } from "@cdf/ui";
import { getTranslator } from "@/server/locale";
import { PublicChrome } from "./public-chrome";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("system.notFoundTitle") };
}

export default async function NotFound() {
  const t = await getTranslator();
  return (
    <PublicChrome t={t}>
      <CDFSystemMessage testId="not-found" title={t("system.notFoundTitle")} body={t("system.notFoundBody")}>
        <Link href="/" className={buttonClass("primary")}>
          {t("system.backHome")}
        </Link>
      </CDFSystemMessage>
    </PublicChrome>
  );
}
