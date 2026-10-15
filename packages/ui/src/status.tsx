// One status registry and the three indicators (UX-136, UX-059, UX-047; audit RC-13 and §15.11).
// Pages never pick a colour for a status: they name the domain and the status code, and the registry decides.
import type {
  AllegationStatus,
  CaseTaskStatus,
  CorrectiveActionStatus,
  EvidenceStatus,
  EvidenceVersionStatus,
  FormStatus,
  FindingResult,
  InterviewStatus,
  LegalHoldRequestStatus,
  LegalReviewStatus,
  MeetingConflictConcernStatus,
  MeetingStatus,
  MinutesStatus,
  ProceedingStatus,
  RecommendationPackageStatus,
  RecordsState,
  ReportAttachmentStatus,
  ReportStatus,
  ScanStatus,
  VoteItemStatus,
} from "@cdf/contracts";
import type { ReactNode } from "react";

export type StatusTone = "info" | "success" | "warning" | "danger" | "neutral";

interface Registry {
  report: Record<ReportStatus, StatusTone>;
  form: Record<FormStatus, StatusTone>;
  interview: Record<InterviewStatus, StatusTone>;
  evidence: Record<EvidenceStatus, StatusTone>;
  evidenceVersion: Record<EvidenceVersionStatus, StatusTone>;
  attachment: Record<ReportAttachmentStatus, StatusTone>;
  scan: Record<ScanStatus, StatusTone>;
  records: Record<RecordsState, StatusTone>;
  holdRequest: Record<LegalHoldRequestStatus, StatusTone>;
  task: Record<CaseTaskStatus, StatusTone>;
  /** Whether the caller has read one of their own notifications (S4). */
  notification: Record<"UNREAD" | "READ", StatusTone>;
  /** A proceeding inside a case (ADR-017; Phase 12). */
  proceeding: Record<ProceedingStatus, StatusTone>;
  allegation: Record<AllegationStatus, StatusTone>;
  /** A finding is a decision, never a failure, so every result is neutral; the words carry it. */
  finding: Record<FindingResult, StatusTone>;
  /** A committee meeting, one of its votes, a version of its minutes and a conflict raised in it (P12-2a). */
  meeting: Record<MeetingStatus, StatusTone>;
  voteItem: Record<VoteItemStatus, StatusTone>;
  minutes: Record<MinutesStatus, StatusTone>;
  /** A raised conflict waits for its decider; the decision either way is not a failure. */
  concern: Record<MeetingConflictConcernStatus, StatusTone>;
  /** A recommendation package (P12-2c): amber while it waits on Legal, the authority or the secretary. */
  recommendationPackage: Record<RecommendationPackageStatus, StatusTone>;
  /** A request for legal review (P12-3a): amber while it waits for the opinion; an opinion is a decision, not a win. */
  legalReview: Record<LegalReviewStatus, StatusTone>;
  /** A corrective action (P12-3b): amber while its completion waits for the verifier; a waiver ends it, neutrally. */
  correctiveAction: Record<CorrectiveActionStatus, StatusTone>;
}
export type StatusDomain = keyof Registry;

/**
 * Colour budget (audit O09 §09.12): red only for a failure; amber when the item waits for someone; green for a
 * completed, positive outcome; info for work in progress; neutral for ended or inactive. A decision such as a
 * rejected hold request is not a failure, so it is neutral. Every status code of every domain has an entry
 * (the type makes a missing one a compile error), and the text label always carries the meaning (WCAG 1.4.1).
 */
