// The meetings service (Phase 12 P12-2a; ADR-054): validation before the gateway, database refusals mapped to safe
// errors and recorded as COMMAND_DENIED with the command and outcome only, and a refused read turned into the uniform
// not-found with an ACCESS_DENIED event. Who may act, and when, is the database's: tests/security/
// meeting-screen-capabilities.spec.ts and committee-meetings.spec.ts; the whole path is tests/integration/meetings.spec.ts.
import { describe, expect, it } from "vitest";
import type { SecurityEvent } from "@cdf/audit";
import { createMeetingsService, type MeetingsGateway } from "./meetings";

const MEETING = "33333333-3333-4333-8333-333333333333";
const ITEM = "44444444-4444-4444-8444-444444444444";
const PARTICIPANT = "55555555-5555-4555-8555-555555555555";
const ctx = {
  userId: "a0000000-0000-4000-8000-000000000003",
  requestId: "22222222-2222-4222-8222-222222222222",
};

function harness(refusal?: string) {
  const calls: unknown[][] = [];
  const events: SecurityEvent[] = [];
  const answer =
    (name: string, value: unknown = undefined) =>
    async (_: unknown, input: unknown) => {
      calls.push([name, input]);
      if (refusal) throw new Error(refusal);
      return value;
    };
  const gateway = {
    meetingView: answer("meetingView", { view: "CONCERNS_ONLY", meetingId: MEETING }),
    minutesView: answer("minutesView", { minutesId: MEETING }),
    voteItemStatus: answer("voteItemStatus", { voteItemId: ITEM, voters: [] }),
    openMeeting: answer("openMeeting"),
    closeMeeting: answer("closeMeeting"),
    cancelMeeting: answer("cancelMeeting"),
    recordAttendance: answer("recordAttendance"),
    recordExcusedAbsence: answer("recordExcusedAbsence", PARTICIPANT),
    declareConflict: answer("declareConflict"),
    acknowledgeConfidentiality: answer("acknowledgeConfidentiality", PARTICIPANT),
    raiseConcern: answer("raiseConcern", PARTICIPANT),
    decideConcern: answer("decideConcern"),
    reverseConcern: answer("reverseConcern", PARTICIPANT),
    openVoteItem: answer("openVoteItem", ITEM),
    castVote: answer("castVote"),
    reviseVote: answer("reviseVote"),
    recuseForConflict: answer("recuseForConflict"),
    recordVoteNote: answer("recordVoteNote", ITEM),
    recordVoteForMember: answer("recordVoteForMember"),
    closeVoteItem: answer("closeVoteItem", "APPROVED"),
    castCastingVote: answer("castCastingVote", "REJECTED"),
    generateMinutes: answer("generateMinutes", ITEM),
    reviewMinutes: answer("reviewMinutes", "IN_REVIEW"),
    recordMinutesReminder: answer("recordMinutesReminder"),
    applyMinutesDeemedApproval: answer("applyMinutesDeemedApproval", "DEEMED_APPROVED"),
    overruleMinutesObjection: answer("overruleMinutesObjection"),
  } as unknown as MeetingsGateway;
  const service = createMeetingsService({
    gateway,
    securityEvents: { record: async (e) => void events.push(e) },
  });
  return { service, calls, events };
}

