"use server";
import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { AppError } from "@cdf/application";
import { fieldErrors } from "@cdf/validation";
import { clientKey, portalService } from "@/server/container";
import { echoedValues, identityToReenter, reportValuesFromFormData, type ReportEcho } from "./form-data";

export type SubmitResult =
  | { status: "ok"; reportRef: string; secret: string }
  | { status: "invalid"; fieldErrors: Record<string, string> }
  | { status: "error"; kind: string; ref: string };

/** What a native (no-JavaScript) submission renders: the receipt, or the form again with the reporter's text. */
export type ReportFormState =
  | null
  | { status: "ok"; reportRef: string; secret: string }
  | ((
      | { status: "invalid"; fieldErrors: Record<string, string> }
      | { status: "error"; kind: string; ref: string }
    ) & { values: ReportEcho; reenter: "EMAIL_ONLY" | "IDENTIFIED" | null });

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

/**
 * The same submission from the form's native POST, before hydration or with JavaScript off (UX-002). It goes
 * through submitReportAction, so the schema, rate limit and database command are the ones the JavaScript path
 * uses. A failure returns the non-identity values for the POST response only; identity is entered again.
 */
export async function submitReportFormAction(
  _previous: ReportFormState,
  form: FormData,
): Promise<ReportFormState> {
  const values = reportValuesFromFormData(form);
  const result = await submitReportAction(values);
  if (result.status === "ok") return result;
  return { ...result, values: echoedValues(values), reenter: identityToReenter(values) };
}
