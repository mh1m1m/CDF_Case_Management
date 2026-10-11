// Report submission without JavaScript (UX-002). The form's native POST body is turned into the value shape the
// JavaScript path sends, so both reach the same schema and the same portal service. Nothing here validates.

const FIELDS = [
  "relationship",
  "relationshipOther",
  "category",
  "categoryOther",
  "subjectDescription",
  "description",
  "incidentDate",
  "incidentTime",
  "location",
  "willingToCooperate",
  "reporterMode",
  "language",
] as const;

const IDENTITY_FIELDS = [
  "givenName",
  "fatherName",
  "grandfatherName",
  "familyName",
  "gender",
  "birthDateCalendar",
  "birthDate",
  "idType",
  "idNumber",
  "city",
  "nationality",
  "phone",
  "email",
  "preferredContact",
] as const;

/**
 * Fields that may be shown back to the reporter after a failed submission, in the POST response body only.
 * Never identity (`identity.*`): those are entered again (§22).
 */
const ECHOED_FIELDS = [
  "relationship",
  "relationshipOther",
  "category",
  "categoryOther",
  "subjectDescription",
  "description",
  "incidentDate",
  "incidentTime",
  "location",
  "willingToCooperate",
  "reporterMode",
] as const;

export type EchoedField = (typeof ECHOED_FIELDS)[number];
export type ReportEcho = Partial<Record<EchoedField, string>> & { acknowledgement?: true };

/** Same names as the JavaScript path (`identity.*` included); empty strings are dropped; the checkbox is `true`. */
export function reportValuesFromFormData(form: FormData): Record<string, unknown> {
  const value = (name: string) => {
    const v = form.get(name);
    return typeof v === "string" && v !== "" ? v : undefined;
  };
  const values: Record<string, unknown> = {};
  for (const field of FIELDS) {
    const v = value(field);
    if (v !== undefined) values[field] = v;
  }
  if (form.get("acknowledgement") === "on") values.acknowledgement = true;
  const identity: Record<string, string> = {};
  for (const field of IDENTITY_FIELDS) {
    const v = value(`identity.${field}`);
    if (v !== undefined) identity[field] = v;
  }
  if (Object.keys(identity).length > 0) values.identity = identity;
  return values;
}

/** The non-identity values to put back into the form after a failed submission. */
export function echoedValues(values: Record<string, unknown>): ReportEcho {
  const echo: ReportEcho = {};
  for (const field of ECHOED_FIELDS) {
    const v = values[field];
    if (typeof v === "string") echo[field] = v;
  }
  if (values.acknowledgement === true) echo.acknowledgement = true;
  return echo;
}

/** Which identity values the reporter must enter again, from the mode they chose. */
export function identityToReenter(values: Record<string, unknown>): "EMAIL_ONLY" | "IDENTIFIED" | null {
  return values.reporterMode === "EMAIL_ONLY" || values.reporterMode === "IDENTIFIED"
    ? values.reporterMode
    : null;
}

/** Server field errors (`identity.email` → key) in the nested shape React Hook Form keeps. */
export function nestedFieldErrors(
  flat: Readonly<Record<string, string>>,
): Record<string, { type: string; message: string } | Record<string, { type: string; message: string }>> {
  const out: Record<
    string,
    Record<string, { type: string; message: string }> | { type: string; message: string }
  > = {};
  for (const [path, message] of Object.entries(flat)) {
    const [head, child] = path.split(".");
    if (!head) continue;
    if (child) {
      const group = (out[head] ?? {}) as Record<string, { type: string; message: string }>;
      group[child] = { type: "server", message };
      out[head] = group;
    } else {
      out[head] = { type: "server", message };
    }
  }
  return out;
}
