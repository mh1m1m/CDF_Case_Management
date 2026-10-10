/**
 * Input schemas shared by browser forms (React Hook Form) and server actions (§45).
 * The server always re-validates; the database validates a third time.
 * Error messages are i18n keys, never prose.
 */
import { z } from "zod";
import {
  ASSIGNMENT_ROLES,
  CLASSIFICATION_LEVELS,
  EVIDENCE_TYPES,
  FORM_APPROVAL_OUTCOMES,
  FORM_REVIEW_OUTCOMES,
  FORM_TEXTAREA_MAX,
  PRIORITIES,
  RECORDS_STATES,
  REPORT_CATEGORIES,
  TRIAGE_OUTCOMES,
} from "@cdf/contracts";

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

const uuid = z.uuid({ message: "validation.invalid" });

// ---- Public portal --------------------------------------------------------------------------
export const reportIdentitySchema = z
  .object({
    fullName: optionalText(200),
    email: z
      .string()
      .trim()
      .toLowerCase()
      .max(254)
      .optional()
      .transform((v) => (v ? v : undefined))
      .pipe(z.email({ message: "validation.email" }).optional()),
    phone: z
      .string()
      .trim()
      .optional()
      .transform((v) => (v ? v : undefined))
      .pipe(
        z
          .string()
          .regex(/^\+?[0-9 ()-]{6,40}$/, { message: "validation.phone" })
          .optional(),
      ),
    preferredContact: z.enum(["EMAIL", "PHONE", "PORTAL_ONLY"]).default("PORTAL_ONLY"),
  })
  .refine((v) => v.fullName || v.email || v.phone, {
    message: "validation.identityRequired",
    path: ["fullName"],
  });

export const submitReportSchema = z
  .object({
    category: z.enum(REPORT_CATEGORIES, { message: "validation.required" }),
    subjectDescription: optionalText(500),
    description: text(20, 8000),
    incidentDate: z
      .string()
      .optional()
      .transform((v) => (v ? v : undefined))
      .pipe(
        z.iso
          .date({ message: "validation.invalid" })
          .refine((d) => d <= new Date().toISOString().slice(0, 10), { message: "validation.futureDate" })
          .optional(),
      ),
    location: optionalText(200),
    language: z.enum(["ar", "en"]).default("ar"),
    reporterMode: z.enum(["ANONYMOUS", "IDENTIFIED"]),
    // Validated only for identified reports; anything entered in anonymous mode is discarded.
    identity: z.unknown().optional(),
    acknowledgement: z.literal(true, { message: "validation.acknowledgementRequired" }),
  })
  .transform((v, ctx) => {
    if (v.reporterMode === "ANONYMOUS") return { ...v, identity: undefined };
    const identity = reportIdentitySchema.safeParse(v.identity ?? {});
    if (!identity.success) {
      for (const issue of identity.error.issues) {
        ctx.addIssue({ code: "custom", message: issue.message, path: ["identity", ...issue.path] });
      }
      return z.NEVER;
    }
    return { ...v, identity: identity.data };
  });
export type SubmitReportInput = Omit<z.input<typeof submitReportSchema>, "identity"> & {
  identity?: z.input<typeof reportIdentitySchema>;
};
export type SubmitReport = z.output<typeof submitReportSchema>;

export const reportAccessSchema = z.object({
  reportRef: z.string().trim().min(1, { message: "validation.required" }).max(40),
  secret: z.string().trim().min(1, { message: "validation.required" }).max(60),
});

export const reporterMessageSchema = reportAccessSchema.extend({ body: text(1, 4000) });

// ---- Investigation app ----------------------------------------------------------------------
export const triageReportSchema = z
  .object({
    reportId: uuid,
    outcome: z.enum(TRIAGE_OUTCOMES),
    reason: text(10, 4000),
    referredTo: optionalText(200),
    duplicateOf: uuid.optional(),
  })
  .refine((v) => v.outcome !== "REFER_OUT" || v.referredTo, {
    message: "validation.required",
    path: ["referredTo"],
  })
  .refine((v) => v.outcome !== "DUPLICATE" || v.duplicateOf, {
    message: "validation.required",
    path: ["duplicateOf"],
  });

export const createCaseSchema = z.object({
  reportId: uuid,
  title: text(3, 200),
  summary: text(10, 4000),
  classification: z.enum(CLASSIFICATION_LEVELS).default("RESTRICTED"),
  isRestricted: z.boolean().default(false),
});

export const updateCaseDetailsSchema = z.object({
  caseId: uuid,
  title: text(3, 200),
  summary: text(10, 4000),
  priority: z.enum(PRIORITIES).optional(),
  expectedVersion: z.coerce.number().int().positive(),
});

export const assignCaseSchema = z.object({
  caseId: uuid,
  userId: uuid,
  assignmentRole: z.enum(ASSIGNMENT_ROLES),
  reason: text(5, 2000),
});

