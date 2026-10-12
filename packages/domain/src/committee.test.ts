import { describe, expect, it } from "vitest";
import { COMMITTEE_SEATS } from "@cdf/contracts";
import {
  SINGLE_HOLDER_SEATS,
  isEffectiveAt,
  isQuorate,
  isVotingSeat,
  periodsOverlap,
  proceedingDisplayNumber,
  quorumThreshold,
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
