import { describe, expect, it } from "vitest";
import {
  acknowledgeInterviewStatementSchema,
  planInterviewSchema,
  recordInterviewConductedSchema,
  recordInterviewRightsSchema,
  recordInterviewStatementSchema,
  scheduleInterviewSchema,
  transitionInterviewSchema,
} from "./interviews";

const ID = "8f8c2a52-4f0e-4b5a-9a43-0f7f2c1d9e10";
const messages = (r: { success: boolean; error?: { issues: { message: string; path: PropertyKey[] }[] } }) =>
  (r.error?.issues ?? []).map((i) => `${i.path.join(".")}:${i.message}`);

describe("planInterviewSchema", () => {
  const base = { caseId: ID, title: "Witness interview", classification: "CONFIDENTIAL" };

  it("requires a working label for witnesses and subjects", () => {
    expect(planInterviewSchema.safeParse({ ...base, intervieweeKind: "WITNESS" }).success).toBe(false);
    expect(
      planInterviewSchema.safeParse({
        ...base,
        intervieweeKind: "WITNESS",
        intervieweeLabel: "Witness Gamma",
      }).success,
    ).toBe(true);
  });

  it("refuses any name for the reporter instead of silently dropping it", () => {
    const r = planInterviewSchema.safeParse({
      ...base,
      intervieweeKind: "REPORTER",
      intervieweeLabel: "Reporter Gamma",
    });
    expect(messages(r)).toContain("intervieweeLabel:interviews.validation.reporterNotNamed");
    expect(planInterviewSchema.safeParse({ ...base, intervieweeKind: "REPORTER" }).success).toBe(true);
    expect(
      planInterviewSchema.safeParse({ ...base, intervieweeKind: "REPORTER", casePersonId: ID }).success,
    ).toBe(false);
  });
});

describe("scheduling and conduct times", () => {
  it("reads datetime-local values as Riyadh time", () => {
    const r = scheduleInterviewSchema.safeParse({
      interviewId: ID,
      scheduledStart: "2026-10-08T10:30",
      durationMinutes: "60",
      mode: "IN_PERSON",
    });
    expect(r.success && r.data.scheduledStart).toBe("2026-10-08T07:30:00.000Z");
  });

  it("bounds the duration and rejects nonsense dates", () => {
    const base = { interviewId: ID, scheduledStart: "2026-10-08T10:30", mode: "PHONE" };
    expect(scheduleInterviewSchema.safeParse({ ...base, durationMinutes: "5" }).success).toBe(false);
    expect(scheduleInterviewSchema.safeParse({ ...base, durationMinutes: "500" }).success).toBe(false);
    expect(
      scheduleInterviewSchema.safeParse({ ...base, durationMinutes: "30", scheduledStart: "tomorrow" })
        .success,
    ).toBe(false);
  });

  it("requires the end after the start", () => {
    const r = recordInterviewConductedSchema.safeParse({
      interviewId: ID,
      startedAt: "2026-10-07T10:00",
      endedAt: "2026-10-07T09:00",
    });
    expect(messages(r)).toContain("endedAt:interviews.validation.endBeforeStart");
  });
});

describe("statements and acknowledgements", () => {
  it("canonicalises statement text to NFC and LF", () => {
    const r = recordInterviewStatementSchema.safeParse({
      interviewId: ID,
      content: "Line one\r\nCafé",
      language: "en",
    });
    expect(r.success && r.data.content).toBe("Line one\nCafé");
  });

  it("rejects empty statements", () => {
    expect(
      recordInterviewStatementSchema.safeParse({ interviewId: ID, content: "   ", language: "ar" }).success,
    ).toBe(false);
  });

  it("accepts only a full SHA-256 as the attested hash", () => {
    const ok = acknowledgeInterviewStatementSchema.safeParse({
      versionId: ID,
      method: "SIGNED_PAPER",
      attestedSha256: "A".repeat(64),
    });
    expect(ok.success && ok.data.attestedSha256).toBe("a".repeat(64));
    expect(
      acknowledgeInterviewStatementSchema.safeParse({
        versionId: ID,
        method: "SIGNED_PAPER",
        attestedSha256: "abc",
      }).success,
    ).toBe(false);
  });

  it("normalises the rights notice version", () => {
    const r = recordInterviewRightsSchema.safeParse({
      interviewId: ID,
      method: "SIGNED_FORM",
      noticeVersion: "synthetic-rights-v1",
    });
    expect(r.success && r.data.noticeVersion).toBe("SYNTHETIC-RIGHTS-V1");
  });
});

describe("transitionInterviewSchema", () => {
  it("requires a reason to return or cancel", () => {
    expect(transitionInterviewSchema.safeParse({ interviewId: ID, action: "RETURN" }).success).toBe(false);
    expect(
      transitionInterviewSchema.safeParse({
        interviewId: ID,
        action: "CANCEL",
        reason: "Synthetic: witness unavailable",
      }).success,
    ).toBe(true);
    expect(transitionInterviewSchema.safeParse({ interviewId: ID, action: "APPROVE" }).success).toBe(true);
  });
});
