// Recommendation package and invite schemas (Phase 12 P12-2c; ADR-056). The database re-checks every rule, including
// who may act; these refuse early with the commands' own lengths and pairings, so a form shows the problem field by
// field before a round trip.
import { describe, expect, it } from "vitest";
import {
  addRecommendationItemSchema,
  createRecommendationPackageSchema,
  inviteToMeetingSchema,
  openPackageVoteSchema,
  recordPackageAdoptionSchema,
  resolveConflictTaintSchema,
  returnPackageToCommitteeSchema,
  submitPackageForVoteSchema,
  withdrawRecommendationItemSchema,
} from "./committee-proceedings";

const ID = "8f8c2a52-4f0e-4b5a-9a43-0f7f2c1d9e10";
const OTHER = "0b7d6c55-2c1e-4f3a-8e21-5d9a0c7b6e41";
const messages = (r: { success: boolean; error?: { issues: { message: string; path: PropertyKey[] }[] } }) =>
  (r.error?.issues ?? []).map((i) => `${i.path.join(".")}:${i.message}`);

/** A disciplinary sanction from the catalogue, about one subject, as the builder sends it. */
const sanction = {
  packageId: ID,
  itemType: "DISCIPLINARY_SANCTION",
  sanctionCode: "WARNING",
  description: "Synthetic: written warning for Employee Sigma.",
  subjectIds: [ID],
  requiresLegalJustification: false,
};

describe("package schemas", () => {
  it("a package is voted as a whole or item by item, chosen when it is created", () => {
    for (const voteGranularity of ["PACKAGE", "ITEM"]) {
      expect(
        createRecommendationPackageSchema.safeParse({ committeeProceedingId: ID, voteGranularity }).success,
      ).toBe(true);
    }
    expect(
      messages(
        createRecommendationPackageSchema.safeParse({ committeeProceedingId: ID, voteGranularity: "BOTH" }),
      ),
    ).toEqual(["voteGranularity:validation.required"]);
    expect(
      messages(
        createRecommendationPackageSchema.safeParse({ committeeProceedingId: "x", voteGranularity: "ITEM" }),
      ),
    ).toEqual(["committeeProceedingId:validation.invalid"]);
  });

  it("submitting, adopting and opening a package's vote need only their ids", () => {
    for (const schema of [submitPackageForVoteSchema, recordPackageAdoptionSchema]) {
      expect(schema.safeParse({ packageId: ID }).success).toBe(true);
      expect(messages(schema.safeParse({ packageId: "PKG-01" }))).toEqual(["packageId:validation.invalid"]);
    }
    expect(openPackageVoteSchema.safeParse({ meetingId: ID, packageId: OTHER }).success).toBe(true);
    expect(messages(openPackageVoteSchema.safeParse({ meetingId: ID }))).toEqual([
      "packageId:validation.invalid",
    ]);
  });

  it("returning a package and withdrawing an item need a reason of 5 to 2,000 characters", () => {
    expect(returnPackageToCommitteeSchema.safeParse({ packageId: ID, reason: "Synthetic." }).success).toBe(
      true,
    );
    expect(messages(returnPackageToCommitteeSchema.safeParse({ packageId: ID, reason: "abc" }))).toEqual([
      "reason:validation.tooShort",
    ]);
    expect(messages(withdrawRecommendationItemSchema.safeParse({ itemId: ID, reason: "  " }))).toEqual([
      "reason:validation.required",
    ]);
    expect(
      messages(withdrawRecommendationItemSchema.safeParse({ itemId: ID, reason: "x".repeat(2001) })),
    ).toEqual(["reason:validation.tooLong"]);
  });
});

