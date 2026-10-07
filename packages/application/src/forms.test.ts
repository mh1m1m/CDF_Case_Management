import { describe, expect, it, vi } from "vitest";
import { permissionsForRoles } from "@cdf/authorization";
import type { Actor, Role } from "@cdf/contracts";
import type { SecurityEvent } from "@cdf/audit";
import { createFormsService } from "./forms";
import type { FormsGateway } from "./ports";

const actor = (roles: Role[]): Actor => ({
  userId: "a0000000-0000-4000-8000-000000000004",
  email: "someone@example.test",
  displayName: "Synthetic Person",
  displayNameAr: "شخص افتراضي",
  roles,
  permissions: permissionsForRoles(roles),
  clearance: "CONFIDENTIAL",
});
const ctx = {
  userId: "a0000000-0000-4000-8000-000000000004",
  requestId: "b0000000-0000-4000-8000-000000000001",
};
const CASE = "c0000000-0000-4000-8000-000000000001";
const INSTANCE = "d0000000-0000-4000-8000-000000000001";

function harness(overrides: Partial<FormsGateway> = {}) {
  const events: SecurityEvent[] = [];
  const gateway: FormsGateway = {
    listDefinitions: vi.fn(async () => []),
    listInstances: vi.fn(async () => []),
    getInstance: vi.fn(async () => null),
    startForm: vi.fn(async () => INSTANCE),
    saveDraft: vi.fn(async () => ({ versionId: "v", versionNo: 1, contentHash: "0".repeat(64) })),
    prepare: vi.fn(async () => undefined),
    review: vi.fn(async () => undefined),
    approve: vi.fn(async () => undefined),
    withdraw: vi.fn(async () => undefined),
    ...overrides,
  };
  const service = createFormsService({
    gateway,
    securityEvents: { record: async (e) => void events.push(e) },
  });
  return { service, gateway, events };
}

describe("forms service pre-checks", () => {
  it("refuses a start without FORM_PREPARE and records the denial", async () => {
    const { service, gateway, events } = harness();
    const r = await service.start(ctx, actor(["COMMITTEE_MEMBER"]), {
      caseId: CASE,
      formCode: "WB-FRM-13",
      classification: "CONFIDENTIAL",
    });
    expect(r.ok).toBe(false);
    if (!r.ok && "error" in r) expect(r.error.kind).toBe("FORBIDDEN");
    expect(gateway.startForm).not.toHaveBeenCalled();
    expect(events).toEqual([
      {
        action: "COMMAND_DENIED",
        objectType: "form_instance",
        objectId: CASE,
        metadata: { command: "start_form", outcome: "FORBIDDEN", form_code: "WB-FRM-13" },
      },
    ]);
  });

  it("refuses a form the role is not entitled to even with the permission", async () => {
    const { service, gateway } = harness();
    const r = await service.start(ctx, actor(["INVESTIGATOR"]), {
      caseId: CASE,
      formCode: "WB-FRM-13",
      classification: "CONFIDENTIAL",
    });
    expect(r.ok).toBe(false);
    expect(gateway.startForm).not.toHaveBeenCalled();
  });

  it("starts an entitled form through the gateway", async () => {
    const { service, gateway } = harness();
    const r = await service.start(ctx, actor(["INVESTIGATOR"]), {
      caseId: CASE,
      formCode: "WB-FRM-11",
      classification: "CONFIDENTIAL",
    });
    expect(r).toEqual({ ok: true, value: { instanceId: INSTANCE } });
    expect(gateway.startForm).toHaveBeenCalledWith(ctx, {
      caseId: CASE,
      formCode: "WB-FRM-11",
      classification: "CONFIDENTIAL",
    });
  });

  it("rejects a malformed envelope before any pre-check", async () => {
    const { service, events } = harness();
    const r = await service.start(ctx, actor(["INVESTIGATOR"]), { caseId: "nope", formCode: "WB-FRM-11" });
    expect(r.ok).toBe(false);
    expect("fieldErrors" in r).toBe(true);
    expect(events).toEqual([]);
  });
});

