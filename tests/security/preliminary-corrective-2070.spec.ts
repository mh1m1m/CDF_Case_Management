// Rebase PR-B, migration 2070 (ADR-043): a corrective action from preliminary review (DEC-F41, AMB-021, gap P11-G3).
// The preparer of a recommendation that keeps the matter with Compliance (NO_ACTION, NOT_SERIOUS, NOT_SUBSTANTIATED)
// proposes corrective actions of the types PRELIMINARY_CORRECTIVE_ACTION_TYPES permits (SOURCE_REQUIRED: none), before
// the review; the approval needs each type's authority rule (DEC-F13) and snapshots it; a corrective-action manager who
// did not propose it records each required authority's decision from its source document; an approved proposal opens
// corrective actions as an approved package item does (ADR-033); the case does not close while a proposal waits for its
// authority or its actions are not done. Every step runs through the api.* commands as `authenticated`; the owner
// connection sets the migration-managed setting (rolled back), reads rows and probes the table guards.
import { beforeAll, describe, expect, it } from "vitest";
import { USERS, caseId, ownerScenario, type OwnerScenario, type Scenario, type UserKey } from "../support/db";
import { authorityRuleFor } from "../support/decision";
import { RATIONALE as CLOSURE_RATIONALE } from "../support/closure";
import { setPreliminaryCorrectiveTypes } from "../support/preliminary";

const RATIONALE = "Synthetic: preliminary review rationale for the 2070 tests.";
const SUMMARY = "Synthetic: add a second approver to small purchases.";
const TITLE = "Synthetic: second approver";
const DESCRIPTION = "Synthetic: add a second approver to purchases below the threshold.";
const MEMO = "MEMO-DEMO-2070";
const LABEL = "Chief Executive (synthetic)";
const REASON = "Synthetic: authority reason for the 2070 tests.";
const EVIDENCE = "SOP-DEMO-2070 rev 1";

let caseA: string, caseB: string;
beforeAll(async () => {
  [caseA, caseB] = await Promise.all([caseId("0001"), caseId("0002")]);
});

const setTypes = setPreliminaryCorrectiveTypes;

async function prepare(s: Scenario, user: UserKey, id: string, outcome = "NOT_SERIOUS"): Promise<string> {
  await s.as(user);
  const [r] = await s.tx<{ id: string }[]>`
    select api.prepare_preliminary_recommendation(${id}, ${outcome}, ${RATIONALE}) as id`;
  return r!.id;
}
const propose = (
  tx: Scenario["tx"],
  rec: string,
  type: string | null = "CORRECTIVE_ACTION",
  summary = SUMMARY,
) =>
  tx<{ id: string }[]>`select api.propose_preliminary_corrective_action(${rec}, ${type}, ${summary}) as id`;
async function proposeAs(
  s: Scenario,
  user: UserKey,
  rec: string,
  type = "CORRECTIVE_ACTION",
): Promise<string> {
  await s.as(user);
  const [r] = await propose(s.tx, rec, type);
  return r!.id;
}
async function endorse(s: Scenario, rec: string): Promise<void> {
  await s.as("grcDirector");
  await s.tx`select api.review_preliminary_recommendation(${rec}, 'ENDORSE', null, null)`;
}
const approve = (tx: Scenario["tx"], rec: string) =>
  tx`select api.approve_preliminary_recommendation(${rec}, 'APPROVE', null, null)`;
const record = (
  tx: Scenario["tx"],
  proposal: string,
  authority: string | null = "CEO",
  outcome: string | null = "APPROVED",
  decidedAt: string | null = null,
  source: string | null = MEMO,
  label: string | null = LABEL,
) =>
  tx<{ id: string }[]>`
    select api.record_preliminary_authority_decision(${proposal}, ${authority}, ${outcome},
      coalesce(${decidedAt}::timestamptz, now()), ${label}, ${source}, ${REASON}) as id`;
const openAction = (tx: Scenario["tx"], proposal: string, owner: string | null) =>
  tx<{ id: string }[]>`
    select api.open_preliminary_corrective_action(${proposal}, ${TITLE}, ${DESCRIPTION}, ${owner},
      (now() at time zone 'Asia/Riyadh')::date + 30) as id`;

