// An account with no area (UX redesign S1, RC-07; HD-S18 / DEC-47). Signed in and active, but neither a
// permission nor a live relationship opens any area, so there is nothing to show and no count to give.
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { shellAreas } from "@cdf/authorization";
import { CDFEmptyState, CDFIdentifier, CDFPageHeader } from "@cdf/ui";
import { investigationService, requireActor } from "@/server/container";
import { getTranslator } from "@/server/locale";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("noWorkspace.title") };
}

export default async function NoWorkspacePage() {
  const { actor, ctx } = await requireActor();
  if (shellAreas(actor, await investigationService().myAreas(ctx)).length > 0) redirect("/");
  const t = await getTranslator();
  return (
    <>
      <CDFPageHeader title={t("noWorkspace.title")} />
      <CDFEmptyState
        title={t("noWorkspace.title")}
        body={
          <>
            <p>{t("noWorkspace.body")}</p>
            <p className="mt-2">
              {t("noWorkspace.reference")}: <CDFIdentifier variant="hash">{ctx.requestId}</CDFIdentifier>
            </p>
          </>
        }
        testId="no-workspace"
      />
    </>
  );
}