describe("forms service drafts", () => {
  it("validates field data against the definition and reports issues per field", async () => {
    const { service, gateway } = harness();
    const r = await service.saveDraft(ctx, actor(["INVESTIGATOR"]), {
      instanceId: INSTANCE,
      formCode: "WB-FRM-11",
      data: { evidence_count: "abc", unknown_key: "x" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok && "fieldErrors" in r) {
      expect(r.fieldErrors.issues.map((i) => i.path.join("."))).toEqual([
        "data.unknown_key",
        "data.evidence_count",
      ]);
    } else {
      throw new Error("expected field errors");
    }
    expect(gateway.saveDraft).not.toHaveBeenCalled();
  });

  it("drops empty values and saves the normalised data", async () => {
    const { service, gateway } = harness();
    const r = await service.saveDraft(ctx, actor(["INVESTIGATOR"]), {
      instanceId: INSTANCE,
      formCode: "WB-FRM-11",
      data: { evidence_count: "3", evidence_scope: "", review_notes: "Synthetic note" },
    });
    expect(r).toEqual({ ok: true, value: { versionNo: 1, contentHash: "0".repeat(64) } });
    expect(gateway.saveDraft).toHaveBeenCalledWith(ctx, INSTANCE, {
      evidence_count: "3",
      review_notes: "Synthetic note",
    });
  });

  it("maps database errors to safe codes and records denials", async () => {
    const { service, events } = harness({
      prepare: vi.fn(async () => {
        throw new Error("CDF_INVALID:chain_of_custody_status");
      }),
      withdraw: vi.fn(async () => {
        throw new Error("CDF_NOT_FOUND");
      }),
    });
    const prepared = await service.prepare(ctx, actor(["INVESTIGATOR"]), {
      instanceId: INSTANCE,
      formCode: "WB-FRM-11",
    });
    expect(prepared.ok).toBe(false);
    if (!prepared.ok && "error" in prepared)
      expect([prepared.error.kind, prepared.error.detail]).toEqual(["INVALID", "chain_of_custody_status"]);
    const withdrawn = await service.withdraw(ctx, actor(["INVESTIGATOR"]), {
      instanceId: INSTANCE,
      formCode: "WB-FRM-11",
      reason: "Synthetic reason",
    });
    expect(withdrawn.ok).toBe(false);
    expect(events.map((e) => [e.action, e.metadata?.command, e.metadata?.outcome])).toEqual([
      ["COMMAND_DENIED", "withdraw_form", "NOT_FOUND"],
    ]);
  });

  it("requires a reason when returning a form", async () => {
    const { service, gateway } = harness();
    const r = await service.review(ctx, actor(["LEAD_INVESTIGATOR"]), {
      instanceId: INSTANCE,
      formCode: "WB-FRM-11",
      outcome: "RETURNED",
      reason: "short",
    });
    expect(r.ok).toBe(false);
    expect("fieldErrors" in r).toBe(true);
    expect(gateway.review).not.toHaveBeenCalled();
    const ok = await service.review(ctx, actor(["LEAD_INVESTIGATOR"]), {
      instanceId: INSTANCE,
      formCode: "WB-FRM-11",
      outcome: "REVIEWED",
    });
    expect(ok.ok).toBe(true);
    expect(gateway.review).toHaveBeenCalledWith(ctx, INSTANCE, "REVIEWED", undefined);
  });

  it("only lets approvers approve", async () => {
    const { service, gateway } = harness();
    const r = await service.approve(ctx, actor(["LEAD_INVESTIGATOR"]), {
      instanceId: INSTANCE,
      formCode: "WB-FRM-13",
      outcome: "APPROVED",
    });
    expect(r.ok).toBe(false);
    expect(gateway.approve).not.toHaveBeenCalled();
    const ok = await service.approve(ctx, actor(["COMMITTEE_CHAIR"]), {
      instanceId: INSTANCE,
      formCode: "WB-FRM-13",
      outcome: "APPROVED",
    });
    expect(ok.ok).toBe(true);
  });
});
