// Meeting and minutes commands (migrations 1890, 2000, 2030 and 2050; UX redesign Phase 12 P12-2a, ADR-054). One
// schema per command; the database re-checks every rule, including who may act and in which state. The lengths
// follow the commands' own checks. Error messages are i18n keys, never prose.
import { z } from "zod";
import {
  CASTING_VOTE_CHOICES,
  COI_DECLARATIONS,
  CONCERN_DECISIONS,
  MEMBER_VOTE_CHOICES,
  MINUTES_REVIEW_DECISIONS,
  OPENABLE_VOTE_TARGETS,
  RECORDABLE_ATTENDANCE,
  RECORDED_FOR_MEMBER_CHOICES,
} from "@cdf/contracts";

const uuid = z.uuid({ message: "validation.invalid" });
const requiredText = (min: number, max: number) =>
  z
    .string({ message: "validation.required" })
    .trim()
    .min(1, { message: "validation.required", abort: true })
    .min(min, { message: "validation.tooShort" })
    .max(max, { message: "validation.tooLong" });
const optionalText = (min: number, max: number) =>
  z
    .string()
    .trim()
    .max(max, { message: "validation.tooLong" })
    .optional()
    .transform((v) => (v ? v : undefined))
    .refine((v) => v === undefined || v.length >= min, { message: "validation.tooShort" });
const choice = <T extends readonly [string, ...string[]]>(values: T) =>
  z.enum(values, { message: "validation.required" });
/** A checkbox the form sends as a boolean (formObject's booleans). */
const flag = z.boolean({ message: "validation.invalid" });
/** The meeting commands' reason (open, close, cancel, excuse, declare, recuse): 5 to 2000 characters. */
const reason = requiredText(5, 2000);
/** A raised conflict, its decision and its reversal need a fuller reason: 10 to 2000 characters. */
const concernReason = requiredText(10, 2000);

/**
 * When an absence or recusal happened, if not now (api.record_vote_for_member): datetime-local or ISO, local values
 * read as Riyadh time, never in the future.
 */
const optionalPastInstant = z
  .string()
  .trim()
  .optional()
  .transform((v, ctx) => {
    if (!v) return undefined;
    const withZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(v) ? v : `${v}${v.length === 16 ? ":00" : ""}+03:00`;
    const d = new Date(withZone);
    if (Number.isNaN(d.getTime())) {
      ctx.addIssue({ code: "custom", message: "validation.invalid" });
      return z.NEVER;
    }
    if (d.getTime() > Date.now()) {
      ctx.addIssue({ code: "custom", message: "validation.futureDate" });
      return z.NEVER;
    }
    return d.toISOString();
  });

// ---- The meeting (api.open_meeting, api.close_meeting, api.cancel_meeting) --------------------------------------
export const openMeetingSchema = z.object({ meetingId: uuid, reason });
export const closeMeetingSchema = z.object({ meetingId: uuid, reason });
export const cancelMeetingSchema = z.object({ meetingId: uuid, reason });

// ---- Attendance and excuses (api.record_attendance; api.record_excused_absence, ADR-038) -------------------------
export const recordAttendanceSchema = z.object({
  participantId: uuid,
  attendance: choice(RECORDABLE_ATTENDANCE),
});
export const recordExcusedAbsenceSchema = z.object({ participantId: uuid, reason });

// ---- One's own declaration and acknowledgement (api.declare_meeting_conflict, api.acknowledge_meeting_confidentiality)
/** A declared conflict needs its reason; "no conflict" may carry one. */
export const declareMeetingConflictSchema = z
  .object({
    participantId: uuid,
    status: choice(COI_DECLARATIONS),
    reason: optionalText(5, 2000),
  })
  .superRefine((v, ctx) => {
    if (v.status === "CONFLICT_DECLARED" && !v.reason)
      ctx.addIssue({ code: "custom", message: "validation.required", path: ["reason"] });
  });
export const acknowledgeMeetingConfidentialitySchema = z.object({ participantId: uuid });

// ---- Raised conflicts (api.raise_meeting_conflict, ADR-038; api.decide_meeting_conflict, DEC-F04;
//      api.reverse_meeting_conflict_determination, DEC-AMB-010) ---------------------------------------------------
export const raiseMeetingConflictSchema = z.object({ participantId: uuid, reason: concernReason });
export const decideMeetingConflictSchema = z.object({
  concernId: uuid,
  decision: choice(CONCERN_DECISIONS),
  reason: concernReason,
});
export const reverseMeetingConflictSchema = z.object({ concernId: uuid, reason: concernReason });

// ---- Votes (api.open_vote_item, api.cast_vote, api.revise_vote (AMB-081), api.recuse_for_conflict (AMB-077),
//      api.record_vote_note (AMB-082), api.record_vote_for_member, api.close_vote_item, api.cast_casting_vote) ----
/** A vote on other business; a vote on a finding needs a read of the findings that this screen does not have. */
export const openVoteItemSchema = z.object({
  meetingId: uuid,
  targetType: choice(OPENABLE_VOTE_TARGETS).default("OTHER"),
  title: requiredText(3, 300),
});
export const castVoteSchema = z.object({
  voteItemId: uuid,
  choice: choice(MEMBER_VOTE_CHOICES),
  reason: optionalText(5, 2000),
});
export const reviseVoteSchema = z.object({
  voteItemId: uuid,
  choice: choice(MEMBER_VOTE_CHOICES),
  reason: optionalText(5, 2000),
});
export const recuseForConflictSchema = z.object({ voteItemId: uuid, reason });
export const recordVoteNoteSchema = z.object({
  voteItemId: uuid,
  note: requiredText(10, 4000),
  annexToMinutes: flag,
});
export const recordVoteForMemberSchema = z.object({
  voteItemId: uuid,
  participantId: uuid,
  choice: choice(RECORDED_FOR_MEMBER_CHOICES),
  reason,
  originalEventAt: optionalPastInstant,
});
/** Under a CUSTOM quorum the secretary attests it is met; the database refuses the attestation otherwise. */
export const closeVoteItemSchema = z.object({ voteItemId: uuid, customQuorumAttested: flag });
export const castCastingVoteSchema = z.object({
  voteItemId: uuid,
  choice: choice(CASTING_VOTE_CHOICES),
  reason: optionalText(5, 2000),
});

// ---- Minutes (api.generate_minutes, api.review_minutes, api.record_minutes_reminder,
//      api.apply_minutes_deemed_approval, api.overrule_minutes_objection (AMB-092)) ------------------------------
export const generateMinutesSchema = z.object({ meetingId: uuid, narrative: requiredText(10, 20000) });
/** Asking for changes needs a comment; an approval may carry one. */
export const reviewMinutesSchema = z
  .object({
    minutesId: uuid,
    decision: choice(MINUTES_REVIEW_DECISIONS),
    comment: optionalText(5, 4000),
  })
  .superRefine((v, ctx) => {
    if (v.decision === "REQUEST_CHANGES" && !v.comment)
      ctx.addIssue({ code: "custom", message: "validation.required", path: ["comment"] });
  });
export const recordMinutesReminderSchema = z.object({ minutesId: uuid });
export const applyMinutesDeemedApprovalSchema = z.object({ minutesId: uuid });
export const overruleMinutesObjectionSchema = z.object({ minutesId: uuid, reason: concernReason });
