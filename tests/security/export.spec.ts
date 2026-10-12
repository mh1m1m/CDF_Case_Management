// Business architecture rebase phase 9 (migration 1930, ADR-026, Q99): the export builder.
// N16 per-item authorization, N19 no protected identity, separation of duties, preview binding, the classification
// check and rule-driven second approval. Every step runs through the api.* commands as `authenticated`; the owner
// connection is used only to plant a withheld item (an item that has since become invisible) and to read the outbox.
import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  USERS,
  admin,
  caseId,
  ownerScenario,
  scenario,
  type OwnerScenario,
  type Scenario,
  type UserKey,
} from "../support/db";
import type { Tx } from "@cdf/infrastructure";
import {
  IC_SEATS,
  committeeIds,
  openItem,
  openWithPresent,
  scheduleMeeting,
  seat,
  vote,
} from "../support/committee";
import { caseFacts } from "../support/decision";

const REASON = "Synthetic: export test reason.";
const JUSTIFICATION = "Synthetic: the regulator asked for the case summary.";

let caseA: string, caseB: string, caseExec: string;
beforeAll(async () => {
  [caseA, caseB, caseExec] = await Promise.all([caseId("0001"), caseId("0002"), caseId("0003")]);
});

interface Draft {
  format?: "PDF" | "XLSX" | "EMAIL";
  audience?: "INTERNAL" | "EXTERNAL";
  party?: string | null;
  justification?: string | null;
}

async function draft(s: Scenario, actor: UserKey, caseIdValue: string, d: Draft = {}): Promise<string> {
  await s.as(actor);
  const audience = d.audience ?? "INTERNAL";
  const party =
    d.party !== undefined ? d.party : audience === "EXTERNAL" ? "Regulator Alpha (synthetic)" : null;
  const justification =
    d.justification !== undefined ? d.justification : audience === "EXTERNAL" ? JUSTIFICATION : null;
  const [r] = await s.tx<{ id: string }[]>`
    select api.create_export_request(${caseIdValue}, ${d.format ?? "PDF"}, ${audience}, 'REGULATOR_REQUEST',
      ${party}, ${justification}) as id`;
  return r!.id;
}

async function addItem(s: Scenario, request: string, type: string, objectId: string) {
  await s.tx`select api.add_export_item(${request}, ${type}, ${objectId})`;
}

interface Preview {
  hash: string;
  withheld: number;
  approvals_required: number;
  matched_rules: { code: string; action: string }[];
  document: {
    items: { included: boolean; object_type: string; content: Record<string, unknown> | null }[];
  };
}

async function preview(s: Scenario, request: string): Promise<Preview> {
  const [r] = await s.tx<{ p: Preview }[]>`select api.preview_export(${request}) as p`;
  return r!.p;
}

async function submit(s: Scenario, request: string, classification: string): Promise<string> {
  const p = await preview(s, request);
  const [r] = await s.tx<{ status: string }[]>`
    select api.submit_export(${request}, ${p.hash}, ${classification}::core.classification_level) as status`;
  return r!.status;
}

async function decide(s: Scenario, actor: UserKey, request: string, decision = "APPROVE"): Promise<string> {
  await s.as(actor);
  const p = await preview(s, request);
  const [r] = await s.tx<{ status: string }[]>`
    select api.decide_export(${request}, ${decision}, ${REASON}, ${p.hash}) as status`;
  return r!.status;
}

interface Generated {
  storage_key: string;
  hash: string;
  deliver_to: string[];
  document: unknown;
}

async function generate(s: Scenario, request: string): Promise<Generated> {
  const [r] = await s.tx<{ g: Generated }[]>`select api.generate_export(${request}) as g`;
  return r!.g;
}

const BY_ID = Object.fromEntries(Object.entries(USERS).map(([k, v]) => [v, k])) as Record<string, UserKey>;

async function notified(s: OwnerScenario, template: string, request: string): Promise<UserKey[]> {
  await s.asOwner();
  const rows = await s.tx<{ recipient_id: string }[]>`
    select distinct recipient_id from notify.outbox where template_code = ${template} and object_id = ${request}`;
  return rows.map((r) => BY_ID[r.recipient_id]!).sort();
}

