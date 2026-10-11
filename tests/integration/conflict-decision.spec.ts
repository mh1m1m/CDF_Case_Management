// UX redesign S1, RC-10 (UX-016): deciding a declared conflict through the real service, gateway and database.
// Today's rules as api.decide_conflict enforces them: CONFLICT_MANAGE, the case visible to the decider, never
// the declarant, a reason, and an audit event in the same transaction. Each test runs in one owner-connection
// transaction that is rolled back; the gateway runs inside a savepoint of it.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createInvestigationService, type InvestigationService } from "@cdf/application";
import type { Actor } from "@cdf/contracts";
import { PostgresInvestigationGateway, PostgresSecurityEventSink, type Sql } from "@cdf/infrastructure";
import { USERS, caseId, ownerScenario, type OwnerScenario, type UserKey } from "../support/db";

const REASON = "Synthetic conflict decision reason.";
const ctxFor = (user: UserKey) => ({ userId: USERS[user], requestId: randomUUID() });

function serviceIn(s: OwnerScenario): InvestigationService {
  const sql = {
    begin: (fn: (tx: unknown) => Promise<unknown>) => s.tx.savepoint(fn as never),
  } as unknown as Sql;
  return createInvestigationService({
    gateway: new PostgresInvestigationGateway(sql),
    securityEvents: new PostgresSecurityEventSink(sql),
  });
}
async function actorIn(service: InvestigationService, user: UserKey): Promise<Actor> {
  const a = await service.loadActor(ctxFor(user));
  if (!a) throw new Error(`no actor for ${user}`);
  return a;
}
function outcome(r: { ok: boolean }): string {
  if (r.ok) return "ok";
  if ("error" in r) return (r as { error: { kind: string } }).error.kind;
  return "fieldErrors";
}

describe("deciding a declared conflict (RC-10)", () => {
  it("lets a conflict manager who can see the case confirm or clear it, with a reason, and audits it", async () => {
    const caseA = await caseId("0001");
    await ownerScenario(async (s) => {
      const service = serviceIn(s);
      const investigator = await actorIn(service, "investigatorA");
      expect(
        outcome(
          await service.declareConflict(ctxFor("investigatorA"), investigator, {
            caseId: caseA,
            hasConflict: true,
            declaration: "Synthetic: related to a party in this case.",
          }),
        ),
      ).toBe("ok");

      const manager = await actorIn(service, "caseManager");
      const pending = await service.pendingConflicts(ctxFor("caseManager"), manager, caseA);
      expect(pending.map((p) => p.userId)).toEqual([USERS.investigatorA]);
      // Nobody without CONFLICT_MANAGE sees the queue.
      const lead = await actorIn(service, "lead");
      expect(await service.pendingConflicts(ctxFor("lead"), lead, caseA)).toEqual([]);

      // A short reason or an unknown decision never reaches the database.
      const base = { caseId: caseA, conflictId: pending[0]!.id };
      expect(
        outcome(
          await service.decideConflict(ctxFor("caseManager"), manager, {
            ...base,
            decision: "CONFLICT_CLEARED",
            reason: "short",
          }),
        ),
      ).toBe("fieldErrors");
      expect(
        outcome(
          await service.decideConflict(ctxFor("caseManager"), manager, {
            ...base,
            decision: "NO_CONFLICT",
            reason: REASON,
          }),
        ),
      ).toBe("fieldErrors");

      expect(
        outcome(
          await service.decideConflict(ctxFor("caseManager"), manager, {
            ...base,
            decision: "CONFLICT_CONFIRMED",
            reason: REASON,
          }),
        ),
      ).toBe("ok");
      expect(await service.pendingConflicts(ctxFor("caseManager"), manager, caseA)).toEqual([]);

      await s.asOwner();
      const [audit] = await s.tx<{ n: number }[]>`
        select count(*)::int as n from audit.audit_event
        where action = 'CONFLICT_DECIDED' and case_id = ${caseA} and actor_id = ${USERS.caseManager}`;
      expect(audit!.n).toBe(1);
    });
  });

  it("refuses a decider without CONFLICT_MANAGE before the database, and records the denial", async () => {
    const caseA = await caseId("0001");
    await ownerScenario(async (s) => {
      const service = serviceIn(s);
      await service.declareConflict(ctxFor("investigatorA"), await actorIn(service, "investigatorA"), {
        caseId: caseA,
        hasConflict: true,
        declaration: "Synthetic: related to a party in this case.",
      });
      await s.asOwner();
      const [k] = await s.tx<{ id: string }[]>`
        select id from case_mgmt.conflict_check where case_id = ${caseA} and is_current and status = 'CONFLICT_DECLARED'`;
      const ctx = ctxFor("lead");
      const r = await service.decideConflict(ctx, await actorIn(service, "lead"), {
        caseId: caseA,
        conflictId: k!.id,
        decision: "CONFLICT_CLEARED",
        reason: REASON,
      });
      expect(outcome(r)).toBe("FORBIDDEN");
      await s.asOwner();
      const denied = await s.tx<{ command: string }[]>`
        select metadata->>'command' as command from audit.audit_event
        where action = 'COMMAND_DENIED' and request_id = ${ctx.requestId}`;
      expect(denied.map((d) => d.command)).toEqual(["decide_conflict"]);
    });
  });

  it("answers not-found for a conflict on a case the decider cannot see", async () => {
    const caseSecret = await caseId("0003");
    await ownerScenario(async (s) => {
      const service = serviceIn(s);
      // The restricted SECRET case's named authority declares a conflict on it.
      await service.declareConflict(ctxFor("grcDirector"), await actorIn(service, "grcDirector"), {
        caseId: caseSecret,
        hasConflict: true,
        declaration: "Synthetic: related to a party in this case.",
      });
      await s.asOwner();
      const [k] = await s.tx<{ id: string }[]>`
        select id from case_mgmt.conflict_check
        where case_id = ${caseSecret} and is_current and status = 'CONFLICT_DECLARED'`;
      for (const user of ["caseManager", "grcDeputy"] as UserKey[]) {
        const a = await actorIn(service, user);
        expect(await service.pendingConflicts(ctxFor(user), a, caseSecret), user).toEqual([]);
        const r = await service.decideConflict(ctxFor(user), a, {
          caseId: caseSecret,
          conflictId: k!.id,
          decision: "CONFLICT_CLEARED",
          reason: REASON,
        });
        expect(outcome(r), user).toBe("NOT_FOUND");
      }
    });
  });
});
