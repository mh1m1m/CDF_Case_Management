// How the committee's pages name a proceeding (Phase 12 P12-2b and P12-2c; ADR-055, ADR-056; DEC-02): by its case where
// the caller may see the case's metadata, otherwise by a display-only reference that is never a key.
import type { CommitteeProceedingSummary } from "@cdf/contracts";
import { proceedingShortRef } from "@cdf/domain";
import { isolate, type Translator } from "@cdf/i18n";

export function proceedingLabel(
  t: Translator,
  code: string,
  p: Pick<CommitteeProceedingSummary, "case" | "committeeProceedingId">,
): string {
  return p.case.caseNumber
    ? t("committees.proceedingOfCase", { number: isolate(p.case.caseNumber) })
    : t("committees.proceedingRef", { ref: isolate(proceedingShortRef(code, p.committeeProceedingId)) });
}
