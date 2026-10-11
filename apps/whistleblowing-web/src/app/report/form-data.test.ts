// UX-002: a report posted without JavaScript reaches the same schema, in the same shape, as the JavaScript path;
// a failed submission gives back only non-identity values.
import { describe, expect, it } from "vitest";
import { submitReportSchema } from "@cdf/validation";
import { echoedValues, identityToReenter, nestedFieldErrors, reportValuesFromFormData } from "./form-data";

// SYNTHETIC values only (CLAUDE.md §1).
const NARRATIVE = "SYNTHETIC: Employee Alpha split purchase orders to stay below the approval threshold.";

function form(entries: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.append(k, v);
  // Fields React adds for progressive enhancement travel in the same body and are ignored.
  fd.append("$ACTION_REF_1", "");
  fd.append("$ACTION_KEY", "k0");
  return fd;
}

const anonymous = {
  relationship: "EMPLOYEE",
  relationshipOther: "",
  category: "IRREGULAR_TRANSACTIONS",
  categoryOther: "",
  description: NARRATIVE,
  incidentDate: "2026-09-01",
  incidentTime: "09:30",
  location: "Procurement department (synthetic)",
  subjectDescription: "Employee Alpha (synthetic)",
  reporterMode: "ANONYMOUS",
  willingToCooperate: "YES",
  acknowledgement: "on",
  language: "en",
  "identity.preferredContact": "PORTAL_ONLY",
  "identity.birthDateCalendar": "GREGORIAN",
};

const identified = {
  ...anonymous,
  reporterMode: "IDENTIFIED",
  "identity.givenName": "Reporter",
  "identity.fatherName": "Zeta",
  "identity.grandfatherName": "Synthetic",
  "identity.familyName": "Example",
  "identity.gender": "FEMALE",
  "identity.nationality": "SA",
  "identity.birthDate": "1990-04-15",
  "identity.idType": "NATIONAL_ID",
  "identity.idNumber": "1000000009",
  "identity.city": "RIYADH",
  "identity.phone": "+966 500000009",
  "identity.email": "reporter.zeta@example.test",
};

describe("reportValuesFromFormData", () => {
  it("builds the JavaScript path's shape: identity nested, checkbox true, empty strings and React fields dropped", () => {
    const values = reportValuesFromFormData(form(anonymous));
    expect(values).toEqual({
      relationship: "EMPLOYEE",
      category: "IRREGULAR_TRANSACTIONS",
      description: NARRATIVE,
      incidentDate: "2026-09-01",
      incidentTime: "09:30",
      location: "Procurement department (synthetic)",
      subjectDescription: "Employee Alpha (synthetic)",
      reporterMode: "ANONYMOUS",
      willingToCooperate: "YES",
      acknowledgement: true,
      language: "en",
      identity: { preferredContact: "PORTAL_ONLY", birthDateCalendar: "GREGORIAN" },
    });
  });

  it("passes the shared schema for anonymous and identified reports", () => {
    const a = submitReportSchema.safeParse(reportValuesFromFormData(form(anonymous)));
    expect(a.success).toBe(true);
    expect(a.data?.identity).toBeUndefined();
    const i = submitReportSchema.safeParse(reportValuesFromFormData(form(identified)));
    expect(i.success).toBe(true);
    expect(i.data?.identity).toMatchObject({ givenName: "Reporter", email: "reporter.zeta@example.test" });
  });

  it("an email-only report keeps only the email, though the no-JavaScript form also posts identity defaults", () => {
    const e = submitReportSchema.safeParse(
      reportValuesFromFormData(
        form({ ...anonymous, reporterMode: "EMAIL_ONLY", "identity.email": "reporter.zeta@example.test" }),
      ),
    );
    expect(e.success).toBe(true);
    expect(e.data?.identity).toEqual({ email: "reporter.zeta@example.test" });
  });

  it("an unticked acknowledgement and a missing choice fail the schema as on the JavaScript path", () => {
    const { acknowledgement: _ack, category: _cat, ...rest } = anonymous;
    const r = submitReportSchema.safeParse(reportValuesFromFormData(form(rest)));
    expect(r.success).toBe(false);
    const paths = r.error!.issues.map((i) => i.path.join("."));
    expect(paths).toContain("acknowledgement");
    expect(paths).toContain("category");
  });
});

describe("echoedValues", () => {
  it("gives back the narrative and choices but never an identity value", () => {
    const values = reportValuesFromFormData(form(identified));
    const echo = echoedValues(values);
    expect(echo.description).toBe(NARRATIVE);
    expect(echo.reporterMode).toBe("IDENTIFIED");
    expect(echo.acknowledgement).toBe(true);
    const serialised = JSON.stringify(echo);
    for (const value of [
      "Reporter",
      "Zeta",
      "1990-04-15",
      "1000000009",
      "+966 500000009",
      "reporter.zeta@",
    ]) {
      expect(serialised).not.toContain(value);
    }
    expect(Object.keys(echo).filter((k) => k.startsWith("identity"))).toEqual([]);
  });

  it("says which identity values must be entered again", () => {
    expect(identityToReenter({ reporterMode: "IDENTIFIED" })).toBe("IDENTIFIED");
    expect(identityToReenter({ reporterMode: "EMAIL_ONLY" })).toBe("EMAIL_ONLY");
    expect(identityToReenter({ reporterMode: "ANONYMOUS" })).toBeNull();
    expect(identityToReenter({})).toBeNull();
  });
});

describe("nestedFieldErrors", () => {
  it("nests identity errors the way React Hook Form keeps them", () => {
    expect(
      nestedFieldErrors({ description: "validation.tooShort", "identity.email": "validation.email" }),
    ).toEqual({
      description: { type: "server", message: "validation.tooShort" },
      identity: { email: { type: "server", message: "validation.email" } },
    });
  });
});
