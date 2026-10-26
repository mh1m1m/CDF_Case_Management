// The restriction-lift service (migration 2130, ADR-049; DEC-AMB-012 C): validation before the gateway, the
// database's refusals carried as safe codes, and only access refusals recorded as COMMAND_DENIED, without reasons or
// case content. The database side (who may act, the windows, the preview) is in
// tests/security/restricted-case-authority.spec.ts and tests/integration/restriction-lift.spec.ts.
import { describe, expect, it } from "vitest";
import type { SecurityEvent } from "@cdf/audit";
import type { RestrictionLiftStatusView } from "@cdf/contracts";
import { createRestrictionLiftService, type RestrictionLiftGateway } from "./restriction-lift";

const CASE = "33333333-3333-4333-8333-333333333333";
const REQUEST = "44444444-4444-4444-8444-444444444444";
const HASH = "b".repeat(64);
const REASON = "Synthetic: the restriction is no longer needed.";
const ctx = {
  userId: "a0000000-0000-4000-8000-000000000008",
  requestId: "22222222-2222-4222-8222-222222222222",
};

function harness(refusal?: string) {
  const calls: unknown[][] = [];
  const events: SecurityEvent[] = [];
  const answer =
    <T>(name: string, value: T) =>
    async (_: unknown, input?: unknown): Promise<T> => {
      calls.push(input === undefined ? [name] : [name, input]);
      if (refusal) throw new Error(refusal);
      return value;
    };
  const status: RestrictionLiftStatusView = {
    caseId: CASE,
    isRestricted: true,
    approverRole: "GRC_DIRECTOR",
    capabilities: { mayPreview: true, mayRequest: true },
    requestRefusal: null,
    request: null,
  };
  const gateway: RestrictionLiftGateway = {
    status: answer("status", status),
    myApprovals: answer("myApprovals", []),
    preview: answer("preview", {
      preview: { classification: "CONFIDENTIAL", gates: [], usersGaining: 0, authorityApprovalsEnding: [] },
      previewHash: HASH,
    }),
    request: answer("request", REQUEST),
    decide: answer("decide", "APPROVED" as const),
    lift: answer("lift", undefined),
    expire: answer("expire", undefined),
    withdraw: answer("withdraw", undefined),
  };
  const service = createRestrictionLiftService({
    gateway,
    securityEvents: { record: async (e) => void events.push(e) },
  });
  return { service, calls, events, status };
}

