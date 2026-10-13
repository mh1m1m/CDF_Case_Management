// Business architecture rebase, migration 1890 (ADR-020; owner Q&A Q41–Q70, Q97–Q98; AUTHORIZATION_IMPACT.md N4–N8).
// Conflict of interest, attendance, quorum and voting are enforced by the database: a conflicted or undeclared
// member is never present, never votes and never counts; the secretary records only non-substantive votes; votes
// are not selectable and their choices stay hidden until the item closes; the casting vote exists only on a tie the
// rule lets the chair break. Minutes are reviewed by attending members and deemed approved only after the window and
// a reminder.
import { beforeAll, describe, expect, it } from "vitest";
import { USERS, caseId, ownerScenario, scenario, type Scenario, type UserKey } from "../support/db";
import {
  IC_SEATS,
  REASON,
  committeeIds,
  openItem,
  preliminaryReferral,
  openWithPresent,
  scheduleMeeting,
  seat,
  vote,
  type MeetingFixture,
} from "../support/committee";
import { caseFacts } from "../support/decision";

let caseB: string, ic: string, gc: string;

beforeAll(async () => {
  caseB = await caseId("0002");
  ({ ic, gc } = await committeeIds());
});

const VOTERS: UserKey[] = ["committeeChair", "legal", "legalB", "lead"];

async function ready(s: Scenario, present: UserKey[] = VOTERS): Promise<MeetingFixture> {
  await seat(s, ic, IC_SEATS);
  const f = await scheduleMeeting(s, ic, caseB);
  await openWithPresent(s, f, present);
  return f;
}

async function itemRow(s: Scenario, item: string) {
  await s.as("committeeSecretary");
  const [r] = await s.tx<
    {
      status: string;
      result: string | null;
      eligible_count: number;
      present_count: number;
      quorum_required: number;
    }[]
  >`select status, result, eligible_count, present_count, quorum_required from committee.vote_item where id = ${item}`;
  return r!;
}

