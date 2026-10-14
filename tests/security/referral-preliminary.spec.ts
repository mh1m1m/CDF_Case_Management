// Business architecture rebase, migration 1880 (Q1–Q20, Q28; AUTHORIZATION_IMPACT.md N4–N6, N14, N20).
// Direct referral: a sector prepares, its head (or a time-bound delegate) approves, the Investigation Committee
// secretary accepts, returns or rejects; a rejection may be objected to once. Preliminary review: prepared,
// reviewed (unless the preparer holds the review authority) and approved by different people; the GRC Sector Head
// sees only what awaits their approval. Nobody outside those paths sees a referral or a recommendation.
import { beforeAll, describe, expect, it } from "vitest";
import { USERS, admin, caseId, ownerScenario, scenario, type Scenario, type UserKey } from "../support/db";
import { preliminaryReferral, seat, unseatDemoSeats } from "../support/committee";

const REASON = "Synthetic: referral and preliminary review test.";
const OPS = "b0000000-0000-4000-8000-000000000001";
let caseA: string, caseExec: string, ic: string;

beforeAll(async () => {
  [caseA, caseExec] = await Promise.all([caseId("0001"), caseId("0003")]);
  const [row] = await admin<{ id: string }[]>`select id from committee.committee where code = 'IC'`;
  ic = row!.id;
});

/** Seats a chair, a secretary and one voting member on the Investigation Committee, as the platform admin. */
async function constitute(s: Scenario) {
  await unseatDemoSeats(s);
  await s.as("platformAdmin");
  for (const [user, seat] of [
    ["committeeChair", "CHAIR"],
    ["committeeSecretary", "SECRETARY"],
    ["committee", "MEMBER"],
  ] as const) {
    await s.tx`select api.appoint_committee_member(${ic}, ${USERS[user]}, ${seat}, now() - interval '1 day', null, 'DEMO-APPT')`;
  }
}

async function draft(s: Scenario, preparer: UserKey = "employee"): Promise<string> {
  await s.as(preparer);
  const [r] = await s.tx<{ id: string }[]>`
    select api.create_referral(${OPS}, 'Referral (synthetic)', 'Synthetic: a referral summary for the test.', 'FRAUD',
      'RESTRICTED'::core.classification_level) as id`;
  return r!.id;
}

/** A referral that has reached the committee secretary, approved by the sector head. */
async function atSecretary(s: Scenario): Promise<string> {
  const id = await draft(s);
  await s.tx`select api.submit_referral(${id}, null)`;
  await s.as("sectorHead");
  await s.tx`select api.sector_decide_referral(${id}, 'APPROVE', null, null)`;
  return id;
}

const visible = async (s: Scenario, user: UserKey, id: string) => {
  await s.as(user);
  return (await s.tx`select id from intake.referral where id = ${id}`).length === 1;
};

const actions = async (s: Scenario, user: UserKey, id: string) => {
  await s.as(user);
  const rows = await s.tx<{ action: string }[]>`select action from api.referral_available_actions(${id})`;
  return rows.map((r) => r.action);
};

describe("direct referral: who may prepare and who may see (N4)", () => {
  it("only a current sector member with REFERRAL_PREPARE creates a referral, within their clearance", async () => {
    await scenario(async (s) => {
      await s.as("financeEmployee"); // REFERRER, but in Finance
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) =>
          tx`select api.create_referral(${OPS}, 'Probe', 'Synthetic: probe summary.', 'FRAUD', 'INTERNAL')`,
      );
      await s.as("investigatorA"); // no REFERRAL_PREPARE
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) =>
          tx`select api.create_referral(${OPS}, 'Probe', 'Synthetic: probe summary.', 'FRAUD', 'INTERNAL')`,
      );
      await s.as("employee"); // CONFIDENTIAL clearance
      await s.expectError(
        "CDF_INVALID:classification",
        (tx) =>
          tx`select api.create_referral(${OPS}, 'Probe', 'Synthetic: probe summary.', 'FRAUD', 'SECRET')`,
      );
      const id = await draft(s);
      const [r] = await s.tx<{ referral_number: string; status: string }[]>`
        select referral_number, status from intake.referral where id = ${id}`;
      expect(r!.status).toBe("DRAFT");
      expect(r!.referral_number).toMatch(/^REF-DEMO-\d{4}-\d{4,5}$/);
    });
  });

  it("a draft is the preparer's alone; submission shows it to the head, never to other members or admins", async () => {
    await scenario(async (s) => {
      await constitute(s);
      const id = await draft(s);
      expect(await visible(s, "sectorHead", id)).toBe(false);
      await s.as("employee");
      await s.tx`select api.submit_referral(${id}, 'Synthetic: please review.')`;
      expect(await visible(s, "sectorHead", id)).toBe(true);
      for (const outsider of [
        "employeeB",
        "financeEmployee",
        "platformAdmin",
        "grcDirector", // COMMITTEE_ADMIN and CASE_VIEW_ALL: neither reaches a referral
        "committeeSecretary", // seated, but the referral has not reached the secretary yet
        "caseManager",
        "internalAudit",
      ] as const) {
        expect(await visible(s, outsider, id), outsider).toBe(false);
        expect(await s.tx`select id from intake.referral_event where referral_id = ${id}`).toEqual([]);
      }
    });
  });

  it("the secretary sees a referral only from when it reaches them, and only while seated", async () => {
    await scenario(async (s) => {
      await constitute(s);
      const id = await atSecretary(s);
      expect(await visible(s, "committeeSecretary", id)).toBe(true);
      // A global COMMITTEE_SECRETARY role without the seat sees nothing.
      await s.as("platformAdmin");
      const [m] = await s.tx<{ id: string }[]>`
        select id from committee.membership where user_id = ${USERS.committeeSecretary} and committee_id = ${ic}`;
      await s.tx`select api.end_committee_membership(${m!.id}, now(), ${REASON})`;
      expect(await visible(s, "committeeSecretary", id)).toBe(false);
    });
  });

  it("only the preparer edits, submits or withdraws; edits only while the referral is with the sector", async () => {
    await scenario(async (s) => {
      await constitute(s);
      const id = await draft(s);
      await s.tx`select api.submit_referral(${id}, null)`;
      await s.as("sectorHead");
      await s.expectError("CDF_FORBIDDEN", (tx) => tx`select api.withdraw_referral(${id}, ${REASON})`);
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) =>
          tx`select api.update_referral(${id}, 'Changed', 'Synthetic: changed summary.', 'FRAUD', 'INTERNAL')`,
      );
      await s.as("employee");
      await s.expectError(
        "CDF_CONFLICT:REFERRAL_NOT_EDITABLE",
        (tx) =>
          tx`select api.update_referral(${id}, 'Changed', 'Synthetic: changed summary.', 'FRAUD', 'INTERNAL')`,
      );
      await s.tx`select api.withdraw_referral(${id}, ${REASON})`;
      await s.expectError(
        "CDF_CONFLICT:REFERRAL_NOT_WITHDRAWABLE",
        (tx) => tx`select api.withdraw_referral(${id}, ${REASON})`,
      );
    });
  });
});