interface Authority {
  authority_type: string;
  rule_source_status: string;
  decision: { outcome: string; source_document_reference: string; reason: string | null } | null;
  may_record: boolean;
}
interface Proposal {
  proposal_id: string;
  sequence_no: number;
  action_type: string;
  summary: string;
  state: string;
  authorities: Authority[] | null;
  actions: { action_id: string; sequence_no: number; status: string }[] | null;
  may_open_action: boolean;
}
interface View {
  status: string;
  recommended_outcome: string;
  outcome_eligible: boolean;
  permitted_action_types: string[];
  may_propose: boolean;
  proposals: Proposal[];
}
async function view(s: Scenario, rec: string): Promise<View> {
  const [r] = await s.tx<{ v: View }[]>`select api.preliminary_corrective_view(${rec}) as v`;
  return r!.v;
}
async function recStatus(s: OwnerScenario, rec: string): Promise<string> {
  await s.asOwner();
  const [r] = await s.tx<
    { status: string }[]
  >`select status from case_mgmt.preliminary_recommendation where id = ${rec}`;
  return r!.status;
}
async function ledger(s: OwnerScenario, action: string, id: string) {
  await s.asOwner();
  return s.tx<{ actor_id: string; reason: string | null; metadata: Record<string, unknown> }[]>`
    select actor_id, reason, metadata from audit.audit_event where action = ${action} and object_id = ${id} order by seq`;
}
/** The platform administrator gives `user` the Implementation Owner role (audited, rolled back with the test). */
async function implementationOwner(s: Scenario, user: UserKey): Promise<void> {
  await s.as("platformAdmin");
  await s.tx`select api.grant_role(${USERS[user]}, 'IMPLEMENTATION_OWNER', 'Synthetic: implementation owner for the test')`;
}

/** Case B: investigatorB's NOT_SERIOUS recommendation with one CORRECTIVE_ACTION proposal, endorsed by the GRC Director
 *  and approved by the GRC Sector Head, under a synthetic rule and the CEO authority rule (a SOURCE_REQUIRED fixture). */
async function approvedProposal(s: OwnerScenario): Promise<{ rec: string; proposal: string }> {
  await setTypes(s, "CORRECTIVE_ACTION");
  await authorityRuleFor(s, "CORRECTIVE_ACTION");
  const rec = await prepare(s, "investigatorB", caseB);
  const proposal = await proposeAs(s, "investigatorB", rec);
  await endorse(s, rec);
  await s.as("grcSectorHead");
  await approve(s.tx, rec);
  return { rec, proposal };
}