describe("meetings: scheduling and visibility", () => {
  it("scheduling copies the cleared proceeding members, all PENDING; only the seated secretary schedules", async () => {
    await scenario(async (s) => {
      await seat(s, ic, IC_SEATS);
      const f = await scheduleMeeting(s, ic, caseB);
      const rows = await s.tx<{ seat: string; is_voting: boolean; coi_status: string; attendance: string }[]>`
        select seat, is_voting, coi_status, attendance from committee.meeting_participant where meeting_id = ${f.meeting}
        order by seat`;
      expect(rows.map((r) => r.seat)).toEqual(["CHAIR", "MEMBER", "MEMBER", "MEMBER", "SECRETARY"]);
      expect(new Set(rows.map((r) => r.coi_status))).toEqual(new Set(["PENDING"]));
      expect(rows.filter((r) => r.is_voting)).toHaveLength(4);
      // A seated member cannot schedule; a global COMMITTEE_SECRETARY role without a seat sees nothing.
      await s.as("legal");
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) =>
          tx`select api.schedule_meeting(${f.committeeProceeding}, 'HEARING', 'IN_PERSON', 'Room (synthetic)', null, now() + interval '2 days', now() + interval '2 days 1 hour', ${REASON})`,
      );
      for (const outsider of ["committee", "platformAdmin", "grcSectorHead", "investigatorA"] as const) {
        await s.as(outsider);
        expect(await s.tx`select id from committee.meeting`, outsider).toEqual([]);
        expect(await s.tx`select id from committee.meeting_participant`, outsider).toEqual([]);
      }
    });
  });

  it("validates mode, location, link and times", async () => {
    await scenario(async (s) => {
      await seat(s, ic, IC_SEATS);
      const f = await scheduleMeeting(s, ic, caseB);
      await s.as("committeeSecretary");
      const at = (mode: string, location: string | null, url: string | null) =>
        s.expectError(
          "CDF_INVALID",
          (tx) =>
            tx`select api.schedule_meeting(${f.committeeProceeding}, 'DELIBERATION', ${mode}, ${location}, ${url}, now() + interval '1 day', now() + interval '1 day 1 hour', ${REASON})`,
        );
      await at("IN_PERSON", null, null);
      await at("TEAMS", null, null);
      await at("TEAMS", null, "http://insecure.example.test/x");
      await at("HYBRID", "Room (synthetic)", null);
      await at("VIDEO", "Room (synthetic)", null);
      await s.expectError(
        "CDF_INVALID:scheduled_end",
        (tx) =>
          tx`select api.schedule_meeting(${f.committeeProceeding}, 'DELIBERATION', 'IN_PERSON', 'Room (synthetic)', null, now() + interval '1 day', now() + interval '1 day', ${REASON})`,
      );
    });
  });

  it("an invitee sees the meeting's logistics but no deliberation; a grievance-firewalled member is a witness at most", async () => {
    await scenario(async (s) => {
      await seat(s, ic, IC_SEATS);
      const f = await scheduleMeeting(s, ic, caseB);
      await s.as("committeeSecretary");
      const [inv] = await s.tx<{ id: string }[]>`
        select api.invite_to_meeting(${f.meeting}, 'EXPERT', ${USERS.investigatorB}, null, true, ${REASON}) as id`;
      await s.expectError(
        "CDF_CONFLICT:ALREADY_INVITED",
        (tx) =>
          tx`select api.invite_to_meeting(${f.meeting}, 'WITNESS', ${USERS.investigatorB}, null, false, ${REASON})`,
      );
      // A user who is not cleared for the case cannot be invited (platformAdmin: INTERNAL clearance).
      await s.expectError(
        "CDF_INVALID:user_id",
        (tx) =>
          tx`select api.invite_to_meeting(${f.meeting}, 'EXPERT', ${USERS.platformAdmin}, null, true, ${REASON})`,
      );
      await s.expectError(
        "CDF_INVALID:person_id",
        (tx) =>
          tx`select api.invite_to_meeting(${f.meeting}, 'SUBJECT', ${USERS.investigatorA}, null, false, ${REASON})`,
      );
      await openWithPresent(s, f, VOTERS);
      await openItem(s, f.meeting);
      await s.as("investigatorB");
      await s.tx`select api.declare_meeting_conflict(${inv!.id}, 'NO_CONFLICT', null)`;
      expect(await s.tx`select id from committee.meeting where id = ${f.meeting}`).toHaveLength(1);
      expect(await s.tx`select id from committee.vote_item`).toEqual([]);
      expect(await s.tx`select id from committee.minutes`).toEqual([]);
      // AGENT-09 V4: an invitee outside the case team sees their own participant row, not the seats, conflicts or
      // other invitees.
      await s.as("committeeSecretary");
      const [expert] = await s.tx<{ id: string }[]>`
        select api.invite_to_meeting(${f.meeting}, 'EXPERT', ${USERS.employeeB}, null, false, ${REASON}) as id`;
      await s.as("employeeB");
      expect(await s.tx`select id from committee.meeting where id = ${f.meeting}`).toHaveLength(1);
      expect(await s.tx`select id from committee.meeting_participant`).toEqual([{ id: expert!.id }]);
      expect(await s.tx`select id from committee.vote_item`).toEqual([]);
    });
  });

  it("on a grievance, a member who voted in the case's Investigation Committee may be invited only as witness, expert or information provider (Q45–Q46)", async () => {
    await scenario(async (s) => {
      await seat(s, ic, IC_SEATS);
      await seat(s, gc, [
        ["committeeChair", "CHAIR"],
        ["committeeSecretary", "SECRETARY"],
        ["legal", "MEMBER"],
        ["investigatorA", "MEMBER"],
      ]);
      await preliminaryReferral(s, caseB); // AMB-018 (migration 2030)
      await s.as("caseManager");
      const [icp] = await s.tx<
        { id: string }[]
      >`select api.refer_case_to_committee(${caseB}, ${ic}, null, ${REASON}) as id`;
      const [gcp] = await s.tx<
        { id: string }[]
      >`select api.refer_case_to_committee(${caseB}, ${gc}, null, ${REASON}) as id`;
      expect(icp).toBeDefined();
      await s.as("committeeSecretary");
      const [m] = await s.tx<{ id: string }[]>`
        select api.schedule_meeting(${gcp!.id}, 'HEARING', 'IN_PERSON', 'Room (synthetic)', null, now() + interval '1 day', now() + interval '1 day 1 hour', ${REASON}) as id`;
      const members = await s.tx<{ user_id: string }[]>`
        select user_id from committee.meeting_participant where meeting_id = ${m!.id}`;
      // legal and the chair voted on the IC: firewall-restricted on the GC, so not copied in as members.
      expect(members.map((r) => r.user_id).sort()).toEqual(
        [USERS.committeeSecretary, USERS.investigatorA].sort(),
      );
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.invite_to_meeting(${m!.id}, 'LEGAL', ${USERS.legal}, null, true, ${REASON})`,
      );
      await s.tx`select api.invite_to_meeting(${m!.id}, 'WITNESS', ${USERS.legal}, null, true, ${REASON})`;
    });
  });
});

describe("conflict of interest and attendance (N4, N5)", () => {
  it("a PENDING or conflicted member cannot be recorded present, cannot vote and does not count", async () => {
    await scenario(async (s) => {
      await seat(s, ic, IC_SEATS);
      const f = await scheduleMeeting(s, ic, caseB);
      for (const u of ["committeeChair", "legal"] as const) {
        await s.as(u);
        await s.tx`select api.declare_meeting_conflict(${f.participant[u]!}, 'NO_CONFLICT', null)`;
      }
      await s.as("legalB");
      await s.expectError(
        "CDF_INVALID:reason",
        (tx) => tx`select api.declare_meeting_conflict(${f.participant.legalB!}, 'CONFLICT_DECLARED', null)`,
      );
      await s.tx`select api.declare_meeting_conflict(${f.participant.legalB!}, 'CONFLICT_DECLARED', 'Synthetic: related party.')`;
      // A declared conflict cannot be withdrawn, and nobody declares for another member.
      await s.expectError(
        "CDF_CONFLICT:COI_ALREADY_DECLARED",
        (tx) => tx`select api.declare_meeting_conflict(${f.participant.legalB!}, 'NO_CONFLICT', null)`,
      );
      await s.as("committeeSecretary");
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.declare_meeting_conflict(${f.participant.lead!}, 'NO_CONFLICT', null)`,
      );
      await s.tx`select api.open_meeting(${f.meeting}, ${REASON})`;
      await s.expectError(
        "CDF_CONFLICT:COI_NOT_CLEARED",
        (tx) => tx`select api.record_attendance(${f.participant.lead!}, 'PRESENT')`, // PENDING (N5)
      );
      await s.expectError(
        "CDF_CONFLICT:COI_NOT_CLEARED",
        (tx) => tx`select api.record_attendance(${f.participant.legalB!}, 'PRESENT')`, // conflicted (N4)
      );
      await s.tx`select api.record_attendance(${f.participant.legalB!}, 'EXCUSED_CONFLICT')`;
      await s.tx`select api.record_attendance(${f.participant.committeeChair!}, 'PRESENT')`;
      await s.tx`select api.record_attendance(${f.participant.legal!}, 'PRESENT')`;
      const item = await openItem(s, f.meeting);
      // A member who has not declared sees no deliberation until they do (AGENT-09 V3), so cannot vote either.
      await s.as("lead");
      expect(await s.tx`select id from committee.vote_item`).toEqual([]);
      await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.vote_item_status(${item})`);
      await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.cast_vote(${item}, 'APPROVE', null)`);
      await s.as("legalB");
      expect(await s.tx`select id from committee.vote_item`).toEqual([]); // no deliberation for the conflicted
      await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.cast_vote(${item}, 'APPROVE', null)`);
      await vote(s, "committeeChair", item, "APPROVE");
      await vote(s, "legal", item, "REJECT");
      await s.as("committeeSecretary");
      await s.tx`select api.close_vote_item(${item}, null)`;
      // Eligible = voting members with NO_CONFLICT: the chair and legal. PENDING (lead) and conflicted (legalB) do not count.
      const r = await itemRow(s, item);
      expect(r.eligible_count).toBe(2);
      expect(r.present_count).toBe(2);
    });
  });

  it("a conflict declared in one meeting carries into the proceeding's later meetings", async () => {
    await scenario(async (s) => {
      await seat(s, ic, IC_SEATS);
      const f = await scheduleMeeting(s, ic, caseB);
      await s.as("legal");
      await s.tx`select api.declare_meeting_conflict(${f.participant.legal!}, 'CONFLICT_DECLARED', 'Synthetic: related party.')`;
      await s.as("committeeSecretary");
      const [m2] = await s.tx<{ id: string }[]>`
        select api.schedule_meeting(${f.committeeProceeding}, 'DELIBERATION', 'IN_PERSON', 'Room (synthetic)', null,
          now() + interval '3 days', now() + interval '3 days 1 hour', ${REASON}) as id`;
      const [p2] = await s.tx<{ id: string }[]>`
        select id from committee.meeting_participant where meeting_id = ${m2!.id} and user_id = ${USERS.legal}`;
      await s.as("legal");
      await s.expectError(
        "CDF_CONFLICT:PRIOR_CONFLICT_DECLARED",
        (tx) => tx`select api.declare_meeting_conflict(${p2!.id}, 'NO_CONFLICT', null)`,
      );
      await s.tx`select api.declare_meeting_conflict(${p2!.id}, 'CONFLICT_DECLARED', 'Synthetic: still related.')`;
    });
  });

  it("the database refuses a present row for a conflicted participant", async () => {
    await ownerScenario(async (s) => {
      await seat(s, ic, IC_SEATS);
      const f = await scheduleMeeting(s, ic, caseB);
      await s.asOwner();
      await s.expectError(
        "new row for relation",
        (tx) =>
          tx`update committee.meeting_participant set attendance = 'PRESENT' where id = ${f.participant.lead!}`,
      );
    });
  });
});

describe("voting (N6, N7, N8)", () => {
  it("the secretary records only absence, inability or recusal for a member, never a substantive vote (N6)", async () => {
    await scenario(async (s) => {
      const f = await ready(s, ["committeeChair", "legal", "legalB"]);
      const item = await openItem(s, f.meeting);
      await s.as("committeeSecretary");
      for (const choice of ["APPROVE", "REJECT", "ABSTAIN"]) {
        await s.expectError(
          "CDF_FORBIDDEN",
          (tx) =>
            tx`select api.record_vote_for_member(${item}, ${f.participant.legal!}, ${choice}, 'Synthetic: on behalf.', null)`,
        );
      }
      // A present member votes for themself, recusal included: the secretary cannot pre-empt them (AGENT-09 V1b).
      for (const choice of ["ABSENT", "UNABLE_TO_VOTE", "RECUSED"]) {
        await s.expectError(
          "CDF_CONFLICT:MEMBER_PRESENT",
          (tx) =>
            tx`select api.record_vote_for_member(${item}, ${f.participant.legal!}, ${choice}, 'Synthetic: on behalf.', null)`,
        );
      }
      await s.expectError(
        "CDF_INVALID:reason",
        (tx) =>
          tx`select api.record_vote_for_member(${item}, ${f.participant.lead!}, 'UNABLE_TO_VOTE', null, null)`,
      );
      await s.tx`select api.record_vote_for_member(${item}, ${f.participant.lead!}, 'UNABLE_TO_VOTE', 'Synthetic: not reachable.', null)`;
      await s.expectError(
        "CDF_CONFLICT:ALREADY_VOTED",
        (tx) =>
          tx`select api.record_vote_for_member(${item}, ${f.participant.lead!}, 'ABSENT', 'Synthetic: on behalf.', null)`,
      );
      // A member cannot record for another member either.
      await s.as("legalB");
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) =>
          tx`select api.record_vote_for_member(${item}, ${f.participant.committeeChair!}, 'ABSENT', 'Synthetic: on behalf.', null)`,
      );
      await vote(s, "legal", item, "APPROVE");
    });
  });

  it("attendance is frozen while a vote is undecided, so the secretary cannot drop a counted vote (AGENT-09 V1a)", async () => {
    await scenario(async (s) => {
      const f = await ready(s, ["committeeChair", "legal", "legalB"]);
      const item = await openItem(s, f.meeting);
      await vote(s, "legal", item, "APPROVE");
      await s.as("committeeSecretary");
      await s.expectError(
        "CDF_CONFLICT:VOTE_IN_PROGRESS",
        (tx) => tx`select api.record_attendance(${f.participant.legal!}, 'ABSENT')`,
      );
      // A late arrival cannot be added mid-vote either.
      await s.as("lead");
      await s.tx`select api.declare_meeting_conflict(${f.participant.lead!}, 'NO_CONFLICT', null)`;
      await s.as("committeeSecretary");
      await s.expectError(
        "CDF_CONFLICT:VOTE_IN_PROGRESS",
        (tx) => tx`select api.record_attendance(${f.participant.lead!}, 'PRESENT')`,
      );
      await vote(s, "legalB", item, "REJECT");
      await vote(s, "committeeChair", item, "REJECT");
      await s.as("committeeSecretary");
      expect((await s.tx<{ r: string }[]>`select api.close_vote_item(${item}, null) as r`)[0]!.r).toBe(
        "REJECTED",
      );
      const [t] = await s.tx<{ approve_count: number; excluded_count: number }[]>`
        select approve_count, excluded_count from committee.vote_item where id = ${item}`;
      expect(t).toEqual({ approve_count: 1, excluded_count: 0 });
      // Once every item is decided, attendance can change again.
      await s.tx`select api.record_attendance(${f.participant.lead!}, 'PRESENT')`;
    });
  });

  it("votes are not selectable, and choices stay hidden until the item closes (N7, Q61–Q63)", async () => {
    await scenario(async (s) => {
      const f = await ready(s);
      const item = await openItem(s, f.meeting);
      await vote(s, "legal", item, "APPROVE");
      for (const u of ["legal", "committeeSecretary", "committeeChair", "grcDirector"] as const) {
        await s.as(u);
        await s.expectError("permission denied", (tx) => tx`select * from committee.vote`);
        await s.expectError("permission denied", (tx) => tx`select * from committee.casting_vote`);
      }
      await s.as("legalB");
      const [open] = await s.tx<
        { v: { voters: { user_id: string; has_voted: boolean; choice: string | null }[]; tally: unknown } }[]
      >`
        select api.vote_item_status(${item}) as v`;
      expect(open!.v.tally).toBeNull();
      const legalRow = open!.v.voters.find((v) => v.user_id === USERS.legal)!;
      expect(legalRow).toMatchObject({ has_voted: true, choice: null });
      // The audit ledger records that a vote was cast, not what it was.
      await s.as("dpo");
      const [ev] = await s.tx<{ metadata: Record<string, unknown> }[]>`
        select metadata from audit.audit_event where action = 'VOTE_CAST' and object_id = ${item}`;
      expect(JSON.stringify(ev!.metadata)).not.toContain("APPROVE");
      for (const u of ["legalB", "lead", "committeeChair"] as const) await vote(s, u, item, "APPROVE");
      await s.as("committeeSecretary");
      expect((await s.tx<{ r: string }[]>`select api.close_vote_item(${item}, null) as r`)[0]!.r).toBe(
        "APPROVED",
      );
      await s.as("legalB");
      const [closed] = await s.tx<
        { v: { voters: { user_id: string; choice: string }[]; tally: { approve: number } } }[]
      >`
        select api.vote_item_status(${item}) as v`;
      expect(closed!.v.tally.approve).toBe(4);
      expect(closed!.v.voters.find((v) => v.user_id === USERS.legal)!.choice).toBe("APPROVE");
      // Outsiders and the case team without a meeting seat get nothing.
      for (const u of ["caseManager", "committee", "platformAdmin"] as const) {
        await s.as(u);
        await s.expectError("CDF_NOT_FOUND", (tx) => tx`select api.vote_item_status(${item})`);
      }
    });
  });

  it("closing needs every present eligible member's vote, and quorum from the rule snapshot", async () => {
    await scenario(async (s) => {
      // Four eligible voters, two present: majority quorum is three.
      const f = await ready(s);
      await s.as("committeeSecretary");
      await s.tx`select api.record_attendance(${f.participant.legalB!}, 'ABSENT')`;
      await s.tx`select api.record_attendance(${f.participant.lead!}, 'ABSENT')`;
      const item = await openItem(s, f.meeting);
      await vote(s, "legal", item, "APPROVE");
      await s.as("committeeSecretary");
      await s.expectError(
        "CDF_CONFLICT:VOTES_OUTSTANDING",
        (tx) => tx`select api.close_vote_item(${item}, null)`,
      );
      await s.expectError(
        "CDF_INVALID:custom_quorum_attested",
        (tx) => tx`select api.close_vote_item(${item}, true)`,
      );
      await vote(s, "committeeChair", item, "APPROVE");
      await s.as("committeeSecretary");
      expect((await s.tx<{ r: string }[]>`select api.close_vote_item(${item}, null) as r`)[0]!.r).toBe(
        "NO_QUORUM",
      );
      const r = await itemRow(s, item);
      expect(r).toMatchObject({ status: "CLOSED", eligible_count: 4, present_count: 2, quorum_required: 3 });
      // A closed item takes no more votes and the meeting can close.
      await s.as("legalB");
      await s.expectError(
        "CDF_CONFLICT:NOT_PRESENT",
        (tx) => tx`select api.cast_vote(${item}, 'APPROVE', null)`,
      );
      await s.as("committeeSecretary");
      await s.tx`select api.close_meeting(${f.meeting}, ${REASON})`;
    });
  });

  it("a tie goes to the chair's casting vote when the rule allows; never otherwise (N8, Q57)", async () => {
    await scenario(async (s) => {
      const f = await ready(s);
      const won = await openItem(s, f.meeting, "Clear majority (synthetic)");
      for (const u of ["legal", "legalB", "lead"] as const) await vote(s, u, won, "APPROVE");
      await vote(s, "committeeChair", won, "REJECT");
      await s.as("committeeSecretary");
      await s.tx`select api.close_vote_item(${won}, null)`;
      await s.as("committeeChair");
      await s.expectError(
        "CDF_CONFLICT:NOT_A_TIE",
        (tx) => tx`select api.cast_casting_vote(${won}, 'REJECT', null)`,
      );

      const tie = await openItem(s, f.meeting, "Tie (synthetic)");
      await vote(s, "legal", tie, "APPROVE");
      await vote(s, "legalB", tie, "APPROVE");
      await vote(s, "lead", tie, "REJECT");
      await vote(s, "committeeChair", tie, "REJECT");
      await s.as("committeeSecretary");
      expect((await s.tx<{ r: string }[]>`select api.close_vote_item(${tie}, null) as r`)[0]!.r).toBe(
        "AWAITING_CASTING_VOTE",
      );
      for (const u of ["legal", "committeeSecretary"] as const) {
        await s.as(u);
        await s.expectError(
          "CDF_FORBIDDEN",
          (tx) => tx`select api.cast_casting_vote(${tie}, 'APPROVE', null)`,
        );
      }
      await s.as("committeeChair");
      expect(
        (await s.tx<{ r: string }[]>`select api.cast_casting_vote(${tie}, 'APPROVE', null) as r`)[0]!.r,
      ).toBe("APPROVED");
      await s.expectError(
        "CDF_CONFLICT:NOT_A_TIE",
        (tx) => tx`select api.cast_casting_vote(${tie}, 'REJECT', null)`,
      );
    });
  });

  it("a chair who recused on the item cannot break its tie (AGENT-09 V2)", async () => {
    await scenario(async (s) => {
      const f = await ready(s);
      const item = await openItem(s, f.meeting);
      await vote(s, "committeeChair", item, "RECUSED");
      await vote(s, "legal", item, "APPROVE");
      await vote(s, "lead", item, "REJECT");
      await vote(s, "legalB", item, "ABSTAIN");
      await s.as("committeeSecretary");
      expect((await s.tx<{ r: string }[]>`select api.close_vote_item(${item}, null) as r`)[0]!.r).toBe(
        "TIED",
      );
      await s.as("committeeChair");
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.cast_casting_vote(${item}, 'APPROVE', null)`,
      );
    });
  });

  it("when nobody approves or rejects, the item is not decided and the chair never decides alone (AGENT-09 V5)", async () => {
    await scenario(async (s) => {
      const f = await ready(s);
      const item = await openItem(s, f.meeting);
      for (const u of VOTERS) await vote(s, u, item, "ABSTAIN");
      await s.as("committeeSecretary");
      expect((await s.tx<{ r: string }[]>`select api.close_vote_item(${item}, null) as r`)[0]!.r).toBe(
        "NO_DECISION",
      );
      await s.as("committeeChair");
      await s.expectError(
        "CDF_CONFLICT:NOT_A_TIE",
        (tx) => tx`select api.cast_casting_vote(${item}, 'REJECT', null)`,
      );
    });
  });

  it("with the casting vote disabled by the rule in force at referral, a tie stays TIED", async () => {
    await scenario(async (s) => {
      await s.as("platformAdmin");
      await s.tx`select api.set_committee_rule_set(${ic}, now(), 'MAJORITY_ELIGIBLE', null, false, 3, true, null, null, 'NO_DECISION', 'SOURCE_REQUIRED', ${REASON})`;
      const f = await ready(s);
      const tie = await openItem(s, f.meeting);
      await vote(s, "legal", tie, "APPROVE");
      await vote(s, "legalB", tie, "APPROVE");
      await vote(s, "lead", tie, "REJECT");
      await vote(s, "committeeChair", tie, "REJECT");
      await s.as("committeeSecretary");
      expect((await s.tx<{ r: string }[]>`select api.close_vote_item(${tie}, null) as r`)[0]!.r).toBe("TIED");
      await s.as("committeeChair");
      await s.expectError(
        "CDF_CONFLICT:NOT_A_TIE",
        (tx) => tx`select api.cast_casting_vote(${tie}, 'APPROVE', null)`,
      );
    });
  });
});

