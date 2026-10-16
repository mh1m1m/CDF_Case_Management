/**
 * The meeting and minutes screens (UX redesign Phase 12, slices P12-2a and P12-2b; ADR-054 and ADR-055, migrations
 * 2030, 2065 and 2085): camel-case copies of `api.meeting_view`, `api.minutes_view` and `api.vote_item_status`. A part
 * is present only when its read rule holds in the database, and every capability is its command's own answer, never a
 * page rule (UX-116). Types and literal lists only; the lists mirror the commands' checks.
 */
import type {
  AttendanceStatus,
  BallotSecrecy,
  CoiStatus,
  CommitteeKind,
  CommitteeSeat,
  ConflictDecidedAs,
  MeetingActingBasis,
  MeetingActingRole,
  MeetingConflictConcernStatus,
  MeetingInviteeRole,
  MeetingMode,
  MeetingPurpose,
  MeetingStatus,
  MinutesStatus,
  QuorumType,
  VoteItemStatus,
  VoteResult,
  VoteTargetType,
} from "./index";

export const MEETING_PARTICIPANT_KINDS = ["MEMBER", "INVITEE"] as const;
export type MeetingParticipantKind = (typeof MEETING_PARTICIPANT_KINDS)[number];

/** What the secretary records with `api.record_attendance` (EXCUSED goes through `api.record_excused_absence`). */
export const RECORDABLE_ATTENDANCE = ["PRESENT", "ABSENT", "EXCUSED_CONFLICT"] as const;
export type RecordableAttendance = (typeof RECORDABLE_ATTENDANCE)[number];
/** A participant's own declaration (`api.declare_meeting_conflict`). */
export const COI_DECLARATIONS = ["NO_CONFLICT", "CONFLICT_DECLARED"] as const;
export type CoiDeclaration = (typeof COI_DECLARATIONS)[number];
/** The decision on a raised conflict (`api.decide_meeting_conflict`, DEC-F04). */
export const CONCERN_DECISIONS = ["UPHELD", "DISMISSED"] as const;
export type ConcernDecision = (typeof CONCERN_DECISIONS)[number];
/** A member's own vote (`api.cast_vote`, `api.revise_vote`). */
export const MEMBER_VOTE_CHOICES = ["APPROVE", "REJECT", "ABSTAIN", "RECUSED"] as const;
/** What the secretary records for a member who is not present (`api.record_vote_for_member`, Q60, N6). */
export const RECORDED_FOR_MEMBER_CHOICES = ["ABSENT", "UNABLE_TO_VOTE", "RECUSED"] as const;
/** The deciding vote on a tie (`api.cast_casting_vote`, DEC-F01, DEC-F03). */
export const CASTING_VOTE_CHOICES = ["APPROVE", "REJECT"] as const;
/**
 * The vote items the runner opens directly (`api.open_vote_item`): other business, or a finding the committee may act
 * on (P12-2c, ADR-056, from `api.committee_scope_choices`). Package and item votes open from the package
 * (`api.open_package_vote`).
 */
export const OPENABLE_VOTE_TARGETS = ["OTHER", "FINDING"] as const;
export const MINUTES_REVIEW_DECISIONS = ["APPROVE", "REQUEST_CHANGES"] as const;
export type MinutesReviewDecision = (typeof MINUTES_REVIEW_DECISIONS)[number];

/** Who recorded an accommodation (`api.record_meeting_accommodation`, AMB-157): the participant, or the runner. */
export const MEETING_ACCOMMODATION_SOURCES = ["SELF", "SECRETARY"] as const;
export type MeetingAccommodationSource = (typeof MEETING_ACCOMMODATION_SOURCES)[number];

