/**
 * Legal review and the authority's decision (UX redesign Phase 12, slice P12-3a; ADR-057, migration 2095): camel-case
 * copies of `api.legal_review_view` (L1, the assigned reviewer's request), `api.legal_review_choices` (L2, what a legal
 * review may be asked for or approved with), the legal-review and authority keys 2095 adds to each package of
 * `api.committee_items_view` (R2), and `api.open_packet` (the audited read of a packet's stored content). A packet
 * shows subject names as snapshotted in every label mode (the coordinator, 2026-10-15 06:50): DEC-02 governs labels in
 * lists and rosters, not packet content. Every capability is its command's own answer for the caller now (UX-116), and
 * the command checks again. Types and literal lists only.
 */
import type {
  AuthorityOutcome,
  AuthorityType,
  FindingResult,
  LegalOpinion,
  PacketPurpose,
  RecommendationItemType,
  RecommendationPackageStatus,
  SanctionVerificationStatus,
  SubjectCategory,
} from "./index";
import type { CommitteeLabelMode, FindingProceedingRole, SubjectRef } from "./committee-proceedings";

export const LEGAL_REVIEW_STATUSES = ["ASSIGNED", "OPINION_GIVEN", "CANCELLED"] as const;
export type LegalReviewStatus = (typeof LEGAL_REVIEW_STATUSES)[number];
/** Why a review was asked for: the rules require it (DEC-F12), or the committee's secretary chose to. */
export const LEGAL_REVIEW_BASES = ["RULE", "SECRETARY_ELECTED"] as const;
export type LegalReviewBasis = (typeof LEGAL_REVIEW_BASES)[number];
/** What `api.legal_review_choices` answers for: asking for a review, or approving one on a restricted case. */
export const LEGAL_REVIEW_ACTS = ["REQUEST", "APPROVE"] as const;
export type LegalReviewAct = (typeof LEGAL_REVIEW_ACTS)[number];
/** Where an authority rule stands (DEC-F13): its source status, or NO_RULE where none is in force. */
export const AUTHORITY_RULE_COVERAGES = ["OWNER_DEFAULT", "SOURCE_REQUIRED", "APPROVED", "NO_RULE"] as const;
export type AuthorityRuleCoverage = (typeof AUTHORITY_RULE_COVERAGES)[number];
export type AuthorityRuleSourceStatus = Exclude<AuthorityRuleCoverage, "NO_RULE">;
/** What an authority's decision says of each item in its scope. */
export const AUTHORITY_ITEM_OUTCOMES = ["APPROVED", "REJECTED", "MODIFIED", "RETURNED", "OTHER"] as const;
export type AuthorityItemOutcome = (typeof AUTHORITY_ITEM_OUTCOMES)[number];
/** What the secretary records item by item for APPROVE_PARTIALLY and MODIFY. */
export const RECORDED_ITEM_OUTCOMES = ["APPROVED", "REJECTED", "MODIFIED"] as const;
export type RecordedItemOutcome = (typeof RECORDED_ITEM_OUTCOMES)[number];
/** The outcomes decided item by item: one outcome per item of the authority's scope, and only for these. */
export const ITEMISED_AUTHORITY_OUTCOMES = ["APPROVE_PARTIALLY", "MODIFY"] as const;
/** The outcomes a decision may attach conditions to (AMB-133). */
export const CONDITIONAL_AUTHORITY_OUTCOMES = [
  "APPROVE_AS_RECOMMENDED",
  "APPROVE_PARTIALLY",
  "MODIFY",
] as const;
export const AUTHORITY_CONDITION_KINDS = ["CORRECTIVE_ACTION", "FOLLOW_UP_TASK", "FREE_TEXT"] as const;
export type AuthorityConditionKind = (typeof AUTHORITY_CONDITION_KINDS)[number];
/** Whether the decision's source document is signed (AMB-129): unsigned only with the secretary's attestation. */
export const SOURCE_SIGNATURES = ["SIGNED", "UNSIGNED"] as const;
export type SourceSignature = (typeof SOURCE_SIGNATURES)[number];
/** How a round reached the authority: submitted, or snapshotted when a pre-2030 round was first decided. */
export const SUBMISSION_BASES = ["SUBMISSION", "BACKFILL"] as const;
export type SubmissionBasis = (typeof SUBMISSION_BASES)[number];

/** An account as the read models name it. */
export interface AccountName {
  userId: string;
  displayName: string | null;
  displayNameAr: string | null;
}

