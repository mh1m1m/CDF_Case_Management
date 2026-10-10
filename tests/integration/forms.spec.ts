// Phase 8 forms engine through the real application service, gateway, database, RLS and audit (ADR-011):
// registry listing, start → save → prepare → review, client-verifiable hashes, field-level validation and
// denials recorded as security events.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createFormsService, createInvestigationService, type FormsService } from "@cdf/application";
import type { Actor } from "@cdf/contracts";
import { FORM_DEFINITIONS, formContentHash, getFormDefinition } from "@cdf/domain";
import {
  PostgresFormsGateway,
  PostgresInvestigationGateway,
  PostgresSecurityEventSink,
} from "@cdf/infrastructure";
import { USERS, admin, bff, caseId, type UserKey } from "../support/db";

const investigation = createInvestigationService({
  gateway: new PostgresInvestigationGateway(bff),
  securityEvents: new PostgresSecurityEventSink(bff),
});
const forms: FormsService = createFormsService({
  gateway: new PostgresFormsGateway(bff),
  securityEvents: new PostgresSecurityEventSink(bff),
});
let caseA: string;
beforeAll(async () => {
  caseA = await caseId("0001");
});

const ctxFor = (user: UserKey) => ({ userId: USERS[user], requestId: randomUUID() });
async function actor(user: UserKey): Promise<Actor> {
  const a = await investigation.loadActor(ctxFor(user));
  if (!a) throw new Error(`no actor for ${user}`);
  return a;
}
function failure(result: { ok: boolean }): string {
  if (result.ok) return "ok";
  if ("error" in result) {
    const e = (result as { error: { kind: string; detail?: string } }).error;
    return e.detail ? `${e.kind}:${e.detail}` : e.kind;
  }
  return "fieldErrors";
}
function issuePaths(result: { ok: boolean }): string[] {
  if (result.ok || !("fieldErrors" in result)) return [];
  return (result as { fieldErrors: { issues: { path: PropertyKey[] }[] } }).fieldErrors.issues.map((i) =>
    i.path.join("."),
  );
}

async function startOnCaseA(user: UserKey, formCode: string): Promise<string> {
  const r = await forms.start(ctxFor(user), await actor(user), {
    caseId: caseA,
    formCode,
    classification: "CONFIDENTIAL",
  });
  if (!r.ok) throw new Error(`start ${formCode} as ${user}: ${failure(r)}`);
  return r.value.instanceId;
}

