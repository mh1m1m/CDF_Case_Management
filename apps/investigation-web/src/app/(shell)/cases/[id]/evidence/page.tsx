// Evidence «الأدلة» (UX redesign S2; audit §22.6.1 tab 3, §22.6.3; ADR-016 D6, DEC-09). The case's evidence
// register and upload for the investigation team, and the reporter's files. Who sees what is the database's
// answer (migration 1850): the tab exists only for those with a need to know, the register only for the team,
// LEADS items and the restriction control only for the case manager, owner and lead. Uploads, downloads and
// restriction changes are re-checked by the server.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { can } from "@cdf/authorization";
import { CDFAlert } from "@cdf/ui";
import { evidenceService } from "@/server/container";
import { getTranslator } from "@/server/locale";
import { EvidencePanel, ReporterFilesCard } from "../evidence-panel";
import { CaseWorkspace, contentOpen, loadCase } from "../workspace";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("pageTitles.caseEvidence") };
}

export default async function CaseEvidencePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { actor, ctx, t, c } = await loadCase(id);
  // No need to know: the same answer as a case that does not exist (G2).
  if (c.evidenceAccess === "NONE") notFound();
  const register = c.evidenceAccess === "TEAM" || c.evidenceAccess === "LEADS";
  const [evidence, files] = await Promise.all([
    register ? evidenceService().listEvidence(ctx, id) : Promise.resolve([]),
    evidenceService().listCaseReportAttachments(ctx, id),
  ]);
  // authz.can_upload_evidence, read with the case (UX-116); the upload command checks it again.
  const canUpload = register && c.can.uploadEvidence;
  const canDownload = can(actor, "EVIDENCE_DOWNLOAD");
  return (
    <CaseWorkspace c={c} actor={actor} t={t} tab="evidence">
      {register ? (
        <EvidencePanel
          c={c}
          items={evidence}
          canUpload={canUpload}
          canDownload={canDownload}
          canRestrict={c.evidenceAccess === "LEADS" && contentOpen(c)}
          t={t}
        />
      ) : (
        <div className="mb-4">
          <CDFAlert tone="info" testId="evidence-team-only">
            {t("evidence.teamOnly")}
          </CDFAlert>
        </div>
      )}
      <div className="mt-6">
        <ReporterFilesCard files={files} canDownload={canDownload} t={t} />
      </div>
    </CaseWorkspace>
  );
}
