import { describe, expect, it, vi } from "vitest";
import type { Actor } from "@cdf/contracts";
import { permissionsForRoles } from "@cdf/authorization";
import { createInvestigationService } from "./investigation";
import type { InvestigationGateway } from "./ports";

const ctx = {
  userId: "a0000000-0000-4000-8000-000000000004",
  requestId: "00000000-0000-4000-8000-000000000001",
};
const investigator: Actor = {
  userId: ctx.userId,
  email: "investigator.a@example.test",
  displayName: "Investigator Alpha",
  displayNameAr: "المحقق ألفا",
  roles: ["INVESTIGATOR"],
  permissions: permissionsForRoles(["INVESTIGATOR"]),
  clearance: "CONFIDENTIAL",
};
const caseId = "b0000000-0000-4000-8000-000000000001";

function setup(gateway: Partial<InvestigationGateway> = {}) {
  const record = vi.fn().mockResolvedValue(undefined);
  const service = createInvestigationService({
    gateway: gateway as InvestigationGateway,
    securityEvents: { record },
  });
  return { service, record };
}

describe("investigation commands", () => {
  it("refuses before touching the database when the actor lacks the permission, and records it", async () => {
    const assignCase = vi.fn();
    const { service, record } = setup({ assignCase });
    const result = await service.assignCase(ctx, investigator, {
      caseId,
      userId: ctx.userId,
      assignmentRole: "INVESTIGATOR",
      reason: "self assignment",
    });
    expect(result).toMatchObject({ ok: false, error: { kind: "FORBIDDEN" } });
    expect(assignCase).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "COMMAND_DENIED",
        metadata: { command: "assign_case", outcome: "FORBIDDEN" },
      }),
      ctx,
    );
  });

  it("maps database refusals to safe errors without leaking text", async () => {
    const transitionCase = vi.fn().mockRejectedValue(new Error("CDF_CONFLICT:NO_INVESTIGATOR_ASSIGNED"));
    const { service } = setup({ transitionCase });
    const result = await service.transitionCase(ctx, investigator, {
      caseId,
      transitionCode: "APPROVE_INVESTIGATION",
      reason: "x".repeat(12),
    });
    expect(result).toMatchObject({
      ok: false,
      error: { kind: "CONFLICT", detail: "NO_INVESTIGATOR_ASSIGNED" },
    });
  });

  it("turns unexpected errors into UNAVAILABLE with the correlation id", async () => {
    const transitionCase = vi
      .fn()
      .mockRejectedValue(new Error('relation "x" does not exist at character 15'));
    const { service } = setup({ transitionCase });
    const result = await service.transitionCase(ctx, investigator, {
      caseId,
      transitionCode: "START_SCREENING",
    });
    expect(result).toMatchObject({ ok: false, error: { kind: "UNAVAILABLE", correlationId: ctx.requestId } });
    expect(JSON.stringify(result)).not.toContain("does not exist");
  });

  it("returns field errors for invalid input", async () => {
    const { service } = setup();
    const result = await service.declareConflict(ctx, investigator, {
      caseId: "not-a-uuid",
      hasConflict: true,
      declaration: "",
    });
    expect(result.ok).toBe(false);
    expect("fieldErrors" in result).toBe(true);
  });
});
