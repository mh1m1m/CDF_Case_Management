// Case-structure schemas (migration 1870; Phase 12 P12-1). The database re-checks every rule; these refuse early and
// keep one value per status dimension, as the database does.
import { describe, expect, it } from "vitest";
import {
  addAllegationSchema,
  addCaseSubjectSchema,
  closeProceedingSchema,
  openProceedingSchema,
  recordFindingSchema,
  updateProceedingStateSchema,
} from "./case-structure";

const ID = "8f8c2a52-4f0e-4b5a-9a43-0f7f2c1d9e10";
const REASON = "Synthetic reason for the test.";
const messages = (r: { success: boolean; error?: { issues: { message: string; path: PropertyKey[] }[] } }) =>
  (r.error?.issues ?? []).map((i) => `${i.path.join(".")}:${i.message}`);

describe("case-structure schemas", () => {
  it("a subject needs a label and a category", () => {
    expect(
      addCaseSubjectSchema.safeParse({
        caseId: ID,
        displayLabel: "Employee Alpha",
        subjectCategory: "EMPLOYEE",
      }).success,
    ).toBe(true);
    expect(messages(addCaseSubjectSchema.safeParse({ caseId: ID, displayLabel: " " }))).toEqual([
      "displayLabel:validation.required",
      "subjectCategory:validation.required",
    ]);
  });

  it("an allegation takes an intake category; empty optional fields are dropped", () => {
    const r = addAllegationSchema.safeParse({
      caseId: ID,
      category: "POLICY_BREACH",
      description: "Synthetic allegation description.",
      subjectId: "",
      policyReference: "",
    });
    expect(r.success && r.data).toMatchObject({ subjectId: undefined, policyReference: undefined });
    expect(
      addAllegationSchema.safeParse({ caseId: ID, category: "NOT_A_CATEGORY", description: "x".repeat(20) })
        .success,
    ).toBe(false);
    expect(
      messages(addAllegationSchema.safeParse({ caseId: ID, category: "OTHER", description: "short" })),
    ).toEqual(["description:validation.tooShort"]);
  });

  it("a finding needs a proceeding, a result and a rationale; the subject is optional", () => {
    const base = {
      allegationId: ID,
      proceedingId: ID,
      result: "INCONCLUSIVE",
      rationale: "Synthetic rationale.",
    };
    expect(recordFindingSchema.safeParse(base).success).toBe(true);
    expect(recordFindingSchema.safeParse({ ...base, subjectId: ID }).success).toBe(true);
    expect(messages(recordFindingSchema.safeParse({ ...base, proceedingId: "" }))).toEqual([
      "proceedingId:validation.invalid",
    ]);
    expect(recordFindingSchema.safeParse({ ...base, result: "GUILTY" }).success).toBe(false);
  });

  it("only the directly opened types can be opened; committee and grievance proceedings come from a referral", () => {
    for (const proceedingType of ["INVESTIGATION", "PRELIMINARY_REVIEW", "REINVESTIGATION"])
      expect(openProceedingSchema.safeParse({ caseId: ID, proceedingType, reason: REASON }).success).toBe(
        true,
      );
    for (const proceedingType of ["COMMITTEE_INVESTIGATION", "GRIEVANCE"])
      expect(openProceedingSchema.safeParse({ caseId: ID, proceedingType, reason: REASON }).success).toBe(
        false,
      );
  });

  it("suspended means a suspension reason and no waiting reason; otherwise no suspension reason", () => {
    const base = { proceedingId: ID, reason: REASON };
    expect(
      updateProceedingStateSchema.safeParse({ ...base, status: "SUSPENDED", suspensionReason: "GENERAL" })
        .success,
    ).toBe(true);
    expect(messages(updateProceedingStateSchema.safeParse({ ...base, status: "SUSPENDED" }))).toEqual([
      "suspensionReason:validation.required",
    ]);
    expect(
      messages(
        updateProceedingStateSchema.safeParse({
          ...base,
          status: "SUSPENDED",
          suspensionReason: "GENERAL",
          waitingReason: "WITNESS",
        }),
      ),
    ).toEqual(["waitingReason:validation.invalid"]);
    expect(
      messages(
        updateProceedingStateSchema.safeParse({
          ...base,
          status: "IN_PROGRESS",
          suspensionReason: "GENERAL",
        }),
      ),
    ).toEqual(["suspensionReason:validation.invalid"]);
    expect(
      updateProceedingStateSchema.safeParse({ ...base, status: "IN_PROGRESS", waitingReason: "WITNESS" })
        .success,
    ).toBe(true);
    expect(updateProceedingStateSchema.safeParse({ ...base, status: "CONCLUDED" }).success).toBe(false);
  });

  it("concluded needs an outcome, cancelled has none, and the DEC-F10 outcomes are not offered", () => {
    const base = { proceedingId: ID, reason: REASON };
    expect(
      closeProceedingSchema.safeParse({ ...base, status: "CONCLUDED", outcomeCode: "SUBSTANTIATED" }).success,
    ).toBe(true);
    expect(messages(closeProceedingSchema.safeParse({ ...base, status: "CONCLUDED" }))).toEqual([
      "outcomeCode:validation.required",
    ]);
    expect(
      messages(closeProceedingSchema.safeParse({ ...base, status: "CANCELLED", outcomeCode: "DUPLICATE" })),
    ).toEqual(["outcomeCode:validation.invalid"]);
    expect(closeProceedingSchema.safeParse({ ...base, status: "CANCELLED" }).success).toBe(true);
    for (const outcomeCode of ["NOT_FEASIBLE", "NO_PERSONAL_JURISDICTION"])
      expect(closeProceedingSchema.safeParse({ ...base, status: "CONCLUDED", outcomeCode }).success).toBe(
        false,
      );
  });
});
