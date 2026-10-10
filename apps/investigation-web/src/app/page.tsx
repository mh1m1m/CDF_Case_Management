import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { navigationFor } from "@cdf/authorization";
import { CDFAlert, CDFPageHeader } from "@cdf/ui";
import { requireActor } from "@/server/container";
import { getTranslator } from "@/server/locale";
import { AppNav } from "./app-nav";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  // The layout's title template only applies to child segments, so the root page spells it out.
  return { title: { absolute: `${t("pageTitles.overview")} · ${t("common.appName")}` } };
}

export default async function Home() {
  const { actor } = await requireActor();
  const nav = navigationFor(actor);
  if (nav.intake) redirect("/intake");
  if (nav.cases) redirect("/cases");
  const t = await getTranslator();
  // Administrators, auditors and SOC analysts have no case content in this slice (§21).
  return (
    <>
      <AppNav actor={actor} t={t} />
      <CDFPageHeader title={t("cases.homeTitle")} />
      <CDFAlert tone="info">{t("cases.empty")}</CDFAlert>
    </>
  );
}
