// MeetingsGateway over PostgreSQL (UX redesign Phase 12 P12-2a, P12-2b and P12-2c; ADR-054 to ADR-056). Reads call only
// the purpose read models (api.meeting_view and api.minutes_view of 2030 as replaced in 2065 and 2085,
// api.vote_item_status, api.meeting_invite_choices of 2086), which decide what the caller sees; the gateway renames
// their keys and reads no table. Writes only call the api.* meeting, vote, invite and minutes commands. Every method
// runs in its own transaction under the caller's security context.
import type {
  InviteAccountChoice,
  InvitePersonChoice,
  MeetingAccommodationView,
  MeetingActingRoleView,
  MeetingConcernView,
  MeetingFullView,
  MeetingInviteChoices,
  MeetingParticipantView,
  MeetingSelfView,
  MeetingView,
  MeetingVoteItemView,
  MinutesSnapshot,
  MinutesView,
  MyOfflineBallot,
  OfflineBallotCounts,
  VoteItemProgress,
  VoteTally,
} from "@cdf/contracts";
import type { MeetingsGateway, UserRequestContext } from "@cdf/application";
import { withUserContext, type Sql, type Tx } from "./security-context";

// ---- The read models' JSON, as the database writes it (snake_case; timestamps as text) -------------------------
type Stamp = string;
type Caps<K extends string> = Partial<Record<K, boolean | null>>;

interface RawTally {
  eligible: number;
  present: number;
  quorum_required: number | null;
  approve: number;
  reject: number;
  abstain: number;
  recused: number;
  absent: number;
  unable: number;
  excluded: number;
}

interface RawConcern {
  concern_id: string;
  participant_id: string;
  raised_by: string;
  raised_as: MeetingConcernView["raisedAs"];
  reason: string;
  raised_at: Stamp;
  status: MeetingConcernView["status"];
  decided_by: string | null;
  decided_as: MeetingConcernView["decidedAs"];
  decision_reason: string | null;
  decided_at: Stamp | null;
  reversal: {
    reversal_id: string;
    reversed_by: string;
    reversed_as: NonNullable<MeetingConcernView["reversal"]>["reversedAs"];
    reason: string;
    reversed_at: Stamp;
  } | null;
  capabilities: Caps<"may_decide" | "may_reverse"> | null;
}

interface RawParticipant {
  participant_id: string;
  participant_kind: MeetingParticipantView["participantKind"];
  user_id: string | null;
  person_id: string | null;
  display_name: string | null;
  display_name_ar: string | null;
  seat: MeetingParticipantView["seat"];
  invitee_role: MeetingParticipantView["inviteeRole"];
  is_voting: boolean;
  requires_coi: boolean;
  coi_status: MeetingParticipantView["coiStatus"];
  attendance: MeetingParticipantView["attendance"];
  alternate_for?: string[] | null;
  arrangements?: {
    confidentiality_acknowledged: boolean | null;
    accommodations: RawAccommodation[] | null;
  } | null;
  capabilities: Caps<
    | "may_record_present"
    | "may_record_absent"
    | "may_record_excused_conflict"
    | "may_record_excused_absence"
    | "may_raise_concern"
    | "may_exclude_witness"
    | "may_record_accommodation"
    | "may_declare_conflict"
    | "may_declare_no_conflict"
    | "may_acknowledge_confidentiality"
    | "may_activate_alternate"
  > | null;
}

interface RawVoteItem {
  vote_item_id: string;
  sequence_no: number;
  target_type: MeetingVoteItemView["targetType"];
  finding_id: string | null;
  package_id: string | null;
  recommendation_item_id: string | null;
  package_round: number | null;
  title: string;
  status: MeetingVoteItemView["status"];
  result: MeetingVoteItemView["result"];
  decided_by_casting_vote: boolean | null;
  opened_at: Stamp;
  closed_at: Stamp | null;
  tally: RawTally | null;
  i_have_voted: boolean | null;
  i_have_noted: boolean | null;
  record_vote_for: string[] | null;
  /** 2120 (ADR-048); absent before it, which reads as no ballots. */
  offline_ballots?: Partial<Record<keyof OfflineBallotCounts, number | null>> | null;
  my_ballot?: {
    ballot_id: string;
    status: MyOfflineBallot["status"];
    choice: MyOfflineBallot["choice"];
    ballot_reference: string;
    original_event_at: Stamp;
    /** 2125 (ADR-062); absent before it, which reads as not released. */
    release?: MyOfflineBallot["release"];
  } | null;
  ballots_unconfirmed_for?: string[] | null;
  /** 2125 (ADR-062); absent before it, which reads as none. */
  ballots_releasable_for?: string[] | null;
  capabilities: Caps<
    | "may_vote"
    | "may_close"
    | "may_cast_casting_vote"
    | "may_revise"
    | "may_recuse_for_conflict"
    | "may_record_note"
    | "may_confirm_ballot"
    | "may_decline_ballot"
  > | null;
}

