// Records service (CDF-71): validation before the gateway, the permission pre-check, safe error mapping and
// COMMAND_DENIED security events for refusals (REC-T44). The database side is in tests/integration.
import { describe, expect, it } from "vitest";
import type { Actor, Permission } from "@cdf/contracts";
import type { SecurityEvent } from "@cdf/audit";
import { createRecordsService, type RecordsGateway } from "./records";

const CASE = "11111111-1111-4111-8111-111111111111";
const REQUEST = "33333333-3333-4333-8333-333333333333";
const ctx = {
  userId: "a0000000-0000-4000-8000-000000000019",
  requestId: "22222222-2222-4222-8222-222222222222",
};
const JUSTIFICATION = "Synthetic: preservation required for a pending synthetic inquiry.";

function actor(permissions: Permission[]): Actor {
  return {
    userId: ctx.userId,
    email: "records@example.test",
    displayName: "Records Officer Kappa",
    displayNameAr: "مسؤول السجلات كابا",
    roles: ["RECORDS_OFFICER"],
    permissions,
    clearance: "CONFIDENTIAL",
  };
}
const recordsOfficer = actor([
  "RETENTION_CLASS_ASSIGN",
  "LEGAL_HOLD_APPLY",
  "DISPOSITION_REQUEST",
  "ARCHIVE_RECORD_VIEW",
  "ARCHIVE_RECORD_ADMINISTER",
]);
const investigator = actor(["CONFLICT_DECLARE", "EVIDENCE_UPLOAD", "FORM_VIEW"]);
const approver = actor(["DISPOSITION_APPROVE", "ARCHIVE_RECORD_VIEW"]);

function harness(failWith?: string) {
  const calls: { method: string; input: unknown }[] = [];
  const events: SecurityEvent[] = [];
  const handler: ProxyHandler<object> = {
    get: (_, method: string) => async (_ctx: unknown, input?: unknown) => {
      calls.push({ method, input });
      if (failWith) throw new Error(failWith);
      return method === "refreshEligibility" ? 2 : REQUEST;
    },
  };
  const gateway = new Proxy({}, handler) as RecordsGateway;
  const service = createRecordsService({
    gateway,
    securityEvents: { record: async (e) => void events.push(e) },
  });
  return { service, calls, events };
}

