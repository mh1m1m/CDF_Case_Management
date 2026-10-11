// Allegations «الادعاءات» (UX redesign S2; audit §22.6.1 tab 2). What the case is about. Findings tie to
// allegations once the finding entity exists (S5); until then this tab lists the allegations only.
import type { Metadata } from "next";
import { CDFCard, CDFEmptyState } from "@cdf/ui";
import { getTranslator } from "@/server/locale";
import { CaseWorkspace, loadCase } from "../workspace";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("pageTitles.caseAllegations") };
}

export default async function CaseAllegationsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { actor, t, c } = await loadCase(id);
  return (
    <CaseWorkspace c={c} actor={actor} t={t} tab="allegations">
      <p className="mb-4 text-cdf-text-secondary">{t("caseWorkspace.allegationsIntro")}</p>
      {c.allegations.length === 0 ? (
        <CDFEmptyState title={t("caseWorkspace.noAllegations")} testId="allegations-empty" />
      ) : (
        <CDFCard title={t("cases.allegations")} testId="allegations">
          <ul className="grid gap-3">
            {c.allegations.map((a) => (
              <li key={a.id} className="border-b border-cdf-border pb-3 last:border-0">
                <p className="font-semibold">
                  {t.code("category", a.category, "common.none")}
                  <span className="ms-2 text-sm font-normal text-cdf-text-secondary">
                    {t.code("caseWorkspace.allegationStatus", a.status, "common.none")}
                  </span>
                </p>
                <p className="mt-1 whitespace-pre-wrap break-words">
                  <bdi dir="auto">{a.description}</bdi>
                </p>
              </li>
            ))}
          </ul>
        </CDFCard>
      )}
    </CaseWorkspace>
  );
}
