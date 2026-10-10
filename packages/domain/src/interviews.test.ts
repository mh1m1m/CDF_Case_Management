import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { INTERVIEW_ACTIONS, INTERVIEW_STATUSES } from "@cdf/contracts";
import {
  INTERVIEW_TRANSITIONS,
  conductBlockers,
  interviewActionsFrom,
  interviewDisplayNumber,
  interviewStepsOpen,
  intervieweeLabelAllowed,
  nextInterviewStatus,
  normaliseStatement,
  statementSha256,
  transitionBlockers,
  type InterviewFacts,
} from "./interviews";

const facts = (over: Partial<InterviewFacts> = {}): InterviewFacts => ({
  status: "CONDUCTED",
  preparedBy: null,
  reviewedBy: null,
  rightsAcknowledgedAt: "2026-10-07T09:00:00Z",
  currentStatementVersionId: "v2",
  notices: [{ noticeType: "INVITATION" }],
  statements: [
    { id: "v1", acknowledgement: null },
    { id: "v2", acknowledgement: { method: "SIGNED_PAPER" } },
  ],
  ...over,
});

describe("interview lifecycle", () => {
  it("follows prepared → reviewed → approved", () => {
    expect(nextInterviewStatus("CONDUCTED", "PREPARE")).toBe("PREPARED");
    expect(nextInterviewStatus("PREPARED", "REVIEW")).toBe("REVIEWED");
    expect(nextInterviewStatus("REVIEWED", "APPROVE")).toBe("APPROVED");
  });

  it("returns prepared or reviewed work to CONDUCTED and cancels only before the interview happens", () => {
    expect(nextInterviewStatus("PREPARED", "RETURN")).toBe("CONDUCTED");
    expect(nextInterviewStatus("REVIEWED", "RETURN")).toBe("CONDUCTED");
    expect(nextInterviewStatus("PLANNED", "CANCEL")).toBe("CANCELLED");
    expect(nextInterviewStatus("SCHEDULED", "CANCEL")).toBe("CANCELLED");
    expect(nextInterviewStatus("CONDUCTED", "CANCEL")).toBeNull();
  });

  it("never skips a step or leaves a terminal status", () => {
    expect(nextInterviewStatus("CONDUCTED", "APPROVE")).toBeNull();
    expect(nextInterviewStatus("PREPARED", "APPROVE")).toBeNull();
    for (const action of INTERVIEW_ACTIONS) {
      expect(nextInterviewStatus("APPROVED", action)).toBeNull();
      expect(nextInterviewStatus("CANCELLED", action)).toBeNull();
    }
    expect(interviewActionsFrom("APPROVED")).toEqual([]);
  });

  it("covers every status and requires a reason only to return or cancel", () => {
    const reached = new Set(Object.values(INTERVIEW_TRANSITIONS).flatMap((t) => [...t.from, t.to]));
    for (const s of INTERVIEW_STATUSES) expect(reached.has(s), s).toBe(true);
    expect(
      (Object.keys(INTERVIEW_TRANSITIONS) as (keyof typeof INTERVIEW_TRANSITIONS)[])
        .filter((a) => INTERVIEW_TRANSITIONS[a].reasonRequired)
        .sort(),
    ).toEqual(["CANCEL", "RETURN"]);
  });

  it("opens recording steps only in the matching status", () => {
    expect(interviewStepsOpen("PLANNED")).toMatchObject({ schedule: true, notice: false, statement: false });
    expect(interviewStepsOpen("SCHEDULED")).toMatchObject({ notice: true, rights: true, conduct: true });
    expect(interviewStepsOpen("CONDUCTED")).toMatchObject({
      statement: true,
      linkRecording: true,
      schedule: false,
    });
    expect(Object.values(interviewStepsOpen("APPROVED")).some(Boolean)).toBe(false);
  });
});

describe("interview blockers", () => {
  it("conducting needs an invitation and acknowledged rights", () => {
    expect(conductBlockers(facts({ status: "SCHEDULED" }))).toEqual([]);
    expect(conductBlockers(facts({ status: "SCHEDULED", notices: [], rightsAcknowledgedAt: null }))).toEqual([
      "NOTICE_NOT_ISSUED",
      "RIGHTS_NOT_ACKNOWLEDGED",
    ]);
  });

  it("preparing needs an acknowledged current statement version", () => {
    expect(transitionBlockers(facts(), "PREPARE", "u1")).toEqual([]);
    expect(transitionBlockers(facts({ currentStatementVersionId: null }), "PREPARE", "u1")).toEqual([
      "STATEMENT_MISSING",
    ]);
    // An acknowledgement of an older version does not cover the current one.
    expect(transitionBlockers(facts({ currentStatementVersionId: "v1" }), "PREPARE", "u1")).toEqual([
      "STATEMENT_NOT_ACKNOWLEDGED",
    ]);
  });

  it("separates preparer, reviewer and approver", () => {
    const prepared = facts({ status: "PREPARED", preparedBy: "u1" });
    expect(transitionBlockers(prepared, "REVIEW", "u1")).toEqual(["SEPARATION_OF_DUTIES"]);
    expect(transitionBlockers(prepared, "RETURN", "u1")).toEqual(["SEPARATION_OF_DUTIES"]);
    expect(transitionBlockers(prepared, "REVIEW", "u2")).toEqual([]);
    const reviewed = facts({ status: "REVIEWED", preparedBy: "u1", reviewedBy: "u2" });
    expect(transitionBlockers(reviewed, "APPROVE", "u1")).toEqual(["SEPARATION_OF_DUTIES"]);
    expect(transitionBlockers(reviewed, "APPROVE", "u2")).toEqual(["SEPARATION_OF_DUTIES"]);
    expect(transitionBlockers(reviewed, "APPROVE", "u3")).toEqual([]);
  });
});

describe("interview identity and display rules", () => {
  it("never allows a label for the reporter and always requires one otherwise", () => {
    expect(intervieweeLabelAllowed("REPORTER", null)).toBe(true);
    expect(intervieweeLabelAllowed("REPORTER", "Reporter Gamma")).toBe(false);
    expect(intervieweeLabelAllowed("WITNESS", "Witness Gamma")).toBe(true);
    expect(intervieweeLabelAllowed("SUBJECT", "  ")).toBe(false);
  });

  it("formats display numbers", () => {
    expect(interviewDisplayNumber(1)).toBe("INT-001");
    expect(interviewDisplayNumber(42)).toBe("INT-042");
  });
});

describe("statement hashing", () => {
  it("normalises to NFC and LF so the same words hash the same", () => {
    const decomposed = "é";
    expect(normaliseStatement(decomposed)).toBe("é");
    expect(normaliseStatement("a\r\nb\rc")).toBe("a\nb\nc");
  });

  it("is SHA-256 over UTF-8, Arabic included", async () => {
    for (const text of ["SYNTHETIC statement", "إفادة تجريبية للشاهد جاما", ""]) {
      expect(await statementSha256(text)).toBe(createHash("sha256").update(text, "utf8").digest("hex"));
    }
  });
});