interface RawCaseRef {
  case_id: string | null;
  case_number: string | null;
}

interface RawAccommodation {
  accommodation_id: string;
  details: string;
  source: MeetingAccommodationView["source"];
  recorded_at: Stamp;
}

/** The concern-only view (2030 section 4): the meeting's id and status, the case reference and the concerns. */
interface RawMeetingConcernsOnly {
  meeting_id: string;
  status: MeetingFullView["logistics"]["status"];
  case: RawCaseRef | null;
  concerns: RawConcern[] | null;
}

interface RawMeetingFull {
  meeting_id: string;
  committee_proceeding_id: string;
  committee: { committee_id: string; code: string; kind: MeetingFullView["committee"]["kind"] };
  case: RawCaseRef | null;
  logistics: {
    sequence_no: number;
    purpose: MeetingFullView["logistics"]["purpose"];
    mode: MeetingFullView["logistics"]["mode"];
    provider: string;
    status: MeetingFullView["logistics"]["status"];
    location: string | null;
    online_url: string | null;
    scheduled_start: Stamp;
    scheduled_end: Stamp | null;
    is_emergency: boolean | null;
    opened_at: Stamp | null;
    closed_at: Stamp | null;
    held_offline?: boolean | null;
  };
  me: {
    participant_id: string;
    participant_kind: MeetingSelfView["participantKind"];
    seat: MeetingSelfView["seat"];
    invitee_role: MeetingSelfView["inviteeRole"];
    is_voting: boolean;
    requires_coi: boolean;
    coi_status: MeetingSelfView["coiStatus"];
    attendance: MeetingSelfView["attendance"];
    confidentiality_ack_required: boolean;
    confidentiality_acknowledged: boolean;
    accommodations?: RawAccommodation[] | null;
  } | null;
  roster: RawParticipant[] | null;
  deliberation: {
    ballot_secrecy: NonNullable<MeetingFullView["deliberation"]>["ballotSecrecy"];
    quorum: {
      quorum_type: NonNullable<NonNullable<MeetingFullView["deliberation"]>["quorum"]>["quorumType"];
      eligible: number;
      present: number;
      required: number | null;
    } | null;
    vote_items: RawVoteItem[] | null;
    witness_exclusions:
      | {
          exclusion_id: string;
          participant_id: string;
          reason: string;
          excluded_by: string;
          excluded_at: Stamp;
        }[]
      | null;
  } | null;
  concerns: RawConcern[] | null;
  acting_roles:
    | {
        acting_role_id: string;
        acting_role: MeetingActingRoleView["actingRole"];
        user_id: string;
        participant_id: string;
        replaces_participant_id: string | null;
        basis: MeetingActingRoleView["basis"];
        activated_as: MeetingActingRoleView["activatedAs"];
        activated_at: Stamp;
      }[]
    | null;
  minutes:
    | {
        minutes_id: string;
        version_no: number;
        status: MeetingFullView["minutes"][number]["status"];
        generated_at: Stamp;
        finalised_at: Stamp | null;
      }[]
    | null;
  invitee_roles?:
    | {
        invitee_role: MeetingFullView["inviteeRoles"][number]["inviteeRole"];
        confidentiality_ack_required: boolean | null;
        source_status: MeetingFullView["inviteeRoles"][number]["sourceStatus"];
      }[]
    | null;
  capabilities: Caps<
    | "can_manage"
    | "may_open"
    | "may_close"
    | "may_cancel"
    | "may_open_vote"
    | "may_generate_minutes"
    | "may_raise_concern"
    | "may_declare_conflict"
    | "may_declare_no_conflict"
    | "may_acknowledge_confidentiality"
    | "may_invite"
    | "may_record_accommodation"
    | "may_activate_acting_chair"
    | "may_activate_acting_secretary"
  > | null;
}

type RawMeetingView = RawMeetingFull | RawMeetingConcernsOnly;

