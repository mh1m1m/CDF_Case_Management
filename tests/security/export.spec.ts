// Business architecture rebase phase 9 (migration 1930, ADR-026, Q99): the export builder.
// N16 per-item authorization, N19 no protected identity, separation of duties, preview binding, the classification
// check, rule-driven second approval, the rule author's exclusion (AGENT-09 X1) and the Restricted Case Authority's
// decision on a restricted case (DEC-61/62 precedent). Every step runs through the api.* commands as `authenticated`;
// the owner connection is used only to plant a withheld item (an item that has since become invisible) and to read
// the outbox.
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
    select api.create_export_request(${caseIdValue}, ${d.format ?? "PDF"}, ${audience}, 'REGULATORY_OR_EXTERNAL_AUTHORITY',
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
  authority_approval_required: boolean;
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
  deliver_to: ({ kind: "INTERNAL"; user_id: string } | { kind: "EXTERNAL"; email: string })[];
  document: unknown;
}

async function generate(s: Scenario, request: string): Promise<Generated> {
  const [r] = await s.tx<{ g: Generated }[]>`select api.generate_export(${request}) as g`;
  return r!.g;
}

/** The Restricted Case Authority's decision, on the hash the actor previews. */
async function authority(
  s: Scenario,
  actor: UserKey,
  request: string,
  decision = "APPROVE",
): Promise<string> {
  await s.as(actor);
  const p = await preview(s, request);
  const [r] = await s.tx<{ status: string }[]>`
    select api.decide_restricted_export(${request}, ${decision}, ${REASON}, ${p.hash}) as status`;
  return r!.status;
}

async function rule(s: Scenario, actor: UserKey, code: string, args: string) {
  await s.as(actor);
  const [audience, min, objectType, restricted, action] = args.split(" ");
  await s.tx`select api.set_export_rule(${code}, ${audience!}, ${min === "-" ? null : min!}::core.classification_level,
    ${objectType === "-" ? null : objectType!}, ${restricted === "restricted"}, ${action!}, now(), 'SOURCE_REQUIRED',
    ${REASON})`;
}

/** A rule version authored before migration 2040, when a GRC director could both set rules and approve (1930): the
 *  owner connection plants it as api.set_export_rule wrote it. AGENT-09 X1 still excludes its author. */
async function legacyRule(s: OwnerScenario, author: UserKey, code: string, args: string) {
  await s.asOwner();
  const [audience, min, objectType, restricted, action] = args.split(" ");
  await s.tx`update exchange.approval_rule set effective_to = now() where code = ${code} and effective_to is null`;
  await s.tx`insert into exchange.approval_rule (code, audience, min_classification, object_type, restricted_only,
                                               action, source_status, reason, effective_from, created_by)
             values (${code}, ${audience!}, ${min === "-" ? null : min!}::core.classification_level,
                     ${objectType === "-" ? null : objectType!}, ${restricted === "restricted"}, ${action!},
                     'SOURCE_REQUIRED', ${REASON}, now(), ${USERS[author]})`;
}

