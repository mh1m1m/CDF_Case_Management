import { CDFPageHeader } from "@cdf/ui";
import { getTranslator } from "@/server/locale";
import { FollowUp } from "./follow-up";

export default async function FollowUpPage() {
  const t = await getTranslator();
  return (
    <div className="mx-auto max-w-2xl">
      <CDFPageHeader title={t("portal.followUpTitle")} intro={t("portal.followUpIntro")} />
      <FollowUp locale={t.locale} />
    </div>
  );
}