describe("the rule (DEC-F41, AMB-021): configured, empty by default", () => {
  it("AMB-021: nothing is proposed while PRELIMINARY_CORRECTIVE_ACTION_TYPES is SOURCE_REQUIRED; only a permitted type is", async () => {
    await ownerScenario(async (s) => {
      await s.asOwner();
      expect(
        await s.tx`select value, status from config.setting where key = 'PRELIMINARY_CORRECTIVE_ACTION_TYPES'`,
      ).toEqual([{ value: null, status: "SOURCE_REQUIRED" }]);
      const rec = await prepare(s, "investigatorB", caseB);
      let v = await view(s, rec);
      expect(v).toMatchObject({
        outcome_eligible: true,
        permitted_action_types: [],
        may_propose: false,
        proposals: [],
      });
      for (const type of ["CORRECTIVE_ACTION", "GOVERNANCE_REMEDIATION"]) {
        await s.expectError("CDF_CONFLICT:PRELIMINARY_CORRECTIVE_ACTION_NOT_PERMITTED", (tx) =>
          propose(tx, rec, type),
        );
      }

      await setTypes(s, "GOVERNANCE_REMEDIATION");
      await s.as("investigatorB");
      await s.expectError("CDF_CONFLICT:PRELIMINARY_CORRECTIVE_ACTION_NOT_PERMITTED", (tx) =>
        propose(tx, rec),
      );
      await s.expectError("CDF_INVALID:action_type", (tx) => propose(tx, rec, "DISCIPLINARY_SANCTION"));
      await s.expectError("CDF_INVALID:action_type", (tx) => propose(tx, rec, null));
      await s.expectError("CDF_INVALID:summary", (tx) => propose(tx, rec, "GOVERNANCE_REMEDIATION", "short"));
      v = await view(s, rec);
      expect(v).toMatchObject({ permitted_action_types: ["GOVERNANCE_REMEDIATION"], may_propose: true });
      const first = await proposeAs(s, "investigatorB", rec, "GOVERNANCE_REMEDIATION");

      // A value naming nothing valid permits nothing (fail closed); whitespace around valid names is ignored.
      await setTypes(s, "DISCIPLINARY_SANCTION, corrective_action,BOTH");
      await s.as("investigatorB");
      expect((await view(s, rec)).may_propose).toBe(false);
      await s.expectError("CDF_CONFLICT:PRELIMINARY_CORRECTIVE_ACTION_NOT_PERMITTED", (tx) =>
        propose(tx, rec, "GOVERNANCE_REMEDIATION"),
      );
      await setTypes(s, " GOVERNANCE_REMEDIATION , CORRECTIVE_ACTION ");
      await s.as("investigatorB");
      expect((await view(s, rec)).permitted_action_types).toEqual([
        "CORRECTIVE_ACTION",
        "GOVERNANCE_REMEDIATION",
      ]);
      const second = await proposeAs(s, "investigatorB", rec);
      expect(
        (await view(s, rec)).proposals.map((p) => [
          p.proposal_id,
          p.sequence_no,
          p.action_type,
          p.summary,
          p.state,
        ]),
      ).toEqual([
        [first, 1, "GOVERNANCE_REMEDIATION", SUMMARY, "PROPOSED"],
        [second, 2, "CORRECTIVE_ACTION", SUMMARY, "PROPOSED"],
      ]);

      // No write path but the command; the event carries ids and codes, never the summary.
      await s.expectError(
        "permission denied",
        (
          tx,
        ) => tx`insert into case_mgmt.preliminary_corrective_proposal (case_id, recommendation_id, sequence_no,
                     action_type, summary, proposed_by)
                   values (${caseB}, ${rec}, 3, 'CORRECTIVE_ACTION', ${SUMMARY}, ${USERS.investigatorB})`,
      );
      expect(await ledger(s, "PRELIMINARY_CORRECTIVE_ACTION_PROPOSED", first)).toEqual([
        {
          actor_id: USERS.investigatorB,
          reason: null,
          metadata: {
            recommendation_id: rec,
            version_no: 1,
            sequence_no: 1,
            action_type: "GOVERNANCE_REMEDIATION",
          },
        },
      ]);
    });
  });

  it("only on an outcome that keeps the matter with Compliance: NO_ACTION, NOT_SERIOUS, NOT_SUBSTANTIATED", async () => {
    await ownerScenario(async (s) => {
      await setTypes(s, "CORRECTIVE_ACTION");
      const eligible = ["NO_ACTION", "NOT_SERIOUS", "NOT_SUBSTANTIATED"];
      for (const outcome of [
        "INVESTIGATION_WARRANTED",
        "REFERRED_TO_COMMITTEE",
        "OUT_OF_SCOPE",
        "DUPLICATE",
        "TRANSFERRED",
        "NON_PROCESSABLE",
        "CHANNEL_ABUSE",
        ...eligible,
      ]) {
        const rec = await prepare(s, "investigatorB", caseB, outcome);
        const v = await view(s, rec);
        expect([outcome, v.outcome_eligible, v.may_propose]).toEqual([
          outcome,
          eligible.includes(outcome),
          eligible.includes(outcome),
        ]);
        if (eligible.includes(outcome)) {
          await proposeAs(s, "investigatorB", rec);
        } else {
          await s.expectError("CDF_CONFLICT:OUTCOME_NOT_ELIGIBLE_FOR_CORRECTIVE_ACTION", (tx) =>
            propose(tx, rec),
          );
        }
        // The review returns it, so the next version can be prepared; a returned version's proposals lapse.
        await s.as("grcDirector");
        await s.tx`select api.review_preliminary_recommendation(${rec}, 'RETURN', array['RECOMMENDATION_INCOMPLETE'], null)`;
        await s.as("investigatorB");
        expect((await view(s, rec)).proposals.map((p) => p.state)).toEqual(
          eligible.includes(outcome) ? ["LAPSED"] : [],
        );
        await s.expectError("CDF_CONFLICT:RECOMMENDATION_NOT_OPEN_FOR_PROPOSALS", (tx) => propose(tx, rec));
      }
    });
  });

  it("only the preparer proposes, and only before the review: the review and the approval cover every proposal", async () => {
    await ownerScenario(async (s) => {
      await setTypes(s, "CORRECTIVE_ACTION");
      await authorityRuleFor(s, "CORRECTIVE_ACTION");
      const rec = await prepare(s, "investigatorB", caseB);
      for (const [user, code] of [
        ["investigatorA", "CDF_NOT_FOUND"],
        ["lead", "CDF_NOT_FOUND"],
        ["grcSectorHead", "CDF_NOT_FOUND"],
        ["grcDeputy", "CDF_FORBIDDEN"],
        ["grcDirector", "CDF_FORBIDDEN"],
        ["caseManager", "CDF_FORBIDDEN"],
      ] as [UserKey, string][]) {
        await s.as(user);
        await s.expectError(code, (tx) => propose(tx, rec));
        if (code === "CDF_FORBIDDEN") expect((await view(s, rec)).may_propose, user).toBe(false);
      }
      await proposeAs(s, "investigatorB", rec);

      // The table refuses a proposal by anyone but the preparer, or on another case, whatever the path.
      await s.asOwner();
      for (const [caseRef, by] of [
        [caseB, USERS.grcDeputy],
        [caseA, USERS.investigatorB],
      ]) {
        await s.expectError(
          "CDF_INVALID:recommendation_id",
          (
            tx,
          ) => tx`insert into case_mgmt.preliminary_corrective_proposal (case_id, recommendation_id, sequence_no,
                       action_type, summary, proposed_by)
                     values (${caseRef!}, ${rec}, 9, 'CORRECTIVE_ACTION', ${SUMMARY}, ${by!})`,
        );
      }

      // Once endorsed, no proposal is added: not through the command, not on the table.
      await endorse(s, rec);
      await s.as("investigatorB");
      expect((await view(s, rec)).may_propose).toBe(false);
      await s.expectError("CDF_CONFLICT:RECOMMENDATION_NOT_OPEN_FOR_PROPOSALS", (tx) => propose(tx, rec));
      await s.asOwner();
      await s.expectError(
        "CDF_CONFLICT:RECOMMENDATION_NOT_OPEN_FOR_PROPOSALS",
        (
          tx,
        ) => tx`insert into case_mgmt.preliminary_corrective_proposal (case_id, recommendation_id, sequence_no,
                     action_type, summary, proposed_by)
                   values (${caseB}, ${rec}, 9, 'CORRECTIVE_ACTION', ${SUMMARY}, ${USERS.investigatorB})`,
      );
      await s.as("grcSectorHead");
      await approve(s.tx, rec);

      // A GRC Director's own recommendation skips the review (Q15): proposals until it is approved, then none.
      const own = await prepare(s, "grcDirector", caseB, "NO_ACTION");
      await proposeAs(s, "grcDirector", own);
      await proposeAs(s, "grcDirector", own);
      await s.as("grcSectorHead");
      await approve(s.tx, own);
      await s.as("grcDirector");
      await s.expectError("CDF_CONFLICT:RECOMMENDATION_NOT_OPEN_FOR_PROPOSALS", (tx) => propose(tx, own));

      // Proposals are append-only.
      await s.asOwner();
      await s.expectError(
        "case_mgmt.preliminary_corrective_proposal is append-only",
        (tx) =>
          tx`update case_mgmt.preliminary_corrective_proposal set summary = ${RATIONALE} where recommendation_id = ${rec}`,
      );
      await s.expectError(
        "case_mgmt.preliminary_corrective_proposal is append-only",
        (tx) => tx`delete from case_mgmt.preliminary_corrective_proposal where recommendation_id = ${rec}`,
      );
    });
  });
});

