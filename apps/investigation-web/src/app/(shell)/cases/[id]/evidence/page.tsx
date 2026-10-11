// Evidence «الأدلة» (UX redesign S2; audit §22.6.1 tab 3). The case's evidence register and upload. The list is
// what authz.can_view_evidence returns for this viewer; uploads and downloads are re-checked by the server.
import type { Metadata } from "next";
import { can } from "@cdf/authorization";
import { evidenceService } from "@/server/container";
import { getTranslator } from "@/server/locale";
import { EvidencePanel } from "../evidence-panel";
import { CaseWorkspace, loadCase } from "../workspace";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("pageTitles.caseEvidence") };
}

export default async function CaseEvidencePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { actor, ctx, t, c } = await loadCase(id);
  const evidence = await evidenceService().listEvidence(ctx, id);
  // Mirrors authz.can_upload_evidence for the UI only; the database decides (§19).
  const canUpload =
    can(actor, "EVIDENCE_UPLOAD") &&
    c.recordsState === "ACTIVE" &&
    (can(actor, "CASE_EDIT_ALL") ||
      c.assignments.some(
        (a) =>
          a.userId === actor.userId &&
          ["CASE_OWNER", "LEAD_INVESTIGATOR", "INVESTIGATOR"].includes(a.assignmentRole),
      ));
  return (
    <CaseWorkspace c={c} actor={actor} t={t} tab="evidence">
      <EvidencePanel
        c={c}
        items={evidence}
        canUpload={canUpload}
        canDownload={can(actor, "EVIDENCE_DOWNLOAD")}
        clearance={actor.clearance}
        t={t}
      />
    </CaseWorkspace>
  );
}
