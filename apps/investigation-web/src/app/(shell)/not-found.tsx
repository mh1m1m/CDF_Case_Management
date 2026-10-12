// Translated 404 inside the signed-in shell (UX-080). The same answer for a missing object and one the caller may
// not see (A-7); the shell around it depends only on the caller, never on what was asked for.
import type { Metadata } from "next";
import Link from "next/link";
import { CDFSystemMessage, buttonClass } from "@cdf/ui";
import { getTranslator } from "@/server/locale";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("system.notFoundTitle") };
}

export default async function NotFound() {
  const t = await getTranslator();
  return (
    <CDFSystemMessage testId="not-found" title={t("system.notFoundTitle")} body={t("system.notFoundBody")}>
      <Link href="/" className={buttonClass("primary")}>
        {t("system.backHome")}
      </Link>
    </CDFSystemMessage>
  );
}
