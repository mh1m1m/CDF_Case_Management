// Rebase PR-B, migration 2080 (ADR-044): a conflict of interest raised on the case itself (gap P11-G7), an upheld one
// suspending the subject's purposes on the case (DEC-F38, AMB-057, T-AMB-034), and prior investigators on the case's
// committees (AMB-053, T-AMB-030). Someone on the case raises another person's conflict with a reason; a conflict
// manager who is neither the raiser nor the subject decides it; the reasons never reach the subject. Upheld, the
// subject fails the case gate: every purpose on that case stops, committee participation absolutely, while the
// account and other cases stay. Every step runs through the api.* commands as `authenticated`; the owner connection
// only sets the migration-managed setting (rolled back), reads rows and probes the table guards.
import { beforeAll, describe, expect, it } from "vitest";
import {
  USERS,
  caseId,
  ownerScenario,
  scenario,
  type OwnerScenario,
  type Scenario,
  type UserKey,
} from "../support/db";
import {
  IC_SEATS,
  REASON as MEETING_REASON,
  committeeIds,
  openItem,
  openWithPresent,
  refer,
  scheduleMeeting,
  seat,
} from "../support/committee";

const REASON = "Synthetic: a conflict of interest raised for the 2080 tests.";
const DECISION = "Synthetic: the conflict manager's reasons for the 2080 tests.";

let caseB: string, case4: string, ic: string;
beforeAll(async () => {
  [caseB, case4] = await Promise.all([caseId("0002"), caseId("0004")]);
  ({ ic } = await committeeIds());
});

async function raise(s: Scenario, by: UserKey, subject: UserKey, on = caseB): Promise<string> {
  await s.as(by);
  const [r] = await s.tx<{ id: string }[]>`
    select api.raise_case_conflict(${on}, ${USERS[subject]}, ${REASON}) as id`;
  return r!.id;
}
async function decide(s: Scenario, by: UserKey, concern: string, decision: string): Promise<void> {
  await s.as(by);
  await s.tx`select api.decide_case_conflict(${concern}, ${decision}, ${DECISION})`;
}
interface ConcernView {
  case_id: string;
  may_raise: boolean;
  concerns: {
    concern_id: string;
    subject_user_id: string;
    raised_by: string;
    reason: string;
    status: string;
    decision_reason: string | null;
    may_decide: boolean;
  }[];
}
async function view(s: Scenario, user: UserKey, on = caseB): Promise<ConcernView> {
  await s.as(user);
  const [r] = await s.tx<{ v: ConcernView }[]>`select api.case_conflict_concerns(${on}) as v`;
  return r!.v;
}
async function seesCase(s: Scenario, user: UserKey, on = caseB): Promise<boolean> {
  await s.as(user);
  return (await s.tx`select id from case_mgmt.case_record where id = ${on}`).length > 0;
}
const ledger = (s: OwnerScenario, object: string) =>
  s.tx<{ action: string; reason: string | null; metadata: Record<string, unknown> }[]>`
    select action, reason, metadata from audit.audit_event
    where object_type = 'case_conflict_concern' and object_id = ${object} order by seq`;
async function setPriorInvestigatorRule(s: OwnerScenario, value: string): Promise<void> {
  await s.asOwner();
  await s.tx`update config.setting set value = ${value}, source_reference = 'Synthetic: DEC-05 answered (test)'
             where key = 'PRIOR_INVESTIGATOR_IS_CONFLICTED'`;
}

