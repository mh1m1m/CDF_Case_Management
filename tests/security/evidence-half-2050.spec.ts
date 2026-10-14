// Rebase PR-B, migration 2050 (ADR-041): the evidence half of P11-G4 (DEC-F37), the Defence Packet (DEC-AMB-006
// option C) and the prior-sanctions extract (DEC-AMB-005 option B). The ambiguity-register rows have their own tests in
// the files the matrix names (T-AMB-015 case-isolation, T-AMB-092 grievance-defence, T-AMB-094 and T-AMB-102
// evidence-need-to-know, T-AMB-097, T-AMB-098 and T-AMB-100 evidence-access, T-AMB-111 export); this file covers the
// rest of each rule, the three coordinator defaults (2026-10-14 11:26) and the guards on forged paths.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { USERS, admin, caseId, ownerScenario, type OwnerScenario, type Scenario } from "../support/db";
import { committeeIds } from "../support/committee";
import {
  ALL_CHECKS,
  REASON_2050,
  SYNTHETIC_PRIVILEGE_RULE,
  clearAsIs,
  defenceNotice,
  newSha,
  packetWith,
  priorFinalSanction,
  requestExtract,
  setPacketPolicy,
  storeEvidence,
  storeRendition,
  subjectView,
  withhold,
} from "../support/evidence";

let caseA: string, caseB: string, caseExec: string, case4: string, ic: string, gc: string;

beforeAll(async () => {
  [caseA, caseB, caseExec, case4] = await Promise.all([
    caseId("0001"),
    caseId("0002"),
    caseId("0003"),
    caseId("0004"),
  ]);
  ({ ic, gc } = await committeeIds());
});

const EXCLUSION_REASON =
  "Synthetic: unique-exclusion-marker-2050, obtained outside the investigation mandate.";

/** The case manager makes the lead investigator a second evidence lead on case B (DEC-09). */
async function leadOnCaseB(s: Scenario) {
  await s.as("caseManager");
  await s.tx`select api.assign_case(${caseB}, ${USERS.lead}, 'LEAD_INVESTIGATOR', ${REASON_2050})`;
}

/** Ledger rows for an action, read on the owner connection. */
async function ledger(s: OwnerScenario, action: string) {
  await s.asOwner();
  return s.tx<
    {
      actor_id: string;
      category: string;
      outcome: string;
      reason: string | null;
      metadata: Record<string, unknown>;
    }[]
  >`select actor_id, category, outcome, reason, metadata from audit.audit_event where action = ${action} order by seq`;
}

describe("evidence exclusion (DEC-F37, AMB-161; T3-B2.3-112, T3-B2.3-144, S083/S118)", () => {
  it("an evidence lead excludes an item with a reason; the item, its versions and custody stay; the ledger holds no reason", async () => {
    await ownerScenario(async (s) => {
      const v = await storeEvidence(s, "investigatorA", caseA);
      // Only those who direct the investigation exclude; anyone who cannot see the item cannot tell it exists.
      await s.as("investigatorA");
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.exclude_evidence(${v.evidenceId}, ${EXCLUSION_REASON})`,
      );
      for (const u of ["investigatorB", "committee", "platformAdmin", "grcDirector", "employee"] as const) {
        await s.as(u);
        await s.expectError(
          "CDF_NOT_FOUND",
          (tx) => tx`select api.exclude_evidence(${v.evidenceId}, ${EXCLUSION_REASON})`,
        );
      }
      await s.as("lead");
      await s.expectError(
        "CDF_INVALID:reason",
        (tx) => tx`select api.exclude_evidence(${v.evidenceId}, 'short')`,
      );
      const [x] = await s.tx<
        { id: string }[]
      >`select api.exclude_evidence(${v.evidenceId}, ${EXCLUSION_REASON}) as id`;
      await s.expectError(
        "CDF_CONFLICT:EVIDENCE_EXCLUDED",
        (tx) => tx`select api.exclude_evidence(${v.evidenceId}, ${EXCLUSION_REASON})`,
      );
      // Kept on record: the item, its version and its custody, with the exclusion as its own custody event.
      await s.as("investigatorA");
      expect(
        await s.tx`select status, current_version_id from evidence.evidence where id = ${v.evidenceId}`,
      ).toEqual([{ status: "AVAILABLE", current_version_id: v.versionId }]);
      expect(
        await s.tx`select status, sha256 from evidence.evidence_version where id = ${v.versionId}`,
      ).toEqual([{ status: "AVAILABLE", sha256: v.sha256 }]);
      const custody = await s.tx<{ event_type: string; details: Record<string, unknown> }[]>`
        select event_type, details from evidence.custody_event where evidence_id = ${v.evidenceId} order by seq`;
      expect(custody.map((c) => c.event_type)).toEqual(["RECEIVED", "STORED", "EXCLUDED"]);
      expect(custody[2]!.details).toEqual({ record_no: 1 });
      expect(
        await s.tx`select record_no, reason, excluded_by from evidence.exclusion where evidence_id = ${v.evidenceId}`,
      ).toEqual([{ record_no: 1, reason: EXCLUSION_REASON, excluded_by: USERS.lead }]);
      // The reason stays in the exclusion row: the ledger has ids and numbers only.
      const events = await ledger(s, "EVIDENCE_EXCLUDED");
      const mine = events.filter((e) => e.metadata.evidence_id === v.evidenceId);
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({
        actor_id: USERS.lead,
        category: "BUSINESS",
        outcome: "SUCCESS",
        reason: null,
      });
      expect(Object.keys(mine[0]!.metadata).sort()).toEqual(["evidence_id", "record_no", "sequence_no"]);
      expect(JSON.stringify(mine[0])).not.toContain("unique-exclusion-marker-2050");
      // The formal record (T3-B2.3-144), generated for whoever may see the item; NOT_FOUND for anyone else.
      await s.as("investigatorA");
      const [rec] = await s.tx<
        { r: Record<string, unknown> }[]
      >`select api.evidence_exclusion_record(${x!.id}) as r`;
      expect(rec!.r).toMatchObject({
        exclusion_id: x!.id,
        record_no: 1,
        case_id: caseA,
        evidence_id: v.evidenceId,
        excluded_by: USERS.lead,
        reason: EXCLUSION_REASON,
      });
      for (const u of ["investigatorB", "grcDirector", "committee"] as const) {
        await s.as(u);
        await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.evidence_exclusion_record(${x!.id})`);
        await s.expectError(
          "CDF_NOT_FOUND",
          (tx) => tx`select api.evidence_exclusion_record(${randomUUID()})`,
        );
        expect(await s.tx`select id from evidence.exclusion where id = ${x!.id}`, u).toEqual([]);
      }
    });
  });

  it("an excluded item takes no new version or rendition on any path, and a second exclusion of the case is numbered next", async () => {
    await ownerScenario(async (s) => {
      const v = await storeEvidence(s, "investigatorA", caseA);
      const w = await storeEvidence(s, "investigatorA", caseA);
      await s.as("lead");
      await s.tx`select api.exclude_evidence(${v.evidenceId}, ${EXCLUSION_REASON})`;
      await s.expectError(
        "CDF_CONFLICT:EVIDENCE_EXCLUDED",
        (tx) =>
          tx`select * from api.register_evidence_version(${caseA}, ${v.evidenceId}, null, null, null, null, null, null,
            'ledger-2.pdf', 'application/pdf', 2048, ${newSha()})`,
      );
      await s.expectError(
        "CDF_CONFLICT:EVIDENCE_EXCLUDED",
        (tx) =>
          tx`select * from api.register_evidence_rendition(${v.versionId}, 'ledger-redacted.pdf', 'application/pdf', 1024,
            ${newSha()})`,
      );
      // The guard is on the table: the owner connection is refused too.
      await s.asOwner();
      await s.expectError(
        "CDF_CONFLICT:EVIDENCE_EXCLUDED",
        (
          tx,
        ) => tx`insert into evidence.evidence_version (evidence_id, version_no, object_key, original_file_name,
                     content_type, size_bytes, sha256, uploaded_by)
                   values (${v.evidenceId}, 9, ${"cases/x/evidence/" + randomUUID()}, 'forged.pdf', 'application/pdf', 10,
                           ${newSha()}, ${USERS.lead})`,
      );
      await s.as("lead");
      await s.tx`select api.exclude_evidence(${w.evidenceId}, ${EXCLUSION_REASON})`;
      await s.as("investigatorA");
      const nos = await s.tx<{ record_no: number }[]>`
        select record_no from evidence.exclusion where evidence_id in (${v.evidenceId}, ${w.evidenceId}) order by record_no`;
      const [base] = await s.tx<{ n: number }[]>`
        select count(*)::int as n from evidence.exclusion where case_id = ${caseA}`;
      expect(nos.map((r) => r.record_no)).toEqual([base!.n - 1, base!.n]);
    });
  });

  it("the exclusion is final: no update, delete or truncate, even for the owner", async () => {
    await ownerScenario(async (s) => {
      const v = await storeEvidence(s, "investigatorA", caseA);
      await s.as("lead");
      const [x] = await s.tx<
        { id: string }[]
      >`select api.exclude_evidence(${v.evidenceId}, ${EXCLUSION_REASON}) as id`;
      await s.as("lead");
      await s.expectError(
        "permission denied",
        (tx) => tx`delete from evidence.exclusion where id = ${x!.id}`,
      );
      await s.expectError(
        "permission denied",
        (tx) => tx`update evidence.exclusion set reason = 'x' where id = ${x!.id}`,
      );
      await s.asOwner();
      for (const run of [
        (tx: Scenario["tx"]) =>
          tx`update evidence.exclusion set reason = ${EXCLUSION_REASON + " Edited."} where id = ${x!.id}`,
        (tx: Scenario["tx"]) => tx`delete from evidence.exclusion where id = ${x!.id}`,
        (tx: Scenario["tx"]) => tx`truncate evidence.exclusion`,
      ]) {
        await s.expectError("evidence.exclusion is append-only", run);
      }
    });
  });
});