interface RawMinutesView {
  minutes_id: string;
  meeting_id: string;
  version_no: number;
  status: MinutesView["status"];
  narrative: string;
  snapshot: {
    meeting: {
      sequence_no: number;
      purpose: MinutesSnapshot["meeting"]["purpose"];
      mode: MinutesSnapshot["meeting"]["mode"];
      opened_at: Stamp | null;
      closed_at: Stamp | null;
      is_emergency: boolean | null;
    };
    participants: {
      participant_id: string;
      kind: MinutesSnapshot["participants"][number]["kind"];
      user_id: string | null;
      seat: MinutesSnapshot["participants"][number]["seat"];
      invitee_role: MinutesSnapshot["participants"][number]["inviteeRole"];
      is_voting: boolean;
      coi_status: MinutesSnapshot["participants"][number]["coiStatus"];
      attendance: MinutesSnapshot["participants"][number]["attendance"];
    }[];
    acting_roles: {
      acting_role: MinutesSnapshot["actingRoles"][number]["actingRole"];
      participant_id: string;
      replaces_participant_id: string | null;
      basis: MinutesSnapshot["actingRoles"][number]["basis"];
    }[];
    vote_items: (RawTally & {
      vote_item_id: string;
      sequence_no: number;
      target_type: MinutesSnapshot["voteItems"][number]["targetType"];
      title: string;
      result: MinutesSnapshot["voteItems"][number]["result"];
      decided_by_casting_vote: boolean | null;
    })[];
    annexed_notes: { vote_item_id: string; participant_id: string | null; note: string }[];
  };
  reviewer_count: number;
  review_business_days: number;
  review_due_at: Stamp;
  deemed_approval_enabled: boolean;
  reminder_sent_at: Stamp | null;
  generated_at: Stamp;
  finalised_at: Stamp | null;
  case: RawCaseRef | null;
  meeting: {
    meeting_id: string;
    sequence_no: number;
    purpose: NonNullable<MinutesView["meeting"]>["purpose"];
    mode: NonNullable<MinutesView["meeting"]>["mode"];
    status: NonNullable<MinutesView["meeting"]>["status"];
    scheduled_start: Stamp;
    scheduled_end: Stamp | null;
    opened_at: Stamp | null;
    closed_at: Stamp | null;
  } | null;
  reviews:
    | {
        reviewer_id: string;
        decision: NonNullable<MinutesView["reviews"]>[number]["decision"];
        comment: string | null;
        reviewed_at: Stamp;
      }[]
    | null;
  objection_rulings:
    | {
        ruling_id: string;
        ruled_by: string;
        ruled_as: NonNullable<MinutesView["objectionRulings"]>[number]["ruledAs"];
        reason: string;
        ruled_at: Stamp;
      }[]
    | null;
  i_have_reviewed: boolean | null;
  capabilities: Caps<
    "may_review" | "may_remind" | "may_apply_deemed_approval" | "may_overrule_objection"
  > | null;
}

interface RawVoteItemStatus {
  vote_item_id: string;
  status: VoteItemProgress["status"];
  ballot_secrecy: VoteItemProgress["ballotSecrecy"];
  voters:
    | {
        participant_id: string;
        user_id: string | null;
        seat: VoteItemProgress["voters"][number]["seat"];
        activated_alternate: boolean | null;
        replaced: boolean | null;
        has_voted: boolean | null;
        voted_at: Stamp | null;
        source: VoteItemProgress["voters"][number]["source"];
      }[]
    | null;
}

// ---- Mapping --------------------------------------------------------------------------------------------------
const iso = (v: Stamp | null | undefined): string | null => (v ? new Date(v).toISOString() : null);
const isoReq = (v: Stamp): string => new Date(v).toISOString();
/** A capability or flag the database left out or null reads as false (fail closed). */
const yes = (v: boolean | null | undefined): boolean => v === true;
const each = <R, T>(v: readonly R[] | null | undefined, map: (r: R) => T): T[] => (v ?? []).map(map);

function tally(t: RawTally): VoteTally {
  return {
    eligible: t.eligible,
    present: t.present,
    quorumRequired: t.quorum_required ?? null,
    approve: t.approve,
    reject: t.reject,
    abstain: t.abstain,
    recused: t.recused,
    absent: t.absent,
    unable: t.unable,
    excluded: t.excluded,
  };
}

function concern(c: RawConcern): MeetingConcernView {
  const r = c.reversal;
  return {
    concernId: c.concern_id,
    participantId: c.participant_id,
    raisedBy: c.raised_by,
    raisedAs: c.raised_as,
    reason: c.reason,
    raisedAt: isoReq(c.raised_at),
    status: c.status,
    decidedBy: c.decided_by ?? null,
    decidedAs: c.decided_as ?? null,
    decisionReason: c.decision_reason ?? null,
    decidedAt: iso(c.decided_at),
    reversal: r
      ? {
          reversalId: r.reversal_id,
          reversedBy: r.reversed_by,
          reversedAs: r.reversed_as,
          reason: r.reason,
          reversedAt: isoReq(r.reversed_at),
        }
      : null,
    capabilities: {
      mayDecide: yes(c.capabilities?.may_decide),
      mayReverse: yes(c.capabilities?.may_reverse),
    },
  };
}

function accommodation(a: RawAccommodation): MeetingAccommodationView {
  return {
    accommodationId: a.accommodation_id,
    details: a.details,
    source: a.source,
    recordedAt: isoReq(a.recorded_at),
  };
}

