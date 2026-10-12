// UX redesign S1 (CDF-117, CDF-121, CDF-172) through the real investigation service, gateway and database: the
// sidebar areas, My Work and My access, and the read-only Oversight ledger and Administration register. Reads only,
// so the tests use the BFF pool directly. The SQL-level negatives live in tests/security/my-work-read-models.spec.ts.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createInvestigationService } from "@cdf/application";
import { shellAreas } from "@cdf/authorization";
import type { Actor } from "@cdf/contracts";
import { PostgresInvestigationGateway, PostgresSecurityEventSink } from "@cdf/infrastructure";
import { USERS, bff, type UserKey } from "../support/db";

const service = createInvestigationService({
  gateway: new PostgresInvestigationGateway(bff),
  securityEvents: new PostgresSecurityEventSink(bff),
});
const ctxFor = (user: UserKey) => ({ userId: USERS[user], requestId: randomUUID() });
async function actor(user: UserKey): Promise<Actor> {
  const a = await service.loadActor(ctxFor(user));
  if (!a) throw new Error(`no actor for ${user}`);
  return a;
}

describe("shell read models through the service", () => {
  it("maps areas, items and access with the pre-check applied", async () => {
    const a = await actor("investigatorA");
    const areas = shellAreas(a, await service.myAreas(ctxFor("investigatorA")));
    expect(areas.map((x) => x.area)).toEqual(["MY_WORK", "CASES"]);
    expect(areas.find((x) => x.area === "CASES")?.defaultView).toBe("my-cases");

    const items = await service.myWorkItems(ctxFor("investigatorA"));
    const mine = items.filter((i) => i.view === "MY_CASES");
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      category: "MY_CASE",
      targetType: "CASE",
      caseNumber: "CDF-DEMO-2026-0001",
    });
    expect(Number.isNaN(Date.parse(mine[0]!.sinceAt!))).toBe(false);

    const access = await service.myAccess(ctxFor("investigatorA"));
    expect(access.map((x) => x.basis)).toEqual(["CLEARANCE", "ROLE", "ASSIGNMENT"]);
  });

  it("gives the platform administrator Administration only, and a register with no case data", async () => {
    const a = await actor("platformAdmin");
    expect(shellAreas(a, await service.myAreas(ctxFor("platformAdmin"))).map((x) => x.area)).toEqual([
      "ADMINISTRATION",
    ]);
    expect(await service.myWorkItems(ctxFor("platformAdmin"))).toEqual([]);
    const register = await service.userRegister(ctxFor("platformAdmin"), a);
    const investigator = register.find((u) => u.id === USERS.investigatorA);
    expect(investigator?.roles).toEqual(["INVESTIGATOR"]);
    expect(Object.keys(investigator!).sort()).toEqual(
      ["department", "displayName", "displayNameAr", "email", "id", "roles", "status"].sort(),
    );
    // The ledger is not the administrator's (no AUDIT_VIEW).
    expect(await service.auditLedger(ctxFor("platformAdmin"), a, "ledger")).toEqual([]);
  });

  it("refuses the register to anyone without USER_ADMIN or ROLE_ADMIN", async () => {
    for (const user of ["investigatorA", "internalAudit", "grcDirector"] as UserKey[])
      expect(await service.userRegister(ctxFor(user), await actor(user)), user).toEqual([]);
  });

  it("shows the internal auditor ledger metadata only, and the SOC analyst security events only", async () => {
    const auditor = await actor("internalAudit");
    const ledger = await service.auditLedger(ctxFor("internalAudit"), auditor, "ledger");
    expect(ledger.length).toBeGreaterThan(0);
    expect(ledger.every((e) => e.category === "BUSINESS" || e.category === "ADMIN")).toBe(true);
    expect(Object.keys(ledger[0]!).sort()).toEqual(
      ["action", "actorRoles", "actorType", "category", "objectType", "occurredAt", "outcome", "seq"].sort(),
    );
    expect(await service.auditLedger(ctxFor("internalAudit"), auditor, "security-events")).toEqual([]);
    expect(await service.auditChainBreaks(ctxFor("internalAudit"), auditor)).toBe(0);

    const soc = await actor("soc");
    expect(await service.auditLedger(ctxFor("soc"), soc, "ledger")).toEqual([]);
    const events = await service.auditLedger(ctxFor("soc"), soc, "security-events");
    expect(events.every((e) => e.category === "SECURITY")).toBe(true);

    const investigator = await actor("investigatorA");
    expect(await service.auditLedger(ctxFor("investigatorA"), investigator, "ledger")).toEqual([]);
    expect(await service.auditChainBreaks(ctxFor("investigatorA"), investigator)).toBeNull();
  });
});
