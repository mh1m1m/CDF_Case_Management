// Committee meeting and minutes commands (migrations 1890, 2000, 2010, 2030 and 2050; UX redesign Phase 12 P12-2a and
// P12-2b, ADR-054 and ADR-055). One schema per command; the database re-checks every rule, including who may act and
// in which state. The lengths follow the commands' own checks. Error messages are i18n keys, never prose.
import { z } from "zod";
import {
  CASTING_VOTE_CHOICES,
  COI_DECLARATIONS,
  CONCERN_DECISIONS,
  MEETING_MODES,
  MEETING_PURPOSES,
  MEMBER_VOTE_CHOICES,
  MINUTES_REVIEW_DECISIONS,
  OFFLINE_BALLOT_CHOICES,
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
/** The meeting commands' reason (schedule, open, close, cancel, excuse, declare, recuse): 5 to 2000 characters. */
const reason = requiredText(5, 2000);
/**
 * A fuller reason, 10 to 2000 characters: a raised conflict, its decision and its reversal; excluding a witness; an
 * activation; adding a member to a proceeding; an emergency.
 */
const fullReason = requiredText(10, 2000);

/** A datetime-local or ISO value as a Date; a local value is Riyadh time (UTC+3, no daylight saving). */
const asInstant = (v: string): Date =>
  new Date(/([zZ]|[+-]\d{2}:?\d{2})$/.test(v) ? v : `${v}${v.length === 16 ? ":00" : ""}+03:00`);

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
    const d = asInstant(v);
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

/** A required date and time (datetime-local or ISO, local values read as Riyadh time), as an ISO instant. */
const instant = z
  .string({ message: "validation.required" })
  .trim()
  .min(1, { message: "validation.required", abort: true })
  .transform((v, ctx) => {
    const d = asInstant(v);
    if (Number.isNaN(d.getTime())) {
      ctx.addIssue({ code: "custom", message: "validation.invalid" });
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
export const raiseMeetingConflictSchema = z.object({ participantId: uuid, reason: fullReason });
export const decideMeetingConflictSchema = z.object({
  concernId: uuid,
  decision: choice(CONCERN_DECISIONS),
  reason: fullReason,
});
export const reverseMeetingConflictSchema = z.object({ concernId: uuid, reason: fullReason });

// ---- Votes (api.open_vote_item, api.cast_vote, api.revise_vote (AMB-081), api.recuse_for_conflict (AMB-077),
//      api.record_vote_note (AMB-082), api.record_vote_for_member, api.close_vote_item, api.cast_casting_vote) ----
/**
 * A vote on other business, or on a finding (P12-2c, ADR-056): a finding vote names the finding, other business names
 * none. The database accepts only a finding the committee may act on (CDF-214), the one `api.committee_scope_choices`
 * lists.
 */
export const openVoteItemSchema = z
  .object({
    meetingId: uuid,
    targetType: choice(OPENABLE_VOTE_TARGETS).default("OTHER"),
    findingId: uuid.optional(),
    title: requiredText(3, 300),
  })
  .superRefine((v, ctx) => {
    if (v.targetType === "FINDING" && !v.findingId)
      ctx.addIssue({ code: "custom", message: "validation.required", path: ["findingId"] });
    if (v.targetType !== "FINDING" && v.findingId)
      ctx.addIssue({ code: "custom", message: "validation.invalid", path: ["findingId"] });
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
/**
 * The member confirms their own paper ballot (2120, ADR-048): the choice they read on it, which the database compares
 * with the ballot (BALLOT_CHOICE_MISMATCH). It names no member: nobody confirms for another.
 */
export const confirmOfflineBallotSchema = z.object({
  voteItemId: uuid,
  choice: choice(OFFLINE_BALLOT_CHOICES),
});
/**
 * 2125 (ADR-062): the member lets their own paper ballot go, so that the secretary's record for a member not present
 * may supersede it. It names no member: nobody declines for another.
 */
export const declineOfflineBallotSchema = z.object({ voteItemId: uuid });
/** 2125 (ADR-062): the meeting's chair releases the paper ballot of a member who is not present, with a reason. */
export const releaseOfflineBallotSchema = z.object({ voteItemId: uuid, participantId: uuid, reason });
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
export const overruleMinutesObjectionSchema = z.object({ minutesId: uuid, reason: fullReason });

// ---- Scheduling (api.schedule_meeting; api.schedule_emergency_meeting, AMB-061; P12-2b, ADR-055) ------------------
/** The link committee.insert_meeting accepts: https, no spaces, 12 to 500 characters. */
const ONLINE_LINK = /^https:\/\/\S+$/;
const IN_ROOM: readonly string[] = ["IN_PERSON", "HYBRID"];
const ONLINE: readonly string[] = ["TEAMS", "HYBRID"];

const meetingFields = {
  committeeProceedingId: uuid,
  purpose: choice(MEETING_PURPOSES),
  mode: choice(MEETING_MODES),
  location: optionalText(2, 200),
  onlineUrl: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v : undefined)),
  scheduledStart: instant,
  scheduledEnd: instant,
  reason,
};

/**
 * The command's own pairings: a place for a meeting in a room, a link for one online (HYBRID needs both), and never
 * the other one, which the command refuses rather than drops; the end after the start. The notice the committee
 * requires is the database's to check against the time chosen.
 */
interface MeetingTimeAndPlace {
  mode: string;
  location?: string | undefined;
  onlineUrl?: string | undefined;
  scheduledStart: string;
  scheduledEnd: string;
}
const meetingChecks = (v: MeetingTimeAndPlace, ctx: z.RefinementCtx) => {
  if (IN_ROOM.includes(v.mode) && !v.location)
    ctx.addIssue({ code: "custom", message: "validation.required", path: ["location"] });
  if (!IN_ROOM.includes(v.mode) && v.location)
    ctx.addIssue({ code: "custom", message: "validation.noPlaceOnline", path: ["location"] });
  if (ONLINE.includes(v.mode) && !v.onlineUrl)
    ctx.addIssue({ code: "custom", message: "validation.required", path: ["onlineUrl"] });
  if (!ONLINE.includes(v.mode) && v.onlineUrl)
    ctx.addIssue({ code: "custom", message: "validation.noLinkInPerson", path: ["onlineUrl"] });
  if (v.onlineUrl && (!ONLINE_LINK.test(v.onlineUrl) || v.onlineUrl.length < 12 || v.onlineUrl.length > 500))
    ctx.addIssue({ code: "custom", message: "validation.httpsLink", path: ["onlineUrl"] });
  if (Date.parse(v.scheduledEnd) <= Date.parse(v.scheduledStart))
    ctx.addIssue({ code: "custom", message: "validation.endAfterStart", path: ["scheduledEnd"] });
};

export const scheduleMeetingSchema = z.object(meetingFields).superRefine(meetingChecks);
/** Shorter notice than the committee's minimum, with the emergency recorded and its reason (AMB-061). */
export const scheduleEmergencyMeetingSchema = z
  .object({ ...meetingFields, emergencyReason: fullReason })
  .superRefine(meetingChecks);

// ---- The committee as a proceeding holds it (api.amend_proceeding_snapshot, AMB-038) ------------------------------
/** A current member added after referral; the database refuses one not cleared for the case. */
export const amendProceedingSnapshotSchema = z.object({
  committeeProceedingId: uuid,
  membershipId: uuid,
  reason: fullReason,
});

// ---- The meeting's logistics (api.exclude_meeting_witness, migration 2010; api.record_meeting_accommodation,
//      AMB-157; api.activate_acting_chair, api.activate_acting_secretary, api.activate_alternate_member, DEC-F03,
//      AMB-041, AMB-042; P12-2b) --------------------------------------------------------------------------------
export const excludeMeetingWitnessSchema = z.object({ participantId: uuid, reason: fullReason });
/** What is arranged for the participant (it may concern health, AMB-157): 5 to 2000 characters. */
export const recordMeetingAccommodationSchema = z.object({
  participantId: uuid,
  details: requiredText(5, 2000),
});
export const activateActingChairSchema = z.object({ meetingId: uuid, reason: fullReason });
export const activateActingSecretarySchema = z.object({ meetingId: uuid, reason: fullReason });
export const activateAlternateMemberSchema = z.object({
  alternateParticipantId: uuid,
  replacesParticipantId: uuid,
  reason: fullReason,
});
