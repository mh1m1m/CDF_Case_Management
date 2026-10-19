// The two-person lift of a case's restricted status (migration 2130, ADR-049; DEC-AMB-012 → C) through the real
// service, gateway, database, RLS and audit, with the negatives the coordinator's ruling of 19 Oct 01:42 requires for
// its points (1) to (5). Each test runs in one owner-connection transaction that is rolled back: the gateway runs its
// security context inside a savepoint of that transaction, as it does on its own pool, so no case, request or setting
// reaches the seed. Synthetic data only. The database side in full is tests/security/restricted-case-authority.spec.ts
// (T-AMB-145); there is no page yet (UX owns it), so no end-to-end test.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createRestrictionLiftService, type RestrictionLiftService } from "@cdf/application";
import { PostgresRestrictionLiftGateway, PostgresSecurityEventSink, type Sql } from "@cdf/infrastructure";
import { USERS, ownerScenario, reportId, type OwnerScenario, type UserKey } from "../support/db";

const REASON = "Synthetic: the restriction is no longer needed.";
const DECISION = "Synthetic: the preview and the reason were checked.";
const ctxFor = (user: UserKey) => ({ userId: USERS[user], requestId: randomUUID() });

/** The restriction-lift service bound to the scenario's transaction (each call runs in a savepoint). */
function liftIn(s: OwnerScenario): RestrictionLiftService {
  const sql = {
    begin: (fn: (tx: unknown) => Promise<unknown>) => s.tx.savepoint(fn as never),
  } as unknown as Sql;
  return createRestrictionLiftService({
    gateway: new PostgresRestrictionLiftGateway(sql),
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

function value<T>(r: { ok: boolean }): T {
  if (!r.ok) throw new Error(`expected ok, got ${outcome(r)}`);
  return (r as unknown as { value: T }).value;
}

async function denials(s: OwnerScenario, requestId: string): Promise<string[]> {
  await s.asOwner();
  const rows = await s.tx<{ command: string; outcome: string }[]>`
    select metadata->>'command' as command, metadata->>'outcome' as outcome from audit.audit_event
    where action = 'COMMAND_DENIED' and request_id = ${requestId} order by seq`;
  return rows.map((r) => `${r.command}:${r.outcome}`);
}

/** The second approver's role (null: SOURCE_REQUIRED, unset) as a migration would set it. */
async function approverRole(s: OwnerScenario, role: string | null) {
  await s.asOwner();
  await s.tx`update config.setting
             set value = ${role}, status = ${role === null ? "SOURCE_REQUIRED" : "CONFIGURED"},
                 source_reference = ${role === null ? null : "Synthetic: test Delegation of Authority"}
             where key = 'RESTRICTION_LIFT_SECOND_APPROVER'`;
}

/** A fresh restricted CONFIDENTIAL case whose authority is the GRC Director; with GRC_DIRECTOR as the second
 *  approver's role, the GRC Deputy (cleared, off the team, no conflict) is its one independent approver. */
async function restrictedCase(s: OwnerScenario, role: string | null = "GRC_DIRECTOR"): Promise<string> {
  await approverRole(s, role);
  const report = await reportId("WB-SEED00000005");
  await s.as("triage");
  await s.tx`select api.triage_report(${report}, 'OPEN_CASE', ${REASON}, null, null)`;
  const [c] = await s.tx<{ id: string }[]>`
    select api.create_case_from_report(${report}, 'Restriction lift case (synthetic)', 'Synthetic lift summary.',
      'CONFIDENTIAL'::core.classification_level, true, ${USERS.grcDirector}::uuid) as id`;
  return c!.id;
}

/** The authority previews and requests on what it was shown. */
async function requested(svc: RestrictionLiftService, caseId: string): Promise<string> {
  const director = ctxFor("grcDirector");
  const { previewHash } = value<{ previewHash: string }>(await svc.preview(director, { caseId }));
  return value<string>(await svc.request(director, { caseId, reason: REASON, previewHash }));
}

/** The approver decides on the preview their queue shows. */
async function decided(svc: RestrictionLiftService, request: string, decision = "APPROVE") {
  const deputy = ctxFor("grcDeputy");
  const row = (await svc.myApprovals(deputy)).find((q) => q.id === request)!;
  return svc.decide(deputy, { requestId: request, decision, reason: DECISION, previewHash: row.previewHash });
}

async function isRestricted(s: OwnerScenario, caseId: string): Promise<boolean> {
  await s.asOwner();
  const [c] = await s.tx<
    { r: boolean }[]
  >`select is_restricted as r from case_mgmt.case_record where id = ${caseId}`;
  return c!.r;
}

describe("the two-person lift of a restricted case (2130, ADR-049; DEC-AMB-012 C)", () => {
  it("the authority previews and requests, an independent approver approves the same preview from a queue that names no case, and the authority lifts", async () => {
    await ownerScenario(async (s) => {
      const c = await restrictedCase(s);
      const svc = liftIn(s);
      const director = ctxFor("grcDirector");
      expect(await svc.status(director, c)).toMatchObject({
        caseId: c,
        isRestricted: true,
        approverRole: "GRC_DIRECTOR",
        capabilities: { mayPreview: true, mayRequest: true },
        requestRefusal: null,
        request: null,
      });
      const { preview } = value<{
        preview: { gates: { gate: string; users: number }[]; usersGaining: number };
      }>(await svc.preview(director, { caseId: c }));
      expect(preview.gates.find((g) => g.gate === "CASE_VIEW_ALL")?.users).toBe(2);
      expect(preview.usersGaining).toBeGreaterThanOrEqual(2);
      const request = await requested(svc, c);

      const queue = await svc.myApprovals(ctxFor("grcDeputy"));
      expect(queue.map((q) => [q.id, q.status, q.capabilities.mayDecide, q.approveRefusal])).toEqual([
        [request, "PENDING", true, null],
      ]);
      expect(JSON.stringify(queue)).not.toContain(c);
      expect(value(await decided(svc, request))).toBe("APPROVED");

      expect((await svc.status(director, c))?.request).toMatchObject({
        id: request,
        status: "APPROVED",
        mine: true,
        reason: REASON,
        capabilities: { mayLift: true, mayWithdraw: true, mayExpire: false },
        liftRefusal: null,
      });
      expect(outcome(await svc.lift(director, { requestId: request }))).toBe("ok");
      expect(await isRestricted(s, c)).toBe(false);
      // An approval is used once.
      expect(outcome(await svc.lift(director, { requestId: request }))).toBe("CONFLICT:APPROVAL_CONSUMED");
      expect(await svc.status(director, c)).toMatchObject({
        isRestricted: false,
        capabilities: { mayPreview: false, mayRequest: false },
        requestRefusal: "CASE_NOT_RESTRICTED",
      });
    });
  });

  it("(1) only the case's authority requests and lifts, and a handover leaves the approved request unusable", async () => {
    await ownerScenario(async (s) => {
      const c = await restrictedCase(s);
      const svc = liftIn(s);
      // Who cannot open the case gets nothing: a null panel and NOT_FOUND, recorded as denials.
      const manager = ctxFor("caseManager");
      expect(await svc.status(manager, c)).toBeNull();
      expect(outcome(await svc.preview(manager, { caseId: c }))).toBe("NOT_FOUND");
      expect(
        outcome(await svc.request(manager, { caseId: c, reason: REASON, previewHash: "0".repeat(64) })),
      ).toBe("NOT_FOUND");
      expect(await denials(s, manager.requestId)).toEqual([
        "preview_restriction_lift:NOT_FOUND",
        "request_restriction_lift:NOT_FOUND",
      ]);

      const request = await requested(svc, c);
      expect(value(await decided(svc, request))).toBe("APPROVED");
      // The approver never lifts.
      const deputy = ctxFor("grcDeputy");
      expect(outcome(await svc.lift(deputy, { requestId: request }))).toBe("FORBIDDEN");
      expect(await denials(s, deputy.requestId)).toEqual(["lift_case_restriction:FORBIDDEN"]);
      // The authority hands the case over to the GRC Deputy: the requester is no longer its authority, and the new
      // authority did not make the request. Nobody can use the approval.
      await s.asOwner();
      const [owner] = await s.tx<{ id: string }[]>`
        select id from case_mgmt.case_assignment where case_id = ${c} and assignment_role = 'CASE_OWNER' and status = 'ACTIVE'`;
      await s.as("grcDirector");
      await s.tx`select api.reassign_case(${owner!.id}, ${USERS.grcDeputy}, 'Synthetic: authority handover.')`;
      const director = ctxFor("grcDirector");
      expect(outcome(await svc.lift(director, { requestId: request }))).toBe("FORBIDDEN");
      expect(outcome(await svc.lift(ctxFor("grcDeputy"), { requestId: request }))).toBe("FORBIDDEN");
      expect((await svc.status(ctxFor("grcDeputy"), c))?.request).toMatchObject({
        id: request,
        mine: false,
        reason: null,
        capabilities: { mayLift: false, mayWithdraw: false },
        liftRefusal: "FORBIDDEN",
      });
      expect(await isRestricted(s, c)).toBe(true);
    });
  });

  it("(2) the second approver is independent: never the requester, never the authority, never on the team or conflicted", async () => {
    await ownerScenario(async (s) => {
      const c = await restrictedCase(s);
      const svc = liftIn(s);
      const request = await requested(svc, c);
      const hash = (await svc.myApprovals(ctxFor("grcDeputy")))[0]!.previewHash;
      // The requester holds the approver's role too, and is refused their own second approval.
      const director = ctxFor("grcDirector");
      expect(await svc.myApprovals(director)).toEqual([]);
      expect(
        outcome(
          await svc.decide(director, {
            requestId: request,
            decision: "APPROVE",
            reason: DECISION,
            previewHash: hash,
          }),
        ),
      ).toBe("CONFLICT:REQUESTER_CANNOT_APPROVE");
      // On the case's team: no longer an approver, so the request is not found.
      await s.asOwner();
      const [team] = await s.tx<{ id: string }[]>`
        insert into case_mgmt.case_assignment (case_id, user_id, assignment_role, reason, assigned_by)
        values (${c}, ${USERS.grcDeputy}, 'REVIEWER', 'Synthetic: on the team.', ${USERS.grcDirector}) returning id`;
      const deputy = ctxFor("grcDeputy");
      expect(await svc.myApprovals(deputy)).toEqual([]);
      expect(
        outcome(
          await svc.decide(deputy, {
            requestId: request,
            decision: "APPROVE",
            reason: DECISION,
            previewHash: hash,
          }),
        ),
      ).toBe("NOT_FOUND");
      expect(await denials(s, deputy.requestId)).toEqual(["decide_restriction_lift:NOT_FOUND"]);
      await s.asOwner();
      await s.tx`update case_mgmt.case_assignment set status = 'ENDED', ended_at = now() where id = ${team!.id}`;
      // A declared conflict on the case: likewise.
      const [conflict] = await s.tx<{ id: string }[]>`
        insert into case_mgmt.conflict_check (case_id, user_id, status, declaration)
        values (${c}, ${USERS.grcDeputy}, 'CONFLICT_DECLARED', 'Synthetic: a declared conflict.') returning id`;
      expect(await svc.myApprovals(ctxFor("grcDeputy"))).toEqual([]);
      expect(
        outcome(
          await svc.decide(ctxFor("grcDeputy"), {
            requestId: request,
            decision: "APPROVE",
            reason: DECISION,
            previewHash: hash,
          }),
        ),
      ).toBe("NOT_FOUND");
      // Eligible again, the approver approves; a conflict declared before the lift refuses it (condition c).
      await s.asOwner();
      await s.tx`update case_mgmt.conflict_check set is_current = false where id = ${conflict!.id}`;
      expect(value(await decided(svc, request))).toBe("APPROVED");
      await s.asOwner();
      await s.tx`insert into case_mgmt.conflict_check (case_id, user_id, status, declaration)
                 values (${c}, ${USERS.grcDeputy}, 'CONFLICT_DECLARED', 'Synthetic: declared after approving.')`;
      expect(outcome(await svc.lift(ctxFor("grcDirector"), { requestId: request }))).toBe(
        "CONFLICT:APPROVER_NOT_ELIGIBLE",
      );
      expect(await isRestricted(s, c)).toBe(true);
    });
  });

  it("(3) with the second approver's role unset (SOURCE_REQUIRED) nothing can be requested, and nothing pends", async () => {
    await ownerScenario(async (s) => {
      const c = await restrictedCase(s, null);
      const svc = liftIn(s);
      const director = ctxFor("grcDirector");
      expect(await svc.status(director, c)).toMatchObject({
        approverRole: null,
        capabilities: { mayPreview: true, mayRequest: false },
        requestRefusal: "LIFT_APPROVER_NOT_CONFIGURED",
      });
      const { previewHash } = value<{ previewHash: string }>(await svc.preview(director, { caseId: c }));
      expect(outcome(await svc.request(director, { caseId: c, reason: REASON, previewHash }))).toBe(
        "CONFLICT:LIFT_APPROVER_NOT_CONFIGURED",
      );
      // A role no application may use for it reads as unset too.
      for (const role of ["PLATFORM_ADMIN", "DB_ADMIN", "NO_SUCH_ROLE"]) {
        await approverRole(s, role);
        expect(outcome(await svc.request(director, { caseId: c, reason: REASON, previewHash }))).toBe(
          "CONFLICT:LIFT_APPROVER_NOT_CONFIGURED",
        );
      }
      // A conflict is not a denial; nothing was created or queued.
      expect(await denials(s, director.requestId)).toEqual([]);
      expect(await svc.myApprovals(ctxFor("grcDeputy"))).toEqual([]);
      await s.asOwner();
      expect(await s.tx`select id from case_mgmt.restriction_lift_request where case_id = ${c}`).toEqual([]);
      expect(await isRestricted(s, c)).toBe(true);
    });
  });

  it("(4) an export waiting for the authority's consent blocks the request and the lift", async () => {
    await ownerScenario(async (s) => {
      const c = await restrictedCase(s);
      const svc = liftIn(s);
      await s.as("grcDirector");
      await s.tx`select api.grant_case_access(${c}, ${USERS.caseManager}, 'CASE', ${REASON})`;
      const exportAwaiting = async () => {
        await s.as("caseManager");
        const [q] = await s.tx<{ id: string }[]>`
          select api.create_export_request(${c}, 'PDF', 'INTERNAL', 'INTERNAL_MANAGEMENT_REVIEW', null, null) as id`;
        await s.tx`select api.add_export_item(${q!.id}, 'CASE_SUMMARY', ${c})`;
        const [p] = await s.tx<{ p: { hash: string } }[]>`select api.preview_export(${q!.id}) as p`;
        await s.tx`select api.submit_export(${q!.id}, ${p!.p.hash}, 'CONFIDENTIAL'::core.classification_level)`;
        return q!.id;
      };
      const refuseExport = async (exportId: string) => {
        await s.as("grcDirector");
        const [p] = await s.tx<{ p: { hash: string } }[]>`select api.preview_export(${exportId}) as p`;
        await s.tx`select api.decide_restricted_export(${exportId}, 'REJECT', ${REASON}, ${p!.p.hash})`;
      };
      const first = await exportAwaiting();
      const director = ctxFor("grcDirector");
      expect(await svc.status(director, c)).toMatchObject({
        capabilities: { mayRequest: false },
        requestRefusal: "RESTRICTED_APPROVALS_PENDING",
      });
      const { previewHash } = value<{ previewHash: string }>(await svc.preview(director, { caseId: c }));
      expect(outcome(await svc.request(director, { caseId: c, reason: REASON, previewHash }))).toBe(
        "CONFLICT:RESTRICTED_APPROVALS_PENDING",
      );
      await refuseExport(first);
      const request = await requested(svc, c);
      expect(value(await decided(svc, request))).toBe("APPROVED");
      const second = await exportAwaiting();
      expect(outcome(await svc.lift(ctxFor("grcDirector"), { requestId: request }))).toBe(
        "CONFLICT:RESTRICTED_APPROVALS_PENDING",
      );
      expect(await isRestricted(s, c)).toBe(true);
      await refuseExport(second);
      expect(outcome(await svc.lift(ctxFor("grcDirector"), { requestId: request }))).toBe("ok");
      expect(await isRestricted(s, c)).toBe(false);
    });
  });

  it("(5) the preview is bound: a stale hash at the request, a change before the approval and a change before the lift are each refused", async () => {
    await ownerScenario(async (s) => {
      const c = await restrictedCase(s);
      const svc = liftIn(s);
      const director = ctxFor("grcDirector");
      expect(
        outcome(await svc.request(director, { caseId: c, reason: REASON, previewHash: "0".repeat(64) })),
      ).toBe("CONFLICT:PREVIEW_CHANGED");
      const request = await requested(svc, c);
      // Someone new would gain the case: a CASE_VIEW_ALL role for Investigator Beta.
      const grantRole = async () => {
        await s.asOwner();
        const [a] = await s.tx<{ id: string }[]>`
          insert into iam.user_role_assignment (user_id, role_code, justification)
          values (${USERS.investigatorB}, 'CASE_MANAGER', 'Synthetic: preview probe.') returning id`;
        return a!.id;
      };
      const endRole = async (id: string) => {
        await s.asOwner();
        await s.tx`update iam.user_role_assignment set status = 'REVOKED', revoked_at = now() where id = ${id}`;
      };
      let role = await grantRole();
      expect((await svc.myApprovals(ctxFor("grcDeputy")))[0]).toMatchObject({
        approveRefusal: "PREVIEW_CHANGED",
      });
      expect(outcome(await decided(svc, request))).toBe("CONFLICT:PREVIEW_CHANGED");
      await endRole(role);
      expect(value(await decided(svc, request))).toBe("APPROVED");
      role = await grantRole();
      expect(outcome(await svc.lift(ctxFor("grcDirector"), { requestId: request }))).toBe(
        "CONFLICT:PREVIEW_CHANGED",
      );
      expect((await svc.status(ctxFor("grcDirector"), c))?.request).toMatchObject({
        capabilities: { mayLift: false, mayWithdraw: true },
        liftRefusal: "PREVIEW_CHANGED",
      });
      expect(await isRestricted(s, c)).toBe(true);
      // The requester withdraws the unusable approval and may ask again on the new preview.
      expect(outcome(await svc.withdraw(ctxFor("grcDirector"), { requestId: request }))).toBe("ok");
      expect(await svc.status(ctxFor("grcDirector"), c)).toMatchObject({
        capabilities: { mayRequest: true },
      });
      await endRole(role);
    });
  });
});
