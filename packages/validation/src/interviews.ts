/**
 * Interview command schemas (EPIC 09, CDF-60). Shared by the server actions and re-validated by the
 * database commands in migration 1200 (§45). Error messages are i18n keys, never prose.
 */
import { z } from "zod";
import {
  CLASSIFICATION_LEVELS,
  INTERVIEWEE_KINDS,
  INTERVIEW_ACTIONS,
  INTERVIEW_MODES,
  INTERVIEW_NOTICE_CHANNELS,
  INTERVIEW_NOTICE_TYPES,
  INTERVIEW_STATEMENT_MAX_CHARS,
  RIGHTS_ACK_METHODS,
  STATEMENT_ACK_METHODS,
} from "@cdf/contracts";

const uuid = z.uuid({ message: "validation.invalid" });

const text = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min, { message: min <= 1 ? "validation.required" : "validation.tooShort" })
    .max(max, { message: "validation.tooLong" });

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, { message: "validation.tooLong" })
    .optional()
    .transform((v) => (v ? v : undefined));

/** A date-time from a form (datetime-local or ISO) as an ISO instant. Local values are read as Riyadh time. */
const instant = z
  .string({ message: "validation.required" })
  .trim()
  .min(1, { message: "validation.required" })
  .transform((v, ctx) => {
    const withZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(v) ? v : `${v}${v.length === 16 ? ":00" : ""}+03:00`;
    const d = new Date(withZone);
    if (Number.isNaN(d.getTime())) {
      ctx.addIssue({ code: "custom", message: "validation.invalid" });
      return z.NEVER;
    }
    return d.toISOString();
  });

export const planInterviewSchema = z
  .object({
    caseId: uuid,
    title: text(3, 200),
    purpose: optionalText(2000),
    intervieweeKind: z.enum(INTERVIEWEE_KINDS, { message: "validation.required" }),
    intervieweeLabel: optionalText(200),
    casePersonId: uuid.optional(),
    classification: z.enum(CLASSIFICATION_LEVELS, { message: "validation.required" }),
  })
  // The reporter is referenced only through the case (§22): a name typed here is refused, not dropped.
  .refine((v) => v.intervieweeKind !== "REPORTER" || !v.intervieweeLabel, {
    message: "interviews.validation.reporterNotNamed",
    path: ["intervieweeLabel"],
  })
  .refine((v) => v.intervieweeKind !== "REPORTER" || !v.casePersonId, {
    message: "validation.invalid",
    path: ["casePersonId"],
  })
  .refine((v) => v.intervieweeKind === "REPORTER" || (v.intervieweeLabel?.length ?? 0) >= 2, {
    message: "validation.tooShort",
    path: ["intervieweeLabel"],
  });
export type PlanInterviewInput = z.output<typeof planInterviewSchema>;

export const addInterviewParticipantSchema = z.object({
  interviewId: uuid,
  userId: uuid,
  participantRole: z.enum(["INTERVIEWER", "NOTE_TAKER"]),
});

export const scheduleInterviewSchema = z.object({
  interviewId: uuid,
  scheduledStart: instant,
  durationMinutes: z.coerce
    .number({ message: "validation.invalid" })
    .int({ message: "validation.invalid" })
    .min(15, { message: "validation.invalid" })
    .max(480, { message: "validation.invalid" }),
  mode: z.enum(INTERVIEW_MODES, { message: "validation.required" }),
  location: optionalText(200),
});

export const issueInterviewNoticeSchema = z.object({
  interviewId: uuid,
  noticeType: z.enum(INTERVIEW_NOTICE_TYPES),
  channel: z.enum(INTERVIEW_NOTICE_CHANNELS, { message: "validation.required" }),
});

export const recordInterviewRightsSchema = z.object({
  interviewId: uuid,
  method: z.enum(RIGHTS_ACK_METHODS, { message: "validation.required" }),
  noticeVersion: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9][A-Z0-9.-]{2,39}$/, { message: "validation.invalid" }),
});

export const recordInterviewConductedSchema = z
  .object({ interviewId: uuid, startedAt: instant, endedAt: instant })
  .refine((v) => v.endedAt > v.startedAt, {
    message: "interviews.validation.endBeforeStart",
    path: ["endedAt"],
  });

export const recordInterviewStatementSchema = z.object({
  interviewId: uuid,
  // Canonical form (NFC, LF) so the hash shown to the interviewee is reproducible (packages/domain).
  content: z
    .string()
    .transform((v) => v.normalize("NFC").replace(/\r\n?/g, "\n"))
    .pipe(text(1, INTERVIEW_STATEMENT_MAX_CHARS)),
  language: z.enum(["ar", "en"]),
});

export const acknowledgeInterviewStatementSchema = z.object({
  versionId: uuid,
  method: z.enum(STATEMENT_ACK_METHODS, { message: "validation.required" }),
  attestedSha256: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[0-9a-f]{64}$/, { message: "validation.invalid" }),
});

export const linkInterviewRecordingSchema = z.object({ interviewId: uuid, evidenceId: uuid });

export const transitionInterviewSchema = z
  .object({ interviewId: uuid, action: z.enum(INTERVIEW_ACTIONS), reason: optionalText(2000) })
  .refine((v) => !["RETURN", "CANCEL"].includes(v.action) || (v.reason?.length ?? 0) >= 10, {
    message: "validation.tooShort",
    path: ["reason"],
  });
