// The official record of a committee continuity workbook (migration 2115, ADR-061; the owner's decision on AMB-201).
// One schema per command; the database re-checks every rule, including who may act, in which state and on which
// revision. The lengths follow the commands' own checks. Error messages are i18n keys, never prose.
import { z } from "zod";
import {
  ACTING_CHAIR_BASES,
  CLASSIFICATION_LEVELS,
  COMMITTEE_RECORD_ATTENDANCE,
  COMMITTEE_RECORD_ATTESTATION_ACTIONS,
  COMMITTEE_RECORD_DECISIONS,
  COMMITTEE_RECORD_DECLINE_CODES,
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
const flag = z.boolean({ message: "validation.invalid" });
/** The revision the caller saw; the database refuses any other (E7). Forms send it as text. */
const revision = z.coerce
  .number({ message: "validation.invalid" })
  .int({ message: "validation.invalid" })
  .min(1, {
    message: "validation.invalid",
  });
const reason = requiredText(5, 2000);

/** Today in Riyadh (UTC+3, no daylight saving), the calendar the database checks a meeting date against. */
const riyadhToday = (): string => new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);

// ---- Layer 1: the record, the roster and the signed minutes ----------------------------------------------------------
/** api.open_committee_record takes the workbook's batch. */
export const committeeRecordBatchSchema = z.object({ batchId: uuid });

const declaredLine = z
  .object({
    rosterId: uuid,
    attendance: choice(COMMITTEE_RECORD_ATTENDANCE),
    joinedLate: flag,
    leftEarly: flag,
    signatureVisible: flag,
    signedAsChair: flag,
  })
  .refine((l) => (l.attendance === "ATTENDED_PART") === (l.joinedLate || l.leftEarly), {
    message: "validation.invalid",
    path: ["attendance"],
  })
  .refine((l) => !l.signedAsChair || l.signatureVisible, {
    message: "validation.invalid",
    path: ["signedAsChair"],
  });

/** What the signed minutes show, line by line: the secretary's declaration, confirmed by the chair and each member. */
export const declareCommitteeRecordRosterSchema = z
  .object({
    recordId: uuid,
    lines: z.array(declaredLine).min(1, { message: "validation.required" }).max(200),
  })
  .refine((v) => new Set(v.lines.map((l) => l.rosterId)).size === v.lines.length, {
    message: "validation.invalid",
    path: ["lines"],
  })
  .refine((v) => v.lines.filter((l) => l.signedAsChair).length <= 1, {
    message: "validation.invalid",
    path: ["lines"],
  });

/** The upload form's metadata; the file itself is checked by @cdf/domain checkCommitteeMinutesFile. */
export const uploadCommitteeMinutesSchema = z.object({
  recordId: uuid,
  meetingDate: z.iso
    .date({ message: "validation.invalid" })
    .refine((d) => d <= riyadhToday(), { message: "validation.futureDate" }),
  templateReference: requiredText(2, 100),
  classification: z.enum(CLASSIFICATION_LEVELS, { message: "validation.required" }),
});

/** api.mark_committee_minutes_signed and api.open_committee_record_document take one version of the minutes. */
export const committeeMinutesDocumentSchema = z.object({ documentId: uuid });

// ---- Layer 2: acting chair, the chair's decision, return, attestation ---------------------------------------------
/** A future instant: datetime-local (read as Riyadh time) or ISO. */
const futureInstant = z
  .string({ message: "validation.required" })
  .trim()
  .min(1, { message: "validation.required", abort: true })
  .transform((v, ctx) => {
    const d = new Date(/([zZ]|[+-]\d{2}:?\d{2})$/.test(v) ? v : `${v}${v.length === 16 ? ":00" : ""}+03:00`);
    if (Number.isNaN(d.getTime())) {
      ctx.addIssue({ code: "custom", message: "validation.invalid" });
      return z.NEVER;
    }
    if (d.getTime() <= Date.now()) {
      ctx.addIssue({ code: "custom", message: "validation.invalid" });
      return z.NEVER;
    }
    return d.toISOString();
  });

/** Owner decision §4: reason, effective period and audit; the scope is this one record. */
export const activateRecordActingChairSchema = z.object({
  recordId: uuid,
  basis: choice(ACTING_CHAIR_BASES),
  reason: requiredText(10, 2000),
  effectiveTo: futureInstant,
});

export const endRecordActingChairSchema = z.object({ activationId: uuid, reason });

/** APPROVE needs no reason; RETURN and REJECT do. */
export const decideCommitteeRecordSchema = z
  .object({
    recordId: uuid,
    revision,
    decision: choice(COMMITTEE_RECORD_DECISIONS),
    reason: optionalText(5, 2000),
  })
  .refine((v) => v.decision === "APPROVE" || v.reason !== undefined, {
    message: "validation.required",
    path: ["reason"],
  });

export const returnCommitteeRecordSchema = z.object({ recordId: uuid, reason });

/** A member's own attestation or decline; there is no user field (nobody attests for anyone else, §7, §17 test 15). */
export const attestCommitteeRecordSchema = z
  .object({
    recordId: uuid,
    revision,
    action: choice(COMMITTEE_RECORD_ATTESTATION_ACTIONS),
    discrepancyCode: z.enum(COMMITTEE_RECORD_DECLINE_CODES, { message: "validation.invalid" }).optional(),
    reason: optionalText(5, 2000),
  })
  .refine((v) => (v.action === "DECLINE") === (v.discrepancyCode !== undefined), {
    message: "validation.required",
    path: ["discrepancyCode"],
  })
  .refine((v) => (v.action === "DECLINE") === (v.reason !== undefined), {
    message: "validation.required",
    path: ["reason"],
  });
