// Legal review and authority schemas (Phase 12 P12-3a; ADR-057). The database re-checks every rule, including who may
// act and that each chosen id is one the command accepts; these refuse early with the commands' own lengths and
// pairings, so the form shows each problem next to its field (`itemOutcomes.0.outcome`, `conditions.1.text`).
import { describe, expect, it } from "vitest";
import {
  approveRestrictedLegalReviewSchema,
  cancelLegalReviewRequestSchema,
  giveLegalOpinionSchema,
  giveSupersedingLegalOpinionSchema,
  recordAuthorityDecisionSchema,
  requestLegalReviewSchema,
  submitToAuthoritySchema,
} from "./legal-reviews";

const ID = "8f8c2a52-4f0e-4b5a-9a43-0f7f2c1d9e10";
const OTHER = "0b7d6c55-2c1e-4f3a-8e21-5d9a0c7b6e41";
const THIRD = "4c2a9e11-7d3b-4e6f-9a10-2b8c5d7e1f30";
const messages = (r: { success: boolean; error?: { issues: { message: string; path: PropertyKey[] }[] } }) =>
  (r.error?.issues ?? []).map((i) => `${i.path.join(".")}:${i.message}`);

describe("asking for, approving and cancelling a legal review", () => {
  const ask = { packageId: ID, assignedTo: OTHER, reason: "Synthetic: legal check of the sanction." };

  it("a request names a reviewer from the list and a reason; findings and minutes are optional", () => {
    const r = requestLegalReviewSchema.safeParse(ask);
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject({ findingIds: [], minutesIds: [] });
    expect(
      requestLegalReviewSchema.safeParse({ ...ask, findingIds: [ID, OTHER], minutesIds: [THIRD] }).success,
    ).toBe(true);
  });

  it("no reviewer chosen says choose one; a short or missing reason says so", () => {
    expect(messages(requestLegalReviewSchema.safeParse({ ...ask, assignedTo: undefined }))).toEqual([
      "assignedTo:validation.chooseOne",
    ]);
    expect(messages(requestLegalReviewSchema.safeParse({ ...ask, reason: "abc" }))).toEqual([
      "reason:validation.tooShort",
    ]);
    expect(messages(requestLegalReviewSchema.safeParse({ ...ask, reason: " " }))).toEqual([
      "reason:validation.required",
    ]);
    expect(messages(requestLegalReviewSchema.safeParse({ ...ask, reason: "x".repeat(2001) }))).toEqual([
      "reason:validation.tooLong",
    ]);
  });

  it("a finding or minutes chosen twice is refused, as the command refuses a repeat", () => {
    expect(messages(requestLegalReviewSchema.safeParse({ ...ask, findingIds: [ID, ID] }))).toEqual([
      "findingIds:validation.invalid",
    ]);
    expect(messages(requestLegalReviewSchema.safeParse({ ...ask, minutesIds: ["not-an-id"] }))).toEqual([
      "minutesIds.0:validation.invalid",
    ]);
  });

  it("the restricted case's approval names its reviewer, scope and reason the same way", () => {
    const approve = { packageId: ID, reviewerId: OTHER, findingIds: [THIRD], reason: "Synthetic approval." };
    expect(approveRestrictedLegalReviewSchema.safeParse(approve).success).toBe(true);
    expect(
      messages(approveRestrictedLegalReviewSchema.safeParse({ ...approve, reviewerId: "someone" })),
    ).toEqual(["reviewerId:validation.chooseOne"]);
  });

  it("cancelling needs the request and a reason of 5 to 2,000 characters", () => {
    expect(
      cancelLegalReviewRequestSchema.safeParse({ requestId: ID, reason: "Wrong reviewer." }).success,
    ).toBe(true);
    expect(messages(cancelLegalReviewRequestSchema.safeParse({ requestId: ID, reason: "no" }))).toEqual([
      "reason:validation.tooShort",
    ]);
  });
});

