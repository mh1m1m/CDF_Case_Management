// Administration service (UX redesign Phase 12 P12-8a; ADR-051's P12-8a amendment): each register opens only where
// the caller's permissions open its page, before the gateway is asked, and a page the database refuses is the same
// not-found; both are recorded as ACCESS_DENIED with the page's name only. The calendar's two commands validate with
// the shared schema and pre-check BUSINESS_CALENDAR_ADMIN before the gateway; a refusal is recorded with the command
// and the outcome, never the reason typed. The database side (each page's permission, row-level security, every
// calendar check) is in tests/integration/administration.spec.ts.
import { describe, expect, it } from "vitest";
import type { Actor, AdminView, Permission } from "@cdf/contracts";
import type { SecurityEvent } from "@cdf/audit";
import { createAdministrationService, type AdministrationGateway } from "./administration";

const ctx = {
  userId: "a0000000-0000-4000-8000-000000000009",
  requestId: "22222222-2222-4222-8222-222222222222",
};

function actor(permissions: Permission[]): Actor {
  return {
    userId: ctx.userId,
    email: "platformadmin@example.test",
    displayName: "Platform Admin Eta",
    displayNameAr: "مسؤول المنصة إيتا",
    roles: ["PLATFORM_ADMIN"],
    permissions,
    clearance: "INTERNAL",
  };
}

/** Each page with the permission that opens it, and the service read that returns it. */
const PAGES = [
  ["committees", ["COMMITTEE_ADMIN"], "committees"],
  ["sectors", ["SECTOR_ADMIN"], "sectors"],
  ["notification-rules", ["NOTIFICATION_ADMIN"], "notificationRules"],
  ["export-policy", ["EXPORT_POLICY_ADMIN"], "exportPolicy"],
  ["corrective-action-policy", ["CORRECTIVE_ACTION_POLICY_ADMIN"], "correctiveActionPolicy"],
  ["calendar", ["BUSINESS_CALENDAR_ADMIN"], "calendar"],
] as const satisfies readonly (readonly [AdminView, readonly Permission[], keyof AdministrationGateway])[];

type Read = (typeof PAGES)[number][2];

function harness(fail?: Error) {
  const calls: { name: string; input?: unknown }[] = [];
  const events: SecurityEvent[] = [];
  const page = (name: string) => async () => {
    calls.push({ name });
    if (fail) throw fail;
    return { page: name } as never;
  };
  const gateway: AdministrationGateway = {
    committees: page("committees"),
    sectors: page("sectors"),
    notificationRules: page("notificationRules"),
    exportPolicy: page("exportPolicy"),
    correctiveActionPolicy: page("correctiveActionPolicy"),
    calendar: page("calendar"),
    setCalendarDay: async (_, input) => {
      calls.push({ name: "setCalendarDay", input });
      if (fail) throw fail;
      return "33333333-3333-4333-8333-333333333333";
    },
    setWeekPattern: async (_, input) => {
      calls.push({ name: "setWeekPattern", input });
      if (fail) throw fail;
      return "44444444-4444-4444-8444-444444444444";
    },
  };
  const service = createAdministrationService({
    gateway,
    securityEvents: { record: async (e) => void events.push(e) },
  });
  return { service, calls, events };
}

const day = { calendarDate: "2027-01-03", dayType: "HOLIDAY", reason: "Synthetic: a demo holiday." };
const week = { nonWorkingDays: ["5", "6"], effectiveFrom: "2027-01-03", reason: "Synthetic: a demo week." };

describe("the registers", () => {
  for (const [view, permissions, read] of PAGES) {
    it(`${view} opens to the holder of its permission and reads its register`, async () => {
      const { service, calls, events } = harness();
      expect(await service[read as Read](ctx, actor([...permissions]))).toEqual({ page: read });
      expect(calls).toEqual([{ name: read }]);
      expect(events).toEqual([]);
    });

    it(`${view} is the uniform not-found without its permission, and the gateway is never asked`, async () => {
      const { service, calls, events } = harness();
      // Every other administrator's permission, but not this page's.
      const others = PAGES.filter(([v]) => v !== view).flatMap(([, p]) => p);
      expect(await service[read as Read](ctx, actor([...others, "USER_ADMIN", "ROLE_ADMIN"]))).toBeNull();
      expect(calls).toEqual([]);
      expect(events).toEqual([
        { action: "ACCESS_DENIED", objectType: "administration", objectId: view, metadata: { read: view } },
      ]);
    });

    it(`${view} refused by the database is the same not-found`, async () => {
      for (const code of ["CDF_FORBIDDEN", "CDF_NOT_FOUND"]) {
        const { service, calls, events } = harness(new Error(code));
        expect(await service[read as Read](ctx, actor([...permissions]))).toBeNull();
        expect(calls).toEqual([{ name: read }]);
        expect(events).toEqual([
          { action: "ACCESS_DENIED", objectType: "administration", objectId: view, metadata: { read: view } },
        ]);
      }
    });
  }

  it("export policy never opens to an export approver, even one who also holds EXPORT_POLICY_ADMIN (DEC-F24)", async () => {
    for (const approval of ["EXPORT_APPROVE", "EXPORT_SECOND_APPROVE"] as const) {
      const { service, calls, events } = harness();
      expect(await service.exportPolicy(ctx, actor(["EXPORT_POLICY_ADMIN", approval]))).toBeNull();
      expect(calls).toEqual([]);
      expect(events).toHaveLength(1);
    }
  });

  it("any other database failure is not hidden as a not-found", async () => {
    const { service, events } = harness(new Error("connection reset"));
    await expect(service.calendar(ctx, actor(["BUSINESS_CALENDAR_ADMIN"]))).rejects.toMatchObject({
      kind: "UNAVAILABLE",
    });
    expect(events).toEqual([]);
  });

  it("a failing security sink never masks the not-found", async () => {
    const quiet = createAdministrationService({
      gateway: {} as AdministrationGateway,
      securityEvents: {
        record: async () => {
          throw new Error("sink down");
        },
      },
    });
    expect(await quiet.sectors(ctx, actor([]))).toBeNull();
  });
});

