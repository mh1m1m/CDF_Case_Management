import "server-only";
import type { CommandResult } from "@cdf/application";
import type { CommandFormState } from "@cdf/contracts";
import { echoValues } from "@cdf/ui";
import { fieldErrors } from "@cdf/validation";

/** Serializable state returned by every server action form (CDFCommandForm). Never contains database text (§82). */
export type ActionState = CommandFormState;

export const idle: ActionState = { status: "idle" };

/**
 * Adds the submitted values to a refused result (UX-001), so a submit the browser made before the page hydrated
 * can be shown again. Secrets, files and framework fields are never echoed (`echoValues`).
 */
export function withEcho(state: ActionState, form?: FormData): ActionState {
  if (!form || (state.status !== "invalid" && state.status !== "error")) return state;
  return { ...state, values: echoValues(form) };
}

export function toActionState<T>(result: CommandResult<T>, form?: FormData): ActionState {
  if (result.ok) return { status: "ok" };
  if ("fieldErrors" in result) {
    return withEcho({ status: "invalid", fieldErrors: fieldErrors(result.fieldErrors) }, form);
  }
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
  return withEcho(
    { status: "error", kind: e.kind, ...(e.detail ? { detail: e.detail } : {}), ref: e.correlationId },
    form,
  );
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

/**
 * Repeated rows named `name.k.field`, as an array whose index is the row's place in the form (at most 100 rows), so
 * that an error on `name.k.field` shows next to that control. A row the form did not send is an empty row.
 */
export function formRows(form: FormData, name: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  const pattern = new RegExp(`^${name}\\.(\\d{1,2})\\.(\\w+)$`);
  for (const [key, value] of form.entries()) {
    const m = pattern.exec(key);
    if (!m || typeof value !== "string") continue;
    const k = Number(m[1]);
    for (let j = out.length; j <= k; j++) out.push({});
    out[k]![m[2]!] = value;
  }
  return out;
}

/** The values of a field sent once per ticked box, without empties. */
export const formValues = (form: FormData, name: string): string[] =>
  form.getAll(name).filter((v): v is string => typeof v === "string" && v !== "");

/**
 * Fields the user emptied, as null: `formObject` drops an empty field, which a form sending only changed fields
 * (CDFCommandForm `changedOnly`) would read as unchanged. A field the form did not send stays absent.
 */
export function clearedFields(form: FormData, names: readonly string[]): Record<string, null> {
  const out: Record<string, null> = {};
  for (const name of names) if (form.has(name) && form.get(name) === "") out[name] = null;
  return out;
}
