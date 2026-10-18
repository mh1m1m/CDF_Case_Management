// Phase 12 P12-8a Administration (ADR-051's P12-8a amendment) through the real service, gateway, database, RLS and
// audit, the way the pages call them. Each test runs in one owner-connection transaction that is rolled back: the
// gateway runs its security context inside a savepoint of that transaction, so no calendar day or week reaches the
// seed. These pin that each page opens exactly where its own permission does, in the application pre-check and again
// in the database; that a refused page is the uniform not-found recorded as ACCESS_DENIED with the page's name only;
// that each register is the seed as recorded, with ids, codes and dates and nothing from a case, not even the count of
// proceedings a seat correction recorded; and that the calendar's two forms run their commands, whose refusals are
// COMMAND_DENIED with the command and outcome only.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createAdministrationService,
  createInvestigationService,
  type AdministrationService,
} from "@cdf/application";
import { adminViews } from "@cdf/authorization";
import type { Actor, AdminView } from "@cdf/contracts";
import {
  PostgresAdministrationGateway,
  PostgresInvestigationGateway,
  PostgresSecurityEventSink,
  type Sql,
} from "@cdf/infrastructure";
import { IC_SEATS, committeeIds, refer, seat } from "../support/committee";
import { USERS, bff, caseId, ownerScenario, type OwnerScenario, type UserKey } from "../support/db";

const ctxFor = (user: UserKey) => ({ userId: USERS[user], requestId: randomUUID() });
const REASON = "Synthetic administration test (P12-8a).";

const PEOPLE: readonly UserKey[] = [
  "platformAdmin",
  "grcDirector",
  "grcDeputy",
  "complianceManager",
  "investigatorA",
  "caseManager",
  "committeeSecretary",
];
const actors = {} as Record<UserKey, Actor>;

beforeAll(async () => {
  const investigations = createInvestigationService({
    gateway: new PostgresInvestigationGateway(bff),
    securityEvents: new PostgresSecurityEventSink(bff),
  });
  for (const user of PEOPLE) {
    const a = await investigations.loadActor(ctxFor(user));
    if (!a) throw new Error(`no actor for ${user}`);
    actors[user] = a;
  }
});

/** The administration service bound to the scenario's transaction (each call runs in a savepoint). */
function adminIn(s: OwnerScenario): AdministrationService {
  const sql = {
    begin: (fn: (tx: unknown) => Promise<unknown>) => s.tx.savepoint(fn as never),
  } as unknown as Sql;
  return createAdministrationService({
    gateway: new PostgresAdministrationGateway(sql),
    securityEvents: new PostgresSecurityEventSink(sql),
  });
}

/** The security events one request recorded, read back on the owner connection. */
async function eventsOf(s: OwnerScenario, requestId: string) {
  await s.asOwner();
  return s.tx<
    { action: string; object_type: string; object_id: string | null; metadata: Record<string, string> }[]
  >`
    select action, object_type, object_id, metadata from audit.audit_event
    where category = 'SECURITY' and request_id = ${requestId} order by seq`;
}

function outcome(r: { ok: boolean }): string {
  if (r.ok) return "ok";
  if ("error" in r) {
    const e = (r as { error: { kind: string; detail?: string } }).error;
    return e.detail ? `${e.kind}:${e.detail}` : e.kind;
  }
  return "fieldErrors";
}

/** A date `days` after `date` (YYYY-MM-DD). */
function plusDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Each page's read, as its route calls it. `users` is the S1 register (InvestigationService.userRegister). */
const READS: Record<
  Exclude<AdminView, "users">,
  (a: AdministrationService, c: ReturnType<typeof ctxFor>, actor: Actor) => Promise<unknown>
> = {
  committees: (a, c, actor) => a.committees(c, actor),
  sectors: (a, c, actor) => a.sectors(c, actor),
  "notification-rules": (a, c, actor) => a.notificationRules(c, actor),
  "export-policy": (a, c, actor) => a.exportPolicy(c, actor),
  "corrective-action-policy": (a, c, actor) => a.correctiveActionPolicy(c, actor),
  calendar: (a, c, actor) => a.calendar(c, actor),
};

