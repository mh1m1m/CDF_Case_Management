// History «مجريات القضية» (UX redesign S2; audit §22.7; CDF-127). The case's business events, newest first, in
// business words in both languages, read through api.case_history (migration 1830, ADR-016 D5): the database
// applies each event's audience, so page views, other people's access and legal-hold details never reach this
// page unless the viewer may know them (DEC-08, DEC-10). Oversight reads the full ledger under its own permission.
import type { Metadata } from "next";
import { CDFCard, CDFTimeline } from "@cdf/ui";
import { investigationService } from "@/server/container";
import { getTranslator } from "@/server/locale";
import { CaseWorkspace, historyItems, loadCase } from "../workspace";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("pageTitles.caseHistory") };
}

export default async function CaseHistoryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { actor, ctx, t, c } = await loadCase(id);
  const timeline = await investigationService().caseTimeline(ctx, id);
  return (
    <CaseWorkspace c={c} actor={actor} t={t} tab="history">
      <CDFCard title={t("caseWorkspace.tabs.history")}>
        <p className="mb-4 text-sm text-cdf-text-secondary">{t("caseWorkspace.historyIntro")}</p>
        <CDFTimeline
          testId="audit-timeline"
          empty={t("cases.noTimeline")}
          items={historyItems(t, timeline)}
        />
      </CDFCard>
    </CaseWorkspace>
  );
}
