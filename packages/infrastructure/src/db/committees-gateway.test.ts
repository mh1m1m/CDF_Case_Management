// The committee read models' mapping (Phase 12 P12-2b; ADR-055). The gateway renames keys and decides nothing, so
// these pin what the pages rely on: a capability or count the database left out or null reads as false or zero (fail
// closed), a rule a proceeding's copy does not hold stays null rather than a guessed default, and the snapshot carries
// counts only (DEC-F19).
import { describe, expect, it } from "vitest";
import { toCommitteeRules, toCommitteeView, toMyCommittees } from "./committees-gateway";

type RawView = Parameters<typeof toCommitteeView>[0];
type RawRows = Parameters<typeof toMyCommittees>[0];

const C = "11111111-1111-4111-8111-111111111111";
const P = "33333333-3333-4333-8333-333333333333";
const U = "a0000000-0000-4000-8000-000000000003";
const AT = "2026-10-14 09:30:00+03";

const rulesInForce = {
  quorum_type: "PERCENTAGE",
  quorum_value: "60.0",
  casting_vote_enabled: true,
  acting_chair_casting_vote: false,
  ballot_secrecy: "SECRET_BALLOT",
  vote_revision_allowed: true,
  dissent_note_allowed: true,
  minutes_review_business_days: 5,
  deemed_approval_enabled: true,
  minutes_objection_blocks_deemed: true,
  minimum_notice_days: 3,
  conflict_decider: "CHAIR",
  source_status: "OWNER_DEFAULT",
  effective_from: AT,
  effective_to: null,
  grievance_window_days: null,
};

describe("committee read model mapping", () => {
  it("My Committees rows map their seat and counts; a missing count is zero and a null list is empty", () => {
    expect(toMyCommittees(null)).toEqual([]);
    const rows = [
      {
        committee_id: C,
        code: "IC",
        kind: "INVESTIGATION",
        is_active: true,
        seat: "SECRETARY",
        effective_from: AT,
        effective_to: null,
        open_proceedings: 2,
        active_meetings: null,
      },
    ] as unknown as RawRows;
    expect(toMyCommittees(rows)).toEqual([
      {
        committeeId: C,
        code: "IC",
        kind: "INVESTIGATION",
        isActive: true,
        seat: "SECRETARY",
        effectiveFrom: "2026-10-14T06:30:00.000Z",
        effectiveTo: null,
        openProceedings: 2,
        activeMeetings: 0,
      },
    ]);
  });

  it("rules keep their values and source; numeric text becomes a number", () => {
    expect(toCommitteeRules(rulesInForce as unknown as Parameters<typeof toCommitteeRules>[0])).toEqual({
      quorumType: "PERCENTAGE",
      quorumValue: 60,
      castingVoteEnabled: true,
      actingChairCastingVote: false,
      ballotSecrecy: "SECRET_BALLOT",
      voteRevisionAllowed: true,
      dissentNoteAllowed: true,
      minutesReviewBusinessDays: 5,
      deemedApprovalEnabled: true,
      minutesObjectionBlocksDeemed: true,
      minimumNoticeDays: 3,
      conflictDecider: "CHAIR",
      sourceStatus: "OWNER_DEFAULT",
      effectiveFrom: "2026-10-14T06:30:00.000Z",
    });
  });

  it("a proceeding's copy taken before a rule existed leaves that rule null, never a default", () => {
    const old = { quorum_type: "MAJORITY_ELIGIBLE", quorum_value: null, casting_vote_enabled: false };
    expect(toCommitteeRules(old as unknown as Parameters<typeof toCommitteeRules>[0])).toEqual({
      quorumType: "MAJORITY_ELIGIBLE",
      quorumValue: null,
      castingVoteEnabled: false,
      actingChairCastingVote: null,
      ballotSecrecy: null,
      voteRevisionAllowed: null,
      dissentNoteAllowed: null,
      minutesReviewBusinessDays: null,
      deemedApprovalEnabled: null,
      minutesObjectionBlocksDeemed: null,
      minimumNoticeDays: null,
      conflictDecider: null,
      sourceStatus: null,
      effectiveFrom: null,
    });
  });

  it("a committee view maps members, proceedings, counts and capabilities; missing flags are false", () => {
    const raw = {
      committee: { committee_id: C, code: "IC", kind: "INVESTIGATION", is_active: true },
      my_seat: { seat: "MEMBER", effective_from: AT, effective_to: null },
      members: [
        {
          user_id: U,
          display_name: "Member Alpha",
          display_name_ar: null,
          seat: "MEMBER",
          effective_from: AT,
          effective_to: null,
        },
      ],
      rules: null,
      proceedings: [
        {
          committee_proceeding_id: P,
          status: "OPEN",
          referred_at: AT,
          closed_at: null,
          case: { case_id: null, case_number: null },
          rules: rulesInForce,
          snapshot: {
            seats: [{ seat: "CHAIR", count: 1 }],
            voting: 3,
            cleared: 4,
            not_cleared: 1,
            firewall_restricted: null,
            added_after_referral: 0,
          },
          meetings: [
            {
              meeting_id: P,
              sequence_no: 1,
              purpose: "DELIBERATION",
              mode: "TEAMS",
              status: "SCHEDULED",
              scheduled_start: AT,
              scheduled_end: AT,
              is_emergency: null,
            },
          ],
          amendment_candidates: null,
          capabilities: { may_schedule_meeting: null },
        },
      ],
    } as unknown as RawView;
    const v = toCommitteeView(raw);
    expect(v.committee).toEqual({ committeeId: C, code: "IC", kind: "INVESTIGATION", isActive: true });
    expect(v.mySeat).toEqual({
      seat: "MEMBER",
      effectiveFrom: "2026-10-14T06:30:00.000Z",
      effectiveTo: null,
    });
    expect(v.members).toEqual([
      {
        userId: U,
        displayName: "Member Alpha",
        displayNameAr: null,
        seat: "MEMBER",
        effectiveFrom: "2026-10-14T06:30:00.000Z",
        effectiveTo: null,
      },
    ]);
    expect(v.rules).toBeNull();
    const p = v.proceedings[0]!;
    expect(p.case).toEqual({ caseId: null, caseNumber: null });
    expect(p.snapshot).toEqual({
      seats: [{ seat: "CHAIR", count: 1 }],
      voting: 3,
      cleared: 4,
      notCleared: 1,
      firewallRestricted: 0,
      addedAfterReferral: 0,
    });
    expect(Object.keys(p.snapshot).sort()).toEqual([
      "addedAfterReferral",
      "cleared",
      "firewallRestricted",
      "notCleared",
      "seats",
      "voting",
    ]);
    expect(p.meetings).toEqual([
      {
        meetingId: P,
        sequenceNo: 1,
        purpose: "DELIBERATION",
        mode: "TEAMS",
        status: "SCHEDULED",
        scheduledStart: "2026-10-14T06:30:00.000Z",
        scheduledEnd: "2026-10-14T06:30:00.000Z",
        isEmergency: false,
      },
    ]);
    expect(p.amendmentCandidates).toEqual([]);
    expect(p.capabilities).toEqual({
      mayScheduleMeeting: false,
      mayScheduleEmergencyMeeting: false,
      mayAmendSnapshot: false,
    });
  });
});
