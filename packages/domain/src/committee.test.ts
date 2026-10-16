import { describe, expect, it } from "vitest";
import { COMMITTEE_SEATS } from "@cdf/contracts";
import {
  SINGLE_HOLDER_SEATS,
  addBusinessDays,
  currentFindings,
  governingFinding,
  grievanceOutcomesValid,
  isBusinessDay,
  isCaseWide,
  isEffectiveAt,
  isLateGrievance,
  isQuorate,
  isVotingSeat,
  legalReviewRequired,
  periodsOverlap,
  proceedingDisplayNumber,
  proceedingShortRef,
  quorumThreshold,
  subjectPath,
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
  it("shortens a committee proceeding to its committee and the start of its id, never a count", () => {
    expect(proceedingShortRef("IC", "3f9a2c1b-0d4e-4b7a-9c11-2e5f6a7b8c9d")).toBe("IC-3F9A2C1B");
    expect(proceedingShortRef("GC", "00000000-0000-4000-8000-000000000001")).toBe("GC-00000000");
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

  it("a configured holiday is skipped and a working-day exception counts (DEC-F02)", () => {
    const calendar = { nonWorkingDates: ["2026-10-18"], workingDates: ["2026-10-17"] };
    // Thu, Sat (working by exception), Mon (Sunday is a holiday).
    expect(addBusinessDays(new Date("2026-10-14T10:00:00+03:00"), 3, calendar).toISOString()).toBe(
      new Date("2026-10-19T10:00:00+03:00").toISOString(),
    );
    expect(isBusinessDay(new Date("2026-10-18T12:00:00+03:00"), calendar)).toBe(false);
    expect(isBusinessDay(new Date("2026-10-17T12:00:00+03:00"), calendar)).toBe(true);
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
    // Everyone abstained or recused: the chair never decides alone (AGENT-09 V5).
    expect(voteOutcome({ approve: 0, reject: 0 }, true, true)).toBe("NO_DECISION");
    expect(voteOutcome({ approve: 0, reject: 0 }, true, true, "TIED")).toBe("TIED");
  });
});

describe("recommendations (ADR-021, ADR-022)", () => {
  it("needs legal review for sanctions, legal action and external referral only", () => {
    expect(legalReviewRequired(["CORRECTIVE_ACTION", "GOVERNANCE_REMEDIATION"])).toBe(false);
    expect(legalReviewRequired(["CORRECTIVE_ACTION", "DISCIPLINARY_SANCTION"])).toBe(true);
    expect(legalReviewRequired(["EXTERNAL_REFERRAL"])).toBe(true);
    expect(legalReviewRequired([])).toBe(false);
  });

  it("an item without subjects or allegations is case-wide", () => {
    expect(isCaseWide(0, 0)).toBe(true);
    expect(isCaseWide(1, 0)).toBe(false);
    expect(isCaseWide(0, 2)).toBe(false);
  });
});

describe("grievances (ADR-024)", () => {
  it("flags a grievance filed after the window as late", () => {
    expect(isLateGrievance("2026-09-01T09:00:00Z", "2026-10-01T09:00:00Z", 30)).toBe(false);
    expect(isLateGrievance("2026-09-01T09:00:00Z", "2026-10-01T09:00:01Z", 30)).toBe(true);
  });

  it("combines outcomes unless they contradict", () => {
    expect(grievanceOutcomesValid(["MODIFY", "RETURN_FOR_REINVESTIGATION"])).toBe(true);
    expect(grievanceOutcomesValid(["UPHOLD", "CORRECTIVE_ACTION"])).toBe(true);
    expect(grievanceOutcomesValid(["UPHOLD", "CANCEL"])).toBe(false);
    expect(grievanceOutcomesValid(["MODIFY", "CANCEL"])).toBe(false);
    expect(grievanceOutcomesValid(["INADMISSIBLE"])).toBe(false);
    expect(grievanceOutcomesValid(["UPHOLD", "UPHOLD"])).toBe(false);
    expect(grievanceOutcomesValid([])).toBe(false);
  });
});

describe("findings (AMB-029)", () => {
  const P1 = { id: "p1", sequenceNo: 1, proceedingType: "INVESTIGATION" as const };
  const P2 = { id: "p2", sequenceNo: 2, proceedingType: "COMMITTEE_INVESTIGATION" as const };
  const P3 = { id: "p3", sequenceNo: 3, proceedingType: "COMMITTEE_INVESTIGATION" as const };
  const f = (id: string, proceedingId: string, versionNo: number, subjectId: string | null = "s1") => ({
    id,
    allegationId: "a1",
    subjectId,
    proceedingId,
    versionNo,
  });

  it("the current version of each line is the highest; earlier versions stay out of the current set", () => {
    const current = currentFindings([
      f("v1", "p1", 1),
      f("v2", "p1", 2),
      f("w1", "p2", 1),
      f("x1", "p1", 1, null),
    ]);
    expect(current.map((x) => x.id).sort()).toEqual(["v2", "w1", "x1"]);
  });

  it("the committee proceeding's finding governs; the investigation's stays on record only", () => {
    const current = currentFindings([f("v2", "p1", 2), f("w1", "p2", 1)]);
    expect(governingFinding(current, [P1, P2], "a1", "s1")?.id).toBe("w1");
  });

  it("with no committee finding yet, nothing governs", () => {
    expect(governingFinding(currentFindings([f("v1", "p1", 1)]), [P1, P2], "a1", "s1")).toBeNull();
  });

  it("a later committee proceeding governs over an earlier one, per subject", () => {
    const current = currentFindings([f("w1", "p2", 1), f("z1", "p3", 1), f("y1", "p3", 1, "s2")]);
    expect(governingFinding(current, [P1, P2, P3], "a1", "s1")?.id).toBe("z1");
    expect(governingFinding(current, [P1, P2, P3], "a1", "s2")?.id).toBe("y1");
    expect(governingFinding(current, [P1, P2, P3], "a1", null)).toBeNull();
  });
});

describe("one path per person (AMB-105)", () => {
  const P1 = { id: "p1", sequenceNo: 1, proceedingType: "INVESTIGATION" as const };
  const P2 = { id: "p2", sequenceNo: 2, proceedingType: "COMMITTEE_INVESTIGATION" as const };
  const a = (id: string, subjectId: string | null, status = "OPEN") => ({ id, subjectId, status });
  const f = (allegationId: string, subjectId: string | null, proceedingId: string) => ({
    allegationId,
    subjectId,
    proceedingId,
    versionNo: 1,
  });

  it("counts the person's allegations, those with a finding and those with a committee finding", () => {
    const allegations = [a("a1", "s1"), a("a2", "s1"), a("a3", "s2")];
    const current = [f("a1", "s1", "p1"), f("a1", "s1", "p2"), f("a2", "s1", "p1"), f("a3", "s2", "p2")];
    expect(subjectPath(allegations, current, [P1, P2], "s1")).toEqual({
      allegations: 2,
      found: 2,
      committee: 1,
    });
    expect(subjectPath(allegations, current, [P1, P2], "s2")).toEqual({
      allegations: 1,
      found: 1,
      committee: 1,
    });
  });

  it("a finding for the person on an allegation tied to someone else puts that allegation on their path", () => {
    const allegations = [a("a1", "s1")];
    expect(subjectPath(allegations, [f("a1", "s2", "p1")], [P1, P2], "s2")).toEqual({
      allegations: 1,
      found: 1,
      committee: 0,
    });
  });

  it("withdrawn allegations and findings for the allegation as a whole are not on anyone's path", () => {
    const allegations = [a("a1", "s1", "WITHDRAWN"), a("a2", null)];
    const current = [f("a1", "s1", "p2"), f("a2", null, "p2")];
    expect(subjectPath(allegations, current, [P1, P2], "s1")).toEqual({
      allegations: 0,
      found: 0,
      committee: 0,
    });
  });
});
