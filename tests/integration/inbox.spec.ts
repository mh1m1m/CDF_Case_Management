// UX redesign S4 (ADR-025, migration 1920) through the real inbox service, gateway and database: the caller's own
// in-app notifications, the unread count, marking one read, and the notification settings. The service commits, so
// the fixture notice cannot sit in a rolled-back scenario. Its one write on the owner connection queues the notice
// with notify.enqueue, the function every notification trigger calls, so the run leaves no committee seat behind
// (registry counts in tests/security stay exact). Who is notified, and the SQL-level negatives (only the recipient
// reads or marks a row; a mandatory notice cannot be muted), live in tests/security/notifications.spec.ts.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createInboxService } from "@cdf/application";
import { NOTIFICATION_TEMPLATES } from "@cdf/contracts";
import { PostgresInboxGateway, PostgresSecurityEventSink, withUserContext } from "@cdf/infrastructure";
import { USERS, admin, bff, type UserKey } from "../support/db";
import { committeeIds } from "../support/committee";

const service = createInboxService({
  gateway: new PostgresInboxGateway(bff),
  securityEvents: new PostgresSecurityEventSink(bff),
});
const ctxFor = (user: UserKey) => ({ userId: USERS[user], requestId: randomUUID() });

let committeeId: string;
const fixtureKey = `inbox-test:${randomUUID()}`;

beforeAll(async () => {
  ({ ic: committeeId } = await committeeIds());
  // A seat notice for the synthetic Committee member, as the membership trigger would queue it.
  await admin`select notify.enqueue('COMMITTEE_SEAT_ASSIGNED', ${USERS.committee}, ${committeeId}, ${committeeId},
    ${fixtureKey})`;
});

afterAll(async () => {
  // Leave the synthetic user's own settings as the seed has them.
  await withUserContext(
    bff,
    ctxFor("committee"),
    (tx) => tx`select api.set_notification_preference('COMMITTEE_SEAT_ASSIGNED', 'IN_APP', false)`,
  );
});

describe("inbox through the service", () => {
  it("lists the caller's own notice with a template, an id-only link and no content; marking it read counts down", async () => {
    const ctx = ctxFor("committee");
    const [mine] = await admin<{ id: string }[]>`
      select id from notify.outbox where dedupe_key like ${`${fixtureKey}:%`} and channel = 'IN_APP'`;
    const list = await service.list(ctx);
    const notice = list.find((n) => n.id === mine!.id);
    expect(notice).toEqual({
      id: mine!.id,
      template: "COMMITTEE_SEAT_ASSIGNED",
      objectType: "COMMITTEE",
      deepLink: `/committees/${committeeId}`,
      createdAt: expect.any(String),
      readAt: null,
    });
    expect(list.every((n) => n.template && /^(\/[a-z0-9-]+)+$/.test(n.deepLink))).toBe(true);

    // Nobody else sees it, however the list is asked for.
    for (const other of ["legalB", "platformAdmin", "internalAudit"] as const)
      expect(
        (await service.list(ctxFor(other))).some((n) => n.id === mine!.id),
        other,
      ).toBe(false);

    const before = await service.unreadCount(ctx);
    expect(before).toBeGreaterThan(0);
    expect(await service.markRead(ctx, { notificationId: mine!.id })).toEqual({ ok: true, value: undefined });
    expect(await service.unreadCount(ctx)).toBe(before - 1);
    expect((await service.list(ctx)).find((n) => n.id === mine!.id)?.readAt).toEqual(expect.any(String));
    // Marking it again is a no-op, not an error.
    expect((await service.markRead(ctx, { notificationId: mine!.id })).ok).toBe(true);
  });

  it("another user's notification answers NOT_FOUND, exactly like an id that does not exist, and is recorded", async () => {
    const [mine] = await admin<{ id: string }[]>`
      select id from notify.outbox where dedupe_key like ${`${fixtureKey}:%`} and channel = 'IN_APP'`;
    for (const id of [mine!.id, randomUUID()]) {
      const r = await service.markRead(ctxFor("legalB"), { notificationId: id });
      expect(r.ok === false && "error" in r && r.error.kind).toBe("NOT_FOUND");
    }
    const [denied] = await admin<{ n: number }[]>`
      select count(*)::int as n from audit.audit_event
      where action = 'COMMAND_DENIED' and actor_id = ${USERS.legalB} and object_id = ${mine!.id}`;
    expect(denied!.n).toBeGreaterThan(0);
  });

  it("settings: every template on both channels, mandatory ones always on, the email default off for the rest", async () => {
    const settings = await service.settings(ctxFor("committee"));
    expect(settings).toHaveLength(NOTIFICATION_TEMPLATES.length * 2);
    const at = (template: string, channel: string) =>
      settings.find((s) => s.template === template && s.channel === channel)!;
    expect(at("MEETING_INVITATION", "EMAIL")).toMatchObject({
      mandatory: true,
      ruleDelivers: true,
      muted: false,
    });
    expect(at("COMMITTEE_SEAT_ASSIGNED", "IN_APP")).toMatchObject({ mandatory: false, ruleDelivers: true });
    expect(at("COMMITTEE_SEAT_ASSIGNED", "EMAIL")).toMatchObject({ mandatory: false, ruleDelivers: false });
  });

  it("saves changed settings together; a refused change leaves every setting as it was", async () => {
    const ctx = ctxFor("committee");
    const muted = async () =>
      (await service.settings(ctx)).find(
        (s) => s.template === "COMMITTEE_SEAT_ASSIGNED" && s.channel === "IN_APP",
      )!.muted;
    expect(await muted()).toBe(false);
    const refused = await service.setPreferences(ctx, {
      changes: [
        { template: "COMMITTEE_SEAT_ASSIGNED", channel: "IN_APP", muted: true },
        { template: "MEETING_INVITATION", channel: "IN_APP", muted: true },
      ],
    });
    expect(refused.ok === false && "error" in refused && [refused.error.kind, refused.error.detail]).toEqual([
      "CONFLICT",
      "MANDATORY_NOTIFICATION",
    ]);
    expect(await muted()).toBe(false);

    const saved = await service.setPreferences(ctx, {
      changes: [{ template: "COMMITTEE_SEAT_ASSIGNED", channel: "IN_APP", muted: true }],
    });
    expect(saved.ok).toBe(true);
    expect(await muted()).toBe(true);
    // Another user's settings are untouched.
    expect(
      (await service.settings(ctxFor("legalB"))).find(
        (s) => s.template === "COMMITTEE_SEAT_ASSIGNED" && s.channel === "IN_APP",
      )!.muted,
    ).toBe(false);
  });
});
