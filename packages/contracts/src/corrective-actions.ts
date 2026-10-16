/**
 * Corrective actions under a superseded decision (UX redesign Phase 12, slice P12-3b; ADR-058, migration 2096):
 * camel-case copies of `api.case_corrective_actions` (A1, a case's actions for whoever may see the case) and
 * `api.corrective_action_view` (A2, one action; its `origin` for the case team only, and while the action is frozen,
 * what a disposition is checked against). DEC-AMB-014: the replacement authority decision disposes of each action the
 * superseded decision governed, which is FROZEN_BY_SUPERSEDED_DECISION until then. Every capability is its command's
 * own answer for the caller now (UX-116), and the command checks again. Types and literal lists only.
 */
import type { CorrectiveActionStatus, CorrectiveActionType } from "./index";
import type { AccountName } from "./legal-reviews";

/** Why an action may not move (`decision.action_block`): DEC-AMB-013's two while a conflict is open, DEC-AMB-014's three. */
export const ACTION_BLOCKS = [
  "TAINTED_BY_CONFLICT",
  "CONFLICT_REMEDIATION_OPEN",
  "FROZEN_BY_SUPERSEDED_DECISION",
  "WAIVED_BY_SUPERSEDING_DECISION",
  "REPLACED_BY_NEW_ACTION",
] as const;
export type ActionBlock = (typeof ACTION_BLOCKS)[number];
/** What the replacement decision decides of a frozen action (DEC-AMB-014, option A). */
export const ACTION_DISPOSITIONS = ["RE_ADOPT", "MODIFY", "WAIVE", "REPLACE_WITH_NEW_ACTION"] as const;
export type ActionDisposition = (typeof ACTION_DISPOSITIONS)[number];
/**
 * The dispositions that give the action new wording (a title and a description) and may set a due date: without one,
 * MODIFY keeps the action's own and a replacement takes the policy's default. RE_ADOPT and WAIVE take neither.
 */
export const REWORDING_DISPOSITIONS: readonly ActionDisposition[] = ["MODIFY", "REPLACE_WITH_NEW_ACTION"];
/** Who answers for an action (DEC-F28, migration 2040). */
export const ACTION_OWNER_KINDS = ["USER", "ORG_UNIT", "SHARED_POOL", "EXTERNAL_PARTY"] as const;
export type ActionOwnerKind = (typeof ACTION_OWNER_KINDS)[number];
/** Where an action comes from (DEC-F41, migration 2070): a package item and its decision, or a preliminary proposal. */
export const ACTION_SOURCES = ["AUTHORITY_DECISION", "PRELIMINARY_REVIEW"] as const;
export type ActionSource = (typeof ACTION_SOURCES)[number];

/** The action's owner as both reads give it; a pool by code and name only (R3). */
export interface ActionOwner {
  kind: ActionOwnerKind;
  accountableUserId: string | null;
  sector: { sectorId: string; code: string; nameEn: string; nameAr: string } | null;
  pool: { code: string; name: string } | null;
  externalPartyLabel: string | null;
}

/** One action of the case (A1), for whoever may see the case. Codes and ids; the read is not audited. */
export interface CaseCorrectiveAction {
  actionId: string;
  actionType: CorrectiveActionType;
  sequenceNo: number;
  title: string;
  status: CorrectiveActionStatus;
  /** Calendar date in Riyadh, YYYY-MM-DD. */
  dueDate: string;
  percentComplete: number;
  versionNo: number;
  owner: ActionOwner & { displayName: string | null; displayNameAr: string | null };
  source: ActionSource;
  recommendationItemId: string | null;
  preliminaryProposalId: string | null;
  authorityDecisionId: string | null;
  /** The decision the action executes now: the replacement once it was re-adopted or modified. */
  governingDecisionId: string | null;
  decisionBlock: ActionBlock | null;
  /** When the decision it executes was superseded (DEC-AMB-013), or null. */
  supersededAt: string | null;
  replacedByActionId: string | null;
  replacesActionId: string | null;
  /** api.dispose_superseded_corrective_action, as the view answers it. */
  mayDispose: boolean;
}

/** A wording of the action: the one it carries and every earlier one, never edited in place. */
export interface ActionVersion {
  versionNo: number;
  title: string;
  description: string;
  recordedBy: string;
  recordedAt: string;
}

/** A replacement decision's disposition of the action, without its reason (which stays with the record). */
export interface ActionDispositionRecord {
  dispositionId: string;
  disposition: ActionDisposition;
  supersededDecisionId: string;
  replacementDecisionId: string;
  priorStatus: CorrectiveActionStatus;
  sourceDocumentReference: string;
  revisedVersionNo: number | null;
  replacementActionId: string | null;
  recordedBy: string;
  recordedAt: string;
}

/**
 * While the action is frozen: what api.dispose_superseded_corrective_action checks a disposition against. The owners a
 * replacement may name are every active holder of CORRECTIVE_ACTION_OWN, on the seat basis and never filtered by the
 * case gate (DEC-F19; the command answers INVALID at submit), and only for whoever may dispose and name one.
 */
export interface ActionReplacement {
  decisionId: string;
  /** The replacement decision's source documents; a disposition cites one of them. */
  sources: { position: number; reference: string; isPrimary: boolean }[];
  /** decision.require_owner_naming: on a restricted case, its owner as its authority only. */
  mayNameOwner: boolean;
  ownerCandidates: AccountName[];
  /** The policy's default for a replacement given no due date, or null where the policy sets none. */
  defaultDueDate: string | null;
}

/** Where the action comes from and why it may not move: the case team only. */
export interface ActionOrigin {
  recommendationItemId: string | null;
  authorityDecisionId: string | null;
  source: ActionSource;
  preliminaryProposalId: string | null;
  governingDecisionId: string | null;
  decisionBlock: ActionBlock | null;
  dispositions: ActionDispositionRecord[];
  /** What a disposition may be now, as the command checks it; empty unless the action is frozen. */
  dispositionOptions: ActionDisposition[];
  replacement: ActionReplacement | null;
}

export interface CorrectiveActionCapabilities {
  mayRecordProgress: boolean;
  maySubmitCompletion: boolean;
  mayVerify: boolean;
  mayReopen: boolean;
  mayWaive: boolean;
  mayDispose: boolean;
  mayChangeDueDate: boolean;
  mayAssignOwner: boolean;
  maySetOwnerKind: boolean;
  maySetSharedOwnerKind: boolean;
}

/** One corrective action (A2): the card for whoever may see it, `origin` for the case team only. */
export interface CorrectiveActionView {
  actionId: string;
  actionType: CorrectiveActionType;
  sequenceNo: number;
  title: string;
  description: string;
  status: CorrectiveActionStatus;
  dueDate: string;
  percentComplete: number;
  createdAt: string;
  completionSubmittedAt: string | null;
  completedAt: string | null;
  waivedAt: string | null;
  updatedAt: string;
  versionNo: number;
  versions: ActionVersion[];
  owner: ActionOwner;
  origin: ActionOrigin | null;
  /** The case, under case-metadata visibility only. */
  case: { caseId: string | null; caseNumber: string | null };
  capabilities: CorrectiveActionCapabilities;
}