function participant(p: RawParticipant): MeetingParticipantView {
  const c = p.capabilities;
  const a = p.arrangements;
  return {
    participantId: p.participant_id,
    participantKind: p.participant_kind,
    userId: p.user_id ?? null,
    personId: p.person_id ?? null,
    displayName: p.display_name ?? null,
    displayNameAr: p.display_name_ar ?? null,
    seat: p.seat ?? null,
    inviteeRole: p.invitee_role ?? null,
    isVoting: yes(p.is_voting),
    requiresCoi: yes(p.requires_coi),
    coiStatus: p.coi_status,
    attendance: p.attendance,
    alternateFor: p.alternate_for ?? [],
    arrangements: a
      ? {
          confidentialityAcknowledged: yes(a.confidentiality_acknowledged),
          accommodations: each(a.accommodations, accommodation),
        }
      : null,
    capabilities: {
      mayRecordPresent: yes(c?.may_record_present),
      mayRecordAbsent: yes(c?.may_record_absent),
      mayRecordExcusedConflict: yes(c?.may_record_excused_conflict),
      mayRecordExcusedAbsence: yes(c?.may_record_excused_absence),
      mayRaiseConcern: yes(c?.may_raise_concern),
      mayExcludeWitness: yes(c?.may_exclude_witness),
      mayRecordAccommodation: yes(c?.may_record_accommodation),
      mayDeclareConflict: yes(c?.may_declare_conflict),
      mayDeclareNoConflict: yes(c?.may_declare_no_conflict),
      mayAcknowledgeConfidentiality: yes(c?.may_acknowledge_confidentiality),
      mayActivateAlternate: yes(c?.may_activate_alternate),
    },
  };
}

function voteItem(v: RawVoteItem): MeetingVoteItemView {
  const c = v.capabilities;
  return {
    voteItemId: v.vote_item_id,
    sequenceNo: v.sequence_no,
    targetType: v.target_type,
    findingId: v.finding_id ?? null,
    packageId: v.package_id ?? null,
    recommendationItemId: v.recommendation_item_id ?? null,
    packageRound: v.package_round ?? null,
    title: v.title,
    status: v.status,
    result: v.result ?? null,
    decidedByCastingVote: yes(v.decided_by_casting_vote),
    openedAt: isoReq(v.opened_at),
    closedAt: iso(v.closed_at),
    tally: v.tally ? tally(v.tally) : null,
    iHaveVoted: yes(v.i_have_voted),
    iHaveNoted: yes(v.i_have_noted),
    recordVoteFor: v.record_vote_for ?? [],
    offlineBallots: {
      provisional: v.offline_ballots?.provisional ?? 0,
      confirmed: v.offline_ballots?.confirmed ?? 0,
      superseded: v.offline_ballots?.superseded ?? 0,
      lapsed: v.offline_ballots?.lapsed ?? 0,
    },
    myBallot: v.my_ballot
      ? {
          ballotId: v.my_ballot.ballot_id,
          status: v.my_ballot.status,
          choice: v.my_ballot.choice,
          ballotReference: v.my_ballot.ballot_reference,
          originalEventAt: isoReq(v.my_ballot.original_event_at),
          release: v.my_ballot.release ?? null,
        }
      : null,
    ballotsUnconfirmedFor: v.ballots_unconfirmed_for ?? [],
    ballotsReleasableFor: v.ballots_releasable_for ?? [],
    capabilities: {
      mayVote: yes(c?.may_vote),
      mayClose: yes(c?.may_close),
      mayCastCastingVote: yes(c?.may_cast_casting_vote),
      mayRevise: yes(c?.may_revise),
      mayRecuseForConflict: yes(c?.may_recuse_for_conflict),
      mayRecordNote: yes(c?.may_record_note),
      mayConfirmBallot: yes(c?.may_confirm_ballot),
      mayDeclineBallot: yes(c?.may_decline_ballot),
    },
  };
}

const caseRef = (c: RawCaseRef | null) => ({
  caseId: c?.case_id ?? null,
  caseNumber: c?.case_number ?? null,
});

/** `api.meeting_invite_choices` (2086), as the database writes it. */
interface RawInviteChoices {
  meeting_id: string;
  label_mode: MeetingInviteChoices["labelMode"];
  persons:
    | {
        person_id: string;
        position: number | string;
        case_roles: InvitePersonChoice["caseRoles"] | null;
        label: string | null;
        invitee_roles: InvitePersonChoice["inviteeRoles"] | null;
      }[]
    | null;
  accounts:
    | {
        user_id: string;
        display_name: string | null;
        display_name_ar: string | null;
        bases: InviteAccountChoice["bases"] | null;
        invitee_roles: InviteAccountChoice["inviteeRoles"] | null;
      }[]
    | null;
}

export function toMeetingInviteChoices(v: RawInviteChoices): MeetingInviteChoices {
  return {
    meetingId: v.meeting_id,
    labelMode: v.label_mode,
    persons: (v.persons ?? []).map((p) => ({
      personId: p.person_id,
      position: Number(p.position),
      caseRoles: [...(p.case_roles ?? [])],
      label: p.label ?? null,
      inviteeRoles: [...(p.invitee_roles ?? [])],
    })),
    accounts: (v.accounts ?? []).map((a) => ({
      userId: a.user_id,
      displayName: a.display_name ?? null,
      displayNameAr: a.display_name_ar ?? null,
      bases: [...(a.bases ?? [])],
      inviteeRoles: [...(a.invitee_roles ?? [])],
    })),
  };
}

