// CommitteesGateway over PostgreSQL (UX redesign Phase 12 P12-2b; ADR-055, migration 2085). Reads call only the
// purpose read models api.my_committees and api.committee_view, which decide what the caller sees on the seat basis;
// the gateway renames their keys and reads no table. Writes only call api.schedule_meeting,
// api.schedule_emergency_meeting and api.amend_proceeding_snapshot. Every method runs in its own transaction under the
// caller's security context.
import type {
  CommitteeMeetingRow,
  CommitteeProceedingSummary,
  CommitteeRules,
  CommitteeView,
  MyCommitteeRow,
} from "@cdf/contracts";
import type { CommitteesGateway, UserRequestContext } from "@cdf/application";
import { withUserContext, type Sql, type Tx } from "./security-context";

// ---- The read models' JSON, as the database writes it (snake_case; timestamps as text) -------------------------
type Stamp = string;
type Seat = MyCommitteeRow["seat"];

interface RawMyCommittee {
  committee_id: string;
  code: string;
  kind: MyCommitteeRow["kind"];
  is_active: boolean | null;
  seat: Seat;
  effective_from: Stamp;
  effective_to: Stamp | null;
  open_proceedings: number | null;
  active_meetings: number | null;
}

/**
 * A rule set as `to_jsonb(committee.rule_set)` writes it, without its id, committee, author, time and reason: the
 * committee's rules in force, or the copy a proceeding took at referral. A copy taken before a rule existed lacks its
 * key; numbers may arrive as JSON numbers or numeric text.
 */
interface RawRules {
  quorum_type: CommitteeRules["quorumType"];
  quorum_value?: number | string | null;
  casting_vote_enabled?: boolean | null;
  acting_chair_casting_vote?: boolean | null;
  ballot_secrecy?: CommitteeRules["ballotSecrecy"];
  vote_revision_allowed?: boolean | null;
  dissent_note_allowed?: boolean | null;
  minutes_review_business_days?: number | null;
  deemed_approval_enabled?: boolean | null;
  minutes_objection_blocks_deemed?: boolean | null;
  minimum_notice_days?: number | null;
  conflict_decider?: CommitteeRules["conflictDecider"];
  source_status?: CommitteeRules["sourceStatus"];
  effective_from?: Stamp | null;
}

interface RawProceeding {
  committee_proceeding_id: string;
  status: CommitteeProceedingSummary["status"];
  referred_at: Stamp;
  closed_at: Stamp | null;
  case: { case_id: string | null; case_number: string | null } | null;
  rules: RawRules;
  snapshot: {
    seats: { seat: Seat; count: number }[] | null;
    voting: number | null;
    cleared: number | null;
    not_cleared: number | null;
    firewall_restricted: number | null;
    added_after_referral: number | null;
  } | null;
  meetings:
    | {
        meeting_id: string;
        sequence_no: number;
        purpose: CommitteeMeetingRow["purpose"];
        mode: CommitteeMeetingRow["mode"];
        status: CommitteeMeetingRow["status"];
        scheduled_start: Stamp;
        scheduled_end: Stamp | null;
        is_emergency: boolean | null;
      }[]
    | null;
  amendment_candidates:
    | {
        membership_id: string;
        user_id: string;
        display_name: string | null;
        display_name_ar: string | null;
        seat: Seat;
        effective_from: Stamp;
      }[]
    | null;
  capabilities: Partial<
    Record<"may_schedule_meeting" | "may_schedule_emergency_meeting" | "may_amend_snapshot", boolean | null>
  > | null;
}

interface RawCommitteeView {
  committee: {
    committee_id: string;
    code: string;
    kind: CommitteeView["committee"]["kind"];
    is_active: boolean;
  };
  my_seat: { seat: Seat; effective_from: Stamp; effective_to: Stamp | null };
  members:
    | {
        user_id: string;
        display_name: string | null;
        display_name_ar: string | null;
        seat: Seat;
        effective_from: Stamp;
        effective_to: Stamp | null;
      }[]
    | null;
  rules: RawRules | null;
  proceedings: RawProceeding[] | null;
}

