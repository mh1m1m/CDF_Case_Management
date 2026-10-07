// Evidence download (§24, §27; threat T05). The browser never addresses storage: this handler asks the
// database for permission (api.open_evidence_version records custody and audit, or a SECURITY denial) and
// streams the vault object with download-only, non-cacheable, nosniff headers.
import { notFound } from "next/navigation";
import { evidenceService, requireActor } from "@/server/container";

const UUID = /^[0-9a-f-]{36}$/i;
const SAFE_INLINE_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "text/plain",
]);

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; versionId: string }> },
) {
  const { id, versionId } = await context.params;
  if (!UUID.test(id) || !UUID.test(versionId)) notFound();
  const { ctx } = await requireActor();
  const download = await evidenceService().openDownload(ctx, versionId);
  // Denied, missing and not-yet-available versions are indistinguishable (§40).
  if (!download) notFound();

  const ascii = download.fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(download.fileName);
  return new Response(download.stream, {
    status: 200,
    headers: {
      // Office, audio and video types are served as opaque binaries so nothing is ever rendered in-page.
      "Content-Type": SAFE_INLINE_TYPES.has(download.contentType)
        ? download.contentType
        : "application/octet-stream",
      "Content-Length": String(download.sizeBytes),
      "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "X-CDF-SHA256": download.sha256,
    },
  });
}