export function toMeetingView(m: RawMeetingView): MeetingView {
  // The concern-only view has no logistics (2030 section 4): the caller sees one of the meeting's concerns only.
  if (!("logistics" in m)) {
    return {
      view: "CONCERNS_ONLY",
      meetingId: m.meeting_id,
      status: m.status,
      case: caseRef(m.case),
      concerns: each(m.concerns, concern),
    };
  }
  const l = m.logistics;
  const me = m.me;
  const d = m.deliberation;
  const c = m.capabilities;
  return {
    view: "FULL",
    meetingId: m.meeting_id,
    committeeProceedingId: m.committee_proceeding_id,
    committee: { committeeId: m.committee.committee_id, code: m.committee.code, kind: m.committee.kind },
    case: caseRef(m.case),
    logistics: {
      sequenceNo: l.sequence_no,
      purpose: l.purpose,
      mode: l.mode,
      provider: l.provider,
      status: l.status,
      location: l.location ?? null,
      onlineUrl: l.online_url ?? null,
      scheduledStart: isoReq(l.scheduled_start),
      scheduledEnd: iso(l.scheduled_end),
      isEmergency: yes(l.is_emergency),
      openedAt: iso(l.opened_at),
      closedAt: iso(l.closed_at),
      heldOffline: yes(l.held_offline),
    },
    me: me
      ? {
          participantId: me.participant_id,
          participantKind: me.participant_kind,
          seat: me.seat ?? null,
          inviteeRole: me.invitee_role ?? null,
          isVoting: yes(me.is_voting),
          requiresCoi: yes(me.requires_coi),
          coiStatus: me.coi_status,
          attendance: me.attendance,
          confidentialityAckRequired: yes(me.confidentiality_ack_required),
          confidentialityAcknowledged: yes(me.confidentiality_acknowledged),
          accommodations: each(me.accommodations, accommodation),
        }
      : null,
    roster: m.roster ? m.roster.map(participant) : null,
    deliberation: d
      ? {
          ballotSecrecy: d.ballot_secrecy,
          quorum: d.quorum
            ? {
                quorumType: d.quorum.quorum_type,
                eligible: d.quorum.eligible,
                present: d.quorum.present,
                required: d.quorum.required ?? null,
              }
            : null,
          voteItems: each(d.vote_items, voteItem),
          witnessExclusions: each(d.witness_exclusions, (x) => ({
            exclusionId: x.exclusion_id,
            participantId: x.participant_id,
            reason: x.reason,
            excludedBy: x.excluded_by,
            excludedAt: isoReq(x.excluded_at),
          })),
        }
      : null,
    concerns: each(m.concerns, concern),
    actingRoles: each(m.acting_roles, (a) => ({
      actingRoleId: a.acting_role_id,
      actingRole: a.acting_role,
      userId: a.user_id,
      participantId: a.participant_id,
      replacesParticipantId: a.replaces_participant_id ?? null,
      basis: a.basis,
      activatedAs: a.activated_as,
      activatedAt: isoReq(a.activated_at),
    })),
    minutes: each(m.minutes, (mi) => ({
      minutesId: mi.minutes_id,
      versionNo: mi.version_no,
      status: mi.status,
      generatedAt: isoReq(mi.generated_at),
      finalisedAt: iso(mi.finalised_at),
    })),
    inviteeRoles: each(m.invitee_roles, (r) => ({
      inviteeRole: r.invitee_role,
      confidentialityAckRequired: yes(r.confidentiality_ack_required),
      sourceStatus: r.source_status,
    })),
    capabilities: {
      canManage: yes(c?.can_manage),
      mayOpen: yes(c?.may_open),
      mayClose: yes(c?.may_close),
      mayCancel: yes(c?.may_cancel),
      mayOpenVote: yes(c?.may_open_vote),
      mayGenerateMinutes: yes(c?.may_generate_minutes),
      mayRaiseConcern: yes(c?.may_raise_concern),
      mayDeclareConflict: yes(c?.may_declare_conflict),
      mayDeclareNoConflict: yes(c?.may_declare_no_conflict),
      mayAcknowledgeConfidentiality: yes(c?.may_acknowledge_confidentiality),
      mayInvite: yes(c?.may_invite),
      mayRecordAccommodation: yes(c?.may_record_accommodation),
      mayActivateActingChair: yes(c?.may_activate_acting_chair),
      mayActivateActingSecretary: yes(c?.may_activate_acting_secretary),
    },
  };
}

