/**
 * Pure domain rules. No I/O, no framework imports.
 */
import { CLASSIFICATION_LEVELS, type Classification } from "@cdf/contracts";

// ---- Report references and reporter secrets (§23) --------------------------------------------
/** Crockford base32 without I, L, O, U, so references are easy to read aloud and type. */
export const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const REPORT_REF_PATTERN = /^WB-[0-9A-HJKMNP-TV-Z]{12}$/;

export type RandomSource = (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>;
const defaultRandom: RandomSource = (bytes) => globalThis.crypto.getRandomValues(bytes);

/** 12 random Crockford characters = 60 bits. Not a secret; collisions are retried by the caller. */
export function generateReportRef(random: RandomSource = defaultRandom): string {
  const bytes = random(new Uint8Array(12));
  let out = "WB-";
  for (const b of bytes) out += CROCKFORD_ALPHABET[b & 31];
  return out;
}

/** Normalises user input: trims, upper-cases, maps the ambiguous letters O→0, I/L→1. */
export function normaliseReportRef(input: string): string {
  return input.trim().toUpperCase().replace(/O/g, "0").replace(/[IL]/g, "1");
}

export function isReportRef(value: string): boolean {
  return REPORT_REF_PATTERN.test(value);
}

/**
 * The reporter's follow-up secret: 20 Crockford characters (100 bits), shown once in groups of
 * four. Only HMAC(pepper, secret) is ever stored.
 */
export function generateReporterSecret(random: RandomSource = defaultRandom): string {
  const bytes = random(new Uint8Array(20));
  const chars = Array.from(bytes, (b) => CROCKFORD_ALPHABET[b & 31]).join("");
  return chars.match(/.{4}/g)!.join("-");
}

export const REPORTER_SECRET_PATTERN = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){4}$/;

export function normaliseReporterSecret(input: string): string {
  const compact = input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  return (compact.match(/.{1,4}/g) ?? []).join("-");
}

// ---- Classification (§19 ABAC) ------------------------------------------------------------------
export function classificationRank(level: Classification): number {
  return CLASSIFICATION_LEVELS.indexOf(level);
}

export function clearanceCovers(clearance: Classification, classification: Classification): boolean {
  return classificationRank(clearance) >= classificationRank(classification);
}

// ---- Synthetic data guard (§2) -----------------------------------------------------------------
export const SYNTHETIC_EMAIL_PATTERN = /^[a-z0-9._+-]+@example\.test$/;
export const SYNTHETIC_CASE_NUMBER_PATTERN = /^CDF-DEMO-\d{4}-\d{4,5}$/;

// ---- Evidence files (§25; ADR-006) ---------------------------------------------------------------
export {
  ALLOWED_CONTENT_TYPES,
  EVIDENCE_MAX_BYTES,
  allowedTypeForExtension,
  checkEvidenceFile,
  detectContentType,
  evidenceDisplayNumber,
  extensionOf,
  formatBytes,
  sanitizeFileName,
} from "./evidence";
export type { AllowedContentType, EvidenceFileCheck, EvidenceFileRejection } from "./evidence";

// ---- Forms engine (Phase 8; ADR-011) --------------------------------------------------------------
export {
  FORM_CODE_PATTERN,
  FORM_DATE_PATTERN,
  FORM_DEFINITIONS,
  FORM_ENTITLEMENTS,
  FORM_FIELD_NAME_PATTERN,
  FORM_NUMBER_PATTERN,
  canonicalJson,
  fieldsOf,
  formContentHash,
  formDisplayNumber,
  formFinalStatus,
  formSchemaHash,
  getFormDefinition,
  isFormEntitled,
  sha256Hex,
  validateFormData,
} from "./forms";
export type { FormDataCheck, FormDataIssue, FormDataIssueCode } from "./forms";
// ---- Interviews (EPIC 09, CDF-60; ADR-012) ---------------------------------------------------------
export * from "./interviews";
