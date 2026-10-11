// History «مجريات القضية» (UX redesign S2; audit §22.7; CDF-119). The case's business events, newest first, each
// labelled in both languages. Page views stay in the ledger for Oversight and never appear here (DEC-08).
import type { Metadata } from "next";
import { formatDateTime } from "@cdf/i18n";
import { CDFCard, CDFTimeline } from "@cdf/ui";
import { investigationService } from "@/server/container";
import { getTranslator } from "@/server/locale";
import { CaseWorkspace, loadCase } from "../workspace";

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
          items={timeline.map((e) => ({
            id: String(e.seq),
            title: t.code("auditAction", e.action, "common.none"),
            meta: `${formatDateTime(t.locale, e.occurredAt)} · ${e.actorName ?? "—"}`,
            body: e.reason,
          }))}
        />
      </CDFCard>
    </CaseWorkspace>
  );
}