export type ConcernRaisedAs = "MEMBER" | "SECRETARY";
export type ConcernReversedAs = "CHAIR" | "DEPUTY_CHAIR" | "CONFLICT_AUTHORITY";
export type ActingRoleActivatedAs = "SECRETARY" | "CHAIR" | "ACTING_CHAIR";
export type ObjectionRuledAs = "CHAIR" | "ACTING_CHAIR";
export type VoteSource = "SELF" | "SECRETARY";

/** The case, named only to whoever may see its metadata; null otherwise (purpose routes, DEC-02). */
export interface MeetingCaseRef {
  caseId: string | null;
  caseNumber: string | null;
}

/** A conflict raised about a participant (ADR-038, DEC-F04), as `authz.can_view_meeting_concern` shows it. */
export interface MeetingConcernView {
  concernId: string;
  participantId: string;
  raisedBy: string;
  raisedAs: ConcernRaisedAs;
  reason: string;
  raisedAt: string;
  status: MeetingConflictConcernStatus;
  decidedBy: string | null;
  decidedAs: ConflictDecidedAs | null;
  decisionReason: string | null;
  decidedAt: string | null;
  /** DEC-AMB-010: an upheld concern reversed, prospectively. */
  reversal: {
    reversalId: string;
    reversedBy: string;
    reversedAs: ConcernReversedAs;
    reason: string;
    reversedAt: string;
  } | null;
  capabilities: { mayDecide: boolean; mayReverse: boolean };
}

/** An arrangement made for one participant (AMB-157); its details may concern health. */
export interface MeetingAccommodationView {
  accommodationId: string;
  details: string;
  source: MeetingAccommodationSource;
  recordedAt: string;
}

/** The caller's own place in the meeting. */
export interface MeetingSelfView {
  participantId: string;
  participantKind: MeetingParticipantKind;
  seat: CommitteeSeat | null;
  inviteeRole: MeetingInviteeRole | null;
  isVoting: boolean;
  requiresCoi: boolean;
  coiStatus: CoiStatus;
  attendance: AttendanceStatus;
  confidentialityAckRequired: boolean;
  confidentialityAcknowledged: boolean;
  /** The caller's own accommodations (2085), for an invitee, who sees no roster. */
  accommodations: MeetingAccommodationView[];
}

/** One roster row. Its capabilities are computed for the runner, or on the caller's own row; false elsewhere (2065). */
export interface MeetingParticipantView {
  participantId: string;
  participantKind: MeetingParticipantKind;
  userId: string | null;
  personId: string | null;
  displayName: string | null;
  displayNameAr: string | null;
  seat: CommitteeSeat | null;
  inviteeRole: MeetingInviteeRole | null;
  isVoting: boolean;
  requiresCoi: boolean;
  coiStatus: CoiStatus;
  attendance: AttendanceStatus;
  /** On an alternate's row, the members it may replace now (2085); empty for anyone but the runner. */
  alternateFor: string[];
  /** The acknowledgement and accommodations (2085), for the runner and the participant themself; null otherwise. */
  arrangements: { confidentialityAcknowledged: boolean; accommodations: MeetingAccommodationView[] } | null;
  capabilities: {
    mayRecordPresent: boolean;
    mayRecordAbsent: boolean;
    mayRecordExcusedConflict: boolean;
    mayRecordExcusedAbsence: boolean;
    mayRaiseConcern: boolean;
    /**
     * 2085. Each answers the command for this participant: for the runner on a row without an account, the
     * secretary's path (ADR-054 §5).
     */
    mayExcludeWitness: boolean;
    mayRecordAccommodation: boolean;
    mayDeclareConflict: boolean;
    mayDeclareNoConflict: boolean;
    mayAcknowledgeConfidentiality: boolean;
    mayActivateAlternate: boolean;
  };
}

/** Counts only, after the item is tallied (AMB-083: never an individual choice). */
export interface VoteTally {
  eligible: number;
  present: number;
  quorumRequired: number | null;
  approve: number;
  reject: number;
  abstain: number;
  recused: number;
  absent: number;
  unable: number;
  excluded: number;
}

