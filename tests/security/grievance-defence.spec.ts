// Business architecture rebase, migration 1910 (ADR-024; owner Q&A Q37, Q45–Q46, Q90–Q96; AUTHORIZATION_IMPACT.md N9).
// Each subject has their own defence path through the employee portal and reaches only their own notices; grievances
// are received by the Grievance Committee Secretary, linked or standalone, flagged when late, admitted by the decider
// the rule names, and decided by the Grievance Committee, whose proceeding keeps Investigation Committee voters out of
// its votes (N9).
import { beforeAll, describe, expect, it } from "vitest";
import { USERS, admin, caseId, ownerScenario, scenario, type Scenario } from "../support/db";
import {
  IC_SEATS,
  REASON,
  committeeIds,
  openItem,
  openWithPresent,
  refer,
  scheduleMeeting,
  seat,
  vote,
} from "../support/committee";
import { decidedForSubjects } from "../support/decision";
import {
  GRIEVANCE_GROUNDS,
  GRIEVANCE_SEATS,
  approvedGrievanceVote,
  concludeGrievanceProceeding,
  decisionNotice,
  executeSanction,
  fileOnNotice,
  oldDeliveryNotice,
  recordDelivery,
  setSanctionRule,
  thenUndo,
} from "../support/grievance";

let caseB: string, caseExec: string, ic: string, gc: string;

beforeAll(async () => {
  [caseB, caseExec] = await Promise.all([caseId("0002"), caseId("0003")]);
  ({ ic, gc } = await committeeIds());
});

/** Two subjects on case B with an allegation each; Sigma linked to employee, Tau to employeeB. */
async function twoSubjects(s: Scenario) {
  await s.as("caseManager");
  const ids: Record<string, string> = {};
  for (const [key, label] of [
    ["sigma", "Employee Sigma (synthetic)"],
    ["tau", "Employee Tau (synthetic)"],
  ] as const) {
    const [subj] = await s.tx<{ id: string }[]>`
      select api.add_case_subject(${caseB}, ${label}, 'EMPLOYEE', null) as id`;
    const [a] = await s.tx<{ id: string }[]>`
      select api.add_allegation(${caseB}, 'FRAUD', ${"Synthetic: allegation against " + label + "."}, ${subj!.id}, null, null) as id`;
    ids[key] = subj!.id;
    ids[key + "Allegation"] = a!.id;
  }
  const [l1] = await s.tx<{ id: string }[]>`
    select api.link_subject_portal_account(${ids.sigma!}, ${USERS.employee}, ${REASON}) as id`;
  const [l2] = await s.tx<{ id: string }[]>`
    select api.link_subject_portal_account(${ids.tau!}, ${USERS.employeeB}, ${REASON}) as id`;
  ids.sigmaLink = l1!.id;
  ids.tauLink = l2!.id;
  return ids;
}

const notice = (s: Scenario, subject: string, allegations: string[], due = "now() + interval '10 days'") =>
  s.tx`select api.issue_defence_notice(${subject}, 'Synthetic: you are invited to respond to the allegation below.',
    ${allegations}::uuid[], ${due === "past" ? new Date(Date.now() - 3600_000) : new Date(Date.now() + 10 * 86400_000)}) as id`;

const GC_SEATS: [Parameters<typeof seat>[2][number][0], string][] = [
  ["committee", "CHAIR"],
  ["committeeSecretary", "SECRETARY"],
  ["legal", "MEMBER"], // votes on the Investigation Committee too: firewalled on the grievance (N9)
  ["investigatorA", "MEMBER"],
];

describe("employee defence (Q90; employee rights)", () => {
  it("each subject reaches only their own notice and its permitted material, never the case", async () => {
    await scenario(async (s) => {
      const ids = await twoSubjects(s);
      // Links: never a case-team member, never twice, never by an outsider.
      await s.as("caseManager");
      const [third] = await s.tx<{ id: string }[]>`
        select api.add_case_subject(${caseB}, 'Employee Upsilon (synthetic)', 'EMPLOYEE', null) as id`;
      await s.expectError(
        "CDF_CONFLICT:SUBJECT_ON_CASE_TEAM",
        (tx) => tx`select api.link_subject_portal_account(${third!.id}, ${USERS.investigatorB}, ${REASON})`,
      );
      await s.expectError(
        "CDF_CONFLICT:ALREADY_LINKED",
        (tx) =>
          tx`select api.link_subject_portal_account(${ids.sigma!}, ${USERS.financeEmployee}, ${REASON})`,
      );
      await s.as("committee");
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) => tx`select api.link_subject_portal_account(${third!.id}, ${USERS.financeEmployee}, ${REASON})`,
      );

      await s.as("caseManager");
      await s.expectError("CDF_INVALID:allegation_ids", () => notice(s, ids.sigma!, [ids.tauAllegation!]));
      await s.expectError("CDF_INVALID:allegation_ids", () => notice(s, ids.sigma!, []));
      await s.expectError("CDF_INVALID:due_at", () => notice(s, ids.sigma!, [ids.sigmaAllegation!], "past"));
      const [n1] = await notice(s, ids.sigma!, [ids.sigmaAllegation!]);
      const [n2] = await notice(s, ids.tau!, [ids.tauAllegation!]);
      await s.as("committee");
      await s.expectError("CDF_NOT_FOUND", () => notice(s, ids.sigma!, [ids.sigmaAllegation!]));

      await s.as("employee");
      const [mine] = await s.tx<
        { n: { notice_id: string; items: { snapshot: { description: string } }[] }[] }[]
      >`
        select api.my_defence_notices() as n`;
      expect(mine!.n.map((x) => x.notice_id)).toEqual([(n1 as { id: string }).id]);
      expect(mine!.n[0]!.items.map((i) => i.snapshot.description)).toEqual([
        "Synthetic: allegation against Employee Sigma (synthetic).",
      ]);
      expect(await s.tx`select id from grievance.defence_notice`).toHaveLength(1);
      expect(await s.tx`select id from case_mgmt.case_record where id = ${caseB}`).toEqual([]);
      expect(await s.tx`select id from case_mgmt.allegation where case_id = ${caseB}`).toEqual([]);
      expect(await s.tx`select id from case_mgmt.case_subject where case_id = ${caseB}`).toEqual([]);
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) => tx`select api.acknowledge_defence_notice(${(n2 as { id: string }).id})`,
      );
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) => tx`select api.record_defence_response(${(n1 as { id: string }).id}, 'EMAIL', now(),
                     'Synthetic: my response by email.', 'EMAIL-DEMO-0001')`,
      );
      await s.tx`select api.acknowledge_defence_notice(${(n1 as { id: string }).id})`;
      await s.tx`select api.submit_defence_response(${(n1 as { id: string }).id}, 'Synthetic: my response to the allegation.')`;
      await s.expectError(
        "CDF_CONFLICT:NOTICE_NOT_OPEN",
        (tx) =>
          tx`select api.submit_defence_response(${(n1 as { id: string }).id}, 'Synthetic: a second response.')`,
      );

      // A response received by email is recorded by the issuer side with its original date and reference.
      await s.as("caseManager");
      await s.expectError(
        "CDF_INVALID:original_document_reference",
        (tx) => tx`select api.record_defence_response(${(n2 as { id: string }).id}, 'EMAIL', now(),
                     'Synthetic: response received by email.', null)`,
      );
      await s.tx`select api.record_defence_response(${(n2 as { id: string }).id}, 'EMAIL', now(),
                   'Synthetic: response received by email.', 'EMAIL-DEMO-0002')`;
      const responses = await s.tx<{ channel: string; is_late: boolean }[]>`
        select channel, is_late from grievance.defence_response order by channel`;
      expect(responses).toEqual([
        { channel: "EMAIL", is_late: false },
        { channel: "EMPLOYEE_PORTAL", is_late: false },
      ]);

      // Revoked: the employee reaches nothing.
      await s.tx`select api.revoke_subject_portal_link(${ids.sigmaLink!}, ${REASON})`;
      await s.as("employee");
      expect(await s.tx`select id from grievance.defence_notice`).toEqual([]);
      expect(await s.tx`select id from grievance.defence_response`).toEqual([]);
      const [after] = await s.tx<{ n: unknown[] }[]>`select api.my_defence_notices() as n`;
      expect(after!.n).toEqual([]);
    });
  });
});

