/**
 * My Committees and one committee's page (UX redesign Phase 12, slice P12-2b; ADR-055, migration 2085): camel-case
 * copies of `api.my_committees` and `api.committee_view`. Both read the seat basis only (a current seat on the
 * committee, never the case team's view of a case), a proceeding's committee is counts and never a person (DEC-F19),
 * and every capability is its command's own answer (UX-116). Types and literal lists only.
 */
import type {
  BallotSecrecy,
  CommitteeKind,
  CommitteeSeat,
  ConflictDecider,
  MeetingCaseRef,
  MeetingMode,
  MeetingPurpose,
  MeetingStatus,
  QuorumType,
} from "./index";

/** Where a rule set comes from (`committee.rule_set.source_status`). */
export const RULE_SOURCE_STATUSES = ["OWNER_DEFAULT", "SOURCE_REQUIRED", "APPROVED"] as const;
export type RuleSourceStatus = (typeof RULE_SOURCE_STATUSES)[number];
export const COMMITTEE_PROCEEDING_STATUSES = ["OPEN", "CONCLUDED", "CANCELLED"] as const;
export type CommitteeProceedingStatus = (typeof COMMITTEE_PROCEEDING_STATUSES)[number];

/** One row of My Committees: a committee where the caller holds a seat now. */
export interface MyCommitteeRow {
  committeeId: string;
  code: string;
  kind: CommitteeKind;
  isActive: boolean;
  seat: CommitteeSeat;
  effectiveFrom: string;
  effectiveTo: string | null;
  /** Open proceedings the caller sees through the seat: never one only the case team would see. */
  openProceedings: number;
  /** Scheduled or open meetings of those proceedings that the caller may see. */
  activeMeetings: number;
}

/**
 * A committee's rules as a member needs them: the rule set in force, or the copy a proceeding took at referral (later
 * changes never reach a proceeding). A copy taken before a rule existed does not hold it: null here, never a guess.
 */
export interface CommitteeRules {
  quorumType: QuorumType;
  quorumValue: number | null;
  castingVoteEnabled: boolean | null;
  actingChairCastingVote: boolean | null;
  ballotSecrecy: BallotSecrecy | null;
  voteRevisionAllowed: boolean | null;
  dissentNoteAllowed: boolean | null;
  minutesReviewBusinessDays: number | null;
  deemedApprovalEnabled: boolean | null;
  minutesObjectionBlocksDeemed: boolean | null;
  /** Null: no minimum notice applies (or the copy predates the rule), and scheduling checks none. */
  minimumNoticeDays: number | null;
  conflictDecider: ConflictDecider | null;
  sourceStatus: RuleSourceStatus | null;
  effectiveFrom: string | null;
}

/** A current member of the committee, as the registry shows any current seat holder. */
export interface CommitteeMemberView {
  userId: string;
  displayName: string | null;
  displayNameAr: string | null;
  seat: CommitteeSeat;
  effectiveFrom: string;
  effectiveTo: string | null;
}

/** The committee as a proceeding holds it (DEC-F19): holders per seat and totals, never a name or a per-person flag. */
export interface CommitteeSnapshotCounts {
  seats: { seat: CommitteeSeat; count: number }[];
  voting: number;
  cleared: number;
  notCleared: number;
  firewallRestricted: number;
  /** Members added after referral (AMB-038). */
  addedAfterReferral: number;
}

/** A meeting of the proceeding that the caller may see. */
export interface CommitteeMeetingRow {
  meetingId: string;
  sequenceNo: number;
  purpose: MeetingPurpose;
  mode: MeetingMode;
  status: MeetingStatus;
  scheduledStart: string;
  scheduledEnd: string | null;
  isEmergency: boolean;
}

/**
 * A current member not in the proceeding's snapshot, offered to whoever may amend it. Deliberately not filtered by
 * clearance: the command answers NOT_CLEARED_FOR_CASE at submit (a cleared-only list would be a per-person flag).
 */
export interface AmendmentCandidate {
  membershipId: string;
  userId: string;
  displayName: string | null;
  displayNameAr: string | null;
  seat: CommitteeSeat;
  effectiveFrom: string;
}

/** One proceeding on the committee's page, on the caller's seat basis. */
export interface CommitteeProceedingSummary {
  committeeProceedingId: string;
  status: CommitteeProceedingStatus;
  referredAt: string;
  closedAt: string | null;
  /** Named only to whoever may see the case's metadata. */
  case: MeetingCaseRef;
  rules: CommitteeRules;
  snapshot: CommitteeSnapshotCounts;
  meetings: CommitteeMeetingRow[];
  /** Empty for anyone who may not amend the snapshot. */
  amendmentCandidates: AmendmentCandidate[];
  capabilities: {
    /** Up to the notice check, which needs the time chosen: the form states the minimum notice. */
    mayScheduleMeeting: boolean;
    mayScheduleEmergencyMeeting: boolean;
    mayAmendSnapshot: boolean;
  };
}

/** One committee, for a current seat holder (`api.committee_view`). */
export interface CommitteeView {
  committee: { committeeId: string; code: string; kind: CommitteeKind; isActive: boolean };
  mySeat: { seat: CommitteeSeat; effectiveFrom: string; effectiveTo: string | null };
  members: CommitteeMemberView[];
  /** Null when no rule set is in force. */
  rules: CommitteeRules | null;
  proceedings: CommitteeProceedingSummary[];
}
