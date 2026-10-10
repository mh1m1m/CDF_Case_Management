// CDF-71 records screens through the real records service, gateway, database, RLS and audit (ADR-013,
// ADR-014). Each test runs in one owner-connection transaction that is rolled back: the gateway runs its
// security context inside a savepoint of that transaction, exactly as it does on its own pool, so fixtures
// (an archived case, a CONFIGURED test class) never reach the seed.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createInvestigationService, createRecordsService, type RecordsService } from "@cdf/application";
import type { Actor } from "@cdf/contracts";
import {
  PostgresInvestigationGateway,
  PostgresRecordsGateway,
  PostgresSecurityEventSink,
  type Sql,
} from "@cdf/infrastructure";
import { USERS, bff, caseId, ownerScenario, type OwnerScenario, type UserKey } from "../support/db";
import { JUSTIFICATION, closeAndArchive, makeEligible } from "../support/records";

const investigation = createInvestigationService({
  gateway: new PostgresInvestigationGateway(bff),
  securityEvents: new PostgresSecurityEventSink(bff),
});
const actors = new Map<UserKey, Actor>();
async function actor(user: UserKey): Promise<Actor> {
  if (!actors.has(user)) {
    const a = await investigation.loadActor({ userId: USERS[user], requestId: randomUUID() });
    if (!a) throw new Error(`no actor for ${user}`);
    actors.set(user, a);
  }
  return actors.get(user)!;
}
const ctxFor = (user: UserKey) => ({ userId: USERS[user], requestId: randomUUID() });
const REASON = "Synthetic decision reason.";

/** The records service bound to the scenario's transaction (each call runs in a savepoint). */
function recordsIn(s: OwnerScenario): RecordsService {
  const sql = {
    begin: (fn: (tx: unknown) => Promise<unknown>) => s.tx.savepoint(fn as never),
  } as unknown as Sql;
  return createRecordsService({
    gateway: new PostgresRecordsGateway(sql),
    securityEvents: new PostgresSecurityEventSink(sql),
  });
}

function outcome(r: { ok: boolean }): string {
  if (r.ok) return "ok";
  if ("error" in r) {
    const e = (r as { error: { kind: string; detail?: string } }).error;
    return e.detail ? `${e.kind}:${e.detail}` : e.kind;
  }
  return "fieldErrors";
}

async function denials(s: OwnerScenario, requestId: string): Promise<string[]> {
  await s.asOwner();
  const rows = await s.tx<{ command: string }[]>`
    select metadata->>'command' as command from audit.audit_event
    where action = 'COMMAND_DENIED' and request_id = ${requestId}`;
  return rows.map((r) => r.command);
}

