import "server-only";
import type { CommandResult } from "@cdf/application";
import { fieldErrors } from "@cdf/validation";

/** Serializable state returned by every server action form. Never contains database text (§82). */
export type ActionState =
  | { status: "idle" }
  | { status: "ok"; message?: string }
  | { status: "invalid"; fieldErrors: Record<string, string> }
  | { status: "error"; kind: string; detail?: string; ref: string };

export const idle: ActionState = { status: "idle" };

export function toActionState<T>(result: CommandResult<T>): ActionState {
  if (result.ok) return { status: "ok" };
  if ("fieldErrors" in result) return { status: "invalid", fieldErrors: fieldErrors(result.fieldErrors) };
  const e = result.error;
  if (e.kind === "UNAVAILABLE") {
    console.error(
      JSON.stringify({
        event: "command.failed",
        requestId: e.correlationId,
        kind: e.kind,
        cause: (e.cause as { code?: string })?.code,
      }),
    );
  }
  return { status: "error", kind: e.kind, ...(e.detail ? { detail: e.detail } : {}), ref: e.correlationId };
}

/** FormData → plain object. Checkbox "on" → true; empty strings dropped. */
export function formObject(form: FormData, booleans: string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of form.entries()) {
    if (typeof v !== "string" || k.startsWith("$ACTION")) continue;
    if (v !== "") out[k] = v;
  }
  for (const b of booleans) out[b] = form.get(b) === "on" || form.get(b) === "true";
  return out;
}
