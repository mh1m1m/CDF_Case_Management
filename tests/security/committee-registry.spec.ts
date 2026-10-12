// Business architecture rebase, migration 1870 (ADR-017 to ADR-019; AUTHORIZATION_IMPACT.md N1–N3, N9, N13, N20).
// Committee access comes from a seat and a proceeding snapshot, never from a global role; registry administration
// gives no proceeding or case content; snapshots and effective-dated rows are never rewritten; and the case-structure
// commands keep one value per status dimension.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { USERS, admin, caseId, ownerScenario, scenario, type Scenario } from "../support/db";

const REASON = "Synthetic: committee registry test.";
let caseA: string, caseB: string, ic: string, gc: string;

beforeAll(async () => {
  [caseA, caseB] = await Promise.all([caseId("0001"), caseId("0002")]);
  const rows = await admin<{ code: string; id: string }[]>`select code, id from committee.committee`;
  ic = rows.find((r) => r.code === "IC")!.id;
  gc = rows.find((r) => r.code === "GC")!.id;
});

/** Seats a chair, a secretary and one member on a committee, effective from yesterday, as the platform admin. */
async function constitute(s: Scenario, committeeId: string, member: keyof typeof USERS = "committee") {
  await s.as("platformAdmin");
  const appoint = (user: keyof typeof USERS, seat: string, ref: string) =>
    s.tx<{ id: string }[]>`
      select api.appoint_committee_member(${committeeId}, ${USERS[user]}, ${seat}, now() - interval '1 day', null, ${ref}) as id`;
  const [chair] = await appoint("committeeChair", "CHAIR", "DEMO-APPT-CHAIR");
  const [secretary] = await appoint("committeeSecretary", "SECRETARY", "DEMO-APPT-SEC");
  const [m] = await appoint(member, "MEMBER", "DEMO-APPT-MEMBER");
  return { chair: chair!.id, secretary: secretary!.id, member: m!.id };
}

async function refer(s: Scenario, committeeId: string, target = caseB): Promise<string> {
  await s.as("caseManager");
  const [cp] = await s.tx<{ id: string }[]>`
    select api.refer_case_to_committee(${target}, ${committeeId}, null, ${REASON}) as id`;
  return cp!.id;
}

describe("committee registry: seats, not roles (N1–N3)", () => {
  it("a global COMMITTEE_MEMBER with no seat sees no membership, rules or proceedings", async () => {
    await scenario(async (s) => {
      await constitute(s, ic, "lead");
      await refer(s, ic);
      await s.as("committee");
      expect(await s.tx`select id from committee.membership`).toEqual([]);
      expect(await s.tx`select id from committee.rule_set`).toEqual([]);
      expect(await s.tx`select id from committee.committee_proceeding`).toEqual([]);
      expect(await s.tx`select id from committee.proceeding_member`).toEqual([]);
      expect(await s.tx`select id from case_mgmt.proceeding`).toEqual([]);
      // Committee codes are reference data.
      expect((await s.tx`select code from committee.committee order by code`).length).toBe(2);
    });
  });

  it("a seat on one committee shows that committee's registry only", async () => {
    await scenario(async (s) => {
      await constitute(s, ic);
      await s.as("committee");
      const seats = await s.tx<
        { committee_id: string }[]
      >`select distinct committee_id from committee.membership`;
      expect(seats.map((r) => r.committee_id)).toEqual([ic]);
      const rules = await s.tx<
        { committee_id: string }[]
      >`select distinct committee_id from committee.rule_set`;
      expect(rules.map((r) => r.committee_id)).toEqual([ic]);
    });
  });

  it("an ended seat gives no registry view and no place in a new proceeding", async () => {
    await scenario(async (s) => {
      await s.as("platformAdmin");
      await s.tx`select api.appoint_committee_member(${ic}, ${USERS.lead}, 'MEMBER', now() - interval '10 days', now() - interval '1 day', 'DEMO-APPT-PAST')`;
      await constitute(s, ic);
      const cp = await refer(s, ic);
      await s.as("lead");
      expect(await s.tx`select id from committee.membership`).toEqual([]);
      await s.as("committeeSecretary");
      const members = await s.tx<{ user_id: string }[]>`
        select user_id from committee.proceeding_member where committee_proceeding_id = ${cp}`;
      expect(members.map((m) => m.user_id)).not.toContain(USERS.lead);
    });
  });

  it("proceeding members and secretaries see the proceeding but never the case content (DEC-02)", async () => {
    await scenario(async (s) => {
      await constitute(s, ic);
      const cp = await refer(s, ic);
      for (const user of ["committee", "committeeChair", "committeeSecretary"] as const) {
        await s.as(user);
        expect(await s.tx`select id from committee.committee_proceeding where id = ${cp}`).toHaveLength(1);
        expect(await s.tx`select id from case_mgmt.proceeding`).toHaveLength(1);
        expect(await s.tx`select id from case_mgmt.case_record where id = ${caseB}`).toEqual([]);
        expect(await s.tx`select id from case_mgmt.allegation where case_id = ${caseB}`).toEqual([]);
        expect(await s.tx`select id from case_mgmt.finding where case_id = ${caseB}`).toEqual([]);
      }
    });
  });
});

