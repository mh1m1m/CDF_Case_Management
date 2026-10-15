// How the corrective-action pages name what the read models give them (UX redesign Phase 12 P12-3b; ADR-058). A
// calendar date is the day in Riyadh as written. An owner is their kind and the accountable person's name where the
// page has it, else "a named person": the action's own view gives an id, never a name. A refusal code is the action
// commands' own words for it, else the shared refusal text, else the generic conflict: never the code itself.
import type { ActionDisposition, ActionOrigin, ActionOwner, CorrectiveActionView } from "@cdf/contracts";
import { formatDate, isolate, type Translator } from "@cdf/i18n";
import type { ConfirmAct } from "../confirmations";

/** The corrective-action commands' refusals first, then the shared ones. */
export const ACTION_CODES = ["correctiveActions.codes", "codes"] as const;

/** A calendar date (YYYY-MM-DD, the day in Riyadh), shown as that day in the viewer's language. */
export const calendarDate = (t: Translator, day: string): string =>
  isolate(formatDate(t.locale, `${day}T12:00:00+03:00`));

/** A name in the viewer's language, or null where the page has none. */
export function nameOf(
  t: Translator,
  n: { displayName: string | null; displayNameAr: string | null } | null | undefined,
): string | null {
  if (!n) return null;
  return (
    (t.locale === "ar" ? (n.displayNameAr ?? n.displayName) : (n.displayName ?? n.displayNameAr)) ?? null
  );
}

/** Who answers for the action: the unit, pool or party it is set to, and the accountable person. */
export function ownerText(t: Translator, owner: ActionOwner, name: string | null): string {
  const person = isolate(name ?? t("correctiveActions.owner.person"));
  switch (owner.kind) {
    case "ORG_UNIT":
      return t("correctiveActions.owner.ORG_UNIT", {
        unit: isolate(owner.sector ? (t.locale === "ar" ? owner.sector.nameAr : owner.sector.nameEn) : "—"),
        name: person,
      });
    case "SHARED_POOL":
      return t("correctiveActions.owner.SHARED_POOL", {
        pool: isolate(owner.pool?.name ?? "—"),
        name: person,
      });
    case "EXTERNAL_PARTY":
      return t("correctiveActions.owner.EXTERNAL_PARTY", {
        party: isolate(owner.externalPartyLabel ?? "—"),
        name: person,
      });
    default:
      return t("correctiveActions.owner.USER", { name: person });
  }
}

/**
 * The decision the action carries out now: the one it was opened under, the replacement decision once that re-adopted
 * or modified it, or none for an action from a preliminary review proposal.
 */
export function governingKind(o: ActionOrigin): "ORIGINAL" | "REPLACEMENT" | "NONE" {
  if (!o.governingDecisionId) return "NONE";
  return o.governingDecisionId === o.authorityDecisionId ? "ORIGINAL" : "REPLACEMENT";
}

/** Each disposition's confirmation and the verb on its button. */
export const DISPOSE_ACT: Readonly<Record<ActionDisposition, ConfirmAct>> = {
  RE_ADOPT: "disposeReAdopt",
  MODIFY: "disposeModify",
  WAIVE: "disposeWaive",
  REPLACE_WITH_NEW_ACTION: "disposeReplace",
};

/** The wordings the action carried before the one it carries now, latest first. */
export const earlierVersions = (v: Pick<CorrectiveActionView, "versionNo" | "versions">) =>
  v.versions.filter((x) => x.versionNo < v.versionNo).sort((a, b) => b.versionNo - a.versionNo);
