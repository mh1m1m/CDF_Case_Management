// The meeting read models' mapping (Phase 12 P12-2a and P12-2b; ADR-054 and ADR-055). The gateway renames keys and
// decides nothing, so these pin the three things a screen relies on: the concern-only view stays concern-only, a
// capability or list the database left out or null reads as false or empty (fail closed, which is also what a page
// sees against 2065's read model before 2085), and an individual choice is never carried (AMB-083, rule 5).
import { describe, expect, it } from "vitest";
import { toMeetingInviteChoices, toMeetingView, toMinutesView, toVoteItemProgress } from "./meetings-gateway";

type RawMeeting = Parameters<typeof toMeetingView>[0];
type RawMinutes = Parameters<typeof toMinutesView>[0];
type RawStatus = Parameters<typeof toVoteItemProgress>[0];
type RawInvite = Parameters<typeof toMeetingInviteChoices>[0];

const M = "33333333-3333-4333-8333-333333333333";
const P = "55555555-5555-4555-8555-555555555555";
const U = "a0000000-0000-4000-8000-000000000003";
const AT = "2026-10-14 09:30:00+03";

const concern = {
  concern_id: "66666666-6666-4666-8666-666666666666",
  participant_id: P,
  raised_by: U,
  raised_as: "MEMBER",
  reason: "Synthetic: a concern.",
  raised_at: AT,
  status: "OPEN",
  decided_by: null,
  decided_as: null,
  decision_reason: null,
  decided_at: null,
  reversal: null,
  capabilities: { may_decide: true, may_reverse: null },
} as const;