describe("restriction-lift service", () => {
  it("validates before the gateway: a malformed request, decision or hash never reaches the database", async () => {
    const { service, calls } = harness();
    for (const r of [
      await service.request(ctx, { caseId: CASE, reason: "four", previewHash: HASH }),
      await service.request(ctx, { caseId: CASE, reason: REASON, previewHash: "not-a-hash" }),
      await service.decide(ctx, { requestId: REQUEST, decision: "LIFT", reason: REASON, previewHash: HASH }),
      await service.lift(ctx, { requestId: "not-a-uuid" }),
      await service.preview(ctx, { caseId: "" }),
    ]) {
      expect(r.ok === false && "fieldErrors" in r).toBe(true);
    }
    expect(calls).toEqual([]);
  });

  it("passes the parsed command to the gateway, without any user id", async () => {
    const { service, calls, events } = harness();
    const r = await service.request(ctx, {
      caseId: CASE,
      reason: `  ${REASON}  `,
      previewHash: HASH,
      userId: CASE,
    });
    expect(r).toEqual({ ok: true, value: REQUEST });
    const d = await service.decide(ctx, {
      requestId: REQUEST,
      decision: "APPROVE",
      reason: REASON,
      previewHash: HASH,
      approverId: CASE,
    });
    expect(d).toEqual({ ok: true, value: "APPROVED" });
    expect(await service.lift(ctx, { requestId: REQUEST })).toEqual({ ok: true, value: undefined });
    expect(calls).toEqual([
      ["request", { caseId: CASE, reason: REASON, previewHash: HASH }],
      ["decide", { requestId: REQUEST, decision: "APPROVE", reason: REASON, previewHash: HASH }],
      ["lift", { requestId: REQUEST }],
    ]);
    expect(events).toEqual([]);
  });

  // The coordinator's ruling of 19 Oct 01:42 (points 1 to 5): each refusal the database raises reaches the caller as
  // its own code. Access refusals (who may act, point 1 and the approver's eligibility, point 2) are recorded as
  // COMMAND_DENIED with the command and the object id only; the conflicts (points 3 to 5) are not denials.
  it.each([
    // (1) Only the case's authority requests and lifts; a handover leaves the request unusable.
    ["request", "CDF_FORBIDDEN", "FORBIDDEN", undefined, true],
    ["lift", "CDF_FORBIDDEN", "FORBIDDEN", undefined, true],
    // (2) The second approver: never the requester or the case's authority; an ineligible one sees no request.
    ["decide", "CDF_CONFLICT:REQUESTER_CANNOT_APPROVE", "CONFLICT", "REQUESTER_CANNOT_APPROVE", false],
    ["decide", "CDF_CONFLICT:RCA_CANNOT_APPROVE", "CONFLICT", "RCA_CANNOT_APPROVE", false],
    ["decide", "CDF_NOT_FOUND", "NOT_FOUND", undefined, true],
    ["lift", "CDF_CONFLICT:APPROVER_NOT_ELIGIBLE", "CONFLICT", "APPROVER_NOT_ELIGIBLE", false],
    // (3) The second approver's role unset (SOURCE_REQUIRED), or the window malformed: nothing can be requested.
    [
      "request",
      "CDF_CONFLICT:LIFT_APPROVER_NOT_CONFIGURED",
      "CONFLICT",
      "LIFT_APPROVER_NOT_CONFIGURED",
      false,
    ],
    ["request", "CDF_CONFLICT:LIFT_WINDOW_MISCONFIGURED", "CONFLICT", "LIFT_WINDOW_MISCONFIGURED", false],
    ["lift", "CDF_CONFLICT:APPROVAL_LAPSED", "CONFLICT", "APPROVAL_LAPSED", false],
    // (4) An export awaiting the authority's consent or a Defence Packet awaiting the authority blocks both.
    [
      "request",
      "CDF_CONFLICT:RESTRICTED_APPROVALS_PENDING",
      "CONFLICT",
      "RESTRICTED_APPROVALS_PENDING",
      false,
    ],
    ["lift", "CDF_CONFLICT:RESTRICTED_APPROVALS_PENDING", "CONFLICT", "RESTRICTED_APPROVALS_PENDING", false],
    // (5) The preview: snapshotted at the request, recomputed at the approval and at the lift.
    ["request", "CDF_CONFLICT:PREVIEW_CHANGED", "CONFLICT", "PREVIEW_CHANGED", false],
    ["decide", "CDF_CONFLICT:PREVIEW_CHANGED", "CONFLICT", "PREVIEW_CHANGED", false],
    ["lift", "CDF_CONFLICT:PREVIEW_CHANGED", "CONFLICT", "PREVIEW_CHANGED", false],
    // Replaying a consumed approval.
    ["lift", "CDF_CONFLICT:APPROVAL_CONSUMED", "CONFLICT", "APPROVAL_CONSUMED", false],
  ] as const)("%s refused with %s", async (name, thrown, kind, detail, denial) => {
    const { service, events } = harness(thrown);
    const input = {
      request: { caseId: CASE, reason: REASON, previewHash: HASH },
      decide: { requestId: REQUEST, decision: "APPROVE", reason: REASON, previewHash: HASH },
      lift: { requestId: REQUEST },
    }[name];
    const r = await service[name](ctx, input);
    expect(r.ok).toBe(false);
    if (r.ok || !("error" in r)) throw new Error("expected an error");
    expect([r.error.kind, r.error.detail, r.error.correlationId]).toEqual([kind, detail, ctx.requestId]);
    expect(events).toEqual(
      denial
        ? [
            {
              action: "COMMAND_DENIED",
              objectType: "command",
              objectId: name === "request" ? CASE : REQUEST,
              metadata: {
                command: {
                  request: "request_restriction_lift",
                  decide: "decide_restriction_lift",
                  lift: "lift_case_restriction",
                }[name],
                outcome: kind,
              },
            },
          ]
        : [],
    );
    // Never the reason, never the hash.
    expect(JSON.stringify(events)).not.toContain(REASON);
    expect(JSON.stringify(events)).not.toContain(HASH);
  });

  it("a database error the service does not know becomes UNAVAILABLE, never its text", async () => {
    const { service } = harness('relation "case_mgmt.restriction_lift_request" does not exist');
    const r = await service.withdraw(ctx, { requestId: REQUEST });
    expect(r.ok === false && "error" in r && [r.error.kind, r.error.message]).toEqual([
      "UNAVAILABLE",
      "UNAVAILABLE",
    ]);
  });

  it("the status panel is the authority's only: anyone else, a hidden case and a malformed id all read null", async () => {
    expect(await harness().service.status(ctx, CASE)).toMatchObject({
      caseId: CASE,
      approverRole: "GRC_DIRECTOR",
    });
    expect(await harness("CDF_FORBIDDEN").service.status(ctx, CASE)).toBeNull();
    expect(await harness("CDF_NOT_FOUND").service.status(ctx, CASE)).toBeNull();
    const { service, calls } = harness();
    expect(await service.status(ctx, "not-a-uuid")).toBeNull();
    expect(calls).toEqual([]);
    await expect(harness("connection reset").service.status(ctx, CASE)).rejects.toMatchObject({
      kind: "UNAVAILABLE",
    });
  });

  it("the approval queue passes through, and a database failure is a safe error", async () => {
    expect(await harness().service.myApprovals(ctx)).toEqual([]);
    await expect(harness("CDF_UNAUTHENTICATED").service.myApprovals(ctx)).rejects.toMatchObject({
      kind: "UNAUTHENTICATED",
    });
  });
});