async function storedApprovals(s: OwnerScenario, request: string): Promise<number> {
  await s.asOwner();
  const [r] = await s.tx<{ n: number }[]>`
    select approvals_required as n from exchange.export_request where id = ${request}`;
  return r!.n;
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
        (tx) =>
          tx`select api.create_export_request(${caseA}, 'PDF', 'INTERNAL', 'INTERNAL_MANAGEMENT_REVIEW', null, null)`,
      );
      await s.as("lead");
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) =>
          tx`select api.create_export_request(${caseB}, 'PDF', 'INTERNAL', 'INTERNAL_MANAGEMENT_REVIEW', null, null)`,
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
            tx`select api.create_export_request(${caseA}, 'EMAIL', 'EXTERNAL', 'REGULATORY_OR_EXTERNAL_AUTHORITY', ${party}, ${justification})`,
        );
      }
      await s.expectError(
        "CDF_INVALID:external_party",
        (tx) =>
          tx`select api.create_export_request(${caseA}, 'PDF', 'INTERNAL', 'INTERNAL_MANAGEMENT_REVIEW', 'Regulator Alpha (synthetic)', null)`,
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
      // Internal recipients by id only (AGENT-09 note ii): the mail adapter resolves their addresses.
      expect(g.deliver_to).toEqual([
        { kind: "EXTERNAL", email: "officer.alpha@example.test" },
        { kind: "INTERNAL", user_id: USERS.investigatorA },
      ]);
      expect(JSON.stringify(g)).not.toContain("investigator.a@");
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
        "RESTRICTED_CASE_AUTHORITY",
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
      // The approval stage is given; the case's Restricted Case Authority is its owner, here also the requester, who
      // never consents to their own export (CDF-208): it waits for a teammate's request.
      expect(await decide(s, "grcDeputy", internal)).toBe("SUBMITTED");
      await s.as("grcDirector");
      const own = await preview(s, internal);
      await s.expectError(
        "CDF_CONFLICT:REQUESTER_CANNOT_CONSENT",
        (tx) => tx`select api.decide_restricted_export(${internal}, 'APPROVE', ${REASON}, ${own.hash})`,
      );

      // Only EXPORT_POLICY_ADMIN sets rules, and never someone who approves exports (DEC-F24, migration 2040: the
      // director keeps the 1930 grant, which no longer lets them act; the platform administrator holds it now). A rule
      // in force from now binds an approved, ungenerated export.
      const pending = await draft(s, "lead", caseA);
      await addItem(s, pending, "CASE_SUMMARY", caseA);
      expect(await submit(s, pending, "CONFIDENTIAL")).toBe("APPROVED");
      for (const actor of ["caseManager", "grcDirector", "grcDeputy"] as const) {
        await s.as(actor);
        await s.expectError(
          "CDF_FORBIDDEN",
          (tx) =>
            tx`select api.set_export_rule('INTERNAL_ALL', 'INTERNAL', null, null, false, 'REQUIRE_SECOND_APPROVAL', now(), 'SOURCE_REQUIRED', ${REASON})`,
        );
      }
      await s.as("platformAdmin");
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
  it("X1: a policy administrator who changed a rule that applies to an export can never decide it", async () => {
    await ownerScenario(async (s) => {
      // DEC-F24 (2040): an approver can no longer set a rule at all...
      await s.as("grcDirector");
      await s.expectError(
        "CDF_FORBIDDEN",
        (
          tx,
        ) => tx`select api.set_export_rule('EXTERNAL_CONFIDENTIAL', 'EXTERNAL', 'SECRET', null, false, 'NONE', now(),
          'APPROVED', ${REASON})`,
      );
      // ...but a version authored before (1930 let the director do both) still excludes its author. AGENT-09's probe:
      // the director switched the confidential rule off, narrowed so its own version matches nothing.
      await legacyRule(s, "grcDirector", "EXTERNAL_CONFIDENTIAL", "EXTERNAL SECRET - unrestricted NONE");
      const req = await draft(s, "lead", caseA, { audience: "EXTERNAL" });
      await addItem(s, req, "CASE_SUMMARY", caseA);
      const p = await preview(s, req);
      expect(p.approvals_required).toBe(1);
      expect(await submit(s, req, "CONFIDENTIAL")).toBe("SUBMITTED");
      // The author is neither asked nor allowed to decide, either way.
      expect(await notified(s, "EXPORT_APPROVAL_REQUESTED", req)).toEqual(["caseManager", "grcDeputy"]);
      await s.as("grcDirector");
      for (const decision of ["APPROVE", "REJECT"]) {
        await s.expectError(
          "CDF_FORBIDDEN",
          (tx) => tx`select api.decide_export(${req}, ${decision}, ${REASON}, ${p.hash})`,
        );
      }
      // Authoring a rule that never applied to the export does not exclude anyone.
      await legacyRule(s, "grcDeputy", "EXTERNAL_MINUTES", "EXTERNAL - MINUTES unrestricted NONE");
      expect(await decide(s, "grcDeputy", req)).toBe("APPROVED");
      await s.as("lead");
      expect((await generate(s, req)).hash).toBe(p.hash);
    });
  });

  it("a rule that begins after submission raises the approvals needed, and a refusal stops generation", async () => {
    await ownerScenario(async (s) => {
      // Versions authored by the deputy before migration 2040 (DEC-F24), so X1 keeps them out of this export.
      await legacyRule(s, "grcDeputy", "EXTERNAL_CONFIDENTIAL", "EXTERNAL CONFIDENTIAL - unrestricted NONE");
      const req = await draft(s, "lead", caseA, { audience: "EXTERNAL" });
      await addItem(s, req, "CASE_SUMMARY", caseA);
      expect(await submit(s, req, "CONFIDENTIAL")).toBe("SUBMITTED");
      expect(await storedApprovals(s, req)).toBe(1);
      await legacyRule(
        s,
        "grcDeputy",
        "EXTERNAL_SUMMARY",
        "EXTERNAL - CASE_SUMMARY unrestricted REQUIRE_SECOND_APPROVAL",
      );
      // The first approval no longer suffices; the second stage goes to someone who set no rule for it.
      expect(await decide(s, "caseManager", req)).toBe("SUBMITTED");
      expect(await storedApprovals(s, req)).toBe(2);
      expect(await notified(s, "EXPORT_APPROVAL_REQUESTED", req)).toEqual(["caseManager", "grcDirector"]);
      expect(await decide(s, "grcDirector", req)).toBe("APPROVED");
      // A refusing rule in force after approval stops generation.
      await rule(
        s,
        "platformAdmin",
        "EXTERNAL_SUMMARY_REFUSED",
        "EXTERNAL - CASE_SUMMARY unrestricted REFUSE",
      );
      await s.as("lead");
      await s.expectError("CDF_CONFLICT:REFUSED_BY_RULE", (tx) => tx`select api.generate_export(${req})`);
    });
  });

  it("CDF-208 (AGENT-09 pack 4, R5): the authority never consents to an export they requested, on any path; a teammate's request is decided as usual", async () => {
    await ownerScenario(async (s) => {
      await s.as("grcDirector");
      await s.tx`select api.grant_case_access(${caseExec}, ${USERS.grcDeputy}, 'CASE', ${REASON}, null)`;
      // The case's owner, its only Restricted Case Authority, requests an export of it.
      const own = await draft(s, "grcDirector", caseExec);
      await addItem(s, own, "CASE_SUMMARY", caseExec);
      expect(await submit(s, own, "SECRET")).toBe("SUBMITTED");
      expect(await decide(s, "grcDeputy", own)).toBe("SUBMITTED");
      await s.as("grcDirector");
      const p = await preview(s, own);
      for (const decision of ["APPROVE", "REJECT"]) {
        await s.expectError(
          "CDF_CONFLICT:REQUESTER_CANNOT_CONSENT",
          (tx) => tx`select api.decide_restricted_export(${own}, ${decision}, ${REASON}, ${p.hash})`,
        );
      }
      // Nor on any other path: the table refuses the requester's decision, even written by the owner connection.
      await s.asOwner();
      await s.expectError(
        "CDF_CONFLICT:REQUESTER_CANNOT_CONSENT",
        (
          tx,
        ) => tx`insert into exchange.restricted_export_approval (request_id, case_id, decided_by, decision, reason,
                                                                   preview_hash)
                   values (${own}, ${caseExec}, ${USERS.grcDirector}, 'APPROVED', ${REASON}, ${p.hash})`,
      );
      // The export waits (the accepted deadlock): it is never approved and cannot be generated.
      const [row] = await s.tx<
        { status: string }[]
      >`select status from exchange.export_request where id = ${own}`;
      expect(row!.status).toBe("SUBMITTED");
      await s.as("grcDirector");
      await s.expectError("CDF_CONFLICT:NOT_APPROVED", (tx) => tx`select api.generate_export(${own})`);
      // A teammate's request of the same case is decided by the authority, as before.
      const team = await draft(s, "grcDeputy", caseExec);
      await addItem(s, team, "CASE_SUMMARY", caseExec);
      expect(await submit(s, team, "SECRET")).toBe("SUBMITTED");
      expect(await authority(s, "grcDirector", team)).toBe("SUBMITTED");
      expect(await decide(s, "grcDirector", team)).toBe("APPROVED");
    });
  });

  it("restricted case: its Restricted Case Authority decides each export as submitted (DEC-61/62 precedent)", async () => {
    const deputyRequests = async (s: OwnerScenario): Promise<{ req: string; hash: string }> => {
      await s.as("grcDirector");
      await s.tx`select api.grant_case_access(${caseExec}, ${USERS.grcDeputy}, 'CASE', ${REASON}, null)`;
      const req = await draft(s, "grcDeputy", caseExec);
      await addItem(s, req, "CASE_SUMMARY", caseExec);
      const p = await preview(s, req);
      return { req, hash: p.hash };
    };
    const decideAuthority = (tx: Tx, req: string, hash: string, decision = "APPROVE") =>
      tx`select api.decide_restricted_export(${req}, ${decision}, ${REASON}, ${hash})`;

    await ownerScenario(async (s) => {
      const { req, hash } = await deputyRequests(s);
      expect(await preview(s, req)).toMatchObject({
        approvals_required: 1,
        authority_approval_required: true,
      });
      expect(await submit(s, req, "SECRET")).toBe("SUBMITTED");
      expect(await notified(s, "EXPORT_AUTHORITY_APPROVAL_REQUESTED", req)).toEqual(["grcDirector"]);
      // Outsiders cannot tell it exists; the requester holds the authority permission but does not own the case.
      for (const actor of ["lead", "caseManager"] as const) {
        await s.as(actor);
        await s.expectError("CDF_NOT_FOUND", (tx) => decideAuthority(tx, req, hash));
      }
      await s.as("grcDeputy");
      await s.expectError("CDF_FORBIDDEN", (tx) => decideAuthority(tx, req, hash));
      // The owner decides exactly what was submitted, once.
      await s.as("grcDirector");
      await s.expectError("CDF_CONFLICT:PREVIEW_CHANGED", (tx) => decideAuthority(tx, req, "0".repeat(64)));
      await s.expectError("CDF_INVALID:decision", (tx) => decideAuthority(tx, req, hash, "MAYBE"));
      expect(await authority(s, "grcDirector", req)).toBe("SUBMITTED");
      await s.expectError("CDF_CONFLICT:ALREADY_DECIDED", (tx) => decideAuthority(tx, req, hash));
      await s.as("grcDeputy");
      await s.expectError("CDF_CONFLICT:NOT_APPROVED", (tx) => tx`select api.generate_export(${req})`);
      expect(await decide(s, "grcDirector", req)).toBe("APPROVED");
      expect(await notified(s, "EXPORT_DECIDED", req)).toEqual(["grcDeputy"]);
      await s.as("grcDeputy");
      expect((await generate(s, req)).hash).toBe(hash);
      await s.as("dpo");
      const events = await s.tx<{ action: string }[]>`
        select action from audit.audit_event where object_id = ${req} and action like '%APPROVED' order by seq`;
      expect(events.map((e) => e.action)).toEqual(["RESTRICTED_EXPORT_APPROVED", "EXPORT_APPROVED"]);
    });

    await ownerScenario(async (s) => {
      // DEC-F23 (2040): the authority's say cannot be switched off or narrowed after submission (or ever), on any path;
      // restating it is allowed. The stage is given first; the authority rejects, so the export is rejected.
      const { req, hash } = await deputyRequests(s);
      expect(await submit(s, req, "SECRET")).toBe("SUBMITTED");
      for (const args of [
        "ANY - - restricted NONE",
        "EXTERNAL - - restricted REQUIRE_AUTHORITY_APPROVAL",
        "ANY SECRET - restricted REQUIRE_AUTHORITY_APPROVAL",
        "ANY - MINUTES restricted REQUIRE_AUTHORITY_APPROVAL",
        "ANY - - unrestricted REQUIRE_AUTHORITY_APPROVAL",
        "ANY - - restricted REQUIRE_SECOND_APPROVAL",
      ]) {
        await s.expectError("CDF_CONFLICT:RESTRICTED_CASE_AUTHORITY_PROTECTED", () =>
          rule(s, "platformAdmin", "RESTRICTED_CASE_AUTHORITY", args),
        );
      }
      await s.expectError("CDF_CONFLICT:RESTRICTED_CASE_AUTHORITY_PROTECTED", () =>
        legacyRule(s, "grcDeputy", "RESTRICTED_CASE_AUTHORITY", "ANY - - restricted NONE"),
      );
      await rule(
        s,
        "platformAdmin",
        "RESTRICTED_CASE_AUTHORITY",
        "ANY - - restricted REQUIRE_AUTHORITY_APPROVAL",
      );
      expect(await decide(s, "grcDirector", req)).toBe("SUBMITTED");
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.decide_export(${req}, 'APPROVE', ${REASON}, ${hash})`,
      );
      expect(await authority(s, "grcDirector", req, "REJECT")).toBe("REJECTED");
      expect(await notified(s, "EXPORT_DECIDED", req)).toEqual(["grcDeputy"]);
      await s.as("grcDeputy");
      await s.expectError("CDF_CONFLICT:NOT_APPROVED", (tx) => tx`select api.generate_export(${req})`);
    });

    await ownerScenario(async (s) => {
      // With no approval stage needed, the authority's approval alone approves it, and no approver can add a stage
      // meanwhile. The case owner needs no approver permission to see and decide it (AGENT-09 re-look on 1930).
      await rule(s, "platformAdmin", "RESTRICTED_CASE", "ANY - - restricted NONE");
      const { req, hash } = await deputyRequests(s);
      expect(await preview(s, req)).toMatchObject({
        approvals_required: 0,
        authority_approval_required: true,
      });
      expect(await submit(s, req, "SECRET")).toBe("SUBMITTED");
      await s.as("grcDirector");
      await s.expectError(
        "CDF_CONFLICT:AWAITING_AUTHORITY_APPROVAL",
        (tx) => tx`select api.decide_export(${req}, 'APPROVE', ${REASON}, ${hash})`,
      );
      // Test fixture only: the owner's role loses both approver permissions; the authority clause alone lets them in.
      await s.asOwner();
      await s.tx`delete from iam.role_permission
                 where role_code = 'GRC_DIRECTOR' and permission_code in ('EXPORT_APPROVE', 'EXPORT_SECOND_APPROVE')`;
      await s.as("grcDirector");
      expect(await s.tx`select id from exchange.export_request where id = ${req}`).toHaveLength(1);
      expect(await authority(s, "grcDirector", req)).toBe("APPROVED");
    });

    await ownerScenario(async (s) => {
      // The authority approves nothing a rule refuses or an approver could not see; a rejection is always possible.
      const { req, hash } = await deputyRequests(s);
      expect(await submit(s, req, "SECRET")).toBe("SUBMITTED");
      await rule(s, "platformAdmin", "RESTRICTED_REFUSED", "ANY - - restricted REFUSE");
      await s.as("grcDirector");
      await s.expectError("CDF_CONFLICT:REFUSED_BY_RULE", (tx) => decideAuthority(tx, req, hash));
      await s.asOwner();
      await s.tx`insert into exchange.export_item (request_id, position, object_type, object_id, added_by)
                 values (${req}, 2, 'FINDING', ${randomUUID()}, ${USERS.grcDeputy})`;
      await s.as("grcDirector");
      await s.expectError("CDF_CONFLICT:ITEMS_WITHHELD", (tx) => decideAuthority(tx, req, hash));
      expect(await authority(s, "grcDirector", req, "REJECT")).toBe("REJECTED");
    });

    await ownerScenario(async (s) => {
      // DEC-F23 (2040), fail closed: even with no version of the rule in force (an end given on the owner connection,
      // all the 1930 protection allows), an export of a restricted case still needs its authority. (Until 2040 this
      // scenario showed the rule switched off and no authority decision asked for.)
      await s.asOwner();
      await s.tx`update exchange.approval_rule set effective_to = now()
                 where code = 'RESTRICTED_CASE_AUTHORITY' and effective_to is null`;
      const { req, hash } = await deputyRequests(s);
      const p = await preview(s, req);
      expect(p.authority_approval_required).toBe(true);
      expect(p.matched_rules.map((r) => r.code)).toEqual(["RESTRICTED_CASE"]);
      expect(await submit(s, req, "SECRET")).toBe("SUBMITTED");
      expect(await notified(s, "EXPORT_AUTHORITY_APPROVAL_REQUESTED", req)).toEqual(["grcDirector"]);
      expect(await decide(s, "grcDirector", req)).toBe("SUBMITTED");
      await s.as("grcDeputy");
      await s.expectError("CDF_CONFLICT:NOT_APPROVED", (tx) => tx`select api.generate_export(${req})`);
      expect(await authority(s, "grcDirector", req)).toBe("APPROVED");
      await s.as("grcDeputy");
      expect((await generate(s, req)).hash).toBe(hash);
    });

    await scenario(async (s) => {
      const req = await draft(s, "lead", caseA, { audience: "EXTERNAL" });
      await addItem(s, req, "CASE_SUMMARY", caseA);
      expect(await submit(s, req, "CONFIDENTIAL")).toBe("SUBMITTED");
      await s.as("grcDirector");
      await s.expectError("CDF_CONFLICT:CASE_NOT_RESTRICTED", (tx) =>
        decideAuthority(tx, req, "0".repeat(64)),
      );
    });
  });
});

describe("owner decisions DEC-F21, DEC-F22 and DEC-F24 (migration 2040)", () => {
  it("DEC-F21: a purpose comes from the governed catalogue; OTHER needs a justification; legacy codes stay as history", async () => {
    await ownerScenario(async (s) => {
      const create = (purpose: string | null, justification: string | null) =>
        s.tx`select api.create_export_request(${caseA}, 'PDF', 'INTERNAL', ${purpose}, null, ${justification}) as id`;
      await s.as("lead");
      for (const purpose of [
        "AUTHORITY_SUBMISSION",
        "REGULATOR_REQUEST",
        "LEGAL_COUNSEL",
        "INTERNAL_REPORTING",
        "AUDIT",
        "NOT_A_PURPOSE",
        null,
      ])
        await s.expectError("CDF_INVALID:purpose", () => create(purpose, null));
      await s.expectError("CDF_INVALID:justification", () => create("OTHER", null));
      await s.expectError("CDF_INVALID:justification", () => create("OTHER", "Too short."));
      await create("OTHER", JUSTIFICATION);
      await create("LEGAL_REVIEW", null);
      // The database refuses an inactive purpose, and OTHER without a justification, on any path.
      await s.asOwner();
      for (const [purpose, field] of [
        ["AUDIT", "purpose"],
        ["OTHER", "justification"],
      ] as const) {
        await s.expectError(
          `CDF_INVALID:${field}`,
          (tx) => tx`insert into exchange.export_request (case_id, format, audience, purpose, requested_by)
                     values (${caseA}, 'PDF', 'INTERNAL', ${purpose}, ${USERS.lead})`,
        );
      }
      // Administrable by the export policy administrator only, never by an approver (DEC-F24).
      const setPurpose = (code: string, active: boolean, requiresJustification = false) =>
        s.tx`select api.set_export_purpose(${code}, 'Synthetic purpose', 'غرض تجريبي', ${requiresJustification},
          ${active}, 75, ${REASON})`;
      for (const actor of ["caseManager", "grcDirector", "lead"] as const) {
        await s.as(actor);
        await s.expectError("CDF_FORBIDDEN", () => setPurpose("LEGAL_REVIEW", false));
      }
      await s.as("platformAdmin");
      await s.expectError("CDF_INVALID:code", () => setPurpose("not a code", true));
      await s.expectError(
        "CDF_INVALID:sort_order",
        (
          tx,
        ) => tx`select api.set_export_purpose('LEGAL_REVIEW', 'Legal review', 'مراجعة قانونية', false, true, 950,
          ${REASON})`,
      );
      await s.expectError("CDF_CONFLICT:LEGACY_PURPOSE", () => setPurpose("AUDIT", true));
      await s.expectError("CDF_CONFLICT:OTHER_REQUIRES_JUSTIFICATION", () =>
        setPurpose("OTHER", true, false),
      );
      await setPurpose("LEGAL_REVIEW", false); // deactivated, never deleted
      await setPurpose("SYNTHETIC_DEMO_PURPOSE", true, true);
      await s.as("lead");
      await s.expectError("CDF_INVALID:purpose", () => create("LEGAL_REVIEW", null));
      await s.expectError("CDF_INVALID:justification", () => create("SYNTHETIC_DEMO_PURPOSE", null));
      await create("SYNTHETIC_DEMO_PURPOSE", JUSTIFICATION);
      expect(
        await s.tx`select code, is_active from exchange.export_purpose
                   where code in ('LEGAL_REVIEW', 'AUDIT', 'SYNTHETIC_DEMO_PURPOSE') order by code collate "C"`,
      ).toEqual([
        { code: "AUDIT", is_active: false },
        { code: "LEGAL_REVIEW", is_active: false },
        { code: "SYNTHETIC_DEMO_PURPOSE", is_active: true },
      ]);
      // Audited with codes and flags only.
      await s.asOwner();
      const events = await s.tx<{ object_id: string; metadata: Record<string, unknown> }[]>`
        select object_id, metadata from audit.audit_event where action = 'EXPORT_PURPOSE_SET' order by seq`;
      expect(events.map((e) => [e.object_id, e.metadata.is_active, e.metadata.created])).toEqual([
        ["LEGAL_REVIEW", false, false],
        ["SYNTHETIC_DEMO_PURPOSE", true, true],
      ]);
      expect(JSON.stringify(events)).not.toContain("Synthetic purpose");
    });
  });

  it("DEC-F22: no external domain is invented; the empty list is SOURCE_REQUIRED and only the policy administrator reads it", async () => {
    await scenario(async (s) => {
      await s.as("caseManager");
      expect(
        await s.tx`select value, status from config.setting where key = 'APPROVED_EXTERNAL_DOMAINS'`,
      ).toEqual([{ value: null, status: "SOURCE_REQUIRED" }]);
      await s.expectError(
        "permission denied",
        (tx) => tx`insert into exchange.approved_external_domain (domain, source_status, added_by)
                   values ('regulator.example.test', 'APPROVED', ${USERS.caseManager})`,
      );
      await s.as("platformAdmin");
      expect(await s.tx`select domain from exchange.approved_external_domain`).toEqual([]);
    });
  });

  it("T-AMB-112 (DEC-F24): with no independent approver the export fails closed and a configuration warning is raised", async () => {
    await ownerScenario(async (s) => {
      const add = (user: UserKey, stage: number) =>
        s.tx<
          { id: string }[]
        >`select api.add_export_approver(${USERS[user]}, ${stage}::int, ${REASON}) as id`;
      const warnings = async () => {
        await s.as("platformAdmin");
        const [r] = await s.tx<
          {
            v: {
              pools: { stage: number; in_use: boolean; active_members: number }[];
              warnings: { request_id: string; stage: number; still_blocked: boolean }[];
            };
          }[]
        >`select api.export_approval_config_warnings() as v`;
        return {
          pools: r!.v.pools,
          warnings: r!.v.warnings.map((w) => ({
            request_id: w.request_id,
            stage: w.stage,
            still_blocked: w.still_blocked,
          })),
        };
      };
      // Pools and warnings are the policy administrator's; an approver holding the 1930 grant is refused too.
      for (const actor of ["caseManager", "grcDirector", "lead"] as const) {
        await s.as(actor);
        await s.expectError("CDF_FORBIDDEN", () => add("grcDeputy", 2));
        await s.expectError("CDF_FORBIDDEN", (tx) => tx`select api.export_approval_config_warnings()`);
      }
      await s.as("platformAdmin");
      await s.expectError("CDF_INVALID:stage", () => add("grcDirector", 3));
      await s.expectError(
        "CDF_INVALID:user_id",
        (tx) => tx`select api.add_export_approver(${randomUUID()}, 2, ${REASON})`,
      );
      await s.expectError("CDF_FORBIDDEN", () => add("platformAdmin", 2));
      await s.expectError("CDF_CONFLICT:APPROVER_LACKS_PERMISSION", () => add("caseManager", 2));
      const [membership] = await add("grcDirector", 2);
      await s.expectError("CDF_CONFLICT:ALREADY_MEMBER", () => add("grcDirector", 2));
      expect(await warnings()).toEqual({
        pools: [
          { stage: 1, in_use: false, active_members: 0 },
          { stage: 2, in_use: true, active_members: 1 },
        ],
        warnings: [],
      });

      // The stage-2 pool holds only the director, who requests: nobody independent may give the second approval.
      const req = await draft(s, "grcDirector", caseA, { audience: "EXTERNAL" });
      await addItem(s, req, "CASE_SUMMARY", caseA);
      expect(await submit(s, req, "CONFIDENTIAL")).toBe("SUBMITTED");
      expect(await decide(s, "caseManager", req)).toBe("SUBMITTED");
      const hash = (await preview(s, req)).hash;
      for (const actor of ["grcDeputy", "grcDirector"] as const) {
        await s.as(actor);
        await s.expectError(
          "CDF_FORBIDDEN",
          (tx) => tx`select api.decide_export(${req}, 'APPROVE', ${REASON}, ${hash})`,
        );
      }
      // Only the first stage's approvers were ever asked.
      expect(await notified(s, "EXPORT_APPROVAL_REQUESTED", req)).toEqual(["caseManager", "grcDeputy"]);
      expect((await warnings()).warnings).toEqual([{ request_id: req, stage: 2, still_blocked: true }]);
      await s.asOwner();
      const events = await s.tx<{ actor_type: string; keys: string[] }[]>`
        select actor_type, array(select jsonb_object_keys(metadata) order by 1) as keys
        from audit.audit_event where action = 'EXPORT_APPROVAL_CONFIGURATION_WARNING' and object_id = ${req}`;
      expect(events).toEqual([
        {
          actor_type: "SYSTEM",
          keys: ["approvals_required", "eligible_approvers", "pool_in_use", "stage", "warning_id"],
        },
      ]);
      // Table-level backup, whatever path writes an approval: never the requester, never outside the pool.
      for (const approver of [USERS.grcDirector, USERS.grcDeputy]) {
        await s.expectError(
          "CDF_FORBIDDEN",
          (
            tx,
          ) => tx`insert into exchange.export_approval (request_id, stage, approver_id, decision, reason, preview_hash)
                     values (${req}, 2, ${approver}, 'APPROVED', ${REASON}, ${hash})`,
        );
      }

      // The administrator resolves the configuration; the deputy joins the pool and gives the second approval.
      await s.as("platformAdmin");
      await add("grcDeputy", 2);
      expect(await decide(s, "grcDeputy", req)).toBe("APPROVED");
      expect((await warnings()).warnings).toEqual([{ request_id: req, stage: 2, still_blocked: false }]);

      // A membership is revoked once, by the administrator; an emptied pool stays in use (closed, not open).
      await s.as("caseManager");
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.revoke_export_approver(${membership!.id}, ${REASON})`,
      );
      await s.as("platformAdmin");
      await s.tx`select api.revoke_export_approver(${membership!.id}, ${REASON})`;
      await s.expectError(
        "CDF_CONFLICT:ALREADY_REVOKED",
        (tx) => tx`select api.revoke_export_approver(${membership!.id}, ${REASON})`,
      );
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) => tx`select api.revoke_export_approver(${randomUUID()}, ${REASON})`,
      );
      // Members see their own memberships; nobody else but the administrator sees the pool.
      await s.as("grcDeputy");
      expect(await s.tx`select stage from exchange.export_approver_pool`).toEqual([{ stage: 2 }]);
      await s.as("caseManager");
      expect(await s.tx`select stage from exchange.export_approver_pool`).toEqual([]);
      expect(await s.tx`select id from exchange.export_approval_warning`).toEqual([]);
    });
  });
});