// ---- Mapping --------------------------------------------------------------------------------------------------
const iso = (v: Stamp | null | undefined): string | null => (v ? new Date(v).toISOString() : null);
const isoReq = (v: Stamp): string => new Date(v).toISOString();
/** A capability or flag the database left out or null reads as false (fail closed). */
const yes = (v: boolean | null | undefined): boolean => v === true;
/** A rule the copy holds, or null when it predates the rule: never a default the page would have to invent. */
const held = <T>(v: T | null | undefined): T | null => v ?? null;
const count = (v: number | null | undefined): number => v ?? 0;
const each = <R, T>(v: readonly R[] | null | undefined, map: (r: R) => T): T[] => (v ?? []).map(map);

export function toCommitteeRules(r: RawRules): CommitteeRules {
  const q = r.quorum_value;
  return {
    quorumType: r.quorum_type,
    quorumValue: q === null || q === undefined ? null : Number(q),
    castingVoteEnabled: held(r.casting_vote_enabled),
    actingChairCastingVote: held(r.acting_chair_casting_vote),
    ballotSecrecy: held(r.ballot_secrecy),
    voteRevisionAllowed: held(r.vote_revision_allowed),
    dissentNoteAllowed: held(r.dissent_note_allowed),
    minutesReviewBusinessDays: held(r.minutes_review_business_days),
    deemedApprovalEnabled: held(r.deemed_approval_enabled),
    minutesObjectionBlocksDeemed: held(r.minutes_objection_blocks_deemed),
    minimumNoticeDays: held(r.minimum_notice_days),
    conflictDecider: held(r.conflict_decider),
    sourceStatus: held(r.source_status),
    effectiveFrom: iso(r.effective_from),
  };
}

export function toMyCommittees(rows: readonly RawMyCommittee[] | null): MyCommitteeRow[] {
  return each(rows, (c) => ({
    committeeId: c.committee_id,
    code: c.code,
    kind: c.kind,
    isActive: yes(c.is_active),
    seat: c.seat,
    effectiveFrom: isoReq(c.effective_from),
    effectiveTo: iso(c.effective_to),
    openProceedings: count(c.open_proceedings),
    activeMeetings: count(c.active_meetings),
  }));
}

function proceeding(p: RawProceeding): CommitteeProceedingSummary {
  const s = p.snapshot;
  const c = p.capabilities;
  return {
    committeeProceedingId: p.committee_proceeding_id,
    status: p.status,
    referredAt: isoReq(p.referred_at),
    closedAt: iso(p.closed_at),
    case: { caseId: p.case?.case_id ?? null, caseNumber: p.case?.case_number ?? null },
    rules: toCommitteeRules(p.rules),
    snapshot: {
      seats: each(s?.seats, (x) => ({ seat: x.seat, count: x.count })),
      voting: count(s?.voting),
      cleared: count(s?.cleared),
      notCleared: count(s?.not_cleared),
      firewallRestricted: count(s?.firewall_restricted),
      addedAfterReferral: count(s?.added_after_referral),
    },
    meetings: each(p.meetings, (m) => ({
      meetingId: m.meeting_id,
      sequenceNo: m.sequence_no,
      purpose: m.purpose,
      mode: m.mode,
      status: m.status,
      scheduledStart: isoReq(m.scheduled_start),
      scheduledEnd: iso(m.scheduled_end),
      isEmergency: yes(m.is_emergency),
    })),
    amendmentCandidates: each(p.amendment_candidates, (a) => ({
      membershipId: a.membership_id,
      userId: a.user_id,
      displayName: a.display_name ?? null,
      displayNameAr: a.display_name_ar ?? null,
      seat: a.seat,
      effectiveFrom: isoReq(a.effective_from),
    })),
    capabilities: {
      mayScheduleMeeting: yes(c?.may_schedule_meeting),
      mayScheduleEmergencyMeeting: yes(c?.may_schedule_emergency_meeting),
      mayAmendSnapshot: yes(c?.may_amend_snapshot),
    },
  };
}

