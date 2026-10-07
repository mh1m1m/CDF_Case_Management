"use server";
import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { AppError, type PortalReportStatus } from "@cdf/application";
import { clientKey, portalService } from "@/server/container";

export type StatusResult =
  | { status: "ok"; report: PortalReportStatus }
  | { status: "not_found" }
  | { status: "error"; kind: string; ref: string };

async function guarded<T>(
  fn: (requestId: string, key: string) => Promise<T>,
): Promise<T | { status: "error"; kind: string; ref: string }> {
  const requestId = randomUUID();
  try {
    return await fn(requestId, clientKey(await headers()));
  } catch (error) {
    const kind = error instanceof AppError ? error.kind : "UNAVAILABLE";
    console.error(JSON.stringify({ event: "portal.follow_up_failed", requestId, kind }));
    return { status: "error", kind, ref: requestId };
  }
}

export async function getStatusAction(reportRef: string, secret: string): Promise<StatusResult> {
  return guarded(async (requestId, key) => {
    const report = await portalService().getStatus({ requestId }, key, { reportRef, secret });
    return report ? { status: "ok" as const, report } : { status: "not_found" as const };
  });
}

export async function postMessageAction(
  reportRef: string,
  secret: string,
  body: string,
): Promise<StatusResult> {
  return guarded(async (requestId, key) => {
    const sent = await portalService().postMessage({ requestId }, key, { reportRef, secret, body });
    if (!sent) return { status: "not_found" as const };
    const report = await portalService().getStatus({ requestId }, key, { reportRef, secret });
    return report ? { status: "ok" as const, report } : { status: "not_found" as const };
  });
}