describe("ambiguity register: legal opinions are never exported (CDF-205, ADR-032 §10)", () => {
  it("T-AMB-068: no export item type takes a legal opinion, and package or decision items never carry its text", async () => {
    const { draftPackage, voteOnPackage, requestLegalReview } = await import("../support/decision");
    const { ic } = await committeeIds();
    const MARKER = "unique-opinion-marker-068";
    await scenario(async (s) => {
      const f = await draftPackage(s, ic, caseB);
      await voteOnPackage(s, f);
      const { request, packet } = await requestLegalReview(s, f);
      await s.as("legalB");
      await s.tx`select api.give_legal_opinion(${request}, 'CONCURS_WITH_COMMENTS', ${"Synthetic: " + MARKER + " concur."})`;
      await s.as("committeeSecretary");
      await s.tx`select api.submit_to_authority(${f.pkg})`;
      const [d] = await s.tx<{ id: string }[]>`
        select api.record_authority_decision(${f.pkg}, 'CEO', 'APPROVE_AS_RECOMMENDED', now() - interval '1 hour',
          'Chief Executive (synthetic)', 'MEMO-DEMO-0068', null, ${REASON}) as id`;

      const req = await draft(s, "caseManager", caseB);
      for (const [type, id] of [
        ["LEGAL_OPINION", request],
        ["LEGAL_REVIEW", request],
        ["LEGAL_REVIEW_REQUEST", request],
        ["PACKET", packet],
      ] as const) {
        await s.expectError(
          "CDF_INVALID:object_type",
          (tx) => tx`select api.add_export_item(${req}, ${type}, ${id})`,
        );
      }
      await addItem(s, req, "RECOMMENDATION_PACKAGE", f.pkg);
      await addItem(s, req, "AUTHORITY_DECISION", d!.id);
      const p = await preview(s, req);
      expect(p.document.items.map((i) => [i.object_type, i.included])).toEqual([
        ["RECOMMENDATION_PACKAGE", true],
        ["AUTHORITY_DECISION", true],
      ]);
      const text = JSON.stringify(p.document);
      expect(text).not.toContain(MARKER);
      expect(text).not.toMatch(/opinion/i);
    });
  });
});
