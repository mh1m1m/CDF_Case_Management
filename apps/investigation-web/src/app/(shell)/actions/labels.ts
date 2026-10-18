// How the corrective-action pages name what the read models give them (UX redesign Phase 12 P12-3b and P12-6a;
// ADR-058). A calendar date is the day in Riyadh as written. An owner is their kind and the accountable person's name
// where the page has it, else "a named person": the action's own view gives an id, never a name. A refusal code is the
// action commands' own words for it, else the shared refusal text, else the generic conflict: never the code itself.
// An entry of the action's history is what happened and when, said in words, with who did it only where that is the
// reader or the owner the page can name.
import {
  ACTION_BLOCKS,
  CORRECTIVE_EVIDENCE_TYPES,
  type ActionDisposition,
  type ActionEvent,
  type ActionOrigin,
  type ActionOwner,
  type ActionPolicy,
  type CorrectiveActionView,
  type CorrectiveEvidenceType,
} from "@cdf/contracts";
import { formatDate, formatDateTime, isolate, type MessageKey, type Translator } from "@cdf/i18n";
import type { ConfirmAct } from "../confirmations";

/** The corrective-action commands' refusals first, then the shared ones. */
export const ACTION_CODES = ["correctiveActions.codes", "codes"] as const;

/**
 * Which block holds an action is the case team's to read on the page (A2 gives it to them alone), yet a command
 * refused by the freeze trigger answers with that block's code, whoever called it. So no answer the page sends the
 * browser names it: each of the five codes leaves as ACTION_BLOCKED, whose words say only that nothing was recorded.
 */
export function withoutBlock<S extends { status: string }>(state: S): S {
  const detail = (state as { detail?: unknown }).detail;
  return state.status === "error" &&
    typeof detail === "string" &&
    (ACTION_BLOCKS as readonly string[]).includes(detail)
    ? { ...state, detail: "ACTION_BLOCKED" }
    : state;
}

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

/** The action's history as the page lists it: the latest entry first (A2 gives it oldest first). */
export const latestFirst = (events: readonly ActionEvent[]): ActionEvent[] => [...events].reverse();

/** What an entry of the history records, in words: the percentage, the due date it set, or what was decided. */
export function eventText(t: Translator, e: ActionEvent): string {
  switch (e.eventType) {
    case "OPENED":
      return e.dueDate
        ? t("correctiveActions.event.OPENED_DUE", { date: calendarDate(t, e.dueDate) })
        : t("correctiveActions.event.OPENED");
    case "DUE_DATE_CHANGED":
      return e.dueDate
        ? t("correctiveActions.event.DUE_DATE_CHANGED_TO", { date: calendarDate(t, e.dueDate) })
        : t("correctiveActions.event.DUE_DATE_CHANGED");
    case "PROGRESS":
      return e.percentComplete === null
        ? t("correctiveActions.event.PROGRESS")
        : t("correctiveActions.event.PROGRESS_AT", { percent: e.percentComplete });
    default:
      return t(`correctiveActions.event.${e.eventType}` as MessageKey);
  }
}

/**
 * When an entry was recorded and, where the page can say it, by whom: the reader, or the accountable owner by the name
 * the case team's list gives. Anyone else stays unnamed: A2 gives an id, never a name.
 */
export function eventWhen(
  t: Translator,
  e: Pick<ActionEvent, "actorId" | "createdAt">,
  me: string,
  owner: { userId: string | null; name: string | null },
): string {
  const date = isolate(formatDateTime(t.locale, e.createdAt));
  if (e.actorId === me) return t("correctiveActions.eventAtByYou", { date });
  if (owner.userId && owner.name && e.actorId === owner.userId)
    return t("correctiveActions.eventAtBy", { date, name: isolate(owner.name) });
  return t("correctiveActions.eventAt", { date });
}

/** The evidence a completion named: its reference and, where given, its kind. */
export function evidenceText(
  t: Translator,
  e: Pick<ActionEvent, "evidenceReference" | "evidenceType">,
): string | null {
  if (!e.evidenceReference) return null;
  const reference = isolate(e.evidenceReference);
  return e.evidenceType
    ? t("correctiveActions.evidenceTyped", {
        reference,
        type: t(`correctiveActions.evidenceType.${e.evidenceType}` as MessageKey),
      })
    : t("correctiveActions.evidence", { reference });
}

/** The completion a verifier decides on: the latest one submitted, or null. */
export function latestSubmission(events: readonly ActionEvent[]): ActionEvent | null {
  for (let k = events.length - 1; k >= 0; k--) {
    const e = events[k]!;
    if (e.eventType === "COMPLETION_SUBMITTED") return e;
  }
  return null;
}

/**
 * Whether this person ever submitted a completion of the action. api.verify_corrective_action then leaves verifying it
 * to someone else, as it does for the action's owner; the page only says so, and the command decides.
 */
export const hasSubmitted = (events: readonly ActionEvent[], userId: string): boolean =>
  events.some((e) => e.eventType === "COMPLETION_SUBMITTED" && e.actorId === userId);

/**
 * What a completion needs under the policy in force (DEC-F27, migration 2040): a reference unless the policy accepts a
 * note alone, and a kind of evidence with it where the policy lists the kinds it accepts (only those are offered).
 * Where it lists none, any kind may be named, or none. The command checks again.
 */
export function completionNeeds(p: ActionPolicy): {
  reference: boolean;
  type: boolean;
  types: readonly CorrectiveEvidenceType[];
} {
  return {
    reference: p.completionEvidence !== "NOTE_ONLY",
    type: p.allowedEvidenceTypes !== null,
    types: p.allowedEvidenceTypes ?? CORRECTIVE_EVIDENCE_TYPES,
  };
}