export const STATUS_TONES: Registry = {
  report: {
    RECEIVED: "info",
    INFO_REQUESTED: "warning",
    ACCEPTED: "info",
    CASE_OPENED: "success",
    REFERRED_OUT: "neutral",
    CLOSED_NO_ACTION: "neutral",
    DUPLICATE: "neutral",
  },
  form: {
    DRAFT: "info",
    PREPARED: "warning",
    REVIEWED: "warning",
    APPROVED: "success",
    WITHDRAWN: "neutral",
  },
  interview: {
    PLANNED: "info",
    SCHEDULED: "info",
    CONDUCTED: "info",
    PREPARED: "warning",
    REVIEWED: "warning",
    APPROVED: "success",
    CANCELLED: "neutral",
  },
  evidence: { PENDING: "warning", AVAILABLE: "success", REJECTED: "danger" },
  evidenceVersion: { QUARANTINED: "warning", AVAILABLE: "success", REJECTED: "danger" },
  attachment: { QUARANTINED: "warning", AVAILABLE: "success", REJECTED: "danger" },
  scan: { PENDING: "warning", CLEAN: "success", INFECTED: "danger", UNSCANNED: "warning" },
  records: {
    ACTIVE: "info",
    CLOSED: "info",
    RETENTION: "info",
    ARCHIVED: "neutral",
    DISPOSITION_ELIGIBLE: "warning",
    DISPOSITION_PENDING: "warning",
    DISPOSED: "neutral",
  },
  holdRequest: { SUBMITTED: "warning", ASSIGNED: "warning", APPLIED: "success", REJECTED: "neutral" },
  task: { OPEN: "info", IN_PROGRESS: "info", COMPLETED: "success", CANCELLED: "neutral", EXPIRED: "warning" },
  notification: { UNREAD: "info", READ: "neutral" },
  proceeding: {
    OPEN: "info",
    IN_PROGRESS: "info",
    AWAITING_REVIEW: "warning",
    AWAITING_APPROVAL: "warning",
    RETURNED: "warning",
    SUSPENDED: "warning",
    CONCLUDED: "success",
    CANCELLED: "neutral",
  },
  allegation: {
    OPEN: "info",
    SUBSTANTIATED: "neutral",
    UNSUBSTANTIATED: "neutral",
    WITHDRAWN: "neutral",
    SUPERSEDED: "neutral",
  },
  finding: {
    SUBSTANTIATED: "neutral",
    PARTIALLY_SUBSTANTIATED: "neutral",
    NOT_SUBSTANTIATED: "neutral",
    INCONCLUSIVE: "neutral",
  },
  meeting: { SCHEDULED: "info", OPEN: "info", CLOSED: "neutral", CANCELLED: "neutral" },
  voteItem: { OPEN: "info", AWAITING_CASTING_VOTE: "warning", CLOSED: "neutral" },
  minutes: {
    IN_REVIEW: "warning",
    CHANGES_REQUESTED: "warning",
    APPROVED: "success",
    DEEMED_APPROVED: "success",
    SUPERSEDED: "neutral",
  },
  concern: { OPEN: "warning", UPHELD: "neutral", DISMISSED: "neutral" },
  recommendationPackage: {
    DRAFT: "info",
    VOTING: "info",
    ADOPTED: "warning",
    IN_LEGAL_REVIEW: "warning",
    RETURNED_BY_LEGAL: "warning",
    AWAITING_AUTHORITY: "warning",
    RETURNED_BY_AUTHORITY: "warning",
    DECIDED: "neutral",
  },
  legalReview: { ASSIGNED: "warning", OPINION_GIVEN: "neutral", CANCELLED: "neutral" },
  correctiveAction: {
    OPEN: "info",
    IN_PROGRESS: "info",
    PENDING_VERIFICATION: "warning",
    COMPLETED: "success",
    WAIVED: "neutral",
  },
};

/** The tone for a status; an unknown code (a newer database value) falls back to neutral, never to red. */
export function statusTone(domain: StatusDomain, status: string): StatusTone {
  return (STATUS_TONES[domain] as Record<string, StatusTone>)[status] ?? "neutral";
}

const STATUS_CLASSES: Record<StatusTone, string> = {
  info: "bg-cdf-info-bg text-cdf-info",
  success: "bg-cdf-success-bg text-cdf-success",
  warning: "bg-cdf-warning-bg text-cdf-warning",
  danger: "bg-cdf-danger-bg text-cdf-danger",
  neutral: "bg-cdf-surface-subtle text-cdf-text",
};

/** A status pill. `children` is the translated status label; the tone comes from the registry. */
export function CDFStatusBadge({
  domain,
  status,
  children,
  testId,
}: {
  domain: StatusDomain;
  status: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <span
      data-testid={testId}
      data-status={status}
      className={`inline-flex items-center rounded-full border border-cdf-border px-2 py-0.5 text-xs font-semibold whitespace-nowrap ${STATUS_CLASSES[statusTone(domain, status)]}`}
    >
      {children}
    </span>
  );
}