function snapshot(s: RawMinutesView["snapshot"]): MinutesSnapshot {
  return {
    meeting: {
      sequenceNo: s.meeting.sequence_no,
      purpose: s.meeting.purpose,
      mode: s.meeting.mode,
      openedAt: iso(s.meeting.opened_at),
      closedAt: iso(s.meeting.closed_at),
      isEmergency: yes(s.meeting.is_emergency),
    },
    participants: each(s.participants, (p) => ({
      participantId: p.participant_id,
      kind: p.kind,
      userId: p.user_id ?? null,
      seat: p.seat ?? null,
      inviteeRole: p.invitee_role ?? null,
      isVoting: yes(p.is_voting),
      coiStatus: p.coi_status,
      attendance: p.attendance,
    })),
    actingRoles: each(s.acting_roles, (a) => ({
      actingRole: a.acting_role,
      participantId: a.participant_id,
      replacesParticipantId: a.replaces_participant_id ?? null,
      basis: a.basis,
    })),
    voteItems: each(s.vote_items, (v) => ({
      voteItemId: v.vote_item_id,
      sequenceNo: v.sequence_no,
      targetType: v.target_type,
      title: v.title,
      result: v.result ?? null,
      decidedByCastingVote: yes(v.decided_by_casting_vote),
      tally: tally(v),
    })),
    annexedNotes: each(s.annexed_notes, (n) => ({
      voteItemId: n.vote_item_id,
      participantId: n.participant_id ?? null,
      note: n.note,
    })),
  };
}

export function toMinutesView(v: RawMinutesView): MinutesView {
  const m = v.meeting;
  const c = v.capabilities;
  return {
    minutesId: v.minutes_id,
    meetingId: v.meeting_id,
    versionNo: v.version_no,
    status: v.status,
    narrative: v.narrative,
    snapshot: snapshot(v.snapshot),
    reviewerCount: v.reviewer_count,
    reviewBusinessDays: v.review_business_days,
    reviewDueAt: isoReq(v.review_due_at),
    deemedApprovalEnabled: yes(v.deemed_approval_enabled),
    reminderSentAt: iso(v.reminder_sent_at),
    generatedAt: isoReq(v.generated_at),
    finalisedAt: iso(v.finalised_at),
    case: caseRef(v.case),
    meeting: m
      ? {
          meetingId: m.meeting_id,
          sequenceNo: m.sequence_no,
          purpose: m.purpose,
          mode: m.mode,
          status: m.status,
          scheduledStart: isoReq(m.scheduled_start),
          scheduledEnd: iso(m.scheduled_end),
          openedAt: iso(m.opened_at),
          closedAt: iso(m.closed_at),
        }
      : null,
    reviews: v.reviews
      ? v.reviews.map((r) => ({
          reviewerId: r.reviewer_id,
          decision: r.decision,
          comment: r.comment ?? null,
          reviewedAt: isoReq(r.reviewed_at),
        }))
      : null,
    objectionRulings: v.objection_rulings
      ? v.objection_rulings.map((o) => ({
          rulingId: o.ruling_id,
          ruledBy: o.ruled_by,
          ruledAs: o.ruled_as,
          reason: o.reason,
          ruledAt: isoReq(o.ruled_at),
        }))
      : null,
    iHaveReviewed: typeof v.i_have_reviewed === "boolean" ? v.i_have_reviewed : null,
    capabilities: {
      mayReview: yes(c?.may_review),
      mayRemind: yes(c?.may_remind),
      mayApplyDeemedApproval: yes(c?.may_apply_deemed_approval),
      mayOverruleObjection: yes(c?.may_overrule_objection),
    },
  };
}

export function toVoteItemProgress(s: RawVoteItemStatus): VoteItemProgress {
  return {
    voteItemId: s.vote_item_id,
    status: s.status,
    ballotSecrecy: s.ballot_secrecy,
    // The choice the read model returns after a non-secret close is not taken: the screens never show one (rule 5).
    voters: each(s.voters, (v) => ({
      participantId: v.participant_id,
      userId: v.user_id ?? null,
      seat: v.seat ?? null,
      activatedAlternate: yes(v.activated_alternate),
      replaced: yes(v.replaced),
      hasVoted: yes(v.has_voted),
      votedAt: iso(v.voted_at),
      source: v.source ?? null,
    })),
  };
}

// ---- Gateway --------------------------------------------------------------------------------------------------
export class PostgresMeetingsGateway implements MeetingsGateway {
  constructor(private readonly sql: Sql) {}

  private run<T>(ctx: UserRequestContext, fn: (tx: Tx) => Promise<T>) {
    return withUserContext(this.sql, ctx, fn);
  }

  /** One value from a one-row select written `... as v`. */
  private value<T>(ctx: UserRequestContext, query: (tx: Tx) => Promise<readonly { v: T }[]>): Promise<T> {
    return this.run(ctx, async (tx) => {
      const [row] = await query(tx);
      return row!.v;
    });
  }

  async meetingView(ctx: UserRequestContext, meetingId: string): Promise<MeetingView> {
    return toMeetingView(
      await this.value<RawMeetingView>(ctx, (tx) => tx`select api.meeting_view(${meetingId}) as v`),
    );
  }

  async minutesView(ctx: UserRequestContext, minutesId: string): Promise<MinutesView> {
    return toMinutesView(
      await this.value<RawMinutesView>(ctx, (tx) => tx`select api.minutes_view(${minutesId}) as v`),
    );
  }