export function toCommitteeView(v: RawCommitteeView): CommitteeView {
  return {
    committee: {
      committeeId: v.committee.committee_id,
      code: v.committee.code,
      kind: v.committee.kind,
      isActive: yes(v.committee.is_active),
    },
    mySeat: {
      seat: v.my_seat.seat,
      effectiveFrom: isoReq(v.my_seat.effective_from),
      effectiveTo: iso(v.my_seat.effective_to),
    },
    members: each(v.members, (m) => ({
      userId: m.user_id,
      displayName: m.display_name ?? null,
      displayNameAr: m.display_name_ar ?? null,
      seat: m.seat,
      effectiveFrom: isoReq(m.effective_from),
      effectiveTo: iso(m.effective_to),
    })),
    rules: v.rules ? toCommitteeRules(v.rules) : null,
    proceedings: each(v.proceedings, proceeding),
  };
}

// ---- Gateway --------------------------------------------------------------------------------------------------
export class PostgresCommitteesGateway implements CommitteesGateway {
  constructor(private readonly sql: Sql) {}

  /** One value from a one-row select written `... as v`, in the caller's security context. */
  private value<T>(ctx: UserRequestContext, query: (tx: Tx) => Promise<readonly { v: T }[]>): Promise<T> {
    return withUserContext(this.sql, ctx, async (tx) => {
      const [row] = await query(tx);
      return row!.v;
    });
  }

  async myCommittees(ctx: UserRequestContext): Promise<MyCommitteeRow[]> {
    return toMyCommittees(
      await this.value<RawMyCommittee[] | null>(ctx, (tx) => tx`select api.my_committees() as v`),
    );
  }

  async committeeView(ctx: UserRequestContext, committeeId: string): Promise<CommitteeView> {
    return toCommitteeView(
      await this.value<RawCommitteeView>(ctx, (tx) => tx`select api.committee_view(${committeeId}) as v`),
    );
  }

  scheduleMeeting(
    ctx: UserRequestContext,
    i: {
      committeeProceedingId: string;
      purpose: string;
      mode: string;
      location?: string | undefined;
      onlineUrl?: string | undefined;
      scheduledStart: string;
      scheduledEnd: string;
      reason: string;
    },
  ) {
    return this.value<string>(
      ctx,
      (tx) => tx`
        select api.schedule_meeting(${i.committeeProceedingId}, ${i.purpose}, ${i.mode}, ${i.location ?? null},
          ${i.onlineUrl ?? null}, ${i.scheduledStart}::timestamptz, ${i.scheduledEnd}::timestamptz, ${i.reason}) as v`,
    );
  }

  scheduleEmergencyMeeting(
    ctx: UserRequestContext,
    i: {
      committeeProceedingId: string;
      purpose: string;
      mode: string;
      location?: string | undefined;
      onlineUrl?: string | undefined;
      scheduledStart: string;
      scheduledEnd: string;
      reason: string;
      emergencyReason: string;
    },
  ) {
    return this.value<string>(
      ctx,
      (tx) => tx`
        select api.schedule_emergency_meeting(${i.committeeProceedingId}, ${i.purpose}, ${i.mode},
          ${i.location ?? null}, ${i.onlineUrl ?? null}, ${i.scheduledStart}::timestamptz,
          ${i.scheduledEnd}::timestamptz, ${i.reason}, ${i.emergencyReason}) as v`,
    );
  }

  amendProceedingSnapshot(
    ctx: UserRequestContext,
    i: { committeeProceedingId: string; membershipId: string; reason: string },
  ) {
    return this.value<string>(
      ctx,
      (tx) => tx`
        select api.amend_proceeding_snapshot(${i.committeeProceedingId}, ${i.membershipId}, ${i.reason}) as v`,
    );
  }
}