describe("meetings service", () => {
  it("validates before the gateway: a malformed command never reaches the database", async () => {
    const { service, calls } = harness();
    const r = await service.openVoteItem(ctx, {
      meetingId: MEETING,
      targetType: "FINDING",
      title: "Synthetic",
    });
    expect(r.ok === false && "fieldErrors" in r).toBe(true);
    const d = await service.declareConflict(ctx, { participantId: PARTICIPANT, status: "CONFLICT_DECLARED" });
    expect(d.ok === false && "fieldErrors" in d).toBe(true);
    expect(calls).toEqual([]);
  });

  it("passes the parsed command to the gateway and returns its answer", async () => {
    const { service, calls, events } = harness();
    const r = await service.closeVoteItem(ctx, { voteItemId: ITEM, customQuorumAttested: false });
    expect(r).toEqual({ ok: true, value: "APPROVED" });
    const v = await service.recordVoteForMember(ctx, {
      voteItemId: ITEM,
      participantId: PARTICIPANT,
      choice: "ABSENT",
      reason: "Synthetic: travelling.",
      originalEventAt: "",
    });
    expect(v.ok).toBe(true);
    expect(calls).toEqual([
      ["closeVoteItem", { voteItemId: ITEM, customQuorumAttested: false }],
      [
        "recordVoteForMember",
        {
          voteItemId: ITEM,
          participantId: PARTICIPANT,
          choice: "ABSENT",
          reason: "Synthetic: travelling.",
          originalEventAt: undefined,
        },
      ],
    ]);
    expect(events).toEqual([]);
  });

  it("a refusal is recorded as COMMAND_DENIED with the command and outcome only, never the reason", async () => {
    const { service, events } = harness("CDF_FORBIDDEN");
    const reason = "Synthetic: a reason that must stay in the committee.";
    const r = await service.raiseConcern(ctx, { participantId: PARTICIPANT, reason });
    expect(r.ok === false && "error" in r && r.error.kind).toBe("FORBIDDEN");
    expect(events).toEqual([
      {
        action: "COMMAND_DENIED",
        objectType: "command",
        objectId: PARTICIPANT,
        metadata: { command: "raise_meeting_conflict", outcome: "FORBIDDEN" },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain(reason);
  });

  it("names each command as the database does", async () => {
    const cases: [string, (s: ReturnType<typeof harness>["service"]) => Promise<unknown>][] = [
      ["open_meeting", (s) => s.openMeeting(ctx, { meetingId: MEETING, reason: "Synthetic reason." })],
      ["cancel_meeting", (s) => s.cancelMeeting(ctx, { meetingId: MEETING, reason: "Synthetic reason." })],
      [
        "record_attendance",
        (s) => s.recordAttendance(ctx, { participantId: PARTICIPANT, attendance: "PRESENT" }),
      ],
      ["cast_vote", (s) => s.castVote(ctx, { voteItemId: ITEM, choice: "APPROVE" })],
      ["revise_vote", (s) => s.reviseVote(ctx, { voteItemId: ITEM, choice: "REJECT" })],
      [
        "recuse_for_conflict",
        (s) => s.recuseForConflict(ctx, { voteItemId: ITEM, reason: "Synthetic reason." }),
      ],
      [
        "record_vote_note",
        (s) =>
          s.recordVoteNote(ctx, { voteItemId: ITEM, note: "Synthetic note text.", annexToMinutes: true }),
      ],
      ["cast_casting_vote", (s) => s.castCastingVote(ctx, { voteItemId: ITEM, choice: "APPROVE" })],
      [
        "generate_minutes",
        (s) => s.generateMinutes(ctx, { meetingId: MEETING, narrative: "Synthetic minutes text." }),
      ],
      ["review_minutes", (s) => s.reviewMinutes(ctx, { minutesId: MEETING, decision: "APPROVE" })],
      ["record_minutes_reminder", (s) => s.recordMinutesReminder(ctx, { minutesId: MEETING })],
      ["apply_minutes_deemed_approval", (s) => s.applyMinutesDeemedApproval(ctx, { minutesId: MEETING })],
      [
        "overrule_minutes_objection",
        (s) => s.overruleMinutesObjection(ctx, { minutesId: MEETING, reason: "Synthetic overrule reason." }),
      ],
    ];
    for (const [command, run] of cases) {
      const { service, events } = harness("CDF_NOT_FOUND");
      await run(service);
      expect(
        events.map((e) => e.metadata),
        command,
      ).toEqual([{ command, outcome: "NOT_FOUND" }]);
    }
  });

  it("a business conflict comes back with its code and is not a security event", async () => {
    const { service, events } = harness("CDF_CONFLICT:VOTES_OUTSTANDING");
    const r = await service.closeVoteItem(ctx, { voteItemId: ITEM, customQuorumAttested: false });
    expect(r.ok === false && "error" in r && [r.error.kind, r.error.detail]).toEqual([
      "CONFLICT",
      "VOTES_OUTSTANDING",
    ]);
    expect(events).toEqual([]);
  });

  it("a read the database refuses is null and an ACCESS_DENIED event; anything else surfaces", async () => {
    const ok = harness();
    expect(await ok.service.meeting(ctx, MEETING)).toEqual({ view: "CONCERNS_ONLY", meetingId: MEETING });
    expect(ok.events).toEqual([]);

    const refused = harness("CDF_NOT_FOUND");
    expect(await refused.service.meeting(ctx, MEETING)).toBeNull();
    expect(await refused.service.minutes(ctx, MEETING)).toBeNull();
    expect(await refused.service.voteItemProgress(ctx, ITEM)).toBeNull();
    expect(refused.events).toEqual([
      {
        action: "ACCESS_DENIED",
        objectType: "meeting",
        objectId: MEETING,
        metadata: { read: "meeting_view" },
      },
      {
        action: "ACCESS_DENIED",
        objectType: "minutes",
        objectId: MEETING,
        metadata: { read: "minutes_view" },
      },
      {
        action: "ACCESS_DENIED",
        objectType: "vote_item",
        objectId: ITEM,
        metadata: { read: "vote_item_status" },
      },
    ]);

    await expect(harness("connection reset").service.meeting(ctx, MEETING)).rejects.toMatchObject({
      kind: "UNAVAILABLE",
    });
  });
});
