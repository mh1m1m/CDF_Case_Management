// How the proceeding's pages name what the read models give them (UX redesign Phase 12 P12-2c; ADR-056). A subject is a
// position among the case's subjects and a category, and a name only in DISPLAY_NAME mode (the DEC-02 label card;
// ORDINAL until the owner answers it). An allegation is a position and a category, never its text. A sanction code is
// a label when the catalogue code has one, else the code itself (a code added to the catalogue later).
import type { AllegationChoice, SanctionCatalogueChoice, SubjectRef } from "@cdf/contracts";
import { isolate, type MessageKey, type Translator } from "@cdf/i18n";

export function subjectName(t: Translator, s: SubjectRef): string {
  if (s.label) return s.label;
  return t("committeeProceedings.subjectOrdinal", {
    n: s.position,
    category: t.code("subjectCategory", s.subjectCategory, "common.none"),
  });
}

export function allegationName(t: Translator, a: Pick<AllegationChoice, "position" | "category">): string {
  return `${t("caseStructure.allegationNumber", { n: a.position })} · ${t.code("category", a.category, "common.none")}`;
}

/** An allegation as R2 gives it on an item or a finding vote: its category only. */
export const allegationCategory = (t: Translator, category: string) =>
  t.code("category", category, "common.none");

export function sanctionName(t: Translator, code: string): string {
  const key = `committeeProceedings.sanction.${code}`;
  const label = t(key as MessageKey);
  return label === key ? code : label;
}

/** A catalogue code as the builder offers it: provisional until its basis is approved, and refused at adoption with no version in force. */
export function sanctionOption(t: Translator, s: SanctionCatalogueChoice): string {
  const name = sanctionName(t, s.code);
  if (s.versionNo === null) return t("committeeProceedings.sanctionNotInForce", { sanction: isolate(name) });
  if (s.sourceStatus !== "APPROVED")
    return t("committeeProceedings.sanctionProvisional", { sanction: isolate(name) });
  return name;
}