describe("raising another person's conflict on the case (P11-G7)", () => {
  it("only someone on the case who may declare a conflict raises it, about another active user, with a reason", async () => {
    await ownerScenario(async (s) => {
      // Someone who cannot see the case gets NOT_FOUND, on a real case as on a random one.
      await s.as("investigatorA");
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) => tx`select api.raise_case_conflict(${caseB}, ${USERS.lead}, ${REASON})`,
      );
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) => tx`select api.raise_case_conflict(gen_random_uuid(), ${USERS.lead}, ${REASON})`,
      );
      // The privacy officer on a case grant sees the case but may not declare a conflict.
      await s.as("caseManager");
      await s.tx`select api.grant_case_access(${caseB}, ${USERS.dpo}, 'CASE', ${REASON}, null)`;
      await s.as("dpo");
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.raise_case_conflict(${caseB}, ${USERS.lead}, ${REASON})`,
      );
      await s.as("investigatorB");
      for (const subject of [null, "a0000000-0000-4000-8000-0000000000ff", USERS.revoked]) {
        await s.expectError(
          "CDF_INVALID:subject_user_id",
          (tx) => tx`select api.raise_case_conflict(${caseB}, ${subject}, ${REASON})`,
        );
      }
      // One's own conflict is declared, never raised.
      await s.expectError(
        "CDF_CONFLICT:OWN_CONFLICT",
        (tx) => tx`select api.raise_case_conflict(${caseB}, ${USERS.investigatorB}, ${REASON})`,
      );
      await s.expectError(
        "CDF_INVALID:reason",
        (tx) => tx`select api.raise_case_conflict(${caseB}, ${USERS.lead}, 'Too short')`,
      );
      const k1 = await raise(s, "investigatorB", "lead");
      await s.expectError(
        "CDF_CONFLICT:CONCERN_ALREADY_OPEN",
        (tx) => tx`select api.raise_case_conflict(${caseB}, ${USERS.lead}, ${REASON})`,
      );
      // Someone else may raise their own about the same person: a raiser learns only of their own open concern.
      const k2 = await raise(s, "grcDeputy", "lead");
      expect(k2).not.toBe(k1);

      // An open concern changes no access (DEC-F38 acts on an upheld conflict).
      await s.asOwner();
      const [c] = await s.tx<{ conflicted: boolean }[]>`
        select authz.has_conflict(${caseB}, ${USERS.lead}) as conflicted`;
      expect(c!.conflicted).toBe(false);
      // The ledger has the fact and the subject's id, never the reason (it stays in the row).
      expect(await ledger(s, k1)).toEqual([
        { action: "CASE_CONFLICT_RAISED", reason: null, metadata: { subject_user_id: USERS.lead } },
      ]);
      // Append-only: what was raised never changes and nothing is deleted.
      await s.expectError(
        "case conflict concern",
        (tx) =>
          tx`update case_mgmt.case_conflict_concern set reason = 'Synthetic: rewritten reason.' where id = ${k1}`,
      );
      await s.expectError(
        "case_mgmt.case_conflict_concern is append-only",
        (tx) => tx`delete from case_mgmt.case_conflict_concern where id = ${k1}`,
      );
    });
  });
});

describe("who reads a raised case conflict", () => {
  it("the raiser reads their own, conflict managers all; the subject, even a conflict manager, reads none", async () => {
    await scenario(async (s) => {
      // The GRC deputy (a conflict manager who sees case B) is the subject of both.
      const k1 = await raise(s, "investigatorB", "grcDeputy");
      const k2 = await raise(s, "caseManager", "grcDeputy");

      const own = await view(s, "investigatorB");
      expect(own.may_raise).toBe(true);
      expect(own.concerns.map((c) => [c.concern_id, c.reason, c.may_decide])).toEqual([[k1, REASON, false]]);
      expect(
        (await s.tx<{ id: string }[]>`select id from case_mgmt.case_conflict_concern`).map((r) => r.id),
      ).toEqual([k1]);

      const subject = await view(s, "grcDeputy");
      expect(subject.concerns).toEqual([]);
      expect(await s.tx`select id from case_mgmt.case_conflict_concern`).toEqual([]);
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) => tx`select api.decide_case_conflict(${k1}, 'DISMISSED', ${DECISION})`,
      );

      const director = await view(s, "grcDirector");
      expect(director.concerns.map((c) => [c.concern_id, c.may_decide])).toEqual([
        [k1, true],
        [k2, true],
      ]);
      // The case manager raised k2, so may decide only k1.
      const manager = await view(s, "caseManager");
      expect(manager.concerns.map((c) => [c.concern_id, c.may_decide])).toEqual([
        [k1, true],
        [k2, false],
      ]);

      // Nobody off the case reads either, and the read model answers as for a random case.
      for (const outsider of ["investigatorA", "lead", "committee", "platformAdmin"] as const) {
        await s.as(outsider);
        expect(await s.tx`select id from case_mgmt.case_conflict_concern`, outsider).toEqual([]);
        await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.case_conflict_concerns(${caseB})`);
        await s.expectError(
          "CDF_NOT_FOUND",
          (tx) => tx`select api.case_conflict_concerns(gen_random_uuid())`,
        );
      }
    });
  });
});