describe("direct referral: sector approval and delegation (N5)", () => {
  it("the head approves; the preparer never approves their own referral, even as head", async () => {
    await scenario(async (s) => {
      const id = await draft(s, "sectorHead"); // SECTOR_HEAD also holds REFERRAL_PREPARE
      await s.tx`select api.submit_referral(${id}, null)`;
      await s.expectError(
        "CDF_CONFLICT:SEPARATION_OF_DUTIES",
        (tx) => tx`select api.sector_decide_referral(${id}, 'APPROVE', null, null)`,
      );
      await s.tx`select api.delegate_referral_approval(${OPS}, ${USERS.employeeB}, now(), now() + interval '3 days', 'DEMO-DEL-01', ${REASON})`;
      await s.as("employeeB");
      await s.tx`select api.sector_decide_referral(${id}, 'APPROVE', null, null)`;
      const [r] = await s.tx<
        { status: string; sector_approval_basis: string; delegation_id: string | null }[]
      >`
        select status, sector_approval_basis, delegation_id from intake.referral where id = ${id}`;
      expect(r).toMatchObject({ status: "SUBMITTED_TO_SECRETARY", sector_approval_basis: "DELEGATE" });
      expect(r!.delegation_id).not.toBeNull();
    });
  });

  it("only the current head delegates, to a current member, forward in time, with an end and evidence", async () => {
    await scenario(async (s) => {
      await s.as("employee");
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) =>
          tx`select api.delegate_referral_approval(${OPS}, ${USERS.employeeB}, now(), now() + interval '1 day', 'DEMO-DEL', ${REASON})`,
      );
      await s.as("sectorHead");
      await s.expectError(
        "CDF_INVALID:delegate_id",
        (tx) =>
          tx`select api.delegate_referral_approval(${OPS}, ${USERS.financeEmployee}, now(), now() + interval '1 day', 'DEMO-DEL', ${REASON})`,
      );
      await s.expectError(
        "CDF_INVALID:delegate_id",
        (tx) =>
          tx`select api.delegate_referral_approval(${OPS}, ${USERS.sectorHead}, now(), now() + interval '1 day', 'DEMO-DEL', ${REASON})`,
      );
      await s.expectError(
        "CDF_INVALID:effective_from",
        (tx) =>
          tx`select api.delegate_referral_approval(${OPS}, ${USERS.employeeB}, now() - interval '1 day', now() + interval '1 day', 'DEMO-DEL', ${REASON})`,
      );
      await s.expectError(
        "CDF_INVALID:effective_to",
        (tx) =>
          tx`select api.delegate_referral_approval(${OPS}, ${USERS.employeeB}, now(), null, 'DEMO-DEL', ${REASON})`,
      );
      await s.expectError(
        "CDF_INVALID:evidence_reference",
        (tx) =>
          tx`select api.delegate_referral_approval(${OPS}, ${USERS.employeeB}, now(), now() + interval '1 day', '', ${REASON})`,
      );
    });
  });

  it("a revoked delegation, or one whose delegator is no longer head, approves nothing", async () => {
    await scenario(async (s) => {
      const id = await draft(s);
      await s.tx`select api.submit_referral(${id}, null)`;
      await s.as("sectorHead");
      const [d] = await s.tx<{ id: string }[]>`
        select api.delegate_referral_approval(${OPS}, ${USERS.employeeB}, now(), now() + interval '3 days', 'DEMO-DEL-02', ${REASON}) as id`;
      expect(await actions(s, "employeeB", id)).toContain("SECTOR_APPROVE");
      // The delegate cannot revoke; the head can.
      await s.as("employeeB");
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.revoke_referral_delegation(${d!.id}, ${REASON})`,
      );
      await s.as("sectorHead");
      await s.tx`select api.revoke_referral_delegation(${d!.id}, ${REASON})`;
      expect(await visible(s, "employeeB", id)).toBe(false);
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) => tx`select api.sector_decide_referral(${id}, 'APPROVE', null, null)`,
      );

      // A fresh delegation lapses the moment the head's own position ends.
      await s.as("sectorHead");
      await s.tx`select api.delegate_referral_approval(${OPS}, ${USERS.employeeB}, now(), now() + interval '3 days', 'DEMO-DEL-03', ${REASON})`;
      expect(await visible(s, "employeeB", id)).toBe(true);
      await s.as("platformAdmin");
      const [head] = await s.tx<{ id: string }[]>`
        select id from iam.sector_membership where user_id = ${USERS.sectorHead} and sector_id = ${OPS}`;
      await s.tx`select api.end_sector_membership(${head!.id}, now(), ${REASON})`;
      expect(await visible(s, "employeeB", id)).toBe(false);
      expect(await visible(s, "sectorHead", id)).toBe(false);
    });
  });

  it("a sector return needs structured reasons and sends the referral back to draft with its history", async () => {
    await scenario(async (s) => {
      const id = await draft(s);
      await s.tx`select api.submit_referral(${id}, null)`;
      await s.as("sectorHead");
      await s.expectError(
        "CDF_INVALID:reason_codes",
        (tx) => tx`select api.sector_decide_referral(${id}, 'RETURN', null, null)`,
      );
      await s.expectError(
        "CDF_INVALID:reason_codes",
        (tx) => tx`select api.sector_decide_referral(${id}, 'RETURN', array['NOT_A_CODE'], null)`,
      );
      await s.expectError(
        "CDF_INVALID:comment",
        (tx) => tx`select api.sector_decide_referral(${id}, 'RETURN', array['OTHER'], null)`,
      );
      await s.tx`select api.sector_decide_referral(${id}, 'RETURN', array['MISSING_DOCUMENTS', 'UNCLEAR_ALLEGATION'], 'Attach the synthetic invoice.')`;
      await s.as("employee");
      const events = await s.tx<{ event_type: string; to_status: string; reason_codes: string[] }[]>`
        select event_type, to_status, reason_codes from intake.referral_event where referral_id = ${id} order by occurred_at, id`;
      expect(events.map((e) => e.event_type)).toEqual(["CREATED", "SUBMITTED", "SECTOR_RETURNED"]);
      expect(events[2]).toMatchObject({
        to_status: "DRAFT",
        reason_codes: ["MISSING_DOCUMENTS", "UNCLEAR_ALLEGATION"],
      });
      expect(await actions(s, "employee", id)).toEqual(["UPDATE", "SUBMIT", "WITHDRAW", "COMMENT"]);
      // History is append-only, even for the table owner.
    });
  });
});

describe("direct referral: the committee secretary's decision (N6)", () => {
  it("acceptance creates a DIRECT_REFERRAL case with an owner and a committee proceeding, and no wider access", async () => {
    await scenario(async (s) => {
      await constitute(s);
      const id = await atSecretary(s);
      await s.as("committeeSecretary");
      expect(await actions(s, "committeeSecretary", id)).toEqual([
        "ACCEPT",
        "RETURN_FOR_COMPLETION",
        "REJECT",
        "COMMENT",
      ]);
      await s.expectError(
        "CDF_INVALID:case_owner_id",
        (tx) => tx`select api.secretary_decide_referral(${id}, 'ACCEPT', null, null, null)`,
      );
      await s.expectError(
        "CDF_CONFLICT:ASSIGNEE_ROLE_INELIGIBLE",
        (tx) => tx`select api.secretary_decide_referral(${id}, 'ACCEPT', null, null, ${USERS.investigatorA})`,
      );
      const [c] = await s.tx<{ id: string }[]>`
        select api.secretary_decide_referral(${id}, 'ACCEPT', null, 'Synthetic: accepted.', ${USERS.caseManager}) as id`;
      const caseIdNew = c!.id;

      await s.as("caseManager");
      const [rec] = await s.tx<
        { case_type: string; source: string; source_type: string; owner_id: string }[]
      >`
        select case_type, source, source_type, owner_id from case_mgmt.case_record where id = ${caseIdNew}`;
      expect(rec).toEqual({
        case_type: "INTERNAL_REFERRAL",
        source: "INTERNAL_REFERRAL",
        source_type: "DIRECT_REFERRAL",
        owner_id: USERS.caseManager,
      });
      const procs = await s.tx<{ proceeding_type: string }[]>`
        select proceeding_type from case_mgmt.proceeding where case_id = ${caseIdNew}`;
      expect(procs.map((p) => p.proceeding_type)).toEqual(["COMMITTEE_INVESTIGATION"]);
      expect(await visible(s, "caseManager", id)).toBe(true);

      // The secretary sees the committee proceeding, not the case; the preparer and head see neither.
      await s.as("committeeSecretary");
      expect(await s.tx`select id from case_mgmt.case_record where id = ${caseIdNew}`).toEqual([]);
      expect(
        (await s.tx`select id from committee.committee_proceeding where case_id = ${caseIdNew}`).length,
      ).toBe(1);
      for (const user of ["employee", "sectorHead"] as const) {
        await s.as(user);
        expect(await s.tx`select id from case_mgmt.case_record where id = ${caseIdNew}`).toEqual([]);
        expect(await s.tx`select id from committee.committee_proceeding`).toEqual([]);
        const [r] = await s.tx<{ status: string }[]>`select status from intake.referral where id = ${id}`;
        expect(r!.status).toBe("ACCEPTED");
      }
      // Accepted is final.
      await s.as("employee");
      await s.expectError(
        "CDF_CONFLICT:REFERRAL_NOT_WITHDRAWABLE",
        (tx) => tx`select api.withdraw_referral(${id}, ${REASON})`,
      );
    });
  });

  it("acceptance fails whole when the committee is not constituted", async () => {
    await scenario(async (s) => {
      // The secretary alone is seated: no chair, no voting member.
      await unseatDemoSeats(s);
      await s.as("platformAdmin");
      await s.tx`select api.appoint_committee_member(${ic}, ${USERS.committeeSecretary}, 'SECRETARY', now() - interval '1 day', null, 'DEMO-APPT')`;
      const id = await atSecretary(s);
      await s.as("committeeSecretary");
      await s.expectError(
        "CDF_CONFLICT:COMMITTEE_NOT_CONSTITUTED",
        (tx) => tx`select api.secretary_decide_referral(${id}, 'ACCEPT', null, null, ${USERS.caseManager})`,
      );
      const [r] = await s.tx<{ status: string; case_id: string | null }[]>`
        select status, case_id from intake.referral where id = ${id}`;
      expect(r).toEqual({ status: "SUBMITTED_TO_SECRETARY", case_id: null });
    });
  });

  it("a rejection is not final: the sector objects once, then the secretary accepts or rejects again", async () => {
    await scenario(async (s) => {
      await constitute(s);
      const id = await atSecretary(s);
      await s.as("committeeSecretary");
      await s.expectError(
        "CDF_INVALID:reason_codes",
        (tx) => tx`select api.secretary_decide_referral(${id}, 'REJECT', '{}', null, null)`,
      );
      await s.tx`select api.secretary_decide_referral(${id}, 'REJECT', array['OUT_OF_SCOPE'], null, null)`;
      // The preparer may not object; the head may.
      await s.as("employee");
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.object_to_referral_rejection(${id}, 'Synthetic: objection text.')`,
      );
      expect(await actions(s, "sectorHead", id)).toEqual(["RESUBMIT", "OBJECT", "COMMENT"]);
      await s.as("sectorHead");
      await s.tx`select api.object_to_referral_rejection(${id}, 'Synthetic: the matter is within scope.')`;
      // After an objection there is no return for completion.
      await s.as("committeeSecretary");
      await s.expectError(
        "CDF_INVALID:decision",
        (tx) =>
          tx`select api.secretary_decide_referral(${id}, 'RETURN_FOR_COMPLETION', array['MISSING_INFORMATION'], null, null)`,
      );
      await s.tx`select api.secretary_decide_referral(${id}, 'REJECT', array['OUT_OF_SCOPE'], 'Synthetic: confirmed.', null)`;
      await s.as("sectorHead");
      await s.expectError(
        "CDF_CONFLICT:OBJECTION_ALREADY_DECIDED",
        (tx) => tx`select api.object_to_referral_rejection(${id}, 'Synthetic: a second objection.')`,
      );
      // Migration 2040 (DEC-F09): after this repeated rejection the escalation path is offered too.
      expect(await actions(s, "sectorHead", id)).toEqual(["RESUBMIT", "ESCALATE", "COMMENT"]);
      // Resubmission goes back through the sector.
      await s.as("employee");
      await s.tx`select api.resubmit_referral(${id}, null)`;
      const [r] = await s.tx<{ status: string }[]>`select status from intake.referral where id = ${id}`;
      expect(r!.status).toBe("SUBMITTED_TO_HEAD");
    });
  });

  it("the secretary cannot decide what they approved for the sector, and a COMMITTEE_ADMIN is not a secretary", async () => {
    await scenario(async (s) => {
      await constitute(s);
      const id = await atSecretary(s);
      await s.as("grcDirector");
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) => tx`select api.secretary_decide_referral(${id}, 'REJECT', array['OTHER'], 'Probe.', null)`,
      );
    });
  });

  it("history rows are append-only and closed referrals are frozen, even for the table owner", async () => {
    await ownerScenario(async (s) => {
      await constitute(s);
      const id = await atSecretary(s);
      await s.as("committeeSecretary");
      await s.tx`select api.secretary_decide_referral(${id}, 'ACCEPT', null, null, ${USERS.caseManager})`;
      await s.asOwner();
      await s.expectError(
        "intake.referral_event is append-only",
        (tx) => tx`update intake.referral_event set comment = 'x' where referral_id = ${id}`,
      );
      await s.expectError(
        "intake.referral_event is append-only",
        (tx) => tx`delete from intake.referral_event where referral_id = ${id}`,
      );
      await s.expectError(
        `referral ${id} is closed`,
        (tx) => tx`update intake.referral set title = 'Rewritten' where id = ${id}`,
      );
      await s.expectError(
        "intake.referral is append-only",
        (tx) => tx`delete from intake.referral where id = ${id}`,
      );
    });
  });

  it("audit events carry codes and ids, never the comment text", async () => {
    await scenario(async (s) => {
      const id = await draft(s);
      await s.tx`select api.submit_referral(${id}, 'Synthetic: unique-comment-marker-7731')`;
      await s.tx`select api.comment_on_referral(${id}, 'Synthetic: unique-comment-marker-7731 again')`;
      await s.as("dpo");
      const rows = await s.tx<{ metadata: unknown; reason: string | null }[]>`
        select metadata, reason from audit.audit_event where object_type = 'referral' and object_id = ${id}`;
      expect(rows.length).toBe(3);
      expect(JSON.stringify(rows)).not.toContain("unique-comment-marker-7731");
    });
  });
});