// ---- Indicators -------------------------------------------------------------------------------------------
// Classification, named access and legal hold are not statuses. They are rectangles with a Cinder outline and a
// glyph, so they differ from status pills by shape and glyph as well as colour, and none of them is red.

export const CLASSIFICATION_LEVELS = ["INTERNAL", "RESTRICTED", "CONFIDENTIAL", "SECRET"] as const;
type Level = (typeof CLASSIFICATION_LEVELS)[number];

const LEVEL_FILL: Record<Level, string> = {
  INTERNAL: "bg-cdf-class-internal",
  RESTRICTED: "bg-cdf-class-restricted",
  CONFIDENTIAL: "bg-cdf-class-confidential",
  SECRET: "bg-cdf-class-secret",
};

const INDICATOR =
  "inline-flex items-center gap-1 rounded-cdf-sm border border-cdf-indicator-outline font-semibold whitespace-nowrap text-cdf-indicator-text";
const SIZE = { sm: "px-1.5 py-0.5 text-xs", md: "px-2 py-1 text-sm" } as const;

function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 16 16"
      className="size-3.5 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      {children}
    </svg>
  );
}

/** The lock grows with the level: open, closed, closed with a bar, filled. */
function LevelGlyph({ level }: { level: Level }) {
  const body = (
    <rect x="3" y="7" width="10" height="7" rx="1" fill={level === "SECRET" ? "currentColor" : "none"} />
  );
  const shackle =
    level === "INTERNAL" ? <path d="M5 7V5a3 3 0 0 1 6 0" /> : <path d="M5 7V5a3 3 0 0 1 6 0v2" />;
  return (
    <Glyph>
      {shackle}
      {body}
      {level === "CONFIDENTIAL" ? <path d="M6 10.5h4" /> : null}
    </Glyph>
  );
}

/**
 * Classification of a case, report, form or evidence item. `label` is the glossary text for the level code;
 * level names are SOURCE_REQUIRED (DEC-44), so no name is fixed here.
 */
export function CDFClassificationBadge({
  level,
  label,
  size = "sm",
  testId,
}: {
  level: string;
  label: ReactNode;
  size?: keyof typeof SIZE;
  testId?: string;
}) {
  const known = (CLASSIFICATION_LEVELS as readonly string[]).includes(level) ? (level as Level) : "INTERNAL";
  return (
    <span
      data-testid={testId}
      data-level={level}
      className={`${INDICATOR} ${SIZE[size]} ${LEVEL_FILL[known]}`}
    >
      <LevelGlyph level={known} />
      {label}
    </span>
  );
}

/** The named-access flag of a restricted case (`is_restricted`): outline only, a person with a lock. */
export function CDFNamedAccessFlag({
  label,
  size = "sm",
  testId,
}: {
  label: ReactNode;
  size?: keyof typeof SIZE;
  testId?: string;
}) {
  return (
    <span data-testid={testId} className={`${INDICATOR} ${SIZE[size]} bg-cdf-named-access`}>
      <Glyph>
        <circle cx="6" cy="5" r="2.5" />
        <path d="M1.5 14c0-2.5 2-4.5 4.5-4.5" />
        <rect x="9" y="10" width="5.5" height="4" rx="0.5" />
        <path d="M10 10V9a1.75 1.75 0 0 1 3.5 0v1" />
      </Glyph>
      {label}
    </span>
  );
}

/**
 * A legal hold is active. Shown to the authorised case team where it changes handling (ADR-016 D5); who asked
 * for it and why stay with legal, records and GRC. Wistful blue with a shield, never red.
 */
export function CDFLegalHoldIndicator({
  label,
  size = "sm",
  testId,
}: {
  label: ReactNode;
  size?: keyof typeof SIZE;
  testId?: string;
}) {
  return (
    <span data-testid={testId} className={`${INDICATOR} ${SIZE[size]} bg-cdf-legal-hold`}>
      <Glyph>
        <path d="M8 1.5 2.5 3.5v4c0 3.2 2.3 5.8 5.5 7 3.2-1.2 5.5-3.8 5.5-7v-4z" />
      </Glyph>
      {label}
    </span>
  );
}