describe("records screens (CDF-71)", () => {
  it("shows an archived case to the records officer with exactly the actions the database allows", async () => {
    const caseB = await caseId("0002");
    await ownerScenario(async (s) => {
      await closeAndArchive(s, caseB);
      const records = recordsIn(s);
      const ctx = ctxFor("records");
      const r = await records.getRecord(ctx, caseB);
      expect(r).not.toBeNull();
      expect(r!.recordsState).toBe("ARCHIVED");
      expect(r!.capabilities).toEqual({
        manageRetention: true,
        manageDisposition: true,
        approveDisposition: false,
        applyLegalHold: true,
        releaseLegalHold: false,
        requestLegalHold: true,
      });
      // Lifecycle metadata only: no title, summary, people or allegations in the record.
      expect(Object.keys(r!)).not.toEqual(expect.arrayContaining(["title"]));
      expect(JSON.stringify(r)).not.toMatch(/summary|allegation|reporter/i);

      const classes = await records.listRetentionClasses(ctx);
      expect(classes.map((c) => c.code)).not.toContain("UNASSIGNED");
      expect(classes.every((c) => c.status === "SOURCE_REQUIRED")).toBe(true);

      const me = await actor("records");
      expect(
        outcome(
          await records.assignRetentionClass(ctx, me, {
            caseId: caseB,
            retentionClass: "WB_CASE_NOT_INVESTIGATED",
          }),
        ),
      ).toBe("ok");
      expect(
        outcome(
          await records.placeLegalHold(ctx, me, {
            caseId: caseB,
            reasonCode: "LITIGATION",
            justification: JUSTIFICATION,
          }),
        ),
      ).toBe("ok");

      const after = await records.getRecord(ctxFor("records"), caseB);
      expect(after!.recordsState).toBe("RETENTION");
      expect(after!.legalHoldStatus).toBe("ACTIVE");
      expect(after!.holds).toHaveLength(1);
      expect(after!.holds[0]).toMatchObject({
        status: "ACTIVE",
        reasonCode: "LITIGATION",
        pendingRelease: null,
      });
      expect(after!.holds[0]!.holdNumber).toMatch(/^CDF-HOLD-\d{4}-\d{4,5}$/);

      // The view is audited (RECORDS_CASE_METADATA_VIEWED) in the caller's request.
      await s.asOwner();
      const [viewed] = await s.tx<{ n: number }[]>`
        select count(*)::int as n from audit.audit_event
        where action = 'RECORDS_CASE_METADATA_VIEWED' and request_id = ${ctx.requestId}`;
      expect(viewed!.n).toBe(1);
    });
  });

  it("releases a hold under dual control and hides the decision from its requester", async () => {
    const caseB = await caseId("0002");
    await ownerScenario(async (s) => {
      await closeAndArchive(s, caseB);
      const records = recordsIn(s);
      const placed = await records.placeLegalHold(ctxFor("grcDirector"), await actor("grcDirector"), {
        caseId: caseB,
        reasonCode: "AUDIT",
        justification: JUSTIFICATION,
      });
      expect(outcome(placed)).toBe("ok");
      const holdId = (placed as { value: string }).value;

      // The records officer may place holds but not release them: no release form, and the command refuses.
      const asRecords = await records.getRecord(ctxFor("records"), caseB);
      expect(asRecords!.capabilities.releaseLegalHold).toBe(false);
      const refusedCtx = ctxFor("records");
      expect(
        outcome(
          await records.requestHoldRelease(refusedCtx, await actor("records"), {
            holdId,
            justification: JUSTIFICATION,
          }),
        ),
      ).toBe("FORBIDDEN");
      expect(await denials(s, refusedCtx.requestId)).toEqual(["request_legal_hold_release"]);

      const release = await records.requestHoldRelease(ctxFor("grcDirector"), await actor("grcDirector"), {
        holdId,
        justification: JUSTIFICATION,
      });
      expect(outcome(release)).toBe("ok");
      const mine = await records.getRecord(ctxFor("grcDirector"), caseB);
      expect(mine!.holds[0]!.pendingRelease).toMatchObject({ requestedByMe: true });
      // Dual control: the requester's own decision is refused by the database too.
      expect(
        outcome(
          await records.decideHoldRelease(ctxFor("grcDirector"), await actor("grcDirector"), {
            releaseId: (release as { value: string }).value,
            approve: "APPROVE",
            reason: REASON,
          }),
        ),
      ).toBe("FORBIDDEN");
    });
  });

  it("runs request → approval by someone else → logical execution → verified certificate", async () => {
    const caseB = await caseId("0002");
    await ownerScenario(async (s) => {
      await makeEligible(s, caseB);
      const records = recordsIn(s);
      const officer = await actor("records");
      const director = await actor("grcDirector");

      const eligible = await records.getRecord(ctxFor("records"), caseB);
      expect(eligible!.recordsState).toBe("DISPOSITION_ELIGIBLE");
      const requested = await records.requestDisposition(ctxFor("records"), officer, { caseId: caseB });
      expect(outcome(requested)).toBe("ok");
      const requestId = (requested as { value: string }).value;

      const pending = await records.getRecord(ctxFor("records"), caseB);
      expect(pending!.dispositionRequests[0]).toMatchObject({ status: "PENDING", requestedByMe: true });
      // The records officer cannot approve (no DISPOSITION_APPROVE): refused before the database.
      expect(
        outcome(
          await records.decideDisposition(ctxFor("records"), officer, {
            requestId,
            approve: "APPROVE",
            reason: REASON,
          }),
        ),
      ).toBe("FORBIDDEN");

      const asDirector = await records.getRecord(ctxFor("grcDirector"), caseB);
      expect(asDirector!.capabilities.approveDisposition).toBe(true);
      expect(
        outcome(
          await records.decideDisposition(ctxFor("grcDirector"), director, {
            requestId,
            approve: "APPROVE",
            reason: REASON,
          }),
        ),
      ).toBe("ok");
      const executed = await records.executeDisposition(ctxFor("records"), officer, {
        requestId,
        confirm: true,
      });
      expect(outcome(executed)).toBe("ok");

      const disposed = await records.getRecord(ctxFor("records"), caseB);
      expect(disposed!.recordsState).toBe("DISPOSED");
      expect(disposed!.certificateId).toBe((executed as { value: string }).value);
      // Disposed: no hold can be placed or requested; the UI offers none and the database refuses one.
      expect(disposed!.capabilities.applyLegalHold).toBe(false);
      expect(disposed!.capabilities.requestLegalHold).toBe(false);
      expect(
        outcome(
          await records.placeLegalHold(ctxFor("records"), officer, {
            caseId: caseB,
            reasonCode: "LITIGATION",
            justification: JUSTIFICATION,
          }),
        ),
      ).toMatch(/^(FORBIDDEN|CONFLICT:RECORDS_DISPOSED)$/);

      const cert = await records.getCertificate(ctxFor("records"), disposed!.certificateId!);
      expect(cert).toMatchObject({ executionMode: "LOGICAL_ONLY", activeHoldsFound: 0, verified: true });
      expect(cert!.certificateNumber).toMatch(/^CDF-DISP-\d{4}-\d{4,5}$/);
      // Case roles no longer see the case or its certificate.
      expect(await records.getRecord(ctxFor("caseManager"), caseB)).toBeNull();
      expect(await records.getCertificate(ctxFor("caseManager"), disposed!.certificateId!)).toBeNull();
    });
  });

  it("does not let a records officer reach an active case outside the catalogue", async () => {
    const caseA = await caseId("0001");
    await ownerScenario(async (s) => {
      const records = recordsIn(s);
      const ctx = ctxFor("records");
      expect(await records.getRecord(ctx, caseA)).toBeNull();
      expect(await records.getRecord(ctxFor("records"), randomUUID())).toBeNull();
      expect(
        outcome(
          await records.placeLegalHold(ctxFor("records"), await actor("records"), {
            caseId: caseA,
            reasonCode: "LITIGATION",
            justification: JUSTIFICATION,
          }),
        ),
      ).toBe("NOT_FOUND");
      // The refused view is audited as a SECURITY event (CASE_ACCESS_DENIED).
      await s.asOwner();
      const [denied] = await s.tx<{ n: number }[]>`
        select count(*)::int as n from audit.audit_event
        where action = 'CASE_ACCESS_DENIED' and request_id = ${ctx.requestId}`;
      expect(denied!.n).toBe(1);
    });
  });

  it("gives users without records capabilities nothing", async () => {
    const caseB = await caseId("0002");
    await ownerScenario(async (s) => {
      await closeAndArchive(s, caseB);
      const records = recordsIn(s);
      for (const user of ["intake", "platformAdmin", "soc", "dpo"] as const) {
        expect(await records.getRecord(ctxFor(user), caseB)).toBeNull();
        expect(await records.listHoldRequests(ctxFor(user))).toEqual([]);
        const ctx = ctxFor(user);
        expect(
          outcome(
            await records.placeLegalHold(ctx, await actor(user), {
              caseId: caseB,
              reasonCode: "LITIGATION",
              justification: JUSTIFICATION,
            }),
          ),
        ).toBe("FORBIDDEN");
        expect(await denials(s, ctx.requestId)).toEqual(["place_legal_hold"]);
      }
    });
  });

  it("routes a case-team hold request to a legal reviewer, who applies it", async () => {
    const caseA = await caseId("0001");
    await ownerScenario(async (s) => {
      const records = recordsIn(s);
      const requested = await records.requestLegalHold(ctxFor("caseManager"), await actor("caseManager"), {
        caseId: caseA,
        reasonCode: "REGULATORY_INQUIRY",
        justification: JUSTIFICATION,
      });
      expect(outcome(requested)).toBe("ok");
      const requestId = (requested as { value: string }).value;

      // The legal reviewer has no relationship yet: the request and the case are not visible to them.
      expect((await records.listHoldRequests(ctxFor("legal"))).map((r) => r.id)).not.toContain(requestId);
      expect(await records.getRecord(ctxFor("legal"), caseA)).toBeNull();

      const routed = await records.listHoldRequests(ctxFor("grcDirector"));
      expect(routed.find((r) => r.id === requestId)).toMatchObject({
        status: "SUBMITTED",
        origin: "CASE_TEAM",
        caseId: caseA,
        requestedByMe: false,
      });
      expect(
        outcome(
          await records.assignHoldRequest(ctxFor("grcDirector"), await actor("grcDirector"), {
            requestId,
            reviewerId: USERS.legal,
          }),
        ),
      ).toBe("ok");

      const assigned = (await records.listHoldRequests(ctxFor("legal"))).find((r) => r.id === requestId);
      expect(assigned).toMatchObject({
        status: "ASSIGNED",
        assignedToMe: true,
        caseNumber: "CDF-DEMO-2026-0001",
      });
      // Another reviewer cannot decide it.
      expect(
        outcome(
          await records.reviewHoldRequest(ctxFor("legalB"), await actor("legalB"), {
            requestId,
            apply: "APPLY",
            reason: REASON,
          }),
        ),
      ).toBe("NOT_FOUND");
      expect(
        outcome(
          await records.reviewHoldRequest(ctxFor("legal"), await actor("legal"), {
            requestId,
            apply: "APPLY",
            reason: REASON,
          }),
        ),
      ).toBe("ok");
      const after = await records.getRecord(ctxFor("caseManager"), caseA);
      expect(after!.legalHoldStatus).toBe("ACTIVE");
      expect(after!.holdRequests.find((r) => r.id === requestId)?.status).toBe("APPLIED");
    });
  });
});

describe("controlled legal-hold lookup (CDF-71 negatives)", () => {
  it("refuses a lookup without a justification before the database", async () => {
    const legal = await actor("legal");
    const r = await investigation.requestCaseForLegalHold(ctxFor("legal"), legal, {
      caseReference: "CDF-DEMO-2026-0001",
      reasonCode: "LITIGATION",
    });
    expect(outcome(r)).toBe("fieldErrors");
    const short = await investigation.requestCaseForLegalHold(ctxFor("legal"), legal, {
      caseReference: "CDF-DEMO-2026-0001",
      reasonCode: "LITIGATION",
      justification: "short",
    });
    expect(outcome(short)).toBe("fieldErrors");
  });

  it("refuses a lookup without a justification in the database as well", async () => {
    await ownerScenario(async (s) => {
      await s.as("legal");
      await s.expectError(
        "CDF_INVALID",
        (tx) => tx`select * from api.request_case_for_legal_hold('CDF-DEMO-2026-0001', '', 'LITIGATION')`,
      );
      await s.expectError(
        "CDF_INVALID",
        (tx) => tx`select * from api.request_case_for_legal_hold('CDF-DEMO-2026-0001', null, 'LITIGATION')`,
      );
    });
  });
});
