// AGENT-09 review of migrations 1870/1880 (P1a, P1b) and owner decision DEC-61 (restricted case referral needs the
// Restricted Case Authority's approval). A committee seat gives a proceeding only to people cleared for the case:
// uncleared or conflicted seat holders are snapshotted as excluded and see nothing, and a case conflict declared
// after the snapshot removes access at once. Required negative tests 1, 2, 3 and 6.
import { beforeAll, describe, expect, it } from "vitest";
import { USERS, caseId, ownerScenario, scenario, type Scenario, type UserKey } from "../support/db";
import {
  IC_SEATS,
  REASON,
  committeeIds,
  preliminaryReferral,
  refer,
  scheduleMeeting,
  seat,
} from "../support/committee";

let caseB: string, caseExec: string, ic: string, gc: string;

beforeAll(async () => {
  [caseB, caseExec] = await Promise.all([caseId("0002"), caseId("0003")]);
  ({ ic, gc } = await committeeIds());
});

const sees = async (s: Scenario, user: UserKey, committeeProceeding: string) => {
  await s.as(user);
  const cp = await s.tx`select id from committee.committee_proceeding where id = ${committeeProceeding}`;
  const pm =
    await s.tx`select id from committee.proceeding_member where committee_proceeding_id = ${committeeProceeding}`;
  const p = await s.tx`select p.id from case_mgmt.proceeding p
                       join committee.committee_proceeding cp on cp.proceeding_id = p.id
                       where cp.id = ${committeeProceeding}`;
  return cp.length + pm.length + p.length > 0;
};

describe("committee proceedings are per committee (required test 1)", () => {
  it("a Grievance Committee seat gives no view of an Investigation Committee proceeding", async () => {
    await scenario(async (s) => {
      await seat(s, ic, IC_SEATS);
      await seat(s, gc, [
        ["committeeChair", "CHAIR"],
        ["committeeSecretary", "SECRETARY"],
        ["committee", "MEMBER"],
      ]);
      const cp = await refer(s, ic, caseB);
      expect(await sees(s, "legal", cp)).toBe(true);
      expect(await sees(s, "committee", cp)).toBe(false);
      await s.as("committee");
      expect(await s.tx`select id from committee.meeting`).toEqual([]);
    });
  });
});

