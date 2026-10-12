// Business architecture rebase, migration 1900 (ADR-021, ADR-022, ADR-023, ADR-031; owner Q&A Q58, Q64–Q90;
// AUTHORIZATION_IMPACT.md N14, N15, N19). The Investigation Committee recommends and the competent authority decides:
// packages are prepared by the seated secretary and adopted only by a committee vote; a free-text sanction stays
// flagged PROPOSED_UNVERIFIED; the legal reviewer reaches only the packet assigned to them; an authority decision
// needs its source document and the authority the rules name; packets never carry the reporter's identity.
import { beforeAll, describe, expect, it } from "vitest";
import { USERS, admin, caseId, ownerScenario, scenario, type Scenario } from "../support/db";
import { REASON, committeeIds } from "../support/committee";
import {
  draftPackage,
  packageStatus,
  requestLegalReview,
  voteOnPackage,
  type PackageFixture,
} from "../support/decision";

let caseA: string, caseB: string, ic: string, gc: string;

beforeAll(async () => {
  [caseA, caseB] = await Promise.all([caseId("0001"), caseId("0002")]);
  ({ ic, gc } = await committeeIds());
});

const decide = (
  s: Scenario,
  f: PackageFixture,
  authority: string,
  outcome: string,
  source: string | null,
  itemOutcomes: unknown = null,
) =>
  s.tx`select api.record_authority_decision(${f.pkg}, ${authority}, ${outcome}, now() - interval '1 hour',
    'Chief Executive (synthetic)', ${source}, ${itemOutcomes === null ? null : s.tx.json(itemOutcomes as never)}::jsonb,
    ${REASON}) as id`;

