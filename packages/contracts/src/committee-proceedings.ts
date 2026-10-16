/**
 * The proceeding before the committee and the meeting's invite list (UX redesign Phase 12, slice P12-2c; ADR-056,
 * migrations 2060 and 2086): camel-case copies of `api.committee_items_view` (read model R2, with 2086's
 * capabilities), `api.committee_scope_choices` (R1), `api.recommendation_item_flags`, `decision.sanction_catalogue_entry`
 * and `api.meeting_invite_choices`. A subject or a case person is a position and a category, named only in DISPLAY_NAME
 * mode (the DEC-02 label card; ORDINAL until the owner answers it). Every capability is its command's own answer for the
 * caller now (UX-116), and the command checks again. Types and literal lists only.
 */
import type {
  CommitteeKind,
  CommitteeProceedingSummary,
  CommitteeSeat,
  FindingResult,
  MeetingInviteeRole,
  RecommendationItemType,
  RecommendationPackageStatus,
  SanctionVerificationStatus,
  SubjectCategory,
  VoteItemStatus,
} from "./index";

/** How a package is put to the vote (`api.create_recommendation_package`): one vote, or one per item. */
export const VOTE_GRANULARITIES = ["PACKAGE", "ITEM"] as const;
export type VoteGranularity = (typeof VOTE_GRANULARITIES)[number];
/** How the read models label a subject (`decision.committee_label_policy`, 2060). */
export const COMMITTEE_LABEL_MODES = ["ORDINAL", "DISPLAY_NAME"] as const;
export type CommitteeLabelMode = (typeof COMMITTEE_LABEL_MODES)[number];
/** What the committee records on a conflict taint (`api.resolve_conflict_taint`, DEC-AMB-003, DEC-AMB-013). */
export const TAINT_RESOLUTIONS = ["RE_VOTE", "CONFIRM"] as const;
export type TaintResolution = (typeof TAINT_RESOLUTIONS)[number];
/** An item's result once the adoption is recorded. */
export const COMMITTEE_ITEM_RESULTS = ["APPROVED", "REJECTED"] as const;
export type CommitteeItemResult = (typeof COMMITTEE_ITEM_RESULTS)[number];
/** What `api.recommendation_item_flags` says about an active item (2030). */
export const RECOMMENDATION_ITEM_FLAGS = [
  "PROPOSED_UNVERIFIED",
  "SANCTION_SOURCE_REQUIRED",
  "TAINTED_BY_CONFLICT",
  "CONFLICT_REMEDIATION",
  "DEPENDENCY_NOT_APPROVED",
  "EXCLUSIVITY_CONFLICT",
] as const;
export type RecommendationItemFlag = (typeof RECOMMENDATION_ITEM_FLAGS)[number];
/** Where a finding was recorded, seen from the committee proceeding. */
export const FINDING_PROCEEDING_ROLES = ["COMMITTEE", "REFERRED", "OTHER"] as const;
export type FindingProceedingRole = (typeof FINDING_PROCEEDING_ROLES)[number];
export const ALLEGATION_STATUSES = ["OPEN", "SUBSTANTIATED", "UNSUBSTANTIATED", "WITHDRAWN"] as const;
export type AllegationStatus = (typeof ALLEGATION_STATUSES)[number];
/** A case person's part in the case (`case_mgmt.case_person.role`). */
export const CASE_PERSON_ROLES = ["SUBJECT", "WITNESS", "AFFECTED_PARTY", "OTHER"] as const;
export type CasePersonRole = (typeof CASE_PERSON_ROLES)[number];
/** Why an account is on the invite list (coordinator, 2026-10-15 00:23): never a directory. */
export const INVITE_BASES = ["CASE_TEAM", "LEGAL_REVIEW"] as const;
export type InviteBasis = (typeof INVITE_BASES)[number];

/** A subject as the read models show it: its position among the case's subjects and its category; a name only in DISPLAY_NAME mode. */
export interface SubjectRef {
  subjectId: string;
  position: number;
  subjectCategory: SubjectCategory;
  label: string | null;
}

/** An active item of a package (R2). */
export interface PackageItemView {
  itemId: string;
  itemType: RecommendationItemType;
  sanctionCode: string | null;
  /** A sanction proposed outside the catalogue (Q87): flagged everywhere as unverified. */
  proposedSanctionText: string | null;
  verificationStatus: SanctionVerificationStatus;
  /** What the secretary wrote; in ITEM granularity it opens the item's vote title, which members and the minutes see. */
  description: string;
  /** No subject and no allegation: the whole case (Q89). */
  caseWide: boolean;
  committeeResult: CommitteeItemResult | null;
  requiresLegalJustification: boolean;
  exclusivityGroup: string | null;
  /** Active items of the same package this one depends on (AMB-100). */
  dependsOn: string[];
  subjects: SubjectRef[];
  allegations: { allegationId: string; category: string }[];
  /** `api.recommendation_item_flags`, for whoever reads the package. */
  flags: RecommendationItemFlag[];
  /** The resolutions `api.resolve_conflict_taint` would accept now; empty for anyone else. */
  taintResolutions: TaintResolution[];
  capabilities: { mayWithdraw: boolean };
}

