// Corrective-action commands (ADR-033, migration 1940, Q72). The database re-checks every rule, including whether a
// date is in the past (in Riyadh); error messages are i18n keys, never prose.
import { z } from "zod";
import {
  ACTION_DISPOSITIONS,
  COMPLETION_EVIDENCE_RULES,
  CORRECTIVE_ACTION_POLICY_SOURCES,
  CORRECTIVE_ACTION_TYPES,
  CORRECTIVE_EVIDENCE_TYPES,
  REWORDING_DISPOSITIONS,
  VERIFICATION_DECISIONS,
} from "@cdf/contracts";

const uuid = z.uuid({ message: "validation.invalid" });
const text = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min, { message: min <= 1 ? "validation.required" : "validation.tooShort" })
    .max(max, { message: "validation.tooLong" });
const optionalText = (min: number, max: number) =>
  z
    .string()
    .trim()
    .max(max, { message: "validation.tooLong" })
    .optional()
    .transform((v) => (v ? v : undefined))
    .refine((v) => v === undefined || v.length >= min, { message: "validation.tooShort" });
const calendarDate = z.iso.date({ message: "validation.invalid" });
const days = (max: number) =>
  z
    .number({ message: "validation.invalid" })
    .int({ message: "validation.invalid" })
    .min(1, { message: "validation.invalid" })
    .max(max, { message: "validation.invalid" })
    .optional();

/** Without a due date, the policy's default period applies when one is set (none is seeded: SOURCE_REQUIRED). */
export const openCorrectiveActionSchema = z.object({
  itemId: uuid,
  title: text(5, 200),
  description: text(10, 4000),
  ownerId: uuid,
  dueDate: calendarDate.optional(),
});

export const assignCorrectiveActionOwnerSchema = z.object({
  actionId: uuid,
  ownerId: uuid,
  reason: text(5, 2000),
});

export const changeCorrectiveActionDueDateSchema = z.object({
  actionId: uuid,
  dueDate: calendarDate,
  reason: text(5, 2000),
});

/**
 * A whole percentage from 0 to 100. A form sends text: blank is missing, anything else is read as a number, so "40"
 * passes and "forty" or "40.5" does not.
 */
const percentage = z.preprocess(
  (v) => (typeof v === "string" ? (v.trim() === "" ? undefined : Number(v.trim())) : v),
  z
    .number({ error: (issue) => (issue.input === undefined ? "validation.required" : "validation.invalid") })
    .int({ message: "validation.invalid" })
    .min(0, { message: "validation.invalid" })
    .max(100, { message: "validation.invalid" }),
);

export const recordCorrectiveActionProgressSchema = z.object({
  actionId: uuid,
  percentComplete: percentage,
  note: text(5, 4000),
});

/**
 * The evidence reference (a document or system reference) is required unless the policy says NOTE_ONLY; the database
 * decides that, and whether the policy in force needs an evidence type with a reference (DEC-F27, migration 2040). A
 * type names the kind of the reference, so it never comes without one.
 */
export const submitCorrectiveActionCompletionSchema = z
  .object({
    actionId: uuid,
    note: text(5, 4000),
    evidenceReference: optionalText(3, 300),
    evidenceType: z.enum(CORRECTIVE_EVIDENCE_TYPES, { message: "validation.invalid" }).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.evidenceType && !v.evidenceReference)
      ctx.addIssue({ code: "custom", path: ["evidenceType"], message: "validation.invalid" });
  });

/** A return always says why. */
export const verifyCorrectiveActionSchema = z
  .object({
    actionId: uuid,
    decision: z.enum(VERIFICATION_DECISIONS, { message: "validation.required" }),
    note: optionalText(5, 4000),
  })
  .superRefine((v, ctx) => {
    if (v.decision === "RETURNED" && !v.note)
      ctx.addIssue({ code: "custom", path: ["note"], message: "validation.required" });
  });

export const reopenCorrectiveActionSchema = z.object({ actionId: uuid, reason: text(5, 2000) });

/** The competent authority's waiver is recorded with its source document (N15 pattern). */
export const waiveCorrectiveActionSchema = z.object({
  actionId: uuid,
  sourceDocumentReference: text(3, 300),
  reason: text(5, 2000),
});

export const setCorrectiveActionPolicySchema = z.object({
  actionType: z.enum(CORRECTIVE_ACTION_TYPES, { message: "validation.required" }),
  defaultDueDays: days(730),
  reminderDaysBefore: days(90),
  escalateAfterDays: days(365),
  completionEvidence: z.enum(COMPLETION_EVIDENCE_RULES, { message: "validation.required" }),
  effectiveFrom: z.iso.datetime({ offset: true, message: "validation.invalid" }),
  sourceStatus: z.enum(CORRECTIVE_ACTION_POLICY_SOURCES, { message: "validation.required" }),
  reason: text(5, 2000),
});

/**
 * The replacement decision's disposition of a frozen action (DEC-AMB-014; api.dispose_superseded_corrective_action,
 * Phase 12 P12-3b). It cites one of the replacement decision's own source documents and always says why; the reason
 * stays with the disposition and the ledger, never on the card. MODIFY and REPLACE_WITH_NEW_ACTION carry the new
 * wording and may set a due date (never in the past, which the database checks in Riyadh); a replacement names its
 * owner. RE_ADOPT and WAIVE carry none of these.
 */
export const disposeSupersededCorrectiveActionSchema = z
  .object({
    actionId: uuid,
    disposition: z.enum(ACTION_DISPOSITIONS, { message: "validation.required" }),
    sourceDocumentReference: text(3, 300),
    reason: text(5, 2000),
    title: optionalText(5, 200),
    description: optionalText(10, 4000),
    ownerId: uuid.optional(),
    dueDate: calendarDate.optional(),
  })
  .superRefine((v, ctx) => {
    const rewords = REWORDING_DISPOSITIONS.includes(v.disposition);
    for (const field of ["title", "description"] as const) {
      if (rewords && !v[field])
        ctx.addIssue({ code: "custom", path: [field], message: "validation.required" });
      if (!rewords && v[field])
        ctx.addIssue({ code: "custom", path: [field], message: "validation.invalid" });
    }
    if (!rewords && v.dueDate)
      ctx.addIssue({ code: "custom", path: ["dueDate"], message: "validation.invalid" });
    const replaces = v.disposition === "REPLACE_WITH_NEW_ACTION";
    if (replaces && !v.ownerId)
      ctx.addIssue({ code: "custom", path: ["ownerId"], message: "validation.required" });
    if (!replaces && v.ownerId)
      ctx.addIssue({ code: "custom", path: ["ownerId"], message: "validation.invalid" });
  });