export interface MeetingVoteItemView {
  voteItemId: string;
  sequenceNo: number;
  targetType: VoteTargetType;
  findingId: string | null;
  packageId: string | null;
  recommendationItemId: string | null;
  packageRound: number | null;
  title: string;
  status: VoteItemStatus;
  result: VoteResult | null;
  decidedByCastingVote: boolean;
  openedAt: string;
  closedAt: string | null;
  tally: VoteTally | null;
  iHaveVoted: boolean;
  iHaveNoted: boolean;
  /** The members for whom the runner may record ABSENT, UNABLE_TO_VOTE or RECUSED now; empty for anyone else. */
  recordVoteFor: string[];
  capabilities: {
    mayVote: boolean;
    mayClose: boolean;
    mayCastCastingVote: boolean;
    mayRevise: boolean;
    mayRecuseForConflict: boolean;
    mayRecordNote: boolean;
  };
}

export interface MeetingDeliberationView {
  ballotSecrecy: BallotSecrecy;
  /** Null for a deliberation reader who may not see the roster. */
  quorum: { quorumType: QuorumType; eligible: number; present: number; required: number | null } | null;
  voteItems: MeetingVoteItemView[];
  witnessExclusions: {
    exclusionId: string;
    participantId: string;
    reason: string;
    excludedBy: string;
    excludedAt: string;
  }[];
}

export interface MeetingActingRoleView {
  actingRoleId: string;
  actingRole: MeetingActingRole;
  userId: string;
  participantId: string;
  replacesParticipantId: string | null;
  basis: MeetingActingBasis;
  activatedAs: ActingRoleActivatedAs;
  activatedAt: string;
}

export interface MeetingMinutesRef {
  minutesId: string;
  versionNo: number;
  status: MinutesStatus;
  generatedAt: string;
  finalisedAt: string | null;
}

export interface MeetingCapabilities {
  canManage: boolean;
  mayOpen: boolean;
  mayClose: boolean;
  mayCancel: boolean;
  mayOpenVote: boolean;
  mayGenerateMinutes: boolean;
  mayRaiseConcern: boolean;
  mayDeclareConflict: boolean;
  mayDeclareNoConflict: boolean;
  mayAcknowledgeConfidentiality: boolean;
  /** 2085: `api.invite_to_meeting` (the form comes with P12-2c); the caller's own accommodation; the activations. */
  mayInvite: boolean;
  mayRecordAccommodation: boolean;
  mayActivateActingChair: boolean;
  mayActivateActingSecretary: boolean;
}

/** A role `api.invite_to_meeting` accepts now (`committee.invitee_type_rule`, AMB-156, AMB-158). */
export interface MeetingInviteeRoleRule {
  inviteeRole: MeetingInviteeRole;
  confidentialityAckRequired: boolean;
  sourceStatus: "OWNER_DEFAULT" | "SOURCE_REQUIRED" | "APPROVED";
}

/** The whole meeting, for a caller who passes `authz.can_view_meeting`. */
export interface MeetingFullView {
  view: "FULL";
  meetingId: string;
  committeeProceedingId: string;
  committee: { committeeId: string; code: string; kind: CommitteeKind };
  case: MeetingCaseRef;
  logistics: {
    sequenceNo: number;
    purpose: MeetingPurpose;
    mode: MeetingMode;
    provider: string;
    status: MeetingStatus;
    location: string | null;
    onlineUrl: string | null;
    scheduledStart: string;
    scheduledEnd: string | null;
    isEmergency: boolean;
    openedAt: string | null;
    closedAt: string | null;
  };
  me: MeetingSelfView | null;
  /** Null unless `authz.can_view_meeting_roster`. */
  roster: MeetingParticipantView[] | null;
  /** Null unless `authz.can_view_meeting_deliberation` (a declared conflict closes it, rule 6). */
  deliberation: MeetingDeliberationView | null;
  concerns: MeetingConcernView[];
  actingRoles: MeetingActingRoleView[];
  minutes: MeetingMinutesRef[];
  /** For whoever may invite; empty for anyone else (2085). */
  inviteeRoles: MeetingInviteeRoleRule[];
  capabilities: MeetingCapabilities;
}

