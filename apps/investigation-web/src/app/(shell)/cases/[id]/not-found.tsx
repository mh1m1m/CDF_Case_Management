// One not-found page for the case segment (UX-080, G2). A case that does not exist and a case the user may not
// see both reach notFound() from the same check, so they render this same page with the same status: nothing
// here confirms that a case exists.
import type { Metadata } from "next";
import Link from "next/link";
import { CDFSystemMessage, buttonClass } from "@cdf/ui";
import { getTranslator } from "@/server/locale";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("system.caseNotFoundTitle") };
}

export default async function CaseNotFound() {
  const t = await getTranslator();
  return (
    <CDFSystemMessage
      testId="not-found"
      title={t("system.caseNotFoundTitle")}
      body={t("system.caseNotFoundBody")}
    >
      <Link href="/cases" className={buttonClass("primary")}>
        {t("system.backToCases")}
      </Link>
    </CDFSystemMessage>
  );
}