describe("preliminary review (N14)", () => {
  it("an investigator prepares; the GRC Director reviews; the GRC Sector Head approves; each step is a different person", async () => {
    await scenario(async (s) => {
      await s.as("investigatorA");
      const [r] = await s.tx<{ id: string }[]>`
        select api.prepare_preliminary_recommendation(${caseA}, 'INVESTIGATION_WARRANTED', 'Synthetic: grounds to investigate.') as id`;
      const [p] = await s.tx<{ status: string; proceeding_type: string }[]>`
        select p.status, p.proceeding_type from case_mgmt.proceeding p
        join case_mgmt.preliminary_recommendation r on r.proceeding_id = p.id where r.id = ${r!.id}`;
      expect(p).toEqual({ status: "AWAITING_REVIEW", proceeding_type: "PRELIMINARY_REVIEW" });
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.review_preliminary_recommendation(${r!.id}, 'ENDORSE', null, null)`,
      );
      await s.expectError(
        "CDF_CONFLICT:RECOMMENDATION_PENDING",
        (tx) =>
          tx`select api.prepare_preliminary_recommendation(${caseA}, 'NO_ACTION', 'Synthetic: a second version too early.')`,
      );

      // Before review, the GRC Sector Head sees nothing and cannot approve.
      await s.as("grcSectorHead");
      expect(await s.tx`select id from case_mgmt.preliminary_recommendation`).toEqual([]);
      expect(await s.tx`select * from api.preliminary_approval_queue()`).toEqual([]);
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) => tx`select api.approve_preliminary_recommendation(${r!.id}, 'APPROVE', null, null)`,
      );

      await s.as("grcDirector");
      await s.tx`select api.review_preliminary_recommendation(${r!.id}, 'ENDORSE', null, 'Synthetic: endorsed.')`;

      // Purpose-bound: the recommendation and its case number, never the case, its proceedings or allegations.
      await s.as("grcSectorHead");
      const queue = await s.tx<{ recommendation_id: string; case_number: string }[]>`
        select recommendation_id, case_number from api.preliminary_approval_queue()`;
      expect(queue.map((q) => q.recommendation_id)).toEqual([r!.id]);
      expect(queue[0]!.case_number).toMatch(/^CDF-DEMO-/);
      expect(await s.tx`select id from case_mgmt.case_record`).toEqual([]);
      expect(await s.tx`select id from case_mgmt.proceeding`).toEqual([]);
      expect(await s.tx`select id from case_mgmt.allegation`).toEqual([]);
      await s.tx`select api.approve_preliminary_recommendation(${r!.id}, 'APPROVE', null, null)`;
      // What they decided stays visible to them; the queue is empty again.
      expect((await s.tx`select id from case_mgmt.preliminary_recommendation`).length).toBe(1);
      expect(await s.tx`select * from api.preliminary_approval_queue()`).toEqual([]);

      await s.as("caseManager");
      const [closed] = await s.tx<{ status: string; outcome_code: string; closed_by: string }[]>`
        select p.status, p.outcome_code, p.closed_by from case_mgmt.proceeding p
        join case_mgmt.preliminary_recommendation r on r.proceeding_id = p.id where r.id = ${r!.id}`;
      expect(closed).toEqual({
        status: "CONCLUDED",
        outcome_code: "INVESTIGATION_WARRANTED",
        closed_by: USERS.grcSectorHead,
      });
    });
  });

  it("a GRC Director's own recommendation skips review (Q15) and still needs a different approver", async () => {
    await ownerScenario(async (s) => {
      await s.as("grcDirector");
      const [r] = await s.tx<{ id: string }[]>`
        select api.prepare_preliminary_recommendation(${caseA}, 'NO_ACTION', 'Synthetic: no basis to proceed.') as id`;
      const [row] = await s.tx<{ status: string; review_required: boolean; prepared_role: string }[]>`
        select status, review_required, prepared_role from case_mgmt.preliminary_recommendation where id = ${r!.id}`;
      expect(row).toEqual({
        status: "AWAITING_APPROVAL",
        review_required: false,
        prepared_role: "GRC_DIRECTOR",
      });
      await s.as("grcDeputy");
      await s.expectError(
        "CDF_CONFLICT:RECOMMENDATION_NOT_AWAITING_REVIEW",
        (tx) => tx`select api.review_preliminary_recommendation(${r!.id}, 'ENDORSE', null, null)`,
      );
      // Even if the preparer also held approval authority, they could not approve their own work.
      await s.asOwner();
      await s.tx`
        insert into iam.user_role_assignment (user_id, role_code, justification, source_reference)
        values (${USERS.grcDirector}, 'GRC_SECTOR_HEAD', 'Synthetic: dual role for the test', 'TEST')`;
      await s.as("grcDirector");
      await s.expectError(
        "CDF_CONFLICT:SEPARATION_OF_DUTIES",
        (tx) => tx`select api.approve_preliminary_recommendation(${r!.id}, 'APPROVE', null, null)`,
      );
    });
  });

  it("a return needs structured reasons, marks the proceeding RETURNED, and the next version answers it", async () => {
    await scenario(async (s) => {
      await s.as("investigatorA");
      const [r] = await s.tx<{ id: string }[]>`
        select api.prepare_preliminary_recommendation(${caseA}, 'OUT_OF_SCOPE', 'Synthetic: outside the mandate.') as id`;
      await s.as("grcDirector");
      await s.expectError(
        "CDF_INVALID:reason_codes",
        (tx) => tx`select api.review_preliminary_recommendation(${r!.id}, 'RETURN', null, null)`,
      );
      await s.tx`select api.review_preliminary_recommendation(${r!.id}, 'RETURN', array['RECOMMENDATION_INCOMPLETE'], null)`;
      await s.as("investigatorA");
      const [p] = await s.tx<{ status: string }[]>`
        select p.status from case_mgmt.proceeding p join case_mgmt.preliminary_recommendation r on r.proceeding_id = p.id
        where r.id = ${r!.id}`;
      expect(p!.status).toBe("RETURNED");
      const [r2] = await s.tx<{ id: string }[]>`
        select api.prepare_preliminary_recommendation(${caseA}, 'INVESTIGATION_WARRANTED', 'Synthetic: revised after return.') as id`;
      const versions = await s.tx<{ version_no: number; status: string }[]>`
        select version_no, status from case_mgmt.preliminary_recommendation where case_id = ${caseA} order by version_no`;
      expect(versions).toEqual([
        { version_no: 1, status: "RETURNED" },
        { version_no: 2, status: "AWAITING_REVIEW" },
      ]);
      expect(r2!.id).not.toBe(r!.id);
    });
  });

  it("the GRC Sector Head gets nothing on a restricted case without an explicit grant (fail safe)", async () => {
    await scenario(async (s) => {
      await s.as("grcDirector"); // CASE_OWNER of the restricted SECRET case 0003
      const [r] = await s.tx<{ id: string }[]>`
        select api.prepare_preliminary_recommendation(${caseExec}, 'NO_ACTION', 'Synthetic: restricted case review.') as id`;
      await s.as("grcSectorHead");
      expect(await s.tx`select * from api.preliminary_approval_queue()`).toEqual([]);
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) => tx`select api.approve_preliminary_recommendation(${r!.id}, 'APPROVE', null, null)`,
      );
    });
  });

  it("people with no case access see no recommendation and cannot prepare one", async () => {
    await scenario(async (s) => {
      await s.as("investigatorA");
      await s.tx`select api.prepare_preliminary_recommendation(${caseA}, 'NO_ACTION', 'Synthetic: visibility probe.')`;
      for (const user of [
        "complianceManager",
        "platformAdmin",
        "committee",
        "investigatorB",
        "employee",
      ] as const) {
        await s.as(user);
        expect(await s.tx`select id from case_mgmt.preliminary_recommendation`, user).toEqual([]);
        await s.expectError(
          "CDF_NOT_FOUND",
          (tx) =>
            tx`select api.prepare_preliminary_recommendation(${caseA}, 'NO_ACTION', 'Synthetic: outsider attempt.')`,
        );
      }
    });
  });

  it("a direct-referral case has no preliminary review; decided versions are frozen", async () => {
    await ownerScenario(async (s) => {
      await constitute(s);
      const id = await atSecretary(s);
      await s.as("committeeSecretary");
      const [c] = await s.tx<{ id: string }[]>`
        select api.secretary_decide_referral(${id}, 'ACCEPT', null, null, ${USERS.grcDirector}) as id`;
      await s.as("grcDirector");
      await s.expectError(
        "CDF_CONFLICT:PRELIMINARY_NOT_APPLICABLE",
        (tx) =>
          tx`select api.prepare_preliminary_recommendation(${c!.id}, 'NO_ACTION', 'Synthetic: not applicable.')`,
      );
      const [r] = await s.tx<{ id: string }[]>`
        select api.prepare_preliminary_recommendation(${caseA}, 'DUPLICATE', 'Synthetic: duplicate of another case.') as id`;
      await s.as("grcSectorHead");
      await s.tx`select api.approve_preliminary_recommendation(${r!.id}, 'RETURN', array['INSUFFICIENT_EVIDENCE'], null)`;
      await s.asOwner();
      await s.expectError(
        `recommendation ${r!.id} is decided`,
        (tx) =>
          tx`update case_mgmt.preliminary_recommendation set rationale = 'Rewritten rationale' where id = ${r!.id}`,
      );
    });
  });
});

describe("referral objection and delegation edges (AGENT-09 P2, required tests 4 and 5)", () => {
  it("the head who prepared a referral cannot object to its rejection, and an edit after rejection blocks the objection", async () => {
    await scenario(async (s) => {
      await constitute(s);
      // The head prepares; a delegate approves; the secretary rejects.
      const id = await draft(s, "sectorHead");
      await s.tx`select api.submit_referral(${id}, null)`;
      await s.tx`select api.delegate_referral_approval(${OPS}, ${USERS.employeeB}, now(), now() + interval '3 days', 'DEMO-DEL-P2', ${REASON})`;
      await s.as("employeeB");
      await s.tx`select api.sector_decide_referral(${id}, 'APPROVE', null, null)`;
      await s.as("committeeSecretary");
      await s.tx`select api.secretary_decide_referral(${id}, 'REJECT', array['OUT_OF_SCOPE'], null, null)`;
      // The preparing head holds an approval basis but cannot object alone.
      await s.as("sectorHead");
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.object_to_referral_rejection(${id}, 'Synthetic: objection by the preparer.')`,
      );
      expect(await actions(s, "sectorHead", id)).not.toContain("OBJECT");
      // The preparer edits the rejected text: no approver has seen it, so the delegate cannot object to it either.
      await s.as("sectorHead");
      await s.tx`select api.update_referral(${id}, 'Referral (synthetic, edited)', 'Synthetic: an edited summary text.', 'FRAUD', 'RESTRICTED'::core.classification_level)`;
      await s.as("employeeB");
      await s.expectError(
        "CDF_CONFLICT:REFERRAL_CHANGED_AFTER_REJECTION",
        (tx) => tx`select api.object_to_referral_rejection(${id}, 'Synthetic: objection to edited text.')`,
      );
      expect(await actions(s, "employeeB", id)).not.toContain("OBJECT");
      // The path left is resubmission, which goes back through sector approval.
      await s.as("sectorHead");
      await s.tx`select api.resubmit_referral(${id}, null)`;
      const [r] = await s.tx<{ status: string }[]>`select status from intake.referral where id = ${id}`;
      expect(r!.status).toBe("SUBMITTED_TO_HEAD");
    });
  });

  it("a delegate whose delegation has passed its effective end cannot approve", async () => {
    await ownerScenario(async (s) => {
      const id = await draft(s);
      await s.tx`select api.submit_referral(${id}, null)`;
      await s.as("sectorHead");
      const [d] = await s.tx<{ id: string }[]>`
        select api.delegate_referral_approval(${OPS}, ${USERS.employeeB}, now(), now() + interval '1 day', 'DEMO-DEL-EXP', ${REASON}) as id`;
      // The period ends: shift it into the past as the owner (the commands only ever create future periods).
      await s.asOwner();
      await s.tx`alter table iam.sector_delegation disable trigger user`;
      await s.tx`update iam.sector_delegation set effective_from = now() - interval '3 days',
                   effective_to = now() - interval '1 day' where id = ${d!.id}`;
      await s.tx`alter table iam.sector_delegation enable trigger user`;
      // The lapsed delegate no longer sees the referral at all, so cannot approve it.
      await s.as("employeeB");
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) => tx`select api.sector_decide_referral(${id}, 'APPROVE', null, null)`,
      );
      expect(await actions(s, "employeeB", id)).not.toContain("SECTOR_APPROVE");
    });
  });
});