describe("forms slice", () => {
  it("lists the whole registry with the caller's right to start each form on this case", async () => {
    const mine = await forms.listDefinitions(ctxFor("investigatorA"), caseA);
    expect(mine.map((d) => d.code)).toEqual(FORM_DEFINITIONS.map((d) => d.code));
    expect(mine.every((d) => d.isEnabled && d.versionNo === 1)).toBe(true);
    const canStart = (list: { code: string; canStart: boolean }[]) =>
      Object.fromEntries(list.map((d) => [d.code, d.canStart]));
    expect(canStart(mine)).toMatchObject({ "WB-FRM-11": true, "WB-FRM-12": true, "WB-FRM-13": false });
    const secretary = await forms.listDefinitions(ctxFor("committeeSecretary"), caseA);
    expect(canStart(secretary)).toMatchObject({ "WB-FRM-11": false, "WB-FRM-13": true });
    // The chair reviews and approves; the GRC director approves; neither prepares anything.
    for (const user of ["committeeChair", "grcDirector"] as const) {
      const list = await forms.listDefinitions(ctxFor(user), caseA);
      expect(
        list.some((d) => d.canStart),
        user,
      ).toBe(false);
    }
    // Someone who cannot see the case can read the public registry but start nothing on this case.
    const outsider = await forms.listDefinitions(ctxFor("investigatorB"), caseA);
    expect(outsider).toHaveLength(FORM_DEFINITIONS.length);
    expect(outsider.some((d) => d.canStart)).toBe(false);
  });

  it("runs start → save → prepare → review with hashes the client can recompute", async () => {
    const a = await actor("investigatorA");
    const ctx = ctxFor("investigatorA");
    const instanceId = await startOnCaseA("investigatorA", "WB-FRM-11");
    const data = {
      evidence_count: "3",
      evidence_scope: "Synthetic scope\nline two\twith a tab — ونص عربي",
      chain_of_custody_status: "توجد ملاحظات",
      storage_confirmation: "true",
      integrity_exceptions: "",
    };
    const saved = await forms.saveDraft(ctx, a, { instanceId, formCode: "WB-FRM-11", data });
    expect(failure(saved)).toBe("ok");
    if (!saved.ok) return;
    const definition = getFormDefinition("WB-FRM-11")!;
    const { integrity_exceptions: _empty, ...kept } = data;
    expect(saved.value.versionNo).toBe(1);
    expect(saved.value.contentHash).toBe(await formContentHash("WB-FRM-11", definition.schemaHash, kept));

    const detail = await forms.getInstance(ctx, instanceId);
    expect(detail).toMatchObject({
      id: instanceId,
      caseId: caseA,
      formCode: "WB-FRM-11",
      status: "DRAFT",
      finalStatus: "REVIEWED",
      classification: "CONFIDENTIAL",
      currentVersionNo: 1,
      contentHash: saved.value.contentHash,
      data: kept,
      capabilities: {
        canSave: true,
        canPrepare: true,
        canReview: false,
        canApprove: false,
        canWithdraw: true,
      },
    });
    expect(detail!.definition.schemaHash).toBe(definition.schemaHash);
    expect(detail!.definition.sections).toEqual(definition.sections);
    expect(detail!.caseNumber).toMatch(/-0001$/);

    // Saving the same content again creates no version; a changed field does.
    const again = await forms.saveDraft(ctx, a, { instanceId, formCode: "WB-FRM-11", data });
    expect(again.ok && again.value.versionNo).toBe(1);
    const changed = await forms.saveDraft(ctx, a, {
      instanceId,
      formCode: "WB-FRM-11",
      data: { ...data, evidence_count: "4" },
    });
    expect(changed.ok && changed.value.versionNo).toBe(2);

    // Field problems come back on the field, in the same shape as schema problems, and reach no database.
    const bad = await forms.saveDraft(ctx, a, {
      instanceId,
      formCode: "WB-FRM-11",
      data: { ...data, evidence_count: "three", unknown_key: "x" },
    });
    expect(failure(bad)).toBe("fieldErrors");
    expect(issuePaths(bad).sort()).toEqual(["data.evidence_count", "data.unknown_key"]);
    const tooLong = await forms.saveDraft(ctx, a, {
      instanceId,
      formCode: "WB-FRM-11",
      data: { ...data, evidence_scope: "x".repeat(4001) },
    });
    expect(issuePaths(tooLong)).toEqual(["data.evidence_scope"]);

    const prepared = await forms.prepare(ctx, a, { instanceId, formCode: "WB-FRM-11" });
    expect(failure(prepared)).toBe("ok");
    const locked = await forms.getInstance(ctx, instanceId);
    expect(locked).toMatchObject({
      status: "PREPARED",
      preparedBy: USERS.investigatorA,
      preparedVersionNo: 2,
      capabilities: {
        canSave: false,
        canPrepare: false,
        canReview: false,
        canApprove: false,
        canWithdraw: true,
      },
    });

    const lead = await actor("lead");
    const asLead = ctxFor("lead");
    const seen = await forms.getInstance(asLead, instanceId);
    expect(seen!.capabilities).toEqual({
      canSave: false,
      canPrepare: false,
      canReview: true,
      canApprove: false,
      canWithdraw: true,
    });
    const reviewed = await forms.review(asLead, lead, {
      instanceId,
      formCode: "WB-FRM-11",
      outcome: "REVIEWED",
    });
    expect(failure(reviewed)).toBe("ok");
    const final = await forms.getInstance(asLead, instanceId);
    expect(final).toMatchObject({
      status: "REVIEWED",
      reviewedBy: USERS.lead,
      reviewedByName: expect.any(String),
      capabilities: {
        canSave: false,
        canPrepare: false,
        canReview: false,
        canApprove: false,
        canWithdraw: false,
      },
    });
    expect(final!.versions.map((v) => v.versionNo)).toEqual([1, 2]);
    expect(final!.events.map((e) => [e.eventType, e.fromStatus, e.toStatus])).toEqual([
      ["CREATED", null, "DRAFT"],
      ["SAVED", "DRAFT", "DRAFT"],
      ["SAVED", "DRAFT", "DRAFT"],
      ["PREPARED", "DRAFT", "PREPARED"],
      ["REVIEWED", "PREPARED", "REVIEWED"],
    ]);
    const listed = await forms.listInstances(ctxFor("caseManager"), caseA);
    expect(listed.find((i) => i.id === instanceId)).toMatchObject({
      status: "REVIEWED",
      currentVersionNo: 2,
      createdBy: USERS.investigatorA,
    });
  });

  it("reports missing required fields at prepare time and demands a reason to return a form", async () => {
    const secretary = await actor("committeeSecretary");
    const ctx = ctxFor("committeeSecretary");
    const instanceId = await startOnCaseA("committeeSecretary", "WB-FRM-13");
    const partial = await forms.saveDraft(ctx, secretary, {
      instanceId,
      formCode: "WB-FRM-13",
      data: { chair: "Committee Chair Xi" },
    });
    expect(failure(partial)).toBe("ok");
    const early = await forms.prepare(ctx, secretary, { instanceId, formCode: "WB-FRM-13" });
    expect(failure(early)).toBe("INVALID:formation_reference");
    const full = await forms.saveDraft(ctx, secretary, {
      instanceId,
      formCode: "WB-FRM-13",
      data: {
        formation_reference: "CDF-DEMO-COMMITTEE-0002",
        formation_date: "2026-03-02",
        chair: "Committee Chair Xi",
        members: "Committee Member Epsilon",
        secretary: "Committee Secretary Nu",
        scope: "Synthetic committee scope",
        independence_confirmed: "true",
      },
    });
    expect(failure(full)).toBe("ok");
    expect(failure(await forms.prepare(ctx, secretary, { instanceId, formCode: "WB-FRM-13" }))).toBe("ok");

    const chair = await actor("committeeChair");
    const asChair = ctxFor("committeeChair");
    const noReason = await forms.review(asChair, chair, {
      instanceId,
      formCode: "WB-FRM-13",
      outcome: "RETURNED",
    });
    expect(issuePaths(noReason)).toEqual(["reason"]);
    const returned = await forms.review(asChair, chair, {
      instanceId,
      formCode: "WB-FRM-13",
      outcome: "RETURNED",
      reason: "Synthetic: confirm member independence",
    });
    expect(failure(returned)).toBe("ok");
    const detail = await forms.getInstance(ctx, instanceId);
    expect(detail).toMatchObject({ status: "DRAFT", preparedBy: null, capabilities: { canSave: true } });
    expect(detail!.events.at(-1)).toMatchObject({
      eventType: "RETURNED",
      reason: "Synthetic: confirm member independence",
    });
  });

  it("refuses outsiders and unentitled roles and records each denial as a security event", async () => {
    const instanceId = await startOnCaseA("investigatorA", "WB-FRM-11");

    const b = await actor("investigatorB");
    const asB = ctxFor("investigatorB");
    const save = await forms.saveDraft(asB, b, {
      instanceId,
      formCode: "WB-FRM-11",
      data: { evidence_scope: "not mine" },
    });
    expect(failure(save)).toBe("NOT_FOUND");
    expect(await forms.getInstance(asB, instanceId)).toBeNull();

    const committee = await actor("committee");
    const asCommittee = ctxFor("committee");
    const start = await forms.start(asCommittee, committee, {
      caseId: caseA,
      formCode: "WB-FRM-13",
      classification: "CONFIDENTIAL",
    });
    expect(failure(start)).toBe("FORBIDDEN"); // pre-check: COMMITTEE_MEMBER has no FORM_PREPARE

    const chair = await actor("committeeChair");
    const asChair = ctxFor("committeeChair");
    const review = await forms.review(asChair, chair, {
      instanceId,
      formCode: "WB-FRM-11",
      outcome: "REVIEWED",
    });
    expect(failure(review)).toBe("FORBIDDEN"); // pre-check: the chair is not entitled to investigation forms

    const denials = await admin<{ request_id: string; meta: Record<string, string> }[]>`
      select request_id, metadata as meta from audit.audit_event
      where action = 'COMMAND_DENIED' and request_id in (${asB.requestId}, ${asCommittee.requestId}, ${asChair.requestId})
      order by seq`;
    expect(denials.map((d) => [d.meta.command, d.meta.outcome, d.meta.form_code])).toEqual([
      ["save_form_draft", "NOT_FOUND", "WB-FRM-11"],
      ["start_form", "FORBIDDEN", "WB-FRM-13"],
      ["review_form", "FORBIDDEN", "WB-FRM-11"],
    ]);
    for (const d of denials) expect(JSON.stringify(d.meta)).not.toContain("not mine");
    const opened = await admin<{ n: number }[]>`
      select count(*)::int as n from audit.audit_event where action = 'FORM_ACCESS_DENIED' and object_id = ${instanceId}`;
    expect(opened[0]!.n).toBe(1);
  });
});