describe("registry administration (N13, Q28)", () => {
  it("the platform admin maintains the registry but sees no proceeding, member snapshot or case", async () => {
    await scenario(async (s) => {
      await constitute(s, ic);
      await refer(s, ic);
      await s.as("platformAdmin");
      expect((await s.tx`select id from committee.membership`).length).toBe(3);
      expect((await s.tx`select id from committee.rule_set`).length).toBe(2);
      expect(await s.tx`select id from committee.committee_proceeding`).toEqual([]);
      expect(await s.tx`select id from committee.proceeding_member`).toEqual([]);
      expect(await s.tx`select id from case_mgmt.proceeding`).toEqual([]);
      expect(await s.tx`select id from case_mgmt.case_record`).toEqual([]);
    });
  });

  it.each(["caseManager", "committeeChair", "committeeSecretary", "lead", "dpo"] as const)(
    "%s cannot change committee composition or rules",
    async (actor) => {
      const [membership] = await admin<{ id: string }[]>`select gen_random_uuid() as id`;
      await scenario(async (s) => {
        await s.as(actor);
        await s.expectError(
          "CDF_FORBIDDEN",
          (tx) =>
            tx`select api.appoint_committee_member(${ic}, ${USERS.investigatorA}, 'MEMBER', now(), null, 'DEMO-APPT-X')`,
        );
        await s.expectError(
          "CDF_FORBIDDEN",
          (tx) => tx`select api.end_committee_membership(${membership!.id}, now(), ${REASON})`,
        );
        await s.expectError(
          "CDF_FORBIDDEN",
          (tx) =>
            tx`select api.set_committee_rule_set(${ic}, now(), 'MAJORITY_ELIGIBLE', null, true, 3, true, null, null, 'APPROVED', ${REASON})`,
        );
      });
    },
  );

  it("enforces one holder per single seat, one seat per person, and no self-appointment", async () => {
    await scenario(async (s) => {
      await constitute(s, ic);
      await s.expectError(
        "CDF_CONFLICT:SEAT_OCCUPIED",
        (tx) =>
          tx`select api.appoint_committee_member(${ic}, ${USERS.lead}, 'CHAIR', now() + interval '1 day', null, 'DEMO-APPT-2')`,
      );
      await s.expectError(
        "CDF_CONFLICT:MEMBERSHIP_OVERLAP",
        (tx) =>
          tx`select api.appoint_committee_member(${ic}, ${USERS.committee}, 'ALTERNATE_MEMBER', now(), null, 'DEMO-APPT-3')`,
      );
      await s.expectError(
        "CDF_CONFLICT:SELF_APPOINTMENT",
        (tx) =>
          tx`select api.appoint_committee_member(${ic}, ${USERS.platformAdmin}, 'MEMBER', now(), null, 'DEMO-APPT-4')`,
      );
      // Several members, and the same person on the other committee, are fine (Q22–Q26).
      await s.tx`select api.appoint_committee_member(${ic}, ${USERS.lead}, 'MEMBER', now(), null, 'DEMO-APPT-5')`;
      await s.tx`select api.appoint_committee_member(${gc}, ${USERS.committee}, 'MEMBER', now(), null, 'DEMO-APPT-6')`;
    });
  });

  it("a new rule set starts now or later, closes the current one and never rewrites the past (Q53)", async () => {
    await scenario(async (s) => {
      await s.as("platformAdmin");
      await s.expectError(
        "CDF_INVALID:effective_from",
        (tx) =>
          tx`select api.set_committee_rule_set(${ic}, now() - interval '1 day', 'MAJORITY_ELIGIBLE', null, true, 3, true, null, null, 'APPROVED', ${REASON})`,
      );
      await s.expectError(
        "CDF_INVALID:grievance_rules",
        (tx) =>
          tx`select api.set_committee_rule_set(${ic}, now(), 'MAJORITY_ELIGIBLE', null, true, 3, true, 30, 'SECRETARY', 'APPROVED', ${REASON})`,
      );
      await s.expectError(
        "CDF_INVALID:quorum_value",
        (tx) =>
          tx`select api.set_committee_rule_set(${ic}, now(), 'PERCENTAGE', 120, true, 3, true, null, null, 'APPROVED', ${REASON})`,
      );
      await s.tx`select api.set_committee_rule_set(${ic}, now() + interval '7 days', 'FIXED_NUMBER', 3, false, 5, false, null, null, 'APPROVED', ${REASON})`;
      await s.expectError(
        "CDF_CONFLICT:RULE_SET_SCHEDULED",
        (tx) =>
          tx`select api.set_committee_rule_set(${ic}, now() + interval '1 day', 'MAJORITY_ELIGIBLE', null, true, 3, true, null, null, 'APPROVED', ${REASON})`,
      );
      const rows = await s.tx<{ quorum_type: string; open_ended: boolean }[]>`
        select quorum_type, effective_to is null as open_ended from committee.rule_set where committee_id = ${ic} order by effective_from`;
      expect(rows).toEqual([
        { quorum_type: "MAJORITY_ELIGIBLE", open_ended: false },
        { quorum_type: "FIXED_NUMBER", open_ended: true },
      ]);
    });
  });
});