  async voteItemStatus(ctx: UserRequestContext, voteItemId: string): Promise<VoteItemProgress> {
    return toVoteItemProgress(
      await this.value<RawVoteItemStatus>(ctx, (tx) => tx`select api.vote_item_status(${voteItemId}) as v`),
    );
  }

  async openMeeting(ctx: UserRequestContext, i: { meetingId: string; reason: string }) {
    await this.run(ctx, (tx) => tx`select api.open_meeting(${i.meetingId}, ${i.reason})`);
  }

  async closeMeeting(ctx: UserRequestContext, i: { meetingId: string; reason: string }) {
    await this.run(ctx, (tx) => tx`select api.close_meeting(${i.meetingId}, ${i.reason})`);
  }

  async cancelMeeting(ctx: UserRequestContext, i: { meetingId: string; reason: string }) {
    await this.run(ctx, (tx) => tx`select api.cancel_meeting(${i.meetingId}, ${i.reason})`);
  }

  async recordAttendance(ctx: UserRequestContext, i: { participantId: string; attendance: string }) {
    await this.run(ctx, (tx) => tx`select api.record_attendance(${i.participantId}, ${i.attendance})`);
  }

  recordExcusedAbsence(ctx: UserRequestContext, i: { participantId: string; reason: string }) {
    return this.value<string>(
      ctx,
      (tx) => tx`select api.record_excused_absence(${i.participantId}, ${i.reason}) as v`,
    );
  }

  async declareConflict(
    ctx: UserRequestContext,
    i: { participantId: string; status: string; reason?: string | undefined },
  ) {
    await this.run(
      ctx,
      (tx) => tx`select api.declare_meeting_conflict(${i.participantId}, ${i.status}, ${i.reason ?? null})`,
    );
  }

  acknowledgeConfidentiality(ctx: UserRequestContext, i: { participantId: string }) {
    return this.value<string>(
      ctx,
      (tx) => tx`select api.acknowledge_meeting_confidentiality(${i.participantId}) as v`,
    );
  }

  raiseConcern(ctx: UserRequestContext, i: { participantId: string; reason: string }) {
    return this.value<string>(
      ctx,
      (tx) => tx`select api.raise_meeting_conflict(${i.participantId}, ${i.reason}) as v`,
    );
  }

  async decideConcern(ctx: UserRequestContext, i: { concernId: string; decision: string; reason: string }) {
    await this.run(
      ctx,
      (tx) => tx`select api.decide_meeting_conflict(${i.concernId}, ${i.decision}, ${i.reason})`,
    );
  }

  reverseConcern(ctx: UserRequestContext, i: { concernId: string; reason: string }) {
    return this.value<string>(
      ctx,
      (tx) => tx`select api.reverse_meeting_conflict_determination(${i.concernId}, ${i.reason}) as v`,
    );
  }

  openVoteItem(
    ctx: UserRequestContext,
    i: { meetingId: string; targetType: string; findingId?: string | undefined; title: string },
  ) {
    return this.value<string>(
      ctx,
      (tx) => tx`
        select api.open_vote_item(${i.meetingId}, ${i.targetType}, ${i.findingId ?? null}, ${i.title}) as v`,
    );
  }

  async castVote(
    ctx: UserRequestContext,
    i: { voteItemId: string; choice: string; reason?: string | undefined },
  ) {
    await this.run(ctx, (tx) => tx`select api.cast_vote(${i.voteItemId}, ${i.choice}, ${i.reason ?? null})`);
  }

  async reviseVote(
    ctx: UserRequestContext,
    i: { voteItemId: string; choice: string; reason?: string | undefined },
  ) {
    await this.run(
      ctx,
      (tx) => tx`select api.revise_vote(${i.voteItemId}, ${i.choice}, ${i.reason ?? null})`,
    );
  }

  async recuseForConflict(ctx: UserRequestContext, i: { voteItemId: string; reason: string }) {
    await this.run(ctx, (tx) => tx`select api.recuse_for_conflict(${i.voteItemId}, ${i.reason})`);
  }

  async confirmOfflineBallot(ctx: UserRequestContext, i: { voteItemId: string; choice: string }) {
    await this.run(ctx, (tx) => tx`select api.confirm_offline_ballot(${i.voteItemId}, ${i.choice})`);
  }

  async declineOfflineBallot(ctx: UserRequestContext, i: { voteItemId: string }) {
    await this.run(ctx, (tx) => tx`select api.decline_offline_ballot(${i.voteItemId})`);
  }

  async releaseOfflineBallot(
    ctx: UserRequestContext,
    i: { voteItemId: string; participantId: string; reason: string },
  ) {
    await this.run(
      ctx,
      (tx) => tx`select api.release_offline_ballot(${i.voteItemId}, ${i.participantId}, ${i.reason})`,
    );
  }

  recordVoteNote(ctx: UserRequestContext, i: { voteItemId: string; note: string; annexToMinutes: boolean }) {
    return this.value<string>(
      ctx,
      (tx) => tx`select api.record_vote_note(${i.voteItemId}, ${i.note}, ${i.annexToMinutes}) as v`,
    );
  }