describe("the authority follows the type (DEC-F41, DEC-F13)", () => {
  it("approval needs each proposal's type to be permitted still and to have an authority rule; the requirements snapshot it", async () => {
    await ownerScenario(async (s) => {
      await setTypes(s, "CORRECTIVE_ACTION,GOVERNANCE_REMEDIATION");
      const rec = await prepare(s, "investigatorB", caseB);
      const corrective = await proposeAs(s, "investigatorB", rec);
      const remediation = await proposeAs(s, "investigatorB", rec, "GOVERNANCE_REMEDIATION");
      await endorse(s, rec);

      // No rule for the type: the approval is refused whole (fail closed, as a package's submission).
      await s.as("grcSectorHead");
      await s.expectError("CDF_CONFLICT:AUTHORITY_RULE_MISSING", (tx) => approve(tx, rec));
      await authorityRuleFor(s, "CORRECTIVE_ACTION");
      await s.as("grcSectorHead");
      await s.expectError("CDF_CONFLICT:AUTHORITY_RULE_MISSING", (tx) => approve(tx, rec));
      // Joint authorities for the remediation.
      await s.as("platformAdmin");
      await s.tx`select api.set_action_authority_rule('GOVERNANCE_REMEDIATION', array['CEO', 'BOARD'], now(),
        'SOURCE_REQUIRED', 'Synthetic: test fixture joint rule.')`;
      // A type the rule no longer permits refuses the approval too.
      await setTypes(s, "CORRECTIVE_ACTION");
      await s.as("grcSectorHead");
      await s.expectError("CDF_CONFLICT:PRELIMINARY_CORRECTIVE_ACTION_NOT_PERMITTED", (tx) =>
        approve(tx, rec),
      );
      expect(await recStatus(s, rec)).toBe("AWAITING_APPROVAL");

      await setTypes(s, "CORRECTIVE_ACTION,GOVERNANCE_REMEDIATION");
      await s.as("grcSectorHead");
      await approve(s.tx, rec);
      await s.asOwner();
      const rows = await s.tx<
        { proposal_id: string; authority_type: string; rule_source_status: string; rule: string }[]
      >`
        select q.proposal_id, q.authority_type, q.rule_source_status, r.item_type as rule
        from decision.preliminary_authority_requirement q join decision.action_authority_rule r on r.id = q.rule_id
        where q.case_id = ${caseB} order by q.proposal_id = ${corrective} desc, q.authority_type collate "C"`;
      expect(rows).toEqual([
        {
          proposal_id: corrective,
          authority_type: "CEO",
          rule_source_status: "SOURCE_REQUIRED",
          rule: "CORRECTIVE_ACTION",
        },
        {
          proposal_id: remediation,
          authority_type: "BOARD",
          rule_source_status: "SOURCE_REQUIRED",
          rule: "GOVERNANCE_REMEDIATION",
        },
        {
          proposal_id: remediation,
          authority_type: "CEO",
          rule_source_status: "SOURCE_REQUIRED",
          rule: "GOVERNANCE_REMEDIATION",
        },
      ]);

      // The table takes no requirement that is not the rule's, and none for a proposal not yet approved.
      await s.expectError(
        "CDF_INVALID:preliminary_authority_requirement",
        (
          tx,
        ) => tx`insert into decision.preliminary_authority_requirement (proposal_id, authority_type, case_id, rule_id,
                     rule_source_status)
                   select ${corrective}, 'OTHER', ${caseB}, rule_id, rule_source_status
                   from decision.preliminary_authority_requirement where proposal_id = ${corrective}`,
      );
      const next = await prepare(s, "investigatorB", caseB, "NO_ACTION");
      const pending = await proposeAs(s, "investigatorB", next);
      await s.asOwner();
      await s.expectError(
        "CDF_INVALID:preliminary_authority_requirement",
        (
          tx,
        ) => tx`insert into decision.preliminary_authority_requirement (proposal_id, authority_type, case_id, rule_id,
                     rule_source_status)
                   select ${pending}, authority_type, ${caseB}, rule_id, rule_source_status
                   from decision.preliminary_authority_requirement where proposal_id = ${corrective}`,
      );
      await s.expectError(
        "decision.preliminary_authority_requirement is append-only",
        (tx) => tx`delete from decision.preliminary_authority_requirement where proposal_id = ${corrective}`,
      );

      // Both remediation authorities must approve; one rejection rejects it.
      await s.as("caseManager");
      await record(s.tx, remediation, "CEO");
      await s.as("investigatorB");
      expect((await view(s, rec)).proposals.map((p) => p.state)).toEqual([
        "AWAITING_AUTHORITY",
        "AWAITING_AUTHORITY",
      ]);
      await s.as("caseManager");
      await record(s.tx, remediation, "BOARD", "REJECTED");
      await record(s.tx, corrective, "CEO");
      await s.as("investigatorB");
      expect((await view(s, rec)).proposals.map((p) => p.state)).toEqual(["APPROVED", "REJECTED"]);
    });
  });

  it("a corrective-action manager records each required authority's decision from its source document, never the proposer", async () => {
    await ownerScenario(async (s) => {
      const { rec, proposal } = await approvedProposal(s);
      for (const [user, code] of [
        ["investigatorA", "CDF_NOT_FOUND"],
        ["grcSectorHead", "CDF_NOT_FOUND"],
        ["platformAdmin", "CDF_NOT_FOUND"],
        ["investigatorB", "CDF_FORBIDDEN"],
      ] as [UserKey, string][]) {
        await s.as(user);
        await s.expectError(code, (tx) => record(tx, proposal));
      }
      await s.as("caseManager");
      await s.expectError("CDF_CONFLICT:AUTHORITY_TYPE_MISMATCH", (tx) => record(tx, proposal, "BOARD"));
      await s.expectError("CDF_CONFLICT:AUTHORITY_TYPE_MISMATCH", (tx) => record(tx, proposal, null));
      await s.expectError("CDF_INVALID:outcome", (tx) => record(tx, proposal, "CEO", "MODIFIED"));
      await s.expectError("CDF_INVALID:decided_at", (tx) =>
        record(tx, proposal, "CEO", "APPROVED", new Date(Date.now() + 3_600_000).toISOString()),
      );
      await s.expectError("CDF_INVALID:decided_at", (tx) =>
        record(tx, proposal, "CEO", "APPROVED", new Date(Date.now() - 2 * 86_400_000).toISOString()),
      );
      await s.expectError("CDF_INVALID:source_document_reference", (tx) =>
        record(tx, proposal, "CEO", "APPROVED", null, " "),
      );
      await s.expectError("CDF_INVALID:decided_by_label", (tx) =>
        record(tx, proposal, "CEO", "APPROVED", null, MEMO, "x"),
      );
      // A manager with a declared conflict loses sight of the case, so records nothing.
      await s.as("grcDeputy");
      await s.tx`select api.declare_conflict(${caseB}, true, 'Synthetic: conflict for the 2070 test.')`;
      await s.expectError("CDF_NOT_FOUND", (tx) => record(tx, proposal));

      await s.as("caseManager");
      const [d] = await record(s.tx, proposal);
      await s.expectError("CDF_CONFLICT:AUTHORITY_ALREADY_DECIDED", (tx) => record(tx, proposal));
      const [q] = await s.tx<{ rule_id: string }[]>`
        select rule_id from decision.preliminary_authority_requirement where proposal_id = ${proposal}`;
      // Ids and codes only: no label, source document or reason in the metadata (the reason stays in the row).
      expect(await ledger(s, "PRELIMINARY_AUTHORITY_DECISION_RECORDED", d!.id)).toEqual([
        {
          actor_id: USERS.caseManager,
          reason: null,
          metadata: {
            proposal_id: proposal,
            recommendation_id: rec,
            authority_type: "CEO",
            outcome: "APPROVED",
            rule_id: q!.rule_id,
            rule_source_status: "SOURCE_REQUIRED",
            proposal_state: "APPROVED",
            has_reason: true,
          },
        },
      ]);
      await s.expectError(
        "decision.preliminary_authority_decision is append-only",
        (tx) =>
          tx`update decision.preliminary_authority_decision set outcome = 'REJECTED' where id = ${d!.id}`,
      );
    });
  });

  it("the proposer never records the authority's decision, even as a corrective-action manager; nor before the approval", async () => {
    await ownerScenario(async (s) => {
      await setTypes(s, "CORRECTIVE_ACTION");
      await authorityRuleFor(s, "CORRECTIVE_ACTION");
      const own = await prepare(s, "grcDirector", caseB, "NO_ACTION");
      const proposal = await proposeAs(s, "grcDirector", own);
      await s.as("grcDeputy");
      await s.expectError("CDF_CONFLICT:RECOMMENDATION_NOT_APPROVED", (tx) => record(tx, proposal));
      await s.as("grcSectorHead");
      await approve(s.tx, own);
      await s.as("grcDirector");
      expect((await view(s, own)).proposals[0]!.authorities![0]!.may_record).toBe(false);
      await s.expectError("CDF_CONFLICT:PROPOSER_CANNOT_RECORD", (tx) => record(tx, proposal));
      // The table refuses it on any path.
      await s.asOwner();
      await s.expectError(
        "CDF_CONFLICT:PROPOSER_CANNOT_RECORD",
        (
          tx,
        ) => tx`insert into decision.preliminary_authority_decision (proposal_id, authority_type, case_id, outcome,
                     decided_at, decided_by_label, source_document_reference, recorded_by)
                   values (${proposal}, 'CEO', ${caseB}, 'APPROVED', now(), ${LABEL}, ${MEMO}, ${USERS.grcDirector})`,
      );
      // A decision only for a required authority (the requirement is its key).
      await s.expectError(
        'insert or update on table "preliminary_authority_decision" violates foreign key constraint',
        (
          tx,
        ) => tx`insert into decision.preliminary_authority_decision (proposal_id, authority_type, case_id, outcome,
                     decided_at, decided_by_label, source_document_reference, recorded_by)
                   values (${proposal}, 'BOARD', ${caseB}, 'APPROVED', now(), ${LABEL}, ${MEMO}, ${USERS.caseManager})`,
      );
      await s.as("grcDeputy");
      expect((await view(s, own)).proposals[0]!.authorities![0]!.may_record).toBe(true);
      await record(s.tx, proposal);
    });
  });
});

