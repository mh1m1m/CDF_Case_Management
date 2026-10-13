// Business architecture rebase, migration 1900 (ADR-021, ADR-022, ADR-023, ADR-031; owner Q&A Q58, Q64–Q90;
// AUTHORIZATION_IMPACT.md N14, N15, N19). The Investigation Committee recommends and the competent authority decides:
// packages are prepared by the seated secretary and adopted only by a committee vote; a free-text sanction stays
// flagged PROPOSED_UNVERIFIED; the legal reviewer reaches only the packet assigned to them; an authority decision
// needs its source document and the authority the rules name; packets never carry the reporter's identity.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
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
import { REASON, committeeIds, preliminaryReferral, seat } from "../support/committee";
import {
  authorityRuleFor,
  closePackageVotes,
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
  s.tx`select api.record_authority_decision(${f.pkg}, ${authority}, ${outcome}, now(),
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
  it("T-AMB-065: the assigned reviewer reaches the packet and nothing else of the case; a revised round needs its own opinion", async () => {
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

  it("T-AMB-073: needs the source document and the authority the rules name; partial approval names every item", async () => {
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

describe("AGENT-09 review of 1900 (W1, W2, reviewer eligibility)", () => {
  it("a member who declared a meeting conflict sees no package, items, scope, packet or opinion (W1)", async () => {
    await scenario(async (s) => {
      const f = await draftPackage(s, ic, caseB);
      await voteOnPackage(s, f);
      const { request, packet } = await requestLegalReview(s, f);
      await s.as("legalB");
      await s.tx`select api.give_legal_opinion(${request}, 'CONCURS', null)`;
      await s.as("legal");
      expect(await s.tx`select id from decision.recommendation_package`).toHaveLength(1);
      await s.tx`select api.declare_meeting_conflict(${f.meeting.participant.legal!}, 'CONFLICT_DECLARED', 'Synthetic: related party.')`;
      expect(await s.tx`select id from decision.recommendation_package`).toEqual([]);
      expect(await s.tx`select id from decision.recommendation_item`).toEqual([]);
      expect(await s.tx`select item_id from decision.recommendation_item_subject`).toEqual([]);
      expect(await s.tx`select item_id from decision.recommendation_item_allegation`).toEqual([]);
      expect(await s.tx`select id from decision.packet`).toEqual([]);
      expect(await s.tx`select id from decision.packet_item`).toEqual([]);
      expect(await s.tx`select id from decision.legal_review_request`).toEqual([]);
      await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.open_packet(${packet})`);
      // The case team keeps its view.
      await s.as("caseManager");
      expect(await s.tx`select id from decision.recommendation_package`).toHaveLength(1);
      // A secretary who declared a conflict no longer manages the package.
      await s.as("committeeSecretary");
      const manages = async () =>
        (await s.tx<{ ok: boolean }[]>`select authz.can_manage_recommendation_package(${f.pkg}) as ok`)[0]!
          .ok;
      expect(await manages()).toBe(true);
      await s.tx`select api.declare_meeting_conflict(${f.meeting.participant.committeeSecretary!}, 'CONFLICT_DECLARED', 'Synthetic: related party.')`;
      expect(await manages()).toBe(false);
      await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.submit_to_authority(${f.pkg})`);
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.create_recommendation_package(${f.meeting.committeeProceeding}, 'PACKAGE')`,
      );
    });
  });

  it("on a restricted case a legal review needs the case authority's approval naming the reviewer (W2)", async () => {
    await ownerScenario(async (s) => {
      const caseExec = await caseId("0003"); // SECRET, restricted, owner grcDirector
      await s.asOwner();
      await s.tx`update iam.user_profile set clearance = 'SECRET'
                 where id in (${USERS.committeeSecretary}, ${USERS.legalB})`;
      const { seat } = await import("../support/committee");
      await seat(s, ic, [
        ["committeeChair", "CHAIR"],
        ["committeeSecretary", "SECRETARY"],
        ["grcDeputy", "MEMBER"],
      ]);
      await preliminaryReferral(s, caseExec); // AMB-018 (migration 2030)
      await s.as("grcDirector");
      await s.tx`select api.approve_restricted_committee_referral(${caseExec}, ${ic}, ${REASON})`;
      const [cp] = await s.tx<{ id: string }[]>`
        select api.refer_case_to_committee(${caseExec}, ${ic}, null, ${REASON}) as id`;
      await s.as("committeeSecretary");
      const [m] = await s.tx<{ id: string }[]>`
        select api.schedule_meeting(${cp!.id}, 'DELIBERATION', 'IN_PERSON', 'Room (synthetic)', null,
          now() + interval '1 day', now() + interval '1 day 1 hour', ${REASON}) as id`;
      const [p] = await s.tx<{ id: string }[]>`
        select id from committee.meeting_participant where meeting_id = ${m!.id} and user_id = ${USERS.grcDeputy}`;
      await s.as("grcDeputy");
      await s.tx`select api.declare_meeting_conflict(${p!.id}, 'NO_CONFLICT', null)`;
      await s.as("committeeSecretary");
      await s.tx`select api.open_meeting(${m!.id}, ${REASON})`;
      await s.tx`select api.record_attendance(${p!.id}, 'PRESENT')`;
      const [pkg] = await s.tx<
        { id: string }[]
      >`select api.create_recommendation_package(${cp!.id}, 'PACKAGE') as id`;
      await s.tx`select api.add_recommendation_item(${pkg!.id}, 'CORRECTIVE_ACTION', null, null,
                   'Synthetic: tighten the approval controls.', null, null)`;
      await s.tx`select api.submit_package_for_vote(${pkg!.id})`;
      await s.tx`select api.open_package_vote(${m!.id}, ${pkg!.id})`;
      const [vi] = await s.tx<
        { id: string }[]
      >`select id from committee.vote_item where package_id = ${pkg!.id}`;
      await s.as("grcDeputy");
      await s.tx`select api.cast_vote(${vi!.id}, 'APPROVE', null)`;
      await s.as("committeeSecretary");
      await s.tx`select api.close_vote_item(${vi!.id}, null)`;
      await s.tx`select api.record_package_adoption(${pkg!.id})`;

      await s.expectError(
        "CDF_CONFLICT:AUTHORITY_APPROVAL_REQUIRED",
        (tx) => tx`select api.request_legal_review(${pkg!.id}, ${USERS.legalB}, ${REASON}, null, null)`,
      );
      // Only the case's own authority approves; it names a reviewer who is eligible and cleared.
      for (const u of ["grcDeputy", "committeeSecretary"] as const) {
        await s.as(u);
        await s.expectError(
          "CDF_FORBIDDEN",
          (tx) => tx`select api.approve_restricted_legal_review(${pkg!.id}, ${USERS.legalB}, ${REASON})`,
        );
      }
      await s.as("legalB");
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) => tx`select api.approve_restricted_legal_review(${pkg!.id}, ${USERS.legalB}, ${REASON})`,
      );
      await s.as("grcDirector");
      await s.expectError(
        "CDF_INVALID:reviewer_id",
        (tx) => tx`select api.approve_restricted_legal_review(${pkg!.id}, ${USERS.legal}, ${REASON})`,
      );
      const [a] = await s.tx<{ id: string }[]>`
        select api.approve_restricted_legal_review(${pkg!.id}, ${USERS.legalB}, ${REASON}) as id`;
      // The approval covers the named reviewer only.
      await s.asOwner();
      await s.tx`update iam.user_profile set clearance = 'SECRET' where id = ${USERS.legal}`;
      await s.as("committeeSecretary");
      await s.expectError(
        "CDF_CONFLICT:AUTHORITY_APPROVAL_REQUIRED",
        (tx) => tx`select api.request_legal_review(${pkg!.id}, ${USERS.legal}, ${REASON}, null, null)`,
      );
      const [r] = await s.tx<{ id: string }[]>`
        select api.request_legal_review(${pkg!.id}, ${USERS.legalB}, ${REASON}, null, null) as id`;
      // The case team sees the approval, used once by this request.
      await s.as("grcDirector");
      const [used] = await s.tx<{ legal_review_request_id: string }[]>`
        select legal_review_request_id from decision.restricted_legal_review_approval where id = ${a!.id}`;
      expect(used!.legal_review_request_id).toBe(r!.id);
      await s.as("legalB");
      expect(await s.tx`select id from decision.packet`).toHaveLength(1);
    });
  });

  it("a conflicted or uncleared reviewer cannot be assigned", async () => {
    await ownerScenario(async (s) => {
      const f = await draftPackage(s, ic, caseB);
      await voteOnPackage(s, f);
      await s.asOwner();
      await s.tx`update iam.user_profile set clearance = 'INTERNAL' where id = ${USERS.legalB}`;
      await s.as("committeeSecretary");
      await s.expectError(
        "CDF_INVALID:assigned_to",
        (tx) => tx`select api.request_legal_review(${f.pkg}, ${USERS.legalB}, ${REASON}, null, null)`,
      );
      await s.asOwner();
      await s.tx`update iam.user_profile set clearance = 'CONFIDENTIAL' where id = ${USERS.legalB}`;
      await s.tx`insert into case_mgmt.conflict_check (case_id, user_id, status, declaration)
                 values (${caseB}, ${USERS.legalB}, 'CONFLICT_DECLARED', 'Synthetic conflict')`;
      await s.as("committeeSecretary");
      await s.expectError(
        "CDF_INVALID:assigned_to",
        (tx) => tx`select api.request_legal_review(${f.pkg}, ${USERS.legalB}, ${REASON}, null, null)`,
      );
    });
  });

  it("a reviewer whose legal reviewer role is removed loses the packet and cannot give the opinion", async () => {
    await scenario(async (s) => {
      const f = await draftPackage(s, ic, caseB);
      await voteOnPackage(s, f);
      const { request, packet } = await requestLegalReview(s, f);
      const [ra] = await admin<{ id: string }[]>`
        select id from iam.user_role_assignment where user_id = ${USERS.legalB} and role_code = 'LEGAL_REVIEWER'`;
      await s.as("platformAdmin");
      await s.tx`select api.revoke_role(${ra!.id}, ${REASON})`;
      await s.as("legalB");
      expect(await s.tx`select id from decision.packet`).toEqual([]);
      expect(await s.tx`select id from decision.packet_item`).toEqual([]);
      await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.open_packet(${packet})`);
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.give_legal_opinion(${request}, 'CONCURS', null)`,
      );
    });
  });
});

