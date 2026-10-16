// How the legal review and authority pages name what the read models give them (UX redesign Phase 12 P12-3a; ADR-057).
// An account is its display name in the viewer's language. A refusal code is the page's own words for it where the
// page explains it, else the command's refusal text, else the generic conflict: never the code itself.
import type { AccountName } from "@cdf/contracts";
import type { MessageKey, Translator } from "@cdf/i18n";

export const accountName = (t: Translator, a: AccountName): string =>
  (t.locale === "ar" ? (a.displayNameAr ?? a.displayName) : (a.displayName ?? a.displayNameAr)) ??
  t("committeeProceedings.anAccount");

/** The first section that has words for the code, else the generic conflict. */
export function codeText(t: Translator, sections: readonly string[], code: string): string {
  for (const section of sections) {
    const key = `${section}.${code}`;
    const text = t(key as MessageKey);
    if (text !== key) return text;
  }
  return t("errors.CONFLICT");
}

/** The legal review and authority commands' own refusals first, then the package commands', then the shared ones. */
export const LEGAL_CODES = ["legalReviews.codes", "committeeProceedings.codes", "codes"] as const;