describe("corrective actions from an approved proposal (DEC-F41, ADR-033)", () => {
  it("an action opens only once every required authority approved the proposal, as from an approved item; its origin is the proposal", async () => {
    await ownerScenario(async (s) => {
      await implementationOwner(s, "financeEmployee");
      const { rec, proposal } = await approvedProposal(s);
      await s.as("caseManager");
      await s.expectError("CDF_CONFLICT:PROPOSAL_NOT_APPROVED", (tx) =>
        openAction(tx, proposal, USERS.financeEmployee),
      );
      expect((await view(s, rec)).proposals[0]!.may_open_action).toBe(false);
      // The table refuses it on any path.
      await s.asOwner();
      await s.expectError(
        "CDF_CONFLICT:PROPOSAL_NOT_APPROVED",
        (
          tx,
        ) => tx`insert into decision.corrective_action (case_id, preliminary_proposal_id, action_type, sequence_no, title,
                     description, owner_id, due_date, created_by)
                   values (${caseB}, ${proposal}, 'CORRECTIVE_ACTION', 1, ${TITLE}, ${DESCRIPTION}, ${USERS.financeEmployee},
                           current_date + 30, ${USERS.caseManager})`,
      );
      await s.as("caseManager");
      await record(s.tx, proposal);

      for (const [user, code] of [
        ["lead", "CDF_NOT_FOUND"],
        ["platformAdmin", "CDF_NOT_FOUND"],
        ["investigatorB", "CDF_FORBIDDEN"],
      ] as [UserKey, string][]) {
        await s.as(user);
        await s.expectError(code, (tx) => openAction(tx, proposal, USERS.financeEmployee));
        if (code === "CDF_FORBIDDEN")
          expect((await view(s, rec)).proposals[0]!.may_open_action, user).toBe(false);
      }
      await s.as("caseManager");
      expect((await view(s, rec)).proposals[0]!.may_open_action).toBe(true);
      await s.expectError("CDF_INVALID:owner_id", (tx) => openAction(tx, proposal, null));
      await s.expectError("CDF_INVALID:owner_id", (tx) => openAction(tx, proposal, USERS.investigatorA));
      const [a1] = await openAction(s.tx, proposal, USERS.financeEmployee);
      const [a2] = await openAction(s.tx, proposal, USERS.financeEmployee);

      await s.asOwner();
      expect(
        await s.tx`select sequence_no, action_type, preliminary_proposal_id, recommendation_item_id, authority_decision_id,
                          status
                   from decision.corrective_action where preliminary_proposal_id = ${proposal} order by sequence_no`,
      ).toEqual([
        {
          sequence_no: 1,
          action_type: "CORRECTIVE_ACTION",
          preliminary_proposal_id: proposal,
          recommendation_item_id: null,
          authority_decision_id: null,
          status: "OPEN",
        },
        {
          sequence_no: 2,
          action_type: "CORRECTIVE_ACTION",
          preliminary_proposal_id: proposal,
          recommendation_item_id: null,
          authority_decision_id: null,
          status: "OPEN",
        },
      ]);
      expect(await ledger(s, "CORRECTIVE_ACTION_OPENED", a1!.id)).toEqual([
        {
          actor_id: USERS.caseManager,
          reason: null,
          metadata: {
            origin: "PRELIMINARY_REVIEW",
            preliminary_proposal_id: proposal,
            preliminary_recommendation_id: rec,
            action_type: "CORRECTIVE_ACTION",
            sequence_no: 1,
            owner_id: USERS.financeEmployee,
            due_date: expect.any(String) as string,
            due_date_from_policy: false,
          },
        },
      ]);
      // The origin never changes, and an action has one origin: a proposal or a package item, never both or neither.
      await s.expectError(
        "corrective action",
        (tx) => tx`update decision.corrective_action set preliminary_proposal_id = null where id = ${a1!.id}`,
      );
      const [item] = await s.tx<{ recommendation_item_id: string; authority_decision_id: string }[]>`
        select recommendation_item_id, authority_decision_id from decision.corrective_action
        where recommendation_item_id is not null limit 1`;
      if (item) {
        await s.expectError(
          'new row for relation "corrective_action" violates check constraint "corrective_action_origin"',
          (
            tx,
          ) => tx`insert into decision.corrective_action (case_id, recommendation_item_id, authority_decision_id,
                       preliminary_proposal_id, action_type, sequence_no, title, description, owner_id, due_date,
                       created_by)
                     values (${caseB}, ${item.recommendation_item_id}, ${item.authority_decision_id}, ${proposal},
                             'CORRECTIVE_ACTION', 9, ${TITLE}, ${DESCRIPTION}, ${USERS.financeEmployee}, current_date + 30,
                             ${USERS.caseManager})`,
        );
      }
      await s.expectError(
        'new row for relation "corrective_action" violates check constraint "corrective_action_origin"',
        (
          tx,
        ) => tx`insert into decision.corrective_action (case_id, action_type, sequence_no, title, description, owner_id,
                     due_date, created_by)
                   values (${caseB}, 'CORRECTIVE_ACTION', 9, ${TITLE}, ${DESCRIPTION}, ${USERS.financeEmployee},
                           current_date + 30, ${USERS.caseManager})`,
      );

      // The case team reads where it comes from; the owner reads the card only, and runs it as any action.
      await s.as("caseManager");
      const [team] = await s.tx<{ v: { origin: Record<string, unknown> } }[]>`
        select api.corrective_action_view(${a1!.id}) as v`;
      expect(team!.v.origin).toMatchObject({
        source: "PRELIMINARY_REVIEW",
        preliminary_proposal_id: proposal,
        recommendation_item_id: null,
        authority_decision_id: null,
        governing_decision_id: null,
        decision_block: null,
        dispositions: [],
        disposition_options: [],
      });
      expect(
        (await view(s, rec)).proposals[0]!.actions!.map((x) => [x.action_id, x.sequence_no, x.status]),
      ).toEqual([
        [a1!.id, 1, "OPEN"],
        [a2!.id, 2, "OPEN"],
      ]);
      await s.as("financeEmployee");
      const [owner] = await s.tx<{ v: { origin: unknown; title: string } }[]>`
        select api.corrective_action_view(${a1!.id}) as v`;
      expect([owner!.v.origin, owner!.v.title]).toEqual([null, TITLE]);
      await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.preliminary_corrective_view(${rec})`);
      await s.tx`select api.submit_corrective_action_completion(${a1!.id}, 'Synthetic: the control is in place.', ${EVIDENCE})`;
      await s.as("caseManager");
      expect(await s.tx`select api.verify_corrective_action(${a1!.id}, 'VERIFIED', null) as status`).toEqual([
        { status: "COMPLETED" },
      ]);
    });
  });

  it("a rejected proposal opens nothing", async () => {
    await ownerScenario(async (s) => {
      await implementationOwner(s, "financeEmployee");
      const { rec, proposal } = await approvedProposal(s);
      await s.as("caseManager");
      await record(s.tx, proposal, "CEO", "REJECTED");
      expect((await view(s, rec)).proposals[0]).toMatchObject({ state: "REJECTED", may_open_action: false });
      await s.expectError("CDF_CONFLICT:PROPOSAL_NOT_APPROVED", (tx) =>
        openAction(tx, proposal, USERS.financeEmployee),
      );
    });
  });
});

describe("closure readiness with the preliminary path (DEC-F41, AMB-146)", () => {
  const close = (tx: Scenario["tx"]) =>
    tx<{ r: string }[]>`select api.close_case(${caseB}, 'NO_ACTION', ${CLOSURE_RATIONALE}) as r`;
  const screenOutReasons = async (s: Scenario) => {
    const [t] = await s.tx<{ blocking_reasons: string[] }[]>`
      select blocking_reasons from api.available_transitions(${caseB}) where code = 'SCREEN_OUT'`;
    return t!.blocking_reasons;
  };

  it("a proposal waiting for its authority is a decision not final; an approved one keeps the case open until its actions are done", async () => {
    await ownerScenario(async (s) => {
      await implementationOwner(s, "financeEmployee");
      const { proposal } = await approvedProposal(s);
      await s.as("caseManager");
      await s.expectError("CDF_CONFLICT:DECISION_NOT_FINAL", (tx) => close(tx));
      await s.expectError(
        "CDF_CONFLICT:DECISION_NOT_FINAL",
        (tx) => tx`select api.transition_case(${caseB}, 'SCREEN_OUT', 'Synthetic: screened out directly.')`,
      );
      expect(await screenOutReasons(s)).toEqual(["DECISION_NOT_FINAL"]);

      await record(s.tx, proposal);
      await s.expectError("CDF_CONFLICT:CORRECTIVE_ACTIONS_OUTSTANDING", (tx) => close(tx));
      expect(await screenOutReasons(s)).toEqual(["CORRECTIVE_ACTIONS_OUTSTANDING"]);
      const [a] = await openAction(s.tx, proposal, USERS.financeEmployee);
      await s.expectError("CDF_CONFLICT:CORRECTIVE_ACTIONS_OUTSTANDING", (tx) => close(tx));
      // The owner's direct write is refused too.
      await s.asOwner();
      await s.expectError(
        "CDF_CONFLICT:CORRECTIVE_ACTIONS_OUTSTANDING",
        (tx) => tx`update case_mgmt.case_record set records_state = 'CLOSED' where id = ${caseB}`,
      );

      await s.as("financeEmployee");
      await s.tx`select api.submit_corrective_action_completion(${a!.id}, 'Synthetic: the control is in place.', ${EVIDENCE})`;
      await s.as("caseManager");
      await s.tx`select api.verify_corrective_action(${a!.id}, 'VERIFIED', null)`;
      expect(await screenOutReasons(s)).toEqual([]);
      expect(await close(s.tx)).toEqual([{ r: "CLOSED" }]);
    });
  });

  it("a rejected proposal does not keep the case open", async () => {
    await ownerScenario(async (s) => {
      const { proposal } = await approvedProposal(s);
      await s.as("caseManager");
      await record(s.tx, proposal, "CEO", "REJECTED");
      expect(await close(s.tx)).toEqual([{ r: "CLOSED" }]);
    });
  });
});

describe("the read model (DEC-F41): proposals to the recommendation's readers, the rest to the case team", () => {
  it("the approver outside the team reads the proposals they approve, never the authorities or actions; outsiders read nothing", async () => {
    await ownerScenario(async (s) => {
      await setTypes(s, "CORRECTIVE_ACTION");
      await authorityRuleFor(s, "CORRECTIVE_ACTION");
      const rec = await prepare(s, "investigatorB", caseB);
      const proposal = await proposeAs(s, "investigatorB", rec);
      expect((await view(s, rec)).proposals).toEqual([
        expect.objectContaining({ proposal_id: proposal, state: "PROPOSED", authorities: [], actions: [] }),
      ]);
      for (const user of [
        "grcSectorHead",
        "investigatorA",
        "lead",
        "platformAdmin",
        "employee",
      ] as UserKey[]) {
        await s.as(user);
        await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.preliminary_corrective_view(${rec})`);
        expect(await s.tx`select id from case_mgmt.preliminary_corrective_proposal`, user).toEqual([]);
      }
      await endorse(s, rec);
      await s.as("grcSectorHead");
      const awaiting = await view(s, rec);
      expect(awaiting).toMatchObject({ status: "AWAITING_APPROVAL", may_propose: false });
      expect(awaiting.proposals).toEqual([
        expect.objectContaining({
          proposal_id: proposal,
          summary: SUMMARY,
          state: "PROPOSED",
          authorities: null,
          actions: null,
          may_open_action: false,
        }),
      ]);
      expect((await s.tx`select id from case_mgmt.preliminary_corrective_proposal`).length).toBe(1);
      await approve(s.tx, rec);
      const approved = await view(s, rec);
      expect(approved.proposals[0]).toMatchObject({
        state: "AWAITING_AUTHORITY",
        authorities: null,
        actions: null,
      });
      expect(await s.tx`select * from decision.preliminary_authority_requirement`).toEqual([]);

      await s.as("caseManager");
      await record(s.tx, proposal);
      await s.as("grcSectorHead");
      expect(await s.tx`select * from decision.preliminary_authority_decision`).toEqual([]);
      await s.as("investigatorB");
      expect((await view(s, rec)).proposals[0]!.authorities).toEqual([
        expect.objectContaining({
          authority_type: "CEO",
          rule_source_status: "SOURCE_REQUIRED",
          decision: expect.objectContaining({
            outcome: "APPROVED",
            source_document_reference: MEMO,
            reason: REASON,
          }),
          may_record: false,
        }),
      ]);
    });
  });
});
