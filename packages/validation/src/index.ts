/**
 * Input schemas shared by browser forms (React Hook Form) and server actions (§45).
 * The server always re-validates; the database validates a third time.
 * Error messages are i18n keys, never prose.
 */
import { z } from "zod";
import {
  ASSIGNMENT_ROLES,
  BIRTH_DATE_CALENDARS,
  CITIES,
  CLASSIFICATION_LEVELS,
  EVIDENCE_TYPES,
  FORM_APPROVAL_OUTCOMES,
  FORM_REVIEW_OUTCOMES,
  FORM_TEXTAREA_MAX,
  GENDERS,
  ID_TYPES,
  NATIONALITIES,
  PRIORITIES,
  RECORDS_STATES,
  RELATIONSHIPS_TO_FUND,
  REPORT_CATEGORIES,
  REPORTER_MODES,
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
// Field set from the Drive whistleblowing requirements report (CDF-63). The database command
// public_api.submit_report re-checks every rule.

const requiredEmail = z
  .string({ message: "validation.required" })
  .trim()
  .toLowerCase()
  .min(1, { message: "validation.required" })
  .max(254, { message: "validation.tooLong" })
  .pipe(z.email({ message: "validation.email" }));

const requiredChoice = <T extends readonly [string, ...string[]]>(values: T) =>
  z.enum(values, { message: "validation.required" });

/** Mandatory text: empty or missing reads as "required", then the length rules apply. */
const requiredText = (min: number, max: number) =>
  z
    .string({ message: "validation.required" })
    .trim()
    .min(1, { message: "validation.required" })
    .min(min, { message: "validation.tooShort" })
    .max(max, { message: "validation.tooLong" });

const namePart = requiredText(1, 60);

const ID_NUMBER_PATTERNS: Record<(typeof ID_TYPES)[number], RegExp> = {
  NATIONAL_ID: /^1[0-9]{9}$/,
  IQAMA: /^2[0-9]{9}$/,
  PASSPORT: /^[A-Z0-9]{5,20}$/,
};

/** True when `value` is YYYY-MM-DD and a plausible past date in `calendar` (no conversion). */
export function isValidBirthDate(value: string, calendar: (typeof BIRTH_DATE_CALENDARS)[number]): boolean {
  const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1) return false;
  if (calendar === "HIJRI") return y >= 1318 && y <= 1460 && d <= 30;
  const date = new Date(Date.UTC(y, mo - 1, d));
  return y >= 1900 && date.getUTCDate() === d && value <= new Date().toISOString().slice(0, 10);
}

/** Email-only mode (Drive field 3): the email is the only identity value, stored in the vault. */
export const emailOnlyIdentitySchema = z.object({ email: requiredEmail });

/** Identified mode (Drive fields 4–12): every field is mandatory. */
export const reportIdentitySchema = z
  .object({
    givenName: namePart,
    fatherName: namePart,
    grandfatherName: namePart,
    familyName: namePart,
    gender: requiredChoice(GENDERS),
    birthDateCalendar: requiredChoice(BIRTH_DATE_CALENDARS),
    birthDate: z.string({ message: "validation.required" }).trim().min(1, { message: "validation.required" }),
    idType: requiredChoice(ID_TYPES),
    idNumber: z
      .string({ message: "validation.required" })
      .trim()
      .toUpperCase()
      .min(1, { message: "validation.required" }),
    city: requiredChoice(CITIES),
    nationality: z
      .string({ message: "validation.required" })
      .refine((v) => (NATIONALITIES as readonly string[]).includes(v), { message: "validation.required" }),
    phone: z
      .string({ message: "validation.required" })
      .trim()
      .min(1, { message: "validation.required" })
      .regex(/^\+?[0-9 ()-]{6,40}$/, { message: "validation.phone" }),
    email: requiredEmail,
    preferredContact: z.enum(["EMAIL", "PHONE", "PORTAL_ONLY"]).default("PORTAL_ONLY"),
  })
  .superRefine((v, ctx) => {
    if (!isValidBirthDate(v.birthDate, v.birthDateCalendar))
      ctx.addIssue({ code: "custom", message: "validation.birthDate", path: ["birthDate"] });
    if (!ID_NUMBER_PATTERNS[v.idType].test(v.idNumber))
      ctx.addIssue({ code: "custom", message: "validation.idNumber", path: ["idNumber"] });
  });

function identitySchemaFor(mode: unknown) {
  if (mode === "EMAIL_ONLY") return emailOnlyIdentitySchema;
  if (mode === "IDENTIFIED") return reportIdentitySchema;
  return null;
}

export const submitReportSchema = z
  .object({
    relationship: requiredChoice(RELATIONSHIPS_TO_FUND),
    relationshipOther: optionalText(500),
    category: requiredChoice(REPORT_CATEGORIES),
    categoryOther: optionalText(1000),
    subjectDescription: requiredText(2, 500),
    description: requiredText(20, 8000),
    incidentDate: z
      .string({ message: "validation.required" })
      .min(1, { message: "validation.required" })
      .pipe(
        z.iso
          .date({ message: "validation.invalid" })
          .refine((d) => d <= new Date().toISOString().slice(0, 10), { message: "validation.futureDate" }),
      ),
    incidentTime: z
      .string({ message: "validation.required" })
      .min(1, { message: "validation.required" })
      .regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, { message: "validation.invalid" }),
    location: requiredText(2, 200),
    willingToCooperate: z.enum(["YES", "NO"], { message: "validation.required" }),
    language: z.enum(["ar", "en"]).default("ar"),
    reporterMode: requiredChoice(REPORTER_MODES),
    identity: z.unknown().optional(),
    acknowledgement: z.literal(true, { message: "validation.acknowledgementRequired" }),
  })
  // Identity is checked even when other fields are invalid, so every error shows in one pass.
  .superRefine(
    (v, ctx) => {
      const schema = identitySchemaFor(v?.reporterMode);
      if (!schema) return;
      const identity = schema.safeParse(v.identity ?? {});
      if (identity.success) return;
      for (const issue of identity.error.issues) {
        ctx.addIssue({ code: "custom", message: issue.message, path: ["identity", ...issue.path] });
      }
    },
    { when: () => true },
  )
  .transform((v) => {
    const base = {
      ...v,
      // Conditional "other" texts (Drive fields 2 and 14) only travel with "Other".
      relationshipOther: v.relationship === "OTHER" ? v.relationshipOther : undefined,
      categoryOther: v.category === "OTHER" ? v.categoryOther : undefined,
    };
    const schema = identitySchemaFor(v.reporterMode);
    // Validated above; anything entered for another mode is discarded, never sent.
    if (!schema) return { ...base, identity: undefined };
    return { ...base, identity: schema.parse(v.identity ?? {}) as ReportIdentity | EmailOnlyIdentity };
  });
export type ReportIdentity = z.output<typeof reportIdentitySchema>;
export type EmailOnlyIdentity = z.output<typeof emailOnlyIdentitySchema>;
export type SubmitReportInput = Omit<z.input<typeof submitReportSchema>, "identity"> & {
  identity?: Partial<z.input<typeof reportIdentitySchema>>;
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

// ---- Records, retention and legal hold screens (CDF-71) ------------------------------------------
export * from "./records";

// ---- Interviews (EPIC 09, CDF-60) ----------------------------------------------------------------
export * from "./interviews";
