/**
 * Records, retention and legal hold command schemas (CDF-71, ADR-013, ADR-014). Shared by the server actions
 * and re-validated by the api.* commands of migrations 1310 and 1710 (§45). Messages are i18n keys.
 *
 * Retention values are not chosen here: the class is a code the database checks against
 * records.retention_class, whose periods stay SOURCE_REQUIRED until the CDF policy is supplied.
 */
import { z } from "zod";
import { LEGAL_HOLD_REASON_CODES } from "@cdf/contracts";

const uuid = z.uuid({ message: "validation.invalid" });

const text = (min: number, max: number) =>
  z
    .string({ message: "validation.required" })
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

const reasonCode = z.enum(LEGAL_HOLD_REASON_CODES, { message: "validation.required" });
/** Justifications are bounded like the database columns (20–2000 characters). */
const justification = text(20, 2000);
/** Decision reasons are bounded like api._require_text(…, 10, 2000). */
const decisionReason = text(10, 2000);

/** A two-way decision from a radio group, as the boolean the database command takes. */
const decision = (yes: string, no: string) =>
  z.enum([yes, no], { message: "validation.required" }).transform((v) => v === yes);

export const assignRetentionClassSchema = z.object({
  caseId: uuid,
  retentionClass: z
    .string({ message: "validation.required" })
    .regex(/^[A-Z_]{3,40}$/, { message: "validation.required" })
    .refine((v) => v !== "UNASSIGNED", { message: "validation.required" }),
});

/** Case-scope hold placed by an authorised records or legal user (api.place_legal_hold). */
export const placeLegalHoldSchema = z.object({
  caseId: uuid,
  reasonCode,
  justification,
  authorityReference: optionalText(3, 200),
});

export const requestHoldReleaseSchema = z.object({ holdId: uuid, justification });

export const decideHoldReleaseSchema = z.object({
  releaseId: uuid,
  approve: decision("APPROVE", "REJECT"),
  reason: decisionReason,
});

/** A case-team request for a hold (api.request_legal_hold), reviewed by legal under a task. */
export const requestLegalHoldSchema = z.object({ caseId: uuid, reasonCode, justification });

export const assignHoldRequestSchema = z.object({ requestId: uuid, reviewerId: uuid });

export const reviewHoldRequestSchema = z.object({
  requestId: uuid,
  apply: decision("APPLY", "REJECT"),
  reason: decisionReason,
});

export const requestDispositionSchema = z.object({ caseId: uuid });

export const decideDispositionSchema = z.object({
  requestId: uuid,
  approve: decision("APPROVE", "REJECT"),
  reason: decisionReason,
});

/** Logical execution only (ADR-013 D7); the confirmation is explicit because the case leaves every case view. */
export const executeDispositionSchema = z.object({
  requestId: uuid,
  confirm: z.literal(true, { message: "validation.required" }),
});