describe("conflicted seat holders (required test 2, AGENT-09 P1b)", () => {
  it("a member with a declared case conflict is snapshotted as excluded, non-voting, and sees nothing", async () => {
    await ownerScenario(async (s) => {
      await s.asOwner();
      await s.tx`insert into case_mgmt.conflict_check (case_id, user_id, status, declaration)
                 values (${caseB}, ${USERS.legal}, 'CONFLICT_DECLARED', 'Synthetic conflict')`;
      await seat(s, ic, IC_SEATS);
      const cp = await refer(s, ic, caseB);
      await s.asOwner();
      const [m] = await s.tx<{ is_voting: boolean; case_gate_excluded: boolean }[]>`
        select is_voting, case_gate_excluded from committee.proceeding_member
        where committee_proceeding_id = ${cp} and user_id = ${USERS.legal}`;
      expect(m).toEqual({ is_voting: false, case_gate_excluded: true });
      expect(await sees(s, "legal", cp)).toBe(false);
      // Not placed in that proceeding's meetings either.
      await s.as("committeeSecretary");
      const [mt] = await s.tx<{ id: string }[]>`
        select api.schedule_meeting(${cp}, 'HEARING', 'TEAMS', null, 'https://meet.example.test/synthetic',
          now() + interval '1 day', now() + interval '1 day 1 hour', ${REASON}) as id`;
      const users = await s.tx<{ user_id: string }[]>`
        select user_id from committee.meeting_participant where meeting_id = ${mt!.id}`;
      expect(users.map((u) => u.user_id)).not.toContain(USERS.legal);
    });
  });

  it("a case conflict declared after the snapshot removes the proceeding, the meeting and the vote at once", async () => {
    await ownerScenario(async (s) => {
      await seat(s, ic, IC_SEATS);
      const f = await scheduleMeeting(s, ic, caseB);
      for (const u of ["legal", "legalB", "lead", "committeeChair"] as const) {
        await s.as(u);
        await s.tx`select api.declare_meeting_conflict(${f.participant[u]!}, 'NO_CONFLICT', null)`;
      }
      await s.as("committeeSecretary");
      await s.tx`select api.open_meeting(${f.meeting}, ${REASON})`;
      for (const u of ["legal", "legalB", "lead", "committeeChair"] as const) {
        await s.tx`select api.record_attendance(${f.participant[u]!}, 'PRESENT')`;
      }
      const [item] = await s.tx<{ id: string }[]>`
        select api.open_vote_item(${f.meeting}, 'OTHER', null, 'Recommendation (synthetic)') as id`;
      expect(await sees(s, "legal", f.committeeProceeding)).toBe(true);

      await s.asOwner();
      await s.tx`insert into case_mgmt.conflict_check (case_id, user_id, status, declaration)
                 values (${caseB}, ${USERS.legal}, 'CONFLICT_DECLARED', 'Synthetic conflict')`;
      expect(await sees(s, "legal", f.committeeProceeding)).toBe(false);
      await s.as("legal");
      expect(await s.tx`select id from committee.meeting where id = ${f.meeting}`).toEqual([]);
      expect(await s.tx`select id from committee.vote_item`).toEqual([]);
      await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.cast_vote(${item!.id}, 'APPROVE', null)`);
      // Eligibility follows: three cleared voting members remain, so a quorum is two, not three of four.
      for (const u of ["legalB", "lead", "committeeChair"] as const) {
        await s.as(u);
        await s.tx`select api.cast_vote(${item!.id}, 'APPROVE', null)`;
      }
      await s.as("committeeSecretary");
      await s.tx`select api.close_vote_item(${item!.id}, null)`;
      const [t] = await s.tx<{ eligible_count: number; result: string }[]>`
        select eligible_count, result from committee.vote_item where id = ${item!.id}`;
      expect(t).toEqual({ eligible_count: 3, result: "APPROVED" });
    });
  });
});

describe("restricted cases and uncleared seats (required test 3, DEC-61)", () => {
  it("a restricted case is refused without its authority's approval; uncleared seats are excluded once approved", async () => {
    await scenario(async (s) => {
      await seat(s, ic, [
        ["committeeChair", "CHAIR"], // CONFIDENTIAL
        ["committeeSecretary", "SECRETARY"], // CONFIDENTIAL
        ["legal", "MEMBER"], // CONFIDENTIAL
        ["grcDeputy", "MEMBER"], // SECRET: the only seat cleared for the case
      ]);
      await s.as("grcDirector"); // the case owner and its Restricted Case Authority (DEC-01)
      await s.expectError(
        "CDF_CONFLICT:AUTHORITY_APPROVAL_REQUIRED",
        (tx) => tx`select api.refer_case_to_committee(${caseExec}, ${ic}, null, ${REASON})`,
      );
      // Only the case's own authority approves: not another SECRET GRC user, not someone who cannot see the case.
      await s.as("grcDeputy");
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) => tx`select api.approve_restricted_committee_referral(${caseExec}, ${ic}, ${REASON})`,
      );
      await s.as("caseManager");
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) => tx`select api.approve_restricted_committee_referral(${caseExec}, ${ic}, ${REASON})`,
      );
      await s.as("grcDirector");
      await s.expectError(
        "CDF_CONFLICT:CASE_NOT_RESTRICTED",
        (tx) => tx`select api.approve_restricted_committee_referral(${caseB}, ${ic}, ${REASON})`,
      );
      // AMB-018 (migration 2030): the preliminary review referred the case.
      await preliminaryReferral(s, caseExec);
      await s.as("grcDirector");
      const [a] = await s.tx<{ id: string }[]>`
        select api.approve_restricted_committee_referral(${caseExec}, ${ic}, ${REASON}) as id`;
      const [cp] = await s.tx<{ id: string }[]>`
        select api.refer_case_to_committee(${caseExec}, ${ic}, null, ${REASON}) as id`;
      const [used] = await s.tx<{ committee_proceeding_id: string }[]>`
        select committee_proceeding_id from committee.restricted_referral_approval where id = ${a!.id}`;
      expect(used!.committee_proceeding_id).toBe(cp!.id);

      const members = await s.tx<{ user_id: string; is_voting: boolean; case_gate_excluded: boolean }[]>`
        select user_id, is_voting, case_gate_excluded from committee.proceeding_member
        where committee_proceeding_id = ${cp!.id} order by user_id`;
      expect(members).toEqual(
        [
          { user_id: USERS.committeeChair, is_voting: false, case_gate_excluded: true },
          { user_id: USERS.legal, is_voting: false, case_gate_excluded: true },
          { user_id: USERS.committeeSecretary, is_voting: false, case_gate_excluded: true },
          { user_id: USERS.grcDeputy, is_voting: true, case_gate_excluded: false },
        ].sort((x, y) => x.user_id.localeCompare(y.user_id)),
      );
      for (const u of ["committeeChair", "committeeSecretary", "legal"] as const) {
        expect(await sees(s, u, cp!.id), u).toBe(false);
      }
      expect(await sees(s, "grcDeputy", cp!.id)).toBe(true);
      // The uncleared secretary cannot run a meeting on it.
      await s.as("committeeSecretary");
      await s.expectError(
        "CDF_NOT_FOUND",
        (tx) =>
          tx`select api.schedule_meeting(${cp!.id}, 'DELIBERATION', 'IN_PERSON', 'Room (synthetic)', null, now() + interval '1 day', now() + interval '1 day 1 hour', ${REASON})`,
      );
    });
  });
});

describe("committee seats never reach the reporter's identity (required test 6)", () => {
  it.each<UserKey>(["legal", "committeeSecretary", "committeeChair"])(
    "%s, seated on a proceeding of the case, cannot resolve the reporter identity",
    async (user) => {
      await scenario(async (s) => {
        await seat(s, ic, IC_SEATS);
        await scheduleMeeting(s, ic, caseB);
        await s.as(user);
        await s.expectError(
          "CDF_NOT_FOUND",
          (tx) =>
            tx`select * from api.resolve_reporter_identity(${caseB}, 'Synthetic: committee asks for the identity.')`,
        );
        await s.expectError(
          "permission denied",
          (tx) => tx`select * from protected_identity.reporter_identity`,
        );
      });
    },
  );
});