describe("grievances (Q91–Q96, N9)", () => {
  it("a linked grievance from the portal is flagged late, admitted by the secretary and keeps IC voters out (N9)", async () => {
    await ownerScenario(async (s) => {
      const ids = await twoSubjects(s);
      await seat(s, ic, IC_SEATS);
      await seat(s, gc, GC_SEATS);
      await refer(s, ic, caseB); // legal holds a voting seat on the case's Investigation Committee proceeding

      await s.as("employee");
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) =>
          tx`select api.file_grievance(${ids.tauLink!}, now() - interval '40 days', 'Synthetic: grievance grounds.')`,
      );
      const [g] = await s.tx<{ id: string }[]>`
        select api.file_grievance(${ids.sigmaLink!}, now() - interval '40 days',
          'Synthetic: the sanction ignored my response.') as id`;
      await s.expectError(
        "CDF_CONFLICT:GRIEVANCE_OPEN",
        (tx) =>
          tx`select api.file_grievance(${ids.sigmaLink!}, now() - interval '1 day', 'Synthetic: again.')`,
      );
      const [mine] = await s.tx<{ is_late: boolean; window_days: number; status: string }[]>`
        select is_late, window_days, status from grievance.grievance`;
      expect(mine).toEqual({ is_late: true, window_days: 30, status: "RECEIVED" });

      // Received first by the GC Secretary; nobody else on the committee sees it before admission.
      for (const u of ["legal", "investigatorA", "committee", "employeeB"] as const) {
        await s.as(u);
        expect(await s.tx`select id from grievance.grievance`, u).toEqual([]);
      }
      await s.as("committee");
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) => tx`select api.assess_grievance_admissibility(${g!.id}, 'ADMISSIBLE', null, ${REASON})`,
      );
      await s.as("committeeSecretary");
      expect(
        (
          await s.tx<{ r: string }[]>`
          select api.assess_grievance_admissibility(${g!.id}, 'ADMISSIBLE', 'Synthetic: refer to the committee.', ${REASON}) as r`
        )[0]!.r,
      ).toBe("ADMITTED");
      const [row] = await s.tx<{ committee_proceeding_id: string }[]>`
        select committee_proceeding_id from grievance.grievance where id = ${g!.id}`;
      await s.asOwner();
      const members = await s.tx<{ user_id: string; is_voting: boolean; firewall_restricted: boolean }[]>`
        select user_id, is_voting, firewall_restricted from committee.proceeding_member
        where committee_proceeding_id = ${row!.committee_proceeding_id}`;
      expect(members.find((m) => m.user_id === USERS.legal)).toMatchObject({
        is_voting: false,
        firewall_restricted: true,
      });
      expect(members.find((m) => m.user_id === USERS.investigatorA)).toMatchObject({ is_voting: true });

      // The grievant sees their grievance, not the internal assessment.
      await s.as("employee");
      expect(await s.tx`select id from grievance.grievance`).toHaveLength(1);
      expect(await s.tx`select id from grievance.admissibility_assessment`).toEqual([]);

      // The Grievance Committee decides by vote; outcomes combine unless they contradict.
      await s.as("committeeSecretary");
      const [m] = await s.tx<{ id: string }[]>`
        select api.schedule_meeting(${row!.committee_proceeding_id}, 'DELIBERATION', 'IN_PERSON', 'Room (synthetic)', null,
          now() + interval '1 day', now() + interval '1 day 1 hour', ${REASON}) as id`;
      const parts = await s.tx<{ id: string; user_id: string; is_voting: boolean }[]>`
        select id, user_id, is_voting from committee.meeting_participant where meeting_id = ${m!.id}`;
      expect(parts.map((p) => p.user_id)).not.toContain(USERS.legal);
      const voters = parts.filter((p) => p.is_voting);
      for (const p of voters) {
        await s.as(p.user_id === USERS.committee ? "committee" : "investigatorA");
        await s.tx`select api.declare_meeting_conflict(${p.id}, 'NO_CONFLICT', null)`;
      }
      await s.as("committeeSecretary");
      await s.tx`select api.open_meeting(${m!.id}, ${REASON})`;
      for (const p of voters) await s.tx`select api.record_attendance(${p.id}, 'PRESENT')`;
      const [vi] = await s.tx<{ id: string }[]>`
        select api.open_vote_item(${m!.id}, 'OTHER', null, 'Grievance outcome (synthetic)') as id`;
      for (const p of voters) {
        await s.as(p.user_id === USERS.committee ? "committee" : "investigatorA");
        await s.tx`select api.cast_vote(${vi!.id}, 'APPROVE', null)`;
      }
      await s.as("committeeSecretary");
      await s.tx`select api.close_vote_item(${vi!.id}, null)`;
      const outcome = (outcomes: string[], path: string | null) =>
        s.tx`select api.record_grievance_outcome(${g!.id}, ${outcomes}::text[], ${path}, ${vi!.id},
          'Synthetic: outcome summary for the grievance.') as id`;
      await s.expectError("CDF_INVALID:outcomes", () => outcome(["UPHOLD", "CANCEL"], null));
      await s.expectError("CDF_INVALID:outcomes", () => outcome(["MODIFY", "CANCEL"], null));
      await s.expectError("CDF_INVALID:outcomes", () => outcome(["INADMISSIBLE"], null));
      await s.expectError("CDF_INVALID:reinvestigation_path", () =>
        outcome(["RETURN_FOR_REINVESTIGATION"], null),
      );
      await s.expectError("CDF_INVALID:reinvestigation_path", () => outcome(["MODIFY"], "NEW_INVESTIGATOR"));
      await outcome(["MODIFY", "RETURN_FOR_REINVESTIGATION"], "NEW_INVESTIGATOR");
      await s.asOwner();
      const [o] = await s.tx<{ parent: string; type: string; gc_proceeding: string }[]>`
        select p.parent_proceeding_id as parent, p.proceeding_type as type, cp.proceeding_id as gc_proceeding
        from grievance.grievance_outcome o
        join case_mgmt.proceeding p on p.id = o.reinvestigation_proceeding_id
        join grievance.grievance g on g.id = o.grievance_id
        join committee.committee_proceeding cp on cp.id = g.committee_proceeding_id
        where o.grievance_id = ${g!.id}`;
      expect(o!.type).toBe("REINVESTIGATION");
      expect(o!.parent).toBe(o!.gc_proceeding);
      await s.as("committeeSecretary");
      await s.expectError("CDF_CONFLICT:GRIEVANCE_NOT_ADMITTED", () => outcome(["UPHOLD"], null));
      await s.as("employee");
      expect(await s.tx`select outcomes from grievance.grievance_outcome`).toEqual([
        { outcomes: ["MODIFY", "RETURN_FOR_REINVESTIGATION"] },
      ]);
    });
  });

  it("the secretary records a standalone grievance as a new DIRECT_GRIEVANCE case (Q91)", async () => {
    await ownerScenario(async (s) => {
      await seat(s, gc, GC_SEATS);
      const record = (
        kind: string,
        number: string | null,
        classification: string | null,
        ref: string | null,
      ) =>
        s.tx`select api.record_grievance(${kind}, ${number}, 'Employee Phi (synthetic)',
          ${kind === "STANDALONE" ? "Performance evaluation grievance (synthetic)" : null},
          ${classification}::core.classification_level, ${kind === "STANDALONE" ? USERS.caseManager : null},
          'EMAIL', now() - interval '1 day', now() - interval '5 days', 'Synthetic: the evaluation ignored my work.',
          ${ref}) as id`;
      await s.as("caseManager");
      await s.expectError("CDF_FORBIDDEN", () =>
        record("STANDALONE", null, "CONFIDENTIAL", "EMAIL-DEMO-0003"),
      );
      await s.as("committeeSecretary");
      await s.expectError("CDF_INVALID:classification", () =>
        record("STANDALONE", null, "SECRET", "EMAIL-DEMO-0003"),
      );
      await s.expectError("CDF_INVALID:original_document_reference", () =>
        record("STANDALONE", null, "CONFIDENTIAL", null),
      );
      // An unknown number, and a case the secretary is not cleared for, answer alike.
      await s.expectError("CDF_NOT_FOUND", () =>
        record("LINKED", "CDF-DEMO-2026-9999", null, "EMAIL-DEMO-0003"),
      );
      const [exec] = await admin<
        { n: string }[]
      >`select case_number as n from case_mgmt.case_record where id = ${caseExec}`;
      await s.expectError("CDF_NOT_FOUND", () => record("LINKED", exec!.n, null, "EMAIL-DEMO-0003"));
      const [g] = await record("STANDALONE", null, "CONFIDENTIAL", "EMAIL-DEMO-0003");
      await s.asOwner();
      const [c] = await s.tx<{ source_type: string; owner_id: string; is_late: boolean }[]>`
        select c.source_type, c.owner_id, g.is_late from grievance.grievance g
        join case_mgmt.case_record c on c.id = g.case_id where g.id = ${(g as { id: string }).id}`;
      expect(c).toEqual({ source_type: "DIRECT_GRIEVANCE", owner_id: USERS.caseManager, is_late: false });
      await s.as("caseManager");
      expect(await s.tx`select id from grievance.grievance`).toHaveLength(1);
    });
  });

  it("under a CHAIR rule the chair decides admissibility; the secretary only assesses", async () => {
    await ownerScenario(async (s) => {
      await seat(s, gc, GC_SEATS);
      // 2040 (DEC-F16): the rule in force at the contested decision applies, so the CHAIR rule is in force from now and
      // the contested decision is dated now; the chair also decides a non-admission (DEC-F17).
      await s.as("platformAdmin");
      await s.tx`select api.revise_committee_rule_set(${gc}, now(),
                   '{"grievance_window_days": 10, "admissibility_decider": "CHAIR", "non_admission_decider": "CHAIR"}'::jsonb,
                   'APPROVED', ${REASON})`;
      await s.as("committeeSecretary");
      const [num] = await admin<
        { n: string }[]
      >`select case_number as n from case_mgmt.case_record where id = ${caseB}`;
      const [g] = await s.tx<{ id: string }[]>`
        select api.record_grievance('LINKED', ${num!.n}, 'Employee Sigma (synthetic)', null, null, null, 'PHYSICAL_SUBMISSION',
          now(), now(), 'Synthetic: grievance against the decision.',
          'LETTER-DEMO-0001') as id`;
      const [row] = await s.tx<{ is_late: boolean; window_days: number; admissibility_decider: string }[]>`
        select is_late, window_days, admissibility_decider from grievance.grievance where id = ${g!.id}`;
      expect(row).toEqual({ is_late: false, window_days: 10, admissibility_decider: "CHAIR" });
      expect(
        (
          await s.tx<{ r: string }[]>`
          select api.assess_grievance_admissibility(${g!.id}, 'INADMISSIBLE', null, ${REASON}) as r`
        )[0]!.r,
      ).toBe("AWAITING_ADMISSIBILITY_DECISION");
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.decide_grievance_admissibility(${g!.id}, 'INADMISSIBLE', null, ${REASON})`,
      );
      await s.as("investigatorA");
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) => tx`select api.decide_grievance_admissibility(${g!.id}, 'INADMISSIBLE', null, ${REASON})`,
      );
      await s.as("committee");
      expect(
        (
          await s.tx<{ r: string }[]>`
          select api.decide_grievance_admissibility(${g!.id}, 'INADMISSIBLE', null, ${REASON}) as r`
        )[0]!.r,
      ).toBe("INADMISSIBLE");
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) => tx`select api.decide_grievance_admissibility(${g!.id}, 'ADMISSIBLE', null, ${REASON})`,
      );
      await s.asOwner();
      const [after] = await s.tx<{ status: string; committee_proceeding_id: string | null }[]>`
        select status, committee_proceeding_id from grievance.grievance where id = ${g!.id}`;
      expect(after).toEqual({ status: "INADMISSIBLE", committee_proceeding_id: null });
    });
  });
});

describe("AGENT-09 review of 1910 (G1–G3, outcome vote binding)", () => {
  /** employee files a grievance through Sigma's link; the GC secretary admits it. Returns ids. */
  async function admitted(s: Scenario) {
    const ids = await twoSubjects(s);
    await s.as("employee");
    const [g] = await s.tx<{ id: string }[]>`
      select api.file_grievance(${ids.sigmaLink!}, now() - interval '1 day', 'Synthetic: grievance grounds.') as id`;
    await s.as("committeeSecretary");
    await s.tx`select api.assess_grievance_admissibility(${g!.id}, 'ADMISSIBLE', null, ${REASON})`;
    const [row] = await s.tx<{ cp: string }[]>`
      select committee_proceeding_id as cp from grievance.grievance where id = ${g!.id}`;
    return { ...ids, grievance: g!.id, gcProceeding: row!.cp };
  }

  it("a linked subject or grievant never sits on, sees or works their own case (G1)", async () => {
    await ownerScenario(async (s) => {
      await s.as("caseManager");
      const [upsilon] = await s.tx<{ id: string }[]>`
        select api.add_case_subject(${caseB}, 'Employee Upsilon (synthetic)', 'EMPLOYEE', null) as id`;
      await s.tx`select api.link_subject_portal_account(${upsilon!.id}, ${USERS.investigatorA}, ${REASON})`;
      await s.expectError(
        "CDF_CONFLICT:ASSIGNEE_HAS_CONFLICT",
        (tx) => tx`select api.assign_case(${caseB}, ${USERS.investigatorA}, 'INVESTIGATOR', ${REASON})`,
      );
      await seat(s, ic, [...IC_SEATS, ["investigatorA", "MEMBER"]]);
      const icp = await refer(s, ic, caseB);
      await seat(s, gc, GC_SEATS); // investigatorA also holds a GC member seat
      const f = await admitted(s);
      await s.asOwner();
      const rows = await s.tx<{ cp: string; is_voting: boolean; case_gate_excluded: boolean }[]>`
        select committee_proceeding_id as cp, is_voting, case_gate_excluded from committee.proceeding_member
        where user_id = ${USERS.investigatorA} order by committee_proceeding_id = ${icp}`;
      expect(rows.map((r) => [r.is_voting, r.case_gate_excluded])).toEqual([
        [false, true],
        [false, true],
      ]);
      for (const user of ["investigatorA", "employee"] as const) {
        await s.as(user);
        expect(await s.tx`select id from committee.committee_proceeding`, user).toEqual([]);
        expect(await s.tx`select id from grievance.admissibility_assessment`, user).toEqual([]);
        expect(await s.tx`select id from case_mgmt.case_record where id = ${caseB}`, user).toEqual([]);
      }
      // The grievant still follows their own grievance.
      await s.as("employee");
      expect((await s.tx<{ id: string }[]>`select id from grievance.grievance`).map((r) => r.id)).toEqual([
        f.grievance,
      ]);
    });
  });

  it("a linked grievance on a restricted case needs its authority's approval naming the recorder (G2)", async () => {
    await ownerScenario(async (s) => {
      await s.asOwner();
      await s.tx`update iam.user_profile set clearance = 'SECRET' where id = ${USERS.committeeSecretary}`;
      await seat(s, gc, GC_SEATS);
      const [exec] = await admin<
        { n: string }[]
      >`select case_number as n from case_mgmt.case_record where id = ${caseExec}`;
      const record = () =>
        s.tx`select api.record_grievance('LINKED', ${exec!.n}, 'Employee Psi (synthetic)', null, null, null, 'EMAIL',
          now(), now() - interval '2 days', 'Synthetic: restricted grievance grounds.', 'EMAIL-DEMO-0009') as id`;
      await s.as("committeeSecretary");
      await s.expectError("CDF_NOT_FOUND", () => record());
      const approve = (recorder: string) =>
        s.tx`select api.approve_restricted_grievance_recording(${caseExec}, ${recorder}, ${REASON}) as id`;
      await s.as("caseManager");
      await s.expectError("CDF_NOT_FOUND", () => approve(USERS.committeeSecretary));
      await s.as("grcDirector");
      await s.expectError("CDF_INVALID:recorder_id", () => approve(USERS.legal));
      await approve(USERS.committeeSecretary);
      await s.expectError("CDF_CONFLICT:APPROVAL_ALREADY_PENDING", () => approve(USERS.committeeSecretary));
      await s.as("committeeSecretary");
      await record();
      await s.expectError("CDF_NOT_FOUND", () => record());
    });
  });

  it("a Grievance Committee chair who sat on the case's Investigation Committee cannot decide admissibility (G3)", async () => {
    await scenario(async (s) => {
      await seat(s, ic, [...IC_SEATS, ["committee", "MEMBER"]]);
      await refer(s, ic, caseB);
      await seat(s, gc, GC_SEATS); // committee chairs the GC
      await s.as("platformAdmin");
      await s.tx`select api.set_committee_rule_set(${gc}, now(), 'MAJORITY_ELIGIBLE', null, true, 3, true, 30, 'CHAIR',
                   'NO_DECISION', 'SOURCE_REQUIRED', ${REASON})`;
      const [num] = await admin<
        { n: string }[]
      >`select case_number as n from case_mgmt.case_record where id = ${caseB}`;
      await s.as("committeeSecretary");
      const [g] = await s.tx<{ id: string }[]>`
        select api.record_grievance('LINKED', ${num!.n}, 'Employee Sigma (synthetic)', null, null, null, 'EMAIL',
          now(), now(), 'Synthetic: grievance grounds.', 'EMAIL-DEMO-0010') as id`;
      await s.tx`select api.assess_grievance_admissibility(${g!.id}, 'ADMISSIBLE', null, ${REASON})`;
      await s.as("committee");
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.decide_grievance_admissibility(${g!.id}, 'ADMISSIBLE', null, ${REASON})`,
      );
    });
  });

  it("an outcome needs an approved vote of the grievance's own proceeding", async () => {
    await scenario(async (s) => {
      await seat(s, ic, IC_SEATS);
      const icMeeting = await scheduleMeeting(s, ic, caseB);
      await openWithPresent(s, icMeeting, ["committeeChair", "legal", "legalB", "lead"]);
      const icItem = await openItem(s, icMeeting.meeting);
      for (const u of ["committeeChair", "legal", "legalB", "lead"] as const)
        await vote(s, u, icItem, "APPROVE");
      await s.as("committeeSecretary");
      await s.tx`select api.close_vote_item(${icItem}, null)`;

      await seat(s, gc, GC_SEATS);
      const f = await admitted(s);
      await s.as("committeeSecretary");
      const [m] = await s.tx<{ id: string }[]>`
        select api.schedule_meeting(${f.gcProceeding}, 'DELIBERATION', 'IN_PERSON', 'Room (synthetic)', null,
          now() + interval '1 day', now() + interval '1 day 1 hour', ${REASON}) as id`;
      const parts = await s.tx<{ id: string; user_id: string }[]>`
        select id, user_id from committee.meeting_participant where meeting_id = ${m!.id} and is_voting`;
      const key = (id: string) => (id === USERS.committee ? "committee" : "investigatorA");
      for (const p of parts) {
        await s.as(key(p.user_id));
        await s.tx`select api.declare_meeting_conflict(${p.id}, 'NO_CONFLICT', null)`;
      }
      await s.as("committeeSecretary");
      await s.tx`select api.open_meeting(${m!.id}, ${REASON})`;
      for (const p of parts) await s.tx`select api.record_attendance(${p.id}, 'PRESENT')`;
      const rejected = await openItem(s, m!.id, "Grievance outcome (synthetic)");
      for (const p of parts) await vote(s, key(p.user_id), rejected, "REJECT");
      await s.as("committeeSecretary");
      await s.tx`select api.close_vote_item(${rejected}, null)`;
      for (const item of [rejected, icItem]) {
        await s.expectError(
          "CDF_INVALID:vote_item_id",
          (tx) => tx`select api.record_grievance_outcome(${f.grievance}, ${["UPHOLD"]}::text[], null, ${item},
            'Synthetic: outcome summary for the grievance.')`,
        );
      }
    });
  });
});

