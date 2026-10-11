/**
 * Field rules for CDFCommandForm (UX-001, UX-030). Plain functions over a minimal control shape, so they run on
 * the server (echoing submitted values) and in the browser (restoring, pruning, clearing), and are unit-tested
 * without a DOM.
 *
 * The one rule that never bends: a secret is never sent back into a form. Passwords, follow-up secrets, tokens,
 * one-time codes and anything the page marks `data-cdf-secret` (for example a reporter-identity field) are left
 * out of every echo and cleared after a refused submit.
 */

/** Values the user submitted, by field name; sent back with a refused result so the form can show them again. */
export type EchoedValues = Record<string, string | string[]>;

/** The parts of an input, select or textarea these rules read. A DOM control satisfies it. */
export interface CommandFormControl {
  readonly name: string;
  readonly type: string;
  value: string;
  readonly defaultValue?: string;
  checked?: boolean;
  readonly defaultChecked?: boolean;
  readonly options?: ArrayLike<{
    readonly value: string;
    selected: boolean;
    readonly defaultSelected: boolean;
  }>;
  readonly autocomplete?: string;
  getAttribute?(name: string): string | null;
}

/** Field names that hold a secret, a credential or a protected identity attribute. */
const SECRET_NAME =
  /pass(word|code|phrase)|secret|token|otp|one[-_]?time|pepper|identity|national[-_]?id|id[-_]?number|iqama|passport/i;

/** Next.js framework fields (`$ACTION_ID_…`, `$ACTION_REF_…`): never echoed or restored. */
const FRAMEWORK_FIELD = /^\$ACTION/;

/** True when a field with this name must never be echoed back into a form. */
export function isSecretField(name: string): boolean {
  return SECRET_NAME.test(name);
}

/** True when this control holds a secret: by type, autocomplete hint, explicit marker or name. */
export function isSecretControl(control: CommandFormControl): boolean {
  return (
    control.type === "password" ||
    /password|one-time-code/.test(control.autocomplete ?? "") ||
    (control.getAttribute?.("data-cdf-secret") ?? null) !== null ||
    isSecretField(control.name)
  );
}

/**
 * The submitted values that may be shown again after a refusal. Files, framework fields and every secret field
 * are dropped. Runs on the server, so it sees names only; the page marks any other secret with a secret-like name.
 */
export function echoValues(form: FormData): EchoedValues {
  const out: EchoedValues = {};
  for (const [name, value] of form.entries()) {
    if (typeof value !== "string" || FRAMEWORK_FIELD.test(name) || isSecretField(name)) continue;
    const prior = out[name];
    out[name] = prior === undefined ? value : Array.isArray(prior) ? [...prior, value] : [prior, value];
  }
  return out;
}

const isChoice = (c: CommandFormControl) => c.type === "checkbox" || c.type === "radio";
const isSelect = (c: CommandFormControl) => c.type.startsWith("select");
/** Controls whose value the page owns: never restored, never pruned. */
const isFixed = (c: CommandFormControl) =>
  c.type === "hidden" ||
  c.type === "file" ||
  c.type === "submit" ||
  c.type === "button" ||
  c.type === "reset";

/**
 * Puts echoed values back into the form's controls after a round trip the browser made without the client
 * handler (a submit before hydration). Secret and fixed controls are skipped, so nothing secret is ever written.
 */
export function restoreEcho(controls: Iterable<CommandFormControl>, values: EchoedValues): void {
  for (const control of controls) {
    if (!control.name || FRAMEWORK_FIELD.test(control.name) || isFixed(control) || isSecretControl(control)) {
      continue;
    }
    const raw = values[control.name];
    const submitted = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
    if (isChoice(control)) {
      // An unchecked box or an unanswered radio group is absent from the submission: restore that too.
      control.checked = submitted.includes(control.value);
    } else if (isSelect(control) && control.options) {
      if (raw === undefined) continue;
      for (const option of Array.from(control.options)) option.selected = submitted.includes(option.value);
    } else if (raw !== undefined) {
      control.value = submitted[0] ?? "";
    }
  }
}

/** Empties every secret control, so a refused submit never keeps a secret on screen. Returns how many it cleared. */
export function clearSecretControls(controls: Iterable<CommandFormControl>): number {
  let cleared = 0;
  for (const control of controls) {
    if (!isSecretControl(control) || isFixed(control)) continue;
    if (isChoice(control)) control.checked = false;
    else control.value = "";
    cleared += 1;
  }
  return cleared;
}

/** True when the user left this control as the page rendered it. */
export function isUnchanged(control: CommandFormControl): boolean {
  if (isChoice(control)) return control.checked === control.defaultChecked;
  if (isSelect(control) && control.options) {
    return Array.from(control.options).every((o) => o.selected === o.defaultSelected);
  }
  return control.value === (control.defaultValue ?? "");
}

/**
 * Drops each named field the user did not change (UX-030), so a command only writes what the user edited.
 * A field is kept when any of its controls changed, or when no control by that name is found.
 */
export function pruneUnchanged(
  data: FormData,
  names: readonly string[],
  controlsNamed: (name: string) => CommandFormControl[],
): FormData {
  for (const name of names) {
    const controls = controlsNamed(name);
    if (controls.length > 0 && controls.every(isUnchanged)) data.delete(name);
  }
  return data;
}
