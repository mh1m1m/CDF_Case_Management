"use server";
import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { AppError } from "@cdf/application";
import { fieldErrors } from "@cdf/validation";
import { clientKey, portalService } from "@/server/container";

export type SubmitResult =
  | { status: "ok"; reportRef: string; secret: string }
  | { status: "invalid"; fieldErrors: Record<string, string> }
  | { status: "error"; kind: string; ref: string };

export async function submitReportAction(values: unknown): Promise<SubmitResult> {
  const requestId = randomUUID();
  try {
    const result = await portalService().submitReport({ requestId }, clientKey(await headers()), values);
    if (!result.ok) return { status: "invalid", fieldErrors: fieldErrors(result.issues) };
    return { status: "ok", reportRef: result.reportRef, secret: result.secret };
  } catch (error) {
    const kind = error instanceof AppError ? error.kind : "UNAVAILABLE";
    // Log only the correlation id and error kind; never the report content (§83).
    console.error(JSON.stringify({ event: "portal.submit_failed", requestId, kind }));
    return { status: "error", kind, ref: requestId };
  }
}