describe("minutes (Q97–Q98)", () => {
  async function closedMeeting(s: Scenario) {
    const f = await ready(s);
    const item = await openItem(s, f.meeting);
    for (const u of VOTERS) await vote(s, u, item, "APPROVE");
    await s.as("committeeSecretary");
    await s.tx`select api.close_vote_item(${item}, null)`;
    await s.tx`select api.close_meeting(${f.meeting}, ${REASON})`;
    return f;
  }

  it("attending members review; a change request supersedes; all approvals finalise; choices never appear", async () => {
    await scenario(async (s) => {
      const f = await closedMeeting(s);
      await s.as("legal");
      await s.expectError(
        "CDF_FORBIDDEN",
        (tx) => tx`select api.generate_minutes(${f.meeting}, 'Synthetic minutes narrative.')`,
      );
      await s.as("committeeSecretary");
      const [v1] = await s.tx<{ id: string }[]>`
        select api.generate_minutes(${f.meeting}, 'Synthetic minutes narrative, version one.') as id`;
      const [row] = await s.tx<{ reviewer_count: number; status: string; snapshot: unknown }[]>`
        select reviewer_count, status, snapshot from committee.minutes where id = ${v1!.id}`;
      expect(row).toMatchObject({ reviewer_count: 4, status: "IN_REVIEW" });
      expect(JSON.stringify(row!.snapshot)).not.toMatch(/"choice"/);
      // In review: the case team does not see the minutes; the secretary cannot review.
      await s.as("caseManager");
      expect(await s.tx`select id from committee.minutes`).toEqual([]);
      await s.as("committeeSecretary");
      await s.expectError("CDF_FORBIDDEN", (tx) => tx`select api.review_minutes(${v1!.id}, 'APPROVE', null)`);
      await s.as("legal");
      await s.expectError(
        "CDF_INVALID:comment",
        (tx) => tx`select api.review_minutes(${v1!.id}, 'REQUEST_CHANGES', null)`,
      );
      await s.tx`select api.review_minutes(${v1!.id}, 'REQUEST_CHANGES', 'Synthetic: correct the attendance note.')`;
      await s.as("committeeSecretary");
      const [v2] = await s.tx<{ id: string }[]>`
        select api.generate_minutes(${f.meeting}, 'Synthetic minutes narrative, version two.') as id`;
      for (const u of VOTERS) {
        await s.as(u);
        await s.tx`select api.review_minutes(${v2!.id}, 'APPROVE', null)`;
      }
      const statuses = await s.tx<{ version_no: number; status: string }[]>`
        select version_no, status from committee.minutes where meeting_id = ${f.meeting} order by version_no`;
      expect(statuses).toEqual([
        { version_no: 1, status: "SUPERSEDED" },
        { version_no: 2, status: "APPROVED" },
      ]);
      await s.as("caseManager");
      expect(await s.tx`select id from committee.minutes`).toHaveLength(1);
      await s.as("committeeSecretary");
      await s.expectError(
        "CDF_CONFLICT:MINUTES_EXIST",
        (tx) => tx`select api.generate_minutes(${f.meeting}, 'Synthetic minutes narrative, version three.')`,
      );
    });
  });

  it("deemed approval needs the window to pass and a reminder; it is idempotent", async () => {
    await ownerScenario(async (s) => {
      const f = await closedMeeting(s);
      await s.as("committeeSecretary");
      const [mi] = await s.tx<{ id: string }[]>`
        select api.generate_minutes(${f.meeting}, 'Synthetic minutes narrative for deemed approval.') as id`;
      await s.as("legal");
      await s.tx`select api.review_minutes(${mi!.id}, 'APPROVE', null)`;
      await s.as("committeeSecretary");
      await s.expectError(
        "CDF_CONFLICT:REMINDER_NOT_SENT",
        (tx) => tx`select api.apply_minutes_deemed_approval(${mi!.id})`,
      );
      await s.tx`select api.record_minutes_reminder(${mi!.id})`;
      await s.expectError(
        "CDF_CONFLICT:REVIEW_WINDOW_OPEN",
        (tx) => tx`select api.apply_minutes_deemed_approval(${mi!.id})`,
      );
      // The window passes (the owner shortens it; nothing may lengthen it).
      await s.asOwner();
      await s.expectError(
        "minutes",
        (tx) =>
          tx`update committee.minutes set review_due_at = review_due_at + interval '1 day' where id = ${mi!.id}`,
      );
      await s.tx`update committee.minutes set review_due_at = now() - interval '1 minute' where id = ${mi!.id}`;
      await s.as("legal");
      await s.expectError("CDF_FORBIDDEN", (tx) => tx`select api.apply_minutes_deemed_approval(${mi!.id})`);
      await s.as("committeeSecretary");
      expect(
        (await s.tx<{ r: string }[]>`select api.apply_minutes_deemed_approval(${mi!.id}) as r`)[0]!.r,
      ).toBe("DEEMED_APPROVED");
      expect(
        (await s.tx<{ r: string }[]>`select api.apply_minutes_deemed_approval(${mi!.id}) as r`)[0]!.r,
      ).toBe("DEEMED_APPROVED");
      await s.as("dpo");
      const events = await s.tx`
        select seq from audit.audit_event where action = 'MINUTES_DEEMED_APPROVED' and object_id = ${mi!.id}`;
      expect(events).toHaveLength(1);
    });
  });
});