describe("addRecommendationItemSchema", () => {
  it("accepts a catalogue sanction about a subject, and an item about the whole case", () => {
    const r = addRecommendationItemSchema.safeParse(sanction);
    expect(r.success && r.data).toMatchObject({
      sanctionCode: "WARNING",
      allegationIds: [],
      dependsOnItemIds: [],
    });
    expect(r.success && r.data.proposedSanctionText).toBeUndefined();
    const caseWide = addRecommendationItemSchema.safeParse({
      packageId: ID,
      itemType: "CORRECTIVE_ACTION",
      description: "Synthetic: strengthen the approval controls.",
      requiresLegalJustification: true,
    });
    expect(caseWide.success && caseWide.data).toMatchObject({ subjectIds: [], allegationIds: [] });
  });

  it("a disciplinary sanction names one sanction, from the catalogue or proposed outside it, and a subject (Q87, Q88)", () => {
    expect(
      addRecommendationItemSchema.safeParse({ ...sanction, sanctionCode: "", proposedSanctionText: "A fine" })
        .success,
    ).toBe(true);
    expect(
      messages(
        addRecommendationItemSchema.safeParse({ ...sanction, proposedSanctionText: "A synthetic fine" }),
      ),
    ).toEqual(["proposedSanctionText:validation.oneSanction"]);
    expect(messages(addRecommendationItemSchema.safeParse({ ...sanction, sanctionCode: undefined }))).toEqual(
      ["sanctionCode:validation.sanctionRequired"],
    );
    expect(messages(addRecommendationItemSchema.safeParse({ ...sanction, subjectIds: [] }))).toEqual([
      "subjectIds:validation.subjectRequired",
    ]);
  });

  it("any other item names no sanction", () => {
    const other = { ...sanction, itemType: "OTHER", subjectIds: [] };
    expect(messages(addRecommendationItemSchema.safeParse(other))).toEqual([
      "sanctionCode:validation.noSanction",
    ]);
    expect(
      messages(
        addRecommendationItemSchema.safeParse({
          ...other,
          sanctionCode: undefined,
          proposedSanctionText: "A fine",
        }),
      ),
    ).toEqual(["proposedSanctionText:validation.noSanction"]);
  });

  it("codes, lengths and lists follow the command's own checks", () => {
    expect(messages(addRecommendationItemSchema.safeParse({ ...sanction, sanctionCode: "warning" }))).toEqual(
      ["sanctionCode:validation.code"],
    );
    expect(
      addRecommendationItemSchema.safeParse({ ...sanction, exclusivityGroup: "SUSPENSION_OPTIONS" }).success,
    ).toBe(true);
    expect(messages(addRecommendationItemSchema.safeParse({ ...sanction, exclusivityGroup: "AB" }))).toEqual([
      "exclusivityGroup:validation.code",
    ]);
    expect(
      messages(addRecommendationItemSchema.safeParse({ ...sanction, description: "Too short" })),
    ).toEqual(["description:validation.tooShort"]);
    expect(
      messages(
        addRecommendationItemSchema.safeParse({
          ...sanction,
          sanctionCode: undefined,
          proposedSanctionText: "ab",
        }),
      ),
    ).toEqual(["proposedSanctionText:validation.tooShort"]);
    expect(messages(addRecommendationItemSchema.safeParse({ ...sanction, subjectIds: [ID, ID] }))).toEqual([
      "subjectIds:validation.invalid",
    ]);
    expect(
      messages(addRecommendationItemSchema.safeParse({ ...sanction, dependsOnItemIds: ["item-1"] })),
    ).toEqual(["dependsOnItemIds.0:validation.invalid"]);
    expect(messages(addRecommendationItemSchema.safeParse({ ...sanction, itemType: "FINE" }))).toEqual([
      "itemType:validation.required",
    ]);
  });
});

describe("resolveConflictTaintSchema", () => {
  it("records a re-vote or a confirmation with a reason of 10 to 2,000 characters", () => {
    for (const resolution of ["RE_VOTE", "CONFIRM"]) {
      expect(
        resolveConflictTaintSchema.safeParse({ itemId: ID, resolution, reason: "Synthetic." }).success,
      ).toBe(true);
    }
    expect(
      messages(
        resolveConflictTaintSchema.safeParse({ itemId: ID, resolution: "IGNORE", reason: "Too short" }),
      ),
    ).toEqual(["resolution:validation.required", "reason:validation.tooShort"]);
  });
});

describe("inviteToMeetingSchema", () => {
  const invite = {
    meetingId: ID,
    inviteeRole: "WITNESS",
    requiresCoi: true,
    reason: "Synthetic: a witness.",
  };

  it("takes one candidate from the list, an account or a case person, and sends the command its id", () => {
    const account = inviteToMeetingSchema.safeParse({ ...invite, invitee: `account:${ID.toUpperCase()}` });
    expect(account.success && account.data).toMatchObject({ userId: ID, personId: undefined });
    const person = inviteToMeetingSchema.safeParse({ ...invite, invitee: `person:${OTHER}` });
    expect(person.success && person.data).toMatchObject({ userId: undefined, personId: OTHER });
    expect(person.success && "invitee" in person.data).toBe(false);
  });

  it("refuses anything that is not a listed candidate", () => {
    expect(messages(inviteToMeetingSchema.safeParse({ ...invite, invitee: `user:${ID}` }))).toEqual([
      "invitee:validation.invalid",
    ]);
    expect(messages(inviteToMeetingSchema.safeParse({ ...invite, invitee: " " }))).toEqual([
      "invitee:validation.required",
    ]);
  });

  it("pairs each role as the command does: an interpreter declares, a legal adviser has an account, a person concerned is a case person", () => {
    expect(
      messages(
        inviteToMeetingSchema.safeParse({
          ...invite,
          inviteeRole: "INTERPRETER",
          requiresCoi: false,
          invitee: `person:${ID}`,
        }),
      ),
    ).toEqual(["requiresCoi:validation.interpreterCoi"]);
    expect(
      messages(inviteToMeetingSchema.safeParse({ ...invite, inviteeRole: "LEGAL", invitee: `person:${ID}` })),
    ).toEqual(["inviteeRole:validation.legalNeedsAccount"]);
    expect(
      messages(
        inviteToMeetingSchema.safeParse({ ...invite, inviteeRole: "SUBJECT", invitee: `account:${ID}` }),
      ),
    ).toEqual(["inviteeRole:validation.subjectNeedsPerson"]);
    expect(
      inviteToMeetingSchema.safeParse({
        ...invite,
        inviteeRole: "LEGAL",
        requiresCoi: false,
        invitee: `account:${ID}`,
      }).success,
    ).toBe(true);
    expect(
      messages(inviteToMeetingSchema.safeParse({ ...invite, invitee: `account:${ID}`, reason: "Why" })),
    ).toEqual(["reason:validation.tooShort"]);
  });
});
