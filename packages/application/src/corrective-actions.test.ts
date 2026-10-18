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
const DISPOSITION = "44444444-4444-4444-8444-444444444444";
const CASE = "55555555-5555-4555-8555-555555555555";
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
  const inputs: unknown[] = [];
  const step = async (name: string) => {
    calls.push(name);
    if (refusal) throw new Error(refusal);
  };
  const gateway: CorrectiveActionGateway = {
    setPolicy: async () => (await step("setPolicy"), ACTION),
    open: async () => (await step("open"), ACTION),
    assignOwner: () => step("assignOwner"),
    changeDueDate: () => step("changeDueDate"),
    recordProgress: async (_, i) => (inputs.push(i), await step("recordProgress")),
    submitCompletion: async (_, i) => (inputs.push(i), await step("submitCompletion")),
    verify: async () => (await step("verify"), "COMPLETED"),
    reopen: () => step("reopen"),
    waive: () => step("waive"),
    list: async () => (calls.push("list"), []),
    caseActions: async () => (await step("caseActions"), []),
    view: async () => {
      await step("view");
      throw new Error("not used");
    },
    dispose: async () => (await step("dispose"), DISPOSITION),
  };
  const service = createCorrectiveActionService({
    gateway,
    securityEvents: { record: async (e) => void events.push(e) },
  });
  return { service, calls, events, inputs };
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

  it("hands the owner's report to the gateway as the form sent it: the percentage read, the evidence kind kept", async () => {
    const { service, calls, inputs } = harness();
    // P12-6a: the form sends text; the four-argument command takes the kind of evidence with the reference.
    expect(
      (
        await service.recordProgress(ctx, owner, {
          actionId: ACTION,
          percentComplete: "40",
          note: "Synthetic: half the approvers trained.",
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await service.submitCompletion(ctx, owner, {
          actionId: ACTION,
          note: "Synthetic: the second approver is in place.",
          evidenceReference: "DOC-DEMO-2026-0007",
          evidenceType: "REVISED_PROCEDURE",
        })
      ).ok,
    ).toBe(true);
    // A kind of evidence without a reference never reaches the database.
    expect(
      (
        await service.submitCompletion(ctx, owner, {
          actionId: ACTION,
          note: "Synthetic: the second approver is in place.",
          evidenceType: "DOCUMENT",
        })
      ).ok,
    ).toBe(false);
    expect(calls).toEqual(["recordProgress", "submitCompletion"]);
    expect(inputs).toEqual([
      { actionId: ACTION, percentComplete: 40, note: "Synthetic: half the approvers trained." },
      {
        actionId: ACTION,
        note: "Synthetic: the second approver is in place.",
        evidenceReference: "DOC-DEMO-2026-0007",
        evidenceType: "REVISED_PROCEDURE",
      },
    ]);
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

  describe("a frozen action's disposition (DEC-AMB-014, P12-3b)", () => {
    const base = {
      actionId: ACTION,
      sourceDocumentReference: "DEC-DEMO-2026-0002",
      reason: "Synthetic: the replacement decision re-adopts it.",
    };
    const paths = (r: Awaited<ReturnType<ReturnType<typeof harness>["service"]["dispose"]>>) =>
      !r.ok && "fieldErrors" in r ? r.fieldErrors.issues.map((i) => i.path.join(".")) : [];

    it("RE_ADOPT and WAIVE carry no wording, owner or date; MODIFY and a replacement carry the wording", async () => {
      const { service, calls } = harness();
      const extra = { title: "Synthetic: new wording", description: "Synthetic: new description text." };
      for (const disposition of ["RE_ADOPT", "WAIVE"] as const) {
        expect(
          paths(
            await service.dispose(ctx, manager, {
              ...base,
              disposition,
              ...extra,
              ownerId: OWNER,
              dueDate: "2099-01-01",
            }),
          ),
        ).toEqual(["title", "description", "dueDate", "ownerId"]);
      }
      expect(paths(await service.dispose(ctx, manager, { ...base, disposition: "MODIFY" }))).toEqual([
        "title",
        "description",
      ]);
      expect(
        paths(
          await service.dispose(ctx, manager, { ...base, disposition: "MODIFY", ...extra, ownerId: OWNER }),
        ),
      ).toEqual(["ownerId"]);
      expect(
        paths(
          await service.dispose(ctx, manager, { ...base, disposition: "REPLACE_WITH_NEW_ACTION", ...extra }),
        ),
      ).toEqual(["ownerId"]);
      // The document and the reason are always required; an unknown disposition is refused here first.
      expect(
        paths(
          await service.dispose(ctx, manager, {
            actionId: ACTION,
            disposition: "CARRY_FORWARD",
            sourceDocumentReference: "x",
          }),
        ),
      ).toEqual(["disposition", "sourceDocumentReference", "reason"]);
      expect(calls).toEqual([]);

      expect(await service.dispose(ctx, manager, { ...base, disposition: "RE_ADOPT" })).toEqual({
        ok: true,
        value: DISPOSITION,
      });
      expect(
        await service.dispose(ctx, manager, {
          ...base,
          disposition: "REPLACE_WITH_NEW_ACTION",
          ...extra,
          ownerId: OWNER,
          dueDate: "2099-01-01",
        }),
      ).toEqual({ ok: true, value: DISPOSITION });
      expect(calls).toEqual(["dispose", "dispose"]);
    });

    it("needs CORRECTIVE_ACTION_MANAGE first and records a refusal by its outcome only", async () => {
      const { service, calls, events } = harness();
      const waiver = actor(["CORRECTIVE_ACTION_WAIVE", "CORRECTIVE_ACTION_OWN"]);
      expect(await service.dispose(ctx, waiver, { ...base, disposition: "WAIVE" })).toMatchObject({
        ok: false,
        error: { kind: "FORBIDDEN" },
      });
      expect(calls).toEqual([]);
      expect(events.map((e) => [e.action, e.objectId, e.metadata])).toEqual([
        ["COMMAND_DENIED", ACTION, { command: "dispose_superseded_corrective_action", outcome: "FORBIDDEN" }],
      ]);
    });

    it("passes the command's refusal on with its code, and records only NOT_FOUND and FORBIDDEN", async () => {
      const frozen = harness("CDF_CONFLICT:ALREADY_DISPOSED");
      expect(await frozen.service.dispose(ctx, manager, { ...base, disposition: "RE_ADOPT" })).toMatchObject({
        ok: false,
        error: { kind: "CONFLICT", detail: "ALREADY_DISPOSED" },
      });
      expect(frozen.events).toEqual([]);
      const gone = harness("CDF_NOT_FOUND");
      expect(await gone.service.dispose(ctx, manager, { ...base, disposition: "WAIVE" })).toMatchObject({
        ok: false,
        error: { kind: "NOT_FOUND" },
      });
      expect(gone.events.map((e) => e.metadata)).toEqual([
        { command: "dispose_superseded_corrective_action", outcome: "NOT_FOUND" },
      ]);
    });
  });

  describe("the case's actions and one action (A1, A2)", () => {
    it("is the uniform not-found for whoever may not read, recorded with the read's name only", async () => {
      const { service, events } = harness("CDF_NOT_FOUND");
      expect(await service.caseActions(ctx, CASE)).toBeNull();
      expect(await service.view(ctx, ACTION)).toBeNull();
      expect(events.map((e) => [e.action, e.objectType, e.objectId, e.metadata])).toEqual([
        ["ACCESS_DENIED", "case", CASE, { read: "case_corrective_actions" }],
        ["ACCESS_DENIED", "corrective_action", ACTION, { read: "corrective_action_view" }],
      ]);
    });

    it("lets any other failure through, unrecorded", async () => {
      const { service, events } = harness("connection reset");
      await expect(service.caseActions(ctx, CASE)).rejects.toMatchObject({ kind: "UNAVAILABLE" });
      expect(events).toEqual([]);
    });

    it("returns what the read model gives", async () => {
      const { service, calls } = harness();
      expect(await service.caseActions(ctx, CASE)).toEqual([]);
      expect(calls).toEqual(["caseActions"]);
    });
  });
});
