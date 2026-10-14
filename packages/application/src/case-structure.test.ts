// Case structure (Phase 12 P12-1; migration 1870): validation before the gateway, database refusals mapped to safe
// errors and recorded as COMMAND_DENIED without content. The database side (who may act, one open proceeding per
// type, the Restricted Case Authority's approval) is in tests/security/committee-registry.spec.ts and
// tests/security/restricted-case-authority.spec.ts.
import { describe, expect, it } from "vitest";
import type { SecurityEvent } from "@cdf/audit";
import { createCaseStructureService, type CaseStructureGateway } from "./case-structure";

const CASE = "33333333-3333-4333-8333-333333333333";
const IC = "44444444-4444-4444-8444-444444444444";
const ctx = {
  userId: "a0000000-0000-4000-8000-000000000003",
  requestId: "22222222-2222-4222-8222-222222222222",
};

function harness(refusal?: string) {
  const calls: unknown[][] = [];
  const events: SecurityEvent[] = [];
  const answer = (name: string) => async (_: unknown, input: unknown) => {
    calls.push([name, input]);
    if (refusal) throw new Error(refusal);
    return "55555555-5555-4555-8555-555555555555";
  };
  const gateway = {
    structure: async () => {
      throw new Error("not used");
    },
    addSubject: answer("addSubject"),
    addAllegation: answer("addAllegation"),
    linkAllegationSubject: answer("linkAllegationSubject"),
    recordFinding: answer("recordFinding"),
    openProceeding: answer("openProceeding"),
    updateProceedingState: answer("updateProceedingState"),
    closeProceeding: answer("closeProceeding"),
    referToCommittee: answer("referToCommittee"),
    approveRestrictedReferral: answer("approveRestrictedReferral"),
    referralPreview: async (_: unknown, caseId: string, committeeId: string) => {
      calls.push(["referralPreview", caseId, committeeId]);
      if (refusal) throw new Error(refusal);
      return {
        seats: [{ seat: "CHAIR", count: 1 }],
        voting: 1,
        cleared: 1,
        notCleared: 0,
        firewallRestricted: 0,
      };
    },
  } as unknown as CaseStructureGateway;
  const service = createCaseStructureService({
    gateway,
    securityEvents: { record: async (e) => void events.push(e) },
  });
  return { service, calls, events };
}

describe("case structure service", () => {
  it("validates before the gateway: a malformed referral never reaches the database", async () => {
    const { service, calls } = harness();
    const r = await service.referToCommittee(ctx, { caseId: CASE, committeeId: "IC", reason: "x" });
    expect(r.ok === false && "fieldErrors" in r).toBe(true);
    expect(calls).toEqual([]);
  });

  it("passes the parsed command to the gateway", async () => {
    const { service, calls, events } = harness();
    const r = await service.referToCommittee(ctx, {
      caseId: CASE,
      committeeId: IC,
      parentProceedingId: "",
      reason: "Synthetic referral reason.",
    });
    expect(r.ok).toBe(true);
    expect(calls).toEqual([
      [
        "referToCommittee",
        {
          caseId: CASE,
          committeeId: IC,
          parentProceedingId: undefined,
          reason: "Synthetic referral reason.",
        },
      ],
    ]);
    expect(events).toEqual([]);
  });

  it("a refusal by the database is recorded as COMMAND_DENIED with the command and outcome only", async () => {
    const { service, events } = harness("CDF_FORBIDDEN");
    const r = await service.approveRestrictedReferral(ctx, {
      caseId: CASE,
      committeeId: IC,
      reason: "Synthetic approval reason.",
    });
    expect(r.ok === false && "error" in r && r.error.kind).toBe("FORBIDDEN");
    expect(events).toEqual([
      {
        action: "COMMAND_DENIED",
        objectType: "command",
        objectId: CASE,
        metadata: { command: "approve_restricted_committee_referral", outcome: "FORBIDDEN" },
      },
    ]);
  });

  it("a business conflict is returned with its code and is not a security event", async () => {
    const { service, events } = harness("CDF_CONFLICT:AUTHORITY_APPROVAL_REQUIRED");
    const r = await service.referToCommittee(ctx, {
      caseId: CASE,
      committeeId: IC,
      reason: "Synthetic referral.",
    });
    expect(r.ok === false && "error" in r && [r.error.kind, r.error.detail]).toEqual([
      "CONFLICT",
      "AUTHORITY_APPROVAL_REQUIRED",
    ]);
    expect(events).toEqual([]);
  });

  it("the referral preview (2045) is counts only, and a refusal shows no preview without a security event", async () => {
    const ok = harness();
    expect(await ok.service.referralPreview(ctx, CASE, IC)).toEqual({
      seats: [{ seat: "CHAIR", count: 1 }],
      voting: 1,
      cleared: 1,
      notCleared: 0,
      firewallRestricted: 0,
    });
    for (const refusal of [
      "CDF_NOT_FOUND",
      "CDF_FORBIDDEN",
      "CDF_CONFLICT:CASE_NOT_ACTIVE",
      "CDF_INVALID:committee_id",
    ]) {
      const { service, events } = harness(refusal);
      expect(await service.referralPreview(ctx, CASE, IC), refusal).toBeNull();
      expect(events).toEqual([]);
    }
    // Anything else is not a refusal: it surfaces as the generic failure.
    await expect(harness("connection reset").service.referralPreview(ctx, CASE, IC)).rejects.toMatchObject({
      kind: "UNAVAILABLE",
    });
  });

  it("a finding's rationale never reaches the security event", async () => {
    const { service, events } = harness("CDF_NOT_FOUND");
    const rationale = "Synthetic rationale that must stay in the case.";
    await service.recordFinding(ctx, {
      allegationId: CASE,
      proceedingId: IC,
      result: "SUBSTANTIATED",
      rationale,
    });
    expect(JSON.stringify(events)).not.toContain("Synthetic rationale");
    expect(events[0]?.metadata).toEqual({ command: "record_finding", outcome: "NOT_FOUND" });
  });
});
