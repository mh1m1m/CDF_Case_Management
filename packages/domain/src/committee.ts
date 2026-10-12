/**
 * Proceeding and committee rules (ADR-017 to ADR-020). Pure functions: the UI uses them to explain what will
 * happen and the application layer to refuse early. Migration 1870 and later committee migrations are the
 * authority and re-check every rule.
 */
import type {
  CommitteeSeat,
  ProceedingStatus,
  ProceedingType,
  QuorumType,
  VoteChoice,
  VoteResult,
} from "@cdf/contracts";

/** Chair, deputy chair and members vote; secretaries and alternates do not (api.refer_case_to_committee). */
export const VOTING_SEATS: readonly CommitteeSeat[] = ["CHAIR", "DEPUTY_CHAIR", "MEMBER"];
/** Seats with one holder at a time (api.appoint_committee_member). */
export const SINGLE_HOLDER_SEATS: readonly CommitteeSeat[] = [
  "CHAIR",
  "DEPUTY_CHAIR",
  "SECRETARY",
  "ALTERNATE_SECRETARY",
];

export const TERMINAL_PROCEEDING_STATUSES: readonly ProceedingStatus[] = ["CONCLUDED", "CANCELLED"];
/** Types that api.open_proceeding opens; committee and grievance proceedings come from a referral. */
export const DIRECTLY_OPENED_PROCEEDING_TYPES: readonly ProceedingType[] = [
  "PRELIMINARY_REVIEW",
  "INVESTIGATION",
  "LEGAL_REVIEW",
  "AUTHORITY_DECISION",
  "CORRECTIVE_ACTION",
  "REINVESTIGATION",
];
/** Types that may have more than one open proceeding in a case at a time. */
export const PARALLEL_PROCEEDING_TYPES: readonly ProceedingType[] = ["CORRECTIVE_ACTION", "REINVESTIGATION"];

export function isVotingSeat(seat: CommitteeSeat): boolean {
  return VOTING_SEATS.includes(seat);
}

export function proceedingDisplayNumber(sequenceNo: number): string {
  return `PRC-${String(sequenceNo).padStart(3, "0")}`;
}

export interface EffectivePeriod {
  effectiveFrom: string;
  effectiveTo: string | null;
}

/** Half-open [from, to) periods, as the database compares them. */
export function isEffectiveAt(period: EffectivePeriod, at: string): boolean {
  const t = Date.parse(at);
  return (
    Date.parse(period.effectiveFrom) <= t &&
    (period.effectiveTo === null || Date.parse(period.effectiveTo) > t)
  );
}

export function periodsOverlap(a: EffectivePeriod, b: EffectivePeriod): boolean {
  const aEnd = a.effectiveTo === null ? Infinity : Date.parse(a.effectiveTo);
  const bEnd = b.effectiveTo === null ? Infinity : Date.parse(b.effectiveTo);
  return Date.parse(a.effectiveFrom) < bEnd && Date.parse(b.effectiveFrom) < aEnd;
}

export interface QuorumRule {
  quorumType: QuorumType;
  quorumValue: number | null;
}

/**
 * How many present, non-conflicted eligible voting members a vote needs (Q51–Q54), or null for a CUSTOM rule,
 * which needs a recorded attestation instead of a number. MAJORITY_ELIGIBLE means more than half.
 */
export function quorumThreshold(rule: QuorumRule, eligible: number): number | null {
  switch (rule.quorumType) {
    case "MAJORITY_ELIGIBLE":
      return Math.floor(eligible / 2) + 1;
    case "FIXED_NUMBER":
      return rule.quorumValue ?? Infinity;
    case "PERCENTAGE":
      return Math.ceil((eligible * (rule.quorumValue ?? 100)) / 100);
    case "CUSTOM":
      return null;
  }
}

export function isQuorate(rule: QuorumRule, eligible: number, present: number): boolean | null {
  const needed = quorumThreshold(rule, eligible);
  return needed === null ? null : eligible > 0 && present >= needed;
}

// ---- Meetings, voting and minutes (ADR-020, migration 1890) --------------------------------------------

/** Business days are Sunday to Thursday in Asia/Riyadh. Public holidays are SOURCE_REQUIRED and not modelled. */
const RIYADH_OFFSET_MS = 3 * 60 * 60 * 1000; // UTC+3 all year (no daylight saving)

export function isBusinessDay(at: Date): boolean {
  const day = new Date(at.getTime() + RIYADH_OFFSET_MS).getUTCDay();
  return day !== 5 && day !== 6;
}

/** `days` business days after `from`, same local time of day (committee.add_business_days). */
export function addBusinessDays(from: Date, days: number): Date {
  let t = from.getTime();
  let left = days;
  while (left > 0) {
    t += 24 * 60 * 60 * 1000;
    if (isBusinessDay(new Date(t))) left -= 1;
  }
  return new Date(t);
}

export interface CountedVote {
  choice: VoteChoice;
  /** The voter is present, has declared no conflict and is cleared for the case when the item closes. */
  counted: boolean;
}

export interface Tally {
  approve: number;
  reject: number;
  abstain: number;
  recused: number;
  absent: number;
  unable: number;
  excluded: number;
}

export function tallyVotes(votes: readonly CountedVote[]): Tally {
  const t: Tally = { approve: 0, reject: 0, abstain: 0, recused: 0, absent: 0, unable: 0, excluded: 0 };
  for (const v of votes) {
    if (v.choice === "ABSENT") t.absent += 1;
    else if (v.choice === "UNABLE_TO_VOTE") t.unable += 1;
    else if (!v.counted) t.excluded += 1;
    else if (v.choice === "APPROVE") t.approve += 1;
    else if (v.choice === "REJECT") t.reject += 1;
    else if (v.choice === "ABSTAIN") t.abstain += 1;
    else t.recused += 1;
  }
  return t;
}

/**
 * The outcome api.close_vote_item records: NO_QUORUM without quorum; otherwise a simple majority of APPROVE over
 * REJECT (SOURCE_REQUIRED); with no APPROVE or REJECT at all the rule's no-substantive-vote outcome (never the
 * chair alone); a tie awaits the chair's casting vote when the rule enables it and the chair cast a counted,
 * non-recused vote, else TIED.
 */
export function voteOutcome(
  tally: Pick<Tally, "approve" | "reject">,
  quorate: boolean,
  castingVoteAvailable: boolean,
  noSubstantiveVoteOutcome: "NO_DECISION" | "TIED" = "NO_DECISION",
): VoteResult | "AWAITING_CASTING_VOTE" {
  if (!quorate) return "NO_QUORUM";
  if (tally.approve > tally.reject) return "APPROVED";
  if (tally.reject > tally.approve) return "REJECTED";
  if (tally.approve === 0) return noSubstantiveVoteOutcome;
  return castingVoteAvailable ? "AWAITING_CASTING_VOTE" : "TIED";
}