describe("Administration through the service (Phase 12 P12-8a)", () => {
  it("each administrator opens exactly their pages; every other page is the uniform not-found, recorded with its name only", async () => {
    expect(adminViews(actors.platformAdmin)).toEqual([
      "users",
      "committees",
      "sectors",
      "notification-rules",
      "export-policy",
      "calendar",
    ]);
    // The GRC Director holds EXPORT_POLICY_ADMIN with export approval, so export policy is not theirs (DEC-F24).
    expect(adminViews(actors.grcDirector)).toEqual(["committees", "corrective-action-policy"]);
    expect(adminViews(actors.grcDeputy)).toEqual(["committees", "corrective-action-policy"]);
    expect(adminViews(actors.complianceManager)).toEqual(["committees"]);
    for (const user of ["investigatorA", "caseManager", "committeeSecretary"] as const)
      expect(adminViews(actors[user]), user).toEqual([]);

    await ownerScenario(async (s) => {
      const admin = adminIn(s);
      for (const user of PEOPLE) {
        const opens = adminViews(actors[user]);
        for (const [view, read] of Object.entries(READS) as [
          Exclude<AdminView, "users">,
          (typeof READS)["calendar"],
        ][]) {
          const c = ctxFor(user);
          const page = await read(admin, c, actors[user]);
          const events = await eventsOf(s, c.requestId);
          if (opens.includes(view)) {
            expect(page, `${user} ${view}`).not.toBeNull();
            expect(events, `${user} ${view}`).toEqual([]);
          } else {
            expect(page, `${user} ${view}`).toBeNull();
            expect(events, `${user} ${view}`).toEqual([
              {
                action: "ACCESS_DENIED",
                object_type: "administration",
                object_id: view,
                metadata: { read: view },
              },
            ]);
          }
        }
      }
    });
  });

  it("the database refuses a page to a caller the application pre-check would let through", async () => {
    await ownerScenario(async (s) => {
      const admin = adminIn(s);
      // A forged actor: the investigator's identity with every administration permission claimed. The database
      // answers from the caller's real roles, so each page is still the uniform not-found.
      const forged: Actor = {
        ...actors.investigatorA,
        permissions: [
          ...actors.investigatorA.permissions,
          "COMMITTEE_ADMIN",
          "SECTOR_ADMIN",
          "NOTIFICATION_ADMIN",
          "EXPORT_POLICY_ADMIN",
          "CORRECTIVE_ACTION_POLICY_ADMIN",
          "BUSINESS_CALENDAR_ADMIN",
        ],
      };
      expect(adminViews(forged)).toEqual([
        "committees",
        "sectors",
        "notification-rules",
        "export-policy",
        "corrective-action-policy",
        "calendar",
      ]);
      for (const [view, read] of Object.entries(READS) as [
        Exclude<AdminView, "users">,
        (typeof READS)["calendar"],
      ][]) {
        const c = ctxFor("investigatorA");
        expect(await read(admin, c, forged), view).toBeNull();
        expect(await eventsOf(s, c.requestId), view).toEqual([
          {
            action: "ACCESS_DENIED",
            object_type: "administration",
            object_id: view,
            metadata: { read: view },
          },
        ]);
      }
      // The same holds for a calendar command: the database refuses it, recorded with the command and outcome only.
      const c = ctxFor("investigatorA");
      const r = await admin.setCalendarDay(c, forged, {
        calendarDate: "2099-01-01",
        dayType: "HOLIDAY",
        reason: REASON,
      });
      expect(outcome(r)).toBe("FORBIDDEN");
      expect(await eventsOf(s, c.requestId)).toEqual([
        {
          action: "COMMAND_DENIED",
          object_type: "command",
          object_id: null,
          metadata: { command: "set_business_calendar_day", outcome: "FORBIDDEN" },
        },
      ]);
    });
  });

  it("the committees register is the registry as recorded, with the coverage of who decides", async () => {
    await ownerScenario(async (s) => {
      const page = await adminIn(s).committees(ctxFor("complianceManager"), actors.complianceManager);
      if (!page) throw new Error("expected the committees register");
      expect(page.committees.map((c) => [c.code, c.kind, c.isActive])).toEqual([
        ["GC", "GRIEVANCE", true],
        ["IC", "INVESTIGATION", true],
      ]);
      expect(page.seats).toHaveLength(7);
      expect(
        page.seats.every((x) => x.state === "IN_FORCE" && x.effectiveTo === null && x.endedAt === null),
      ).toBe(true);
      expect(Object.keys(page.seats[0]!).sort()).toEqual(
        [
          "appointedAt",
          "appointedBy",
          "appointmentReference",
          "committeeId",
          "effectiveFrom",
          "effectiveTo",
          "endReason",
          "endedAt",
          "endedBy",
          "membershipId",
          "seat",
          "state",
          "userId",
        ].sort(),
      );
      // The Grievance Committee's first version ended when 2030's owner decisions took effect.
      const gc = page.committees.find((c) => c.code === "GC")!.committeeId;
      expect(
        page.ruleSets
          .filter((r) => r.committeeId === gc)
          .map((r) => [r.state, r.grievanceWindowDays, r.grievanceWindowStartBasis]),
      ).toEqual([
        ["ENDED", 30, null],
        ["IN_FORCE", 30, "DELIVERY"],
      ]);
      expect(page.ruleSets).toHaveLength(3);
      expect(page.ruleSets.every((r) => r.sourceStatus === "OWNER_DEFAULT")).toBe(true);
      expect(page.corrections).toEqual([]);
      expect(page.authorities).toEqual([]);
      expect(page.statusChanges).toEqual([]);
      expect(page.coverage.length).toBeGreaterThan(0);
      // Everyone the page names is resolved, and nobody else.
      const named = new Set(page.people.map((p) => p.userId));
      for (const x of page.seats) expect(named.has(x.userId) && named.has(x.appointedBy)).toBe(true);
      expect(JSON.stringify(page)).not.toContain("CDF-DEMO-");
    });
  });

  it("a seat correction is read beside its seat, never with the number of proceedings that named the seat (§21)", async () => {
    const [{ ic }, caseB] = await Promise.all([committeeIds(), caseId("0002")]);
    await ownerScenario(async (s) => {
      // A proceeding snapshots the committee's members, so the correction records a count derived from a case (2090).
      await seat(s, ic, IC_SEATS);
      await refer(s, ic, caseB);
      await s.asOwner();
      const [m] = await s.tx<{ id: string }[]>`
        select id from committee.membership where committee_id = ${ic} and user_id = ${USERS.legal} and ended_at is null`;
      await s.as("platformAdmin");
      const [c] = await s.tx<{ id: string }[]>`
        select api.annotate_committee_membership(${m!.id}, 'WRONG_REFERENCE', ${REASON}) as id`;
      await s.asOwner();
      expect(
        await s.tx`select affected_proceedings from committee.membership_correction where id = ${c!.id}`,
      ).toEqual([{ affected_proceedings: 1 }]);

      const page = await adminIn(s).committees(ctxFor("complianceManager"), actors.complianceManager);
      if (!page) throw new Error("expected the committees register");
      expect(page.corrections).toEqual([
        {
          correctionId: c!.id,
          membershipId: m!.id,
          committeeId: ic,
          kind: "WRONG_REFERENCE",
          reason: REASON,
          correctedBy: USERS.platformAdmin,
          correctedAt: expect.any(String),
        },
      ]);
      expect(page.seats.some((x) => x.membershipId === m!.id)).toBe(true);
      // Nothing of the proceeding or its case reaches the register.
      const json = JSON.stringify(page);
      for (const fromCase of [caseB, "CDF-DEMO-", "affected"]) expect(json).not.toContain(fromCase);
    });
  });

  it("the sectors, notification-rules, export-policy and corrective-action registers are the seed as recorded", async () => {
    await ownerScenario(async (s) => {
      const admin = adminIn(s);

      const sectors = await admin.sectors(ctxFor("platformAdmin"), actors.platformAdmin);
      if (!sectors) throw new Error("expected the sectors register");
      expect(sectors.sectors.map((x) => [x.code, x.isActive])).toEqual([
        ["FIN", true],
        ["OPS", true],
      ]);
      expect(sectors.positions.map((p) => p.position).sort()).toEqual(["HEAD", "MEMBER", "MEMBER", "MEMBER"]);
      expect(sectors.positions.every((p) => p.state === "IN_FORCE")).toBe(true);
      expect(sectors.delegations).toEqual([]);
      expect(sectors.delegationLimit).toEqual({ status: "SOURCE_REQUIRED", value: null });

      const rules = await admin.notificationRules(ctxFor("platformAdmin"), actors.platformAdmin);
      if (!rules) throw new Error("expected the notification rules");
      expect(rules.templates).toHaveLength(46);
      expect(rules.templates.filter((t) => t.isMandatory)).toHaveLength(38);
      expect(rules.rules).toHaveLength(92);
      const count = (layer: string, channel: string, enabled: boolean) =>
        rules.rules.filter((r) => r.layer === layer && r.channel === channel && r.enabled === enabled).length;
      expect([
        count("SYSTEM_MANDATORY", "IN_APP", true),
        count("SYSTEM_MANDATORY", "EMAIL", true),
        count("EVENT_RULE", "IN_APP", true),
        count("EVENT_RULE", "EMAIL", false),
      ]).toEqual([38, 38, 8, 8]);
      expect(rules.committees.map((c) => c.code)).toEqual(["GC", "IC"]);

      const exports = await admin.exportPolicy(ctxFor("platformAdmin"), actors.platformAdmin);
      if (!exports) throw new Error("expected the export policy");
      expect(exports.rules.map((r) => [r.code, r.action, r.sourceStatus, r.state])).toEqual([
        ["EXTERNAL_CONFIDENTIAL", "REQUIRE_SECOND_APPROVAL", "SOURCE_REQUIRED", "IN_FORCE"],
        ["EXTERNAL_MINUTES", "REQUIRE_SECOND_APPROVAL", "SOURCE_REQUIRED", "IN_FORCE"],
        ["EXTERNAL_SECRET", "REFUSE", "SOURCE_REQUIRED", "IN_FORCE"],
        ["RESTRICTED_CASE", "REQUIRE_SECOND_APPROVAL", "SOURCE_REQUIRED", "IN_FORCE"],
        ["RESTRICTED_CASE_AUTHORITY", "REQUIRE_AUTHORITY_APPROVAL", "SOURCE_REQUIRED", "IN_FORCE"],
      ]);
      expect(exports.purposes).toHaveLength(13);
      expect(exports.purposes.filter((p) => p.isActive && !p.isLegacy)).toHaveLength(8);
      expect(exports.purposes.filter((p) => p.isLegacy && !p.isActive)).toHaveLength(5);
      expect(exports.approvedDomains).toEqual({ status: "SOURCE_REQUIRED", domains: [] });
      expect(exports.pool).toEqual([]);
      expect(exports.warnings.warnings).toEqual([]);

      const policy = await admin.correctiveActionPolicy(ctxFor("grcDeputy"), actors.grcDeputy);
      if (!policy) throw new Error("expected the corrective-action policy");
      expect(
        policy.policies.map((p) => [p.actionType, p.completionEvidence, p.sourceStatus, p.state]),
      ).toEqual([
        ["CORRECTIVE_ACTION", "REFERENCE_REQUIRED", "SOURCE_REQUIRED", "IN_FORCE"],
        ["GOVERNANCE_REMEDIATION", "REFERENCE_REQUIRED", "SOURCE_REQUIRED", "IN_FORCE"],
      ]);
      expect(policy.policies.every((p) => p.defaultDueDays === null && p.steps.length === 0)).toBe(true);
      expect(policy.evidenceTypes).toHaveLength(6);
      expect(policy.pools).toEqual([]);
    });
  });

  it("the calendar's forms add a day from today and change the week from a later date; the database refuses the rest", async () => {
    await ownerScenario(async (s) => {
      const admin = adminIn(s);
      const eta = actors.platformAdmin;
      const before = await admin.calendar(ctxFor("platformAdmin"), eta);
      if (!before) throw new Error("expected the calendar");
      expect(before.source).toBe("SOURCE_REQUIRED");
      expect(before.capabilities).toEqual({ maySetDay: true, maySetWeekPattern: true });
      expect(before.days).toEqual([]);
      expect(before.patterns.map((p) => [p.nonWorkingIsoDays, p.state, p.sourceStatus])).toEqual([
        [[5, 6], "IN_FORCE", "OWNER_DEFAULT"],
      ]);
      const today = before.today;
      expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);

      // A day from today; the same date again is refused, and so is yesterday.
      const holiday = plusDays(today, 400);
      expect(
        outcome(
          await admin.setCalendarDay(ctxFor("platformAdmin"), eta, {
            calendarDate: holiday,
            dayType: "HOLIDAY",
            sourceReference: "SYN-REF-1",
            reason: REASON,
          }),
        ),
      ).toBe("ok");
      expect(
        outcome(
          await admin.setCalendarDay(ctxFor("platformAdmin"), eta, {
            calendarDate: holiday,
            dayType: "WORKING_DAY",
            reason: REASON,
          }),
        ),
      ).toBe("CONFLICT:CALENDAR_DAY_EXISTS");
      expect(
        outcome(
          await admin.setCalendarDay(ctxFor("platformAdmin"), eta, {
            calendarDate: plusDays(today, -1),
            dayType: "HOLIDAY",
            reason: REASON,
          }),
        ),
      ).toBe("INVALID:calendar_date");
      // The schema answers before the database: no type, a short reason, a short source reference.
      expect(
        outcome(
          await admin.setCalendarDay(ctxFor("platformAdmin"), eta, {
            calendarDate: holiday,
            dayType: "",
            sourceReference: "ab",
            reason: "abc",
          }),
        ),
      ).toBe("fieldErrors");

      // The week from a later date: the week in force is given its end, and the new one is SOURCE_REQUIRED.
      const from = plusDays(today, 45);
      expect(
        outcome(
          await admin.setWeekPattern(ctxFor("platformAdmin"), eta, {
            nonWorkingDays: ["6", "5"],
            effectiveFrom: from,
            reason: REASON,
          }),
        ),
      ).toBe("ok");
      expect(
        outcome(
          await admin.setWeekPattern(ctxFor("platformAdmin"), eta, {
            nonWorkingDays: ["5"],
            effectiveFrom: plusDays(today, 40),
            reason: REASON,
          }),
        ),
      ).toBe("CONFLICT:PATTERN_SCHEDULED");
      expect(
        outcome(
          await admin.setWeekPattern(ctxFor("platformAdmin"), eta, {
            nonWorkingDays: ["5", "6"],
            effectiveFrom: today,
            reason: REASON,
          }),
        ),
      ).toBe("INVALID:effective_from");
      expect(
        outcome(
          await admin.setWeekPattern(ctxFor("platformAdmin"), eta, {
            nonWorkingDays: ["1", "2", "3", "4", "5", "6", "7"],
            effectiveFrom: plusDays(today, 50),
            reason: REASON,
          }),
        ),
      ).toBe("fieldErrors");

      const after = await admin.calendar(ctxFor("platformAdmin"), eta);
      expect(after!.days.map((d) => [d.calendarDate, d.dayType, d.sourceReference, d.withdrawnAt])).toEqual([
        [holiday, "HOLIDAY", "SYN-REF-1", null],
      ]);
      expect(after!.patterns.map((p) => [p.nonWorkingIsoDays, p.state, p.sourceStatus])).toEqual([
        [[5, 6], "IN_FORCE", "OWNER_DEFAULT"],
        [[5, 6], "SCHEDULED", "SOURCE_REQUIRED"],
      ]);
      expect(after!.patterns[0]!.effectiveTo).toBe(after!.patterns[1]!.effectiveFrom);
      expect(Date.parse(after!.patterns[1]!.effectiveFrom)).toBe(Date.parse(`${from}T00:00:00+03:00`));
      expect(after!.people.map((p) => p.userId)).toContain(USERS.platformAdmin);

      // Anyone else is refused before the database is asked, recorded with the command and outcome only.
      for (const user of ["grcDirector", "complianceManager"] as const) {
        const c = ctxFor(user);
        expect(
          outcome(
            await admin.setWeekPattern(c, actors[user], {
              nonWorkingDays: ["5", "6"],
              effectiveFrom: plusDays(today, 60),
              reason: REASON,
            }),
          ),
          user,
        ).toBe("FORBIDDEN");
        expect(await eventsOf(s, c.requestId), user).toEqual([
          {
            action: "COMMAND_DENIED",
            object_type: "command",
            object_id: null,
            metadata: { command: "set_business_week_pattern", outcome: "FORBIDDEN" },
          },
        ]);
      }
    });
  });
});