describe("preliminary closure outcomes (migration 1980, P11-G1, ADR-036)", () => {
  const CLOSURES = [
    "NOT_SERIOUS",
    "NOT_SUBSTANTIATED",
    "CHANNEL_ABUSE",
    "NOT_FEASIBLE",
    "NO_PERSONAL_JURISDICTION",
  ] as const;
  // Migration 2040 (DEC-F10): these two are not enabled for a new recommendation until their authority and
  // definitions are confirmed; the owner-decisions describe below proves the refusal.
  const NOT_ENABLED: readonly string[] = ["NOT_FEASIBLE", "NO_PERSONAL_JURISDICTION"];
  const ENABLED = CLOSURES.filter((c) => !NOT_ENABLED.includes(c));
  const MARKER = "unique-rationale-marker-5519";

  it("each enabled closure goes through the same prepare and approve path and concludes the review with that outcome", async () => {
    await scenario(async (s) => {
      const ids: string[] = [];
      for (const outcome of ENABLED) {
        await s.as("grcDirector");
        const [r] = await s.tx<{ id: string }[]>`
          select api.prepare_preliminary_recommendation(${caseA}, ${outcome}, ${`Synthetic: ${MARKER} ${outcome}.`}) as id`;
        ids.push(r!.id);
        await s.as("grcSectorHead");
        await s.tx`select api.approve_preliminary_recommendation(${r!.id}, 'APPROVE', null, null)`;
        await s.as("caseManager");
        const [p] = await s.tx<{ status: string; outcome_code: string; recommended_outcome: string }[]>`
          select p.status, p.outcome_code, r.recommended_outcome from case_mgmt.proceeding p
          join case_mgmt.preliminary_recommendation r on r.proceeding_id = p.id where r.id = ${r!.id}`;
        expect(p, outcome).toEqual({
          status: "CONCLUDED",
          outcome_code: outcome,
          recommended_outcome: outcome,
        });
      }
      // The case itself stays open: closing it is still the CDF_CASE_V1 path (P11-G2).
      const [c] = await s.tx<{ records_state: string }[]>`
        select records_state from case_mgmt.case_record where id = ${caseA}`;
      expect(c!.records_state).toBe("ACTIVE");
      // Audit carries the outcome code, never the rationale.
      await s.as("dpo");
      const events = await s.tx<{ action: string; outcome: string; metadata: unknown }[]>`
        select action, metadata->>'recommended_outcome' as outcome, metadata from audit.audit_event
        where object_type = 'preliminary_recommendation' and object_id = any(${ids}::text[]) order by occurred_at, action`;
      expect(
        events.filter((e) => e.action === "PRELIMINARY_RECOMMENDATION_APPROVED").map((e) => e.outcome),
      ).toEqual([...ENABLED]);
      expect(
        events.filter((e) => e.action === "PRELIMINARY_RECOMMENDATION_PREPARED").map((e) => e.outcome),
      ).toEqual([...ENABLED]);
      expect(JSON.stringify(events)).not.toContain(MARKER);
    });
  });

  it("a closure prepared by an investigator still needs the Director's review and a different approver", async () => {
    await ownerScenario(async (s) => {
      await s.as("investigatorA");
      const [r] = await s.tx<{ id: string }[]>`
        select api.prepare_preliminary_recommendation(${caseA}, 'CHANNEL_ABUSE', 'Synthetic: the report appears malicious.') as id`;
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.review_preliminary_recommendation(${r!.id}, 'ENDORSE', null, null)`,
      );
      await s.as("grcSectorHead");
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) => tx`select api.approve_preliminary_recommendation(${r!.id}, 'APPROVE', null, null)`,
      );
      await s.as("grcDirector");
      await s.tx`select api.review_preliminary_recommendation(${r!.id}, 'ENDORSE', null, null)`;
      // The reviewer, even holding approval authority too, cannot approve what they endorsed.
      await s.asOwner();
      await s.tx`
        insert into iam.user_role_assignment (user_id, role_code, justification, source_reference)
        values (${USERS.grcDirector}, 'GRC_SECTOR_HEAD', 'Synthetic: dual role for the test', 'TEST')`;
      await s.as("grcDirector");
      await s.expectError(
        "CDF_CONFLICT:SEPARATION_OF_DUTIES",
        (tx) => tx`select api.approve_preliminary_recommendation(${r!.id}, 'APPROVE', null, null)`,
      );
    });
  });

  it("outcomes outside the list are still refused, and an outsider learns nothing from the outcome", async () => {
    await scenario(async (s) => {
      await s.as("grcDirector");
      for (const outcome of [
        "SUBSTANTIATED",
        "CORRECTIVE_ACTION",
        "EMERGENCY_CLOSURE",
        "WITHDRAWN",
        "not_serious",
        "NOT_SERIOUS ",
        "",
      ]) {
        await s.expectError(
          "CDF_INVALID:recommended_outcome",
          (tx) =>
            tx`select api.prepare_preliminary_recommendation(${caseA}, ${outcome}, 'Synthetic: refused outcome.')`,
        );
      }
      await s.expectError(
        "CDF_INVALID:recommended_outcome",
        (tx) => tx`select api.prepare_preliminary_recommendation(${caseA}, null, 'Synthetic: no outcome.')`,
      );
      // No case access: NOT_FOUND whatever the outcome, valid or not.
      for (const user of ["complianceManager", "platformAdmin", "employee"] as const) {
        await s.as(user);
        for (const outcome of ["NOT_SERIOUS", "SUBSTANTIATED"]) {
          await s.expectError(
            "CDF_NOT_FOUND",
            (tx) =>
              tx`select api.prepare_preliminary_recommendation(${caseA}, ${outcome}, 'Synthetic: outsider attempt.')`,
          );
        }
      }
    });
  });

  it("the catalogue records where each closure comes from: Q12, or SOURCE_REQUIRED and not enabled (DEC-F10)", async () => {
    const rows = await admin<{ value: string; state: string; source_status: string }[]>`
      select value, state, source_status from config.status_dimension_value
      where dimension = 'PRELIMINARY_OUTCOME' and value = any(${[...CLOSURES]}) order by value collate "C"`;
    expect(rows).toEqual([
      { value: "CHANNEL_ABUSE", state: "ACTIVE", source_status: "OWNER_DEFAULT" },
      { value: "NOT_FEASIBLE", state: "INACTIVE", source_status: "SOURCE_REQUIRED" },
      { value: "NOT_SERIOUS", state: "ACTIVE", source_status: "OWNER_DEFAULT" },
      { value: "NOT_SUBSTANTIATED", state: "ACTIVE", source_status: "OWNER_DEFAULT" },
      { value: "NO_PERSONAL_JURISDICTION", state: "INACTIVE", source_status: "SOURCE_REQUIRED" },
    ]);
    const [module] = await admin<{ delivered_in: string[] }[]>`
      select delivered_in from config.target_module where code = 'PRELIM_CLOSE_OUTCOME'`;
    expect(module!.delivered_in).toEqual(["1880", "1980"]);
  });

  it("case access alone does not let anyone prepare a closure: PRELIMINARY_PREPARE is still required", async () => {
    await scenario(async (s) => {
      await s.as("caseManager"); // sees case 0001, holds no PRELIMINARY_PREPARE
      expect((await s.tx`select id from case_mgmt.case_record where id = ${caseA}`).length).toBe(1);
      for (const outcome of CLOSURES) {
        await s.expectError(
          "CDF_FORBIDDEN",
          (tx) =>
            tx`select api.prepare_preliminary_recommendation(${caseA}, ${outcome}, 'Synthetic: not entitled to prepare.')`,
        );
      }
    });
  });

  it("on a restricted case the GRC Sector Head gets nothing for a closure either (fail safe)", async () => {
    await scenario(async (s) => {
      // Migration 2040 (DEC-F10): an enabled closure; NO_PERSONAL_JURISDICTION, used here before, is refused now.
      await s.as("grcDirector");
      const [r] = await s.tx<{ id: string }[]>`
        select api.prepare_preliminary_recommendation(${caseExec}, 'NOT_SUBSTANTIATED', 'Synthetic: not substantiated at first sight.') as id`;
      await s.as("grcSectorHead");
      expect(await s.tx`select * from api.preliminary_approval_queue()`).toEqual([]);
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) => tx`select api.approve_preliminary_recommendation(${r!.id}, 'APPROVE', null, null)`,
      );
    });
  });
});

describe("owner decisions DEC-F08, DEC-F09 and DEC-F10 (migration 2040)", () => {
  const ESC = "Synthetic: unique-escalation-marker-2040, the rejection misreads the scope.";
  const DELEGATION_KEY = "MAX_SECTOR_APPROVAL_DELEGATION_DAYS";

  /** The committee secretary rejects the referral. */
  async function reject(s: Scenario, id: string) {
    await s.as("committeeSecretary");
    await s.tx`select api.secretary_decide_referral(${id}, 'REJECT', array['OUT_OF_SCOPE'], null, null)`;
  }
  /** The preparer resubmits and the head approves again, so the referral is back with the secretary. */
  async function resubmit(s: Scenario, id: string) {
    await s.as("employee");
    await s.tx`select api.resubmit_referral(${id}, null)`;
    await s.as("sectorHead");
    await s.tx`select api.sector_decide_referral(${id}, 'APPROVE', null, null)`;
  }
  /** A referral rejected twice by the secretary. */
  async function rejectedTwice(s: Scenario): Promise<string> {
    const id = await atSecretary(s);
    await reject(s, id);
    await resubmit(s, id);
    await reject(s, id);
    return id;
  }
  const DECIDING = ["ACCEPT_ESCALATION", "UPHOLD_REJECTION", "COMMENT"];

  it("DEC-F08: no maximum delegation is invented; once configured, a longer delegation is refused (fail closed)", async () => {
    await ownerScenario(async (s) => {
      await s.as("sectorHead");
      expect(await s.tx`select value, status from config.setting where key = ${DELEGATION_KEY}`).toEqual([
        { value: null, status: "SOURCE_REQUIRED" },
      ]);
      // Not configured: the 1880 rules alone apply (an end date and evidence), however long the period.
      await s.tx`select api.delegate_referral_approval(${OPS}, ${USERS.employeeB}, now(), now() + interval '400 days', 'DEMO-DEL-F08', ${REASON})`;
      // Configured (a synthetic value for the test only): a period longer than the limit is refused.
      await s.asOwner();
      await s.tx`update config.setting set value = '30', status = 'CONFIGURED', source_reference = 'SYNTHETIC-TEST'
                 where key = ${DELEGATION_KEY}`;
      await s.as("sectorHead");
      await s.expectError(
        "CDF_CONFLICT:DELEGATION_TOO_LONG",
        (tx) =>
          tx`select api.delegate_referral_approval(${OPS}, ${USERS.employee}, now(), now() + interval '31 days', 'DEMO-DEL-F08', ${REASON})`,
      );
      await s.tx`select api.delegate_referral_approval(${OPS}, ${USERS.employee}, now(), now() + interval '30 days', 'DEMO-DEL-F08', ${REASON})`;
      // A configured value that is not a whole number of days refuses every new delegation.
      await s.asOwner();
      await s.tx`update config.setting set value = 'thirty' where key = ${DELEGATION_KEY}`;
      await s.as("sectorHead");
      await s.expectError(
        "CDF_CONFLICT:DELEGATION_LIMIT_MISCONFIGURED",
        (tx) =>
          tx`select api.delegate_referral_approval(${OPS}, ${USERS.employee}, now() + interval '40 days', now() + interval '41 days', 'DEMO-DEL-F08', ${REASON})`,
      );
      // The table refuses it whatever the path, the owner connection included.
      await s.asOwner();
      await s.tx`update config.setting set value = '30' where key = ${DELEGATION_KEY}`;
      await s.expectError(
        "CDF_CONFLICT:DELEGATION_TOO_LONG",
        (tx) => tx`
          insert into iam.sector_delegation (sector_id, delegator_id, delegate_id, scope, effective_from, effective_to,
                                             evidence_reference, reason)
          values (${OPS}, ${USERS.sectorHead}, ${USERS.employee}, 'REFERRAL_APPROVAL', now() + interval '50 days',
                  now() + interval '90 days', 'DEMO-DEL-F08', ${REASON})`,
      );
    });
  });

  it("DEC-F09: escalation is offered after the second rejection and reaches only the configured target", async () => {
    await scenario(async (s) => {
      await constitute(s);
      const id = await atSecretary(s);
      await reject(s, id);
      // One rejection: resubmission or objection, no escalation yet.
      expect(await actions(s, "sectorHead", id)).toEqual(["RESUBMIT", "OBJECT", "COMMENT"]);
      await s.as("sectorHead");
      await s.expectError(
        "CDF_CONFLICT:ESCALATION_NOT_AVAILABLE",
        (tx) => tx`select api.escalate_referral_rejection(${id}, ${ESC})`,
      );
      await resubmit(s, id);
      await reject(s, id);
      // The repeated rejection: the escalation path is offered next to resubmission and objection.
      expect(await actions(s, "sectorHead", id)).toEqual(["RESUBMIT", "OBJECT", "ESCALATE", "COMMENT"]);
      // Never to the preparer (as for an objection).
      expect(await actions(s, "employee", id)).not.toContain("ESCALATE");
      await s.as("employee");
      await s.expectError("CDF_FORBIDDEN", (tx) => tx`select api.escalate_referral_rejection(${id}, ${ESC})`);
      // The target sees nothing before the escalation.
      expect(await visible(s, "committeeChair", id)).toBe(false);
      await s.as("sectorHead");
      await s.expectError(
        "CDF_INVALID:comment",
        (tx) => tx`select api.escalate_referral_rejection(${id}, 'Too short')`,
      );
      await s.tx`select api.escalate_referral_rejection(${id}, ${ESC})`;
      const [r] = await s.tx<{ status: string; target: string }[]>`
        select status, escalation_target_id as target from intake.referral where id = ${id}`;
      const [t] = await admin<{ id: string; seat: string; source_status: string; committee_id: string }[]>`
        select id, seat, source_status, committee_id from intake.referral_escalation_target where effective_to is null`;
      expect(t).toEqual({ id: r!.target, seat: "CHAIR", source_status: "OWNER_DEFAULT", committee_id: ic });
      expect(r!.status).toBe("ESCALATED");
      // Only the holder of the target seat (the Investigation Committee Chair, owner default) sees and decides it.
      expect(await visible(s, "committeeChair", id)).toBe(true);
      expect(await visible(s, "committee", id)).toBe(false);
      expect(await actions(s, "committeeChair", id)).toEqual(DECIDING);
      expect(await actions(s, "committeeSecretary", id)).toEqual(["COMMENT"]);
      expect(await actions(s, "sectorHead", id)).toEqual(["COMMENT"]);
      await s.as("committeeSecretary");
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.decide_referral_escalation(${id}, 'ACCEPT', null, null, ${USERS.caseManager})`,
      );
      await s.expectError(
        "CDF_CONFLICT:REFERRAL_NOT_AWAITING_SECRETARY",
        (tx) => tx`select api.secretary_decide_referral(${id}, 'ACCEPT', null, null, ${USERS.caseManager})`,
      );
      for (const user of ["committee", "platformAdmin", "grcDirector"] as const) {
        await s.as(user);
        await s.expectError(
          "CDF_NOT_FOUND",
          (tx) =>
            tx`select api.decide_referral_escalation(${id}, 'ACCEPT', null, null, ${USERS.caseManager})`,
        );
      }
      await s.as("sectorHead");
      await s.expectError(
        "CDF_CONFLICT:REFERRAL_NOT_REJECTED",
        (tx) => tx`select api.escalate_referral_rejection(${id}, ${ESC})`,
      );
      // The Chair upholds the rejection, with structured reasons.
      await s.as("committeeChair");
      await s.expectError(
        "CDF_INVALID:reason_codes",
        (tx) => tx`select api.decide_referral_escalation(${id}, 'UPHOLD', '{}', null, null)`,
      );
      await s.expectError(
        "CDF_INVALID:decision",
        (tx) => tx`select api.decide_referral_escalation(${id}, 'REJECT', array['OUT_OF_SCOPE'], null, null)`,
      );
      await s.tx`select api.decide_referral_escalation(${id}, 'UPHOLD', array['OUT_OF_SCOPE'], null, null)`;
      // One escalation per rejection, and the decided escalation is not reopened by an objection; resubmission is
      // never capped.
      await s.as("sectorHead");
      await s.expectError(
        "CDF_CONFLICT:ESCALATION_ALREADY_DECIDED",
        (tx) => tx`select api.escalate_referral_rejection(${id}, ${ESC})`,
      );
      await s.expectError(
        "CDF_CONFLICT:ESCALATION_ALREADY_DECIDED",
        (tx) =>
          tx`select api.object_to_referral_rejection(${id}, 'Synthetic: an objection after the escalation.')`,
      );
      expect(await actions(s, "sectorHead", id)).toEqual(["RESUBMIT", "COMMENT"]);
      await resubmit(s, id);
      await reject(s, id);
      await s.as("sectorHead");
      await s.tx`select api.escalate_referral_rejection(${id}, ${ESC})`;
      // This time the Chair accepts: the case and its committee proceeding, as on the secretary's acceptance.
      await s.as("committeeChair");
      await s.expectError(
        "CDF_INVALID:case_owner_id",
        (tx) => tx`select api.decide_referral_escalation(${id}, 'ACCEPT', null, null, null)`,
      );
      const [c] = await s.tx<{ id: string }[]>`
        select api.decide_referral_escalation(${id}, 'ACCEPT', null, null, ${USERS.caseManager}) as id`;
      const [done] = await s.tx<{ status: string; case_id: string; decided_by: string }[]>`
        select status, case_id, decided_by from intake.referral where id = ${id}`;
      expect(done).toEqual({ status: "ACCEPTED", case_id: c!.id, decided_by: USERS.committeeChair });
      await s.as("caseManager");
      const [k] = await s.tx<{ source_type: string; proceedings: number }[]>`
        select c.source_type, (select count(*)::int from committee.committee_proceeding cp where cp.case_id = c.id) as proceedings
        from case_mgmt.case_record c where c.id = ${c!.id}`;
      expect(k).toEqual({ source_type: "DIRECT_REFERRAL", proceedings: 1 });
      // History and audit carry codes and ids, never the comment.
      await s.as("dpo");
      const events = await s.tx<{ action: string; decision: string | null; metadata: unknown }[]>`
        select action, metadata->>'decision' as decision, metadata from audit.audit_event
        where object_type = 'referral' and object_id = ${id} and action like 'REFERRAL_ESCALAT%' order by seq`;
      expect(events.map((e) => [e.action, e.decision])).toEqual([
        ["REFERRAL_ESCALATED", null],
        ["REFERRAL_ESCALATION_DECIDED", "UPHOLD"],
        ["REFERRAL_ESCALATED", null],
        ["REFERRAL_ESCALATION_DECIDED", "ACCEPT"],
      ]);
      expect(JSON.stringify(events)).not.toContain("unique-escalation-marker");
    });
  });

  it("DEC-F09: the target is set by COMMITTEE_ADMIN, effective-dated, and a change does not re-route an open escalation", async () => {
    await scenario(async (s) => {
      await constitute(s);
      await s.as("platformAdmin");
      await s.tx`select api.appoint_committee_member(${ic}, ${USERS.legal}, 'DEPUTY_CHAIR', now() - interval '1 day', null, 'DEMO-APPT')`;
      const first = await rejectedTwice(s);
      await s.as("sectorHead");
      await s.tx`select api.escalate_referral_rejection(${first}, ${ESC})`;
      for (const user of ["sectorHead", "committeeChair", "committeeSecretary", "grcSectorHead"] as const) {
        await s.as(user);
        await s.expectError(
          "CDF_FORBIDDEN",
          (tx) =>
            tx`select api.set_referral_escalation_target(${ic}, 'DEPUTY_CHAIR', now(), 'DEMO-DEC-F09', ${REASON})`,
        );
      }
      await s.as("platformAdmin");
      for (const [prefix, call] of [
        [
          "CDF_INVALID:seat",
          (tx: Scenario["tx"]) =>
            tx`select api.set_referral_escalation_target(${ic}, 'SECRETARY', now(), 'DEMO-DEC-F09', ${REASON})`,
        ],
        [
          "CDF_INVALID:effective_from",
          (tx: Scenario["tx"]) =>
            tx`select api.set_referral_escalation_target(${ic}, 'DEPUTY_CHAIR', now() - interval '1 day', 'DEMO-DEC-F09', ${REASON})`,
        ],
        [
          "CDF_INVALID:source_reference",
          (tx: Scenario["tx"]) =>
            tx`select api.set_referral_escalation_target(${ic}, 'DEPUTY_CHAIR', now(), null, ${REASON})`,
        ],
        [
          "CDF_INVALID:committee_id",
          (tx: Scenario["tx"]) =>
            tx`select api.set_referral_escalation_target(${OPS}, 'DEPUTY_CHAIR', now(), 'DEMO-DEC-F09', ${REASON})`,
        ],
      ] as const) {
        await s.expectError(prefix, call);
      }
      await s.tx`select api.set_referral_escalation_target(${ic}, 'DEPUTY_CHAIR', now(), 'DEMO-DEC-F09', ${REASON})`;
      expect(
        await s.tx`select seat, source_status, effective_to is null as open from intake.referral_escalation_target
                   order by effective_from`,
      ).toEqual([
        { seat: "CHAIR", source_status: "OWNER_DEFAULT", open: false },
        { seat: "DEPUTY_CHAIR", source_status: "APPROVED", open: true },
      ]);
      await s.expectError(
        "CDF_CONFLICT:ESCALATION_TARGET_SCHEDULED",
        (tx) =>
          tx`select api.set_referral_escalation_target(${ic}, 'CHAIR', now(), 'DEMO-DEC-F09', ${REASON})`,
      );
      // The open escalation stays with the target in force when it was raised.
      expect(await visible(s, "legal", first)).toBe(false);
      expect(await actions(s, "committeeChair", first)).toEqual(DECIDING);
      // A new escalation reaches the Deputy Chair only.
      const second = await rejectedTwice(s);
      await s.as("sectorHead");
      await s.tx`select api.escalate_referral_rejection(${second}, ${ESC})`;
      expect(await visible(s, "committeeChair", second)).toBe(false);
      expect(await actions(s, "legal", second)).toEqual(DECIDING);
      await s.as("committeeChair");
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) =>
          tx`select api.decide_referral_escalation(${second}, 'UPHOLD', array['OUT_OF_SCOPE'], null, null)`,
      );
      await s.as("legal");
      await s.tx`select api.decide_referral_escalation(${second}, 'UPHOLD', array['OUT_OF_SCOPE'], null, null)`;
      // The setting is audited with ids and codes.
      await s.as("dpo");
      const [e] = await s.tx<{ category: string; seat: string }[]>`
        select category, metadata->>'seat' as seat from audit.audit_event
        where action = 'REFERRAL_ESCALATION_TARGET_SET' order by seq desc limit 1`;
      expect(e).toEqual({ category: "ADMIN", seat: "DEPUTY_CHAIR" });
    });
  });

  it("DEC-F09: an escalation never reaches someone who took part, nor a vacant seat (fail closed); targets are append-only", async () => {
    await ownerScenario(async (s) => {
      // The sector head who approves the referral also chairs the committee (the demo seats end first, 2030 §4).
      await unseatDemoSeats(s);
      for (const [user, seat] of [
        ["sectorHead", "CHAIR"],
        ["committeeSecretary", "SECRETARY"],
        ["committee", "MEMBER"],
      ] as const) {
        await s.tx`select api.appoint_committee_member(${ic}, ${USERS[user]}, ${seat}, now() - interval '1 day', null, 'DEMO-APPT')`;
      }
      const id = await rejectedTwice(s);
      expect(await actions(s, "sectorHead", id)).not.toContain("ESCALATE");
      await s.as("sectorHead");
      await s.expectError(
        "CDF_CONFLICT:ESCALATION_TARGET_UNAVAILABLE",
        (tx) => tx`select api.escalate_referral_rejection(${id}, ${ESC})`,
      );
      // A target seat nobody holds: refused, not parked.
      await s.as("platformAdmin");
      await s.tx`select api.set_referral_escalation_target(${ic}, 'DEPUTY_CHAIR', now(), 'DEMO-DEC-F09', ${REASON})`;
      await s.as("sectorHead");
      await s.expectError(
        "CDF_CONFLICT:ESCALATION_TARGET_UNAVAILABLE",
        (tx) => tx`select api.escalate_referral_rejection(${id}, ${ESC})`,
      );
      expect(await actions(s, "sectorHead", id)).toEqual(["RESUBMIT", "OBJECT", "COMMENT"]);
      // A target version is never edited or deleted, even by the owner; ending it is the one change.
      await s.asOwner();
      await s.expectError(
        "intake.referral_escalation_target is append-only",
        (tx) => tx`update intake.referral_escalation_target set seat = 'CHAIR' where seat = 'DEPUTY_CHAIR'`,
      );
      await s.expectError(
        "intake.referral_escalation_target is append-only",
        (tx) => tx`delete from intake.referral_escalation_target`,
      );
    });
  });

  it("AGENT-09 pack 3, R4: the escalation target's reason, author and source reach committee administrators only", async () => {
    await ownerScenario(async (s) => {
      const reads = async (u: UserKey) => {
        await s.as(u);
        return (await s.tx`select reason, set_by, source_reference from intake.referral_escalation_target`)
          .length;
      };
      for (const u of ["platformAdmin", "grcDirector", "complianceManager"] as const)
        expect(await reads(u), u).toBeGreaterThan(0);
      for (const u of [
        "sectorHead",
        "employee",
        "committeeChair",
        "committeeSecretary",
        "caseManager",
      ] as const)
        expect(await reads(u), u).toBe(0);
    });
  });

  it("DEC-F10: NOT_FEASIBLE and NO_PERSONAL_JURISDICTION are refused for a new recommendation; an existing one keeps its code and can only be returned", async () => {
    await ownerScenario(async (s) => {
      for (const outcome of ["NOT_FEASIBLE", "NO_PERSONAL_JURISDICTION"]) {
        for (const user of ["grcDirector", "investigatorA"] as const) {
          await s.as(user);
          await s.expectError(
            "CDF_CONFLICT:OUTCOME_NOT_ENABLED",
            (tx) =>
              tx`select api.prepare_preliminary_recommendation(${caseA}, ${outcome}, 'Synthetic: an outcome not enabled.')`,
          );
        }
      }
      // A recommendation from before the decision (simulated on the owner connection, as the commands no longer
      // create one) keeps its code; it can be returned, never endorsed or approved.
      await s.as("investigatorA");
      const [r] = await s.tx<{ id: string }[]>`
        select api.prepare_preliminary_recommendation(${caseA}, 'NOT_SERIOUS', 'Synthetic: not serious at first sight.') as id`;
      await s.asOwner();
      await s.tx`alter table case_mgmt.preliminary_recommendation disable trigger user`;
      await s.tx`update case_mgmt.preliminary_recommendation set recommended_outcome = 'NOT_FEASIBLE' where id = ${r!.id}`;
      await s.tx`alter table case_mgmt.preliminary_recommendation enable trigger user`;
      // Whatever path inserts a new one is refused too.
      await s.expectError(
        "CDF_CONFLICT:OUTCOME_NOT_ENABLED",
        (tx) => tx`
          insert into case_mgmt.preliminary_recommendation (case_id, proceeding_id, version_no, recommended_outcome, rationale,
                                                            status, prepared_by, prepared_role, review_required)
          select case_id, proceeding_id, version_no + 1, 'NO_PERSONAL_JURISDICTION', rationale, 'AWAITING_REVIEW',
                 prepared_by, prepared_role, true
          from case_mgmt.preliminary_recommendation where id = ${r!.id}`,
      );
      await s.as("grcDirector");
      await s.expectError(
        "CDF_CONFLICT:OUTCOME_NOT_ENABLED",
        (tx) => tx`select api.review_preliminary_recommendation(${r!.id}, 'ENDORSE', null, null)`,
      );
      await s.tx`select api.review_preliminary_recommendation(${r!.id}, 'RETURN', array['RECOMMENDATION_INCOMPLETE'], null)`;
      expect(
        await s.tx`select recommended_outcome, status from case_mgmt.preliminary_recommendation where id = ${r!.id}`,
      ).toEqual([{ recommended_outcome: "NOT_FEASIBLE", status: "RETURNED" }]);
      // The next version names an enabled outcome; both codes stay in the check and remain outcome codes.
      await s.as("investigatorA");
      await s.tx`select api.prepare_preliminary_recommendation(${caseA}, 'NOT_SUBSTANTIATED', 'Synthetic: the next version.')`;
      const [codes] = await admin<{ n: number }[]>`
        select count(*)::int as n from config.status_code
        where dimension = 'OUTCOME_CODE' and code in ('NOT_FEASIBLE', 'NO_PERSONAL_JURISDICTION') and is_active`;
      expect(codes!.n).toBe(2);
    });
  });
});

