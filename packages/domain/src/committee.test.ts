import { describe, expect, it } from "vitest";
import { COMMITTEE_SEATS } from "@cdf/contracts";
import {
  SINGLE_HOLDER_SEATS,
  addBusinessDays,
  isBusinessDay,
  isEffectiveAt,
  isQuorate,
  isVotingSeat,
  periodsOverlap,
  proceedingDisplayNumber,
  quorumThreshold,
  tallyVotes,
  voteOutcome,
} from "./committee";

describe("committee seats", () => {
  it("only chair, deputy chair and members vote", () => {
    expect(COMMITTEE_SEATS.filter(isVotingSeat)).toEqual(["CHAIR", "DEPUTY_CHAIR", "MEMBER"]);
  });

  it("members and alternate members may be several; the other seats have one holder", () => {
    expect(COMMITTEE_SEATS.filter((s) => !SINGLE_HOLDER_SEATS.includes(s))).toEqual([
      "MEMBER",
      "ALTERNATE_MEMBER",
    ]);
  });
});

describe("effective periods", () => {
  const p = { effectiveFrom: "2026-01-01T00:00:00Z", effectiveTo: "2026-07-01T00:00:00Z" };

  it("are half-open", () => {
    expect(isEffectiveAt(p, "2026-01-01T00:00:00Z")).toBe(true);
    expect(isEffectiveAt(p, "2026-07-01T00:00:00Z")).toBe(false);
    expect(isEffectiveAt({ ...p, effectiveTo: null }, "2030-01-01T00:00:00Z")).toBe(true);
  });

  it("touching periods do not overlap; open-ended ones do", () => {
    expect(periodsOverlap(p, { effectiveFrom: "2026-07-01T00:00:00Z", effectiveTo: null })).toBe(false);
    expect(periodsOverlap(p, { effectiveFrom: "2026-06-30T00:00:00Z", effectiveTo: null })).toBe(true);
    expect(
      periodsOverlap(
        { ...p, effectiveTo: null },
        { effectiveFrom: "2027-01-01T00:00:00Z", effectiveTo: null },
      ),
    ).toBe(true);
  });
});

describe("quorum (Q51–Q54)", () => {
  it("defaults to more than half of the eligible members", () => {
    const rule = { quorumType: "MAJORITY_ELIGIBLE" as const, quorumValue: null };
    expect([1, 2, 3, 4, 5].map((n) => quorumThreshold(rule, n))).toEqual([1, 2, 2, 3, 3]);
    expect(isQuorate(rule, 4, 2)).toBe(false);
    expect(isQuorate(rule, 4, 3)).toBe(true);
    expect(isQuorate(rule, 0, 0)).toBe(false);
  });

  it("supports fixed numbers, percentages and custom rules", () => {
    expect(quorumThreshold({ quorumType: "FIXED_NUMBER", quorumValue: 3 }, 7)).toBe(3);
    expect(quorumThreshold({ quorumType: "PERCENTAGE", quorumValue: 60 }, 7)).toBe(5);
    expect(isQuorate({ quorumType: "CUSTOM", quorumValue: null }, 5, 5)).toBeNull();
  });
});

describe("display numbers", () => {
  it("pads proceeding numbers", () => {
    expect(proceedingDisplayNumber(7)).toBe("PRC-007");
  });
});

describe("business days (Q98)", () => {
  it("are Sunday to Thursday in Riyadh", () => {
    expect(isBusinessDay(new Date("2026-10-11T09:00:00+03:00"))).toBe(true); // Sunday
    expect(isBusinessDay(new Date("2026-10-15T23:30:00+03:00"))).toBe(true); // Thursday night
    expect(isBusinessDay(new Date("2026-10-16T00:30:00+03:00"))).toBe(false); // Friday, though Thursday in UTC
    expect(isBusinessDay(new Date("2026-10-17T12:00:00+03:00"))).toBe(false); // Saturday
  });

  it("three business days from Wednesday skip the weekend", () => {
    expect(addBusinessDays(new Date("2026-10-14T10:00:00+03:00"), 3).toISOString()).toBe(
      new Date("2026-10-19T10:00:00+03:00").toISOString(), // Thu, Sun, Mon
    );
  });
});

describe("vote tally and outcome (Q55–Q63)", () => {
  it("counts only present, cleared voters; absence and inability are counted apart", () => {
    expect(
      tallyVotes([
        { choice: "APPROVE", counted: true },
        { choice: "APPROVE", counted: false },
        { choice: "REJECT", counted: true },
        { choice: "ABSTAIN", counted: true },
        { choice: "ABSENT", counted: false },
        { choice: "UNABLE_TO_VOTE", counted: true },
      ]),
    ).toEqual({ approve: 1, reject: 1, abstain: 1, recused: 0, absent: 1, unable: 1, excluded: 1 });
  });

  it("decides by majority, sends a tie to the casting vote only when available", () => {
    expect(voteOutcome({ approve: 3, reject: 1 }, false, true)).toBe("NO_QUORUM");
    expect(voteOutcome({ approve: 3, reject: 1 }, true, true)).toBe("APPROVED");
    expect(voteOutcome({ approve: 1, reject: 2 }, true, true)).toBe("REJECTED");
    expect(voteOutcome({ approve: 2, reject: 2 }, true, true)).toBe("AWAITING_CASTING_VOTE");
    expect(voteOutcome({ approve: 2, reject: 2 }, true, false)).toBe("TIED");
  });
});