describe("meeting records are append-only", () => {
  it("votes, conflicts and reviews cannot be changed or deleted even by the owner; a closed meeting is frozen", async () => {
    await ownerScenario(async (s) => {
      const f = await ready(s, ["committeeChair", "legal", "legalB"]);
      const item = await openItem(s, f.meeting);
      await vote(s, "legal", item, "APPROVE");
      await s.as("committeeSecretary");
      await s.tx`select api.record_vote_for_member(${item}, ${f.participant.lead!}, 'ABSENT', 'Synthetic: absent.', null)`;
      await s.asOwner();
      await s.expectError(
        "committee.vote is append-only",
        (tx) => tx`update committee.vote set choice = 'REJECT'`,
      );
      await s.expectError("committee.vote is append-only", (tx) => tx`delete from committee.vote`);
      await s.expectError(
        "committee.meeting_conflict is append-only",
        (tx) => tx`delete from committee.meeting_conflict`,
      );
      await s.expectError("committee.meeting is append-only", (tx) => tx`delete from committee.meeting`);
      // The owner cannot even store a secretary-recorded APPROVE (N6 check constraint).
      await s.expectError(
        "new row for relation",
        (
          tx,
        ) => tx`insert into committee.vote (vote_item_id, participant_id, recorded_for, recorded_by, source, choice, reason, original_event_at)
                   values (${item}, ${f.participant.lead!}, ${USERS.lead}, ${USERS.committeeSecretary}, 'SECRETARY', 'APPROVE', 'Synthetic.', now())`,
      );
    });
  });
});