describe("meeting read model mapping", () => {
  it("the concern-only view carries only the meeting id, status, case reference and concerns", () => {
    const raw = {
      meeting_id: M,
      status: "OPEN",
      case: { case_id: null, case_number: null },
      concerns: [concern],
    } as unknown as RawMeeting;
    expect(toMeetingView(raw)).toEqual({
      view: "CONCERNS_ONLY",
      meetingId: M,
      status: "OPEN",
      case: { caseId: null, caseNumber: null },
      concerns: [
        {
          concernId: concern.concern_id,
          participantId: P,
          raisedBy: U,
          raisedAs: "MEMBER",
          reason: "Synthetic: a concern.",
          raisedAt: "2026-10-14T06:30:00.000Z",
          status: "OPEN",
          decidedBy: null,
          decidedAs: null,
          decisionReason: null,
          decidedAt: null,
          reversal: null,
          capabilities: { mayDecide: true, mayReverse: false },
        },
      ],
    });
  });

  it("a full view's missing parts stay null, and missing or null capabilities are false", () => {
    const raw = {
      meeting_id: M,
      committee_proceeding_id: M,
      committee: { committee_id: M, code: "IC", kind: "INVESTIGATION" },
      case: null,
      logistics: {
        sequence_no: 2,
        purpose: "DELIBERATION",
        mode: "IN_PERSON",
        provider: "MANUAL",
        status: "SCHEDULED",
        location: null,
        online_url: null,
        scheduled_start: AT,
        scheduled_end: null,
        is_emergency: null,
        opened_at: null,
        closed_at: null,
      },
      me: null,
      roster: null,
      deliberation: null,
      concerns: null,
      acting_roles: null,
      minutes: null,
      capabilities: { can_manage: true, may_open: null },
    } as unknown as RawMeeting;
    const v = toMeetingView(raw);
    expect(v.view).toBe("FULL");
    if (v.view !== "FULL") return;
    expect(v.case).toEqual({ caseId: null, caseNumber: null });
    expect(v.logistics.isEmergency).toBe(false);
    expect(v.logistics.scheduledStart).toBe("2026-10-14T06:30:00.000Z");
    expect([v.me, v.roster, v.deliberation]).toEqual([null, null, null]);
    expect([v.concerns, v.actingRoles, v.minutes, v.inviteeRoles]).toEqual([[], [], [], []]);
    expect(v.capabilities).toEqual({
      canManage: true,
      mayOpen: false,
      mayClose: false,
      mayCancel: false,
      mayOpenVote: false,
      mayGenerateMinutes: false,
      mayRaiseConcern: false,
      mayDeclareConflict: false,
      mayDeclareNoConflict: false,
      mayAcknowledgeConfidentiality: false,
      mayInvite: false,
      mayRecordAccommodation: false,
      mayActivateActingChair: false,
      mayActivateActingSecretary: false,
    });
  });

  it("roster rows and vote items keep booleans only, and record_vote_for is a list", () => {
    const raw = {
      meeting_id: M,
      committee_proceeding_id: M,
      committee: { committee_id: M, code: "IC", kind: "INVESTIGATION" },
      case: { case_id: M, case_number: "CDF-DEMO-2026-0002" },
      logistics: {
        sequence_no: 1,
        purpose: "DELIBERATION",
        mode: "IN_PERSON",
        provider: "MANUAL",
        status: "OPEN",
        location: "Room 1 (synthetic)",
        online_url: null,
        scheduled_start: AT,
        scheduled_end: AT,
        is_emergency: false,
        opened_at: AT,
        closed_at: null,
      },
      me: null,
      roster: [
        {
          participant_id: P,
          participant_kind: "MEMBER",
          user_id: U,
          person_id: null,
          display_name: "Member Alpha",
          display_name_ar: null,
          seat: "MEMBER",
          invitee_role: null,
          is_voting: true,
          requires_coi: true,
          coi_status: "NO_CONFLICT",
          attendance: "PRESENT",
          capabilities: null,
        },
      ],
      deliberation: {
        ballot_secrecy: "SECRET_BALLOT",
        quorum: { quorum_type: "MAJORITY_ELIGIBLE", eligible: 3, present: 2, required: 2 },
        vote_items: [
          {
            vote_item_id: M,
            sequence_no: 1,
            target_type: "OTHER",
            finding_id: null,
            package_id: null,
            recommendation_item_id: null,
            package_round: null,
            title: "Synthetic business",
            status: "OPEN",
            result: null,
            decided_by_casting_vote: null,
            opened_at: AT,
            closed_at: null,
            tally: null,
            i_have_voted: null,
            i_have_noted: true,
            record_vote_for: null,
            capabilities: { may_vote: true },
          },
        ],
        witness_exclusions: null,
      },
      concerns: [],
      acting_roles: [],
      minutes: [],
      capabilities: {},
    } as unknown as RawMeeting;
    const v = toMeetingView(raw);
    if (v.view !== "FULL") throw new Error("expected the full view");
    expect(v.case).toEqual({ caseId: M, caseNumber: "CDF-DEMO-2026-0002" });
    expect(v.roster?.[0]?.capabilities).toEqual({
      mayRecordPresent: false,
      mayRecordAbsent: false,
      mayRecordExcusedConflict: false,
      mayRecordExcusedAbsence: false,
      mayRaiseConcern: false,
      mayExcludeWitness: false,
      mayRecordAccommodation: false,
      mayDeclareConflict: false,
      mayDeclareNoConflict: false,
      mayAcknowledgeConfidentiality: false,
      mayActivateAlternate: false,
    });
    expect([v.roster?.[0]?.alternateFor, v.roster?.[0]?.arrangements]).toEqual([[], null]);
    const item = v.deliberation?.voteItems[0];
    expect(item).toMatchObject({ iHaveVoted: false, iHaveNoted: true, recordVoteFor: [], tally: null });
    expect(item?.capabilities).toEqual({
      mayVote: true,
      mayClose: false,
      mayCastCastingVote: false,
      mayRevise: false,
      mayRecuseForConflict: false,
      mayRecordNote: false,
    });
    expect(v.deliberation?.witnessExclusions).toEqual([]);
  });

  it("2085's logistics map through: accommodations, arrangements, alternates, invitee roles and the new flags", () => {
    const accommodation = {
      accommodation_id: "77777777-7777-4777-8777-777777777777",
      details: "Synthetic: step-free access.",
      source: "SECRETARY",
      recorded_at: AT,
    };
    const raw = {
      meeting_id: M,
      committee_proceeding_id: M,
      committee: { committee_id: M, code: "IC", kind: "INVESTIGATION" },
      case: null,
      logistics: {
        sequence_no: 1,
        purpose: "HEARING",
        mode: "HYBRID",
        provider: "MANUAL",
        status: "SCHEDULED",
        location: "Room 2 (synthetic)",
        online_url: "https://meet.example.test/synthetic",
        scheduled_start: AT,
        scheduled_end: AT,
        is_emergency: false,
        opened_at: null,
        closed_at: null,
      },
      me: {
        participant_id: P,
        participant_kind: "INVITEE",
        seat: null,
        invitee_role: "WITNESS",
        is_voting: false,
        requires_coi: true,
        coi_status: "PENDING",
        attendance: "NOT_RECORDED",
        confidentiality_ack_required: true,
        confidentiality_acknowledged: false,
        accommodations: [accommodation],
      },
      roster: [
        {
          participant_id: P,
          participant_kind: "MEMBER",
          user_id: U,
          person_id: null,
          display_name: "Alternate Delta",
          display_name_ar: null,
          seat: "ALTERNATE_MEMBER",
          invitee_role: null,
          is_voting: false,
          requires_coi: true,
          coi_status: "NO_CONFLICT",
          attendance: "PRESENT",
          alternate_for: [M],
          arrangements: { confidentiality_acknowledged: null, accommodations: [accommodation] },
          capabilities: {
            may_activate_alternate: true,
            may_record_accommodation: true,
            may_exclude_witness: null,
          },
        },
      ],
      deliberation: null,
      concerns: [],
      acting_roles: [],
      minutes: [],
      invitee_roles: [
        { invitee_role: "WITNESS", confidentiality_ack_required: true, source_status: "OWNER_DEFAULT" },
        { invitee_role: "INTERPRETER", confidentiality_ack_required: null, source_status: "SOURCE_REQUIRED" },
      ],
      capabilities: { may_invite: true, may_record_accommodation: true, may_activate_acting_chair: false },
    } as unknown as RawMeeting;
    const v = toMeetingView(raw);
    if (v.view !== "FULL") throw new Error("expected the full view");
    const mapped = {
      accommodationId: accommodation.accommodation_id,
      details: "Synthetic: step-free access.",
      source: "SECRETARY",
      recordedAt: "2026-10-14T06:30:00.000Z",
    };
    expect(v.me?.accommodations).toEqual([mapped]);
    const row = v.roster?.[0];
    expect(row?.alternateFor).toEqual([M]);
    expect(row?.arrangements).toEqual({ confidentialityAcknowledged: false, accommodations: [mapped] });
    expect(row?.capabilities).toMatchObject({
      mayActivateAlternate: true,
      mayRecordAccommodation: true,
      mayExcludeWitness: false,
      mayDeclareConflict: false,
    });
    expect(v.inviteeRoles).toEqual([
      { inviteeRole: "WITNESS", confidentialityAckRequired: true, sourceStatus: "OWNER_DEFAULT" },
      { inviteeRole: "INTERPRETER", confidentialityAckRequired: false, sourceStatus: "SOURCE_REQUIRED" },
    ]);
    expect(v.capabilities).toMatchObject({
      mayInvite: true,
      mayRecordAccommodation: true,
      mayActivateActingChair: false,
      mayActivateActingSecretary: false,
    });
  });

  it("the invite list keeps a person to its position and roles, an account to its names and bases (P12-2c)", () => {
    expect(
      toMeetingInviteChoices({
        meeting_id: M,
        label_mode: "ORDINAL",
        persons: null,
        accounts: null,
      } as unknown as RawInvite),
    ).toEqual({ meetingId: M, labelMode: "ORDINAL", persons: [], accounts: [] });
    const v = toMeetingInviteChoices({
      meeting_id: M,
      label_mode: "ORDINAL",
      persons: [
        {
          person_id: P,
          position: "2",
          case_roles: ["WITNESS"],
          label: null,
          invitee_roles: ["WITNESS", "EXPERT"],
        },
        { person_id: M, position: 3, case_roles: null, invitee_roles: null },
      ],
      accounts: [
        {
          user_id: U,
          display_name: "Investigator Beta",
          display_name_ar: null,
          bases: ["CASE_TEAM", "LEGAL_REVIEW"],
          invitee_roles: ["LEGAL", "INFORMATION_PROVIDER"],
        },
      ],
    } as unknown as RawInvite);
    expect(v.persons).toEqual([
      { personId: P, position: 2, caseRoles: ["WITNESS"], label: null, inviteeRoles: ["WITNESS", "EXPERT"] },
      { personId: M, position: 3, caseRoles: [], label: null, inviteeRoles: [] },
    ]);
    expect(v.accounts).toEqual([
      {
        userId: U,
        displayName: "Investigator Beta",
        displayNameAr: null,
        bases: ["CASE_TEAM", "LEGAL_REVIEW"],
        inviteeRoles: ["LEGAL", "INFORMATION_PROVIDER"],
      },
    ]);
  });

  it("vote progress says who has voted and never carries a choice, even where the read model returns one", () => {
    const raw = {
      vote_item_id: M,
      status: "CLOSED",
      result: "APPROVED",
      ballot_secrecy: "COMMITTEE_AFTER_CLOSE",
      casting_vote: null,
      voters: [
        {
          participant_id: P,
          user_id: U,
          seat: "MEMBER",
          activated_alternate: false,
          replaced: null,
          has_voted: true,
          voted_at: AT,
          source: "SELF",
          choice: "APPROVE",
        },
      ],
      notes: [{ participant_id: P, note: "Synthetic: a note." }],
    } as unknown as RawStatus;
    const p = toVoteItemProgress(raw);
    expect(p).toEqual({
      voteItemId: M,
      status: "CLOSED",
      ballotSecrecy: "COMMITTEE_AFTER_CLOSE",
      voters: [
        {
          participantId: P,
          userId: U,
          seat: "MEMBER",
          activatedAlternate: false,
          replaced: false,
          hasVoted: true,
          votedAt: "2026-10-14T06:30:00.000Z",
          source: "SELF",
        },
      ],
    });
    expect(JSON.stringify(p)).not.toMatch(/APPROVE|Synthetic: a note/);
  });

  it("minutes keep reviews and rulings null for a reader outside the deliberation, and tallies come from the snapshot", () => {
    const raw = {
      minutes_id: M,
      meeting_id: M,
      version_no: 1,
      status: "APPROVED",
      narrative: "Synthetic minutes.",
      snapshot: {
        meeting: {
          id: M,
          sequence_no: 1,
          purpose: "DELIBERATION",
          mode: "IN_PERSON",
          opened_at: AT,
          closed_at: AT,
          is_emergency: false,
        },
        participants: [
          {
            participant_id: P,
            kind: "MEMBER",
            user_id: U,
            person_id: null,
            seat: "MEMBER",
            invitee_role: null,
            is_voting: true,
            coi_status: "NO_CONFLICT",
            attendance: "PRESENT",
          },
        ],
        acting_roles: [],
        vote_items: [
          {
            vote_item_id: M,
            sequence_no: 1,
            target_type: "OTHER",
            finding_id: null,
            title: "Synthetic business",
            result: "APPROVED",
            decided_by_casting_vote: false,
            eligible: 3,
            present: 3,
            quorum_required: 2,
            approve: 2,
            reject: 1,
            abstain: 0,
            recused: 0,
            absent: 0,
            unable: 0,
            excluded: 0,
          },
        ],
        annexed_notes: [{ vote_item_id: M, participant_id: null, note: "Synthetic: an anonymous note." }],
      },
      reviewer_count: 0,
      review_business_days: 5,
      review_due_at: AT,
      deemed_approval_enabled: false,
      reminder_sent_at: null,
      generated_at: AT,
      finalised_at: AT,
      case: null,
      meeting: null,
      reviews: null,
      objection_rulings: null,
      i_have_reviewed: null,
      capabilities: null,
    } as unknown as RawMinutes;
    const v = toMinutesView(raw);
    expect([v.meeting, v.reviews, v.objectionRulings, v.iHaveReviewed]).toEqual([null, null, null, null]);
    expect(v.capabilities).toEqual({
      mayReview: false,
      mayRemind: false,
      mayApplyDeemedApproval: false,
      mayOverruleObjection: false,
    });
    expect(v.snapshot.voteItems[0]?.tally).toEqual({
      eligible: 3,
      present: 3,
      quorumRequired: 2,
      approve: 2,
      reject: 1,
      abstain: 0,
      recused: 0,
      absent: 0,
      unable: 0,
      excluded: 0,
    });
    expect(v.snapshot.annexedNotes).toEqual([
      { voteItemId: M, participantId: null, note: "Synthetic: an anonymous note." },
    ]);
    // The snapshot's case person reference is not carried to the screen.
    expect(JSON.stringify(v.snapshot.participants)).not.toContain("personId");
  });
});
