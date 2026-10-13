// Confirmation copy for controlled and irreversible acts (UX-031, O08 §08.6.4). The dialog only gates a command
// the user already chose; the database command and its rules are unchanged. All text comes from @cdf/i18n.
import type { MessageKey, Translator } from "@cdf/i18n";
import type { CDFConfirmation } from "@cdf/ui";

export type ConfirmAct =
  | "closeAtScreening"
  | "closeOutOfJurisdiction"
  | "closeCase"
  | "archiveCase"
  | "returnToJurisdiction"
  | "withdrawForm"
  | "cancelInterview"
  | "releaseHold"
  | "declareConflict";

/** Case transitions that close, archive or return a case. Any other step into Closure or Archive also confirms. */
const CASE_TRANSITIONS: Readonly<Record<string, ConfirmAct>> = {
  SCREEN_OUT: "closeAtScreening",
  OUT_OF_JURISDICTION: "closeOutOfJurisdiction",
  ARCHIVE_CASE: "archiveCase",
  REJECT_INVESTIGATION: "returnToJurisdiction",
};

export function transitionAct(code: string, toState: string): ConfirmAct | null {
  return (
    CASE_TRANSITIONS[code] ??
    (toState === "ARCHIVE" ? "archiveCase" : toState === "CLOSURE" ? "closeCase" : null)
  );
}

/** The verb that labels the act's trigger and its confirm button. */
export const actLabel = (t: Translator, act: ConfirmAct) => t(`confirm.acts.${act}.action` as MessageKey);

export function confirmation(t: Translator, act: ConfirmAct): CDFConfirmation {
  const part = (name: string) => t(`confirm.acts.${act}.${name}` as MessageKey);
  return {
    title: part("title"),
    whatHappens: part("body"),
    undo: part("undo"),
    affected: part("affected"),
    confirmLabel: actLabel(t, act),
    // "Cancel" next to "Cancel interview" would be ambiguous, so that dialog says "Keep interview".
    cancelLabel: act === "cancelInterview" ? part("dismiss") : t("confirm.cancel"),
    labels: {
      whatHappens: t("confirm.whatHappens"),
      undo: t("confirm.canUndo"),
      affected: t("confirm.whoAffected"),
      notified: t("confirm.whoNotified"),
    },
  };
}
