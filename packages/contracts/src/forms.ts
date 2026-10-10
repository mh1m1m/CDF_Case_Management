/**
 * Forms engine contracts (Phase 8, CDF-50; ADR-011): the 19 WB-FRM definitions as data, case form
 * instances with immutable versions and a prepared → reviewed → approved lifecycle. Types only.
 */
import type { Classification, Role } from "./index";

export const FORM_FIELD_TYPES = ["text", "textarea", "date", "select", "boolean", "number"] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

export const FORM_STATUSES = ["DRAFT", "PREPARED", "REVIEWED", "APPROVED", "WITHDRAWN"] as const;
export type FormStatus = (typeof FORM_STATUSES)[number];

export const FORM_EVENT_TYPES = [
  "CREATED",
  "SAVED",
  "PREPARED",
  "REVIEWED",
  "RETURNED",
  "APPROVED",
  "WITHDRAWN",
] as const;
export type FormEventType = (typeof FORM_EVENT_TYPES)[number];

export const FORM_ENTITLEMENT_ACTIONS = ["VIEW", "PREPARE", "REVIEW", "APPROVE"] as const;
export type FormEntitlementAction = (typeof FORM_ENTITLEMENT_ACTIONS)[number];

export const FORM_OWNER_HINTS = ["COMPLIANCE_INTAKE", "INVESTIGATOR", "COMMITTEE_SECRETARY"] as const;
export type FormOwnerHint = (typeof FORM_OWNER_HINTS)[number];

export const FORM_REVIEW_OUTCOMES = ["REVIEWED", "RETURNED"] as const;
export type FormReviewOutcome = (typeof FORM_REVIEW_OUTCOMES)[number];
export const FORM_APPROVAL_OUTCOMES = ["APPROVED", "RETURNED"] as const;
export type FormApprovalOutcome = (typeof FORM_APPROVAL_OUTCOMES)[number];

/** Field value limits enforced by the browser hint, @cdf/domain and forms.validate_data alike. */
export const FORM_TEXT_MAX = 500;
export const FORM_TEXTAREA_MAX = 4000;
export const FORM_DATA_MAX_BYTES = 262_144;

export interface FormFieldOption {
  /** Stored value (the baseline's Arabic option text). */
  value: string;
  labelAr: string;
  labelEn: string;
}

export interface FormFieldDefinition {
  /** Position within the form, 1-based. */
  no: number;
  /** Data key: ^[a-z][a-z0-9_]{1,63}$ */
  name: string;
  labelAr: string;
  labelEn: string;
  type: FormFieldType;
  required: boolean;
  options: FormFieldOption[];
  helpAr: string | null;
  helpEn: string | null;
  sensitive: boolean;
}

export interface FormSectionDefinition {
  no: number;
  titleAr: string;
  titleEn: string;
  fields: FormFieldDefinition[];
}

export interface FormDefinition {
  code: string;
  sequenceNo: number;
  nameAr: string;
  nameEn: string;
  purposeAr: string;
  purposeEn: string;
  ownerRoleHint: FormOwnerHint;
  sourceReference: string;
  reviewRequired: boolean;
  approvalRequired: boolean;
  repeatable: boolean;
  /** sha256 of the canonical JSON of `sections`; part of every instance content hash. */
  schemaHash: string;
  sections: FormSectionDefinition[];
}

export interface FormEntitlement {
  formCode: string;
  roleCode: Role;
  action: FormEntitlementAction;
  source: "BASELINE" | "DERIVED" | "SOURCE_REQUIRED";
}

/** Field name → value in lexical form (dates YYYY-MM-DD, booleans "true"/"false", numbers as decimal text). */
export type FormData = Record<string, string>;

/** A definition as listed for one case, with the caller's right to start it (mirrors authz.can_prepare_form). */
export interface FormDefinitionListItem {
  code: string;
  sequenceNo: number;
  nameAr: string;
  nameEn: string;
  purposeAr: string;
  purposeEn: string;
  ownerRoleHint: FormOwnerHint;
  reviewRequired: boolean;
  approvalRequired: boolean;
  isEnabled: boolean;
  versionNo: number;
  canStart: boolean;
}

export interface FormInstanceSummary {
  id: string;
  caseId: string;
  caseNumber: string;
  formCode: string;
  formNameAr: string;
  formNameEn: string;
  instanceNo: number;
  status: FormStatus;
  classification: Classification;
  currentVersionNo: number | null;
  contentHash: string | null;
  createdBy: string;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FormInstanceVersionInfo {
  id: string;
  versionNo: number;
  contentHash: string;
  savedBy: string;
  savedByName: string | null;
  savedAt: string;
}

export interface FormEventInfo {
  id: string;
  eventType: FormEventType;
  fromStatus: FormStatus | null;
  toStatus: FormStatus;
  versionNo: number | null;
  actorId: string;
  actorName: string | null;
  occurredAt: string;
  reason: string | null;
}

/** What the database would allow the caller to do now (hidden ≠ forbidden: commands re-check). */
export interface FormInstanceCapabilities {
  canSave: boolean;
  canPrepare: boolean;
  canReview: boolean;
  canApprove: boolean;
  canWithdraw: boolean;
}

export interface FormInstanceDetail extends FormInstanceSummary {
  definition: {
    code: string;
    nameAr: string;
    nameEn: string;
    purposeAr: string;
    purposeEn: string;
    reviewRequired: boolean;
    approvalRequired: boolean;
    versionNo: number;
    schemaHash: string;
    sections: FormSectionDefinition[];
  };
  /** The current version's data (empty object before the first save). */
  data: FormData;
  /** The status that completes this form: APPROVED, REVIEWED or PREPARED depending on the definition. */
  finalStatus: FormStatus;
  preparedBy: string | null;
  preparedByName: string | null;
  preparedAt: string | null;
  preparedVersionNo: number | null;
  reviewedBy: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
  approvedBy: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  withdrawnBy: string | null;
  withdrawnByName: string | null;
  withdrawnAt: string | null;
  versions: FormInstanceVersionInfo[];
  events: FormEventInfo[];
  capabilities: FormInstanceCapabilities;
}