// =====================================================================================================
// Owner Finalization Set, section 3 (migration 2030): DEC-F11, DEC-F12, DEC-F13, DEC-F19, DEC-F20, DEC-AMB-003 and the
// ambiguity rows routed here (T-AMB ids as in AMBIGUITY_TEST_MATRIX.md).
describe("owner Finalization Set: packages, legal review and authority (migration 2030)", () => {
  const FIRM = "Synthetic: the committee's documented reasoning.";

  /** Legal review by legalB with the given opinion, then submission to the authority. */
  async function toAuthority(
    s: Scenario,
    f: PackageFixture,
  ): Promise<{ request: string; packet: string; authorityPacket: string }> {
    const { request, packet } = await requestLegalReview(s, f);
    await s.as("legalB");
    await s.tx`select api.give_legal_opinion(${request}, 'CONCURS', null)`;
    await s.as("committeeSecretary");
    const [k] = await s.tx<{ id: string }[]>`select api.submit_to_authority(${f.pkg}) as id`;
    return { request, packet, authorityPacket: k!.id };
  }

  interface DecisionOptions {
    source?: string;
    items?: unknown;
    delegation?: string | null;
    signature?: string | null;
    attestation?: string | null;
    sources?: string[] | null;
    conditions?: unknown;
  }
  /** The 13-argument authority decision (AMB-125, AMB-129, AMB-130, AMB-133), decided today. */
  const decideWith = (
    s: Scenario,
    f: PackageFixture,
    authority: string,
    outcome: string,
    o: DecisionOptions = {},
  ) =>
    s.tx<{ id: string }[]>`
      select api.record_authority_decision(${f.pkg}, ${authority}, ${outcome}, now(), 'Authority (synthetic)',
        ${o.source ?? "MEMO-DEMO-0201"}, ${o.items ? s.tx.json(o.items as never) : null}::jsonb, ${REASON},
        ${o.delegation ?? null}::text, ${o.signature ?? null}::text, ${o.attestation ?? null}::text,
        ${o.sources ?? null}::text[], ${o.conditions ? s.tx.json(o.conditions as never) : null}::jsonb) as id`;

  const flags = async (s: Scenario, pkg: string) =>
    (
      await s.tx<{ item_id: string; flag: string }[]>`
        select item_id, flag from api.recommendation_item_flags(${pkg})`
    ).map((r) => `${r.item_id}:${r.flag}`);

  describe("defence notice before adoption (AMB-026)", () => {
    it("T-AMB-011: a sanction on an allegation its subject has no defence notice on is not adopted", async () => {
      await scenario(async (s) => {
        const f = await draftPackage(s, ic, caseB);
        await s.as("caseManager");
        const [later] = await s.tx<{ id: string }[]>`
          select api.add_allegation(${caseB}, 'FRAUD', 'Synthetic: a later allegation against Employee Sigma.',
            ${f.subject}, null, null) as id`;
        await s.as("committeeSecretary");
        await s.tx`select api.add_recommendation_item(${f.pkg}, 'DISCIPLINARY_SANCTION', 'SUSPENSION', null,
          'Synthetic: suspension on the later allegation.', ${[f.subject]}::uuid[], ${[later!.id]}::uuid[])`;
        await closePackageVotes(s, f);
        await s.expectError(
          "CDF_CONFLICT:DEFENCE_NOTICE_REQUIRED",
          (tx) => tx`select api.record_package_adoption(${f.pkg})`,
        );
        expect(await packageStatus(s, f.pkg)).toEqual({ status: "VOTING", round_no: 1 });
        // A notice on the later allegation lets the committee's vote stand.
        await s.as("caseManager");
        await s.tx`select api.issue_defence_notice(${f.subject}, 'Synthetic: you are invited to respond.',
          ${[later!.id]}::uuid[], now() + interval '10 days')`;
        await s.as("committeeSecretary");
        const [r] = await s.tx<{ status: string }[]>`select api.record_package_adoption(${f.pkg}) as status`;
        expect(r!.status).toBe("ADOPTED");
      });
    });

    it("T-AMB-011: the committee's rule set may switch the guard off; the proceeding keeps its snapshot", async () => {
      await scenario(async (s) => {
        await s.as("platformAdmin");
        await s.tx`select api.revise_committee_rule_set(${ic}, now(),
          ${s.tx.json({ sanction_requires_defence_notice: false })}, 'SOURCE_REQUIRED', ${REASON})`;
        const f = await draftPackage(s, ic, caseB);
        await s.as("caseManager");
        const [later] = await s.tx<{ id: string }[]>`
          select api.add_allegation(${caseB}, 'FRAUD', 'Synthetic: a later allegation against Employee Sigma.',
            ${f.subject}, null, null) as id`;
        await s.as("committeeSecretary");
        await s.tx`select api.add_recommendation_item(${f.pkg}, 'DISCIPLINARY_SANCTION', 'SUSPENSION', null,
          'Synthetic: suspension on the later allegation.', ${[f.subject]}::uuid[], ${[later!.id]}::uuid[])`;
        expect(await voteOnPackage(s, f)).toBe("ADOPTED");
      });
    });
  });

  describe("sanction catalogue versions (DEC-F11)", () => {
    it("T-AMB-057: a sanction without a sourced basis is shown as SOURCE_REQUIRED, never as policy (AMB-102)", async () => {
      await ownerScenario(async (s) => {
        const entry = async (code: string) =>
          (
            await s.tx<Record<string, unknown>[]>`
              select version_no, basis_status, legal_basis, internal_policy_basis, source_reference, authority_status,
                     legal_review_requirement, exclusivity_status, subject_categories
              from decision.sanction_catalogue_entry where code = ${code}`
          )[0];
        await s.as("caseManager");
        const rows = await s.tx<{ code: string }[]>`
          select code from decision.sanction_catalogue_entry order by code collate "C"`;
        expect(rows.map((r) => r.code)).toEqual([
          "DEMOTION",
          "SALARY_DEDUCTION",
          "SUSPENSION",
          "TERMINATION",
          "WARNING",
        ]);
        for (const r of rows) {
          expect(await entry(r.code), r.code).toEqual({
            version_no: 1,
            basis_status: "SOURCE_REQUIRED",
            legal_basis: null,
            internal_policy_basis: null,
            source_reference: null,
            authority_status: "SOURCE_REQUIRED",
            legal_review_requirement: "SOURCE_REQUIRED",
            exclusivity_status: "SOURCE_REQUIRED",
            subject_categories: ["EMPLOYEE", "OTHER_AUTHORIZED"],
          });
        }
        // The versions themselves are not selectable; anonymous callers see nothing.
        await s.expectError(
          "permission denied",
          (tx) => tx`select id from decision.sanction_catalogue_version`,
        );
        await s.as(null);
        await s.expectError(
          "permission denied",
          (tx) => tx`select code from decision.sanction_catalogue_entry`,
        );

        // Only the committee administrator writes a version; APPROVED needs the basis and the source that approved it.
        const set = (
          code: string,
          basis: string | null,
          status: string,
          reference: string | null,
          days = 0,
        ) =>
          s.tx<{ id: string }[]>`
            select api.set_sanction_catalogue_entry(${code}, ${basis}, null, null, 'SOURCE_REQUIRED',
              array['EMPLOYEE']::text[], null, now() + ${days} * interval '1 day', ${status}, ${reference},
              ${REASON}) as id`;
        await s.as("committeeSecretary");
        await s.expectError("CDF_FORBIDDEN", () => set("WARNING", null, "SOURCE_REQUIRED", null));
        await s.as("platformAdmin");
        await s.expectError("CDF_INVALID:legal_basis", () =>
          set("WARNING", null, "APPROVED", "DEMO-SRC-0001"),
        );
        await s.expectError("CDF_INVALID:source_reference", () =>
          set("WARNING", "Synthetic basis text", "APPROVED", null),
        );
        await s.expectError("CDF_INVALID:effective_from", () =>
          set("WARNING", null, "SOURCE_REQUIRED", null, -1),
        );
        await s.expectError(
          "CDF_INVALID:subject_categories",
          (tx) =>
            tx`select api.set_sanction_catalogue_entry('WARNING', null, null, null, 'SOURCE_REQUIRED',
              array['VENDOR']::text[], null, now(), 'SOURCE_REQUIRED', null, ${REASON})`,
        );
        // Draft text under SOURCE_REQUIRED is kept on the version and never shown as policy.
        await set("WARNING", "Synthetic draft basis, unconfirmed", "SOURCE_REQUIRED", null);
        expect(await entry("WARNING")).toMatchObject({
          version_no: 2,
          basis_status: "SOURCE_REQUIRED",
          legal_basis: null,
        });
        await s.expectError("CDF_CONFLICT:LATER_VERSION_EXISTS", () =>
          set("WARNING", null, "SOURCE_REQUIRED", null),
        );
        // An approved version shows its basis and its source once in force (synthetic text and reference).
        await set(
          "SUSPENSION",
          "Synthetic basis: article 0 of a demo regulation",
          "APPROVED",
          "DEMO-SRC-0002",
        );
        await s.as("caseManager");
        expect(await entry("SUSPENSION")).toMatchObject({
          version_no: 2,
          basis_status: "SOURCED",
          legal_basis: "Synthetic basis: article 0 of a demo regulation",
          source_reference: "DEMO-SRC-0002",
        });
        // The ledger gets codes and flags, never the basis text.
        await s.as("dpo");
        const events = await s.tx<{ metadata: unknown; reason: string | null }[]>`
          select metadata, reason from audit.audit_event where action = 'SANCTION_CATALOGUE_VERSION_SET'`;
        expect(events).toHaveLength(2);
        expect(JSON.stringify(events)).not.toMatch(/Synthetic (draft )?basis/);
        // A version is never rewritten, even by the table owner; it is only given an end, once.
        await s.asOwner();
        await s.expectError(
          "sanction_catalogue_version",
          (tx) =>
            tx`update decision.sanction_catalogue_version set legal_basis = 'Rewritten' where code = 'SUSPENSION'`,
        );
        await s.expectError(
          "decision.sanction_catalogue_version is append-only",
          (tx) => tx`delete from decision.sanction_catalogue_version where code = 'SUSPENSION'`,
        );
      });
    });

    it("T-AMB-056: a catalogue change after adoption does not change the adopted item (AMB-101)", async () => {
      await scenario(async (s) => {
        const f = await draftPackage(s, ic, caseB);
        await voteOnPackage(s, f);
        await s.as("committeeSecretary");
        const adopted = async () =>
          (
            await s.tx<{ id: string; no: number }[]>`
              select catalogue_version_id as id, (snapshot ->> 'catalogue_version_no')::int as no
              from decision.item_adoption where item_id = ${f.sanction}`
          )[0]!;
        const before = await adopted();
        expect(before.no).toBe(1);
        expect(await flags(s, f.pkg)).toContain(`${f.sanction}:SANCTION_SOURCE_REQUIRED`);
        // A new version in force from now: another authority and a legal-review requirement.
        await s.as("platformAdmin");
        await s.tx`select api.set_sanction_catalogue_entry('WARNING', null, null, 'BOARD', 'REQUIRED',
          array['EMPLOYEE']::text[], null, now(), 'SOURCE_REQUIRED', null, ${REASON})`;
        await s.as("committeeSecretary");
        const [entry] = await s.tx`
          select version_no, authority_type, legal_review_requirement from decision.sanction_catalogue_entry
          where code = 'WARNING'`;
        expect(entry).toEqual({
          version_no: 2,
          authority_type: "BOARD",
          legal_review_requirement: "REQUIRED",
        });
        // The adopted item keeps version 1, on its adoption and in what Legal receives.
        expect(await adopted()).toEqual(before);
        const { packet } = await requestLegalReview(s, f);
        const [snap] = await s.tx<{ v: string }[]>`
          select snapshot ->> 'catalogue_version_id' as v from decision.packet_item
          where packet_id = ${packet} and source_id = ${f.sanction}`;
        expect(snap!.v).toBe(before.id);
      });
    });

    it("AMB-036: a catalogue sanction is offered only for the subject categories of its version (no CONTRACTOR yet)", async () => {
      await scenario(async (s) => {
        const f = await draftPackage(s, ic, caseB);
        await s.as("caseManager");
        const [kappa] = await s.tx<{ id: string }[]>`
          select api.add_case_subject(${caseB}, 'Contractor Kappa (synthetic)', 'CONTRACTOR', null) as id`;
        await s.as("committeeSecretary");
        const add = (code: string | null, text: string | null, type = "DISCIPLINARY_SANCTION") =>
          s.tx`select api.add_recommendation_item(${f.pkg}, ${type}, ${code}, ${text},
            'Synthetic: an item on the contractor.', ${[kappa!.id]}::uuid[], null) as id`;
        await s.expectError("CDF_CONFLICT:SANCTION_NOT_APPLICABLE_TO_SUBJECT", () => add("WARNING", null));
        await s.expectError("CDF_CONFLICT:SANCTION_NOT_APPLICABLE_TO_SUBJECT", () =>
          add(null, "Synthetic: end the contract"),
        );
        // A corrective action may name the contractor; only sanctions are governed by category.
        await add(null, null, "CORRECTIVE_ACTION");
        // Once a version names CONTRACTOR (synthetic), the code is offered for them.
        await s.as("platformAdmin");
        await s.tx`select api.set_sanction_catalogue_entry('WARNING', null, null, null, 'SOURCE_REQUIRED',
          array['EMPLOYEE', 'CONTRACTOR']::text[], null, now(), 'SOURCE_REQUIRED', null, ${REASON})`;
        await s.as("committeeSecretary");
        await add("WARNING", null);
      });
    });
  });

  describe("legal review rules (DEC-F12, CON-017)", () => {
    it("T-AMB-065 (AMB-113): the owner minimums cannot be switched off; the rule table, not a fixed list, decides", async () => {
      await scenario(async (s) => {
        await s.as("caseManager");
        const open = await s.tx<{ k: string }[]>`
          select k from (select committee_kind || ':' || trigger_kind || ':' || coalesce(item_type, '-') || ':'
                                || requirement || ':' || source_status as k
                         from decision.legal_review_rule where effective_to is null) r
          order by k collate "C"`;
        expect(open.map((r) => r.k)).toEqual([
          "GRIEVANCE:ITEM_TYPE:DISCIPLINARY_SANCTION:REQUIRED:OWNER_DEFAULT",
          "INVESTIGATION:ITEM_TYPE:DISCIPLINARY_SANCTION:REQUIRED:OWNER_DEFAULT",
          "INVESTIGATION:ITEM_TYPE:EXTERNAL_REFERRAL:REQUIRED:OWNER_DEFAULT",
          "INVESTIGATION:ITEM_TYPE:LEGAL_ACTION:REQUIRED:OWNER_DECISION",
          "INVESTIGATION:LEGAL_JUSTIFICATION_FLAG:-:REQUIRED:OWNER_DECISION",
        ]);
        const rule = (kind: string, type: string | null, requirement: string) =>
          s.tx`select api.set_legal_review_rule('INVESTIGATION', ${kind}, ${type}, ${requirement}, now(),
            'SOURCE_REQUIRED', ${REASON}) as id`;
        await s.as("committeeSecretary");
        await s.expectError("CDF_FORBIDDEN", () => rule("ITEM_TYPE", "CORRECTIVE_ACTION", "REQUIRED"));
        await s.as("platformAdmin");
        await s.expectError("CDF_CONFLICT:OWNER_MINIMUM_RULE", () =>
          rule("ITEM_TYPE", "LEGAL_ACTION", "NOT_REQUIRED"),
        );
        await s.expectError("CDF_CONFLICT:OWNER_MINIMUM_RULE", () =>
          rule("LEGAL_JUSTIFICATION_FLAG", null, "NOT_REQUIRED"),
        );
        await s.expectError("CDF_INVALID:item_type", () => rule("ITEM_TYPE", null, "REQUIRED"));
        await s.expectError("CDF_INVALID:item_type", () =>
          rule("LEGAL_JUSTIFICATION_FLAG", "OTHER", "REQUIRED"),
        );
        // The configured disciplinary rule (an owner default) may change: from now no legal review for sanctions.
        await rule("ITEM_TYPE", "DISCIPLINARY_SANCTION", "NOT_REQUIRED");
        await s.expectError("CDF_CONFLICT:LATER_RULE_EXISTS", () =>
          rule("ITEM_TYPE", "DISCIPLINARY_SANCTION", "REQUIRED"),
        );
        const f = await draftPackage(s, ic, caseB);
        // A matter that needs a legal justification still needs the review (owner minimum).
        await s.as("committeeSecretary");
        const [justified] = await s.tx<{ id: string }[]>`
          select api.add_recommendation_item(${f.pkg}, 'OTHER', null, null, 'Synthetic: a matter needing a legal basis.',
            null, null, true, null, null) as id`;
        await voteOnPackage(s, f);
        await s.expectError(
          "CDF_CONFLICT:LEGAL_REVIEW_REQUIRED",
          (tx) => tx`select api.submit_to_authority(${f.pkg})`,
        );
        const { request } = await requestLegalReview(s, f);
        const [basis] = await s.tx<{ basis: string }[]>`
          select basis from decision.legal_review_request where id = ${request}`;
        expect(basis!.basis).toBe("RULE");
        expect(justified).toBeDefined();
      });
    });

    it("T-AMB-065 (AMB-113): without a required rule the package goes straight to the authority; the secretary may still elect a review", async () => {
      await scenario(async (s) => {
        await s.as("platformAdmin");
        await s.tx`select api.set_legal_review_rule('INVESTIGATION', 'ITEM_TYPE', 'DISCIPLINARY_SANCTION', 'NOT_REQUIRED',
          now(), 'SOURCE_REQUIRED', ${REASON})`;
        const f = await draftPackage(s, ic, caseB);
        await voteOnPackage(s, f);
        const { request } = await requestLegalReview(s, f);
        const [basis] = await s.tx<{ basis: string }[]>`
          select basis from decision.legal_review_request where id = ${request}`;
        expect(basis!.basis).toBe("SECRETARY_ELECTED");
      });
    });

    it("T-AMB-065 (AMB-113): a sanction catalogue version that requires review counts as a rule for items adopted under it", async () => {
      await scenario(async (s) => {
        await s.as("platformAdmin");
        await s.tx`select api.set_legal_review_rule('INVESTIGATION', 'ITEM_TYPE', 'DISCIPLINARY_SANCTION', 'NOT_REQUIRED',
          now(), 'SOURCE_REQUIRED', ${REASON})`;
        await s.tx`select api.set_sanction_catalogue_entry('WARNING', null, null, null, 'REQUIRED',
          array['EMPLOYEE']::text[], null, now(), 'SOURCE_REQUIRED', null, ${REASON})`;
        const g = await draftPackage(s, ic, caseB);
        await s.as("committeeSecretary");
        await s.tx`select api.withdraw_recommendation_item(${g.corrective}, ${REASON})`;
        await voteOnPackage(s, g);
        await s.expectError(
          "CDF_CONFLICT:LEGAL_REVIEW_REQUIRED",
          (tx) => tx`select api.submit_to_authority(${g.pkg})`,
        );
      });
    });
  });

  describe("returns, cancellation and superseding opinions", () => {
    it("T-AMB-061: before submission the secretary returns an adopted package; after it, nothing changes it (AMB-108)", async () => {
      await scenario(async (s) => {
        const f = await draftPackage(s, ic, caseB);
        await voteOnPackage(s, f);
        await s.as("legal");
        await s.expectError(
          "CDF_FORBIDDEN",
          (tx) => tx`select api.return_package_to_committee(${f.pkg}, ${REASON})`,
        );
        await s.as("committee");
        await s.expectError(
          "CDF_NOT_FOUND",
          (tx) => tx`select api.return_package_to_committee(${f.pkg}, ${REASON})`,
        );
        await s.as("committeeSecretary");
        await s.expectError(
          "CDF_INVALID:reason",
          (tx) => tx`select api.return_package_to_committee(${f.pkg}, null)`,
        );
        await s.tx`select api.return_package_to_committee(${f.pkg}, 'Synthetic: new evidence arrived after adoption.')`;
        expect(await packageStatus(s, f.pkg)).toEqual({ status: "DRAFT", round_no: 1 });
        await s.expectError(
          "CDF_CONFLICT:PACKAGE_NOT_ADOPTED",
          (tx) => tx`select api.return_package_to_committee(${f.pkg}, ${REASON})`,
        );
        await s.as("caseManager");
        expect(
          await s.tx`select package_round from decision.package_return where package_id = ${f.pkg}`,
        ).toEqual([{ package_round: 1 }]);
        expect(await voteOnPackage(s, f)).toBe("ADOPTED");
        expect(await packageStatus(s, f.pkg)).toEqual({ status: "ADOPTED", round_no: 2 });
        const { request } = await toAuthority(s, f);
        // With the authority: no return, edit, vote, legal review or superseding opinion.
        await s.expectError(
          "CDF_CONFLICT:PACKAGE_NOT_ADOPTED",
          (tx) => tx`select api.return_package_to_committee(${f.pkg}, ${REASON})`,
        );
        await s.expectError(
          "CDF_CONFLICT:PACKAGE_NOT_EDITABLE",
          (tx) =>
            tx`select api.add_recommendation_item(${f.pkg}, 'OTHER', null, null, 'Synthetic: a late addition.', null, null)`,
        );
        await s.expectError(
          "CDF_CONFLICT:PACKAGE_NOT_EDITABLE",
          (tx) => tx`select api.withdraw_recommendation_item(${f.corrective}, ${REASON})`,
        );
        await s.expectError(
          "CDF_CONFLICT:PACKAGE_NOT_EDITABLE",
          (tx) => tx`select api.submit_package_for_vote(${f.pkg})`,
        );
        await s.expectError(
          "CDF_CONFLICT:PACKAGE_NOT_ADOPTED",
          (tx) => tx`select api.request_legal_review(${f.pkg}, ${USERS.legalB}, ${REASON}, null, null)`,
        );
        await s.as("legalB");
        await s.expectError(
          "CDF_CONFLICT:PACKAGE_NOT_ADOPTED",
          (tx) =>
            tx`select api.give_superseding_legal_opinion(${request}, 'CONFLICTS', 'Synthetic: too late to supersede.')`,
        );
        expect(await packageStatus(s, f.pkg)).toEqual({ status: "AWAITING_AUTHORITY", round_no: 2 });
      });
    });

    it("T-AMB-066: a cancelled request ends the replaced reviewer's packet at once (AMB-115)", async () => {
      await scenario(async (s) => {
        const f = await draftPackage(s, ic, caseB);
        await voteOnPackage(s, f);
        const { request, packet } = await requestLegalReview(s, f);
        await s.as("legalB");
        expect(await s.tx`select id from decision.packet`).toHaveLength(1);
        await s.expectError(
          "CDF_FORBIDDEN",
          (tx) => tx`select api.cancel_legal_review_request(${request}, ${REASON})`,
        );
        await s.as("committee");
        await s.expectError(
          "CDF_NOT_FOUND",
          (tx) => tx`select api.cancel_legal_review_request(${request}, ${REASON})`,
        );
        await s.as("committeeSecretary");
        await s.tx`select api.cancel_legal_review_request(${request}, 'Synthetic: the reviewer is replaced.')`;
        expect(await packageStatus(s, f.pkg)).toEqual({ status: "ADOPTED", round_no: 1 });
        await s.expectError(
          "CDF_CONFLICT:LEGAL_REVIEW_NOT_OPEN",
          (tx) => tx`select api.cancel_legal_review_request(${request}, ${REASON})`,
        );
        await s.as("legalB");
        expect(await s.tx`select id from decision.packet`).toEqual([]);
        expect(await s.tx`select id from decision.packet_item`).toEqual([]);
        expect(await s.tx`select id from decision.legal_review_request`).toEqual([]);
        await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.open_packet(${packet})`);
        await s.expectError(
          "CDF_NOT_FOUND",
          (tx) => tx`select api.give_legal_opinion(${request}, 'CONCURS', null)`,
        );
        await s.expectError(
          "CDF_NOT_FOUND",
          (tx) => tx`select api.give_superseding_legal_opinion(${request}, 'CONCURS', null)`,
        );
        // The replacement is a new request; the cancelled one stays on record.
        await s.as("committeeSecretary");
        await s.tx`select api.request_legal_review(${f.pkg}, ${USERS.legal}, ${REASON}, null, null)`;
        expect(
          await s.tx`select status from decision.legal_review_request where package_id = ${f.pkg}
                     order by status collate "C"`,
        ).toEqual([{ status: "ASSIGNED" }, { status: "CANCELLED" }]);
        await s.as("caseManager");
        expect(
          await s.tx`select request_id from decision.legal_review_cancellation where package_id = ${f.pkg}`,
        ).toEqual([{ request_id: request }]);
        await s.as("legalB");
        expect(await s.tx`select id from decision.packet`).toEqual([]);
      });
    });

    it("AMB-117: a superseding opinion in the same round keeps the first; both travel to the authority", async () => {
      await scenario(async (s) => {
        const f = await draftPackage(s, ic, caseB);
        await voteOnPackage(s, f);
        const { request } = await requestLegalReview(s, f);
        await s.as("legalB");
        await s.expectError(
          "CDF_CONFLICT:OPINION_NOT_GIVEN",
          (tx) => tx`select api.give_superseding_legal_opinion(${request}, 'CONCURS', null)`,
        );
        await s.tx`select api.give_legal_opinion(${request}, 'CONCURS', null)`;
        await s.expectError(
          "CDF_INVALID:opinion_text",
          (tx) => tx`select api.give_superseding_legal_opinion(${request}, 'CONCURS_WITH_COMMENTS', null)`,
        );
        await s.tx`select api.give_superseding_legal_opinion(${request}, 'CONCURS_WITH_COMMENTS',
          'Synthetic: on reflection, note the warning period.')`;
        await s.as("legal");
        await s.expectError(
          "CDF_FORBIDDEN",
          (tx) => tx`select api.give_superseding_legal_opinion(${request}, 'CONCURS', null)`,
        );
        await s.as("committeeSecretary");
        const [first] = await s.tx<{ opinion: string }[]>`
          select opinion from decision.legal_review_request where id = ${request}`;
        expect(first!.opinion).toBe("CONCURS");
        const [k] = await s.tx<{ id: string }[]>`select api.submit_to_authority(${f.pkg}) as id`;
        const opinions = await s.tx<{ revision_no: number; opinion: string; superseded: boolean }[]>`
          select (snapshot ->> 'revision_no')::int as revision_no, snapshot ->> 'opinion' as opinion,
                 (snapshot ->> 'superseded')::boolean as superseded
          from decision.packet_item where packet_id = ${k!.id} and item_kind = 'LEGAL_OPINION' order by position`;
        expect(opinions).toEqual([
          { revision_no: 1, opinion: "CONCURS", superseded: true },
          { revision_no: 2, opinion: "CONCURS_WITH_COMMENTS", superseded: false },
        ]);
      });
    });

    it("AMB-117: a superseding CONFLICTS opinion returns the package to the committee", async () => {
      await scenario(async (s) => {
        const f = await draftPackage(s, ic, caseB);
        await voteOnPackage(s, f);
        const { request } = await requestLegalReview(s, f);
        await s.as("legalB");
        await s.tx`select api.give_legal_opinion(${request}, 'CONCURS', null)`;
        await s.tx`select api.give_superseding_legal_opinion(${request}, 'CONFLICTS',
          'Synthetic: on reflection the sanction lacks a basis.')`;
        expect(await packageStatus(s, f.pkg)).toEqual({ status: "RETURNED_BY_LEGAL", round_no: 1 });
        await s.as("legalB");
        await s.expectError(
          "CDF_CONFLICT:PACKAGE_NOT_ADOPTED",
          (tx) => tx`select api.give_superseding_legal_opinion(${request}, 'CONCURS', null)`,
        );
      });
    });

    it("T-AMB-069: the reviewer's packet ends when the authority decision is recorded, plus the configured grace (AMB-119, AMB-229)", async () => {
      await ownerScenario(async (s) => {
        const f = await draftPackage(s, ic, caseB);
        await voteOnPackage(s, f);
        const { request, packet } = await toAuthority(s, f);
        // After the opinion and until the decision the reviewer keeps the packet.
        await s.as("legalB");
        expect(await s.tx`select id from decision.packet`).toHaveLength(1);
        await s.as("committeeSecretary");
        await decideWith(s, f, "CEO", "APPROVE_AS_RECOMMENDED");
        await s.as("legalB");
        expect(await s.tx`select id from decision.packet`).toEqual([]);
        expect(await s.tx`select id from decision.packet_item`).toEqual([]);
        expect(await s.tx`select id from decision.legal_review_request`).toEqual([]);
        await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.open_packet(${packet})`);
        await s.expectError(
          "CDF_NOT_FOUND",
          (tx) => tx`select api.give_superseding_legal_opinion(${request}, 'CONCURS', null)`,
        );
        // PURPOSE_ACCESS_GRACE_DAYS (default 0) keeps it that long after the decision.
        await s.asOwner();
        await s.tx`update config.setting set value = '1' where key = 'PURPOSE_ACCESS_GRACE_DAYS'`;
        await s.as("legalB");
        expect(await s.tx`select id from decision.packet`).toHaveLength(1);
      });
    });
  });

  describe("restricted legal review scope (DEC-F20)", () => {
    /** AGENT-09 W2 on the restricted SECRET case 0003 (owner grcDirector): referred after its preliminary review and
     *  its authority's approval; a cleared member adopts a corrective action. The owner records a finding. */
    async function restrictedAdopted(
      s: OwnerScenario,
    ): Promise<{ pkg: string; finding: string; caseExec: string }> {
      const caseExec = await caseId("0003");
      await s.asOwner();
      await s.tx`update iam.user_profile set clearance = 'SECRET'
                 where id in (${USERS.committeeSecretary}, ${USERS.legalB})`;
      await seat(s, ic, [
        ["committeeChair", "CHAIR"],
        ["committeeSecretary", "SECRETARY"],
        ["grcDeputy", "MEMBER"],
      ]);
      await authorityRuleFor(s, "CORRECTIVE_ACTION");
      await preliminaryReferral(s, caseExec);
      await s.as("grcDirector");
      await s.tx`select api.approve_restricted_committee_referral(${caseExec}, ${ic}, ${REASON})`;
      const [cp] = await s.tx<{ id: string }[]>`
        select api.refer_case_to_committee(${caseExec}, ${ic}, null, ${REASON}) as id`;
      const [p] = await s.tx<{ id: string }[]>`
        select api.open_proceeding(${caseExec}, 'INVESTIGATION', null, ${REASON}) as id`;
      const [subj] = await s.tx<{ id: string }[]>`
        select api.add_case_subject(${caseExec}, 'Employee Phi (synthetic)', 'EMPLOYEE', null) as id`;
      const [a] = await s.tx<{ id: string }[]>`
        select api.add_allegation(${caseExec}, 'FRAUD', 'Synthetic: allegation against Employee Phi.', ${subj!.id},
          null, null) as id`;
      const [finding] = await s.tx<{ id: string }[]>`
        select api.record_finding(${a!.id}, null, ${p!.id}, 'SUBSTANTIATED', 'Synthetic: finding rationale text.') as id`;
      await s.as("committeeSecretary");
      const [m] = await s.tx<{ id: string }[]>`
        select api.schedule_meeting(${cp!.id}, 'DELIBERATION', 'IN_PERSON', 'Room (synthetic)', null,
          now() + interval '1 day', now() + interval '1 day 1 hour', ${REASON}) as id`;
      const [part] = await s.tx<{ id: string }[]>`
        select id from committee.meeting_participant where meeting_id = ${m!.id} and user_id = ${USERS.grcDeputy}`;
      await s.as("grcDeputy");
      await s.tx`select api.declare_meeting_conflict(${part!.id}, 'NO_CONFLICT', null)`;
      await s.as("committeeSecretary");
      await s.tx`select api.open_meeting(${m!.id}, ${REASON})`;
      await s.tx`select api.record_attendance(${part!.id}, 'PRESENT')`;
      const [pkg] = await s.tx<{ id: string }[]>`
        select api.create_recommendation_package(${cp!.id}, 'PACKAGE') as id`;
      await s.tx`select api.add_recommendation_item(${pkg!.id}, 'CORRECTIVE_ACTION', null, null,
        'Synthetic: tighten the approval controls.', null, null)`;
      await s.tx`select api.submit_package_for_vote(${pkg!.id})`;
      await s.tx`select api.open_package_vote(${m!.id}, ${pkg!.id})`;
      const [vi] = await s.tx<
        { id: string }[]
      >`select id from committee.vote_item where package_id = ${pkg!.id}`;
      await s.as("grcDeputy");
      await s.tx`select api.cast_vote(${vi!.id}, 'APPROVE', null)`;
      await s.as("committeeSecretary");
      await s.tx`select api.close_vote_item(${vi!.id}, null)`;
      await s.tx`select api.record_package_adoption(${pkg!.id})`;
      return { pkg: pkg!.id, finding: finding!.id, caseExec };
    }

    it("T-AMB-070: a restricted legal packet carries only what its approval names; more needs a new approval (AMB-120)", async () => {
      await ownerScenario(async (s) => {
        const r = await restrictedAdopted(s);
        await s.as("grcDirector");
        await s.expectError(
          "CDF_INVALID:finding_ids",
          (tx) =>
            tx`select api.approve_restricted_legal_review(${r.pkg}, ${USERS.legalB}, ${[randomUUID()]}::uuid[],
              null, ${REASON})`,
        );
        // The approval names no finding: the packet may carry the adopted items only.
        await s.tx`select api.approve_restricted_legal_review(${r.pkg}, ${USERS.legalB}, null, null, ${REASON})`;
        await s.expectError(
          "CDF_CONFLICT:APPROVAL_ALREADY_PENDING",
          (tx) =>
            tx`select api.approve_restricted_legal_review(${r.pkg}, ${USERS.legalB}, ${[r.finding]}::uuid[], null,
              ${REASON})`,
        );
        await s.as("committeeSecretary");
        await s.expectError(
          "CDF_CONFLICT:AUTHORITY_APPROVAL_SCOPE_EXCEEDED",
          (tx) =>
            tx`select api.request_legal_review(${r.pkg}, ${USERS.legalB}, ${REASON}, ${[r.finding]}::uuid[], null)`,
        );
        const [req] = await s.tx<{ id: string }[]>`
          select api.request_legal_review(${r.pkg}, ${USERS.legalB}, ${REASON}, null, null) as id`;
        const [k] = await s.tx<{ id: string }[]>`
          select id from decision.packet where legal_review_request_id = ${req!.id}`;
        // Every path: even the table owner cannot add to the packet what the approval does not name.
        await s.asOwner();
        await s.expectError(
          "CDF_CONFLICT:AUTHORITY_APPROVAL_SCOPE_EXCEEDED",
          (tx) =>
            tx`insert into decision.packet_item (packet_id, position, item_kind, source_id, snapshot)
               values (${k!.id}, 99, 'FINDING', ${r.finding}, '{}'::jsonb)`,
        );
        // More material: the secretary cancels, the case authority approves again naming the finding.
        await s.as("committeeSecretary");
        await s.tx`select api.cancel_legal_review_request(${req!.id}, 'Synthetic: Legal needs the finding.')`;
        await s.expectError(
          "CDF_CONFLICT:AUTHORITY_APPROVAL_REQUIRED",
          (tx) =>
            tx`select api.request_legal_review(${r.pkg}, ${USERS.legalB}, ${REASON}, ${[r.finding]}::uuid[], null)`,
        );
        await s.as("grcDirector");
        await s.tx`select api.approve_restricted_legal_review(${r.pkg}, ${USERS.legalB}, ${[r.finding]}::uuid[], null,
          ${REASON})`;
        await s.as("committeeSecretary");
        const [req2] = await s.tx<{ id: string }[]>`
          select api.request_legal_review(${r.pkg}, ${USERS.legalB}, ${REASON}, ${[r.finding]}::uuid[], null) as id`;
        await s.as("legalB");
        const items = await s.tx<{ item_kind: string }[]>`
          select pi.item_kind from decision.packet_item pi join decision.packet k on k.id = pi.packet_id
          where k.legal_review_request_id = ${req2!.id} order by pi.position`;
        expect(items.map((i) => i.item_kind)).toEqual(["RECOMMENDATION_ITEM", "FINDING"]);
      });
    });
  });

  describe("authority rules and decisions (DEC-F13, CON-018)", () => {
    it("T-AMB-079: an adopted item type without an authority rule is not submitted (AMB-135)", async () => {
      await scenario(async (s) => {
        const f = await draftPackage(s, ic, caseB);
        await s.as("committeeSecretary");
        await s.tx`select api.withdraw_recommendation_item(${f.sanction}, ${REASON})`;
        await s.tx`select api.add_recommendation_item(${f.pkg}, 'OTHER', null, null, 'Synthetic: brief the board.',
          null, null)`;
        await voteOnPackage(s, f);
        await s.expectError(
          "CDF_CONFLICT:AUTHORITY_RULE_MISSING",
          (tx) => tx`select api.submit_to_authority(${f.pkg})`,
        );
        // The administrator sees which types have no rule, and that the 0400 setting still differs from the rule.
        await s.expectError("CDF_FORBIDDEN", (tx) => tx`select * from api.authority_rule_coverage()`);
        await s.as("platformAdmin");
        const coverage = await s.tx<
          { item_type: string; authority_types: string[]; coverage: string; setting_disagreement: boolean }[]
        >`select item_type, authority_types, coverage, setting_disagreement from api.authority_rule_coverage()`;
        const byType = Object.fromEntries(coverage.map((c) => [c.item_type, c]));
        expect(byType.OTHER).toEqual({
          item_type: "OTHER",
          authority_types: [],
          coverage: "NO_RULE",
          setting_disagreement: false,
        });
        expect(byType.DISCIPLINARY_SANCTION).toMatchObject({
          authority_types: ["CEO"],
          coverage: "OWNER_DEFAULT",
          setting_disagreement: true,
        });
        expect(byType.CORRECTIVE_ACTION).toMatchObject({
          authority_types: ["CEO"],
          coverage: "SOURCE_REQUIRED",
        });
        expect(coverage).toHaveLength(9);
        await s.tx`select api.set_action_authority_rule('OTHER', 'DELEGATED_EXECUTIVE', now(), 'SOURCE_REQUIRED',
          ${REASON})`;
        await s.as("committeeSecretary");
        await s.tx`select api.submit_to_authority(${f.pkg})`;
        expect(await packageStatus(s, f.pkg)).toMatchObject({ status: "AWAITING_AUTHORITY" });
      });
    });

    it("T-AMB-077: a rule change after submission does not change the authority the round needs (AMB-132)", async () => {
      await scenario(async (s) => {
        const f = await draftPackage(s, ic, caseB);
        await voteOnPackage(s, f);
        const { authorityPacket } = await toAuthority(s, f);
        await s.as("platformAdmin");
        await s.tx`select api.set_action_authority_rule('DISCIPLINARY_SANCTION', 'BOARD', now(), 'SOURCE_REQUIRED',
          ${REASON})`;
        await s.as("committeeSecretary");
        await s.expectError("CDF_CONFLICT:AUTHORITY_TYPE_MISMATCH", () =>
          decideWith(s, f, "BOARD", "APPROVE_AS_RECOMMENDED"),
        );
        const [snap] = await s.tx<{ authority: string; status: string }[]>`
          select snapshot ->> 'required_authority' as authority, snapshot ->> 'authority_rule_source_status' as status
          from decision.packet_item where packet_id = ${authorityPacket} and source_id = ${f.sanction}`;
        expect(snap).toEqual({ authority: "CEO", status: "OWNER_DEFAULT" });
        await decideWith(s, f, "CEO", "APPROVE_AS_RECOMMENDED");
        expect(await packageStatus(s, f.pkg)).toMatchObject({ status: "DECIDED" });
      });
    });

    it("T-AMB-074: a package is not DECIDED while an item lacks its own authority's decision (AMB-126)", async () => {
      await ownerScenario(async (s) => {
        await s.as("platformAdmin");
        await s.tx`select api.set_action_authority_rule('CORRECTIVE_ACTION', 'BOARD', now(), 'SOURCE_REQUIRED',
          ${REASON})`;
        const f = await draftPackage(s, ic, caseB);
        await voteOnPackage(s, f);
        await toAuthority(s, f);
        // The CEO decides the sanction only; partial outcomes may name only the CEO's items.
        await s.expectError("CDF_INVALID:item_outcomes", () =>
          decideWith(s, f, "CEO", "APPROVE_PARTIALLY", {
            items: [
              { item_id: f.sanction, outcome: "APPROVED" },
              { item_id: f.corrective, outcome: "APPROVED" },
            ],
          }),
        );
        await s.expectError("CDF_CONFLICT:AUTHORITY_TYPE_MISMATCH", () =>
          decideWith(s, f, "DELEGATED_EXECUTIVE", "APPROVE_AS_RECOMMENDED"),
        );
        const [ceo] = await decideWith(s, f, "CEO", "APPROVE_AS_RECOMMENDED");
        expect(await packageStatus(s, f.pkg)).toMatchObject({ status: "AWAITING_AUTHORITY" });
        await s.expectError("CDF_CONFLICT:AUTHORITY_ALREADY_DECIDED", () =>
          decideWith(s, f, "CEO", "APPROVE_AS_RECOMMENDED"),
        );
        const [board] = await decideWith(s, f, "BOARD", "APPROVE_AS_RECOMMENDED", {
          source: "BOARD-RES-DEMO-0002",
        });
        expect(await packageStatus(s, f.pkg)).toMatchObject({ status: "DECIDED" });
        const scope = await s.tx<{ decision_id: string; item_id: string; authority_type: string }[]>`
          select decision_id, item_id, authority_type from decision.authority_decision_scope
          where decision_id in (${ceo!.id}, ${board!.id}) order by authority_type collate "C"`;
        expect(scope).toEqual([
          { decision_id: board!.id, item_id: f.corrective, authority_type: "BOARD" },
          { decision_id: ceo!.id, item_id: f.sanction, authority_type: "CEO" },
        ]);
        // The corrective action is approved by the Board's decision (1940 reads it per authority).
        await s.asOwner();
        const [approving] = await s.tx<
          { id: string }[]
        >`select decision.approving_decision(${f.corrective}) as id`;
        expect(approving!.id).toBe(board!.id);
      });
    });

    it("T-AMB-074: joint authorities must both decide, and a disagreement returns the package (AMB-127)", async () => {
      await scenario(async (s) => {
        await s.as("platformAdmin");
        await s.tx`select api.set_action_authority_rule('CORRECTIVE_ACTION', ${["CEO", "BOARD"]}::text[], now(),
          'SOURCE_REQUIRED', ${REASON})`;
        const f = await draftPackage(s, ic, caseB);
        await voteOnPackage(s, f);
        const { authorityPacket } = await toAuthority(s, f);
        const [snap] = await s.tx<{ a: string[] }[]>`
          select array(select jsonb_array_elements_text(snapshot -> 'required_authorities')) as a
          from decision.packet_item where packet_id = ${authorityPacket} and source_id = ${f.corrective}`;
        expect(snap!.a).toEqual(["BOARD", "CEO"]);
        await decideWith(s, f, "CEO", "APPROVE_AS_RECOMMENDED");
        expect(await packageStatus(s, f.pkg)).toMatchObject({ status: "AWAITING_AUTHORITY" });
        await decideWith(s, f, "BOARD", "REJECT", { source: "BOARD-RES-DEMO-0003" });
        expect(await packageStatus(s, f.pkg)).toEqual({ status: "RETURNED_BY_AUTHORITY", round_no: 1 });
      });
    });

    it("T-AMB-076: decided_at may not fall on a day before adoption (AMB-131)", async () => {
      await scenario(async (s) => {
        const f = await draftPackage(s, ic, caseB);
        await voteOnPackage(s, f);
        await toAuthority(s, f);
        await s.expectError(
          "CDF_INVALID:decided_at",
          (tx) =>
            tx`select api.record_authority_decision(${f.pkg}, 'CEO', 'APPROVE_AS_RECOMMENDED', now() - interval '2 days',
              'Chief Executive (synthetic)', 'MEMO-DEMO-0202', null, null)`,
        );
        await decideWith(s, f, "CEO", "APPROVE_AS_RECOMMENDED");
        const [d] = await s.tx<{ same: boolean }[]>`
          select decided_at <= recorded_at as same from decision.authority_decision where package_id = ${f.pkg}`;
        expect(d!.same).toBe(true);
      });
    });

    it("T-AMB-075: an unsigned source needs the secretary's attestation and is flagged; delegation, sources and conditions are recorded (AMB-125, AMB-129, AMB-130, AMB-133)", async () => {
      await scenario(async (s) => {
        const f = await draftPackage(s, ic, caseB);
        await voteOnPackage(s, f);
        await toAuthority(s, f);
        const ATTEST = "Synthetic: I confirm the memo came from the CEO's office.";
        await s.expectError("CDF_INVALID:unsigned_attestation", () =>
          decideWith(s, f, "CEO", "APPROVE_AS_RECOMMENDED", { signature: "UNSIGNED" }),
        );
        await s.expectError("CDF_INVALID:unsigned_attestation", () =>
          decideWith(s, f, "CEO", "APPROVE_AS_RECOMMENDED", { signature: "SIGNED", attestation: ATTEST }),
        );
        await s.expectError("CDF_INVALID:source_signature", () =>
          decideWith(s, f, "CEO", "APPROVE_AS_RECOMMENDED", { signature: "STAMPED" }),
        );
        await s.expectError("CDF_INVALID:additional_source_references", () =>
          decideWith(s, f, "CEO", "APPROVE_AS_RECOMMENDED", { sources: ["MEMO-DEMO-0201"] }),
        );
        await s.expectError("CDF_INVALID:conditions", () =>
          decideWith(s, f, "CEO", "APPROVE_AS_RECOMMENDED", {
            conditions: [{ kind: "PROMISE", text: "Synthetic: an unknown kind." }],
          }),
        );
        await s.expectError("CDF_INVALID:conditions", () =>
          decideWith(s, f, "CEO", "REJECT", {
            conditions: [{ kind: "FREE_TEXT", text: "Synthetic: a condition on a rejection." }],
          }),
        );
        await s.expectError("CDF_INVALID:conditions", () =>
          decideWith(s, f, "CEO", "APPROVE_AS_RECOMMENDED", {
            conditions: [{ kind: "FOLLOW_UP_TASK", text: "Synthetic: elsewhere.", item_id: randomUUID() }],
          }),
        );
        const [d] = await decideWith(s, f, "CEO", "APPROVE_AS_RECOMMENDED", {
          signature: "UNSIGNED",
          attestation: ATTEST,
          delegation: "DOA-DEMO-0001",
          sources: ["EMAIL-DEMO-0001"],
          conditions: [
            { kind: "CORRECTIVE_ACTION", text: "Synthetic: within the quarter.", item_id: f.corrective },
            { kind: "FREE_TEXT", text: "Synthetic: report back to the CEO." },
          ],
        });
        const [row] = await s.tx`
          select primary_source, delegation_reference, source_signature, source_count, condition_count, flags
          from decision.authority_decision_overview where decision_id = ${d!.id}`;
        expect(row).toEqual({
          primary_source: "MEMO-DEMO-0201",
          delegation_reference: "DOA-DEMO-0001",
          source_signature: "UNSIGNED",
          source_count: 2,
          condition_count: 2,
          flags: ["UNSIGNED_SOURCE", "FREE_TEXT_CONDITION", "DELEGATED"],
        });
        const sources = await s.tx`
          select position, reference, is_primary from decision.authority_decision_source
          where decision_id = ${d!.id} order by position`;
        expect(sources).toEqual([
          { position: 1, reference: "MEMO-DEMO-0201", is_primary: true },
          { position: 2, reference: "EMAIL-DEMO-0001", is_primary: false },
        ]);
        // Outsiders see no decision, flag or condition.
        await s.as("committee");
        expect(await s.tx`select decision_id from decision.authority_decision_overview`).toEqual([]);
        expect(await s.tx`select id from decision.authority_decision_condition`).toEqual([]);
      });
    });

    it("AMB-129: a decision recorded without a signature attribute is flagged SIGNATURE_NOT_RECORDED", async () => {
      await scenario(async (s) => {
        const f = await draftPackage(s, ic, caseB);
        await voteOnPackage(s, f);
        await toAuthority(s, f);
        const [d] = await s.tx<{ id: string }[]>`
          select api.record_authority_decision(${f.pkg}, 'CEO', 'APPROVE_AS_RECOMMENDED', now(),
            'Chief Executive (synthetic)', 'MEMO-DEMO-0203', null, null) as id`;
        await s.as("caseManager");
        const [row] = await s.tx<{ flags: string[] }[]>`
          select flags from decision.authority_decision_overview where decision_id = ${d!.id}`;
        expect(row!.flags).toEqual(["SIGNATURE_NOT_RECORDED"]);
      });
    });
  });

  describe("dependencies and exclusivity groups (AMB-100)", () => {
    it("AMB-100: alternatives are flagged; the authority approves at most one; a dependant of a rejected item is flagged", async () => {
      await scenario(async (s) => {
        const f = await draftPackage(s, ic, caseB);
        await authorityRuleFor(s, "GOVERNANCE_REMEDIATION");
        await s.as("committeeSecretary");
        const add = (
          type: string,
          code: string | null,
          text: string | null,
          subjects: string[] | null,
          depends: string[] | null,
          group: string | null,
        ) =>
          s.tx<{ id: string }[]>`
            select api.add_recommendation_item(${f.pkg}, ${type}, ${code}, ${text}, 'Synthetic: recommendation text.',
              ${subjects}::uuid[], ${subjects ? [f.allegation] : null}::uuid[], false, ${depends}::uuid[], ${group}) as id`;
        await s.expectError("CDF_INVALID:depends_on_item_ids", () =>
          add("GOVERNANCE_REMEDIATION", null, null, null, [randomUUID()], null),
        );
        await s.expectError("CDF_INVALID:exclusivity_group", () =>
          add("CORRECTIVE_ACTION", null, null, null, null, "bad group"),
        );
        const [dep] = await add("GOVERNANCE_REMEDIATION", null, null, null, [f.corrective], null);
        const [alt1] = await add(
          "DISCIPLINARY_SANCTION",
          "SUSPENSION",
          null,
          [f.subject],
          null,
          "SIGMA_SANCTION",
        );
        const [alt2] = await add(
          "DISCIPLINARY_SANCTION",
          null,
          "Synthetic: final written warning",
          [f.subject],
          null,
          "SIGMA_SANCTION",
        );
        expect((await flags(s, f.pkg)).sort()).toEqual(
          [
            `${f.sanction}:SANCTION_SOURCE_REQUIRED`,
            `${alt1!.id}:EXCLUSIVITY_CONFLICT`,
            `${alt1!.id}:SANCTION_SOURCE_REQUIRED`,
            `${alt2!.id}:EXCLUSIVITY_CONFLICT`,
            `${alt2!.id}:PROPOSED_UNVERIFIED`,
          ].sort(),
        );
        await s.as("committee");
        await s.expectError("CDF_NOT_FOUND", () => flags(s, f.pkg));
        await voteOnPackage(s, f);
        await toAuthority(s, f);
        const outcomes = (a1: string, a2: string) => [
          { item_id: f.sanction, outcome: "APPROVED" },
          { item_id: f.corrective, outcome: "REJECTED" },
          { item_id: dep!.id, outcome: "APPROVED" },
          { item_id: alt1!.id, outcome: a1 },
          { item_id: alt2!.id, outcome: a2 },
        ];
        await s.expectError("CDF_CONFLICT:EXCLUSIVITY_GROUP_VIOLATION", () =>
          decideWith(s, f, "CEO", "APPROVE_PARTIALLY", { items: outcomes("APPROVED", "APPROVED") }),
        );
        await decideWith(s, f, "CEO", "APPROVE_PARTIALLY", { items: outcomes("APPROVED", "REJECTED") });
        expect(await packageStatus(s, f.pkg)).toMatchObject({ status: "DECIDED" });
        expect(await flags(s, f.pkg)).toContain(`${dep!.id}:DEPENDENCY_NOT_APPROVED`);
      });
    });
  });

  describe("conflict discovered after a vote or decision (AMB-051; DEC-AMB-003, owner, 2026-10-13)", () => {
    const TAINT = "CDF_CONFLICT:TAINTED_BY_CONFLICT";
    /** Someone raises a conflict on the lead's participation; the chair upholds it. Returns the concern. */
    async function upheldOnLead(
      s: Scenario,
      f: PackageFixture,
      raiser: "committeeSecretary" | "legal" = "legal",
    ): Promise<string> {
      await s.as(raiser);
      const [c] = await s.tx<{ id: string }[]>`
        select api.raise_meeting_conflict(${f.meeting.participant.lead!}, 'Synthetic: the lead is related to the subject.') as id`;
      await s.as("committeeChair");
      await s.tx`select api.decide_meeting_conflict(${c!.id}, 'UPHELD', 'Synthetic: the relationship is confirmed.')`;
      return c!.id;
    }
    /** Submits the package and opens its single package vote; returns the vote item. */
    async function openPackageVote(s: Scenario, f: PackageFixture): Promise<string> {
      await s.as("committeeSecretary");
      await s.tx`select api.submit_package_for_vote(${f.pkg})`;
      await s.tx`select api.open_package_vote(${f.meeting.meeting}, ${f.pkg})`;
      const [vi] = await s.tx<{ id: string }[]>`
        select vi.id from committee.vote_item vi
        join decision.recommendation_package p on p.id = vi.package_id and vi.package_round = p.round_no
        where p.id = ${f.pkg}`;
      return vi!.id;
    }
    /** What the tally froze for the vote item, read as the table owner. */
    async function tally(s: OwnerScenario, voteItem: string) {
      await s.asOwner();
      return s.tx<{ user_id: string; choice: string; counted: boolean }[]>`
        select user_id, choice, counted from decision.vote_tally_entry where vote_item_id = ${voteItem}
        order by user_id::text collate "C"`;
    }
    const resolve = (s: Scenario, item: string, resolution: string, reason: string | null = FIRM) =>
      s.tx<{ id: string }[]>`select api.resolve_conflict_taint(${item}, ${resolution}, ${reason}) as id`;
    /** Chair and lead approve, legal rejects: the lead's vote decides. */
    const decisive = (_target: string, voter: UserKey) => (voter === "legal" ? "REJECT" : "APPROVE");
    const tainted = async (s: Scenario, f: PackageFixture) =>
      (await flags(s, f.pkg)).filter((x) => x.endsWith(":TAINTED_BY_CONFLICT")).sort();
    const bothTainted = (f: PackageFixture) =>
      [`${f.sanction}:TAINTED_BY_CONFLICT`, `${f.corrective}:TAINTED_BY_CONFLICT`].sort();

    it("T-AMB-028: a conflict found after a vote or decision taints the item; the database refuses every downstream step until the committee resolves it by RE_VOTE or CONFIRM; CONFIRM needs documented reasoning and a result the conflicted participation could not have changed", async () => {
      await ownerScenario(async (s) => {
        await s.as("platformAdmin");
        await s.tx`select api.grant_role(${USERS.financeEmployee}, 'IMPLEMENTATION_OWNER',
          'Synthetic: implementation owner for the test')`;
        const f = await draftPackage(s, ic, caseB);
        // Chair and lead approve, legal rejects: the committee adopts two to one.
        expect(await voteOnPackage(s, f, decisive)).toBe("ADOPTED");

        // 1. A conflict found after the vote: the lead's participation is upheld as conflicted. Both items, carried by
        //    the one package vote, are TAINTED_BY_CONFLICT.
        await upheldOnLead(s, f);
        await s.as("committeeSecretary");
        expect(await tainted(s, f)).toEqual(bothTainted(f));

        // 2. The next step is refused, through the command and directly at the table, and so is anything that would
        //    read the adopted result as final: submission and an authority decision.
        await s.expectError(
          TAINT,
          (tx) => tx`select api.request_legal_review(${f.pkg}, ${USERS.legalB}, ${REASON}, null, null)`,
        );
        await s.asOwner();
        await s.expectError(
          TAINT,
          (tx) =>
            tx`insert into decision.legal_review_request (package_id, case_id, package_round, basis, assigned_to, reason,
                 requested_by) values (${f.pkg}, ${caseB}, 1, 'RULE', ${USERS.legalB}, ${REASON}, ${USERS.committeeSecretary})`,
        );
        for (const status of ["IN_LEGAL_REVIEW", "AWAITING_AUTHORITY", "DECIDED"]) {
          await s.expectError(
            TAINT,
            (tx) => tx`update decision.recommendation_package set status = ${status} where id = ${f.pkg}`,
          );
        }
        await s.expectError(
          TAINT,
          (tx) =>
            tx`insert into decision.authority_decision (package_id, case_id, package_round, authority_type, outcome,
                 decided_at, decided_by_label, source_document_reference, recorded_by)
               values (${f.pkg}, ${caseB}, 1, 'CEO', 'APPROVE_AS_RECOMMENDED', now(), 'Synthetic',
                 'MEMO-DEMO-0299', ${USERS.committeeSecretary})`,
        );

        // 4. CONFIRM is refused without documented reasoning, and when the conflicted participation could have
        //    changed the result: two to one with the lead, one to one without.
        await s.as("committeeSecretary");
        await s.expectError("CDF_INVALID:reason", () => resolve(s, f.sanction, "CONFIRM", null));
        await s.expectError("CDF_INVALID:reason", () => resolve(s, f.sanction, "CONFIRM", "Too short"));
        await s.expectError("CDF_INVALID:resolution", () => resolve(s, f.sanction, "IGNORE"));
        await s.expectError("CDF_CONFLICT:RESULT_MAY_CHANGE", () => resolve(s, f.sanction, "CONFIRM"));
        expect(await tainted(s, f)).toEqual(bothTainted(f));

        // 3a. RE_VOTE: the package goes back to the committee; the next round votes again on the same target without
        //     the lead, so the tainted result no longer counts.
        await resolve(s, f.sanction, "RE_VOTE");
        expect(await packageStatus(s, f.pkg)).toEqual({ status: "DRAFT", round_no: 1 });
        expect(await tainted(s, f)).toEqual([]);
        expect(await voteOnPackage(s, f, () => "APPROVE", ["committeeChair", "legal"])).toBe("ADOPTED");
        expect(await packageStatus(s, f.pkg)).toEqual({ status: "ADOPTED", round_no: 2 });

        // The authority decides round two.
        await toAuthority(s, f);
        await s.as("committeeSecretary");
        const [d] = await decideWith(s, f, "CEO", "APPROVE_AS_RECOMMENDED");
        expect(await packageStatus(s, f.pkg)).toMatchObject({ status: "DECIDED" });

        // 1. A conflict found after the decision: legal, who voted in round two, declares one in the meeting.
        await s.as("legal");
        await s.tx`select api.declare_meeting_conflict(${f.meeting.participant.legal!}, 'CONFLICT_DECLARED',
          'Synthetic: the member advised the subject.')`;
        await s.as("committeeSecretary");
        expect(await tainted(s, f)).toEqual(bothTainted(f));

        // 2. What reads the decided result as final is refused: opening the corrective action, the decision notice.
        await s.as("caseManager");
        const openAction = (tx: typeof s.tx) =>
          tx`select api.open_corrective_action(${f.corrective}, 'Synthetic: strengthen approval controls',
            'Synthetic: add a second approver to payments above the threshold.', ${USERS.financeEmployee},
            (now() at time zone 'Asia/Riyadh')::date + 30)`;
        const notice = (tx: typeof s.tx) =>
          tx`select api.issue_decision_notice(${f.subject}, ${d!.id}, 'Synthetic: the decision on your case.')`;
        await s.expectError(TAINT, openAction);
        await s.expectError(TAINT, notice);

        // 4. Still no CONFIRM without reasoning.
        await s.as("committeeSecretary");
        await s.expectError("CDF_INVALID:reason", () => resolve(s, f.corrective, "CONFIRM", null));
        // 3b. CONFIRM: two approvals of two eligible; without legal one of one, still APPROVED.
        await resolve(s, f.corrective, "CONFIRM");
        expect(await tainted(s, f)).toEqual([]);
        await s.as("caseManager");
        await openAction(s.tx);
        await notice(s.tx);

        // Both resolutions are kept, with the recount that justified each.
        await s.as("committeeSecretary");
        expect(
          await s.tx`
            select package_round, resolution, conflicted_user_ids, original_result, recount_result, reason
            from decision.conflict_taint_resolution where package_id = ${f.pkg} order by package_round`,
        ).toEqual([
          {
            package_round: 1,
            resolution: "RE_VOTE",
            conflicted_user_ids: [USERS.lead],
            original_result: "APPROVED",
            recount_result: "TIED",
            reason: FIRM,
          },
          {
            package_round: 2,
            resolution: "CONFIRM",
            conflicted_user_ids: [USERS.legal],
            original_result: "APPROVED",
            recount_result: "APPROVED",
            reason: FIRM,
          },
        ]);
      });
    });

    it("T-AMB-028: a conflict upheld before adoption blocks adoption; one found during legal review blocks the opinion", async () => {
      await ownerScenario(async (s) => {
        const f = await draftPackage(s, ic, caseB);
        await closePackageVotes(s, f);
        await upheldOnLead(s, f);
        await s.as("committeeSecretary");
        expect(await tainted(s, f)).toEqual(bothTainted(f));
        await s.expectError(TAINT, (tx) => tx`select api.record_package_adoption(${f.pkg})`);
        // The result could not change without the lead (two approvals of two eligible): confirmed, it is adopted.
        await resolve(s, f.sanction, "CONFIRM");
        await s.tx`select api.record_package_adoption(${f.pkg})`;
        const { request } = await requestLegalReview(s, f);
        // During legal review: the legal member declares a conflict; the opinion is refused on every path.
        await s.as("legal");
        await s.tx`select api.declare_meeting_conflict(${f.meeting.participant.legal!}, 'CONFLICT_DECLARED',
          'Synthetic: the member advised the subject.')`;
        await s.as("legalB");
        await s.expectError(TAINT, (tx) => tx`select api.give_legal_opinion(${request}, 'CONCURS', null)`);
        await s.asOwner();
        await s.expectError(
          TAINT,
          (tx) =>
            tx`update decision.legal_review_request set status = 'OPINION_GIVEN', opinion = 'CONCURS', opinion_at = now()
               where id = ${request}`,
        );
      });
    });

    it("T-AMB-028: a conflict found while the package is with the authority allows only a return", async () => {
      await scenario(async (s) => {
        const f = await draftPackage(s, ic, caseB);
        await voteOnPackage(s, f);
        await toAuthority(s, f);
        await upheldOnLead(s, f);
        await s.as("committeeSecretary");
        await s.expectError(TAINT, () => decideWith(s, f, "CEO", "APPROVE_AS_RECOMMENDED"));
        await s.expectError("CDF_CONFLICT:PACKAGE_WITH_AUTHORITY", () => resolve(s, f.sanction, "RE_VOTE"));
        await decideWith(s, f, "CEO", "RETURN_TO_COMMITTEE");
        expect(await packageStatus(s, f.pkg)).toEqual({ status: "RETURNED_BY_AUTHORITY", round_no: 1 });
      });
    });

    it("T-AMB-028: CONFIRM is recorded once per taint, read like the item, audited with codes only and append-only", async () => {
      await ownerScenario(async (s) => {
        const f = await draftPackage(s, ic, caseB);
        expect(await voteOnPackage(s, f)).toBe("ADOPTED");
        await upheldOnLead(s, f);
        await s.as("committeeSecretary");
        const [r] = await resolve(s, f.corrective, "CONFIRM");
        // The package vote carried both items: one resolution clears both.
        expect(await tainted(s, f)).toEqual([]);
        await s.expectError("CDF_CONFLICT:NOT_TAINTED", () => resolve(s, f.sanction, "CONFIRM"));
        const [row] = await s.tx`
          select resolution, conflicted_user_ids, original_result, recount_result, package_round, reason
          from decision.conflict_taint_resolution where id = ${r!.id}`;
        expect(row).toEqual({
          resolution: "CONFIRM",
          conflicted_user_ids: [USERS.lead],
          original_result: "APPROVED",
          recount_result: "APPROVED",
          package_round: 1,
          reason: FIRM,
        });
        // Read like the item: the case team sees it, an outsider does not; the ledger has codes, not the reason.
        await s.as("caseManager");
        expect(await s.tx`select id from decision.conflict_taint_resolution`).toHaveLength(1);
        await s.as("committee");
        expect(await s.tx`select id from decision.conflict_taint_resolution`).toEqual([]);
        await s.as("dpo");
        const events = await s.tx<{ metadata: Record<string, unknown>; reason: string | null }[]>`
          select metadata, reason from audit.audit_event where action = 'CONFLICT_TAINT_RESOLVED'`;
        expect(events).toHaveLength(1);
        expect(events[0]!.metadata).toMatchObject({
          resolution: "CONFIRM",
          conflicted: 1,
          recount_result: "APPROVED",
        });
        expect(JSON.stringify(events)).not.toContain(FIRM);
        expect(JSON.stringify(events)).not.toContain(USERS.lead);
        // The package goes on.
        await toAuthority(s, f);
        // Append-only, even for the table owner.
        await s.asOwner();
        await s.expectError(
          "decision.conflict_taint_resolution is append-only",
          (tx) => tx`update decision.conflict_taint_resolution set resolution = 'RE_VOTE'`,
        );
        await s.expectError(
          "decision.conflict_taint_resolution is append-only",
          (tx) => tx`delete from decision.conflict_taint_resolution`,
        );
      });
    });

    it("T-AMB-028: the conflicted member, whoever raised the conflict, other members and outsiders cannot resolve it", async () => {
      await scenario(async (s) => {
        const f = await draftPackage(s, ic, caseB);
        await voteOnPackage(s, f);
        // The secretary raises it: then the secretary does not record the committee's resolution.
        await upheldOnLead(s, f, "committeeSecretary");
        await s.as("committeeSecretary");
        await s.expectError("CDF_FORBIDDEN", () => resolve(s, f.sanction, "CONFIRM"));
        await s.as("lead"); // the conflicted member no longer sees the package (W1)
        await s.expectError("CDF_NOT_FOUND", () => resolve(s, f.sanction, "CONFIRM"));
        for (const u of ["committeeChair", "legal"] as const) {
          await s.as(u);
          await s.expectError("CDF_FORBIDDEN", () => resolve(s, f.sanction, "CONFIRM"));
        }
        for (const u of ["committee", "platformAdmin", "investigatorA", "legalB"] as const) {
          await s.as(u);
          await s.expectError("CDF_NOT_FOUND", () => resolve(s, f.sanction, "CONFIRM"));
          await s.expectError("CDF_NOT_FOUND", () => resolve(s, randomUUID(), "CONFIRM"));
        }
        // Still blocked downstream.
        await s.as("committeeSecretary");
        await s.expectError(
          TAINT,
          (tx) => tx`select api.request_legal_review(${f.pkg}, ${USERS.legalB}, ${REASON}, null, null)`,
        );
        expect(await packageStatus(s, f.pkg)).toEqual({ status: "ADOPTED", round_no: 1 });
      });
    });

    it("T-AMB-028: a reversal of the upheld conflict does not clear the taint; the committee still resolves it", async () => {
      await ownerScenario(async (s) => {
        const f = await draftPackage(s, ic, caseB);
        expect(await voteOnPackage(s, f, decisive)).toBe("ADOPTED");
        const concern = await upheldOnLead(s, f);
        await s.as("committeeSecretary");
        expect(await tainted(s, f)).toEqual(bothTainted(f));
        // No deputy chair is seated, so the next decider after the chair is the committee's conflict authority.
        await s.as("platformAdmin");
        await s.tx`select api.appoint_conflict_authority(${ic}, ${USERS.complianceManager}, now(), null, 'DEMO-CA-28',
          'SOURCE_REQUIRED', ${REASON})`;
        await s.as("complianceManager");
        await s.tx`select api.reverse_meeting_conflict_determination(${concern},
          'Synthetic: the link was misread; no conflict.')`;
        // DEC-AMB-010 is prospective: the lead no longer counts as conflicted for the proceeding's later work ...
        await s.asOwner();
        expect(
          await s.tx`select authz.has_meeting_conflict(${USERS.lead}, ${f.meeting.committeeProceeding}) as conflicted`,
        ).toEqual([{ conflicted: false }]);
        // ... but the vote taken while the conflict stood stays tainted, and every downstream step stays refused.
        await s.as("committeeSecretary");
        expect(await tainted(s, f)).toEqual(bothTainted(f));
        await s.expectError(
          TAINT,
          (tx) => tx`select api.request_legal_review(${f.pkg}, ${USERS.legalB}, ${REASON}, null, null)`,
        );
        // Only the committee clears it: the lead's vote decided, so CONFIRM is refused and the vote is taken again.
        await s.expectError("CDF_CONFLICT:RESULT_MAY_CHANGE", () => resolve(s, f.sanction, "CONFIRM"));
        await resolve(s, f.sanction, "RE_VOTE");
        expect(await tainted(s, f)).toEqual([]);
        expect(await packageStatus(s, f.pkg)).toEqual({ status: "DRAFT", round_no: 1 });
      });
    });

    it("T-AMB-028: the recount follows the tally: the alternate who voted counts with their last choice, the member they replaced does not", async () => {
      await ownerScenario(async (s) => {
        // The committee user holds an alternate seat; the lead declares a conflict before the vote and is replaced.
        await seat(s, ic, [["committee", "ALTERNATE_MEMBER"]]);
        const f = await draftPackage(s, ic, caseB);
        const alternate = f.meeting.participant.committee!;
        await s.as("committee");
        await s.tx`select api.declare_meeting_conflict(${alternate}, 'NO_CONFLICT', null)`;
        await s.as("committeeSecretary");
        await s.tx`select api.record_attendance(${alternate}, 'PRESENT')`;
        await s.as("lead");
        await s.tx`select api.declare_meeting_conflict(${f.meeting.participant.lead!}, 'CONFLICT_DECLARED',
          'Synthetic: the lead is related to the subject.')`;
        await s.as("committeeSecretary");
        await s.tx`select api.activate_alternate_member(${alternate}, ${f.meeting.participant.lead!},
          'Synthetic: the member is conflicted today.')`;

        // Chair approves, legal rejects; the alternate rejects, then revises to approve: two to one.
        const vi = await openPackageVote(s, f);
        await s.as("committeeChair");
        await s.tx`select api.cast_vote(${vi}, 'APPROVE', null)`;
        await s.as("legal");
        await s.tx`select api.cast_vote(${vi}, 'REJECT', null)`;
        await s.as("committee");
        await s.tx`select api.cast_vote(${vi}, 'REJECT', null)`;
        await s.tx`select api.revise_vote(${vi}, 'APPROVE', null)`;
        await s.as("committeeSecretary");
        await s.tx`select api.close_vote_item(${vi}, null)`;
        expect(await s.tx`select api.record_package_adoption(${f.pkg}) as status`).toEqual([
          { status: "ADOPTED" },
        ]);
        // The lead was conflicted before the vote and cast none: nothing is tainted.
        expect(await tainted(s, f)).toEqual([]);
        expect(await tally(s, vi)).toEqual(
          [
            { user_id: USERS.committeeChair, choice: "APPROVE", counted: true },
            { user_id: USERS.legal, choice: "REJECT", counted: true },
            { user_id: USERS.committee, choice: "APPROVE", counted: true },
          ].sort((a, b) => (a.user_id < b.user_id ? -1 : 1)),
        );

        // The alternate's conflict comes to light after the vote. Without their last choice (an approval, not the
        // rejection they first cast) it is one to one: the result may change.
        await s.as("committee");
        await s.tx`select api.declare_meeting_conflict(${alternate}, 'CONFLICT_DECLARED',
          'Synthetic: the alternate advised the subject.')`;
        await s.as("committeeSecretary");
        expect(await tainted(s, f)).toEqual(bothTainted(f));
        await s.asOwner();
        expect(await s.tx`select decision.recount_without(${vi}, ${[USERS.committee]}::uuid[]) as r`).toEqual(
          [{ r: "TIED" }],
        );
        await s.as("committeeSecretary");
        await s.expectError("CDF_CONFLICT:RESULT_MAY_CHANGE", () => resolve(s, f.sanction, "CONFIRM"));
        await resolve(s, f.sanction, "RE_VOTE");
        expect(await tainted(s, f)).toEqual([]);
      });
    });

    it("T-AMB-028: a vote that stopped counting before the close still taints (fail safe); CONFIRM holds because the tally never counted it", async () => {
      await ownerScenario(async (s) => {
        const f = await draftPackage(s, ic, caseB);
        const vi = await openPackageVote(s, f);
        await s.as("committeeChair");
        await s.tx`select api.cast_vote(${vi}, 'APPROVE', null)`;
        await s.as("legal");
        await s.tx`select api.cast_vote(${vi}, 'APPROVE', null)`;
        // The lead votes, then declares a conflict before the close: the vote stops counting.
        await s.as("lead");
        await s.tx`select api.cast_vote(${vi}, 'REJECT', null)`;
        await s.tx`select api.declare_meeting_conflict(${f.meeting.participant.lead!}, 'CONFLICT_DECLARED',
          'Synthetic: the lead is related to the subject.')`;
        await s.as("committeeSecretary");
        await s.tx`select api.close_vote_item(${vi}, null)`;
        const [closed] = await s.tx<{ result: string; reject_count: number; excluded_count: number }[]>`
          select result, reject_count, excluded_count from committee.vote_item where id = ${vi}`;
        expect(closed).toEqual({ result: "APPROVED", reject_count: 0, excluded_count: 1 });
        expect((await tally(s, vi)).find((e) => e.user_id === USERS.lead)).toEqual({
          user_id: USERS.lead,
          choice: "REJECT",
          counted: false,
        });
        // The lead took part, so the result is tainted and not adopted; without a vote the tally never counted, it
        // stands, so the committee may confirm it.
        await s.as("committeeSecretary");
        expect(await tainted(s, f)).toEqual(bothTainted(f));
        await s.expectError(TAINT, (tx) => tx`select api.record_package_adoption(${f.pkg})`);
        const [r] = await resolve(s, f.sanction, "CONFIRM");
        const [row] = await s.tx`
          select original_result, recount_result from decision.conflict_taint_resolution where id = ${r!.id}`;
        expect(row).toEqual({ original_result: "APPROVED", recount_result: "APPROVED" });
        expect(await tainted(s, f)).toEqual([]);
        expect(await s.tx`select api.record_package_adoption(${f.pkg}) as status`).toEqual([
          { status: "ADOPTED" },
        ]);
      });
    });

    it("T-AMB-028: nothing to resolve without a conflict, and only in an open meeting of the proceeding", async () => {
      await scenario(async (s) => {
        const f = await draftPackage(s, ic, caseB);
        await voteOnPackage(s, f);
        await s.as("committeeSecretary");
        await s.expectError("CDF_CONFLICT:NOT_TAINTED", () => resolve(s, f.sanction, "CONFIRM"));
        await upheldOnLead(s, f);
        await s.as("committeeSecretary");
        await s.tx`select api.close_meeting(${f.meeting.meeting}, ${REASON})`;
        await s.expectError("CDF_CONFLICT:MEETING_NOT_OPEN", () => resolve(s, f.sanction, "CONFIRM"));
      });
    });
  });
});
