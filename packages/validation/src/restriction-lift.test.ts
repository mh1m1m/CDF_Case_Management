// The restriction-lift schemas (migration 2130, ADR-049): they refuse early what the database refuses anyway, and none
// of them carries a user id (the actor is the session's, T-AMB-142). Synthetic data only.
import { describe, expect, it } from "vitest";
import {
  decideRestrictionLiftSchema,
  requestRestrictionLiftSchema,
  restrictionLiftCaseSchema,
  restrictionLiftRequestSchema,
} from "./restriction-lift";

const ID = "8f8c2a52-4f0e-4b5a-9a43-0f7f2c1d9e10";
const HASH = "a".repeat(64);
const REASON = "Synthetic: the restriction is no longer needed.";
const messages = (r: { success: boolean; error?: { issues: { message: string; path: PropertyKey[] }[] } }) =>
  (r.error?.issues ?? []).map((i) => `${i.path.join(".")}:${i.message}`);

describe("restriction-lift schemas", () => {
  it("a request needs the case, a reason of 5 to 2000 characters and the previewed hash", () => {
    expect(
      requestRestrictionLiftSchema.safeParse({ caseId: ID, reason: REASON, previewHash: HASH }).success,
    ).toBe(true);
    expect(
      messages(requestRestrictionLiftSchema.safeParse({ caseId: "x", reason: " ", previewHash: "" })),
    ).toEqual(["caseId:validation.invalid", "reason:validation.required", "previewHash:validation.invalid"]);
    expect(
      messages(requestRestrictionLiftSchema.safeParse({ caseId: ID, reason: "four", previewHash: HASH })),
    ).toEqual(["reason:validation.tooShort"]);
    expect(
      messages(
        requestRestrictionLiftSchema.safeParse({ caseId: ID, reason: "x".repeat(2001), previewHash: HASH }),
      ),
    ).toEqual(["reason:validation.tooLong"]);
    // A hash is 64 lower-case hex characters: anything else never reaches the database.
    for (const previewHash of ["A".repeat(64), "a".repeat(63), `${"a".repeat(63)}g`]) {
      expect(
        requestRestrictionLiftSchema.safeParse({ caseId: ID, reason: REASON, previewHash }).success,
      ).toBe(false);
    }
  });

  it("a decision is APPROVE or REJECT, with a reason and the previewed hash", () => {
    const base = { requestId: ID, decision: "APPROVE", reason: REASON, previewHash: HASH };
    expect(decideRestrictionLiftSchema.safeParse(base).success).toBe(true);
    expect(decideRestrictionLiftSchema.safeParse({ ...base, decision: "REJECT" }).success).toBe(true);
    expect(messages(decideRestrictionLiftSchema.safeParse({ ...base, decision: "LIFT" }))).toEqual([
      "decision:validation.required",
    ]);
    expect(messages(decideRestrictionLiftSchema.safeParse({ ...base, reason: undefined }))).toEqual([
      "reason:validation.required",
    ]);
  });

  it("the case and request commands take one id and nothing else, never a user id", () => {
    expect(restrictionLiftCaseSchema.safeParse({ caseId: ID }).success).toBe(true);
    expect(restrictionLiftRequestSchema.safeParse({ requestId: ID }).success).toBe(true);
    expect(restrictionLiftRequestSchema.safeParse({ requestId: "not-a-uuid" }).success).toBe(false);
    // Extra keys (an acting-as user, an approver) are dropped: the database derives the actor itself.
    const parsed = restrictionLiftRequestSchema.parse({ requestId: ID, userId: ID, approverId: ID });
    expect(parsed).toEqual({ requestId: ID });
    for (const schema of [
      restrictionLiftCaseSchema,
      requestRestrictionLiftSchema,
      decideRestrictionLiftSchema,
      restrictionLiftRequestSchema,
    ]) {
      const actorKeys = Object.keys(schema.shape).filter(
        (k) => /(?:user|actor|approver)/i.test(k) || /by$/i.test(k),
      );
      expect(actorKeys).toEqual([]);
    }
  });
});
