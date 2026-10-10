import { describe, expect, it } from "vitest";
import type { Actor, InterviewDetail } from "@cdf/contracts";
import type { SecurityEvent } from "@cdf/audit";
import { createInterviewService, type InterviewGateway } from "./interviews";

const CASE = "11111111-1111-4111-8111-111111111111";
const INTERVIEW = "33333333-3333-4333-8333-333333333333";
const ctx = {
  userId: "a0000000-0000-4000-8000-000000000006",
  requestId: "22222222-2222-4222-8222-222222222222",
};
const lead: Actor = {
  userId: ctx.userId,
  email: "lead@example.test",
  displayName: "Lead Investigator Delta",
  displayNameAr: "المحقق الأول دلتا",
  roles: ["LEAD_INVESTIGATOR"],
  permissions: [
    "CASE_ASSIGN",
    "WORKFLOW_ADVANCE",
    "CONFLICT_DECLARE",
    "EVIDENCE_UPLOAD",
    "EVIDENCE_DOWNLOAD",
  ],
  clearance: "CONFIDENTIAL",
};

function detail(over: Partial<InterviewDetail> = {}): InterviewDetail {
  return {
    id: INTERVIEW,
    caseId: CASE,
    sequenceNo: 1,
    title: "Witness interview",
    intervieweeLabel: "Witness Gamma",
    intervieweeKind: "WITNESS",
    classification: "CONFIDENTIAL",
    status: "PREPARED",
    scheduledStart: "2026-10-07T08:00:00.000Z",
    mode: "IN_PERSON",
    createdBy: "a0000000-0000-4000-8000-000000000004",
    createdByName: "Investigator Alpha",
    updatedAt: "2026-10-07T09:00:00.000Z",
    purpose: null,
    casePersonId: null,
    location: null,
    durationMinutes: 60,
    rightsAckMethod: "SIGNED_FORM",
    rightsNoticeVersion: "SYNTHETIC-RIGHTS-V1",
    rightsAcknowledgedAt: "2026-10-07T08:00:00.000Z",
    conductedStartedAt: "2026-10-07T08:00:00.000Z",
    conductedEndedAt: "2026-10-07T09:00:00.000Z",
    currentStatementVersionId: "v1",
    formInstanceId: null,
    preparedBy: "a0000000-0000-4000-8000-000000000004",
    preparedAt: "2026-10-07T09:10:00.000Z",
    reviewedBy: null,
    reviewedAt: null,
    approvedBy: null,
    approvedAt: null,
    cancelledAt: null,
    rowVersion: 7,
    participants: [],
    notices: [],
    statements: [],
    recordings: [],
    ...over,
  };
}

function harness(failWith?: string) {
  const calls: string[] = [];
  const events: SecurityEvent[] = [];
  const fail = async (): Promise<never> => {
    throw new Error(failWith);
  };
  const gateway: InterviewGateway = {
    listInterviews: async () => [],
    getInterview: async () => null,
    planInterview: async (_c, i) => (failWith ? fail() : (calls.push(`plan:${i.intervieweeKind}`), "new-id")),
    addParticipant: async () => "p",
    schedule: async (_c, i) => void calls.push(`schedule:${i.scheduledStart}`),
    issueNotice: async () => "n",
    recordRights: async () => undefined,
    recordConducted: async () => undefined,
    recordStatement: async (_c, i) => (
      calls.push(`statement:${i.content}`),
      { versionId: "v", versionNo: 1, sha256: "x" }
    ),
    acknowledgeStatement: async () => "a",
    linkRecording: async () => "r",
    transition: async (_c, i) => (failWith ? fail() : (calls.push(`transition:${i.action}`), "REVIEWED")),
  };
  const service = createInterviewService({
    gateway,
    securityEvents: { record: async (e) => void events.push(e) },
  });
  return { service, calls, events };
}

describe("interview service", () => {
  it("validates before touching the gateway", async () => {
    const { service, calls } = harness();
    const r = await service.plan(ctx, { caseId: CASE, title: "x", intervieweeKind: "WITNESS" });
    expect(r.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("refuses a reporter name before the database sees it", async () => {
    const { service, calls } = harness();
    const r = await service.plan(ctx, {
      caseId: CASE,
      title: "Reporter interview",
      intervieweeKind: "REPORTER",
      intervieweeLabel: "Reporter Gamma",
      classification: "RESTRICTED",
    });
    expect(r.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("passes canonical, validated input to the gateway", async () => {
    const { service, calls } = harness();
    const r = await service.recordStatement(ctx, {
      interviewId: INTERVIEW,
      content: "First line\r\nsecond line",
      language: "en",
    });
    expect(r.ok).toBe(true);
    expect(calls).toEqual(["statement:First line\nsecond line"]);
  });

  it("maps database refusals to safe errors and records denials as security events", async () => {
    const { service, events } = harness("CDF_FORBIDDEN");
    const r = await service.plan(ctx, {
      caseId: CASE,
      title: "Witness interview",
      intervieweeKind: "WITNESS",
      intervieweeLabel: "Witness Gamma",
      classification: "CONFIDENTIAL",
    });
    expect(r.ok === false && "error" in r && r.error.kind).toBe("FORBIDDEN");
    expect(events).toEqual([
      {
        action: "COMMAND_DENIED",
        objectType: "interview",
        objectId: CASE,
        metadata: { command: "plan_interview", outcome: "FORBIDDEN" },
      },
    ]);
  });

  it("keeps conflict codes but never database text", async () => {
    const { service, events } = harness("CDF_CONFLICT:SEPARATION_OF_DUTIES");
    const r = await service.transition(ctx, lead, { interviewId: INTERVIEW, action: "REVIEW" });
    expect(r.ok === false && "error" in r && [r.error.kind, r.error.detail]).toEqual([
      "CONFLICT",
      "SEPARATION_OF_DUTIES",
    ]);
    expect(events).toEqual([]);
    const { service: broken } = harness('relation "case_mgmt.interview" does not exist');
    const u = await broken.transition(ctx, lead, { interviewId: INTERVIEW, action: "REVIEW" });
    expect(u.ok === false && "error" in u && [u.error.kind, u.error.detail]).toEqual([
      "UNAVAILABLE",
      undefined,
    ]);
  });

  it("refuses a self-review early when the detail is known", async () => {
    const { service, calls } = harness();
    const preparedByLead = detail({ preparedBy: lead.userId });
    const r = await service.transition(
      ctx,
      lead,
      { interviewId: INTERVIEW, action: "REVIEW" },
      preparedByLead,
    );
    expect(r.ok === false && "error" in r && r.error.detail).toBe("SEPARATION_OF_DUTIES");
    expect(calls).toEqual([]);
    const ok = await service.transition(ctx, lead, { interviewId: INTERVIEW, action: "REVIEW" }, detail());
    expect(ok).toEqual({ ok: true, value: "REVIEWED" });
    expect(calls).toEqual(["transition:REVIEW"]);
  });
});