/**
 * The concern-only view: a caller who may not see the meeting but may see one of its concerns (the committee's
 * conflict authority, or a seated deputy who reverses). No logistics, roster, votes, acting roles or minutes.
 */
export interface MeetingConcernsOnlyView {
  view: "CONCERNS_ONLY";
  meetingId: string;
  status: MeetingStatus;
  case: MeetingCaseRef;
  concerns: MeetingConcernView[];
}

export type MeetingView = MeetingFullView | MeetingConcernsOnlyView;

/** `api.vote_item_status`: who has voted so far, never a choice while the vote runs (AMB-083). */
export interface VoteItemProgress {
  voteItemId: string;
  status: VoteItemStatus;
  ballotSecrecy: BallotSecrecy;
  voters: {
    participantId: string;
    userId: string | null;
    seat: CommitteeSeat | null;
    activatedAlternate: boolean;
    replaced: boolean;
    hasVoted: boolean;
    votedAt: string | null;
    source: VoteSource | null;
  }[];
}

/** What a minutes version recorded when it was generated (2030 §2.12): the meeting as it stood at closing. */
export interface MinutesSnapshot {
  meeting: {
    sequenceNo: number;
    purpose: MeetingPurpose;
    mode: MeetingMode;
    openedAt: string | null;
    closedAt: string | null;
    isEmergency: boolean;
  };
  participants: {
    participantId: string;
    kind: MeetingParticipantKind;
    userId: string | null;
    seat: CommitteeSeat | null;
    inviteeRole: MeetingInviteeRole | null;
    isVoting: boolean;
    coiStatus: CoiStatus;
    attendance: AttendanceStatus;
  }[];
  actingRoles: {
    actingRole: MeetingActingRole;
    participantId: string;
    replacesParticipantId: string | null;
    basis: MeetingActingBasis;
  }[];
  voteItems: {
    voteItemId: string;
    sequenceNo: number;
    targetType: VoteTargetType;
    title: string;
    result: VoteResult | null;
    decidedByCastingVote: boolean;
    tally: VoteTally;
  }[];
  /** Notes their authors asked to annex; under a secret ballot the note names no member (AMB-083). */
  annexedNotes: { voteItemId: string; participantId: string | null; note: string }[];
}

export interface MinutesView {
  minutesId: string;
  meetingId: string;
  versionNo: number;
  status: MinutesStatus;
  narrative: string;
  snapshot: MinutesSnapshot;
  reviewerCount: number;
  reviewBusinessDays: number;
  reviewDueAt: string;
  deemedApprovalEnabled: boolean;
  reminderSentAt: string | null;
  generatedAt: string;
  finalisedAt: string | null;
  case: MeetingCaseRef;
  /** Null unless the caller may see the meeting itself. */
  meeting: {
    meetingId: string;
    sequenceNo: number;
    purpose: MeetingPurpose;
    mode: MeetingMode;
    status: MeetingStatus;
    scheduledStart: string;
    scheduledEnd: string | null;
    openedAt: string | null;
    closedAt: string | null;
  } | null;
  /** Null unless the caller may see the deliberation. */
  reviews:
    | { reviewerId: string; decision: MinutesReviewDecision; comment: string | null; reviewedAt: string }[]
    | null;
  objectionRulings:
    | { rulingId: string; ruledBy: string; ruledAs: ObjectionRuledAs; reason: string; ruledAt: string }[]
    | null;
  iHaveReviewed: boolean | null;
  capabilities: {
    mayReview: boolean;
    mayRemind: boolean;
    mayApplyDeemedApproval: boolean;
    mayOverruleObjection: boolean;
  };
}
