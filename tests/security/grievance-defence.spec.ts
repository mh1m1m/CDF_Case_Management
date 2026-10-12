// Business architecture rebase, migration 1910 (ADR-024; owner Q&A Q37, Q45–Q46, Q90–Q96; AUTHORIZATION_IMPACT.md N9).
// Each subject has their own defence path through the employee portal and reaches only their own notices; grievances
// are received by the Grievance Committee Secretary, linked or standalone, flagged when late, admitted by the decider
// the rule names, and decided by the Grievance Committee, whose proceeding keeps Investigation Committee voters out of
// its votes (N9).
import { beforeAll, describe, expect, it } from "vitest";
import { USERS, admin, caseId, ownerScenario, scenario, type Scenario } from "../support/db";
import { IC_SEATS, REASON, committeeIds, refer, seat } from "../support/committee";

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
      await s.as("platformAdmin");
      await s.tx`select api.set_committee_rule_set(${gc}, now(), 'MAJORITY_ELIGIBLE', null, true, 3, true, 10, 'CHAIR',
                   'NO_DECISION', 'APPROVED', ${REASON})`;
      await s.as("committeeSecretary");
      const [num] = await admin<
        { n: string }[]
      >`select case_number as n from case_mgmt.case_record where id = ${caseB}`;
      const [g] = await s.tx<{ id: string }[]>`
        select api.record_grievance('LINKED', ${num!.n}, 'Employee Sigma (synthetic)', null, null, null, 'PHYSICAL_SUBMISSION',
          now(), now() - interval '12 days', 'Synthetic: grievance against the decision.',
          'LETTER-DEMO-0001') as id`;
      const [row] = await s.tx<{ is_late: boolean; window_days: number; admissibility_decider: string }[]>`
        select is_late, window_days, admissibility_decider from grievance.grievance where id = ${g!.id}`;
      expect(row).toEqual({ is_late: true, window_days: 10, admissibility_decider: "CHAIR" });
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
