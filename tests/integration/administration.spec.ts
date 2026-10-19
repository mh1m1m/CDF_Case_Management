// Phase 12 P12-8a and P12-8b Administration (ADR-051's P12-8a amendment, ADR-063) through the real service, gateway,
// database, RLS and audit, the way the pages call them. Each test runs in one owner-connection transaction that is rolled back: the
// gateway runs its security context inside a savepoint of that transaction, so no calendar day or week reaches the
// seed. These pin that each page opens exactly where its own permission does, in the application pre-check and again
// in the database; that a refused page is the uniform not-found recorded as ACCESS_DENIED with the page's name only;
// that each register is the seed as recorded, with ids, codes and dates and nothing from a case, not even the count of
// proceedings a seat correction recorded; and that the calendar's two forms run their commands, whose refusals are
// COMMAND_DENIED with the command and outcome only. Since P12-8b: the page list and every control's flag come from
// the database (2127); each form records exactly what its command records, provisional where the form says so; the
// five page rules that narrow a command (a mandatory notice takes no rule, an export rule is for a new code only, a
// policy version is never looser, a committee's rules never change an option that follows a decision, and a
// committee's safeguards are never loosened; coordinator rulings of 2026-10-18 21:17, 23:20 and 23:50) refuse with
// nothing written; and "never looser" is the completion command's own comparison.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  acceptsEvidenceKind,
  createAdministrationService,
  createInvestigationService,
  needsEvidenceReference,
  type AdministrationService,
  type CompletionRule,
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
import { draftPackage, voteOnPackage } from "../support/decision";
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

// ---- P12-8b (ADR-063): the pages' other forms --------------------------------------------------------------------

const REASON_8B = "Synthetic administration test (P12-8b).";

class Undo extends Error {}

/** True when `run` succeeds, with whatever it wrote undone; else the CDF code the database refused it with. */
async function triedThenUndone(s: OwnerScenario, run: () => Promise<unknown>): Promise<true | string> {
  let refused: string | undefined;
  try {
    await s.tx.savepoint(async () => {
      await run();
      throw new Undo();
    });
  } catch (error) {
    if (!(error instanceof Undo)) refused = (error as Error).message;
  }
  if (refused === undefined) return true;
  if (!refused.startsWith("CDF_")) throw new Error(refused);
  return refused;
}

/** Rows of a table, counted on the owner connection. */
async function count(s: OwnerScenario, table: string): Promise<number> {
  await s.asOwner();
  const [r] = await s.tx.unsafe<{ n: number }[]>(`select count(*)::int as n from ${table}`);
  return r!.n;
}

