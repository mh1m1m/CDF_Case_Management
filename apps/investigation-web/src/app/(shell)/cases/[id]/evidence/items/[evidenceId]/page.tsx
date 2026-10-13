// One evidence item «الدليل» (UX redesign S2e; UX-075; audit §22.6.1 tab 3). Its own address, by id, inside the
// Evidence tab. The register is the team's (DEC-09, migration 1850): anyone else, and anyone asking for an item RLS
// does not return to them (a LEADS item, another case's item, a made-up id), gets the same 404 as a missing case.
// Downloads, restriction changes and new versions are re-checked by the server and the database.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { can } from "@cdf/authorization";
import { evidenceDisplayNumber } from "@cdf/domain";
import { evidenceService } from "@/server/container";
import { getTranslator } from "@/server/locale";
import { EvidenceItemView } from "../../../evidence-panel";
import { CaseWorkspace, contentOpen, loadCase } from "../../../workspace";

/** Unique translated title (WCAG 2.4.2, UX-082); never an evidence number or title. */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("pageTitles.evidenceItem") };
}

const UUID = /^[0-9a-f-]{36}$/i;

export default async function EvidenceItemPage({
  params,
}: {
  params: Promise<{ id: string; evidenceId: string }>;
}) {
  const { id, evidenceId } = await params;
  if (!UUID.test(evidenceId)) notFound();
  const { actor, ctx, t, c } = await loadCase(id);
  if (c.evidenceAccess !== "TEAM" && c.evidenceAccess !== "LEADS") notFound();
  const e = (await evidenceService().listEvidence(ctx, id)).find((x) => x.id === evidenceId);
  if (!e) notFound();
  return (
    <CaseWorkspace
      c={c}
      actor={actor}
      t={t}
      tab="evidence"
      item={<bdi dir="ltr">{evidenceDisplayNumber(e.sequenceNo)}</bdi>}
    >
      <EvidenceItemView
        c={c}
        e={e}
        // authz.can_upload_evidence, read with the case (UX-116); the upload command checks it again.
        canUpload={c.can.uploadEvidence}
        canDownload={can(actor, "EVIDENCE_DOWNLOAD")}
        canRestrict={c.evidenceAccess === "LEADS" && contentOpen(c)}
        t={t}
      />
    </CaseWorkspace>
  );
}
