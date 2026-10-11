"use server";
import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { AppError, type PortalReportStatus } from "@cdf/application";
import { clientKey, portalService } from "@/server/container";

export type StatusResult =
  | { status: "ok"; report: PortalReportStatus }
  | { status: "not_found" }
  | { status: "error"; kind: string; ref: string };

/** What a native (no-JavaScript) sign-in or reply renders. Never carries the secret. */
export type FollowUpFormState =
  null | StatusResult | { status: "ok"; report: PortalReportStatus; replySent: true };

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

/**
 * Sign-in and reply from the forms' native POST, before hydration or with JavaScript off (UX-002). Both go
 * through the same actions as the JavaScript path, so an unknown Report ID and a wrong secret still give the
 * same answer (§23). The secret comes from the POST body each time and is never returned or rendered: the
 * no-JavaScript reply form asks for it again.
 */
export async function followUpFormAction(
  _previous: FollowUpFormState,
  form: FormData,
): Promise<FollowUpFormState> {
  const field = (name: string) => {
    const v = form.get(name);
    return typeof v === "string" ? v : "";
  };
  if (form.has("body")) {
    const r = await postMessageAction(field("reportRef"), field("secret"), field("body"));
    return r.status === "ok" ? { ...r, replySent: true } : r;
  }
  return getStatusAction(field("reportRef"), field("secret"));
}
