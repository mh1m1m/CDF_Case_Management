// Export service (ADR-026, migration 1930): validation and the permission pre-check before the gateway, generation
// that renders and stores inside the gateway's transaction, and delivery recorded only when the mailer accepts it.
// The database side (per-item authorization, hashes, approvals) is in tests/security/export.spec.ts.
import { describe, expect, it } from "vitest";
import type { Actor, ExportDelivery, ExportDocument, GeneratedExport, Permission } from "@cdf/contracts";
import type { SecurityEvent } from "@cdf/audit";
import { createExportService, type ExportGateway } from "./exports";
import type { RenderedExport } from "./ports";

const CASE = "11111111-1111-4111-8111-111111111111";
const REQUEST = "33333333-3333-4333-8333-333333333333";
const KEY = "exports/44444444-4444-4444-8444-444444444444";
const HASH = "a".repeat(64);
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
const requester = actor(["EXPORT_REQUEST"]);
const approver = actor(["EXPORT_APPROVE"]);
const authority = actor(["RESTRICTED_CASE_AUTHORITY"]);
const INTERNAL_RECIPIENT = "a0000000-0000-4000-8000-000000000004";
const nobody = actor(["FORM_VIEW"]);

function document(format: ExportDocument["format"]): ExportDocument {
  return {
    requestId: REQUEST,
    caseId: CASE,
    caseNumber: "CDF-DEMO-2026-0001",
    classification: "CONFIDENTIAL",
    format,
    audience: "EXTERNAL",
    purpose: "REGULATOR_REQUEST",
    externalParty: "Regulator Alpha (synthetic)",
    items: [],
  };
}

function harness(
  opts: { format?: ExportDocument["format"]; mailer?: "ok" | "refuse" | "throw"; renderFails?: boolean } = {},
) {
  const calls: string[] = [];
  const events: SecurityEvent[] = [];
  const stored: [string, RenderedExport][] = [];
  const sent: ExportDelivery[][] = [];
  const generated: GeneratedExport = {
    storageKey: KEY,
    hash: HASH,
    document: document(opts.format ?? "PDF"),
    deliverTo:
      opts.format === "EMAIL"
        ? [
            { kind: "EXTERNAL", email: "officer.alpha@example.test" },
            { kind: "INTERNAL", userId: INTERNAL_RECIPIENT },
          ]
        : [],
  };
  const gateway: ExportGateway = {
    create: async () => (calls.push("create"), REQUEST),
    addItem: async () => (calls.push("addItem"), REQUEST),
    addRecipient: async () => (calls.push("addRecipient"), REQUEST),
    preview: async () => {
      calls.push("preview");
      return {
        document: generated.document,
        hash: HASH,
        withheld: 0,
        approvalsRequired: 1,
        authorityApprovalRequired: false,
        matchedRules: [],
      };
    },
    submit: async () => (calls.push("submit"), "SUBMITTED"),
    decide: async () => (calls.push("decide"), "APPROVED"),
    decideRestricted: async () => (calls.push("decideRestricted"), "APPROVED"),
    generate: async (_ctx, _id, write) => {
      calls.push("generate");
      const written = await write(generated); // a throw here aborts the transaction
      calls.push("commit");
      return { generated, written };
    },
    recordSent: async () => void calls.push("recordSent"),
    cancel: async () => void calls.push("cancel"),
  };
  const service = createExportService({
    gateway,
    renderer: {
      kind: "stub-json",
      render: async () => {
        if (opts.renderFails) throw new Error("render failed");
        return { body: new Uint8Array([123, 125]), contentType: "application/json", fileName: "export.json" };
      },
    },
    store: { kind: "memory", put: async (key, file) => void stored.push([key, file]) },
    mailer: {
      kind: "stub-email",
      send: async (to) => {
        if (opts.mailer === "throw") throw new Error("relay refused officer.alpha@example.test");
        sent.push([...to]);
        return opts.mailer !== "refuse";
      },
    },
    securityEvents: { record: async (e) => void events.push(e) },
  });
  return { service, calls, events, stored, sent };
}