describe("recommendation packages (ADR-021)", () => {
  it("only the seated secretary prepares a package; items are scoped and sanctions are governed", async () => {
    await ownerScenario(async (s) => {
      const f = await draftPackage(s, ic, caseB);
      // Members and the case team see the package; only the secretary writes it.
      for (const u of ["legal", "caseManager"] as const) {
        await s.as(u);
        expect(await s.tx`select id from decision.recommendation_package`, u).toHaveLength(1);
        await s.expectError(
          "CDF_FORBIDDEN",
          (tx) =>
            tx`select api.add_recommendation_item(${f.pkg}, 'OTHER', null, null, 'Synthetic: other recommendation.', null, null)`,
        );
      }
      for (const u of ["committee", "platformAdmin", "legalB", "investigatorA"] as const) {
        await s.as(u);
        expect(await s.tx`select id from decision.recommendation_package`, u).toEqual([]);
        expect(await s.tx`select id from decision.recommendation_item`, u).toEqual([]);
        await s.expectError(
          "CDF_NOT_FOUND",
          (tx) =>
            tx`select api.add_recommendation_item(${f.pkg}, 'OTHER', null, null, 'Synthetic: other recommendation.', null, null)`,
        );
      }
      await s.as("committeeSecretary");
      const add = (type: string, code: string | null, text: string | null, subjects: string[] | null) =>
        s.tx`select api.add_recommendation_item(${f.pkg}, ${type}, ${code}, ${text}, 'Synthetic: recommendation text.',
          ${subjects}::uuid[], null) as id`;
      await s.expectError("CDF_INVALID:subject_ids", () =>
        add("DISCIPLINARY_SANCTION", "WARNING", null, null),
      );
      await s.expectError("CDF_INVALID:sanction", () =>
        add("DISCIPLINARY_SANCTION", "WARNING", "Synthetic: written warning", [f.subject]),
      );
      await s.expectError("CDF_INVALID:sanction_code", () =>
        add("DISCIPLINARY_SANCTION", "PUBLIC_SHAMING", null, [f.subject]),
      );
      await s.expectError("CDF_INVALID:sanction", () => add("CORRECTIVE_ACTION", "WARNING", null, null));
      // A subject of another case cannot be named.
      await s.as("caseManager");
      const [other] = await s.tx<{ id: string }[]>`
        select api.add_case_subject(${caseA}, 'Employee Omicron (synthetic)', 'EMPLOYEE', null) as id`;
      await s.as("committeeSecretary");
      await s.expectError("CDF_INVALID:subject_ids", () =>
        add("DISCIPLINARY_SANCTION", "WARNING", null, [other!.id]),
      );
      // Q87: a free-text sanction is flagged and stays flagged.
      const [proposed] = await s.tx<{ id: string }[]>`
        select api.add_recommendation_item(${f.pkg}, 'DISCIPLINARY_SANCTION', null, 'Synthetic: mandatory retraining',
          'Synthetic: proposed sanction outside the catalogue.', ${[f.subject]}::uuid[], null) as id`;
      const rows = await s.tx<{ id: string; verification_status: string; case_wide: boolean }[]>`
        select id, verification_status, case_wide from decision.recommendation_item where package_id = ${f.pkg}`;
      const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
      expect(byId[f.sanction]).toMatchObject({ verification_status: "CATALOGUE", case_wide: false });
      expect(byId[f.corrective]).toMatchObject({ verification_status: "NOT_APPLICABLE", case_wide: true });
      expect(byId[proposed!.id]).toMatchObject({
        verification_status: "PROPOSED_UNVERIFIED",
        case_wide: false,
      });
      await s.asOwner();
      await s.expectError(
        "recommendation item",
        (tx) =>
          tx`update decision.recommendation_item set sanction_code = 'WARNING', proposed_sanction_text = null,
               verification_status = 'CATALOGUE' where id = ${proposed!.id}`,
      );
      // A generic vote item can no longer carry a package target: package votes come from open_package_vote.
      await s.as("committeeSecretary");
      await s.expectError(
        "CDF_INVALID:target_type",
        (tx) => tx`select api.open_vote_item(${f.meeting.meeting}, 'PACKAGE', null, 'Synthetic package')`,
      );
    });
  });

  it("a Grievance Committee proceeding has no recommendation package here", async () => {
    await scenario(async (s) => {
      const { seat } = await import("../support/committee");
      await seat(s, gc, [
        ["committeeChair", "CHAIR"],
        ["committeeSecretary", "SECRETARY"],
        ["legal", "MEMBER"],
      ]);
      await s.as("caseManager");
      const [cp] = await s.tx<{ id: string }[]>`
        select api.refer_case_to_committee(${caseB}, ${gc}, null, ${REASON}) as id`;
      await s.as("committeeSecretary");
      await s.expectError(
        "CDF_CONFLICT:NOT_AN_INVESTIGATION_COMMITTEE",
        (tx) => tx`select api.create_recommendation_package(${cp!.id}, 'PACKAGE')`,
      );
    });
  });

  it("only a committee vote adopts; per-item votes adopt the approved items; nothing approved returns to draft", async () => {
    await scenario(async (s) => {
      const f = await draftPackage(s, ic, caseB, "ITEM");
      await s.as("committeeSecretary");
      await s.expectError(
        "CDF_CONFLICT:PACKAGE_NOT_VOTING",
        (tx) => tx`select api.record_package_adoption(${f.pkg})`,
      );
      expect(await voteOnPackage(s, f, (item) => (item === f.sanction ? "APPROVE" : "REJECT"))).toBe(
        "ADOPTED",
      );
      await s.as("committeeSecretary");
      const results = await s.tx<{ id: string; committee_result: string }[]>`
        select id, committee_result from decision.recommendation_item where package_id = ${f.pkg}`;
      expect(Object.fromEntries(results.map((r) => [r.id, r.committee_result]))).toEqual({
        [f.sanction]: "APPROVED",
        [f.corrective]: "REJECTED",
      });
      // An adopted package is not edited; it is returned and revised instead.
      await s.expectError(
        "CDF_CONFLICT:PACKAGE_NOT_EDITABLE",
        (tx) => tx`select api.withdraw_recommendation_item(${f.corrective}, ${REASON})`,
      );

      const g = await draftPackageOnSameProceeding(s, f);
      expect(await voteOnPackage(s, g, () => "REJECT")).toBe("DRAFT");
    });
  });
});