describe("Administration's other forms through the service (Phase 12 P12-8b)", () => {
  it("each page carries the database's list of pages, the same as the application's (F3), and its controls' flags", async () => {
    await ownerScenario(async (s) => {
      const admin = adminIn(s);
      for (const user of PEOPLE)
        expect(await admin.views(ctxFor(user)), user).toEqual(adminViews(actors[user]));
      const eta = actors.platformAdmin;
      const mine = adminViews(eta);
      const calendar = await admin.calendar(ctxFor("platformAdmin"), eta);
      const sectors = await admin.sectors(ctxFor("platformAdmin"), eta);
      const rules = await admin.notificationRules(ctxFor("platformAdmin"), eta);
      const exports = await admin.exportPolicy(ctxFor("platformAdmin"), eta);
      for (const page of [calendar, sectors, rules, exports]) expect(page!.views).toEqual(mine);
      expect(calendar!.capabilities).toEqual({ maySetDay: true, maySetWeekPattern: true });
      expect(sectors!.capabilities).toEqual({ mayCreateSector: true });
      expect(rules!.capabilities).toEqual({ maySetRule: true });
      expect(exports!.capabilities).toEqual({ maySetRule: true, mayAddPurpose: true });
      // A purpose in the catalogue may be changed from its row; a legacy one never (the command's LEGACY_PURPOSE).
      expect(exports!.purposes.map((p) => [p.code, p.maySet])).toEqual(
        exports!.purposes.map((p) => [p.code, !p.isLegacy]),
      );
      const policy = await admin.correctiveActionPolicy(ctxFor("grcDeputy"), actors.grcDeputy);
      expect(policy!.views).toEqual(adminViews(actors.grcDeputy));
      expect(policy!.capabilities).toEqual({ maySetPolicy: true });
      // The roles an escalation step may name: none technical (§21).
      expect(policy!.roles.map((r) => r.code)).not.toEqual(expect.arrayContaining(["PLATFORM_ADMIN"]));
      expect(policy!.roles.map((r) => r.code)).toContain("CASE_MANAGER");
      const committees = await admin.committees(ctxFor("complianceManager"), actors.complianceManager);
      expect(committees!.views).toEqual(adminViews(actors.complianceManager));
      expect(committees!.ruleControls.map((r) => r.mayReviseRuleSet)).toEqual([true, true]);
      expect(committees!.ruleControls.map((r) => r.committeeId).sort()).toEqual(
        committees!.committees.map((c) => c.committeeId).sort(),
      );
    });
  });

  it("the calendar: a day is withdrawn from today on, once, with a reason; a day already past is not", async () => {
    await ownerScenario(async (s) => {
      const admin = adminIn(s);
      const eta = actors.platformAdmin;
      const today = (await admin.calendar(ctxFor("platformAdmin"), eta))!.today;
      const date = plusDays(today, 300);
      expect(
        outcome(
          await admin.setCalendarDay(ctxFor("platformAdmin"), eta, {
            calendarDate: date,
            dayType: "HOLIDAY",
            reason: REASON_8B,
          }),
        ),
      ).toBe("ok");
      await s.asOwner();
      const [past] = await s.tx<{ id: string }[]>`
        insert into config.business_calendar_day (calendar_date, day_type, reason, recorded_by)
        values (${plusDays(today, -3)}::date, 'HOLIDAY', ${REASON_8B}, ${USERS.platformAdmin}) returning id`;
      let page = (await admin.calendar(ctxFor("platformAdmin"), eta))!;
      const day = page.days.find((d) => d.calendarDate === date)!;
      expect(day.mayWithdraw).toBe(true);
      expect(page.days.find((d) => d.dayId === past!.id)!.mayWithdraw).toBe(false);

      const withdraw = (dayId: string) =>
        admin.withdrawCalendarDay(ctxFor("platformAdmin"), eta, { dayId, reason: REASON_8B });
      expect(outcome(await withdraw(past!.id))).toBe("CONFLICT:CALENDAR_DAY_PAST");
      expect(outcome(await withdraw(day.dayId))).toBe("ok");
      expect(outcome(await withdraw(day.dayId))).toBe("CONFLICT:CALENDAR_DAY_WITHDRAWN");
      page = (await admin.calendar(ctxFor("platformAdmin"), eta))!;
      const after = page.days.find((d) => d.dayId === day.dayId)!;
      expect([after.withdrawnBy, after.withdrawReason, after.mayWithdraw]).toEqual([
        USERS.platformAdmin,
        REASON_8B,
        false,
      ]);
      expect(page.days.find((d) => d.dayId === past!.id)!.withdrawnAt).toBeNull();
      // An id the calendar does not have is the not-found, recorded with the command and outcome only.
      const c = ctxFor("platformAdmin");
      expect(
        outcome(await admin.withdrawCalendarDay(c, eta, { dayId: randomUUID(), reason: REASON_8B })),
      ).toBe("NOT_FOUND");
      expect(await eventsOf(s, c.requestId)).toEqual([
        {
          action: "COMMAND_DENIED",
          object_type: "command",
          object_id: null,
          metadata: { command: "withdraw_business_calendar_day", outcome: "NOT_FOUND" },
        },
      ]);
    });
  });

  it("the sectors: a sector is created once per code; a delegation in force is revoked once, with a reason", async () => {
    await ownerScenario(async (s) => {
      const admin = adminIn(s);
      const eta = actors.platformAdmin;
      const sector = { code: "SYN8B", nameEn: "Synthetic sector", nameAr: "قطاع اصطناعي" };
      expect(outcome(await admin.createSector(ctxFor("platformAdmin"), eta, sector))).toBe("ok");
      expect(
        outcome(
          await admin.createSector(ctxFor("platformAdmin"), eta, { ...sector, nameEn: "Another synthetic" }),
        ),
      ).toBe("CONFLICT:SECTOR_CODE_TAKEN");
      let page = (await admin.sectors(ctxFor("platformAdmin"), eta))!;
      expect(
        page.sectors.filter((x) => x.code === "SYN8B").map((x) => [x.nameEn, x.nameAr, x.isActive]),
      ).toEqual([["Synthetic sector", "قطاع اصطناعي", true]]);

      await s.asOwner();
      const [ops] = await s.tx<{ id: string }[]>`select id from iam.sector where code = 'OPS'`;
      await s.as("sectorHead");
      const [d] = await s.tx<{ id: string }[]>`
        select api.delegate_referral_approval(${ops!.id}, ${USERS.employeeB}, now(), now() + interval '7 days',
          'DEMO-DELEGATION-8B', ${REASON_8B}) as id`;
      page = (await admin.sectors(ctxFor("platformAdmin"), eta))!;
      expect(page.delegations.map((x) => [x.delegationId, x.state, x.mayRevoke])).toEqual([
        [d!.id, "IN_FORCE", true],
      ]);
      const revoke = () =>
        admin.revokeDelegation(ctxFor("platformAdmin"), eta, { delegationId: d!.id, reason: REASON_8B });
      expect(outcome(await revoke())).toBe("ok");
      expect(outcome(await revoke())).toBe("CONFLICT:DELEGATION_NOT_ACTIVE");
      page = (await admin.sectors(ctxFor("platformAdmin"), eta))!;
      expect(page.delegations.map((x) => [x.state, x.mayRevoke, x.revokedAt !== null])).toEqual([
        ["ENDED", false, true],
      ]);
    });
  });

  it("the notification rules: a notice is turned on or off from a later date; a mandatory notice and a start before a later rule are refused, with nothing written", async () => {
    await ownerScenario(async (s) => {
      const admin = adminIn(s);
      const eta = actors.platformAdmin;
      const before = (await admin.notificationRules(ctxFor("platformAdmin"), eta))!;
      const today = before.today;
      const gc = before.committees.find((c) => c.code === "GC")!.committeeId;
      const rule = {
        layer: "EVENT_RULE",
        templateCode: "GRIEVANCE_RECEIVED",
        channel: "EMAIL",
        enabled: "on",
        effectiveFrom: plusDays(today, 30),
        reason: REASON_8B,
      };
      const set = (input: Record<string, unknown>) =>
        admin.setNotificationRule(ctxFor("platformAdmin"), eta, input);
      expect(outcome(await set(rule))).toBe("ok");
      expect(
        outcome(
          await set({
            ...rule,
            layer: "COMMITTEE_DEFAULT",
            committeeId: gc,
            channel: "IN_APP",
            enabled: "off",
          }),
        ),
      ).toBe("ok");
      const rows = await count(s, "notify.rule");
      // F8: a start at or before a later rule of the same notice and channel.
      expect(outcome(await set({ ...rule, effectiveFrom: plusDays(today, 20) }))).toBe(
        "CONFLICT:LATER_RULE_EXISTS",
      );
      // A mandatory notice is always sent: no rule changes it.
      const mandatory = before.templates.find((t) => t.isMandatory)!.code;
      expect(
        outcome(await set({ ...rule, templateCode: mandatory, effectiveFrom: plusDays(today, 90) })),
      ).toBe("CONFLICT:MANDATORY_NOTICE");
      expect(outcome(await set({ ...rule, effectiveFrom: today }))).toBe("INVALID:effective_from");
      expect(await count(s, "notify.rule")).toBe(rows);

      const after = (await admin.notificationRules(ctxFor("platformAdmin"), eta))!;
      const of = (layer: string, channel: string) =>
        after.rules
          .filter((r) => r.template === "GRIEVANCE_RECEIVED" && r.layer === layer && r.channel === channel)
          .map((r) => [r.enabled, r.state, r.committeeId]);
      expect(of("EVENT_RULE", "EMAIL")).toEqual([
        [false, "IN_FORCE", null],
        [true, "SCHEDULED", null],
      ]);
      expect(of("COMMITTEE_DEFAULT", "IN_APP")).toEqual([[false, "SCHEDULED", gc]]);
    });
  });

  it("the export rules: a rule for a new code only, provisional; a code already recorded is refused under the command's own lock", async () => {
    await ownerScenario(async (s) => {
      const admin = adminIn(s);
      const eta = actors.platformAdmin;
      const today = (await admin.exportPolicy(ctxFor("platformAdmin"), eta))!.today;
      const rule = {
        code: "SYN_8B_RULE",
        audience: "EXTERNAL",
        minClassification: "CONFIDENTIAL",
        objectType: "MINUTES",
        restrictedOnly: false,
        action: "REFUSE",
        effectiveFrom: plusDays(today, 30),
        reason: REASON_8B,
      };
      const add = (input: Record<string, unknown>) =>
        admin.addExportRule(ctxFor("platformAdmin"), eta, input);
      expect(outcome(await add(rule))).toBe("ok");
      const rows = await count(s, "exchange.approval_rule");
      for (const code of ["SYN_8B_RULE", "EXTERNAL_SECRET"])
        expect(outcome(await add({ ...rule, code, effectiveFrom: plusDays(today, 60) })), code).toBe(
          "CONFLICT:RULE_CODE_EXISTS",
        );
      // NONE would switch a code off: never offered (coordinator ruling on F4).
      expect(outcome(await add({ ...rule, code: "SYN_8B_OFF", action: "NONE" }))).toBe("fieldErrors");
      expect(await count(s, "exchange.approval_rule")).toBe(rows);
      const page = (await admin.exportPolicy(ctxFor("platformAdmin"), eta))!;
      expect(
        page.rules
          .filter((r) => r.code === "SYN_8B_RULE")
          .map((r) => [r.audience, r.minClassification, r.objectType, r.action, r.sourceStatus, r.state]),
      ).toEqual([["EXTERNAL", "CONFIDENTIAL", "MINUTES", "REFUSE", "SOURCE_REQUIRED", "SCHEDULED"]]);
      // The lock the gateway takes before its check is the command's own.
      await s.asOwner();
      const [def] = await s.tx<{ src: string }[]>`
        select pg_get_functiondef('api.set_export_rule(text,text,core.classification_level,text,boolean,text,timestamptz,text,text)'::regprocedure) as src`;
      expect(def!.src).toContain("pg_advisory_xact_lock(hashtext('exchange.approval_rule:' || p_code))");
    });
  });

  it("the export purposes: added and changed at the version read, as the administrator's own entry; a stale version and a legacy purpose are refused, with nothing written", async () => {
    await ownerScenario(async (s) => {
      const admin = adminIn(s);
      const eta = actors.platformAdmin;
      const purpose = {
        code: "SYN_8B_PURPOSE",
        nameEn: "Synthetic purpose",
        nameAr: "غرض اصطناعي",
        requiresJustification: true,
        isActive: false,
        sortOrder: "95",
        reason: REASON_8B,
      };
      const ctx = () => ctxFor("platformAdmin");
      expect(outcome(await admin.addExportPurpose(ctx(), eta, purpose))).toBe("ok");
      const read = async (code: string) =>
        (await admin.exportPolicy(ctx(), eta))!.purposes.find((p) => p.code === code)!;
      expect(await read("SYN_8B_PURPOSE")).toMatchObject({
        nameEn: "Synthetic purpose",
        isActive: false,
        sortOrder: 95,
        sourceStatus: "APPROVED",
        rowVersion: 1,
        maySet: true,
      });
      expect(
        outcome(
          await admin.editExportPurpose(ctx(), eta, {
            ...purpose,
            nameEn: "Synthetic purpose, renamed",
            expectedVersion: "1",
          }),
        ),
      ).toBe("ok");
      const rows = await count(s, "exchange.export_purpose");
      // A change made since the page was read, and a new purpose under a code already in the catalogue (F13).
      expect(
        outcome(
          await admin.editExportPurpose(ctx(), eta, { ...purpose, nameEn: "Stale", expectedVersion: "1" }),
        ),
      ).toBe("CONFLICT:STALE_VERSION");
      expect(outcome(await admin.addExportPurpose(ctx(), eta, { ...purpose, nameEn: "Again" }))).toBe(
        "CONFLICT:STALE_VERSION",
      );
      // A legacy purpose is never changed, at its own version too.
      const legacy = await read("AUDIT");
      expect([legacy.isLegacy, legacy.maySet]).toEqual([true, false]);
      expect(
        outcome(
          await admin.editExportPurpose(ctx(), eta, {
            ...purpose,
            code: "AUDIT",
            expectedVersion: String(legacy.rowVersion),
          }),
        ),
      ).toBe("CONFLICT:LEGACY_PURPOSE");
      expect(await count(s, "exchange.export_purpose")).toBe(rows);
      expect(await read("SYN_8B_PURPOSE")).toMatchObject({
        nameEn: "Synthetic purpose, renamed",
        rowVersion: 2,
      });
      expect(await read("AUDIT")).toEqual(legacy);
      // No path sets a purpose's source status: the command takes none, and records the administrator's own entry.
      await s.asOwner();
      const signatures = await s.tx<{ args: string }[]>`
        select pg_get_function_identity_arguments(p.oid) as args from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'api' and p.proname = 'set_export_purpose'`;
      expect(signatures).toHaveLength(1);
      expect(signatures[0]!.args).not.toMatch(/status/);
    });
  });

  it("the corrective-action policy: a version from a later date with every value, provisional, never looser than a version in force or scheduled", async () => {
    await ownerScenario(async (s) => {
      const admin = adminIn(s);
      const deputy = actors.grcDeputy;
      const ctx = () => ctxFor("grcDeputy");
      const today = (await admin.correctiveActionPolicy(ctx(), deputy))!.today;
      const version = {
        actionType: "GOVERNANCE_REMEDIATION",
        defaultDueDays: "60",
        reminderDaysBefore: "7",
        reminderRepeatDays: "2",
        overdueAfterDays: "1",
        escalateAfterDays: "10",
        completionEvidence: "REFERENCE_REQUIRED",
        allowedEvidenceTypes: ["DOCUMENT", "REVISED_PROCEDURE"],
        escalationSteps: [
          { afterDaysOverdue: "3", recipientKind: "ROLE", roleCode: "CASE_MANAGER" },
          { afterDaysOverdue: "5", recipientKind: "CASE_MANAGERS", roleCode: "" },
        ],
        effectiveFrom: plusDays(today, 30),
        reason: REASON_8B,
      };
      const set = (input: Record<string, unknown>) => admin.setCorrectiveActionPolicy(ctx(), deputy, input);
      const rows = await count(s, "decision.corrective_action_policy");
      // The seeded version needs a reference: a version that does not is looser.
      expect(
        outcome(await set({ ...version, completionEvidence: "NOTE_ONLY", allowedEvidenceTypes: [] })),
      ).toBe("CONFLICT:LOOSER_COMPLETION_EVIDENCE");
      expect(await count(s, "decision.corrective_action_policy")).toBe(rows);
      expect(outcome(await set(version))).toBe("ok");
      const page = (await admin.correctiveActionPolicy(ctx(), deputy))!;
      expect(
        page.policies
          .filter((p) => p.actionType === "GOVERNANCE_REMEDIATION")
          .map((p) => [
            p.state,
            p.sourceStatus,
            p.completionEvidence,
            p.allowedEvidenceTypes,
            p.defaultDueDays,
          ]),
      ).toEqual([
        ["IN_FORCE", "SOURCE_REQUIRED", "REFERENCE_REQUIRED", null, null],
        ["SCHEDULED", "SOURCE_REQUIRED", "REFERENCE_REQUIRED", ["DOCUMENT", "REVISED_PROCEDURE"], 60],
      ]);
      const scheduled = page.policies.find(
        (p) => p.actionType === "GOVERNANCE_REMEDIATION" && p.state === "SCHEDULED",
      )!;
      expect([
        scheduled.reminderDaysBefore,
        scheduled.reminderRepeatDays,
        scheduled.overdueAfterDays,
        scheduled.escalateAfterDays,
      ]).toEqual([7, 2, 1, 10]);
      expect(scheduled.steps.map((x) => [x.afterDaysOverdue, x.recipientKind, x.roleCode])).toEqual([
        [3, "ROLE", "CASE_MANAGER"],
        [5, "CASE_MANAGERS", null],
      ]);
      const later = plusDays(today, 60);
      const after = await count(s, "decision.corrective_action_policy");
      // The scheduled version lists the kinds it accepts: a later one may list only kinds among them.
      for (const allowedEvidenceTypes of [["DOCUMENT", "TRAINING_EVIDENCE"], []])
        expect(outcome(await set({ ...version, allowedEvidenceTypes, effectiveFrom: later }))).toBe(
          "CONFLICT:LOOSER_EVIDENCE_TYPES",
        );
      // Stricter but before the scheduled version: the command's own refusal.
      expect(
        outcome(
          await set({ ...version, allowedEvidenceTypes: ["DOCUMENT"], effectiveFrom: plusDays(today, 20) }),
        ),
      ).toBe("CONFLICT:LATER_POLICY_EXISTS");
      expect(await count(s, "decision.corrective_action_policy")).toBe(after);
      expect(
        outcome(await set({ ...version, allowedEvidenceTypes: ["DOCUMENT"], effectiveFrom: later })),
      ).toBe("ok");
      // The guard reads the versions under the command's own lock.
      await s.asOwner();
      const [def] = await s.tx<{ src: string }[]>`
        select pg_get_functiondef(p.oid) as src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'api' and p.proname = 'set_corrective_action_policy' and p.pronargs = 12`;
      expect(def!.src).toContain(
        "pg_advisory_xact_lock(hashtext('decision.corrective_action_policy:' || p_action_type))",
      );
    });
  });

  it("never looser is the completion command's own comparison: each version accepts exactly the completions the rule says", async () => {
    const [{ ic }, caseB] = await Promise.all([committeeIds(), caseId("0002")]);
    await ownerScenario(async (s) => {
      // An approved corrective item on case 0002 (the sanction withdrawn, so no legal review is needed).
      const f = await draftPackage(s, ic, caseB);
      await s.as("committeeSecretary");
      await s.tx`select api.withdraw_recommendation_item(${f.sanction}, ${REASON_8B})`;
      await voteOnPackage(s, f);
      await s.as("committeeSecretary");
      await s.tx`select api.submit_to_authority(${f.pkg})`;
      await s.tx`select api.record_authority_decision(${f.pkg}, 'CEO', 'APPROVE_AS_RECOMMENDED', now(),
        'Chief Executive (synthetic)', 'MEMO-DEMO-0127', null, ${REASON_8B})`;
      await s.as("platformAdmin");
      await s.tx`select api.grant_role(${USERS.financeEmployee}, 'IMPLEMENTATION_OWNER', 'Synthetic: implementation owner for the test')`;

      const LISTED = "DOCUMENT";
      const UNLISTED = "TRAINING_EVIDENCE";
      const completions: { reference: string | null; kind: string | null }[] = [
        { reference: null, kind: null },
        { reference: "SOP-DEMO-0127 rev 1", kind: null },
        { reference: "SOP-DEMO-0127 rev 1", kind: LISTED },
        { reference: "SOP-DEMO-0127 rev 1", kind: UNLISTED },
      ];
      /** The rule the pages apply: a reference unless NOTE_ONLY; a listed kind where the version lists kinds. */
      const accepts = (v: CompletionRule, c: (typeof completions)[number]) =>
        c.reference === null
          ? !needsEvidenceReference(v.completionEvidence)
          : v.allowedEvidenceTypes === null ||
            (c.kind !== null && acceptsEvidenceKind(v.allowedEvidenceTypes, c.kind));
      const versions: CompletionRule[] = [
        { completionEvidence: "REFERENCE_REQUIRED", allowedEvidenceTypes: null },
        { completionEvidence: "REFERENCE_REQUIRED", allowedEvidenceTypes: [LISTED, "REVISED_PROCEDURE"] },
        { completionEvidence: "NOTE_ONLY", allowedEvidenceTypes: null },
        { completionEvidence: "NOTE_ONLY", allowedEvidenceTypes: [LISTED] },
      ];
      for (const v of versions) {
        const label = JSON.stringify(v);
        const seen: [boolean, boolean][] = [];
        expect(
          await triedThenUndone(s, async () => {
            // The version in force from now, and an action opened under it.
            await s.as("grcDirector");
            await s.tx`select api.set_corrective_action_policy('CORRECTIVE_ACTION', 30, null::int, null::int,
              ${v.completionEvidence}, now(), 'SOURCE_REQUIRED', ${REASON_8B}, null::int, null::int,
              ${v.allowedEvidenceTypes === null ? null : [...v.allowedEvidenceTypes]}::text[], null::jsonb)`;
            await s.as("caseManager");
            const [a] = await s.tx<{ id: string }[]>`
              select api.open_corrective_action(${f.corrective}, 'Synthetic: strengthen approval controls',
                'Synthetic: add a second approver.', ${USERS.financeEmployee},
                (now() at time zone 'Asia/Riyadh')::date + 30) as id`;
            for (const c of completions) {
              const result = await triedThenUndone(s, async () => {
                await s.as("financeEmployee");
                await s.tx`select api.submit_corrective_action_completion(${a!.id}, 'Synthetic: the control is in place.',
                  ${c.reference}, ${c.kind})`;
              });
              if (result !== true)
                expect(result, `${label} ${JSON.stringify(c)}`).toMatch(/^CDF_INVALID:evidence_/);
              seen.push([result === true, accepts(v, c)]);
            }
          }),
          label,
        ).toBe(true);
        expect(seen, label).toHaveLength(completions.length);
        for (const [i, [actual, expected]] of seen.entries())
          expect(actual, `${label} ${JSON.stringify(completions[i])}`).toBe(expected);
      }
    });
  });

  it("the committee rules: a new version from a later date with only the options changed, provisional; an option that follows a decision is never changed, and a safeguard never loosened", async () => {
    await ownerScenario(async (s) => {
      const admin = adminIn(s);
      const cm = actors.complianceManager;
      const ctx = () => ctxFor("complianceManager");
      const before = (await admin.committees(ctx(), cm))!;
      const today = before.today;
      const ic = before.committees.find((c) => c.code === "IC")!.committeeId;
      const gc = before.committees.find((c) => c.code === "GC")!.committeeId;
      const revise = (input: Record<string, unknown>) => admin.reviseCommitteeRuleSet(ctx(), cm, input);
      const base = {
        committeeId: ic,
        committeeKind: "INVESTIGATION",
        effectiveFrom: plusDays(today, 30),
        reason: REASON_8B,
      };
      expect(outcome(await revise({ ...base, minimumNoticeDays: "5", ballotSecrecy: "SECRET_BALLOT" }))).toBe(
        "ok",
      );
      const rows = await count(s, "committee.rule_set");
      expect(
        outcome(await revise({ ...base, minimumNoticeDays: "6", effectiveFrom: plusDays(today, 20) })),
      ).toBe("CONFLICT:RULE_SET_SCHEDULED");
      // Coordinator ruling of 2026-10-18 23:20: an option that follows a decision is refused before the command,
      // whatever else the revision changes, so nothing is written (each value is one the command would take).
      const later = { ...base, minimumNoticeDays: "7", effectiveFrom: plusDays(today, 60) };
      for (const [key, value] of Object.entries({
        quorumType: "MAJORITY_ELIGIBLE",
        quorumValue: null,
        castingVoteEnabled: "off",
        minutesReviewBusinessDays: "5",
        deemedApprovalEnabled: "off",
        noSubstantiveVoteOutcome: "TIED",
        conflictDecider: "SECRETARY",
        actingChairCastingVote: "on",
      }))
        expect(outcome(await revise({ ...later, [key]: value })), key).toBe("CONFLICT:DECIDED_OPTION");
      for (const [key, value] of Object.entries({
        grievanceWindowDays: "45",
        admissibilityDecider: "CHAIR",
        grievanceWindowStartBasis: "ISSUE",
        nonAdmissionDecider: "CHAIR",
      }))
        expect(
          outcome(await revise({ ...later, committeeId: gc, committeeKind: "GRIEVANCE", [key]: value })),
          key,
        ).toBe("CONFLICT:DECIDED_OPTION");
      expect(outcome(await revise({ ...base, effectiveFrom: plusDays(today, 60) }))).toBe("INVALID:changes");
      expect(
        outcome(await revise({ ...base, grievanceCompletionDays: "45", effectiveFrom: plusDays(today, 60) })),
      ).toBe("fieldErrors");
      // Coordinator ruling of 2026-10-18 23:50: a safeguard is never loosened below a version in force or scheduled,
      // alone or beside a change the page may make, on either committee; refused before the command, so nothing is
      // written. The investigation committee's floor is now the version from day 30: five days' notice, a secret
      // ballot, both guards on; the grievance committee's is the version in force: both guards on.
      for (const [committee, loosen] of [
        [{ committeeId: ic, committeeKind: "INVESTIGATION" }, { sanctionRequiresDefenceNotice: "off" }],
        [{ committeeId: ic, committeeKind: "INVESTIGATION" }, { minutesObjectionBlocksDeemed: "off" }],
        [{ committeeId: ic, committeeKind: "INVESTIGATION" }, { ballotSecrecy: "COMMITTEE_AFTER_CLOSE" }],
        [{ committeeId: ic, committeeKind: "INVESTIGATION" }, { minimumNoticeDays: "4" }],
        [{ committeeId: ic, committeeKind: "INVESTIGATION" }, { minimumNoticeDays: null }],
        [{ committeeId: gc, committeeKind: "GRIEVANCE" }, { sanctionRequiresDefenceNotice: "off" }],
        [{ committeeId: gc, committeeKind: "GRIEVANCE" }, { minutesObjectionBlocksDeemed: "off" }],
      ] as const)
        for (const extra of [{}, { dissentNoteAllowed: "off" }])
          expect(
            outcome(
              await revise({
                ...base,
                ...committee,
                ...extra,
                ...loosen,
                effectiveFrom: plusDays(today, 60),
              }),
            ),
            `${committee.committeeKind} ${JSON.stringify({ ...extra, ...loosen })}`,
          ).toBe("CONFLICT:LOOSER_RULE_OPTION");
      expect(await count(s, "committee.rule_set")).toBe(rows);
      // As strict (sent or carried) or stricter is recorded.
      expect(
        outcome(
          await revise({
            ...base,
            minimumNoticeDays: "7",
            ballotSecrecy: "SECRET_BALLOT",
            effectiveFrom: plusDays(today, 60),
          }),
        ),
      ).toBe("ok");
      expect(
        outcome(
          await revise({
            committeeId: gc,
            committeeKind: "GRIEVANCE",
            grievanceCompletionDays: "20",
            dissentNoteAllowed: "off",
            effectiveFrom: plusDays(today, 30),
            reason: REASON_8B,
          }),
        ),
      ).toBe("ok");

      const after = (await admin.committees(ctx(), cm))!;
      const versions = (committeeId: string) =>
        after.ruleSets.filter((r) => r.committeeId === committeeId && r.state !== "ENDED");
      const of = (committeeId: string) =>
        versions(committeeId).map((r) => [
          r.state,
          r.sourceStatus,
          r.minimumNoticeDays,
          r.ballotSecrecy,
          r.dissentNoteAllowed,
          r.grievanceCompletionDays,
          r.minutesObjectionBlocksDeemed,
          r.sanctionRequiresDefenceNotice,
        ]);
      // Every new version carries both guards as the version in force has them.
      expect(of(ic)).toEqual([
        ["IN_FORCE", "OWNER_DEFAULT", null, "COMMITTEE_AFTER_CLOSE", true, null, true, true],
        ["SCHEDULED", "SOURCE_REQUIRED", 5, "SECRET_BALLOT", true, null, true, true],
        ["SCHEDULED", "SOURCE_REQUIRED", 7, "SECRET_BALLOT", true, null, true, true],
      ]);
      expect(of(gc)).toEqual([
        ["IN_FORCE", "OWNER_DEFAULT", null, "COMMITTEE_AFTER_CLOSE", true, null, true, true],
        ["SCHEDULED", "SOURCE_REQUIRED", null, "COMMITTEE_AFTER_CLOSE", false, 20, true, true],
      ]);
      // Each new version keeps every option that follows a decision as the version in force has it.
      const decided = (r: (typeof after.ruleSets)[number]) => [
        r.quorumType,
        r.quorumValue,
        r.castingVoteEnabled,
        r.minutesReviewBusinessDays,
        r.deemedApprovalEnabled,
        r.noSubstantiveVoteOutcome,
        r.conflictDecider,
        r.actingChairCastingVote,
        r.grievanceWindowDays,
        r.admissibilityDecider,
        r.grievanceWindowStartBasis,
        r.nonAdmissionDecider,
      ];
      for (const id of [ic, gc]) {
        const [inForce, ...scheduled] = versions(id);
        expect(scheduled.length).toBeGreaterThan(0);
        for (const later of scheduled) expect(decided(later)).toEqual(decided(inForce!));
      }
      expect(decided(versions(gc)[0]!)).toEqual([
        "MAJORITY_ELIGIBLE",
        null,
        true,
        3,
        true,
        "NO_DECISION",
        "CHAIR",
        false,
        30,
        "SECRETARY",
        "DELIVERY",
        "COMMITTEE",
      ]);
      // The ledger records the options changed, by the command's names, and nothing typed in the reason.
      await s.asOwner();
      const events = await s.tx<{ changes: Record<string, unknown>; metadata: Record<string, unknown> }[]>`
        select metadata->'changes' as changes, metadata from audit.audit_event
        where action = 'COMMITTEE_RULE_SET_CHANGED' and metadata->>'committee_id' in (${ic}, ${gc}) order by seq`;
      expect(events.map((e) => e.changes)).toEqual([
        { minimum_notice_days: 5, ballot_secrecy: "SECRET_BALLOT" },
        { minimum_notice_days: 7, ballot_secrecy: "SECRET_BALLOT" },
        { grievance_completion_days: 20, dissent_note_allowed: false },
      ]);
      expect(JSON.stringify(events.map((e) => e.metadata))).not.toContain(REASON_8B);
    });
  });

  it("every form is refused by the database to a caller the application pre-check would let through, recorded with the command and outcome only", async () => {
    await ownerScenario(async (s) => {
      const admin = adminIn(s);
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
      const { ic } = await committeeIds();
      const from = plusDays(new Date().toISOString().slice(0, 10), 30);
      const forms: [string, string, (c: ReturnType<typeof ctxFor>) => Promise<{ ok: boolean }>][] = [
        [
          "withdraw_business_calendar_day",
          "FORBIDDEN",
          (c) => admin.withdrawCalendarDay(c, forged, { dayId: randomUUID(), reason: REASON_8B }),
        ],
        [
          "create_sector",
          "FORBIDDEN",
          (c) => admin.createSector(c, forged, { code: "SYN8BX", nameEn: "Forged", nameAr: "مزوّر" }),
        ],
        // A delegation the caller neither made nor holds is not found to them.
        [
          "revoke_referral_delegation",
          "NOT_FOUND",
          (c) => admin.revokeDelegation(c, forged, { delegationId: randomUUID(), reason: REASON_8B }),
        ],
        [
          "set_notification_rule",
          "FORBIDDEN",
          (c) =>
            admin.setNotificationRule(c, forged, {
              layer: "EVENT_RULE",
              templateCode: "GRIEVANCE_RECEIVED",
              channel: "EMAIL",
              enabled: "on",
              effectiveFrom: from,
              reason: REASON_8B,
            }),
        ],
        [
          "set_export_rule",
          "FORBIDDEN",
          (c) =>
            admin.addExportRule(c, forged, {
              code: "SYN_8B_FORGED",
              audience: "ANY",
              restrictedOnly: true,
              action: "REFUSE",
              effectiveFrom: from,
              reason: REASON_8B,
            }),
        ],
        [
          "set_export_purpose",
          "FORBIDDEN",
          (c) =>
            admin.addExportPurpose(c, forged, {
              code: "SYN_8B_FORGED",
              nameEn: "Forged",
              nameAr: "مزوّر",
              requiresJustification: false,
              isActive: false,
              sortOrder: "99",
              reason: REASON_8B,
            }),
        ],
        [
          "set_corrective_action_policy",
          "FORBIDDEN",
          (c) =>
            admin.setCorrectiveActionPolicy(c, forged, {
              actionType: "CORRECTIVE_ACTION",
              completionEvidence: "REFERENCE_REQUIRED",
              effectiveFrom: from,
              reason: REASON_8B,
            }),
        ],
        [
          "revise_committee_rule_set",
          "FORBIDDEN",
          (c) =>
            admin.reviseCommitteeRuleSet(c, forged, {
              committeeId: ic,
              committeeKind: "INVESTIGATION",
              minimumNoticeDays: "4",
              effectiveFrom: from,
              reason: REASON_8B,
            }),
        ],
      ];
      const ledger = await count(s, "audit.audit_event where category <> 'SECURITY'");
      for (const [command, refusal, run] of forms) {
        const c = ctxFor("investigatorA");
        expect(outcome(await run(c)), command).toBe(refusal);
        expect(await eventsOf(s, c.requestId), command).toEqual([
          {
            action: "COMMAND_DENIED",
            object_type: "command",
            object_id: null,
            metadata: { command, outcome: refusal },
          },
        ]);
      }
      expect(await count(s, "audit.audit_event where category <> 'SECURITY'")).toBe(ledger);
    });
  });
});
