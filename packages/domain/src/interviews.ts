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

/**
 * The interview's steps in order (UX-033). The page shows them as a stepper with one current step: the first
 * one not yet done. A step is done by what is on record, so a step done out of order (rights before the
 * invitation) still shows as done. Nothing here grants anything; each step's command re-checks in the database.
 */
export const INTERVIEW_STEPS = [
  "SCHEDULE",
  "INVITE",
  "RIGHTS",
  "CONDUCT",
  "STATEMENT",
  "PREPARE",
  "REVIEW",
  "APPROVE",
] as const;
export type InterviewStep = (typeof INTERVIEW_STEPS)[number];
export type InterviewStepState = "done" | "current" | "upcoming" | "skipped";

/** Facts the steps need; a subset of InterviewDetail. */
export interface InterviewStepFacts extends InterviewFacts {
  scheduledStart: string | null;
  conductedStartedAt: string | null;
}

const PREPARED_OR_LATER: readonly InterviewStatus[] = ["PREPARED", "REVIEWED", "APPROVED"];

function stepDone(i: InterviewStepFacts, step: InterviewStep): boolean {
  switch (step) {
    case "SCHEDULE":
      return i.status !== "PLANNED" && i.scheduledStart !== null;
    case "INVITE":
      return i.notices.some((n) => n.noticeType === "INVITATION");
    case "RIGHTS":
      return i.rightsAcknowledgedAt !== null;
    case "CONDUCT":
      return i.conductedStartedAt !== null;
    case "STATEMENT":
      return (
        PREPARED_OR_LATER.includes(i.status) ||
        !!i.statements.find((s) => s.id === i.currentStatementVersionId)?.acknowledgement
      );
    case "PREPARE":
      return PREPARED_OR_LATER.includes(i.status);
    case "REVIEW":
      return i.status === "REVIEWED" || i.status === "APPROVED";
    case "APPROVE":
      return i.status === "APPROVED";
  }
}

/** Each step with its state. A cancelled interview has no current step: what was not done is "skipped". */
export function interviewSteps(i: InterviewStepFacts): { step: InterviewStep; state: InterviewStepState }[] {
  const cancelled = i.status === "CANCELLED";
  let currentFound = false;
  return INTERVIEW_STEPS.map((step) => {
    if (stepDone(i, step)) return { step, state: "done" as const };
    if (cancelled) return { step, state: "skipped" as const };
    if (currentFound) return { step, state: "upcoming" as const };
    currentFound = true;
    return { step, state: "current" as const };
  });
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