describe("export builder (Q99, ADR-026)", () => {
  it("an internal file of a visible item needs no approval and generates exactly what was previewed", async () => {
    await scenario(async (s) => {
      const req = await draft(s, "lead", caseA);
      await addItem(s, req, "CASE_SUMMARY", caseA);
      const p = await preview(s, req);
      expect(p).toMatchObject({ withheld: 0, approvals_required: 0, matched_rules: [] });
      expect(p.document.items[0]).toMatchObject({ included: true, object_type: "CASE_SUMMARY" });
      expect(await submit(s, req, "CONFIDENTIAL")).toBe("APPROVED");
      const g = await generate(s, req);
      expect(g.storage_key).toMatch(/^exports\/[0-9a-f-]{36}$/);
      expect(g.hash).toBe(p.hash);
      expect(g.deliver_to).toEqual([]);
      // Files are final once generated; a second generation or a cancellation is refused.
      await s.expectError("CDF_CONFLICT:NOT_APPROVED", (tx) => tx`select api.generate_export(${req})`);
      await s.expectError(
        "CDF_CONFLICT:NOT_CANCELLABLE",
        (tx) => tx`select api.cancel_export(${req}, ${REASON})`,
      );
      await s.expectError("CDF_CONFLICT:NOT_EMAIL", (tx) => tx`select api.record_export_sent(${req})`);
      await s.as("dpo");
      const events = await s.tx<{ action: string }[]>`
        select action from audit.audit_event where object_id = ${req} order by seq`;
      expect(events.map((e) => e.action)).toEqual([
        "EXPORT_REQUESTED",
        "EXPORT_ITEM_ADDED",
        "EXPORT_PREVIEWED",
        "EXPORT_PREVIEWED",
        "EXPORT_SUBMITTED",
        "EXPORT_GENERATED",
      ]);
    });
  });

  it("N16: an item the requester cannot see, from another case or missing answers NOT_FOUND alike", async () => {
    await scenario(async (s) => {
      // lead works case 0001 only; the case manager sees both 0001 and 0002.
      const req = await draft(s, "lead", caseA);
      for (const [type, id] of [
        ["CASE_SUMMARY", caseB],
        ["CASE_SUMMARY", caseExec],
        ["CASE_SUMMARY", randomUUID()],
        ["FINDING", randomUUID()],
        ["MINUTES", randomUUID()],
      ] as const) {
        await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.add_export_item(${req}, ${type}, ${id})`);
      }
      const other = await draft(s, "caseManager", caseA);
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) => tx`select api.add_export_item(${other}, 'CASE_SUMMARY', ${caseB})`,
      );
      await s.expectError(
        "CDF_INVALID:object_type",
        (tx) => tx`select api.add_export_item(${other}, 'EVIDENCE', ${caseA})`,
      );
      // A finding the case manager can read, but on another case.
      const facts = await caseFacts(s, caseB);
      await s.as("caseManager");
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) => tx`select api.add_export_item(${other}, 'FINDING', ${facts.finding})`,
      );
      // Recipients belong to email exports, and external addresses to external ones.
      await s.expectError(
        "CDF_CONFLICT:FORMAT_HAS_NO_RECIPIENTS",
        (tx) => tx`select api.add_export_recipient(${other}, 'INTERNAL', ${USERS.lead}, null)`,
      );
      const mail = await draft(s, "caseManager", caseA, { format: "EMAIL" });
      await s.expectError(
        "CDF_CONFLICT:INTERNAL_AUDIENCE",
        (tx) => tx`select api.add_export_recipient(${mail}, 'EXTERNAL', null, 'officer.alpha@example.test')`,
      );
      // People without EXPORT_REQUEST cannot start one, and an outsider cannot tell the case exists.
      await s.as("investigatorA");
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.create_export_request(${caseA}, 'PDF', 'INTERNAL', 'AUDIT', null, null)`,
      );
      await s.as("lead");
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) => tx`select api.create_export_request(${caseB}, 'PDF', 'INTERNAL', 'AUDIT', null, null)`,
      );
      // A draft is its requester's alone: approvers cannot see or act on it.
      await s.as("caseManager");
      expect(await s.tx`select id from exchange.export_request where id = ${req}`).toEqual([]);
      await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.preview_export(${req})`);
    });
  });

  it("a withheld item stays listed, and blocks submission and approval", async () => {
    await ownerScenario(async (s) => {
      const req = await draft(s, "caseManager", caseA, { audience: "EXTERNAL" });
      await addItem(s, req, "CASE_SUMMARY", caseA);
      // Fixture: an item the requester can no longer see (a finding that is not theirs to read).
      await s.asOwner();
      await s.tx`insert into exchange.export_item (request_id, position, object_type, object_id, added_by)
                 values (${req}, 2, 'FINDING', ${randomUUID()}, ${USERS.caseManager})`;
      await s.as("caseManager");
      const p = await preview(s, req);
      expect(p.withheld).toBe(1);
      expect(p.document.items[1]).toMatchObject({ included: false, content: null });
      await s.expectError(
        "CDF_CONFLICT:ITEMS_WITHHELD",
        (tx) => tx`select api.submit_export(${req}, ${p.hash}, 'CONFIDENTIAL'::core.classification_level)`,
      );
    });
    await ownerScenario(async (s) => {
      const req = await draft(s, "caseManager", caseA, { audience: "EXTERNAL" });
      await addItem(s, req, "CASE_SUMMARY", caseA);
      expect(await submit(s, req, "CONFIDENTIAL")).toBe("SUBMITTED");
      await s.asOwner();
      await s.tx`insert into exchange.export_item (request_id, position, object_type, object_id, added_by)
                 values (${req}, 2, 'FINDING', ${randomUUID()}, ${USERS.caseManager})`;
      await s.as("grcDirector");
      const p = await preview(s, req);
      await s.expectError(
        "CDF_CONFLICT:ITEMS_WITHHELD",
        (tx) => tx`select api.decide_export(${req}, 'APPROVE', ${REASON}, ${p.hash})`,
      );
    });
  });

  it("external email: justification, party, classification check and two approvals by different people", async () => {
    await ownerScenario(async (s) => {
      await s.as("lead");
      for (const [party, justification, field] of [
        ["Regulator Alpha (synthetic)", null, "justification"],
        ["Regulator Alpha (synthetic)", "Too short.", "justification"],
        [null, JUSTIFICATION, "external_party"],
      ] as const) {
        await s.expectError(
          `CDF_INVALID:${field}`,
          (tx) =>
            tx`select api.create_export_request(${caseA}, 'EMAIL', 'EXTERNAL', 'REGULATOR_REQUEST', ${party}, ${justification})`,
        );
      }
      await s.expectError(
        "CDF_INVALID:external_party",
        (tx) =>
          tx`select api.create_export_request(${caseA}, 'PDF', 'INTERNAL', 'AUDIT', 'Regulator Alpha (synthetic)', null)`,
      );
      const req = await draft(s, "lead", caseA, { format: "EMAIL", audience: "EXTERNAL" });
      await addItem(s, req, "CASE_SUMMARY", caseA);
      await s.expectError(
        "CDF_INVALID:email",
        (tx) =>
          tx`select api.add_export_recipient(${req}, 'EXTERNAL', null, 'officer@regulator.example.com')`,
      );
      // investigatorB does not work case 0001; investigatorA does.
      await s.expectError(
        "CDF_INVALID:user_id",
        (tx) => tx`select api.add_export_recipient(${req}, 'INTERNAL', ${USERS.investigatorB}, null)`,
      );
      await s.tx`select api.add_export_recipient(${req}, 'EXTERNAL', null, ' Officer.Alpha@Example.Test ')`;
      await s.expectError(
        "CDF_CONFLICT:ALREADY_ADDED",
        (tx) => tx`select api.add_export_recipient(${req}, 'EXTERNAL', null, 'officer.alpha@example.test')`,
      );
      const before = await preview(s, req);
      await s.tx`select api.add_export_recipient(${req}, 'INTERNAL', ${USERS.investigatorA}, null)`;
      // The preview no longer matches: recipients are part of what is approved.
      await s.expectError(
        "CDF_CONFLICT:PREVIEW_CHANGED",
        (tx) =>
          tx`select api.submit_export(${req}, ${before.hash}, 'CONFIDENTIAL'::core.classification_level)`,
      );
      const p = await preview(s, req);
      expect(p.approvals_required).toBe(2);
      expect(p.matched_rules).toEqual([{ code: "EXTERNAL_CONFIDENTIAL", action: "REQUIRE_SECOND_APPROVAL" }]);
      await s.expectError(
        "CDF_CONFLICT:CLASSIFICATION_MISMATCH",
        (tx) => tx`select api.submit_export(${req}, ${p.hash}, 'RESTRICTED'::core.classification_level)`,
      );
      expect(await submit(s, req, "CONFIDENTIAL")).toBe("SUBMITTED");
      expect(await notified(s, "EXPORT_APPROVAL_REQUESTED", req)).toEqual([
        "caseManager",
        "grcDeputy",
        "grcDirector",
      ]);
      // Separation of duties: never the requester; a stage needs its permission; nobody approves twice.
      await s.as("lead");
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.decide_export(${req}, 'APPROVE', ${REASON}, ${p.hash})`,
      );
      await s.as("investigatorA");
      expect(await s.tx`select id from exchange.export_request where id = ${req}`).toEqual([]);
      await s.as("grcDirector");
      await s.expectError(
        "CDF_CONFLICT:PREVIEW_CHANGED",
        (tx) => tx`select api.decide_export(${req}, 'APPROVE', ${REASON}, ${"0".repeat(64)})`,
      );
      expect(await decide(s, "grcDirector", req)).toBe("SUBMITTED");
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.decide_export(${req}, 'APPROVE', ${REASON}, ${p.hash})`,
      );
      await s.as("caseManager");
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.decide_export(${req}, 'APPROVE', ${REASON}, ${p.hash})`,
      );
      expect(await notified(s, "EXPORT_APPROVAL_REQUESTED", req)).toEqual([
        "caseManager",
        "grcDeputy",
        "grcDirector",
      ]);
      await s.as("lead");
      await s.expectError("CDF_CONFLICT:NOT_APPROVED", (tx) => tx`select api.generate_export(${req})`);
      expect(await decide(s, "grcDeputy", req)).toBe("APPROVED");
      expect(await notified(s, "EXPORT_DECIDED", req)).toEqual(["lead"]);
      // Only the requester generates, sends or cancels.
      await s.as("grcDirector");
      for (const call of [
        (tx: Tx) => tx`select api.generate_export(${req})`,
        (tx: Tx) => tx`select api.cancel_export(${req}, ${REASON})`,
      ])
        await s.expectError("CDF_FORBIDDEN", call);
      await s.as("lead");
      const g = await generate(s, req);
      expect(g.deliver_to).toEqual(["investigator.a@example.test", "officer.alpha@example.test"]);
      await s.tx`select api.record_export_sent(${req})`;
      const [row] = await s.tx<{ status: string; approvals: number }[]>`
        select q.status, (select count(*)::int from exchange.export_approval a where a.request_id = q.id) as approvals
        from exchange.export_request q where q.id = ${req}`;
      expect(row).toEqual({ status: "SENT", approvals: 2 });
      // Addresses never enter the audit ledger.
      await s.as("dpo");
      const audit = await s.tx<{ t: string }[]>`
        select coalesce(reason, '') || metadata::text as t from audit.audit_event where object_id = ${req}`;
      expect(audit.length).toBeGreaterThan(0);
      expect(audit.filter((a) => /officer\.alpha|investigator\.a@/i.test(a.t))).toEqual([]);
    });
  });

  it("an approval and the generation are bound to the submitted content and classification", async () => {
    await scenario(async (s) => {
      const req = await draft(s, "caseManager", caseB, { audience: "EXTERNAL" });
      await addItem(s, req, "CASE_SUMMARY", caseB);
      expect(await submit(s, req, "RESTRICTED")).toBe("SUBMITTED");
      // The requester never approves their own export, even holding EXPORT_APPROVE.
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.decide_export(${req}, 'APPROVE', ${REASON}, ${"0".repeat(64)})`,
      );
      await s.as("grcDirector");
      const seen = await preview(s, req);
      await s.as("caseManager");
      const [c] = await s.tx<
        { v: number }[]
      >`select row_version as v from case_mgmt.case_record where id = ${caseB}`;
      await s.tx`select api.update_case_details(${caseB}, 'Tender scoring irregularity, revised (synthetic)',
        'Synthetic case: tender evaluation without documented scoring.', 'HIGH', ${c!.v})`;
      await s.as("grcDirector");
      await s.expectError(
        "CDF_CONFLICT:PREVIEW_CHANGED",
        (tx) => tx`select api.decide_export(${req}, 'APPROVE', ${REASON}, ${seen.hash})`,
      );
      // Rejecting releases nothing, so a changed export can always be sent back.
      expect(await decide(s, "grcDirector", req, "REJECT")).toBe("REJECTED");
      await s.as("caseManager");
      await s.expectError("CDF_CONFLICT:NOT_APPROVED", (tx) => tx`select api.generate_export(${req})`);
      await s.expectError(
        "CDF_CONFLICT:NOT_CANCELLABLE",
        (tx) => tx`select api.cancel_export(${req}, ${REASON})`,
      );
    });

    await scenario(async (s) => {
      const req = await draft(s, "caseManager", caseB, { audience: "EXTERNAL" });
      await addItem(s, req, "CASE_SUMMARY", caseB);
      expect(await submit(s, req, "RESTRICTED")).toBe("SUBMITTED");
      expect(await decide(s, "grcDirector", req)).toBe("APPROVED");
      // Raising the classification after approval changes what would be sent.
      await s.as("caseManager");
      await s.tx`select api.change_case_classification(${caseB}, 'CONFIDENTIAL'::core.classification_level, false, ${REASON})`;
      await s.expectError("CDF_CONFLICT:PREVIEW_CHANGED", (tx) => tx`select api.generate_export(${req})`);
      await s.tx`select api.cancel_export(${req}, ${REASON})`;
      await s.expectError(
        "CDF_CONFLICT:NOT_CANCELLABLE",
        (tx) => tx`select api.cancel_export(${req}, ${REASON})`,
      );
    });
  });

  it("an internal recipient who loses access to the case stops submission and generation", async () => {
    // investigatorA declares a conflict on case 0001 and so loses it (user_case_gate).
    const conflicted = async (s: Scenario) => {
      await s.as("investigatorA");
      await s.tx`select api.declare_conflict(${caseA}, true, 'Synthetic: a declared conflict.')`;
      await s.as("caseManager");
    };
    await scenario(async (s) => {
      const req = await draft(s, "caseManager", caseA, { format: "EMAIL" });
      await addItem(s, req, "CASE_SUMMARY", caseA);
      await s.tx`select api.add_export_recipient(${req}, 'INTERNAL', ${USERS.investigatorA}, null)`;
      const p = await preview(s, req);
      await conflicted(s);
      await s.expectError(
        "CDF_CONFLICT:RECIPIENT_NOT_ELIGIBLE",
        (tx) => tx`select api.submit_export(${req}, ${p.hash}, 'CONFIDENTIAL'::core.classification_level)`,
      );
    });
    await scenario(async (s) => {
      const req = await draft(s, "caseManager", caseA, { format: "EMAIL" });
      await addItem(s, req, "CASE_SUMMARY", caseA);
      await s.tx`select api.add_export_recipient(${req}, 'INTERNAL', ${USERS.investigatorA}, null)`;
      expect(await submit(s, req, "CONFIDENTIAL")).toBe("APPROVED");
      await conflicted(s);
      await s.expectError(
        "CDF_CONFLICT:RECIPIENT_NOT_ELIGIBLE",
        (tx) => tx`select api.generate_export(${req})`,
      );
    });
  });

  it("N19: an export of the identified-reporter case carries no reporter identity or WB id", async () => {
    await scenario(async (s) => {
      const facts = await caseFacts(s, caseB);
      const req = await draft(s, "caseManager", caseB, { audience: "EXTERNAL" });
      await addItem(s, req, "CASE_SUMMARY", caseB);
      await addItem(s, req, "FINDING", facts.finding);
      const p = await preview(s, req);
      expect(p.withheld).toBe(0);
      expect(await submit(s, req, "RESTRICTED")).toBe("SUBMITTED");
      expect(await decide(s, "grcDirector", req)).toBe("APPROVED");
      await s.as("caseManager");
      const g = await generate(s, req);
      const [wb] = await admin<
        { wb: string }[]
      >`select reporter_wb_id as wb from case_mgmt.case_record where id = ${caseB}`;
      for (const text of [JSON.stringify(p), JSON.stringify(g)]) {
        expect(text).not.toMatch(/reporter\.gamma|1000000001|WBID-/i);
        expect(text).not.toContain(wb!.wb);
      }
      expect(JSON.stringify(g.document)).toContain("Synthetic: finding rationale text.");
    });
  });

  it("rules: SECRET is refused externally, a restricted case needs an approval, a new rule binds pending exports", async () => {
    await ownerScenario(async (s) => {
      const ext = await draft(s, "grcDirector", caseExec, { audience: "EXTERNAL" });
      await addItem(s, ext, "CASE_SUMMARY", caseExec);
      const p = await preview(s, ext);
      expect(p.matched_rules.map((r) => r.code)).toEqual([
        "EXTERNAL_CONFIDENTIAL",
        "EXTERNAL_SECRET",
        "RESTRICTED_CASE",
      ]);
      await s.expectError(
        "CDF_CONFLICT:REFUSED_BY_RULE",
        (tx) => tx`select api.submit_export(${ext}, ${p.hash}, 'SECRET'::core.classification_level)`,
      );

      const internal = await draft(s, "grcDirector", caseExec);
      await addItem(s, internal, "CASE_SUMMARY", caseExec);
      expect(await submit(s, internal, "SECRET")).toBe("SUBMITTED");
      // grcDeputy is not cleared into the restricted case: not asked, cannot see it.
      expect(await notified(s, "EXPORT_APPROVAL_REQUESTED", internal)).toEqual([]);
      await s.as("grcDeputy");
      await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.preview_export(${internal})`);
      await s.as("grcDirector");
      await s.tx`select api.grant_case_access(${caseExec}, ${USERS.grcDeputy}, 'CASE', ${REASON}, null)`;
      expect(await decide(s, "grcDeputy", internal)).toBe("APPROVED");

      // Only EXPORT_POLICY_ADMIN sets rules; a rule in force from now binds an approved, ungenerated export.
      const pending = await draft(s, "lead", caseA);
      await addItem(s, pending, "CASE_SUMMARY", caseA);
      expect(await submit(s, pending, "CONFIDENTIAL")).toBe("APPROVED");
      for (const actor of ["caseManager", "platformAdmin"] as const) {
        await s.as(actor);
        await s.expectError(
          "CDF_FORBIDDEN",
          (tx) =>
            tx`select api.set_export_rule('INTERNAL_ALL', 'INTERNAL', null, null, false, 'REQUIRE_SECOND_APPROVAL', now(), 'SOURCE_REQUIRED', ${REASON})`,
        );
      }
      await s.as("grcDirector");
      await s.tx`select api.set_export_rule('INTERNAL_ALL', 'INTERNAL', null, null, false, 'REQUIRE_SECOND_APPROVAL', now(), 'SOURCE_REQUIRED', ${REASON})`;
      await s.expectError(
        "CDF_CONFLICT:LATER_RULE_EXISTS",
        (tx) =>
          tx`select api.set_export_rule('INTERNAL_ALL', 'INTERNAL', null, null, false, 'NONE', now(), 'SOURCE_REQUIRED', ${REASON})`,
      );
      await s.as("lead");
      await s.expectError(
        "CDF_CONFLICT:APPROVALS_CHANGED",
        (tx) => tx`select api.generate_export(${pending})`,
      );
    });
  });

  it("minutes: only approved minutes are exportable, and externally they need a second approval", async () => {
    await scenario(async (s) => {
      const { ic } = await committeeIds();
      const voters: UserKey[] = ["committeeChair", "legal", "legalB", "lead"];
      await seat(s, ic, IC_SEATS);
      const f = await scheduleMeeting(s, ic, caseB);
      await openWithPresent(s, f, voters);
      const item = await openItem(s, f.meeting);
      for (const u of voters) await vote(s, u, item, "APPROVE");
      await s.as("committeeSecretary");
      await s.tx`select api.close_vote_item(${item}, null)`;
      await s.tx`select api.close_meeting(${f.meeting}, ${REASON})`;
      const [m] = await s.tx<{ id: string }[]>`
        select api.generate_minutes(${f.meeting}, 'Synthetic minutes narrative for export.') as id`;
      const req = await draft(s, "caseManager", caseB, { audience: "EXTERNAL" });
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) => tx`select api.add_export_item(${req}, 'MINUTES', ${m!.id})`,
      );
      for (const u of voters) {
        await s.as(u);
        await s.tx`select api.review_minutes(${m!.id}, 'APPROVE', null)`;
      }
      await s.as("caseManager");
      await addItem(s, req, "MINUTES", m!.id);
      const p = await preview(s, req);
      expect(p.approvals_required).toBe(2);
      expect(p.matched_rules.map((r) => r.code)).toEqual(["EXTERNAL_MINUTES"]);
      expect(Object.keys(p.document.items[0]!.content!).sort()).toEqual([
        "finalised_at",
        "narrative",
        "status",
        "version_no",
      ]);
    });
  });
});
