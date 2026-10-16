// The committees service (Phase 12 P12-2b; ADR-055): validation before the gateway, database refusals mapped to safe
// errors and recorded as COMMAND_DENIED with the command and outcome only, and a committee the caller holds no seat on
// turned into the uniform not-found with an ACCESS_DENIED event. Who may act, and when, is the database's:
// tests/security/my-committees-and-meeting-logistics.spec.ts; the whole path is tests/integration/committees.spec.ts.
import { describe, expect, it } from "vitest";
import type { SecurityEvent } from "@cdf/audit";
import { createCommitteesService, type CommitteesGateway } from "./committees";

const COMMITTEE = "11111111-1111-4111-8111-111111111111";
const PROCEEDING = "33333333-3333-4333-8333-333333333333";
const MEMBERSHIP = "44444444-4444-4444-8444-444444444444";
const MEETING = "55555555-5555-4555-8555-555555555555";
const ctx = {
  userId: "a0000000-0000-4000-8000-000000000003",
  requestId: "22222222-2222-4222-8222-222222222222",
};
const room = {
  committeeProceedingId: PROCEEDING,
  purpose: "DELIBERATION",
  mode: "IN_PERSON",
  location: "Meeting room (synthetic)",
  scheduledStart: "2026-11-02T10:00",
  scheduledEnd: "2026-11-02T11:30",
  reason: "Synthetic: first deliberation.",
};

function harness(refusal?: string) {
  const calls: unknown[][] = [];
  const events: SecurityEvent[] = [];
  const answer =
    (name: string, value: unknown = undefined) =>
    async (_: unknown, input?: unknown) => {
      calls.push(input === undefined ? [name] : [name, input]);
      if (refusal) throw new Error(refusal);
      return value;
    };
  const gateway = {
    myCommittees: answer("myCommittees", []),
    committeeView: answer("committeeView", { committee: { committeeId: COMMITTEE } }),
    scheduleMeeting: answer("scheduleMeeting", MEETING),
    scheduleEmergencyMeeting: answer("scheduleEmergencyMeeting", MEETING),
    amendProceedingSnapshot: answer("amendProceedingSnapshot", MEMBERSHIP),
  } as unknown as CommitteesGateway;
  const service = createCommitteesService({
    gateway,
    securityEvents: { record: async (e) => void events.push(e) },
  });
  return { service, calls, events };
}

describe("committees service", () => {
  it("validates before the gateway: a malformed command never reaches the database", async () => {
    const { service, calls } = harness();
    const r = await service.scheduleMeeting(ctx, { ...room, scheduledEnd: room.scheduledStart });
    expect(r.ok === false && "fieldErrors" in r).toBe(true);
    const e = await service.scheduleEmergencyMeeting(ctx, room);
    expect(e.ok === false && "fieldErrors" in e).toBe(true);
    const a = await service.amendProceedingSnapshot(ctx, {
      committeeProceedingId: PROCEEDING,
      reason: "Synthetic.",
    });
    expect(a.ok === false && "fieldErrors" in a).toBe(true);
    expect(calls).toEqual([]);
  });

  it("passes the parsed command to the gateway, times as instants, and returns the new id", async () => {
    const { service, calls, events } = harness();
    expect(await service.scheduleMeeting(ctx, room)).toEqual({ ok: true, value: MEETING });
    expect(calls).toEqual([
      [
        "scheduleMeeting",
        {
          ...room,
          onlineUrl: undefined,
          scheduledStart: "2026-11-02T07:00:00.000Z",
          scheduledEnd: "2026-11-02T08:30:00.000Z",
        },
      ],
    ]);
    expect(events).toEqual([]);
  });

  it("a refusal is recorded as COMMAND_DENIED with the command and outcome only, never the reason", async () => {
    const reason = "Synthetic: a reason that must stay in the committee.";
    const cases: [string, (s: ReturnType<typeof harness>["service"]) => Promise<unknown>][] = [
      ["schedule_meeting", (s) => s.scheduleMeeting(ctx, { ...room, reason })],
      [
        "schedule_emergency_meeting",
        (s) => s.scheduleEmergencyMeeting(ctx, { ...room, reason, emergencyReason: reason }),
      ],
      [
        "amend_proceeding_snapshot",
        (s) =>
          s.amendProceedingSnapshot(ctx, {
            committeeProceedingId: PROCEEDING,
            membershipId: MEMBERSHIP,
            reason,
          }),
      ],
    ];
    for (const [command, run] of cases) {
      const { service, events } = harness("CDF_FORBIDDEN");
      await run(service);
      expect(events, command).toEqual([
        {
          action: "COMMAND_DENIED",
          objectType: "command",
          objectId: PROCEEDING,
          metadata: { command, outcome: "FORBIDDEN" },
        },
      ]);
      expect(JSON.stringify(events)).not.toContain(reason);
    }
  });

  it("a business conflict comes back with its code and is not a security event", async () => {
    const { service, events } = harness("CDF_CONFLICT:NOTICE_TOO_SHORT");
    const r = await service.scheduleMeeting(ctx, room);
    expect(r.ok === false && "error" in r && [r.error.kind, r.error.detail]).toEqual([
      "CONFLICT",
      "NOTICE_TOO_SHORT",
    ]);
    expect(events).toEqual([]);
  });

  it("a committee without a seat is null and an ACCESS_DENIED event; anything else surfaces", async () => {
    const ok = harness();
    expect(await ok.service.committee(ctx, COMMITTEE)).toEqual({ committee: { committeeId: COMMITTEE } });
    expect(await ok.service.myCommittees(ctx)).toEqual([]);
    expect(ok.events).toEqual([]);

    const refused = harness("CDF_NOT_FOUND");
    expect(await refused.service.committee(ctx, COMMITTEE)).toBeNull();
    expect(refused.events).toEqual([
      {
        action: "ACCESS_DENIED",
        objectType: "committee",
        objectId: COMMITTEE,
        metadata: { read: "committee_view" },
      },
    ]);

    await expect(harness("connection reset").service.committee(ctx, COMMITTEE)).rejects.toMatchObject({
      kind: "UNAVAILABLE",
    });
    await expect(harness("connection reset").service.myCommittees(ctx)).rejects.toMatchObject({
      kind: "UNAVAILABLE",
    });
  });
});