describe("the calendar's commands", () => {
  const admin = actor(["BUSINESS_CALENDAR_ADMIN"]);

  it("a day goes to the gateway as the schema reads it", async () => {
    const { service, calls, events } = harness();
    const result = await service.setCalendarDay(ctx, admin, { ...day, sourceReference: "  " });
    expect(result).toEqual({ ok: true, value: "33333333-3333-4333-8333-333333333333" });
    expect(calls).toEqual([{ name: "setCalendarDay", input: { ...day, sourceReference: undefined } }]);
    expect(events).toEqual([]);
  });

  it("a week goes to the gateway with its days as sorted numbers", async () => {
    const { service, calls } = harness();
    const result = await service.setWeekPattern(ctx, admin, { ...week, nonWorkingDays: ["6", "5"] });
    expect(result.ok).toBe(true);
    expect(calls).toEqual([{ name: "setWeekPattern", input: { ...week, nonWorkingDays: [5, 6] } }]);
  });

  it("invalid input never reaches the gateway and records nothing", async () => {
    const { service, calls, events } = harness();
    const bad = await service.setCalendarDay(ctx, admin, { ...day, dayType: "WEEKEND", reason: "abc" });
    expect(bad.ok).toBe(false);
    expect("fieldErrors" in bad && bad.fieldErrors.issues.map((i) => i.path.join("."))).toEqual(
      expect.arrayContaining(["dayType", "reason"]),
    );
    const all = await service.setWeekPattern(ctx, admin, {
      ...week,
      nonWorkingDays: ["1", "2", "3", "4", "5", "6", "7"],
    });
    expect("fieldErrors" in all && all.fieldErrors.issues.map((i) => i.message)).toEqual([
      "validation.oneWorkingDay",
    ]);
    expect(calls).toEqual([]);
    expect(events).toEqual([]);
  });

  for (const [name, run] of [
    [
      "set_business_calendar_day",
      (s: ReturnType<typeof harness>["service"], a: Actor) => s.setCalendarDay(ctx, a, day),
    ],
    [
      "set_business_week_pattern",
      (s: ReturnType<typeof harness>["service"], a: Actor) => s.setWeekPattern(ctx, a, week),
    ],
  ] as const) {
    it(`${name} is refused before the gateway without BUSINESS_CALENDAR_ADMIN, and recorded`, async () => {
      const { service, calls, events } = harness();
      // Every other administrator's permission is not enough.
      const result = await run(service, actor(PAGES.flatMap(([v, p]) => (v === "calendar" ? [] : p))));
      expect(result).toMatchObject({ ok: false, error: { kind: "FORBIDDEN" } });
      expect(calls).toEqual([]);
      expect(events).toEqual([
        {
          action: "COMMAND_DENIED",
          objectType: "command",
          objectId: undefined,
          metadata: { command: name, outcome: "FORBIDDEN" },
        },
      ]);
    });

    it(`${name} refused by the database is recorded with the outcome only`, async () => {
      const { service, events } = harness(new Error("CDF_FORBIDDEN"));
      expect(await run(service, admin)).toMatchObject({ ok: false, error: { kind: "FORBIDDEN" } });
      expect(events).toEqual([
        {
          action: "COMMAND_DENIED",
          objectType: "command",
          objectId: undefined,
          metadata: { command: name, outcome: "FORBIDDEN" },
        },
      ]);
    });

    it(`${name}: a conflict or an invalid value comes back with its code and is not a denial`, async () => {
      for (const [message, kind, detail] of [
        ["CDF_CONFLICT:CALENDAR_DAY_EXISTS", "CONFLICT", "CALENDAR_DAY_EXISTS"],
        ["CDF_INVALID:effective_from", "INVALID", "effective_from"],
      ] as const) {
        const { service, events } = harness(new Error(message));
        expect(await run(service, admin)).toMatchObject({ ok: false, error: { kind, detail } });
        expect(events).toEqual([]);
      }
    });
  }
});