describe("AGENT-09 re-check of 1910 (G2b, G3b, approval checks)", () => {
  const RESTRICTED_GC: [Parameters<typeof seat>[2][number][0], string][] = [
    ["committee", "CHAIR"],
    ["grcDeputy", "SECRETARY"],
    ["grcSectorHead", "ALTERNATE_SECRETARY"],
  ];
  const caseNumber = async (id: string) =>
    (await admin<{ n: string }[]>`select case_number as n from case_mgmt.case_record where id = ${id}`)[0]!.n;
  const visible = async (s: Scenario, grievance: string) =>
    (await s.tx`select id from grievance.grievance where id = ${grievance}`).length === 1;

  it("a portal grievance on a restricted case reaches a secretary only once its authority names them (G2b)", async () => {
    await ownerScenario(async (s) => {
      await seat(s, gc, RESTRICTED_GC);
      await s.as("grcDirector");
      const [subj] = await s.tx<{ id: string }[]>`
        select api.add_case_subject(${caseExec}, 'Employee Sigma (synthetic)', 'EMPLOYEE', null) as id`;
      const [l] = await s.tx<{ id: string }[]>`
        select api.link_subject_portal_account(${subj!.id}, ${USERS.employee}, ${REASON}) as id`;
      await s.as("employee");
      const [g] = await s.tx<{ id: string }[]>`
        select api.file_grievance(${l!.id}, now() - interval '2 days', 'Synthetic: grievance grounds.') as id`;
      for (const user of ["grcDeputy", "grcSectorHead"] as const) {
        await s.as(user);
        expect(await visible(s, g!.id), user).toBe(false);
        await s.expectError(
          "CDF_NOT_FOUND",
          (tx) => tx`select api.assess_grievance_admissibility(${g!.id}, 'INADMISSIBLE', null, ${REASON})`,
        );
      }
      await s.asOwner();
      const notices = await s.tx<{ recipient_id: string; template_code: string }[]>`
        select distinct recipient_id, template_code from notify.outbox where object_id = ${g!.id}`;
      expect(notices).toEqual([
        { recipient_id: USERS.grcDirector, template_code: "GRIEVANCE_AUTHORITY_APPROVAL_NEEDED" },
      ]);

      const approve = (secretary: string) =>
        s.tx`select api.approve_restricted_grievance_handling(${g!.id}, ${secretary}, ${REASON}) as id`;
      await s.as("caseManager");
      await s.expectError("CDF_NOT_FOUND", () => approve(USERS.grcDeputy));
      await s.as("grcDirector");
      await s.expectError("CDF_INVALID:secretary_id", () => approve(USERS.grcDirector));
      await approve(USERS.grcDeputy);
      await s.expectError("CDF_CONFLICT:ALREADY_APPROVED", () => approve(USERS.grcDeputy));
      await s.asOwner();
      const named = await s.tx<{ recipient_id: string }[]>`
        select distinct recipient_id from notify.outbox
        where object_id = ${g!.id} and template_code = 'GRIEVANCE_HANDLING_APPROVED'`;
      expect(named).toEqual([{ recipient_id: USERS.grcDeputy }]);
      await s.as("grcDeputy");
      expect(await visible(s, g!.id)).toBe(true);
      await s.tx`select api.assess_grievance_admissibility(${g!.id}, 'INADMISSIBLE', null, ${REASON})`;
      await s.as("grcSectorHead");
      expect(await visible(s, g!.id)).toBe(false);
    });
  });

  it("only the case owner holding the authority names a seated secretary cleared for the case (G2b)", async () => {
    await ownerScenario(async (s) => {
      await seat(s, gc, [
        ["committee", "CHAIR"],
        ["committeeSecretary", "SECRETARY"], // CONFIDENTIAL: not cleared for the SECRET case
        ["grcDeputy", "ALTERNATE_SECRETARY"],
      ]);
      await s.as("grcDirector");
      const [subj] = await s.tx<{ id: string }[]>`
        select api.add_case_subject(${caseExec}, 'Employee Sigma (synthetic)', 'EMPLOYEE', null) as id`;
      const [l] = await s.tx<{ id: string }[]>`
        select api.link_subject_portal_account(${subj!.id}, ${USERS.employee}, ${REASON}) as id`;
      await s.as("employee");
      const [g] = await s.tx<{ id: string }[]>`
        select api.file_grievance(${l!.id}, now() - interval '2 days', 'Synthetic: grievance grounds.') as id`;
      const approve = (secretary: string) =>
        s.tx`select api.approve_restricted_grievance_handling(${g!.id}, ${secretary}, ${REASON}) as id`;
      await s.as("grcDirector");
      await s.expectError("CDF_INVALID:secretary_id", () => approve(USERS.committeeSecretary)); // not cleared
      await s.expectError("CDF_INVALID:secretary_id", () => approve(USERS.grcSectorHead)); // cleared, holds no seat
      // grcDeputy works the case and holds the authority, but does not own the case.
      await s.tx`select api.grant_case_access(${caseExec}, ${USERS.grcDeputy}, 'CASE', ${REASON}, null)`;
      await s.as("grcDeputy");
      await s.expectError("CDF_FORBIDDEN", () => approve(USERS.grcDeputy));
      await s.as("grcDirector");
      await approve(USERS.grcDeputy);
    });
  });

  it("a recorded grievance on a restricted case is handled by its approved recorder only (G2b)", async () => {
    await ownerScenario(async (s) => {
      await seat(s, gc, RESTRICTED_GC);
      await s.as("grcDirector");
      await s.tx`select api.approve_restricted_grievance_recording(${caseExec}, ${USERS.grcDeputy}, ${REASON})`;
      await s.as("grcDeputy");
      const [g] = await s.tx<{ id: string }[]>`
        select api.record_grievance('LINKED', ${await caseNumber(caseExec)}, 'Employee Psi (synthetic)', null, null, null,
          'EMAIL', now(), now() - interval '2 days', 'Synthetic: restricted grievance grounds.', 'EMAIL-DEMO-0011') as id`;
      expect(await visible(s, g!.id)).toBe(true);
      await s.as("grcSectorHead");
      expect(await visible(s, g!.id)).toBe(false);
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) => tx`select api.assess_grievance_admissibility(${g!.id}, 'INADMISSIBLE', null, ${REASON})`,
      );
    });
  });

  it("a secretary who sat on the case's Investigation Committee does not assess its grievance (G3b, N9)", async () => {
    await scenario(async (s) => {
      await seat(s, ic, IC_SEATS); // legal is an IC voting member
      await refer(s, ic, caseB);
      await seat(s, gc, [
        ["committee", "CHAIR"],
        ["legal", "SECRETARY"],
        ["investigatorB", "ALTERNATE_SECRETARY"],
      ]);
      const ids = await twoSubjects(s);
      await s.as("employee");
      const [g] = await s.tx<{ id: string }[]>`
        select api.file_grievance(${ids.sigmaLink!}, now() - interval '1 day', 'Synthetic: grievance grounds.') as id`;
      await s.as("legal");
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.assess_grievance_admissibility(${g!.id}, 'INADMISSIBLE', null, ${REASON})`,
      );
      await s.as("investigatorB");
      await s.tx`select api.assess_grievance_admissibility(${g!.id}, 'ADMISSIBLE', null, ${REASON})`;
    });
  });

  it("a grievant stays conflicted for their case after their portal link is revoked (G1)", async () => {
    await ownerScenario(async (s) => {
      const ids = await twoSubjects(s);
      await s.as("employee");
      await s.tx`select api.file_grievance(${ids.sigmaLink!}, now() - interval '1 day', 'Synthetic: grievance grounds.')`;
      await s.as("caseManager");
      await s.tx`select api.revoke_subject_portal_link(${ids.sigmaLink!}, ${REASON})`;
      await s.asOwner();
      const [r] = await s.tx<
        { gate: boolean }[]
      >`select authz.user_case_gate(${USERS.employee}, ${caseB}) as gate`;
      expect(r!.gate).toBe(false);
    });
  });

  it("only the case owner holding the authority approves, and only a seated, cleared secretary is named (G2)", async () => {
    await ownerScenario(async (s) => {
      await seat(s, gc, [
        ["committee", "CHAIR"],
        ["committeeSecretary", "SECRETARY"], // CONFIDENTIAL: not cleared for the SECRET case
        ["grcDeputy", "ALTERNATE_SECRETARY"],
      ]);
      const approve = (recorder: string) =>
        s.tx`select api.approve_restricted_grievance_recording(${caseExec}, ${recorder}, ${REASON}) as id`;
      await s.as("grcDirector");
      await s.tx`select api.grant_case_access(${caseExec}, ${USERS.grcDeputy}, 'CASE', ${REASON}, null)`;
      await s.expectError("CDF_INVALID:recorder_id", () => approve(USERS.committeeSecretary));
      await s.expectError("CDF_INVALID:recorder_id", () => approve(USERS.grcSectorHead)); // cleared, holds no seat
      // grcDeputy works the case and holds the authority, but does not own the case.
      await s.as("grcDeputy");
      await s.expectError("CDF_FORBIDDEN", () => approve(USERS.grcDeputy));
      await s.expectError("CDF_FORBIDDEN", () => approve(USERS.grcSectorHead));
    });
  });
});

// Migration 2040, owner decisions of 2026-10-13 on grievances and sanctions: DEC-AMB-004 (the grievance effect on
// execution, per sanction type), DEC-AMB-001 (one reconsideration on new evidence) and DEC-AMB-011 (an outcome never
// makes a sanction more severe). The catalogue's configuration is SOURCE_REQUIRED; the tests configure synthetic values
// through api.set_sanction_rule and never through the owner connection.
describe("DEC-AMB-004, DEC-AMB-001, DEC-AMB-011 (owner, 2026-10-13)", () => {
  const executability = async (s: Scenario) => {
    await s.as("caseManager");
    const [r] = await s.tx<{ v: { item_id: string; blocked_by: string | null; executable: boolean }[] }[]>`
      select api.sanction_executability(${caseB}) as v`;
    return r!.v.map((x) => ({ item_id: x.item_id, blocked_by: x.blocked_by, executable: x.executable }));
  };
  const outcomeWith = (s: Scenario, grievance: string, vi: string) => (outcomes: string[], subs: unknown) =>
    s.tx`select api.record_grievance_outcome(${grievance}, ${outcomes}::text[], null, ${vi},
      'Synthetic: outcome summary for the grievance.', ${subs === null ? null : s.tx.json(subs as never)}) as id`;
  const reconsider = (s: Scenario, g: string, description: string | null, reference: string | null) =>
    s.tx<{ id: string }[]>`
      select api.file_grievance_reconsideration(${g}, ${GRIEVANCE_GROUNDS}, ${description}, ${reference}) as id`;
  const EVIDENCE = "Synthetic: a payroll record not available at the first grievance.";

  it("T-AMB-063: the sanction rule is configured per type by the committee administrator, SOURCE_REQUIRED by default", async () => {
    await ownerScenario(async (s) => {
      await s.as("caseManager");
      expect(
        await s.tx`select code, severity_rank, is_irreversible, grievance_execution_rule, rule_source_status
                   from decision.sanction_catalogue order by code collate "C"`,
      ).toEqual(
        ["DEMOTION", "SALARY_DEDUCTION", "SUSPENSION", "TERMINATION", "WARNING"].map((code) => ({
          code,
          severity_rank: null,
          is_irreversible: code === "TERMINATION",
          grievance_execution_rule: null,
          rule_source_status: "SOURCE_REQUIRED",
        })),
      );
      const set = (
        code: string,
        rank: number | null,
        irreversible: boolean | null,
        rule: string | null,
        status = "APPROVED",
      ) =>
        s.tx`select api.set_sanction_rule(${code}, ${rank}::int, ${irreversible}::boolean, ${rule}, ${status},
          'Synthetic: sanction rule for the test only.',
          (select row_version from decision.sanction_catalogue where code = ${code}))`;
      for (const u of ["caseManager", "committeeSecretary", "committee", "lead"] as const) {
        await s.as(u);
        await s.expectError("CDF_FORBIDDEN", () => set("WARNING", 2, false, "PROCEED"));
      }
      await s.as("platformAdmin");
      await s.expectError("CDF_INVALID:code", () => set("NOPE_CODE", 2, false, "PROCEED"));
      await s.expectError("CDF_INVALID:severity_rank", () => set("WARNING", 0, false, "PROCEED"));
      await s.expectError("CDF_INVALID:is_irreversible", () => set("WARNING", 2, null, "PROCEED"));
      await s.expectError("CDF_INVALID:grievance_execution_rule", () => set("WARNING", 2, false, null));
      await s.expectError("CDF_INVALID:grievance_execution_rule", () =>
        set("WARNING", 2, false, "SOMETIMES"),
      );
      await s.expectError("CDF_INVALID:source_status", () => set("WARNING", 2, false, "PROCEED", "GUESSED"));
      await s.expectError("CDF_CONFLICT:IRREVERSIBLE_SANCTION_SUSPENDED", () =>
        set("TERMINATION", 5, true, "PROCEED"),
      );
      await set("WARNING", 2, false, "PROCEED");
      await s.asOwner();
      const [row] = await s.tx<{ change: string; n: number }[]>`
        select (select id::text from decision.sanction_rule_change) as change,
               (select count(*)::int from audit.audit_event e
                where e.action = 'SANCTION_RULE_SET' and e.object_id = 'WARNING'
                  and e.metadata ->> 'previous_grievance_execution_rule' is null
                  and e.metadata ->> 'grievance_execution_rule' = 'PROCEED') as n`;
      expect(row!.n).toBe(1);
      await s.expectError(
        "decision.sanction_rule_change is append-only",
        (tx) => tx`update decision.sanction_rule_change set severity_rank = 9`,
      );
      // The change history (with its reasons) is the committee administrator's; others read the catalogue only.
      await s.as("caseManager");
      expect(await s.tx`select id from decision.sanction_rule_change`).toEqual([]);
      await s.as("platformAdmin");
      expect(await s.tx`select id::text from decision.sanction_rule_change`).toEqual([{ id: row!.change }]);
      // Database guard: an irreversible sanction never proceeds, whatever writes the catalogue.
      await s.asOwner();
      await s.expectError(
        'new row for relation "sanction_catalogue" violates check constraint',
        (tx) =>
          tx`update decision.sanction_catalogue set grievance_execution_rule = 'PROCEED' where code = 'TERMINATION'`,
      );
    });
  });

  it("T-AMB-063: an irreversible type and a type with no rule are not executable in the grievance window; a reversible type follows its rule", async () => {
    await ownerScenario(async (s) => {
      const f = await decidedForSubjects(s, ic, caseB);
      const n = await decisionNotice(s, f.sigma, f.decision);
      await recordDelivery(s, n);
      // No rule (SOURCE_REQUIRED): held as irreversible.
      expect(await executability(s)).toEqual([
        { item_id: f.sanction, blocked_by: "GRIEVANCE_WINDOW_OPEN", executable: false },
      ]);
      await s.expectError("CDF_CONFLICT:GRIEVANCE_WINDOW_OPEN", () =>
        executeSanction(s, f.sanction, f.sigma),
      );
      // Irreversible: suspended.
      await setSanctionRule(s, "WARNING", null, true, "SUSPEND_UNTIL_RESOLVED");
      await s.as("caseManager");
      await s.expectError("CDF_CONFLICT:GRIEVANCE_WINDOW_OPEN", () =>
        executeSanction(s, f.sanction, f.sigma),
      );
      // Reversible, configured to wait: suspended.
      await setSanctionRule(s, "WARNING", null, false, "SUSPEND_UNTIL_RESOLVED");
      await s.as("caseManager");
      await s.expectError("CDF_CONFLICT:GRIEVANCE_WINDOW_OPEN", () =>
        executeSanction(s, f.sanction, f.sigma),
      );
      // Reversible, configured to proceed: executable during the window.
      await setSanctionRule(s, "WARNING", null, false, "PROCEED");
      expect(await executability(s)).toEqual([{ item_id: f.sanction, blocked_by: null, executable: true }]);
      await executeSanction(s, f.sanction, f.sigma);
      // Who may read the executability: the case team, not the platform administrator or another case's team.
      for (const u of ["platformAdmin", "investigatorA", "employee"] as const) {
        await s.as(u);
        await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.sanction_executability(${caseB})`);
      }
    });
  });

  it("T-AMB-063: an irreversible type and a type with no rule are not executable while a grievance on it is open, after the window", async () => {
    await ownerScenario(async (s) => {
      const f = await decidedForSubjects(s, ic, caseB);
      const old = await oldDeliveryNotice(s, caseB, gc, f.sigma, f.decision, 40);
      await recordDelivery(s, old, 35);
      await s.as("employee");
      const [g] = await fileOnNotice(s, old);
      // No rule: held as irreversible.
      expect(await executability(s)).toEqual([
        { item_id: f.sanction, blocked_by: "GRIEVANCE_OPEN", executable: false },
      ]);
      await s.expectError("CDF_CONFLICT:GRIEVANCE_OPEN", () => executeSanction(s, f.sanction, f.sigma));
      for (const [irreversible, rule] of [
        [true, "SUSPEND_UNTIL_RESOLVED"],
        [false, "SUSPEND_UNTIL_RESOLVED"],
      ] as const) {
        await setSanctionRule(s, "WARNING", null, irreversible, rule);
        await s.as("caseManager");
        await s.expectError("CDF_CONFLICT:GRIEVANCE_OPEN", () => executeSanction(s, f.sanction, f.sigma));
      }
      await setSanctionRule(s, "WARNING", null, false, "PROCEED");
      await s.as("caseManager");
      await thenUndo(s, () => executeSanction(s, f.sanction, f.sigma));
      // Resolved (here withdrawn): the irreversible type is executable once the window is over.
      await setSanctionRule(s, "WARNING", null, true, "SUSPEND_UNTIL_RESOLVED");
      await s.as("employee");
      await s.tx`select api.withdraw_grievance(${g!.id}, ${REASON})`;
      expect(await executability(s)).toEqual([{ item_id: f.sanction, blocked_by: null, executable: true }]);
      await executeSanction(s, f.sanction, f.sigma);
    });
  });

  it("T-AMB-063, DEC-AMB-003 (owner, 2026-10-13): a sanction of a package tainted by a conflict is not executable, whatever its rule", async () => {
    await ownerScenario(async (s) => {
      const f = await decidedForSubjects(s, ic, caseB);
      const n = await decisionNotice(s, f.sigma, f.decision);
      await recordDelivery(s, n);
      // Reversible and configured to proceed: nothing else holds it.
      await setSanctionRule(s, "WARNING", null, false, "PROCEED");
      expect(await executability(s)).toEqual([{ item_id: f.sanction, blocked_by: null, executable: true }]);
      // A conflict of a member whose vote counted comes to light after the decision: the package is tainted. (Owner
      // fixture: the case conflict as api.declare_conflict writes it; the committee member does not open the case.)
      await s.asOwner();
      await s.tx`insert into case_mgmt.conflict_check (case_id, user_id, status, declaration)
                 values (${caseB}, ${USERS.legal}, 'CONFLICT_DECLARED', 'Synthetic: came to light after the vote.')`;
      expect(await executability(s)).toEqual([
        { item_id: f.sanction, blocked_by: "TAINTED_BY_CONFLICT", executable: false },
      ]);
      await s.expectError("CDF_CONFLICT:TAINTED_BY_CONFLICT", () => executeSanction(s, f.sanction, f.sigma));
      // The guard is on the table: the owner connection is refused too.
      await s.asOwner();
      await s.expectError(
        "CDF_CONFLICT:TAINTED_BY_CONFLICT",
        (
          tx,
        ) => tx`insert into decision.sanction_execution (item_id, subject_id, case_id, authority_decision_id,
                     effective_from, execution_reference, recorded_by)
                   values (${f.sanction}, ${f.sigma}, ${caseB}, ${f.decision}, now(), 'HR-DEMO-2040',
                           ${USERS.caseManager})`,
      );
    });
  });

  it("T-AMB-085: exactly one reconsideration through the portal, on new evidence confirmed at admissibility; no third grievance", async () => {
    await ownerScenario(async (s) => {
      await seat(s, gc, GRIEVANCE_SEATS);
      const f = await decidedForSubjects(s, ic, caseB);
      const n = await decisionNotice(s, f.sigma, f.decision);
      await recordDelivery(s, n);
      await s.as("employee");
      const [g] = await fileOnNotice(s, n, [f.sanction]);
      await s.expectError("CDF_CONFLICT:GRIEVANCE_NOT_DECIDED", () =>
        reconsider(s, g!.id, EVIDENCE, "PAYROLL-DEMO-2040"),
      );
      await s.as("committeeSecretary");
      await s.tx`select api.assess_grievance_admissibility(${g!.id}, 'ADMISSIBLE', null, ${REASON})`;
      const vi = await approvedGrievanceVote(s, g!.id);
      await outcomeWith(s, g!.id, vi)(["UPHOLD"], null);

      // CDF-207 kept: a plain further grievance on the decided decision is refused.
      await s.as("employee");
      await s.expectError("CDF_CONFLICT:GRIEVANCE_ALREADY_DECIDED", () => fileOnNotice(s, n));
      // No new evidence, no reconsideration.
      await s.expectError("CDF_INVALID:new_evidence_description", () =>
        reconsider(s, g!.id, null, "PAYROLL-DEMO-2040"),
      );
      await s.expectError("CDF_INVALID:new_evidence_reference", () => reconsider(s, g!.id, EVIDENCE, null));
      await s.as("employeeB");
      await s.expectError("CDF_NOT_FOUND", () => reconsider(s, g!.id, EVIDENCE, "PAYROLL-DEMO-2040"));
      await s.as("caseManager");
      await s.expectError("CDF_FORBIDDEN", () => reconsider(s, g!.id, EVIDENCE, "PAYROLL-DEMO-2040"));
      await s.as("employee");
      const [r] = await reconsider(s, g!.id, EVIDENCE, "PAYROLL-DEMO-2040");
      await s.asOwner();
      expect(
        await s.tx`select reconsideration_of, status, is_late, channel, new_evidence_reference,
                          contested_authority_decision_id,
                          array(select item_id from grievance.contested_item c where c.grievance_id = g.id) as items
                   from grievance.grievance g where id = ${r!.id}`,
      ).toEqual([
        {
          reconsideration_of: g!.id,
          status: "RECEIVED",
          is_late: false,
          channel: "EMPLOYEE_PORTAL",
          new_evidence_reference: "PAYROLL-DEMO-2040",
          contested_authority_decision_id: f.decision,
          items: [f.sanction],
        },
      ]);

      // A second one is refused, by any path, while the reconsideration is open and after it.
      await s.as("employee");
      await s.expectError("CDF_CONFLICT:RECONSIDERATION_USED", () =>
        reconsider(s, g!.id, EVIDENCE, "PAYROLL-DEMO-2040-B"),
      );
      await s.expectError("CDF_CONFLICT:RECONSIDERATION_USED", () =>
        reconsider(s, r!.id, EVIDENCE, "PAYROLL-DEMO-2040-B"),
      );
      await s.expectError("CDF_CONFLICT:RECONSIDERATION_USED", () => fileOnNotice(s, n));
      await s.as("committeeSecretary");
      await s.expectError(
        "CDF_CONFLICT:RECONSIDERATION_USED",
        (tx) => tx`select api.record_grievance_reconsideration(${g!.id}, 'EMAIL', now(), ${GRIEVANCE_GROUNDS},
          'LETTER-DEMO-2040', ${EVIDENCE}, 'PAYROLL-DEMO-2040-C')`,
      );

      // Admissibility must confirm the evidence is new (fail closed).
      await s.expectError(
        "CDF_CONFLICT:NEW_EVIDENCE_NOT_CONFIRMED",
        (tx) => tx`select api.assess_grievance_admissibility(${r!.id}, 'ADMISSIBLE', null, ${REASON})`,
      );
      await s.expectError(
        "CDF_CONFLICT:NEW_EVIDENCE_NOT_CONFIRMED",
        (tx) => tx`select api.assess_grievance_admissibility(${r!.id}, 'ADMISSIBLE', null, ${REASON}, false)`,
      );
      await s.asOwner();
      await s.expectError(
        "CDF_CONFLICT:NEW_EVIDENCE_NOT_CONFIRMED",
        (
          tx,
        ) => tx`insert into grievance.admissibility_assessment (grievance_id, stage, assessment, decided_by_role,
                                                                    reason, recorded_by)
                   values (${r!.id}, 'DECISION', 'ADMISSIBLE', 'SECRETARY', ${REASON}, ${USERS.committeeSecretary})`,
      );
      await s.expectError(
        "CDF_INVALID:new_evidence_confirmed",
        (
          tx,
        ) => tx`insert into grievance.admissibility_assessment (grievance_id, stage, assessment, decided_by_role,
                                                                    reason, recorded_by, new_evidence_confirmed)
                   values (${g!.id}, 'DECISION', 'ADMISSIBLE', 'SECRETARY', ${REASON}, ${USERS.committeeSecretary}, true)`,
      );
      await concludeGrievanceProceeding(s, g!.id);
      await s.as("committeeSecretary");
      expect(
        await s.tx`select api.assess_grievance_admissibility(${r!.id}, 'ADMISSIBLE', null, ${REASON}, true) as r`,
      ).toEqual([{ r: "ADMITTED" }]);
      await s.as("employee");
      await s.tx`select api.withdraw_grievance(${r!.id}, ${REASON})`;
      await s.expectError("CDF_CONFLICT:RECONSIDERATION_USED", () => fileOnNotice(s, n));
      await s.expectError("CDF_CONFLICT:RECONSIDERATION_USED", () =>
        reconsider(s, g!.id, EVIDENCE, "PAYROLL-DEMO-2040-D"),
      );
    });
  });

  it("T-AMB-085: the Secretary records the one reconsideration received outside the portal, never dated before the decided grievance", async () => {
    await ownerScenario(async (s) => {
      await seat(s, gc, GRIEVANCE_SEATS);
      const [num] = await admin<
        { n: string }[]
      >`select case_number as n from case_mgmt.case_record where id = ${caseB}`;
      await s.as("committeeSecretary");
      const [g] = await s.tx<{ id: string }[]>`
        select api.record_grievance('LINKED', ${num!.n}, 'Employee Sigma (synthetic)', null, null, null, 'PHYSICAL_SUBMISSION',
          now(), now(), 'Synthetic: grievance against the decision.', 'LETTER-DEMO-2040') as id`;
      const record = (grievance: string, channel: string, submitted: string, description: string | null) =>
        s.tx<{ id: string }[]>`
          select api.record_grievance_reconsideration(${grievance}, ${channel}, now() - ${submitted}::interval,
            ${GRIEVANCE_GROUNDS}, 'LETTER-DEMO-2040-R', ${description}, 'PAYROLL-DEMO-2040') as id`;
      await s.expectError("CDF_CONFLICT:GRIEVANCE_NOT_DECIDED", () =>
        record(g!.id, "EMAIL", "0 days", EVIDENCE),
      );
      await s.tx`select api.assess_grievance_admissibility(${g!.id}, 'ADMISSIBLE', null, ${REASON})`;
      const vi = await approvedGrievanceVote(s, g!.id);
      await outcomeWith(s, g!.id, vi)(["REJECT_ON_MERITS"], null);

      await s.as("committeeSecretary");
      await s.expectError("CDF_INVALID:channel", () => record(g!.id, "EMPLOYEE_PORTAL", "0 days", EVIDENCE));
      await s.expectError("CDF_INVALID:new_evidence_description", () =>
        record(g!.id, "EMAIL", "0 days", null),
      );
      // Received before the grievance it reconsiders was decided: not a reconsideration on new evidence.
      await s.expectError("CDF_INVALID:original_submission_date", () =>
        record(g!.id, "EMAIL", "1 day", EVIDENCE),
      );
      for (const u of ["caseManager", "employee"] as const) {
        await s.as(u);
        await s.expectError(u === "employee" ? "CDF_NOT_FOUND" : "CDF_FORBIDDEN", () =>
          record(g!.id, "EMAIL", "0 days", EVIDENCE),
        );
      }
      await s.as("employeeB");
      await s.expectError("CDF_NOT_FOUND", () => record(g!.id, "EMAIL", "0 days", EVIDENCE));
      await s.as("committeeSecretary");
      const [r] = await record(g!.id, "EMAIL", "0 days", EVIDENCE);
      await s.expectError("CDF_CONFLICT:RECONSIDERATION_USED", () =>
        record(g!.id, "EMAIL", "0 days", EVIDENCE),
      );
      await s.expectError("CDF_CONFLICT:RECONSIDERATION_USED", () =>
        record(r!.id, "EMAIL", "0 days", EVIDENCE),
      );
      await s.asOwner();
      expect(
        await s.tx`select reconsideration_of, grievant_subject_id, grievant_label, channel, recorded_by
                   from grievance.grievance where id = ${r!.id}`,
      ).toEqual([
        {
          reconsideration_of: g!.id,
          grievant_subject_id: null,
          grievant_label: "Employee Sigma (synthetic)",
          channel: "EMAIL",
          recorded_by: USERS.committeeSecretary,
        },
      ]);
      const [audit] = await s.tx<{ metadata: Record<string, unknown> }[]>`
        select metadata from audit.audit_event where action = 'GRIEVANCE_FILED' and object_id = ${r!.id}`;
      expect(audit!.metadata).toMatchObject({ reconsideration_of: g!.id, channel: "EMAIL", is_late: false });
      expect(JSON.stringify(audit!.metadata)).not.toContain("payroll record");
    });
  });

  it("T-AMB-088: uphold, reduce, a modification no more severe and cancel are allowed; more severe or not comparable is refused", async () => {
    await ownerScenario(async (s) => {
      await seat(s, gc, GRIEVANCE_SEATS);
      const f = await decidedForSubjects(s, ic, caseB);
      const n = await decisionNotice(s, f.sigma, f.decision);
      await recordDelivery(s, n);
      await s.as("employee");
      const [g] = await fileOnNotice(s, n, [f.sanction]);
      await s.as("committeeSecretary");
      await s.tx`select api.assess_grievance_admissibility(${g!.id}, 'ADMISSIBLE', null, ${REASON})`;
      const vi = await approvedGrievanceVote(s, g!.id);
      const outcome = outcomeWith(s, g!.id, vi);
      const sub = (code: string, within?: string) => [
        { item_id: f.sanction, sanction_code: code, ...(within ? { within_type_change: within } : {}) },
      ];

      // Unranked (the seeded state): no change between types at all; within the same type, reduce or keep only.
      await s.as("committeeSecretary");
      await s.expectError("CDF_CONFLICT:SANCTION_NOT_COMPARABLE", () =>
        outcome(["MODIFY"], sub("SALARY_DEDUCTION")),
      );
      await s.expectError("CDF_CONFLICT:SANCTION_MORE_SEVERE", () =>
        outcome(["MODIFY"], sub("WARNING", "INCREASE")),
      );
      await s.expectError("CDF_INVALID:within_type_change", () => outcome(["MODIFY"], sub("WARNING")));
      await thenUndo(s, () => outcome(["MODIFY"], sub("WARNING", "REDUCE")));
      for (const allowed of [["UPHOLD"], ["REJECT_ON_MERITS"]]) {
        await thenUndo(s, () => outcome(allowed, null));
      }

      // Synthetic ranks for the test (SANCTION_SEVERITY_RANK is SOURCE_REQUIRED): SALARY_DEDUCTION 1, WARNING and
      // DEMOTION 2, TERMINATION 5; SUSPENSION stays unranked.
      await setSanctionRule(s, "SALARY_DEDUCTION", 1, false, "PROCEED");
      await setSanctionRule(s, "WARNING", 2, false, "SUSPEND_UNTIL_RESOLVED");
      await setSanctionRule(s, "DEMOTION", 2, false, "SUSPEND_UNTIL_RESOLVED");
      await setSanctionRule(s, "TERMINATION", 5, true, "SUSPEND_UNTIL_RESOLVED");
      await s.as("committeeSecretary");
      await s.expectError("CDF_CONFLICT:SANCTION_MORE_SEVERE", () => outcome(["MODIFY"], sub("TERMINATION")));
      await s.expectError("CDF_CONFLICT:SANCTION_NOT_COMPARABLE", () =>
        outcome(["MODIFY"], sub("SUSPENSION")),
      );
      await s.expectError("CDF_INVALID:within_type_change", () =>
        outcome(["MODIFY"], sub("SALARY_DEDUCTION", "REDUCE")),
      );
      await s.expectError("CDF_INVALID:substitutions", () => outcome(["UPHOLD"], sub("SALARY_DEDUCTION")));
      await s.expectError("CDF_INVALID:substitutions", () => outcome(["MODIFY"], sub("WARNING", "BIGGER")));
      await s.expectError("CDF_INVALID:substitutions", () =>
        outcome(["MODIFY"], [{ item_id: f.corrective, sanction_code: "SALARY_DEDUCTION" }]),
      );
      await s.expectError("CDF_INVALID:substitutions", () =>
        outcome(["MODIFY"], [{ item_id: "not-a-uuid", sanction_code: "SALARY_DEDUCTION" }]),
      );
      await s.as("employee");
      await s.expectError("CDF_FORBIDDEN", () => outcome(["MODIFY"], sub("SALARY_DEDUCTION")));
      // Guarded in the database, whatever writes the row.
      await s.asOwner();
      for (const [code, error] of [
        ["TERMINATION", "CDF_CONFLICT:SANCTION_MORE_SEVERE"],
        ["SUSPENSION", "CDF_CONFLICT:SANCTION_NOT_COMPARABLE"],
      ] as const) {
        await s.expectError(
          error,
          (
            tx,
          ) => tx`insert into grievance.outcome_substitution (grievance_id, item_id, original_sanction_code,
                                                                  substitute_sanction_code, recorded_by)
                     values (${g!.id}, ${f.sanction}, 'WARNING', ${code}, ${USERS.committeeSecretary})`,
        );
      }

      // Allowed: an equal rank (no more severe), and cancel, which sets the sanction aside for execution.
      await s.as("committeeSecretary");
      await thenUndo(s, () => outcome(["MODIFY"], sub("DEMOTION")));
      await thenUndo(s, async () => {
        await outcome(["CANCEL"], null);
        expect(await executability(s)).toEqual([
          { item_id: f.sanction, blocked_by: "SANCTION_SET_ASIDE_BY_GRIEVANCE", executable: false },
        ]);
        await s.expectError("CDF_CONFLICT:SANCTION_SET_ASIDE_BY_GRIEVANCE", () =>
          executeSanction(s, f.sanction, f.sigma),
        );
      });
      // Reduce between types: kept for the rest of the test.
      await s.as("committeeSecretary");
      await outcome(["MODIFY"], sub("SALARY_DEDUCTION"));
      await s.asOwner();
      expect(
        await s.tx`select original_sanction_code, substitute_sanction_code, original_severity_rank,
                          substitute_severity_rank, within_type_change
                   from grievance.outcome_substitution where grievance_id = ${g!.id}`,
      ).toEqual([
        {
          original_sanction_code: "WARNING",
          substitute_sanction_code: "SALARY_DEDUCTION",
          original_severity_rank: 2,
          substitute_severity_rank: 1,
          within_type_change: null,
        },
      ]);

      // The reconsideration compares with the sanction now in effect (SALARY_DEDUCTION), not the decided WARNING.
      await s.as("employee");
      const [r] = await reconsider(s, g!.id, EVIDENCE, "PAYROLL-DEMO-2040");
      await concludeGrievanceProceeding(s, g!.id);
      await s.as("committeeSecretary");
      await s.tx`select api.assess_grievance_admissibility(${r!.id}, 'ADMISSIBLE', null, ${REASON}, true)`;
      const vi2 = await approvedGrievanceVote(s, r!.id);
      const again = outcomeWith(s, r!.id, vi2);
      await s.as("committeeSecretary");
      await s.expectError("CDF_CONFLICT:SANCTION_MORE_SEVERE", () => again(["MODIFY"], sub("WARNING")));
      await again(["MODIFY"], sub("SALARY_DEDUCTION", "NONE"));
      // Executed as the sanction in effect; SALARY_DEDUCTION is configured to proceed.
      await s.as("caseManager");
      await executeSanction(s, f.sanction, f.sigma);
      await s.asOwner();
      expect(
        await s.tx`select executed_sanction_code from decision.sanction_execution where item_id = ${f.sanction}`,
      ).toEqual([{ executed_sanction_code: "SALARY_DEDUCTION" }]);
    });
  });
});

