/**
 * Forms engine domain rules (Phase 8, CDF-50; ADR-011). Pure: no I/O.
 *
 * The database is authoritative (forms.validate_data, forms.content_hash); these are the first-enforcement
 * mirrors used by the UI and the application layer, kept equal by tests/integration/forms.spec.ts.
 */
import type {
  FormData,
  FormDefinition,
  FormEntitlementAction,
  FormFieldDefinition,
  FormSectionDefinition,
  FormStatus,
  Role,
} from "@cdf/contracts";
import { FORM_TEXT_MAX, FORM_TEXTAREA_MAX } from "@cdf/contracts";
import { FORM_DEFINITIONS, FORM_ENTITLEMENTS } from "./forms/registry.generated";

export { FORM_DEFINITIONS, FORM_ENTITLEMENTS };

export const FORM_CODE_PATTERN = /^WB-FRM-\d{2}$/;
export const FORM_FIELD_NAME_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;
export const FORM_NUMBER_PATTERN = /^-?[0-9]{1,15}(\.[0-9]{1,6})?$/;
export const FORM_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function getFormDefinition(code: string): FormDefinition | undefined {
  return FORM_DEFINITIONS.find((d) => d.code === code);
}

/** Role × form × action entitlement from the registry (mirror of authz.form_entitled). */
export function isFormEntitled(
  roles: readonly Role[],
  formCode: string,
  action: FormEntitlementAction,
): boolean {
  return FORM_ENTITLEMENTS.some(
    (e) => e.formCode === formCode && e.action === action && roles.includes(e.roleCode),
  );
}

/** The status that completes a form (mirror of forms.terminal_status). */
export function formFinalStatus(def: { reviewRequired: boolean; approvalRequired: boolean }): FormStatus {
  return def.approvalRequired ? "APPROVED" : def.reviewRequired ? "REVIEWED" : "PREPARED";
}

/** Display identifier within a case, e.g. "WB-FRM-11 #2". UUIDs remain the keys (§87). */
export function formDisplayNumber(formCode: string, instanceNo: number): string {
  return `${formCode} #${instanceNo}`;
}

export function fieldsOf(sections: readonly FormSectionDefinition[]): FormFieldDefinition[] {
  return sections.flatMap((s) => s.fields);
}

// ---- Canonical JSON and hashes (mirror of forms.canonical_json / forms.content_hash) ------------------------
/** Object keys sorted by code unit, arrays in order, scalars as JSON.stringify, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** sha256(formCode ':' schemaHash ':' canonicalJson(data)), hex. Equal to the database's content_hash. */
export function formContentHash(formCode: string, schemaHash: string, data: FormData): Promise<string> {
  return sha256Hex(`${formCode}:${schemaHash}:${canonicalJson(data)}`);
}

/** sha256 of the canonical JSON of a definition's sections; what the generator stored as schemaHash. */
export function formSchemaHash(sections: readonly FormSectionDefinition[]): Promise<string> {
  return sha256Hex(canonicalJson(sections));
}

// ---- Validation (mirror of forms.validate_data) ---------------------------------------------------------------
export type FormDataIssueCode = "unknownField" | "required" | "tooLong" | "invalid";
export interface FormDataIssue {
  field: string;
  code: FormDataIssueCode;
}
export type FormDataCheck = { ok: true; data: FormData } | { ok: false; issues: FormDataIssue[] };

const CONTROL = /\p{Cc}/u;

function isValidDate(value: string): boolean {
  if (!FORM_DATE_PATTERN.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function checkValue(field: FormFieldDefinition, value: string): FormDataIssueCode | null {
  switch (field.type) {
    case "text":
      return value.length > FORM_TEXT_MAX ? "tooLong" : CONTROL.test(value) ? "invalid" : null;
    case "textarea":
      return value.length > FORM_TEXTAREA_MAX
        ? "tooLong"
        : CONTROL.test(value.replace(/[\n\r\t]/g, ""))
          ? "invalid"
          : null;
    case "date":
      return isValidDate(value) ? null : "invalid";
    case "select":
      return field.options.some((o) => o.value === value) ? null : "invalid";
    case "boolean":
      return value === "true" || value === "false" ? null : "invalid";
    case "number":
      return FORM_NUMBER_PATTERN.test(value) ? null : "invalid";
  }
}

/**
 * Validates and normalises submitted data against a definition. Empty values are dropped; in strict mode
 * (prepare) every required field must be present. Unknown keys are rejected.
 */
export function validateFormData(
  sections: readonly FormSectionDefinition[],
  data: Record<string, unknown>,
  strict: boolean,
): FormDataCheck {
  const fields = fieldsOf(sections);
  const known = new Set(fields.map((f) => f.name));
  const issues: FormDataIssue[] = [];
  for (const key of Object.keys(data)) if (!known.has(key)) issues.push({ field: key, code: "unknownField" });
  const normalised: FormData = {};
  for (const field of fields) {
    const raw = data[field.name];
    if (raw === undefined || raw === null) {
      if (strict && field.required) issues.push({ field: field.name, code: "required" });
      continue;
    }
    if (typeof raw !== "string") {
      issues.push({ field: field.name, code: "invalid" });
      continue;
    }
    if (raw.trim() === "") {
      if (strict && field.required) issues.push({ field: field.name, code: "required" });
      continue;
    }
    const code = checkValue(field, raw);
    if (code) issues.push({ field: field.name, code });
    else normalised[field.name] = raw;
  }
  return issues.length === 0 ? { ok: true, data: normalised } : { ok: false, issues };
}
