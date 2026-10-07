// CDF-73 / ADR-014 §28.8: the UI pre-checks (@cdf/authorization), the application services (API) and the
// database (RLS + authz.*) give the same answers. Read-only against the seed: nothing here is committed
// except the audit events of the lookup, which the database writes by design.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createInvestigationService } from "@cdf/application";
import {
  canApplyLegalHold,
  canManageRetention,
  canViewCaseContent,
  canViewCaseMetadata,
  navigationFor,
  type CaseAccessContext,
} from "@cdf/authorization";
import type { Actor, Classification, RecordsState } from "@cdf/contracts";
import { PostgresInvestigationGateway, PostgresSecurityEventSink } from "@cdf/infrastructure";
import { admin, bff, scenario, USERS, type UserKey } from "../support/db";

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

async function contextFor(user: UserKey, caseId: string): Promise<CaseAccessContext> {
  const u = USERS[user];
  const [c] = await admin<
    {
      classification: Classification;
      is_restricted: boolean;
      records_state: RecordsState;
      conflict: boolean;
      assignment: boolean;
      grant_: boolean;
      bg: boolean;
    }[]
  >`
    select c.classification, c.is_restricted, c.records_state,
           authz.has_conflict(c.id, ${u}) as conflict, authz.has_active_assignment(c.id, ${u}) as assignment,
           authz.has_active_grant(c.id, ${u}) as grant_, authz.has_active_break_glass(c.id, ${u}) as bg
    from case_mgmt.case_record c where c.id = ${caseId}`;
  const tasks = await admin<
    { task_type: string; scope: string[]; status: string; access_granted_at: Date; expires_at: Date }[]
  >`select task_type, scope, status, access_granted_at, expires_at from case_mgmt.case_task
     where case_id = ${caseId} and assigned_user_id = ${u}`;
  return {
    classification: c!.classification,
    isRestricted: c!.is_restricted,
    recordsState: c!.records_state,
    hasConflict: c!.conflict,
    hasAssignment: c!.assignment,
    hasGrant: c!.grant_,
    hasBreakGlass: c!.bg,
    tasks: tasks.map((t) => ({
      taskType: t.task_type as CaseAccessContext["tasks"][number]["taskType"],
      scope: t.scope as CaseAccessContext["tasks"][number]["scope"],
      status: t.status as CaseAccessContext["tasks"][number]["status"],
      accessGrantedAt: t.access_granted_at,
      expiresAt: t.expires_at,
    })),
  };
}

const USERS_UNDER_TEST: UserKey[] = [
  "records",
  "legal",
  "grcDirector",
  "caseManager",
  "investigatorA",
  "internalAudit",
];

describe("UI, API and database agree (CDF-73 §28.8)", () => {
  it("the @cdf/authorization mirror matches authz.* for every seed case and actor", async () => {
    const cases = await admin<{ id: string }[]>`select id from case_mgmt.case_record order by case_number`;
    for (const user of USERS_UNDER_TEST) {
      const a = await actor(user);
      for (const { id } of cases) {
        const ctx = await contextFor(user, id);
        let db: Record<string, boolean> = {};
        await scenario(async (s) => {
          await s.as(user);
          const [row] = await s.tx<Record<string, boolean>[]>`
            select authz.can_view_case(${id}) as content, authz.can_view_case_metadata(${id}) as metadata,
                   authz.can_apply_legal_hold(${id}) as apply, authz.can_manage_retention(${id}) as retention`;
          db = row!;
        });
        expect(
          {
            content: canViewCaseContent(a, ctx),
            metadata: canViewCaseMetadata(a, ctx),
            apply: canApplyLegalHold(a, ctx),
            retention: canManageRetention(a, ctx),
          },
          `${user} on ${id}`,
        ).toEqual(db);
      }
    }
  });

  it("the catalogue search and dashboards return only what the database lets the caller see", async () => {
    for (const user of ["records", "legal"] as const) {
      const ctx = ctxFor(user);
      const a = await actor(user);
      const result = await investigation.searchRecordsCatalogue(ctx, a, { caseNumber: "CDF-DEMO" });
      if (!result.ok) throw new Error(JSON.stringify(result));
      let sql: string[] = [];
      await scenario(async (s) => {
        await s.as(user);
        sql = (await s.tx<{ case_id: string }[]>`select case_id from records.case_record_catalogue`).map(
          (r) => r.case_id,
        );
      });
      expect(result.value.items.map((i) => i.caseId).sort()).toEqual(sql.sort());
      expect(result.value.total).toBe(sql.length);
      for (const item of result.value.items) {
        expect(Object.keys(item)).not.toEqual(expect.arrayContaining(["title"]));
      }
      const summary = await investigation.myWorkSummary(ctx);
      const tasks = await investigation.myCaseTasks(ctx);
      expect(summary.assignedLegalHolds + summary.myRetentionTasks + summary.myDispositionTasks).toBe(
        tasks.filter((t) => t.taskType !== "LEGAL_REVIEW" && t.taskType !== "ARCHIVE_TRANSFER").length,
      );
      // Navigation never offers an "all investigations" view to these roles.
      expect(navigationFor(a)).toMatchObject({ myWork: true });
      expect(a.permissions).not.toContain("CASE_VIEW_ALL");
    }
  });

  it("the lookup is validated and pre-checked before the database, and refused again by it", async () => {
    const legalB = await actor("legalB");
    const wildcard = await investigation.requestCaseForLegalHold(ctxFor("legalB"), legalB, {
      caseReference: "CDF-DEMO-%",
      justification: "Synthetic: preservation required for a pending synthetic inquiry.",
      reasonCode: "LITIGATION",
    });
    expect(wildcard.ok).toBe(false);
    expect("fieldErrors" in wildcard).toBe(true);

    const investigator = await actor("investigatorA");
    const refused = await investigation.requestCaseForLegalHold(ctxFor("investigatorA"), investigator, {
      caseReference: "CDF-DEMO-2026-9999",
      justification: "Synthetic: preservation required for a pending synthetic inquiry.",
      reasonCode: "LITIGATION",
    });
    expect(refused).toMatchObject({ ok: false, error: { kind: "FORBIDDEN" } });

    // This suite commits its lookup audit events, so a re-run within the hour may hit the rate limit.
    const [recent] = await admin<{ n: number }[]>`
      select count(*)::int as n from audit.audit_event where action = 'CASE_DISCOVERY_REQUESTED'
        and actor_id = ${USERS.legalB} and occurred_at > now() - interval '1 hour'`;
    const miss = await investigation.requestCaseForLegalHold(ctxFor("legalB"), legalB, {
      caseReference: "cdf-demo-2026-9999",
      justification: "Synthetic: preservation required for a pending synthetic inquiry.",
      reasonCode: "LITIGATION",
    });
    if (recent!.n < 5)
      expect(miss).toMatchObject({ ok: true, value: { outcome: "NO_MATCH", requestId: null } });
    else expect(miss).toMatchObject({ ok: false, error: { kind: "RATE_LIMITED" } });
  });
});