describe("deciding a raised case conflict", () => {
  it("a conflict manager on the case decides, never the raiser or the subject; dismissed changes nothing", async () => {
    await ownerScenario(async (s) => {
      const k1 = await raise(s, "investigatorB", "grcDeputy");
      const k2 = await raise(s, "caseManager", "grcDeputy");
      // The raiser without the permission, and the raiser holding it.
      await s.as("investigatorB");
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.decide_case_conflict(${k1}, 'UPHELD', ${DECISION})`,
      );
      await s.as("caseManager");
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.decide_case_conflict(${k2}, 'UPHELD', ${DECISION})`,
      );
      // The subject never sees it.
      await s.as("grcDeputy");
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) => tx`select api.decide_case_conflict(${k2}, 'DISMISSED', ${DECISION})`,
      );
      await s.as("grcDirector");
      await s.expectError(
        "CDF_INVALID:decision",
        (tx) => tx`select api.decide_case_conflict(${k1}, 'CONFIRMED', ${DECISION})`,
      );
      await s.expectError(
        "CDF_INVALID:reason",
        (tx) => tx`select api.decide_case_conflict(${k1}, 'DISMISSED', 'Too short')`,
      );
      await decide(s, "grcDirector", k1, "DISMISSED");
      await s.as("grcDirector");
      await s.expectError(
        "CDF_CONFLICT:NOTHING_TO_DECIDE",
        (tx) => tx`select api.decide_case_conflict(${k1}, 'UPHELD', ${DECISION})`,
      );
      expect(await seesCase(s, "grcDeputy")).toBe(true);
      // The raiser reads the decision; the ledger has the decision code, never its reasons.
      const own = await view(s, "investigatorB");
      expect(own.concerns.map((c) => [c.status, c.decision_reason])).toEqual([["DISMISSED", DECISION]]);
      await s.asOwner();
      expect((await ledger(s, k1)).map((e) => [e.action, e.reason, e.metadata])).toEqual([
        ["CASE_CONFLICT_RAISED", null, { subject_user_id: USERS.grcDeputy }],
        ["CASE_CONFLICT_DECIDED", null, { subject_user_id: USERS.grcDeputy, decision: "DISMISSED" }],
      ]);
      // Decided once: the decision is final.
      await s.expectError(
        "case conflict concern",
        (tx) => tx`update case_mgmt.case_conflict_concern set status = 'UPHELD' where id = ${k1}`,
      );
    });
  });
});

