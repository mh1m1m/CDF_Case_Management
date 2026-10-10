// Reporter attachment download (CDF-72; ADR-015). Same gate as evidence: the database decides
// (api.open_report_attachment: clean scan, report visibility, download right) and records the download or a
// SECURITY denial; the vault object is streamed as a download, never rendered in-page.
import { notFound } from "next/navigation";
import { evidenceService, requireActor } from "@/server/container";

const UUID = /^[0-9a-f-]{36}$/i;

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; attachmentId: string }> },
) {
  const { id, attachmentId } = await context.params;
  if (!UUID.test(id) || !UUID.test(attachmentId)) notFound();
  const { ctx } = await requireActor();
  const download = await evidenceService().openReportAttachment(ctx, attachmentId);
  // Denied, missing, quarantined and rejected attachments are indistinguishable (§40).
  if (!download) notFound();

  // The display name is generated (ATT-001.pdf), so it is always plain ASCII.
  return new Response(download.stream, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(download.sizeBytes),
      "Content-Disposition": `attachment; filename="${download.fileName}"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "X-CDF-SHA256": download.sha256,
    },
  });
}