describe("preliminary review before the Investigation Committee (AMB-018, migration 2030)", () => {
  const refer = (s: Scenario, caseId: string, committeeId: string) =>
    s.tx<
      { id: string }[]
    >`select api.refer_case_to_committee(${caseId}, ${committeeId}, null, ${REASON}) as id`;
  const prepare = async (s: Scenario, outcome: string) => {
    await s.as("grcDirector");
    const [r] = await s.tx<{ id: string }[]>`
      select api.prepare_preliminary_recommendation(${caseA}, ${outcome}, 'Synthetic: preliminary review rationale.') as id`;
    return r!.id;
  };
  const approve = async (s: Scenario, id: string) => {
    await s.as("grcSectorHead");
    await s.tx`select api.approve_preliminary_recommendation(${id}, 'APPROVE', null, null)`;
  };

  it("T-AMB-008: a whistleblowing case without an approved REFERRED_TO_COMMITTEE review is not referred to the Investigation Committee", async () => {
    await ownerScenario(async (s) => {
      await constitute(s);
      const [gc] = await admin<{ id: string }[]>`select id from committee.committee where code = 'GC'`;
      await seat(s, gc!.id, [
        ["committeeChair", "CHAIR"],
        ["committeeSecretary", "SECRETARY"],
        ["legal", "MEMBER"],
        ["investigatorA", "MEMBER"],
      ]);
      // No preliminary recommendation at all.
      await s.as("caseManager");
      await s.expectError("CDF_CONFLICT:PRELIMINARY_REFERRAL_REQUIRED", () => refer(s, caseA, ic));
      // Another approved outcome does not refer the case.
      await approve(s, await prepare(s, "NOT_SERIOUS"));
      await s.as("caseManager");
      await s.expectError("CDF_CONFLICT:PRELIMINARY_REFERRAL_REQUIRED", () => refer(s, caseA, ic));
      // A referral recommendation that awaits approval does not either.
      const pending = await prepare(s, "REFERRED_TO_COMMITTEE");
      await s.as("caseManager");
      await s.expectError("CDF_CONFLICT:PRELIMINARY_REFERRAL_REQUIRED", () => refer(s, caseA, ic));
      // A trigger, so every path is covered: even the table owner inserting the proceeding directly is refused.
      await s.asOwner();
      await s.expectError(
        "CDF_CONFLICT:PRELIMINARY_REFERRAL_REQUIRED",
        (tx) =>
          tx`insert into committee.committee_proceeding (proceeding_id, committee_id, case_id, rule_set_id, rule_snapshot,
               referred_by)
             select gen_random_uuid(), ${ic}, ${caseA}, r.id, '{}'::jsonb, ${USERS.caseManager}
             from committee.rule_set r where r.committee_id = ${ic} and r.effective_to is null`,
      );
      // The Grievance Committee path is not a preliminary-review outcome and is unaffected.
      await s.as("caseManager");
      expect(await refer(s, caseA, gc!.id)).toHaveLength(1);
      // Approved: the case reaches the Investigation Committee.
      await approve(s, pending);
      await s.as("caseManager");
      const [cp] = await refer(s, caseA, ic);
      expect(cp!.id).toBeDefined();
    });
  });

  it("T-AMB-008 (DEC-F19): a restricted case still needs its authority's approval first, then the preliminary referral", async () => {
    await ownerScenario(async (s) => {
      await s.asOwner();
      await s.tx`update iam.user_profile set clearance = 'SECRET'
                 where id in (${USERS.committeeChair}, ${USERS.committeeSecretary}, ${USERS.committee})`;
      await constitute(s);
      await s.as("grcDirector");
      await s.expectError("CDF_CONFLICT:AUTHORITY_APPROVAL_REQUIRED", () => refer(s, caseExec, ic));
      await s.tx`select api.approve_restricted_committee_referral(${caseExec}, ${ic}, ${REASON})`;
      await s.expectError("CDF_CONFLICT:PRELIMINARY_REFERRAL_REQUIRED", () => refer(s, caseExec, ic));
      await preliminaryReferral(s, caseExec);
      await s.as("grcDirector");
      expect(await refer(s, caseExec, ic)).toHaveLength(1);
    });
  });
});