describe("committee proceedings and snapshots (Q30, Q45–Q46)", () => {
  it("cannot open on a committee without a chair, a secretary and a voting member", async () => {
    await scenario(async (s) => {
      await s.as("caseManager");
      await s.expectError(
        "CDF_CONFLICT:COMMITTEE_NOT_CONSTITUTED",
        (tx) => tx`select api.refer_case_to_committee(${caseB}, ${ic}, null, ${REASON})`,
      );
    });
  });

  it("snapshots seats and rules; later registry changes do not reach the proceeding", async () => {
    await scenario(async (s) => {
      const seats = await constitute(s, ic);
      const cp = await refer(s, ic);
      await s.as("platformAdmin");
      await s.tx`select api.end_committee_membership(${seats.member}, now(), ${REASON})`;
      await s.tx`select api.set_committee_rule_set(${ic}, now(), 'FIXED_NUMBER', 2, false, 5, false, null, null, 'APPROVED', ${REASON})`;
      await s.as("committeeSecretary");
      const members = await s.tx<{ user_id: string; seat: string; is_voting: boolean }[]>`
        select user_id, seat, is_voting from committee.proceeding_member where committee_proceeding_id = ${cp} order by seat`;
      expect(members).toEqual([
        { user_id: USERS.committeeChair, seat: "CHAIR", is_voting: true },
        { user_id: USERS.committee, seat: "MEMBER", is_voting: true },
        { user_id: USERS.committeeSecretary, seat: "SECRETARY", is_voting: false },
      ]);
      const [snap] = await s.tx<{ quorum_type: string; minutes: number }[]>`
        select rule_snapshot->>'quorum_type' as quorum_type, (rule_snapshot->>'minutes_review_business_days')::int as minutes
        from committee.committee_proceeding where id = ${cp}`;
      expect(snap).toEqual({ quorum_type: "MAJORITY_ELIGIBLE", minutes: 3 });
      // The ended member still sees the proceeding they sat on.
      await s.as("committee");
      expect(await s.tx`select id from committee.committee_proceeding where id = ${cp}`).toHaveLength(1);
    });
  });

  it("an Investigation Committee voter sits on the same case's grievance without a vote (N9)", async () => {
    await scenario(async (s) => {
      await constitute(s, ic);
      await s.as("platformAdmin");
      await s.tx`select api.appoint_committee_member(${gc}, ${USERS.lead}, 'CHAIR', now() - interval '1 day', null, 'DEMO-GC-1')`;
      await s.tx`select api.appoint_committee_member(${gc}, ${USERS.investigatorA}, 'SECRETARY', now() - interval '1 day', null, 'DEMO-GC-2')`;
      await s.tx`select api.appoint_committee_member(${gc}, ${USERS.committee}, 'MEMBER', now() - interval '1 day', null, 'DEMO-GC-3')`;
      await s.tx`select api.appoint_committee_member(${gc}, ${USERS.committeeChair}, 'MEMBER', now() - interval '1 day', null, 'DEMO-GC-4')`;
      await refer(s, ic);
      const gcp = await refer(s, gc);
      await s.as("investigatorA");
      const rows = await s.tx<{ user_id: string; is_voting: boolean; firewall_restricted: boolean }[]>`
        select user_id, is_voting, firewall_restricted from committee.proceeding_member
        where committee_proceeding_id = ${gcp} and seat in ('CHAIR', 'MEMBER') order by user_id`;
      expect(rows).toEqual(
        [
          { user_id: USERS.committee, is_voting: false, firewall_restricted: true },
          { user_id: USERS.committeeChair, is_voting: false, firewall_restricted: true },
          { user_id: USERS.lead, is_voting: true, firewall_restricted: false },
        ].sort((a, b) => a.user_id.localeCompare(b.user_id)),
      );
    });
  });

  it("refuses a grievance committee whose every voter sat on the investigation", async () => {
    await scenario(async (s) => {
      await constitute(s, ic);
      await constitute(s, gc);
      await refer(s, ic);
      await s.as("caseManager");
      await s.expectError(
        "CDF_CONFLICT:COMMITTEE_NOT_CONSTITUTED",
        (tx) => tx`select api.refer_case_to_committee(${caseB}, ${gc}, null, ${REASON})`,
      );
    });
  });

  it("snapshots, memberships and rule sets cannot be rewritten even by the table owner", async () => {
    await ownerScenario(async (s) => {
      await constitute(s, ic);
      const cp = await refer(s, ic);
      await s.asOwner();
      await s.expectError(
        "committee proceeding",
        (tx) => tx`update committee.committee_proceeding set rule_snapshot = '{}' where id = ${cp}`,
      );
      await s.expectError(
        "committee.proceeding_member is append-only",
        (tx) => tx`delete from committee.proceeding_member`,
      );
      await s.expectError("membership", (tx) => tx`update committee.membership set seat = 'CHAIR'`);
      await s.expectError(
        "rule set",
        (tx) => tx`update committee.rule_set set quorum_type = 'CUSTOM', quorum_value = null`,
      );
      await s.expectError("committee.rule_set is append-only", (tx) => tx`delete from committee.rule_set`);
    });
  });
});