describe("the opinion and a later opinion", () => {
  for (const [name, schema] of [
    ["giveLegalOpinionSchema", giveLegalOpinionSchema],
    ["giveSupersedingLegalOpinionSchema", giveSupersedingLegalOpinionSchema],
  ] as const) {
    it(`${name}: CONCURS may stand alone, any other opinion gives its text`, () => {
      expect(schema.safeParse({ requestId: ID, opinion: "CONCURS" }).data).toEqual({
        requestId: ID,
        opinion: "CONCURS",
        opinionText: undefined,
      });
      expect(messages(schema.safeParse({ requestId: ID, opinion: "CONFLICTS" }))).toEqual([
        "opinionText:validation.opinionTextRequired",
      ]);
      expect(
        messages(schema.safeParse({ requestId: ID, opinion: "CONCURS_WITH_COMMENTS", opinionText: "  " })),
      ).toEqual(["opinionText:validation.opinionTextRequired"]);
      expect(
        schema.safeParse({
          requestId: ID,
          opinion: "CONFLICTS",
          opinionText: "Synthetic: the sanction exceeds.",
        }).success,
      ).toBe(true);
    });

    it(`${name}: no opinion chosen says choose one; the text is 10 to 8,000 characters`, () => {
      expect(messages(schema.safeParse({ requestId: ID }))).toEqual(["opinion:validation.chooseOne"]);
      expect(
        messages(schema.safeParse({ requestId: ID, opinion: "CONCURS", opinionText: "Too short" })),
      ).toEqual(["opinionText:validation.tooShort"]);
      expect(
        messages(schema.safeParse({ requestId: ID, opinion: "CONCURS", opinionText: "x".repeat(8001) })),
      ).toEqual(["opinionText:validation.tooLong"]);
    });
  }
});

