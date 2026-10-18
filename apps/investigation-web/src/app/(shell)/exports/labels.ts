// How the export pages name what api.export_request_view and the preview give them (UX redesign Phase 12 P12-6b-1;
// ADR-026). A person is the directory's name in the reader's language, read in the reader's own context, else "an
// account"; the reader is "you". A purpose is the catalogue's own name (DEC-F21). A rule or purpose says where it comes
// from, so a provisional default never reads as CDF policy. A refusal code is the export commands' own words for it,
// else the shared refusal text, else the generic conflict: never the code itself.
import { can } from "@cdf/authorization";
import type {
  AccountName,
  Actor,
  ExportItemView,
  ExportPurposeEntry,
  ExportRequestView,
  ExportSourceStatus,
  Permission,
} from "@cdf/contracts";
import { formatDateTime, isolate, type MessageKey, type Translator } from "@cdf/i18n";
import type { CDFProgressState, CDFValueSource } from "@cdf/ui";
import { accountName } from "../legal-reviews/labels";

/** The export commands' refusals first, then the shared ones. */
export const EXPORT_CODES = ["exports.codes", "codes"] as const;

/**
 * The roles the preview's pre-check accepts (the export service): its requester, an approver, a restricted case's
 * authority. The view's may_preview answers for the database; this keeps the link from leading to a refusal.
 */
const PREVIEW_PERMISSIONS: readonly Permission[] = [
  "EXPORT_REQUEST",
  "EXPORT_APPROVE",
  "EXPORT_SECOND_APPROVE",
  "RESTRICTED_CASE_AUTHORITY",
];
export const mayOpenPreview = (actor: Actor): boolean => PREVIEW_PERMISSIONS.some((p) => can(actor, p));

/** A person the view names: the reader is "you"; anyone the directory does not show the reader is "an account". */
export function personName(
  t: Translator,
  people: readonly AccountName[],
  userId: string,
  me: string,
): string {
  if (userId === me) return t("exports.youName");
  const found = people.find((p) => p.userId === userId);
  return found ? accountName(t, found) : t("exports.anAccount");
}

/** Where a governed export rule or purpose comes from, in CDFConfiguredValue's terms. */
export const SOURCE: Readonly<Record<ExportSourceStatus, CDFValueSource>> = {
  OWNER_DEFAULT: "OWNER_DEFAULT",
  SOURCE_REQUIRED: "SOURCE_REQUIRED",
  APPROVED: "CONFIGURED",
};

/** The words for a source, as the case structure pages say them. */
export const sourceLabel = (t: Translator, s: ExportSourceStatus): string =>
  t(`caseStructure.ruleSource.${s}` as MessageKey);

/** The request's purpose in the reader's language; a code the catalogue no longer has stays as written. */
export function purposeName(t: Translator, purpose: ExportPurposeEntry | null, code: string): string {
  if (!purpose) return code;
  return t.locale === "ar" ? purpose.nameAr : purpose.nameEn;
}

/** A governed rule in the reader's language where the catalogue names it; a rule added later keeps its code. */
export function ruleName(t: Translator, code: string): string {
  const key = `exports.rule.${code}`;
  const name = t(key as MessageKey);
  return name !== key ? name : code;
}

/** The kind of an item, in words. */
export const itemKind = (t: Translator, i: Pick<ExportItemView, "objectType">): string =>
  t.code("exports.objectType", i.objectType, "exports.objectType.OTHER");

/** A moment, isolated so it keeps its own direction inside a sentence. */
export const when = (t: Translator, iso: string): string => isolate(formatDateTime(t.locale, iso));

/** The export's path, as the progress tracker shows it: prepared, approved, generated and, by email, sent. */
export type ExportStep = "PREPARE" | "APPROVE" | "GENERATE" | "SEND";
const ALL_STEPS: readonly ExportStep[] = ["PREPARE", "APPROVE", "GENERATE", "SEND"];

export const exportSteps = (v: Pick<ExportRequestView, "format">): readonly ExportStep[] =>
  v.format === "EMAIL" ? ALL_STEPS : ALL_STEPS.slice(0, 3);

/** How many steps it has done: a rejection ends it after its preparation, a cancellation wherever it was. */
function stepsDone(v: Pick<ExportRequestView, "status" | "submittedAt" | "decidedAt">): number {
  switch (v.status) {
    case "DRAFT":
      return 0;
    case "SUBMITTED":
    case "REJECTED":
      return 1;
    case "APPROVED":
      return 2;
    case "GENERATED":
      return 3;
    case "SENT":
      return 4;
    case "CANCELLED":
      return v.decidedAt ? 2 : v.submittedAt ? 1 : 0;
  }
}

const ENDED = new Set(["REJECTED", "CANCELLED"]);

/** The step that waits now: none once it has ended, or once every step of its path is done. */
export function currentStep(
  v: Pick<ExportRequestView, "status" | "format" | "submittedAt" | "decidedAt">,
): ExportStep | null {
  if (ENDED.has(v.status)) return null;
  return exportSteps(v)[stepsDone(v)] ?? null;
}

/** Each step's state: done, the one that waits now, still to come, or never taken once the export has ended. */
export function stepState(
  v: Pick<ExportRequestView, "status" | "format" | "submittedAt" | "decidedAt">,
  s: ExportStep,
): CDFProgressState {
  const k = ALL_STEPS.indexOf(s);
  const n = stepsDone(v);
  if (k < n) return "done";
  if (ENDED.has(v.status)) return "skipped";
  return k === n ? "current" : "upcoming";
}
