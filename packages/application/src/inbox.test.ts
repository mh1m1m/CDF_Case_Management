// In-app notifications (UX redesign S4; ADR-025): validation before the gateway, refusals recorded as
// COMMAND_DENIED, database answers mapped to safe errors, and settings saved in one call. The database side (only
// the recipient reads or marks a notification; a mandatory notice cannot be muted) is in
// tests/security/notifications.spec.ts.
import { describe, expect, it } from "vitest";
import type { SecurityEvent } from "@cdf/audit";
import { createInboxService, type InboxGateway } from "./inbox";

const NOTE = "33333333-3333-4333-8333-333333333333";
const ctx = {
  userId: "a0000000-0000-4000-8000-000000000007",
  requestId: "22222222-2222-4222-8222-222222222222",
};

function harness(refusal?: string) {
  const calls: unknown[][] = [];
  const events: SecurityEvent[] = [];
  const gateway: InboxGateway = {
    list: async (_, limit) => (calls.push(["list", limit]), []),
    unreadCount: async () => (calls.push(["unreadCount"]), 0),
    settings: async () => (calls.push(["settings"]), []),
    markRead: async (_, id) => {
      calls.push(["markRead", id]);
      if (refusal) throw new Error(refusal);
    },
    setPreferences: async (_, changes) => {
      calls.push(["setPreferences", changes]);
      if (refusal) throw new Error(refusal);
    },
  };
  const service = createInboxService({
    gateway,
    securityEvents: { record: async (e) => void events.push(e) },
  });
  return { service, calls, events };
}

describe("inbox service", () => {
  it("validates before the gateway: an id that is not a uuid never reaches the database", async () => {
    const { service, calls } = harness();
    const r = await service.markRead(ctx, { notificationId: "1 or 1=1" });
    expect(r.ok).toBe(false);
    expect(r.ok === false && "fieldErrors" in r).toBe(true);
    expect(calls).toEqual([]);
  });

  it("marks one of the caller's notifications read", async () => {
    const { service, calls, events } = harness();
    const r = await service.markRead(ctx, { notificationId: NOTE });
    expect(r).toEqual({ ok: true, value: undefined });
    expect(calls).toEqual([["markRead", NOTE]]);
    expect(events).toEqual([]);
  });

  it("another user's notification answers NOT_FOUND and is recorded as a refusal, with no content", async () => {
    const { service, events } = harness("CDF_NOT_FOUND");
    const r = await service.markRead(ctx, { notificationId: NOTE });
    expect(r.ok === false && "error" in r && r.error.kind).toBe("NOT_FOUND");
    expect(events).toEqual([
      {
        action: "COMMAND_DENIED",
        objectType: "command",
        objectId: NOTE,
        metadata: { command: "mark_notification_read", outcome: "NOT_FOUND" },
      },
    ]);
  });

  it("saves every changed setting in one call and refuses unknown templates, channels or repeats", async () => {
    const { service, calls } = harness();
    const ok = await service.setPreferences(ctx, {
      changes: [
        { template: "COMMITTEE_SEAT_ASSIGNED", channel: "IN_APP", muted: true },
        { template: "COMMITTEE_SEAT_ASSIGNED", channel: "EMAIL", muted: false },
      ],
    });
    expect(ok.ok).toBe(true);
    expect(calls).toHaveLength(1);
    for (const changes of [
      [],
      [{ template: "NOT_A_TEMPLATE", channel: "IN_APP", muted: true }],
      [{ template: "COMMITTEE_SEAT_ASSIGNED", channel: "SMS", muted: true }],
      [{ template: "COMMITTEE_SEAT_ASSIGNED", channel: "IN_APP", muted: "yes" }],
      [
        { template: "COMMITTEE_SEAT_ASSIGNED", channel: "IN_APP", muted: true },
        { template: "COMMITTEE_SEAT_ASSIGNED", channel: "IN_APP", muted: false },
      ],
    ]) {
      const r = await service.setPreferences(ctx, { changes });
      expect(r.ok === false && "fieldErrors" in r, JSON.stringify(changes)).toBe(true);
    }
    expect(calls).toHaveLength(1);
  });

  it("muting a mandatory notice is the database's refusal, shown as a conflict and not recorded as a denial", async () => {
    const { service, events } = harness("CDF_CONFLICT:MANDATORY_NOTIFICATION");
    const r = await service.setPreferences(ctx, {
      changes: [{ template: "MEETING_INVITATION", channel: "IN_APP", muted: true }],
    });
    expect(r.ok === false && "error" in r && [r.error.kind, r.error.detail]).toEqual([
      "CONFLICT",
      "MANDATORY_NOTIFICATION",
    ]);
    expect(events).toEqual([]);
  });

  it("an unexpected database failure becomes UNAVAILABLE, never the raw message", async () => {
    const { service } = harness('relation "notify.outbox" does not exist');
    const r = await service.markRead(ctx, { notificationId: NOTE });
    expect(r.ok === false && "error" in r && [r.error.kind, r.error.message]).toEqual([
      "UNAVAILABLE",
      "UNAVAILABLE",
    ]);
  });

  it("reads the newest page by default", async () => {
    const { service, calls } = harness();
    await service.list(ctx);
    expect(calls).toEqual([["list", 100]]);
  });
});
