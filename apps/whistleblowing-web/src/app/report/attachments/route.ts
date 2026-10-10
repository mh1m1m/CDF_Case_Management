// Reporter attachment upload (CDF-72; ADR-015). One file per request, same origin only, bounded body.
// The browser sends the file to this server only; storage, the scanner and the database are reached
// from here through the portal service. The file name is used for its extension and never logged.
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { AppError, type AttachmentUploadResult } from "@cdf/application";
import { REPORTER_ATTACHMENT_MAX_BYTES } from "@cdf/contracts";
import { clientKey, portalService } from "@/server/container";

// One file plus the multipart envelope and three short text fields.
const MAX_REQUEST_BYTES = REPORTER_ATTACHMENT_MAX_BYTES + 64 * 1024;

type Body = AttachmentUploadResult | { ok: false; code: "RATE_LIMITED" | "UNAVAILABLE"; ref?: string };

function reply(status: number, body: Body) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/** Same-origin check: there is no session to ride on, but uploads still only come from the portal's own pages. */
function sameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!origin || !host) return false;
  try {
    if (new URL(origin).host !== host) return false;
  } catch {
    return false;
  }
  const site = request.headers.get("sec-fetch-site");
  return site === null || site === "same-origin";
}

export async function POST(request: NextRequest) {
  const requestId = randomUUID();
  if (!sameOrigin(request)) return reply(403, { ok: false, code: "NOT_ACCEPTED" });
  const length = Number(request.headers.get("content-length") ?? "NaN");
  if (!Number.isInteger(length) || length <= 0 || length > MAX_REQUEST_BYTES)
    return reply(413, { ok: false, code: "INVALID_FILE", reason: "TOO_LARGE" });
  if (!(request.headers.get("content-type") ?? "").startsWith("multipart/form-data"))
    return reply(415, { ok: false, code: "INVALID_FILE" });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return reply(400, { ok: false, code: "INVALID_FILE" });
  }
  const file = form.get("file");
  if (!(file instanceof File)) return reply(400, { ok: false, code: "INVALID_FILE", reason: "EMPTY" });

  try {
    const result = await portalService().uploadAttachment(
      { requestId },
      clientKey(request.headers),
      { reportRef: form.get("reportRef"), secret: form.get("secret"), source: form.get("source") },
      { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) },
    );
    return reply(result.ok ? 201 : 422, result);
  } catch (error) {
    const kind = error instanceof AppError ? error.kind : "UNAVAILABLE";
    // Correlation id and error kind only: never the file, its name or the credentials (§83).
    console.error(JSON.stringify({ event: "portal.attachment_failed", requestId, kind }));
    if (kind === "RATE_LIMITED") return reply(429, { ok: false, code: "RATE_LIMITED" });
    return reply(503, { ok: false, code: "UNAVAILABLE", ref: requestId });
  }
}
