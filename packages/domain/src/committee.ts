/**
 * Proceeding and committee rules (ADR-017 to ADR-020). Pure functions: the UI uses them to explain what will
 * happen and the application layer to refuse early. Migration 1870 and later committee migrations are the
 * authority and re-check every rule.
 */
import type { CommitteeSeat, ProceedingStatus, ProceedingType, QuorumType } from "@cdf/contracts";

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
