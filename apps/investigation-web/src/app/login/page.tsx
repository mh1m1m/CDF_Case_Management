import type { Metadata } from "next";
import { CDFAlert, CDFCard, CDFPageHeader } from "@cdf/ui";
import { getTranslator } from "@/server/locale";
import { env } from "@/server/env";
import { LoginForm } from "./login-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("login.title") };
}

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
