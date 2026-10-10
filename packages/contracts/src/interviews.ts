/**
 * Interview contracts (EPIC 09, CDF-60, ADR-012). Types and literal lists only; the lists mirror the
 * check constraints in infrastructure/supabase/migrations/20261007001200_interviews.sql.
 */
import type { Classification } from "./index";

export const INTERVIEWEE_KINDS = ["WITNESS", "SUBJECT", "REPORTER", "OTHER"] as const;
export type IntervieweeKind = (typeof INTERVIEWEE_KINDS)[number];

export const INTERVIEW_STATUSES = [
  "PLANNED",
  "SCHEDULED",
  "CONDUCTED",
  "PREPARED",
  "REVIEWED",
  "APPROVED",
  "CANCELLED",
] as const;
export type InterviewStatus = (typeof INTERVIEW_STATUSES)[number];

/** Lifecycle actions handled by api.transition_interview. */
export const INTERVIEW_ACTIONS = ["PREPARE", "REVIEW", "APPROVE", "RETURN", "CANCEL"] as const;
export type InterviewAction = (typeof INTERVIEW_ACTIONS)[number];

export const INTERVIEW_PARTICIPANT_ROLES = ["LEAD_INTERVIEWER", "INTERVIEWER", "NOTE_TAKER"] as const;
export type InterviewParticipantRole = (typeof INTERVIEW_PARTICIPANT_ROLES)[number];

export const INTERVIEW_MODES = ["IN_PERSON", "REMOTE_VIDEO", "PHONE"] as const;
export type InterviewMode = (typeof INTERVIEW_MODES)[number];

export const INTERVIEW_NOTICE_TYPES = ["INVITATION", "RESCHEDULE"] as const;
export type InterviewNoticeType = (typeof INTERVIEW_NOTICE_TYPES)[number];

export const INTERVIEW_NOTICE_CHANNELS = ["IN_PERSON", "INTERNAL_EMAIL", "LETTER", "PORTAL_MESSAGE"] as const;
export type InterviewNoticeChannel = (typeof INTERVIEW_NOTICE_CHANNELS)[number];

export const RIGHTS_ACK_METHODS = ["SIGNED_FORM", "VERBAL_ON_RECORD"] as const;
export type RightsAckMethod = (typeof RIGHTS_ACK_METHODS)[number];

export const STATEMENT_ACK_METHODS = ["SIGNED_PAPER", "ELECTRONIC_ACK", "REFUSED_TO_SIGN"] as const;
export type StatementAckMethod = (typeof STATEMENT_ACK_METHODS)[number];

/** Upper bound for one statement version, enforced by the browser hint, the server and the database. */
export const INTERVIEW_STATEMENT_MAX_CHARS = 50_000;

/** Evidence types that may be linked to an interview as a recording or signed statement. */
export const INTERVIEW_RECORDING_EVIDENCE_TYPES = ["AUDIO", "VIDEO", "DOCUMENT"] as const;

export interface InterviewListItem {
  id: string;
  caseId: string;
  sequenceNo: number;
  title: string;
  /** For REPORTER this is always null: the reporter is referenced only through the case's wb_id. */
  intervieweeLabel: string | null;
  intervieweeKind: IntervieweeKind;
  classification: Classification;
  status: InterviewStatus;
  scheduledStart: string | null;
  mode: InterviewMode | null;
  createdBy: string;
  createdByName: string | null;
  updatedAt: string;
}

export interface InterviewParticipantInfo {
  id: string;
  userId: string;
  displayName: string;
  displayNameAr: string;
  participantRole: InterviewParticipantRole;
  addedAt: string;
}

export interface InterviewNoticeInfo {
  id: string;
  noticeType: InterviewNoticeType;
  channel: InterviewNoticeChannel;
  scheduledStart: string;
  issuedBy: string;
  issuedByName: string | null;
  issuedAt: string;
}

export interface StatementAckInfo {
  method: StatementAckMethod;
  attestedSha256: string;
  recordedBy: string;
  recordedByName: string | null;
  recordedAt: string;
}

export interface StatementVersionInfo {
  id: string;
  versionNo: number;
  content: string;
  language: "ar" | "en";
  contentSha256: string;
  recordedBy: string;
  recordedByName: string | null;
  recordedAt: string;
  acknowledgement: StatementAckInfo | null;
}

export interface InterviewRecordingInfo {
  id: string;
  evidenceId: string;
  evidenceSequenceNo: number;
  evidenceTitle: string;
  evidenceType: string;
  linkedBy: string;
  linkedByName: string | null;
  linkedAt: string;
}

export interface InterviewDetail extends InterviewListItem {
  purpose: string | null;
  casePersonId: string | null;
  location: string | null;
  durationMinutes: number | null;
  rightsAckMethod: RightsAckMethod | null;
  rightsNoticeVersion: string | null;
  rightsAcknowledgedAt: string | null;
  conductedStartedAt: string | null;
  conductedEndedAt: string | null;
  currentStatementVersionId: string | null;
  formInstanceId: string | null;
  preparedBy: string | null;
  preparedAt: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  cancelledAt: string | null;
  rowVersion: number;
  participants: InterviewParticipantInfo[];
  notices: InterviewNoticeInfo[];
  statements: StatementVersionInfo[];
  recordings: InterviewRecordingInfo[];
}
