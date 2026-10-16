// The recommendation package commands and the meeting's invite (migrations 1900, 2030 and 2060; UX redesign Phase 12
// P12-2c, ADR-056). One schema per command; the database re-checks every rule, including who may act, in which state,
// and that every subject, allegation, item and finding chosen belongs where the command says. The lengths and pairings
// follow the commands' own checks. Error messages are i18n keys, never prose.
import { z } from "zod";
import {
  MEETING_INVITEE_ROLES,
  RECOMMENDATION_ITEM_TYPES,
  TAINT_RESOLUTIONS,
  VOTE_GRANULARITIES,
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
/** A governed code (`^[A-Z][A-Z0-9_]{2,59}$`): a sanction code or an exclusivity group. */
const CODE = /^[A-Z][A-Z0-9_]{2,59}$/;
const optionalCode = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v ? v : undefined))
  .refine((v) => v === undefined || CODE.test(v), { message: "validation.code" });
/** Ids chosen with checkboxes: each once (the command refuses a repeat). */
const idList = z
  .array(uuid)
  .default([])
  .refine((ids) => new Set(ids).size === ids.length, { message: "validation.invalid" });

// ---- Packages (api.create_recommendation_package, api.submit_package_for_vote, api.open_package_vote,
//      api.record_package_adoption, api.return_package_to_committee) ----------------------------------------------
export const createRecommendationPackageSchema = z.object({
  committeeProceedingId: uuid,
  voteGranularity: choice(VOTE_GRANULARITIES),
});
export const submitPackageForVoteSchema = z.object({ packageId: uuid });
/** In one meeting of the package's proceeding that the caller runs and that is open (`open_vote_in`). */
export const openPackageVoteSchema = z.object({ meetingId: uuid, packageId: uuid });
export const recordPackageAdoptionSchema = z.object({ packageId: uuid });
/** Back to the committee after the adoption (DRAFT again), with the reason (5 to 2000 characters). */
export const returnPackageToCommitteeSchema = z.object({ packageId: uuid, reason: requiredText(5, 2000) });

// ---- Items (api.add_recommendation_item, CDF-213; api.withdraw_recommendation_item) --------------------------------
/**
 * The command's own pairings, so a mistake shows field by field before the database is asked: a disciplinary sanction
 * names a catalogue code or describes a sanction proposed outside it (Q87), never both, and names at least one subject
 * (Q88); any other item names no sanction. No subject and no allegation means the whole case (Q89).
 */
export const addRecommendationItemSchema = z
  .object({
    packageId: uuid,
    itemType: choice(RECOMMENDATION_ITEM_TYPES),
    sanctionCode: optionalCode,
    proposedSanctionText: optionalText(3, 500),
    description: requiredText(10, 4000),
    subjectIds: idList,
    allegationIds: idList,
    requiresLegalJustification: flag,
    dependsOnItemIds: idList,
    exclusivityGroup: optionalCode,
  })
  .superRefine((v, ctx) => {
    if (v.itemType === "DISCIPLINARY_SANCTION") {
      if (v.sanctionCode && v.proposedSanctionText)
        ctx.addIssue({ code: "custom", message: "validation.oneSanction", path: ["proposedSanctionText"] });
      if (!v.sanctionCode && !v.proposedSanctionText)
        ctx.addIssue({ code: "custom", message: "validation.sanctionRequired", path: ["sanctionCode"] });
      if (v.subjectIds.length === 0)
        ctx.addIssue({ code: "custom", message: "validation.subjectRequired", path: ["subjectIds"] });
    } else {
      if (v.sanctionCode)
        ctx.addIssue({ code: "custom", message: "validation.noSanction", path: ["sanctionCode"] });
      if (v.proposedSanctionText)
        ctx.addIssue({ code: "custom", message: "validation.noSanction", path: ["proposedSanctionText"] });
    }
  });
export const withdrawRecommendationItemSchema = z.object({ itemId: uuid, reason: requiredText(5, 2000) });

// ---- A conflict taint (api.resolve_conflict_taint, DEC-AMB-003, DEC-AMB-013) ------------------------------------------
/** Recorded in an open meeting of the proceeding that the caller runs; the reason is 10 to 2000 characters. */
export const resolveConflictTaintSchema = z.object({
  itemId: uuid,
  resolution: choice(TAINT_RESOLUTIONS),
  reason: requiredText(10, 2000),
});

// ---- The meeting's invite (api.invite_to_meeting, AMB-156, AMB-158) ---------------------------------------------------
/**
 * One candidate from the invite list, as `account:<id>` or `person:<id>` (the list's two kinds), the role it is
 * invited as and the reason. An interpreter always declares their conflict-of-interest status (the command refuses
 * otherwise); a legal adviser needs an account and a person concerned needs to be a case person, which the list
 * already narrows.
 */
const INVITEE = /^(account|person):([0-9a-f-]{36})$/i;
export const inviteToMeetingSchema = z
  .object({
    meetingId: uuid,
    invitee: z
      .string({ message: "validation.required" })
      .trim()
      .min(1, { message: "validation.required", abort: true })
      .regex(INVITEE, { message: "validation.invalid" }),
    inviteeRole: choice(MEETING_INVITEE_ROLES),
    requiresCoi: flag,
    reason: requiredText(5, 2000),
  })
  .superRefine((v, ctx) => {
    const kind = INVITEE.exec(v.invitee)?.[1]?.toLowerCase();
    if (v.inviteeRole === "INTERPRETER" && !v.requiresCoi)
      ctx.addIssue({ code: "custom", message: "validation.interpreterCoi", path: ["requiresCoi"] });
    if (v.inviteeRole === "LEGAL" && kind === "person")
      ctx.addIssue({ code: "custom", message: "validation.legalNeedsAccount", path: ["inviteeRole"] });
    if (v.inviteeRole === "SUBJECT" && kind === "account")
      ctx.addIssue({ code: "custom", message: "validation.subjectNeedsPerson", path: ["inviteeRole"] });
  })
  .transform(({ invitee, ...v }) => {
    const [, kind, id] = INVITEE.exec(invitee)!;
    return {
      ...v,
      userId: kind!.toLowerCase() === "account" ? id!.toLowerCase() : undefined,
      personId: kind!.toLowerCase() === "person" ? id!.toLowerCase() : undefined,
    };
  });