describe("the Defence Packet (DEC-AMB-006 option C; AMB-159, AMB-118, AMB-171)", () => {
  it("chosen by one evidence lead, reviewed by another, released; the subject sees only cleared items, by reviewed title, view only", async () => {
    await ownerScenario(async (s) => {
      await setPacketPolicy(s);
      await leadOnCaseB(s);
      const n = await defenceNotice(s, caseB);
      const a = await storeEvidence(s, "investigatorB", caseB, {
        title: "Synthetic: unique-title-marker-2050, statement naming Witness Gamma",
      });
      const b = await storeEvidence(s, "investigatorB", caseB);
      const { packet, items } = await packetWith(s, "lead", n.notice, [a.versionId, b.versionId]);
      await s.as("employee");
      expect(await subjectView(s, n.notice)).toEqual([]);
      // Every item is reviewed before anything goes out.
      await s.as("lead");
      await s.expectError(
        "CDF_CONFLICT:ITEM_NOT_REVIEWED",
        (tx) => tx`select api.submit_defence_packet(${packet})`,
      );
      // The lead (the chooser) makes the redacted rendition; the case manager, who made neither, clears it (CDF-217(1),
      // migration 2060).
      const redacted = await storeRendition(s, "lead", a.versionId);
      await s.as("caseManager");
      // A redacted clearance names a rendition of the chosen original; an as-is clearance the original itself.
      await s.expectError(
        "CDF_INVALID:disclosed_version_id",
        (tx) => tx`select api.review_defence_packet_item(${items[0]!}, 'CLEARED_REDACTED', ${b.versionId},
                     'Bank statement (redacted)', ${ALL_CHECKS}::text[], null)`,
      );
      await s.expectError(
        "CDF_INVALID:checks",
        (
          tx,
        ) => tx`select api.review_defence_packet_item(${items[0]!}, 'CLEARED_REDACTED', ${redacted.versionId},
                     'Bank statement (redacted)', ${["REPORTER", "WITNESS"]}::text[], null)`,
      );
      await s.tx`select api.review_defence_packet_item(${items[0]!}, 'CLEARED_REDACTED', ${redacted.versionId},
                   'Bank statement (redacted)', ${ALL_CHECKS}::text[], null)`;
      await s.expectError(
        "CDF_CONFLICT:ALREADY_REVIEWED",
        (
          tx,
        ) => tx`select api.review_defence_packet_item(${items[0]!}, 'WITHHELD', null, null, ${["REPORTER"]}::text[],
                     'Synthetic: a second review.')`,
      );
      await withhold(s, "caseManager", items[1]!);
      await s.as("lead");
      expect(await s.tx`select api.submit_defence_packet(${packet}) as st`).toEqual([{ st: "RELEASED" }]);
      // The privilege rule in force is snapshotted on the clearance.
      await s.as("caseManager");
      expect(
        await s.tx`select outcome, privilege_rule_reference from grievance.defence_packet_review
                   where packet_id = ${packet} order by outcome`,
      ).toEqual([
        { outcome: "CLEARED_REDACTED", privilege_rule_reference: SYNTHETIC_PRIVILEGE_RULE },
        { outcome: "WITHHELD", privilege_rule_reference: null },
      ]);
      // The subject: the cleared item only, under its reviewed title; no evidence title, id or version.
      await s.as("employee");
      const [doc] = await s.tx<{ v: unknown }[]>`select api.my_defence_packet(${n.notice}) as v`;
      const text = JSON.stringify(doc!.v);
      for (const hidden of [
        "unique-title-marker-2050",
        a.evidenceId,
        b.evidenceId,
        a.versionId,
        redacted.versionId,
      ])
        expect(text).not.toContain(hidden);
      expect(await subjectView(s, n.notice)).toEqual([["Bank statement (redacted)"]]);
      const [o] = await s.tx<
        Record<string, unknown>[]
      >`select * from api.open_defence_packet_item(${items[0]!})`;
      expect(o).toEqual({
        o_object_key: redacted.objectKey,
        o_file_name: "defence-item-1.pdf",
        o_content_type: "application/pdf",
        o_size_bytes: "1024",
        o_sha256: redacted.sha256,
        o_version_id: redacted.versionId,
        o_disposition: "INLINE",
      });
      expect(await s.tx`select * from api.open_defence_packet_item(${items[1]!})`).toEqual([]);
      // No general evidence access: not the original, not the rendition, not the tables.
      for (const version of [a.versionId, redacted.versionId, b.versionId])
        expect(await s.tx`select * from api.open_evidence_version(${version})`).toEqual([]);
      for (const t of [
        "evidence.evidence",
        "evidence.evidence_version",
        "evidence.custody_event",
        "evidence.exclusion",
        "grievance.defence_packet",
        "grievance.defence_packet_item",
        "grievance.defence_packet_review",
      ])
        expect(await s.tx`select 1 from ${s.tx(t)}`, t).toEqual([]);
      await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.defence_packet_view(${packet})`);
      // Another subject reaches nothing.
      await s.as("employeeB");
      await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.my_defence_packet(${n.notice})`);
      expect(await s.tx`select * from api.open_defence_packet_item(${items[0]!})`).toEqual([]);
      // The leads' view: items and reviews, never the review note.
      await s.as("caseManager");
      const [view] = await s.tx<{ v: { status: string; items: { review: Record<string, unknown> }[] } }[]>`
        select api.defence_packet_view(${packet}) as v`;
      expect(view!.v.status).toBe("RELEASED");
      expect(view!.v.items.map((i) => i.review.outcome)).toEqual(["CLEARED_REDACTED", "WITHHELD"]);
      expect(JSON.stringify(view!.v)).not.toContain("names a witness");
      // Custody records the subject's view of the rendition; the ledger has ids only; the subject was told by code.
      expect(
        await s.tx`select event_type, actor_id from evidence.custody_event
                   where version_id = ${redacted.versionId} order by seq`,
      ).toEqual([
        { event_type: "RECEIVED", actor_id: USERS.lead },
        { event_type: "STORED", actor_id: USERS.lead },
        { event_type: "PACKET_VIEWED", actor_id: USERS.employee },
      ]);
      const viewed = await ledger(s, "DEFENCE_PACKET_ITEM_VIEWED");
      expect(viewed.at(-1)).toMatchObject({
        actor_id: USERS.employee,
        metadata: { item_id: items[0], version_id: redacted.versionId },
      });
      const denied = await ledger(s, "DEFENCE_PACKET_ACCESS_DENIED");
      expect(denied.at(-1)).toMatchObject({
        actor_id: USERS.employeeB,
        category: "SECURITY",
        outcome: "DENIED",
      });
      expect(
        await s.tx`select channel, object_type, object_id, deep_link from notify.outbox
                   where recipient_id = ${USERS.employee} and template_code = 'DEFENCE_PACKET_RELEASED' order by channel`,
      ).toEqual([
        {
          channel: "EMAIL",
          object_type: "DEFENCE_NOTICE",
          object_id: n.notice,
          deep_link: `/my-defence/${n.notice}`,
        },
        {
          channel: "IN_APP",
          object_type: "DEFENCE_NOTICE",
          object_id: n.notice,
          deep_link: `/my-defence/${n.notice}`,
        },
      ]);
    });
  });

  it("default 1 (coordinator, 2026-10-14): whoever chose an item never reviews it; the setting is configurable", async () => {
    await ownerScenario(async (s) => {
      await setPacketPolicy(s);
      const n = await defenceNotice(s, caseB);
      const a = await storeEvidence(s, "investigatorB", caseB);
      const { packet, items } = await packetWith(s, "caseManager", n.notice, [a.versionId]);
      await s.as("caseManager");
      await s.expectError(
        "CDF_CONFLICT:REVIEWER_IS_CHOOSER",
        (tx) =>
          tx`select api.review_defence_packet_item(${items[0]!}, 'CLEARED_AS_IS', null, 'Item', ${ALL_CHECKS}::text[], null)`,
      );
      await s.expectError(
        "CDF_CONFLICT:REVIEWER_IS_CHOOSER",
        (
          tx,
        ) => tx`select api.review_defence_packet_item(${items[0]!}, 'WITHHELD', null, null, ${["REPORTER"]}::text[],
                     'Synthetic: withheld by the chooser.')`,
      );
      // The guard is on the table: the owner connection is refused too.
      await s.asOwner();
      await s.expectError(
        "CDF_CONFLICT:REVIEWER_IS_CHOOSER",
        (
          tx,
        ) => tx`insert into grievance.defence_packet_review (item_id, packet_id, outcome, checks, note, reviewed_by)
                   values (${items[0]!}, ${packet}, 'WITHHELD', '{REPORTER}', 'Synthetic: withheld by the chooser.',
                           ${USERS.caseManager})`,
      );
      // Configurable: a policy version that lets the chooser review admits it.
      await setPacketPolicy(s, { reviewerMustDiffer: false });
      await clearAsIs(s, "caseManager", items[0]!);
    });
  });

  it("default 2 (AMB-118): while LEGAL_PRIVILEGE_RULE is SOURCE_REQUIRED nothing is cleared, so nothing reaches the subject", async () => {
    await ownerScenario(async (s) => {
      // The seeded policy: reviewer differs, view only, privilege rule SOURCE_REQUIRED.
      await s.as("caseManager");
      expect(
        await s.tx`select reviewer_must_differ, packet_evidence_download, privilege_rule_reference, privilege_source_status
                   from grievance.defence_packet_policy where effective_to is null`,
      ).toEqual([
        {
          reviewer_must_differ: true,
          packet_evidence_download: false,
          privilege_rule_reference: null,
          privilege_source_status: "SOURCE_REQUIRED",
        },
      ]);
      await leadOnCaseB(s);
      const n = await defenceNotice(s, caseB);
      const a = await storeEvidence(s, "investigatorB", caseB);
      const { packet, items } = await packetWith(s, "lead", n.notice, [a.versionId]);
      const redacted = await storeRendition(s, "caseManager", a.versionId);
      await s.as("caseManager");
      await s.expectError(
        "CDF_CONFLICT:LEGAL_PRIVILEGE_RULE_REQUIRED",
        (tx) =>
          tx`select api.review_defence_packet_item(${items[0]!}, 'CLEARED_AS_IS', null, 'Item', ${ALL_CHECKS}::text[], null)`,
      );
      await s.expectError(
        "CDF_CONFLICT:LEGAL_PRIVILEGE_RULE_REQUIRED",
        (
          tx,
        ) => tx`select api.review_defence_packet_item(${items[0]!}, 'CLEARED_REDACTED', ${redacted.versionId}, 'Item',
                     ${ALL_CHECKS}::text[], null)`,
      );
      await s.asOwner();
      await s.expectError(
        "CDF_CONFLICT:LEGAL_PRIVILEGE_RULE_REQUIRED",
        (
          tx,
        ) => tx`insert into grievance.defence_packet_review (item_id, packet_id, outcome, disclosed_version_id,
                     disclosed_title, checks, reviewed_by)
                   values (${items[0]!}, ${packet}, 'CLEARED_AS_IS', ${a.versionId}, 'Item', ${ALL_CHECKS}::text[],
                           ${USERS.caseManager})`,
      );
      // Withholding needs no rule, but a packet with nothing cleared is never released.
      await withhold(s, "caseManager", items[0]!);
      await s.as("lead");
      await s.expectError(
        "CDF_CONFLICT:NOTHING_CLEARED",
        (tx) => tx`select api.submit_defence_packet(${packet})`,
      );
      await s.as("employee");
      expect(await subjectView(s, n.notice)).toEqual([]);
      // The policy changes only by a new version: a version only ever gets an end, and none is deleted.
      await s.asOwner();
      await s.expectError(
        "defence packet policy",
        (tx) => tx`update grievance.defence_packet_policy set privilege_rule_reference = 'X-RULE',
                     privilege_source_status = 'APPROVED' where effective_to is null`,
      );
      await s.expectError(
        "grievance.defence_packet_policy is append-only",
        (tx) => tx`delete from grievance.defence_packet_policy`,
      );
      await s.as("platformAdmin");
      await s.expectError(
        "permission denied",
        (tx) => tx`update grievance.defence_packet_policy set effective_to = now()`,
      );
    });
  });

  it("a restricted case's packet waits for its Restricted Case Authority, who never consents to a packet they made or submitted", async () => {
    // Fixture: the lead investigator and the subject's portal account are cleared to SECRET for case 0003.
    const prepare = async (s: OwnerScenario) => {
      await setPacketPolicy(s);
      await s.asOwner();
      await s.tx`update iam.user_profile set clearance = 'SECRET' where id in (${USERS.lead}, ${USERS.employee})`;
      await s.as("grcDirector");
      await s.tx`select api.assign_case(${caseExec}, ${USERS.lead}, 'LEAD_INVESTIGATOR', ${REASON_2050})`;
      const n = await defenceNotice(s, caseExec, "grcDirector");
      const a = await storeEvidence(s, "grcDirector", caseExec, { classification: "SECRET" });
      return { n, a };
    };
    const decide = (tx: Scenario["tx"], packet: string, d = "APPROVE") =>
      tx`select api.decide_restricted_defence_packet(${packet}, ${d}, 'Synthetic: authority decision.') as st`;

    await ownerScenario(async (s) => {
      const { n, a } = await prepare(s);
      const { packet, items } = await packetWith(s, "lead", n.notice, [a.versionId]);
      await clearAsIs(s, "grcDirector", items[0]!);
      await s.as("lead");
      expect(await s.tx`select api.submit_defence_packet(${packet}) as st`).toEqual([
        { st: "AWAITING_AUTHORITY" },
      ]);
      await s.as("employee");
      expect(await subjectView(s, n.notice)).toEqual([]);
      expect(await s.tx`select * from api.open_defence_packet_item(${items[0]!})`).toEqual([]);
      await s.asOwner();
      expect(
        await s.tx`select recipient_id, object_type, deep_link from notify.outbox
                   where template_code = 'DEFENCE_PACKET_APPROVAL_REQUESTED' and object_id = ${packet} and channel = 'IN_APP'`,
      ).toEqual([
        {
          recipient_id: USERS.grcDirector,
          object_type: "DEFENCE_PACKET",
          deep_link: `/defence-packets/${packet}`,
        },
      ]);
      // Only the case's own authority decides; nobody else can tell the packet exists.
      for (const u of ["caseManager", "investigatorB", "employee"] as const) {
        await s.as(u);
        await s.expectError("CDF_NOT_FOUND", (tx) => decide(tx, packet));
      }
      await s.as("lead");
      await s.expectError("CDF_FORBIDDEN", (tx) => decide(tx, packet));
      // Forged release without the authority's approval: refused on the table.
      await s.asOwner();
      await s.expectError(
        "CDF_CONFLICT:AUTHORITY_APPROVAL_REQUIRED",
        (tx) =>
          tx`update grievance.defence_packet set status = 'RELEASED', released_at = now() where id = ${packet}`,
      );
      await s.as("grcDirector");
      await s.expectError("CDF_INVALID:decision", (tx) => decide(tx, packet, "MAYBE"));
      expect(await decide(s.tx, packet)).toEqual([{ st: "RELEASED" }]);
      await s.expectError("CDF_CONFLICT:NOT_AWAITING_AUTHORITY", (tx) => decide(tx, packet));
      await s.as("employee");
      expect(await subjectView(s, n.notice)).toEqual([["Item for your defence"]]);
    });

    await ownerScenario(async (s) => {
      const { n, a } = await prepare(s);
      // The authority made and submitted this packet: they cannot also consent to it, on any path.
      const { packet, items } = await packetWith(s, "grcDirector", n.notice, [a.versionId]);
      await clearAsIs(s, "lead", items[0]!);
      await s.as("grcDirector");
      expect(await s.tx`select api.submit_defence_packet(${packet}) as st`).toEqual([
        { st: "AWAITING_AUTHORITY" },
      ]);
      await s.expectError("CDF_CONFLICT:REQUESTER_CANNOT_CONSENT", (tx) => decide(tx, packet));
      await s.asOwner();
      await s.expectError(
        "CDF_CONFLICT:REQUESTER_CANNOT_CONSENT",
        (
          tx,
        ) => tx`insert into grievance.defence_packet_authority_decision (packet_id, case_id, decision, reason, decided_by)
                   values (${packet}, ${caseExec}, 'APPROVED', 'Synthetic: self consent.', ${USERS.grcDirector})`,
      );
      // It can only be withdrawn and made again by someone else.
      await s.as("grcDirector");
      await s.tx`select api.withdraw_defence_packet(${packet}, ${REASON_2050})`;
      await s.as("employee");
      expect(await subjectView(s, n.notice)).toEqual([]);
    });
  });

  it("withdrawal ends the subject's view at once; a withdrawn notice shows nothing", async () => {
    await ownerScenario(async (s) => {
      await setPacketPolicy(s);
      await leadOnCaseB(s);
      const n = await defenceNotice(s, caseB);
      const a = await storeEvidence(s, "investigatorB", caseB);
      const { packet, items } = await packetWith(s, "lead", n.notice, [a.versionId]);
      await clearAsIs(s, "caseManager", items[0]!);
      await s.as("lead");
      await s.tx`select api.submit_defence_packet(${packet})`;
      await s.as("employee");
      expect(await subjectView(s, n.notice)).toEqual([["Item for your defence"]]);
      await s.as("lead");
      await s.expectError(
        "CDF_INVALID:reason",
        (tx) => tx`select api.withdraw_defence_packet(${packet}, 'short')`,
      );
      await s.tx`select api.withdraw_defence_packet(${packet}, ${REASON_2050})`;
      await s.expectError(
        "CDF_CONFLICT:PACKET_CLOSED",
        (tx) => tx`select api.withdraw_defence_packet(${packet}, ${REASON_2050})`,
      );
      await s.as("employee");
      expect(await subjectView(s, n.notice)).toEqual([]);
      expect(await s.tx`select * from api.open_defence_packet_item(${items[0]!})`).toEqual([]);
      // A withdrawn packet never comes back; a new one may be made for the open notice.
      await s.asOwner();
      await s.expectError(
        "defence packet",
        (
          tx,
        ) => tx`update grievance.defence_packet set status = 'RELEASED', withdrawn_at = null, withdrawn_by = null,
                     withdrawal_reason = null where id = ${packet}`,
      );
      const again = await packetWith(s, "lead", n.notice, [a.versionId]);
      expect(again.items).toHaveLength(1);
      await s.as("lead");
      await s.expectError(
        "CDF_CONFLICT:PACKET_ALREADY_OPEN",
        (tx) => tx`select api.create_defence_packet(${n.notice})`,
      );
    });
  });

  it("the committee secretary never assembles a packet or reads its items; nor does an investigator who is not a lead (DEC-09)", async () => {
    await ownerScenario(async (s) => {
      await setPacketPolicy(s);
      const { seat, IC_SEATS, refer } = await import("../support/committee");
      await seat(s, ic, IC_SEATS);
      await refer(s, ic, caseB);
      const n = await defenceNotice(s, caseB);
      const a = await storeEvidence(s, "investigatorB", caseB);
      const { packet, items } = await packetWith(s, "caseManager", n.notice, [a.versionId]);
      // The secretary of the open proceeding passes the case gate but holds no view of the case's records, so the packet
      // and its evidence are not found from there.
      await s.as("committeeSecretary");
      await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.create_defence_packet(${n.notice})`);
      await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.defence_packet_view(${packet})`);
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) => tx`select api.add_defence_packet_item(${packet}, ${a.versionId})`,
      );
      expect(await s.tx`select id from grievance.defence_packet where id = ${packet}`).toEqual([]);
      // An investigator on the team (not a lead) neither assembles nor reviews.
      await s.as("investigatorB");
      await s.expectError("CDF_FORBIDDEN", (tx) => tx`select api.create_defence_packet(${n.notice})`);
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.add_defence_packet_item(${packet}, ${a.versionId})`,
      );
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) =>
          tx`select api.review_defence_packet_item(${items[0]!}, 'CLEARED_AS_IS', null, 'Item', ${ALL_CHECKS}::text[], null)`,
      );
    });
  });

  it("guards on forged paths: draft only, originals of the case only, one review, the release block and forward-only status", async () => {
    await ownerScenario(async (s) => {
      await setPacketPolicy(s);
      await leadOnCaseB(s);
      const n = await defenceNotice(s, caseB);
      const a = await storeEvidence(s, "investigatorB", caseB);
      const other = await storeEvidence(s, "investigatorA", caseA);
      const { packet, items } = await packetWith(s, "lead", n.notice, [a.versionId]);
      const redacted = await storeRendition(s, "lead", a.versionId);
      await s.as("lead");
      await s.expectError(
        "CDF_CONFLICT:ALREADY_ADDED",
        (tx) => tx`select api.add_defence_packet_item(${packet}, ${a.versionId})`,
      );
      // Evidence of another case the lead also works is refused; a rendition is not an original.
      await s.expectError(
        "CDF_INVALID:version_id",
        (tx) => tx`select api.add_defence_packet_item(${packet}, ${other.versionId})`,
      );
      // Evidence of a case the chooser cannot see is not found.
      const hidden = await storeEvidence(s, "investigatorB", case4);
      await s.as("lead");
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) => tx`select api.add_defence_packet_item(${packet}, ${hidden.versionId})`,
      );
      const b = await storeEvidence(s, "investigatorB", caseB);
      const rb = await storeRendition(s, "caseManager", b.versionId);
      await s.as("lead");
      await s.expectError(
        "CDF_CONFLICT:NOT_AN_ORIGINAL",
        (tx) => tx`select api.add_defence_packet_item(${packet}, ${rb.versionId})`,
      );
      // An unfinished (quarantined) version is not available.
      await s.as("investigatorB");
      const [q] = await s.tx<{ v: string }[]>`
        select o_version_id as v from api.register_evidence_version(${caseB}, null, 'Synthetic pending item', null,
          'DOCUMENT', 'Synthetic source', null, 'CONFIDENTIAL'::core.classification_level, 'p.pdf', 'application/pdf', 10,
          ${newSha()})`;
      await s.as("lead");
      await s.expectError(
        "CDF_CONFLICT:VERSION_NOT_AVAILABLE",
        (tx) => tx`select api.add_defence_packet_item(${packet}, ${q!.v})`,
      );
      // Forged item rows: a version of another case, or a rendition, are refused on the table.
      await s.asOwner();
      await s.expectError(
        "CDF_INVALID:version_id",
        (
          tx,
        ) => tx`insert into grievance.defence_packet_item (packet_id, position, evidence_id, source_version_id, added_by)
                   values (${packet}, 7, ${other.evidenceId}, ${other.versionId}, ${USERS.lead})`,
      );
      await s.expectError(
        "CDF_CONFLICT:NOT_AN_ORIGINAL",
        (
          tx,
        ) => tx`insert into grievance.defence_packet_item (packet_id, position, evidence_id, source_version_id, added_by)
                   values (${packet}, 7, ${b.evidenceId}, ${rb.versionId}, ${USERS.lead})`,
      );
      // Release is blocked until every item is reviewed, on the table too.
      await s.expectError(
        "CDF_CONFLICT:ITEM_NOT_REVIEWED",
        (tx) => tx`update grievance.defence_packet set status = 'RELEASED', submitted_by = ${USERS.lead},
                     submitted_at = now(), released_at = now() where id = ${packet}`,
      );
      await s.as("caseManager");
      await s.tx`select api.review_defence_packet_item(${items[0]!}, 'CLEARED_REDACTED', ${redacted.versionId}, 'Item',
                   ${ALL_CHECKS}::text[], null)`;
      // Reviews and items are append-only.
      await s.asOwner();
      await s.expectError(
        "grievance.defence_packet_review is append-only",
        (tx) =>
          tx`update grievance.defence_packet_review set outcome = 'CLEARED_AS_IS' where item_id = ${items[0]!}`,
      );
      await s.expectError(
        "grievance.defence_packet_item is append-only",
        (tx) => tx`delete from grievance.defence_packet_item where id = ${items[0]!}`,
      );
      await s.expectError(
        "grievance.defence_packet is append-only",
        (tx) => tx`delete from grievance.defence_packet where id = ${packet}`,
      );
      await s.as("lead");
      await s.tx`select api.submit_defence_packet(${packet})`;
      // Released: no item or review is added any more, and the status moves only forward.
      await s.expectError(
        "CDF_CONFLICT:PACKET_NOT_DRAFT",
        (tx) => tx`select api.add_defence_packet_item(${packet}, ${b.versionId})`,
      );
      await s.asOwner();
      await s.expectError(
        "CDF_CONFLICT:PACKET_NOT_DRAFT",
        (
          tx,
        ) => tx`insert into grievance.defence_packet_item (packet_id, position, evidence_id, source_version_id, added_by)
                   values (${packet}, 2, ${b.evidenceId}, ${b.versionId}, ${USERS.lead})`,
      );
      await s.expectError(
        "defence packet",
        (tx) =>
          tx`update grievance.defence_packet set status = 'DRAFT', released_at = null where id = ${packet}`,
      );
      await s.expectError(
        "defence packet",
        (tx) =>
          tx`update grievance.defence_packet set subject_id = ${n.subject}, notice_id = ${randomUUID()} where id = ${packet}`,
      );
    });
  });

  it("a cleared item that later becomes undisclosable (excluded, or failed its integrity check) leaves the subject's view", async () => {
    await ownerScenario(async (s) => {
      await setPacketPolicy(s);
      await leadOnCaseB(s);
      const n = await defenceNotice(s, caseB);
      const a = await storeEvidence(s, "investigatorB", caseB);
      const b = await storeEvidence(s, "investigatorB", caseB);
      const { packet, items } = await packetWith(s, "lead", n.notice, [a.versionId, b.versionId]);
      await clearAsIs(s, "caseManager", items[0]!, "First item");
      await clearAsIs(s, "caseManager", items[1]!, "Second item");
      // Excluded before release: the release is blocked.
      await s.as("lead");
      await s.tx`select api.exclude_evidence(${a.evidenceId}, ${EXCLUSION_REASON})`;
      await s.expectError(
        "CDF_CONFLICT:ITEM_NOT_DISCLOSABLE",
        (tx) => tx`select api.submit_defence_packet(${packet})`,
      );
      await s.tx`select api.withdraw_defence_packet(${packet}, ${REASON_2050})`;
      const again = await packetWith(s, "lead", n.notice, [b.versionId]);
      await clearAsIs(s, "caseManager", again.items[0]!, "Second item");
      await s.as("lead");
      await s.tx`select api.submit_defence_packet(${again.packet})`;
      await s.as("employee");
      expect(await subjectView(s, n.notice)).toEqual([["Second item"]]);
      // An integrity failure after release removes the item at once, from the list and the viewer.
      await s.as("caseManager");
      await s.tx`select api.report_evidence_integrity_failure(${b.versionId}, ${newSha()})`;
      await s.as("employee");
      expect(await subjectView(s, n.notice)).toEqual([[]]);
      expect(await s.tx`select * from api.open_defence_packet_item(${again.items[0]!})`).toEqual([]);
    });
  });
});

describe("the prior-sanctions extract (DEC-AMB-005 option B; AMB-034, AMB-106)", () => {
  it("rows change once, by the source case's authority; the tables have no reader; requests need an open proceeding", async () => {
    await ownerScenario(async (s) => {
      const p = await priorFinalSanction(s, { ic, gc, caseB, requestingCase: case4 }, true);
      const extract = await requestExtract(s, p);
      await s.asOwner();
      const [row] = await s.tx<{ id: string; status: string }[]>`
        select id, status from decision.sanction_extract_row where extract_id = ${extract}`;
      expect(row!.status).toBe("AWAITING_AUTHORITY");
      // Nobody reads the extract tables directly (no grant, no policy); the read models are the only way in.
      for (const u of ["committeeSecretary", "grcDirector", "legal", "caseManager"] as const) {
        await s.as(u);
        await s.expectError(
          "permission denied for table sanction_extract",
          (tx) => tx`select id from decision.sanction_extract`,
        );
        await s.expectError(
          "permission denied for table sanction_extract_row",
          (tx) => tx`select id from decision.sanction_extract_row`,
        );
      }
      // The authority's queue shows their own case's row, nothing about the requesting case.
      await s.as("grcDirector");
      const [q] = await s.tx<
        { v: Record<string, unknown>[] }[]
      >`select api.my_sanction_extract_approvals() as v`;
      expect(q!.v).toHaveLength(1);
      expect(q!.v[0]).toMatchObject({
        row_id: row!.id,
        source_case_id: caseB,
        subject_id: p.sigma,
        sanction_code: "WARNING",
      });
      expect(JSON.stringify(q!.v)).not.toContain(case4);
      await s.as("committeeSecretary");
      expect(await s.tx`select api.my_sanction_extract_approvals() as v`).toEqual([{ v: [] }]);
      // A forged change is refused: only an awaiting row changes, once, to INCLUDED or WITHHELD.
      await s.asOwner();
      await s.expectError(
        "sanction extract row",
        (tx) =>
          tx`update decision.sanction_extract_row set sanction_code = 'TERMINATION' where id = ${row!.id}`,
      );
      await s.as("grcDirector");
      await s.tx`select api.decide_sanction_extract_row(${row!.id}, 'REJECT', 'Synthetic: not relevant here.')`;
      await s.expectError(
        "CDF_CONFLICT:ALREADY_DECIDED",
        (tx) =>
          tx`select api.decide_sanction_extract_row(${row!.id}, 'APPROVE', 'Synthetic: changed my mind.')`,
      );
      await s.asOwner();
      await s.expectError(
        "sanction extract row",
        (tx) => tx`update decision.sanction_extract_row set status = 'INCLUDED' where id = ${row!.id}`,
      );
      await s.expectError(
        "decision.sanction_extract_row is append-only",
        (tx) => tx`delete from decision.sanction_extract_row`,
      );
      await s.expectError(
        "decision.sanction_extract is append-only",
        (tx) => tx`update decision.sanction_extract set reason = reason`,
      );
      // Withheld: the secretary's view never shows it.
      await s.as("committeeSecretary");
      const [v] = await s.tx<
        { v: { sanctions: unknown[] } }[]
      >`select api.sanction_extract_view(${extract}) as v`;
      expect(v!.v.sanctions).toEqual([]);
      // The request needs the secretary of an open proceeding and a subject of its case.
      await s.expectError(
        "CDF_INVALID:subject_id",
        (tx) => tx`select api.request_sanction_extract(${p.committeeProceeding}, ${p.sigma}, ${REASON_2050})`,
      );
      await s.expectError(
        "CDF_INVALID:reason",
        (tx) =>
          tx`select api.request_sanction_extract(${p.committeeProceeding}, ${p.requestingSubject}, 'short')`,
      );
      await s.as("legal");
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) =>
          tx`select api.request_sanction_extract(${p.committeeProceeding}, ${p.requestingSubject}, ${REASON_2050})`,
      );
    });
  });
});

describe("Defence Packet follow-ups (migration 2060, ADR-042)", () => {
  it("CDF-217(1): whoever made a redacted rendition never clears it, by the command or on the table, under the chooser rule's switch", async () => {
    await ownerScenario(async (s) => {
      await setPacketPolicy(s);
      await leadOnCaseB(s);
      const n = await defenceNotice(s, caseB);
      const a = await storeEvidence(s, "investigatorB", caseB);
      const { packet, items } = await packetWith(s, "lead", n.notice, [a.versionId]);
      // The case manager did not choose the item, but made the rendition: they may not clear it.
      const redacted = await storeRendition(s, "caseManager", a.versionId);
      await s.as("caseManager");
      await s.expectError(
        "CDF_CONFLICT:REVIEWER_IS_REDACTOR",
        (
          tx,
        ) => tx`select api.review_defence_packet_item(${items[0]!}, 'CLEARED_REDACTED', ${redacted.versionId},
                     'Item (redacted)', ${ALL_CHECKS}::text[], null)`,
      );
      await s.asOwner();
      await s.expectError(
        "CDF_CONFLICT:REVIEWER_IS_REDACTOR",
        (tx) =>
          tx`insert into grievance.defence_packet_review (item_id, packet_id, outcome, disclosed_version_id,
                                                           disclosed_title, checks, reviewed_by)
             values (${items[0]!}, ${packet}, 'CLEARED_REDACTED', ${redacted.versionId}, 'Item (redacted)',
                     ${ALL_CHECKS}::text[], ${USERS.caseManager})`,
      );
      // The same configurable switch as the chooser rule (coordinator default 1): a policy that lets the chooser
      // review lets the redactor clear their rendition too.
      await setPacketPolicy(s, { reviewerMustDiffer: false });
      await s.as("caseManager");
      await s.tx`select api.review_defence_packet_item(${items[0]!}, 'CLEARED_REDACTED', ${redacted.versionId},
                   'Item (redacted)', ${ALL_CHECKS}::text[], null)`;
    });
  });

  const WITHHOLD_NOTE = "Synthetic: unique-withhold-marker-2060, names a witness.";
  const EVIDENCE_TITLE = "Synthetic: unique-evidence-title-marker-2060";
  /** Case 0003 (restricted, SECRET): the lead investigator and the subject's portal account are cleared to SECRET. */
  async function restrictedNotice(s: OwnerScenario) {
    await setPacketPolicy(s);
    await s.asOwner();
    await s.tx`update iam.user_profile set clearance = 'SECRET' where id in (${USERS.lead}, ${USERS.employee})`;
    await s.as("grcDirector");
    await s.tx`select api.assign_case(${caseExec}, ${USERS.lead}, 'LEAD_INVESTIGATOR', ${REASON_2050})`;
    return defenceNotice(s, caseExec, "grcDirector");
  }
  const approvalView = (tx: Scenario["tx"], packet: string) =>
    tx<{ v: ApprovalView }[]>`select api.defence_packet_approval_view(${packet}) as v`;
  interface ApprovalView {
    status: string;
    release_block: string | null;
    items: {
      position: number;
      outcome: string;
      redaction: string;
      disclosed_title: string | null;
      content_type: string | null;
      checks: string[];
    }[];
    counts: Record<string, number>;
  }

  it("CDF-218(1): the Restricted Case Authority reads what it approves, bound to the request, never evidence; audited with counts", async () => {
    await ownerScenario(async (s) => {
      const n = await restrictedNotice(s);
      const a = await storeEvidence(s, "grcDirector", caseExec, {
        classification: "SECRET",
        title: EVIDENCE_TITLE,
      });
      const b = await storeEvidence(s, "grcDirector", caseExec, { classification: "SECRET" });
      const c = await storeEvidence(s, "grcDirector", caseExec, { classification: "SECRET" });
      const { packet, items } = await packetWith(s, "lead", n.notice, [
        a.versionId,
        b.versionId,
        c.versionId,
      ]);
      // Nothing awaits the authority while the packet is a draft.
      await s.as("grcDirector");
      await s.expectError("CDF_NOT_FOUND", (tx) => approvalView(tx, packet));
      // Item 1 as is; item 2 by a rendition the lead made; item 3 withheld. The lead submits.
      await clearAsIs(s, "grcDirector", items[0]!, "First item");
      const r = await storeRendition(s, "lead", b.versionId);
      await s.as("grcDirector");
      await s.tx`select api.review_defence_packet_item(${items[1]!}, 'CLEARED_REDACTED', ${r.versionId},
                   'Second item (redacted)', ${ALL_CHECKS}::text[], null)`;
      await s.tx`select api.review_defence_packet_item(${items[2]!}, 'WITHHELD', null, null, ${["WITNESS"]}::text[],
                   ${WITHHOLD_NOTE})`;
      await s.as("lead");
      expect(await s.tx`select api.submit_defence_packet(${packet}) as st`).toEqual([
        { st: "AWAITING_AUTHORITY" },
      ]);

      await s.as("grcDirector");
      const [row] = await approvalView(s.tx, packet);
      const v = row!.v;
      expect(v.status).toBe("AWAITING_AUTHORITY");
      expect(v.release_block).toBeNull();
      expect(
        v.items.map((i) => [i.position, i.outcome, i.redaction, i.disclosed_title, i.content_type]),
      ).toEqual([
        [1, "CLEARED_AS_IS", "NONE", "First item", "application/pdf"],
        [2, "CLEARED_REDACTED", "REDACTED_RENDITION", "Second item (redacted)", "application/pdf"],
        [3, "WITHHELD", "WITHHELD", null, null],
      ]);
      expect(v.items[2]!.checks).toEqual(["WITNESS"]);
      expect(v.counts).toEqual({ items: 3, cleared: 2, redacted: 1, withheld: 1, not_disclosable: 0 });
      // Never evidence: no evidence or version id, object key, hash, evidence title or reviewer note.
      const text = JSON.stringify(v);
      for (const hidden of [
        a.evidenceId,
        a.versionId,
        b.versionId,
        c.versionId,
        r.versionId,
        a.objectKey,
        r.objectKey,
        a.sha256,
        r.sha256,
        EVIDENCE_TITLE,
        WITHHOLD_NOTE,
      ]) {
        expect(text).not.toContain(hidden);
      }
      const keys = new Set<string>();
      const walk = (x: unknown): void => {
        if (Array.isArray(x)) x.forEach(walk);
        else if (x && typeof x === "object")
          for (const [k, y] of Object.entries(x)) {
            keys.add(k);
            walk(y);
          }
      };
      walk(v);
      for (const k of [
        "evidence_id",
        "version_id",
        "disclosed_version_id",
        "object_key",
        "sha256",
        "note",
        "title",
      ]) {
        expect(keys.has(k), k).toBe(false);
      }
      // Audited: one business event per read, ids and counts only.
      const viewed = await ledger(s, "DEFENCE_PACKET_APPROVAL_VIEWED");
      expect(viewed).toHaveLength(1);
      expect(viewed[0]).toEqual({
        actor_id: USERS.grcDirector,
        category: "BUSINESS",
        outcome: "SUCCESS",
        reason: null,
        metadata: { items: 3, cleared: 2, withheld: 1 },
      });
      // Bound to the approval request: the chooser and submitter, the case team of other cases, another GRC director
      // without access, the subject and the platform administrator all get NOT_FOUND, as for a random id.
      for (const u of [
        "lead",
        "caseManager",
        "investigatorB",
        "grcDeputy",
        "employee",
        "platformAdmin",
      ] as const) {
        await s.as(u);
        await s.expectError("CDF_NOT_FOUND", (tx) => approvalView(tx, packet));
      }
      await s.as("grcDirector");
      await s.expectError("CDF_NOT_FOUND", (tx) => approvalView(tx, randomUUID()));
      // Refusals leave no business event.
      expect(await ledger(s, "DEFENCE_PACKET_APPROVAL_VIEWED")).toHaveLength(1);
      // Once decided, nothing awaits the authority.
      await s.as("grcDirector");
      await s.tx`select api.decide_restricted_defence_packet(${packet}, 'APPROVE', 'Synthetic: authority decision.')`;
      await s.expectError("CDF_NOT_FOUND", (tx) => approvalView(tx, packet));
    });
  });

  it("CDF-218(1): an authority who made or submitted the packet reads nothing of it; an unrestricted case's packet never awaits one", async () => {
    await ownerScenario(async (s) => {
      const n = await restrictedNotice(s);
      const a = await storeEvidence(s, "grcDirector", caseExec, { classification: "SECRET" });
      const { packet, items } = await packetWith(s, "grcDirector", n.notice, [a.versionId]);
      await clearAsIs(s, "lead", items[0]!);
      await s.as("grcDirector");
      expect(await s.tx`select api.submit_defence_packet(${packet}) as st`).toEqual([
        { st: "AWAITING_AUTHORITY" },
      ]);
      await s.expectError("CDF_NOT_FOUND", (tx) => approvalView(tx, packet));
    });
    await ownerScenario(async (s) => {
      await setPacketPolicy(s);
      const n = await defenceNotice(s, caseB);
      const a = await storeEvidence(s, "investigatorB", caseB);
      const { packet, items } = await packetWith(s, "caseManager", n.notice, [a.versionId]);
      await leadOnCaseB(s);
      await clearAsIs(s, "lead", items[0]!);
      await s.as("caseManager");
      expect(await s.tx`select api.submit_defence_packet(${packet}) as st`).toEqual([{ st: "RELEASED" }]);
      for (const u of ["caseManager", "grcDirector", "lead"] as const) {
        await s.as(u);
        await s.expectError("CDF_NOT_FOUND", (tx) => approvalView(tx, packet));
      }
    });
  });

  it("AGENT-09 R1: the approval read is VOLATILE (it audits); only authenticated may call it", async () => {
    const [fn] = await admin<{ volatility: string; anon: boolean; authenticated: boolean }[]>`
      select p.provolatile as volatility,
             has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated
      from pg_proc p where p.oid = 'api.defence_packet_approval_view(uuid)'::regprocedure`;
    expect(fn).toEqual({ volatility: "v", anon: false, authenticated: true });
  });
});
