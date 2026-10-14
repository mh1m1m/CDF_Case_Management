// Case-structure commands (ADR-017 to ADR-019, migration 1870; UX redesign Phase 12 P12-1). One schema per command;
// the database re-checks every rule, including who may act, the open-proceeding rules and the status catalogue.
// Error messages are i18n keys, never prose.
import { z } from "zod";
import {
  CLOSED_PROCEEDING_STATUSES,
  FINDING_RESULTS,
  OPEN_PROCEEDING_STATUSES,
  OPENABLE_PROCEEDING_TYPES,
  OUTCOME_CODES_NOT_OFFERED,
  REPORT_CATEGORIES,
  STATUS_CODES,
  SUBJECT_CATEGORIES,
} from "@cdf/contracts";

const uuid = z.uuid({ message: "validation.invalid" });
const optionalUuid = z
  .union([uuid, z.literal("")])
  .optional()
  .transform((v) => (v ? v : undefined));
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
const optionalChoice = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .union([z.enum(values, { message: "validation.invalid" }), z.literal("")])
    .optional()
    .transform((v) => (v ? v : undefined));
const reason = requiredText(5, 2000);

/** A person the case is about, added by a synthetic label (api.add_case_subject). */
export const addCaseSubjectSchema = z.object({
  caseId: uuid,
  displayLabel: requiredText(2, 200),
  subjectCategory: choice(SUBJECT_CATEGORIES),
});

export const addAllegationSchema = z.object({
  caseId: uuid,
  category: choice(REPORT_CATEGORIES),
  description: requiredText(10, 8000),
  subjectId: optionalUuid,
  policyReference: optionalText(2, 200),
  lawReference: optionalText(2, 200),
});

/** Ties an allegation that has no subject yet to one (api.link_allegation_subject). */
export const linkAllegationSubjectSchema = z.object({
  allegationId: uuid,
  subjectId: uuid,
  policyReference: optionalText(2, 200),
  lawReference: optionalText(2, 200),
});

/** A new version of the finding on one allegation, for one subject (or the allegation as a whole), in one proceeding. */
export const recordFindingSchema = z.object({
  allegationId: uuid,
  subjectId: optionalUuid,
  proceedingId: uuid,
  result: choice(FINDING_RESULTS),
  rationale: requiredText(10, 8000),
});

export const openProceedingSchema = z.object({
  caseId: uuid,
  proceedingType: choice(OPENABLE_PROCEEDING_TYPES),
  parentProceedingId: optionalUuid,
  reason,
});

/** One current value per dimension: a suspended proceeding has a suspension reason and no waiting reason. */
export const updateProceedingStateSchema = z
  .object({
    proceedingId: uuid,
    status: choice(OPEN_PROCEEDING_STATUSES),
    waitingReason: optionalChoice(STATUS_CODES.WAITING_REASON),
    suspensionReason: optionalChoice(STATUS_CODES.SUSPENSION_REASON),
    reason,
  })
  .superRefine((v, ctx) => {
    if (v.status === "SUSPENDED") {
      if (!v.suspensionReason)
        ctx.addIssue({ code: "custom", message: "validation.required", path: ["suspensionReason"] });
      if (v.waitingReason)
        ctx.addIssue({ code: "custom", message: "validation.invalid", path: ["waitingReason"] });
    } else if (v.suspensionReason) {
      ctx.addIssue({ code: "custom", message: "validation.invalid", path: ["suspensionReason"] });
    }
  });

/** Concluded needs an outcome; cancelled has none. A closed proceeding never changes again (the database). */
export const closeProceedingSchema = z
  .object({
    proceedingId: uuid,
    status: choice(CLOSED_PROCEEDING_STATUSES),
    outcomeCode: optionalChoice(STATUS_CODES.OUTCOME_CODE),
    reason,
  })
  .superRefine((v, ctx) => {
    if (v.status === "CONCLUDED" && !v.outcomeCode)
      ctx.addIssue({ code: "custom", message: "validation.required", path: ["outcomeCode"] });
    if (v.status === "CANCELLED" && v.outcomeCode)
      ctx.addIssue({ code: "custom", message: "validation.invalid", path: ["outcomeCode"] });
    // DEC-F10: not offered until their authority and definitions are confirmed.
    if ((OUTCOME_CODES_NOT_OFFERED as readonly string[]).includes(v.outcomeCode ?? ""))
      ctx.addIssue({ code: "custom", message: "validation.invalid", path: ["outcomeCode"] });
  });

export const referCaseToCommitteeSchema = z.object({
  caseId: uuid,
  committeeId: uuid,
  parentProceedingId: optionalUuid,
  reason,
});

/** DEC-61: the Restricted Case Authority approves one referral of a restricted case to one committee. */
export const approveRestrictedReferralSchema = z.object({
  caseId: uuid,
  committeeId: uuid,
  reason,
});