describe("an upheld case conflict suspends the subject's purposes on the case (DEC-F38, AMB-057)", () => {
  it("T-AMB-034: the subject gets NOT_FOUND through every purpose on the case; the account and other cases stay", async () => {
    await ownerScenario(async (s) => {
      // Investigator B is assigned to case B (and to case 0004).
      expect(await seesCase(s, "investigatorB")).toBe(true);
      const k = await raise(s, "caseManager", "investigatorB");
      expect(await seesCase(s, "investigatorB")).toBe(true);
      await decide(s, "grcDirector", k, "UPHELD");

      await s.as("investigatorB");
      expect(await s.tx`select id from case_mgmt.case_record where id = ${caseB}`).toEqual([]);
      const [opened] = await s.tx<{ ok: boolean }[]>`select api.open_case(${caseB}) as ok`;
      expect(opened!.ok).toBe(false);
      await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.case_conflict_concerns(${caseB})`);
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) => tx`select api.raise_case_conflict(${caseB}, ${USERS.grcDeputy}, ${REASON})`,
      );
      // Nor can the subject clear it by declaring no conflict.
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) => tx`select api.declare_conflict(${caseB}, false, 'Synthetic: no conflict.')`,
      );
      // Never the account: the user, their role and their other case stay.
      expect(await seesCase(s, "investigatorB", case4)).toBe(true);
      await s.asOwner();
      const [u] = await s.tx<{ status: string; roles: number; elsewhere: boolean }[]>`
        select u.status,
               (select count(*)::int from iam.user_role_assignment a
                 where a.user_id = u.id and a.revoked_at is null) as roles,
               authz.has_conflict(${case4}, u.id) as elsewhere
        from iam.user_profile u where u.id = ${USERS.investigatorB}`;
      expect(u).toEqual({ status: "ACTIVE", roles: 1, elsewhere: false });
      // The assignment on case B ended (revoke the affected purpose grant), and nobody can give it back.
      expect(
        await s.tx`select status, end_reason from case_mgmt.case_assignment
                   where case_id = ${caseB} and user_id = ${USERS.investigatorB}`,
      ).toEqual([{ status: "ENDED", end_reason: "Conflict of interest upheld" }]);
      await s.as("caseManager");
      await s.expectError(
        "CDF_CONFLICT:ASSIGNEE_HAS_CONFLICT",
        (tx) => tx`select api.assign_case(${caseB}, ${USERS.investigatorB}, 'INVESTIGATOR', ${REASON})`,
      );
      await s.expectError(
        "CDF_CONFLICT:GRANTEE_HAS_CONFLICT",
        (tx) => tx`select api.grant_case_access(${caseB}, ${USERS.investigatorB}, 'CASE', ${REASON}, null)`,
      );
      await s.asOwner();
      expect(
        (
          await s.tx<{ action: string; reason: string | null }[]>`
            select action, reason from audit.audit_event
            where case_id = ${caseB} and metadata ->> 'user_id' = ${USERS.investigatorB}
              and action = 'CASE_UNASSIGNED'`
        ).map((e) => [e.action, e.reason]),
      ).toEqual([["CASE_UNASSIGNED", "Conflict of interest upheld"]]);
      expect((await ledger(s, k)).map((e) => [e.action, e.metadata])).toEqual([
        ["CASE_CONFLICT_RAISED", { subject_user_id: USERS.investigatorB }],
        ["CASE_CONFLICT_DECIDED", { subject_user_id: USERS.investigatorB, decision: "UPHELD" }],
      ]);
    });
  });

  it("an active case grant of the subject is revoked with it", async () => {
    await ownerScenario(async (s) => {
      await s.as("caseManager");
      const [g] = await s.tx<{ id: string }[]>`
        select api.grant_case_access(${caseB}, ${USERS.dpo}, 'CASE', ${REASON}, null) as id`;
      expect(await seesCase(s, "dpo")).toBe(true);
      const k = await raise(s, "investigatorB", "dpo");
      await decide(s, "caseManager", k, "UPHELD");
      expect(await seesCase(s, "dpo")).toBe(false);
      await s.asOwner();
      expect(
        await s.tx`select status, revocation_reason from case_mgmt.case_access_grant where id = ${g!.id}`,
      ).toEqual([{ status: "REVOKED", revocation_reason: "Conflict of interest upheld" }]);
      const [e] = await s.tx<{ reason: string; metadata: Record<string, unknown> }[]>`
        select reason, metadata from audit.audit_event
        where action = 'CASE_ACCESS_REVOKED' and object_id = ${g!.id}::text`;
      expect(e).toEqual({
        reason: "Conflict of interest upheld",
        metadata: { user_id: USERS.dpo, scope: "CASE" },
      });
    });
  });

  it("committee participation stops absolutely: no proceeding, meeting, vote or invitation, and quorum follows", async () => {
    await scenario(async (s) => {
      await seat(s, ic, IC_SEATS);
      const f = await scheduleMeeting(s, ic, caseB);
      const voters = ["legal", "legalB", "lead", "committeeChair"] as const;
      await openWithPresent(s, f, [...voters]);
      const item = await openItem(s, f.meeting);
      await s.as("legal");
      expect(
        await s.tx`select id from committee.committee_proceeding where id = ${f.committeeProceeding}`,
      ).toHaveLength(1);

      const k = await raise(s, "caseManager", "legal");
      await decide(s, "grcDirector", k, "UPHELD");

      await s.as("legal");
      expect(
        await s.tx`select id from committee.committee_proceeding where id = ${f.committeeProceeding}`,
      ).toEqual([]);
      expect(await s.tx`select id from committee.meeting where id = ${f.meeting}`).toEqual([]);
      expect(await s.tx`select id from committee.vote_item`).toEqual([]);
      await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.cast_vote(${item}, 'APPROVE', null)`);
      await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.meeting_view(${f.meeting})`);
      // Three cleared voting members remain: they carry the vote.
      for (const u of ["legalB", "lead", "committeeChair"] as const) {
        await s.as(u);
        await s.tx`select api.cast_vote(${item}, 'APPROVE', null)`;
      }
      await s.as("committeeSecretary");
      await s.tx`select api.close_vote_item(${item}, null)`;
      expect(await s.tx`select eligible_count, result from committee.vote_item where id = ${item}`).toEqual([
        { eligible_count: 3, result: "APPROVED" },
      ]);
      // A later meeting of the proceeding does not invite them.
      const [m2] = await s.tx<{ id: string }[]>`
        select api.schedule_meeting(${f.committeeProceeding}, 'HEARING', 'TEAMS', null,
          'https://meet.example.test/synthetic', now() + interval '2 days', now() + interval '2 days 1 hour',
          ${MEETING_REASON}) as id`;
      const invited = await s.tx<{ user_id: string }[]>`
        select user_id from committee.meeting_participant where meeting_id = ${m2!.id}`;
      expect(invited.map((r) => r.user_id)).not.toContain(USERS.legal);
    });
  });
});

describe("a member who investigated the case does not judge it (AMB-053)", () => {
  it("T-AMB-030: a former investigator of the case is snapshotted non-voting and excluded; the preview counts it", async () => {
    await ownerScenario(async (s) => {
      await seat(s, ic, IC_SEATS);
      await s.as("caseManager");
      const [a] = await s.tx<{ id: string }[]>`
        select api.assign_case(${caseB}, ${USERS.lead}, 'LEAD_INVESTIGATOR', ${REASON}) as id`;
      await s.tx`select api.end_assignment(${a!.id}, 'Synthetic: the lead hands the case back.')`;
      const [p] = await s.tx<{ p: Record<string, unknown> }[]>`
        select api.committee_referral_preview(${caseB}, ${ic}) as p`;
      expect(p!.p).toMatchObject({ voting: 3, cleared: 4, not_cleared: 1, firewall_restricted: 0 });

      const cp = await refer(s, ic, caseB);
      await s.asOwner();
      const [m] = await s.tx<{ is_voting: boolean; case_gate_excluded: boolean }[]>`
        select is_voting, case_gate_excluded from committee.proceeding_member
        where committee_proceeding_id = ${cp} and user_id = ${USERS.lead}`;
      expect(m).toEqual({ is_voting: false, case_gate_excluded: true });
      const [e] = await s.tx<{ m: Record<string, unknown> }[]>`
        select metadata as m from audit.audit_event
        where action = 'COMMITTEE_PROCEEDING_OPENED' and object_id = ${cp}::text`;
      expect(e!.m).toMatchObject({
        voting_members: 3,
        case_gate_excluded_members: 1,
        prior_investigator_members: 1,
      });
      // No view of the proceeding as a member, and no invitation to its meetings.
      await s.as("lead");
      expect(await s.tx`select id from committee.committee_proceeding where id = ${cp}`).toEqual([]);
      await s.as("committeeSecretary");
      const [mt] = await s.tx<{ id: string }[]>`
        select api.schedule_meeting(${cp}, 'DELIBERATION', 'IN_PERSON', 'Room (synthetic)', null,
          now() + interval '1 day', now() + interval '1 day 1 hour', ${MEETING_REASON}) as id`;
      const invited = await s.tx<{ user_id: string }[]>`
        select user_id from committee.meeting_participant where meeting_id = ${mt!.id}`;
      expect(invited.map((r) => r.user_id)).not.toContain(USERS.lead);
    });
  });

  it("a current investigator keeps the case-team purpose but is not a member of the proceeding", async () => {
    await ownerScenario(async (s) => {
      await seat(s, ic, IC_SEATS);
      await s.as("caseManager");
      await s.tx`select api.assign_case(${caseB}, ${USERS.lead}, 'LEAD_INVESTIGATOR', ${REASON})`;
      const cp = await refer(s, ic, caseB);
      await s.asOwner();
      const [m] = await s.tx<{ is_voting: boolean; case_gate_excluded: boolean }[]>`
        select is_voting, case_gate_excluded from committee.proceeding_member
        where committee_proceeding_id = ${cp} and user_id = ${USERS.lead}`;
      expect(m).toEqual({ is_voting: false, case_gate_excluded: true });
      // The investigation stays: the lead still sees the case (and so the proceeding, as the case team does).
      expect(await seesCase(s, "lead")).toBe(true);
      await s.as("committeeSecretary");
      const [mt] = await s.tx<{ id: string }[]>`
        select api.schedule_meeting(${cp}, 'DELIBERATION', 'IN_PERSON', 'Room (synthetic)', null,
          now() + interval '1 day', now() + interval '1 day 1 hour', ${MEETING_REASON}) as id`;
      const invited = await s.tx<{ user_id: string }[]>`
        select user_id from committee.meeting_participant where meeting_id = ${mt!.id}`;
      expect(invited.map((r) => r.user_id)).not.toContain(USERS.lead);
    });
  });

  it("a member sitting on an open proceeding is not assigned to investigate it; the amendment refuses a prior investigator", async () => {
    await ownerScenario(async (s) => {
      await seat(s, ic, IC_SEATS);
      await refer(s, ic, caseB);
      await s.as("caseManager");
      await s.expectError(
        "CDF_CONFLICT:COMMITTEE_MEMBER_OF_CASE",
        (tx) => tx`select api.assign_case(${caseB}, ${USERS.lead}, 'LEAD_INVESTIGATOR', ${REASON})`,
      );
    });
    await ownerScenario(async (s) => {
      // The lead is appointed to the committee after the referral, having investigated the case.
      await seat(
        s,
        ic,
        IC_SEATS.filter(([u]) => u !== "lead"),
      );
      await s.as("caseManager");
      await s.tx`select api.assign_case(${caseB}, ${USERS.lead}, 'LEAD_INVESTIGATOR', ${REASON})`;
      const cp = await refer(s, ic, caseB);
      await s.as("platformAdmin");
      const [ms] = await s.tx<{ id: string }[]>`
        select api.appoint_committee_member(${ic}, ${USERS.lead}, 'MEMBER', now() - interval '1 hour', null,
          'DEMO-APPT') as id`;
      await s.as("committeeSecretary");
      await s.expectError(
        "CDF_CONFLICT:PRIOR_INVESTIGATOR",
        (tx) => tx`select api.amend_proceeding_snapshot(${cp}, ${ms!.id}, ${REASON})`,
      );
    });
  });

  it("configured off (DEC-05 answered), a former investigator votes as before", async () => {
    await ownerScenario(async (s) => {
      await setPriorInvestigatorRule(s, "false");
      await seat(s, ic, IC_SEATS);
      await s.as("caseManager");
      const [a] = await s.tx<{ id: string }[]>`
        select api.assign_case(${caseB}, ${USERS.lead}, 'LEAD_INVESTIGATOR', ${REASON}) as id`;
      await s.tx`select api.end_assignment(${a!.id}, 'Synthetic: the lead hands the case back.')`;
      const cp = await refer(s, ic, caseB);
      await s.asOwner();
      const [m] = await s.tx<{ is_voting: boolean; case_gate_excluded: boolean }[]>`
        select is_voting, case_gate_excluded from committee.proceeding_member
        where committee_proceeding_id = ${cp} and user_id = ${USERS.lead}`;
      expect(m).toEqual({ is_voting: true, case_gate_excluded: false });
      // Any value but 'false' keeps the rule (fail safe).
      await setPriorInvestigatorRule(s, "no");
      const [r] = await s.tx<
        { on: boolean }[]
      >`select authz.prior_investigator_conflicted(${USERS.lead}, ${caseB}) as on`;
      expect(r!.on).toBe(true);
    });
  });

  it("the rule's helpers answer about any user, so no application role may call them", async () => {
    await scenario(async (s) => {
      await s.as("caseManager");
      await s.expectError(
        "permission denied",
        (tx) => tx`select authz.prior_investigator_conflicted(${USERS.lead}, ${caseB})`,
      );
      await s.expectError("permission denied", (tx) => tx`select case_mgmt.prior_investigator_rule()`);
    });
  });
});
