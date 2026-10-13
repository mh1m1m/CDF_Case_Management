// Export builder commands (ADR-026, migration 1930, Q99). The database re-checks every rule; error messages are
// i18n keys, never prose.
import { z } from "zod";
import {
  CLASSIFICATION_LEVELS,
  EXPORT_AUDIENCES,
  EXPORT_FORMATS,
  EXPORT_OBJECT_TYPES,
  EXPORT_PURPOSES,
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
const previewHash = z.string().regex(/^[0-9a-f]{64}$/, { message: "validation.invalid" });

/** External exports always name the receiving party and carry a justification (Q99). */
export const createExportRequestSchema = z
  .object({
    caseId: uuid,
    format: z.enum(EXPORT_FORMATS, { message: "validation.required" }),
    audience: z.enum(EXPORT_AUDIENCES, { message: "validation.required" }),
    purpose: z.enum(EXPORT_PURPOSES, { message: "validation.required" }),
    externalParty: optionalText(200),
    justification: optionalText(2000),
  })
  .superRefine((v, ctx) => {
    const tooShort = (value: string | undefined, min: number) => value !== undefined && value.length < min;
    if (v.audience === "EXTERNAL") {
      if (!v.externalParty || tooShort(v.externalParty, 3))
        ctx.addIssue({
          code: "custom",
          path: ["externalParty"],
          message: v.externalParty ? "validation.tooShort" : "validation.required",
        });
      if (!v.justification || tooShort(v.justification, 20))
        ctx.addIssue({
          code: "custom",
          path: ["justification"],
          message: v.justification ? "validation.tooShort" : "validation.required",
        });
    } else {
      if (v.externalParty)
        ctx.addIssue({ code: "custom", path: ["externalParty"], message: "validation.invalid" });
      if (tooShort(v.justification, 20))
        ctx.addIssue({ code: "custom", path: ["justification"], message: "validation.tooShort" });
    }
  });

export const addExportItemSchema = z.object({
  requestId: uuid,
  objectType: z.enum(EXPORT_OBJECT_TYPES, { message: "validation.required" }),
  objectId: uuid,
});

/** PRODUCTION_SUBSTITUTION_REQUIRED: synthetic @example.test addresses only; production checks a CDF domain list. */
export const EXTERNAL_EXPORT_EMAIL = /^[a-z0-9._%+-]{1,64}@example\.test$/;

export const addExportRecipientSchema = z.discriminatedUnion("kind", [
  z.object({ requestId: uuid, kind: z.literal("INTERNAL"), userId: uuid }),
  z.object({
    requestId: uuid,
    kind: z.literal("EXTERNAL"),
    email: z
      .string()
      .trim()
      .toLowerCase()
      .max(254, { message: "validation.tooLong" })
      .regex(EXTERNAL_EXPORT_EMAIL, { message: "validation.email" }),
  }),
]);

export const exportRequestRefSchema = z.object({ requestId: uuid });

/** The requester confirms the case's classification and the hash of the preview they saw. */
export const submitExportSchema = z.object({
  requestId: uuid,
  previewHash,
  classification: z.enum(CLASSIFICATION_LEVELS, { message: "validation.required" }),
});

export const EXPORT_DECISIONS = ["APPROVE", "REJECT"] as const;
export const decideExportSchema = z.object({
  requestId: uuid,
  decision: z.enum(EXPORT_DECISIONS, { message: "validation.required" }),
  reason: text(5, 2000),
  previewHash,
});

export const cancelExportSchema = z.object({ requestId: uuid, reason: text(5, 2000) });
