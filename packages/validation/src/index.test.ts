import { describe, expect, it } from "vitest";
import { fieldErrors, isValidBirthDate, submitReportSchema, triageReportSchema } from "./index";

const base = {
  relationship: "EMPLOYEE",
  category: "FINANCIAL_CORRUPTION",
  subjectDescription: "Employee Alpha (synthetic)",
  description: "SYNTHETIC: a sufficiently long description of the concern.",
  incidentDate: "2026-09-01",
  incidentTime: "09:30",
  location: "Finance department (synthetic)",
  willingToCooperate: "YES",
  reporterMode: "ANONYMOUS",
  acknowledgement: true,
} as const;

const identified = {
  givenName: "Reporter",
  fatherName: "Sigma",
  grandfatherName: "Synthetic",
  familyName: "Example",
  gender: "FEMALE",
  birthDateCalendar: "GREGORIAN",
  birthDate: "1990-04-15",
  idType: "NATIONAL_ID",
  idNumber: "1000000001",
  city: "RIYADH",
  nationality: "SA",
  phone: "+966 500000001",
  email: "Reporter.Sigma@Example.test",
} as const;

const errorsOf = (input: object) => {
  const r = submitReportSchema.safeParse(input);
  return r.success ? {} : fieldErrors(r.error);
};

describe("submitReportSchema (Drive field set, CDF-63)", () => {
  it("accepts an anonymous report and drops any identity", () => {
    const r = submitReportSchema.parse({ ...base, identity: { givenName: "Reporter Alpha" } });
    expect(r.identity).toBeUndefined();
  });

  it("ignores partial identity fields left over in anonymous mode", () => {
    const r = submitReportSchema.safeParse({ ...base, identity: { preferredContact: "PORTAL_ONLY" } });
    expect(r.success).toBe(true);
  });

  it("requires every mandatory report field", () => {
    expect(errorsOf({ reporterMode: "ANONYMOUS", description: "", acknowledgement: false })).toMatchObject({
      relationship: "validation.required",
      category: "validation.required",
      subjectDescription: "validation.required",
      description: "validation.required",
      incidentDate: "validation.required",
      incidentTime: "validation.required",
      location: "validation.required",
      willingToCooperate: "validation.required",
      acknowledgement: "validation.acknowledgementRequired",
    });
  });

  it("requires a reporting mode from the three Drive modes", () => {
    expect(errorsOf({ ...base, reporterMode: undefined })).toMatchObject({
      reporterMode: "validation.required",
    });
    expect(errorsOf({ ...base, reporterMode: "PSEUDONYMOUS" })).toMatchObject({
      reporterMode: "validation.required",
    });
  });

  it("rejects short descriptions, future dates, bad times and missing acknowledgement with i18n keys", () => {
    expect(
      errorsOf({
        ...base,
        description: "short",
        incidentDate: "2999-01-01",
        incidentTime: "25:00",
        acknowledgement: false,
      }),
    ).toMatchObject({
      description: "validation.tooShort",
      incidentDate: "validation.futureDate",
      incidentTime: "validation.invalid",
      acknowledgement: "validation.acknowledgementRequired",
    });
  });

  it("keeps the relationship and violation-type 'other' texts only when Other is chosen", () => {
    const other = submitReportSchema.parse({
      ...base,
      relationship: "OTHER",
      relationshipOther: "Volunteer (synthetic)",
      category: "OTHER",
      categoryOther: "Something else (synthetic)",
    });
    expect(other).toMatchObject({
      relationshipOther: "Volunteer (synthetic)",
      categoryOther: "Something else (synthetic)",
    });
    const notOther = submitReportSchema.parse({ ...base, relationshipOther: "x", categoryOther: "y" });
    expect(notOther.relationshipOther).toBeUndefined();
    expect(notOther.categoryOther).toBeUndefined();
    // Optional even when Other is chosen (Drive fields 2 and 14).
    expect(submitReportSchema.safeParse({ ...base, relationship: "OTHER", category: "OTHER" }).success).toBe(
      true,
    );
  });

  it("email-only mode requires a valid email and keeps nothing else", () => {
    expect(errorsOf({ ...base, reporterMode: "EMAIL_ONLY", identity: {} })).toMatchObject({
      "identity.email": "validation.required",
    });
    expect(errorsOf({ ...base, reporterMode: "EMAIL_ONLY", identity: { email: "nope" } })).toMatchObject({
      "identity.email": "validation.email",
    });
    const r = submitReportSchema.parse({
      ...base,
      reporterMode: "EMAIL_ONLY",
      identity: { email: " Reporter.Tau@Example.test ", givenName: "Tau", phone: "+966 500000003" },
    });
    expect(r.identity).toEqual({ email: "reporter.tau@example.test" });
  });

  it("identified mode requires every identity field", () => {
    const errors = errorsOf({ ...base, reporterMode: "IDENTIFIED", identity: {} });
    for (const field of [
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
    ])
      expect(errors[`identity.${field}`], field).toBeDefined();
  });

  it("reports identity errors in the same pass as other field errors", () => {
    const errors = errorsOf({ ...base, relationship: undefined, reporterMode: "IDENTIFIED", identity: {} });
    expect(errors).toMatchObject({
      relationship: "validation.required",
      "identity.givenName": "validation.required",
    });
  });

  it("accepts a complete identified report and normalises it", () => {
    const r = submitReportSchema.parse({ ...base, reporterMode: "IDENTIFIED", identity: identified });
    expect(r.identity).toMatchObject({
      email: "reporter.sigma@example.test",
      preferredContact: "PORTAL_ONLY",
    });
  });

  it("checks the ID number against the ID type", () => {
    const bad = (idType: string, idNumber: string) =>
      errorsOf({ ...base, reporterMode: "IDENTIFIED", identity: { ...identified, idType, idNumber } })[
        "identity.idNumber"
      ];
    expect(bad("NATIONAL_ID", "2000000001")).toBe("validation.idNumber");
    expect(bad("IQAMA", "1000000001")).toBe("validation.idNumber");
    expect(bad("IQAMA", "2000000001")).toBeUndefined();
    expect(bad("PASSPORT", "a1234567")).toBeUndefined();
    expect(bad("PASSPORT", "A1")).toBe("validation.idNumber");
  });

  it("checks the date of birth in the chosen calendar", () => {
    expect(isValidBirthDate("1990-04-15", "GREGORIAN")).toBe(true);
    expect(isValidBirthDate("2001-02-29", "GREGORIAN")).toBe(false);
    expect(isValidBirthDate("2999-01-01", "GREGORIAN")).toBe(false);
    expect(isValidBirthDate("1410-09-30", "HIJRI")).toBe(true);
    expect(isValidBirthDate("1410-09-31", "HIJRI")).toBe(false);
    expect(isValidBirthDate("1990-04-15", "HIJRI")).toBe(false);
    expect(
      errorsOf({
        ...base,
        reporterMode: "IDENTIFIED",
        identity: { ...identified, birthDateCalendar: "HIJRI" },
      })["identity.birthDate"],
    ).toBe("validation.birthDate");
  });
});

describe("triageReportSchema", () => {
  it("requires a destination when referring out", () => {
    const r = triageReportSchema.safeParse({
      reportId: "a0000000-0000-4000-8000-000000000001",
      outcome: "REFER_OUT",
      reason: "Synthetic: belongs to another authority.",
    });
    expect(r.success).toBe(false);
  });
});