export const declareConflictSchema = z.object({
  caseId: uuid,
  hasConflict: z.boolean(),
  declaration: text(5, 2000),
});

export const transitionCaseSchema = z.object({
  caseId: uuid,
  transitionCode: z.string().regex(/^[A-Z_]{3,64}$/),
  reason: optionalText(2000),
});

export const replyToReporterSchema = z.object({ reportId: uuid, body: text(1, 4000) });

const pastDate = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined))
  .pipe(
    z.iso
      .date({ message: "validation.invalid" })
      .refine((d) => d <= new Date().toISOString().slice(0, 10), { message: "validation.futureDate" })
      .optional(),
  );

/** Evidence metadata. The file itself is checked by @cdf/domain checkEvidenceFile (§25). */
export const uploadEvidenceSchema = z
  .object({
    caseId: uuid,
    // Present when adding a version to an existing item; the item's metadata is then not editable here.
    evidenceId: uuid.optional(),
    title: optionalText(200),
    description: optionalText(2000),
    evidenceType: z.enum(EVIDENCE_TYPES).optional(),
    sourceDescription: optionalText(500),
    collectedAt: pastDate,
    classification: z.enum(CLASSIFICATION_LEVELS).optional(),
  })
  .refine((v) => v.evidenceId || (v.title && v.title.length >= 3), {
    message: "validation.tooShort",
    path: ["title"],
  })
  .refine((v) => v.evidenceId || v.evidenceType, { message: "validation.required", path: ["evidenceType"] })
  .refine((v) => v.evidenceId || v.classification, {
    message: "validation.required",
    path: ["classification"],
  });
export type UploadEvidenceInput = z.output<typeof uploadEvidenceSchema>;

// ---- Forms engine (Phase 8; ADR-011). Field values are checked against the definition by @cdf/domain
// validateFormData and by forms.validate_data; these schemas cover the command envelope.
const formCode = z.string().regex(/^WB-FRM-\d{2}$/, { message: "validation.invalid" });

export const startFormSchema = z.object({
  caseId: uuid,
  formCode,
  classification: z.enum(CLASSIFICATION_LEVELS, { message: "validation.required" }),
});

export const saveFormDraftSchema = z.object({
  instanceId: uuid,
  formCode,
  data: z.record(
    z.string().regex(/^[a-z][a-z0-9_]{1,63}$/, { message: "validation.invalid" }),
    z.string().max(FORM_TEXTAREA_MAX, { message: "validation.tooLong" }),
  ),
});

export const prepareFormSchema = z.object({ instanceId: uuid, formCode });

const decisionReason = optionalText(2000);
const returnNeedsReason = (v: { outcome: string; reason?: string }) =>
  v.outcome !== "RETURNED" || (v.reason !== undefined && v.reason.length >= 10);

export const reviewFormSchema = z
  .object({ instanceId: uuid, formCode, outcome: z.enum(FORM_REVIEW_OUTCOMES), reason: decisionReason })
  .refine(returnNeedsReason, { message: "validation.tooShort", path: ["reason"] });

export const approveFormSchema = z
  .object({ instanceId: uuid, formCode, outcome: z.enum(FORM_APPROVAL_OUTCOMES), reason: decisionReason })
  .refine(returnNeedsReason, { message: "validation.tooShort", path: ["reason"] });

export const withdrawFormSchema = z.object({ instanceId: uuid, formCode, reason: text(5, 2000) });

export const revealRequestSchema = z.object({ caseId: uuid, justification: text(20, 2000) });

export const signInSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.email({ message: "validation.email" })),
  password: z.string().min(1, { message: "validation.required" }).max(200),
});

/** Field → i18n key map for form error display. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".");
    if (!(key in out))
      out[key] = issue.message.startsWith("validation.") ? issue.message : "validation.invalid";
  }
  return out;
}

// ---- Purpose-bound records and legal access (ADR-014) -----------------------------------------------
/** Exact case number only (§6): no wildcard, prefix or partial value reaches the lookup. */
export const caseDiscoverySchema = z.object({
  caseReference: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^CDF-(CASE|DEMO)-[0-9]{4}-[0-9]{4,5}$/, { message: "validation.invalid" }),
  justification: text(20, 2000),
  reasonCode: z.enum(["LITIGATION", "REGULATORY_INQUIRY", "INTERNAL_INVESTIGATION", "AUDIT", "OTHER"]),
});

/** Catalogue search over authorised rows; the case-number filter is a plain prefix of allowed characters. */
export const recordsCatalogueSearchSchema = z.object({
  caseNumber: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9-]{0,20}$/, { message: "validation.invalid" })
    .optional(),
  archiveStatus: z.enum(RECORDS_STATES).optional(),
  legalHoldStatus: z.enum(["NONE", "ACTIVE"]).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});
