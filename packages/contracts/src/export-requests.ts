/**
 * Export requests (UX redesign Phase 12, slice P12-6b-1; ADR-026, migration 1930, owner decisions in 2040): a camel-case
 * copy of `api.export_request_view` (2040), the purpose read of one export request, and of the reference rows the page
 * reads with it. The view never returns the storage key or the document: the content comes only from the audited
 * preview. Every capability is its command's own answer for the caller now (UX-116), and the command checks again.
 * Types and literal lists only.
 */
import type {
  Classification,
  ExportAudience,
  ExportFormat,
  ExportObjectType,
  ExportRuleAction,
  ExportStatus,
} from "./index";
import type { AccountName } from "./legal-reviews";

export const EXPORT_RECIPIENT_KINDS = ["INTERNAL", "EXTERNAL"] as const;
export type ExportRecipientKind = (typeof EXPORT_RECIPIENT_KINDS)[number];
/** What an approval stage or the case's authority decided (exchange.export_approval, restricted_export_approval). */
export const EXPORT_APPROVAL_OUTCOMES = ["APPROVED", "REJECTED"] as const;
export type ExportApprovalOutcome = (typeof EXPORT_APPROVAL_OUTCOMES)[number];
/** Where a governed export rule or purpose comes from (exchange.approval_rule, exchange.export_purpose). */
export const EXPORT_SOURCE_STATUSES = ["OWNER_DEFAULT", "SOURCE_REQUIRED", "APPROVED"] as const;
export type ExportSourceStatus = (typeof EXPORT_SOURCE_STATUSES)[number];
/** CDF-208: why a submitted export of a restricted case waits for its authority. */
export const EXPORT_AUTHORITY_BLOCKS = ["REQUESTER_IS_CASE_AUTHORITY"] as const;
export type ExportAuthorityBlock = (typeof EXPORT_AUTHORITY_BLOCKS)[number];
/** Where a config.setting value stands. */
export const SETTING_STATUSES = ["SOURCE_REQUIRED", "CONFIGURED"] as const;
export type SettingStatus = (typeof SETTING_STATUSES)[number];

/** One item of the export. `included` is whether the caller may see it now (N16): a withheld item keeps its place. */
export interface ExportItemView {
  itemId: string;
  position: number;
  objectType: ExportObjectType;
  objectId: string;
  addedBy: string;
  addedAt: string;
  included: boolean;
}

/** One recipient of an EMAIL export: an internal account by id, or an external address (AMB-187: shown exactly). */
export interface ExportRecipientView {
  recipientId: string;
  kind: ExportRecipientKind;
  userId: string | null;
  email: string | null;
  addedBy: string;
  addedAt: string;
}

/** One approval stage as decided. */
export interface ExportApprovalView {
  approvalId: string;
  stage: number;
  approverId: string;
  decision: ExportApprovalOutcome;
  reason: string;
  decidedAt: string;
}

/** The restricted case's authority's consent or refusal (DEC-F23), apart from the approval stages. */
export interface ExportAuthorityDecisionView {
  decidedBy: string;
  decision: ExportApprovalOutcome;
  reason: string;
  decidedAt: string;
}

/** The export as it stands now, computed for the caller: the document's hash and what it needs. */
export interface ExportCurrentState {
  hash: string;
  /** Items the caller may not see now; nothing is submitted, approved or generated while any is withheld. */
  withheld: number;
  refusedByRule: boolean;
  approvalsRequired: number;
  authorityApprovalRequired: boolean;
  /** The stage that waits for a decision, while the export is SUBMITTED and a stage is still to give. */
  nextStage: number | null;
  /** CDF-208, a staffing fact: the case's authority asked for this export and cannot consent to it. */
  authorityConsentBlocked: ExportAuthorityBlock | null;
}

/** Each flag is its command's own answer for the caller now (2040:4953-4989). */
export interface ExportCapabilities {
  mayAddItem: boolean;
  mayAddRecipient: boolean;
  mayPreview: boolean;
  maySubmit: boolean;
  mayApprove: boolean;
  mayReject: boolean;
  mayAuthorityApprove: boolean;
  mayAuthorityReject: boolean;
  mayGenerate: boolean;
  mayRecordSent: boolean;
  mayCancel: boolean;
}

/** `api.export_request_view`: NOT_FOUND unless `authz.can_view_export`. */
export interface ExportRequestView {
  requestId: string;
  status: ExportStatus;
  format: ExportFormat;
  audience: ExportAudience;
  /** A code of the governed purpose catalogue (DEC-F21); a request made before 2040 may carry a legacy one. */
  purpose: string;
  externalParty: string | null;
  justification: string | null;
  classificationAtSubmit: Classification | null;
  /** Fixed at submission; null for a draft. */
  approvalsRequired: number | null;
  authorityApprovalRequired: boolean;
  /** The rule codes matched at submission. */
  matchedRules: string[];
  previewHash: string | null;
  previewedAt: string | null;
  submittedHash: string | null;
  requestedBy: string;
  createdAt: string;
  submittedAt: string | null;
  decidedAt: string | null;
  generatedAt: string | null;
  sentAt: string | null;
  cancelledAt: string | null;
  updatedAt: string;
  rowVersion: number;
  current: ExportCurrentState;
  items: ExportItemView[];
  recipients: ExportRecipientView[];
  approvals: ExportApprovalView[];
  authorityDecision: ExportAuthorityDecisionView | null;
  /** Under case metadata only; every viewer of an export has it (§2.1.3 of the P12-6b map). */
  caseId: string | null;
  caseNumber: string | null;
  capabilities: ExportCapabilities;
}

/** One purpose of the governed catalogue (exchange.export_purpose, DEC-F21). */
export interface ExportPurposeEntry {
  code: string;
  nameEn: string;
  nameAr: string;
  requiresJustification: boolean;
  isActive: boolean;
  isLegacy: boolean;
  sourceStatus: ExportSourceStatus;
}

/** A rule code as in force now, with where it comes from (exchange.approval_rule; every seeded rule is SOURCE_REQUIRED). */
export interface ExportRuleSourceEntry {
  code: string;
  action: ExportRuleAction;
  sourceStatus: ExportSourceStatus;
}

/** What the export's page reads, in one transaction: the view, and the reference rows that name what it shows. */
export interface ExportRequestPage {
  view: ExportRequestView;
  /** The accounts the view names, from the directory (RLS-guarded, in the caller's context). */
  people: AccountName[];
  /** The request's purpose as the catalogue names it; null if the catalogue no longer has it. */
  purpose: ExportPurposeEntry | null;
  /** The source of each rule code the page shows (matched at submission, or by the caller's preview). */
  rules: ExportRuleSourceEntry[];
  /** DEC-F22: the approved external domains are SOURCE_REQUIRED until the CDF source exists. */
  approvedDomains: SettingStatus;
}