/** A superseding opinion (AMB-117): the reviewer's later opinion on the same request, kept with every earlier one. */
export interface OpinionRevision {
  revisionId: string;
  revisionNo: number;
  opinion: LegalOpinion;
  opinionText: string | null;
  givenAt: string;
}

/** `api.legal_review_view` (L1): the assigned reviewer's request while its packet is theirs to read. */
export interface LegalReviewView {
  requestId: string;
  packageRound: number;
  status: LegalReviewStatus;
  basis: LegalReviewBasis;
  /** The secretary's reason for asking. */
  reason: string;
  requestedAt: string;
  requestedBy: AccountName | null;
  opinion: LegalOpinion | null;
  opinionText: string | null;
  opinionAt: string | null;
  revisions: OpinionRevision[];
  /** For `api.open_packet`, the audited read. */
  packetId: string;
  capabilities: { mayGiveOpinion: boolean; mayGiveSupersedingOpinion: boolean };
  /** What each command would refuse with now, or null where it would accept the opinion chosen. */
  opinionBlock: string | null;
  supersedingOpinionBlock: string | null;
}

/** A finding a request may send: by allegation number and category, its person by position (a name only in DISPLAY_NAME mode). */
export interface LegalReviewFindingChoice {
  findingId: string;
  versionNo: number;
  result: FindingResult;
  proceedingRole: FindingProceedingRole;
  allegation: { allegationId: string; position: number; category: string };
  subject: SubjectRef | null;
}

/** Approved or deemed-approved minutes of a meeting of the package's proceeding. */
export interface LegalReviewMinutesChoice {
  minutesId: string;
  meetingId: string;
  meetingSequenceNo: number;
  versionNo: number;
  status: string;
  finalisedAt: string | null;
}

/** `api.legal_review_choices` (L2): audited LEGAL_REVIEW_CHOICES_VIEWED with counts only; a refusal raises the command's code. */
export interface LegalReviewChoices {
  act: LegalReviewAct;
  package: {
    packageId: string;
    committeeProceedingId: string;
    sequenceNo: number;
    roundNo: number;
    status: RecommendationPackageStatus;
  };
  labelMode: CommitteeLabelMode;
  /** On a restricted case a request takes exactly the unused approval of the round: its reviewer and scope (ruling 2). */
  restricted: boolean;
  /** The package's adopted items, which the packet carries besides. */
  items: { itemId: string; itemType: RecommendationItemType; sanctionCode: string | null }[];
  /** Every active holder of LEGAL_OPINION_GIVE but the caller (the seat basis, not filtered by the case gate, ruling 1). */
  reviewers: AccountName[];
  findings: LegalReviewFindingChoice[];
  minutes: LegalReviewMinutesChoice[];
}

/** A request for legal review of a package, as R2 shows it to whoever may read the package (2095). */
export interface PackageLegalReviewRequest {
  requestId: string;
  packageRound: number;
  status: LegalReviewStatus;
  basis: LegalReviewBasis;
  reason: string;
  requestedAt: string;
  reviewer: AccountName;
  opinion: LegalOpinion | null;
  opinionText: string | null;
  opinionAt: string | null;
  /** The packet sent to the reviewer, for `api.open_packet`. */
  packetId: string | null;
  revisions: OpinionRevision[];
  cancellation: { reason: string; cancelledAt: string } | null;
  /** api.cancel_legal_review_request up to the reason typed. */
  capabilities: { mayCancel: boolean };
}

/** A package's legal review (R2, 2095): whether the rules require one now (DEC-F12), and each request of every round. */
export interface PackageLegalReview {
  required: boolean;
  requests: PackageLegalReviewRequest[];
}

/** The rule in force for an adopted item type, as a submission would snapshot it now (DEC-F13). */
export interface PackageAuthorityRule {
  itemType: RecommendationItemType;
  ruleId: string | null;
  authorityTypes: AuthorityType[];
  sourceStatus: AuthorityRuleSourceStatus | null;
  coverage: AuthorityRuleCoverage;
  /** The FINAL_DISCIPLINARY_AUTHORITY setting is SOURCE_REQUIRED or names another authority. */
  settingDisagreement: boolean;
}

/** A round submitted to the authority, with the package as submitted (DEC-19) and what it requires of whom. */
export interface AuthoritySubmissionView {
  submissionId: string;
  packageRound: number;
  /** The package as submitted, for `api.open_packet`. */
  packetId: string | null;
  basis: SubmissionBasis;
  submittedAt: string;
  requirements: {
    itemId: string;
    authorityType: AuthorityType;
    ruleSourceStatus: AuthorityRuleSourceStatus;
  }[];
}