describe("export service", () => {
  it("validates the external rules before the gateway: party and justification", async () => {
    const { service, calls } = harness();
    const r = await service.createRequest(ctx, requester, {
      caseId: CASE,
      format: "EMAIL",
      audience: "EXTERNAL",
      purpose: "REGULATOR_REQUEST",
      justification: "Too short.",
    });
    expect(r.ok).toBe(false);
    if (!r.ok && "fieldErrors" in r)
      expect(r.fieldErrors.issues.map((i) => i.path.join("."))).toEqual(["externalParty", "justification"]);
    expect(calls).toEqual([]);
  });

  it("refuses an external recipient outside the synthetic domain before the gateway", async () => {
    const { service, calls } = harness();
    const r = await service.addRecipient(ctx, requester, {
      requestId: REQUEST,
      kind: "EXTERNAL",
      email: "officer@regulator.example.com",
    });
    expect(r.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("pre-checks the permission and records the refusal without calling the gateway", async () => {
    const { service, calls, events } = harness();
    const r = await service.decide(ctx, requester, {
      requestId: REQUEST,
      decision: "APPROVE",
      reason: "Synthetic: approved.",
      previewHash: HASH,
    });
    expect(r).toMatchObject({ ok: false, error: { kind: "FORBIDDEN" } });
    expect(calls).toEqual([]);
    expect(events).toEqual([
      {
        action: "COMMAND_DENIED",
        objectType: "command",
        objectId: REQUEST,
        metadata: { command: "decide_export", outcome: "FORBIDDEN" },
      },
    ]);
    expect((await service.preview(ctx, nobody, { requestId: REQUEST })).ok).toBe(false);
    expect(
      (
        await service.decide(ctx, approver, {
          requestId: REQUEST,
          decision: "APPROVE",
          reason: "Synthetic: approved.",
          previewHash: HASH,
        })
      ).ok,
    ).toBe(true);
  });

  it("only a Restricted Case Authority reaches the gateway for a restricted export's authority decision", async () => {
    const { service, calls, events } = harness();
    const input = {
      requestId: REQUEST,
      decision: "APPROVE",
      reason: "Synthetic: the authority approves.",
      previewHash: HASH,
    };
    expect(await service.decideRestricted(ctx, approver, input)).toMatchObject({
      ok: false,
      error: { kind: "FORBIDDEN" },
    });
    expect(events.map((e) => e.metadata)).toEqual([
      { command: "decide_restricted_export", outcome: "FORBIDDEN" },
    ]);
    expect(calls).toEqual([]);
    expect(await service.decideRestricted(ctx, authority, input)).toEqual({ ok: true, value: "APPROVED" });
    expect(calls).toEqual(["decideRestricted"]);
  });

  it("a file export is rendered and stored inside the generation transaction, and never mailed", async () => {
    const { service, calls, stored, sent } = harness({ format: "PDF" });
    const r = await service.generate(ctx, requester, { requestId: REQUEST });
    expect(r).toEqual({
      ok: true,
      value: { status: "GENERATED", storageKey: KEY, hash: HASH, delivered: false },
    });
    expect(calls).toEqual(["generate", "commit"]);
    expect(stored.map(([k]) => k)).toEqual([KEY]);
    expect(sent).toEqual([]);
  });

  it("a failed render stores nothing and generates nothing", async () => {
    const { service, calls, stored } = harness({ renderFails: true });
    const r = await service.generate(ctx, requester, { requestId: REQUEST });
    expect(r).toMatchObject({ ok: false, error: { kind: "UNAVAILABLE" } });
    expect(calls).toEqual(["generate"]);
    expect(stored).toEqual([]);
  });

  it("an email export is recorded as sent only when the mailer accepts it", async () => {
    const ok = harness({ format: "EMAIL", mailer: "ok" });
    expect(await ok.service.generate(ctx, requester, { requestId: REQUEST })).toMatchObject({
      ok: true,
      value: { status: "SENT", delivered: true },
    });
    expect(ok.sent).toEqual([
      [
        { kind: "EXTERNAL", email: "officer.alpha@example.test" },
        { kind: "INTERNAL", userId: INTERNAL_RECIPIENT },
      ],
    ]);
    expect(ok.calls).toEqual(["generate", "commit", "recordSent"]);

    for (const mailer of ["refuse", "throw"] as const) {
      const h = harness({ format: "EMAIL", mailer });
      expect(await h.service.generate(ctx, requester, { requestId: REQUEST })).toMatchObject({
        ok: true,
        value: { status: "GENERATED", delivered: false },
      });
      expect(h.calls).toEqual(["generate", "commit"]);
    }
  });
});
