/**
 * Interview lifecycle rules (EPIC 09, CDF-60, ADR-012). Pure functions: the UI uses them to decide what
 * to offer and the application layer to refuse early; api.transition_interview and the other commands in
 * migration 1200 are the authority and re-check every rule.
 */
import type { InterviewAction, InterviewStatus, IntervieweeKind } from "@cdf/contracts";

/** Mirror of api.transition_interview (asserted by the interview integration tests). */
export const INTERVIEW_TRANSITIONS: Readonly<
  Record<InterviewAction, { from: readonly InterviewStatus[]; to: InterviewStatus; reasonRequired: boolean }>
> = {
  PREPARE: { from: ["CONDUCTED"], to: "PREPARED", reasonRequired: false },
  REVIEW: { from: ["PREPARED"], to: "REVIEWED", reasonRequired: false },
  APPROVE: { from: ["REVIEWED"], to: "APPROVED", reasonRequired: false },
  RETURN: { from: ["PREPARED", "REVIEWED"], to: "CONDUCTED", reasonRequired: true },
  CANCEL: { from: ["PLANNED", "SCHEDULED"], to: "CANCELLED", reasonRequired: true },
};

export const TERMINAL_INTERVIEW_STATUSES: readonly InterviewStatus[] = ["APPROVED", "CANCELLED"];

export function nextInterviewStatus(
  status: InterviewStatus,
  action: InterviewAction,
): InterviewStatus | null {
  const t = INTERVIEW_TRANSITIONS[action];
  return t.from.includes(status) ? t.to : null;
}

export function interviewActionsFrom(status: InterviewStatus): InterviewAction[] {
  return (Object.keys(INTERVIEW_TRANSITIONS) as InterviewAction[]).filter(
    (a) => nextInterviewStatus(status, a) !== null,
  );
}

/** Which recording steps are open in a status (schedule, notice, rights, conduct, statement, link). */
export function interviewStepsOpen(status: InterviewStatus) {
  return {
    addParticipant: status === "PLANNED" || status === "SCHEDULED",
    schedule: status === "PLANNED" || status === "SCHEDULED",
    notice: status === "SCHEDULED",
    rights: status === "SCHEDULED",
    conduct: status === "SCHEDULED",
    statement: status === "CONDUCTED",
    acknowledge: status === "CONDUCTED",
    linkRecording: status === "CONDUCTED",
  };
}

export type InterviewBlocker =
  | "INTERVIEW_STATE"
  | "NOTICE_NOT_ISSUED"
  | "RIGHTS_NOT_ACKNOWLEDGED"
  | "STATEMENT_MISSING"
  | "STATEMENT_NOT_ACKNOWLEDGED"
  | "SEPARATION_OF_DUTIES";

/** Facts the rules need; a subset of InterviewDetail so callers can pass the detail directly. */
export interface InterviewFacts {
  status: InterviewStatus;
  preparedBy: string | null;
  reviewedBy: string | null;
  rightsAcknowledgedAt: string | null;
  currentStatementVersionId: string | null;
  notices: readonly { noticeType: string }[];
  statements: readonly { id: string; acknowledgement: unknown }[];
}

/** Blocking conditions for conducting a scheduled interview. */
export function conductBlockers(i: InterviewFacts): InterviewBlocker[] {
  const out: InterviewBlocker[] = [];
  if (i.status !== "SCHEDULED") out.push("INTERVIEW_STATE");
  if (!i.notices.some((n) => n.noticeType === "INVITATION")) out.push("NOTICE_NOT_ISSUED");
  if (!i.rightsAcknowledgedAt) out.push("RIGHTS_NOT_ACKNOWLEDGED");
  return out;
}

/**
 * Blocking conditions for a lifecycle action by `actorId`. Separation of duties
 * (SOURCE_REQUIRED, ADR-012): the reviewer is not the preparer; the approver is neither.
 */
export function transitionBlockers(
  i: InterviewFacts,
  action: InterviewAction,
  actorId: string,
): InterviewBlocker[] {
  const out: InterviewBlocker[] = [];
  if (nextInterviewStatus(i.status, action) === null) out.push("INTERVIEW_STATE");
  if (action === "PREPARE") {
    const current = i.statements.find((s) => s.id === i.currentStatementVersionId);
    if (!current) out.push("STATEMENT_MISSING");
    else if (!current.acknowledgement) out.push("STATEMENT_NOT_ACKNOWLEDGED");
  }
  if ((action === "REVIEW" || action === "RETURN") && i.preparedBy === actorId)
    out.push("SEPARATION_OF_DUTIES");
  if (action === "APPROVE" && (i.preparedBy === actorId || i.reviewedBy === actorId))
    out.push("SEPARATION_OF_DUTIES");
  return out;
}

/** Display number within a case: INT-001. The UUID remains the identifier (§87). */
export function interviewDisplayNumber(sequenceNo: number): string {
  return `INT-${String(sequenceNo).padStart(3, "0")}`;
}

/** The reporter is never named on an interview (§22); every other interviewee needs a working label. */
export function intervieweeLabelAllowed(kind: IntervieweeKind, label: string | null | undefined): boolean {
  const present = !!label && label.trim().length > 0;
  return kind === "REPORTER" ? !present : present;
}

/**
 * Canonical statement text: Unicode NFC and LF line endings, so the same words always hash the same.
 * Applied by the validation schema before the text reaches the database, which hashes what it stores.
 */
export function normaliseStatement(text: string): string {
  return text.normalize("NFC").replace(/\r\n?/g, "\n");
}

/** SHA-256 (hex) of the UTF-8 statement text; equals the database's content_sha256 for the same text. */
export async function statementSha256(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