describe("ambiguity register: defence notices and late paper grievances (CDF-205)", () => {
  it("T-AMB-092: a defence notice carries no evidence and no reporter field, in its tables or the portal read", async () => {
    await scenario(async (s) => {
      const ids = await twoSubjects(s); // case B has an identified reporter (Reporter Gamma, synthetic)
      await s.as("caseManager");
      await notice(s, ids.sigma!, [ids.sigmaAllegation!]);
      await s.as("employee");
      const [mine] = await s.tx<{ n: unknown }[]>`select api.my_defence_notices() as n`;
      const text = JSON.stringify(mine!.n);
      expect(text).not.toMatch(/Reporter Gamma|reporter\.gamma|WBID-|WB-SEED/i);
      const keys = new Set<string>();
      const walk = (v: unknown) => {
        if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === "object")
          for (const [k, x] of Object.entries(v)) {
            keys.add(k);
            walk(x);
          }
      };
      walk(mine!.n);
      expect(
        [...keys].filter((k) => /evidence|reporter|wb_id|identity|attachment|storage|object_key/i.test(k)),
      ).toEqual([]);
    });
    const columns = await admin<{ c: string }[]>`
      select table_name || '.' || column_name as c from information_schema.columns
      where table_schema = 'grievance' and table_name like 'defence_notice%'
        and column_name ~* '(evidence|reporter|wb_id|identity|attachment|storage|object_key)'`;
    expect(columns).toEqual([]);
  });

  it("T-AMB-092: evidence reaches the subject only as reviewed Defence Packet items; a restricted case also needs its authority", async () => {
    const { clearAsIs, defenceNotice, packetWith, setPacketPolicy, storeEvidence, subjectView } =
      await import("../support/evidence");
    await ownerScenario(async (s) => {
      await setPacketPolicy(s);
      await s.asOwner();
      await s.tx`update iam.user_profile set clearance = 'SECRET' where id in (${USERS.lead}, ${USERS.employee})`;
      await s.as("caseManager");
      await s.tx`select api.assign_case(${caseB}, ${USERS.lead}, 'LEAD_INVESTIGATOR', ${REASON})`;
      // An unrestricted case: an unreviewed item blocks the release; the notice itself carries no evidence.
      const n = await defenceNotice(s, caseB);
      const a = await storeEvidence(s, "investigatorB", caseB);
      const { packet, items } = await packetWith(s, "lead", n.notice, [a.versionId]);
      await s.expectError(
        "CDF_CONFLICT:ITEM_NOT_REVIEWED",
        (tx) => tx`select api.submit_defence_packet(${packet})`,
      );
      await s.as("employee");
      expect(await subjectView(s, n.notice)).toEqual([]);
      expect(await s.tx`select * from api.open_defence_packet_item(${items[0]!})`).toEqual([]);
      await clearAsIs(s, "caseManager", items[0]!, "Reviewed item");
      await s.as("lead");
      expect(await s.tx`select api.submit_defence_packet(${packet}) as st`).toEqual([{ st: "RELEASED" }]);
      await s.as("employee");
      expect(await subjectView(s, n.notice)).toEqual([["Reviewed item"]]);
      // No general evidence access from the packet: no item row, no version, no download.
      expect(await s.tx`select id from evidence.evidence`).toEqual([]);
      expect(await s.tx`select 1 from api.open_evidence_version(${a.versionId})`).toEqual([]);

      // A restricted case: the reviewed packet waits for the case's Restricted Case Authority.
      await s.as("grcDirector");
      await s.tx`select api.assign_case(${caseExec}, ${USERS.lead}, 'LEAD_INVESTIGATOR', ${REASON})`;
      const r = await defenceNotice(s, caseExec, "grcDirector", "employee", "Employee Tau (synthetic)");
      const e = await storeEvidence(s, "grcDirector", caseExec, { classification: "SECRET" });
      const restricted = await packetWith(s, "lead", r.notice, [e.versionId]);
      await clearAsIs(s, "grcDirector", restricted.items[0]!, "Restricted item");
      await s.as("lead");
      expect(await s.tx`select api.submit_defence_packet(${restricted.packet}) as st`).toEqual([
        { st: "AWAITING_AUTHORITY" },
      ]);
      await s.as("employee");
      expect(await subjectView(s, r.notice)).toEqual([]);
      await s.as("grcDirector");
      await s.tx`select api.decide_restricted_defence_packet(${restricted.packet}, 'APPROVE', 'Synthetic: consent given.')`;
      await s.as("employee");
      expect(await subjectView(s, r.notice)).toEqual([["Restricted item"]]);
    });
  });

  it("T-AMB-089: a grievance recorded later from paper keeps its original received date, which decides lateness", async () => {
    await ownerScenario(async (s) => {
      await seat(s, gc, GC_SEATS);
      const [num] = await admin<
        { n: string }[]
      >`select case_number as n from case_mgmt.case_record where id = ${caseB}`;
      await s.as("committeeSecretary");
      const decided = new Date(Date.now() - 45 * 86400_000);
      const received = new Date(Date.now() - 43 * 86400_000); // two days after the decision, recorded only now
      const [g] = await s.tx<{ id: string }[]>`
        select api.record_grievance('LINKED', ${num!.n}, 'Employee Sigma (synthetic)', null, null, null,
          'PHYSICAL_SUBMISSION', ${received}, ${decided}, 'Synthetic: the sanction ignored my response.',
          'PAPER-DEMO-0089') as id`;
      await s.asOwner();
      const [row] = await s.tx<
        { original_submission_date: Date; recorded_at: Date; is_late: boolean; window_days: number }[]
      >`
        select original_submission_date, recorded_at, is_late, window_days from grievance.grievance where id = ${g!.id}`;
      expect(row!.original_submission_date.toISOString()).toBe(received.toISOString());
      expect(row!.recorded_at.getTime()).toBeGreaterThan(received.getTime() + 40 * 86400_000);
      expect(row!.window_days).toBeLessThan(43); // recorded today it would be late; received in time it is not
      expect(row!.is_late).toBe(false);
      await s.expectError(
        "grievance ", // "grievance <id> is closed or its record is immutable", even for the owner
        (tx) => tx`update grievance.grievance set original_submission_date = now() where id = ${g!.id}`,
      );
    });
  });
});
