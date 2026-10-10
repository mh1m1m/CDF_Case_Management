// First secure vertical slice (§95): Anonymous Report → Triage → Create Case → Assign Investigator →
// Open Investigation, through the real application services, adapters, database, RLS and audit.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createInvestigationService, createPortalService } from "@cdf/application";
import type { Actor } from "@cdf/contracts";
import {
  PostgresInvestigationGateway,
  PostgresPortalGateway,
  PostgresRateLimiter,
  PostgresSecurityEventSink,
  PrototypeKeyProvider,
} from "@cdf/infrastructure";
import { USERS, admin, bff, portal, type UserKey } from "../support/db";

const keys = new PrototypeKeyProvider(
  "test-only-pepper-not-a-secret-0123456789",
  "test-only-salt-not-a-secret-012345678901",
);
const portalService = createPortalService({
  gateway: new PostgresPortalGateway(portal),
  keys,
  rateLimiter: new PostgresRateLimiter(portal),
});
const investigation = createInvestigationService({
  gateway: new PostgresInvestigationGateway(bff),
  securityEvents: new PostgresSecurityEventSink(bff),
});

const ctxFor = (user: UserKey) => ({ userId: USERS[user], requestId: randomUUID() });
async function actor(user: UserKey): Promise<Actor> {
  const a = await investigation.loadActor(ctxFor(user));
  if (!a) throw new Error(`no actor for ${user}`);
  return a;
}
function ok<T>(r: { ok: true; value: T } | { ok: false }): T {
  if (!r.ok) throw new Error(`command failed: ${JSON.stringify(r)}`);
  return r.value;
}
async function as<T>(user: UserKey, fn: (ctx: ReturnType<typeof ctxFor>, a: Actor) => Promise<T>) {
  return fn(ctxFor(user), await actor(user));
}

