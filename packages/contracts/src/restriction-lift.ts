// Lifting a case's restricted status by two-person control (migration 2130, ADR-049; DEC-AMB-012 → C): the case's
// Restricted Case Authority previews and requests, an independent second approver approves the same preview, and the
// authority lifts it. Counts and role codes only: no names, user ids or case content (§40, condition d).
import type { Classification } from "./index";

/** A request's states (`case_mgmt.restriction_lift_request.status`). PENDING and APPROVED are open. */
export const RESTRICTION_LIFT_STATUSES = [
  "PENDING",
  "APPROVED",
  "REJECTED",
  "LIFTED",
  "EXPIRED",
  "WITHDRAWN",
] as const;
export type RestrictionLiftStatus = (typeof RESTRICTION_LIFT_STATUSES)[number];

/** What the second approver decides (`api.decide_restriction_lift`). */
export const RESTRICTION_LIFT_DECISIONS = ["APPROVE", "REJECT"] as const;
export type RestrictionLiftDecision = (typeof RESTRICTION_LIFT_DECISIONS)[number];

/** The gates the restriction closes, in the preview's fixed order (the Grievance Committee's secretaries last). */
export const RESTRICTION_LIFT_GATES = [
  "CASE_VIEW_ALL",
  "BREAK_GLASS_REQUEST",
  "ARCHIVE_RECORD_VIEW",
  "PRELIMINARY_APPROVE",
  "LEGAL_HOLD_REQUEST",
  "GRIEVANCE_COMMITTEE_SECRETARY",
] as const;
export type RestrictionLiftGate = (typeof RESTRICTION_LIFT_GATES)[number];

/** The authority's approvals that stop applying once the case is not restricted. */
export const RESTRICTION_LIFT_AUTHORITY_APPROVALS = [
  "EXPORT_CONSENT",
  "DEFENCE_PACKET_RELEASE",
  "LEGAL_REVIEW",
  "COMMITTEE_REFERRAL",
  "GRIEVANCE_HANDLING",
  "GRIEVANCE_RECORDING",
  "SANCTION_EXTRACT",
] as const;
export type RestrictionLiftAuthorityApproval = (typeof RESTRICTION_LIFT_AUTHORITY_APPROVALS)[number];

/** Why the authority may not request now (`request_refusal`; the command raises the same code). */
export const RESTRICTION_LIFT_REQUEST_REFUSALS = [
  "FORBIDDEN",
  "CASE_NOT_RESTRICTED",
  "RECORDS_READ_ONLY",
  "LIFT_APPROVER_NOT_CONFIGURED",
  "LIFT_WINDOW_MISCONFIGURED",
  "RESTRICTED_APPROVALS_PENDING",
  "LIFT_ALREADY_REQUESTED",
  "NO_ELIGIBLE_APPROVER",
] as const;
/** Why an approver may not approve now (`approve_refusal`, after the decide checks pass). */
export const RESTRICTION_LIFT_APPROVE_REFUSALS = [
  "CASE_NOT_RESTRICTED",
  "LIFT_WINDOW_MISCONFIGURED",
  "RESTRICTED_APPROVALS_PENDING",
  "PREVIEW_CHANGED",
] as const;
/** Why the authority may not lift now (`lift_refusal`; the command raises the same code). */
export const RESTRICTION_LIFT_LIFT_REFUSALS = [
  "FORBIDDEN",
  "APPROVAL_CONSUMED",
  "NOT_APPROVED",
  "APPROVAL_LAPSED",
  "CASE_NOT_RESTRICTED",
  "RECORDS_READ_ONLY",
  "APPROVER_NOT_ELIGIBLE",
  "RESTRICTED_APPROVALS_PENDING",
  "PREVIEW_CHANGED",
] as const;
export type RestrictionLiftRequestRefusal = (typeof RESTRICTION_LIFT_REQUEST_REFUSALS)[number];
export type RestrictionLiftApproveRefusal = (typeof RESTRICTION_LIFT_APPROVE_REFUSALS)[number];
export type RestrictionLiftLiftRefusal = (typeof RESTRICTION_LIFT_LIFT_REFUSALS)[number];

/** Who would gain access through one gate, by the role code that gives it ("NONE": a secretary seat alone). */
export interface RestrictionLiftGatePreview {
  gate: RestrictionLiftGate;
  users: number;
  roles: { role: string; users: number }[];
}

/** What lifting would open: counts and role codes per gate, and the distinct total. */
export interface RestrictionLiftPreview {
  classification: Classification;
  gates: RestrictionLiftGatePreview[];
  usersGaining: number;
  authorityApprovalsEnding: RestrictionLiftAuthorityApproval[];
}

/** `api.preview_restriction_lift`: the preview and the hash the request (and the approval) must carry. */
export interface RestrictionLiftPreviewResult {
  preview: RestrictionLiftPreview;
  previewHash: string;
}

/** The case's open request, else its latest, as the case's authority sees it. Reasons only on their own request. */
export interface RestrictionLiftRequestView {
  id: string;
  status: RestrictionLiftStatus;
  classification: Classification;
  mine: boolean;
  reason: string | null;
  requestedAt: string;
  expiresAt: string;
  preview: RestrictionLiftPreview;
  previewHash: string;
  decidedAt: string | null;
  decisionReason: string | null;
  approvalPreviewHash: string | null;
  approvalExpiresAt: string | null;
  liftedAt: string | null;
  endedAt: string | null;
  lapsed: boolean;
  capabilities: { mayLift: boolean; mayWithdraw: boolean; mayExpire: boolean };
  liftRefusal: RestrictionLiftLiftRefusal | null;
}

/** `api.restriction_lift_status`: for the case's Restricted Case Authority only (FORBIDDEN otherwise). */
export interface RestrictionLiftStatusView {
  caseId: string;
  isRestricted: boolean;
  /** The configured second approver's role in force, or null (SOURCE_REQUIRED: no request can be made). */
  approverRole: string | null;
  capabilities: { mayPreview: boolean; mayRequest: boolean };
  requestRefusal: RestrictionLiftRequestRefusal | null;
  request: RestrictionLiftRequestView | null;
}

/** One row of `api.my_restriction_lift_approvals`: no case id and no case number (DEC-22). */
export interface RestrictionLiftApproval {
  id: string;
  status: Extract<RestrictionLiftStatus, "PENDING" | "APPROVED">;
  classification: Classification;
  reason: string;
  requestedAt: string;
  expiresAt: string;
  /** The preview the decision is on (the approval's own snapshot once approved). */
  preview: RestrictionLiftPreview;
  previewHash: string;
  decidedByMe: boolean;
  approvalExpiresAt: string | null;
  lapsed: boolean;
  capabilities: { mayDecide: boolean; mayExpire: boolean };
  approveRefusal: RestrictionLiftApproveRefusal | null;
}
