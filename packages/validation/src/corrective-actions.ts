// Corrective-action commands (ADR-033, migration 1940, Q72). The database re-checks every rule, including whether a
// date is in the past (in Riyadh); error messages are i18n keys, never prose.
import { z } from "zod";
import {
  COMPLETION_EVIDENCE_RULES,
  CORRECTIVE_ACTION_POLICY_SOURCES,
  CORRECTIVE_ACTION_TYPES,
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

export const recordCorrectiveActionProgressSchema = z.object({
  actionId: uuid,
  percentComplete: z
    .number({ message: "validation.invalid" })
    .int({ message: "validation.invalid" })
    .min(0, { message: "validation.invalid" })
    .max(100, { message: "validation.invalid" }),
  note: text(5, 4000),
});

/** The evidence reference (a document or system reference) is required unless the policy says NOTE_ONLY. */
export const submitCorrectiveActionCompletionSchema = z.object({
  actionId: uuid,
  note: text(5, 4000),
  evidenceReference: optionalText(3, 300),
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