/** An authority's decision as recorded from its source documents (N15). */
export interface AuthorityDecisionView {
  decisionId: string;
  packageRound: number;
  authorityType: AuthorityType;
  outcome: AuthorityOutcome;
  decidedAt: string;
  decidedByLabel: string;
  recordedAt: string;
  reason: string | null;
  delegationReference: string | null;
  sourceSignature: SourceSignature | null;
  unsignedAttestation: string | null;
  sources: { position: number; reference: string; isPrimary: boolean }[];
  scope: { itemId: string; itemOutcome: AuthorityItemOutcome; modification: string | null }[];
  conditions: {
    position: number;
    kind: AuthorityConditionKind;
    itemId: string | null;
    text: string;
    dueDate: string | null;
  }[];
  /** Once a re-decision replaced it (DEC-AMB-013): kept read-only and marked SUPERSEDED. */
  superseded: { supersededBy: string; supersededAt: string } | null;
}

/** An authority still to decide in the package's current round, with its items. */
export interface AuthorityToDecide {
  authorityType: AuthorityType;
  itemIds: string[];
  /** Whether its decision would be the round's last. */
  completesRound: boolean;
}

/** A package's authority half (R2, 2095). */
export interface PackageAuthority {
  rules: PackageAuthorityRule[];
  submissions: AuthoritySubmissionView[];
  decisions: AuthorityDecisionView[];
  /** While the package is with the authority; empty otherwise. */
  toDecide: AuthorityToDecide[];
}

/** What recording the round's last decision would supersede under a conflict remediation (counts only, ruling 3). */
export interface RecordSupersedes {
  decisions: number;
  correctiveActions: number;
}

// ---- api.open_packet --------------------------------------------------------------------------------------------
/** A person concerned as the packet stored them: the name snapshotted when the packet was made. */
export interface PacketSubject {
  subjectId: string;
  label: string | null;
  category: SubjectCategory;
}

/** An adopted item as the packet stored it (`decision.item_snapshot` and its 2030 extra; for the authority, its rule). */
export interface PacketRecommendationItem {
  kind: "RECOMMENDATION_ITEM";
  position: number;
  sourceId: string;
  itemType: RecommendationItemType;
  sanctionCode: string | null;
  proposedSanctionText: string | null;
  verificationStatus: SanctionVerificationStatus;
  description: string;
  caseWide: boolean;
  committeeResult: "APPROVED" | "REJECTED" | null;
  subjects: PacketSubject[];
  allegations: { allegationId: string; category: string }[];
  requiresLegalJustification: boolean;
  exclusivityGroup: string | null;
  dependsOn: string[];
  /** In a packet for the authority: the authorities its rule required at submission, and the rule's source status. */
  requiredAuthorities: AuthorityType[];
  authorityRuleSourceStatus: AuthorityRuleSourceStatus | null;
}

/** A finding the secretary sent with a legal review, as recorded then. */
export interface PacketFinding {
  kind: "FINDING";
  position: number;
  sourceId: string;
  result: FindingResult;
  rationale: string;
  versionNo: number;
  allegationId: string;
  allegationCategory: string;
  subjectId: string | null;
}

/** Approved minutes the secretary sent with a legal review: the narrative and each vote's result and counts. */
export interface PacketMinutes {
  kind: "MINUTES";
  position: number;
  sourceId: string;
  versionNo: number;
  status: string;
  narrative: string;
  voteItems: {
    sequenceNo: number;
    targetType: string;
    title: string;
    result: string | null;
    decidedByCastingVote: boolean;
    approve: number;
    reject: number;
    abstain: number;
  }[];
}

/** A legal opinion the authority's packet carries: every opinion given on the package, superseded ones marked. */
export interface PacketOpinion {
  kind: "LEGAL_OPINION";
  position: number;
  sourceId: string;
  opinion: LegalOpinion;
  opinionText: string | null;
  packageRound: number;
  revisionNo: number;
  /** A later opinion on the same request replaced this one. */
  superseded: boolean;
}

export type PacketItem = PacketRecommendationItem | PacketFinding | PacketMinutes | PacketOpinion;

/** `api.open_packet`: the packet's stored content, read once per call and recorded (PACKET_VIEWED). */
export interface PacketView {
  packetId: string;
  purpose: PacketPurpose;
  classification: string;
  createdAt: string;
  items: PacketItem[];
}