describe("first vertical slice", () => {
  it("takes an anonymous report to an open investigation with full authorization and audit", async () => {
    const client = `test-client-${randomUUID()}`;

    // 1. Anonymous submission through the portal.
    const submitted = await portalService.submitReport({ requestId: randomUUID() }, client, {
      relationship: "EMPLOYEE",
      category: "FINANCIAL_CORRUPTION",
      subjectDescription: "Employee Alpha (synthetic)",
      description: "SYNTHETIC: Employee Alpha allegedly split purchase orders to avoid approval thresholds.",
      incidentDate: "2026-09-01",
      incidentTime: "09:30",
      location: "Finance department (synthetic)",
      willingToCooperate: "YES",
      language: "en",
      reporterMode: "ANONYMOUS",
      acknowledgement: true,
    });
    if (!submitted.ok) throw new Error("submission rejected");
    const access = { reportRef: submitted.reportRef, secret: submitted.secret };
    expect((await portalService.getStatus({ requestId: randomUUID() }, client, access))?.status).toBe(
      "RECEIVED",
    );

    // 2. Intake sees it in the queue; the report row carries no identity.
    const queue = await investigation.listIntakeReports(ctxFor("intake"));
    const item = queue.find((r) => r.reportRef === submitted.reportRef)!;
    expect(item).toMatchObject({ reporterMode: "ANONYMOUS", status: "RECEIVED", caseId: null });

    // 3. Triage accepts and opens a case.
    const caseId = await as("triage", async (ctx, a) => {
      ok(
        await investigation.triageReport(ctx, a, {
          reportId: item.id,
          outcome: "OPEN_CASE",
          reason: "Synthetic: specific, credible, in mandate.",
        }),
      );
      const id = ok(
        await investigation.createCase(ctx, a, {
          reportId: item.id,
          title: "Split purchase orders (synthetic)",
          summary: "Synthetic case created by the first-slice integration test.",
          classification: "CONFIDENTIAL",
        }),
      );
      ok(await investigation.transitionCase(ctx, a, { caseId: id, transitionCode: "START_SCREENING" }));
      ok(await investigation.transitionCase(ctx, a, { caseId: id, transitionCode: "COMPLETE_SCREENING" }));
      return id;
    });
    const created = (await investigation.getCase(ctxFor("caseManager"), caseId))!;
    expect(created.caseNumber).toMatch(/^CDF-DEMO-\d{4}-\d{4,5}$/);
    expect(created.currentState).toBe("CONFLICT_CHECK");
    expect((await portalService.getStatus({ requestId: randomUUID() }, client, access))?.status).toBe(
      "IN_PROGRESS",
    );

    // 4. Case manager: priority, conflict declaration, triage, jurisdiction, assignment.
    await as("caseManager", async (ctx, a) => {
      ok(
        await investigation.updateCaseDetails(ctx, a, {
          caseId,
          title: created.title,
          summary: created.summary,
          priority: "HIGH",
          expectedVersion: created.rowVersion,
        }),
      );
      // Stale write is rejected (optimistic concurrency).
      const stale = await investigation.updateCaseDetails(ctx, a, {
        caseId,
        title: created.title,
        summary: created.summary,
        priority: "LOW",
        expectedVersion: created.rowVersion,
      });
      expect(stale).toMatchObject({ ok: false, error: { kind: "CONFLICT" } });
      ok(
        await investigation.declareConflict(ctx, a, {
          caseId,
          hasConflict: false,
          declaration: "Synthetic: no relationship.",
        }),
      );
      ok(await investigation.transitionCase(ctx, a, { caseId, transitionCode: "CLEAR_CONFLICT_CHECK" }));
      ok(await investigation.transitionCase(ctx, a, { caseId, transitionCode: "COMPLETE_TRIAGE" }));
      ok(
        await investigation.transitionCase(ctx, a, {
          caseId,
          transitionCode: "CONFIRM_JURISDICTION",
          reason: "Synthetic: within mandate.",
        }),
      );
      // Approval is blocked until an investigator is assigned.
      const early = await investigation.transitionCase(ctx, a, {
        caseId,
        transitionCode: "APPROVE_INVESTIGATION",
        reason: "Synthetic: approve.",
      });
      expect(early).toMatchObject({
        ok: false,
        error: { kind: "CONFLICT", detail: "NO_INVESTIGATOR_ASSIGNED" },
      });
      ok(
        await investigation.assignCase(ctx, a, {
          caseId,
          userId: USERS.investigatorB,
          assignmentRole: "INVESTIGATOR",
          reason: "Synthetic: available",
        }),
      );
    });

    // 5. The assigned investigator now sees the case; another investigator does not.
    expect(await investigation.getCase(ctxFor("investigatorA"), caseId)).toBeNull();
    const assigned = (await investigation.getCase(ctxFor("investigatorB"), caseId))!;
    expect(assigned.assignments.map((x) => x.userId)).toContain(USERS.investigatorB);
    const approveForB = assigned.transitions.find((t) => t.code === "APPROVE_INVESTIGATION");
    expect(approveForB?.allowed).toBe(false);

    // 6. GRC approval is blocked until the assignee declares no conflict.
    await as("grcDirector", async (ctx, a) => {
      const blocked = await investigation.transitionCase(ctx, a, {
        caseId,
        transitionCode: "APPROVE_INVESTIGATION",
        reason: "Synthetic: approve.",
      });
      expect(blocked).toMatchObject({
        ok: false,
        error: { kind: "CONFLICT", detail: "ASSIGNEE_CONFLICT_DECLARATION_MISSING" },
      });
    });
    await as("investigatorB", async (ctx, a) => {
      ok(
        await investigation.declareConflict(ctx, a, {
          caseId,
          hasConflict: false,
          declaration: "Synthetic: no relationship.",
        }),
      );
      // Investigators cannot assign others.
      const denied = await investigation.assignCase(ctx, a, {
        caseId,
        userId: USERS.investigatorA,
        assignmentRole: "INVESTIGATOR",
        reason: "Synthetic: help",
      });
      expect(denied).toMatchObject({ ok: false, error: { kind: "FORBIDDEN" } });
    });
    await as("grcDirector", async (ctx, a) => {
      expect(
        ok(
          await investigation.transitionCase(ctx, a, {
            caseId,
            transitionCode: "APPROVE_INVESTIGATION",
            reason: "Synthetic: approved for investigation.",
          }),
        ),
      ).toBe("INVESTIGATION");
    });

    // 7. Investigation is open; the timeline and ledger agree.
    const open = (await investigation.getCase(ctxFor("investigatorB"), caseId))!;
    expect(open.currentState).toBe("INVESTIGATION");
    expect(open.openedAt).not.toBeNull();
    const timeline = await investigation.caseTimeline(ctxFor("investigatorB"), caseId);
    const actions = timeline.map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "CASE_CREATED",
        "CASE_ASSIGNED",
        "CONFLICT_DECLARED",
        "WORKFLOW_TRANSITION",
        "CASE_UPDATED",
      ]),
    );
    expect(await admin`select * from audit.verify_chain()`).toEqual([]);

    // 8. Denials were recorded as SECURITY events in their own transactions.
    const [denials] = await admin<{ n: number }[]>`
      select count(*)::int as n from audit.audit_event
      where category = 'SECURITY' and actor_id = ${USERS.investigatorB} and action = 'COMMAND_DENIED' and object_id = ${caseId}`;
    expect(denials!.n).toBe(1);
    const [viewDenied] = await admin<{ n: number }[]>`
      select count(*)::int as n from audit.audit_event where action = 'CASE_ACCESS_DENIED' and actor_id = ${USERS.investigatorA} and object_id = ${caseId}`;
    expect(viewDenied!.n).toBe(1);
  });

  it("the portal never reveals whether a Report ID exists", async () => {
    const client = `test-client-${randomUUID()}`;
    const wrong = await portalService.getStatus({ requestId: randomUUID() }, client, {
      reportRef: "WB-SEED00000001",
      secret: "AAAA-BBBB-CCCC-DDDD-EEEE",
    });
    const unknown = await portalService.getStatus({ requestId: randomUUID() }, client, {
      reportRef: "WB-ZZZZZZZZZZZZ",
      secret: "AAAA-BBBB-CCCC-DDDD-EEEE",
    });
    const garbage = await portalService.getStatus({ requestId: randomUUID() }, client, {
      reportRef: "hello",
      secret: "x",
    });
    expect([wrong, unknown, garbage]).toEqual([null, null, null]);
  });

  it("rate-limits a client at the portal boundary", async () => {
    const client = `test-client-${randomUUID()}`;
    const attempts = [];
    for (let i = 0; i < 31; i++) {
      attempts.push(
        portalService
          .getStatus({ requestId: randomUUID() }, client, { reportRef: "WB-ZZZZZZZZZZZZ", secret: "x" })
          .then(
            () => "ok",
            (e: Error) => e.message,
          ),
      );
    }
    const results = await Promise.all(attempts);
    expect(results.filter((r) => r === "RATE_LIMITED").length).toBeGreaterThanOrEqual(1);
  });
});