/** A second package in the proceeding of f (same meeting, sequence 2). */
async function draftPackageOnSameProceeding(s: Scenario, f: PackageFixture): Promise<PackageFixture> {
  await s.as("committeeSecretary");
  const [pkg] = await s.tx<{ id: string }[]>`
    select api.create_recommendation_package(${f.meeting.committeeProceeding}, 'PACKAGE') as id`;
  const [item] = await s.tx<{ id: string }[]>`
    select api.add_recommendation_item(${pkg!.id}, 'GOVERNANCE_REMEDIATION', null, null,
      'Synthetic: revise the delegation matrix.', null, null) as id`;
  return { ...f, pkg: pkg!.id, sanction: item!.id, corrective: item!.id };
}

describe("legal review packets (ADR-022, ADR-031, N14)", () => {
  it("the assigned reviewer reaches the packet and nothing else of the case", async () => {
    await scenario(async (s) => {
      const f = await draftPackage(s, ic, caseB);
      expect(await voteOnPackage(s, f)).toBe("ADOPTED");
      await s.as("committeeSecretary");
      // The reviewer holds the opinion permission, is cleared for the case and is not the requester.
      for (const who of [USERS.lead, USERS.committeeSecretary, USERS.platformAdmin]) {
        await s.expectError(
          "CDF_INVALID:assigned_to",
          (tx) => tx`select api.request_legal_review(${f.pkg}, ${who}, ${REASON}, null, null)`,
        );
      }
      await s.as("legalB");
      expect(await s.tx`select id from decision.packet`).toEqual([]);
      const { request, packet } = await requestLegalReview(s, f);
      await s.as("committeeSecretary");
      await s.expectError(
        "CDF_CONFLICT:PACKAGE_NOT_ADOPTED",
        (tx) => tx`select api.request_legal_review(${f.pkg}, ${USERS.legalB}, ${REASON}, null, null)`,
      );

      await s.as("legalB");
      const [opened] = await s.tx<{ p: { items: { kind: string; source_id: string }[] } }[]>`
        select api.open_packet(${packet}) as p`;
      expect(opened!.p.items.map((i) => [i.kind, i.source_id])).toEqual([
        ["RECOMMENDATION_ITEM", f.sanction],
        ["RECOMMENDATION_ITEM", f.corrective],
        ["FINDING", f.finding],
      ]);
      expect(await s.tx`select id from decision.packet_item`).toHaveLength(3);
      expect(await s.tx`select id from decision.legal_review_request`).toEqual([{ id: request }]);
      // N14: nothing outside the packet.
      expect(await s.tx`select id from decision.recommendation_package`).toEqual([]);
      expect(await s.tx`select id from decision.recommendation_item`).toEqual([]);
      expect(await s.tx`select id from case_mgmt.case_record where id = ${caseB}`).toEqual([]);
      expect(await s.tx`select id from case_mgmt.finding`).toEqual([]);
      expect(await s.tx`select id from case_mgmt.allegation where case_id = ${caseB}`).toEqual([]);
      expect(await s.tx`select id from committee.committee_proceeding`).toEqual([]);
      expect(await s.tx`select id from committee.meeting`).toEqual([]);
      expect(await s.tx`select id from committee.minutes`).toEqual([]);
      // Every packet read is audited.
      await s.as("dpo");
      expect(
        await s.tx`select seq from audit.audit_event where action = 'PACKET_VIEWED' and object_id = ${packet}
                     and actor_id = ${USERS.legalB}`,
      ).toHaveLength(1);

      // Only the assigned reviewer gives the opinion; a seated member with the legal role cannot.
      await s.as("legal");
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.give_legal_opinion(${request}, 'CONCURS', null)`,
      );
      await s.as("committee");
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) => tx`select api.give_legal_opinion(${request}, 'CONCURS', null)`,
      );
      await s.as("legalB");
      await s.expectError(
        "CDF_INVALID:opinion_text",
        (tx) => tx`select api.give_legal_opinion(${request}, 'CONFLICTS', null)`,
      );
      await s.tx`select api.give_legal_opinion(${request}, 'CONFLICTS', 'Synthetic: the sanction lacks a stated basis.')`;
      await s.expectError(
        "CDF_CONFLICT:OPINION_ALREADY_GIVEN",
        (tx) => tx`select api.give_legal_opinion(${request}, 'CONCURS', null)`,
      );
      expect(await packageStatus(s, f.pkg)).toEqual({ status: "RETURNED_BY_LEGAL", round_no: 1 });
      // Returned: revised and voted again in a new round.
      await s.tx`select api.withdraw_recommendation_item(${f.corrective}, ${REASON})`;
      expect(await voteOnPackage(s, f)).toBe("ADOPTED");
      expect(await packageStatus(s, f.pkg)).toEqual({ status: "ADOPTED", round_no: 2 });
      // The round-one opinion does not cover the revised package.
      await s.expectError(
        "CDF_CONFLICT:LEGAL_REVIEW_REQUIRED",
        (tx) => tx`select api.submit_to_authority(${f.pkg})`,
      );
    });
  });

  it("a reviewer who becomes conflicted in the case loses the packet at once", async () => {
    await ownerScenario(async (s) => {
      const f = await draftPackage(s, ic, caseB);
      await voteOnPackage(s, f);
      const { request, packet } = await requestLegalReview(s, f);
      await s.asOwner();
      await s.tx`insert into case_mgmt.conflict_check (case_id, user_id, status, declaration)
                 values (${caseB}, ${USERS.legalB}, 'CONFLICT_DECLARED', 'Synthetic conflict')`;
      await s.as("legalB");
      expect(await s.tx`select id from decision.packet`).toEqual([]);
      expect(await s.tx`select id from decision.packet_item`).toEqual([]);
      await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.open_packet(${packet})`);
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) => tx`select api.give_legal_opinion(${request}, 'CONCURS', null)`,
      );
    });
  });

  it("packets are immutable snapshots and never carry the reporter's identity (N19)", async () => {
    await ownerScenario(async (s) => {
      const f = await draftPackage(s, ic, caseB);
      await voteOnPackage(s, f);
      const { request, packet } = await requestLegalReview(s, f);
      await s.as("legalB");
      await s.tx`select api.give_legal_opinion(${request}, 'CONCURS', null)`;
      await s.as("committeeSecretary");
      const [auth] = await s.tx<{ id: string }[]>`select api.submit_to_authority(${f.pkg}) as id`;
      const [legalPacket] = await s.tx<{ p: unknown }[]>`select api.open_packet(${packet}) as p`;
      const [authorityPacket] = await s.tx<{ p: { items: { kind: string }[] } }[]>`
        select api.open_packet(${auth!.id}) as p`;
      expect(authorityPacket!.p.items.map((i) => i.kind)).toEqual([
        "RECOMMENDATION_ITEM",
        "RECOMMENDATION_ITEM",
        "LEGAL_OPINION",
      ]);
      const identities = await admin<{ wb_id: string; full_name: string | null; email: string | null }[]>`
        select wb_id, full_name, email from protected_identity.reporter_identity`;
      const text = JSON.stringify([legalPacket, authorityPacket]);
      for (const r of identities) {
        for (const v of [r.wb_id, r.full_name, r.email].filter((x): x is string => !!x)) {
          expect(text).not.toContain(v);
        }
      }
      expect(text).not.toMatch(/reporter|wb_id|protected_identity/i);
      await s.asOwner();
      await s.expectError(
        "decision.packet_item is append-only",
        (tx) => tx`update decision.packet_item set snapshot = '{}'::jsonb where packet_id = ${packet}`,
      );
      await s.expectError("decision.packet is append-only", (tx) => tx`delete from decision.packet`);
    });
  });
});

