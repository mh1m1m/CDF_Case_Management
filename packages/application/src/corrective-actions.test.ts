// Corrective-action service (ADR-033, migration 1940): validation and the permission pre-check before the gateway,
// refusals recorded as COMMAND_DENIED, database answers mapped to safe errors. The database side (ownership, the
// case gate, separation of duties, the Restricted Case Authority) is in tests/security/corrective-actions.spec.ts.
import { describe, expect, it } from "vitest";
import type { Actor, Permission } from "@cdf/contracts";
import type { SecurityEvent } from "@cdf/audit";
import { createCorrectiveActionService, type CorrectiveActionGateway } from "./corrective-actions";

const ITEM = "11111111-1111-4111-8111-111111111111";
const ACTION = "33333333-3333-4333-8333-333333333333";
const OWNER = "a0000000-0000-4000-8000-000000000028";
const ctx = {
  userId: "a0000000-0000-4000-8000-000000000003",
  requestId: "22222222-2222-4222-8222-222222222222",
};

function actor(permissions: Permission[]): Actor {
  return {
    userId: ctx.userId,
    email: "casemanager@example.test",
    displayName: "Case Manager Delta",
    displayNameAr: "مدير القضايا دلتا",
    roles: ["CASE_MANAGER"],
    permissions,
    clearance: "CONFIDENTIAL",
  };
}
const manager = actor(["CORRECTIVE_ACTION_MANAGE"]);
const owner = actor(["CORRECTIVE_ACTION_OWN"]);

function harness(refusal?: string) {
  const calls: string[] = [];
  const events: SecurityEvent[] = [];
  const step = async (name: string) => {
    calls.push(name);
    if (refusal) throw new Error(refusal);
  };
  const gateway: CorrectiveActionGateway = {
    setPolicy: async () => (await step("setPolicy"), ACTION),
    open: async () => (await step("open"), ACTION),
    assignOwner: () => step("assignOwner"),
    changeDueDate: () => step("changeDueDate"),
    recordProgress: () => step("recordProgress"),
    submitCompletion: () => step("submitCompletion"),
    verify: async () => (await step("verify"), "COMPLETED"),
    reopen: () => step("reopen"),
    waive: () => step("waive"),
    list: async () => (calls.push("list"), []),
  };
  const service = createCorrectiveActionService({
    gateway,
    securityEvents: { record: async (e) => void events.push(e) },
  });
  return { service, calls, events };
}

describe("corrective-action service", () => {
  it("validates before the gateway: wording, owner, date and percentage", async () => {
    const { service, calls } = harness();
    const r = await service.open(ctx, manager, {
      itemId: ITEM,
      title: "x",
      description: "Synthetic: add a second approver.",
      ownerId: "not-a-uuid",
      dueDate: "2026-02-30",
    });
    expect(r.ok).toBe(false);
    if (!r.ok && "fieldErrors" in r)
      expect(r.fieldErrors.issues.map((i) => i.path.join("."))).toEqual(["title", "ownerId", "dueDate"]);
    const p = await service.recordProgress(ctx, owner, {
      actionId: ACTION,
      percentComplete: 101,
      note: "Done.",
    });
    expect(p.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("a return needs a note; a verification does not", async () => {
    const { service, calls } = harness();
    expect((await service.verify(ctx, manager, { actionId: ACTION, decision: "RETURNED" })).ok).toBe(false);
    expect(await service.verify(ctx, manager, { actionId: ACTION, decision: "VERIFIED" })).toEqual({
      ok: true,
      value: "COMPLETED",
    });
    expect(calls).toEqual(["verify"]);
  });

  it("pre-checks the permission and records the refusal without calling the gateway", async () => {
    const { service, calls, events } = harness();
    // The owner reports; managing, verifying and waiving need other permissions.
    expect(await service.verify(ctx, owner, { actionId: ACTION, decision: "VERIFIED" })).toMatchObject({
      ok: false,
      error: { kind: "FORBIDDEN" },
    });
    expect(
      (
        await service.waive(ctx, manager, {
          actionId: ACTION,
          sourceDocumentReference: "MEMO-DEMO-0103",
          reason: "Synthetic: waived by the authority.",
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await service.recordProgress(ctx, manager, {
          actionId: ACTION,
          percentComplete: 10,
          note: "Synthetic.",
        })
      ).ok,
    ).toBe(false);
    expect(events.map((e) => [e.objectId, e.metadata])).toEqual([
      [ACTION, { command: "verify_corrective_action", outcome: "FORBIDDEN" }],
      [ACTION, { command: "waive_corrective_action", outcome: "FORBIDDEN" }],
      [ACTION, { command: "record_corrective_action_progress", outcome: "FORBIDDEN" }],
    ]);
    expect(calls).toEqual([]);
    expect(
      (
        await service.recordProgress(ctx, owner, {
          actionId: ACTION,
          percentComplete: 10,
          note: "Synthetic.",
        })
      ).ok,
    ).toBe(true);
    expect(calls).toEqual(["recordProgress"]);
  });

  it("maps the database's answers to safe errors and records only refusals", async () => {
    const notFound = harness("CDF_NOT_FOUND");
    const r = await notFound.service.assignOwner(ctx, manager, {
      actionId: ACTION,
      ownerId: OWNER,
      reason: "Synthetic: hand it to Finance.",
    });
    expect(r).toMatchObject({ ok: false, error: { kind: "NOT_FOUND" } });
    expect(notFound.events.map((e) => e.metadata)).toEqual([
      { command: "assign_corrective_action_owner", outcome: "NOT_FOUND" },
    ]);
    const conflict = harness("CDF_CONFLICT:RESTRICTED_CASE_AUTHORITY_REQUIRED");
    expect(
      await conflict.service.open(ctx, manager, {
        itemId: ITEM,
        title: "Synthetic: strengthen controls",
        description: "Synthetic: add a second approver.",
        ownerId: OWNER,
      }),
    ).toMatchObject({ ok: false, error: { kind: "CONFLICT" } });
    expect(conflict.events).toEqual([]);
  });
});