describe("case structure commands (ADR-017)", () => {
  it("keeps one value per status dimension and freezes closed proceedings", async () => {
    await scenario(async (s) => {
      await s.as("caseManager");
      const [p] = await s.tx<{ id: string }[]>`
        select api.open_proceeding(${caseB}, 'PRELIMINARY_REVIEW', null, ${REASON}) as id`;
      await s.expectError(
        "CDF_CONFLICT:PROCEEDING_ALREADY_OPEN",
        (tx) => tx`select api.open_proceeding(${caseB}, 'PRELIMINARY_REVIEW', null, ${REASON})`,
      );
      await s.expectError(
        "CDF_INVALID:proceeding_type",
        (tx) => tx`select api.open_proceeding(${caseB}, 'COMMITTEE_INVESTIGATION', null, ${REASON})`,
      );
      await s.expectError(
        "CDF_INVALID:suspension_reason",
        (tx) => tx`select api.update_proceeding_state(${p!.id}, 'SUSPENDED', null, null, ${REASON})`,
      );
      await s.expectError(
        "CDF_INVALID:waiting_reason",
        (tx) =>
          tx`select api.update_proceeding_state(${p!.id}, 'IN_PROGRESS', 'NOT_A_CODE', null, ${REASON})`,
      );
      await s.expectError(
        "CDF_INVALID:waiting_reason",
        (tx) =>
          tx`select api.update_proceeding_state(${p!.id}, 'SUSPENDED', 'DOCUMENTS', 'GENERAL', ${REASON})`,
      );
      await s.tx`select api.update_proceeding_state(${p!.id}, 'SUSPENDED', null, 'LEAVE_OR_ILLNESS', ${REASON})`;
      const [child] = await s.tx<{ id: string }[]>`
        select api.open_proceeding(${caseB}, 'CORRECTIVE_ACTION', ${p!.id}, ${REASON}) as id`;
      await s.expectError(
        "CDF_CONFLICT:OPEN_CHILD_PROCEEDINGS",
        (tx) => tx`select api.close_proceeding(${p!.id}, 'CONCLUDED', 'NO_ACTION', ${REASON})`,
      );
      await s.tx`select api.close_proceeding(${child!.id}, 'CANCELLED', null, ${REASON})`;
      await s.expectError(
        "CDF_INVALID:outcome_code",
        (tx) => tx`select api.close_proceeding(${p!.id}, 'CONCLUDED', null, ${REASON})`,
      );
      await s.tx`select api.close_proceeding(${p!.id}, 'CONCLUDED', 'NO_ACTION', ${REASON})`;
      const [row] = await s.tx<{ status: string; suspension_reason: string | null; outcome_code: string }[]>`
        select status, suspension_reason, outcome_code from case_mgmt.proceeding where id = ${p!.id}`;
      expect(row).toEqual({ status: "CONCLUDED", suspension_reason: null, outcome_code: "NO_ACTION" });
      await s.expectError(
        "CDF_CONFLICT:PROCEEDING_CLOSED",
        (tx) => tx`select api.update_proceeding_state(${p!.id}, 'OPEN', null, null, ${REASON})`,
      );
    });
  });

  it("records versioned findings per allegation and subject; investigators may, committee members may not", async () => {
    await scenario(async (s) => {
      await s.as("caseManager");
      const [p] = await s.tx<
        { id: string }[]
      >`select api.open_proceeding(${caseB}, 'INVESTIGATION', null, ${REASON}) as id`;
      const [subj] = await s.tx<{ id: string }[]>`
        select api.add_case_subject(${caseB}, 'Employee Sigma (synthetic)', 'EMPLOYEE', null) as id`;
      await s.expectError("CDF_CONFLICT:ALREADY_SUBJECT", async (tx) => {
        const [person] = await tx<
          { id: string }[]
        >`select person_id as id from case_mgmt.case_subject where id = ${subj!.id}`;
        return tx`select api.add_case_subject(${caseB}, null, 'EMPLOYEE', ${person!.id})`;
      });
      const [a] = await s.tx<{ id: string }[]>`
        select api.add_allegation(${caseB}, 'FRAUD', 'Synthetic: allegation against Employee Sigma.', ${subj!.id}, null, null) as id`;
      await s.as("investigatorB");
      const record = (result: string) =>
        s.tx`select api.record_finding(${a!.id}, null, ${p!.id}, ${result}, 'Synthetic: finding rationale text.')`;
      await record("INCONCLUSIVE");
      await record("SUBSTANTIATED");
      const rows = await s.tx<{ version_no: number; result: string; subject_id: string }[]>`
        select version_no, result, subject_id from case_mgmt.finding where allegation_id = ${a!.id} order by version_no`;
      expect(rows).toEqual([
        { version_no: 1, result: "INCONCLUSIVE", subject_id: subj!.id },
        { version_no: 2, result: "SUBSTANTIATED", subject_id: subj!.id },
      ]);
      await s.as("committee");
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) =>
          tx`select api.record_finding(${a!.id}, null, ${p!.id}, 'SUBSTANTIATED', 'Synthetic: not allowed.')`,
      );
      // A subject or proceeding from another case is refused, not re-homed.
      await s.as("caseManager");
      const [otherSubject] = await s.tx<{ id: string }[]>`
        select api.add_case_subject(${caseA}, 'Employee Tau (synthetic)', 'CONTRACTOR', null) as id`;
      await s.expectError(
        "CDF_INVALID:subject_id",
        (tx) =>
          tx`select api.record_finding(${a!.id}, ${otherSubject!.id}, ${p!.id}, 'SUBSTANTIATED', 'Synthetic: swap attempt.')`,
      );
      await s.expectError(
        "CDF_INVALID:proceeding_id",
        (tx) =>
          tx`select api.record_finding(${a!.id}, null, ${randomUUID()}, 'SUBSTANTIATED', 'Synthetic: swap attempt.')`,
      );
    });
  });

  it("links only evidence from the same case that the caller can see", async () => {
    await scenario(async (s) => {
      await s.as("investigatorA");
      const [ev] = await s.tx<{ e: string; v: string }[]>`
        select o_evidence_id as e, o_version_id as v from api.register_evidence_version(${caseA}, null, 'Case A item (synthetic)',
          null, 'DOCUMENT', 'Synthetic source', null, 'CONFIDENTIAL'::core.classification_level, 'a.pdf', 'application/pdf', 100, ${"9".repeat(64)})`;
      await s.as("caseManager");
      const [a] = await s.tx<{ id: string }[]>`
        select api.add_allegation(${caseB}, 'FRAUD', 'Synthetic: case B allegation for linking.', null, null, null) as id`;
      await s.expectError(
        "CDF_INVALID:evidence_id",
        (tx) => tx`select api.link_supporting_material(${ev!.e}, ${a!.id}, null)`,
      );
      await s.expectError(
        "CDF_INVALID:target",
        (tx) => tx`select api.link_supporting_material(${ev!.e}, null, null)`,
      );
    });
  });

  it("existing cases are whistleblowing by intake path, and new ones default to it", async () => {
    const rows = await admin<
      { source_type: string }[]
    >`select distinct source_type from case_mgmt.case_record`;
    expect(rows).toEqual([{ source_type: "WHISTLEBLOWING" }]);
  });
});