describe("authority decisions (ADR-023, N15)", () => {
  async function awaitingAuthority(s: Scenario): Promise<PackageFixture> {
    const f = await draftPackage(s, ic, caseB);
    await voteOnPackage(s, f);
    await s.as("committeeSecretary");
    // Q74: a sanction needs legal review before the authority.
    await s.expectError(
      "CDF_CONFLICT:LEGAL_REVIEW_REQUIRED",
      (tx) => tx`select api.submit_to_authority(${f.pkg})`,
    );
    const { request } = await requestLegalReview(s, f);
    await s.as("legalB");
    await s.tx`select api.give_legal_opinion(${request}, 'CONCURS_WITH_COMMENTS', 'Synthetic: concur, note the warning period.')`;
    await s.as("committeeSecretary");
    await s.tx`select api.submit_to_authority(${f.pkg})`;
    return f;
  }

  it("needs the source document and the authority the rules name; partial approval names every item", async () => {
    await ownerScenario(async (s) => {
      const f = await awaitingAuthority(s);
      await s.as("legal");
      await s.expectError("CDF_FORBIDDEN", () =>
        decide(s, f, "CEO", "APPROVE_AS_RECOMMENDED", "MEMO-DEMO-0001"),
      );
      await s.as("committeeSecretary");
      // N15: no source document, no decision.
      await s.expectError("CDF_INVALID:source_document_reference", () =>
        decide(s, f, "CEO", "APPROVE_AS_RECOMMENDED", null),
      );
      await s.expectError("CDF_INVALID:source_document_reference", () =>
        decide(s, f, "CEO", "APPROVE_AS_RECOMMENDED", "  "),
      );
      // The seeded rule names the CEO for disciplinary sanctions.
      await s.expectError("CDF_CONFLICT:AUTHORITY_TYPE_MISMATCH", () =>
        decide(s, f, "BOARD", "APPROVE_AS_RECOMMENDED", "MEMO-DEMO-0001"),
      );
      await s.expectError(
        "CDF_INVALID:decided_at",
        (tx) =>
          tx`select api.record_authority_decision(${f.pkg}, 'CEO', 'APPROVE_AS_RECOMMENDED', now() + interval '1 day',
            'Chief Executive (synthetic)', 'MEMO-DEMO-0001', null, null)`,
      );
      await s.expectError("CDF_INVALID:item_outcomes", () =>
        decide(s, f, "CEO", "APPROVE_PARTIALLY", "MEMO-DEMO-0001"),
      );
      await s.expectError("CDF_INVALID:item_outcomes", () =>
        decide(s, f, "CEO", "APPROVE_PARTIALLY", "MEMO-DEMO-0001", [
          { item_id: f.sanction, outcome: "APPROVED" },
        ]),
      );
      await s.expectError("CDF_INVALID:item_outcomes", () =>
        decide(s, f, "CEO", "APPROVE_PARTIALLY", "MEMO-DEMO-0001", [
          { item_id: f.sanction, outcome: "MODIFIED" },
          { item_id: f.corrective, outcome: "APPROVED" },
        ]),
      );
      const [d] = await decide(s, f, "CEO", "APPROVE_PARTIALLY", "MEMO-DEMO-0001", [
        { item_id: f.sanction, outcome: "MODIFIED", modification: "Synthetic: verbal warning instead." },
        { item_id: f.corrective, outcome: "APPROVED" },
      ]);
      expect(await packageStatus(s, f.pkg)).toMatchObject({ status: "DECIDED" });
      const outcomes = await s.tx<{ item_id: string; outcome: string }[]>`
        select item_id, outcome from decision.authority_item_decision where decision_id = ${(d as { id: string }).id}`;
      expect(outcomes).toHaveLength(2);
      // The case team sees the decision; an outsider does not.
      await s.as("caseManager");
      expect(await s.tx`select id from decision.authority_decision`).toHaveLength(1);
      await s.as("committee");
      expect(await s.tx`select id from decision.authority_decision`).toEqual([]);
      // Decided is final, and the database refuses a decision without its source document even from the owner.
      await s.as("committeeSecretary");
      await s.expectError("CDF_CONFLICT:PACKAGE_NOT_AWAITING_AUTHORITY", () =>
        decide(s, f, "CEO", "REJECT", "MEMO-DEMO-0002"),
      );
      await s.asOwner();
      await s.expectError(
        "recommendation package",
        (tx) => tx`update decision.recommendation_package set status = 'DRAFT' where id = ${f.pkg}`,
      );
      await s.expectError(
        "null value",
        (tx) =>
          tx`insert into decision.authority_decision (package_id, case_id, package_round, authority_type, outcome,
               decided_at, decided_by_label, source_document_reference, recorded_by)
             values (${f.pkg}, ${caseB}, 1, 'CEO', 'REJECT', now(), 'Synthetic', null, ${USERS.committeeSecretary})`,
      );
      await s.expectError(
        "decision.authority_decision is append-only",
        (tx) => tx`update decision.authority_decision set outcome = 'REJECT'`,
      );
    });
  });

  it("the authority rule is configurable by the committee administrator and binds later decisions", async () => {
    await scenario(async (s) => {
      await s.as("committeeSecretary");
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) =>
          tx`select api.set_action_authority_rule('DISCIPLINARY_SANCTION', 'BOARD', now(), 'SOURCE_REQUIRED', ${REASON})`,
      );
      await s.as("platformAdmin");
      await s.expectError(
        "CDF_INVALID:authority_type",
        (tx) =>
          tx`select api.set_action_authority_rule('DISCIPLINARY_SANCTION', 'MINISTER', now(), 'SOURCE_REQUIRED', ${REASON})`,
      );
      await s.tx`select api.set_action_authority_rule('DISCIPLINARY_SANCTION', 'BOARD', now(), 'SOURCE_REQUIRED', ${REASON})`;
      const f = await awaitingAuthority(s);
      await s.as("committeeSecretary");
      await s.expectError("CDF_CONFLICT:AUTHORITY_TYPE_MISMATCH", () =>
        decide(s, f, "CEO", "APPROVE_AS_RECOMMENDED", "MEMO-DEMO-0003"),
      );
      await decide(s, f, "BOARD", "APPROVE_AS_RECOMMENDED", "BOARD-RES-DEMO-0001");
      expect(await packageStatus(s, f.pkg)).toMatchObject({ status: "DECIDED" });
    });
  });

  it("returned to the committee, a package is revised and voted again in a new round", async () => {
    await scenario(async (s) => {
      const f = await awaitingAuthority(s);
      await s.as("committeeSecretary");
      await decide(s, f, "CEO", "RETURN_TO_COMMITTEE", "MEMO-DEMO-0004");
      expect(await packageStatus(s, f.pkg)).toEqual({ status: "RETURNED_BY_AUTHORITY", round_no: 1 });
      await s.tx`select api.withdraw_recommendation_item(${f.sanction}, ${REASON})`;
      expect(await voteOnPackage(s, f)).toBe("ADOPTED");
      expect(await packageStatus(s, f.pkg)).toEqual({ status: "ADOPTED", round_no: 2 });
      // Only the corrective action remains: no legal review is required this time.
      await s.tx`select api.submit_to_authority(${f.pkg})`;
      await decide(s, f, "CEO", "APPROVE_AS_RECOMMENDED", "MEMO-DEMO-0005");
      const decisions = await s.tx<{ package_round: number; outcome: string }[]>`
        select package_round, outcome from decision.authority_decision where package_id = ${f.pkg} order by recorded_at`;
      expect(decisions).toEqual([
        { package_round: 1, outcome: "RETURN_TO_COMMITTEE" },
        { package_round: 2, outcome: "APPROVE_AS_RECOMMENDED" },
      ]);
    });
  });
});