describe("the authority", () => {
  it("submitting needs only the package", () => {
    expect(submitToAuthoritySchema.safeParse({ packageId: ID }).success).toBe(true);
    expect(messages(submitToAuthoritySchema.safeParse({}))).toEqual(["packageId:validation.invalid"]);
  });

  /** A decision as the record page sends it: three empty condition rows, and one row per item of the scope. */
  const decision = {
    packageId: ID,
    authorityType: "CEO",
    outcome: "APPROVE_AS_RECOMMENDED",
    decidedAt: "2026-10-14T10:30",
    decidedByLabel: "Synthetic Chief Executive",
    sourceDocumentReference: "CDF-DEMO-DEC-0001",
    additionalSourceReferences: "",
    itemOutcomes: [{ itemId: OTHER }, { itemId: THIRD }],
    conditions: [{}, { kind: "", text: "", itemId: "", dueDate: "" }, {}],
  };

  it("a whole decision drops the empty rows and reads a local time as Riyadh time", () => {
    const r = recordAuthorityDecisionSchema.safeParse(decision);
    expect(messages(r)).toEqual([]);
    expect(r.data).toMatchObject({
      outcome: "APPROVE_AS_RECOMMENDED",
      decidedAt: "2026-10-14T07:30:00.000Z",
      additionalSourceReferences: [],
      itemOutcomes: undefined,
      conditions: undefined,
    });
  });

  it("a decision in the future, or a date that is not one, is refused at its field", () => {
    expect(
      messages(recordAuthorityDecisionSchema.safeParse({ ...decision, decidedAt: "2999-01-01T00:00" })),
    ).toEqual(["decidedAt:validation.futureDate"]);
    expect(
      messages(recordAuthorityDecisionSchema.safeParse({ ...decision, decidedAt: "yesterday" })),
    ).toEqual(["decidedAt:validation.invalid"]);
    expect(messages(recordAuthorityDecisionSchema.safeParse({ ...decision, decidedAt: "" }))).toEqual([
      "decidedAt:validation.required",
    ]);
  });

  it("an unsigned source needs the secretary's attestation, and any other source takes none", () => {
    expect(
      messages(recordAuthorityDecisionSchema.safeParse({ ...decision, sourceSignature: "UNSIGNED" })),
    ).toEqual(["unsignedAttestation:validation.attestationRequired"]);
    expect(
      recordAuthorityDecisionSchema.safeParse({
        ...decision,
        sourceSignature: "UNSIGNED",
        unsignedAttestation: "Synthetic: confirmed with the office.",
      }).success,
    ).toBe(true);
    expect(
      messages(
        recordAuthorityDecisionSchema.safeParse({
          ...decision,
          sourceSignature: "SIGNED",
          unsignedAttestation: "Synthetic: not needed here.",
        }),
      ),
    ).toEqual(["unsignedAttestation:validation.noAttestation"]);
  });

  it("further sources are one per line: blank lines left out, a repeat or the main one refused", () => {
    expect(
      recordAuthorityDecisionSchema.safeParse({
        ...decision,
        additionalSourceReferences: "REF-1\n\n REF-2 \n",
      }).data?.additionalSourceReferences,
    ).toEqual(["REF-1", "REF-2"]);
    for (const additionalSourceReferences of ["REF-1\nREF-1", "CDF-DEMO-DEC-0001", "ab"]) {
      expect(
        messages(recordAuthorityDecisionSchema.safeParse({ ...decision, additionalSourceReferences })),
        additionalSourceReferences,
      ).toEqual(["additionalSourceReferences:validation.sources"]);
    }
  });

  it("approving partially or modifying needs a decision on every item, and a modified item says how", () => {
    const partial = { ...decision, outcome: "MODIFY" };
    expect(messages(recordAuthorityDecisionSchema.safeParse(partial))).toEqual([
      "itemOutcomes.0.outcome:validation.chooseOne",
      "itemOutcomes.1.outcome:validation.chooseOne",
    ]);
    expect(
      messages(
        recordAuthorityDecisionSchema.safeParse({
          ...partial,
          itemOutcomes: [
            { itemId: OTHER, outcome: "MODIFIED" },
            { itemId: THIRD, outcome: "APPROVED", modification: "Synthetic: not for an approved item." },
          ],
        }),
      ),
    ).toEqual([
      "itemOutcomes.0.modification:validation.modificationRequired",
      "itemOutcomes.1.modification:validation.noModification",
    ]);
    const r = recordAuthorityDecisionSchema.safeParse({
      ...partial,
      itemOutcomes: [
        { itemId: OTHER, outcome: "MODIFIED", modification: "Synthetic: a shorter suspension." },
        { itemId: THIRD, outcome: "REJECTED", modification: "" },
      ],
    });
    expect(r.data?.itemOutcomes).toEqual([
      { itemId: OTHER, outcome: "MODIFIED", modification: "Synthetic: a shorter suspension." },
      { itemId: THIRD, outcome: "REJECTED", modification: undefined },
    ]);
  });

  it("item outcomes go only with an itemised decision: any other outcome sends none", () => {
    const r = recordAuthorityDecisionSchema.safeParse({
      ...decision,
      outcome: "REJECT",
      itemOutcomes: [{ itemId: OTHER, outcome: "APPROVED" }],
    });
    expect(r.success).toBe(true);
    expect(r.data?.itemOutcomes).toBeUndefined();
  });

  it("conditions go only with an approving decision, each with its kind and text", () => {
    const condition = {
      kind: "FOLLOW_UP_TASK",
      text: "Synthetic: report back in 30 days.",
      itemId: OTHER,
      dueDate: "2026-11-30",
    };
    const r = recordAuthorityDecisionSchema.safeParse({ ...decision, conditions: [{}, condition, {}] });
    expect(r.data?.conditions).toEqual([condition]);
    expect(
      messages(
        recordAuthorityDecisionSchema.safeParse({ ...decision, outcome: "REJECT", conditions: [condition] }),
      ),
    ).toEqual(["conditions.0.kind:validation.noConditions"]);
    expect(
      messages(
        recordAuthorityDecisionSchema.safeParse({
          ...decision,
          conditions: [{}, { text: "Hi", itemId: "x", dueDate: "30/11/2026" }],
        }),
      ),
    ).toEqual([
      "conditions.1.kind:validation.chooseOne",
      "conditions.1.text:validation.tooShort",
      "conditions.1.itemId:validation.invalid",
      "conditions.1.dueDate:validation.invalid",
    ]);
  });

  it("who decided and the main source are required, with the commands' lengths", () => {
    expect(
      messages(
        recordAuthorityDecisionSchema.safeParse({
          ...decision,
          decidedByLabel: "",
          sourceDocumentReference: "ab",
        }),
      ),
    ).toEqual(["decidedByLabel:validation.required", "sourceDocumentReference:validation.tooShort"]);
    expect(messages(recordAuthorityDecisionSchema.safeParse({ ...decision, authorityType: "KING" }))).toEqual(
      ["authorityType:validation.required"],
    );
    expect(messages(recordAuthorityDecisionSchema.safeParse({ ...decision, outcome: undefined }))).toEqual([
      "outcome:validation.chooseOne",
    ]);
  });
});