describe("a finding vote binds one finding version (AMB-030, migration 2030)", () => {
  it("T-AMB-012: a new finding version does not alter the version bound to a closed vote item", async () => {
    await ownerScenario(async (s) => {
      await seat(s, ic, IC_SEATS);
      const facts = await caseFacts(s, caseB);
      const f = await scheduleMeeting(s, ic, caseB);
      await openWithPresent(s, f, VOTERS);
      const [vi] = await s.tx<{ id: string }[]>`
        select api.open_vote_item(${f.meeting}, 'FINDING', ${facts.finding}, 'Finding on the allegation (synthetic)') as id`;
      for (const user of VOTERS) await vote(s, user, vi!.id, "APPROVE");
      await s.as("committeeSecretary");
      await s.tx`select api.close_vote_item(${vi!.id}, null)`;

      // Investigation goes on: a new version of the finding is recorded after the vote.
      await s.as("investigatorB");
      const [v2] = await s.tx<{ id: string }[]>`
        select api.record_finding(${facts.allegation}, null, ${facts.proceeding}, 'NOT_SUBSTANTIATED',
          'Synthetic: revised finding after new evidence.') as id`;
      expect(v2!.id).not.toBe(facts.finding);

      // The vote still names version 1, which is unchanged; version 2 is a separate row awaiting its own vote.
      await s.as("committeeSecretary");
      const [bound] = await s.tx<{ finding_id: string; status: string; result: string }[]>`
        select finding_id, status, result from committee.vote_item where id = ${vi!.id}`;
      expect(bound).toEqual({ finding_id: facts.finding, status: "CLOSED", result: "APPROVED" });
      await s.as("investigatorB");
      expect(
        await s.tx`select version_no, result from case_mgmt.finding
                   where allegation_id = ${facts.allegation} order by version_no`,
      ).toEqual([
        { version_no: 1, result: "SUBSTANTIATED" },
        { version_no: 2, result: "NOT_SUBSTANTIATED" },
      ]);

      // Negative: neither the bound version nor the closed vote item can be changed, even by the table owner.
      await s.asOwner();
      await s.expectError(
        "case_mgmt.finding is append-only",
        (tx) => tx`update case_mgmt.finding set result = 'NOT_SUBSTANTIATED' where id = ${facts.finding}`,
      );
      await s.expectError(
        `vote item ${vi!.id} is closed`,
        (tx) => tx`update committee.vote_item set finding_id = ${v2!.id} where id = ${vi!.id}`,
      );
    });
  });
});