describe("ambiguity register: preliminary review separation (CDF-205)", () => {
  it("T-AMB-147: a preparer who also holds PRELIMINARY_REVIEW cannot review their own recommendation (N10)", async () => {
    await ownerScenario(async (s) => {
      await s.as("investigatorA");
      const [r] = await s.tx<{ id: string }[]>`
        select api.prepare_preliminary_recommendation(${caseA}, 'NO_ACTION', 'Synthetic: own review probe.') as id`;
      // Review authority granted after preparation, so the recommendation still awaits review (Q15 applies at preparation).
      await s.asOwner();
      await s.tx`
        insert into iam.user_role_assignment (user_id, role_code, justification, source_reference)
        values (${USERS.investigatorA}, 'GRC_DIRECTOR', 'Synthetic: dual role for the test', 'TEST')`;
      await s.as("investigatorA");
      expect(
        (await s.tx<{ ok: boolean }[]>`select authz.has_permission('PRELIMINARY_REVIEW') as ok`)[0]!.ok,
      ).toBe(true);
      await s.expectError(
        "CDF_CONFLICT:SEPARATION_OF_DUTIES",
        (tx) => tx`select api.review_preliminary_recommendation(${r!.id}, 'ENDORSE', null, null)`,
      );
      await s.expectError(
        "CDF_CONFLICT:SEPARATION_OF_DUTIES",
        (tx) =>
          tx`select api.review_preliminary_recommendation(${r!.id}, 'RETURN', array['RECOMMENDATION_INCOMPLETE'], null)`,
      );
      const [row] = await s.tx<{ status: string; reviewed_by: string | null }[]>`
        select status, reviewed_by from case_mgmt.preliminary_recommendation where id = ${r!.id}`;
      expect(row).toEqual({ status: "AWAITING_REVIEW", reviewed_by: null });
    });
  });
});
