import { CDFPageHeader } from "@cdf/ui";
import { getTranslator } from "@/server/locale";
import { ReportForm } from "./report-form";

export default async function ReportPage() {
  const t = await getTranslator();
  return (
    <div className="mx-auto max-w-2xl">
      <CDFPageHeader title={t("portal.formTitle")} intro={t("portal.formIntro")} />
      <ReportForm locale={t.locale} />
    </div>
  );
}