describe("records service", () => {
  it("places a hold after validation and the permission pre-check", async () => {
    const { service, calls, events } = harness();
    const r = await service.placeLegalHold(ctx, recordsOfficer, {
      caseId: CASE,
      reasonCode: "LITIGATION",
      justification: JUSTIFICATION,
      authorityReference: "",
    });
    expect(r).toEqual({ ok: true, value: REQUEST });
    expect(calls).toEqual([
      {
        method: "placeLegalHold",
        input: {
          caseId: CASE,
          reasonCode: "LITIGATION",
          justification: JUSTIFICATION,
          authorityReference: undefined,
        },
      },
    ]);
    expect(events).toEqual([]);
  });

  it("refuses a user without the permission before the database and records COMMAND_DENIED (REC-T44)", async () => {
    const { service, calls, events } = harness();
    const r = await service.placeLegalHold(ctx, investigator, {
      caseId: CASE,
      reasonCode: "LITIGATION",
      justification: JUSTIFICATION,
    });
    expect(r.ok).toBe(false);
    expect("error" in r && r.error.kind).toBe("FORBIDDEN");
    expect(calls).toEqual([]);
    expect(events).toEqual([
      {
        action: "COMMAND_DENIED",
        objectType: "command",
        objectId: CASE,
        metadata: { command: "place_legal_hold", outcome: "FORBIDDEN" },
      },
    ]);
  });

  it.each([
    ["assignRetentionClass", { caseId: CASE, retentionClass: "WB_CASE_NOT_INVESTIGATED" }],
    ["requestDisposition", { caseId: CASE }],
    ["decideDisposition", { requestId: REQUEST, approve: "APPROVE", reason: "Synthetic decision reason." }],
    ["executeDisposition", { requestId: REQUEST, confirm: true }],
    ["requestHoldRelease", { holdId: REQUEST, justification: JUSTIFICATION }],
    ["decideHoldRelease", { releaseId: REQUEST, approve: "REJECT", reason: "Synthetic decision reason." }],
    ["requestLegalHold", { caseId: CASE, reasonCode: "AUDIT", justification: JUSTIFICATION }],
    ["assignHoldRequest", { requestId: REQUEST, reviewerId: ctx.userId }],
    ["reviewHoldRequest", { requestId: REQUEST, apply: "APPLY", reason: "Synthetic decision reason." }],
  ] as const)("%s is refused for a user without records capabilities", async (method, input) => {
    const { service, calls, events } = harness();
    const r = await service[method](ctx, investigator, input);
    expect(r.ok).toBe(false);
    expect("error" in r && r.error.kind).toBe("FORBIDDEN");
    expect(calls).toEqual([]);
    expect(events.map((e) => e.action)).toEqual(["COMMAND_DENIED"]);
  });

  it("refuses eligibility refresh without DISPOSITION_REQUEST", async () => {
    const { service, calls, events } = harness();
    const r = await service.refreshEligibility(ctx, approver);
    expect("error" in r && r.error.kind).toBe("FORBIDDEN");
    expect(calls).toEqual([]);
    expect(events[0]?.metadata).toEqual({ command: "refresh_disposition_eligibility", outcome: "FORBIDDEN" });
  });

  it("lets the approver execute an approved disposition (requester or approver, as in the database)", async () => {
    const { service, calls } = harness();
    const r = await service.executeDisposition(ctx, approver, { requestId: REQUEST, confirm: true });
    expect(r).toEqual({ ok: true, value: REQUEST });
    expect(calls.map((c) => c.method)).toEqual(["executeDisposition"]);
  });

  it("requires the explicit confirmation to execute", async () => {
    const { service, calls } = harness();
    const r = await service.executeDisposition(ctx, recordsOfficer, { requestId: REQUEST, confirm: false });
    expect("fieldErrors" in r).toBe(true);
    expect(calls).toEqual([]);
  });

  it("parses decisions from the radio values the forms send", async () => {
    const { service, calls } = harness();
    await service.decideDisposition(ctx, approver, {
      requestId: REQUEST,
      approve: "REJECT",
      reason: "Synthetic decision reason.",
    });
    expect(calls[0]?.input).toEqual({
      requestId: REQUEST,
      approve: false,
      reason: "Synthetic decision reason.",
    });
  });

  it.each([
    [
      "a short justification",
      { caseId: CASE, reasonCode: "LITIGATION", justification: "too short" },
      "justification",
    ],
    ["no justification", { caseId: CASE, reasonCode: "LITIGATION" }, "justification"],
    ["an unknown reason", { caseId: CASE, reasonCode: "WHIM", justification: JUSTIFICATION }, "reasonCode"],
    ["a non-UUID case id", { caseId: "1", reasonCode: "LITIGATION", justification: JUSTIFICATION }, "caseId"],
  ])("rejects a hold with %s before any call", async (_label, input, path) => {
    const { service, calls, events } = harness();
    const r = await service.placeLegalHold(ctx, recordsOfficer, input);
    expect("fieldErrors" in r && r.fieldErrors.issues.map((i) => i.path.join("."))).toContain(path);
    expect(calls).toEqual([]);
    expect(events).toEqual([]);
  });

  it("never accepts UNASSIGNED or a malformed retention class", async () => {
    const { service, calls } = harness();
    for (const retentionClass of ["UNASSIGNED", "wb_case", "X; drop", ""]) {
      const r = await service.assignRetentionClass(ctx, recordsOfficer, { caseId: CASE, retentionClass });
      expect("fieldErrors" in r).toBe(true);
    }
    expect(calls).toEqual([]);
  });

  it("maps a database refusal to a safe error and records it; conflicts are not security events", async () => {
    const denied = harness("CDF_FORBIDDEN");
    const r1 = await denied.service.requestDisposition(ctx, recordsOfficer, { caseId: CASE });
    expect("error" in r1 && r1.error.kind).toBe("FORBIDDEN");
    expect(denied.events.map((e) => e.metadata)).toEqual([
      { command: "request_disposition", outcome: "FORBIDDEN" },
    ]);

    const missing = harness("CDF_NOT_FOUND");
    await missing.service.requestDisposition(ctx, recordsOfficer, { caseId: CASE });
    expect(missing.events.map((e) => e.metadata)).toEqual([
      { command: "request_disposition", outcome: "NOT_FOUND" },
    ]);

    const conflict = harness("CDF_CONFLICT:LEGAL_HOLD_ACTIVE");
    const r3 = await conflict.service.requestDisposition(ctx, recordsOfficer, { caseId: CASE });
    expect("error" in r3 && [r3.error.kind, r3.error.detail]).toEqual(["CONFLICT", "LEGAL_HOLD_ACTIVE"]);
    expect(conflict.events).toEqual([]);
  });

  it("never exposes database text in errors", async () => {
    const { service } = harness('relation "records.legal_hold" violates check constraint');
    const r = await service.placeLegalHold(ctx, recordsOfficer, {
      caseId: CASE,
      reasonCode: "LITIGATION",
      justification: JUSTIFICATION,
    });
    expect("error" in r && r.error.kind).toBe("UNAVAILABLE");
    expect("error" in r && r.error.detail).toBeUndefined();
  });

  it("offers no delete, purge or destruction command", () => {
    const { service } = harness();
    expect(Object.keys(service).filter((k) => /delete|purge|destroy|remove/i.test(k))).toEqual([]);
  });
});
