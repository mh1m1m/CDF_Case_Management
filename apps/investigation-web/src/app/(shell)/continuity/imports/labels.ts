// How the continuity import page names what api.bcp_import_batch_view gives it (UX redesign Phase 12 P12-6b-1;
// ADR-034). A person is the directory's name in the reader's language, read in the reader's own context, else "an
// account"; the reader is "you". A sheet is the workbook's own code with its name; a row's problem and the dry run's
// outcome are the page's words for their codes, else the shared refusal text: never a cell, and never the code alone.
import type { AccountName, BcpBatchStatus, BcpImportBatchView, BcpImportRowView } from "@cdf/contracts";
import { formatDateTime, isolate, type MessageKey, type Translator } from "@cdf/i18n";
import { refusalMessage, type CDFProgressState } from "@cdf/ui";
import { accountName } from "../../legal-reviews/labels";

/** The continuity commands' refusals first, then the shared ones. */
export const BCP_CODES = ["continuityImports.codes", "codes"] as const;

/** A person the view names: the reader is "you"; anyone the directory does not show the reader is "an account". */
export function personName(
  t: Translator,
  people: readonly AccountName[],
  userId: string,
  me: string,
): string {
  if (userId === me) return t("continuityImports.youName");
  const found = people.find((p) => p.userId === userId);
  return found ? accountName(t, found) : t("continuityImports.anAccount");
}

/** A moment, isolated so it keeps its own direction inside a sentence. */
export const when = (t: Translator, iso: string): string => isolate(formatDateTime(t.locale, iso));

/** The words for a key the catalogue may not have: the key's text, else the fallback. */
function known(t: Translator, key: string, fallback: string): string {
  const text = t(key as MessageKey);
  return text !== key ? text : fallback;
}

/** A sheet's name in the reader's language; a sheet added later keeps its code. */
export const sheetName = (t: Translator, code: string): string =>
  known(t, `continuityImports.sheet.${code}`, code);

/** A template column's label, as the workbook's second row gives it. */
export const columnName = (t: Translator, code: string): string =>
  known(t, `bcpTemplate.columns.${code}`, code);

/**
 * What is wrong with a row, in words: an INVALID row names the first column that breaks its rule (or FORMULA,
 * DUPLICATE_ROW_ID and the like), a CONFLICT row says why it conflicts. A code the page has no words for is the
 * column's rule, with the column's label.
 */
export function detailText(t: Translator, detail: string): string {
  const key = `continuityImports.detail.${detail}`;
  const text = t(key as MessageKey);
  return text !== key ? text : t("continuityImports.detail.COLUMN", { column: columnName(t, detail) });
}

const OUTCOME = /^CDF_([A-Z_]+)(?::(.+))?$/;
const KINDS = new Set(["NOT_FOUND", "FORBIDDEN", "INVALID", "CONFLICT"]);

/**
 * The last dry run's result for a row: OK, or the refusal its command gave (the platform's own code, never SQL text),
 * as the refusal's words.
 */
export function outcomeText(t: Translator, outcome: string): string {
  if (outcome === "OK") return t("continuityImports.outcome.OK");
  const m = OUTCOME.exec(outcome);
  const kind = m && KINDS.has(m[1]!) ? m[1]! : "CONFLICT";
  const detail = m && KINDS.has(m[1]!) ? m[2]?.split(":")[0] : undefined;
  return t("continuityImports.outcome.refused", { reason: refusalMessage(t, kind, detail, BCP_CODES) });
}

/** Rows that still need the importer's decision before the batch can be submitted. */
export const unresolved = (r: Pick<BcpImportRowView, "resolution" | "state">): boolean =>
  r.resolution === null && r.state !== "ALREADY_IMPORTED";

const OPEN: ReadonlySet<BcpBatchStatus> = new Set(["STAGED", "SUBMITTED", "APPROVED"]);

/** A committee workbook (2110) goes on only through its official record (ADR-061), which has no page yet: until it is
 *  imported or ends, its page names no one who acts next, and its importer finds what comes next on the record. */
export const throughOfficialRecord = (
  v: Pick<BcpImportBatchView, "officialRecordRequired" | "status">,
): boolean => v.officialRecordRequired && OPEN.has(v.status);

/** The import's path, as the progress tracker shows it: prepared and submitted, approved, imported. */
export type BcpStep = "PREPARE" | "APPROVE" | "IMPORT";
export const BCP_STEPS: readonly BcpStep[] = ["PREPARE", "APPROVE", "IMPORT"];

type StepView = Pick<BcpImportBatchView, "status" | "submittedAt" | "decidedAt">;

/** How many steps it has done: a rejection ends it after its preparation, a cancellation wherever it was. */
function stepsDone(v: StepView): number {
  switch (v.status) {
    case "STAGED":
      return 0;
    case "SUBMITTED":
    case "REJECTED":
      return 1;
    case "APPROVED":
      return 2;
    case "IMPORTED":
      return 3;
    case "CANCELLED":
      return v.decidedAt ? 2 : v.submittedAt ? 1 : 0;
  }
}

const ENDED: ReadonlySet<BcpBatchStatus> = new Set(["REJECTED", "CANCELLED"]);

/** The step that waits now: none once it has ended or been imported. */
export function currentStep(v: StepView): BcpStep | null {
  if (ENDED.has(v.status)) return null;
  return BCP_STEPS[stepsDone(v)] ?? null;
}

/** Each step's state: done, the one that waits now, still to come, or never taken once the import has ended. */
export function stepState(v: StepView, s: BcpStep): CDFProgressState {
  const k = BCP_STEPS.indexOf(s);
  const n = stepsDone(v);
  if (k < n) return "done";
  if (ENDED.has(v.status)) return "skipped";
  return k === n ? "current" : "upcoming";
}
