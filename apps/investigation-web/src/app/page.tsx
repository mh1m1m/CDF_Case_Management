import { redirect } from "next/navigation";
import { navigationFor } from "@cdf/authorization";
import { CDFAlert, CDFPageHeader } from "@cdf/ui";
import { requireActor } from "@/server/container";
import { getTranslator } from "@/server/locale";
import { AppNav } from "./app-nav";

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
