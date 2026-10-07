import { describe, expect, it } from "vitest";
import { fieldErrors, submitReportSchema, triageReportSchema } from "./index";

const base = {
  category: "FRAUD",
  description: "SYNTHETIC: a sufficiently long description of the concern.",
  reporterMode: "ANONYMOUS",
  acknowledgement: true,
} as const;

describe("submitReportSchema", () => {
  it("accepts an anonymous report and drops any identity", () => {
    const r = submitReportSchema.parse({ ...base, identity: { fullName: "Reporter Alpha" } });
    expect(r.identity).toBeUndefined();
  });

  it("requires some identity for identified reports", () => {
    const r = submitReportSchema.safeParse({ ...base, reporterMode: "IDENTIFIED", identity: {} });
    expect(r.success).toBe(false);
  });

  it("rejects short descriptions, future dates and missing acknowledgement with i18n keys", () => {
    const r = submitReportSchema.safeParse({
      ...base,
      description: "short",
      incidentDate: "2999-01-01",
      acknowledgement: false,
    });
    expect(r.success).toBe(false);
    const errors = fieldErrors(r.error!);
    expect(errors).toMatchObject({
      description: "validation.tooShort",
      incidentDate: "validation.futureDate",
      acknowledgement: "validation.acknowledgementRequired",
    });
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
