// The owner's report, the verification and a reopening (Phase 12 P12-6a; ADR-058; migrations 1940 and 2040). The
// database re-checks every rule, including what the policy in force asks of a completion; these refuse early with the
// commands' own lengths and pairings, so the form shows each problem next to its field. A form sends text: a
// percentage is read from it, and a blank field arrives as missing.
import { describe, expect, it } from "vitest";
import {
  recordCorrectiveActionProgressSchema,
  reopenCorrectiveActionSchema,
  submitCorrectiveActionCompletionSchema,
  verifyCorrectiveActionSchema,
} from "./corrective-actions";

const ID = "8f8c2a52-4f0e-4b5a-9a43-0f7f2c1d9e10";
const messages = (r: { success: boolean; error?: { issues: { message: string; path: PropertyKey[] }[] } }) =>
  (r.error?.issues ?? []).map((i) => `${i.path.join(".")}:${i.message}`);

describe("recording progress", () => {
  const progress = { actionId: ID, note: "Synthetic: the second approver is being trained." };

  it("takes a whole percentage from 0 to 100, as the form sends it or as a number", () => {
    for (const percentComplete of ["0", "40", " 100 ", 0, 55, 100]) {
      const r = recordCorrectiveActionProgressSchema.safeParse({ ...progress, percentComplete });
      expect(r.success, String(percentComplete)).toBe(true);
    }
    expect(recordCorrectiveActionProgressSchema.parse({ ...progress, percentComplete: "40" })).toEqual({
      ...progress,
      percentComplete: 40,
    });
  });

  it("says a missing percentage is required, and anything but a whole number from 0 to 100 is invalid", () => {
    for (const percentComplete of [undefined, "", "  "])
      expect(
        messages(recordCorrectiveActionProgressSchema.safeParse({ ...progress, percentComplete })),
        String(percentComplete),
      ).toEqual(["percentComplete:validation.required"]);
    for (const percentComplete of ["forty", "40.5", "-1", "101", "1e3", 40.5, -1, 101, null])
      expect(
        messages(recordCorrectiveActionProgressSchema.safeParse({ ...progress, percentComplete })),
        String(percentComplete),
      ).toEqual(["percentComplete:validation.invalid"]);
  });

  it("needs a note of 5 to 4,000 characters", () => {
    expect(
      messages(
        recordCorrectiveActionProgressSchema.safeParse({ ...progress, percentComplete: "40", note: "abc" }),
      ),
    ).toEqual(["note:validation.tooShort"]);
    expect(
      messages(
        recordCorrectiveActionProgressSchema.safeParse({
          ...progress,
          percentComplete: "40",
          note: "x".repeat(4001),
        }),
      ),
    ).toEqual(["note:validation.tooLong"]);
  });
});

describe("submitting a completion", () => {
  const completion = { actionId: ID, note: "Synthetic: the second approver is in place." };

  it("takes a note alone, or with a reference and, with it, a kind of evidence", () => {
    expect(submitCorrectiveActionCompletionSchema.safeParse(completion).success).toBe(true);
    expect(
      submitCorrectiveActionCompletionSchema.safeParse({
        ...completion,
        evidenceReference: "DOC-DEMO-2026-0007",
      }).success,
    ).toBe(true);
    expect(
      submitCorrectiveActionCompletionSchema.parse({
        ...completion,
        evidenceReference: " DOC-DEMO-2026-0007 ",
        evidenceType: "REVISED_PROCEDURE",
      }),
    ).toEqual({ ...completion, evidenceReference: "DOC-DEMO-2026-0007", evidenceType: "REVISED_PROCEDURE" });
  });

  it("refuses a kind of evidence without a reference, and a kind the contracts do not name", () => {
    expect(
      messages(submitCorrectiveActionCompletionSchema.safeParse({ ...completion, evidenceType: "DOCUMENT" })),
    ).toEqual(["evidenceType:validation.invalid"]);
    expect(
      messages(
        submitCorrectiveActionCompletionSchema.safeParse({
          ...completion,
          evidenceReference: "DOC-DEMO-2026-0007",
          evidenceType: "PHOTOGRAPH",
        }),
      ),
    ).toEqual(["evidenceType:validation.invalid"]);
  });

  it("keeps the command's lengths: a note of 5 to 4,000 and a reference of 3 to 300 characters", () => {
    expect(
      messages(submitCorrectiveActionCompletionSchema.safeParse({ ...completion, note: "abc" })),
    ).toEqual(["note:validation.tooShort"]);
    expect(
      messages(submitCorrectiveActionCompletionSchema.safeParse({ ...completion, evidenceReference: "ab" })),
    ).toEqual(["evidenceReference:validation.tooShort"]);
    expect(
      messages(
        submitCorrectiveActionCompletionSchema.safeParse({
          ...completion,
          evidenceReference: "x".repeat(301),
        }),
      ),
    ).toEqual(["evidenceReference:validation.tooLong"]);
  });
});

describe("verifying, returning and reopening", () => {
  it("verifies with or without a note, and returns only saying why", () => {
    expect(verifyCorrectiveActionSchema.safeParse({ actionId: ID, decision: "VERIFIED" }).success).toBe(true);
    expect(
      verifyCorrectiveActionSchema.safeParse({
        actionId: ID,
        decision: "VERIFIED",
        note: "Synthetic: checked against the procedure.",
      }).success,
    ).toBe(true);
    expect(messages(verifyCorrectiveActionSchema.safeParse({ actionId: ID, decision: "RETURNED" }))).toEqual([
      "note:validation.required",
    ]);
    expect(
      verifyCorrectiveActionSchema.safeParse({
        actionId: ID,
        decision: "RETURNED",
        note: "Synthetic: the procedure is not yet signed.",
      }).success,
    ).toBe(true);
    expect(messages(verifyCorrectiveActionSchema.safeParse({ actionId: ID, decision: "APPROVED" }))).toEqual([
      "decision:validation.required",
    ]);
  });

  it("reopens only with a reason of 5 to 2,000 characters", () => {
    expect(
      reopenCorrectiveActionSchema.safeParse({ actionId: ID, reason: "Synthetic: the control failed again." })
        .success,
    ).toBe(true);
    expect(messages(reopenCorrectiveActionSchema.safeParse({ actionId: ID, reason: "abc" }))).toEqual([
      "reason:validation.tooShort",
    ]);
    expect(messages(reopenCorrectiveActionSchema.safeParse({ actionId: ID }))).not.toEqual([]);
  });

  it("refuses an id that is not a UUID", () => {
    expect(
      messages(reopenCorrectiveActionSchema.safeParse({ actionId: "1", reason: "Synthetic: reopened." })),
    ).toEqual(["actionId:validation.invalid"]);
  });
});