  async recordVoteForMember(
    ctx: UserRequestContext,
    i: {
      voteItemId: string;
      participantId: string;
      choice: string;
      reason: string;
      originalEventAt?: string | undefined;
    },
  ) {
    await this.run(
      ctx,
      (tx) => tx`
        select api.record_vote_for_member(${i.voteItemId}, ${i.participantId}, ${i.choice}, ${i.reason},
          ${i.originalEventAt ?? null}::timestamptz)`,
    );
  }

  closeVoteItem(ctx: UserRequestContext, i: { voteItemId: string; customQuorumAttested: boolean }) {
    return this.value<string>(
      ctx,
      (tx) => tx`select api.close_vote_item(${i.voteItemId}, ${i.customQuorumAttested}) as v`,
    );
  }

  castCastingVote(
    ctx: UserRequestContext,
    i: { voteItemId: string; choice: string; reason?: string | undefined },
  ) {
    return this.value<string>(
      ctx,
      (tx) => tx`select api.cast_casting_vote(${i.voteItemId}, ${i.choice}, ${i.reason ?? null}) as v`,
    );
  }

  generateMinutes(ctx: UserRequestContext, i: { meetingId: string; narrative: string }) {
    return this.value<string>(
      ctx,
      (tx) => tx`select api.generate_minutes(${i.meetingId}, ${i.narrative}) as v`,
    );
  }

  reviewMinutes(
    ctx: UserRequestContext,
    i: { minutesId: string; decision: string; comment?: string | undefined },
  ) {
    return this.value<string>(
      ctx,
      (tx) => tx`select api.review_minutes(${i.minutesId}, ${i.decision}, ${i.comment ?? null}) as v`,
    );
  }

  async recordMinutesReminder(ctx: UserRequestContext, i: { minutesId: string }) {
    await this.run(ctx, (tx) => tx`select api.record_minutes_reminder(${i.minutesId})`);
  }

  applyMinutesDeemedApproval(ctx: UserRequestContext, i: { minutesId: string }) {
    return this.value<string>(ctx, (tx) => tx`select api.apply_minutes_deemed_approval(${i.minutesId}) as v`);
  }

  async overruleMinutesObjection(ctx: UserRequestContext, i: { minutesId: string; reason: string }) {
    await this.run(ctx, (tx) => tx`select api.overrule_minutes_objection(${i.minutesId}, ${i.reason})`);
  }

  // ---- The meeting's logistics (P12-2b; ADR-055) -------------------------------------------------------------------
  excludeWitness(ctx: UserRequestContext, i: { participantId: string; reason: string }) {
    return this.value<string>(
      ctx,
      (tx) => tx`select api.exclude_meeting_witness(${i.participantId}, ${i.reason}) as v`,
    );
  }

  recordAccommodation(ctx: UserRequestContext, i: { participantId: string; details: string }) {
    return this.value<string>(
      ctx,
      (tx) => tx`select api.record_meeting_accommodation(${i.participantId}, ${i.details}) as v`,
    );
  }

  activateActingChair(ctx: UserRequestContext, i: { meetingId: string; reason: string }) {
    return this.value<string>(
      ctx,
      (tx) => tx`select api.activate_acting_chair(${i.meetingId}, ${i.reason}) as v`,
    );
  }

  activateActingSecretary(ctx: UserRequestContext, i: { meetingId: string; reason: string }) {
    return this.value<string>(
      ctx,
      (tx) => tx`select api.activate_acting_secretary(${i.meetingId}, ${i.reason}) as v`,
    );
  }

  activateAlternateMember(
    ctx: UserRequestContext,
    i: { alternateParticipantId: string; replacesParticipantId: string; reason: string },
  ) {
    return this.value<string>(
      ctx,
      (tx) => tx`
        select api.activate_alternate_member(${i.alternateParticipantId}, ${i.replacesParticipantId}, ${i.reason}) as v`,
    );
  }

  // ---- The meeting's invite (P12-2c; ADR-056) ----------------------------------------------------------------------
  async inviteChoices(ctx: UserRequestContext, meetingId: string): Promise<MeetingInviteChoices> {
    return toMeetingInviteChoices(
      await this.value<RawInviteChoices>(
        ctx,
        (tx) => tx`select api.meeting_invite_choices(${meetingId}) as v`,
      ),
    );
  }

  /** One of `userId` and `personId`, as the schema splits the candidate chosen. */
  inviteToMeeting(
    ctx: UserRequestContext,
    i: {
      meetingId: string;
      inviteeRole: string;
      userId?: string | undefined;
      personId?: string | undefined;
      requiresCoi: boolean;
      reason: string;
    },
  ) {
    return this.value<string>(
      ctx,
      (tx) => tx`
        select api.invite_to_meeting(${i.meetingId}, ${i.inviteeRole}, ${i.userId ?? null}, ${i.personId ?? null},
          ${i.requiresCoi}, ${i.reason}) as v`,
    );
  }
}