export interface RecommendationPackageView {
  packageId: string;
  sequenceNo: number;
  status: RecommendationPackageStatus;
  roundNo: number;
  voteGranularity: VoteGranularity;
  items: PackageItemView[];
  /** The meetings where `api.open_package_vote` would accept the package now, in meeting order; empty for anyone else. */
  openVoteIn: string[];
  capabilities: {
    mayAddItem: boolean;
    maySubmitForVote: boolean;
    mayRecordAdoption: boolean;
    mayReturnToCommittee: boolean;
  };
}

/** A vote on a finding in a meeting of the proceeding that the caller may deliberate in (R2). */
export interface FindingVoteView {
  voteItemId: string;
  meetingId: string;
  sequenceNo: number;
  status: VoteItemStatus;
  finding: {
    findingId: string;
    versionNo: number;
    /** False once a later version of the finding is recorded. */
    isCurrentVersion: boolean;
    result: FindingResult;
    proceedingRole: FindingProceedingRole;
    allegation: { allegationId: string; category: string };
    subject: SubjectRef | null;
  };
}

/** `api.committee_items_view` (R2): the packages and finding votes of one proceeding before the committee. */
export interface CommitteeItemsView {
  committeeProceedingId: string;
  labelMode: CommitteeLabelMode;
  capabilities: { mayCreatePackage: boolean };
  packages: RecommendationPackageView[];
  findingVotes: FindingVoteView[];
}

/** An allegation the secretary may name on an item: its position among the case's allegations and its category. */
export interface AllegationChoice {
  allegationId: string;
  position: number;
  category: string;
  status: AllegationStatus;
  subjectId: string | null;
}

/** A finding the committee may act on: the current version, recorded in the committee proceeding or the one it was referred from. */
export interface FindingChoice {
  findingId: string;
  allegationId: string;
  subjectId: string | null;
  proceedingRole: Exclude<FindingProceedingRole, "OTHER">;
  versionNo: number;
  result: FindingResult;
  recordedAt: string;
}

/** `api.committee_scope_choices` (R1): what the committee's secretary may choose from. Never narrative or the case. */
export interface CommitteeScopeChoices {
  committeeProceedingId: string;
  labelMode: CommitteeLabelMode;
  subjects: SubjectRef[];
  allegations: AllegationChoice[];
  findings: FindingChoice[];
}

/** An active sanction code with the catalogue version in force (`decision.sanction_catalogue_entry`, DEC-F11). */
export interface SanctionCatalogueChoice {
  code: string;
  /** Null when no version is in force: adoption then refuses the code (SANCTION_NOT_IN_FORCE). */
  versionNo: number | null;
  /** SOURCE_REQUIRED until the basis is approved; never shown as policy. */
  sourceStatus: "SOURCE_REQUIRED" | "APPROVED";
  subjectCategories: SubjectCategory[];
}

/**
 * The proceeding page: the proceeding as the caller's seat gives it (`api.committee_view`), its packages and finding
 * votes (R2) and, for whoever builds packages now, the choices (R1) and the catalogue.
 */
export interface CommitteeProceedingPage {
  committee: { committeeId: string; code: string; kind: CommitteeKind };
  mySeat: CommitteeSeat;
  proceeding: CommitteeProceedingSummary;
  /** Null when R2 does not show the caller the proceeding's packages (a conflict they declared in one of its meetings). */
  items: CommitteeItemsView | null;
  /** Null unless the caller may create a package or add an item now. */
  scope: CommitteeScopeChoices | null;
  /** Empty unless the caller may add an item now. */
  catalogue: SanctionCatalogueChoice[];
}

/** A case person the runner may invite, as the person (the secretary's path, ADR-054 §5): no name in ORDINAL mode. */
export interface InvitePersonChoice {
  personId: string;
  /** Position among the case's persons. */
  position: number;
  caseRoles: CasePersonRole[];
  label: string | null;
  inviteeRoles: MeetingInviteeRole[];
}

/** An account on the ruled bases only: the case team's active assignments and the proceeding's legal reviewers. */
export interface InviteAccountChoice {
  userId: string;
  displayName: string | null;
  displayNameAr: string | null;
  bases: InviteBasis[];
  inviteeRoles: MeetingInviteeRole[];
}

/** `api.meeting_invite_choices`: the runner's candidates for one meeting, never a directory. */
export interface MeetingInviteChoices {
  meetingId: string;
  labelMode: CommitteeLabelMode;
  persons: InvitePersonChoice[];
  accounts: InviteAccountChoice[];
}
