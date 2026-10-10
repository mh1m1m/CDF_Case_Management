import { CDFAlert, CDFCard, CDFPageHeader } from "@cdf/ui";
import { getTranslator } from "@/server/locale";
import { env } from "@/server/env";
import { LoginForm } from "./login-form";

export default async function LoginPage() {
  const t = await getTranslator();
  return (
    <div className="mx-auto max-w-md">
      <CDFPageHeader title={t("login.title")} />
      {env().CDF_IDENTITY_PROVIDER === "local-dev" ? (
        <CDFAlert tone="warning">{t("login.devNotice")}</CDFAlert>
      ) : null}
      <CDFCard>
        <LoginForm locale={t.locale} />
      </CDFCard>
    </div>
  );
}
